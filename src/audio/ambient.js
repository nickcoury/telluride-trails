/**
 * Contextual & positional San Juan ambient soundscape:
 * - Ridge/valley wind (elevation, forest shelter, and monsoon gusts)
 * - Quaking aspen leaf rustle in forest cover
 * - Birds by day (below treeline, calm weather) & crickets at night (valleys)
 * - Distant town murmur near Telluride & San Juan towns
 * - Positional river/creek rushing water & waterfall roars (Bridal Veil, Ingram, etc.)
 * - Positional gondola/aerialway cable hum near cabins
 * - Monsoon rain bed + speed-of-sound delayed canyon thunder after lightning
 */

import { lonLatToWorld } from '../core/geo.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const ICONIC_WATERFALLS = [
  { id: 'iconic_bridal_veil', name: 'Bridal Veil Falls', lon: -107.7689, lat: 37.9211, heightM: 111 },
  { id: 'iconic_ingram', name: 'Ingram Falls', lon: -107.7753, lat: 37.9286, heightM: 65 },
  { id: 'iconic_cornet', name: 'Cornet Creek Falls', lon: -107.8075, lat: 37.9438, heightM: 24 },
  { id: 'iconic_bear_creek_ouray', name: 'Bear Creek Falls', lon: -107.6634, lat: 37.9912, heightM: 69 },
];

const FALLBACK_TOWN_CENTERS = [
  { name: 'Telluride', ...lonLatToWorld(-107.8123, 37.9375) },
  { name: 'Mountain Village', ...lonLatToWorld(-107.8558, 37.9325) },
  { name: 'Silverton', ...lonLatToWorld(-107.6645, 37.8119) },
  { name: 'Ouray', ...lonLatToWorld(-107.6714, 38.0228) },
  { name: 'Lake City', ...lonLatToWorld(-107.3153, 38.0300) },
];

function getDenverHour() {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Denver',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? now.getHours());
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? now.getMinutes());
    return (hh % 24) + mm / 60;
  } catch {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60;
  }
}

function parseLocalTimeStr(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') hh += 12;
  return hh + Number(m[2]) / 60;
}

/**
 * Closest point on a stride-3 polyline [x,y,z,...] in XZ to (px, pz).
 * Writes result into `out` to avoid per-frame allocations.
 */
function nearestPointOnPolylineXZ(coords, px, pz, out) {
  if (!coords || coords.length < 6) return false;
  let found = false;
  for (let i = 0; i <= coords.length - 6; i += 3) {
    const ax = coords[i];
    const az = coords[i + 2];
    const bx = coords[i + 3];
    const bz = coords[i + 5];
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    let t = 0;
    if (lenSq > 1e-4) {
      t = clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1);
    }
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const dSq = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
    if (dSq < out.distSq) {
      out.distSq = dSq;
      out.x = cx;
      out.z = cz;
      found = true;
    }
  }
  return found;
}

function computeStereoPan(dx, dz, yaw) {
  const dist = Math.hypot(dx, dz);
  if (dist < 1.5) return 0;
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const rightDot = (dx * rightX + dz * rightZ) / dist;
  return clamp(rightDot * 0.9, -0.9, 0.9);
}

