// Diagram: oppervlak dat binnen 1 uur bereikbaar is, per half uur.
// Rekent op de achtergrond, één vertrektijd tegelijk, als de worker niets anders te doen heeft.

import { STEP_MIN, params, points, state } from "./state";
import { $ } from "./ui";
import type { Request, Response } from "./worker";

const PROFILE_MIN = 60;
const profile = new Float64Array(1440 / STEP_MIN).fill(NaN);
let profileGen = 0;
let profileNext = 0;
let profileBusy = false;
let profileKey = "";

let deps: {
  send: (m: Request) => void;
  idle: () => boolean; // de kaart en het afspelen gaan voor
  pick: (min: number) => void; // klikken of slepen in het diagram kiest de vertrektijd
};
export function initChart(d: typeof deps) {
  deps = d;
}

/** na elke wijziging: opnieuw beginnen als het vertrekpunt of het fietsen anders is */
export function checkProfile() {
  const key = JSON.stringify([points(), params.day, params.bikeKmh, params.bikeMaxKm, params.directMaxKm,
    params.bikeStart, params.bikeEnd, params.realBike && state.bikeLoaded]);
  if (key !== profileKey) {
    profileKey = key;
    profileGen++;
    profile.fill(NaN);
    profileNext = 0;
    profileBusy = false;
  }
  renderChart();
  pumpProfile();
}
export function pumpProfile() {
  if (params.departMin === null || profileBusy || profileNext >= profile.length) return;
  if (!deps.idle()) return;
  profileBusy = true;
  deps.send({ type: "profile", gen: profileGen, departMin: profileNext++ * STEP_MIN, ...points(),
    params: { ...params, tMaxMin: PROFILE_MIN } });
}
export function onProfile(m: Extract<Response, { type: "profile" }>) {
  profileBusy = false;
  if (m.gen === profileGen) {
    profile[m.departMin / STEP_MIN] = m.km2;
    renderChart();
  }
  pumpProfile();
}

// één keer opbouwen; daarna alleen bijwerken (anders breekt slepen in het diagram af)
const CHART_W = 480, CHART_H = 60;
const chartEl = $("chart");
chartEl.innerHTML =
  `<div class="chart-head"><span>Binnen 1 uur bereikbaar</span><b></b></div>` +
  `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" aria-hidden="true">` +
  `<path class="chart-area"/><path class="chart-line"/><line class="chart-now" y1="0" y2="${CHART_H}"/></svg>` +
  `<div class="chart-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>24 u</span></div>` +
  `<div class="chart-note"></div>`;
const chartSvg = chartEl.querySelector("svg")!;
const [chartArea, chartLine] = chartSvg.querySelectorAll("path");
const chartNow = chartSvg.querySelector("line")!;

export function renderChart() {
  chartEl.hidden = params.departMin === null;
  if (chartEl.hidden) return;
  chartEl.querySelector("span")!.textContent = state.source === "ic" ? "Binnen 1 uur van een IC-station"
    : points().b ? "Voor allebei binnen 1 uur" : "Binnen 1 uur bereikbaar";
  const n = profile.length;
  let max = 1;
  for (const v of profile) if (v > max) max = v;
  const x = (i: number) => (((i + 0.5) / n) * CHART_W).toFixed(1);
  const y = (v: number) => (CHART_H - (v / max) * (CHART_H - 4)).toFixed(1);
  let line = "";
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(profile[i])) continue;
    line += `${line ? "L" : "M"}${x(i)},${y(profile[i])}`;
    if (first < 0) first = i;
    last = i;
  }
  chartLine.setAttribute("d", line);
  chartArea.setAttribute("d", line ? `${line}L${x(last)},${CHART_H}L${x(first)},${CHART_H}Z` : "");
  const mx = (((params.departMin! + STEP_MIN / 2) / 1440) * CHART_W).toFixed(1);
  chartNow.setAttribute("x1", mx);
  chartNow.setAttribute("x2", mx);
  const cur = profile[params.departMin! / STEP_MIN];
  chartEl.querySelector("b")!.textContent = Number.isFinite(cur) ? `${Math.round(cur).toLocaleString("nl")} km²` : "…";
  const done = profileNext - (profileBusy ? 1 : 0); // op volgorde gevraagd; een mislukte telt ook mee
  chartEl.querySelector(".chart-note")!.textContent = done < n ? `berekenen… ${done}/${n}` : "";
}

function pickFromChart(e: PointerEvent) {
  const r = chartSvg.getBoundingClientRect();
  const i = Math.min(profile.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * profile.length)));
  if (params.departMin === i * STEP_MIN) return;
  deps.pick(i * STEP_MIN);
}
chartSvg.addEventListener("pointerdown", (e) => {
  chartSvg.setPointerCapture(e.pointerId);
  pickFromChart(e);
});
chartSvg.addEventListener("pointermove", (e) => e.buttons && pickFromChart(e));
