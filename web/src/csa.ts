// Fase 4: de dienstregeling (Connection Scan Algorithm) met echte vertrektijden en 0 min overstap.
// conn_<datum>.bin.gz bevat per rit de haltes en tijden (zie pipeline/export_web.py); de browser
// maakt daar een lijst connections van, gesorteerd op vertrektijd.

import { fetchGz, type Graph, type Params, type Search, type Segment } from "./router";

const NO_BOARD = 1;
const NO_ALIGHT = 2;
export const DAY_S = 86400;

export interface Timetable {
  n: number; // aantal connections
  dep: Int32Array; // s na middernacht, oplopend
  arr: Int32Array;
  from: Uint16Array; // halteplek
  to: Uint16Array;
  trip: Int32Array;
  flags: Uint8Array;
  tripRoute: Uint16Array; // index in g.routes
}

export interface ConnInfo {
  file: string;
  nTrip: number;
  nStop: number;
}

/** Laadt de dienstregeling van één dag. Ritten na middernacht (≥ 24:00) staan er ook vóór 00:00 in,
 *  als de nacht van de vorige dag (van hetzelfde soort dag). null als het bestand ontbreekt. */
export async function loadTimetable(base: string, info: ConnInfo): Promise<Timetable | null> {
  const buf = await fetchGz(base + info.file);
  const { nTrip: nT, nStop: nS } = info;
  if (!buf || buf.byteLength !== 8 * nT + 7 * nS) return null;
  const tripStart = new Int32Array(buf, 0, nT);
  const tripLen = new Uint16Array(buf, 4 * nT, nT);
  const tripRoute = new Uint16Array(buf, 6 * nT, nT).slice();
  const stopArea = new Uint16Array(buf, 8 * nT, nS);
  const stopArr = new Uint16Array(buf, 8 * nT + 2 * nS, nS);
  const stopDwell = new Uint16Array(buf, 8 * nT + 4 * nS, nS);
  const stopFlags = new Uint8Array(buf, 8 * nT + 6 * nS, nS);

  // twee keer door de ritten: eerst tellen per vertrekseconde, dan op hun plek zetten (counting sort)
  let maxDep = 0;
  for (let t = 0, s = 0; t < nT; s += tripLen[t++]) maxDep = Math.max(maxDep, tripStart[t] + stopArr[s + tripLen[t] - 1]);
  const count = new Int32Array(maxDep + 2);
  const each = (fn: (t: number, i: number, dep: number) => void) => {
    for (let t = 0, s = 0; t < nT; s += tripLen[t++]) {
      const end = s + tripLen[t] - 1;
      for (let i = s; i < end; i++) {
        if (stopArea[i] === stopArea[i + 1]) continue; // binnen één halteplek: de tijd loopt door via de volgende hop
        const dep = tripStart[t] + stopArr[i] + stopDwell[i];
        fn(t, i, dep);
        if (dep >= DAY_S) fn(t, i, dep - DAY_S); // de nacht van de vorige dag
      }
    }
  };
  each((_t, _i, dep) => count[dep + 1]++);
  for (let k = 1; k < count.length; k++) count[k] += count[k - 1];
  const n = count[count.length - 1];
  const tt: Timetable = {
    n,
    dep: new Int32Array(n),
    arr: new Int32Array(n),
    from: new Uint16Array(n),
    to: new Uint16Array(n),
    trip: new Int32Array(n),
    flags: new Uint8Array(n),
    tripRoute,
  };
  each((t, i, dep) => {
    const c = count[dep]++;
    tt.dep[c] = dep;
    tt.arr[c] = dep - stopArr[i] - stopDwell[i] + stopArr[i + 1];
    tt.from[c] = stopArea[i];
    tt.to[c] = stopArea[i + 1];
    tt.trip[c] = t;
    tt.flags[c] = (stopFlags[i] & NO_BOARD) | (stopFlags[i + 1] & NO_ALIGHT);
  });
  return tt;
}