export function createAmbientSystem(audioCtx, engine, { terrain, trailData } = {}) {
  let bedsBuilt = false;
  let disposed = false;

  // Continuous bed nodes
  const sources = [];
  let windLowFilter, windLowGain;
  let windHighFilter, windHighGain;
  let leavesGain;
  let rainLowGain, rainHighGain;
  let townGain;
  let riverBodyGain, riverSparkleGain, riverPanner;
  let wfRumbleGain, wfHissGain, wfPanner;
  let gondolaGain, gondolaOsc1, gondolaOsc2, gondolaPanner;

  // Storm state
  let stormActive = false;
  let stormIntensity = 0;
  const thunderTimers = new Set();

  // Spatial caches (refreshed on data:chunk)
  let waterfalls = [];
  let townCenters = [...FALLBACK_TOWN_CENTERS];
  let fallbackAerialway = null;

  // Throttled spatial scan state
  let spatialTimer = 0;
  let targetRiverGain = 0;
  let targetRiverPan = 0;
  let targetWfGain = 0;
  let targetWfPan = 0;
  let targetGondolaGain = 0;
  let targetGondolaPan = 0;
  let targetTownGain = 0;

  // Wildlife timers
  let birdTimer = 2.0 + Math.random() * 4.0;
  let cricketTimer = 1.5 + Math.random() * 2.5;
  let gustClock = 0;
  let lastPlayerX = 0;
  let lastPlayerZ = 0;
  let lastYaw = 0;

  const _scratchNearest = { distSq: Infinity, x: 0, z: 0 };

  function rebuildSpatialCaches() {
    // Waterfalls: trailData.waterfalls + iconic San Juan falls
    const wfList = [];
    if (Array.isArray(trailData?.waterfalls)) {
      for (const wf of trailData.waterfalls) {
        if (Number.isFinite(wf?.x) && Number.isFinite(wf?.z)) {
          wfList.push({ x: wf.x, z: wf.z, heightM: wf.heightM || 40 });
        }
      }
    }
    for (const ic of ICONIC_WATERFALLS) {
      const p = lonLatToWorld(ic.lon, ic.lat);
      const dup = wfList.some((w) => Math.hypot(w.x - p.x, w.z - p.z) < 200);
      if (!dup) wfList.push({ x: p.x, z: p.z, heightM: ic.heightM });
    }
    waterfalls = wfList;

    // Town centers from POIs + fallbacks
    const towns = [...FALLBACK_TOWN_CENTERS];
    if (Array.isArray(trailData?.pois)) {
      for (const poi of trailData.pois) {
        if (poi?.kind === 'town' && Number.isFinite(poi.x) && Number.isFinite(poi.z)) {
          const dup = towns.some((t) => Math.hypot(t.x - poi.x, t.z - poi.z) < 350);
          if (!dup) towns.push({ name: poi.name, x: poi.x, z: poi.z });
        }
      }
    }
    townCenters = towns;

    if (!fallbackAerialway && (!trailData?.aerialways || trailData.aerialways.length === 0)) {
      const p1 = lonLatToWorld(-107.8130, 37.9354);
      const p2 = lonLatToWorld(-107.8268, 37.9261);
      const p3 = lonLatToWorld(-107.8473, 37.9328);
      fallbackAerialway = {
        coords: new Float32Array([p1.x, 2670, p1.z, p2.x, 3212, p2.z, p3.x, 2908, p3.z]),
      };
    }
  }
  rebuildSpatialCaches();

  function makeNoiseBed(ctx, bufType, filterType, freq, q, dest) {
    const buf = audioCtx.getNoiseBuffer(bufType);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start(0, Math.random() * 0.9);
    sources.push(src);
    return { src, filter, gain };
  }

  function ensureBedsBuilt() {
    if (bedsBuilt || disposed || !audioCtx.isUnlocked || !audioCtx.context) return;
    const ctx = audioCtx.context;
    const amb = audioCtx.ambientGain;

    // Wind: low valley/ridge roar + high mountain whistle
    const wLow = makeNoiseBed(ctx, 'pink', 'bandpass', 240, 0.9, amb);
    windLowFilter = wLow.filter;
    windLowGain = wLow.gain;

    const wHigh = makeNoiseBed(ctx, 'pink', 'bandpass', 780, 1.8, amb);
    windHighFilter = wHigh.filter;
    windHighGain = wHigh.gain;

    // Aspen leaf rustle
    const leaves = makeNoiseBed(ctx, 'white', 'bandpass', 2800, 1.1, amb);
    leavesGain = leaves.gain;

    // Monsoon rain
    const rLow = makeNoiseBed(ctx, 'pink', 'lowpass', 620, 0.7, amb);
    rainLowGain = rLow.gain;
    const rHigh = makeNoiseBed(ctx, 'white', 'bandpass', 2100, 0.85, amb);
    rainHighGain = rHigh.gain;

    // Distant town murmur
    const town = makeNoiseBed(ctx, 'brown', 'bandpass', 330, 1.1, amb);
    townGain = town.gain;

    // Positional river / creek
    riverPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : amb;
    if (riverPanner !== amb) riverPanner.connect(amb);
    const rBody = makeNoiseBed(ctx, 'brown', 'lowpass', 480, 0.8, riverPanner);
    riverBodyGain = rBody.gain;
    const rSpark = makeNoiseBed(ctx, 'pink', 'bandpass', 1800, 1.2, riverPanner);
    riverSparkleGain = rSpark.gain;

    // Positional waterfall roar
    wfPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : amb;
    if (wfPanner !== amb) wfPanner.connect(amb);
    const wfR = makeNoiseBed(ctx, 'brown', 'lowpass', 145, 0.8, wfPanner);
    wfRumbleGain = wfR.gain;
    const wfH = makeNoiseBed(ctx, 'pink', 'bandpass', 860, 0.85, wfPanner);
    wfHissGain = wfH.gain;

    // Positional gondola / lift hum
    gondolaPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : amb;
    if (gondolaPanner !== amb) gondolaPanner.connect(amb);
    gondolaGain = ctx.createGain();
    gondolaGain.gain.value = 0;
    const gondFilter = ctx.createBiquadFilter();
    gondFilter.type = 'lowpass';
    gondFilter.frequency.value = 340;
    gondolaGain.connect(gondFilter);
    gondFilter.connect(gondolaPanner);

    gondolaOsc1 = ctx.createOscillator();
    gondolaOsc1.type = 'triangle';
    gondolaOsc1.frequency.value = 108;
    const g1 = ctx.createGain();
    g1.gain.value = 0.65;
    gondolaOsc1.connect(g1);
    g1.connect(gondolaGain);

    gondolaOsc2 = ctx.createOscillator();
    gondolaOsc2.type = 'sine';
    gondolaOsc2.frequency.value = 162;
    const g2 = ctx.createGain();
    g2.gain.value = 0.35;
    gondolaOsc2.connect(g2);
    g2.connect(gondolaGain);

    gondolaOsc1.start(0);
    gondolaOsc2.start(0);
    sources.push(gondolaOsc1, gondolaOsc2);

    bedsBuilt = true;
  }

  function playBirdCall() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('wildlife', 1200);
    if (!release) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const pan = (Math.random() - 0.5) * 1.5;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);

    let dest = audioCtx.ambientGain;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(dest);
    } else {
      gain.connect(dest);
    }
    osc.connect(gain);

    // Pick a San Juan songbird motif (mountain chickadee / warbler / canyon wren)
    const motif = Math.floor(Math.random() * 3);
    const baseFreq = 2500 + Math.random() * 1100;
    const vol = 0.025 + Math.random() * 0.02;
    let t = now + 0.02;

    if (motif === 0) {
      // Chickadee-dee-dee (high pure whistle then 2 crisp notes)
      const notes = [1.0, 0.88, 0.88];
      const durs = [0.16, 0.09, 0.09];
      for (let i = 0; i < notes.length; i++) {
        osc.frequency.setValueAtTime(baseFreq * notes[i], t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + durs[i]);
        t += durs[i] + 0.06;
      }
    } else if (motif === 1) {
      // Canyon wren descending cascade
      for (let i = 0; i < 5; i++) {
        const f = baseFreq * (1.25 - i * 0.14);
        osc.frequency.setValueAtTime(f, t);
        osc.frequency.exponentialRampToValueAtTime(f * 0.86, t + 0.09);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(vol * 0.9, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
        t += 0.125;
      }
    } else {
      // Rising two-note warbler chirp
      for (let i = 0; i < 2; i++) {
        const f = baseFreq * (0.9 + i * 0.18);
        osc.frequency.setValueAtTime(f, t);
        osc.frequency.exponentialRampToValueAtTime(f * 1.15, t + 0.07);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
        t += 0.14;
      }
    }

    osc.start(now);
    osc.stop(t + 0.04);
    osc.onended = release;
  }

  function playCricketChirp() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('wildlife', 900);
    if (!release) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const pan = (Math.random() - 0.5) * 1.4;
    const freq = 4100 + Math.random() * 550;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);

    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      panner.connect(audioCtx.ambientGain);
    } else {
      gain.connect(audioCtx.ambientGain);
    }
    osc.connect(gain);

    const pulses = 3 + Math.floor(Math.random() * 2);
    const vol = 0.014 + Math.random() * 0.01;
    let t = now + 0.01;
    for (let i = 0; i < pulses; i++) {
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.032);
      t += 0.046;
    }

    osc.start(now);
    osc.stop(t + 0.03);
    osc.onended = release;
  }

  function playThunder({ x, z, dist = 2200, close = false }) {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('thunder', 5200);
    if (!release) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const brown = audioCtx.getNoiseBuffer('brown');
    const pink = audioCtx.getNoiseBuffer('pink');
    if (!brown || !pink) {
      release();
      return;
    }

    const pan = Number.isFinite(x) && Number.isFinite(z)
      ? computeStereoPan(x - lastPlayerX, z - lastPlayerZ, lastYaw)
      : (Math.random() - 0.5) * 0.8;

    const distFactor = close ? 1.0 : clamp(1 - (dist - 1200) / 3600, 0.35, 0.95);
    const dur = 2.6 + distFactor * 2.2;

    const outNode = ctx.createStereoPanner ? ctx.createStereoPanner() : audioCtx.ambientGain;
    if (outNode !== audioCtx.ambientGain) {
      outNode.pan.value = pan;
      outNode.connect(audioCtx.ambientGain);
      if (audioCtx.canyonConvolver) outNode.connect(audioCtx.canyonConvolver);
    }

    // Initial crack for closer strikes
    if (close || dist < 2100) {
      const crackSrc = ctx.createBufferSource();
      crackSrc.buffer = pink;
      const crackFilter = ctx.createBiquadFilter();
      crackFilter.type = 'bandpass';
      crackFilter.frequency.setValueAtTime(1400, now);
      crackFilter.frequency.exponentialRampToValueAtTime(160, now + 0.45);
      const crackGain = ctx.createGain();
      crackGain.gain.setValueAtTime(0.0001, now);
      crackGain.gain.linearRampToValueAtTime(0.55 * distFactor, now + 0.015);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      crackSrc.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(outNode);
      crackSrc.start(now, Math.random() * 0.4, 0.6);
    }

    // Rolling low canyon thunder rumble
    const rumSrc = ctx.createBufferSource();
    rumSrc.buffer = brown;
    rumSrc.loop = true;

    const rumFilter = ctx.createBiquadFilter();
    rumFilter.type = 'lowpass';
    rumFilter.frequency.setValueAtTime(close ? 260 : 175, now);
    rumFilter.frequency.exponentialRampToValueAtTime(52, now + dur);

    const rumGain = ctx.createGain();
    rumGain.gain.setValueAtTime(0.0001, now);
    rumGain.gain.linearRampToValueAtTime(0.65 * distFactor, now + 0.14);
    // Secondary canyon echo swell
    rumGain.gain.linearRampToValueAtTime(0.32 * distFactor, now + dur * 0.38);
    rumGain.gain.linearRampToValueAtTime(0.45 * distFactor, now + dur * 0.52);
    rumGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    rumSrc.connect(rumFilter);
    rumFilter.connect(rumGain);
    rumGain.connect(outNode);
    rumSrc.start(now, Math.random() * 0.5, dur + 0.05);
    rumSrc.onended = release;
  }

  function scheduleLightningThunder(payload = {}) {
    const dist = Number.isFinite(payload.dist) ? payload.dist : 2200;
    // Speed of sound ~343 m/s, capped at 8.5s so players reliably hear the echo
    const delayMs = payload.close ? 120 : clamp((dist / 343) * 1000, 350, 8500);
    const tid = setTimeout(() => {
      thunderTimers.delete(tid);
      if (!disposed) playThunder(payload);
    }, delayMs);
    thunderTimers.add(tid);
  }

  function scanPositionalSources(px, pz, yaw, hud) {
    // 1. Nearest waterway (rivers & creeks)
    let bestWaterDist = Infinity;
    let bestWaterX = px;
    let bestWaterZ = pz;
    if (Array.isArray(trailData?.waterways)) {
      const wList = trailData.waterways;
      for (let i = 0; i < wList.length; i++) {
        const w = wList[i];
        _scratchNearest.distSq = bestWaterDist * bestWaterDist;
        if (nearestPointOnPolylineXZ(w?.coords, px, pz, _scratchNearest)) {
          bestWaterDist = Math.sqrt(_scratchNearest.distSq);
          bestWaterX = _scratchNearest.x;
          bestWaterZ = _scratchNearest.z;
        }
      }
    }
    if (hud?.nearStream && bestWaterDist > 12) {
      bestWaterDist = 6;
    }
    if (bestWaterDist < 140) {
      const atten = Math.pow(1 - bestWaterDist / 140, 1.7);
      targetRiverGain = atten * 0.24;
      targetRiverPan = computeStereoPan(bestWaterX - px, bestWaterZ - pz, yaw);
    } else {
      targetRiverGain = 0;
    }

    // 2. Nearest waterfall
    let bestWfGain = 0;
    let bestWfPan = 0;
    for (let i = 0; i < waterfalls.length; i++) {
      const wf = waterfalls[i];
      const dx = wf.x - px;
      const dz = wf.z - pz;
      const d = Math.hypot(dx, dz);
      const maxR = clamp(180 + wf.heightM * 3.4, 220, 560);
      if (d < maxR) {
        const g = Math.pow(1 - d / maxR, 1.55) * clamp(0.18 + wf.heightM * 0.0022, 0.18, 0.42);
        if (g > bestWfGain) {
          bestWfGain = g;
          bestWfPan = computeStereoPan(dx, dz, yaw);
        }
      }
    }
    targetWfGain = bestWfGain;
    targetWfPan = bestWfPan;

    // 3. Nearest gondola / aerialway
    let bestLiftDist = Infinity;
    let bestLiftX = px;
    let bestLiftZ = pz;
    const lifts = trailData?.aerialways?.length ? trailData.aerialways : (fallbackAerialway ? [fallbackAerialway] : []);
    for (let i = 0; i < lifts.length; i++) {
      _scratchNearest.distSq = bestLiftDist * bestLiftDist;
      if (nearestPointOnPolylineXZ(lifts[i]?.coords, px, pz, _scratchNearest)) {
        bestLiftDist = Math.sqrt(_scratchNearest.distSq);
        bestLiftX = _scratchNearest.x;
        bestLiftZ = _scratchNearest.z;
      }
    }
    if (bestLiftDist < 170) {
      targetGondolaGain = Math.pow(1 - bestLiftDist / 170, 1.6) * 0.085;
      targetGondolaPan = computeStereoPan(bestLiftX - px, bestLiftZ - pz, yaw);
    } else {
      targetGondolaGain = 0;
    }

    // 4. Nearest town center (Telluride murmur)
    let bestTownDist = Infinity;
    for (let i = 0; i < townCenters.length; i++) {
      const t = townCenters[i];
      const d = Math.hypot(t.x - px, t.z - pz);
      if (d < bestTownDist) bestTownDist = d;
    }
    targetTownGain = bestTownDist < 550 ? Math.pow(1 - bestTownDist / 550, 1.4) * 0.095 : 0;
  }

  function update(dt, hud, appState) {
    ensureBedsBuilt();
    if (!audioCtx.context) return;

    const px = hud?.x ?? engine.camera?.position?.x ?? 0;
    const pz = hud?.z ?? engine.camera?.position?.z ?? 0;
    const elevFt = hud?.elevFt ?? (terrain?.getHeight ? terrain.getHeight(px, pz) * 3.28084 : 8750);
    const yaw = engine.cameraRig?.getYaw?.() ?? hud?.heading ?? 0;
    lastPlayerX = px;
    lastPlayerZ = pz;
    lastYaw = yaw;

    const parsedHour = parseLocalTimeStr(hud?.localTimeStr);
    const hour = parsedHour ?? getDenverHour();
    const isNight = hour >= 19.75 || hour < 6.25;

    if (typeof hud?.stormActive === 'boolean') {
      if (hud.stormActive && !stormActive) {
        stormActive = true;
        stormIntensity = Math.max(stormIntensity, 0.8);
      } else if (!hud.stormActive && stormActive) {
        stormActive = false;
        stormIntensity = 0;
      }
    }

    // Throttled 6 Hz positional scan
    spatialTimer -= dt;
    if (spatialTimer <= 0) {
      spatialTimer = 0.16;
      scanPositionalSources(px, pz, yaw, hud);
    }

    if (!bedsBuilt || !audioCtx.isReady) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const inWorld = appState === 'playing' || appState === 'paused';
    const playMul = appState === 'playing' ? 1.0 : appState === 'paused' ? 0.45 : 0.25;

    // Cover query (fast cached lookup in terrain, with clean HUD fallback if terrain not passed)
    let forestAmt = 0;
    if (terrain?.getSurface) {
      const cover = terrain.getSurface(px, pz);
      forestAmt = clamp(cover?.forest ?? 0, 0, 1);
    } else if (hud?.surface === 'forest') {
      forestAmt = 0.85;
    } else if (elevFt < 11200 && (hud?.surface === 'trail' || hud?.surface === 'path')) {
      forestAmt = 0.35;
    }

    // Wind calculation: stronger at high elevation & exposed ridges, plus storm gusts
    gustClock += dt;
    const gust = 0.78 + 0.22 * Math.sin(gustClock * 0.45) * Math.cos(gustClock * 0.19);
    const ridgeFactor = clamp((elevFt - 9200) / 4800, 0, 1);
    const shelter = 1 - forestAmt * 0.42;
    const stormBoost = stormActive ? stormIntensity * 0.65 : 0;
    const windLevel = clamp((0.12 + ridgeFactor * 0.68 + stormBoost) * shelter * gust, 0.05, 1.2) * playMul;

    windLowFilter.frequency.setTargetAtTime(185 + windLevel * 180, now, 0.25);
    windLowGain.gain.setTargetAtTime(windLevel * 0.16, now, 0.2);

    const whistleAmt = clamp((ridgeFactor - 0.25) * 1.2 + stormBoost * 0.7, 0, 1) * gust * playMul;
    windHighFilter.frequency.setTargetAtTime(560 + whistleAmt * 520, now, 0.3);
    windHighGain.gain.setTargetAtTime(whistleAmt * 0.055, now, 0.25);

    // Quaking aspen leaf rustle in forest
    const leafAmt = inWorld ? forestAmt * clamp(0.35 + windLevel * 0.85, 0.2, 1.1) * playMul : 0;
    leavesGain.gain.setTargetAtTime(leafAmt * 0.06, now, 0.2);

    // Monsoon rain
    const rainAmt = inWorld && stormActive ? stormIntensity * playMul : 0;
    rainLowGain.gain.setTargetAtTime(rainAmt * 0.22, now, 0.35);
    rainHighGain.gain.setTargetAtTime(rainAmt * 0.14, now, 0.35);

    // Town murmur (quieter at night)
    const townTimeMul = isNight ? 0.38 : 1.0;
    townGain.gain.setTargetAtTime(inWorld ? targetTownGain * townTimeMul * playMul : 0, now, 0.3);

    // Positional river, waterfall, gondola
    const posMul = inWorld ? playMul : 0;
    riverBodyGain.gain.setTargetAtTime(targetRiverGain * 0.85 * posMul, now, 0.18);
    riverSparkleGain.gain.setTargetAtTime(targetRiverGain * 0.55 * posMul, now, 0.18);
    if (riverPanner.pan) riverPanner.pan.setTargetAtTime(targetRiverPan, now, 0.15);

    wfRumbleGain.gain.setTargetAtTime(targetWfGain * 1.1 * posMul, now, 0.2);
    wfHissGain.gain.setTargetAtTime(targetWfGain * 0.72 * posMul, now, 0.2);
    if (wfPanner.pan) wfPanner.pan.setTargetAtTime(targetWfPan, now, 0.15);

    gondolaGain.gain.setTargetAtTime(targetGondolaGain * posMul, now, 0.2);
    if (gondolaPanner.pan) gondolaPanner.pan.setTargetAtTime(targetGondolaPan, now, 0.15);

    // Birds by day vs crickets by night
    if (appState === 'playing' && !stormActive) {
      if (!isNight && elevFt < 12300) {
        birdTimer -= dt;
        if (birdTimer <= 0) {
          birdTimer = 4.2 + Math.random() * 6.8;
          playBirdCall();
        }
      } else if (isNight && elevFt < 10800) {
        cricketTimer -= dt;
        if (cricketTimer <= 0) {
          cricketTimer = 2.0 + Math.random() * 3.4;
          playCricketChirp();
        }
      }
    }
  }

  // Event subscriptions for chunks & storm/lightning
  const unsubChunk = engine?.events?.on?.('data:chunk', rebuildSpatialCaches);
  const unsubStorm = engine?.events?.on?.('world:storm', (p = {}) => {
    stormActive = p.active !== false;
    stormIntensity = stormActive ? clamp(p.intensity ?? 0.85, 0.2, 1) : 0;
    if (stormActive && p.lightning) {
      scheduleLightningThunder({ dist: 1800 });
    }
  });
  const unsubMonsoon = engine?.events?.on?.('world:monsoon', (p = {}) => {
    stormActive = p.active !== false;
    stormIntensity = stormActive ? clamp(p.intensity ?? 0.9, 0.2, 1) : 0;
  });
  const unsubLightning = engine?.events?.on?.('world:lightning', (p = {}) => {
    scheduleLightningThunder(p);
  });

  function dispose() {
    disposed = true;
    unsubChunk?.();
    unsubStorm?.();
    unsubMonsoon?.();
    unsubLightning?.();
    for (const tid of thunderTimers) clearTimeout(tid);
    thunderTimers.clear();
    for (const s of sources) {
      try { s.stop(); } catch {}
      try { s.disconnect(); } catch {}
    }
    sources.length = 0;
    bedsBuilt = false;
  }

  return {
    update,
    dispose,
    triggerThunderNow: (p) => playThunder(p || { close: true }),
  };
}
