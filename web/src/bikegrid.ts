// Fietsen over de weg: een raster met per cel de wegafstand naar 16 buren (uit OSRM/OSM),
// en Dijkstra over dat raster. Vervangt "hemelsbreed × 1,3" voor fietsen vanaf het vertrekpunt
// en van de laatste halte naar de bestemming. Zie pipeline/export_bike_grid.py voor het formaat
// en ONTWIKKELPLAN.md (fase 3) voor de keuzes en metingen.

import { CELL, NX, NY, ROW_SCALE, X0, Y0, cellOf, mercX, mercY } from "./grid";
import { cone, newRaster, VIA_DIRECT, type Raster } from "./raster";
import { DETOUR, distM, fetchGz, type Graph, type Params, type Search } from "./router";

const NONE = 15; // 4-bitswaarde voor "geen kant" / "geen knoop"
const W = 10; // breedte van een bucket in de wachtrij, seconden
const ORIGIN_R = 2; // vertrekpunt start in de (2R+1)² cellen eromheen
const FILL_M = 750; // cellen zonder weg (weiland, bos) krijgen de tijd van een knoop tot zo ver weg

export interface BikeGrid {
  nNode: number;
  cellOfNode: Int32Array;
  nodeOfCell: Int32Array; // -1 = geen knoop (water, buitenland, ver van een weg)
  snapM: Float32Array; // per knoop: afstand celknoop → celmidden, meter
  // kanten in CSR-vorm (beide richtingen): die van knoop u staan op first[u] .. first[u+1]
  first: Uint32Array;
  nbr: Int32Array;
  lenM: Uint16Array; // echte meters
  // startcellen per halteplek: k = (2R+1)² knopen met de afstand halte → knoop; knoop -1 = geen
  seedK: number;
  seedNode: Int32Array;
  seedDist: Float32Array;
}

/** laadt bike.bin.gz; geeft null als het bestand ontbreekt of niet past (dan blijft het hemelsbrede model over) */
export async function loadBikeGrid(base: string, g: Graph): Promise<BikeGrid | null> {
  const buf = await fetchGz(base + "bike.bin.gz");
  if (!buf) return null;
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 6));
  const nx = dv.getUint16(8, true), ny = dv.getUint16(10, true), nDirs = dv.getUint16(12, true);
  const seedR = dv.getUint16(14, true), nA = dv.getUint32(16, true);
  if (magic !== "FIETS1" || nx !== NX || ny !== NY || nA !== g.nArea) {
    console.warn("bike.bin.gz past niet bij dit raster of deze graaf; hemelsbreed model blijft",
      { magic, nx, ny, nA, nArea: g.nArea });
    return null;
  }
  let p = 20;
  const dirs: [number, number][] = [];
  for (let d = 0; d < nDirs; d++, p += 2) dirs.push([dv.getInt8(p), dv.getInt8(p + 1)]);
  const levels: number[] = [];
  for (let l = 0; l < 15; l++, p += 4) levels.push(dv.getFloat32(p, true));
  const snapStep = dv.getFloat32(p, true);
  const seedStep = dv.getFloat32(p + 4, true);
  p += 8;

  const N = NX * NY;
  const edges = new Uint8Array(buf, p, (N * nDirs) / 2);
  p += edges.length;
  const snaps = new Uint8Array(buf, p, Math.ceil(N / 2));
  p += snaps.length;
  const seeds = new Uint8Array(buf, p, g.nArea * (2 * seedR + 1) ** 2);

  // knopen: cellen met een weg binnen 250 m
  const nibble = (a: Uint8Array, k: number) => (k & 1 ? a[k >> 1] & 15 : a[k >> 1] >> 4);
  const nodeOfCell = new Int32Array(N).fill(-1);
  let nNode = 0;
  for (let c = 0; c < N; c++) if (nibble(snaps, c) !== NONE) nodeOfCell[c] = nNode++;
  const cellOfNode = new Int32Array(nNode);
  const snapM = new Float32Array(nNode);
  for (let c = 0; c < N; c++) {
    const n = nodeOfCell[c];
    if (n < 0) continue;
    cellOfNode[n] = c;
    snapM[n] = nibble(snaps, c) * snapStep;
  }

  // kanten: het bestand heeft er 8 per cel ("vooruit"); de 8 terug zijn dezelfde, vanuit de buur.
  // Eerst tellen, dan vullen (CSR), met de lengte al in echte meters.
  const off = dirs.map(([di, dj]) => dj * NX + di);
  const unit = dirs.map(([di, dj]) => Math.hypot(di, dj) * CELL);
  const deg = new Uint32Array(nNode + 1);
  for (let n = 0; n < nNode; n++) {
    const c = cellOfNode[n];
    for (let d = 0; d < nDirs; d++) {
      if (nibble(edges, c * nDirs + d) === NONE || nodeOfCell[c + off[d]] < 0) continue;
      deg[n]++;
      deg[nodeOfCell[c + off[d]]]++;
    }
  }
  const first = new Uint32Array(nNode + 1);
  for (let n = 0; n < nNode; n++) first[n + 1] = first[n] + deg[n];
  const fill = first.slice(0, nNode);
  const nbr = new Int32Array(first[nNode]);
  const lenM = new Uint16Array(first[nNode]);
  for (let n = 0; n < nNode; n++) {
    const c = cellOfNode[n];
    const scale = ROW_SCALE[Math.floor(c / NX)]; // de kant ligt in de rij van n: mercator-meter → echte meter
    for (let d = 0; d < nDirs; d++) {
      const l = nibble(edges, c * nDirs + d);
      const m = nodeOfCell[c + off[d]];
      if (l === NONE || m < 0) continue;
      const len = Math.min(65535, Math.round(unit[d] * levels[l] * scale));
      nbr[fill[n]] = m;
      lenM[fill[n]++] = len;
      nbr[fill[m]] = n;
      lenM[fill[m]++] = len;
    }
  }

  // startcellen per halteplek, vooraf omgezet naar knopen
  const w = 2 * seedR + 1, seedK = w * w;
  const seedNode = new Int32Array(g.nArea * seedK).fill(-1);
  const seedDist = new Float32Array(g.nArea * seedK);
  for (let a = 0; a < g.nArea; a++) {
    const c0 = cellOf(g.areaLat[a], g.areaLon[a]);
    if (c0 < 0) continue;
    const oi = c0 % NX, oj = Math.floor(c0 / NX);
    for (let dj = -seedR, s = 0; dj <= seedR; dj++) {
      for (let di = -seedR; di <= seedR; di++, s++) {
        const byte = seeds[a * seedK + s];
        if (byte === 255) continue;
        const i = Math.min(NX - 1, Math.max(0, oi + di)), j = Math.min(NY - 1, Math.max(0, oj + dj));
        seedNode[a * seedK + s] = nodeOfCell[j * NX + i];
        seedDist[a * seedK + s] = byte * seedStep;
      }
    }
  }
  return { nNode, cellOfNode, nodeOfCell, snapM, first, nbr, lenM, seedK, seedNode, seedDist };
}

