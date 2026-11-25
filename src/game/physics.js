// Movement physics, Tobler-inspired ultrarunner grade speed, surface evaluation,
// trail-keeping magnet, cliff slide-back, and autopilot steering.

import {
  AUTO_POWER_HIKE_GRADE,
  CLIFF_GRADE,
  M_TO_FT,
  SURFACES,
  TRAIL_SNAP_RADIUS_M,
} from './constants.js';
import { physiologySpeedFactor } from './physiology.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const statNorm = (s) => (clamp(Number.isFinite(s) ? s : 80, 50, 99) - 80) / 20;
const ROUGH_SURFACES = new Set(['scree', 'talus', 'forest', 'creek', 'snow']);

const DOWNHILL_PEAK_0 = Math.exp(-Math.pow(0.08 / 0.065, 2));

/**
 * Running grade multiplier (separate from hiking VAM curve so steep climbs never triple-compound).
 * - Downhill: sweet spot around -7%..-9% (~1.14x), technical braking past -13%.
 * - Uphill: smooth 1 / (1 + grade * (4.0 - 0.65 * nClimb)) so strong climbers can run 12–18%
 *   faster than hiking (at a sharp stamina cost!).
 */
export function runGradeMultiplier(grade, surface = 'trail', stats = null) {
  const nClimb = statNorm(stats?.climbing);
  const nTech = statNorm(stats?.technical);

  if (grade < 0) {
    const bump = (Math.exp(-Math.pow((grade + 0.08) / 0.065, 2)) - DOWNHILL_PEAK_0) / (1 - DOWNHILL_PEAK_0);
    let mul = 1 + 0.14 * Math.max(0, bump);
    if (grade < -0.13) {
      const steepness = -grade - 0.13;
      const brake = surface === 'talus' ? 2.4 : surface === 'scree' ? 2.0 : surface === 'road' ? 0.75 : surface === 'track' ? 0.92 : 1.35;
      mul *= Math.max(0.32, 1 - steepness * brake);
    }
    if (grade < -0.10) {
      mul *= 1 + nTech * 0.18;
    }
    return clamp(mul, 0.28, 1.34);
  }

  const climbSlope = Math.max(2.3, 3.35 - 0.68 * nClimb);
  const mul = 1 / (1 + grade * climbSlope);
  return clamp(mul, 0.18, 1.0);
}

// Backward-compatible alias
export const gradeSpeedMultiplier = runGradeMultiplier;

/**
 * Determine active surface key & trail context from terrain.getSurface + trailData.nearest.
 */
export function evaluateSurface(x, z, terrain, trailData) {
  const nearest = trailData?.nearest ? trailData.nearest(x, z, 18) : null;
  const cover = terrain?.getSurface ? terrain.getSurface(x, z) : { forest: 0, rock: 0, water: 0, snow: 0, grass: 1 };
  const elevM = terrain?.getHeight ? terrain.getHeight(x, z) : 2667;
  const elevFt = elevM * M_TO_FT;

  let onTrail = false;
  let surface = 'grass';
  let trailDistM = nearest ? nearest.dist : Infinity;

  if (nearest) {
    const snapR = TRAIL_SNAP_RADIUS_M[nearest.kind] ?? 4.5;
    if (nearest.dist <= snapR) {
      onTrail = true;
      if (nearest.kind === 'road') surface = 'road';
      else if (nearest.kind === 'track') surface = 'track';
      else {
        // High difficulty / alpine trail with rocky cover becomes scree or talus
        const diff = (nearest.difficulty || '').toLowerCase();
        if (cover.water > 0.55) {
          surface = 'creek';
        } else if (cover.snow > 0.55 && elevFt > 11200) {
          surface = 'snow';
        } else if (cover.rock > 0.72 && (diff.includes('demanding') || diff.includes('alpine') || elevFt > 12300)) {
          surface = elevFt > 12900 ? 'talus' : 'scree';
        } else {
          surface = nearest.kind === 'path' ? 'path' : 'trail';
        }
      }
    }
  }

  if (!onTrail) {
    if (cover.water > 0.45) surface = 'creek';
    else if (cover.snow > 0.45) surface = 'snow';
    else if (cover.rock > 0.45) surface = elevFt > 12500 ? 'talus' : 'scree';
    else if (cover.forest > 0.40) surface = 'forest';
    else surface = 'grass';
  }

  return {
    surface,
    surfaceInfo: SURFACES[surface] || SURFACES.trail,
    onTrail,
    nearest,
    trailDistM,
    cover,
    elevM,
    elevFt,
  };
}

/**
 * Blend steering slightly toward trail centerline so runner stays centered on singletrack.
 */
