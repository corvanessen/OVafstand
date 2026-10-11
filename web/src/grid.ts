// Rekenraster in Web Mercator, zodat het één-op-één als ImageSource op de kaart past.
// Rijen zijn lineair in mercator-y; de echte celgrootte is ~250 m rond 52° NB.

export const R = 6378137;
export const BBOX = { west: 3.2, south: 50.6, east: 7.4, north: 53.7 };
const CELL_REAL_M = 250;
const LAT_REF = 52.2;

const DEG = Math.PI / 180;
export const mercX = (lon: number) => R * lon * DEG;
export const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
const invLon = (x: number) => x / R / DEG;
const invLat = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG;

export const CELL = CELL_REAL_M / Math.cos(LAT_REF * DEG); // mercator-meter per cel
export const X0 = mercX(BBOX.west);
export const Y0 = mercY(BBOX.south);
export const NX = Math.ceil((mercX(BBOX.east) - X0) / CELL);
export const NY = Math.ceil((mercY(BBOX.north) - Y0) / CELL);

/** echte meters per mercator-meter, per rij (cos van de breedtegraad van het rijmidden) */
export const ROW_SCALE = Float64Array.from({ length: NY }, (_, j) =>
  Math.cos(invLat(Y0 + (j + 0.5) * CELL) * DEG),
);

/** hoekpunten voor de MapLibre ImageSource: linksboven, rechtsboven, rechtsonder, linksonder */
export const CORNERS: [[number, number], [number, number], [number, number], [number, number]] = [
  [invLon(X0), invLat(Y0 + NY * CELL)],
  [invLon(X0 + NX * CELL), invLat(Y0 + NY * CELL)],
  [invLon(X0 + NX * CELL), invLat(Y0)],
  [invLon(X0), invLat(Y0)],
];

/** celindex (rij j vanaf het zuiden), of -1 buiten het raster */
export function cellOf(lat: number, lon: number): number {
  const i = Math.floor((mercX(lon) - X0) / CELL);
  const j = Math.floor((mercY(lat) - Y0) / CELL);
  if (i < 0 || j < 0 || i >= NX || j >= NY) return -1;
  return j * NX + i;
}
