// Web Worker: houdt de graaf en het laatste resultaat vast, zodat de kaart soepel blijft.

import { NX, NY, cellOf } from "./grid";
import { colorize, rasterize, VIA_DIRECT, VIA_NONE, type Raster } from "./raster";
import { loadGraph, pathTo, search, type Graph, type Params, type Search, type Segment } from "./router";

export type Request =
  | { type: "init"; base: string }
  | { type: "compute"; id: number; lat: number; lon: number; params: Params }
  | { type: "explain"; id: number; lat: number; lon: number };

export type Response =
  | { type: "ready"; date: string; nArea: number; ms: number; stations: Station[] }
  | { type: "result"; id: number; bitmap: ImageBitmap; msRoute: number; msRaster: number; reached: number }
  | { type: "explain"; id: number; minutes: number | null; segments: Segment[]; lastBike: number }
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
      if (t >= g.nArea && g.routes[g.lineRoute[t - g.nArea]][1] === 2) {
        out.push({ name: g.areaNames[a], lat: g.areaLat[a], lon: g.areaLon[a] });
        break;
      }
    }
  }
  return out;
}

let graph: Graph | null = null;
let last: { s: Search; r: Raster } | null = null;

const post = (msg: Response, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

self.onmessage = async (ev: MessageEvent<Request>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      const t0 = performance.now();
      graph = await loadGraph(m.base);
      post({ type: "ready", date: graph.date, nArea: graph.nArea, ms: performance.now() - t0,
        stations: trainStations(graph) });
    } else if (m.type === "compute" && graph) {
      const t0 = performance.now();
      const s = search(graph, m.lat, m.lon, m.params);
      const t1 = performance.now();
      const r = rasterize(graph, s, m.lat, m.lon, m.params);
      const img = colorize(r, m.params.tMaxMin);
      const canvas = new OffscreenCanvas(NX, NY);
      canvas.getContext("2d")!.putImageData(img, 0, 0);
      const bitmap = canvas.transferToImageBitmap();
      const t2 = performance.now();
      last = { s, r };
      let reached = 0;
      for (let a = 0; a < graph.nArea; a++) if (s.dist[a] < m.params.tMaxMin * 60) reached++;
      post({ type: "result", id: m.id, bitmap, msRoute: t1 - t0, msRaster: t2 - t1, reached }, [bitmap]);
    } else if (m.type === "explain" && graph && last) {
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