/** loopkanten tussen halteplekken uit de graaf, als CSR (voor elke dag hetzelfde) */
export interface Footpaths {
  off: Uint32Array;
  to: Uint32Array;
  sec: Uint16Array;
}
export function footpaths(g: Graph): Footpaths {
  const off = new Uint32Array(g.nArea + 1);
  for (let a = 0; a < g.nArea; a++) {
    let k = 0;
    for (let e = g.offsets[a]; e < g.offsets[a + 1]; e++) if (g.target[e] < g.nArea) k++;
    off[a + 1] = off[a] + k;
  }
  const to = new Uint32Array(off[g.nArea]);
  const sec = new Uint16Array(off[g.nArea]);
  for (let a = 0, k = 0; a < g.nArea; a++) {
    for (let e = g.offsets[a]; e < g.offsets[a + 1]; e++) {
      if (g.target[e] < g.nArea) {
        to[k] = g.target[e];
        sec[k++] = g.cost[e];
      }
    }
  }
  return { off, to, sec };
}

/** het resultaat van één scan, met de gegevens om de route terug te vinden */
interface Scan {
  arrival: Float64Array; // kloktijd (s) per halteplek
  inConn: Int32Array; // connection waarmee je aankwam, of -1
  inWalk: Int32Array; // halteplek waar je vandaan liep, of -1
  board: Int32Array; // per rit de connection waar je instapte, of -1
}

function newScan(g: Graph, tt: Timetable): Scan {
  return {
    arrival: new Float64Array(g.nArea),
    inConn: new Int32Array(g.nArea),
    inWalk: new Int32Array(g.nArea),
    board: new Int32Array(tt.tripRoute.length),
  };
}

/** Earliest-arrival CSA vanaf kloktijd t0, met begintijden init[a] (s na t0) en zoekgrens tMax (s). */
function scan(g: Graph, tt: Timetable, fp: Footpaths, init: Float64Array, t0: number, tMax: number, sc: Scan) {
  const { arrival, inConn, inWalk, board } = sc;
  const used = g.areaUsed;
  arrival.fill(Infinity);
  inConn.fill(-1);
  inWalk.fill(-1);
  board.fill(-1);
  const stack: number[] = [];
  // lopen naar de buren, en van daar verder (zoals de loopkanten in de graaf)
  const walk = (a0: number) => {
    stack.push(a0);
    while (stack.length) {
      const a = stack.pop()!;
      for (let e = fp.off[a]; e < fp.off[a + 1]; e++) {
        const b = fp.to[e];
        const t = arrival[a] + fp.sec[e];
        if (t < arrival[b] && used[b]) {
          arrival[b] = t;
          inConn[b] = -1;
          inWalk[b] = a;
          stack.push(b);
        }
      }
    }
  };
  for (let a = 0; a < g.nArea; a++) {
    if (init[a] < tMax && used[a] && t0 + init[a] < arrival[a]) {
      arrival[a] = t0 + init[a];
      inWalk[a] = -1;
      walk(a);
    }
  }
  const tEnd = t0 + tMax;
  const { dep, arr, from, to, trip, flags } = tt;
  // de eerste connection met dep >= t0
  let lo = 0, hi = tt.n;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (dep[m] < t0) lo = m + 1;
    else hi = m;
  }
  for (let c = lo; c < tt.n; c++) {
    const d = dep[c];
    if (d > tEnd) break;
    const t = trip[c];
    if (board[t] < 0) {
      if (arrival[from[c]] > d || flags[c] & NO_BOARD) continue;
      board[t] = c;
    }
    const v = to[c];
    if (arr[c] < arrival[v] && !(flags[c] & NO_ALIGHT) && arr[c] <= tEnd) {
      arrival[v] = arr[c];
      inConn[v] = c;
      inWalk[v] = -1;
      walk(v);
    }
  }
}

