// "Laatste kilometer": t(cel) = min( direct fietsen , min over halteplekken s van T(s) + fiets(s, cel) ).
// Elke bereikte halteplek tekent een kegel in een venster rond zich; het raster houdt het minimum.

import { CELL, NX, NY, ROW_SCALE, X0, Y0, mercX, mercY } from "./grid";
import { DETOUR, type Graph, type Params, type Search } from "./router";

export const VIA_DIRECT = -1;
export const VIA_NONE = -2;

export interface Raster {
  time: Float32Array; // minuten, Infinity = niet bereikbaar
  via: Int32Array; // halteplek van de laatste fietsrit, VIA_DIRECT of VIA_NONE
}

function cone(
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

export function rasterize(g: Graph, s: Search, lat: number, lon: number, p: Params): Raster {
  const r: Raster = {
    time: new Float32Array(NX * NY).fill(Infinity),
    via: new Int32Array(NX * NY).fill(VIA_NONE),
  };
  const v = p.bikeKmh / 3.6;
  const tMax = p.tMaxMin * 60;
  cone(r, mercX(lon), mercY(lat), 0, p.directMaxKm * 1000, v, VIA_DIRECT, tMax);
  const bikeMax = p.bikeMaxKm * 1000;
  for (let a = 0; a < g.nArea; a++) {
    const t = s.dist[a];
    if (t >= tMax) continue;
    cone(r, mercX(g.areaLon[a]), mercY(g.areaLat[a]), t, bikeMax, v, a, tMax);
  }
  return r;
}

// Kleurschaal: banden van 15 minuten, van groen (dichtbij) via geel en oranje naar paars (ver)
const RAMP = ["#1a9850", "#66bd63", "#a6d96a", "#d9ef8b", "#fee08b", "#fdae61",
  "#f46d43", "#d73027", "#a50026", "#7b1f5c", "#54278f", "#3f007d"];
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

export function colorize(r: Raster, tMaxMin: number): ImageData {
  const n = Math.ceil(tMaxMin / BAND_MIN);
  const lut = Array.from({ length: n }, (_, b) => bandColor(b, n));
  const img = new ImageData(NX, NY);
  const px = new Uint32Array(img.data.buffer);
  const packed = lut.map(([R, G, B]) => (255 << 24) | (B << 16) | (G << 8) | R); // little endian RGBA
  for (let j = 0; j < NY; j++) {
    const src = j * NX;
    const dst = (NY - 1 - j) * NX; // afbeelding begint bovenaan (noorden)
    for (let i = 0; i < NX; i++) {
      const t = r.time[src + i];
      if (t < tMaxMin) px[dst + i] = packed[Math.floor(t / BAND_MIN)];
    }
  }
  return img;
}
