// Pure JS runner physiology model for Telluride Trails.
// Inspired by track24/src/sim.js, extended with short-term stamina,
// altitude (>11,000 ft), technical terrain stumbling, and stream refills.

import {
  ALT_PENALTY_START_M,
  ALT_SEVERE_FT,
  FOODS,
  M_TO_FT,
  MILE_M,
} from './constants.js';

export const ENERGY_MAX = 2200; // kcal readily available glycogen + fuel
export const STOMACH_CAP = 950;
const KCAL_PER_METER = 108 / MILE_M; // ~108 kcal/mi baseline + vert cost

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function createPhysiology() {
  return {
    energy: 1900,        // kcal
    stamina: 100,        // 0..100 short-term effort reserve (sprinting, steep climbs, bushwhacking)
    stomachKcal: 0,
    stomachMl: 0,
    stomachBulk: 0,
    waterDeficitMl: 0,   // positive = dehydrated (ml), negative = overhydrated
    sodiumDeficitMg: 0,
    caffeineMg: 0,
    legs: 0,             // cumulative muscle fatigue/damage 0..100
    nauseaS: 0,
    crampS: 0,
    falls: 0,
    trips: 0,
    kcalEaten: 0,
    mlDrunk: 0,
    altitudeFactor: 1,   // 0.6..1.0
    drowsiness: 0,       // 0..1
    flasksMl: 1000,      // carried soft flasks (max 1000 ml)
    flaskMaxMl: 1000,
    gelsCarried: 3,
  };
}

export function stomachLoad(p) {
  return p.stomachBulk + 0.4 * p.stomachMl;
}

/**
 * Hydration percentage 0..100 for HUD display.
 * 100% = well hydrated (waterDeficitMl <= 0), 0% = severely dehydrated (>= 3500 ml deficit).
 */
export function hydrationPct(p) {
  return clamp(100 - (Math.max(0, p.waterDeficitMl) / 3500) * 100, 0, 100);
}

/**
 * Altitude performance multiplier.
 * No penalty below 11,000 ft; gradual hypoxia penalty above 11,000 ft down to ~0.68 at 14,150 ft.
 */
export function computeAltitudeFactor(elevationM) {
  const elevFt = elevationM * M_TO_FT;
  if (elevFt <= 11000) return 1.0;
  // ~4.5% per 1000 ft above 11,000 ft, steeper past 13,200 ft
  const aboveK = (elevFt - 11000) / 1000;
  const extra = elevFt > ALT_SEVERE_FT ? ((elevFt - ALT_SEVERE_FT) / 1000) * 0.04 : 0;
  return clamp(1 - aboveK * 0.075 - extra, 0.62, 1.0);
}

/**
 * Circadian drowsiness given local hour (0..24) and continuous hours awake/running.
 */
export function computeDrowsiness(p, localHour, elapsedHours) {
  const awake = 2 + elapsedHours;
  const pressure = clamp((awake - 15) / 18, 0, 1);
  const dh = ((localHour - 4 + 36) % 24) - 12; // distance from 4 AM circadian trough
  const circadian = 0.52 * Math.exp(-(dh * dh) / (2 * 2.5 * 2.5));
  const caf = Math.min(0.5, p.caffeineMg / 220);
  return clamp(pressure * 0.58 + circadian - caf, 0, 1);
}

/**
 * Maximum physiological speed scale (0.25 .. 1.1) applied on top of terrain/grade speed.
 */
export function physiologySpeedFactor(p) {
  let factor = 1 - 0.38 * (p.legs / 100);

  if (p.stamina < 20) factor *= 0.65 + 0.35 * (p.stamina / 20);
  if (p.energy < 400) factor *= 0.45 + 0.55 * (p.energy / 400);
  if (p.energy < 110) factor = Math.min(factor, 0.42); // full bonk: death march

  if (p.waterDeficitMl > 1400) {
    factor *= 1 - clamp((p.waterDeficitMl - 1400) / 3200, 0, 0.45);
  }
  if (p.waterDeficitMl < -1300) factor *= 0.82; // hyponatremic sloshing
  if (stomachLoad(p) > 0.82 * STOMACH_CAP) factor *= 0.78;
  if (p.nauseaS > 0) factor *= 0.72;
  if (p.crampS > 0) factor = Math.min(factor, 0.45);

  factor *= 1 - 0.20 * p.drowsiness;
  factor *= p.altitudeFactor;

  return clamp(factor, 0.25, 1.05);
}

/**
 * Consume food or drink (at an aid station or from pack).
 */
