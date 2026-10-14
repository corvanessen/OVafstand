// Laden van graph.bin en one-to-all Dijkstra over het OV-netwerk (model A / A+).
// Zie pipeline/export_web.py voor het bestandsformaat.

export type Route = [shortName: string, routeType: number, agency: string, longName: string];

export interface Graph {
  date: string;
  nArea: number;
  nNode: number;
  areaLat: Float32Array;
  areaLon: Float32Array;
  offsets: Uint32Array;
  target: Uint32Array;
  lineRoute: Uint16Array;
  cost: Uint16Array;
  kind: Uint8Array;
  areaNames: string[];
  routes: Route[];
  hoursFile: string | null;
  /** uurmodel (na loadHours): wachttijd in minuten per instapkant per uur, 255 = geen vertrek */
  hours: Uint8Array | null;
  /** per kant de rij in hours (alleen instapkanten), anders -1 */
  boardRow: Int32Array | null;
}

export interface Params {
  waitFactor: number; // 0 = alleen rijtijd, 0.5 = gemiddeld half interval wachten
  waitCapMin: number; // maximale wachtstraf per instap
  bikeKmh: number;
  bikeMaxKm: number; // max fietsafstand van de laatste halte naar de bestemming
  directMaxKm: number; // max fietsafstand vanaf het vertrekpunt (direct, of naar de eerste halte)
  tMaxMin: number; // kleurschaal en zoekgrens
  realBike: boolean; // fietsen over de weg (fietsraster uit OSM) in plaats van hemelsbreed × DETOUR
  // vertrektijd in minuten na middernacht (uurmodel, realistische wachttijd per uur);
  // null = een gemiddelde werkdag 07–19 u met waitFactor
  departMin: number | null;
}

export const DETOUR = 1.3; // hemelsbreed -> over de weg
const KIND_BOARD = 1;
const HOUR_BINS = 24;
const NO_SERVICE = 255;

/** haalt een .gz-bestand op en pakt het zelf uit als de server geen Content-Encoding zette; null bij 404 */
export async function fetchGz(url: string): Promise<ArrayBuffer | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

/** laadt het uurmodel (hours.bin.gz) in g.hours; false als het ontbreekt of niet past */
export async function loadHours(base: string, g: Graph): Promise<boolean> {
  if (g.hours) return true;
  if (!g.hoursFile) return false;
  const buf = await fetchGz(base + g.hoursFile);
  if (!buf) return false;
  const hours = new Uint8Array(buf);
  const boardRow = new Int32Array(g.kind.length).fill(-1);
  let n = 0;
  for (let e = 0; e < g.kind.length; e++) if (g.kind[e] === KIND_BOARD) boardRow[e] = n++;
  if (hours.length !== n * HOUR_BINS) {
    console.warn("hours.bin.gz past niet bij deze graaf", hours.length, n);
    return false;
  }
  g.hours = hours;
  g.boardRow = boardRow;
  return true;
}

export async function loadGraph(base: string): Promise<Graph> {
  const [meta, buf] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json()),
    fetch(base + "graph.bin").then((r) => r.arrayBuffer()),
  ]);
  const L = meta.layout as Record<string, [number, number]>;
  return {
    date: meta.date,
    nArea: meta.nArea,
    nNode: meta.nNode,
    areaLat: new Float32Array(buf, ...L.areaLat),
    areaLon: new Float32Array(buf, ...L.areaLon),
    offsets: new Uint32Array(buf, ...L.offsets),
    target: new Uint32Array(buf, ...L.target),
    lineRoute: new Uint16Array(buf, ...L.lineRoute),
    cost: new Uint16Array(buf, ...L.cost),
    kind: new Uint8Array(buf, ...L.kind),
    areaNames: meta.areaNames,
    routes: meta.routes,
    hoursFile: meta.hours?.file ?? null,
    hours: null,
    boardRow: null,
  };
}

/** hemelsbrede afstand in meter (equirectangulair, ruim nauwkeurig genoeg op < 20 km) */
export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const kx = 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110574);
}

export interface Search {
  dist: Float64Array; // seconden, per knoop
  pred: Int32Array; // vorige knoop, -1 = begin (fiets vanaf startpunt), -2 = onbereikt
}

