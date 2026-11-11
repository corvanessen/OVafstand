// Vaste controle van de rekenkern en de pure UI-functies, in Node (zonder browser).
//   cd web && npm run check
// Faalt (exit 1) als een waarde afwijkt van de validatie in CLAUDE.md. Na een data-update kunnen
// de verwachte waarden verschuiven: dan eerst nagaan waarom, en ze hier bijwerken.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBikeGrid, originAccess, rasterizeBike, type BikeGrid } from "../src/bikegrid";
import { csaPath, csaSearch, footpaths, loadTimetable } from "../src/csa";
import { diffText, explainHtml, hoverHtml, type ExplainCtx } from "../src/explain";
import { clockSec, fmtMin, footNote, inRange } from "../src/format";
import { applyDay, legs, loadDay, loadGraph, search, straightAccess, type Params } from "../src/router";
import { DEFAULTS } from "../src/state";

const WEB = resolve(import.meta.dirname ?? ".", "../web/public/data") + "/";
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const UTRECHT = { lat: 52.0894, lon: 5.11 };

let failed = 0;
function expect(what: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FOUT"} ${what}: ${got}${ok ? "" : ` (verwacht ${want})`}`);
}

/** hetzelfde raster met omgekeerde knoopnummers (alleen voor de test hierboven) */
function renumber(bg: BikeGrid): BikeGrid {
  const N = bg.nNode;
  const inv = (n: number) => (n < 0 ? n : N - 1 - n);
  const first = new Uint32Array(N + 1);
  const edge = new Uint8Array(bg.edge.length);
  for (let u = 0, k = 0; u < N; u++) {
    const o = N - 1 - u;
    edge.set(bg.edge.subarray(bg.first[o], bg.first[o + 1]), k);
    k += bg.first[o + 1] - bg.first[o];
    first[u + 1] = k;
  }
  return { ...bg, nodeOfCell: bg.nodeOfCell.map(inv), cellOfNode: bg.cellOfNode.slice().reverse(),
    snapM: bg.snapM.slice().reverse(), first, edge, seedNode: bg.seedNode.map(inv) };
}