export function eatItem(p, key, speedMs = 0) {
  const f = FOODS[key];
  if (!f) return { ok: false, events: [] };
  const events = [];

  // Running hard while drinking risks spilling half on your vest
  let frac = 1;
  if (f.drink && speedMs > 3.2) {
    frac = 0.6;
    events.push({ type: 'spill', name: f.name });
  }

  p.stomachKcal += f.kcal * frac;
  p.stomachMl += f.ml * frac;
  p.stomachBulk += f.bulk;
  p.sodiumDeficitMg = Math.max(-1500, p.sodiumDeficitMg - f.na);
  p.caffeineMg += f.caf;
  p.kcalEaten += Math.round(f.kcal * frac);
  p.mlDrunk += Math.round(f.ml * frac);
  p.stamina = clamp(p.stamina + (f.caf > 0 ? 14 : 7), 0, 100);
  events.push({ type: 'eat', key, name: f.name, kcal: Math.round(f.kcal * frac), ml: Math.round(f.ml * frac) });

  if (stomachLoad(p) > STOMACH_CAP) {
    p.stomachKcal = 0;
    p.stomachMl = 0;
    p.stomachBulk = 0;
    p.waterDeficitMl += 280;
    p.nauseaS = 180;
    events.push({ type: 'vomit' });
  }

  return { ok: true, events };
}

export function drinkFromFlask(p, ml = 180) {
  if (p.flasksMl <= 0) return { ok: false, events: [{ type: 'empty_flask' }] };
  const taken = Math.min(p.flasksMl, ml);
  p.flasksMl -= taken;
  p.stomachMl += taken;
  p.mlDrunk += Math.round(taken);
  return { ok: true, ml: taken, events: [{ type: 'sip', ml: Math.round(taken) }] };
}

export function refillFlasks(p, atAid = false) {
  const added = p.flaskMaxMl - p.flasksMl;
  p.flasksMl = p.flaskMaxMl;
  if (atAid) {
    p.gelsCarried = Math.max(p.gelsCarried, 4);
  }
  return added;
}

/**
 * Advance physiology by dt seconds.
 * Returns array of discrete events emitted this step.
 */
