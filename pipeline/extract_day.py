"""Fase 0, stap 1: filter de NL GTFS op één representatieve werkdag.

Gebruik:  python pipeline/extract_day.py [YYYYMMDD]

Schrijft naar data/day_<datum>/:
  stops.pkl       alle haltes (stop_id, naam, lat, lon, parent_station, ...)
  routes.pkl      routes (route_id, agency, short_name, route_type)
  trips.pkl       ritten die op die dag rijden
  stop_times.pkl  stop_times van die ritten, tijden in seconden sinds middernacht
"""
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
GTFS = ROOT / "data" / "raw" / "gtfs-nl.zip"
DATE = sys.argv[1] if len(sys.argv) > 1 else "20261110"  # dinsdag, buiten schoolvakanties
OUT = ROOT / "data" / f"day_{DATE}"


def hms_to_sec(s: pd.Series) -> np.ndarray:
    # GTFS-tijden kunnen > 24:00:00 zijn (ritten na middernacht)
    parts = s.str.split(":", expand=True).astype(np.int32)
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]).to_numpy(np.int32)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with zipfile.ZipFile(GTFS) as z:
        cal = pd.read_csv(z.open("calendar_dates.txt"), dtype=str)
        services = set(cal.loc[(cal.date == DATE) & (cal.exception_type == "1"), "service_id"])
        print(f"{len(services)} service_ids actief op {DATE}")

        trips = pd.read_csv(z.open("trips.txt"), dtype=str,
                            usecols=["route_id", "service_id", "trip_id", "trip_headsign",
                                     "trip_short_name", "direction_id"])
        trips = trips[trips.service_id.isin(services)].reset_index(drop=True)
        trip_ids = set(trips.trip_id)
        print(f"{len(trips):,} ritten op die dag")

        routes = pd.read_csv(z.open("routes.txt"), dtype=str,
                             usecols=["route_id", "agency_id", "route_short_name",
                                      "route_long_name", "route_type"])
        stops = pd.read_csv(z.open("stops.txt"), dtype=str)
        stops["stop_lat"] = stops.stop_lat.astype(float)
        stops["stop_lon"] = stops.stop_lon.astype(float)

        chunks = []
        n_rows = 0
        reader = pd.read_csv(z.open("stop_times.txt"), dtype=str, chunksize=2_000_000,
                             usecols=["trip_id", "stop_sequence", "stop_id", "arrival_time",
                                      "departure_time", "pickup_type", "drop_off_type"])
        for chunk in reader:
            n_rows += len(chunk)
            chunk = chunk[chunk.trip_id.isin(trip_ids)]
            chunks.append(chunk)
            print(f"  stop_times gelezen: {n_rows:,}  ({time.time() - t0:.0f}s)", flush=True)

    st = pd.concat(chunks, ignore_index=True)
    st["stop_sequence"] = st.stop_sequence.astype(np.int32)
    st["arr"] = hms_to_sec(st.arrival_time)
    st["dep"] = hms_to_sec(st.departure_time)
    st["pickup_type"] = st.pickup_type.fillna("0").astype(np.int8)
    st["drop_off_type"] = st.drop_off_type.fillna("0").astype(np.int8)
    st = st.drop(columns=["arrival_time", "departure_time"])
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)

    stops.to_pickle(OUT / "stops.pkl")
    routes.to_pickle(OUT / "routes.pkl")
    trips.to_pickle(OUT / "trips.pkl")
    st.to_pickle(OUT / "stop_times.pkl")
    print(f"klaar: {len(st):,} stop_times van {n_rows:,} totaal, in {time.time() - t0:.0f}s -> {OUT}")


if __name__ == "__main__":
    main()
