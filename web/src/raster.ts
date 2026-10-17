// "Laatste kilometer": t(cel) = min( direct fietsen , min over halteplekken s van T(s) + fiets(s, cel) ).
// Elke bereikte halteplek tekent een kegel in een venster rond zich; het raster houdt het minimum.

import { CELL, NX, NY, ROW_SCALE, X0, Y0, mercX, mercY } from "./grid";
import { DETOUR, legs, type Graph, type Params, type Search } from "./router";

// via is een Uint16Array (scheelt 3 MB per raster): de halteplekken moeten onder VIA_DIRECT blijven
export const VIA_DIRECT = 65534;
export const VIA_NONE = 65535;

export interface Raster {
  time: Float32Array; // minuten, Infinity = niet bereikbaar
  via: Uint16Array; // halteplek van de laatste fietsrit, VIA_DIRECT of VIA_NONE
}

export function newRaster(): Raster {
  return {
    time: new Float32Array(NX * NY).fill(Infinity),
    via: new Uint16Array(NX * NY).fill(VIA_NONE),
  };
}

/** hemelsbrede fietskegel (× DETOUR) rond (cx, cy) in mercator-meter, vanaf tijd t0 (s) */
export function cone(
  r: Raster, cx: number, cy: number, t0: number, maxM: number, vMs: number, id: number, tMax: number,
) {
  const { time, via } = r;
  const scale0 = ROW_SCALE[Math.min(NY - 1, Math.max(0, Math.floor((cy - Y0) / CELL)))];
  const rad = Math.min(maxM, (tMax - t0) * vMs) / DETOUR / scale0; // straal in mercator-meter
  const i0 = Math.max(0, Math.floor((cx - rad - X0) / CELL));
  const i1 = Math.min(NX - 1, Math.floor((cx + rad - X0) / CELL));
  const j0 = Math.max(0, Math.floor((cy - rad - Y0) / CELL));
  const j1 = Math.min(NY - 1, Math.floor((cy + rad - Y0) / CELL));
  const k = DETOUR / vMs / 60; // minuten per echte meter hemelsbreed
  const t0m = t0 / 60;
  const maxReal = maxM / DETOUR;
  for (let j = j0; j <= j1; j++) {
    const s = ROW_SCALE[j];
    const dy = (Y0 + (j + 0.5) * CELL - cy) * s;
    const row = j * NX;
    for (let i = i0; i <= i1; i++) {
      const dx = (X0 + (i + 0.5) * CELL - cx) * s;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > maxReal) continue;
      const t = t0m + d * k;
      const c = row + i;
      if (t < time[c]) {
        time[c] = t;
        via[c] = id;
      }
    }
  }
}

/** origin null: alleen vanaf de haltes (de kaart naar het dichtstbijzijnde IC-station) */
export function rasterize(g: Graph, s: Search, origin: { lat: number; lon: number } | null, p: Params): Raster {
  const r = newRaster();
  const { startV, startMax, endV, endMax } = legs(p);
  const tMax = p.tMaxMin * 60;
  if (origin) cone(r, mercX(origin.lon), mercY(origin.lat), 0, startMax, startV, VIA_DIRECT, tMax);
  for (let a = 0; a < g.nArea; a++) {
    const t = s.dist[a];
    if (t >= tMax) continue;
    cone(r, mercX(g.areaLon[a]), mercY(g.areaLat[a]), t, endMax, endV, a, tMax);
  }
  return r;
}

// Kleurschaal: banden van 15 minuten, viridis van geel (dichtbij) via groen en blauw naar paars (ver).
// De helderheid loopt gelijkmatig af, zodat de banden ook bij kleurenblindheid uit elkaar te houden zijn
// (de oude schaal groen-geel-rood: bij rood-groenblindheid waren 30 en 75 min dezelfde kleur).
const RAMP = ["#fde725", "#c2df23", "#86d549", "#52c569", "#2ab07f", "#1e9b8a",
  "#25858e", "#2d708e", "#38588c", "#433e85", "#482173", "#440154"];
export const BAND_MIN = 15;

function hex(c: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
}

/** kleur voor band b van n banden (interpoleert over RAMP, zodat elke tMax de hele schaal gebruikt) */
export function bandColor(b: number, n: number): [number, number, number] {
  const x = n <= 1 ? 0 : (b / (n - 1)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const c0 = hex(RAMP[i]);
  const c1 = hex(RAMP[i + 1]);
  return [0, 1, 2].map((k) => Math.round(c0[k] + (c1[k] - c0[k]) * f)) as [number, number, number];
}

// Verschil A − B (fase 6.5): tweekleurig, bruin = A sneller, petrol = B sneller (BrBG, kleurenblindveilig).
// DIFF_EDGES zijn de grenzen in minuten; onder de eerste is het "ongeveer even snel" (grijs).
export const DIFF_EDGES = [5, 15, 30, 60];
export const DIFF_A = ["#dfc27d", "#bf812d", "#8c510a", "#543005"]; // A sneller, van weinig naar veel
export const DIFF_B = ["#80cdc1", "#35978f", "#01665e", "#003c30"];
export const DIFF_SAME = "#c8c8c8";

/** band voor een verschil d = A − B in minuten: −4..−1 = A sneller, 0 = even snel, 1..4 = B sneller */
export function diffBand(d: number): number {
  const a = Math.abs(d);
  let k = 0;
  while (k < DIFF_EDGES.length && a >= DIFF_EDGES[k]) k++;
  return d < 0 ? -k : k;
}

/** per cel A − B; een punt dat de cel niet binnen tMax haalt, telt als tMax (een ondergrens voor het verschil) */
export function colorizeDiff(a: Float32Array, b: Float32Array, tMaxMin: number): ImageData {
  const img = new ImageData(NX, NY);
  const px = new Uint32Array(img.data.buffer);
  const pack = (c: string) => {
    const [R, G, B] = hex(c);
    return (255 << 24) | (B << 16) | (G << 8) | R;
  };
  const n = DIFF_EDGES.length;
  // index k + n: 0..n−1 = A sneller (sterk naar zwak), n = even snel, n+1..2n = B sneller
  const packed = [...DIFF_A.slice().reverse(), DIFF_SAME, ...DIFF_B].map(pack);
  for (let j = 0; j < NY; j++) {
    const src = j * NX;
    const dst = (NY - 1 - j) * NX;
    for (let i = 0; i < NX; i++) {
      const ta = a[src + i], tb = b[src + i];
      if (ta >= tMaxMin && tb >= tMaxMin) continue;
      px[dst + i] = packed[diffBand(Math.min(ta, tMaxMin) - Math.min(tb, tMaxMin)) + n];
    }
  }
  return img;
}

/** time: minuten per cel (een Raster.time, of bij vergelijken de langste van twee) */
export function colorize(time: Float32Array, tMaxMin: number): ImageData {
  const n = Math.ceil(tMaxMin / BAND_MIN);
  const lut = Array.from({ length: n }, (_, b) => bandColor(b, n));
  const img = new ImageData(NX, NY);
  const px = new Uint32Array(img.data.buffer);
  const packed = lut.map(([R, G, B]) => (255 << 24) | (B << 16) | (G << 8) | R); // little endian RGBA
  for (let j = 0; j < NY; j++) {
    const src = j * NX;
    const dst = (NY - 1 - j) * NX; // afbeelding begint bovenaan (noorden)
    for (let i = 0; i < NX; i++) {
      const t = time[src + i];
      if (t < tMaxMin) px[dst + i] = packed[Math.floor(t / BAND_MIN)];
    }
  }
  return img;
}
