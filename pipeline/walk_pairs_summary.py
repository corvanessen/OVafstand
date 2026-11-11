"""Lopen, stap 0b: samenvatting van de proef met een looptraster per regio (bike_grid_test.py ... --foot).

Gebruik:  python pipeline/walk_pairs_summary.py [max_min]

Leest data/bike_grid/<regio>_16_s<R>[_4b]_foot_pairs.npz (per paar halte → cel: T = OSRM-voet, G = raster,
M = hemelsbreed × 1,3, in minuten bij 4 km/u) en telt alleen paren met T ≤ max_min (standaard 30 min = 2 km
lopen, de loopgrens). Verdere paren komen met die grens niet op de kaart, maar domineren anders de uitschieters
(barrières als kanalen en snelwegen: 1,6 km hemelsbreed kan 3,9 km lopen zijn).
"""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "bike_grid"
MAX_MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 30.0
REGIONS = ["utrecht", "zeeland", "denhaag", "amsterdam", "arnhem"]
VARIANTS = [("s1_4b", "4 bits, start 3×3 (zoals de fiets)"), ("s1", "8 bits, start 3×3"), ("s2_4b", "4 bits, start 5×5"), ("s3_4b", "4 bits, start 7×7")]


def row(T, G, M):
    reach = np.isfinite(G)
    e = G[reach] - T[reach]
    p = np.percentile(e, [50, 90, 98]).round(1) if len(e) else [np.nan] * 3
    pct = lambda x: f"{100 * x.mean():5.1f}%"
    return (f"{len(T):6d}  {pct(~reach | (np.abs(G - T) > 5))}  {pct(~reach | (np.abs(G - T) > 2))}  "
            f"{pct(np.abs(M - T) > 5)}  {pct(~reach)}   {p[0]:+.1f} / {p[1]:+.1f} / {p[2]:+.1f}")


def main():
    print(f"paren met OSRM-voet ≤ {MAX_MIN:.0f} min (4 km/u); fout = raster − OSRM-voet; niet bereikt telt als fout")
    for key, label in VARIANTS:
        print(f"\n{label}")
        print("regio        paren  raster>5 raster>2 hemelsbr>5 niet-bereikt  p50 / p90 / p98 (min)")
        all_ = []
        for r in REGIONS:
            f = DATA / f"{r}_16_{key}_foot_pairs.npz"
            if not f.exists():
                print(f"{r:11s}  (ontbreekt)")
                continue
            z = np.load(f)
            keep = z["T"] <= MAX_MIN
            T, G, M = z["T"][keep], z["G"][keep], z["M"][keep]
            all_.append((T, G, M))
            print(f"{r:11s} {row(T, G, M)}")
        if all_:
            print(f"{'totaal':11s} {row(*(np.concatenate(x) for x in zip(*all_)))}")


if __name__ == "__main__":
    main()
