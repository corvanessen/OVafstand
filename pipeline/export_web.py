"""Fase 1: exporteer graph.npz naar een compact binair formaat voor de browser.

Gebruik:  python pipeline/export_web.py [YYYYMMDD]
Schrijft web/public/data/graph.bin en web/public/data/meta.json

graph.bin is een aaneenschakeling van typed arrays (little endian), in deze volgorde,
met byte-offsets in meta.json:
  areaLat    Float32[nArea]
  areaLon    Float32[nArea]
  offsets    Uint32[nNode + 1]     CSR: uitgaande kanten van knoop i = offsets[i] .. offsets[i+1]
  target     Uint32[nEdge]
  lineRoute  Uint16[nLine]         index in meta.routes, voor lijnknoop nArea + i
  cost       Uint16[nEdge]         seconden; bij instapkanten (kind=1) het interval in seconden
  kind       Uint8[nEdge]          0 = vaste kost, 1 = instappen (kost = min(f * interval, cap))
Knopen 0..nArea-1 zijn halteplekken, nArea..nNode-1 zijn lijnknopen (route+richting @ halteplek).

hours.bin.gz (uurmodel, fase 6.4; gzip): Uint8[nBoard × 24], per instapkant (kind=1, in de volgorde
van graph.bin) de gemiddelde wachttijd in minuten voor elk uur van de dag; 255 = geen vertrek binnen
254 min. De browser laadt het pas als er een vertrektijd gekozen wordt.
"""
import gzip
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATE = sys.argv[1] if len(sys.argv) > 1 else "20261110"
D = ROOT / "data" / f"day_{DATE}"
OUT = ROOT / "web" / "public" / "data"

KIND_FIXED, KIND_BOARD = 0, 1


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    g = dict(np.load(D / "graph.npz"))
    routes = pd.read_pickle(D / "routes.pkl").set_index("route_id")

    n_area = int(g["n_area"])
    n_line = len(g["line_node"])
    n_node = n_area + n_line
    assert (g["line_node"] == n_area + np.arange(n_line)).all()

    b, a = g["line_board"], g["line_alight"]
    u = np.r_[g["line_area"][b], g["line_node"][a], g["ride_u"], g["walk_u"]]
    v = np.r_[g["line_node"][b], g["line_area"][a], g["ride_v"], g["walk_v"]]
    cost = np.r_[g["line_headway_comb"][b], np.zeros(a.sum()), g["ride_t"], g["walk_t"]]
    kind = np.r_[np.full(b.sum(), KIND_BOARD), np.full(a.sum() + len(g["ride_u"]) + len(g["walk_u"]), KIND_FIXED)]
    cost = np.clip(np.round(cost), 0, 65535).astype(np.uint16)
    line_row = np.r_[np.nonzero(b)[0], np.full(len(u) - b.sum(), -1)]   # instapkant -> lijnknoop

    order = np.argsort(u, kind="stable")
    u, v, cost, kind = u[order], v[order], cost[order], kind[order].astype(np.uint8)
    line_row = line_row[order]
    offsets = np.zeros(n_node + 1, np.uint32)
    np.cumsum(np.bincount(u, minlength=n_node), out=offsets[1:])

    # routes: één tabel, lijnknoop -> index
    route_ids = pd.Series(g["line_group"]).str.split("|").str[0]
    uniq = route_ids.unique()
    route_index = pd.Series(np.arange(len(uniq)), index=uniq)
    line_route = route_index[route_ids].to_numpy(np.uint16)
    r = routes.reindex(uniq)
    route_table = [
        [str(sn) if isinstance(sn, str) else "", int(rt) if isinstance(rt, str) else 3,
         str(ag) if isinstance(ag, str) else "", str(ln) if isinstance(ln, str) else ""]
        for sn, rt, ag, ln in zip(r.route_short_name, r.route_type, r.agency_id, r.route_long_name)
    ]

    arrays = [
        ("areaLat", g["area_lat"].astype(np.float32)),
        ("areaLon", g["area_lon"].astype(np.float32)),
        ("offsets", offsets),
        ("target", v.astype(np.uint32)),
        ("lineRoute", line_route),
        ("cost", cost),
        ("kind", kind),
    ]
    layout = {}
    pos = 0
    with open(OUT / "graph.bin", "wb") as f:
        for name, arr in arrays:
            pad = (-pos) % arr.itemsize
            f.write(b"\0" * pad)
            pos += pad
            layout[name] = [pos, len(arr)]
            f.write(arr.tobytes())
            pos += arr.nbytes

    # uurmodel: wachttijd per instapkant per uur, in minuten
    wait_h = g["line_wait_h"][line_row[kind == KIND_BOARD]] / 60
    hours = np.where(np.isfinite(wait_h), np.clip(np.round(wait_h), 0, 255), 255)
    hours[hours > 254] = 255
    hours = hours.astype(np.uint8)
    (OUT / "hours.bin.gz").write_bytes(gzip.compress(hours.tobytes(), 9))
    print(f"hours.bin.gz: {hours.shape[0]:,} instapkanten × 24 uur, {(OUT / 'hours.bin.gz').stat().st_size / 1e6:.2f} MB")

    meta = {
        "date": DATE,
        "hours": {"file": "hours.bin.gz", "nBoard": int(hours.shape[0]), "bins": 24},
        "nArea": n_area, "nLine": n_line, "nNode": n_node, "nEdge": int(len(v)),
        "layout": layout,
        "areaNames": [str(s) for s in g["area_name"]],
        # [korte naam, route_type, vervoerder, lange naam]
        "routes": route_table,
    }
    with open(OUT / "meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
    print(f"graph.bin: {pos / 1e6:.2f} MB, meta.json: {(OUT / 'meta.json').stat().st_size / 1e6:.2f} MB")
    print(f"knopen {n_node:,}, kanten {len(v):,}, routes {len(uniq):,}")


if __name__ == "__main__":
    main()