export function stepPhysiology(p, dt, ctx, rng = Math.random) {
  const events = [];
  if (dt <= 0) return events;

  const {
    speedMs = 0,
    grade = 0,
    elevationM = 2667,
    surface = 'trail',
    offTrail = false,
    tempC = 14,
    effort = 'run', // 'idle'|'walk'|'hike'|'run'|'sprint'
    localHour = 10,
    elapsedHours = 0,
    isMoving = false,
  } = ctx;

  const distM = speedMs * dt;
  const prevEnergy = p.energy;
  const prevHydr = hydrationPct(p);

  // Altitude & circadian state
  p.altitudeFactor = computeAltitudeFactor(elevationM);
  p.drowsiness = computeDrowsiness(p, localHour, elapsedHours);

  // --- Stamina (short-term reserve) ---
  const elevPenalty = elevationM > ALT_PENALTY_START_M ? 1 + (1 - p.altitudeFactor) * 1.4 : 1;
  let staminaDrain = 0;
  if (isMoving) {
    if (effort === 'sprint') staminaDrain = 3.8;
    else if (effort === 'run') staminaDrain = 0.035; // ~45 min sustained cruise on smooth trail
    else if (effort === 'hike' || effort === 'power-hike') staminaDrain = -0.6;
    else staminaDrain = -3.0; // walking recovers stamina

    if (grade > 0.08 && effort !== 'walk') {
      const gradeEffort = effort === 'hike' || effort === 'power-hike' ? 0.8 : 2.2;
      staminaDrain += (grade - 0.08) * gradeEffort;
    }
    if (offTrail) staminaDrain += 1.1;
    if (surface === 'talus' || surface === 'scree' || surface === 'snow') staminaDrain += 0.35;
    if (staminaDrain > 0) staminaDrain *= elevPenalty;
  } else {
    staminaDrain = -8.0; // resting recovers stamina quickly
  }

  // Low energy caps stamina recovery
  const staminaCap = clamp(30 + (p.energy / ENERGY_MAX) * 70, 25, 100);
  p.stamina = clamp(p.stamina - staminaDrain * dt, 0, staminaCap);

  // --- Energy / Fuel ---
  const intensity = clamp((speedMs - 1.4) / 3.0, 0, 1);
  const climbKcal = grade > 0 ? Math.max(0, distM * grade) * 0.0095 : 0; // ~10 kcal per 100m vert
  const offTrailKcal = offTrail ? 1.28 : 1.0;
  const burn = (72 / 3600) * dt + KCAL_PER_METER * distM * offTrailKcal * (1 + 0.14 * Math.max(0, speedMs - 3.0)) + climbKcal;
  const fatIncome = (195 / 3600) * dt * (speedMs < 3.8 ? 1 : 0.65);
  const absorbMax = (820 / 3600) * dt * (1 - 0.25 * intensity) * (p.nauseaS > 0 ? 0.4 : 1);
  const absorbed = Math.min(p.stomachKcal, absorbMax);

  p.stomachKcal -= absorbed;
  if (p.stomachKcal <= 0.5) {
    p.stomachBulk = Math.max(0, p.stomachBulk - (220 / 3600) * dt);
  } else {
    p.stomachBulk = Math.max(0, p.stomachBulk - (absorbed / Math.max(1, absorbed + p.stomachKcal)) * p.stomachBulk);
  }
  p.energy = clamp(p.energy - burn + fatIncome + absorbed, 0, ENERGY_MAX);

  if (prevEnergy >= 380 && p.energy < 380) events.push({ type: 'low_energy' });
  if (prevEnergy >= 110 && p.energy < 110) events.push({ type: 'bonk' });

  // --- Hydration & Electrolytes ---
  const heat = clamp(0.55 + (tempC - 10) * 0.045, 0.45, 1.35);
  // High altitude dries breathing air too
  const altDry = elevationM > ALT_PENALTY_START_M ? 1.15 : 1.0;
  const sweatMl = (0.18 + 0.18 * speedMs) * heat * altDry * (1000 / 3600) * dt;
  p.waterDeficitMl += sweatMl;
  p.sodiumDeficitMg += sweatMl * 0.85;

  const thirst = clamp(p.waterDeficitMl / 3000, 0, 1);
  const drinkAbsorb = Math.min(p.stomachMl, ((1550 + 700 * thirst) / 3600) * dt * (1 - 0.2 * intensity));
  p.stomachMl -= drinkAbsorb;
  p.waterDeficitMl -= drinkAbsorb;
  if (p.waterDeficitMl < 0) {
    p.waterDeficitMl = Math.min(0, p.waterDeficitMl + (340 / 3600) * dt);
  }

  const currHydr = hydrationPct(p);
  if (prevHydr >= 45 && currHydr < 45) events.push({ type: 'dehydrated' });

  // Auto-sip carried flask on long runs when thirsty & moving steadily (not in nausea)
  if (isMoving && p.waterDeficitMl > 650 && p.flasksMl >= 150 && p.stomachMl < 180 && p.nauseaS <= 0) {
    const sip = drinkFromFlask(p, 150);
    if (sip.ok) events.push(...sip.events);
  }

  // --- Legs / Muscle damage ---
  // Steep downhills hammer quads!
  const downhillHammer = grade < -0.08 ? 1 + Math.abs(grade) * 5.0 : 1.0;
  const legRate = (distM / 1000) * 0.16 * Math.pow(Math.max(0.5, speedMs / 3.0), 1.45) * downhillHammer;
  p.legs = clamp(p.legs + legRate, 0, 100);
  if (speedMs < 0.25) {
    p.legs = Math.max(0, p.legs - (1.8 / 3600) * dt);
  }

  // --- Timers & Cramp / Stumble checks ---
  p.caffeineMg *= Math.pow(0.5, dt / (5 * 3600));
  p.nauseaS = Math.max(0, p.nauseaS - dt);
  p.crampS = Math.max(0, p.crampS - dt);

  if (p.crampS <= 0 && speedMs > 1.2 && p.sodiumDeficitMg > 2400) {
    const pPerMin = (p.sodiumDeficitMg - 2400) / 26000 + p.legs / 4200;
    if (rng() < (pPerMin * dt) / 60) {
      p.crampS = 22 + rng() * 30;
      events.push({ type: 'cramp' });
    }
  }

  return events;
}

/**
 * Probability per second of tripping/falling on technical terrain when tired.
 */
export function fallProbabilityPerSec(p, speedMs, stumbleMul = 1.0, grade = 0) {
  if (speedMs < 1.35) return 0;
  const fatigue = Math.pow(p.legs / 100, 2) * 0.012 + Math.pow(p.drowsiness, 2) * 0.015;
  const lowStam = p.stamina < 18 ? 0.012 : 0;
  const downhillRisk = grade < -0.10 ? 1 + Math.abs(grade) * 3 : 1;
  const speedRisk = speedMs > 3.6 ? 1.8 : speedMs > 2.4 ? 1.0 : 0.4;
  // Base rate is tiny unless tired + technical + fast downhill
  return (0.00015 + fatigue + lowStam) * stumbleMul * downhillRisk * speedRisk;
}