/** Dijkstra-toestand, hergebruikt tussen berekeningen (scheelt geheugen en GC) */
class Run {
  time: Float32Array; // seconden, Infinity = niet bereikt
  bike: Float32Array; // gefietste meters sinds de bron, voor de fietsgrens
  src: Int32Array; // halteplek waar de fietsrit begon, of VIA_DIRECT
  private nxt = new Int32Array(1 << 20);
  private item = new Int32Array(1 << 20);
  private head = new Int32Array(0);
  private n = 0;
  private tMax = 0;

  constructor(nNode: number) {
    this.time = new Float32Array(nNode);
    this.bike = new Float32Array(nNode);
    this.src = new Int32Array(nNode);
  }

  reset(tMax: number) {
    this.time.fill(Infinity);
    this.tMax = tMax;
    const nb = Math.ceil(tMax / W) + 2;
    if (this.head.length < nb) this.head = new Int32Array(nb);
    this.head.fill(-1);
    this.n = 0;
  }

  /** zet een bron neer (alleen als die beter is dan wat er al staat) */
  seed(node: number, t: number, bike: number, src: number) {
    if (t >= this.time[node] || t >= this.tMax) return;
    this.time[node] = t;
    this.bike[node] = bike;
    this.src[node] = src;
    this.push(t, node);
  }

  private push(t: number, node: number) {
    if (this.n === this.nxt.length) {
      const a = new Int32Array(this.n * 2);
      a.set(this.nxt);
      this.nxt = a;
      const b = new Int32Array(this.n * 2);
      b.set(this.item);
      this.item = b;
    }
    const b = (t / W) | 0;
    this.item[this.n] = node;
    this.nxt[this.n] = this.head[b];
    this.head[b] = this.n++;
  }

