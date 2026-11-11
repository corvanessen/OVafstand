// Lopen, stap 0: hoe goed is lopen over het fietsraster (wat de kaart nu doet) vergeleken met echt lopen?
// Waarheid: de OSRM-loopserver (localhost:5001, osrm_setup.sh voet). Ter scheiding van de foutbronnen ook
// de fietsserver (:5000): fiets-OSRM vs voet-OSRM is het verschil in netwerk, raster vs fiets-OSRM de rasterfout.
// Per regio een vaste steekproef haltes, per halte de cellen binnen RADIUS_M hemelsbreed. Tijden bij 5 km/u.
//   cd web && npx rolldown bench/walk_check.ts --platform node -o ../data/walk_check.mjs && node ../data/walk_check.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBikeGrid, rasterizeBike } from "../src/bikegrid";
import { CELL, NX, NY, X0, Y0, mercX, mercY } from "../src/grid";
import { applyDay, distM, loadGraph, DETOUR, type Params, type Search } from "../src/router";
import { DEFAULTS } from "../src/state";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const WEB = ROOT + "/web/public/data/";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string) => {
  if (url.startsWith("http")) return realFetch(url);
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const FOOT = "http://localhost:5001/table/v1/foot/";
const BIKE = "http://localhost:5000/table/v1/bike/";
const KMH = 4; // stevig doorwandelen (keuze van Cor); de app rekende tot nu toe met 5
const RADIUS_M = 2000; // cellen binnen 2 km hemelsbreed (de loopgrens nu)
const SNAP_MAX = 250; // cel zonder voetpad binnen 250 m telt niet mee (weiland, water)
// --max=30: alleen paren met OSRM-voet ≤ 30 min (2 km lopen, de loopgrens); verdere paren komen met die grens
// niet op de kaart. Zelfde filter als pipeline/walk_pairs_summary.py (stap 0b).
const MAX_T = Number(process.argv.find((a) => a.startsWith("--max="))?.slice(6) ?? Infinity);
const N_STOPS = 30;
const REGIONS: Record<string, [number, number, number, number]> = { // lat_min, lat_max, lon_min, lon_max
  utrecht: [51.95, 52.25, 4.85, 5.35],
  zeeland: [51.2, 51.75, 3.35, 4.3],
  "den haag": [52.03, 52.13, 4.22, 4.4],
  amsterdam: [52.33, 52.4, 4.85, 4.95],
  "arnhem/veluwezoom": [51.95, 52.06, 5.85, 6.05],
};
// lopen over het fietsraster, zonder afkapping binnen het venster: 5 km/u, grens ruim boven RADIUS_M
const P: Params = { ...DEFAULTS, bikeKmh: KMH, bikeMaxKm: 4, directMaxKm: 4, bikeEnd: true };

/** vaste toevalsgenerator (mulberry32), zodat de steekproef elke keer gelijk is */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cellLat = (j: number) => (2 * Math.atan(Math.exp((Y0 + (j + 0.5) * CELL) / 6378137)) - Math.PI / 2) * (180 / Math.PI);
const cellLon = (i: number) => ((X0 + (i + 0.5) * CELL) / 6378137) * (180 / Math.PI);

interface Table { durations?: unknown; distances: (number | null)[][]; sources: { distance: number }[]; destinations: { distance: number }[] }

async function table(url: string, pts: [number, number][]): Promise<Table> {
  const coords = pts.map(([la, lo]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(";");
  for (let a = 0; a < 3; a++) {
    try {
      const res = await realFetch(`${url}${coords}?annotations=distance&sources=0`, { method: "GET" });
      if (res.ok) return (await res.json()) as Table;
    } catch { /* opnieuw */ }
  }
  throw new Error(`OSRM onbereikbaar: ${url}`);
}

/** afstand halte → cel over de weg, inclusief beide snapafstanden; NaN = geen route of geen weg bij de cel */
function walked(t: Table, k: number): number {
  const d = t.distances[0][k + 1];
  const snap = t.destinations[k + 1].distance;
  return d === null || snap > SNAP_MAX ? NaN : t.sources[0].distance + d + snap;
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`.padStart(6);

async function main() {
  const g = await loadGraph(WEB);
  applyDay(g, "wd");
  const bg = (await loadBikeGrid(WEB, g))!;
  const v = (KMH / 3.6) * 60; // meter per minuut
  const total = { n: 0, g5: 0, g2: 0, m5: 0, b5: 0, r5: 0, miss: 0 };
  console.log(`lopen ${KMH} km/u, cellen binnen ${RADIUS_M} m hemelsbreed van ${N_STOPS} haltes per regio; fout = schatting − OSRM-voet${MAX_T < Infinity ? `; alleen OSRM-voet ≤ ${MAX_T} min` : ""}`);
  console.log("regio               paren  raster>5  raster>2  hemelsbr>5  fietsOSRM>5  raster-fietsOSRM>5  niet bereikt  raster p50/p90/p98 (min)");
  for (const [name, [la0, la1, lo0, lo1]] of Object.entries(REGIONS)) {
    const inside: number[] = [];
    for (let a = 0; a < g.nArea; a++) {
      const la = g.areaLat[a], lo = g.areaLon[a];
      if (la > la0 + 0.02 && la < la1 - 0.02 && lo > lo0 + 0.03 && lo < lo1 - 0.03) inside.push(a);
    }
    const r = rng(7);
    const picks = new Set<number>();
    while (picks.size < Math.min(N_STOPS, inside.length)) picks.add(inside[Math.floor(r() * inside.length)]);

    const err: number[] = [];
    const worst: [number, string][] = []; // grootste verschillen raster − voet, om de waarheid na te lopen
    const c = { n: 0, g5: 0, g2: 0, m5: 0, b5: 0, r5: 0, miss: 0 };
    for (const a of picks) {
      const lat = g.areaLat[a], lon = g.areaLon[a];
      // raster: alleen deze halte als bron, op tijd 0
      const dist = new Float64Array(g.nArea).fill(Infinity);
      dist[a] = 0;
      const time = rasterizeBike(bg, g, { dist } as unknown as Search, null, P).time;

      const oi = Math.floor((mercX(lon) - X0) / CELL), oj = Math.floor((mercY(lat) - Y0) / CELL);
      const R = Math.ceil((RADIUS_M * 1.8) / CELL);
      const cells: number[] = [], pts: [number, number][] = [[lat, lon]];
      for (let j = Math.max(0, oj - R); j <= Math.min(NY - 1, oj + R); j++) {
        for (let i = Math.max(0, oi - R); i <= Math.min(NX - 1, oi + R); i++) {
          if (distM(lat, lon, cellLat(j), cellLon(i)) > RADIUS_M) continue;
          cells.push(j * NX + i);
          pts.push([cellLat(j), cellLon(i)]);
        }
      }
      const [foot, bike] = await Promise.all([table(FOOT, pts), table(BIKE, pts)]);
      if (foot.sources[0].distance > SNAP_MAX) continue;
      for (let k = 0; k < cells.length; k++) {
        const T = walked(foot, k) / v;
        if (!Number.isFinite(T) || T > MAX_T) continue;
        const B = walked(bike, k) / v;
        const G = time[cells[k]];
        const M = (distM(lat, lon, pts[k + 1][0], pts[k + 1][1]) * DETOUR) / v;
        c.n++;
        if (!Number.isFinite(G)) { c.miss++; continue; }
        err.push(G - T);
        worst.push([B - T, `${g.areaNames[a]} (${lat.toFixed(5)},${lon.toFixed(5)}) → ${pts[k + 1][0].toFixed(5)},${pts[k + 1][1].toFixed(5)}: voet ${T.toFixed(0)}, fiets-OSRM ${B.toFixed(0)}, raster ${G.toFixed(0)}, hemelsbreed×1,3 ${M.toFixed(0)} min`]);
        if (Math.abs(G - T) > 5) c.g5++;
        if (Math.abs(G - T) > 2) c.g2++;
        if (Math.abs(M - T) > 5) c.m5++;
        if (!Number.isFinite(B) || Math.abs(B - T) > 5) c.b5++;
        if (Number.isFinite(B) && Math.abs(G - B) > 5) c.r5++;
      }
    }
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += c[k];
    const p = [0.5, 0.9, 0.98].map((x) => q(err, x).toFixed(1)).join(" / ");
    if (process.argv.includes("--voorbeelden")) for (const [, w] of worst.sort((x, y) => y[0] - x[0]).slice(0, 3)) console.log("    " + w);
    console.log(`${name.padEnd(18)} ${String(c.n).padStart(6)}  ${pct(c.g5, c.n)}    ${pct(c.g2, c.n)}    ${pct(c.m5, c.n)}      ${pct(c.b5, c.n)}       ${pct(c.r5, c.n)}           ${pct(c.miss, c.n)}     ${p}`);
  }
  const t = total;
  console.log(`${"totaal".padEnd(18)} ${String(t.n).padStart(6)}  ${pct(t.g5, t.n)}    ${pct(t.g2, t.n)}    ${pct(t.m5, t.n)}      ${pct(t.b5, t.n)}       ${pct(t.r5, t.n)}           ${pct(t.miss, t.n)}`);
}

main();
