// Vaste controle van de rekenkern en de pure UI-functies, in Node (zonder browser).
//   cd web && npm run check
// Faalt (exit 1) als een waarde afwijkt van de validatie in CLAUDE.md. Na een data-update kunnen
// de verwachte waarden verschuiven: dan eerst nagaan waarom, en ze hier bijwerken.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBikeGrid, originAccess } from "../src/bikegrid";
import { csaPath, csaSearch, footpaths, loadTimetable } from "../src/csa";
import { diffText, explainHtml, hoverHtml, type ExplainCtx } from "../src/explain";
import { clockSec, fmtMin } from "../src/format";
import { applyDay, loadDay, loadGraph, search, straightAccess, type Params } from "../src/router";

const WEB = resolve(import.meta.dirname ?? ".", "../web/public/data") + "/";
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

// gelijk aan DEFAULTS in main.ts
const DEFAULTS: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true, departMin: null,
  bikeStart: true, bikeEnd: false, day: "wd", timetable: false,
};
const UTRECHT = { lat: 52.0894, lon: 5.11 };

let failed = 0;
function expect(what: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FOUT"} ${what}: ${got}${ok ? "" : ` (verwacht ${want})`}`);
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
  expect("model A Utrecht C → Groningen", min(dA, "Groningen"), 111);

  // de standaardkaart met het fietsraster, en met fiets bij aankomst (de statusregel in de browser)
  const bike = await loadBikeGrid(WEB, g);
  expect("fietsraster geladen", bike !== null, true);
  const reached = (p: Params) => {
    const d = search(g, originAccess(bike!, g, UTRECHT.lat, UTRECHT.lon, p), p).dist;
    let n = 0;
    for (let i = 0; i < g.nArea; i++) if (d[i] < p.tMaxMin * 60) n++;
    return n;
  };
  expect("haltes binnen 3 uur, fiets bij aankomst", reached({ ...DEFAULTS, bikeEnd: true }), 28960);

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
