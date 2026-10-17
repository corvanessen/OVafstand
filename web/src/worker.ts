// Web Worker: houdt de graaf en het laatste resultaat vast, zodat de kaart soepel blijft.

import { csaPath, csaSearch, footpaths, loadTimetable, type CsaRun, type Footpaths, type Timetable } from "./csa";
import { loadBikeGrid, originAccess, rasterizeBike, type BikeGrid } from "./bikegrid";
import { NX, NY, cellOf } from "./grid";
import { colorize, colorizeDiff, rasterize, VIA_DIRECT, VIA_NONE, type Raster } from "./raster";
import { applyDay, loadDay, loadGraph, pathTo, type Day, search, straightAccess, type Graph, type Params, type Route, type Search, type Segment } from "./router";

export interface Point {
  lat: number;
  lon: number;
}

// Met b (fase 6.5, vergelijken) kleurt de kaart per cel naar de langste van de twee ("max", voor ons allebei)
// of naar het verschil A − B ("diff").
export type CompareMode = "max" | "diff";
// De kaart gaat over één of twee vertrekpunten ("point"), of over de reistijd naar het dichtstbijzijnde
// IC-station ("ic", fase 6.7 stap 3): dan tellen a en b niet.
export type Source = "point" | "ic";
export type Request =
  | { type: "init"; base: string }
  | { type: "compute"; id: number; source: Source; a: Point; b: Point | null; mode: CompareMode; params: Params }
  | { type: "explain"; id: number; resultId: number; lat: number; lon: number }
  // frames die de pagina weggooit (na een wijziging tijdens afspelen, of bij stoppen): niet bewaren
  | { type: "forget"; ids: number[] }
  // diagram (fase 6.4): bereikbaar oppervlak binnen tMaxMin, voor één vertrektijd
  | { type: "profile"; gen: number; departMin: number; source: Source; a: Point; b: Point | null; params: Params };

/** de reis vanaf één vertrekpunt naar de cel onder de muis; minutes null = niet bereikbaar */
export interface Explained {
  minutes: number | null;
  segments: Segment[];
  lastBike: number;
  // met echte vertrektijden: wanneer deze reis vertrekt (kloktijd in s, één van de scans rond de vertrektijd)
  leave?: number;
}

export type Response =
  | { type: "ready"; date: string; nArea: number; ms: number; stations: Station[]; nIc: number;
      days: { key: Day; date: string }[] }
  | { type: "bikeReady"; ok: boolean; ms: number; nNode: number }
  // reached: haltes binnen tMax (bij "max" vanaf allebei); split: bij "diff" de haltes waar A en waar B sneller is
  | { type: "result"; id: number; bitmap: ImageBitmap; msRoute: number; msRaster: number; reached: number;
      split: [number, number] | null; bike: boolean; timetable: boolean }
  // parts: één reis per vertrekpunt (A, en bij vergelijken ook B)
  | { type: "explain"; id: number; parts: Explained[] }
  | { type: "profile"; gen: number; departMin: number; km2: number }
  // of: het verzoek dat misging (compute: id, profile: gen en departMin), zodat main.ts zijn wachtrij kan bijwerken
  | { type: "error"; message: string; of: ErrorOf };
export type ErrorOf =
  | { type: "init" }
  | { type: "compute"; id: number }
  | { type: "profile"; gen: number; departMin: number }
  | { type: "explain"; id: number };

export interface Station {
  name: string;
  lat: number;
  lon: number;
}

/** halteplekken waar je op de werkdag overdag instapt in een lijn waarvoor test(route) geldt
 *  (instapkost 65535 = alleen 's nachts, zoals de Nightjet) */
function areasWithRoute(g: Graph, test: (r: Route) => boolean): number[] {
  const out: number[] = [];
  for (let a = 0; a < g.nArea; a++) {
    for (let e = g.offsets[a]; e < g.offsets[a + 1]; e++) {
      const t = g.target[e];
      if (t >= g.nArea && g.cost[e] !== 65535 && test(g.routes[g.lineRoute[t - g.nArea]])) {
        out.push(a);
        break;
      }
    }
  }
  return out;
}
/** halteplekken waar je in een trein kunt stappen, voor de zoekbalk */
const trainStations = (g: Graph): Station[] =>
  areasWithRoute(g, (r) => r[1] === 2).map((a) => ({ name: g.areaNames[a], lat: g.areaLat[a], lon: g.areaLon[a] }));
