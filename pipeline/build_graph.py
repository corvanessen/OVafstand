"""Fase 0, stap 3: bouw de statische graaf voor model A/A+.

Knopen:
  - halteplek (stop area): parent_station, of de stop_id zelf als die geen parent heeft
  - lijnknoop (route+richting, halteplek)
Kanten:
  - instappen   halteplek -> lijnknoop    kost = wachttijd (wait_factor * interval, max cap)
  - uitstappen  lijnknoop -> halteplek    kost = 0
  - rijden      lijnknoop -> volgende lijnknoop van dezelfde route+richting, minimale rijtijd
  - lopen       halteplek -> halteplek binnen WALK_RADIUS (overstappen tussen naburige perrons)

Gebruik:  python pipeline/build_graph.py [YYYYMMDD]
Schrijft data/day_<datum>/graph.npz
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
DATE = sys.argv[1] if len(sys.argv) > 1 else "20261110"
D = ROOT / "data" / f"day_{DATE}"

WINDOW = (7 * 3600, 19 * 3600)   # tijdvenster voor rijtijden en intervallen
WALK_RADIUS_M = 300
WALK_SPEED_MS = 5 / 3.6 / 1.2    # 5 km/u met omloopfactor 1.2

LAT0 = 52.2
KX = 111_320 * np.cos(np.radians(LAT0))  # meter per graad lengte
KY = 110_574                             # meter per graad breedte


def to_xy(lat, lon):
    return np.c_[np.asarray(lon) * KX, np.asarray(lat) * KY]


def hourly_waits(st_day, serve, g_next):
    """Uurmodel (fase 6.4): gemiddelde wachttijd (s) per lijnknoop en per uur van de dag.

    Voor iemand die op een willekeurig moment in dat uur bij de halte komt, tot het eerstvolgende
    vertrek in dezelfde corridor als headway_comb_s (alle ritten naar de drukste volgende halte).
    Bij een regelmatige dienst is dat ½ interval; gaten (avond, nacht) tellen vanzelf mee.
    Tijden na middernacht (≥ 24:00) gelden als de nacht van deze dag; na het laatste vertrek
    volgt het eerste vertrek van de volgende dag (dezelfde dienstregeling).
    """
    tid = st_day.trip_id.to_numpy()
    i0 = np.nonzero(tid[1:] == tid[:-1])[0]
    p = pd.DataFrame({
        "group": st_day.group.to_numpy()[i0],
        "a0": st_day.a.to_numpy()[i0], "a1": st_day.a.to_numpy()[i0 + 1],
        "dep": st_day.dep.to_numpy()[i0] % 86400,
        "board": st_day.pickup_type.to_numpy()[i0] != 1,
    })
    p = p[(p.a0 != p.a1) & p.board]
    corr = {k: np.sort(v.to_numpy()) for k, v in p.groupby(["a0", "a1"]).dep}
    own = {k: np.sort(v.to_numpy()) for k, v in p.groupby(["group", "a0"]).dep}
    top = g_next.loc[g_next.groupby(["group", "a0"]).n_corr.idxmax()]
    best = dict(zip(zip(top.group, top.a0), top.a1))

    t = np.arange(24 * 60) * 60 + 30.0   # het midden van elke minuut
    out = np.full((len(serve), 24), np.inf, np.float32)
    for i, (g, a) in enumerate(zip(serve.group, serve.a)):
        a1 = best.get((g, a))
        deps = corr.get((a, a1)) if a1 is not None else None
        if deps is None:
            deps = own.get((g, a))   # eindhalte of geen corridor: de eigen vertrekken
        if deps is None or len(deps) == 0:
            continue
        d = np.r_[deps, deps[0] + 86400]
        out[i] = (d[np.searchsorted(d, t)] - t).reshape(24, 60).mean(1)
    return out


def main():
    stops = pd.read_pickle(D / "stops.pkl")
    routes = pd.read_pickle(D / "routes.pkl")
    trips = pd.read_pickle(D / "trips.pkl")
    st = pd.read_pickle(D / "stop_times.pkl")

    # --- halteplekken
    stops["area"] = stops.parent_station.fillna(stops.stop_id)
    st = st.merge(stops[["stop_id", "area"]], on="stop_id")
    used = stops[stops.stop_id.isin(st.stop_id.unique())]
    areas = (used.groupby("area")
             .agg(lat=("stop_lat", "mean"), lon=("stop_lon", "mean"), name=("stop_name", "first"))
             .reset_index())
    # parent_station heeft vaak een nettere naam
    parent_names = stops.set_index("stop_id").stop_name
    areas["name"] = areas.area.map(parent_names).fillna(areas.name)
    area_idx = pd.Series(np.arange(len(areas)), index=areas.area)
    n_area = len(areas)
    print(f"halteplekken: {n_area:,}")

    # --- ritten binnen het venster, gegroepeerd per route+richting
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)
    trips["group"] = trips.route_id + "|" + trips.direction_id.fillna("0")
    st = st.merge(trips[["trip_id", "group", "route_id"]], on="trip_id")
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)
    st["a"] = st.area.map(area_idx).to_numpy()
    st_day = st   # de hele dag, voor het uurmodel (fase 6.4)
    start = st.groupby("trip_id").dep.transform("min")
    st = st[(start >= WINDOW[0]) & (start < WINDOW[1])].reset_index(drop=True)

    # opeenvolgende paren binnen elke rit
    same = st.trip_id.to_numpy()[1:] == st.trip_id.to_numpy()[:-1]
    i0 = np.nonzero(same)[0]
    i1 = i0 + 1
    pairs = pd.DataFrame({
        "trip_id": st.trip_id.to_numpy()[i0],
        "group": st.group.to_numpy()[i0],
        "a0": st.a.to_numpy()[i0], "a1": st.a.to_numpy()[i1],
        "dt": st.arr.to_numpy()[i1] - st.arr.to_numpy()[i0],
    })
    pairs = pairs[pairs.a0 != pairs.a1]
    ride = pairs.groupby(["group", "a0", "a1"]).dt.min().reset_index()
    ride["dt"] = ride.dt.clip(lower=30)  # 0-minuut-segmenten in de data: minimaal 30 s

    # lijnknopen: (group, area) en hun interval
    hours = (WINDOW[1] - WINDOW[0]) / 3600
    serve = st.groupby(["group", "a"]).agg(
        n_trips=("trip_id", "nunique"),
        can_board=("pickup_type", lambda s: (s != 1).any()),
        can_alight=("drop_off_type", lambda s: (s != 1).any()),
    ).reset_index()
    serve["headway_s"] = hours * 3600 / serve.n_trips
    # Gecombineerd interval: wie bij halte a instapt richting volgende halte b, kan elk voertuig
    # nemen dat a->b rijdt (ook van andere routes). Neem per lijnknoop de drukste corridor.
    corridor = pairs.groupby(["a0", "a1"]).trip_id.nunique().rename("n_corr").reset_index()
    g_next = pairs[["group", "a0", "a1"]].drop_duplicates().merge(corridor, on=["a0", "a1"])
    n_corr = g_next.groupby(["group", "a0"]).n_corr.max()
    nc = n_corr.reindex(pd.MultiIndex.from_frame(serve[["group", "a"]])).to_numpy()
    serve["headway_comb_s"] = hours * 3600 / np.fmax(nc, serve.n_trips.to_numpy())
    serve["node"] = n_area + np.arange(len(serve))
    node_of = pd.Series(serve.node.to_numpy(),
                        index=pd.MultiIndex.from_frame(serve[["group", "a"]]))
    print(f"lijnknopen: {len(serve):,}  ({serve.group.nunique():,} route-richtingen)")

    line_wait_h = hourly_waits(st_day, serve, g_next)
    print(f"uurmodel: mediane wachttijd 12 u {np.nanmedian(np.where(np.isfinite(line_wait_h[:, 12]), line_wait_h[:, 12], np.nan)) / 60:.1f} min, "
          f"3 u {np.nanmedian(np.where(np.isfinite(line_wait_h[:, 3]), line_wait_h[:, 3], np.nan)) / 60:.1f} min")

    ride["u"] = node_of.reindex(pd.MultiIndex.from_frame(ride[["group", "a0"]])).to_numpy()
    ride["v"] = node_of.reindex(pd.MultiIndex.from_frame(ride[["group", "a1"]])).to_numpy()

    # --- loopkanten tussen naburige halteplekken
    xy = to_xy(areas.lat, areas.lon)
    tree = cKDTree(xy)
    wp = tree.query_pairs(WALK_RADIUS_M, output_type="ndarray")
    wd = np.linalg.norm(xy[wp[:, 0]] - xy[wp[:, 1]], axis=1)
    walk_u = np.r_[wp[:, 0], wp[:, 1]]
    walk_v = np.r_[wp[:, 1], wp[:, 0]]
    walk_t = np.r_[wd, wd] / WALK_SPEED_MS
    print(f"loopkanten: {len(walk_u):,}, rijkanten: {len(ride):,}")

    # route_type per lijnknoop (voor statistiek / kleur)
    g_route = trips.drop_duplicates("group").set_index("group").route_id
    rtype = routes.set_index("route_id").route_type.astype(int)
    serve["route_type"] = serve.group.map(g_route).map(rtype).fillna(3).astype(np.int8)

    np.savez_compressed(
        D / "graph.npz",
        n_area=n_area,
        area_id=areas.area.to_numpy(str), area_name=areas.name.to_numpy(str),
        area_lat=areas.lat.to_numpy(), area_lon=areas.lon.to_numpy(),
        line_node=serve.node.to_numpy(np.int32), line_area=serve.a.to_numpy(np.int32),
        line_headway=serve.headway_s.to_numpy(np.float32),
        line_headway_comb=serve.headway_comb_s.to_numpy(np.float32),
        line_wait_h=line_wait_h,
        line_board=serve.can_board.to_numpy(bool), line_alight=serve.can_alight.to_numpy(bool),
        line_route_type=serve.route_type.to_numpy(np.int8),
        line_group=serve.group.to_numpy(str),
        ride_u=ride.u.to_numpy(np.int32), ride_v=ride.v.to_numpy(np.int32),
        ride_t=ride.dt.to_numpy(np.float32),
        walk_u=walk_u.astype(np.int32), walk_v=walk_v.astype(np.int32),
        walk_t=walk_t.astype(np.float32),
    )
    print(f"opgeslagen: {D / 'graph.npz'}")


if __name__ == "__main__":
    main()
