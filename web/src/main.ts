import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { ImageSource, Map as MlMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { LayerSpecification } from "maplibre-gl";
import { geocode, type Place } from "./geocode";
import { CORNERS, cellOf } from "./grid";
import { BAND_MIN, DIFF_A, DIFF_B, DIFF_EDGES, DIFF_SAME, bandColor } from "./raster";
import type { Day, Params, Segment } from "./router";
import type { CompareMode, Explained, Request, Response, Source, Station } from "./worker";

setWorkerUrl(maplibreWorkerUrl);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const narrow = matchMedia("(max-width: 640px)"); // smal scherm: het paneel is een sheet onderaan

// ---------- bezoekers tellen (GoatCounter, zonder cookies; zie index.html) ----------
// Alleen het soort gebeurtenis, nooit coördinaten of adressen. count.js telt niet op localhost
// en stuurt de hash (met het vertrekpunt) niet mee.
declare global {
  interface Window {
    goatcounter?: { count?: (v: { path: string; title?: string; event?: boolean }) => void };
  }
}
function track(event: string) {
  window.goatcounter?.count?.({ path: event, event: true });
}

// ---------- instellingen ----------
const DEFAULTS: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true, departMin: null,
  bikeStart: true, bikeEnd: false, day: "wd", timetable: false,
};
const params: Params = { ...DEFAULTS };
let bikeLoaded = false; // het fietsraster komt na de graaf binnen

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
    settingsChanged();
  });
}
for (const el of modelRadios) {
  el.addEventListener("change", () => {
    params.waitFactor = +el.value;
    settingsChanged();
  });
}
realBikeBox.addEventListener("change", () => {
  params.realBike = realBikeBox.checked;
  settingsChanged();
});
for (const [key, box] of LEG_BOXES) {
  box.addEventListener("change", () => {
    params[key] = box.checked;
    syncLegs();
    settingsChanged();
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
  settingsChanged();
});

// ---------- vertrektijd (uurmodel of echte vertrektijden) en de werkdag afspelen ----------
const timeOn = $<HTMLInputElement>("timeOn");
const departSlider = $<HTMLInputElement>("departMin");
const playBtn = $<HTMLButtonElement>("play");
const ttButtons = [...$("ttPick").querySelectorAll<HTMLButtonElement>("button")];
const DEFAULT_DEPART = 8 * 60;
const FRAME_STEP_MIN = 30;
const FRAME_MS = 700; // minimale tijd per stap tijdens afspelen
const AHEAD = 2; // frames die tijdens afspelen al klaarstaan of onderweg zijn
const FADE_MS = 400; // overgang tussen twee frames
let playing = false;
let playGen = 0; // na een wijziging tellen frames die nog onderweg zijn niet meer
const frames = new Map<number, ResultMsg>(); // vertrektijd -> klaar frame
const framesAsked = new Set<number>();
let lastFrameAt = 0;
let playTimer = 0;

const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const nextMin = (min: number, k = 1) => (min + k * FRAME_STEP_MIN) % 1440;
/** kloktijd van seconden na middernacht (ook na 24:00, bij ritten in de nacht) */
const clockSec = (sec: number) => clock(Math.round(sec / 60) % 1440);
/** welk venster de kaart gebruikt: het uurmodel middelt over een uur rond het half uur, de dienstregeling
 *  neemt 12 vertrekken van 15 min ervoor tot 40 min erna (CSA_RUNS in csa.ts) */
function timeNote(min: number): string {
  const at = (d: number) => clock((min + d + 1440) % 1440);
  return params.timetable
    ? `Je vertrekt 12 keer, om de 5 min tussen ${at(-15)} en ${at(40)}. Elke plek toont de middelste reistijd.`
    : `Bij elke overstap telt de gemiddelde wachttijd tussen ${at(-15)} en ${at(45)}.`;
}

// ---------- dag: werkdag, zaterdag of zondag (fase 6.7 stap 4) ----------
const DAY_NAME: Record<Day, string> = { wd: "Werkdag", za: "Zaterdag", zo: "Zondag" };
const dayDates = new Map<Day, string>(); // de dagen in de data, met hun datum (na "ready")
for (const btn of $("dayPick").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    const day = btn.dataset.day as Day;
    if (day === params.day) return;
    params.day = day;
    if (day !== "wd") track("dag-weekend");
    syncTime();
    settingsChanged();
  });
}

timeOn.addEventListener("change", () => {
  params.departMin = timeOn.checked ? +departSlider.value : null;
  if (!timeOn.checked) stopPlaying();
  syncTime();
  settingsChanged();
});
departSlider.addEventListener("input", () => {
  stopPlaying();
  params.departMin = +departSlider.value;
  syncTime();
  settingsChanged();
});
playBtn.addEventListener("click", () => (playing ? stopPlaying() : startPlaying()));
// fase 4: gemiddelde wachttijd (uurmodel) of echte vertrektijden (CSA)
for (const btn of ttButtons) {
  btn.addEventListener("click", () => {
    const on = btn.dataset.tt === "1";
    if (on === params.timetable) return;
    params.timetable = on;
    if (on) track("dienstregeling");
    syncTime();
    settingsChanged();
  });
}

function setPlaying(on: boolean) {
  playing = on;
  playBtn.textContent = on ? "❚❚" : "▶";
  playBtn.setAttribute("aria-label", on ? "Pauzeren" : `${DAY_NAME[params.day]} afspelen`);
}
function startPlaying() {
  if (params.departMin === null) return;
  setPlaying(true);
  track("animatie-gestart");
  lastFrameAt = 0;
  askFrames();
}
function stopPlaying() {
  if (!playing) return;
  setPlaying(false);
  clearTimeout(playTimer);
  dropFrames();
}
/** frames met oude instellingen weggooien (na een wijziging, of bij stoppen) */
function dropFrames() {
  playGen++;
  for (const f of frames.values()) f.bitmap.close();
  frames.clear();
  framesAsked.clear();
}
/** de volgende AHEAD halve uren laten uitrekenen, als dat nog niet gebeurt */
function askFrames() {
  if (!playing || params.departMin === null) return;
  for (let k = 1; k <= AHEAD; k++) {
    const t = nextMin(params.departMin, k);
    if (frames.has(t) || framesAsked.has(t)) continue;
    framesAsked.add(t);
    requestFrame(t);
  }
}
/** het volgende frame tonen zodra het klaar is en het vorige lang genoeg in beeld was */
function advance() {
  clearTimeout(playTimer);
  if (!playing || params.departMin === null) return;
  const t = nextMin(params.departMin);
  const f = frames.get(t);
  if (!f) return; // nog onderweg: de worker meldt zich
  const wait = lastFrameAt + FRAME_MS - performance.now();
  if (wait > 0) {
    playTimer = window.setTimeout(advance, wait);
    return;
  }
  frames.delete(t);
  params.departMin = t;
  syncTime();
  writeHash();
  showResult(f, true);
  lastFrameAt = performance.now();
  askFrames();
  playTimer = window.setTimeout(advance, FRAME_MS);
}

// ---------- diagram: oppervlak dat binnen 1 uur bereikbaar is, per half uur ----------
// Rekent op de achtergrond, één vertrektijd tegelijk, als de worker niets anders te doen heeft.
const PROFILE_MIN = 60;
const profile = new Float64Array(1440 / FRAME_STEP_MIN).fill(NaN);
let profileGen = 0;
let profileNext = 0;
let profileBusy = false;
let profileKey = "";

