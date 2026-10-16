// Tijden, datums en tekst opmaken. Zonder DOM, dus ook in Node te gebruiken (bench/check.ts).

/** minuten na middernacht -> "08:30" */
export const clock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
/** kloktijd van seconden na middernacht (ook na 24:00, bij ritten in de nacht) */
export const clockSec = (sec: number) => clock(Math.round(sec / 60) % 1440);
/** "20261110" -> "10-11-2026" */
export const fmtDate = (d: string) => `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}`;
/** reistijd: "45 min" of "1 u 05" */
export const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} u ${String(Math.round(m % 60)).padStart(2, "0")}`);
/** tekst veilig in HTML */
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
