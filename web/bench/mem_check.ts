// Geheugenmeting: hoeveel bytes houdt de worker vast, per onderdeel en per berekening?
//   cd web && npx rolldown bench/mem_check.ts --platform node -o ../data/mem_check.mjs && node --expose-gc ../data/mem_check.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { csaSearch, footpaths, loadTimetable, type Timetable } from "../src/csa";
import { loadBikeGrid, originAccess, rasterizeBike } from "../src/bikegrid";
import { applyDay, loadDay, loadGraph, search, type Day, type Params } from "../src/router";

const WEB = resolve(import.meta.dirname ?? ".", "../web/public/data") + "/";
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const P: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true,
  departMin: 480, bikeStart: true, bikeEnd: false, day: "wd", timetable: true,
};

const MB = (b: number) => (b / 2 ** 20).toFixed(1).padStart(7) + " MB";
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
/** bytes van alle typed arrays in een object (één niveau diep), apart per veld */
function arrays(o: object): [string, number][] {
  return Object.entries(o)
    .filter(([, v]) => ArrayBuffer.isView(v))
    .map(([k, v]) => [k, (v as ArrayBufferView).byteLength] as [string, number])
    .sort((a, b) => b[1] - a[1]);
}
function show(title: string, o: object) {
  const a = arrays(o);
  console.log(`\n${title}: ${MB(a.reduce((t, [, b]) => t + b, 0))}`);
  for (const [k, b] of a) if (b > 2 ** 16) console.log(`  ${k.padEnd(12)} ${MB(b)}`);
}
let last = { heap: 0, ab: 0 };
function stage(name: string) {
  gc();
  const m = process.memoryUsage();
  console.log(`[node] ${name.padEnd(34)} heap ${MB(m.heapUsed)} (+${MB(m.heapUsed - last.heap).trim()}), ` +
    `arrayBuffers ${MB(m.arrayBuffers)} (+${MB(m.arrayBuffers - last.ab).trim()})`);
  last = { heap: m.heapUsed, ab: m.arrayBuffers };
}

async function main() {
  stage("begin");
  const g = await loadGraph(WEB);
  applyDay(g, "wd");
  stage("graaf (graph.bin + meta.json)");
  show("graaf", g);
  console.log(`  areaNames ${g.areaNames.length}, routes ${g.routes.length} (JS-heap)`);

  for (const d of ["wd", "za", "zo"] as Day[]) await loadDay(WEB, g, d, true);
  for (const d of ["za", "zo"] as Day[]) applyDay(g, d);
  applyDay(g, "wd");
  stage("3 dagen + uurmodel");
  for (const [k, d] of g.dayData) show(`dag ${k}`, d);

  const bike = (await loadBikeGrid(WEB, g))!;
  stage("fietsraster");
  show("fietsraster", bike);

  const tts = new Map<Day, Timetable>();
  for (const d of g.days) {
    tts.set(d.key, (await loadTimetable(WEB, d.conn!))!);
    stage(`dienstregeling ${d.key}`);
    show(`dienstregeling ${d.key} (${tts.get(d.key)!.n.toLocaleString("nl")} connections)`, tts.get(d.key)!);
  }
  const fp = footpaths(g);
  show("loopkanten", fp);

  // grote nieuwe Int32Arrays loggen: zo zie je of de wachtrij van de fiets-Dijkstra groeit
  const Orig = Int32Array;
  globalThis.Int32Array = class extends Orig {
    constructor(...a: unknown[]) {
      super(...(a as [number]));
      if (typeof a[0] === "number" && a[0] >= 1 << 21) console.log(`  (nieuwe Int32Array van ${MB(this.byteLength).trim()})`);
    }
  } as Int32ArrayConstructor;

  // één kaart (vertrekpunt Utrecht C), zoals run() in de worker
  const pt = { lat: 52.0894, lon: 5.11 };
  const keep: object[] = [];
  for (const timetable of [false, true]) {
    const p = { ...P, timetable };
    const init = originAccess(bike, g, pt.lat, pt.lon, p);
    const res = timetable ? csaSearch(g, tts.get("wd")!, fp, init, p) : { s: search(g, init, p), csa: null };
    const r = rasterizeBike(bike, g, res.s, pt, p);
    keep.push(res, r);
    stage(`één kaart (${timetable ? "CSA" : "uurmodel"})`);
    show(`  zoektocht`, res.s);
    if (res.csa) show(`  CsaRun`, res.csa);
    show(`  raster`, r);
  }
  // de Run-objecten van het fietsraster (fromOrigin, fromStops) zijn module-intern: schatting
  const runBytes = bike.nNode * 12 + 2 * 4 * (1 << 20);
  console.log(`\nfiets-Dijkstra (2 × Run, hergebruikt): ±${MB(2 * runBytes)} (time/bike/src + wachtrij 2 × 4 MB, groeit zo nodig)`);
  console.log(`fillDist: ${MB(bike.nodeOfCell.length * 4)}`);
  console.log(`(${keep.length} resultaten vastgehouden, zodat de meting ze meetelt)`);
}

main();