/** na elke wijziging: opnieuw beginnen als het vertrekpunt of het fietsen anders is */
function checkProfile() {
  const key = JSON.stringify([points(), params.day, params.bikeKmh, params.bikeMaxKm, params.directMaxKm,
    params.bikeStart, params.bikeEnd, params.realBike && bikeLoaded]);
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
function pumpProfile() {
  if (params.departMin === null || profileBusy || profileNext >= profile.length) return;
  if (!workerReady || busy || framesAsked.size > 0) return; // de kaart en het afspelen gaan voor
  profileBusy = true;
  send({ type: "profile", gen: profileGen, departMin: profileNext++ * FRAME_STEP_MIN, ...points(),
    params: { ...params, tMaxMin: PROFILE_MIN } });
}
function onProfile(m: Extract<Response, { type: "profile" }>) {
  profileBusy = false;
  if (m.gen === profileGen) {
    profile[m.departMin / FRAME_STEP_MIN] = m.km2;
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

function renderChart() {
  chartEl.hidden = params.departMin === null;
  if (chartEl.hidden) return;
  chartEl.querySelector("span")!.textContent = source === "ic" ? "Binnen 1 uur van een IC-station"
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
  const mx = (((params.departMin! + FRAME_STEP_MIN / 2) / 1440) * CHART_W).toFixed(1);
  chartNow.setAttribute("x1", mx);
  chartNow.setAttribute("x2", mx);
  const cur = profile[params.departMin! / FRAME_STEP_MIN];
  chartEl.querySelector("b")!.textContent = Number.isFinite(cur) ? `${Math.round(cur).toLocaleString("nl")} km²` : "…";
  const done = profile.filter(Number.isFinite).length;
  chartEl.querySelector(".chart-note")!.textContent = done < n ? `berekenen… ${done}/${n}` : "";
}
// klikken of slepen in het diagram kiest de vertrektijd
function pickFromChart(e: PointerEvent) {
  const r = chartSvg.getBoundingClientRect();
  const i = Math.min(profile.length - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * profile.length)));
  if (params.departMin === i * FRAME_STEP_MIN) return;
  stopPlaying();
  params.departMin = i * FRAME_STEP_MIN;
  syncTime();
  settingsChanged();
}
chartSvg.addEventListener("pointerdown", (e) => {
  chartSvg.setPointerCapture(e.pointerId);
  pickFromChart(e);
});
chartSvg.addEventListener("pointermove", (e) => e.buttons && pickFromChart(e));

function syncTime() {
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
  if (d) $("dataDate").textContent = `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`;
  for (const btn of $("dayPick").querySelectorAll("button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.day === params.day));
    btn.hidden = dayDates.size > 0 && !dayDates.has(btn.dataset.day as Day);
  }
  renderChart();
}
departSlider.value = String(DEFAULT_DEPART);

/** zet alle invoervelden op de waarden in params */
function syncControls() {
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

function settingsChanged() {
  writeHash();
  scheduleCompute();
  afterChange();
}
/** tijdens afspelen gelden de frames die al klaarstaan niet meer; het diagram misschien ook niet */
function afterChange() {
  if (playing) {
    dropFrames();
    askFrames();
  }
  checkProfile();
}

function renderLegend() {
  const el = $("legend");
  el.innerHTML = "";
  $("legendCaption").hidden = !diffShown();
  if (diffShown()) return renderDiffLegend();
  const n = Math.ceil(params.tMaxMin / BAND_MIN);
  for (let b = 0; b < n; b++) {
    const [r, g, bl] = bandColor(b, n);
    const sw = document.createElement("span");
    sw.style.background = `rgb(${r},${g},${bl})`;
    sw.title = `${b * BAND_MIN}–${(b + 1) * BAND_MIN} min`;
    el.append(sw);
  }
  const labels = $("legendLabels");
  labels.innerHTML = "";
  for (let m = 0; m <= params.tMaxMin; m += params.tMaxMin <= 120 ? 30 : 60) {
    const s = document.createElement("span");
    s.textContent = m === 0 ? "0" : m % 60 === 0 ? `${m / 60} u` : `${m}′`;
    s.style.left = `${(m / params.tMaxMin) * 100}%`;
    labels.append(s);
  }
}
/** verschil A − B: bruin (A sneller) via grijs naar petrol (B sneller), met de grenzen in minuten */
function renderDiffLegend() {
  const edges = DIFF_EDGES;
  const bands = [
    ...DIFF_A.map((c, k) => [c, `A ${edges[k]}${k + 1 < edges.length ? "–" + edges[k + 1] : "+"} min sneller`]).reverse(),
    [DIFF_SAME, `minder dan ${edges[0]} min verschil`],
    ...DIFF_B.map((c, k) => [c, `B ${edges[k]}${k + 1 < edges.length ? "–" + edges[k + 1] : "+"} min sneller`]),
  ];
  for (const [c, title] of bands) {
    const sw = document.createElement("span");
    sw.style.background = c;
    sw.title = title;
    $("legend").append(sw);
  }
  // een getal op elke grens tussen twee banden
  const labels = $("legendLabels");
  labels.innerHTML = "";
  const marks = [...edges.slice().reverse(), ...edges];
  for (const [i, m] of marks.entries()) {
    const s = document.createElement("span");
    s.textContent = i === 0 || i === marks.length - 1 ? `${m}′` : String(m);
    s.style.left = `${((i + 1) / bands.length) * 100}%`;
    s.style.transform = "translateX(-50%)";
    labels.append(s);
  }
}

// ---------- deellink: #lat,lon,naam&w=0.5&v=15&b=5&d=15&t=180&f=1&u=480&r=1&s=1&a=0&dag=za&k=ic&p2=lat,lon,naam&m=diff ----------
// Alleen afwijkingen van de standaard komen in de link; onbekende of ongeldige waarden worden genegeerd.
// p2 is punt B bij vergelijken (b is al de fietsgrens), m=diff de stand "Verschil",
// k=ic de kaart naar het dichtstbijzijnde IC-station (het vertrekpunt blijft erin staan).
const HASH_KEYS = {
  w: "waitFactor", v: "bikeKmh", b: "bikeMaxKm", d: "directMaxKm", t: "tMaxMin", f: "realBike", u: "departMin",
  s: "bikeStart", a: "bikeEnd", r: "timetable",
} as const;
type HashParam = (typeof HASH_KEYS)[keyof typeof HASH_KEYS];
type Origin = { lat: number; lon: number; name: string };

/** een waarde uit de link, alleen als het bijbehorende invoerveld hem ook kan tonen */
function parseSetting(key: HashParam, raw: string): number | boolean | null {
  const v = Number(raw);
  if (raw === "" || !Number.isFinite(v)) return null;
  if (key === "realBike" || key === "bikeStart" || key === "bikeEnd" || key === "timetable") return v === 0 || v === 1 ? v === 1 : null;
  if (key === "waitFactor") return modelRadios.some((r) => +r.value === v) ? v : null;
  if (key === "tMaxMin") return [...tMaxSel.options].some((o) => +o.value === v) ? v : null;
  const input = $<HTMLInputElement>(key);
  const steps = (v - +input.min) / +input.step;
  return v >= +input.min && v <= +input.max && Math.abs(steps - Math.round(steps)) < 1e-6 ? v : null;
}

/** "lat,lon,naam" (de naam URL-gecodeerd, dus zonder & of ,) */
function parsePoint(s: string): Origin | null {
  const m = /^([-\d.]+),([-\d.]+)(?:,(.*))?$/.exec(s);
  if (!m || !Number.isFinite(+m[1]) || !Number.isFinite(+m[2])) return null;
  let name = "";
  try {
    name = m[3] ? decodeURIComponent(m[3]) : "";
  } catch { /* kapotte codering: zonder naam verder */ }
  return { lat: +m[1], lon: +m[2], name };
}
const fmtPoint = ({ lat, lon, name }: Origin) =>
  `${lat.toFixed(5)},${lon.toFixed(5)}${name ? "," + encodeURIComponent(name) : ""}`;

function readHash(): { origin: Origin; b: Origin | null; mode: CompareMode; source: Source; settings: Partial<Params> } | null {
  // het vertrekpunt staat vooraan; daarna volgen de instellingen, elk na een &
  const [head, ...rest] = location.hash.slice(1).split("&");
  const origin = parsePoint(head);
  if (!origin) return null;
  const settings: Record<string, number | boolean | string> = {};
  let b: Origin | null = null;
  let mode: CompareMode = "max";
  let source: Source = "point";
  for (const part of rest) {
    const [k, raw] = part.split("=");
    if (k === "p2" && raw !== undefined) b = parsePoint(raw);
    if (k === "dag" && (raw === "za" || raw === "zo")) settings.day = raw;
    if (k === "m" && raw === "diff") mode = "diff";
    if (k === "k" && raw === "ic") source = "ic";
    const key = HASH_KEYS[k as keyof typeof HASH_KEYS];
    const v = key && raw !== undefined ? parseSetting(key, raw) : null;
    if (v !== null) settings[key] = v;
  }
  return { origin, b, mode, source, settings: settings as Partial<Params> };
}

function writeHash() {
  let h = "#" + fmtPoint(origin);
  for (const [k, key] of Object.entries(HASH_KEYS)) {
    const v = params[key];
    if (v !== DEFAULTS[key]) h += `&${k}=${typeof v === "boolean" ? +v : v}`;
  }
  if (params.day !== "wd") h += "&dag=" + params.day;
  if (comparing && pointB) h += "&p2=" + fmtPoint(pointB);
  if (comparing && compareMode === "diff") h += "&m=diff";
  if (source === "ic") h += "&k=ic";
  history.replaceState(null, "", h);
}

// ---------- vertrekpunt ----------
const initial = readHash();
let origin: Origin = initial?.origin ?? { lat: 52.0894, lon: 5.11, name: "Utrecht Centraal" };
Object.assign(params, initial?.settings);

// vergelijken (fase 6.5): een tweede punt B; de kaart kleurt naar de langste van de twee reistijden
// ("Voor ons allebei") of naar het verschil A − B ("Verschil")
type Which = "a" | "b";
let pointB: Origin | null = initial?.b ?? null;
let comparing = pointB !== null;
let compareMode: CompareMode = initial?.b ? initial.mode : "max";
// fase 6.7 stap 3: de kaart gaat over het vertrekpunt, of over de reistijd naar het dichtstbijzijnde IC-station
let source: Source = initial?.source ?? "point";
let nIc = 0;
/** de kaart toont het verschil: alleen als B ook gekozen is */
const diffShown = () => source === "point" && comparing && pointB !== null && compareMode === "diff";
let editing: Which = comparing ? "b" : "a"; // het punt dat klikken, zoeken en de voorbeelden verplaatsen
const pointName = (p: Origin) => p.name || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
/** de punten voor de worker: B alleen als het gekozen is (bij de IC-kaart tellen ze niet) */
const points = () => ({
  source,
  a: { lat: origin.lat, lon: origin.lon },
  b: source === "point" && comparing && pointB ? { lat: pointB.lat, lon: pointB.lon } : null,
});
syncControls();

function setOrigin(lat: number, lon: number, name = "", which = editing) {
  if (which === "b") pointB = { lat, lon, name };
  else origin = { lat, lon, name };
  writeHash();
  renderPoints();
  hideInfo();
  scheduleCompute();
  afterChange();
}

const HINT = matchMedia("(pointer: coarse)").matches
  ? "Tik op de kaart voor de reistijd en de route. Sleep de punt om het vertrekpunt te verplaatsen."
  : "Klik op de kaart voor de route, of sleep de punt om het vertrekpunt te verplaatsen.";

/** namen, markeringen en knoppen van A en B bijwerken (en verbergen bij de IC-kaart) */
function renderPoints() {
  const ic = source === "ic";
  for (const btn of $("mapKind").querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.kind === source));
  $("icNote").hidden = !ic;
  $("icNote").innerHTML = "<b>Naar het dichtstbijzijnde IC-station:</b> de kleur is de reistijd van elke plek naar het IC-station " +
    `dat het snelst te bereiken is${nIc ? ` (${nIc} stations)` : ""}. Het stuk vanaf de plek zelf volgt "Fiets bij vertrek".`;
  $("rowA").hidden = ic;
  $("origin").textContent = pointName(origin);
  $("originLabel").textContent = comparing ? "Punt A" : "Vertrekpunt";
  $("rowB").hidden = ic || !comparing;
  $("originB").textContent = pointB ? pointName(pointB) : "kies een plek…";
  $("compare").hidden = ic || comparing;
  $("compareNote").hidden = ic || !comparing;
  $("compareMode").hidden = ic || !comparing;
  for (const btn of $("compareMode").querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.mode === compareMode));
  $("compareNote").innerHTML = compareMode === "diff"
    ? `<b>Verschil:</b> bruin is sneller vanaf A, petrol sneller vanaf B. Hoe donkerder, hoe groter het verschil. Grijs: minder dan ${DIFF_EDGES[0]} min.`
    : "<b>Voor ons allebei:</b> de kleur is de langste van de twee reistijden. Groen is dus snel vanaf A én vanaf B.";
  renderLegend();
  for (const [id, w] of [["rowA", "a"], ["rowB", "b"]] as const) {
    const row = $(id);
    row.classList.toggle("editing", comparing && editing === w);
    row.classList.toggle("pickable", comparing);
    row.setAttribute("aria-pressed", String(comparing && editing === w));
    row.tabIndex = comparing ? 0 : -1;
    row.setAttribute("role", comparing ? "button" : "group");
  }
  markerEl.textContent = comparing ? "A" : "";
  markerEl.classList.toggle("lettered", comparing);
  marker.setLngLat([origin.lon, origin.lat]);
  if (ic) marker.remove();
  else marker.addTo(map);
  if (!ic && comparing && pointB) markerB.setLngLat([pointB.lon, pointB.lat]).addTo(map);
  else markerB.remove();
  $("hint").textContent = ic ? "Klik op de kaart of zoek een plek voor de reistijd en de route naar het IC-station."
    : !comparing ? HINT
    : !pointB ? "Klik op de kaart of zoek een plek voor punt B."
    : `Klik op de kaart om punt ${editing.toUpperCase()} te verplaatsen. Kies hierboven welk punt.`;
}

function startCompare() {
  comparing = true;
  editing = "b";
  track("vergelijken-gestart");
  renderPoints();
  // op een telefoon geen toetsenbord over de kaart: zoeken of tikken mag allebei
  if (narrow.matches) setSheet("half");
  else $("q").focus();
}
function stopCompare() {
  comparing = false;
  pointB = null;
  compareMode = "max";
  editing = "a";
  writeHash();
  renderPoints();
  scheduleCompute();
  afterChange();
}

/** de soort kaart kiezen: vanaf het vertrekpunt, of naar het dichtstbijzijnde IC-station */
function setSource(s: Source) {
  if (s === source) return;
  source = s;
  if (s === "ic") track("kaart-ic");
  hideInfo();
  renderPoints();
  settingsChanged();
}

/** naar een plek vliegen en daar vertrekken (zoeken, voorbeelden, mijn locatie);
 *  bij de IC-kaart alleen erheen, met de reisinfo van die plek */
function goTo(lat: number, lon: number, name = "", zoom = 8.5) {
  if (source === "ic") {
    map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom) });
    pinAt = { lat, lon, name };
    pinPending = true;
    flushExplain();
    if (narrow.matches) setSheet("half");
    return;
  }
  setOrigin(lat, lon, name);
  if (!fitBoth(true)) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom) });
  if (narrow.matches) setSheet("collapsed"); // de kaart is nu het belangrijkst
}
/** bij vergelijken A en B allebei in beeld, op de desktop naast het paneel; false zonder B */
function fitBoth(animate: boolean): boolean {
  if (source !== "point" || !comparing || !pointB) return false;
  const pad = narrow.matches ? 40 : { top: 60, bottom: 60, right: 60, left: $("panel").offsetWidth + 60 };
  map.fitBounds([[Math.min(origin.lon, pointB.lon), Math.min(origin.lat, pointB.lat)],
    [Math.max(origin.lon, pointB.lon), Math.max(origin.lat, pointB.lat)]], { padding: pad, maxZoom: 11, animate });
  return true;
}


