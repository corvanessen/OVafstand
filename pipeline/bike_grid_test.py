"""Fase 3, stap 3: hoe sla je echte fietstijden compact op? Proef in één regio.

Gebruik:  python pipeline/bike_grid_test.py [regio] [aantal_haltes]     (regio: zeeland, utrecht)

Vergelijkt twee opslagvormen met OSRM (eigen server, localhost:5000) als waarheid:
  A. tabellen per halte: fietstijd naar elke cel binnen 5 km, of alleen de correcties t.o.v. het model;
  B. fietsraster: per cel de fietsafstand over de weg naar 4 buren (O, N, NO, NW; de andere 4 zijn
     dezelfde kanten terug). De browser zou dan Dijkstra over het raster doen, met de haltes als bron.

Het raster is hetzelfde als in web/src/grid.ts (Web Mercator, ±250 m).
Schrijft data/bike_grid/<regio>_edges.npz en output/bike_grid_<regio>.png, en drukt een samenvatting af.
"""
import json
import sys
import time
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

ROOT = Path(__file__).resolve().parent.parent
REGIONS = {  # lat_min, lat_max, lon_min, lon_max
    "zeeland": (51.20, 51.75, 3.35, 4.30),
    "utrecht": (51.95, 52.25, 4.85, 5.35),
}
REGION = sys.argv[1] if len(sys.argv) > 1 else "zeeland"
N_STOPS = int(sys.argv[2]) if len(sys.argv) > 2 else 60
VARIANT = sys.argv[3] if len(sys.argv) > 3 else "8"
DATE = "20261110"
OSRM = "http://localhost:5000/table/v1/bike/"
OUT_DATA = ROOT / "data" / "bike_grid"
OUT = ROOT / "output"

KMH, DETOUR, BIKE_MAX = 15.0, 1.3, 5000.0
SNAP_MAX = 250.0     # m; cel verder van een fietsbare weg = geen knoop (water, weiland)
BLOCK = 8            # cellen per blok per OSRM-verzoek
Q_STEP = 1 / 32      # kwantisering van de omrijfactor per kant (uint8: 1 + q·Q_STEP, 255 = geen kant)

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


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000.0 * np.arcsin(np.sqrt(a))


def table(lats, lons, sources=None, destinations=None):
    coords = ";".join(f"{x:.6f},{y:.6f}" for x, y in zip(lons, lats))
    q = "annotations=distance"
    if sources is not None:
        q += "&sources=" + ";".join(map(str, sources))
    if destinations is not None:
        q += "&destinations=" + ";".join(map(str, destinations))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(f"{OSRM}{coords}?{q}", timeout=120) as resp:
                return json.load(resp)
        except Exception as err:
            print(f"  fout ({err}), poging {attempt + 1}")
            time.sleep(2)
    raise RuntimeError("OSRM (localhost:5000) onbereikbaar; start met: bash pipeline/osrm_setup.sh start")