export const CSA_RUNS = 12;
const CSA_STEP_S = 300;
const CSA_FROM_S = -15 * 60; // vertrekken van 15 min vóór tot 40 min na het begin van het half uur

/** wat nodig is om de route naar een halteplek opnieuw uit te rekenen */
export interface CsaRun {
  init: Float64Array;
  t0s: number[];
  pick: Uint8Array; // per halteplek de scan met de mediaan
  tMax: number;
}

/** Reistijd per halteplek: de mediaan over CSA_RUNS vertrekken rond p.departMin (elke 5 min,
 *  hetzelfde uur als het uurmodel). Zo springt de kaart niet als een bus net weg is. */
export function csaSearch(g: Graph, tt: Timetable, fp: Footpaths, init: Float64Array, p: Params): { s: Search; csa: CsaRun } {
  const tMax = p.tMaxMin * 60;
  // vóór middernacht: de avond van dezelfde dag (de dienstregeling kent geen vorige dag)
  const t0s = Array.from({ length: CSA_RUNS }, (_, k) => (p.departMin! * 60 + CSA_FROM_S + k * CSA_STEP_S + DAY_S) % DAY_S);
  const runs = t0s.map(() => new Float64Array(g.nArea));
  const sc = newScan(g, tt);
  t0s.forEach((t0, k) => {
    scan(g, tt, fp, init, t0, tMax, sc);
    const r = runs[k];
    for (let a = 0; a < g.nArea; a++) r[a] = sc.arrival[a] - t0;
  });
  // per halteplek de onderste mediaan (de 6e van 12), en welke scan die gaf
  const dist = new Float64Array(g.nNode).fill(Infinity);
  const pick = new Uint8Array(g.nArea);
  const v = new Float64Array(CSA_RUNS);
  const idx = new Uint8Array(CSA_RUNS);
  const mid = (CSA_RUNS - 1) >> 1;
  for (let a = 0; a < g.nArea; a++) {
    for (let k = 0; k < CSA_RUNS; k++) {
      // invoegsorteren met de index erbij
      const x = runs[k][a];
      let j = k;
      while (j > 0 && v[j - 1] > x) {
        v[j] = v[j - 1];
        idx[j] = idx[j - 1];
        j--;
      }
      v[j] = x;
      idx[j] = k;
    }
    dist[a] = v[mid] <= tMax ? v[mid] : Infinity;
    pick[a] = idx[mid];
  }
  return { s: { dist, pred: new Int32Array(0) }, csa: { init, t0s, pick, tMax } };
}

/** de route naar halteplek area, uit de scan die voor die halteplek de mediaan gaf */
export function csaPath(g: Graph, tt: Timetable, fp: Footpaths, run: CsaRun, area: number): Segment[] {
  const t0 = run.t0s[run.pick[area]];
  const sc = newScan(g, tt);
  scan(g, tt, fp, run.init, t0, run.tMax, sc);
  const { arrival, inConn, inWalk, board } = sc;
  const name = (a: number) => g.areaNames[a];
  const min = (s: number) => s / 60;
  const segs: Segment[] = [];
  let a = area;
  for (let guard = 0; guard < 1000 && Number.isFinite(arrival[a]); guard++) {
    const c = inConn[a];
    if (c >= 0) {
      const b = board[tt.trip[c]];
      const u = tt.from[b];
      segs.push({
        kind: "ride",
        route: g.routes[tt.tripRoute[tt.trip[c]]],
        from: name(u),
        to: name(a),
        wait: min(tt.dep[b] - arrival[u]),
        minutes: min(tt.arr[c] - tt.dep[b]),
      });
      a = u;
    } else if (inWalk[a] >= 0) {
      const b = inWalk[a];
      segs.push({ kind: "walk", minutes: min(arrival[a] - arrival[b]), from: name(b), to: name(a) });
      a = b;
    } else {
      segs.push({ kind: "bike", minutes: min(arrival[a] - t0), to: name(a) });
      break;
    }
  }
  return segs.reverse();
}
