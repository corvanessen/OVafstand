"""Verkenning fase 4: connections voor een dienstregelingsrouter (CSA) en hun grootte.

Een connection is één rit van halteplek naar volgende halteplek: vertrek, aankomst, van, naar, rit.
De halteplekken en hun volgorde komen uit graph.npz (build_graph.py), zodat de index gelijk is aan
die in graph.bin. Hops binnen één halteplek vallen weg, net als in consecutive_pairs.

Meet het aantal per uur en de grootte (ruw en gzip) in een paar coderingen. Schrijft
data/connections_<datum>.bin (kolommen achter elkaar) plus .json met de lengtes, alleen voor de
benchmark (web/bench/csa_bench.ts), niet voor de website.

Gebruik:  python pipeline/export_connections.py [YYYYMMDD]
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
G = ROOT / "data" / "day_20261110" / "graph.npz"   # de graaf van de basisdag (alle dagen samen)

NO_BOARD, NO_ALIGHT = 1, 2   # vlaggen per connection


def gz(b):
    return len(gzip.compress(b, 9, mtime=0))


def mb(n):
    return f"{n / 1e6:6.2f} MB"


def main():
    g = np.load(G)
    area_idx = pd.Series(np.arange(len(g["area_id"])), index=g["area_id"])
    stops = pd.read_pickle(D / "stops.pkl")
    stops["area"] = stops.parent_station.fillna(stops.stop_id)
    trips = pd.read_pickle(D / "trips.pkl")
    st = pd.read_pickle(D / "stop_times.pkl")
    st = st.merge(stops[["stop_id", "area"]], on="stop_id")
    st["a"] = area_idx.reindex(st.area).to_numpy()
    assert st.a.notna().all(), "halteplek ontbreekt in graph.npz"
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)
    trip_no = pd.Series(np.arange(len(trips)), index=trips.trip_id)
    st["trip"] = trip_no.reindex(st.trip_id).to_numpy()

    tid = st.trip.to_numpy()
    i0 = np.nonzero(tid[1:] == tid[:-1])[0]
    i1 = i0 + 1
    a = st.a.to_numpy().astype(np.int64)
    c = pd.DataFrame({
        "dep": st.dep.to_numpy()[i0], "arr": st.arr.to_numpy()[i1],
        "u": a[i0], "v": a[i1], "trip": tid[i0],
        "flags": ((st.pickup_type.to_numpy()[i0] == 1) * NO_BOARD
                  | (st.drop_off_type.to_numpy()[i1] == 1) * NO_ALIGHT).astype(np.uint8),
    })
    # een hop binnen één halteplek: de rit blijft staan, de tijd loopt door (die telt via de volgende hop)
    c = c[c.u != c.v]
    c = c.sort_values(["dep", "arr"], kind="stable").reset_index(drop=True)
    n = len(c)
    print(f"{DATE}: {len(trips):,} ritten, {n:,} connections")
    per_hour = np.bincount(np.minimum(c.dep.to_numpy() // 3600, 30), minlength=31)
    print("per uur:", " ".join(f"{h:02d}:{k // 1000}k" for h, k in enumerate(per_hour) if k))
    win = ((c.dep >= 7 * 3600) & (c.dep < 10 * 3600)).sum()
    print(f"07–10 u: {win:,}  (venster van 3 uur)")
    dur = (c.arr - c.dep).to_numpy()
    print(f"rijtijd: min {dur.min()} s, max {dur.max()} s, negatief {np.sum(dur < 0)}")
    n_area = int(g["n_area"])

    dep = c.dep.to_numpy()
    # (a) alles 32 bits, rij voor rij
    rows = np.empty(n, [("dep", "<u4"), ("arr", "<u4"), ("u", "<u4"), ("v", "<u4"), ("trip", "<u4")])
    for k in rows.dtype.names:
        rows[k] = c[k].to_numpy()
    sizes = {"(a) 5 × uint32, rijen": rows.tobytes()}
    # (b) kolommen, compact: dep als verschil, rijtijd uint16, halteplekken uint16, rit uint32
    ddep = np.diff(dep, prepend=0)
    assert n_area < 65536 and dur.max() < 65536
    cols = [np.minimum(ddep, 255).astype(np.uint8), dur.astype(np.uint16), c.u.to_numpy(np.uint16),
            c.v.to_numpy(np.uint16), c.trip.to_numpy(np.uint32), c["flags"].to_numpy(np.uint8)]
    print(f"dep-verschil > 255 s: {np.sum(ddep > 255)} keer")
    sizes["(b) kolommen, Δdep u8, rijtijd u16, u/v u16, rit u32"] = b"".join(x.tobytes() for x in cols)
    # (c) per rit: eerste vertrek, aantal, dan per halte de halteplek en de tijden als verschil
    per = st[["trip", "a", "arr", "dep"]]
    first = per.groupby("trip").dep.transform("first")
    n_stop = per.groupby("trip").size()
    trip_bytes = [n_stop.to_numpy(np.uint16), per.groupby("trip").dep.first().to_numpy(np.uint32),
                  per.a.to_numpy(np.uint16),
                  (per.arr - first).to_numpy(np.uint16), (per.dep - per.arr).to_numpy(np.uint8)]
    sizes["(c) per rit: halteplekken + tijden t.o.v. vertrek"] = b"".join(x.tobytes() for x in trip_bytes)
    # (d) per patroon: dezelfde reeks halteplekken met dezelfde tijden t.o.v. het eerste vertrek
    per = per.assign(off_a=(per.arr - first), off_d=(per.dep - first))
    sig = per.groupby("trip").apply(
        lambda t: (tuple(t.a), tuple(t.off_a), tuple(t.off_d)), include_groups=False)
    pat = pd.Series(pd.factorize(sig)[0], index=sig.index)
    uniq = sig.drop_duplicates()
    n_pat_stop = sum(len(s[0]) for s in uniq)
    print(f"patronen (zelfde haltes en tijden): {len(uniq):,} voor {len(sig):,} ritten, "
          f"{n_pat_stop:,} haltes in patronen")
    pat_bytes = (np.array([len(s[0]) for s in uniq], np.uint16).tobytes()
                 + np.concatenate([np.array(s[0], np.uint16) for s in uniq]).tobytes()
                 + np.concatenate([np.array(s[1]).astype(np.int16) for s in uniq]).tobytes()
                 + np.concatenate([np.diff(np.array(s[2]) - np.array(s[1]), prepend=0).astype(np.int8)
                                   for s in uniq]).tobytes())
    order = np.argsort(pat.to_numpy(), kind="stable")
    starts = per.groupby("trip").dep.first().to_numpy()[order]
    trip_tab = pat.to_numpy(np.uint32)[order].tobytes() + np.diff(starts, prepend=0).astype(np.int32).tobytes()
    sizes["(d) patronen + per rit (patroon, vertrek)"] = pat_bytes + trip_tab

    print(f"\n{'codering':55s} {'ruw':>10s} {'gzip':>10s}")
    for k, b in sizes.items():
        print(f"{k:55s} {mb(len(b))} {mb(gz(b))}")

    out = ROOT / "data" / f"connections_{DATE}.bin"
    arrays = [c.dep.to_numpy(np.int32), c.arr.to_numpy(np.int32), c.u.to_numpy(np.int32),
              c.v.to_numpy(np.int32), c.trip.to_numpy(np.int32), c["flags"].to_numpy(np.uint8)]
    out.write_bytes(b"".join(x.tobytes() for x in arrays))
    (out.with_suffix(".json")).write_text(json.dumps({"n": n, "nTrip": len(trips), "nArea": n_area}))
    print(f"\nopgeslagen: {out}")


if __name__ == "__main__":
    main()
