"""Fase 3, stap 1: hoe goed klopt 'hemelsbreed × 1,3' voor fietsen?

Gebruik:  python pipeline/bike_check.py [aantal_haltes] [YYYYMMDD] [--offline] [--local]

Met --offline wordt niets opgehaald en alleen de cache geanalyseerd.
Met --local gaan de verzoeken naar de eigen server uit osrm_setup.sh (localhost:5000),
zonder wachttijd en met een eigen cache.

Trekt een steekproef van halteplekken en per halte willekeurige bestemmingen
(gelijkmatig over het oppervlak, dus zoals rastercellen) binnen 5 km, plus een paar
tussen 5 en 15 km (het fietsen naar de eerste halte). Vraagt per halte één
OSRM-tabel op bij de publieke fietsserver van FOSSGIS (routing.openstreetmap.de),
hooguit 1 verzoek per seconde. Antwoorden worden per halte bewaard, dus opnieuw
starten gaat verder waar het was.

Schrijft data/bike_check/pairs.pkl en output/bike_check_*.png, en drukt een samenvatting af.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
OFFLINE = "--offline" in sys.argv  # alleen de cache gebruiken, niets ophalen
LOCAL = "--local" in sys.argv      # eigen server uit osrm_setup.sh in plaats van de publieke
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
N_STOPS = int(ARGS[0]) if len(ARGS) > 0 else 300
DATE = ARGS[1] if len(ARGS) > 1 else "20261110"
CACHE = ROOT / "data" / "bike_check" / ("osrm_local" if LOCAL else "osrm")
OUT = ROOT / "output"
SUFFIX = "_local" if LOCAL else ""

OSRM = ("http://localhost:5000/table/v1/bike/" if LOCAL
        else "https://routing.openstreetmap.de/routed-bike/table/v1/driving/")
N_NEAR, R_NEAR = 40, 5.0      # bestemmingen binnen 5 km (fietsen van halte naar cel)
N_FAR, R_FAR = 10, 15.0       # 5–15 km (fietsen naar de eerste halte)
DETOUR, KMH = 1.3, 15.0       # het huidige model
SNAP_MAX = 250.0              # m; verder van een weg = water, weiland of bos zonder pad
NL_BBOX = (50.75, 53.55, 3.35, 7.22)  # lat_min, lat_max, lon_min, lon_max
R_EARTH = 6_371_000.0


def haversine(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * R_EARTH * np.arcsin(np.sqrt(a))


def offset(lat, lon, dist_m, bearing):
    """punt op afstand dist_m in richting bearing (rad), vlakke benadering"""
    dlat = dist_m * np.cos(bearing) / R_EARTH
    dlon = dist_m * np.sin(bearing) / (R_EARTH * np.cos(np.radians(lat)))
    return lat + np.degrees(dlat), lon + np.degrees(dlon)


def sample_dests(rng, lat, lon):
    # gelijkmatig over de schijf: r = R·√u
    r_near = R_NEAR * 1000 * np.sqrt(rng.random(N_NEAR))
    r_far = 1000 * np.sqrt(rng.uniform(R_NEAR**2, R_FAR**2, N_FAR))
    r = np.r_[r_near, r_far]
    return offset(lat, lon, r, rng.uniform(0, 2 * np.pi, len(r)))


def fetch(lat, lon, dlat, dlon):
    coords = ";".join(f"{x:.6f},{y:.6f}" for x, y in zip(np.r_[lon, dlon], np.r_[lat, dlat]))
    url = f"{OSRM}{coords}?sources=0&annotations=duration,distance"
    req = urllib.request.Request(url, headers={"User-Agent": "OVafstand-meting/0.1 (prive hobbyproject)"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except Exception as err:  # netwerk of 429: wachten (Retry-After als de server die geeft) en opnieuw
            retry = getattr(err, "headers", None) and err.headers.get("Retry-After")
            wait = int(retry) if retry and retry.isdigit() else 30 * 2**attempt
            print(f"  fout ({err}), poging {attempt + 1}, wacht {wait} s")
            time.sleep(wait)
    return None


def collect():
    g = np.load(ROOT / "data" / f"day_{DATE}" / "graph.npz")
    lat, lon, names = g["area_lat"], g["area_lon"], g["area_name"]
    la0, la1, lo0, lo1 = NL_BBOX
    inside = np.flatnonzero((lat > la0) & (lat < la1) & (lon > lo0) & (lon < lo1))

    # haltedichtheid: aantal halteplekken binnen 1 km (stad vs. platteland)
    xy = np.c_[np.radians(lon) * np.cos(np.radians(52.2)), np.radians(lat)] * R_EARTH
    density = np.array([len(n) for n in cKDTree(xy).query_ball_point(xy, 1000)])

    rng = np.random.default_rng(42)
    picks = rng.choice(inside, size=N_STOPS, replace=False)
    CACHE.mkdir(parents=True, exist_ok=True)
    rows = []
    online = not OFFLINE
    for i, s in enumerate(picks):
        f = CACHE / f"{s}.json"
        srng = np.random.default_rng(int(s))  # bestemmingen vast per halte
        dlat, dlon = sample_dests(srng, lat[s], lon[s])
        if f.exists():
            res = json.loads(f.read_text())
        elif not online:
            continue
        else:
            t0 = time.time()
            res = fetch(lat[s], lon[s], dlat, dlon)
            if res is None:  # server weigert: verder met wat in de cache staat
                print("OSRM weigert verzoeken; verder met alleen de cache. Later opnieuw starten vult aan.")
                online = False
                continue
            f.write_text(json.dumps({k: res[k] for k in ("code", "distances", "durations", "sources", "destinations")}))
            if not LOCAL:  # publieke server: hooguit 1 verzoek per seconde
                time.sleep(max(0.0, 1.0 - (time.time() - t0)))
            if i % 25 == 0:
                print(f"{i}/{N_STOPS} {names[s]}")
        if res["code"] != "Ok":
            continue
        src_snap = res["sources"][0]["distance"]
        for j in range(len(dlat)):
            dist, dur = res["distances"][0][j + 1], res["durations"][0][j + 1]
            rows.append(dict(
                stop=int(s), name=str(names[s]), lat=lat[s], lon=lon[s], density=int(density[s]),
                dlat=dlat[j], dlon=dlon[j], far=j >= N_NEAR,
                straight=haversine(lat[s], lon[s], dlat[j], dlon[j]),
                osrm_dist=np.nan if dist is None else dist,
                osrm_dur=np.nan if dur is None else dur,
                snap_src=src_snap, snap_dst=res["destinations"][j + 1]["distance"],
            ))
    df = pd.DataFrame(rows)
    df.to_pickle(CACHE.parent / f"pairs{SUFFIX}.pkl")
    return df


def summarize(df):
    print(f"\n{df.stop.nunique()} haltes, {len(df)} paren")
    off = (df.snap_dst > SNAP_MAX) | (df.snap_src > SNAP_MAX) | df.osrm_dist.isna()
    print(f"bestemming > {SNAP_MAX:.0f} m van een fietsbare weg (water, weiland): {off.mean():.1%} — buiten beschouwing")
    d = df[~off & (df.straight > 300)].copy()
    d["ratio"] = d.osrm_dist / d.straight
    d["t_model"] = d.straight * DETOUR / (KMH / 3.6) / 60
    d["t_net15"] = (d.osrm_dist + d.snap_dst + d.snap_src) / (KMH / 3.6) / 60  # echte route, zelfde snelheid
    d["t_osrm"] = d.osrm_dur / 60                                             # OSRM's eigen snelheden
    d["err"] = d.t_net15 - d.t_model                                          # >0: model te optimistisch
    d["osrm_kmh"] = d.osrm_dist / d.osrm_dur * 3.6

    q = lambda s: s.quantile([0.1, 0.5, 0.9, 0.98]).round(2).tolist()
    print("\nomrijfactor (OSRM-afstand / hemelsbreed), percentielen 10/50/90/98:")
    bins = [0.3, 1, 2, 3, 5, 10, 15.5]
    d["band"] = pd.cut(d.straight / 1000, bins)
    for band, grp in d.groupby("band", observed=True):
        print(f"  {str(band):>12} km  n={len(grp):5d}  factor {q(grp.ratio)}   fout (min) {q(grp.err)}")

    d["kind"] = pd.qcut(d.density, 3, labels=["landelijk", "middel", "stedelijk"])
    print("\nnaar haltedichtheid (haltes binnen 1 km), alleen ≤ 5 km:")
    for kind, grp in d[~d.far].groupby("kind", observed=True):
        print(f"  {kind:>10} (dichtheid {grp.density.min()}–{grp.density.max()})  factor {q(grp.ratio)}   fout (min) {q(grp.err)}")

    near = d[~d.far]
    print(f"\n≤ 5 km: mediane factor {near.ratio.median():.2f}; "
          f"|fout| > 5 min bij {(near.err.abs() > 5).mean():.1%}, > 10 min bij {(near.err.abs() > 10).mean():.1%}")
    print(f"beste vaste factor (kleinste mediane absolute fout, ≤ 5 km): "
          f"{min(np.arange(1.1, 1.61, 0.02), key=lambda f: (near.t_net15 - near.straight * f / (KMH / 3.6) / 60).abs().median()):.2f}")
    print(f"OSRM's eigen fietssnelheid: mediaan {d.osrm_kmh.median():.1f} km/u "
          f"(OSRM-reistijd / model-reistijd: mediaan {(d.t_osrm / d.t_model).median():.2f})")

    print("\nergste omwegen (≤ 5 km):")
    worst = near.nlargest(12, "err")
    for r in worst.itertuples():
        print(f"  {r.name[:38]:38}  {r.straight/1000:4.1f} km hemelsbreed → {r.osrm_dist/1000:5.1f} km fietsen "
              f"(+{r.err:.0f} min)  naar {r.dlat:.4f},{r.dlon:.4f}")
    return d, off


def plot(df, d, off):
    OUT.mkdir(exist_ok=True)
    fig, axes = plt.subplots(1, 2, figsize=(15, 9))
    ax = axes[0]
    near = d[~d.far].sort_values("ratio")
    sc = ax.scatter(near.dlon, near.dlat, c=near.ratio.clip(1, 2.2), cmap="RdYlGn_r", s=5, vmin=1, vmax=2.2)
    ax.scatter(df[off].dlon, df[off].dlat, c="#4a7fd4", s=3, marker="x", label=f"> {SNAP_MAX:.0f} m van een weg")
    ax.set_aspect(1 / np.cos(np.radians(52.2)))
    ax.set_title("omrijfactor fietsen (≤ 5 km van een halte)")
    ax.legend(loc="lower right")
    fig.colorbar(sc, ax=ax, shrink=0.7)
    ax = axes[1]
    ax.scatter(d.straight / 1000, d.t_net15 - d.t_model, s=3, alpha=0.4, c=np.where(d.far, "#888", "#c33"))
    ax.axhline(0, c="k", lw=0.8)
    ax.set_xlabel("hemelsbreed (km)")
    ax.set_ylabel("fietstijd echte route − model (min, beide 15 km/u)")
    ax.set_title("fout van hemelsbreed × 1,3")
    fig.tight_layout()
    fig.savefig(OUT / f"bike_check{SUFFIX}.png", dpi=110)
    print(f"\nkaart: {OUT / f'bike_check{SUFFIX}.png'}")


if __name__ == "__main__":
    df = collect()
    d, off = summarize(df)
    plot(df, d, off)
