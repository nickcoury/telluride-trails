import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// Mock global fetch for Node verification against public/data/vector/
globalThis.fetch = async (url) => {
  const cleanPath = String(url).replace(/^\/telluride-trails\//, '').replace(/^\.\//, '');
  const fullPath = path.join(PUBLIC_DIR, cleanPath);
  const text = await fs.readFile(fullPath, 'utf8');
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(text),
  };
};

const { loadTrailData } = await import('../../src/data/index.js');

const events = [];
const mockEngine = {
  assetsBase: '/telluride-trails/',
  events: {
    emit(name, payload) {
      events.push({ name, payload });
    },
  },
};

const t0 = performance.now();
const trailData = await loadTrailData(mockEngine);
const startupMs = performance.now() - t0;

console.log(`Startup loadTrailData(): ${startupMs.toFixed(1)} ms`);
console.log(`POIs: ${trailData.pois.length} total, ${trailData.pois.filter((p) => p.freeRun).length} freeRun`);
console.log(`Races: ${trailData.races.length}`);

assert.ok(trailData.pois.length >= 30, 'Expected >= 30 POIs');
assert.ok(trailData.pois.filter((p) => p.freeRun).length >= 30, 'Expected >= 30 curated freeRun spots');
assert.ok(trailData.races.length >= 8, 'Expected >= 8 races');

// Verify key elevations
const M_TO_FT = 3.28084;
for (const nameCheck of ['Telluride Gondola Plaza', 'Handies Peak', 'Imogene Pass', 'Kendall Mountain Summit', 'Bridal Veil Falls']) {
  const p = trailData.pois.find((x) => x.name === nameCheck);
  assert.ok(p, `Missing POI: ${nameCheck}`);
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isFinite(p.y), `Bad coords for ${nameCheck}`);
  console.log(`  POI ${p.name}: (${p.x}, ${p.z}), elev=${(p.y * M_TO_FT).toFixed(0)} ft, heading=${p.heading}`);
}

// Verify races
for (const r of trailData.races) {
  assert.ok(r.line instanceof Float32Array, `${r.id}.line must be Float32Array`);
  assert.ok(r.line.length >= 6 && r.line.length % 3 === 0, `${r.id}.line stride 3 invalid`);
  let prevD = -1;
  for (let i = 2; i < r.line.length; i += 3) {
    assert.ok(r.line[i] >= prevD, `${r.id}.line cumDist not monotonic at idx ${i}`);
    prevD = r.line[i];
  }
  const totalD = r.line[r.line.length - 1];
  assert.ok(r.checkpoints.length >= 2, `${r.id} needs >= 2 checkpoints`);
  let prevCpD = -1;
  for (const cp of r.checkpoints) {
    assert.ok(cp.d >= prevCpD && cp.d <= totalD + 1, `${r.id} checkpoint ${cp.name} d=${cp.d} out of range [0, ${totalD}]`);
    prevCpD = cp.d;
  }
}

// Load Telluride area (radius 5000m)
const res = await trailData.loadArea(0, 0, 5000);
console.log(
  `Loaded Telluride 5km area: trails=${trailData.trails.length}, waterways=${trailData.waterways.length}, ` +
  `lakes=${trailData.lakes.length}, waterfalls=${trailData.waterfalls.length}, buildings=${trailData.buildings.length}, ` +
  `aerialways=${trailData.aerialways.length}, skiRuns=${trailData.skiRuns.length}`
);
assert.ok(trailData.trails.length > 50, 'Expected trails around Telluride');
assert.ok(trailData.buildings.length > 100, 'Expected buildings in Telluride');
assert.ok(trailData.aerialways.length >= 2, 'Expected gondola/lifts around Telluride');
assert.ok(events.some((e) => e.name === 'data:chunk'), 'Expected data:chunk event');

// Check zero duplicate IDs
assert.equal(new Set(trailData.trails.map((t) => t.id)).size, trailData.trails.length, 'Duplicate trail IDs');
assert.equal(new Set(trailData.buildings.map((b) => b.id)).size, trailData.buildings.length, 'Duplicate building IDs');

// Benchmark nearest()
const near0 = trailData.nearest(0, 0, 100);
assert.ok(near0 && near0.dist < 100, 'Expected a trail/road near Telluride origin');
console.log(`nearest(0, 0): ${near0.name} (${near0.kind}), dist=${near0.dist.toFixed(1)}m`);

const N_CALLS = 10000;
const bt0 = performance.now();
let hits = 0;
for (let i = 0; i < N_CALLS; i++) {
  const rx = ((i * 73) % 2000) - 1000;
  const rz = ((i * 137) % 2000) - 1000;
  if (trailData.nearest(rx, rz, 25)) hits++;
}
const dtMs = performance.now() - bt0;
console.log(`nearest() benchmark: ${N_CALLS} calls in ${dtMs.toFixed(2)} ms (${((dtMs * 1000) / N_CALLS).toFixed(2)} us/call, hits=${hits})`);
assert.ok(dtMs / N_CALLS < 0.05, 'nearest() too slow for per-frame use');

// Wait a tick for graph.json background load triggered by loadArea, then test route()
await new Promise((r) => setTimeout(r, 100));
const poly = trailData.route({ x: 0, z: 0 }, { x: 1500, z: 2500 });
console.log(`route(Telluride -> Bear Creek area): ${poly.length} points`);
assert.ok(poly.length > 5, 'Expected multi-point A* routed polyline');

console.log('ALL RUNTIME VERIFICATIONS PASSED!');
