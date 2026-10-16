// Deellink: #lat,lon,naam&w=0.5&v=15&b=5&d=15&t=180&f=1&u=480&r=1&s=1&a=0&dag=za&k=ic&p2=lat,lon,naam&m=diff
// Alleen afwijkingen van de standaard komen in de link; onbekende of ongeldige waarden worden genegeerd.
// p2 is punt B bij vergelijken (b is al de fietsgrens), m=diff de stand "Verschil",
// k=ic de kaart naar het dichtstbijzijnde IC-station (het vertrekpunt blijft erin staan).

import type { Params } from "./router";
import { DEFAULTS, params, state, type Origin } from "./state";
import { $ } from "./ui";
import type { CompareMode, Source } from "./worker";

const HASH_KEYS = {
  w: "waitFactor", v: "bikeKmh", b: "bikeMaxKm", d: "directMaxKm", t: "tMaxMin", f: "realBike", u: "departMin",
  s: "bikeStart", a: "bikeEnd", r: "timetable",
} as const;
type HashParam = (typeof HASH_KEYS)[keyof typeof HASH_KEYS];

/** een waarde uit de link, alleen als het bijbehorende invoerveld hem ook kan tonen */
function parseSetting(key: HashParam, raw: string): number | boolean | null {
  const v = Number(raw);
  if (raw === "" || !Number.isFinite(v)) return null;
  if (key === "realBike" || key === "bikeStart" || key === "bikeEnd" || key === "timetable") return v === 0 || v === 1 ? v === 1 : null;
  if (key === "waitFactor") return [...document.querySelectorAll<HTMLInputElement>("input[name=model]")].some((r) => +r.value === v) ? v : null;
  if (key === "tMaxMin") return [...$<HTMLSelectElement>("tMaxMin").options].some((o) => +o.value === v) ? v : null;
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
export const fmtPoint = ({ lat, lon, name }: Origin) =>
  `${lat.toFixed(5)},${lon.toFixed(5)}${name ? "," + encodeURIComponent(name) : ""}`;

export function readHash(): { origin: Origin; b: Origin | null; mode: CompareMode; source: Source; settings: Partial<Params> } | null {
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

export function writeHash() {
  const { origin, pointB, comparing, compareMode, source } = state;
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
