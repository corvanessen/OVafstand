// Oppervlak binnen de kleurschaal (km²) en haltes, per rekenwijze en met/zonder fiets bij aankomst.
//   cd web && npx rolldown bench/coverage.ts --platform node -o ../data/coverage.mjs && node ../data/coverage.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBikeGrid, originAccess, rasterizeBike } from "../src/bikegrid";
import { csaSearch, footpaths, loadTimetable } from "../src/csa";
import { applyDay, loadDay, loadGraph, search, type Params } from "../src/router";

const WEB = resolve(import.meta.dirname ?? ".", "../web/public/data") + "/";
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const BASE: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true,
  departMin: null, bikeStart: true, bikeEnd: false, day: "wd", timetable: false,
};
const CELL_KM2 = 0.0625;

async function main() {
  const g = await loadGraph(WEB);
  await loadDay(WEB, g, "wd", true);
  applyDay(g, "wd");
  const bg = (await loadBikeGrid(WEB, g))!;
  const tt = (await loadTimetable(WEB, g.days[0].conn!))!;
  const fp = footpaths(g);
  const [lat, lon] = [52.0894, 5.11];
  console.log("rekenwijze                 | aankomst | haltes ≤ 3 u | km² ≤ 3 u | km² ≤ 1 u");
  for (const [label, extra] of [
    ["gemiddelde dag 07–19 u", {}],
    ["uurmodel 08:00", { departMin: 480 }],
    ["dienstregeling 08:00", { departMin: 480, timetable: true }],
  ] as [string, Partial<Params>][]) {
    for (const bikeEnd of [true, false]) {
      const p = { ...BASE, ...extra, bikeEnd };
      const init = originAccess(bg, g, lat, lon, p);
      const s = p.timetable ? csaSearch(g, tt, fp, init, p).s : search(g, init, p);
      const r = rasterizeBike(bg, g, s, { lat, lon }, p);
      let n3 = 0, n1 = 0, h = 0;
      for (let i = 0; i < r.time.length; i++) {
        if (r.time[i] < 180) n3++;
        if (r.time[i] < 60) n1++;
      }
      for (let a = 0; a < g.nArea; a++) if (s.dist[a] < 180 * 60) h++;
      console.log(`${label.padEnd(26)} | ${bikeEnd ? "fiets   " : "lopen   "} | ${String(h).padStart(12)} | ${Math.round(n3 * CELL_KM2).toLocaleString("nl").padStart(9)} | ${Math.round(n1 * CELL_KM2).toLocaleString("nl").padStart(9)}`);
    }
  }
}

main();
