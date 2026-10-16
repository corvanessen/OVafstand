// De dag afspelen: elk half uur een frame. De worker rekent AHEAD frames vooruit; een frame komt
// in beeld zodra het klaar is en het vorige minstens FRAME_MS te zien was.

import { DAY_NAME, STEP_MIN, params } from "./state";
import { $, track } from "./ui";
import type { Response } from "./worker";

export type ResultMsg = Extract<Response, { type: "result" }>;

const FRAME_MS = 700; // minimale tijd per stap tijdens afspelen
const AHEAD = 2; // frames die tijdens afspelen al klaarstaan of onderweg zijn (de worker bewaart KEEP = AHEAD + 1 resultaten)
const playBtn = $<HTMLButtonElement>("play");
let playing = false;
let playGen = 0; // na een wijziging tellen frames die nog onderweg zijn niet meer
const frames = new Map<number, ResultMsg>(); // vertrektijd -> klaar frame
const framesAsked = new Set<number>();
let lastFrameAt = 0;
let playTimer = 0;

let deps: {
  request: (min: number, gen: number) => void; // een frame laten uitrekenen
  show: (f: ResultMsg) => void; // params.departMin is dan al de tijd van het frame
};
export function initPlayback(d: typeof deps) {
  deps = d;
}

const nextMin = (min: number, k = 1) => (min + k * STEP_MIN) % 1440;
/** frames onderweg: dan wacht het diagram */
export const framesPending = () => framesAsked.size > 0;

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
export function stopPlaying() {
  if (!playing) return;
  setPlaying(false);
  clearTimeout(playTimer);
  dropFrames();
}
playBtn.addEventListener("click", () => (playing ? stopPlaying() : startPlaying()));

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
    deps.request(t, playGen);
  }
}
/** tijdens afspelen gelden de frames die al klaarstaan niet meer na een wijziging */
export function restartFrames() {
  if (!playing) return;
  dropFrames();
  askFrames();
}

/** een frame is terug van de worker */
export function onFrame(min: number, gen: number, m: ResultMsg) {
  framesAsked.delete(min);
  if (gen !== playGen || !playing) m.bitmap.close();
  else {
    frames.set(min, m);
    advance();
  }
}
/** dit frame komt niet: niet blijven wachten */
export function frameFailed(min: number) {
  framesAsked.delete(min);
  stopPlaying();
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
  deps.show(f);
  lastFrameAt = performance.now();
  askFrames();
  playTimer = window.setTimeout(advance, FRAME_MS);
}