# --- regio in rastercellen ---
la0, la1, lo0, lo1 = REGIONS[REGION]
I0, I1 = int((mercX(lo0) - X0) // CELL), int((mercX(lo1) - X0) // CELL)
J0, J1 = int((mercY(la0) - Y0) // CELL), int((mercY(la1) - Y0) // CELL)
NI, NJ = I1 - I0 + 1, J1 - J0 + 1
ii, jj = np.meshgrid(np.arange(I0, I1 + 1), np.arange(J0, J1 + 1))   # [j, i]
clat = invLat(Y0 + (jj + 0.5) * CELL)
clon = invLon(X0 + (ii + 0.5) * CELL)
# kanten "vooruit" (de rest zijn dezelfde kanten terug); (di, dj) in cellen
DIRS = [(1, 0), (0, 1), (1, 1), (-1, 1)]                     # 8 richtingen
if VARIANT in ("16", "16L"):
    DIRS += [(2, 1), (1, 2), (-1, 2), (-2, 1)]               # + paardensprongen: 16 richtingen
if VARIANT == "16L":
    DIRS += [(2, 0), (0, 2), (2, 2), (-2, 2)]                # + lange rechte kanten tegen zigzag
M_I = max(abs(di) for di, _ in DIRS)
M_J = max(dj for _, dj in DIRS)


def build_edges():
    """B: per cel de wegafstand naar 4 buren, per blok één OSRM-tabel"""
    f = OUT_DATA / f"{REGION}_edges{'' if VARIANT == '8' else VARIANT}.npz"
    if f.exists():
        z = np.load(f)
        return z["snap"], z["road"]
    snap = np.full((NJ, NI), np.inf)
    road = np.full((len(DIRS), NJ, NI), np.inf)   # wegafstand tussen de gesnapte punten

    def block(b):
        bj, bi = b
        # blok plus een rand erboven en links en rechts, voor de buren
        js = np.arange(bj, min(bj + BLOCK + M_J, NJ))
        is_ = np.arange(max(bi - M_I, 0), min(bi + BLOCK + M_I, NI))
        gj, gi = np.meshgrid(js, is_, indexing="ij")
        gj, gi = gj.ravel(), gi.ravel()
        res = table(clat[gj, gi], clon[gj, gi])
        idx = {(a, c): n for n, (a, c) in enumerate(zip(gj, gi))}
        out = []
        for (a, c), n in idx.items():
            if not (bj <= a < bj + BLOCK and bi <= c < bi + BLOCK):
                continue
            row = [res["sources"][n]["distance"], []]
            for di, dj in DIRS:
                m = idx.get((a + dj, c + di))
                d = None if m is None else res["distances"][n][m]
                e = None if m is None else res["distances"][m][n]
                row[1].append(None if d is None or e is None else (d + e) / 2)
            out.append((a, c, row))
        return out

    blocks = [(bj, bi) for bj in range(0, NJ, BLOCK) for bi in range(0, NI, BLOCK)]
    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        for k, out in enumerate(ex.map(block, blocks)):
            for a, c, (s, ds) in out:
                snap[a, c] = s
                for n, d in enumerate(ds):
                    if d is not None:
                        road[n, a, c] = d
            if k % 200 == 0:
                print(f"  blok {k}/{len(blocks)}  {time.time() - t0:.0f} s")
    print(f"kanten: {len(blocks)} OSRM-verzoeken in {time.time() - t0:.0f} s")
    OUT_DATA.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(f, snap=snap, road=road)
    return snap, road


def quantize(snap, road):
    """kanten als uint8-omrijfactor t.o.v. de rechte lijn tussen de celmiddens; 255 = geen kant"""
    q = np.full(road.shape, 255, np.uint8)
    node = snap <= SNAP_MAX
    for n, (di, dj) in enumerate(DIRS):
        a0, a1 = max(0, -dj), NJ - max(0, dj)
        c0, c1 = max(0, -di), NI - max(0, di)
        nb = np.zeros_like(node)
        nb[a0:a1, c0:c1] = node[a0 + dj:a1 + dj, c0 + di:c1 + di]
        b_lat = np.roll(np.roll(clat, -dj, 0), -di, 1)
        b_lon = np.roll(np.roll(clon, -dj, 0), -di, 1)
        straight = haversine(clat, clon, b_lat, b_lon)
        ratio = road[n] / straight
        ok = node & nb & np.isfinite(ratio)
        qq = np.clip(np.round((np.maximum(ratio, 1) - 1) / Q_STEP), 0, 254)
        q[n][ok] = qq[ok].astype(np.uint8)
    return q, node


def grid_graph(q, node):
    """B in de browser: ongerichte graaf over de cellen met de gekwantiseerde kanten"""
    rows, cols, w = [], [], []
    idx = np.arange(NJ * NI).reshape(NJ, NI)
    for n, (di, dj) in enumerate(DIRS):
        a, c = np.nonzero(q[n] < 255)
        straight = haversine(clat[a, c], clon[a, c], clat[a + dj, c + di], clon[a + dj, c + di])
        d = straight * (1 + q[n][a, c] * Q_STEP)
        rows += [idx[a, c], idx[a + dj, c + di]]
        cols += [idx[a + dj, c + di], idx[a, c]]
        w += [d, d]
    rows, cols, w = map(np.concatenate, (rows, cols, w))
    return coo_matrix((w, (rows, cols)), shape=(NJ * NI, NJ * NI)).tocsr()


def evaluate(graph, node):
    g = np.load(ROOT / "data" / f"day_{DATE}" / "graph.npz")
    lat, lon, names = g["area_lat"], g["area_lon"], g["area_name"]
    inside = np.flatnonzero((lat > la0 + 0.05) & (lat < la1 - 0.05) & (lon > lo0 + 0.07) & (lon < lo1 - 0.07))
    picks = np.random.default_rng(7).choice(inside, size=min(N_STOPS, len(inside)), replace=False)
    t_true, t_grid, t_model, cnt_cells = [], [], [], []
    for s in picks:
        dd = haversine(lat[s], lon[s], clat, clon)
        near = np.flatnonzero((dd <= BIKE_MAX / DETOUR).ravel() & node.ravel())   # zelfde venster als de kegel
        cnt_cells.append(len(near))
        # waarheid: OSRM halte → celmidden, plus de snapafstanden (zoals bike_check.py)
        res = table(np.r_[lat[s], clat.ravel()[near]], np.r_[lon[s], clon.ravel()[near]], sources=[0])
        if res["sources"][0]["distance"] > SNAP_MAX:
            continue
        d_true = np.array([np.nan if x is None else x for x in res["distances"][0][1:]], float)
        d_true += res["sources"][0]["distance"] + np.array([x["distance"] for x in res["destinations"][1:]])
        # raster: start in de cel van de halte, met de echte afstand halte → die cel
        own = int((mercY(lat[s]) - Y0) // CELL) - J0, int((mercX(lon[s]) - X0) // CELL) - I0
        own_k = own[0] * NI + own[1]
        hit = np.flatnonzero(near == own_k)
        if not len(hit) or np.isnan(d_true[hit[0]]):
            continue
        # celknoop = het gesnapte punt van het celmidden: halte → eigen knoop, dan over het raster,
        # dan van de knoop van de doelcel naar het celmidden
        snap_dst = np.array([x["distance"] for x in res["destinations"][1:]])
        start = d_true[hit[0]] - snap_dst[hit[0]]
        d_grid = dijkstra(graph, indices=own_k, limit=3 * BIKE_MAX)[near] + start + snap_dst
        t_true.append(d_true)
        t_grid.append(d_grid)
        t_model.append(dd.ravel()[near] * DETOUR)
    v = KMH / 3.6 * 60
    T, G, M = (np.concatenate(x) / v for x in (t_true, t_grid, t_model))
    ok = np.isfinite(T)
    T, G, M = T[ok], G[ok], M[ok]
    return T, G, M, np.mean(cnt_cells), len(t_true)


def main():
    print(f"regio {REGION}, variant {VARIANT} ({2 * len(DIRS)} richtingen): {NI} × {NJ} = {NI * NJ} cellen")
    snap, road = build_edges()
    q, node = quantize(snap, road)
    print(f"cellen met een fietsbare weg binnen {SNAP_MAX:.0f} m: {node.mean():.1%}")

    # B: grootte
    raw = q.tobytes()
    packed = zlib.compress(np.ascontiguousarray(q.transpose(1, 2, 0)).tobytes(), 9)
    full_nl = 1146 * 1378
    print(f"\nB. fietsraster: {len(raw) / 1e6:.2f} MB ruw, {len(packed) / 1e6:.2f} MB zlib "
          f"→ heel NL ±{len(packed) / (NI * NJ) * full_nl / 1e6:.1f} MB (zelfde verhouding land/water)")

    graph = grid_graph(q, node)
    T, G, M, ncell, nstop = evaluate(graph, node)
    q_ = lambda s: np.round(np.quantile(s, [0.02, 0.1, 0.5, 0.9, 0.98]), 1).tolist()
    print(f"\nproef: {nstop} haltes, gemiddeld {ncell:.0f} cellen binnen 5 km, {len(T)} paren")
    print("fout in minuten (schatting − OSRM), percentielen 2/10/50/90/98:")
    print(f"  model hemelsbreed × 1,3 : {q_(M - T)}   |fout| > 5 min: {(abs(M - T) > 5).mean():.1%}")
    print(f"  B. fietsraster          : {q_(G - T)}   |fout| > 5 min: {(abs(G - T) > 5).mean():.1%}")
    k = np.median(T / G)
    print(f"  B. relatief (raster/OSRM): mediaan {np.median(G / T):.3f}")
    print(f"  B. × {k:.3f} (vaste correctie): {q_(G * k - T)}   |fout| > 5 min: {(abs(G * k - T) > 5).mean():.1%}"
          f"   > 3 min: {(abs(G * k - T) > 3).mean():.1%}")
    print(f"  model, ter vergelijking      : |fout| > 3 min: {(abs(M - T) > 3).mean():.1%}")

    # A: tabellen per halte, voor heel NL geschat uit deze regio
    n_area = 34000
    for thr in (2, 3, 5):
        frac = (abs(M - T) > thr).mean()
        n = n_area * ncell * frac
        print(f"A. correcties > {thr} min: {frac:.1%} van de paren → NL ±{n / 1e6:.1f} mln × 3 B = ±{3 * n / 1e6:.0f} MB")
    print(f"A. volledige tabel: NL ±{n_area * ncell / 1e6:.0f} mln waarden × 1 B")

    OUT.mkdir(exist_ok=True)
    fig, axes = plt.subplots(1, 2, figsize=(15, 7))
    ax = axes[0]
    ax.imshow(np.where(node, (q < 255).sum(0), np.nan), origin="lower", cmap="viridis",
              extent=(lo0, lo1, la0, la1), aspect=1 / np.cos(np.radians((la0 + la1) / 2)))
    ax.set_title(f"{REGION}: aantal kanten vooruit per cel, wit = geen weg binnen {SNAP_MAX:.0f} m")
    ax = axes[1]
    bins = np.linspace(-15, 25, 81)
    ax.hist(M - T, bins, alpha=0.5, label="hemelsbreed × 1,3")
    ax.hist(G - T, bins, alpha=0.5, label="fietsraster")
    ax.set_yscale("log")
    ax.set_xlabel("schatting − OSRM (min)")
    ax.legend()
    fig.tight_layout()
    name = f"bike_grid_{REGION}_{VARIANT}.png"
    fig.savefig(OUT / name, dpi=110)
    print(f"\nfiguur: {OUT / name}")


if __name__ == "__main__":
    main()
