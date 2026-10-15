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
  kind       Uint8[nEdge]          0 = vaste kost, 1 = instappen (kost = min(f * interval, cap)),
                                   2 = rijden, alleen buiten 07–19 u (nachtlijnen): alleen in het uurmodel,
                                   3 = rijden, maar niet op deze dag (een lijn die alleen in het weekend rijdt)
Een instapkant met kost 65535 rijdt niet in 07–19 u en is dicht in het dagmodel.
Knopen 0..nArea-1 zijn halteplekken, nArea..nNode-1 zijn lijnknopen (route+richting @ halteplek).

hours.bin.gz (uurmodel, fase 6.4; gzip): Uint8[nBoard × bins], per instapkant (kind=1, in de volgorde
van graph.bin) de gemiddelde wachttijd in minuten voor elk tijdvak van binMin minuten (meta.hours);
255 = geen vertrek binnen 254 min. De browser laadt het pas als er een vertrektijd gekozen wordt.

Meerdere dagen (fase 6.7 stap 4; graph.npz van build_graph.py met meerdere datums): graph.bin en
hours.bin.gz zijn de basisdag (werkdag). Voor elke andere dag (zaterdag, zondag) komen er
  day_<datum>.bin.gz    gzip van cost Uint16[nEdge] + kind Uint8[nEdge], in de volgorde van graph.bin
  hours_<datum>.bin.gz  het uurmodel van die dag, zoals hours.bin.gz
meta.days noemt ze: [{key: "wd" | "za" | "zo", date, file (null voor de basisdag), hours, conn}].

conn_<datum>.bin.gz (dienstregeling, fase 4; gzip), per dag alle ritten, voor CSA in de browser.
Achter elkaar, met de aantallen in meta.days[k].conn = {file, nTrip, nStop}:
  tripStart  Int32[nTrip]    aankomst op de eerste halte (s na middernacht, kan > 24:00 zijn)
  tripLen    Uint16[nTrip]   aantal haltes van de rit
  tripRoute  Uint16[nTrip]   index in meta.routes
  stopArea   Uint16[nStop]   halteplek, per rit de haltes op volgorde
  stopArr    Uint16[nStop]   aankomst in s na tripStart
  stopDwell  Uint16[nStop]   vertrek − aankomst in s
  stopFlags  Uint8[nStop]    1 = niet instappen, 2 = niet uitstappen
