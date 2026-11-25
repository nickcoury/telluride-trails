import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

const fetchedUrls = [];
let inFlight = 0;
let peakInFlight = 0;
let injectedTransientFailure = false;

globalThis.fetch = async (url) => {
  const cleanPath = String(url).replace(/^\/telluride-trails\//, '').replace(/^\.\//, '');
  fetchedUrls.push(cleanPath);
  inFlight++;
  if (inFlight > peakInFlight) peakInFlight = inFlight;
  await new Promise((r) => setTimeout(r, 2));
  try {
    if (!injectedTransientFailure && cleanPath.includes('chunks/')) {
      injectedTransientFailure = true;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    const fullPath = path.join(PUBLIC_DIR, cleanPath);
    const text = await fs.readFile(fullPath, 'utf8');
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(text),
    };
  } finally {
    inFlight--;
  }
};

const { loadTrailData } = await import('../../src/data/index.js');

const events = [];
let appState = 'loading';
const scheduledSlices = [];
const mockEngine = {
  assetsBase: '/telluride-trails/',
  getAppState: () => appState,
  scheduler: {
    enqueue(fn, opts) {
      scheduledSlices.push({ fn, opts });
    },
  },
  events: {
    emit(name, payload) {
      events.push({ name, payload });
    },
  },
};

const t0 = performance.now();
const trailData = await loadTrailData(mockEngine);
const startupMs = performance.now() - t0;

console.log(`Startup loadTrailData(): ${startupMs.toFixed(1)} ms (reqs=${fetchedUrls.length})`);
console.log(`POIs: ${trailData.pois.length} total, ${trailData.pois.filter((p) => p.freeRun).length} freeRun`);
console.log(`Races: ${trailData.races.length}`);

assert.equal(trailData.races.length, 13, 'Expected 13 races');
assert.ok(!JSON.stringify(trailData.pois).includes('St. Sophia'), 'St. Sophia should be San Sophia');
assert.ok(!JSON.stringify(trailData.races).includes('St. Sophia'), 'St. Sophia in races should be San Sophia');

// Check Spurs Austin International Half Marathon Easter egg (13th race, index 12, bottom of list)
const spurs = trailData.races[trailData.races.length - 1];
assert.equal(spurs.id, 'spurs-half-marathon', 'spurs-half-marathon must be the 13th/last race');
assert.equal(spurs.name, 'Spurs Austin International Half Marathon');
assert.equal(spurs.easterEgg, true, 'spurs-half-marathon must have easterEgg: true');
assert.equal(spurs.seaLevel, true, 'spurs-half-marathon must have seaLevel: true');
assert.equal(spurs.startTimeLocal, '07:00');
assert.equal(spurs.cutoffH, 4);
assert.equal(spurs.gainFt, 197);
assert.equal(spurs.officialGainFt, 197);
assert.equal(spurs.lossFt, 561);
assert.ok(spurs.distanceMi >= 13.0 && spurs.distanceMi <= 13.25, `spurs distanceMi=${spurs.distanceMi} out of range`);
const spursTotalM = spurs.line[spurs.line.length - 1];
assert.ok(spursTotalM >= 21050 && spursTotalM <= 21180, `spurs polyline length ${spursTotalM}m outside 21050..21180m`);
for (let i = 0; i < spurs.line.length; i += 3) {
  assert.ok(spurs.line[i] >= -17500, `spurs x=${spurs.line[i]} out of safe western bound >= -17500`);
}
assert.equal(spurs.elevations.length, 128, 'spurs must have 128 elevation samples');
const spursMaxE = Math.max(...spurs.elevations);
const spursMinE = Math.min(...spurs.elevations);
assert.ok(spursMaxE >= 267 && spursMaxE <= 269, `spurs max elev=${spursMaxE}m should be ~268m`);
assert.ok(spursMinE >= 148 && spursMinE <= 150, `spurs min elev=${spursMinE}m should be ~149m`);
assert.equal(spurs.checkpoints.length, 4, 'spurs must have 4 checkpoints');
assert.ok(spurs.checkpoints[0].name.includes('Shoal Creek') && spurs.checkpoints[3].name.includes('Texas State Capitol'));

// Check Gondola Base & San Sophia POIs + both Rundola races
const townPoi = trailData.pois.find((p) => p.id === 'telluride-town');
const sophiaPoi = trailData.pois.find((p) => p.id === 'san-sophia-gondola');
assert.ok(townPoi && Math.hypot(townPoi.x - (-118.0), townPoi.z - 162.0) < 2.0, `telluride-town misplaced: (${townPoi?.x}, ${townPoi?.z})`);
assert.ok(sophiaPoi && Math.hypot(sophiaPoi.x - (-1782.0), sophiaPoi.z - 677.0) < 2.0, `san-sophia-gondola misplaced: (${sophiaPoi?.x}, ${sophiaPoi?.z})`);
assert.ok(sophiaPoi.y > 3205 && sophiaPoi.y < 3225, `san-sophia-gondola y=${sophiaPoi.y}m should be ~3212m (~10538ft)`);

const rundolaTT = trailData.races.find((r) => r.id === 'rundola');
const rundolaOrig = trailData.races.find((r) => r.id === 'rundola-original');
assert.ok(rundolaTT && rundolaOrig, 'Expected both rundola and rundola-original races');
assert.equal(rundolaTT.start.x, rundolaOrig.start.x, 'Both Rundola courses must share the exact same Gondola Base start X');
assert.equal(rundolaTT.start.z, rundolaOrig.start.z, 'Both Rundola courses must share the exact same Gondola Base start Z');
assert.ok(Math.hypot(rundolaTT.start.x - (-165.4), rundolaTT.start.z - 176.1) < 1.0, `Rundola start (${rundolaTT.start.x}, ${rundolaTT.start.z}) should be Gondola Base Apron (-165.4, 176.1)`);
assert.equal(rundolaTT.finish.x, rundolaOrig.finish.x, 'Both Rundola courses must share the exact same San Sophia finish X');
assert.equal(rundolaTT.finish.z, rundolaOrig.finish.z, 'Both Rundola courses must share the exact same San Sophia finish Z');
assert.ok(Math.hypot(rundolaTT.finish.x - (-1782.0), rundolaTT.finish.z - 677.0) < 1.0, `Rundola finish (${rundolaTT.finish.x}, ${rundolaTT.finish.z}) should be San Sophia Apron (-1782.0, 677.0)`);
assert.ok(rundolaTT.distanceMi >= 2.4 && rundolaTT.distanceMi <= 2.8, `rundola dist=${rundolaTT.distanceMi} mi out of range`);
assert.ok(rundolaTT.gainFt >= 1760 && rundolaTT.gainFt <= 1860, `rundola gain=${rundolaTT.gainFt} ft out of range`);
assert.ok(rundolaOrig.distanceMi >= 1.0 && rundolaOrig.distanceMi <= 1.2, `rundola-original dist=${rundolaOrig.distanceMi} mi out of range`);
assert.ok(rundolaOrig.gainFt >= 1750 && rundolaOrig.gainFt <= 1850, `rundola-original gain=${rundolaOrig.gainFt} ft out of range`);

// Verify heading convention atan2(-dx, -dz) on all races
for (const r of trailData.races) {
  const dx = r.line[3] - r.line[0];
  const dz = r.line[4] - r.line[1];
  const expectedH = Math.atan2(-dx, -dz);
  assert.ok(Math.abs(r.start.heading - expectedH) < 0.01, `${r.id} start heading ${r.start.heading} != atan2(-dx,-dz) ${expectedH}`);
}

// Check Bear Creek Falls elevation (~9,976 ft = ~3040.8 m) & single Bridal Veil Falls
const bcf = trailData.pois.find((p) => p.id === 'bear-creek-falls');
assert.ok(bcf && bcf.y > 2950 && bcf.y < 3120, `Bear Creek Falls y=${bcf?.y}m should be ~3041m (~9976ft)`);
const bvMatches = trailData.pois.filter((p) => p.name.toLowerCase() === 'bridal veil falls');
assert.equal(bvMatches.length, 1, `Expected 1 Bridal Veil Falls in pois.json, got ${bvMatches.length}`);

// Check Kendall & SJS50 checkpoint spacing
const kendall = trailData.races.find((r) => r.id === 'kendall-mountain-run');
const kMiles = kendall.checkpoints.map((c) => Number((c.d / 1609.344).toFixed(2)));
console.log('Kendall checkpoints (mi):', kMiles);
assert.ok(kMiles[0] > 2.5 && kMiles[0] < 4.2 && kMiles[2] > 5.6 && kMiles[2] < 6.6, 'Kendall checkpoints misplaced');

const sjs = trailData.races.find((r) => r.id === 'san-juan-solstice-50');
const sjsMiles = sjs.checkpoints.map((c) => Number((c.d / 1609.344).toFixed(2)));
console.log('SJS50 checkpoints (mi):', sjsMiles);
assert.ok(sjsMiles[0] > 5.5 && sjsMiles[0] < 8.5 && sjsMiles[5] > 43.0 && sjsMiles[5] < 47.0, 'SJS50 checkpoints misplaced');

// Verify races have 128-sample elevations & monotonic checkpoints with y
for (const r of trailData.races) {
  assert.ok(r.line instanceof Float32Array && r.line.length >= 6 && r.line.length % 3 === 0);
  assert.ok(Array.isArray(r.elevations) && r.elevations.length === 128);
  let prevCpD = -1;
  for (const cp of r.checkpoints) {
    assert.ok(cp.d > prevCpD && Number.isFinite(cp.y), `${r.id} cp ${cp.name} invalid`);
    prevCpD = cp.d;
  }
}

// 1. Load Telluride area while playing -> verify scheduler mid-chunk slicing + retry + zero graph.json
appState = 'playing';
const loadProm = trailData.loadArea(0, 0, 2000);
// Pump mock scheduler slices until loadProm settles
let slicePumpCount = 0;
const pumpTimer = setInterval(() => {
  while (scheduledSlices.length > 0) {
    const task = scheduledSlices.shift();
    slicePumpCount++;
    if (task.fn() === true) scheduledSlices.push(task);
  }
}, 5);
await loadProm;
clearInterval(pumpTimer);

console.log(`Loaded Telluride 2km via ${slicePumpCount} scheduler slices (transient 503 retried=${injectedTransientFailure})`);
assert.ok(slicePumpCount >= 4, 'Expected scheduler slices during playing state');
assert.ok(!fetchedUrls.some((u) => u.endsWith('graph.json')), 'loadArea() must NOT eagerly fetch graph.json!');

// Verify bbox on ALL 6 geometry categories
for (const cat of ['trails', 'waterways', 'lakes', 'buildings', 'aerialways', 'skiRuns']) {
  assert.ok(
    trailData[cat].every((it) => Array.isArray(it.bbox) && it.bbox.length === 4),
    `Missing bbox on ${cat}`
  );
}

// 2. Local synchronous route() without graph.json + Gondola Cut & building clearance checks
const localPoly = trailData.route({ x: 0, z: 0 }, { x: 1200, z: 2200 });
assert.ok(localPoly.length > 5 && !fetchedUrls.some((u) => u.endsWith('graph.json')));

// Verify Gondola Base -> San Sophia local route() and nearest() on Gondola Cut + building clearance
appState = 'loading';
await trailData.loadArea(-1000, 420, 1400);
const nearCut = trailData.nearest(-975, 423, 25);
assert.ok(nearCut && nearCut.name === 'Original Rundola (Gondola Cut)', `Expected Original Rundola (Gondola Cut) at (-975,423), got ${nearCut?.name}`);
const nearBase = trailData.nearest(rundolaOrig.start.x, rundolaOrig.start.z, 10);
assert.ok(nearBase && nearBase.dist < 1.0, `Expected trail at Rundola start, got dist=${nearBase?.dist}`);
const nearSophia = trailData.nearest(rundolaOrig.finish.x, rundolaOrig.finish.z, 10);
assert.ok(nearSophia && nearSophia.dist < 1.0, `Expected trail at San Sophia finish, got dist=${nearSophia?.dist}`);
const gondolaRoute = trailData.route(rundolaOrig.start, rundolaOrig.finish);
assert.ok(gondolaRoute.length >= 2, `Expected valid route() from Gondola Base to San Sophia, got len=${gondolaRoute.length}`);
assert.ok(rundolaOrig.line.length >= 30 * 3, `Expected densified polyline on rundola-original, got ${rundolaOrig.line.length / 3} pts`);

// Point-in-polygon check against all loaded buildings for POIs + Rundola starts/finishes
function ptInBuilding(px, pz, coords) {
  let inside = false;
  const n = coords.length / 3;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = coords[i * 3], zi = coords[i * 3 + 2];
    const xj = coords[j * 3], zj = coords[j * 3 + 2];
    if (((zi > pz) !== (zj > pz)) && (px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
for (const [label, pt] of [
  ['telluride-town', townPoi],
  ['san-sophia-gondola', sophiaPoi],
  ['rundola start', rundolaTT.start],
  ['rundola finish', rundolaTT.finish],
  ['rundola-original start', rundolaOrig.start],
  ['rundola-original finish', rundolaOrig.finish],
]) {
  for (const b of trailData.buildings) {
    if (pt.x < b.bbox[0] || pt.x > b.bbox[2] || pt.z < b.bbox[1] || pt.z > b.bbox[3]) continue;
    assert.ok(!ptInBuilding(pt.x, pt.z, b.coords), `${label} (${pt.x},${pt.z}) is INSIDE building ${b.id} (${b.name})`);
  }
}
// Verify pylon clearance (>= 5.0 m) on both Rundola starts, finishes, and all rundola-original vertices
const gondolaAw = trailData.aerialways.find((a) => a.id === 'aw17145067');
assert.ok(gondolaAw && Array.isArray(gondolaAw.pylons) && gondolaAw.pylons.length >= 15, 'Expected aw17145067 pylons');
for (const [label, pt] of [
  ['rundola start', rundolaTT.start],
  ['rundola finish', rundolaTT.finish],
  ['rundola-original start', rundolaOrig.start],
  ['rundola-original finish', rundolaOrig.finish],
]) {
  const minPylonD = Math.min(...gondolaAw.pylons.map((p) => Math.hypot(pt.x - p.x, pt.z - p.z)));
  assert.ok(minPylonD >= 5.0, `${label} (${pt.x},${pt.z}) too close to gondola pylon: ${minPylonD.toFixed(2)}m`);
}
let minLinePylonD = Infinity;
for (let i = 0; i < rundolaOrig.line.length; i += 3) {
  const px = rundolaOrig.line[i], pz = rundolaOrig.line[i + 1];
  for (const py of gondolaAw.pylons) {
    const d = Math.hypot(px - py.x, pz - py.z);
    if (d < minLinePylonD) minLinePylonD = d;
  }
}
assert.ok(minLinePylonD >= 5.0, `rundola-original polyline too close to gondola pylon: ${minLinePylonD.toFixed(2)}m`);
console.log(`Verified both Rundola courses, Gondola Cut nearest()/route(), zero building intersections, and pylon clearance >= ${minLinePylonD.toFixed(2)}m!`);

// Verify Spurs Half Marathon start & finish road nearest() and zero building overlap
await trailData.loadArea(spurs.start.x, spurs.start.z, 800);
const nearSpursStart = trailData.nearest(spurs.start.x, spurs.start.z, 10);
assert.ok(nearSpursStart && nearSpursStart.kind === 'road' && nearSpursStart.dist < 2.0, `Expected paved road at spurs start, got ${JSON.stringify(nearSpursStart)}`);
for (const b of trailData.buildings) {
  if (spurs.start.x < b.bbox[0] || spurs.start.x > b.bbox[2] || spurs.start.z < b.bbox[1] || spurs.start.z > b.bbox[3]) continue;
  assert.ok(!ptInBuilding(spurs.start.x, spurs.start.z, b.coords), `spurs start inside building ${b.id}`);
}
await trailData.loadArea(spurs.finish.x, spurs.finish.z, 1200);
const nearSpursFin = trailData.nearest(spurs.finish.x, spurs.finish.z, 10);
assert.ok(nearSpursFin && nearSpursFin.kind === 'road' && nearSpursFin.dist < 2.0, `Expected paved road at spurs finish, got ${JSON.stringify(nearSpursFin)}`);
for (const b of trailData.buildings) {
  if (spurs.finish.x < b.bbox[0] || spurs.finish.x > b.bbox[2] || spurs.finish.z < b.bbox[1] || spurs.finish.z > b.bbox[3]) continue;
  assert.ok(!ptInBuilding(spurs.finish.x, spurs.finish.z, b.coords), `spurs finish inside building ${b.id}`);
}
console.log(`Verified Spurs Austin Half Marathon (${spurs.distanceMi} mi / ${spursTotalM.toFixed(1)} m, Austin elev ${spursMaxE}m -> ${spursMinE}m, road start='${nearSpursStart.name}', road finish='${nearSpursFin.name}', 0 building overlap)!`);

// 3. Test concurrency cap (<=6) & LRU eviction across full 60km region load
appState = 'loading';
await trailData.loadArea(15000, -5000, 40000); // requests >150 chunks
console.log(`Peak concurrent fetches across full-region load: ${peakInFlight} (cap=6)`);
assert.ok(peakInFlight <= 6, `Concurrency cap exceeded: ${peakInFlight}`);
const evicts = events.filter((e) => e.name === 'data:evict').length;
console.log(`LRU evicted chunks: ${evicts}, remaining trails=${trailData.trails.length}, buildings=${trailData.buildings.length}`);
assert.ok(evicts > 50, 'Expected LRU eviction when loading >56 chunks');

// Ensure nearest() rebuilds cleanly after eviction and stays fast
await trailData.loadArea(0, 0, 2000);
const N_CALLS = 10000;
const bt0 = performance.now();
let hits = 0;
for (let i = 0; i < N_CALLS; i++) {
  const rx = ((i * 73) % 2000) - 1000;
  const rz = ((i * 137) % 2000) - 1000;
  if (trailData.nearest(rx, rz, 25)) hits++;
}
const dtMs = performance.now() - bt0;
console.log(`nearest() benchmark post-LRU: ${N_CALLS} calls in ${dtMs.toFixed(2)} ms (${((dtMs * 1000) / N_CALLS).toFixed(2)} us/call, hits=${hits})`);
assert.ok(dtMs / N_CALLS < 0.05 && hits > 1000);

console.log('ALL REVIEWER, PLAYTEST & PERFQA VERIFICATIONS PASSED!');