/** Binaire min-heap met 'lazy deletion' (verouderde items worden overgeslagen). */
class Heap {
  keys = new Float64Array(1 << 16);
  vals = new Int32Array(1 << 16);
  size = 0;
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const k2 = new Float64Array(this.size * 2);
      k2.set(this.keys);
      const v2 = new Int32Array(this.size * 2);
      v2.set(this.vals);
      this.keys = k2;
      this.vals = v2;
    }
    const { keys, vals } = this;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  /** haalt het minimum eruit; sleutel staat daarna in this.topKey */
  topKey = 0;
  pop(): number {
    const { keys, vals } = this;
    const v = vals[0];
    this.topKey = keys[0];
    const k = keys[--this.size];
    const x = vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = k;
    vals[i] = x;
    return v;
  }
}

/** begintijden (s) per halteplek: hemelsbreed × DETOUR fietsen vanaf het vertrekpunt, binnen directMaxKm */
export function straightAccess(g: Graph, lat: number, lon: number, p: Params): Float64Array {
  const init = new Float64Array(g.nArea).fill(Infinity);
  const v = p.bikeKmh / 3.6;
  const accessMax = p.directMaxKm * 1000;
  for (let a = 0; a < g.nArea; a++) {
    const d = distM(lat, lon, g.areaLat[a], g.areaLon[a]) * DETOUR;
    if (d <= accessMax) init[a] = d / v;
  }
  return init;
}

/** OV-zoektocht vanaf de halteplekken met begintijd init[a] (de fietstijd vanaf het vertrekpunt) */
export function search(g: Graph, init: Float64Array, p: Params): Search {
  const dist = new Float64Array(g.nNode).fill(Infinity);
  const pred = new Int32Array(g.nNode).fill(-2);
  const heap = new Heap();
  const waitCap = p.waitCapMin * 60;
  const tMax = p.tMaxMin * 60;

  for (let a = 0; a < g.nArea; a++) {
    if (init[a] < tMax) {
      dist[a] = init[a];
      pred[a] = -1;
      heap.push(dist[a], a);
    }
  }

  const { offsets, target, cost, kind } = g;
  // uurmodel: de wachttijd hangt af van de kloktijd bij aankomst op de halte (vertrektijd + label)
  const hours = p.departMin !== null ? g.hours : null;
  const boardRow = g.boardRow!;
  const t0 = (p.departMin ?? 0) * 60;
  while (heap.size > 0) {
    const u = heap.pop();
    const du = heap.topKey;
    if (du > dist[u]) continue;
    if (du > tMax) break;
    const hour = Math.floor((t0 + du) / 3600) % HOUR_BINS;
    for (let e = offsets[u], end = offsets[u + 1]; e < end; e++) {
      let w: number;
      if (kind[e] !== KIND_BOARD) w = cost[e];
      else if (hours) {
        const m = hours[boardRow[e] * HOUR_BINS + hour];
        if (m === NO_SERVICE) continue;
        w = m * 60;
      } else w = Math.min(p.waitFactor * cost[e], waitCap);
      const nd = du + w;
      const t = target[e];
      if (nd < dist[t]) {
        dist[t] = nd;
        pred[t] = u;
        heap.push(nd, t);
      }
    }
  }
  return { dist, pred };
}

export type Segment =
  | { kind: "bike"; minutes: number; to: string }
  | { kind: "walk"; minutes: number; from: string; to: string }
  | { kind: "ride"; route: Route; from: string; to: string; wait: number; minutes: number };

/** Route naar halteplek `area` uit de zoekboom, als lijst segmenten (zonder de laatste fietsrit). */
export function pathTo(g: Graph, s: Search, area: number): Segment[] {
  const nodes: number[] = [];
  for (let n = area; n >= 0; n = s.pred[n]) nodes.push(n);
  nodes.reverse();
  const name = (a: number) => g.areaNames[a];
  const min = (sec: number) => sec / 60;
  const segs: Segment[] = [{ kind: "bike", minutes: min(s.dist[nodes[0]]), to: name(nodes[0]) }];
  let i = 0;
  while (i < nodes.length - 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (b < g.nArea) {
      segs.push({ kind: "walk", minutes: min(s.dist[b] - s.dist[a]), from: name(a), to: name(b) });
      i++;
      continue;
    }
    // instappen bij a op lijnknoop b, doorrijden tot de eerste halteplek
    let j = i + 1;
    while (j < nodes.length && nodes[j] >= g.nArea) j++;
    const off = nodes[j];
    segs.push({
      kind: "ride",
      route: g.routes[g.lineRoute[b - g.nArea]],
      from: name(a),
      to: name(off),
      wait: min(s.dist[b] - s.dist[a]),
      minutes: min(s.dist[off] - s.dist[b]),
    });
    i = j;
  }
  return segs;
}
