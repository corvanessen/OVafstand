// Fietsen en lopen over de weg: een raster met per cel de wegafstand naar 16 buren (uit OSRM/OSM),
// en Dijkstra over dat raster. Vervangt "hemelsbreed × 1,3" vanaf het vertrekpunt en van de laatste
// halte naar de bestemming. Er zijn twee rasters in hetzelfde formaat: fietsen (bike.bin.gz) en lopen
// (walk.bin.gz, met voetpaden en een grotere startzone per halte). Zonder looptraster gaat lopen over
// het fietsraster. Zie pipeline/export_bike_grid.py voor het formaat en ONTWIKKELPLAN.md (fase 3, en
// "Lopen over voetpaden") voor de keuzes en metingen.

import { CELL, NX, NY, ROW_SCALE, X0, Y0, cellOf, mercX, mercY } from "./grid";
import { cone, newRaster, VIA_DIRECT, type Raster } from "./raster";
import { DETOUR, distM, fetchGz, legs, type Graph, type Params, type Search } from "./router";

const NONE = 15; // 4-bitswaarde voor "geen kant" / "geen knoop"
const W = 10; // breedte van een bucket in de wachtrij, seconden
const ORIGIN_R = 2; // vertrekpunt start in de (2R+1)² cellen eromheen
const FILL_M = 750; // cellen zonder weg (weiland, bos) krijgen de tijd van een knoop tot zo ver weg

export interface BikeGrid {
  nNode: number;
  cellOfNode: Int32Array;
  nodeOfCell: Int32Array; // -1 = geen knoop (water, buitenland, ver van een weg)
  snapM: Float32Array; // per knoop: afstand celknoop → celmidden, meter
  // kanten in CSR-vorm (beide richtingen): die van knoop u staan op first[u] .. first[u+1], één byte per kant:
  // richting (bovenste 4 bits, 0–7 vooruit, 8–15 terug) en lengteniveau (onderste 4). De buur is
  // nodeOfCell[cel + step[richting]], de lengte in echte meters lenTab[rij × 256 + byte] (rij van u).
  first: Uint32Array;
  edge: Uint8Array;
  step: Int32Array;
  lenTab: Uint16Array;
  // startcellen per halteplek: de (2R+1)² = seedK cellen rond de cel van de halte (seedCell, -1 = buiten het
  // raster), cel s op (seedDI[s], seedDJ[s]), aan de rand begrensd. De knoop volgt uit nodeOfCell (seedNodeAt).
  seedK: number;
  seedCell: Int32Array;
  seedDI: Int8Array;
  seedDJ: Int8Array;
  // afstand halte → knoop in stappen, zoals in het bestand (1 byte per startcel, 255 = geen); meters = seedLen[byte]
  seedDist: Uint8Array;
  seedLen: Float32Array;
}

/** het fietsraster en, als het er is, het looptraster */
export interface Grids {
  bike: BikeGrid;
  walk: BikeGrid | null;
}
/** het raster voor een stuk: fietsen over het fietsraster, lopen over het looptraster (anders ook het fietsraster) */
const pick = (gs: Grids, bike: boolean) => (bike || !gs.walk ? gs.bike : gs.walk);

/** laadt bike.bin.gz; null als het ontbreekt of niet past (dan blijft het hemelsbrede model over) */
export const loadBikeGrid = (base: string, g: Graph) => loadGrid(base + "bike.bin.gz", "FIETS1", g);
/** laadt walk.bin.gz; null als het ontbreekt of niet past (dan gaat lopen over het fietsraster) */
export const loadWalkGrid = (base: string, g: Graph) => loadGrid(base + "walk.bin.gz", "LOPEN1", g);

