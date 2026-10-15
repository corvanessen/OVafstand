// De instellingen in het paneel: wachttijd, fietsen, kleurschaal, dag en vertrektijd.
// Elke wijziging komt in params en roept changed() aan (main.ts: deellink, opnieuw rekenen).

import { renderChart } from "./chart";
import { clock, fmtDate } from "./format";
import { renderLegend } from "./legend";
import { stopPlaying } from "./playback";
import type { Day, Params } from "./router";
import { DAY_NAME, params } from "./state";
import { $, track } from "./ui";

let changed: () => void = () => {};
export function initControls(onChange: () => void) {
  changed = onChange;
}

// ---------- instellingen ----------
type NumParam = { [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params];

const RANGES: [NumParam, (v: number) => string][] = [
  ["bikeKmh", (v) => `${v} km/u`],
  ["bikeMaxKm", (v) => `${v} km`],
  ["directMaxKm", (v) => `${v} km`],
];
const modelRadios = [...document.querySelectorAll<HTMLInputElement>("input[name=model]")];
const realBikeBox = $<HTMLInputElement>("realBike");
// fiets bij vertrek en bij aankomst (fase 6.7): zonder fiets loop je dat stuk
const LEG_BOXES = [["bikeStart", $<HTMLInputElement>("bikeStart")], ["bikeEnd", $<HTMLInputElement>("bikeEnd")]] as const;
const tMaxSel = $<HTMLSelectElement>("tMaxMin");

for (const [id, fmt] of RANGES) {
  const input = $<HTMLInputElement>(id);
  input.addEventListener("input", () => {
    params[id] = +input.value;
    $(id + "Out").textContent = fmt(params[id]);
    changed();
  });
}
for (const el of modelRadios) {
  el.addEventListener("change", () => {
    params.waitFactor = +el.value;
    changed();
  });
}
realBikeBox.addEventListener("change", () => {
  params.realBike = realBikeBox.checked;
  changed();
});
for (const [key, box] of LEG_BOXES) {
  box.addEventListener("change", () => {
    params[key] = box.checked;
    syncLegs();
    changed();
  });
}
/** schuiven die bij lopen niet meetellen, uitzetten */
function syncLegs() {
  $<HTMLInputElement>("directMaxKm").disabled = !params.bikeStart;
  $<HTMLInputElement>("bikeMaxKm").disabled = !params.bikeEnd;
  $<HTMLInputElement>("bikeKmh").disabled = !params.bikeStart && !params.bikeEnd;
}
tMaxSel.addEventListener("change", () => {
  params.tMaxMin = +tMaxSel.value;
  renderLegend();
  changed();
});

/** het fietsraster is geladen (of niet: dan kan het vinkje niet aan) */
export function setBikeAvailable(ok: boolean) {
  realBikeBox.disabled = !ok;
  if (!ok) realBikeBox.parentElement!.title = "Fietsraster niet beschikbaar";
}

// ---------- vertrektijd (uurmodel of echte vertrektijden) ----------
const timeOn = $<HTMLInputElement>("timeOn");
const departSlider = $<HTMLInputElement>("departMin");
const ttButtons = [...$("ttPick").querySelectorAll<HTMLButtonElement>("button")];
const DEFAULT_DEPART = 8 * 60;

/** welk venster de kaart gebruikt: het uurmodel middelt over een uur rond het half uur, de dienstregeling
 *  neemt 12 vertrekken van 15 min ervoor tot 40 min erna (CSA_RUNS in csa.ts) */
function timeNote(min: number): string {
  const at = (d: number) => clock((min + d + 1440) % 1440);
  return params.timetable
    ? `Je vertrekt 12 keer, om de 5 min tussen ${at(-15)} en ${at(40)}. Elke plek toont de middelste reistijd.`
    : `Bij elke overstap telt de gemiddelde wachttijd tussen ${at(-15)} en ${at(45)}.`;
}

// ---------- dag: werkdag, zaterdag of zondag (fase 6.7 stap 4) ----------
export const dayDates = new Map<Day, string>(); // de dagen in de data, met hun datum (na "ready")
for (const btn of $("dayPick").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day as Day;
    if (day === params.day) return;
    params.day = day;
    if (day !== "wd") track("dag-weekend");
    syncTime();
    changed();
  });
}

timeOn.addEventListener("change", () => {
  params.departMin = timeOn.checked ? +departSlider.value : null;
  if (!timeOn.checked) stopPlaying();
  syncTime();
  changed();
});
departSlider.addEventListener("input", () => {
  stopPlaying();
  params.departMin = +departSlider.value;
  syncTime();
  changed();
});
// fase 4: gemiddelde wachttijd (uurmodel) of echte vertrektijden (CSA)
for (const btn of ttButtons) {
  btn.addEventListener("click", () => {
    const on = btn.dataset.tt === "1";
    if (on === params.timetable) return;
    params.timetable = on;
    if (on) track("dienstregeling");
    syncTime();
    changed();
  });
}

export function syncTime() {
  const on = params.departMin !== null;
  timeOn.checked = on;
  $("timeCtl").hidden = !on;
  $("timeRow").classList.toggle("active", on);
  if (on) departSlider.value = String(params.departMin);
  $("ttPick").hidden = $("timeNote").hidden = !on;
  for (const btn of ttButtons) btn.setAttribute("aria-pressed", String((btn.dataset.tt === "1") === params.timetable));
  if (on) $("timeNote").textContent = timeNote(params.departMin!);
  $("departOut").textContent = clock(on ? params.departMin! : +departSlider.value);
  // met een tijdstip telt de wachttijd van dat uur (gemiddeld of echt), niet de wachtfactor
  for (const el of modelRadios) el.disabled = on;
  const day = DAY_NAME[params.day].toLowerCase();
  $("dataWindow").textContent = on
    ? `${day}, vertrek ${clock(params.departMin!)}, ${params.timetable ? "echte vertrektijden" : "gemiddelde wachttijd"}`
    : `${day}, 07–19 u`;
  const d = dayDates.get(params.day);
  if (d) $("dataDate").textContent = fmtDate(d);
  for (const btn of $("dayPick").querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.day === params.day));
    btn.hidden = dayDates.size > 0 && !dayDates.has(btn.dataset.day as Day);
  }
  renderChart();
}
departSlider.value = String(DEFAULT_DEPART);

/** zet alle invoervelden op de waarden in params */
export function syncControls() {
  for (const [id, fmt] of RANGES) {
    $<HTMLInputElement>(id).value = String(params[id]);
    $(id + "Out").textContent = fmt(params[id]);
  }
  for (const el of modelRadios) el.checked = +el.value === params.waitFactor;
  realBikeBox.checked = params.realBike;
  for (const [key, box] of LEG_BOXES) box.checked = params[key];
  syncLegs();
  tMaxSel.value = String(params.tMaxMin);
  renderLegend();
  syncTime();
}