export function applyTrailCenterPull(px, pz, dirX, dirZ, nearest, isTouch = false) {
  if (!nearest || nearest.dist > 5.5) return { x: dirX, z: dirZ };
  const len = Math.hypot(dirX, dirZ);
  if (len < 0.05) return { x: dirX, z: dirZ };

  let tx = nearest.tx ?? 0;
  let tz = nearest.tz ?? -1;
  const tLen = Math.hypot(tx, tz) || 1;
  tx /= tLen;
  tz /= tLen;

  const ux = dirX / len;
  const uz = dirZ / len;
  const dot = ux * tx + uz * tz;
  if (Math.abs(dot) < 0.55) return { x: dirX, z: dirZ };

  if (dot < 0) {
    tx = -tx;
    tz = -tz;
  }

  // Cross-track correction toward nearest point on trail
  const cx = nearest.x - px;
  const cz = nearest.z - pz;
  const pull = isTouch ? 0.28 : 0.14;
  const targetX = tx + cx * 0.25;
  const targetZ = tz + cz * 0.25;
  const tNorm = Math.hypot(targetX, targetZ) || 1;

  const rx = ux * (1 - pull) + (targetX / tNorm) * pull;
  const rz = uz * (1 - pull) + (targetZ / tNorm) * pull;
  const rNorm = Math.hypot(rx, rz) || 1;
  return { x: (rx / rNorm) * len, z: (rz / rNorm) * len };
}

/**
 * Base flat singletrack speed in m/s at STAT_BASELINE (80) before stats/grade/surface/physiology.
 */
export function baseEffortSpeed(effort) {
  switch (effort) {
    case 'idle':   return 0;
    case 'walk':   return 1.42; // ~18:53/mi casual walk
    case 'hike':   return 1.98; // ~13:33/mi brisk trail hike
    case 'run':    return 3.38; // ~7:56/mi strong local flat singletrack cruise
    case 'sprint': return 4.45; // ~6:02/mi (~1.32x run)
    default:       return 3.38;
  }
}

/**
 * Direct Horizontal + VAM Euclidean hiking / power-hiking speed (never multiplied by runGradeMultiplier).
 */
export function computeHikeSpeed(grade, stats = null) {
  const nSpeed = statNorm(stats?.speed);
  const nClimb = statNorm(stats?.climbing);
  const vHikeFlat = 1.98 * (1 + nSpeed * 0.08 + nClimb * 0.12);
  if (grade > 0) {
    const vamMs = 0.345 * (1 + nClimb * 0.38);
    return 1 / Math.hypot(1 / vHikeFlat, grade / vamMs);
  }
  return vHikeFlat * clamp(1 - grade * 0.8, 0.85, 1.16);
}

/**
 * Determine gait label & final target speed.
 * Separates Run vs. Hike/Power-Hike curves, applies ultra aerobic pacing & optional sea-level boost.
 */