"""
import gzip
import json
import sys
from datetime import date as Date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATE = sys.argv[1] if len(sys.argv) > 1 else "20261110"
D = ROOT / "data" / f"day_{DATE}"
OUT = ROOT / "web" / "public" / "data"

KIND_FIXED, KIND_BOARD, KIND_NIGHT, KIND_OFF = 0, 1, 2, 3


def day_key(d: str) -> str:
    wd = Date(int(d[:4]), int(d[4:6]), int(d[6:])).weekday()
    return "za" if wd == 5 else "zo" if wd == 6 else "wd"


def hours_bytes(line_wait, rows):
    """uurmodel per instapkant (rows: de lijnknoop van elke instapkant), in minuten, 255 = geen vertrek"""
    wait_h = line_wait[rows] / 60
    hours = np.where(np.isfinite(wait_h), np.clip(np.round(wait_h), 0, 255), 255)
    hours[hours > 254] = 255
    return hours.astype(np.uint8)


def conn_bytes(date, area_idx, route_index):
    """de ritten van één dag als tabellen per rit en per halte (zie conn_<datum>.bin.gz hierboven)"""
    dd = ROOT / "data" / f"day_{date}"
    stops = pd.read_pickle(dd / "stops.pkl")
    stops["area"] = stops.parent_station.fillna(stops.stop_id)
    trips = pd.read_pickle(dd / "trips.pkl")
    st = pd.read_pickle(dd / "stop_times.pkl").merge(stops[["stop_id", "area"]], on="stop_id")
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)
    area = area_idx.reindex(st.area).to_numpy()
    assert not np.isnan(area).any(), "halteplek ontbreekt in de graaf"
    first = st.groupby("trip_id", sort=False)
    start = first.arr.transform("first").to_numpy()
    trip_ids = first.size().index
    n_stop = first.size().to_numpy()
    route = trips.set_index("trip_id").route_id.reindex(trip_ids)
    assert route.notna().all() and route.isin(route_index.index).all()
    arr_off = st.arr.to_numpy() - start
    dwell = st.dep.to_numpy() - st.arr.to_numpy()
    assert arr_off.min() >= 0 and arr_off.max() < 65536 and dwell.min() >= 0 and dwell.max() < 65536
    assert len(area_idx) < 65536 and n_stop.max() < 65536
    flags = (st.pickup_type.to_numpy() == 1) * 1 + (st.drop_off_type.to_numpy() == 1) * 2
    print(f"conn_{date}: {len(trip_ids):,} ritten, {len(st):,} haltes")
    parts = [first.arr.first().to_numpy(np.int32), n_stop.astype(np.uint16),
             route_index[route].to_numpy(np.uint16), area.astype(np.uint16), arr_off.astype(np.uint16),
             dwell.astype(np.uint16), flags.astype(np.uint8)]
    return b"".join(p.tobytes() for p in parts), len(trip_ids), len(st)


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
    line_row = np.r_[np.nonzero(b)[0], np.full(len(u) - b.sum(), -1)]   # instapkant -> lijnknoop
    order = np.argsort(u, kind="stable")
    u, v, line_row = u[order], v[order], line_row[order]

    # per dag cost en kind (een graph.npz van één dag heeft alleen de oude namen)
    if "dates" in g:
        dates = [str(d) for d in g["dates"]]
        per_day = [(g["day_headway_comb"][k], g["day_ride_t"][k], g["day_ride_kind"][k], g["day_line_wait"][k])
                   for k in range(len(dates))]
    else:
        dates = [DATE]
        per_day = [(g["line_headway_comb"], g["ride_t"],
                    np.where(g["ride_in_window"], KIND_FIXED, KIND_NIGHT), g["line_wait"])]

    def cost_kind(headway_comb, ride_t, ride_kind):
        cost = np.r_[headway_comb[b], np.zeros(a.sum()), ride_t, g["walk_t"]]
        kind = np.r_[np.full(b.sum(), KIND_BOARD), np.full(a.sum(), KIND_FIXED), ride_kind,
                     np.full(len(g["walk_u"]), KIND_FIXED)]
        return np.clip(np.round(cost), 0, 65535).astype(np.uint16)[order], kind.astype(np.uint8)[order]

    cost, kind = cost_kind(*per_day[0][:3])
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

    # uurmodel: wachttijd per instapkant per uur, in minuten; mtime=0, zodat dezelfde inhoud dezelfde bytes geeft
    board_rows = line_row[kind == KIND_BOARD]
    area_idx = pd.Series(np.arange(n_area), index=g["area_id"])
    days = []
    for k, d in enumerate(dates):
        hours = hours_bytes(per_day[k][3], board_rows)
        name = "hours.bin.gz" if k == 0 else f"hours_{d}.bin.gz"
        (OUT / name).write_bytes(gzip.compress(hours.tobytes(), 9, mtime=0))
        file = None
        if k > 0:
            c, kd = cost_kind(*per_day[k][:3])
            assert ((kd == KIND_BOARD) == (kind == KIND_BOARD)).all()   # dezelfde instapkanten: hours past
            file = f"day_{d}.bin.gz"
            (OUT / file).write_bytes(gzip.compress(c.tobytes() + kd.tobytes(), 9, mtime=0))
            print(f"{file}: {(OUT / file).stat().st_size / 1e6:.2f} MB, "
                  f"instapkanten open in het dagmodel {((kd == KIND_BOARD) & (c < 65535)).sum():,}")
        conn, n_trip, n_stop = conn_bytes(d, area_idx, route_index)
        conn_file = f"conn_{d}.bin.gz"
        (OUT / conn_file).write_bytes(gzip.compress(conn, 9, mtime=0))
        print(f"{conn_file}: {(OUT / conn_file).stat().st_size / 1e6:.2f} MB")
        days.append({"key": day_key(d), "date": d, "file": file, "hours": name,
                     "conn": {"file": conn_file, "nTrip": n_trip, "nStop": n_stop}})
        print(f"{name}: {hours.shape[0]:,} instapkanten × {hours.shape[1]} tijdvakken, {(OUT / name).stat().st_size / 1e6:.2f} MB")

    meta = {
        "date": DATE,
        "hours": {"file": "hours.bin.gz", "nBoard": int(hours.shape[0]), "bins": int(hours.shape[1]),
                  "binMin": int(g["bin_min"])},
        "days": days,
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