async function loadGrid(url: string, want: string, g: Graph): Promise<BikeGrid | null> {
  const buf = await fetchGz(url);
  if (!buf) return null;
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 6));
  const nx = dv.getUint16(8, true), ny = dv.getUint16(10, true), nDirs = dv.getUint16(12, true);
  const seedR = dv.getUint16(14, true), nA = dv.getUint32(16, true);
  // nA < nArea: de graaf heeft er halteplekken bij (weekend); die hebben (nog) geen startcellen en tekenen kegels
  // nDirs ≤ 8: vooruit en terug moeten samen in 4 bits passen
  if (magic !== want || nx !== NX || ny !== NY || nA > g.nArea || nDirs > 8) {
    console.warn(`${url} past niet bij dit raster of deze graaf; het wordt niet gebruikt`,
      { magic, nx, ny, nDirs, nA, nArea: g.nArea });
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
  const seeds = new Uint8Array(buf, p, nA * (2 * seedR + 1) ** 2);

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
  // Eerst tellen, dan vullen (CSR). De buur en de lengte staan niet per kant, die volgen uit de richting.
  const off = dirs.map(([di, dj]) => dj * NX + di);
  const unit = dirs.map(([di, dj]) => Math.hypot(di, dj) * CELL);
  const step = new Int32Array(16);
  for (let d = 0; d < nDirs; d++) {
    step[d] = off[d];
    step[d + nDirs] = -off[d];
  }
  // lengte per rij, richting en niveau: mercator-meter → echte meter met de rij van de kant "vooruit"
  // (voor een kant terug is dat de rij van de buur)
  const lenTab = new Uint16Array(NY * 256);
  for (let j = 0; j < NY; j++) {
    for (let d = 0; d < nDirs; d++) {
      const back = ROW_SCALE[Math.min(NY - 1, Math.max(0, j - dirs[d][1]))];
      for (let l = 0; l < 15; l++) {
        lenTab[j * 256 + ((d << 4) | l)] = Math.min(65535, Math.round(unit[d] * levels[l] * ROW_SCALE[j]));
        lenTab[j * 256 + (((d + nDirs) << 4) | l)] = Math.min(65535, Math.round(unit[d] * levels[l] * back));
      }
    }
  }
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
  const edge = new Uint8Array(first[nNode]);
  for (let n = 0; n < nNode; n++) {
    const c = cellOfNode[n];
    for (let d = 0; d < nDirs; d++) {
      const l = nibble(edges, c * nDirs + d);
      const m = nodeOfCell[c + off[d]];
      if (l === NONE || m < 0) continue;
      edge[fill[n]++] = (d << 4) | l;
      edge[fill[m]++] = ((d + nDirs) << 4) | l;
    }
  }

  // startcellen per halteplek: alleen de cel van de halte en de afstanden; de knopen volgen uit nodeOfCell
  const w = 2 * seedR + 1, seedK = w * w;
  const seedDI = new Int8Array(seedK), seedDJ = new Int8Array(seedK);
  for (let dj = -seedR, s = 0; dj <= seedR; dj++) for (let di = -seedR; di <= seedR; di++, s++) [seedDI[s], seedDJ[s]] = [di, dj];
  const seedCell = new Int32Array(g.nArea);
  for (let a = 0; a < g.nArea; a++) seedCell[a] = cellOf(g.areaLat[a], g.areaLon[a]);
  const seedDist = new Uint8Array(g.nArea * seedK).fill(255);
  const seedLen = new Float32Array(256);
  for (let b = 0; b < 256; b++) seedLen[b] = b * seedStep;
  for (let a = 0; a < nA; a++) if (seedCell[a] >= 0) seedDist.set(seeds.subarray(a * seedK, (a + 1) * seedK), a * seedK);
  // halteplekken die er in bike.bin.gz nog niet waren (alleen in het weekend): zoals het vertrekpunt,
  // hemelsbreed × 1,3 naar de middens van de cellen eromheen, plus de snapafstand
  for (let a = nA; a < g.nArea; a++) {
    const c0 = seedCell[a];
    if (c0 < 0) continue;
    const oi = c0 % NX, oj = Math.floor(c0 / NX);
    for (let s = 0; s < seedK; s++) {
      const i = oi + seedDI[s], j = oj + seedDJ[s];
      // buiten het raster: geen startcel (seedNodeAt zou de cel aan de rand begrenzen)
      const n = i < 0 || j < 0 || i >= NX || j >= NY ? -1 : nodeOfCell[j * NX + i];
      if (n < 0) continue;
      const [clat, clon] = cellCenter(i, j);
      seedDist[a * seedK + s] = seedByte(distM(g.areaLat[a], g.areaLon[a], clat, clon) * DETOUR + snapM[n], seedStep);
    }
  }
  return { nNode, cellOfNode, nodeOfCell, snapM, first, edge, step, lenTab, seedK, seedCell, seedDI, seedDJ, seedDist, seedLen };
}

/** de knoop van startcel s van de halte in cel c0 (aan de rand van het raster begrensd); -1 = geen knoop */
function seedNodeAt(bg: BikeGrid, c0: number, s: number): number {
  const i = Math.min(NX - 1, Math.max(0, (c0 % NX) + bg.seedDI[s]));
  const j = Math.min(NY - 1, Math.max(0, Math.floor(c0 / NX) + bg.seedDJ[s]));
  return bg.nodeOfCell[j * NX + i];
}

/** afstand halte → startcel (m) als byte in stappen van `step`, zoals seed_bytes in export_bike_grid.py;
 *  255 = geen verbinding */