  /** Dijkstra met een bucketwachtrij (Dial). Binnen een bucket is de volgorde willekeurig;
   *  een knoop die later binnen dezelfde bucket verbetert, wordt gewoon opnieuw verwerkt.
   *  De fietsgrens geldt per label: de eerste bron die een knoop bereikt, bepaalt de gefietste afstand. */
  run(g: BikeGrid, vMs: number, bikeMax: number) {
    const { time, bike, src, head, tMax } = this;
    const { first, nbr, lenM } = g;
    const invV = 1 / vMs;
    for (let b = 0; b < head.length; b++) {
      while (head[b] !== -1) {
        const e = head[b];
        head[b] = this.nxt[e];
        const u = this.item[e];
        const t0 = time[u];
        if (((t0 / W) | 0) !== b) continue; // verouderd: intussen in een eerdere bucket verwerkt
        const b0 = bike[u];
        const s0 = src[u];
        for (let k = first[u], end = first[u + 1]; k < end; k++) {
          const m = lenM[k];
          const bb = b0 + m;
          if (bb > bikeMax) continue;
          const t = t0 + m * invV;
          const w = nbr[k];
          if (t < time[w] && t < tMax) {
            time[w] = t;
            bike[w] = bb;
            src[w] = s0;
            this.push(t, w);
          }
        }
      }
    }
  }
}

let fromOrigin: Run | null = null;
let fromStops: Run | null = null;

/** middelpunt van cel (i, j) in graden */
function cellCenter(i: number, j: number): [number, number] {
  const x = X0 + (i + 0.5) * CELL, y = Y0 + (j + 0.5) * CELL;
  return [(2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI), (x / 6378137) * (180 / Math.PI)];
}

/** Stap 1: fietsen vanaf het vertrekpunt over het raster (grens directMaxKm).
 *  Geeft per halteplek de begintijd voor de OV-zoektocht (Infinity = niet bereikbaar). */
export function originAccess(bg: BikeGrid, g: Graph, lat: number, lon: number, p: Params): Float64Array {
  fromOrigin ??= new Run(bg.nNode);
  const r = fromOrigin;
  const v = p.bikeKmh / 3.6;
  const directMax = p.directMaxKm * 1000;
  r.reset(p.tMaxMin * 60);
  // het vertrekpunt kan overal liggen: start in de cellen eromheen, hemelsbreed × 1,3 naar het celmidden
  const oi = Math.floor((mercX(lon) - X0) / CELL), oj = Math.floor((mercY(lat) - Y0) / CELL);
  for (let dj = -ORIGIN_R; dj <= ORIGIN_R; dj++) {
    for (let di = -ORIGIN_R; di <= ORIGIN_R; di++) {
      const i = oi + di, j = oj + dj;
      if (i < 0 || j < 0 || i >= NX || j >= NY) continue;
      const n = bg.nodeOfCell[j * NX + i];
      if (n < 0) continue;
      const [clat, clon] = cellCenter(i, j);
      const d = distM(lat, lon, clat, clon) * DETOUR + bg.snapM[n];
      r.seed(n, d / v, d, VIA_DIRECT);
    }
  }
  r.run(bg, v, directMax);

  // naar de halteplekken: via hun startcellen (de afstand halte ↔ celknoop geldt beide kanten op)
  const init = new Float64Array(g.nArea).fill(Infinity);
  const { seedK, seedNode, seedDist } = bg;
  for (let a = 0; a < g.nArea; a++) {
    let any = false;
    for (let k = a * seedK, end = k + seedK; k < end; k++) {
      const n = seedNode[k];
      if (n < 0) continue;
      any = true;
      if (r.bike[n] + seedDist[k] > directMax) continue; // ook waar r.time Infinity is: dan geeft min niets
      init[a] = Math.min(init[a], r.time[n] + seedDist[k] / v);
    }
    if (!any) {
      // halte zonder startcellen (buiten het fietsraster): hemelsbreed × 1,3, zoals vroeger
      const d = distM(lat, lon, g.areaLat[a], g.areaLon[a]) * DETOUR;
      if (d <= directMax) init[a] = d / v;
    }
  }
  return init;
}

/** Stap 2: van alle bereikte haltes verder fietsen over het raster (grens bikeMaxKm), en het raster vullen.
 *  Haltes zonder startcellen tekenen nog een hemelsbrede kegel, net als het vertrekpunt buiten het raster. */
