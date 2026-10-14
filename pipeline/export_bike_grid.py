"""Fase 3: het fietsraster coderen voor de browser.

Gebruik:  python pipeline/export_bike_grid.py

Leest data/bike_grid/nl_raw.npz (van build_bike_grid.py) en schrijft web/public/data/bike.bin.gz.
Keuzes (zie ONTWIKKELPLAN.md, fase 3, stap 5):
  - 4 bits per kant, 15 niveaus van de omrijfactor t.o.v. de rechte lijn tussen de celmiddens, 15 = geen kant;
    factoren boven ±5 worden "geen kant", nooit naar beneden afgerond (anders sluiproutes over water);
  - overbodige kanten weg: als een pad over twee andere kanten even kort of korter is;
  - per cel 4 bits snapafstand (celknoop → celmidden, stappen van 17 m);
  - per halteplek de afstand naar de knopen van de 3 × 3 cellen eromheen (uint8, stappen van 8 m).

Formaat (little endian), daarna gzip:
  header  "FIETS1\\0\\0", uint16 NX, NY, nDirs, seedR, uint32 nArea, 8 × (int8 di, dj), 15 × float32 niveaus,
          float32 snapStap, float32 seedStap
  kanten  NX·NY × nDirs/2 bytes, per cel naast elkaar, twee kanten per byte (hoge nibble eerst)
  snap    NX·NY / 2 bytes, twee cellen per byte (hoge nibble eerst; 15 = geen knoop)
  seeds   nArea × (2R+1)² bytes (255 = geen verbinding)
"""
import gzip
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "bike_grid" / "nl_raw.npz"
OUT = ROOT / "web" / "public" / "data" / "bike.bin.gz"

LEVELS = np.array([1.0, 1.04, 1.08, 1.13, 1.19, 1.26, 1.35, 1.46, 1.6, 1.8, 2.05, 2.4, 2.9, 3.6, 4.5])
SNAP_MAX, SNAP_STEP = 250.0, 17.0
SEED_STEP = 8.0

# --- raster, gelijk aan grid.ts ---
R = 6378137.0
DEG = np.pi / 180
CELL = 250 / np.cos(52.2 * DEG)
X0, Y0 = R * 3.2 * DEG, R * np.log(np.tan(np.pi / 4 + 50.6 * DEG / 2))
invLat = lambda y: (2 * np.arctan(np.exp(y / R)) - np.pi / 2) / DEG


def shift(arr, di, dj, fill=np.inf):
    """out[j, i] = arr[j + dj, i + di]"""
    NY, NX = arr.shape
    out = np.full(arr.shape, fill, arr.dtype)
    a0, a1, c0, c1 = max(0, -dj), NY - max(0, dj), max(0, -di), NX - max(0, di)
    out[a0:a1, c0:c1] = arr[a0 + dj:a1 + dj, c0 + di:c1 + di]
    return out


