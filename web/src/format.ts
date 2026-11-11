// Tijden, datums en tekst opmaken. Zonder DOM, dus ook in Node te gebruiken (bench/check.ts).

/** minuten na middernacht -> "08:30" */
export const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
/** kloktijd van seconden na middernacht (ook na 24:00, bij ritten in de nacht) */
export const clockSec = (sec: number) => clock(Math.round(sec / 60) % 1440);
/** "20261110" -> "10-11-2026" */
export const fmtDate = (d: string) => `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`;
/** reistijd: "45 min" of "1 u 05" */
export const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} u ${String(Math.round(m % 60)).padStart(2, "0")}`);
/** voetregel onder de kaart: fiets of lopen per stuk, en waarover. grid: "walk" = er is een looptraster,
 *  "road" = alleen het fietsraster, "straight" = hemelsbreed × 1,3 */
export function footNote(bikeStart: boolean, bikeEnd: boolean, grid: "walk" | "road" | "straight"): string {
  const legs = bikeStart === bikeEnd ? (bikeStart ? "fiets heen en terug" : "lopen van en naar de halte")
    : bikeStart ? "fiets bij vertrek, lopen bij aankomst" : "lopen bij vertrek, fiets bij aankomst";
  const walking = !bikeStart || !bikeEnd;
  const how = grid === "straight" ? "afstand hemelsbreed × 1,3"
    : grid === "walk" && walking ? "over de weg en voetpaden (OpenStreetMap)" : "over de weg (OpenStreetMap)";
  return legs + " · " + how;
}
/** allowlist voor een getal uit de deellink: binnen [min, max] en op de stap van de schuif */
export function inRange(v: number, min: number, max: number, step: number): boolean {
  if (!Number.isFinite(v)) return false;
  const steps = (v - min) / step;
  return v >= min && v <= max && Math.abs(steps - Math.round(steps)) < 1e-6;
}
/** tekst veilig in HTML */
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