export function rasterizeBike(bg: BikeGrid, g: Graph, s: Search, lat: number, lon: number, p: Params): Raster {
  fromStops ??= new Run(bg.nNode);
  const r = fromStops;
  const o = fromOrigin!;
  const v = p.bikeKmh / 3.6;
  const tMax = p.tMaxMin * 60;
  const bikeMax = p.bikeMaxKm * 1000;
  r.reset(tMax);
  const { seedK, seedNode, seedDist } = bg;
  const out = newRaster();
  for (let a = 0; a < g.nArea; a++) {
    const t = s.dist[a];
    if (t >= tMax) continue;
    let any = false;
    for (let k = a * seedK, end = k + seedK; k < end; k++) {
      const n = seedNode[k];
      if (n < 0) continue;
      any = true;
      if (seedDist[k] <= bikeMax) r.seed(n, t + seedDist[k] / v, seedDist[k], a);
    }
    if (!any) cone(out, mercX(g.areaLon[a]), mercY(g.areaLat[a]), t, bikeMax, v, a, tMax);
  }
  r.run(bg, v, bikeMax);

  // knopen → cellen: de snapafstand (celknoop → celmidden) komt er nog bij
  let originOnGrid = false;
  for (let n = 0; n < bg.nNode; n++) {
    const extra = bg.snapM[n] / v;
    const c = bg.cellOfNode[n];
    if (o.time[n] < Infinity) originOnGrid = true;
    const t1 = (o.time[n] + extra) / 60, t2 = (r.time[n] + extra) / 60;
    if (t1 < out.time[c] && t1 <= t2) {
      out.time[c] = t1;
      out.via[c] = VIA_DIRECT;
    } else if (t2 < out.time[c]) {
      out.time[c] = t2;
      out.via[c] = r.src[n];
    }
  }
  if (!originOnGrid) cone(out, mercX(lon), mercY(lat), 0, p.directMaxKm * 1000, v, VIA_DIRECT, tMax);
  fillGaps(bg, out, v);
  return out;
}

let fillDist: Float32Array | null = null;

/** Cellen zonder knoop aanvullen vanuit de buren: afstandstransformatie in twee passes
 *  (8 buren, hemelsbreed × DETOUR), tot FILL_M van de dichtstbijzijnde gevulde cel.
 *  Water wordt ook gevuld, maar dat valt op de kaart onder het watermasker. */
function fillGaps(bg: BikeGrid, r: Raster, vMs: number) {
  const { time, via } = r;
  const { nodeOfCell } = bg;
  const N = NX * NY;
  fillDist ??= new Float32Array(N);
  const fd = fillDist;
  // bron = elke cel met een tijd; knopen zonder tijd zijn niet bereikt en worden ook niet aangevuld
  // (anders ontstaat hemelsbreed alsnog een sluiproute over water of spoor)
  for (let c = 0; c < N; c++) fd[c] = time[c] < Infinity ? 0 : Infinity;
  const k = DETOUR / vMs / 60; // minuten per meter
  for (let pass = 0; pass < 2; pass++) {
    const fwd = pass === 0;
    for (let jj = 0; jj < NY; jj++) {
      const j = fwd ? jj : NY - 1 - jj;
      const s1 = CELL * ROW_SCALE[j], s2 = s1 * Math.SQRT2;
      const dj = fwd ? -1 : 1; // eerdere rij in deze pass
      const hasPrev = fwd ? j > 0 : j < NY - 1;
      for (let ii = 0; ii < NX; ii++) {
        const i = fwd ? ii : NX - 1 - ii;
        const c = j * NX + i;
        if (fd[c] === 0 || nodeOfCell[c] >= 0) continue;
        let bestD = fd[c], bestN = -1;
        const di = fwd ? -1 : 1; // eerdere kolom in deze pass
        // de buren die in deze pass al aan de beurt waren
        if (fwd ? i > 0 : i < NX - 1) {
          const n = c + di;
          if (fd[n] + s1 < bestD) { bestD = fd[n] + s1; bestN = n; }
        }
        if (hasPrev) {
          const r0 = c + dj * NX;
          if (fd[r0] + s1 < bestD) { bestD = fd[r0] + s1; bestN = r0; }
          if (i > 0 && fd[r0 - 1] + s2 < bestD) { bestD = fd[r0 - 1] + s2; bestN = r0 - 1; }
          if (i < NX - 1 && fd[r0 + 1] + s2 < bestD) { bestD = fd[r0 + 1] + s2; bestN = r0 + 1; }
        }
        if (bestN < 0 || bestD > FILL_M) continue;
        fd[c] = bestD;
        const t = time[bestN] + (bestD - fd[bestN]) * k;
        if (t < time[c]) {
          time[c] = t;
          via[c] = via[bestN];
        }
      }
    }
  }
}
