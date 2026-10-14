"""Fase 3: fietsraster voor heel NL bouwen met de eigen OSRM-server (localhost:5000).

Gebruik:  python pipeline/build_bike_grid.py [YYYYMMDD]

De OSRM-server moet het grensextract draaien (bash pipeline/osrm_setup.sh grens): NL plus de strook
BE en DE binnen het raster. Tot stap 8 was dat alleen NL (data/bike_grid/nl/ en nl_raw.npz).

Per rastercel (zelfde raster als web/src/grid.ts) de wegafstand naar 8 buren "vooruit"
(16 richtingen: O, N, NO, NW en de paardensprongen), en per halteplek de afstand naar de
knopen van de 3 × 3 cellen eromheen. De keuzes en metingen staan in ONTWIKKELPLAN.md (fase 3, stap 3–5).

Het script is te onderbreken: elke rij blokken wordt apart bewaard in data/bike_grid/grens/
en bij een nieuwe start overgeslagen. Resultaat: data/bike_grid/grens_raw.npz met de ruwe
OSRM-afstanden (float32, meters). Het coderen voor de browser (4 bits, snoeien) is een aparte stap.
"""
import json
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATE = sys.argv[1] if len(sys.argv) > 1 else "20261110"
OSRM = "http://localhost:5000/table/v1/bike/"
CONTAINER = "osrm-fiets"   # zie osrm_setup.sh
OUT = ROOT / "data" / "bike_grid"
PARTS = OUT / "grens"

BLOCK = 8          # cellen per blok per OSRM-verzoek
THREADS = 8
SEED_R = 1         # halte → knopen van (2R+1)² cellen
DIRS = [(1, 0), (0, 1), (1, 1), (-1, 1), (2, 1), (1, 2), (-1, 2), (-2, 1)]
M_I = max(abs(di) for di, _ in DIRS)
M_J = max(dj for _, dj in DIRS)

# --- raster, gelijk aan grid.ts ---
R = 6378137.0
DEG = np.pi / 180
BBOX = dict(west=3.2, south=50.6, east=7.4, north=53.7)
CELL = 250 / np.cos(52.2 * DEG)
mercX = lambda lon: R * lon * DEG
mercY = lambda lat: R * np.log(np.tan(np.pi / 4 + lat * DEG / 2))
invLon = lambda x: x / R / DEG
invLat = lambda y: (2 * np.arctan(np.exp(y / R)) - np.pi / 2) / DEG
X0, Y0 = mercX(BBOX["west"]), mercY(BBOX["south"])
NX = int(np.ceil((mercX(BBOX["east"]) - X0) / CELL))
NY = int(np.ceil((mercY(BBOX["north"]) - Y0) / CELL))
clat = invLat(Y0 + (np.arange(NY) + 0.5) * CELL)          # per rij
clon = invLon(X0 + (np.arange(NX) + 0.5) * CELL)          # per kolom


_restart_lock = threading.Lock()
_last_restart = [0.0]


def restart_osrm():
    """OSRM blijft soms hangen op ±800% CPU (fase 3, stap 6 en 8). Dan helpt alleen een herstart van de container."""
    with _restart_lock:
        if time.time() - _last_restart[0] < 600:   # net al herstart door een andere thread
            return
        print("  OSRM hangt: container herstarten", flush=True)
        subprocess.run(["wsl", "-e", "/usr/bin/docker", "restart", CONTAINER], check=False)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"{OSRM}5.11,52.09;5.12,52.10", timeout=10).read()
                break
            except Exception:
                time.sleep(5)
        _last_restart[0] = time.time()


def table(lats, lons, sources=None, destinations=None):
    coords = ";".join(f"{x:.6f},{y:.6f}" for x, y in zip(lons, lats))
    q = "annotations=distance"
    if sources is not None:
        q += "&sources=" + ";".join(map(str, sources))
    if destinations is not None:
        q += "&destinations=" + ";".join(map(str, destinations))
    for attempt in range(5):
        try:
            with urllib.request.urlopen(f"{OSRM}{coords}?{q}", timeout=120) as resp:
                return json.load(resp)
        except Exception as err:
            print(f"  fout ({err}), poging {attempt + 1}", flush=True)
            if "timed out" in str(err):
                restart_osrm()
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("OSRM (localhost:5000) onbereikbaar; start met: bash pipeline/osrm_setup.sh start")


