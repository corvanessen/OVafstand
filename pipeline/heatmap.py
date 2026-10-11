"""Fase 0, stap 4: one-to-all vanaf een punt plus een heatmap op een raster van 250 m (model A/A+).

Gebruik:  python pipeline/heatmap.py <lat> <lon> <naam> [wait_factor] [YYYYMMDD]
  wait_factor 0   = model A  (alleen rijtijd)
  wait_factor 0.5 = model A+ (gemiddeld een half interval wachten per instap), standaard
"""
import sys
import time
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import BoundaryNorm, ListedColormap
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent

BIKE_MS = 15 / 3.6      # 15 km/u
DETOUR = 1.3            # hemelsbreed -> over de weg
BIKE_MAX_M = 5000       # max fietsafstand van/naar een halte
WAIT_CAP_S = 30 * 60    # maximale wachtstraf per instap
CELL_M = 250
T_MAX_MIN = 240

LAT0 = 52.2
KX = 111_320 * np.cos(np.radians(LAT0))
KY = 110_574
BBOX = (3.3, 50.7, 7.3, 53.6)  # lon_min, lat_min, lon_max, lat_max


def load_graph(date):
    return dict(np.load(ROOT / "data" / f"day_{date}" / "graph.npz"))


def build_matrix(g, wait_factor):
    """Bouw de CSR-matrix; de laatste knoop is de virtuele bron."""
    n_area = int(g["n_area"])
    n = n_area + len(g["line_node"]) + 1
    wait = np.minimum(wait_factor * g["line_headway_comb"], WAIT_CAP_S)
    b, a = g["line_board"], g["line_alight"]
    u = np.r_[g["line_area"][b], g["line_node"][a], g["ride_u"], g["walk_u"]]
    v = np.r_[g["line_node"][b], g["line_area"][a], g["ride_v"], g["walk_v"]]
    # 0-kosten kanten worden door scipy als 'geen kant' gezien: gebruik een epsilon
    w = np.r_[np.maximum(wait[b], 1e-3), np.full(a.sum(), 1e-3), g["ride_t"], g["walk_t"]]
    return u, v, w, n


def query(g, mat, lat, lon):
    u, v, w, n = mat
    n_area = int(g["n_area"])
    axy = np.c_[g["area_lon"] * KX, g["area_lat"] * KY]
    oxy = np.array([lon * KX, lat * KY])
    d = np.linalg.norm(axy - oxy, axis=1) * DETOUR
    near = np.nonzero(d <= BIKE_MAX_M)[0]
    src = n - 1
    uu = np.r_[u, np.full(len(near), src)]
    vv = np.r_[v, near]
    ww = np.r_[w, np.maximum(d[near] / BIKE_MS, 1e-3)]
    m = csr_matrix((ww, (uu, vv)), shape=(n, n))
    t0 = time.perf_counter()
    dist = dijkstra(m, indices=src, directed=True)
    dt = time.perf_counter() - t0
    return dist[:n_area], dt


def rasterize(g, t_area, lat, lon):
    """t(cel) = min( direct fietsen , min_s T(s) + fiets(s, cel) ), via 'kegels' per halteplek."""
    x0, y0 = BBOX[0] * KX, BBOX[1] * KY
    nx = int((BBOX[2] - BBOX[0]) * KX / CELL_M)
    ny = int((BBOX[3] - BBOX[1]) * KY / CELL_M)
    gx = x0 + (np.arange(nx) + 0.5) * CELL_M
    gy = y0 + (np.arange(ny) + 0.5) * CELL_M

    # direct fietsen vanaf het startpunt
    ox, oy = lon * KX, lat * KY
    grid = np.hypot(gx[None, :] - ox, gy[:, None] - oy) * DETOUR / BIKE_MS

    ax = g["area_lon"] * KX
    ay = g["area_lat"] * KY
    r_cells = int(BIKE_MAX_M / DETOUR / CELL_M) + 1
    order = np.argsort(t_area)
    for s in order:
        T = t_area[s]
        if not np.isfinite(T) or T > T_MAX_MIN * 60:
            break
        ci = int((ax[s] - x0) / CELL_M)
        cj = int((ay[s] - y0) / CELL_M)
        i0, i1 = max(ci - r_cells, 0), min(ci + r_cells + 1, nx)
        j0, j1 = max(cj - r_cells, 0), min(cj + r_cells + 1, ny)
        if i0 >= i1 or j0 >= j1:
            continue
        dd = np.hypot(gx[None, i0:i1] - ax[s], gy[j0:j1, None] - ay[s]) * DETOUR
        tt = np.where(dd <= BIKE_MAX_M, T + dd / BIKE_MS, np.inf)
        np.minimum(grid[j0:j1, i0:i1], tt, out=grid[j0:j1, i0:i1])

    # cellen verder dan BIKE_MAX_M van elke halte en van het startpunt: onbekend
    tree = cKDTree(np.c_[ax, ay])
    X, Y = np.meshgrid(gx, gy)
    dn, _ = tree.query(np.c_[X.ravel(), Y.ravel()], distance_upper_bound=BIKE_MAX_M / DETOUR)
    far = ~np.isfinite(dn.reshape(grid.shape))
    far &= np.hypot(X - ox, Y - oy) * DETOUR > BIKE_MAX_M
    grid[far] = np.nan
    return grid / 60


