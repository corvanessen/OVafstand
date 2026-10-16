// Controle van bikegrid.ts: rekentijd, geheugen en uitkomst, vergeleken met een referentie.
// De eerste keer schrijft het de rastertijden naar data/bikegrid_ref.bin; daarna vergelijkt het cel voor cel.
//   cd web && npx rolldown bench/bikegrid_check.ts --platform node -o ../data/bikegrid_check.mjs && node ../data/bikegrid_check.mjs [--ref]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBikeGrid, originAccess, rasterizeBike } from "../src/bikegrid";
import { NX, NY } from "../src/grid";
import { applyDay, loadGraph, search, type Params } from "../src/router";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const WEB = ROOT + "/web/public/data/";
const REF = ROOT + "/data/bikegrid_ref.bin";
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const P: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true,
  departMin: null, bikeStart: true, bikeEnd: false, day: "wd", timetable: false,
};
const POINTS: [string, number, number][] = [
  ["Utrecht C", 52.0894, 5.11], ["Venlo", 51.3645, 6.1712], ["Maastricht", 50.8497, 5.7056],
  ["Groningen", 53.2105, 6.5641], ["Vlissingen", 51.4426, 3.5966], ["Aken", 50.7676, 6.0911],
];
// fiets bij aankomst uit en aan (15 km): het zwaarste geval voor de tweede Dijkstra
const CASES: Params[] = [P, { ...P, bikeEnd: true, bikeMaxKm: 15 }];

async function main() {
  const g = await loadGraph(WEB);
  applyDay(g, "wd");
  let t = performance.now();
  const bg = (await loadBikeGrid(WEB, g))!;
  const msLoad = performance.now() - t;
  const bytes = Object.values(bg).reduce((s, v) => s + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0);
  console.log(`fietsraster: ${bg.nNode.toLocaleString("nl")} knopen, ${(bytes / 2 ** 20).toFixed(1)} MB, laden ${msLoad.toFixed(0)} ms`);

  const writeRef = process.argv.includes("--ref") || !existsSync(REF);
  const N = NX * NY;
  const all = new Float32Array(POINTS.length * CASES.length * N);
  const ref = writeRef ? null : new Float32Array(readFileSync(REF).buffer.slice(0));
  let k = 0;
  for (const p of CASES) {
    console.log(`\n${p.bikeEnd ? "fiets bij aankomst 15 km" : "lopen bij aankomst"}: route + raster (ms, beste van 3)`);
    for (const [name, lat, lon] of POINTS) {
      let best = Infinity, time: Float32Array | null = null;
      for (let rep = 0; rep < 3; rep++) {
        t = performance.now();
        const init = originAccess(bg, g, lat, lon, p);
        const s = search(g, init, p);
        time = rasterizeBike(bg, g, s, { lat, lon }, p).time;
        best = Math.min(best, performance.now() - t);
      }
      all.set(time!, k * N);
      let diff = "";
      if (ref) {
        let nDiff = 0, maxD = 0;
        for (let c = 0; c < N; c++) {
          const a = time![c], b = ref[k * N + c];
          if (a === b) continue;
          nDiff++;
          if (Number.isFinite(a) && Number.isFinite(b)) maxD = Math.max(maxD, Math.abs(a - b));
          else maxD = Infinity;
        }
        diff = nDiff === 0 ? "  gelijk aan de referentie" : `  ${nDiff} cellen anders, max ${maxD.toFixed(4)} min`;
      }
      console.log(`  ${name.padEnd(11)} ${best.toFixed(0).padStart(5)} ms${diff}`);
      k++;
    }
  }
  if (writeRef) {
    writeFileSync(REF, new Uint8Array(all.buffer));
    console.log(`\nreferentie geschreven: ${REF}`);
  }
}

main();