def block(bj, bi):
    """één blok van BLOCK × BLOCK cellen, met een rand voor de buren"""
    js = np.arange(bj, min(bj + BLOCK + M_J, NY))
    is_ = np.arange(max(bi - M_I, 0), min(bi + BLOCK + M_I, NX))
    gj, gi = np.meshgrid(js, is_, indexing="ij")
    gj, gi = gj.ravel(), gi.ravel()
    res = table(clat[gj], clon[gi])
    idx = {(a, c): n for n, (a, c) in enumerate(zip(gj, gi))}
    D = res["distances"]
    nj, ni = min(BLOCK, NY - bj), min(BLOCK, NX - bi)
    snap = np.full((nj, ni), np.inf, np.float32)
    road = np.full((len(DIRS), nj, ni), np.inf, np.float32)
    for a in range(nj):
        for c in range(ni):
            n = idx[(bj + a, bi + c)]
            snap[a, c] = res["sources"][n]["distance"]
            for k, (di, dj) in enumerate(DIRS):
                m = idx.get((bj + a + dj, bi + c + di))
                if m is None or D[n][m] is None or D[m][n] is None:
                    continue
                road[k, a, c] = (D[n][m] + D[m][n]) / 2   # gemiddelde van heen en terug
    return snap, road


def build_grid():
    PARTS.mkdir(parents=True, exist_ok=True)
    rows = list(range(0, NY, BLOCK))
    todo = [bj for bj in rows if not (PARTS / f"rij_{bj:04d}.npz").exists()]
    print(f"raster {NX} × {NY}, {len(rows)} rijen van {(NX + BLOCK - 1) // BLOCK} blokken; nog te doen: {len(todo)}")
    t0 = time.time()
    with ThreadPoolExecutor(THREADS) as ex:
        for k, bj in enumerate(todo):
            parts = list(ex.map(lambda bi: block(bj, bi), range(0, NX, BLOCK)))
            snap = np.concatenate([p[0] for p in parts], axis=1)
            road = np.concatenate([p[1] for p in parts], axis=2)
            tmp = PARTS / f"rij_{bj:04d}.tmp.npz"
            np.savez_compressed(tmp, snap=snap, road=road)
            tmp.replace(PARTS / f"rij_{bj:04d}.npz")   # pas na volledig schrijven: veilig bij onderbreken
            if k % 10 == 0 or k == len(todo) - 1:
                el = time.time() - t0
                eta = el / (k + 1) * (len(todo) - k - 1)
                print(f"  rij {bj}/{NY}  ({k + 1}/{len(todo)})  {el / 60:.1f} min, nog ±{eta / 60:.0f} min", flush=True)
    snap = np.concatenate([np.load(PARTS / f"rij_{bj:04d}.npz")["snap"] for bj in rows], axis=0)
    road = np.concatenate([np.load(PARTS / f"rij_{bj:04d}.npz")["road"] for bj in rows], axis=1)
    return snap, road


def build_seeds():
    """per halteplek de wegafstand naar de knopen van de (2R+1)² cellen eromheen"""
    g = np.load(ROOT / "data" / f"day_{DATE}" / "graph.npz")
    lat, lon = g["area_lat"], g["area_lon"]
    n = len(lat)
    oj = np.floor((mercY(lat) - Y0) / CELL).astype(int)
    oi = np.floor((mercX(lon) - X0) / CELL).astype(int)
    offs = [(dj, di) for dj in range(-SEED_R, SEED_R + 1) for di in range(-SEED_R, SEED_R + 1)]
    dist = np.full((n, len(offs)), np.inf, np.float32)   # halte (gesnapt) → celknoop, meters
    hsnap = np.full(n, np.inf, np.float32)               # halte → zijn gesnapte punt
    B = 50

    def batch(s0):
        ids = np.arange(s0, min(s0 + B, n))
        cj = np.clip(oj[ids, None] + [o[0] for o in offs], 0, NY - 1)
        ci = np.clip(oi[ids, None] + [o[1] for o in offs], 0, NX - 1)
        la = np.r_[lat[ids], clat[cj.ravel()]]
        lo = np.r_[lon[ids], clon[ci.ravel()]]
        res = table(la, lo, sources=range(len(ids)), destinations=range(len(ids), len(la)))
        out = []
        for r, s in enumerate(ids):
            row = res["distances"][r][r * len(offs):(r + 1) * len(offs)]
            out.append((s, res["sources"][r]["distance"], [np.inf if x is None else x for x in row]))
        return out

    t0 = time.time()
    with ThreadPoolExecutor(THREADS) as ex:
        for out in ex.map(batch, range(0, n, B)):
            for s, sn, row in out:
                hsnap[s] = sn
                dist[s] = row
    print(f"startcellen: {n} halteplekken in {time.time() - t0:.0f} s")
    return oj, oi, dist, hsnap


def main():
    snap, road = build_grid()
    oj, oi, seed_dist, seed_snap = build_seeds()
    np.savez_compressed(OUT / "grens_raw.npz", snap=snap, road=road, dirs=np.array(DIRS),
                        seed_j=oj, seed_i=oi, seed_dist=seed_dist, seed_snap=seed_snap, seed_r=SEED_R)
    node = snap <= 250
    print(f"klaar: {OUT / 'grens_raw.npz'}")
    print(f"cellen met een fietsbare weg binnen 250 m: {node.sum()} van {node.size} ({node.mean():.1%})")
    print(f"kanten: {np.isfinite(road).sum()}, halteplekken met een weg binnen 250 m: {(seed_snap <= 250).mean():.1%}")


if __name__ == "__main__":
    main()
