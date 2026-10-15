// Fase 4: controle van csa.ts in Node (laden, rekentijd, reistijden, route).
//   cd web && npx rolldown bench/csa_check.ts --platform node -o ../data/csa_check.mjs && node ../data/csa_check.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { csaPath, csaSearch, footpaths, loadTimetable } from "../src/csa";
import { applyDay, loadDay, loadGraph, search, straightAccess, type Day, type Params } from "../src/router";

const WEB = resolve(import.meta.dirname ?? ".", "../web/public/data") + "/";
globalThis.fetch = (async (url: string) => {
  try {
    return new Response(readFileSync(url));
  } catch {
    return new Response(null, { status: 404 });
  }
}) as typeof fetch;

const P: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: false,
  departMin: 480, bikeStart: true, bikeEnd: false, day: "wd", timetable: true,
};
const TARGETS = ["Amsterdam Centraal", "Rotterdam Centraal", "Zwolle", "Groningen"];

async function main() {
  const g = await loadGraph(WEB);
  const fp = footpaths(g);
  const idx = (n: string) => g.areaNames.findIndex((x) => x === n);
  for (const day of ["wd", "zo"] as Day[]) {
    await loadDay(WEB, g, day, true);
    applyDay(g, day);
    const info = g.days.find((d) => d.key === day)!.conn!;
    let t = performance.now();
    const tt = (await loadTimetable(WEB, info))!;
    console.log(`\n== ${day}: ${tt.n.toLocaleString("nl")} connections, laden ${(performance.now() - t).toFixed(0)} ms`);
    const init = straightAccess(g, 52.0894, 5.11, P);
    for (const departMin of [480, 0, 1380]) {
      const p = { ...P, day, departMin };
      t = performance.now();
      const { s, csa } = csaSearch(g, tt, fp, init, p);
      const ms = performance.now() - t;
      const u = search(g, init, p).dist;
      const d = s.dist;
      const n60 = (x: Float64Array) => x.subarray(0, g.nArea).filter((v) => v <= 3600).length;
      console.log(`vertrek ${String(departMin / 60).padStart(2, "0")}:00  CSA ${ms.toFixed(0)} ms, binnen 1 uur ${n60(d)} (uurmodel ${n60(u)}) | ` +
        TARGETS.map((n) => `${n.split(" ")[0]} ${Math.round(d[idx(n)] / 60)} (${Math.round(u[idx(n)] / 60)})`).join(", "));
      if (departMin === 480) {
        const gr = idx("Groningen");
        const segs = csaPath(g, tt, fp, csa, gr);
        console.log("  route naar Groningen (vertrek", (csa.t0s[csa.pick[gr]] / 60 / 60).toFixed(2), "u):");
        for (const sg of segs) console.log("   ", JSON.stringify(sg.kind === "ride" ? { ...sg, route: sg.route[0] } : sg));
        const total = segs.reduce((t, sg) => t + sg.minutes + (sg.kind === "ride" ? sg.wait : 0), 0);
        console.log(`  som ${total.toFixed(1)} min, mediaan ${(d[gr] / 60).toFixed(1)} min`);
      }
    }
  }
}

main();