/** IC-stations: waar een Intercity instapt (geen internationale treinen) */
const icStations = (g: Graph) =>
  areasWithRoute(g, ([short, type, agency]) => type === 2 && short.startsWith("Intercity") && agency !== "IFF:NS_INT");

let graph: Graph | null = null;
let icAreas: number[] = [];
let base = "";
let bike: BikeGrid | null = null;
// dienstregeling (fase 4): pas geladen als iemand erom vraagt, één dag tegelijk; null = ontbreekt
const timetables = new Map<Day, Promise<Timetable | null>>();
let walks: Footpaths | null = null;

interface Run {
  s: Search;
  r: Raster;
  useBike: boolean;
  msRoute: number;
  msRaster: number;
  // met de dienstregeling: om de route naar een halteplek opnieuw uit te rekenen (op die dag)
  csa: { tt: Timetable; run: CsaRun; day: Day } | null;
}
// De resultaten per id, voor de tooltip: tijdens afspelen is het getoonde beeld niet het laatst berekende.
// De pagina meldt wat ze niet meer nodig heeft ("forget"): het vorige beeld zodra er een nieuw in beeld komt,
// en de frames die ze weggooit (na een wijziging tijdens afspelen, of bij stoppen). Dan blijven het getoonde
// beeld en de frames vooruit (AHEAD in playback.ts) over. KEEP is het vangnet daarboven, met plaats voor een
// gewone kaart die tijdens afspelen tussendoor komt: die staat na de frames, maar komt eerder in beeld.
// Een run kost ±10 MB.
const results = new Map<number, Run[]>();
const forgotten = new Set<number>(); // weggegooid terwijl nog onderweg: straks niet bewaren
const KEEP = 4;
const CELL_KM2 = 0.0625; // een cel is ±250 × 250 m

/** OV-zoektocht plus het raster (fietsen over de weg of hemelsbreed) voor één vertrekpunt;
 *  pt null: vanaf alle IC-stations tegelijk */
function run(g: Graph, pt: Point | null, p: Params, tt: Timetable | null): Run {
  const t0 = performance.now();
  const useBike = p.realBike && bike !== null;
  let init: Float64Array;
  if (pt) init = useBike ? originAccess(bike!, g, pt.lat, pt.lon, p) : straightAccess(g, pt.lat, pt.lon, p);
  else {
    // Gerekend vanaf de stations, bedoeld als reistijd naar het station: het laatste stuk ligt aan de
    // kant van de plek zelf, dus dat volgt "fiets bij vertrek". Het netwerk is bijna symmetrisch.
    p = { ...p, bikeEnd: p.bikeStart, bikeMaxKm: p.directMaxKm };
    init = new Float64Array(g.nArea).fill(Infinity);
    for (const a of icAreas) init[a] = 0;
  }
  let s: Search;
  let csa: Run["csa"] = null;
  if (tt && p.departMin !== null) {
    const res = csaSearch(g, tt, (walks ??= footpaths(g)), init, p);
    s = res.s;
    csa = { tt, run: res.csa, day: p.day };
  } else s = search(g, init, p);
  const t1 = performance.now();
  const r = useBike ? rasterizeBike(bike!, g, s, pt, p) : rasterize(g, s, pt, p);
  return { s, r, useBike, msRoute: t1 - t0, msRaster: performance.now() - t1, csa };
}