async function main() {
  const g = await loadGraph(WEB);
  await loadDay(WEB, g, "wd", true);
  applyDay(g, "wd");
  const idx = (n: string) => g.areaNames.indexOf(n);
  const min = (d: Float64Array, n: string) => Math.round(d[idx(n)] / 60);

  // model A (alleen rijtijd), vanaf het punt bij Utrecht C, fietsen hemelsbreed: zoals pipeline/heatmap.py
  const a = { ...DEFAULTS, waitFactor: 0, realBike: false, tMaxMin: 240 };
  const dA = search(g, straightAccess(g, UTRECHT.lat, UTRECHT.lon, a), a).dist;
  expect("model A Utrecht C → Amsterdam Centraal", min(dA, "Amsterdam Centraal"), 27);
  expect("model A Utrecht C → Rotterdam Centraal", min(dA, "Rotterdam Centraal"), 37);
  // de verwachte getallen horen bij de dagen in pipeline/days.py (feed van 11 nov 2026: Groningen 112, was 111)
  expect("model A Utrecht C → Groningen", min(dA, "Groningen"), 112);

  // lopen: tempo en grens komen uit de instellingen (standaard 4 km/u, tot 2 km)
  const kmh = (v: number) => Math.round(v * 3.6 * 1000) / 1000;
  expect("lopen bij vertrek: standaardtempo", kmh(legs({ ...DEFAULTS, bikeStart: false }).startV), 4);
  expect("lopen bij vertrek: standaardgrens", legs({ ...DEFAULTS, bikeStart: false }).startMax, 2000);
  expect("lopen bij aankomst volgt walkKmh", kmh(legs({ ...DEFAULTS, walkKmh: 5.5 }).endV), 5.5);
  expect("lopen bij aankomst volgt walkMaxKm", legs({ ...DEFAULTS, walkMaxKm: 3.5 }).endMax, 3500);

  // voetregel: welk stuk fietsen of lopen is, en waarover; voetpaden alleen als er gelopen wordt over het looptraster
  expect("voetregel standaard, met looptraster", footNote(true, false, "walk"),
    "fiets bij vertrek, lopen bij aankomst · over de weg en voetpaden (OpenStreetMap)");
  expect("voetregel standaard, zonder looptraster", footNote(true, false, "road"),
    "fiets bij vertrek, lopen bij aankomst · over de weg (OpenStreetMap)");
  expect("voetregel fiets heen en terug: geen voetpaden", footNote(true, true, "walk"), "fiets heen en terug · over de weg (OpenStreetMap)");
  expect("voetregel hemelsbreed", footNote(false, false, "straight"), "lopen van en naar de halte · afstand hemelsbreed × 1,3");

  // deellink: een getal telt alleen binnen het bereik en op de stap van de schuif (allowlist, hash.ts)
  const walkSlider = [0.5, 8, 0.5] as const; // min, max, stap van "Lopen, max"
  expect("deellink: l=3 geldig", inRange(3, ...walkSlider), true);
  expect("deellink: l=99 buiten bereik", inRange(99, ...walkSlider), false);
  expect("deellink: l=-1 buiten bereik", inRange(-1, ...walkSlider), false);
  expect("deellink: l=1.3 niet op de stap", inRange(1.3, ...walkSlider), false);
  expect("deellink: lt=abc geen getal", inRange(Number("abc"), 3, 6, 0.5), false);

  // de standaardkaart met het fietsraster, en met fiets bij aankomst (de statusregel in de browser)
  const bike = await loadBikeGrid(WEB, g);
  expect("fietsraster geladen", bike !== null, true);
  const reached = (p: Params) => {
    const d = search(g, originAccess({ bike: bike!, walk: null }, g, UTRECHT.lat, UTRECHT.lon, p), p).dist;
    let n = 0;
    for (let i = 0; i < g.nArea; i++) if (d[i] < p.tMaxMin * 60) n++;
    return n;
  };
  expect("haltes binnen 3 uur, fiets bij aankomst", reached({ ...DEFAULTS, bikeEnd: true }), 27402); // feed 10 okt: 28960, met veel meer De Lijn

  // twee rasters (fiets en lopen) hebben elk hun eigen knoopnummers. Een "looptraster" dat precies het
  // fietsraster is, maar met omgekeerde nummers, moet dus cel voor cel dezelfde kaart geven als geen looptraster.
  const cellTimes = (walk: BikeGrid | null, p: Params) => {
    const grids = { bike: bike!, walk };
    const s = search(g, originAccess(grids, g, UTRECHT.lat, UTRECHT.lon, p), p);
    return rasterizeBike(grids, g, s, UTRECHT, p).time.slice();
  };
  const flipped = renumber(bike!);
  for (const [what, p] of [["fiets bij vertrek, lopen bij aankomst", DEFAULTS], ["lopen bij vertrek", { ...DEFAULTS, bikeStart: false }],
    ["fiets aan beide kanten", { ...DEFAULTS, bikeEnd: true }]] as [string, Params][]) {
    const a = cellTimes(null, p), b = cellTimes(flipped, p);
    let nDiff = 0;
    for (let c = 0; c < a.length; c++) if (a[c] !== b[c]) nDiff++;
    expect(`twee rasters, ${what}: cellen anders`, nDiff, 0);
  }

  // echte vertrektijden: een route naar Groningen met kloktijden
  const p = { ...DEFAULTS, realBike: false, departMin: 480, timetable: true };
  const tt = await loadTimetable(WEB, g.days.find((d) => d.key === "wd")!.conn!);
  expect("dienstregeling geladen", tt !== null, true);
  const { s, csa } = csaSearch(g, tt!, footpaths(g), straightAccess(g, UTRECHT.lat, UTRECHT.lon, p), p);
  const { segments } = csaPath(g, tt!, footpaths(g), csa, idx("Groningen"));
  const rides = segments.filter((x) => x.kind === "ride");
  expect("CSA route naar Groningen heeft ritten met kloktijden", rides.length > 0 && rides.every((x) => x.dep !== undefined), true);
  expect("CSA Utrecht C → Groningen binnen 2,5 uur", min(s.dist, "Groningen") < 150, true);

  // de reisinfo als HTML (explain.ts): opmaak, escapen, vergelijken
  const ctx: ExplainCtx = { tMaxMin: 180, bikeStart: true, bikeEnd: false, ic: false, diff: false };
  expect("fmtMin 45", fmtMin(45), "45 min");
  expect("fmtMin 65", fmtMin(65), "1 u 05");
  expect("clockSec na middernacht", clockSec(25 * 3600 + 30 * 60), "01:30");
  expect("diffText A sneller", diffText([30, 50]), "20 min sneller vanaf A");
  expect("diffText alleen B", diffText([null, 50]), "Alleen vanaf B");
  const one = { type: "explain" as const, id: 1, parts: [{ minutes: 40, lastBike: 5, segments: [
    { kind: "bike" as const, minutes: 6, to: "Utrecht Centraal" },
    { kind: "ride" as const, route: ["Intercity", 2, "IFF:NS", "<x>"] as [string, number, string, string],
      from: "Utrecht Centraal", to: "A&B", wait: 3, minutes: 26 },
  ] }] };
  const html = explainHtml(one, ctx);
  expect("reisinfo: fiets, trein, loop naar bestemming",
    ["Fiets 6 min naar Utrecht Centraal", "Intercity", "+3 wacht", "A&#38;B", "Loop 5 min naar bestemming"].every((t) => html.includes(t)), true);
  expect("reisinfo: lange naam ge-escaped", html.includes("title=\"&#60;x&#62;\""), true);
  expect("label onder de muis", hoverHtml(one, ctx), `<b>40 min</b><div class="tt-sub">klik voor de route</div>`);
  const two = { ...one, parts: [one.parts[0], { minutes: null, lastBike: 0, segments: [] }] };
  expect("vergelijken: niet voor allebei", explainHtml(two, ctx).startsWith(`<div class="tt-total">Niet voor allebei</div>`), true);

  console.log(failed ? `\n${failed} fout(en)` : "\nalles klopt");
  process.exitCode = failed ? 1 : 0;
}

main();
