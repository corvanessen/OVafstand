// De toestand van de pagina: de instellingen (params) en de punten. Eén plek, zodat alle modules
// hetzelfde zien. params wordt alleen ter plekke aangepast (Object.assign), nooit vervangen.

import type { Day, Params } from "./router";
import type { CompareMode, Source } from "./worker";

export const DEFAULTS: Params = {
  waitFactor: 0.5, waitCapMin: 30, bikeKmh: 15, bikeMaxKm: 5, directMaxKm: 15, tMaxMin: 180, realBike: true, departMin: null,
  bikeStart: true, bikeEnd: false, day: "wd", timetable: false,
};
export const params: Params = { ...DEFAULTS };

export const DAY_NAME: Record<Day, string> = { wd: "Werkdag", za: "Zaterdag", zo: "Zondag" };
export const STEP_MIN = 30; // tijdvak van de tijdschuif, het afspelen en het diagram

export type Origin = { lat: number; lon: number; name: string };
export type Which = "a" | "b";

export const state = {
  origin: { lat: 52.0894, lon: 5.11, name: "Utrecht Centraal" } as Origin,
  // vergelijken (fase 6.5): een tweede punt B; de kaart kleurt naar de langste van de twee reistijden
  // ("Voor ons allebei", "max") of naar het verschil A − B ("Verschil", "diff")
  pointB: null as Origin | null,
  comparing: false,
  compareMode: "max" as CompareMode,
  // fase 6.7 stap 3: de kaart gaat over het vertrekpunt, of over de reistijd naar het dichtstbijzijnde IC-station
  source: "point" as Source,
  editing: "a" as Which, // het punt dat klikken, zoeken en de voorbeelden verplaatsen
  bikeLoaded: false, // het fietsraster komt na de graaf binnen
  nIc: 0, // aantal IC-stations (na "ready")
};

/** de kaart toont het verschil: alleen als B ook gekozen is */
export const diffShown = () =>
  state.source === "point" && state.comparing && state.pointB !== null && state.compareMode === "diff";
export const pointName = (p: Origin) => p.name || `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
/** de punten voor de worker: B alleen als het gekozen is (bij de IC-kaart tellen ze niet) */
export const points = () => ({
  source: state.source,
  a: { lat: state.origin.lat, lon: state.origin.lon },
  b: state.source === "point" && state.comparing && state.pointB ? { lat: state.pointB.lat, lon: state.pointB.lon } : null,
});