// Bij vergelijken verandert meestal één punt tegelijk (slepen met B): het andere komt uit deze cache.
// Twee is genoeg: het punt dat blijft staan, is steeds het laatst gebruikt.
const runCache = new Map<string, Run>();
const KEEP_RUNS = 2;
function cachedRun(g: Graph, pt: Point | null, p: Params, tt: Timetable | null): Run {
  const key = JSON.stringify([pt ? [pt.lat, pt.lon] : "ic", p, bike !== null]);
  const hit = runCache.get(key);
  if (hit) runCache.delete(key); // achteraan: het laatst gebruikt
  const r = hit ?? run(g, pt, p, tt);
  runCache.set(key, r);
  for (const k of runCache.keys()) if (runCache.size > KEEP_RUNS) runCache.delete(k);
  return hit ? { ...hit, msRoute: 0, msRaster: 0 } : r;
}

/** per cel de langste reistijd van alle punten: waar zijn we allemaal snel? */
function maxTime(runs: Run[]): Float32Array {
  if (runs.length === 1) return runs[0].r.time;
  const out = new Float32Array(runs[0].r.time);
  for (const { r } of runs.slice(1)) {
    const t = r.time;
    for (let i = 0; i < out.length; i++) if (t[i] > out[i]) out[i] = t[i];
  }
  return out;
}

function explainRun(g: Graph, { s, r, csa }: Run, c: number): Explained {
  const via = c < 0 ? VIA_NONE : r.via[c];
  if (via === VIA_NONE) return { minutes: null, segments: [], lastBike: 0 };
  const minutes = r.time[c];
  if (via === VIA_DIRECT) return { minutes, segments: [], lastBike: minutes };
  const lastBike = minutes - s.dist[via] / 60;
  if (!csa) return { minutes, segments: pathTo(g, s, via), lastBike };
  // de scan gebruikt de halteplekken van de dag van dit resultaat, ook als intussen een andere dag gekozen is
  const now = g.day;
  applyDay(g, csa.day);
  try {
    const { segments, t0 } = csaPath(g, csa.tt, walks!, csa.run, via);
    return { minutes, segments, lastBike, leave: t0 };
  } finally {
    applyDay(g, now);
  }
}

/** De dag van een opdracht laden (werkdag, zaterdag, zondag), met het uurmodel als er een vertrektijd is,
 *  en de dienstregeling als die gevraagd is (die komt terug). Past p aan als iets ontbreekt. Daarna meteen applyDay en synchroon rekenen: tussen twee awaits kan
 *  een andere opdracht een andere dag gekozen hebben. */
async function prepareDay(g: Graph, p: Params): Promise<Timetable | null> {
  let ok = await loadDay(base, g, p.day, p.departMin !== null);
  if (!ok.day) {
    p.day = "wd";
    ok = await loadDay(base, g, "wd", p.departMin !== null);
  }
  if (!ok.hours) p.departMin = null;
  if (!p.timetable || p.departMin === null) {
    p.timetable = false;
    return null;
  }
  const info = g.days.find((d) => d.key === p.day)?.conn;
  if (info && !timetables.has(p.day)) {
    // alleen de dag die nu gevraagd wordt (17–31 MB per dag); terug naar een andere dag laadt die opnieuw
    // (uit de HTTP-cache, ±150–250 ms). Runs in results en runCache houden hun eigen dag nog even vast.
    timetables.clear();
    timetables.set(p.day, loadTimetable(base, info).catch(() => null));
  }
  const tt = info ? await timetables.get(p.day)! : null;
  if (!tt) {
    console.warn(`dienstregeling van ${p.day} ontbreekt; het uurmodel rekent`);
    p.timetable = false;
  }
  return tt;
}

/** de dag van een opdracht laden en kiezen, plus de punten (null: vanaf alle IC-stations).
 *  Wat na de await komt, moet synchroon blijven (zie prepareDay). */
async function prepare(g: Graph, source: Source, a: Point, b: Point | null, p: Params) {
  const tt = await prepareDay(g, p);
  applyDay(g, p.day);
  const pts: (Point | null)[] = source === "ic" ? [null] : b ? [a, b] : [a];
  return { tt, pts };
}

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

