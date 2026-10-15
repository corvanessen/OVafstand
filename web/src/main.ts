// De pagina: kaart, punten A en B, het verkeer met de worker en de reisinfo. De rest staat in eigen modules:
// state (toestand), hash (deellink), controls (instellingen), playback (afspelen), chart (diagram),
// legend, explain (reisinfo als HTML), search (zoeken), sheet (paneel), ui en format (hulpjes).
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { ImageSource, Map as MlMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { LayerSpecification } from "maplibre-gl";
import { checkProfile, initChart, onProfile, pumpProfile } from "./chart";
import { dayDates, initControls, setBikeAvailable, syncControls, syncTime } from "./controls";
import { explainHtml, hoverHtml, type ExplainCtx, type ExplainMsg } from "./explain";
import { fmtDate } from "./format";
import { CORNERS, cellOf } from "./grid";
import { readHash, writeHash } from "./hash";
import { renderLegend } from "./legend";
import { frameFailed, framesPending, initPlayback, onFrame, restartFrames, stopPlaying, type ResultMsg } from "./playback";
import { DIFF_EDGES } from "./raster";
import { initSearch, q, setStations } from "./search";
import { panel, setSheet } from "./sheet";
import { DEFAULTS, diffShown, params, pointName, points, state, type Which } from "./state";
import { $, hideToast, narrow, toast, track } from "./ui";
import type { CompareMode, Request, Response, Source } from "./worker";

setWorkerUrl(maplibreWorkerUrl);

// ---------- de modules aan elkaar knopen ----------
initControls(settingsChanged);
initPlayback({
  request: requestFrame,
  show: (f) => {
    syncTime();
    writeHash();
    showResult(f, true);
  },
});
initChart({
  send: (m) => send(m),
  idle: () => workerReady && !busy && !framesPending(),
  pick: (min) => {
    stopPlaying();
    params.departMin = min;
    syncTime();
    settingsChanged();
  },
});
initSearch((p) => goTo(p.lat, p.lon, p.name));

function settingsChanged() {
  writeHash();
  scheduleCompute();
  afterChange();
}
/** tijdens afspelen gelden de frames die al klaarstaan niet meer; het diagram misschien ook niet */
function afterChange() {
  restartFrames();
  checkProfile();
}

// ---------- vertrekpunt (uit de deellink) ----------
const initial = readHash();
if (initial) {
  state.origin = initial.origin;
  Object.assign(params, initial.settings);
  state.pointB = initial.b;
  state.comparing = initial.b !== null;
  state.compareMode = initial.b ? initial.mode : "max";
  state.source = initial.source;
}
state.editing = state.comparing ? "b" : "a";
syncControls();

function setOrigin(lat: number, lon: number, name = "", which = state.editing) {
  if (which === "b") state.pointB = { lat, lon, name };
  else state.origin = { lat, lon, name };
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
  const { origin, pointB, comparing, compareMode, editing } = state;
  const ic = state.source === "ic";
  for (const btn of $("mapKind").querySelectorAll("button")) btn.setAttribute("aria-pressed", String(btn.dataset.kind === state.source));
  $("icNote").hidden = !ic;
  $("icNote").innerHTML = "<b>Naar het dichtstbijzijnde IC-station:</b> de kleur is de reistijd van elke plek naar het IC-station " +
    `dat het snelst te bereiken is${state.nIc ? ` (${state.nIc} stations)` : ""}. Het stuk vanaf de plek zelf volgt "Fiets bij vertrek".`;
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
  state.comparing = true;
  state.editing = "b";
  track("vergelijken-gestart");
  renderPoints();
  // op een telefoon geen toetsenbord over de kaart: zoeken of tikken mag allebei
  if (narrow.matches) setSheet("half");
  else q.focus();
}
function stopCompare() {
  state.comparing = false;
  state.pointB = null;
  state.compareMode = "max";
  state.editing = "a";
  writeHash();
  renderPoints();
  scheduleCompute();
  afterChange();
}

/** de soort kaart kiezen: vanaf het vertrekpunt, of naar het dichtstbijzijnde IC-station */
function setSource(s: Source) {
  if (s === state.source) return;
  state.source = s;
  if (s === "ic") track("kaart-ic");
  hideInfo();
  renderPoints();
  settingsChanged();
}

/** naar een plek vliegen en daar vertrekken (zoeken, voorbeelden, mijn locatie);
 *  bij de IC-kaart alleen erheen, met de reisinfo van die plek */
function goTo(lat: number, lon: number, name = "", zoom = 8.5) {
  if (state.source === "ic") {
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
  const { origin, pointB } = state;
  if (state.source !== "point" || !state.comparing || !pointB) return false;
  const pad = narrow.matches ? 40 : { top: 60, bottom: 60, right: 60, left: panel.offsetWidth + 60 };
  map.fitBounds([[Math.min(origin.lon, pointB.lon), Math.min(origin.lat, pointB.lat)],
    [Math.max(origin.lon, pointB.lon), Math.max(origin.lat, pointB.lat)]], { padding: pad, maxZoom: 11, animate });
  return true;
}

// ---------- kaart ----------
const map = new MlMap({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron",
  // via een gedeelde link: centreer op het vertrekpunt
  center: location.hash ? [state.origin.lon, state.origin.lat] : [5.3, 52.2],
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
const marker = new Marker({ element: markerEl, draggable: true }).setLngLat([state.origin.lon, state.origin.lat]).addTo(map);
marker.on("dragend", () => {
  const p = marker.getLngLat();
  if (state.comparing) state.editing = "a";
  setOrigin(p.lat, p.lng, "", "a");
  track("vertrekpunt-slepen");
});
const markerBEl = document.createElement("div");
markerBEl.className = "origin-marker lettered b";
markerBEl.textContent = "B";
const markerB = new Marker({ element: markerBEl, draggable: true }).setLngLat([0, 0]);
markerB.on("dragend", () => {
  const p = markerB.getLngLat();
  state.editing = "b";
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

// ---------- heatmap: twee lagen die in elkaar overvloeien ----------
const HEAT = ["heat0", "heat1"];
const HEAT_OPACITY = 0.72;
const FADE_MS = 400; // overgang tussen twee frames
const FADE_STEP_MS = 50;
let heatFront = 0;
let fadeRaf = 0;

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
    : state.source === "ic" ? `${nl(state.nIc)} IC-stations · ${nl(m.reached)} haltes binnen ${params.tMaxMin / 60} uur`
    : `${nl(m.reached)} haltes ${points().b ? "voor allebei " : ""}binnen ${params.tMaxMin / 60} uur`;
  $("status").textContent = reached + " · " +
    `netwerk ${m.msRoute.toFixed(0)} ms · kaart ${m.msRaster.toFixed(0)} ms` +
    (params.realBike && !state.bikeLoaded ? " · fietsraster laden…" : "");
  const legNote = params.bikeStart === params.bikeEnd ? (params.bikeStart ? "fiets heen en terug" : "lopen van en naar de halte")
    : params.bikeStart ? "fiets bij vertrek, lopen bij aankomst" : "lopen bij vertrek, fiets bij aankomst";
  $("bikeNote").textContent = legNote + " · " + (m.bike ? "over de weg (OpenStreetMap)" : "afstand hemelsbreed × 1,3");
  hasResult = true;
  // het beeld is anders: het label en de vastgezette reisinfo opnieuw laten uitrekenen
  hoverSent = null;
  if (pinAt) pinPending = true;
  flushExplain();
}

// ---------- worker ----------
// Een berekening is de gewone kaart ("view", één tegelijk) of een frame dat tijdens afspelen vooruit
// wordt gerekend; het diagram vraagt "profile" als de worker verder niets te doen heeft.
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (m: Request) => worker.postMessage(m);
let workerReady = false;
let mapReady = false;
let hasResult = false; // de worker kan pas een route uitleggen na de eerste berekening
let computeId = 0;
let busy = false;
let pending = false;
const requests = new Map<number, { kind: "view" } | { kind: "frame"; min: number; gen: number }>();
let shownId = 0; // het resultaat in beeld: daarover gaat de tooltip

worker.onmessage = (ev: MessageEvent<Response>) => {
  const m = ev.data;
  if (m.type === "ready") {
    workerReady = true;
    setStations(m.stations);
    state.nIc = m.nIc;
    renderPoints();
    $("dataDate").textContent = fmtDate(m.date);
    for (const day of m.days) dayDates.set(day.key, day.date);
    if (!dayDates.has(params.day)) params.day = "wd"; // een deellink met een dag die deze data niet heeft
    syncTime();
    scheduleCompute();
  } else if (m.type === "bikeReady") {
    state.bikeLoaded = m.ok;
    setBikeAvailable(m.ok);
    if (m.ok && params.realBike) scheduleCompute();
    checkProfile();
  } else if (m.type === "result") {
    const req = requests.get(m.id);
    requests.delete(m.id);
    if (req?.kind === "frame") onFrame(req.min, req.gen, m);
    else {
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
    onError(m);
  }
};
/** een mislukt verzoek uit de wachtrij halen, zodat de kaart, het afspelen en het diagram doorlopen */
function onError(m: Extract<Response, { type: "error" }>) {
  const of = m.of;
  // de statusregel gaat over de kaart; een fout op de achtergrond (diagram, reisinfo) alleen in de console
  const req = of.type === "compute" ? requests.get(of.id) : undefined;
  if (of.type === "init" || (of.type === "compute" && req?.kind !== "frame")) $("status").textContent = "Fout: " + m.message;
  else console.warn(`worker (${of.type}):`, m.message);
  if (of.type === "compute") {
    requests.delete(of.id);
    if (req?.kind === "frame") frameFailed(req.min);
    else {
      busy = false;
      $("app").classList.remove("loading");
      if (pending) compute();
    }
  } else if (of.type === "profile") {
    onProfile({ type: "profile", gen: of.gen, departMin: of.departMin, km2: NaN });
  } else if (of.type === "explain") {
    explainBusy = null;
    flushExplain();
  }
  pumpProfile();
}
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
  send({ type: "compute", id, ...points(), mode: state.compareMode, params: { ...params } });
}
/** een frame voor het afspelen: dezelfde instellingen, een andere vertrektijd */
function requestFrame(min: number, gen: number) {
  const id = ++computeId;
  requests.set(id, { kind: "frame", min, gen });
  send({ type: "compute", id, ...points(), mode: state.compareMode, params: { ...params, departMin: min } });
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

const explainCtx = (): ExplainCtx => ({
  tMaxMin: params.tMaxMin, bikeStart: params.bikeStart, bikeEnd: params.bikeEnd,
  ic: state.source === "ic", diff: diffShown(),
});

function onExplain(m: ExplainMsg) {
  const via = explainBusy;
  explainBusy = null;
  if (via === "hover" && hoverAt === hoverSent && lastPointerType !== "touch") {
    tooltip.innerHTML = hoverHtml(m, explainCtx());
    tooltip.hidden = false;
    placeTooltip(); // de grootte kan veranderd zijn
  } else if (via === "pin" && pinAt && !pinPending) {
    const at = pinAt;
    const box = document.createElement("div");
    box.innerHTML = explainHtml(m, explainCtx());
    const btn = document.createElement("button");
    btn.className = "btn";
    // het punt van het label, ook als daarna een andere rij gekozen is
    const which = state.editing;
    const fromIc = state.source === "ic";
    btn.textContent = state.comparing && !fromIc ? `Punt ${which.toUpperCase()} hierheen` : "Vertrek vanaf hier";
    btn.onclick = () => {
      // vanaf de IC-kaart: terug naar de gewone kaart, met hier het vertrekpunt (A)
      if (fromIc) {
        state.source = "point";
        if (state.comparing) state.editing = "a";
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

// ---------- punten A en B, soort kaart ----------
renderPoints();
$("compare").addEventListener("click", startCompare);
for (const btn of $("mapKind").querySelectorAll("button")) btn.addEventListener("click", () => setSource(btn.dataset.kind as Source));
for (const btn of $("compareMode").querySelectorAll("button")) {
  btn.addEventListener("click", () => {
    const m = btn.dataset.mode as CompareMode;
    if (m === state.compareMode) return;
    state.compareMode = m;
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
for (const [id, w] of [["rowA", "a"], ["rowB", "b"]] as [string, Which][]) {
  const row = $(id);
  const pick = () => {
    if (!state.comparing) return;
    state.editing = w;
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
  state.pointB = h.b;
  state.comparing = h.b !== null;
  state.compareMode = h.b ? h.mode : "max";
  state.source = h.source;
  state.editing = state.comparing ? "b" : "a";
  setOrigin(h.origin.lat, h.origin.lon, h.origin.name, "a");
  if (!fitBoth(true)) map.flyTo({ center: [h.origin.lon, h.origin.lat] });
});
for (const id of ["settings", "about"]) {
  const d = $<HTMLDetailsElement>(id);
  d.addEventListener("toggle", () => d.open && track(id === "about" ? "uitleg-geopend" : "instellingen-geopend"));
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

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return toast("Je browser geeft geen locatie door");
  toast("Locatie zoeken…", 10000);
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      if (cellOf(lat, lon) < 0) return toast("Je locatie ligt buiten de kaart (Nederland en de grensstreek)");
      hideToast();
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
      const { origin, pointB } = state;
      const title = state.source === "ic" ? "OV-afstand: reistijd naar het dichtstbijzijnde IC-station"
        : state.comparing && pointB
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
