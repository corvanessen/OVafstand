"""Fase 0, stap 3: bouw de statische graaf voor model A/A+.

Knopen:
  - halteplek (stop area): parent_station, of de stop_id zelf als die geen parent heeft
  - lijnknoop (route+richting, halteplek)
Kanten:
  - instappen   halteplek -> lijnknoop    kost = wachttijd (wait_factor * interval, max cap)
  - uitstappen  lijnknoop -> halteplek    kost = 0
  - rijden      lijnknoop -> volgende lijnknoop van dezelfde route+richting, minimale rijtijd
  - lopen       halteplek -> halteplek binnen WALK_RADIUS (overstappen tussen naburige perrons)

Het dagmodel (rijtijden, intervallen) komt uit de ritten die in WINDOW beginnen. Lijnknopen en rijkanten
die alleen buiten WINDOW bestaan (nachtlijnen, vroege en late trajecten) zitten er ook in, maar alleen
voor het uurmodel (fase 6.4): hun interval is inf en ride_in_window is False.

Meerdere dagen (fase 6.7 stap 4, het weekend): de eerste datum is de basis (een werkdag). De graaf is de
vereniging van alle dagen. Halteplekken, lijnknopen en rijkanten van de basisdag houden hun volgorde
(de startcellen in bike.bin.gz horen bij de volgorde van de halteplekken); die van de andere dagen komen
erachter. Per dag zijn er eigen intervallen, rijtijden, een uurmodel en een soort per rijkant:
0 = in het venster, 2 = alleen buiten het venster, 3 = rijdt die dag niet.

Gebruik:  python pipeline/build_graph.py [YYYYMMDD ...]     bijv. 20261110 20261114 20261115
Schrijft data/day_<eerste datum>/graph.npz
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
DATES = sys.argv[1:] or ["20261110"]
D = ROOT / "data" / f"day_{DATES[0]}"

WINDOW = (7 * 3600, 19 * 3600)   # tijdvenster voor rijtijden en intervallen (het dagmodel)
BIN_MIN = 30                     # uurmodel: tijdvakken van een half uur
WAIT_WINDOW_MIN = 60             # uurmodel: wachttijd gemiddeld over een uur rond elk tijdvak
WALK_RADIUS_M = 300
WALK_SPEED_MS = 5 / 3.6 / 1.2    # 5 km/u met omloopfactor 1.2
RIDE_WINDOW, RIDE_NIGHT, RIDE_OFF = 0, 2, 3   # soort rijkant per dag (zoals kind in graph.bin)

LAT0 = 52.2
KX = 111_320 * np.cos(np.radians(LAT0))  # meter per graad lengte
KY = 110_574                             # meter per graad breedte


def to_xy(lat, lon):
    return np.c_[np.asarray(lon) * KX, np.asarray(lat) * KY]


def consecutive_pairs(st):
    """opeenvolgende haltes binnen elke rit (st gesorteerd op trip_id, stop_sequence)"""
    tid = st.trip_id.to_numpy()
    i0 = np.nonzero(tid[1:] == tid[:-1])[0]
    i1 = i0 + 1
    p = pd.DataFrame({
        "trip_id": tid[i0],
        "group": st.group.to_numpy()[i0],
        "a0": st.a.to_numpy()[i0], "a1": st.a.to_numpy()[i1],
        "dt": st.arr.to_numpy()[i1] - st.arr.to_numpy()[i0],
        "dep": st.dep.to_numpy()[i0],
        "board": st.pickup_type.to_numpy()[i0] != 1,
    })
    return p[p.a0 != p.a1]


def corridors(pairs):
    """per (route-richting, halte) de volgende halten, met het aantal ritten in die corridor"""
    corridor = pairs.groupby(["a0", "a1"]).trip_id.nunique().rename("n_corr").reset_index()
    return pairs[["group", "a0", "a1"]].drop_duplicates().merge(corridor, on=["a0", "a1"])


def bin_waits(pairs_day, serve, g_next):
    """Uurmodel (fase 6.4): gemiddelde wachttijd (s) per lijnknoop en per tijdvak van BIN_MIN minuten.

    Voor iemand die op een willekeurig moment binnen WAIT_WINDOW_MIN rond het midden van het tijdvak
    bij de halte komt, tot het eerstvolgende vertrek in de drukste corridor van de lijnknoop (alle ritten
    naar dezelfde volgende halte, ook van andere routes; zoals headway_comb_s, maar over de hele dag
    geteld). Bij een regelmatige dienst is dat ½ interval; gaten (avond, nacht) tellen vanzelf mee.
    Tijden na middernacht (≥ 24:00) gelden als de nacht van deze dag; na het laatste vertrek volgt het
    eerste van de volgende dag.

    Waarom een venster van een uur bij tijdvakken van een half uur: veel lijnen rijden één keer per uur
    op een vaste minuut. Gemiddeld per half uur verschilt de wachttijd dan tussen de eerste en de tweede
    helft van het uur, en de kaart flikkerde bij afspelen (15–33% van de cellen wisselde per stap van
    kleur, ook overdag). Over een uur middelt die fase weg; de resolutie blijft een half uur.
    """
    p = pairs_day[pairs_day.board]
    dep = p.dep % 86400
    corr = {k: np.sort(v.to_numpy()) for k, v in dep.groupby([p.a0, p.a1])}
    own = {k: np.sort(v.to_numpy()) for k, v in dep.groupby([p.group, p.a0])}
    top = g_next.loc[g_next.groupby(["group", "a0"]).n_corr.idxmax()]
    best = dict(zip(zip(top.group, top.a0), top.a1))

    n_bins = 24 * 60 // BIN_MIN
    t = np.arange(24 * 60) * 60 + 30.0   # het midden van elke minuut
    # per tijdvak de minuten van een venster rond het midden (rond middernacht doorlopend)
    start = np.arange(n_bins) * BIN_MIN + (BIN_MIN - WAIT_WINDOW_MIN) // 2
    window = (start[:, None] + np.arange(WAIT_WINDOW_MIN)) % (24 * 60)
    out = np.full((len(serve), n_bins), np.inf, np.float32)
    for i, (g, a) in enumerate(zip(serve.group, serve.a)):
        a1 = best.get((g, a))
        deps = corr.get((a, a1)) if a1 is not None else None
        if deps is None:
            deps = own.get((g, a))   # eindhalte of geen corridor: de eigen vertrekken
        if deps is None or len(deps) == 0:
            continue
        d = np.r_[deps, deps[0] + 86400]
        out[i] = (d[np.searchsorted(d, t)] - t)[window].mean(1)
    return out


def day_model(date, trips, st, stop_area, area_idx):
    """lijnknopen, rijkanten en corridors van één dag (alles nog als tabellen, zonder knoopnummers)"""
    trips = trips.copy()
    trips["group"] = trips.route_id + "|" + trips.direction_id.fillna("0")
    st = st.merge(stop_area, on="stop_id")
    st = st.merge(trips[["trip_id", "group", "route_id"]], on="trip_id")
    st = st.sort_values(["trip_id", "stop_sequence"]).reset_index(drop=True)
    st["a"] = st.area.map(area_idx).to_numpy()
    st_day = st   # de hele dag: nachtlijnen en het uurmodel (fase 6.4)
    start = st.groupby("trip_id").dep.transform("min")
    st = st[(start >= WINDOW[0]) & (start < WINDOW[1])].reset_index(drop=True)

    pairs = consecutive_pairs(st)
    pairs_day = consecutive_pairs(st_day)
    ride = pairs.groupby(["group", "a0", "a1"]).dt.min().reset_index()
    ride["in_window"] = True
    # rijkanten die alleen buiten het venster bestaan (nachtlijnen, late of vroege trajecten):
    # alleen voor het uurmodel; het dagmodel slaat ze over (kind 2 in graph.bin)
    ride_all = pairs_day.groupby(["group", "a0", "a1"]).dt.min().reset_index()
    extra = ride_all.merge(ride[["group", "a0", "a1"]], how="left", indicator=True)
    extra = extra[extra._merge == "left_only"].drop(columns="_merge").assign(in_window=False)
    ride = pd.concat([ride, extra], ignore_index=True)
    ride["dt"] = ride.dt.clip(lower=30)  # 0-minuut-segmenten in de data: minimaal 30 s

    # lijnknopen: (group, area); eerst die van het venster, dan die van de rest van de dag
    agg = dict(
        n_trips=("trip_id", "nunique"),
        can_board=("pickup_type", lambda s: (s != 1).any()),
        can_alight=("drop_off_type", lambda s: (s != 1).any()),
    )
    serve = st.groupby(["group", "a"]).agg(**agg).reset_index()
    serve_all = st_day.groupby(["group", "a"]).agg(**agg).reset_index()
    night = serve_all.merge(serve[["group", "a"]], how="left", indicator=True)
    night = night[night._merge == "left_only"].drop(columns="_merge").assign(n_trips=0)
    print(f"{date}: {trips.trip_id.nunique():,} ritten, {len(serve):,} lijnknopen in "
          f"{WINDOW[0] // 3600:02d}–{WINDOW[1] // 3600} u, {len(night):,} alleen daarbuiten")
    serve = pd.concat([serve, night], ignore_index=True)
    # Gecombineerd interval: wie bij halte a instapt richting volgende halte b, kan elk voertuig
    # nemen dat a->b rijdt (ook van andere routes). Neem per lijnknoop de drukste corridor.
    n_corr = corridors(pairs).groupby(["group", "a0"]).n_corr.max()
    return dict(date=date, trips=trips, ride=ride, serve=serve, n_corr=n_corr, pairs_day=pairs_day)


def append_new(table, more, key):
    """rijen van more die nog niet in table staan, achter table"""
    new = more[key].merge(table[key], how="left", indicator=True)
    new = new[new._merge == "left_only"][key]
    return pd.concat([table[key], new], ignore_index=True)


def main():
    stops = pd.read_pickle(D / "stops.pkl")   # stops.txt en routes.txt zijn voor elke dag hetzelfde
    routes = pd.read_pickle(D / "routes.pkl")
    days = [(date, pd.read_pickle(ROOT / "data" / f"day_{date}" / "trips.pkl"),
             pd.read_pickle(ROOT / "data" / f"day_{date}" / "stop_times.pkl")) for date in DATES]

    # --- halteplekken: die van de basisdag eerst, in dezelfde volgorde als met één dag
    stops["area"] = stops.parent_station.fillna(stops.stop_id)
    parent_names = stops.set_index("stop_id").stop_name   # parent_station heeft vaak een nettere naam

    def area_table(stop_ids):
        used = stops[stops.stop_id.isin(stop_ids)]
        t = (used.groupby("area")
             .agg(lat=("stop_lat", "mean"), lon=("stop_lon", "mean"), name=("stop_name", "first"))
             .reset_index())
        t["name"] = t.area.map(parent_names).fillna(t.name)
        return t

    areas = area_table(days[0][2].stop_id.unique())
    for date, _, st in days[1:]:
        more = area_table(st.stop_id.unique())
        more = more[~more.area.isin(areas.area)]
        print(f"{date}: {len(more):,} halteplekken die de basisdag niet heeft")
        areas = pd.concat([areas, more], ignore_index=True)
    area_idx = pd.Series(np.arange(len(areas)), index=areas.area)
    n_area = len(areas)
    print(f"halteplekken: {n_area:,}")

    stop_area = stops[["stop_id", "area"]]
    models = [day_model(date, trips, st, stop_area, area_idx) for date, trips, st in days]
    n_days = len(models)
    hours = (WINDOW[1] - WINDOW[0]) / 3600

    # --- lijnknopen: de vereniging, die van de basisdag eerst
    key = ["group", "a"]
    lines = models[0]["serve"][key].copy()
    for m in models[1:]:
        lines = append_new(lines, m["serve"], key)
    n_line = len(lines)
    lines["node"] = n_area + np.arange(n_line)
    idx = pd.MultiIndex.from_frame(lines[key])
    node_of = pd.Series(lines.node.to_numpy(), index=idx)
    can_board = np.zeros(n_line, bool)
    can_alight = np.zeros(n_line, bool)
    headway = np.full((n_days, n_line), np.inf, np.float32)
    headway_comb = np.full((n_days, n_line), np.inf, np.float32)
    line_wait = np.full((n_days, n_line, 24 * 60 // BIN_MIN), np.inf, np.float32)
    for k, m in enumerate(models):
        s = m["serve"].set_index(key).reindex(idx)
        can_board |= s.can_board.astype("boolean").fillna(False).to_numpy(bool)
        can_alight |= s.can_alight.astype("boolean").fillna(False).to_numpy(bool)
        n_trips = s.n_trips.fillna(0).to_numpy(float)
        nc = m["n_corr"].reindex(idx).to_numpy(float)
        with np.errstate(divide="ignore"):
            headway[k] = hours * 3600 / n_trips   # inf buiten het venster: dicht in het dagmodel
            headway_comb[k] = hours * 3600 / np.fmax(nc, n_trips)
        line_wait[k] = bin_waits(m["pairs_day"], lines, corridors(m["pairs_day"]))
        med = lambda col: np.median(col[np.isfinite(col)]) / 60
        print(f"{m['date']}: uurmodel, mediane wachttijd 12 u {med(line_wait[k][:, 12 * 60 // BIN_MIN]):.1f} min, "
              f"3 u {med(line_wait[k][:, 3 * 60 // BIN_MIN]):.1f} min; "
              f"{np.isfinite(headway_comb[k]).sum():,} lijnknopen open in het dagmodel")
    print(f"lijnknopen: {n_line:,} ({lines.group.nunique():,} route-richtingen)")

    # --- rijkanten: de vereniging; per dag de rijtijd en de soort
    rkey = ["group", "a0", "a1"]
    rides = models[0]["ride"][rkey]
    for m in models[1:]:
        rides = append_new(rides, m["ride"], rkey)
    ridx = pd.MultiIndex.from_frame(rides)
    ride_t = np.full((n_days, len(rides)), np.nan, np.float32)
    ride_kind = np.full((n_days, len(rides)), RIDE_OFF, np.uint8)
    for k, m in enumerate(models):
        r = m["ride"].set_index(rkey).reindex(ridx)
        have = r.dt.notna().to_numpy()
        ride_t[k] = r.dt.to_numpy(float)
        ride_kind[k][have] = np.where(r.in_window.to_numpy()[have].astype(bool), RIDE_WINDOW, RIDE_NIGHT)
    # een dag zonder die rit: de kortste rijtijd van de andere dagen (telt niet mee, soort 3)
    ride_t = np.where(np.isnan(ride_t), np.nanmin(ride_t, axis=0), ride_t)
    ride_u = node_of.reindex(pd.MultiIndex.from_frame(rides[["group", "a0"]])).to_numpy()
    ride_v = node_of.reindex(pd.MultiIndex.from_frame(rides[["group", "a1"]])).to_numpy()
    for k, m in enumerate(models):
        n = np.bincount(ride_kind[k], minlength=4)
        print(f"{m['date']}: rijkanten in het venster {n[RIDE_WINDOW]:,}, daarbuiten {n[RIDE_NIGHT]:,}, "
              f"niet op deze dag {n[RIDE_OFF]:,}")

    # --- loopkanten tussen naburige halteplekken
    xy = to_xy(areas.lat, areas.lon)
    tree = cKDTree(xy)
    wp = tree.query_pairs(WALK_RADIUS_M, output_type="ndarray")
    wd = np.linalg.norm(xy[wp[:, 0]] - xy[wp[:, 1]], axis=1)
    walk_u = np.r_[wp[:, 0], wp[:, 1]]
    walk_v = np.r_[wp[:, 1], wp[:, 0]]
    walk_t = np.r_[wd, wd] / WALK_SPEED_MS
    print(f"loopkanten: {len(walk_u):,}, rijkanten: {len(rides):,}")

    # route_type per lijnknoop (voor statistiek / kleur)
    all_trips = pd.concat([m["trips"] for m in models], ignore_index=True)
    g_route = all_trips.drop_duplicates("group").set_index("group").route_id
    rtype = routes.set_index("route_id").route_type.astype(int)
    route_type = lines.group.map(g_route).map(rtype).fillna(3).astype(np.int8)

    np.savez_compressed(
        D / "graph.npz",
        n_area=n_area,
        area_id=areas.area.to_numpy(str), area_name=areas.name.to_numpy(str),
        area_lat=areas.lat.to_numpy(), area_lon=areas.lon.to_numpy(),
        line_node=lines.node.to_numpy(np.int32), line_area=lines.a.to_numpy(np.int32),
        # de basisdag onder de oude namen (heatmap.py en andere metingen)
        line_headway=headway[0], line_headway_comb=headway_comb[0], line_wait=line_wait[0], bin_min=BIN_MIN,
        line_board=can_board, line_alight=can_alight,
        line_route_type=route_type.to_numpy(np.int8),
        line_group=lines.group.to_numpy(str),
        ride_u=ride_u.astype(np.int32), ride_v=ride_v.astype(np.int32),
        ride_t=ride_t[0], ride_in_window=ride_kind[0] == RIDE_WINDOW,
        walk_u=walk_u.astype(np.int32), walk_v=walk_v.astype(np.int32),
        walk_t=walk_t.astype(np.float32),
        # per dag (fase 6.7 stap 4); index 0 is de basisdag
        dates=np.array(DATES), day_headway_comb=headway_comb, day_line_wait=line_wait,
        day_ride_t=ride_t, day_ride_kind=ride_kind,
    )
    print(f"opgeslagen: {D / 'graph.npz'}")


if __name__ == "__main__":
    main()
