// Standalone CLI verification & pacing calibration harness for Telluride Trails.
// NOT imported by src/main.js. Run via: source ~/.nvm/nvm.sh && node src/game/verifyPacing.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { M_TO_FT, MILE_M, SURFACES } from './constants.js';
import { computeHikeSpeed, computeTargetSpeed } from './physics.js';
import {
  createPhysiology,
  eatItem,
  fallProbabilityPerSec,
  refillFlasks,
  stepPhysiology,
  stomachLoad,
} from './physiology.js';
import { normalizeRunnerSelection, TELLURIDE_RUNNERS } from './roster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACES_PATH = path.resolve(__dirname, '../../public/data/vector/races.json');
const races = JSON.parse(fs.readFileSync(RACES_PATH, 'utf8'));

function fmtTime(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`;
}

function parseClock(str) {
  const parts = str.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function getRunner(id) {
  if (id === 'local-80') {
    return normalizeRunnerSelection({
      id: 'custom',
      isCustom: true,
      name: 'Local 80',
      stats: { speed: 80, climbing: 80, technical: 80, endurance: 80, altitude: 80 },
    });
  }
  return normalizeRunnerSelection(id);
}

// =========================================================================
// 1. Run vs. Hike Crossover & Steep Power-Hike Assertions
// =========================================================================
console.log('=== 1. Run vs. Hike Crossover & Tactical Trade-offs ===');
const local80 = getRunner('local-80');
const becker = getRunner('ryan-becker');

for (const g of [0.0, 0.05, 0.10, 0.12]) {
  const p = createPhysiology(local80.stats);
  const vRun = computeTargetSpeed({ effort: 'run', grade: g, surface: 'trail', surfaceInfo: SURFACES.trail, phys: p, stats: local80.stats }).speedMs;
  const vHike = computeTargetSpeed({ effort: 'hike', grade: g, surface: 'trail', surfaceInfo: SURFACES.trail, phys: p, stats: local80.stats }).speedMs;
  assert.ok(vRun > vHike, `Expected Run (${vRun.toFixed(2)}) > Hike (${vHike.toFixed(2)}) at +${(g * 100).toFixed(0)}%`);
}

// Check +18% grade stamina & kcal trade-off (Run vs Hike over 180s)
{
  const pRun = createPhysiology(local80.stats);
  const pHike = createPhysiology(local80.stats);
  const vRun = computeTargetSpeed({ effort: 'run', grade: 0.18, surface: 'trail', surfaceInfo: SURFACES.trail, phys: pRun, stats: local80.stats });
  const vHike = computeTargetSpeed({ effort: 'hike', grade: 0.18, surface: 'trail', surfaceInfo: SURFACES.trail, phys: pHike, stats: local80.stats });
  for (let i = 0; i < 180; i++) {
    stepPhysiology(pRun, 1.0, { speedMs: vRun.speedMs, grade: 0.18, elevationM: 2900, effort: vRun.gait, isMoving: true, stats: local80.stats });
    stepPhysiology(pHike, 1.0, { speedMs: vHike.speedMs, grade: 0.18, elevationM: 2900, effort: vHike.gait, isMoving: true, stats: local80.stats });
  }
  const runKcalUsed = pRun.energyMax * (1900 / 2200) - pRun.energy;
  const hikeKcalUsed = pHike.energyMax * (1900 / 2200) - pHike.energy;
  const kcalPerMRun = runKcalUsed / (vRun.speedMs * 180);
  const kcalPerMHike = hikeKcalUsed / (vHike.speedMs * 180);
  console.log(`  +18% 3-min test (Local 80): Run stam=${pRun.stamina.toFixed(1)}% vs Hike stam=${pHike.stamina.toFixed(1)}%; kcal/m saving=${(((kcalPerMRun - kcalPerMHike) / kcalPerMRun) * 100).toFixed(1)}%`);
  assert.ok(pHike.stamina > pRun.stamina + 25, 'Hike must preserve far more stamina than running +18%');
  assert.ok(kcalPerMHike < kcalPerMRun * 0.85, 'Hike must save >15% energy per meter on steep climb');
}

// Check +30%..+50% power-hike speed (NEVER 59:36/mi = 0.45 m/s!)
{
  const pB = createPhysiology(becker.stats);
  const p80 = createPhysiology(local80.stats);
  const b30 = computeTargetSpeed({ effort: 'run', grade: 0.30, surface: 'path', surfaceInfo: SURFACES.path, phys: pB, stats: becker.stats });
  const b50 = computeTargetSpeed({ effort: 'run', grade: 0.50, surface: 'path', surfaceInfo: SURFACES.path, phys: pB, stats: becker.stats });
  const l30 = computeTargetSpeed({ effort: 'run', grade: 0.30, surface: 'path', surfaceInfo: SURFACES.path, phys: p80, stats: local80.stats });
  const l50 = computeTargetSpeed({ effort: 'run', grade: 0.50, surface: 'path', surfaceInfo: SURFACES.path, phys: p80, stats: local80.stats });
  console.log(`  Power-hike speeds: Becker +30%=${b30.speedMs.toFixed(2)}m/s (${fmtTime(MILE_M / b30.speedMs)}/mi), +50%=${b50.speedMs.toFixed(2)}m/s (${fmtTime(MILE_M / b50.speedMs)}/mi) | Local80 +30%=${l30.speedMs.toFixed(2)}m/s, +50%=${l50.speedMs.toFixed(2)}m/s`);
  assert.equal(b30.gait, 'power-hike');
  assert.ok(b30.speedMs >= 1.10, 'Becker +30% power-hike too slow');
  assert.ok(b50.speedMs >= 0.72, 'Becker +50% power-hike must be >= 0.72 m/s');
  assert.ok(l30.speedMs >= 0.88, 'Local 80 +30% power-hike too slow');
}

// Check downhill hike quad-wear (-45%) and fall-risk (-70%) protection
{
  const pRunD = createPhysiology(local80.stats);
  const pHikeD = createPhysiology(local80.stats);
  stepPhysiology(pRunD, 60, { speedMs: 2.2, grade: -0.18, elevationM: 3200, effort: 'run', isMoving: true, stats: local80.stats });
  stepPhysiology(pHikeD, 60, { speedMs: 2.2, grade: -0.18, elevationM: 3200, effort: 'hike', isMoving: true, stats: local80.stats });
  const ratioLeg = pHikeD.legs / pRunD.legs;
  const fRun = fallProbabilityPerSec(pRunD, 2.2, 2.0, -0.18, local80.stats, 'run');
  const fHike = fallProbabilityPerSec(pRunD, 2.2, 2.0, -0.18, local80.stats, 'hike');
  console.log(`  Downhill -18% protection: Hike legs/Run legs=${ratioLeg.toFixed(2)} (target 0.55), fall ratio=${(fHike / fRun).toFixed(2)} (target 0.30)`);
  assert.ok(Math.abs(ratioLeg - 0.55) < 0.02, 'Downhill hike must cut leg wear by 45%');
  assert.ok(Math.abs(fHike / fRun - 0.30) < 0.02, 'Downhill hike must cut fall risk by 70%');
}

// =========================================================================
// 2. Full 13-Course Race Simulator (dt = 1.0 s)
// =========================================================================
function sampleRaceElevation(race, distM, totalDistM) {
  const elevs = race.elevations;
  const frac = Math.max(0, Math.min(1, distM / Math.max(1, totalDistM)));
  const fIdx = frac * (elevs.length - 1);
  const i0 = Math.min(elevs.length - 1, Math.floor(fIdx));
  const i1 = Math.min(elevs.length - 1, i0 + 1);
  return elevs[i0] + (elevs[i1] - elevs[i0]) * (fIdx - i0);
}

function surfaceForRace(race, elevM, grade) {
  if (race.seaLevel) return 'road';
  if (race.id === 'rundola-original') return 'path';
  if (race.id === 'imogene-pass-run') return 'track';
  const elevFt = elevM * M_TO_FT;
  if (elevFt > 12950 && Math.abs(grade) > 0.16) return 'talus';
  if (elevFt > 12300 && Math.abs(grade) > 0.14) return 'scree';
  if (elevFt > 11800) return 'path';
  return 'trail';
}

function simulateRace(race, runnerId) {
  const runner = getRunner(runnerId);
  const phys = createPhysiology(runner.stats);
  const line = race.line;
  const segCount = Math.floor(line.length / 3);
  const totalDistM = segCount > 0 ? line[(segCount - 1) * 3 + 2] : race.distanceMi * MILE_M;

  // Compute start hour from startTimeLocal ("HH:MM")
  const [sh, sm] = String(race.startTimeLocal || '06:00').split(':').map(Number);
  const startHour = (sh || 6) + (sm || 0) / 60;

  const cps = (race.checkpoints || []).map((c) => ({ ...c, passed: false })).sort((a, b) => a.d - b.d);
  let cpIdx = 0;

  const dt = 1.0;
  let distM = 0;
  let clockS = 0;
  let speedMs = 0;
  let autoHikeStam = false;
  let lastAidRefuelS = -999;
  let dnf = false;
  let dnfReason = null;

  const maxClockS = (race.cutoffH || 48) * 3600 + 3600;
  const hikeGradeThresh = (race.distanceMi || 0) >= 30 ? 0.13 : 0.18;

  while (distM < totalDistM && clockS < maxClockS) {
    const hHere = sampleRaceElevation(race, distM, totalDistM);
    const stepProbe = Math.min(25, Math.max(8, totalDistM / 127));
    const hAhead = sampleRaceElevation(race, Math.min(totalDistM, distM + stepProbe), totalDistM);
    const grade = (hAhead - hHere) / Math.max(1, Math.min(totalDistM, distM + stepProbe) - distM);

    const surface = surfaceForRace(race, hHere, grade);
    const surfaceInfo = SURFACES[surface] || SURFACES.trail;

    if (phys.stamina < 25) autoHikeStam = true;
    else if (phys.stamina > 65) autoHikeStam = false;

    let effort = 'run';
    if (grade >= hikeGradeThresh || autoHikeStam || (surface === 'talus' && grade < -0.10 && phys.legs > 75)) {
      effort = 'hike';
    }

    const target = computeTargetSpeed({
      effort,
      grade,
      surface,
      surfaceInfo,
      phys,
      stats: runner.stats,
      race,
    });

    speedMs += Math.max(-6.5 * dt, Math.min(4.5 * dt, target.speedMs - speedMs));
    distM += speedMs * dt;
    clockS += dt;

    const localHour = (startHour + clockS / 3600) % 24;
    const tempC = race.seaLevel ? 18 : Math.max(4, 18 - (hHere - 2600) * 0.0065);

    stepPhysiology(phys, dt, {
      speedMs,
      grade,
      elevationM: hHere,
      surface,
      offTrail: false,
      tempC,
      effort: target.gait,
      localHour,
      elapsedHours: clockS / 3600,
      isMoving: speedMs > 0.2,
      stats: runner.stats,
    }, () => 0.99);

    // Check aid stations / checkpoints & cutoffs
    while (cpIdx < cps.length && distM >= cps[cpIdx].d - 15) {
      const cp = cps[cpIdx];
      cp.passed = true;
      cpIdx++;
      if (cp.cutoffH != null && clockS > cp.cutoffH * 3600) {
        dnf = true;
        dnfReason = `Missed cutoff at ${cp.name} (${fmtTime(clockS)} > ${cp.cutoffH}h)`;
        break;
      }
      // Smart autopilot aid refueling
      const isFinishCp = cpIdx === cps.length && cp.d >= totalDistM - 60;
      if (!isFinishCp) {
        refillFlasks(phys, true);
        const cap = phys.stomachCap || 950;
        const isNight = localHour >= 19 || localHour < 6.5;
        for (let k = 0; k < 3; k++) {
          if (stomachLoad(phys) >= cap * 0.65) break;
          if (phys.drowsiness > 0.35 && isNight) eatItem(phys, 'coffee', 1.2);
          else if (phys.sodiumDeficitMg > 1200) eatItem(phys, isNight ? 'broth' : 'potato', 1.2);
          else if (phys.energy < (phys.energyMax || 2200) * 0.80) eatItem(phys, phys.energy < 1100 ? 'quesadilla' : 'pbj', 1.2);
          else if (phys.waterDeficitMl > 600) eatItem(phys, 'electro', 1.2);
          else break;
        }
        lastAidRefuelS = clockS;
      }
    }
    if (dnf) break;

    // On long ultras without dense aid, sip gels carried between stations if getting low
    if (phys.energy < 850 && phys.gelsCarried > 0 && clockS - lastAidRefuelS > 300 && stomachLoad(phys) < (phys.stomachCap || 950) * 0.65) {
      phys.gelsCarried--;
      eatItem(phys, 'gel', speedMs);
      lastAidRefuelS = clockS;
    }

    if (race.cutoffH && clockS > race.cutoffH * 3600) {
      dnf = true;
      dnfReason = `Exceeded overall ${race.cutoffH}h cutoff`;
      break;
    }
  }

  return {
    raceId: race.id,
    runnerId,
    clockS,
    timeStr: fmtTime(clockS),
    paceStr: fmtTime(clockS / Math.max(0.1, totalDistM / MILE_M)) + '/mi',
    dnf,
    dnfReason,
    endEnergy: Math.round(phys.energy),
    endLegs: Math.round(phys.legs),
    endStam: Math.round(phys.stamina),
  };
}

const BENCHMARKS = [
  ['rundola', 'ryan-becker', '20:00', '27:00'],
  ['rundola', 'nick-coury', '24:00', '30:30'],
  ['rundola', 'local-80', '30:00', '40:00'],

  ['rundola-original', 'ryan-becker', '20:30', '27:00'],
  ['rundola-original', 'local-80', '29:00', '39:00'],

  ['spurs-half-marathon', 'willie-milam', '1:05:00', '1:11:00'],
  ['spurs-half-marathon', 'nick-coury', '1:10:00', '1:15:30'],
  ['spurs-half-marathon', 'local-80', '1:23:00', '1:36:00'],

  ['deep-creek-half', 'ryan-becker', '1:36:00', '1:52:00'],
  ['deep-creek-half', 'nick-coury', '1:46:00', '2:04:00'],
  ['deep-creek-half', 'local-80', '2:10:00', '2:42:00'],

  ['imogene-pass-run', 'willie-milam', '2:08:00', '2:28:00'],
  ['imogene-pass-run', 'lisa-kiesler', '2:30:00', '2:54:00'],
  ['imogene-pass-run', 'local-80', '2:55:00', '3:42:00'],

  ['kendall-mountain-run', 'ryan-becker', '1:38:00', '2:02:00'],
  ['kendall-mountain-run', 'local-80', '2:12:00', '2:52:00'],

  ['blue-lakes-alpine-classic', 'ryan-becker', '1:28:00', '1:52:00'],
  ['blue-lakes-alpine-classic', 'local-80', '2:00:00', '2:38:00'],

  ['silverton-alpine-50k', 'willie-milam', '3:45:00', '4:50:00'],
  ['silverton-alpine-50k', 'nick-coury', '3:45:00', '4:50:00'],
  ['silverton-alpine-50k', 'local-80', '5:00:00', '6:30:00'],

  ['telluride-mountain-run', 'dakota-jones', '7:15:00', '9:25:00'],
  ['telluride-mountain-run', 'ryan-becker', '7:15:00', '9:25:00'],
  ['telluride-mountain-run', 'local-80', '9:50:00', '13:00:00'],

  ['san-juan-solstice-50', 'dakota-jones', '7:30:00', '9:50:00'],
  ['san-juan-solstice-50', 'nick-coury', '7:30:00', '9:50:00'],
  ['san-juan-solstice-50', 'local-80', '10:15:00', '13:30:00'],

  ['ouray-50', 'anna-frost', '10:30:00', '14:00:00'],
  ['ouray-50', 'dakota-jones', '10:30:00', '14:00:00'],
  ['ouray-50', 'local-80', '14:00:00', '19:00:00'],

  ['hardrock-100-cw', 'anna-frost', '23:30:00', '31:00:00'],
  ['hardrock-100-cw', 'nick-coury', '23:30:00', '31:00:00'],
  ['hardrock-100-cw', 'dakota-jones', '23:30:00', '31:00:00'],
  ['hardrock-100-cw', 'local-80', '32:30:00', '43:30:00'],

  ['hardrock-100-ccw', 'anna-frost', '23:30:00', '31:00:00'],
  ['hardrock-100-ccw', 'nick-coury', '23:30:00', '31:00:00'],
  ['hardrock-100-ccw', 'dakota-jones', '23:30:00', '31:00:00'],
  ['hardrock-100-ccw', 'local-80', '32:30:00', '43:30:00'],
];

console.log(`\n=== 2. All ${races.length}-Course Realistic Pacing Verification (dt = 1.0 s) ===`);
assert.equal(races.length, 13, 'Expected 13 races including spurs-half-marathon');

const raceById = Object.fromEntries(races.map((r) => [r.id, r]));
const results = [];
let failures = 0;

for (const [raceId, runnerId, minStr, maxStr] of BENCHMARKS) {
  const race = raceById[raceId];
  assert.ok(race, `Missing race ${raceId}`);
  const r = simulateRace(race, runnerId);
  const minS = parseClock(minStr);
  const maxS = parseClock(maxStr);
  const ok = !r.dnf && r.clockS >= minS && r.clockS <= maxS;
  if (!ok) failures++;
  results.push({
    race: raceId,
    runner: runnerId,
    time: r.timeStr,
    target: `${minStr}–${maxStr}`,
    pace: r.paceStr,
    ok: ok ? 'PASS' : (r.dnf ? `DNF: ${r.dnfReason}` : (r.clockS < minS ? 'FAST' : 'SLOW')),
    legs: r.endLegs,
    kcal: r.endEnergy,
  });
}

console.table(results);
if (failures > 0) {
  console.error(`\nFAILED: ${failures}/${results.length} benchmarks outside target window.`);
  process.exit(1);
}
console.log(`\nALL ${results.length}/${results.length} BENCHMARKS ACROSS ALL 13 COURSES PASSED (0 DNFs)!`);