// ---------- kaart ----------
const map = new MlMap({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  // via een gedeelde link: centreer op het vertrekpunt
  center: location.hash ? [origin.lon, origin.lat] : [5.3, 52.2],
  zoom: location.hash ? 9 : 7,
  minZoom: 5,
  // ruim om NL heen: maxBounds geldt voor het hele beeld, dus een krap kader
  // blokkeert op brede schermen het uitzoomen tot heel Nederland
  maxBounds: [[-4, 47.5], [14.5, 56.5]],
  attributionControl: { compact: true, customAttribution: "OV-data: NDOV Loket / OVapi" },
});
map.addControl(new NavigationControl({ showCompass: false }), "top-right");
fitBoth(false); // een gedeelde link met punt B
map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

const markerEl = document.createElement("div");
markerEl.className = "origin-marker";
const marker = new Marker({ element: markerEl, draggable: true }).setLngLat([origin.lon, origin.lat]).addTo(map);
marker.on("dragend", () => {
  const p = marker.getLngLat();
  if (comparing) editing = "a";
  setOrigin(p.lat, p.lng, "", "a");
  track("vertrekpunt-slepen");
});
const markerBEl = document.createElement("div");
markerBEl.className = "origin-marker lettered b";
markerBEl.textContent = "B";
const markerB = new Marker({ element: markerBEl, draggable: true }).setLngLat([0, 0]);
markerB.on("dragend", () => {
  const p = markerB.getLngLat();
  editing = "b";
  setOrigin(p.lat, p.lng, "", "b");
  track("vertrekpunt-slepen");
});