export function seedByte(d: number, step: number): number {
  const b = Math.round(d / step);
  return b <= 254 ? b : 255;
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

  /** past bij een raster met nNode knopen (fiets- en looptraster verschillen) */
  ensure(nNode: number): this {
    if (this.time.length !== nNode) {
      this.time = new Float32Array(nNode);
      this.bike = new Float32Array(nNode);
      this.src = new Int32Array(nNode);
    }
    return this;
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
    const { first, edge, step, lenTab, cellOfNode, nodeOfCell } = g;
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
        const cu = cellOfNode[u];
        const row = ((cu / NX) | 0) << 8;
        for (let k = first[u], end = first[u + 1]; k < end; k++) {
          const x = edge[k];
          const m = lenTab[row | x];
          const bb = b0 + m;
          if (bb > bikeMax) continue;
          const t = t0 + m * invV;
          const w = nodeOfCell[cu + step[x >> 4]];
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
let originGrid: BikeGrid | null = null; // het raster van de laatste originAccess (fromOrigin hoort erbij)

/** middelpunt van cel (i, j) in graden */
export function cellCenter(i: number, j: number): [number, number] {
  const x = X0 + (i + 0.5) * CELL, y = Y0 + (j + 0.5) * CELL;
  return [(2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * (180 / Math.PI), (x / 6378137) * (180 / Math.PI)];
}

/** Stap 1: fietsen (of lopen) vanaf het vertrekpunt over het raster (grens directMaxKm of walkMaxKm).
 *  Geeft per halteplek de begintijd voor de OV-zoektocht (Infinity = niet bereikbaar). */
export function originAccess(gs: Grids, g: Graph, lat: number, lon: number, p: Params): Float64Array {
  const bg = (originGrid = pick(gs, p.bikeStart));
  const r = (fromOrigin ??= new Run(bg.nNode)).ensure(bg.nNode);
  const { startV: v, startMax: directMax } = legs(p);
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
  const { seedK, seedCell, seedDist, seedLen } = bg;
  for (let a = 0; a < g.nArea; a++) {
    let any = false;
    for (let s = 0, k = a * seedK; s < seedK && seedCell[a] >= 0; s++, k++) {
      if (seedDist[k] === 255) continue;
      const n = seedNodeAt(bg, seedCell[a], s);
      if (n < 0) continue;
      any = true;
      const d = seedLen[seedDist[k]];
      if (r.bike[n] + d > directMax) continue; // ook waar r.time Infinity is: dan geeft min niets
      init[a] = Math.min(init[a], r.time[n] + d / v);
    }
    if (!any) {
      // halte zonder startcellen (buiten het fietsraster): hemelsbreed × 1,3, zoals vroeger
      const d = distM(lat, lon, g.areaLat[a], g.areaLon[a]) * DETOUR;
      if (d <= directMax) init[a] = d / v;
    }
  }
  return init;
}

/** Stap 2: van alle bereikte haltes verder fietsen (of lopen) over het raster (grens bikeMaxKm of walkMaxKm),
 *  en het raster vullen. Haltes zonder startcellen tekenen nog een hemelsbrede kegel, net als het vertrekpunt
 *  buiten het raster. origin null: alleen vanaf de haltes (de kaart naar het dichtstbijzijnde IC-station);
 *  anders hoort er een originAccess voor hetzelfde punt en dezelfde instellingen bij. */
export function rasterizeBike(gs: Grids, g: Graph, s: Search, origin: { lat: number; lon: number } | null, p: Params): Raster {
  const bg = pick(gs, p.bikeEnd);
  const og = origin ? pick(gs, p.bikeStart) : bg;
  if (origin && og !== originGrid) throw new Error("rasterizeBike: eerst originAccess met dezelfde instellingen");
  const r = (fromStops ??= new Run(bg.nNode)).ensure(bg.nNode);
  const { startV, startMax, endV: v, endMax: bikeMax } = legs(p);
  const tMax = p.tMaxMin * 60;
  r.reset(tMax);
  const { seedK, seedCell, seedDist, seedLen } = bg;
  const out = newRaster();
  for (let a = 0; a < g.nArea; a++) {
    const t = s.dist[a];
    if (t >= tMax) continue;
    let any = false;
    for (let q = 0, k = a * seedK; q < seedK && seedCell[a] >= 0; q++, k++) {
      if (seedDist[k] === 255) continue;
      const n = seedNodeAt(bg, seedCell[a], q);
      if (n < 0) continue;
      any = true;
      const d = seedLen[seedDist[k]];
      if (d <= bikeMax) r.seed(n, t + d / v, d, a);
    }
    if (!any) cone(out, mercX(g.areaLon[a]), mercY(g.areaLat[a]), t, bikeMax, v, a, tMax);
  }
  r.run(bg, v, bikeMax);

  // knopen → cellen, per cel (de twee rasters hebben elk hun eigen knoopnummers); de snapafstand
  // (celknoop → celmidden) komt er nog bij. Eerst vanaf het vertrekpunt, dan vanaf de haltes: bij gelijke
  // tijd wint het vertrekpunt van de haltes, en een kegel van allebei.
  let originOnGrid = false;
  if (origin) {
    const o = fromOrigin!.time;
    for (let n = 0; n < og.nNode; n++) {
      if (o[n] === Infinity) continue;
      originOnGrid = true;
      const c = og.cellOfNode[n];
      const t1 = (o[n] + og.snapM[n] / startV) / 60;
      if (t1 < out.time[c]) {
        out.time[c] = t1;
        out.via[c] = VIA_DIRECT;
      }
    }
  }
  for (let n = 0; n < bg.nNode; n++) {
    const c = bg.cellOfNode[n];
    const t2 = (r.time[n] + bg.snapM[n] / v) / 60;
    if (t2 < out.time[c]) {
      out.time[c] = t2;
      out.via[c] = r.src[n];
    }
  }
  if (origin && !originOnGrid) cone(out, mercX(origin.lon), mercY(origin.lat), 0, startMax, startV, VIA_DIRECT, tMax);
  fillGaps(og, bg, out, startV, v);
  return out;
}

let fillDist: Float32Array | null = null;

/** Cellen zonder knoop aanvullen vanuit de buren: afstandstransformatie in twee passes
 *  (8 buren, hemelsbreed × DETOUR), tot FILL_M van de dichtstbijzijnde gevulde cel.
 *  Het tempo hangt af van het stuk: vanaf het vertrekpunt (vStart) of vanaf een halte (vEnd).
 *  Een knoop die niet bereikt is, wordt niet gevuld (anders alsnog een sluiproute over water of spoor).
 *  Een cel met een knoop van het laatste stuk (bg) wordt dus nooit gevuld. Een cel met alleen een knoop van het
 *  eerste stuk (og, bijv. een fietspad zonder voetpad) wordt alleen gevuld vanuit buren die vanaf een halte
 *  komen: het eerste stuk heeft hem niet bereikt, maar het laatste stuk kent er geen knoop.
 *  Water wordt ook gevuld, maar dat valt op de kaart onder het watermasker. */
function fillGaps(og: BikeGrid, bg: BikeGrid, r: Raster, vStart: number, vEnd: number) {
  const { time, via } = r;
  const n1 = og.nodeOfCell, n2 = bg.nodeOfCell;
  const N = NX * NY;
  fillDist ??= new Float32Array(N);
  const fd = fillDist;
  // bron = elke cel met een tijd; knopen zonder tijd zijn niet bereikt en worden ook niet aangevuld
  // (anders ontstaat hemelsbreed alsnog een sluiproute over water of spoor)
  for (let c = 0; c < N; c++) fd[c] = time[c] < Infinity ? 0 : Infinity;
  const kStart = DETOUR / vStart / 60, kEnd = DETOUR / vEnd / 60; // minuten per meter
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
        if (fd[c] === 0 || n2[c] >= 0) continue; // een niet bereikte knoop van het laatste stuk: niet vullen
        const stopsOnly = n1[c] >= 0; // alleen een knoop van het eerste stuk: niet vanaf het vertrekpunt vullen
        let bestD = fd[c], bestN = -1;
        const near = (n: number, s: number) => {
          if (fd[n] + s < bestD && !(stopsOnly && via[n] === VIA_DIRECT)) { bestD = fd[n] + s; bestN = n; }
        };
        // de buren die in deze pass al aan de beurt waren
        if (fwd ? i > 0 : i < NX - 1) near(c + (fwd ? -1 : 1), s1);
        if (hasPrev) {
          const r0 = c + dj * NX;
          near(r0, s1);
          if (i > 0) near(r0 - 1, s2);
          if (i < NX - 1) near(r0 + 1, s2);
        }
        if (bestN < 0 || bestD > FILL_M) continue;
        fd[c] = bestD;
        const t = time[bestN] + (bestD - fd[bestN]) * (via[bestN] === VIA_DIRECT ? kStart : kEnd);
        if (t < time[c]) {
          time[c] = t;
          via[c] = via[bestN];
        }
      }
    }
  }
}
