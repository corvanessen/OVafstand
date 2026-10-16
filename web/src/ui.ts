// Kleine hulpjes voor de pagina: elementen opzoeken, smal scherm, meldingen en bezoekers tellen.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const narrow = matchMedia("(max-width: 640px)"); // smal scherm: het paneel is een sheet onderaan

// ---------- bezoekers tellen (GoatCounter, zonder cookies; zie index.html) ----------
// Alleen het soort gebeurtenis, nooit coördinaten of adressen. count.js telt niet op localhost
// en stuurt de hash (met het vertrekpunt) niet mee.
declare global {
  interface Window {
    goatcounter?: { count?: (v: { path: string; title?: string; event?: boolean }) => void };
  }
}
export function track(event: string) {
  window.goatcounter?.count?.({ path: event, event: true });
}

// ---------- melding onderaan ----------
let toastTimer = 0;
export function toast(msg: string, ms = 3000) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}
export const hideToast = () => ($("toast").hidden = true);