map.on("load", () => {
  const layers = map.getStyle().layers;
  // de heatmap komt onder wegen en labels; daarboven een kopie van het water,
  // zodat de fietskegels niet over zee en meren doorlopen
  const firstRoad = layers.find((l) => "source-layer" in l && l["source-layer"] === "transportation")?.id;
  // twee lagen: een nieuw frame komt in de achterste en vloeit dan over de voorste heen
  for (const [i, id] of HEAT.entries()) {
    map.addSource(id, { type: "image", coordinates: CORNERS });
    map.addLayer({
      id, type: "raster", source: id,
      // geen ingebouwde overgang (standaard 300 ms): crossfade() stuurt de dekking zelf
      paint: { "raster-opacity": i === 0 ? HEAT_OPACITY : 0, "raster-opacity-transition": { duration: 0, delay: 0 },
        "raster-resampling": "linear", "raster-fade-duration": 0 },
    }, firstRoad);
  }
  for (const l of layers) {
    if (l.type === "fill" && "source-layer" in l && l["source-layer"] === "water") {
      map.addLayer({ ...(l as LayerSpecification), id: l.id + "-mask" } as LayerSpecification, firstRoad);
    }
  }
  // MapLibre toont de bronvermelding eerst uitgeklapt; op een telefoon bedekt die dan een flink stuk kaart
  // en het midden van de kaart (het vertrekpunt na flyTo) hoort boven de sheet, niet eronder
  if (narrow.matches) {
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    map.setPadding({ top: 0, left: 0, right: 0, bottom: Math.round(window.innerHeight * 0.3) });
  }
  mapReady = true;
  scheduleCompute();
});

// ---------- worker ----------
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (m: Request) => worker.postMessage(m);
let workerReady = false;
let mapReady = false;
let hasResult = false; // de worker kan pas een route uitleggen na de eerste berekening
let computeId = 0;
let busy = false;
let pending = false;
let stations: Station[] = [];
type ResultMsg = Extract<Response, { type: "result" }>;
// een berekening is de gewone kaart ("view") of een frame dat tijdens afspelen vooruit wordt gerekend
const requests = new Map<number, { kind: "view" } | { kind: "frame"; min: number; gen: number }>();
let shownId = 0; // het resultaat in beeld: daarover gaat de tooltip

const HEAT = ["heat0", "heat1"];
const HEAT_OPACITY = 0.72;
let heatFront = 0;
let fadeRaf = 0;
const FADE_STEP_MS = 50;

/** Overgang van de oude naar de nieuwe heatmaplaag. De nieuwe ligt erboven en gaat van 0 naar
 *  HEAT_OPACITY; de oude zakt zo dat de basiskaart steeds voor precies 1 − HEAT_OPACITY doorschijnt.
 *  Zakten beide lineair, dan schemerde halverwege de basiskaart door (een witte flits). */
function crossfade(oldId: string, newId: string, fade: boolean) {
  map.moveLayer(oldId, newId); // de oude laag onder de nieuwe
  cancelAnimationFrame(fadeRaf);
  const set = (t: number) => {
    const top = HEAT_OPACITY * t;
    map.setPaintProperty(newId, "raster-opacity", top);
    map.setPaintProperty(oldId, "raster-opacity", t >= 1 ? 0 : 1 - (1 - HEAT_OPACITY) / (1 - top));
  };
  if (!fade) return set(1);
  // in stappen van ±50 ms: vloeiend genoeg, en elke stap kost een volledige repaint van de kaart
  const t0 = performance.now();
  let last = t0;
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / FADE_MS);
    if (t >= 1 || now - last >= FADE_STEP_MS) {
      set(t);
      last = now;
    }
    if (t < 1) fadeRaf = requestAnimationFrame(step);
  };
  set(0);
  fadeRaf = requestAnimationFrame(step);
}

