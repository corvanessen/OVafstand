// Controle van bikegrid.ts: rekentijd, geheugen en uitkomst, vergeleken met een referentie.
// De eerste keer schrijft het de rastertijden naar data/bikegrid_ref.bin; daarna vergelijkt het cel voor cel.
// Na een nieuwe dataset (graph.bin, bike.bin.gz, walk.bin.gz) of een bedoelde wijziging van de uitkomst:
// opnieuw met --ref, in dezelfde commit, en de reden in de commit.
//   cd web && npx rolldown bench/bikegrid_check.ts --platform node -o ../data/bikegrid_check.mjs && node ../data/bikegrid_check.mjs [--ref]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBikeGrid, loadWalkGrid, originAccess, rasterizeBike } from "../src/bikegrid";
import { NX, NY } from "../src/grid";
import { applyDay, loadGraph, search, type Params } from "../src/router";
import { DEFAULTS } from "../src/state";

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

// De instellingen die de kaart bepalen staan hier vast, niet via DEFAULTS: een andere standaard in de app
// mag de referentie niet ongemerkt ongeldig maken (dan lijkt een gewijzigde instelling een fout in de Dijkstra).
// Alle velden van Params staan hier vast; ...DEFAULTS vult alleen velden aan die later bij Params komen.
const P: Params = {
  ...DEFAULTS, waitFactor: 0.5, waitCapMin: 30, tMaxMin: 180, realBike: true, departMin: null, day: "wd", timetable: false,
  bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, bikeStart: true, bikeEnd: false, walkKmh: 4, walkMaxKm: 2,
};
const POINTS: [string, number, number][] = [
  ["Utrecht C", 52.0894, 5.11], ["Venlo", 51.3645, 6.1712], ["Maastricht", 50.8497, 5.7056],
  ["Groningen", 53.2105, 6.5641], ["Vlissingen", 51.4426, 3.5966], ["Aken", 50.7676, 6.0911],
];
// lopen bij aankomst (2 km), en fiets bij aankomst (15 km): het zwaarste geval voor de tweede Dijkstra
const CASES: Params[] = [P, { ...P, bikeEnd: true, bikeMaxKm: 15 }];

async function main() {
  const g = await loadGraph(WEB);
  applyDay(g, "wd");
  let t = performance.now();
  const bg = { bike: (await loadBikeGrid(WEB, g))!, walk: await loadWalkGrid(WEB, g) };
  console.log(bg.walk ? "met looptraster" : "zonder looptraster (lopen over het fietsraster)");
  const msLoad = performance.now() - t;
  console.log(`laden ${msLoad.toFixed(0)} ms`);
  for (const [name, grid] of [["fietsraster", bg.bike], ["looptraster", bg.walk]] as const) {
    if (!grid) continue;
    const bytes = Object.values(grid).reduce((s, v) => s + (ArrayBuffer.isView(v) ? v.byteLength : 0), 0);
    console.log(`${name}: ${grid.nNode.toLocaleString("nl")} knopen, ${(bytes / 2 ** 20).toFixed(1)} MB`);
  }

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
