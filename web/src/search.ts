// Zoeken: eerst de treinstations uit de graaf, daarna adressen en plaatsen via PDOK (geocode.ts).

import { esc } from "./format";
import { geocode, type Place } from "./geocode";
import { setSheet } from "./sheet";
import { $, narrow, track } from "./ui";
import type { Station } from "./worker";

export const q = $<HTMLInputElement>("q");
const results = $<HTMLUListElement>("results");
let abort: AbortController | null = null;
let qTimer = 0;
let shown: Place[] = [];
let active = -1;
let stations: Station[] = [];
let go: (p: Place) => void = () => {};

/** go: naar de gekozen plek (main.ts: goTo) */
export function initSearch(onPick: (p: Place) => void) {
  go = onPick;
}
export function setStations(list: Station[]) {
  stations = list;
}

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
  go(p);
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
q.addEventListener("focus", () => narrow.matches && setSheet("full")); // ruimte voor de resultaten boven het toetsenbord