export function computeTargetSpeed({ effort, grade, surface = 'trail', surfaceInfo, phys, stats = null, race = null }) {
  if (effort === 'idle') return { speedMs: 0, gait: 'idle', isPowerHike: false };

  const nSpeed = statNorm(stats?.speed);
  const nClimb = statNorm(stats?.climbing);
  const nTech = statNorm(stats?.technical);
  const nEnd = statNorm(stats?.endurance);

  // Hysteresis for low-stamina forced power-hike so runner doesn't stutter between run/hike at 10% stamina
  const stam = phys?.stamina ?? 100;
  let forcedByStamina = Boolean(phys?._forcedPowerHike);
  if (stam < 10) forcedByStamina = true;
  else if (stam > 28 && grade < AUTO_POWER_HIKE_GRADE) forcedByStamina = false;
  if (phys) phys._forcedPowerHike = forcedByStamina;

  const sprintShiftGrade = stam > 20 ? 0.32 : AUTO_POWER_HIKE_GRADE;
  const autoShiftToPowerHike =
    (effort === 'run' && (grade >= AUTO_POWER_HIKE_GRADE || forcedByStamina)) ||
    (effort === 'sprint' && (grade >= sprintShiftGrade || forcedByStamina));

  let sMul = surfaceInfo?.speedMul ?? 1.0;
  if (ROUGH_SURFACES.has(surface)) {
    sMul *= 1 + nTech * 0.18;
  }
  const pMul = physiologySpeedFactor(phys);
  // Sea-level oxygen + carbon super-shoe road boost (Austin Half Marathon)
  const seaLevelMul = race?.seaLevel ? 1.19 : 1.0;

  // Distance-aware race intensity:
  // - Short sub-8 equivMi trail climbs run at threshold pace (run only, not hike VAM)
  // - Half-to-100M mountain courses scale aerobic pacing with endurance advantage past 22 equivMi
  const equivMi = (race?.distanceMi || 0) + (race?.gainFt || 0) / 1000;
  const shortRunBoost = (race && !race.seaLevel && equivMi > 0 && equivMi < 8)
    ? 1 + 0.30 * clamp((8 - equivMi) / 5, 0, 1) * (1 + nClimb * 0.28)
    : 1.0;
  const ultraEndWeight = clamp((equivMi - 18) / 28, 0, 1);
  const ultraRunScale = (!race?.seaLevel && equivMi > 14)
    ? (1 / (1 + 0.26 * Math.log(1 + Math.max(0, equivMi - 13) / 15))) * (1 + nEnd * 0.145 * ultraEndWeight)
    : 1.0;
  const ultraHikeScale = (!race?.seaLevel && equivMi > 18)
    ? (1 / (1 + 0.27 * Math.log(1 + Math.max(0, equivMi - 18) / 18))) * (1 + nEnd * 0.145 * ultraEndWeight)
    : 1.0;

  if (effort === 'hike' || effort === 'power-hike' || autoShiftToPowerHike) {
    const isPowerHike = effort === 'power-hike' || autoShiftToPowerHike || grade >= 0.06;
    const gait = isPowerHike ? 'power-hike' : 'hike';
    const rawHike = computeHikeSpeed(grade, stats);
    // Hiking handles uneven trail/path surfaces more steadily than running
    const hikeSurfaceMul = sMul < 1 ? (0.45 + 0.55 * sMul) : (1 + (sMul - 1) * 0.5);
    const speedMs = Math.max(0.42, rawHike * hikeSurfaceMul * pMul * ultraHikeScale * seaLevelMul);
    return { speedMs, gait, isPowerHike };
  }

  if (effort === 'walk') {
    const baseWalk = baseEffortSpeed('walk') * (1 + nSpeed * 0.06);
    const walkGrade = grade > 0 ? 1 / (1 + grade * 2.2) : clamp(1 - grade * 0.4, 0.85, 1.08);
    const speedMs = Math.max(0.42, baseWalk * walkGrade * Math.min(1.05, sMul) * pMul);
    return { speedMs, gait: 'walk', isPowerHike: false };
  }

  // Running or Sprinting
  const baseRun = baseEffortSpeed(effort) * (1 + nSpeed * 0.31);
  const gMul = runGradeMultiplier(grade, surface, stats);
  const speedMs = Math.max(0.48, baseRun * gMul * sMul * pMul * ultraRunScale * shortRunBoost * seaLevelMul);
  return { speedMs, gait: effort, isPowerHike: false };
}

/**
 * Cliff collision & slide-back.
 * Given terrain normal (nx, ny, nz) with ny = cos(slopeAngle):
 * Slope grade = sqrt(1 - ny*ny) / max(0.05, ny).
 * Never strips velocity or slides when steering back toward a nearby trail (<=30m) or race course (<=40m),
 * and validates passive slide destinations to prevent V-gully trapping.
 */
export function resolveCliffSlide(vx, vz, normal, dt, cliffGradeLimit = CLIFF_GRADE, opts = null) {
  if (!normal) return { vx, vz, onCliff: false };
  const ny = clamp(normal.y, 0.05, 1.0);
  const horizMag = Math.hypot(normal.x, normal.z);
  const slopeGrade = horizMag / ny;

  if (slopeGrade <= cliffGradeLimit || horizMag < 1e-4) {
    return { vx, vz, onCliff: false };
  }

  // Never block or slide a runner actively steering back toward a nearby trail or race line
  if (opts) {
    const speed = Math.hypot(vx, vz);
    if (speed > 0.05) {
      const ux = vx / speed;
      const uz = vz / speed;
      const nt = opts.nearestTrail;
      if (nt && nt.dist <= 30 && Number.isFinite(nt.x) && Number.isFinite(nt.z)) {
        const tx = nt.x - opts.x;
        const tz = nt.z - opts.z;
        const tLen = Math.hypot(tx, tz);
        if (tLen > 0.1 && (ux * tx + uz * tz) / tLen > 0.15) {
          return { vx, vz, onCliff: false };
        }
      }
      const ct = opts.courseTarget;
      if (ct && opts.offCourseM <= 40 && Number.isFinite(ct.x) && Number.isFinite(ct.z)) {
        const tx = ct.x - opts.x;
        const tz = ct.z - opts.z;
        const tLen = Math.hypot(tx, tz);
        if (tLen > 0.1 && (ux * tx + uz * tz) / tLen > 0.15) {
          return { vx, vz, onCliff: false };
        }
      }
    }
  }

  // Downhill unit horizontal vector = (normal.x, normal.z) / horizMag
  const dx = normal.x / horizMag;
  const dz = normal.z / horizMag;
  const dot = vx * dx + vz * dz; // negative means trying to climb uphill

  let outVx = vx;
  let outVz = vz;
  if (dot < 0) {
    // Strip uphill velocity component
    outVx -= dot * dx;
    outVz -= dot * dz;
  }

  // Validate passive slide destination before sliding (prevents V-gully / water / building traps)
  let canSlide = true;
  if (opts && Number.isFinite(opts.x) && Number.isFinite(opts.z)) {
    const probeX = opts.x + dx * 0.75;
    const probeZ = opts.z + dz * 0.75;
    if (typeof opts.isBlocked === 'function' && opts.isBlocked(probeX, probeZ)) {
      canSlide = false;
    } else if (typeof opts.getGroundY === 'function') {
      const hHere = opts.getGroundY(opts.x, opts.z);
      const hProbe = opts.getGroundY(probeX, probeZ);
      if (Number.isFinite(hHere) && Number.isFinite(hProbe) && hProbe >= hHere - 0.02) {
        canSlide = false;
      }
    }
  }

  if (canSlide) {
    const slideSpeed = clamp((slopeGrade - cliffGradeLimit) * 3.8, 0.6, 5.5);
    outVx += dx * slideSpeed * Math.min(1, dt * 6 + 0.35);
    outVz += dz * slideSpeed * Math.min(1, dt * 6 + 0.35);
  }

  return { vx: outVx, vz: outVz, onCliff: true };
}

