/**
 * Contextual & positional San Juan ambient soundscape:
 * - Ridge/valley wind (elevation, forest shelter, and monsoon gusts)
 * - Quaking aspen leaf rustle in forest cover (throttled 6 Hz surface lookup)
 * - Birds by day (mid-July twilight 5:27 AM - 8:39 PM, below treeline) & crickets at night
 * - Distant town murmur near Telluride & San Juan towns
 * - Bounded-memory Float32Array spatial-grid positional river/creek water & waterfall roars
 * - 3D-attenuated positional gondola/aerialway cable hum near cabins
 * - Monsoon rain bed (synced to world uRainAmount) + speed-of-sound delayed canyon thunder
 */

import { lonLatToWorld } from '../core/geo.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const WATER_WINDOW_RADIUS_M = 950;
const WATER_RECENTER_DIST_M = 650; // 950 - 650 = 300m > 145m max audible radius
const MAX_WINDOW_SEGS = 2048;
const SEG_STRIDE = 7; // [x0, z0, dx, dz, invLenSq, bodyWeight, foamWeight]

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

let _denverFmt = null;
let _cachedRealHour = 10.0;
let _lastRealHourPerf = -99999;

function getCachedDenverHour() {
  const nowPerf = performance.now();
  if (nowPerf - _lastRealHourPerf < 5000) return _cachedRealHour;
  _lastRealHourPerf = nowPerf;
  try {
    if (!_denverFmt) {
      _denverFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
      });
    }
    const parts = _denverFmt.formatToParts(new Date());
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 10) % 24;
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    _cachedRealHour = hh + mm / 60;
  } catch {
    const d = new Date();
    _cachedRealHour = d.getHours() + d.getMinutes() / 60;
  }
  return _cachedRealHour;
}