def main():
    z = np.load(RAW)
    snap, road, dirs = z["snap"], z["road"], [tuple(d) for d in z["dirs"]]
    NY, NX = snap.shape
    node = snap <= SNAP_MAX
    # rechte afstand tussen celmiddens, per rij (de mercatorschaal hangt alleen van de breedte af)
    scale = np.cos(invLat(Y0 + (np.arange(NY) + 0.5) * CELL) * DEG)        # echte m per mercator-m
    straight = np.array([np.hypot(di, dj) * CELL * scale for di, dj in dirs])  # [richting, rij]

    # 1. omrijfactor → 4-bitsniveau; geen kant als een van beide cellen geen knoop is
    L = np.full(road.shape, np.inf)
    lv = np.full(road.shape, 15, np.uint8)
    for k, (di, dj) in enumerate(dirs):
        ok = node & shift(node, di, dj, False) & np.isfinite(road[k])
        ratio = np.maximum(road[k] / straight[k][:, None], 1.0)
        level = np.abs(np.log(ratio)[..., None] - np.log(LEVELS)).argmin(-1)
        ok &= ratio <= LEVELS[-1] * 1.1
        lv[k][ok] = level[ok]
        L[k][ok] = (straight[k][:, None] * LEVELS[level])[ok]
    n_edges = (lv < 15).sum()

    # 2. snoeien: kant weg als een pad over twee andere kanten even kort of korter is
    full = [((di, dj), k, True) for k, (di, dj) in enumerate(dirs)] + \
           [((-di, -dj), k, False) for k, (di, dj) in enumerate(dirs)]
    lookup = {vec: (vec, k, f) for vec, k, f in full}

    def get(vec, k, fwd):   # lengte van kant u → u+vec, per cel u
        return L[k] if fwd else shift(L[k], vec[0], vec[1])

    drop = np.zeros(lv.shape, bool)
    for k, target in enumerate(dirs):
        best = np.full((NY, NX), np.inf)
        for v1, k1, f1 in full:
            v2 = (target[0] - v1[0], target[1] - v1[1])
            if v2 in lookup:
                best = np.minimum(best, get(v1, k1, f1) + shift(get(*lookup[v2]), *v1))
        drop[k] = (lv[k] < 15) & (best <= L[k] + 1e-6)
    lv[drop] = 15
    print(f"kanten: {n_edges} → {(lv < 15).sum()} na snoeien ({(lv < 15).sum() / n_edges:.0%})")

    # 3. snapafstand per cel, 4 bits
    sn = np.where(node, np.minimum(np.round(snap / SNAP_STEP), 14), 15).astype(np.uint8)

    # 4. startcellen per halteplek: halte → zijn gesnapte punt → celknoop
    seed = z["seed_dist"] + z["seed_snap"][:, None]
    seed_ok = np.isfinite(seed) & (z["seed_snap"][:, None] <= SNAP_MAX)
    # alleen cellen die zelf een knoop zijn
    R_ = int(z["seed_r"])
    offs = [(dj, di) for dj in range(-R_, R_ + 1) for di in range(-R_, R_ + 1)]
    for m, (dj, di) in enumerate(offs):
        cj = np.clip(z["seed_j"] + dj, 0, NY - 1)
        ci = np.clip(z["seed_i"] + di, 0, NX - 1)
        seed_ok[:, m] &= node[cj, ci]
    seeds = np.where(seed_ok, np.minimum(np.round(seed / SEED_STEP), 254), 255).astype(np.uint8)
    n_area = len(seeds)
    print(f"halteplekken: {n_area}, zonder enige startcel: {(~seed_ok.any(1)).sum()}")

    # 5. schrijven
    edges = np.ascontiguousarray(lv.transpose(1, 2, 0)).reshape(-1)     # [cel][richting]
    edges = (edges[0::2] << 4 | edges[1::2]).astype(np.uint8)
    snaps = sn.reshape(-1)
    if len(snaps) % 2:
        snaps = np.r_[snaps, 15].astype(np.uint8)
    snaps = (snaps[0::2] << 4 | snaps[1::2]).astype(np.uint8)
    head = b"FIETS1\0\0" + struct.pack("<4HI", NX, NY, len(dirs), R_, n_area)
    head += b"".join(struct.pack("<2b", di, dj) for di, dj in dirs)
    head += struct.pack(f"<{len(LEVELS)}f", *LEVELS) + struct.pack("<2f", SNAP_STEP, SEED_STEP)
    raw = head + edges.tobytes() + snaps.tobytes() + seeds.tobytes()
    OUT.write_bytes(gzip.compress(raw, 9))
    print(f"{OUT}: {len(raw) / 1e6:.1f} MB ruw, {OUT.stat().st_size / 1e6:.2f} MB gzip "
          f"(kanten {len(edges) / 1e6:.1f}, snap {len(snaps) / 1e6:.1f}, startcellen {seeds.size / 1e6:.2f} MB ruw)")


if __name__ == "__main__":
    main()