self.onmessage = async (ev: MessageEvent<Request>) => {
  const m = ev.data;
  if (m.type === "forget") {
    for (const id of m.ids) if (!results.delete(id)) forgotten.add(id);
    return;
  }
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      base = m.base;
      graph = await loadGraph(m.base);
      if (graph.nArea >= VIA_DIRECT) throw new Error(`${graph.nArea} halteplekken: past niet in Raster.via (Uint16)`);
      applyDay(graph, "wd");
      icAreas = icStations(graph);
      post({ type: "ready", date: graph.date, nArea: graph.nArea, ms: performance.now() - t0,
        stations: trainStations(graph), nIc: icAreas.length, days: graph.days.map(({ key, date }) => ({ key, date })) });
      // het fietsraster (±2 MB) komt erna; tot dan rekent de kaart hemelsbreed
      const t1 = performance.now();
      try {
        bike = await loadBikeGrid(m.base, graph);
      } catch (err) {
        console.warn("fietsraster niet geladen:", err);
      }
      post({ type: "bikeReady", ok: bike !== null, ms: performance.now() - t1, nNode: bike?.nNode ?? 0 });
    } else if (m.type === "compute" && graph) {
      // het uurmodel (±0,6 MB) pas laden als er een vertrektijd gekozen is
      const g = graph;
      const { tt, pts } = await prepare(g, m.source, m.a, m.b, m.params);
      const runs = pts.map((pt) => cachedRun(g, pt, m.params, tt));
      const t1 = performance.now();
      const diff = m.mode === "diff" && runs.length === 2;
      const img = diff ? colorizeDiff(runs[0].r.time, runs[1].r.time, m.params.tMaxMin) : colorize(maxTime(runs), m.params.tMaxMin);
      const canvas = new OffscreenCanvas(NX, NY);
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      const bitmap = canvas.transferToImageBitmap();
      const t2 = performance.now();
      if (!forgotten.delete(m.id)) {
        results.set(m.id, runs);
        for (const id of results.keys()) if (results.size > KEEP) results.delete(id);
      }
      // haltes die vanaf elk punt binnen de kleurschaal liggen; bij "diff": vanaf minstens één, en wie er sneller is
      const tMax = m.params.tMaxMin * 60;
      let reached = 0;
      const split: [number, number] | null = diff ? [0, 0] : null;
      for (let a = 0; a < g.nArea; a++) {
        if (split) {
          const da = runs[0].s.dist[a], db = runs[1].s.dist[a];
          if (Math.min(da, db) >= tMax) continue;
          reached++;
          if (da < db) split[0]++;
          else if (db < da) split[1]++;
        } else if (runs.every(({ s }) => s.dist[a] < tMax)) reached++;
      }
      const sum = (k: "msRoute" | "msRaster") => runs.reduce((t, r) => t + r[k], 0);
      post({ type: "result", id: m.id, bitmap, msRoute: sum("msRoute"), msRaster: sum("msRaster") + t2 - t1, reached, split,
        bike: runs[0].useBike, timetable: tt !== null }, [bitmap]);
    } else if (m.type === "profile" && graph) {
      const p = { ...m.params, departMin: m.departMin };
      const g = graph;
      const { tt, pts } = await prepare(g, m.source, m.a, m.b, p);
      // zonder uurmodel geen vertrektijd: toch antwoorden, anders wacht het diagram voor altijd
      if (p.departMin === null) return post({ type: "profile", gen: m.gen, departMin: m.departMin, km2: NaN });
      const time = maxTime(pts.map((pt) => run(g, pt, p, tt)));
      let n = 0;
      for (let i = 0; i < time.length; i++) if (time[i] < p.tMaxMin) n++;
      post({ type: "profile", gen: m.gen, departMin: m.departMin, km2: n * CELL_KM2 });
    } else if (m.type === "explain" && graph) {
      const g = graph;
      const runs = results.get(m.resultId);
      const c = cellOf(m.lat, m.lon);
      const parts = runs ? runs.map((r) => explainRun(g, r, c)) : [{ minutes: null, segments: [], lastBike: 0 }];
      post({ type: "explain", id: m.id, parts });
    }
  } catch (err) {
    const of: ErrorOf = m.type === "compute" || m.type === "explain" ? { type: m.type, id: m.id }
      : m.type === "profile" ? { type: "profile", gen: m.gen, departMin: m.departMin } : { type: "init" };
    post({ type: "error", message: String(err), of });
  }
};