def plot(g, grid, lat, lon, name, wait_factor, out):
    bounds = list(range(0, T_MAX_MIN + 1, 15))
    base = plt.get_cmap("turbo", len(bounds) - 1)
    cmap = ListedColormap(base(np.arange(len(bounds) - 1)))
    cmap.set_over("#3a0a0a")
    cmap.set_bad("#e8eef2")
    norm = BoundaryNorm(bounds, cmap.N)

    fig, ax = plt.subplots(figsize=(9, 10.5), dpi=110)
    ax.imshow(grid, origin="lower", extent=(BBOX[0], BBOX[2], BBOX[1], BBOX[3]),
              cmap=cmap, norm=norm, interpolation="nearest")
    ax.contour(np.linspace(BBOX[0], BBOX[2], grid.shape[1]),
               np.linspace(BBOX[1], BBOX[3], grid.shape[0]),
               np.nan_to_num(grid, nan=999), levels=[30, 60, 90, 120, 180],
               colors="k", linewidths=0.4, alpha=0.6)
    ax.plot(lon, lat, marker="*", color="white", markeredgecolor="black", markersize=14)
    ax.set_aspect(KY / KX)
    model = "A (alleen rijtijd)" if wait_factor == 0 else f"A+ (wachten = {wait_factor} x interval)"
    ax.set_title(f"Reistijd OV + fiets vanaf {name}\nmodel {model}, fiets 15 km/u, raster {CELL_M} m")
    sm = plt.cm.ScalarMappable(norm=norm, cmap=cmap)
    fig.colorbar(sm, ax=ax, shrink=0.6, extend="max", label="minuten", ticks=bounds[::2])
    fig.tight_layout()
    fig.savefig(out)
    plt.close(fig)


def main():
    lat, lon, name = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
    wait_factor = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
    date = sys.argv[5] if len(sys.argv) > 5 else "20261110"

    g = load_graph(date)
    mat = build_matrix(g, wait_factor)
    t_area, dt = query(g, mat, lat, lon)
    print(f"Dijkstra over {mat[3]:,} knopen / {len(mat[0]):,} kanten: {dt * 1000:.0f} ms")

    t0 = time.perf_counter()
    grid = rasterize(g, t_area, lat, lon)
    print(f"raster {grid.shape[1]}x{grid.shape[0]}: {time.perf_counter() - t0:.1f} s")

    # steekproef: een paar bekende bestemmingen
    names = g["area_name"]
    for q in ["Amsterdam Centraal", "Rotterdam Centraal", "Groningen", "Maastricht",
              "Den Helder", "Vlissingen", "Enschede", "Leeuwarden"]:
        hits = [i for i, nm in enumerate(names) if nm == q]
        if hits:
            print(f"  {q:20s} {min(t_area[hits]) / 60:6.0f} min")

    out_dir = ROOT / "output"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"heatmap_{name.replace(' ', '_')}_w{wait_factor}.png"
    plot(g, grid, lat, lon, name, wait_factor, out)
    print(f"-> {out}")


if __name__ == "__main__":
    main()
