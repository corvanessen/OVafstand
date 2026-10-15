// Verkenning fase 4: hoe snel is een dienstregelingsrouter (CSA) in JS, en hoe verhoudt die zich tot A+?
// Alleen een meting, geen onderdeel van de website.
//
//   python pipeline/export_connections.py 20261110      (maakt data/connections_20261110.bin)
//   cd web && npx rolldown bench/csa_bench.ts --platform node -o ../data/csa_bench.mjs && node ../data/csa_bench.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyDay, loadDay, loadGraph, search, straightAccess, type Graph, type Params } from "../src/router";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const DATE = process.argv[2] ?? "20261110";
const WEB = resolve(ROOT, "web/public/data") + "/";

// loadGraph en fetchGz gebruiken fetch; hier lezen we van schijf
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const NO_BOARD = 1, NO_ALIGHT = 2;

interface Conns {
  n: number;
  dep: Int32Array;
  arr: Int32Array;
  u: Int32Array;
  v: Int32Array;
  trip: Int32Array;
  flags: Uint8Array;
  nTrip: number;
}

function loadConns(): Conns {
  const info = JSON.parse(readFileSync(resolve(ROOT, `data/connections_${DATE}.json`), "utf8"));
  const b = readFileSync(resolve(ROOT, `data/connections_${DATE}.bin`));
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const n = info.n;
  const col = (k: number) => new Int32Array(buf, k * n * 4, n);
  return { n, dep: col(0), arr: col(1), u: col(2), v: col(3), trip: col(4), flags: new Uint8Array(buf, 5 * n * 4, n), nTrip: info.nTrip };
}

/** loopkanten tussen halteplekken uit de graaf (kind 0, van halteplek naar halteplek), als CSR */
function footpaths(g: Graph) {
  const off = new Uint32Array(g.nArea + 1);
  const to: number[] = [], w: number[] = [];
  for (let a = 0; a < g.nArea; a++) {
    for (let e = g.offsets[a]; e < g.offsets[a + 1]; e++) {
      if (g.target[e] < g.nArea) { to.push(g.target[e]); w.push(g.cost[e]); }
    }
    off[a + 1] = to.length;
  }
  return { off, to: Int32Array.from(to), w: Int32Array.from(w) };
}

/** Earliest-arrival CSA, 0 min overstap. init[a]: tijd (s) vanaf het vertrek tot halteplek a.
 *  Geeft per halteplek de reistijd (s) vanaf t0, Infinity als niet bereikt binnen tMax. */
function csa(c: Conns, fp: ReturnType<typeof footpaths>, init: Float64Array, t0: number, tMax: number,
             arrival: Float64Array, inTrip: Uint8Array): Float64Array {
  const nArea = init.length;
  arrival.fill(Infinity);
  inTrip.fill(0);
  const reach = (a: number, t: number) => {
    if (t >= arrival[a]) return;
    arrival[a] = t;
    for (let e = fp.off[a]; e < fp.off[a + 1]; e++) {
      const b = fp.to[e], tb = t + fp.w[e];
      if (tb < arrival[b]) arrival[b] = tb; // één stap lopen, zoals in de graaf
    }
  };
  for (let a = 0; a < nArea; a++) if (init[a] < tMax) reach(a, t0 + init[a]);
  // eerste connection met dep >= t0
  let lo = 0, hi = c.n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c.dep[m] < t0) lo = m + 1; else hi = m; }
  const tEnd = t0 + tMax;
  const { dep, arr, u, v, trip, flags } = c;
  for (let i = lo; i < c.n; i++) {
    const d = dep[i];
    if (d > tEnd) break;
    const t = trip[i];
    if (!inTrip[t]) {
      if (arrival[u[i]] > d || flags[i] & NO_BOARD) continue;
      inTrip[t] = 1;
    }
    if (!(flags[i] & NO_ALIGHT) && arr[i] <= tEnd) reach(v[i], arr[i]);
  }
  const out = new Float64Array(nArea);
  for (let a = 0; a < nArea; a++) out[a] = arrival[a] - t0;
  return out;
}

function median(xs: number[]) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

const P: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: false,
  departMin: null, bikeStart: true, bikeEnd: false, day: "wd", timetable: false,
};

const PLACES: [string, number, number][] = [
  ["Utrecht C", 52.0894, 5.11],
  ["Ruinen", 52.7625, 6.3536],
  ["Maastricht", 50.8497, 5.7053],
];
const TARGETS = ["Amsterdam Centraal", "Rotterdam Centraal", "Groningen", "Maastricht", "Zwolle"]; // precies deze namen

