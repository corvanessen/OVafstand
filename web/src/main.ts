import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { ImageSource, Map as MlMap, Marker, NavigationControl, Popup, ScaleControl, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { LayerSpecification } from "maplibre-gl";
import { geocode, type Place } from "./geocode";
import { CORNERS, cellOf } from "./grid";
import { BAND_MIN, bandColor } from "./raster";
import type { Params, Segment } from "./router";
import type { Request, Response, Station } from "./worker";

setWorkerUrl(maplibreWorkerUrl);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- instellingen ----------
const DEFAULTS: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true,
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
tMaxSel.addEventListener("change", () => {
  params.tMaxMin = +tMaxSel.value;
  renderLegend();
  settingsChanged();
});

/** zet alle invoervelden op de waarden in params */
function syncControls() {
  for (const [id, fmt] of RANGES) {
    $<HTMLInputElement>(id).value = String(params[id]);
    $(id + "Out").textContent = fmt(params[id]);
  }
  for (const el of modelRadios) el.checked = +el.value === params.waitFactor;
  realBikeBox.checked = params.realBike;
  tMaxSel.value = String(params.tMaxMin);
  renderLegend();
}

function settingsChanged() {
  writeHash();
  scheduleCompute();
}

function renderLegend() {
  const n = Math.ceil(params.tMaxMin / BAND_MIN);
  const el = $("legend");
  el.innerHTML = "";
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

// ---------- deellink: #lat,lon,naam&w=0.5&v=15&b=5&d=15&t=180&f=1 ----------
// Alleen afwijkingen van de standaard komen in de link; onbekende of ongeldige waarden worden genegeerd.
const HASH_KEYS = { w: "waitFactor", v: "bikeKmh", b: "bikeMaxKm", d: "directMaxKm", t: "tMaxMin", f: "realBike" } as const;
type HashParam = (typeof HASH_KEYS)[keyof typeof HASH_KEYS];
type Origin = { lat: number; lon: number; name: string };

/** een waarde uit de link, alleen als het bijbehorende invoerveld hem ook kan tonen */
function parseSetting(key: HashParam, raw: string): number | boolean | null {
  const v = Number(raw);
  if (raw === "" || !Number.isFinite(v)) return null;
  if (key === "realBike") return v === 0 || v === 1 ? v === 1 : null;
  if (key === "waitFactor") return modelRadios.some((r) => +r.value === v) ? v : null;
  if (key === "tMaxMin") return [...tMaxSel.options].some((o) => +o.value === v) ? v : null;
  const input = $<HTMLInputElement>(key);
  const steps = (v - +input.min) / +input.step;
  return v >= +input.min && v <= +input.max && Math.abs(steps - Math.round(steps)) < 1e-6 ? v : null;
}

function readHash(): { origin: Origin; settings: Partial<Params> } | null {
  // de naam is URL-gecodeerd en bevat dus geen &; daarna volgen de instellingen
  const m = /^#([-\d.]+),([-\d.]+)(?:,([^&]*))?(.*)$/.exec(location.hash);
  if (!m || !Number.isFinite(+m[1]) || !Number.isFinite(+m[2])) return null;
  let name = "";
  try {
    name = m[3] ? decodeURIComponent(m[3]) : "";
  } catch { /* kapotte codering: zonder naam verder */ }
  const settings: Record<string, number | boolean> = {};
  for (const part of m[4].split("&")) {
    const [k, raw] = part.split("=");
    const key = HASH_KEYS[k as keyof typeof HASH_KEYS];
    const v = key && raw !== undefined ? parseSetting(key, raw) : null;
    if (v !== null) settings[key] = v;
  }
  return { origin: { lat: +m[1], lon: +m[2], name }, settings: settings as Partial<Params> };
}

function writeHash() {
  const { lat, lon, name } = origin;
  let h = `#${lat.toFixed(5)},${lon.toFixed(5)}${name ? "," + encodeURIComponent(name) : ""}`;
  for (const [k, key] of Object.entries(HASH_KEYS)) {
    const v = params[key];
    if (v !== DEFAULTS[key]) h += `&${k}=${typeof v === "boolean" ? +v : v}`;
  }
  history.replaceState(null, "", h);
}

// ---------- vertrekpunt ----------
const initial = readHash();
let origin: Origin = initial?.origin ?? { lat: 52.0894, lon: 5.11, name: "Utrecht Centraal" };
Object.assign(params, initial?.settings);
syncControls();

function setOrigin(lat: number, lon: number, name = "") {
  origin = { lat, lon, name };
  marker.setLngLat([lon, lat]);
  writeHash();
  $("origin").textContent = name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  popup.remove();
  scheduleCompute();
}

/** naar een plek vliegen en daar vertrekken (zoeken, voorbeelden, mijn locatie) */
function goTo(lat: number, lon: number, name = "", zoom = 8.5) {
  map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom) });
  setOrigin(lat, lon, name);
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
map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");

