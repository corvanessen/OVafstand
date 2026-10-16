"""Verkenning fase 5: wat brengt een buitenlandse GTFS-feed binnen de rasterbox?

Telt per feed op één dag:
  - haltes, halteplekken en ritten binnen de rasterbox (dezelfde box als het fietsraster);
  - connections (hops tussen opeenvolgende haltes) met beide haltes in de box;
  - idem in een strook langs de grens (STRIP_KM van de dichtstbijzijnde binnenlandse NL-halte);
  - overlap met de NL-feed: halteplekken binnen MATCH_M van een NL-halte met een gelijkende naam
    (grensstations), en vertrekken daar die de NL-feed op dezelfde minuut ook heeft (dubbele ritten).

De dag: calendar.txt plus calendar_dates.txt. Ligt DATE buiten de geldigheid van de feed, dan de
dinsdag die er het dichtst bij ligt (zo zijn ook oudere kopieën te tellen).

Gebruik:  python pipeline/border_survey.py <gtfs.zip> [YYYYMMDD]
De NL-kant komt uit data/day_20261110/ (extract_day.py).
"""
import datetime as dt
import sys
import time
import zipfile
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
ZIP = Path(sys.argv[1])
DATE = sys.argv[2] if len(sys.argv) > 2 else "20261110"
NL = ROOT / "data" / "day_20261110"

BOX = (3.2, 7.4, 50.6, 53.7)   # lon_min, lon_max, lat_min, lat_max (rasterbox van het fietsraster)
MATCH_M = 150
STRIP_KM = (20, 50)
# vervoerders in de NL-feed die (ook) in het buitenland rijden; hun haltes tellen niet als NL voor de strook
FOREIGN = {"DELIJN", "IFF:DB", "IFF:EUROBAHN", "IFF:EU_SLEEPER", "IFF:NMBS", "IFF:NS_INT", "IFF:VIAS"}
LAT0 = 52.2
KX = 111_320 * np.cos(np.radians(LAT0))
KY = 110_574


def xy(lat, lon):
    return np.c_[np.asarray(lon) * KX, np.asarray(lat) * KY]


def hms(s: pd.Series) -> np.ndarray:
    """HH:MM:SS -> seconden; lege tijden worden NaN"""
    p = s.str.split(":", expand=True)
    if p.shape[1] < 3:
        return np.full(len(s), np.nan)
    return (p[0].astype(float) * 3600 + p[1].astype(float) * 60 + p[2].astype(float)).to_numpy()


def norm(name: str) -> str:
    n = name.lower()
    for w in ("hbf", "hauptbahnhof", "bahnhof", "station", "centraal", "gare", "bf", "(", ")", "-", ",", "."):
        n = n.replace(w, " ")
    return " ".join(n.split())


def read(z, name, **kw):
    return pd.read_csv(z.open(name), dtype=str, **kw) if name in z.namelist() else None


def services_on(z, date):
    cal = read(z, "calendar.txt")
    cd = read(z, "calendar_dates.txt")
    days = []
    if cal is not None:
        days += [cal.start_date.min(), cal.end_date.max()]
    if cd is not None:
        days += [cd.date.min(), cd.date.max()]
    lo, hi = min(days), max(days)
    d = dt.datetime.strptime(date, "%Y%m%d").date()
    lo_d, hi_d = (dt.datetime.strptime(x, "%Y%m%d").date() for x in (lo, hi))
    if not lo_d <= d <= hi_d:
        # de dinsdag binnen de geldigheid die het dichtst bij ligt, bij voorkeur een week na het begin
        d = min(max(d, lo_d + dt.timedelta(days=7)), hi_d - dt.timedelta(days=7))
        d -= dt.timedelta(days=(d.weekday() - 1) % 7)
    ds = d.strftime("%Y%m%d")
    s = set()
    if cal is not None:
        col = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
        s |= set(cal.loc[(cal.start_date <= ds) & (cal.end_date >= ds) & (cal[col] == "1"), "service_id"])
    if cd is not None:
        on = cd[cd.date == ds]
        s |= set(on.loc[on.exception_type == "1", "service_id"])
        s -= set(on.loc[on.exception_type == "2", "service_id"])
    return ds, s, (lo, hi)