/** een resultaat in beeld brengen; tijdens afspelen met een overgang */
function showResult(m: ResultMsg, fade: boolean) {
  const back = 1 - heatFront;
  (map.getSource(HEAT[back]) as ImageSource).updateImage({ image: m.bitmap });
  crossfade(HEAT[heatFront], HEAT[back], fade);
  heatFront = back;
  shownId = m.id;
  const nl = (v: number) => v.toLocaleString("nl");
  const reached = m.split
    ? `${nl(m.reached)} haltes binnen ${params.tMaxMin / 60} uur: A sneller bij ${nl(m.split[0])}, B bij ${nl(m.split[1])}`
    : source === "ic" ? `${nl(nIc)} IC-stations · ${nl(m.reached)} haltes binnen ${params.tMaxMin / 60} uur`
    : `${nl(m.reached)} haltes ${points().b ? "voor allebei " : ""}binnen ${params.tMaxMin / 60} uur`;
  $("status").textContent = reached + " · " +
    `netwerk ${m.msRoute.toFixed(0)} ms · kaart ${m.msRaster.toFixed(0)} ms` +
    (params.realBike && !bikeLoaded ? " · fietsraster laden…" : "");
  const legNote = params.bikeStart === params.bikeEnd ? (params.bikeStart ? "fiets heen en terug" : "lopen van en naar de halte")
    : params.bikeStart ? "fiets bij vertrek, lopen bij aankomst" : "lopen bij vertrek, fiets bij aankomst";
  $("bikeNote").textContent = legNote + " · " + (m.bike ? "over de weg (OpenStreetMap)" : "afstand hemelsbreed × 1,3");
  hasResult = true;
  // het beeld is anders: het label en de vastgezette reisinfo opnieuw laten uitrekenen
  hoverSent = null;
  if (pinAt) pinPending = true;
  flushExplain();
}

worker.onmessage = (ev: MessageEvent<Response>) => {
  const m = ev.data;
  if (m.type === "ready") {
    workerReady = true;
    stations = m.stations;
    nIc = m.nIc;
    renderPoints();
    const d = m.date;
    $("dataDate").textContent = `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`;
    for (const day of m.days) dayDates.set(day.key, day.date);
    if (!dayDates.has(params.day)) params.day = "wd"; // een deellink met een dag die deze data niet heeft
    syncTime();
    scheduleCompute();
  } else if (m.type === "bikeReady") {
    bikeLoaded = m.ok;
    realBikeBox.disabled = !m.ok;
    if (!m.ok) realBikeBox.parentElement!.title = "Fietsraster niet beschikbaar";
    if (m.ok && params.realBike) scheduleCompute();
    checkProfile();
  } else if (m.type === "result") {
    const req = requests.get(m.id);
    requests.delete(m.id);
    if (req?.kind === "frame") {
      framesAsked.delete(req.min);
      if (req.gen !== playGen || !playing) m.bitmap.close();
      else {
        frames.set(req.min, m);
        advance();
      }
    } else {
      busy = false;
      showResult(m, false);
      $("app").classList.remove("loading");
      if (pending) compute();
    }
    pumpProfile();
  } else if (m.type === "profile") {
    onProfile(m);
  } else if (m.type === "explain") {
    onExplain(m);
  } else if (m.type === "error") {
    busy = false;
    explainBusy = null;
    $("status").textContent = "Fout: " + m.message;
  }
};
// de worker tekent met OffscreenCanvas en pakt het fietsraster uit met DecompressionStream;
// Safari kan dat pas vanaf iOS 16.4 (de melding staat onderaan dit bestand)
const supported = typeof OffscreenCanvas !== "undefined" && typeof DecompressionStream !== "undefined";
if (supported) send({ type: "init", base: new URL("data/", document.baseURI).href });

let timer = 0;
function scheduleCompute() {
  clearTimeout(timer);
  timer = window.setTimeout(compute, 60);
}
function compute() {
  if (!workerReady || !mapReady) return;
  if (busy) {
    pending = true;
    return;
  }
  busy = true;
  pending = false;
  $("app").classList.add("loading");
  const id = ++computeId;
  requests.set(id, { kind: "view" });
  send({ type: "compute", id, ...points(), mode: compareMode, params: { ...params } });
}
/** een frame voor het afspelen: dezelfde instellingen, een andere vertrektijd */
function requestFrame(min: number) {
  const id = ++computeId;
  requests.set(id, { kind: "frame", min, gen: playGen });
  send({ type: "compute", id, ...points(), mode: compareMode, params: { ...params, departMin: min } });
}

// ---------- reistijd onder de muis, reisinfo na een klik of tik ----------
// Hover toont een klein label met de minuten. Een klik of tik zet de route vast in het paneel,
// met een knop om daarvandaan te vertrekken. Die reisinfo rekent mee als het beeld verandert.
const tooltip = $("tooltip");
type LatLon = { lat: number; lon: number };
let explainId = 0;
let hoverAt: LatLon | null = null; // de laatste muispositie
let hoverSent: LatLon | null = null; // de positie waarvoor het label al is gevraagd
let pinAt: (LatLon & { name?: string }) | null = null; // de vastgezette plek (null: geen reisinfo); naam na zoeken
let pinPending = false;
let explainBusy: "hover" | "pin" | null = null;

/** hooguit één verzoek tegelijk; de reisinfo gaat voor, tussentijdse muisposities worden overgeslagen */
function flushExplain() {
  if (explainBusy || !hasResult) return;
  let at: LatLon;
  if (pinPending && pinAt) {
    pinPending = false;
    explainBusy = "pin";
    at = pinAt;
  } else if (hoverAt && hoverAt !== hoverSent) {
    hoverSent = hoverAt;
    explainBusy = "hover";
    at = hoverAt;
  } else return;
  send({ type: "explain", id: ++explainId, resultId: shownId, lat: at.lat, lon: at.lon });
}

