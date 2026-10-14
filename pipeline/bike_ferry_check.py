"""Fase 3: doen de veerponten mee in het fietsraster?

Gebruik:  python pipeline/bike_ferry_check.py [raster.npz]      (standaard data/bike_grid/grens_raw.npz)

Leest de ponten uit OSM (data/bike_grid/ferries.geojsonseq, zie ONTWIKKELPLAN.md fase 3 stap 8 voor het
osmium-commando) en zoekt per pont de kortste weg door het fietsraster tussen de knopen bij beide
aanlegplaatsen. Is die weg niet veel langer dan de pont zelf, dan vaart de pont mee in het raster.
De kanten zijn de ruwe OSRM-afstanden, met dezelfde regels als export_bike_grid.py (beide cellen een
knoop, omrijfactor ≤ ±5), maar zonder de 4-bitsafronding.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from build_bike_grid import CELL, NX, NY, X0, Y0, clat, clon, mercX, mercY
from export_bike_grid import LEVELS, SNAP_MAX

ROOT = Path(__file__).resolve().parent.parent
RAW = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "bike_grid" / "grens_raw.npz"
FERRIES = ROOT / "data" / "bike_grid" / "ferries.geojsonseq"


def haversine(lat1, lon1, lat2, lon2):
    p = np.pi / 180
    a = np.sin((lat2 - lat1) * p / 2) ** 2 + np.cos(lat1 * p) * np.cos(lat2 * p) * np.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * 6371000 * np.arcsin(np.sqrt(a))


def graph(z):
    snap, road, dirs = z["snap"], z["road"], [tuple(d) for d in z["dirs"]]
    node = snap <= SNAP_MAX
    ids = np.arange(NY * NX).reshape(NY, NX)
    rows, cols, vals = [], [], []
    for k, (di, dj) in enumerate(dirs):
        j, i = np.nonzero(node)
        j2, i2 = j + dj, i + di
        ok = (j2 >= 0) & (j2 < NY) & (i2 >= 0) & (i2 < NX)
        j, i, j2, i2 = j[ok], i[ok], j2[ok], i2[ok]
        d = road[k][j, i]
        straight = haversine(clat[j], clon[i], clat[j2], clon[i2])
        ok = node[j2, i2] & np.isfinite(d) & (d <= straight * LEVELS[-1] * 1.1)
        a, b, d = ids[j, i][ok], ids[j2, i2][ok], np.maximum(d[ok], 1.0)
        rows += [a, b]
        cols += [b, a]
        vals += [d, d]
    g = csr_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(NY * NX,) * 2)
    return g, node, snap


def nearest_node(lat, lon, node, snap):
    """de knoop-cel het dichtst bij (lat, lon), binnen 2 cellen; -1 als die er niet is"""
    j0 = int(np.floor((mercY(lat) - Y0) / CELL))
    i0 = int(np.floor((mercX(lon) - X0) / CELL))
    best, bd = -1, np.inf
    for j in range(j0 - 2, j0 + 3):
        for i in range(i0 - 2, i0 + 3):
            if 0 <= j < NY and 0 <= i < NX and node[j, i]:
                d = haversine(lat, lon, clat[j], clon[i])
                if d < bd:
                    best, bd = j * NX + i, d
    return best


def main():
    z = np.load(RAW)
    g, node, snap = graph(z)
    print(f"raster {RAW.name}: {node.sum()} knopen, {g.nnz // 2} kanten")

    ferries = []
    for line in FERRIES.open(encoding="utf8"):
        f = json.loads(line.strip("\x1e"))
        p = f["properties"]
        if f["geometry"]["type"] != "LineString" or p.get("route") != "ferry":
            continue
        c = np.array(f["geometry"]["coordinates"])
        length = haversine(c[:-1, 1], c[:-1, 0], c[1:, 1], c[1:, 0]).sum()
        bike = p.get("bicycle", "")
        ferries.append(dict(id=p["@id"], name=p.get("name", "?"), bike=bike, length=length,
                            a=(c[0, 1], c[0, 0]), b=(c[-1, 1], c[-1, 0])))
    print(f"ponten in OSM (route=ferry): {len(ferries)}")

    res = []
    for f in ferries:
        na, nb = nearest_node(*f["a"], node, snap), nearest_node(*f["b"], node, snap)
        if na < 0 or nb < 0:
            res.append((f, None, "geen knoop"))
            continue
        lim = max(4 * f["length"], 5000)
        d = dijkstra(g, indices=na, limit=lim)[nb]
        # de knopen liggen tot ±2 cellen van de aanlegplaatsen: 1 km speling
        ok = d <= 1.3 * f["length"] + 1000
        res.append((f, d, "mee" if ok else ("omweg" if np.isfinite(d) else "geen route")))

    from collections import Counter
    print("\nuitkomst, alle ponten:", dict(Counter(r[2] for r in res)))
    for bike in ["yes", "", "no"]:
        sub = [r for r in res if r[0]["bike"] == bike]
        print(f"  bicycle={bike or '(leeg)'}: {dict(Counter(r[2] for r in sub))}")
    print("\nponten zonder bicycle=no die niet meedoen (lengte, rasterafstand):")
    for f, d, s in sorted(res, key=lambda r: r[0]["length"]):
        if s != "mee" and f["bike"] != "no":
            dd = "–" if d is None or not np.isfinite(d) else f"{d / 1000:.1f} km"
            print(f"  {s:10s} {f['length'] / 1000:5.2f} km  {dd:>8s}  w{f['id']}  {f['name']}  "
                  f"({f['a'][0]:.4f}, {f['a'][1]:.4f})  bicycle={f['bike'] or '-'}")
    print("\nponten met bicycle=no die wel meedoen (een andere weg, of het profiel negeert de tag):")
    for f, d, s in res:
        if s == "mee" and f["bike"] == "no":
            print(f"  {f['length'] / 1000:5.2f} km  {d / 1000:.1f} km  w{f['id']}  {f['name']}")


if __name__ == "__main__":
    main()