async function main() {
  let t = performance.now();
  const g = await loadGraph(WEB);
  await loadDay(WEB, g, "wd", true);
  applyDay(g, "wd");
  const c = loadConns();
  const fp = footpaths(g);
  console.log(`laden: ${(performance.now() - t).toFixed(0)} ms, ${c.n.toLocaleString("nl")} connections, ${fp.to.length.toLocaleString("nl")} loopkanten`);
  const arrival = new Float64Array(g.nArea);
  const inTrip = new Uint8Array(c.nTrip);
  const idx = (name: string) => g.areaNames.indexOf(name);
  const tMax = P.tMaxMin * 60;

  // controle zonder fiets: vanaf de halteplek Utrecht Centraal, elk kwartier tussen 08:00 en 09:00
  const ut = new Float64Array(g.nArea).fill(Infinity);
  ut[idx("Utrecht Centraal")] = 0;
  for (let k = 0; k < 4; k++) {
    const r = csa(c, fp, ut, (8 * 60 + 15 * k) * 60, tMax, arrival, inTrip);
    console.log(`Utrecht Centraal 08:${String(15 * k).padStart(2, "0")} (halte, zonder fiets): ` +
      TARGETS.map((n) => `${n.split(" ")[0]} ${Math.round(r[idx(n)] / 60)}`).join(", "));
  }

  for (const [name, lat, lon] of PLACES) {
    // startcellen hier hemelsbreed: het gaat om het OV-deel
    const init = straightAccess(g, lat, lon, P);
    console.log(`\n== ${name} ==`);
    // CSA, één vertrekmoment
    for (const [h, m] of [[8, 0], [8, 7], [13, 0], [22, 0]]) {
      const t0 = (h * 60 + m) * 60;
      csa(c, fp, init, t0, tMax, arrival, inTrip); // opwarmen
      t = performance.now();
      const R = 5;
      let r!: Float64Array;
      for (let k = 0; k < R; k++) r = csa(c, fp, init, t0, tMax, arrival, inTrip);
      const ms = (performance.now() - t) / R;
      const in60 = r.filter((x) => x <= 3600).length, in180 = r.filter((x) => x <= tMax).length;
      console.log(`CSA ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}: ${ms.toFixed(1)} ms, ` +
        `${in60} haltes binnen 1 uur, ${in180} binnen 3 uur | ` +
        TARGETS.map((n) => `${n.split(" ")[0]} ${Math.round(r[idx(n)] / 60)}`).join(", "));
    }
    // 12 vertrekmomenten (08:00–08:55), mediaan per halteplek
    t = performance.now();
    const runs: Float64Array[] = [];
    for (let k = 0; k < 12; k++) runs.push(csa(c, fp, init, (8 * 60 + 5 * k) * 60, tMax, arrival, inTrip).slice());
    const med = new Float64Array(g.nArea);
    const col: number[] = new Array(12);
    for (let a = 0; a < g.nArea; a++) {
      for (let k = 0; k < 12; k++) col[k] = runs[k][a];
      med[a] = median(col);
    }
    const msMed = performance.now() - t;
    console.log(`CSA mediaan 12× 08:00–08:55: ${msMed.toFixed(0)} ms, ${med.filter((x) => x <= 3600).length} haltes binnen 1 uur | ` +
      TARGETS.map((n) => `${n.split(" ")[0]} ${Math.round(med[idx(n)] / 60)}`).join(", "));
    // A+ ter vergelijking: model A, A+ (gemiddelde dag) en het uurmodel om 08:00
    for (const [label, p] of [
      ["A (rijtijd)", { ...P, waitFactor: 0 }],
      ["A+ (½ interval)", P],
      ["uurmodel 08:00", { ...P, departMin: 480 }],
    ] as [string, Params][]) {
      t = performance.now();
      const s = search(g, init, p);
      const ms = performance.now() - t;
      const d = s.dist.subarray(0, g.nArea);
      console.log(`${label.padEnd(16)}: ${ms.toFixed(1)} ms, ${d.filter((x) => x <= 3600).length} haltes binnen 1 uur | ` +
        TARGETS.map((n) => `${n.split(" ")[0]} ${Math.round(d[idx(n)] / 60)}`).join(", "));
    }
  }
}

main();
