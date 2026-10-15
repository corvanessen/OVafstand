// Web Worker: houdt de graaf en het laatste resultaat vast, zodat de kaart soepel blijft.

import { loadBikeGrid, originAccess, rasterizeBike, type BikeGrid } from "./bikegrid";
import { NX, NY, cellOf } from "./grid";
import { colorize, colorizeDiff, rasterize, VIA_DIRECT, VIA_NONE, type Raster } from "./raster";
import { applyDay, loadDay, loadGraph, pathTo, type Day, search, straightAccess, type Graph, type Params, type Search, type Segment } from "./router";

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
  // diagram (fase 6.4): bereikbaar oppervlak binnen tMaxMin, voor één vertrektijd
  | { type: "profile"; gen: number; departMin: number; source: Source; a: Point; b: Point | null; params: Params };

/** de reis vanaf één vertrekpunt naar de cel onder de muis; minutes null = niet bereikbaar */
export interface Explained {
  minutes: number | null;
  segments: Segment[];
  lastBike: number;
}

export type Response =
  | { type: "ready"; date: string; nArea: number; ms: number; stations: Station[]; nIc: number;
      days: { key: Day; date: string }[] }
  | { type: "bikeReady"; ok: boolean; ms: number; nNode: number }
  // reached: haltes binnen tMax (bij "max" vanaf allebei); split: bij "diff" de haltes waar A en waar B sneller is
  | { type: "result"; id: number; bitmap: ImageBitmap; msRoute: number; msRaster: number; reached: number;
      split: [number, number] | null; bike: boolean }
  // parts: één reis per vertrekpunt (A, en bij vergelijken ook B)
  | { type: "explain"; id: number; parts: Explained[] }
  | { type: "profile"; gen: number; departMin: number; km2: number }
  | { type: "error"; message: string };

export interface Station {
  name: string;
  lat: number;
  lon: number;
}

/** halteplekken waar je in een trein kunt stappen, voor de zoekbalk */
function trainStations(g: Graph): Station[] {
  const out: Station[] = [];
  for (let a = 0; a < g.nArea; a++) {
    for (let e = g.offsets[a]; e < g.offsets[a + 1]; e++) {
      const t = g.target[e];
      // instappen in een trein die ook overdag rijdt (65535 = alleen 's nachts, zoals de Nightjet)
      if (t >= g.nArea && g.cost[e] !== 65535 && g.routes[g.lineRoute[t - g.nArea]][1] === 2) {
        out.push({ name: g.areaNames[a], lat: g.areaLat[a], lon: g.areaLon[a] });
        break;
      }
    }
  }
  return out;
}

/** IC-stations: halteplekken waar overdag een Intercity instapt (geen internationale treinen) */
function icStations(g: Graph): number[] {
  const out: number[] = [];
  for (let a = 0; a < g.nArea; a++) {
    for (let e = g.offsets[a]; e < g.offsets[a + 1]; e++) {
      const t = g.target[e];
      if (t < g.nArea || g.cost[e] === 65535) continue;
      const [short, type, agency] = g.routes[g.lineRoute[t - g.nArea]];
      if (type === 2 && short.startsWith("Intercity") && agency !== "IFF:NS_INT") {
        out.push(a);
        break;
      }
    }
  }
  return out;
}

let graph: Graph | null = null;
let icAreas: number[] = [];
let base = "";
let bike: BikeGrid | null = null;

interface Run {
  s: Search;
  r: Raster;
  useBike: boolean;
  msRoute: number;
  msRaster: number;
}
// de laatste resultaten per id: tijdens afspelen is het getoonde beeld niet het laatst berekende
const results = new Map<number, Run[]>();
const KEEP = 4;
const CELL_KM2 = 0.0625; // een cel is ±250 × 250 m

/** OV-zoektocht plus het raster (fietsen over de weg of hemelsbreed) voor één vertrekpunt;
 *  pt null: vanaf alle IC-stations tegelijk */
function run(g: Graph, pt: Point | null, p: Params): Run {
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
  const s = search(g, init, p);
  const t1 = performance.now();
  const r = useBike ? rasterizeBike(bike!, g, s, pt, p) : rasterize(g, s, pt, p);
  return { s, r, useBike, msRoute: t1 - t0, msRaster: performance.now() - t1 };
}

// Bij vergelijken verandert meestal één punt tegelijk (slepen met B): het andere komt uit deze cache.
const runCache = new Map<string, Run>();
const KEEP_RUNS = 4;
function cachedRun(g: Graph, pt: Point | null, p: Params): Run {
  const key = JSON.stringify([pt ? [pt.lat, pt.lon] : "ic", p, bike !== null]);
  const hit = runCache.get(key);
  if (hit) runCache.delete(key); // achteraan: het laatst gebruikt
  const r = hit ?? run(g, pt, p);
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

function explainRun(g: Graph, { s, r }: Run, c: number): Explained {
  const via = c < 0 ? VIA_NONE : r.via[c];
  if (via === VIA_NONE) return { minutes: null, segments: [], lastBike: 0 };
  const minutes = r.time[c];
  if (via === VIA_DIRECT) return { minutes, segments: [], lastBike: minutes };
  return { minutes, segments: pathTo(g, s, via), lastBike: minutes - s.dist[via] / 60 };
}

/** De dag van een opdracht laden (werkdag, zaterdag, zondag), met het uurmodel als er een vertrektijd is.
 *  Past p aan als iets ontbreekt. Daarna meteen applyDay en synchroon rekenen: tussen twee awaits kan
 *  een andere opdracht een andere dag gekozen hebben. */
async function prepareDay(g: Graph, p: Params) {
  let ok = await loadDay(base, g, p.day, p.departMin !== null);
  if (!ok.day) {
    p.day = "wd";
    ok = await loadDay(base, g, "wd", p.departMin !== null);
  }
  if (!ok.hours) p.departMin = null;
}

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

self.onmessage = async (ev: MessageEvent<Request>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      base = m.base;
      graph = await loadGraph(m.base);
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
      await prepareDay(graph, m.params);
      const g = graph;
      applyDay(g, m.params.day);
      const pts = m.source === "ic" ? [null] : m.b ? [m.a, m.b] : [m.a];
      const runs = pts.map((pt) => cachedRun(g, pt, m.params));
      const t1 = performance.now();
      const diff = m.mode === "diff" && runs.length === 2;
      const img = diff ? colorizeDiff(runs[0].r.time, runs[1].r.time, m.params.tMaxMin) : colorize(maxTime(runs), m.params.tMaxMin);
      const canvas = new OffscreenCanvas(NX, NY);
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      const bitmap = canvas.transferToImageBitmap();
      const t2 = performance.now();
      results.set(m.id, runs);
      for (const id of results.keys()) if (results.size > KEEP) results.delete(id);
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
        bike: runs[0].useBike }, [bitmap]);
    } else if (m.type === "profile" && graph) {
      const p = { ...m.params, departMin: m.departMin };
      await prepareDay(graph, p);
      if (p.departMin === null) return;
      const g = graph;
      applyDay(g, p.day);
      const pts = m.source === "ic" ? [null] : m.b ? [m.a, m.b] : [m.a];
      const time = maxTime(pts.map((pt) => run(g, pt, p)));
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
    post({ type: "error", message: String(err) });
  }
};