const MODE: Record<number, string> = { 0: "Tram", 1: "Metro", 2: "Trein", 3: "Bus", 4: "Veerboot", 7: "Kabelbaan" };
const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} u ${String(Math.round(m % 60)).padStart(2, "0")}`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function routeLabel(seg: Extract<Segment, { kind: "ride" }>) {
  const [short, type, , long] = seg.route;
  const mode = MODE[type] ?? "OV";
  const name = type === 2 ? short || mode : `${mode} ${short}`;
  return `<b title="${esc(long)}">${esc(name)}</b>`;
}

function explainHtml(m: Extract<Response, { type: "explain" }>): string {
  const within = `binnen ${params.tMaxMin / 60} uur`;
  if (m.parts.length === 1) {
    const p = m.parts[0];
    if (p.minutes === null) {
      return `<div class="tt-total">Niet bereikbaar</div><div class="tt-sub">${within}${source === "ic" ? " van een IC-station" : ""}</div>`;
    }
    if (source === "ic") return icHtml(p);
    return `<div class="tt-total">${fmtMin(p.minutes)}</div>${leaveHtml(p)}${legsHtml(p)}`;
  }
  // vergelijken: de langste van de twee of het verschil (dat is de kleur), daarna elke reis apart
  const mins = m.parts.map((p) => p.minutes);
  const head = diffShown() ? `<div class="tt-total">${diffText(mins)}</div><div class="tt-sub">${diffSub(mins)}</div>`
    : mins.every((v) => v !== null)
    ? `<div class="tt-total">${fmtMin(Math.max(...(mins as number[])))}</div><div class="tt-sub">voor jullie allebei (de langste reis)</div>`
    : `<div class="tt-total">Niet voor allebei</div><div class="tt-sub">bereikbaar ${within}</div>`;
  return head + m.parts.map((p, i) => {
    const tag = `<span class="tag ${"ab"[i]}">${"AB"[i]}</span>`;
    return p.minutes === null
      ? `<div class="tt-part">${tag} niet bereikbaar</div>`
      : `<div class="tt-part">${tag} ${fmtMin(p.minutes)}</div>${leaveHtml(p)}${legsHtml(p)}`;
  }).join("");
}

/** stand "Verschil": wie is er sneller, en hoeveel (een reis die niet binnen de kleurschaal past: null) */
function diffText([a, b]: (number | null)[]): string {
  if (a === null && b === null) return "Niet bereikbaar";
  if (a === null || b === null) return `Alleen vanaf ${a === null ? "B" : "A"}`;
  const d = a - b;
  return Math.abs(d) < 0.5 ? "Even snel" : `${fmtMin(Math.abs(d))} sneller vanaf ${d < 0 ? "A" : "B"}`;
}
function diffSub([a, b]: (number | null)[]): string {
  if (a !== null && b !== null) return "verschil tussen de twee reizen";
  return a === null && b === null ? `vanaf A en B niet binnen ${params.tMaxMin / 60} uur`
    : `vanaf ${a === null ? "A" : "B"} niet binnen ${params.tMaxMin / 60} uur`;
}

/** kort label onder de muis: alleen de minuten */
function hoverHtml(m: Extract<Response, { type: "explain" }>): string {
  const mins = m.parts.map((p) => p.minutes);
  const sub = `<div class="tt-sub">klik voor de route</div>`;
  if (mins.length === 1) return mins[0] === null ? `<div class="tt-sub">Niet bereikbaar</div>` : `<b>${fmtMin(mins[0])}</b>${sub}`;
  const each = mins.map((v, i) => `${"AB"[i]} ${v === null ? "–" : fmtMin(v)}`).join(" · ");
  if (diffShown()) return `<b>${diffText(mins)}</b> <span class="tt-sub">${each}</span>${sub}`;
  return mins.every((v) => v !== null)
    ? `<b>${fmtMin(Math.max(...(mins as number[])))}</b> <span class="tt-sub">${each}</span>${sub}`
    : `<div class="tt-sub">Niet voor allebei · ${each}</div>`;
}

const leg = (bike: boolean, min: number, to: string) =>
  `<li class="${bike ? "bike" : "walk"}">${bike ? "Fiets" : "Loop"} ${fmtMin(min)} naar ${to}</li>`;

/** IC-kaart: de worker rekent vanaf het station; hier staat de reis andersom, van de plek naar het station */
function icHtml(m: Explained): string {
  const [first, ...rest] = m.segments; // first: 0 min "fietsen" naar het IC-station waar de zoektocht begon
  if (!first) return "";
  const rows = [leg(params.bikeStart, m.lastBike, esc(rest.length ? rest[rest.length - 1].to : first.to))];
  for (const s of rest.reverse()) {
    if (s.kind === "walk") { if (s.minutes >= 0.5) rows.push(`<li class="walk">Loop ${fmtMin(s.minutes)} naar ${esc(s.from)}</li>`); }
    else if (s.kind === "ride") rows.push(rideRow({ ...s, from: s.to, to: s.from, dep: undefined, arr: undefined }));
  }
  return `<div class="tt-total">${fmtMin(m.minutes!)}</div><div class="tt-sub">naar IC-station ${esc(first.to)}</div>` +
    `<ol class="legs">${rows.join("")}</ol>`;
}
function rideRow(s: Extract<Segment, { kind: "ride" }>) {
  const wait = s.wait >= 0.5 ? ` <span class="wait">+${Math.round(s.wait)} wacht</span>` : "";
  // met echte vertrektijden staan de kloktijden erbij
  const at = (t: number | undefined) => (t === undefined ? "" : clockSec(t) + " ");
  return `<li class="ride t${s.route[1]}">${routeLabel(s)} ${fmtMin(s.minutes)}${wait}<br><small>${at(s.dep)}${esc(s.from)} → ${at(s.arr)}${esc(s.to)}</small></li>`;
}

/** met echte vertrektijden: wanneer deze reis vertrekt en aankomt (één van de 12 vertrekken rond het tijdstip) */
function leaveHtml(m: Explained): string {
  if (m.leave === undefined || m.minutes === null) return "";
  return `<div class="tt-sub">middelste van 12 reizen: vertrek ${clockSec(m.leave)}, aankomst ${clockSec(m.leave + m.minutes * 60)}</div>`;
}

/** de etappes van één reis, met het laatste stuk fietsen of lopen */
function legsHtml(m: Explained): string {
  const rows: string[] = [];
  for (const s of m.segments) {
    if (s.kind === "bike") { if (s.minutes >= 0.5) rows.push(leg(params.bikeStart, s.minutes, esc(s.to))); }
    else if (s.kind === "walk") { if (s.minutes >= 0.5) rows.push(`<li class="walk">Loop ${fmtMin(s.minutes)} naar ${esc(s.to)}</li>`); }
    else rows.push(rideRow(s));
  }
  // direct (zonder OV) is het hele stuk het eerste stuk
  rows.push(leg(m.segments.length ? params.bikeEnd : params.bikeStart, m.lastBike, "bestemming"));
  return `<ol class="legs">${rows.join("")}</ol>`;
}

function onExplain(m: Extract<Response, { type: "explain" }>) {
  const via = explainBusy;
  explainBusy = null;
  if (via === "hover" && hoverAt === hoverSent && lastPointerType !== "touch") {
    tooltip.innerHTML = hoverHtml(m);
    tooltip.hidden = false;
    placeTooltip(); // de grootte kan veranderd zijn
  } else if (via === "pin" && pinAt && !pinPending) {
    const at = pinAt;
    const box = document.createElement("div");
    box.innerHTML = explainHtml(m);
    const btn = document.createElement("button");
    btn.className = "btn";
    // het punt van het label, ook als daarna een andere rij gekozen is
    const which = editing;
    const fromIc = source === "ic";
    btn.textContent = comparing && !fromIc ? `Punt ${which.toUpperCase()} hierheen` : "Vertrek vanaf hier";
    btn.onclick = () => {
      // vanaf de IC-kaart: terug naar de gewone kaart, met hier het vertrekpunt (A)
      if (fromIc) {
        source = "point";
        if (comparing) editing = "a";
      }
      setOrigin(at.lat, at.lon, at.name ?? "", fromIc ? "a" : which);
      track("vertrekpunt-klik");
      if (narrow.matches) setSheet("collapsed");
    };
    box.append(btn);
    showInfo(box, [at.lon, at.lat]);
  }
  flushExplain();
}

// na een tik stuurt de browser een nagebootste mousemove; die mag geen hover-tooltip
// openen, anders staat er een label onder de vinger
let lastPointerType = "mouse";
map.getCanvasContainer().addEventListener("pointerdown", (ev) => (lastPointerType = ev.pointerType), true);
map.getCanvasContainer().addEventListener("pointermove", (ev) => (lastPointerType = ev.pointerType), true);

// rechtsonder de muis, maar links of boven de muis als hij anders buiten de kaart valt
let tooltipAt: [number, number] = [0, 0];
function placeTooltip() {
  const [x, y] = tooltipAt;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  const W = window.innerWidth, H = window.innerHeight;
  let left = x + 16, top = y + 16;
  if (left + w > W - 8) left = Math.max(8, x - 16 - w);
  if (top + h > H - 8) top = Math.max(8, y - 16 - h);
  tooltip.style.transform = `translate(${left}px, ${top}px)`;
}

map.on("mousemove", (e) => {
  if (lastPointerType === "touch") {
    tooltip.hidden = true;
    return;
  }
  tooltipAt = [e.point.x, e.point.y];
  placeTooltip();
  hoverAt = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  flushExplain();
});
map.getCanvas().addEventListener("mouseleave", () => (tooltip.hidden = true));
map.on("click", (e) => {
  // klik of tik = de reisinfo vastzetten, met een knop om daarvandaan te vertrekken
  pinAt = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  pinPending = true;
  flushExplain();
  track("reisinfo-klik");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement !== q) hideInfo();
});

// ---------- zoeken ----------
const q = $<HTMLInputElement>("q");
const results = $<HTMLUListElement>("results");
let abort: AbortController | null = null;
let qTimer = 0;
let shown: Place[] = [];
let active = -1;

function showResults(list: Place[]) {
  shown = list;
  active = -1;
  results.innerHTML = "";
  for (const [i, p] of list.entries()) {
    const li = document.createElement("li");
    li.innerHTML = `${esc(p.name)} <small>${esc(p.type)}</small>`;
    li.onmousedown = (ev) => {
      ev.preventDefault();
      pick(i);
    };
    results.append(li);
  }
  results.hidden = list.length === 0;
}

function pick(i: number) {
  const p = shown[i];
  if (!p) return;
  q.value = p.name;
  showResults([]);
  q.blur();
  goTo(p.lat, p.lon, p.name);
  track("vertrekpunt-zoeken");
}

q.addEventListener("input", () => {
  clearTimeout(qTimer);
  const text = q.value.trim();
  if (text.length < 2) return showResults([]);
  const lower = text.toLowerCase();
  const local: Place[] = stations
    .filter((s) => s.name.toLowerCase().includes(lower))
    .slice(0, 3)
    .map((s) => ({ name: s.name, type: "station", lat: s.lat, lon: s.lon }));
  showResults(local);
  qTimer = window.setTimeout(async () => {
    abort?.abort();
    abort = new AbortController();
    try {
      const remote = await geocode(text, abort.signal);
      showResults([...local, ...remote].slice(0, 8));
    } catch (err) {
      if ((err as Error).name !== "AbortError") showResults(local);
    }
  }, 220);
});
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = (active + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % Math.max(shown.length, 1);
    [...results.children].forEach((li, i) => li.classList.toggle("active", i === active));
  } else if (e.key === "Enter") {
    pick(active >= 0 ? active : 0);
  } else if (e.key === "Escape") {
    showResults([]);
  }
});
q.addEventListener("blur", () => setTimeout(() => showResults([]), 100));

renderPoints();
$("compare").addEventListener("click", startCompare);
for (const btn of $("mapKind").querySelectorAll("button")) btn.addEventListener("click", () => setSource(btn.dataset.kind as Source));
for (const btn of $("compareMode").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    const m = btn.dataset.mode as CompareMode;
    if (m === compareMode) return;
    compareMode = m;
    renderPoints();
    settingsChanged();
    if (m === "diff") track("vergelijken-verschil");
  });
}
$("compareOff").addEventListener("click", (e) => {
  e.stopPropagation(); // niet ook rij B kiezen
  stopCompare();
});
// bij vergelijken: klik op een rij om te kiezen welk punt de kaart verplaatst
for (const [id, w] of [["rowA", "a"], ["rowB", "b"]] as const) {
  const row = $(id);
  const pick = () => {
    if (!comparing) return;
    editing = w;
    renderPoints();
  };
  row.addEventListener("click", pick);
  row.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
}

// een andere hash (zelf getypt of een geplakte deellink): ontbrekende instellingen worden de standaard
window.addEventListener("hashchange", () => {
  const h = readHash();
  if (!h) return;
  Object.assign(params, DEFAULTS, h.settings);
  syncControls();
  pointB = h.b;
  comparing = pointB !== null;
  compareMode = h.b ? h.mode : "max";
  source = h.source;
  editing = comparing ? "b" : "a";
  setOrigin(h.origin.lat, h.origin.lon, h.origin.name, "a");
  if (!fitBoth(true)) map.flyTo({ center: [h.origin.lon, h.origin.lat] });
});
for (const id of ["settings", "about"]) {
  const d = $<HTMLDetailsElement>(id);
  d.addEventListener("toggle", () => d.open && track(id === "about" ? "uitleg-geopend" : "instellingen-geopend"));
}

// ---------- smal scherm: het paneel is een sheet onderaan ----------
// Drie standen: ingeklapt (vertrekpunt en legenda), half (zoeken, voorbeelden, delen, reisinfo)
// en vol (ook instellingen en uitleg). De CSS kijkt naar data-sheet, en alleen onder 640 px.
const panel = $("panel");
type Sheet = "collapsed" | "half" | "full";
const SHEETS: Sheet[] = ["collapsed", "half", "full"];

function setSheet(s: Sheet) {
  panel.dataset.sheet = s;
  if (s !== "full") panel.scrollTop = 0;
}
// via een gedeelde link gaat het om de kaart; bij een eerste bezoek om zoeken en de voorbeelden
setSheet(location.hash ? "collapsed" : "half");

// Slepen aan de greep of de kop: de sheet volgt de vinger, en springt bij loslaten naar de
// dichtstbijzijnde stand (een snelle veeg: een stand verder in die richting). Tikken klapt open of dicht.
const grip = $("grip");
const FLICK = 0.3; // px/ms: sneller dan dit telt als veeg
const NUDGE = 30; // px: wie verder sleept, gaat minstens een stand in die richting
let collapsedH = 120; // gemeten in de ingeklapte stand (hangt af van de tijdregel)
let drag: { id: number; y0: number; h0: number; from: Sheet; moved: boolean; y: number; t: number; v: number } | null = null;

const targetH = (s: Sheet) =>
  s === "collapsed" ? collapsedH : window.innerHeight * (s === "half" ? 0.45 : 0.85);

function dragStart(e: PointerEvent) {
  if (!narrow.matches || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag = { id: e.pointerId, y0: e.clientY, h0: panel.offsetHeight, from: panel.dataset.sheet as Sheet,
    moved: false, y: e.clientY, t: e.timeStamp, v: 0 };
}
function dragMove(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y0;
  if (!drag.moved) {
    if (Math.abs(dy) < 6) return;
    drag.moved = true;
    panel.classList.add("dragging");
    panel.dataset.sheet = "full"; // alle inhoud zichtbaar; de hoogte volgt de vinger
  }
  if (e.timeStamp > drag.t) drag.v = (e.clientY - drag.y) / (e.timeStamp - drag.t);
  drag.y = e.clientY;
  drag.t = e.timeStamp;
  const h = Math.min(targetH("full"), Math.max(collapsedH * 0.8, drag.h0 - dy));
  panel.style.height = panel.style.maxHeight = `${h}px`;
}
function dragEnd(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.moved) {
    setSheet(d.from === "collapsed" ? "half" : "collapsed");
    return;
  }
  const h = panel.offsetHeight;
  const dy = e.clientY - d.y0;
  const i = SHEETS.indexOf(d.from);
  const step = (dir: number) => SHEETS[Math.max(0, Math.min(SHEETS.length - 1, i + dir))];
  let to: Sheet;
  if (e.type === "pointercancel") to = d.from;
  else if (Math.abs(d.v) > FLICK) to = step(d.v < 0 ? 1 : -1);
  else {
    to = SHEETS.reduce((a, b) => (Math.abs(targetH(b) - h) < Math.abs(targetH(a) - h) ? b : a));
    if (to === d.from && Math.abs(dy) > NUDGE) to = step(dy < 0 ? 1 : -1);
  }
  // vanaf de huidige hoogte naar de nieuwe stand laten glijden
  panel.style.height = "";
  panel.style.maxHeight = `${h}px`;
  void panel.offsetHeight;
  panel.classList.remove("dragging");
  setSheet(to);
  requestAnimationFrame(() => (panel.style.maxHeight = ""));
}
for (const zone of [grip, panel.querySelector("header")!]) {
  zone.addEventListener("pointerdown", dragStart);
  zone.addEventListener("pointermove", dragMove);
  zone.addEventListener("pointerup", dragEnd);
  zone.addEventListener("pointercancel", dragEnd);
  // geen nagestuurde klik na een tik: na het inklappen ligt de kaart onder de vinger, en die klik
  // zou daar de reisinfo openen (en de sheet weer half openzetten)
  zone.addEventListener("touchend", (e) => e.cancelable && e.preventDefault(), { passive: false });
}
grip.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  setSheet(panel.dataset.sheet === "collapsed" ? "half" : "collapsed");
});
q.addEventListener("focus", () => narrow.matches && setSheet("full")); // ruimte voor de resultaten boven het toetsenbord

// kaartbediening en meldingen blijven boven de sheet
const setSheetHeight = () => {
  document.documentElement.style.setProperty("--sheet-h", narrow.matches ? `${panel.offsetHeight}px` : "0px");
  if (narrow.matches && !drag && panel.dataset.sheet === "collapsed") collapsedH = panel.offsetHeight;
};
new ResizeObserver(setSheetHeight).observe(panel);
narrow.addEventListener("change", setSheetHeight);

// ---------- desktop: het paneel inklappen (de stand wordt onthouden) ----------
const fold = $("fold");
function setFolded(on: boolean) {
  panel.classList.toggle("folded", on);
  fold.textContent = on ? "»" : "«";
  fold.title = on ? "Paneel uitklappen" : "Paneel inklappen";
  fold.setAttribute("aria-expanded", String(!on));
}
try { setFolded(localStorage.getItem("ovafstand-folded") === "1"); } catch { /* geen opslag: uitgeklapt */ }
fold.addEventListener("click", () => {
  const on = !panel.classList.contains("folded");
  setFolded(on);
  try { localStorage.setItem("ovafstand-folded", on ? "1" : "0"); } catch { /* niet erg */ }
  track(on ? "paneel-ingeklapt" : "paneel-uitgeklapt");
});

// reisinfo na een klik of tik: bovenaan het paneel (op een smal scherm in de sheet), met een markering op de kaart
const info = $("info");
const tapEl = document.createElement("div");
tapEl.className = "tap-marker";
const tapMarker = new Marker({ element: tapEl });

function showInfo(content: HTMLElement, lngLat: [number, number]) {
  const close = document.createElement("button");
  close.className = "close";
  close.setAttribute("aria-label", "Sluiten");
  close.title = "Sluiten (Esc)";
  close.textContent = "×";
  close.onclick = hideInfo;
  const first = info.hidden; // bij bijwerken (tijdschuif, instellingen) de sheet niet verzetten
  info.replaceChildren(close, content);
  info.hidden = false;
  tapMarker.setLngLat(lngLat).addTo(map);
  if (first) {
    setSheet("half");
    panel.scrollTop = 0;
  }
}
function hideInfo() {
  pinAt = null;
  pinPending = false;
  if (info.hidden) return;
  info.hidden = true;
  info.replaceChildren();
  tapMarker.remove();
}

// ---------- voorbeelden, mijn locatie, delen ----------
const CHIPS: [label: string, lat: number, lon: number, name: string][] = [
  ["Amsterdam C", 52.3789, 4.9003, "Amsterdam Centraal"],
  ["Groningen", 53.2105, 6.5641, "Groningen"],
  ["Middelburg", 51.4955, 3.6166, "Middelburg"],
  ["Terschelling", 53.3594, 5.2185, "West-Terschelling"],
  ["Winterswijk", 51.9693, 6.7186, "Winterswijk"],
];
for (const [label, lat, lon, name] of CHIPS) {
  const a = document.createElement("a");
  a.className = "chip";
  a.textContent = label;
  a.href = `#${lat.toFixed(5)},${lon.toFixed(5)},${encodeURIComponent(name)}`; // gewone deellink, ook voor een nieuw tabblad
  a.addEventListener("click", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    ev.preventDefault(); // zo blijven de instellingen staan
    goTo(lat, lon, name);
    track("vertrekpunt-voorbeeld");
  });
  $("chips").append(a);
}

