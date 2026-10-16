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
  hourBins: number; // tijdvakken per dag in het uurmodel
  /** uurmodel van de gekozen dag (na loadDay met uren): wachttijd in minuten per instapkant per tijdvak,
   *  255 = geen vertrek */
  hours: Uint8Array | null;
  /** per kant de rij in hours (alleen instapkanten), anders -1; voor elke dag dezelfde */
  boardRow: Int32Array;
  nBoard: number;
  // fase 6.7 stap 4: cost, kind en hours horen bij één dag; applyDay wisselt ze
  days: DayInfo[];
  day: Day;
  dayData: Map<Day, DayData>;
  /** halteplekken met een lijn die op de gekozen dag rijdt; de andere slaat search over */
  areaUsed: Uint8Array;
}

export type Day = "wd" | "za" | "zo";
export interface DayInfo {
  key: Day;
  date: string;
  file: string | null; // cost + kind van deze dag; null = de basisdag in graph.bin
  hours: string | null;
  conn?: { file: string; nTrip: number; nStop: number }; // dienstregeling (fase 4), conn_<datum>.bin.gz
}
interface DayData {
  cost: Uint16Array;
  kind: Uint8Array;
  hours: Uint8Array | null;
  used: Uint8Array | null; // zie Graph.areaUsed; pas berekend bij applyDay
}

export interface Params {
  waitFactor: number; // 0 = alleen rijtijd, 0.5 = gemiddeld half interval wachten
  waitCapMin: number; // maximale wachtstraf per instap
  bikeKmh: number;
  bikeMaxKm: number; // max fietsafstand van de laatste halte naar de bestemming
  directMaxKm: number; // max fietsafstand vanaf het vertrekpunt (direct, of naar de eerste halte)
  tMaxMin: number; // kleurschaal en zoekgrens
  realBike: boolean; // fietsen over de weg (fietsraster uit OSM) in plaats van hemelsbreed × DETOUR
  bikeStart: boolean; // fiets bij vertrek; anders lopen (WALK_KMH, tot WALK_MAX_KM)
  bikeEnd: boolean; // fiets bij aankomst (van de laatste halte naar de bestemming); anders lopen
  // vertrektijd in minuten na middernacht (uurmodel, realistische wachttijd per uur);
  // null = een gemiddelde dag 07–19 u met waitFactor
  departMin: number | null;
  day: Day; // werkdag, zaterdag of zondag (de worker kiest daarmee de arrays van de graaf)
  // met departMin: rekenen met de echte vertrektijden (CSA, csa.ts) in plaats van het uurmodel
  timetable: boolean;
}

export const DETOUR = 1.3; // hemelsbreed -> over de weg
export const WALK_KMH = 5;
export const WALK_MAX_KM = 2; // ±25 min lopen naar of van een halte (en direct lopen)

/** snelheid (m/s) en grens (m) van het eerste stuk (vanaf het vertrekpunt) en het laatste (vanaf de halte):
 *  fietsen, of lopen als die fiets er niet is. Lopen gaat over hetzelfde fietsraster, met een andere snelheid. */
export function legs(p: Params) {
  return {
    startV: (p.bikeStart ? p.bikeKmh : WALK_KMH) / 3.6,
    startMax: (p.bikeStart ? p.directMaxKm : WALK_MAX_KM) * 1000,
    endV: (p.bikeEnd ? p.bikeKmh : WALK_KMH) / 3.6,
    endMax: (p.bikeEnd ? p.bikeMaxKm : WALK_MAX_KM) * 1000,
  };
}
const KIND_BOARD = 1;
const KIND_NIGHT = 2; // rijkant die alleen buiten 07–19 u bestaat: alleen in het uurmodel
const KIND_OFF = 3; // rijkant die op deze dag niet rijdt (bestaat alleen op een andere dag)
const CLOSED = 65535; // instapkost van een lijnknoop die in 07–19 u niet rijdt
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

/** Laadt de arrays van een dag (day_<datum>.bin.gz) en, met withHours, het uurmodel van die dag.
 *  day: false als die dag er niet is (dan blijft de vorige over); hours: false als het uurmodel ontbreekt. */
export async function loadDay(base: string, g: Graph, key: Day, withHours: boolean): Promise<{ day: boolean; hours: boolean }> {
  const info = g.days.find((d) => d.key === key);
  if (!info) return { day: false, hours: false };
  let d = g.dayData.get(key);
  if (!d) {
    const n = g.target.length;
    const buf = info.file ? await fetchGz(base + info.file) : null;
    if (!buf || buf.byteLength !== n * 3) {
      console.warn(`${info.file} ontbreekt of past niet bij deze graaf`);
      return { day: false, hours: false };
    }
    d = { cost: new Uint16Array(buf, 0, n), kind: new Uint8Array(buf, n * 2, n), hours: null, used: null };
    g.dayData.set(key, d);
  }
  if (withHours && !d.hours && info.hours) {
    const buf = await fetchGz(base + info.hours);
    if (buf && buf.byteLength === g.nBoard * g.hourBins) d.hours = new Uint8Array(buf);
    else console.warn(`${info.hours} ontbreekt of past niet bij deze graaf`);
  }
  return { day: true, hours: d.hours !== null };
}