function parseLocalTimeStr(str) {
  if (typeof str !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(str);
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') hh += 12;
  return hh + Number(m[2]) / 60;
}

function nearestPointOnPolyline3D(coords, px, py, pz, out) {
  if (!coords || coords.length < 6) return false;
  let found = false;
  for (let i = 0; i <= coords.length - 6; i += 3) {
    const ax = coords[i];
    const ay = coords[i + 1];
    const az = coords[i + 2];
    const bx = coords[i + 3];
    const by = coords[i + 4];
    const bz = coords[i + 5];
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const lenSq = dx * dx + dy * dy + dz * dz;
    let t = 0;
    if (lenSq > 1e-4) {
      t = clamp(((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / lenSq, 0, 1);
    }
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const cz = az + dz * t;
    const dSq = (px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz);
    if (dSq < out.distSq) {
      out.distSq = dSq;
      out.x = cx;
      out.y = cy;
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

export function createAmbientSystem(audioCtx, engine, { terrain, trailData, world } = {}) {
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

  // Bounded-memory (56 KB) zero-GC local 950m waterway window packed in one Float32Array
  let waterSegBuf = null; // lazily allocated Float32Array(MAX_WINDOW_SEGS * SEG_STRIDE) when inWorld
  let waterSegCount = 0;
  let waterWinX = NaN;
  let waterWinZ = NaN;
  let waterWindowDirty = true;
  let lastSeenWaterwaysLen = 0;

  // Pre-indexed waterfalls, towns, and aerialways with AABBs
  let waterfalls = [];
  let townCenters = [...FALLBACK_TOWN_CENTERS];
  let indexedAerialways = [];

  // Throttled 6 Hz spatial & terrain cache state
  let spatialTimer = 0;
  let cachedForestAmt = 0.25;
  let cachedTerrainY = 2670;
  let targetRiverBodyGain = 0;
  let targetRiverSparkleGain = 0;
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

  const _scratch3D = { distSq: Infinity, x: 0, y: 0, z: 0 };

  function buildAerialwayRecord(aw) {
    const c = aw?.coords;
    if (!c || c.length < 6) return null;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i <= c.length - 3; i += 3) {
      const x = c[i];
      const z = c[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const isGondola =
      aw.kind === 'gondola' ||
      aw.kind === 'cable_car' ||
      (aw.name || '').toLowerCase().includes('gondola');
    return { coords: c, minX, minZ, maxX, maxZ, isGondola };
  }

  function rebuildPoiAndLiftCaches() {
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

    // Aerialways with precomputed AABBs (~23 across region)
    const lifts = [];
    if (Array.isArray(trailData?.aerialways) && trailData.aerialways.length > 0) {
      for (const aw of trailData.aerialways) {
        const rec = buildAerialwayRecord(aw);
        if (rec) lifts.push(rec);
      }
    } else {
      const p1 = lonLatToWorld(-107.8130, 37.9354);
      const p2 = lonLatToWorld(-107.8268, 37.9261);
      const p3 = lonLatToWorld(-107.8473, 37.9328);
      const rec = buildAerialwayRecord({
        kind: 'gondola',
        name: 'Telluride Gondola',
        coords: new Float32Array([p1.x, 2670, p1.z, p2.x, 3212, p2.z, p3.x, 2908, p3.z]),
      });
      if (rec) lifts.push(rec);
    }
    indexedAerialways = lifts;
    waterWindowDirty = true;
  }
  rebuildPoiAndLiftCaches();

  /**
   * Rebuild the bounded local 950m waterway segment buffer around (px, pz).
   * Zero Map/Array allocations; deferred until inWorld so 2D map panning allocates 0 bytes.
   */
  function rebuildLocalWaterWindow(px, pz) {
    waterWinX = px;
    waterWinZ = pz;
    waterWindowDirty = false;
    waterSegCount = 0;

    const wList = trailData?.waterways;
    if (!Array.isArray(wList) || wList.length === 0) {
      lastSeenWaterwaysLen = 0;
      return;
    }
    lastSeenWaterwaysLen = wList.length;

    if (!waterSegBuf) {
      waterSegBuf = new Float32Array(MAX_WINDOW_SEGS * SEG_STRIDE);
    }

    const minWinX = px - WATER_WINDOW_RADIUS_M;
    const maxWinX = px + WATER_WINDOW_RADIUS_M;
    const minWinZ = pz - WATER_WINDOW_RADIUS_M;
    const maxWinZ = pz + WATER_WINDOW_RADIUS_M;

    for (let wi = 0; wi < wList.length && waterSegCount < MAX_WINDOW_SEGS; wi++) {
      const w = wList[wi];
      const c = w?.coords;
      if (!c || c.length < 6) continue;

      let b = w.bbox || w._audioBbox;
      if (!b) {
        let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
        for (let k = 0; k <= c.length - 3; k += 3) {
          const vx = c[k];
          const vz = c[k + 2];
          if (vx < bx0) bx0 = vx;
          if (vx > bx1) bx1 = vx;
          if (vz < bz0) bz0 = vz;
          if (vz > bz1) bz1 = vz;
        }
        b = [bx0, bz0, bx1, bz1];
        w._audioBbox = b;
      }
      if (b[2] < minWinX || b[0] > maxWinX || b[3] < minWinZ || b[1] > maxWinZ) {
        continue;
      }

      const widthM = w.widthM || (w.kind === 'river' ? 7.5 : 2.8);
      const bodyWeight = clamp(0.65 + widthM * 0.06, 0.7, 1.35);

      for (let i = 0; i <= c.length - 6 && waterSegCount < MAX_WINDOW_SEGS; i += 3) {
        const x0 = c[i];
        const z0 = c[i + 2];
        const x1 = c[i + 3];
        const z1 = c[i + 5];
        if (
          (x0 < minWinX && x1 < minWinX) || (x0 > maxWinX && x1 > maxWinX) ||
          (z0 < minWinZ && z1 < minWinZ) || (z0 > maxWinZ && z1 > maxWinZ)
        ) {
          continue;
        }
        const dx = x1 - x0;
        const dz = z1 - z0;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 1e-3) continue;

        const y0 = c[i + 1];
        const y1 = c[i + 4];
        const slope = Math.abs(y1 - y0) / Math.sqrt(lenSq);
        const foamWeight = clamp(0.45 + slope * 3.8, 0.45, 1.45);

        const base = waterSegCount * SEG_STRIDE;
        waterSegCount++;
        waterSegBuf[base] = x0;
        waterSegBuf[base + 1] = z0;
        waterSegBuf[base + 2] = dx;
        waterSegBuf[base + 3] = dz;
        waterSegBuf[base + 4] = 1 / lenSq;
        waterSegBuf[base + 5] = bodyWeight;
        waterSegBuf[base + 6] = foamWeight;
      }
    }
  }

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
    if (bedsBuilt || disposed || !audioCtx.isUnlocked || !audioCtx.hasNoiseBuffers || !audioCtx.context) return;
    const ctx = audioCtx.context;
    const amb = audioCtx.ambientGain;

    const wLow = makeNoiseBed(ctx, 'pink', 'bandpass', 240, 0.9, amb);
    windLowFilter = wLow.filter;
    windLowGain = wLow.gain;

    const wHigh = makeNoiseBed(ctx, 'pink', 'bandpass', 780, 1.8, amb);
    windHighFilter = wHigh.filter;
    windHighGain = wHigh.gain;

    const leaves = makeNoiseBed(ctx, 'white', 'bandpass', 2800, 1.1, amb);
    leavesGain = leaves.gain;

    const rLow = makeNoiseBed(ctx, 'pink', 'lowpass', 620, 0.7, amb);
    rainLowGain = rLow.gain;
    const rHigh = makeNoiseBed(ctx, 'white', 'bandpass', 2100, 0.85, amb);
    rainHighGain = rHigh.gain;

    const town = makeNoiseBed(ctx, 'brown', 'bandpass', 330, 1.1, amb);
    townGain = town.gain;

    riverPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : amb;
    if (riverPanner !== amb) riverPanner.connect(amb);
    const rBody = makeNoiseBed(ctx, 'brown', 'lowpass', 480, 0.8, riverPanner);
    riverBodyGain = rBody.gain;
    const rSpark = makeNoiseBed(ctx, 'pink', 'bandpass', 1800, 1.2, riverPanner);
    riverSparkleGain = rSpark.gain;

    wfPanner = ctx.createStereoPanner ? ctx.createStereoPanner() : amb;
    if (wfPanner !== amb) wfPanner.connect(amb);
    const wfR = makeNoiseBed(ctx, 'brown', 'lowpass', 145, 0.8, wfPanner);
    wfRumbleGain = wfR.gain;
    const wfH = makeNoiseBed(ctx, 'pink', 'bandpass', 860, 0.85, wfPanner);
    wfHissGain = wfH.gain;

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

    let tail = gain;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(audioCtx.ambientGain);
    osc.connect(gain);

    const motif = Math.floor(Math.random() * 3);
    const baseFreq = 2500 + Math.random() * 1100;
    const vol = 0.025 + Math.random() * 0.02;
    let t = now + 0.02;

    if (motif === 0) {
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

    osc.onended = () => {
      try { tail.disconnect(); } catch {}
      release();
    };
    osc.start(now);
    osc.stop(t + 0.04);
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

    let tail = gain;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(audioCtx.ambientGain);
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

    osc.onended = () => {
      try { tail.disconnect(); } catch {}
      release();
    };
    osc.start(now);
    osc.stop(t + 0.03);
  }

  function playThunder({ x, z, dist = 2200, close = false }) {
    if (!audioCtx.isReady || !audioCtx.hasNoiseBuffers) return;
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

    const hasPanner = Boolean(ctx.createStereoPanner);
    const outNode = hasPanner ? ctx.createStereoPanner() : ctx.createGain();
    if (hasPanner) outNode.pan.value = pan;
    outNode.connect(audioCtx.ambientGain);
    if (audioCtx.canyonConvolver) outNode.connect(audioCtx.canyonConvolver);

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
    rumGain.gain.linearRampToValueAtTime(0.32 * distFactor, now + dur * 0.38);
    rumGain.gain.linearRampToValueAtTime(0.45 * distFactor, now + dur * 0.52);
    rumGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    rumSrc.connect(rumFilter);
    rumFilter.connect(rumGain);
    rumGain.connect(outNode);
    rumSrc.onended = () => {
      try { outNode.disconnect(); } catch {}
      release();
    };
    rumSrc.start(now, Math.random() * 0.5, dur + 0.05);
  }

  function scheduleLightningThunder(payload = {}) {
    const dist = Number.isFinite(payload.dist) ? payload.dist : 2200;
    const delayMs = payload.close ? 120 : clamp((dist / 343) * 1000, 350, 8500);
    const tid = setTimeout(() => {
      thunderTimers.delete(tid);
      if (!disposed) playThunder(payload);
    }, delayMs);
    thunderTimers.add(tid);
  }

  function scanPositionalSources(px, pz, yaw, hud, inWorld) {
    // Update cached terrain height & forest cover at 6 Hz (never at 60 Hz)
    if (terrain?.getHeight && !Number.isFinite(hud?.y)) {
      const h = terrain.getHeight(px, pz);
      if (Number.isFinite(h)) cachedTerrainY = h;
    } else if (Number.isFinite(hud?.y)) {
      cachedTerrainY = hud.y;
    }

    const elevFt = hud?.elevFt ?? cachedTerrainY * 3.28084;
    if (terrain?.getSurface) {
      const cover = terrain.getSurface(px, pz);
      cachedForestAmt = clamp(cover?.forest ?? 0, 0, 1);
    } else if (hud?.surface === 'forest') {
      cachedForestAmt = 0.85;
    } else if (elevFt < 11200 && (hud?.surface === 'trail' || hud?.surface === 'path')) {
      cachedForestAmt = 0.35;
    } else {
      cachedForestAmt = 0;
    }

    if (!inWorld) {
      targetRiverBodyGain = 0;
      targetRiverSparkleGain = 0;
      targetWfGain = 0;
      targetGondolaGain = 0;
      targetTownGain = 0;
      return;
    }

    const py = hud?.y ?? cachedTerrainY;

    // Refresh local 2.6 km waterway window only when needed while inWorld
    const curWLen = trailData?.waterways?.length || 0;
    if (
      waterWindowDirty ||
      curWLen !== lastSeenWaterwaysLen ||
      !Number.isFinite(waterWinX) ||
      Math.hypot(px - waterWinX, pz - waterWinZ) > WATER_RECENTER_DIST_M
    ) {
      rebuildLocalWaterWindow(px, pz);
    }

    // 1. Tight linear scan over the ~30-200 local segments in the 56 KB Float32Array window
    const maxWaterR = 145;
    let bestWaterDistSq = maxWaterR * maxWaterR;
    let bestWaterX = px;
    let bestWaterZ = pz;
    let bestBodyW = 1.0;
    let bestFoamW = 0.8;

    if (waterSegCount > 0 && waterSegBuf) {
      for (let segId = 0; segId < waterSegCount; segId++) {
        const base = segId * SEG_STRIDE;
        const x0 = waterSegBuf[base];
        const z0 = waterSegBuf[base + 1];
        const dx = waterSegBuf[base + 2];
        const dz = waterSegBuf[base + 3];
        const invLenSq = waterSegBuf[base + 4];

        let t = ((px - x0) * dx + (pz - z0) * dz) * invLenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const qx = x0 + dx * t;
        const qz = z0 + dz * t;
        const dSq = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
        if (dSq < bestWaterDistSq) {
          bestWaterDistSq = dSq;
          bestWaterX = qx;
          bestWaterZ = qz;
          bestBodyW = waterSegBuf[base + 5];
          bestFoamW = waterSegBuf[base + 6];
        }
      }
    }

    let bestWaterDist = Math.sqrt(bestWaterDistSq);
    if (hud?.nearStream && bestWaterDist > 12) {
      bestWaterDist = 6;
    }
    if (bestWaterDist < maxWaterR) {
      const atten = Math.pow(1 - bestWaterDist / maxWaterR, 1.7) * 0.24;
      targetRiverBodyGain = atten * 0.85 * bestBodyW;
      targetRiverSparkleGain = atten * 0.55 * bestFoamW;
      targetRiverPan = computeStereoPan(bestWaterX - px, bestWaterZ - pz, yaw);
    } else {
      targetRiverBodyGain = 0;
      targetRiverSparkleGain = 0;
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

    // 3. Nearest gondola / aerialway (AABB-culled + 3D cable clearance)
    const maxLiftR = 165;
    let bestLiftGain = 0;
    let bestLiftPan = 0;
    for (let i = 0; i < indexedAerialways.length; i++) {
      const aw = indexedAerialways[i];
      if (
        px < aw.minX - maxLiftR || px > aw.maxX + maxLiftR ||
        pz < aw.minZ - maxLiftR || pz > aw.maxZ + maxLiftR
      ) {
        continue;
      }
      _scratch3D.distSq = maxLiftR * maxLiftR;
      if (nearestPointOnPolyline3D(aw.coords, px, py, pz, _scratch3D)) {
        const d3 = Math.sqrt(_scratch3D.distSq);
        const typeMul = aw.isGondola ? 0.095 : 0.055;
        const g = Math.pow(1 - d3 / maxLiftR, 1.65) * typeMul;
        if (g > bestLiftGain) {
          bestLiftGain = g;
          bestLiftPan = computeStereoPan(_scratch3D.x - px, _scratch3D.z - pz, yaw);
        }
      }
    }
    targetGondolaGain = bestLiftGain;
    targetGondolaPan = bestLiftPan;

    // 4. Nearest town center (Telluride / San Juan town murmur)
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
    const py = hud?.y ?? cachedTerrainY;
    const elevFt = hud?.elevFt ?? py * 3.28084;
    const yaw = engine.cameraRig?.getYaw?.() ?? hud?.heading ?? 0;
    lastPlayerX = px;
    lastPlayerZ = pz;
    lastYaw = yaw;

    const inWorld = appState === 'playing' || appState === 'paused';

    // Mid-July Telluride twilight hours matching src/game/weather.js
    const parsedHour = parseLocalTimeStr(hud?.localTimeStr);
    const hour = parsedHour ?? getCachedDenverHour();
    const isNight = hour >= 20.65 || hour < 5.45;
    const isDawnChorus = hour >= 5.45 && hour <= 7.75;

    if (typeof hud?.stormActive === 'boolean') {
      if (hud.stormActive && !stormActive) {
        stormActive = true;
        stormIntensity = Math.max(stormIntensity, 0.8);
      } else if (!hud.stormActive && stormActive) {
        stormActive = false;
        stormIntensity = 0;
      }
    }

    // Throttled 6 Hz positional & terrain surface scan
    spatialTimer -= dt;
    if (spatialTimer <= 0) {
      spatialTimer = 0.16;
      scanPositionalSources(px, pz, yaw, hud, inWorld);
    }

    if (!bedsBuilt || !audioCtx.isReady) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const playMul = appState === 'playing' ? 1.0 : appState === 'paused' ? 0.45 : 0.25;
    const forestAmt = cachedForestAmt;

    // Sync rain amount directly with world uRainAmount uniform if present
    const worldRain = world?.uniforms?.uRainAmount?.value;
    const effectiveRain = Number.isFinite(worldRain)
      ? Math.max(worldRain, stormActive ? stormIntensity * 0.85 : 0)
      : (stormActive ? stormIntensity : 0);

    // Wind calculation: stronger at high elevation & exposed ridges, plus storm gusts
    gustClock += dt;
    const gust = 0.78 + 0.22 * Math.sin(gustClock * 0.45) * Math.cos(gustClock * 0.19);
    const ridgeFactor = clamp((elevFt - 9200) / 4800, 0, 1);
    const shelter = 1 - forestAmt * 0.42;
    const stormBoost = effectiveRain * 0.65;
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
    const rainAmt = inWorld ? effectiveRain * playMul : 0;
    rainLowGain.gain.setTargetAtTime(rainAmt * 0.22, now, 0.35);
    rainHighGain.gain.setTargetAtTime(rainAmt * 0.14, now, 0.35);

    // Town murmur (quieter at night)
    const townTimeMul = isNight ? 0.38 : 1.0;
    townGain.gain.setTargetAtTime(inWorld ? targetTownGain * townTimeMul * playMul : 0, now, 0.3);

    // Positional river, waterfall, gondola
    const posMul = inWorld ? playMul : 0;
    riverBodyGain.gain.setTargetAtTime(targetRiverBodyGain * posMul, now, 0.18);
    riverSparkleGain.gain.setTargetAtTime(targetRiverSparkleGain * posMul, now, 0.18);
    if (riverPanner.pan) riverPanner.pan.setTargetAtTime(targetRiverPan, now, 0.15);

    wfRumbleGain.gain.setTargetAtTime(targetWfGain * 1.1 * posMul, now, 0.2);
    wfHissGain.gain.setTargetAtTime(targetWfGain * 0.72 * posMul, now, 0.2);
    if (wfPanner.pan) wfPanner.pan.setTargetAtTime(targetWfPan, now, 0.15);

    gondolaGain.gain.setTargetAtTime(targetGondolaGain * posMul, now, 0.2);
    if (gondolaPanner.pan) gondolaPanner.pan.setTargetAtTime(targetGondolaPan, now, 0.15);

    // Birds by day vs crickets by night
    if (appState === 'playing' && effectiveRain < 0.25) {
      if (!isNight && elevFt < 12300) {
        birdTimer -= dt;
        if (birdTimer <= 0) {
          birdTimer = (isDawnChorus ? 2.8 : 4.2) + Math.random() * (isDawnChorus ? 4.2 : 6.8);
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

  const unsubChunk = engine?.events?.on?.('data:chunk', rebuildPoiAndLiftCaches);
  const unsubStorm = engine?.events?.on?.('world:storm', (p = {}) => {
    stormActive = p.active !== false;
    stormIntensity = stormActive ? clamp(p.intensity ?? 0.85, 0.2, 1) : 0;
    if (!world && stormActive && p.lightning) {
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
    waterSegBuf = null;
    waterSegCount = 0;
    bedsBuilt = false;
  }

  return {
    update,
    dispose,
    triggerThunderNow: (p) => playThunder(p || { close: true }),
    getSpatialStats: () => ({
      totalLoadedWaterways: trailData?.waterways?.length || 0,
      windowWaterSegments: waterSegCount,
      waterBufferKB: waterSegBuf ? Math.round(waterSegBuf.byteLength / 1024) : 0,
      waterfalls: waterfalls.length,
      aerialways: indexedAerialways.length,
      towns: townCenters.length,
    }),
  };
}