const toastEl = $("toast");
let toastTimer = 0;
function toast(msg: string, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), ms);
}

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Je browser geeft geen locatie door");
  toast("Locatie zoeken…", 10000);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      if (cellOf(lat, lon) < 0) return toast("Je locatie ligt buiten de kaart (Nederland en de grensstreek)");
      toastEl.hidden = true;
      goTo(lat, lon, "", 11);
      track("vertrekpunt-locatie");
    },
    (err) => toast(err.code === err.PERMISSION_DENIED ? "Geen toestemming voor je locatie" : "Je locatie is niet gevonden"),
    { timeout: 10000, maximumAge: 0 },
  );
});

$("share").addEventListener("click", async () => {
  writeHash();
  const url = location.href;
  // op een telefoon het deelmenu van het systeem, op de desktop kopiëren
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try {
      const title = source === "ic" ? "OV-afstand: reistijd naar het dichtstbijzijnde IC-station"
        : comparing && pointB
        ? `OV-afstand: ${pointName(origin)} en ${pointName(pointB)} vergeleken`
        : `OV-afstand vanaf ${pointName(origin)}`;
      await navigator.share({ title, url });
      track("gedeeld-menu");
    } catch { /* geannuleerd */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link gekopieerd");
    track("gedeeld-kopie");
  } catch {
    prompt("Kopieer deze link:", url);
  }
});

if (!supported) {
  const msg = "Je browser is te oud voor deze kaart. Op een iPhone of iPad is iOS 16.4 of nieuwer nodig.";
  $("status").textContent = msg;
  toast(msg, 600000);
}
