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

assert.equal(trailData.races.length, 11, 'Expected 11 races');
assert.ok(!JSON.stringify(trailData.pois).includes('St. Sophia'), 'St. Sophia should be San Sophia');
assert.ok(!JSON.stringify(trailData.races).includes('St. Sophia'), 'St. Sophia in races should be San Sophia');

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

// 2. Local synchronous route() without graph.json
const localPoly = trailData.route({ x: 0, z: 0 }, { x: 1200, z: 2200 });
assert.ok(localPoly.length > 5 && !fetchedUrls.some((u) => u.endsWith('graph.json')));

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
