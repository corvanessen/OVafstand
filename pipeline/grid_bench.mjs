// Fase 3, stap 4: rekentijd van Dijkstra over het fietsraster van heel NL (synthetisch raster).
// Gebruik: node pipeline/grid_bench.mjs   (V8, dus representatief voor Chrome)
// Kanten per cel naast elkaar (16 richtingen, beide kanten op) en een bucketwachtrij (Dial, 10 s).
// Een binaire heap was 3× trager; 1 byte per kant in plaats van 2 gaf geen winst.
const NX = 1146, NY = 1378, N = NX * NY, CELL = 250;
const F = [[1, 0], [0, 1], [1, 1], [-1, 1], [2, 1], [1, 2], [-1, 2], [-2, 1]];
const DIRS = [...F, ...F.map(([a, b]) => [-a, -b])]; // 16
const ND = DIRS.length, Q_STEP = 1 / 32;
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const land = new Uint8Array(N).fill(1);
for (let k = 0; k < 400; k++) {
  const cx = rnd() * NX, cy = rnd() * NY, r = 3 + rnd() * 40;
  for (let j = Math.max(0, cy - r | 0); j < Math.min(NY, cy + r); j++)
    for (let i = Math.max(0, cx - r | 0); i < Math.min(NX, cx + r); i++)
      if ((i - cx) ** 2 + (j - cy) ** 2 < r * r) land[j * NX + i] = 0;
}
// kosten per kant direct in seconden bij 15 km/u (uint16), 65535 = geen kant; [cel * 16 + richting]
const v = 15 / 3.6;
const cost = new Uint16Array(N * ND).fill(65535);
const LEN = DIRS.map(([a, b]) => Math.hypot(a, b) * CELL);
const OFF = Int32Array.from(DIRS, ([a, b]) => b * NX + a);
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const c = j * NX + i; if (!land[c]) continue;
  for (let d = 0; d < F.length; d++) {
    const [di, dj] = F[d], i2 = i + di, j2 = j + dj;
    if (i2 < 0 || i2 >= NX || j2 >= NY || !land[j2 * NX + i2]) continue;
    const s = Math.round(LEN[d] * (1 + ((rnd() * 16) | 0) * Q_STEP) / v);
    cost[c * ND + d] = s; cost[(j2 * NX + i2) * ND + d + 8] = s;
  }
}
const W = 10, NB = 1200; // bucketbreedte 10 s, 3 u + marge
function run(seeds, tMax, bikeMaxS) {
  const time = new Float32Array(N).fill(Infinity);
  const bike = new Float32Array(N); // fietstijd sinds de bron (s), voor de fietsgrens
  const head = new Int32Array(NB).fill(-1);
  let cap = 1 << 21, nxt = new Int32Array(cap), cel = new Int32Array(cap), ne = 0;
  const push = (t, c) => {
    if (ne === cap) { cap *= 2; let a = new Int32Array(cap); a.set(nxt); nxt = a; a = new Int32Array(cap); a.set(cel); cel = a; }
    const b = (t / W) | 0; cel[ne] = c; nxt[ne] = head[b]; head[b] = ne++;
  };
  for (const [c, t] of seeds) if (t < time[c]) { time[c] = t; bike[c] = 0; push(t, c); }
  let settled = 0;
  for (let b = 0; b < NB; b++) {
    while (head[b] !== -1) {
      const e = head[b]; head[b] = nxt[e]; const c = cel[e];
      const t0 = time[c]; if (((t0 / W) | 0) !== b) continue; // verouderd
      settled++;
      const b0 = bike[c], base = c * ND;
      for (let d = 0; d < ND; d++) {
        const s = cost[base + d]; if (s === 65535) continue;
        const bb = b0 + s; if (bb > bikeMaxS) continue;
        const t = t0 + s, c2 = c + OFF[d];
        if (t < time[c2] && t < tMax) { time[c2] = t; bike[c2] = bb; push(t, c2); }
      }
    }
  }
  return settled;
}
const tMax = 180 * 60;
for (const nSeeds of [500, 3000, 10000]) {
  const seeds = [];
  while (seeds.length < nSeeds) { const c = (rnd() * N) | 0; if (land[c]) seeds.push([c, rnd() * 170 * 60]); }
  for (let rep = 0; rep < 3; rep++) {
    const t = performance.now(); const s = run(seeds, tMax, 5000 / v);
    console.log(`haltes ${nSeeds}: ${(performance.now() - t).toFixed(0)} ms, ${s} cellen`);
  }
}
let o = (NY / 2 | 0) * NX + (NX / 2 | 0); while (!land[o]) o++;
for (let rep = 0; rep < 3; rep++) {
  const t = performance.now(); const s = run([[o, 0]], tMax, 15000 / v);
  console.log(`vertrekpunt 15 km: ${(performance.now() - t).toFixed(0)} ms, ${s} cellen`);
}