/** maakt een geladen dag (loadDay) de dag van de graaf */
export function applyDay(g: Graph, key: Day) {
  const d = g.dayData.get(key)!;
  g.cost = d.cost;
  g.kind = d.kind;
  g.hours = d.hours;
  g.day = key;
  g.areaUsed = d.used ??= areasInUse(g);
}

/** Halteplekken waar op deze dag een lijn stopt: met een in- of uitstapkant naar een lijnknoop die
 *  die dag rijdt (een rijkant van soort 0 of 2, erin of eruit). Zonder dit zou je via een loopkant
 *  een halte bereiken die alleen op een andere dag gebruikt wordt. */
function areasInUse(g: Graph): Uint8Array {
  const { nArea, offsets, target, kind } = g;
  const runs = new Uint8Array(g.nNode);
  for (let u = nArea; u < g.nNode; u++) {
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = target[e];
      if (v >= nArea && (kind[e] === 0 || kind[e] === KIND_NIGHT)) runs[u] = runs[v] = 1;
    }
  }
  const used = new Uint8Array(nArea);
  for (let u = 0; u < g.nNode; u++) {
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = target[e];
      if (u < nArea && v >= nArea && runs[v]) used[u] = 1; // instappen
      else if (u >= nArea && v < nArea && runs[u]) used[v] = 1; // uitstappen
    }
  }
  return used;
}

export async function loadGraph(base: string): Promise<Graph> {
  const [meta, buf] = await Promise.all([
    fetch(base + "meta.json").then((r) => r.json()),
    fetch(base + "graph.bin").then((r) => r.arrayBuffer()),
  ]);
  const L = meta.layout as Record<string, [number, number]>;
  const cost = new Uint16Array(buf, ...L.cost);
  const kind = new Uint8Array(buf, ...L.kind);
  // de instapkanten liggen voor elke dag op dezelfde plek
  const boardRow = new Int32Array(kind.length).fill(-1);
  let nBoard = 0;
  for (let e = 0; e < kind.length; e++) if (kind[e] === KIND_BOARD) boardRow[e] = nBoard++;
  // oudere meta.json zonder days: alleen de werkdag
  const days: DayInfo[] = meta.days ?? [{ key: "wd", date: meta.date, file: null, hours: meta.hours?.file ?? null }];
  return {
    date: meta.date,
    nArea: meta.nArea,
    nNode: meta.nNode,
    areaLat: new Float32Array(buf, ...L.areaLat),
    areaLon: new Float32Array(buf, ...L.areaLon),
    offsets: new Uint32Array(buf, ...L.offsets),
    target: new Uint32Array(buf, ...L.target),
    lineRoute: new Uint16Array(buf, ...L.lineRoute),
    cost,
    kind,
    areaNames: meta.areaNames,
    routes: meta.routes,
    hourBins: meta.hours?.bins ?? 24,
    hours: null,
    boardRow,
    nBoard,
    days,
    day: "wd",
    dayData: new Map([["wd", { cost, kind, hours: null, used: null }]]),
    areaUsed: new Uint8Array(0),
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

/** begintijden (s) per halteplek: hemelsbreed × DETOUR fietsen (of lopen) vanaf het vertrekpunt, binnen de grens */
export function straightAccess(g: Graph, lat: number, lon: number, p: Params): Float64Array {
  const init = new Float64Array(g.nArea).fill(Infinity);
  const { startV: v, startMax: accessMax } = legs(p);
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

  const used = g.areaUsed;
  for (let a = 0; a < g.nArea; a++) {
    if (init[a] < tMax && used[a]) {
      dist[a] = init[a];
      pred[a] = -1;
      heap.push(dist[a], a);
    }
  }

  const { offsets, target, cost, kind } = g;
  // uurmodel: de wachttijd hangt af van de kloktijd bij aankomst op de halte (vertrektijd + label)
  const hours = p.departMin !== null ? g.hours : null;
  const boardRow = g.boardRow;
  const t0 = (p.departMin ?? 0) * 60;
  const bins = g.hourBins;
  while (heap.size > 0) {
    const u = heap.pop();
    const du = heap.topKey;
    if (du > dist[u]) continue;
    if (du > tMax) break;
    const bin = Math.floor(((t0 + du) / 86400) * bins) % bins;
    for (let e = offsets[u], end = offsets[u + 1]; e < end; e++) {
      const k = kind[e];
      let w: number;
      if (k === KIND_BOARD) {
        if (hours) {
          const m = hours[boardRow[e] * bins + bin];
          if (m === NO_SERVICE) continue;
          w = m * 60;
        } else {
          if (cost[e] === CLOSED) continue; // rijdt niet overdag
          w = Math.min(p.waitFactor * cost[e], waitCap);
        }
      } else if (k === KIND_OFF || (k === KIND_NIGHT && !hours)) continue;
      else w = cost[e];
      const nd = du + w;
      const t = target[e];
      if (t < g.nArea && !used[t]) continue; // geen lijn op deze dag
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
  // dep/arr: kloktijden (s na middernacht), alleen met echte vertrektijden (csaPath)
  | { kind: "ride"; route: Route; from: string; to: string; wait: number; minutes: number; dep?: number; arr?: number };

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
