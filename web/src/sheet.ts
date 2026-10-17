// Het paneel: op een smal scherm een sheet onderaan, op de desktop in te klappen.

import { $, narrow, track } from "./ui";

// ---------- smal scherm: het paneel is een sheet onderaan ----------
// Drie standen: ingeklapt (vertrekpunt en legenda), half (zoeken, voorbeelden, delen, reisinfo)
// en vol (ook instellingen en uitleg). De CSS kijkt naar data-sheet, en alleen onder 640 px.
export const panel = $("panel");
type Sheet = "collapsed" | "half" | "full";
const SHEETS: Sheet[] = ["collapsed", "half", "full"];

export function setSheet(s: Sheet) {
  panel.dataset.sheet = s;
  if (s !== "full") panel.scrollTop = 0;
}
// eerst de kaart, met vertrekpunt en legenda eronder; zoeken en de voorbeelden zijn één tik verder
setSheet("collapsed");

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