def main():
    t0 = time.time()
    print(f"== {ZIP}  ({ZIP.stat().st_size / 1e6:.0f} MB)")
    with zipfile.ZipFile(ZIP) as z:
        ds, services, (lo, hi) = services_on(z, DATE)
        print(f"geldig {lo}–{hi}; dag {ds} ({dt.datetime.strptime(ds, '%Y%m%d'):%a}), {len(services):,} service_ids")
        stops = read(z, "stops.txt")
        stops["lat"] = stops.stop_lat.astype(float)
        stops["lon"] = stops.stop_lon.astype(float)
        if "parent_station" not in stops:
            stops["parent_station"] = np.nan
        stops["area"] = stops.parent_station.replace("", np.nan).fillna(stops.stop_id)
        in_box = stops.lon.between(BOX[0], BOX[1]) & stops.lat.between(BOX[2], BOX[3])
        box_ids = set(stops.loc[in_box, "stop_id"])
        print(f"haltes: {len(stops):,}, in de box {in_box.sum():,}")

        trips = read(z, "trips.txt", usecols=["route_id", "service_id", "trip_id"])
        routes = read(z, "routes.txt", usecols=lambda c: c in ("route_id", "agency_id", "route_short_name", "route_type"))
        trips = trips[trips.service_id.isin(services)]
        active = set(trips.trip_id)
        print(f"ritten op {ds}: {len(trips):,}")

        # twee keer door stop_times: eerst welke ritten de box raken, dan die ritten helemaal
        cols = ["trip_id", "stop_sequence", "stop_id", "arrival_time", "departure_time"]
        touch = set()
        for ch in pd.read_csv(z.open("stop_times.txt"), dtype=str, usecols=cols[:3], chunksize=4_000_000):
            ch = ch[ch.trip_id.isin(active) & ch.stop_id.isin(box_ids)]
            touch |= set(ch.trip_id)
        print(f"ritten die de box raken: {len(touch):,}  ({time.time() - t0:.0f}s)")
        parts = []
        for ch in pd.read_csv(z.open("stop_times.txt"), dtype=str, usecols=cols, chunksize=4_000_000):
            parts.append(ch[ch.trip_id.isin(touch)])
    st = pd.concat(parts, ignore_index=True)
    st["seq"] = st.stop_sequence.astype(int)
    st = st.sort_values(["trip_id", "seq"]).reset_index(drop=True)
    st["dep"] = hms(st.departure_time.fillna(""))
    st = st.merge(stops[["stop_id", "area", "lat", "lon"]], on="stop_id")
    st = st.sort_values(["trip_id", "seq"]).reset_index(drop=True)
    st["box"] = st.stop_id.isin(box_ids)

    tid = st.trip_id.to_numpy()
    i0 = np.nonzero(tid[1:] == tid[:-1])[0]
    i1 = i0 + 1
    area = st.area.to_numpy()
    hop = area[i0] != area[i1]
    both = st.box.to_numpy()[i0] & st.box.to_numpy()[i1]
    n_conn = int(np.sum(hop & both))
    print(f"connections met beide haltes in de box: {n_conn:,} (NL-feed: 2,10 mln)")

    used = st[st.box]
    areas = (stops[stops.area.isin(used.area.unique())]
             .groupby("area").agg(lat=("lat", "mean"), lon=("lon", "mean"), name=("stop_name", "first")))
    print(f"halteplekken in gebruik in de box: {len(areas):,}")

    # --- strook langs de grens: afstand tot de dichtstbijzijnde binnenlandse NL-halte
    nl_stops = pd.read_pickle(NL / "stops.pkl")
    nl_st = pd.read_pickle(NL / "stop_times.pkl")
    nl_trips = pd.read_pickle(NL / "trips.pkl").merge(pd.read_pickle(NL / "routes.pkl"), on="route_id")
    domestic_trips = set(nl_trips.loc[~nl_trips.agency_id.isin(FOREIGN), "trip_id"])
    dom = nl_stops[nl_stops.stop_id.isin(nl_st.loc[nl_st.trip_id.isin(domestic_trips), "stop_id"].unique())]
    d_nl, _ = cKDTree(xy(dom.stop_lat, dom.stop_lon)).query(xy(areas.lat, areas.lon))
    areas["d_nl"] = d_nl
    d_hop = np.maximum(areas.d_nl.reindex(area[i0]).to_numpy(), areas.d_nl.reindex(area[i1]).to_numpy())
    for km in STRIP_KM:
        k = int(np.sum(hop & both & (d_hop <= km * 1000)))
        print(f"strook tot {km} km van een binnenlandse NL-halte: {np.sum(d_nl <= km * 1000):,} halteplekken, "
              f"{k:,} connections")

    # --- overlap met NL: halteplekken bij een NL-halte met een gelijkende naam
    nl_used = nl_stops[nl_stops.stop_id.isin(nl_st.stop_id.unique())].copy()
    nl_used["area"] = nl_used.parent_station.fillna(nl_used.stop_id)
    tree = cKDTree(xy(nl_used.stop_lat, nl_used.stop_lon))
    d, j = tree.query(xy(areas.lat, areas.lon))
    near = d <= MATCH_M
    nl_name = nl_used.stop_name.to_numpy()[j]
    sim = np.array([SequenceMatcher(None, norm(a), norm(b)).ratio() if n else 0
                    for a, b, n in zip(areas.name, nl_name, near)])
    areas["nl_area"] = np.where(near, nl_used.area.to_numpy()[j], None)
    areas["match"] = near & (sim >= 0.5)
    print(f"halteplekken binnen {MATCH_M} m van een NL-halte: {near.sum():,}, met gelijkende naam: {areas.match.sum():,}"
          f" -> nieuw: {len(areas) - near.sum():,}")
    ex = areas[areas.match].head(12)
    if len(ex):
        nl_names = nl_used.drop_duplicates("area").set_index("area").stop_name
        print("  bijv.:", "; ".join(f"{a} = {b}" for a, b in zip(ex.name, nl_names.reindex(ex.nl_area))))

    # vertrekken op gekoppelde halteplekken die de NL-feed op dezelfde minuut ook heeft (dubbel)
    m = areas[areas.match]
    if len(m):
        ev = st[st.area.isin(m.index) & st.dep.notna()][["trip_id", "area", "dep"]]
        ev = ev.assign(nl_area=ev.area.map(m.nl_area), minute=(ev.dep // 60).astype(int))
        nl_ev = nl_st.merge(nl_used[["stop_id", "area"]], on="stop_id")
        nl_keys = set(zip(nl_ev.area, nl_ev.dep // 60))
        ev["dup"] = [(a, k) in nl_keys or (a, k - 1) in nl_keys or (a, k + 1) in nl_keys
                     for a, k in zip(ev.nl_area, ev.minute)]
        dup_trip = ev.groupby("trip_id").dup.mean()
        print(f"vertrekken op gekoppelde halteplekken: {len(ev):,}, op dezelfde minuut ook in NL: {ev.dup.sum():,}; "
              f"ritten waarvan alle zulke vertrekken dubbel zijn: {(dup_trip == 1).sum():,} van {len(dup_trip):,}")
        rt = trips.merge(routes, on="route_id").set_index("trip_id")
        dt_ = rt.reindex(dup_trip.index[dup_trip == 1])
        if len(dt_):
            print("  dubbele ritten per vervoerder/type:",
                  dt_.groupby([dt_.get("agency_id", pd.Series("?", index=dt_.index)), dt_.route_type]).size()
                  .sort_values(ascending=False).head(8).to_dict())
    print(f"klaar in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
