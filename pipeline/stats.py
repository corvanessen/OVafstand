"""Fase 0, stap 2: statistieken van één dag GTFS, om de schattingen in ONTWIKKELPLAN.md te toetsen."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATE = sys.argv[1] if len(sys.argv) > 1 else "20261110"
D = ROOT / "data" / f"day_{DATE}"

ROUTE_TYPES = {0: "tram", 1: "metro", 2: "trein", 3: "bus", 4: "veerboot", 7: "kabelbaan"}


def main():
    stops = pd.read_pickle(D / "stops.pkl")
    routes = pd.read_pickle(D / "routes.pkl")
    trips = pd.read_pickle(D / "trips.pkl")
    st = pd.read_pickle(D / "stop_times.pkl")

    print("== Haltes (stops.txt, hele feed)")
    print(stops.location_type.fillna("0").value_counts().rename("aantal").to_string())
    used = st.stop_id.unique()
    su = stops[stops.stop_id.isin(used)]
    print(f"haltepalen gebruikt op {DATE}: {len(su):,}")
    print(f"  daarvan met parent_station: {su.parent_station.notna().sum():,}, "
          f"unieke parent_stations: {su.parent_station.nunique():,}")
    in_nl = su.stop_lat.between(50.7, 53.6) & su.stop_lon.between(3.3, 7.25)
    print(f"  binnen NL-bbox: {in_nl.sum():,}, daarbuiten: {(~in_nl).sum():,}")

    print("\n== Ritten en connections per modaliteit")
    tr = trips.merge(routes[["route_id", "route_type", "agency_id"]], on="route_id")
    tr["mode"] = tr.route_type.astype(int).map(ROUTE_TYPES).fillna("overig")
    n_st = st.groupby("trip_id").size().rename("n_stops")
    tr = tr.join(n_st, on="trip_id")
    tr["n_conn"] = tr.n_stops - 1
    print(tr.groupby("mode").agg(routes=("route_id", "nunique"), ritten=("trip_id", "size"),
                                 connections=("n_conn", "sum")).to_string())
    print(f"totaal connections: {tr.n_conn.sum():,}")

    # connections per uur (vertrek)
    first = st.groupby("trip_id").dep.transform("max")
    dep_conn = st[st.dep != first].dep  # ruwe benadering: elke stop behalve de laatste
    hours = (dep_conn // 3600).value_counts().sort_index()
    print("\n== Vertrekkende connections per uur")
    print(" ".join(f"{h:02d}:{c // 1000}k" for h, c in hours.items()))

    print("\n== Lijnpatronen en headways (07-19u)")
    seq = st.groupby("trip_id").stop_id.agg(tuple)
    tr["pattern"] = tr.trip_id.map(seq)
    tr["start"] = tr.trip_id.map(st.groupby("trip_id").dep.min())
    print(f"unieke stopvolgordes (patronen): {tr.pattern.nunique():,}")
    day = tr[(tr.start >= 7 * 3600) & (tr.start < 19 * 3600)]
    per_route_dir = day.groupby(["route_id", "direction_id"]).size()
    headway_min = (12 * 60) / per_route_dir
    bins = [0, 5, 10, 15, 30, 60, 120, 1e9]
    labels = ["<=5", "5-10", "10-15", "15-30", "30-60", "60-120", ">120"]
    hw = pd.cut(headway_min, bins=bins, labels=labels).value_counts().reindex(labels)
    print("gemiddelde interval per route+richting (min), aantal routes:")
    print(hw.to_string())

    print("\n== Agencies (top 15 op connections)")
    print(tr.groupby("agency_id").n_conn.sum().sort_values(ascending=False).head(15).to_string())


if __name__ == "__main__":
    main()