/**
 * Ray-casting point-in-polygon for packed Float32Array [x, y, z, ...] lake rings.
 */
function pointInLakeRing(x, z, coords) {
  const n = Math.floor(coords.length / 3);
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = coords[i * 3];
    const zi = coords[i * 3 + 2];
    const xj = coords[j * 3];
    const zj = coords[j * 3 + 2];
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / ((zj - zi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Check whether world position (x, z) is inside deep standing lake water
 * (Ice Lake, Blue Lakes, etc.) and not on a trail/bridge.
 * Avoids calling terrain.getSurface() on dry ground unless nearWaterHint is true.
 */
export function isDeepLakeWater(x, z, engine, terrain, trailData, onTrail = false, nearWaterHint = false) {
  if (onTrail) return false;
  if (engine?.worldWaterMask?.isInLake) {
    if (engine.worldWaterMask.isInLake(x, z, 0)) return true;
    // Fast path: when worldWaterMask is active and we aren't near cover water, skip DEM/cover query
    if (!nearWaterHint) return false;
  } else if (Array.isArray(trailData?.lakes) && trailData.lakes.length > 0) {
    for (let i = 0; i < trailData.lakes.length; i++) {
      const lake = trailData.lakes[i];
      const b = lake.bbox;
      if (b && (x < b[0] || x > b[2] || z < b[1] || z > b[3])) continue;
      if (lake.coords && pointInLakeRing(x, z, lake.coords)) return true;
    }
    if (!nearWaterHint) return false;
  } else if (!nearWaterHint) {
    return false;
  }

  const cover = terrain?.getSurface ? terrain.getSurface(x, z) : null;
  if (cover && cover.water > 0.72) {
    const nearest = trailData?.nearest ? trailData.nearest(x, z, 8) : null;
    if (!nearest || nearest.dist > 5.5) return true;
  }
  return false;
}

const SHORE_RADII = [15, 35, 60, 95, 140, 210];
const SHORE_ANGLES = 12;

/**
 * If (x, z) lies inside deep lake water, find the closest dry shoreline point
 * via nearest trail first, then a fast concentric radial scan.
 */
export function findDryShore(x, z, engine, terrain, trailData) {
  if (!isDeepLakeWater(x, z, engine, terrain, trailData, false, true)) {
    return { x, z, nudged: false };
  }
  const nr = trailData?.nearest ? trailData.nearest(x, z, 260) : null;
  if (nr && !isDeepLakeWater(nr.x, nr.z, engine, terrain, trailData, false, true)) {
    return { x: nr.x, z: nr.z, nudged: true };
  }
  for (let ri = 0; ri < SHORE_RADII.length; ri++) {
    const r = SHORE_RADII[ri];
    for (let ai = 0; ai < SHORE_ANGLES; ai++) {
      const a = (ai / SHORE_ANGLES) * Math.PI * 2;
      const cx = x + Math.cos(a) * r;
      const cz = z + Math.sin(a) * r;
      if (!isDeepLakeWater(cx, cz, engine, terrain, trailData, false, true)) {
        return { x: cx, z: cz, nudged: true };
      }
    }
  }
  return { x, z, nudged: false };
}
