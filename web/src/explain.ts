// De reisinfo als HTML: het korte label onder de muis (hoverHtml) en de route na een klik (explainHtml).
// Zonder DOM en zonder de toestand van de pagina: wat nodig is, komt binnen via ExplainCtx.

import { clockSec, esc, fmtMin } from "./format";
import type { Segment } from "./router";
import type { Explained, Response } from "./worker";

export type ExplainMsg = Extract<Response, { type: "explain" }>;

/** de instellingen die de tekst bepalen */
export interface ExplainCtx {
  tMaxMin: number;
  bikeStart: boolean;
  bikeEnd: boolean;
  ic: boolean; // de kaart naar het dichtstbijzijnde IC-station
  diff: boolean; // vergelijken in de stand "Verschil"
}

const MODE: Record<number, string> = { 0: "Tram", 1: "Metro", 2: "Trein", 3: "Bus", 4: "Veerboot", 7: "Kabelbaan" };

function routeLabel(seg: Extract<Segment, { kind: "ride" }>) {
  const [short, type, , long] = seg.route;
  const mode = MODE[type] ?? "OV";
  const name = type === 2 ? short || mode : `${mode} ${short}`;
  return `<b title="${esc(long)}">${esc(name)}</b>`;
}

export function explainHtml(m: ExplainMsg, c: ExplainCtx): string {
  const within = `binnen ${c.tMaxMin / 60} uur`;
  if (m.parts.length === 1) {
    const p = m.parts[0];
    if (p.minutes === null) {
      return `<div class="tt-total">Niet bereikbaar</div><div class="tt-sub">${within}${c.ic ? " van een IC-station" : ""}</div>`;
    }
    if (c.ic) return icHtml(p, c);
    return `<div class="tt-total">${fmtMin(p.minutes)}</div>${leaveHtml(p)}${legsHtml(p, c)}`;
  }
  // vergelijken: de langste van de twee of het verschil (dat is de kleur), daarna elke reis apart
  const mins = m.parts.map((p) => p.minutes);
  const head = c.diff ? `<div class="tt-total">${diffText(mins)}</div><div class="tt-sub">${diffSub(mins, c.tMaxMin)}</div>`
    : mins.every((v) => v !== null)
    ? `<div class="tt-total">${fmtMin(Math.max(...(mins as number[])))}</div><div class="tt-sub">voor jullie allebei (de langste reis)</div>`
    : `<div class="tt-total">Niet voor allebei</div><div class="tt-sub">bereikbaar ${within}</div>`;
  return head + m.parts.map((p, i) => {
    const tag = `<span class="tag ${"ab"[i]}">${"AB"[i]}</span>`;
    return p.minutes === null
      ? `<div class="tt-part">${tag} niet bereikbaar</div>`
      : `<div class="tt-part">${tag} ${fmtMin(p.minutes)}</div>${leaveHtml(p)}${legsHtml(p, c)}`;
  }).join("");
}

/** stand "Verschil": wie is er sneller, en hoeveel (een reis die niet binnen de kleurschaal past: null) */
export function diffText([a, b]: (number | null)[]): string {
  if (a === null && b === null) return "Niet bereikbaar";
  if (a === null || b === null) return `Alleen vanaf ${a === null ? "B" : "A"}`;
  const d = a - b;
  return Math.abs(d) < 0.5 ? "Even snel" : `${fmtMin(Math.abs(d))} sneller vanaf ${d < 0 ? "A" : "B"}`;
}
function diffSub([a, b]: (number | null)[], tMaxMin: number): string {
  if (a !== null && b !== null) return "verschil tussen de twee reizen";
  return a === null && b === null ? `vanaf A en B niet binnen ${tMaxMin / 60} uur`
    : `vanaf ${a === null ? "A" : "B"} niet binnen ${tMaxMin / 60} uur`;
}

/** kort label onder de muis: alleen de minuten */
export function hoverHtml(m: ExplainMsg, c: ExplainCtx): string {
  const mins = m.parts.map((p) => p.minutes);
  const sub = `<div class="tt-sub">klik voor de route</div>`;
  if (mins.length === 1) return mins[0] === null ? `<div class="tt-sub">Niet bereikbaar</div>` : `<b>${fmtMin(mins[0])}</b>${sub}`;
  const each = mins.map((v, i) => `${"AB"[i]} ${v === null ? "–" : fmtMin(v)}`).join(" · ");
  if (c.diff) return `<b>${diffText(mins)}</b> <span class="tt-sub">${each}</span>${sub}`;
  return mins.every((v) => v !== null)
    ? `<b>${fmtMin(Math.max(...(mins as number[])))}</b> <span class="tt-sub">${each}</span>${sub}`
    : `<div class="tt-sub">Niet voor allebei · ${each}</div>`;
}

const leg = (bike: boolean, min: number, to: string) =>
  `<li class="${bike ? "bike" : "walk"}">${bike ? "Fiets" : "Loop"} ${fmtMin(min)} naar ${to}</li>`;

/** IC-kaart: de worker rekent vanaf het station; hier staat de reis andersom, van de plek naar het station */
function icHtml(m: Explained, c: ExplainCtx): string {
  const [first, ...rest] = m.segments; // first: 0 min "fietsen" naar het IC-station waar de zoektocht begon
  if (!first) return "";
  const rows = [leg(c.bikeStart, m.lastBike, esc(rest.length ? rest[rest.length - 1].to : first.to))];
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
function legsHtml(m: Explained, c: ExplainCtx): string {
  const rows: string[] = [];
  for (const s of m.segments) {
    if (s.kind === "bike") { if (s.minutes >= 0.5) rows.push(leg(c.bikeStart, s.minutes, esc(s.to))); }
    else if (s.kind === "walk") { if (s.minutes >= 0.5) rows.push(`<li class="walk">Loop ${fmtMin(s.minutes)} naar ${esc(s.to)}</li>`); }
    else rows.push(rideRow(s));
  }
  // direct (zonder OV) is het hele stuk het eerste stuk
  rows.push(leg(m.segments.length ? c.bikeEnd : c.bikeStart, m.lastBike, "bestemming"));
  return `<ol class="legs">${rows.join("")}</ol>`;
}