const markerEl = document.createElement("div");
markerEl.className = "origin-marker";
const marker = new Marker({ element: markerEl, draggable: true }).setLngLat([origin.lon, origin.lat]).addTo(map);
marker.on("dragend", () => {
  const p = marker.getLngLat();
  setOrigin(p.lat, p.lng);
});

const popup = new Popup({ closeButton: true, maxWidth: "320px", className: "route-popup" });

map.on("load", () => {
  const layers = map.getStyle().layers;
  // de heatmap komt onder wegen en labels; daarboven een kopie van het water,
  // zodat de fietskegels niet over zee en meren doorlopen
  const firstRoad = layers.find((l) => "source-layer" in l && l["source-layer"] === "transportation")?.id;
  map.addSource("heat", { type: "image", coordinates: CORNERS });
  map.addLayer({
    id: "heat", type: "raster", source: "heat",
    paint: { "raster-opacity": 0.72, "raster-resampling": "linear", "raster-fade-duration": 0 },
  }, firstRoad);
  for (const l of layers) {
    if (l.type === "fill" && "source-layer" in l && l["source-layer"] === "water") {
      map.addLayer({ ...(l as LayerSpecification), id: l.id + "-mask" } as LayerSpecification, firstRoad);
    }
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

worker.onmessage = (ev: MessageEvent<Response>) => {
  const m = ev.data;
  if (m.type === "ready") {
    workerReady = true;
    stations = m.stations;
    const d = m.date;
    $("dataDate").textContent = `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`;
    scheduleCompute();
  } else if (m.type === "bikeReady") {
    bikeLoaded = m.ok;
    realBikeBox.disabled = !m.ok;
    if (!m.ok) realBikeBox.parentElement!.title = "Fietsraster niet beschikbaar";
    if (m.ok && params.realBike) scheduleCompute();
  } else if (m.type === "result") {
    busy = false;
    (map.getSource("heat") as ImageSource).updateImage({ image: m.bitmap });
    $("status").textContent =
      `${m.reached.toLocaleString("nl")} haltes binnen ${params.tMaxMin / 60} uur · ` +
      `netwerk ${m.msRoute.toFixed(0)} ms · kaart ${m.msRaster.toFixed(0)} ms` +
      (params.realBike && !bikeLoaded ? " · fietsraster laden…" : "");
    $("bikeNote").textContent = m.bike ? "fietsen over de weg (OpenStreetMap)" : "fietsafstand hemelsbreed × 1,3";
    $("app").classList.remove("loading");
    hasResult = true;
    flushExplain();
    if (pending) compute();
  } else if (m.type === "explain") {
    onExplain(m);
  } else if (m.type === "error") {
    busy = false;
    explainBusy = false;
    $("status").textContent = "Fout: " + m.message;
  }
};
send({ type: "init", base: new URL("data/", document.baseURI).href });

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
  send({ type: "compute", id: ++computeId, lat: origin.lat, lon: origin.lon, params: { ...params } });
}

// ---------- reistijd onder de muis / bij tikken ----------
const tooltip = $("tooltip");
let explainId = 0;
type ExplainTarget = { lat: number; lon: number; via: "hover" | "popup" };
let explainTarget: ExplainTarget | null = null;
let explainBusy = false;

let explainSent: ExplainTarget | null = null;

function requestExplain(lat: number, lon: number, via: "hover" | "popup") {
  explainTarget = { lat, lon, via };
  flushExplain();
}

/** hooguit één verzoek tegelijk; tussentijdse muisposities worden overgeslagen */
function flushExplain() {
  if (explainBusy || !hasResult || !explainTarget || explainTarget === explainSent) return;
  explainBusy = true;
  explainSent = explainTarget;
  send({ type: "explain", id: ++explainId, lat: explainTarget.lat, lon: explainTarget.lon });
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
  if (m.minutes === null) return `<div class="tt-total">Niet bereikbaar</div><div class="tt-sub">binnen ${params.tMaxMin / 60} uur</div>`;
  const rows: string[] = [];
  for (const s of m.segments) {
    if (s.kind === "bike") { if (s.minutes >= 0.5) rows.push(`<li class="bike">Fiets ${fmtMin(s.minutes)} naar ${esc(s.to)}</li>`); }
    else if (s.kind === "walk") rows.push(`<li class="walk">Loop ${fmtMin(s.minutes)} naar ${esc(s.to)}</li>`);
    else {
      const wait = s.wait >= 0.5 ? ` <span class="wait">+${Math.round(s.wait)} wacht</span>` : "";
      rows.push(`<li class="ride t${s.route[1]}">${routeLabel(s)} ${fmtMin(s.minutes)}${wait}<br><small>${esc(s.from)} → ${esc(s.to)}</small></li>`);
    }
  }
  rows.push(`<li class="bike">Fiets ${fmtMin(m.lastBike)} naar bestemming</li>`);
  return `<div class="tt-total">${fmtMin(m.minutes)}</div><ol class="legs">${rows.join("")}</ol>`;
}

let lastPopupLngLat: [number, number] = [0, 0];

function onExplain(m: Extract<Response, { type: "explain" }>) {
  explainBusy = false;
  const t = explainSent;
  if (explainTarget !== explainSent) {
    flushExplain(); // er is intussen een nieuwere positie
    if (explainTarget?.via === "hover") return;
  }
  if (t?.via === "hover") {
    if (lastPointerType === "touch") return;
    tooltip.innerHTML = explainHtml(m);
    tooltip.hidden = false;
    placeTooltip(); // de grootte kan veranderd zijn
  } else if (t?.via === "popup") {
    const box = document.createElement("div");
    box.innerHTML = explainHtml(m);
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = "Vertrek vanaf hier";
    btn.onclick = () => setOrigin(lastPopupLngLat[1], lastPopupLngLat[0]);
    box.append(btn);
    popup.setLngLat(lastPopupLngLat).setDOMContent(box).addTo(map);
    explainTarget = null;
  }
}

// na een tik stuurt de browser een nagebootste mousemove; die mag geen hover-tooltip
// openen, anders staat dezelfde reisinformatie dubbel in beeld (tooltip én popup)
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
  requestExplain(e.lngLat.lat, e.lngLat.lng, "hover");
});
map.getCanvas().addEventListener("mouseleave", () => (tooltip.hidden = true));
map.on("click", (e) => {
  if ((e.originalEvent as PointerEvent).pointerType === "touch") {
    // op een touchscreen: tik = reistijd bekijken, met een knop om daarvandaan te vertrekken
    lastPopupLngLat = [e.lngLat.lng, e.lngLat.lat];
    requestExplain(e.lngLat.lat, e.lngLat.lng, "popup");
  } else {
    setOrigin(e.lngLat.lat, e.lngLat.lng);
  }
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

$("origin").textContent = origin.name || `${origin.lat.toFixed(4)}, ${origin.lon.toFixed(4)}`;
// een andere hash (zelf getypt of een geplakte deellink): ontbrekende instellingen worden de standaard
window.addEventListener("hashchange", () => {
  const h = readHash();
  if (!h) return;
  Object.assign(params, DEFAULTS, h.settings);
  syncControls();
  setOrigin(h.origin.lat, h.origin.lon, h.origin.name);
  map.flyTo({ center: [h.origin.lon, h.origin.lat] });
});
if (matchMedia("(max-width: 640px)").matches) $("panel").classList.add("collapsed");
$("panelToggle").addEventListener("click", () => $("panel").classList.toggle("collapsed"));

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
      await navigator.share({ title: `OV-afstand vanaf ${$("origin").textContent}`, url });
    } catch { /* geannuleerd */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link gekopieerd");
  } catch {
    prompt("Kopieer deze link:", url);
  }
});
