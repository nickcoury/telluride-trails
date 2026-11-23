// Movement physics, Tobler-inspired ultrarunner grade speed, surface evaluation,
// trail-keeping magnet, cliff slide-back, and autopilot steering.

import {
  CLIFF_GRADE,
  M_TO_FT,
  POWER_HIKE_GRADE,
  SURFACES,
  TRAIL_SNAP_RADIUS_M,
} from './constants.js';
import { physiologySpeedFactor } from './physiology.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * Ultrarunner grade multiplier (modified Tobler hiking/running function).
 * grade = rise / run (e.g. +0.20 = 20% climb, -0.15 = 15% descent).
 */
export function gradeSpeedMultiplier(grade, surface = 'trail') {
  // Smooth Tobler base: peak slightly downhill (~ -0.05)
  const tobler = Math.exp(-3.2 * Math.abs(grade + 0.045));
  // Normalize so grade=0 gives 1.0
  const base0 = Math.exp(-3.2 * 0.045);
  let mul = tobler / base0;

  // Gentle downhill bonus on runnable surfaces, technical penalty on steep descents
  if (grade < -0.12) {
    const steepness = Math.abs(grade + 0.12);
    const techPenalty = surface === 'talus' || surface === 'scree' ? 2.4 : 1.35;
    mul *= Math.max(0.32, 1 - steepness * techPenalty);
  } else if (grade > 0.15) {
    // Power hiking preserves reasonable speed on very steep climbs up to ~35%
    mul = Math.max(mul, clamp(0.62 - (grade - 0.15) * 1.15, 0.20, 0.65));
  }

  return clamp(mul, 0.18, 1.16);
}

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
 * Compute desired world-space direction (unit dx, dz) and target speed from input + trail magnet.
 * Heading convention: yaw=0 faces North (-Z), yaw=+PI/2 faces East (+X) or West?
 * Standard Three.js Y-rotation: forward = (sin(yaw), 0, -cos(yaw)) or (-sin(yaw), 0, -cos(yaw))?
 * Let's support camera-relative input cleanly!
 */
export function computeTrailMagnet(moveX, moveZ, nearest, isTouch = false) {
  if (!nearest || nearest.dist > 5.5) return { x: moveX, z: moveZ };
  const len = Math.hypot(moveX, moveZ);
  if (len < 0.05) return { x: moveX, z: moveZ };

  const ux = moveX / len;
  const uz = moveZ / len;

  // Tangent (tx, tz) is bidirectional; pick sign matching player's intended direction
  let tx = nearest.tx ?? 0;
  let tz = nearest.tz ?? -1;
  const tLen = Math.hypot(tx, tz);
  if (tLen < 1e-5) return { x: moveX, z: moveZ };
  tx /= tLen;
  tz /= tLen;

  const dot = ux * tx + uz * tz;
  if (dot < 0) {
    tx = -tx;
    tz = -tz;
  }

  // Only assist when player is roughly moving along the trail (within ~55 deg),
  // never fight the player if they deliberately turn perpendicular off-trail!
  const align = Math.abs(dot);
  if (align < 0.55) return { x: moveX, z: moveZ };

  // Subtle pull toward trail centerline + tangent alignment
  const toCenterX = nearest.x; // wait: nearest gives point {x, z}
  const strength = isTouch ? 0.36 : 0.18;
  const bx = ux * (1 - strength) + tx * strength;
  const bz = uz * (1 - strength) + tz * strength;
  const bLen = Math.hypot(bx, bz) || 1;
  return { x: (bx / bLen) * len, z: (bz / bLen) * len };
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
 * Base target speed in m/s for effort level before grade/surface/altitude/physiology.
 */
export function baseEffortSpeed(effort) {
  switch (effort) {
    case 'idle':   return 0;
    case 'walk':   return 1.38; // ~19:25/mi
    case 'hike':   return 1.85; // ~14:30/mi brisk hike
    case 'run':    return 3.15; // ~8:30/mi trail cruise
    case 'sprint': return 4.75; // ~5:38/mi hard push
    default:       return 3.15;
  }
}

/**
 * Determine gait label & final target speed.
 */
export function computeTargetSpeed({ effort, grade, surfaceInfo, phys }) {
  if (effort === 'idle') return { speedMs: 0, gait: 'idle', isPowerHike: false };

  let base = baseEffortSpeed(effort);

  // Steep uphill automatically shifts running into power-hike unless sprinting on gentle pitch
  let isPowerHike = false;
  let gait = effort;
  if (grade >= POWER_HIKE_GRADE && (effort === 'run' || effort === 'hike' || effort === 'sprint')) {
    isPowerHike = true;
    gait = 'power-hike';
    base = Math.min(base, effort === 'sprint' ? 2.45 : 2.05);
  }

  const gMul = gradeSpeedMultiplier(grade, surfaceInfo.name || 'trail');
  const sMul = surfaceInfo.speedMul ?? 1.0;
  const pMul = physiologySpeedFactor(phys);

  const speedMs = Math.max(0.45, base * gMul * sMul * pMul);
  return { speedMs, gait, isPowerHike };
}

/**
 * Cliff collision & slide-back.
 * Given terrain normal (nx, ny, nz) with ny = cos(slopeAngle):
 * Slope grade = sqrt(1 - ny*ny) / max(0.05, ny).
 * If slope > CLIFF_GRADE and runner tries to go uphill (dot(dir, horizNormal) < 0),
 * project out the uphill component and apply downhill slide!
 */
export function resolveCliffSlide(vx, vz, normal, dt) {
  if (!normal) return { vx, vz, onCliff: false };
  const ny = clamp(normal.y, 0.05, 1.0);
  const horizMag = Math.hypot(normal.x, normal.z);
  const slopeGrade = horizMag / ny;

  if (slopeGrade <= CLIFF_GRADE || horizMag < 1e-4) {
    return { vx, vz, onCliff: false };
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

  // Add gravity slide downhill proportional to steepness beyond CLIFF_GRADE
  const slideSpeed = clamp((slopeGrade - CLIFF_GRADE) * 3.8, 0.6, 5.5);
  outVx += dx * slideSpeed * Math.min(1, dt * 6 + 0.35);
  outVz += dz * slideSpeed * Math.min(1, dt * 6 + 0.35);

  return { vx: outVx, vz: outVz, onCliff: true };
}
