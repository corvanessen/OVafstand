import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { ImageSource, Map as MlMap, Marker, NavigationControl, Popup, ScaleControl, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { LayerSpecification } from "maplibre-gl";
import { geocode, type Place } from "./geocode";
import { CORNERS } from "./grid";
import { BAND_MIN, bandColor } from "./raster";
import type { Params, Segment } from "./router";
import type { Request, Response, Station } from "./worker";

setWorkerUrl(maplibreWorkerUrl);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- instellingen ----------
const params: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180,
};

function bindRange(id: keyof Params, fmt: (v: number) => string) {
  const input = $<HTMLInputElement>(id);
  const out = $<HTMLOutputElement>(id + "Out");
  input.value = String(params[id]);
  out.textContent = fmt(params[id]);
  input.addEventListener("input", () => {
    params[id] = +input.value;
    out.textContent = fmt(params[id]);
    scheduleCompute();
  });
}
bindRange("bikeKmh", (v) => `${v} km/u`);
bindRange("bikeMaxKm", (v) => `${v} km`);
bindRange("directMaxKm", (v) => `${v} km`);
for (const el of document.querySelectorAll<HTMLInputElement>("input[name=model]")) {
  el.checked = +el.value === params.waitFactor;
  el.addEventListener("change", () => {
    params.waitFactor = +el.value;
    scheduleCompute();
  });
}
const tMaxSel = $<HTMLSelectElement>("tMaxMin");
tMaxSel.value = String(params.tMaxMin);
tMaxSel.addEventListener("change", () => {
  params.tMaxMin = +tMaxSel.value;
  renderLegend();
  scheduleCompute();
});

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
renderLegend();

// ---------- vertrekpunt ----------
let origin = readHash() ?? { lat: 52.0894, lon: 5.11, name: "Utrecht Centraal" };

function readHash(): { lat: number; lon: number; name: string } | null {
  const m = /^#([-\d.]+),([-\d.]+)(?:,(.*))?$/.exec(location.hash);
  return m ? { lat: +m[1], lon: +m[2], name: m[3] ? decodeURIComponent(m[3]) : "" } : null;
}

function setOrigin(lat: number, lon: number, name = "") {
  origin = { lat, lon, name };
  marker.setLngLat([lon, lat]);
  history.replaceState(null, "", `#${lat.toFixed(5)},${lon.toFixed(5)}${name ? "," + encodeURIComponent(name) : ""}`);
  $("origin").textContent = name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  popup.remove();
  scheduleCompute();
}

// ---------- kaart ----------
const map = new MlMap({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  // via een gedeelde link: centreer op het vertrekpunt
  center: location.hash ? [origin.lon, origin.lat] : [5.3, 52.2],
  zoom: location.hash ? 9 : 7,
  minZoom: 6,
  maxBounds: [[1.5, 49.8], [9.2, 54.4]],
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
  } else if (m.type === "result") {
    busy = false;
    (map.getSource("heat") as ImageSource).updateImage({ image: m.bitmap });
    $("status").textContent =
      `${m.reached.toLocaleString("nl")} haltes binnen ${params.tMaxMin / 60} uur · ` +
      `netwerk ${m.msRoute.toFixed(0)} ms · kaart ${m.msRaster.toFixed(0)} ms`;
    $("app").classList.remove("loading");
    if (pending) compute();
  } else if (m.type === "explain") {
    onExplain(m);
  } else if (m.type === "error") {
    busy = false;
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
  if (explainBusy || !workerReady || !explainTarget || explainTarget === explainSent) return;
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
    tooltip.innerHTML = explainHtml(m);
    tooltip.hidden = false;
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

map.on("mousemove", (e) => {
  tooltip.style.transform = `translate(${e.point.x + 16}px, ${e.point.y + 16}px)`;
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
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 8.5) });
  setOrigin(p.lat, p.lon, p.name);
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
window.addEventListener("hashchange", () => {
  const h = readHash();
  if (h) {
    setOrigin(h.lat, h.lon, h.name);
    map.flyTo({ center: [h.lon, h.lat] });
  }
});
if (matchMedia("(max-width: 640px)").matches) $("panel").classList.add("collapsed");
$("panelToggle").addEventListener("click", () => $("panel").classList.toggle("collapsed"));
