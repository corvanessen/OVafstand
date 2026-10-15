// Web Worker: houdt de graaf en het laatste resultaat vast, zodat de kaart soepel blijft.

import { loadBikeGrid, originAccess, rasterizeBike, type BikeGrid } from "./bikegrid";
import { NX, NY, cellOf } from "./grid";
import { colorize, rasterize, VIA_DIRECT, VIA_NONE, type Raster } from "./raster";
import { loadGraph, loadHours, pathTo, search, straightAccess, type Graph, type Params, type Search, type Segment } from "./router";

export type Request =
  | { type: "init"; base: string }
  | { type: "compute"; id: number; lat: number; lon: number; params: Params }
  | { type: "explain"; id: number; resultId: number; lat: number; lon: number }
  // diagram (fase 6.4): bereikbaar oppervlak binnen tMaxMin, voor één vertrektijd
  | { type: "profile"; gen: number; departMin: number; lat: number; lon: number; params: Params };

export type Response =
  | { type: "ready"; date: string; nArea: number; ms: number; stations: Station[] }
  | { type: "bikeReady"; ok: boolean; ms: number; nNode: number }
  | { type: "result"; id: number; bitmap: ImageBitmap; msRoute: number; msRaster: number; reached: number; bike: boolean }
  | { type: "explain"; id: number; minutes: number | null; segments: Segment[]; lastBike: number }
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

let graph: Graph | null = null;
let base = "";
let bike: BikeGrid | null = null;
// de laatste resultaten per id: tijdens afspelen is het getoonde beeld niet het laatst berekende
const results = new Map<number, { s: Search; r: Raster }>();
const KEEP = 4;
const CELL_KM2 = 0.0625; // een cel is ±250 × 250 m

/** OV-zoektocht plus het raster (fietsen over de weg of hemelsbreed) voor één vertrekpunt */
function run(g: Graph, lat: number, lon: number, p: Params) {
  const useBike = p.realBike && bike !== null;
  const init = useBike ? originAccess(bike!, g, lat, lon, p) : straightAccess(g, lat, lon, p);
  const s = search(g, init, p);
  const t1 = performance.now();
  const r = useBike ? rasterizeBike(bike!, g, s, lat, lon, p) : rasterize(g, s, lat, lon, p);
  return { s, r, useBike, t1 };
}

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

self.onmessage = async (ev: MessageEvent<Request>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      base = m.base;
      graph = await loadGraph(m.base);
      post({ type: "ready", date: graph.date, nArea: graph.nArea, ms: performance.now() - t0,
        stations: trainStations(graph) });
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
      if (m.params.departMin !== null && !(await loadHours(base, graph))) m.params.departMin = null;
      const t0 = performance.now();
      const { s, r, useBike, t1 } = run(graph, m.lat, m.lon, m.params);
      const img = colorize(r, m.params.tMaxMin);
      const canvas = new OffscreenCanvas(NX, NY);
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      const bitmap = canvas.transferToImageBitmap();
      const t2 = performance.now();
      results.set(m.id, { s, r });
      for (const id of results.keys()) if (results.size > KEEP) results.delete(id);
      let reached = 0;
      for (let a = 0; a < graph.nArea; a++) if (s.dist[a] < m.params.tMaxMin * 60) reached++;
      post({ type: "result", id: m.id, bitmap, msRoute: t1 - t0, msRaster: t2 - t1, reached, bike: useBike }, [bitmap]);
    } else if (m.type === "profile" && graph) {
      const p = { ...m.params, departMin: m.departMin };
      if (!(await loadHours(base, graph))) return;
      const { r } = run(graph, m.lat, m.lon, p);
      let n = 0;
      for (let i = 0; i < r.time.length; i++) if (r.time[i] < p.tMaxMin) n++;
      post({ type: "profile", gen: m.gen, departMin: m.departMin, km2: n * CELL_KM2 });
    } else if (m.type === "explain" && graph) {
      const last = results.get(m.resultId);
      if (!last) {
        post({ type: "explain", id: m.id, minutes: null, segments: [], lastBike: 0 });
        return;
      }
      const c = cellOf(m.lat, m.lon);
      const via = c < 0 ? VIA_NONE : last.r.via[c];
      if (via === VIA_NONE) {
        post({ type: "explain", id: m.id, minutes: null, segments: [], lastBike: 0 });
        return;
      }
      const minutes = last.r.time[c];
      if (via === VIA_DIRECT) {
        post({ type: "explain", id: m.id, minutes, segments: [], lastBike: minutes });
        return;
      }
      const segments = pathTo(graph, last.s, via);
      post({ type: "explain", id: m.id, minutes, segments, lastBike: minutes - last.s.dist[via] / 60 });
    }
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
};
