// Main gameplay module for Telluride Trails.
// Implements PLAN.md createGame(engine, terrain, trailData, world) contract.

import { lonLatToWorld } from '../core/geo.js';
import {
  ACHIEVEMENTS,
  ALT_PENALTY_START_FT,
  CLIFF_GRADE,
  FOODS,
  KM_M,
  M_TO_FT,
  MILE_M,
  TRAIL_CLIFF_GRADE,
} from './constants.js';
import {
  applyRunnerStatsToPhysiology,
  createPhysiology,
  drinkFromFlask,
  eatItem,
  fallProbabilityPerSec,
  hydrationPct,
  refillFlasks,
  stepPhysiology,
  stomachLoad,
} from './physiology.js';
import { createTrailDogs } from './dogs.js';
import {
  CUSTOM_ARCHETYPES,
  normalizeRunnerSelection,
  rollRandomCustomRunner,
  RUNNER_KIT_SWATCHES,
  TELLURIDE_RUNNERS,
} from './roster.js';
import {
  applyTrailCenterPull,
  computeTargetSpeed,
  evaluateSurface,
  findDryShore,
  isDeepLakeWater,
  resolveCliffSlide,
} from './physics.js';
import {
  formatAwayJoke,
  pickAltQuote,
  pickBonkQuote,
  pickCliffWarning,
  pickLntWarning,
  pickNightQuote,
  pickStormWarning,
  pickWildlifeEvent,
} from './humor.js';
import { createHardrockMonument, createRunnerCharacter } from './runner.js';
import { createRaceManager } from './races.js';
import {
  clearSavedRun,
  hasSavedRun,
  loadAchievements,
  loadPersonalBests,
  loadSavedRun,
  loadSelectedRunner,
  saveAchievement,
  saveSelectedRunner,
  writeSavedRun,
} from './save.js';
import { createWeatherSystem } from './weather.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function createGame(engine, terrain, trailData, world) {
  const runner = createRunnerCharacter(engine.assetsBase || './');
  engine.scene.add(runner.root);

  const dogs = createTrailDogs(engine);

  const hardrockRock = createHardrockMonument();
  hardrockRock.visible = false;
  engine.scene.add(hardrockRock);

  const raceMgr = createRaceManager();
  const weather = createWeatherSystem(engine, world);

  const params = new URLSearchParams(window.location.search);
  const initialTs = Math.max(1, Number(params.get('ts')) || 1);

  let activeRunner = normalizeRunnerSelection(loadSelectedRunner());
  runner.setAppearance(activeRunner.kit);

  function runnerHudMeta(r = activeRunner) {
    return {
      id: r.id,
      name: r.name,
      hometown: r.hometown,
      ovr: r.ovr,
      isCustom: Boolean(r.isCustom),
      statUncapped: Boolean(r.statUncapped),
    };
  }

  let phys = createPhysiology(activeRunner.stats);
  let timeScale = initialTs;
  let paceMode = 'auto'; // 'auto' | 'walk' | 'hike' | 'run' | 'sprint'
  let autopilot = false;
  let elapsedRunS = 0;
  let maxElevFt = 0;
  let lntWarningsCount = 0;
  let offTrailSeconds = 0;
  let lastLntToastS = -999;
  let lastCliffToastS = -999;
  let lastLakeToastS = -999;
  let lastAltToastS = -999;
  let lastNightToastS = -999;
  let nextWildlifeS = 65 + Math.random() * 65;
  let saveAccumS = 0;
  let lastStreamX = NaN;
  let lastStreamZ = NaN;
  let lastShadowsEnabled = null;
  const isCoarsePointer = Boolean(typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches);

  // Cached return-to-course route for race autopilot (prevents per-substep A* stalls)
  let cachedReturnRoute = null;
  let cachedRouteIdx = 1;
  let cachedRoutePerfMs = -Infinity;
  const camPoseScratch = { x: 0, y: 0, z: 0, heading: 0 };
  const runnerBoundsScratch = { x: 0, y: 0, z: 0, height: 1.74, radius: 0.42, visible: false };
  const pushBldgScratch = { x: 0, z: 0, pushed: false };
  const cliffOptsScratch = {
    x: 0,
    z: 0,
    nearestTrail: null,
    offCourseM: Infinity,
    courseTarget: null,
    getGroundY: null,
    isBlocked: null,
  };
  let lastIsFp = false;
  let lastFpBounce = 0;
  let virtualElevRefM = null;
  let stuckAnchorX = 0;
  let stuckAnchorZ = 0;
  let stuckTimerS = 0;
  let autoHikeStaminaMode = false;
  let lastAutoAidRefuelS = -999;

  // Precomputed diagonal shoreline glide probe angles (±35°, ±70°)
  const SHORE_SLIDE_ANGLES = [0.610865, -0.610865, 1.22173, -1.22173];

  // Prefer exact rendered-mesh height when exposed by terrain3, plus 3D town street/sidewalk deck height
  function sampleGroundHeight(x, z) {
    const terrainY = typeof terrain.getRenderedHeight === 'function'
      ? terrain.getRenderedHeight(x, z)
      : terrain.getHeight(x, z);
    if (!Number.isFinite(terrainY)) return state.y;
    const deckY = engine.worldBuildingMask?.getWalkableDeckHeight?.(x, z);
    if (Number.isFinite(deckY) && deckY >= terrainY - 0.05 && deckY <= terrainY + 0.45) {
      return Math.max(terrainY, deckY);
    }
    return terrainY;
  }

  function pushClearOfBuildings(x, z, radiusM = 0.48) {
    const fn = engine.worldBuildingMask?.pushOutOfBuilding;
    if (!fn) {
      pushBldgScratch.x = x;
      pushBldgScratch.z = z;
      pushBldgScratch.pushed = false;
      return pushBldgScratch;
    }
    return fn(x, z, radiusM, pushBldgScratch) || pushBldgScratch;
  }

  function isDogWater(x, z) {
    return isDeepLakeWater(x, z, engine, terrain, trailData, false, false);
  }

  function isCliffSlideBlocked(x, z) {
    if (isDeepLakeWater(x, z, engine, terrain, trailData, false, false)) return true;
    const res = pushClearOfBuildings(x, z, 0.48);
    return Boolean(res.pushed);
  }
  cliffOptsScratch.getGroundY = sampleGroundHeight;
  cliffOptsScratch.isBlocked = isCliffSlideBlocked;

  function hasDogsForRunner(r = activeRunner) {
    return Boolean(r && (r.id === 'ryan-becker' || r.id === 'lindsay-allison'));
  }

  function syncDogsActive() {
    const shouldShow = state.mode !== 'idle' && hasDogsForRunner(activeRunner);
    dogs.setActive(shouldShow, state.x, state.z, state.heading, sampleGroundHeight);
  }

  function ensureVectorArea(x, z) {
    if (!trailData?.loadArea) return;
    if (!Number.isFinite(lastStreamX) || Math.hypot(x - lastStreamX, z - lastStreamZ) > 450) {
      lastStreamX = x;
      lastStreamZ = z;
      Promise.resolve(trailData.loadArea(x, z, 1500)).catch(() => {});
    }
  }

  // Exact terrain grounding + small trail hop (zero smoothY lag on steep climbs/descents)
  const initGroundY = typeof terrain.getRenderedHeight === 'function'
    ? terrain.getRenderedHeight(0, 0)
    : terrain.getHeight(0, 0);
  let vertRefY = Number.isFinite(initGroundY) ? initGroundY : 2667;
  let jumpOffset = 0;
  let jumpVel = 0;
  let stumbleTimer = 0;
  let fallTimer = 0;
  let prevNearStream = false;
  let lastNearAid = null;
  let lastStormRisk = 0;
  let raceOffCourseS = 0;
  let lastSurfaceInfo = null;
  let lastLocalClock = weather.getDenverClock();

  // Persistent state exposed to main.js / perfqa / playtest
  const state = {
    mode: 'idle', // 'idle' | 'freerun' | 'race'
    raceId: null,
    paused: false,
    finished: false,
    dnf: false,
    dnfReason: null,
    x: 0,
    z: 0,
    y: vertRefY,
    heading: 0,
    distanceM: 0,
    vertM: 0,
    vertLossM: 0,
    speedMs: 0,
    grade: 0,
    gait: 'idle',
    stamina: 1,
    hydration: 1,
    surface: 'trail',
    trailName: null,
    autopilot: false,
    timeScale,
    timeDilated: initialTs > 1,
    checkpointIdx: 0,
    runner: runnerHudMeta(activeRunner),
  };

  function toast(text, tone = 'info', durationS = 4.0) {
    engine.events.emit('game:toast', {
      text,
      tone,
      kind: tone,
      durationS,
      durationMs: Math.round(durationS * 1000),
    });
  }

  function unlockAchievement(id) {
    const def = ACHIEVEMENTS[id];
    if (!def) return;
    if (saveAchievement(id)) {
      // UI listens to 'game:achievement' and displays the achievement toast
      engine.events.emit('game:achievement', { ...def });
    }
  }

  function updateRunnerBoundsScratch() {
    runnerBoundsScratch.x = state.x;
    runnerBoundsScratch.y = state.y;
    runnerBoundsScratch.z = state.z;
    runnerBoundsScratch.height = runner.getVisualHeight();
    runnerBoundsScratch.radius = 0.42;
    runnerBoundsScratch.visible = Boolean(runner.root.visible && state.mode !== 'idle');
  }

  function syncRunnerVisuals(dt, isNight, snapGround = false) {
    const camMode = engine.cameraRig?.getMode?.() || 'chase';
    const isFp = camMode === 'first-person';
    const shadowsEnabled = Boolean(engine.quality?.shadows);
    if (shadowsEnabled !== lastShadowsEnabled) {
      lastShadowsEnabled = shadowsEnabled;
      runner.setShadowsEnabled(shadowsEnabled);
      dogs.setShadowsEnabled(shadowsEnabled);
    }

    // Re-sync exact rendered terrain height so streaming tiles or pauses never cause drift
    if (state.mode !== 'idle') {
      const exactGroundY = sampleGroundHeight(state.x, state.z);
      state.y = exactGroundY + jumpOffset;
    }

    runner.root.position.set(state.x, state.y, state.z);
    runner.root.rotation.y = state.heading;

    const terrainNormal = terrain.getNormal ? terrain.getNormal(state.x, state.z) : null;
    const bounce = runner.updatePose(dt, {
      speedMs: state.speedMs,
      grade: state.grade,
      gait: state.gait,
      isStumbling: stumbleTimer > 0,
      isFallen: fallTimer > 0,
      isAirborne: jumpOffset > 0.06,
      isKissingRock: raceMgr.isCeremony(),
      nightMode: isNight,
      visible: state.mode !== 'idle' && !isFp,
      allowHeadlamp: true,
      getGroundY: sampleGroundHeight,
      terrainNormal,
      heading: state.heading,
      snapGround,
    });

    lastIsFp = isFp;
    lastFpBounce = bounce;

    if (dogs.isActive() && state.mode !== 'idle') {
      dogs.update(dt, {
        x: state.x,
        z: state.z,
        heading: state.heading,
        speedMs: state.speedMs,
        getGroundY: sampleGroundHeight,
        isWater: isDogWater,
        visible: true,
      });
    }

    updateRunnerBoundsScratch();

    if (hardrockRock.visible) {
      const fin = raceMgr.getRace()?.finish;
      if (fin) {
        hardrockRock.position.set(fin.x, sampleGroundHeight(fin.x, fin.z), fin.z);
      }
    }

    return { isFp, bounce };
  }

  /**
   * Post-terrain grounding resnap called by main.js right after terrain.update(_activePos)
   * and before cameraRig.update(). Idempotent; never re-advances AnimationMixer!
   */
  function syncPostTerrain() {
    if (state.mode === 'idle') {
      runnerBoundsScratch.visible = false;
      return;
    }
    const freshGroundY = sampleGroundHeight(state.x, state.z);
    state.y = freshGroundY + jumpOffset;
    runner.root.position.set(state.x, state.y, state.z);
    const terrainNormal = terrain.getNormal ? terrain.getNormal(state.x, state.z) : null;
    runner.resnapGround({
      getGroundY: sampleGroundHeight,
      terrainNormal,
      heading: state.heading,
    });
    dogs.resnapGround(sampleGroundHeight);
    updateRunnerBoundsScratch();

    camPoseScratch.x = state.x;
    camPoseScratch.y = state.y + (lastIsFp ? lastFpBounce * 0.7 : 0);
    camPoseScratch.z = state.z;
    camPoseScratch.heading = state.heading;

    if (hardrockRock.visible) {
      const fin = raceMgr.getRace()?.finish;
      if (fin) {
        hardrockRock.position.set(fin.x, sampleGroundHeight(fin.x, fin.z), fin.z);
      }
    }
  }

  function setRunner(selection, { persist = true, emit = true } = {}) {
    activeRunner = normalizeRunnerSelection(selection);
    if (persist) saveSelectedRunner(activeRunner);
    runner.setAppearance(activeRunner.kit);
    applyRunnerStatsToPhysiology(phys, activeRunner.stats);
    state.runner = runnerHudMeta(activeRunner);
    if (state.mode === 'race' && raceMgr.isActive()) {
      raceMgr.setRunnerMeta(state.runner);
    }
    syncDogsActive();
    if (state.mode !== 'idle') {
      syncRunnerVisuals(0, lastLocalClock.isNight, true);
      emitHud(lastNearAid, prevNearStream);
      if (persist) persistRun();
    }
    if (emit) {
      engine.events.emit('game:runnerChanged', { runner: activeRunner });
    }
    return activeRunner;
  }

  function resetRunMetrics(x, z, heading) {
    phys = createPhysiology(activeRunner.stats);
    state.runner = runnerHudMeta(activeRunner);
    state.x = x;
    state.z = z;
    const groundY = sampleGroundHeight(x, z);
    vertRefY = groundY;
    virtualElevRefM = null;
    stuckAnchorX = x;
    stuckAnchorZ = z;
    stuckTimerS = 0;
    autoHikeStaminaMode = false;
    lastAutoAidRefuelS = -999;
    state.y = groundY;
    state.heading = heading;
    camPoseScratch.x = x;
    camPoseScratch.y = groundY;
    camPoseScratch.z = z;
    camPoseScratch.heading = heading;
    cachedReturnRoute = null;
    cachedRoutePerfMs = -Infinity;
    state.distanceM = 0;
    state.vertM = 0;
    state.vertLossM = 0;
    state.speedMs = 0;
    state.grade = 0;
    state.gait = 'idle';
    state.finished = false;
    state.dnf = false;
    state.dnfReason = null;
    state.checkpointIdx = 0;
    elapsedRunS = 0;
    maxElevFt = groundY * M_TO_FT;
    offTrailSeconds = 0;
    raceOffCourseS = 0;
    lastNearAid = null;
    lastStormRisk = 0;
    lntWarningsCount = 0;
    stumbleTimer = 0;
    fallTimer = 0;
    jumpOffset = 0;
    jumpVel = 0;
    lastLntToastS = -999;
    lastCliffToastS = -999;
    lastLakeToastS = -999;
    lastAltToastS = -999;
    lastNightToastS = -999;
    nextWildlifeS = 50 + Math.random() * 60;
    saveAccumS = 0;
  }

  function persistRun() {
    if (state.mode === 'idle') return;
    writeSavedRun({
      mode: state.mode,
      raceId: state.raceId,
      pos: { x: state.x, y: state.y, z: state.z },
      heading: state.heading,
      distanceM: state.distanceM,
      vertM: state.vertM,
      vertLossM: state.vertLossM,
      elapsedRunS,
      maxElevFt,
      simEpochMs: weather.getDenverClock().epochMs,
      timeDilated: state.timeDilated,
      finished: state.finished,
      dnf: state.dnf,
      runner: state.runner,
      runnerProfile: activeRunner,
      phys,
      race: raceMgr.serialize(),
    });
  }

  const START_TIME_KEY = 'telluride_trails.startTime.v1';
  function resolveFreeRunStartTime(startTime, startHour) {
    let spec = null;
    if (typeof startHour === 'number' && Number.isFinite(startHour)) {
      spec = startHour;
    } else if (startTime === 'realtime') {
      spec = 'now';
    } else if (startTime) {
      spec = startTime;
    }
    if (startTime) {
      try { localStorage.setItem(START_TIME_KEY, String(startTime)); } catch {}
    } else if (spec === null) {
      try { spec = localStorage.getItem(START_TIME_KEY) || 'morning'; } catch { spec = 'morning'; }
    }
    weather.setStartTime(spec ?? 'morning');
    lastLocalClock = weather.getDenverClock();
  }

  function startFreeRun({ x = 0, z = 0, heading = 0, startTime, startHour } = {}) {
    clearSavedRun();
    raceMgr.clear();
    hardrockRock.visible = false;
    state.mode = 'freerun';
    state.raceId = null;
    state.paused = false;
    state.timeDilated = timeScale > 1;
    ensureVectorArea(x, z);
    const drySpawn = findDryShore(x, z, engine, terrain, trailData);
    const clearSpawn = pushClearOfBuildings(drySpawn.x, drySpawn.z, 0.55);
    const spawnX = clearSpawn.x;
    const spawnZ = clearSpawn.z;
    if (drySpawn.nudged || clearSpawn.pushed) {
      ensureVectorArea(spawnX, spawnZ);
    }
    resetRunMetrics(spawnX, spawnZ, heading);
    runner.ensureLoaded();
    resolveFreeRunStartTime(startTime, startHour);
    syncDogsActive();

    syncRunnerVisuals(0.016, lastLocalClock.isNight, true);
    engine.cameraRig?.snapTo?.({ x: state.x, y: state.y, z: state.z }, state.heading);
    engine.setAppState?.('playing');
    emitHud(null, false);
    engine.events.emit('game:started', { mode: 'freerun', pos: { x: spawnX, z: spawnZ, y: state.y } });
    persistRun();
  }

  function startRace(raceId) {
    const race = trailData?.races?.find((r) => r.id === raceId);
    if (!race) {
      toast(`Race "${raceId}" not found; starting Free Run.`, 'warn', 3.5);
      startFreeRun({ x: 0, z: 0, heading: 0 });
      return;
    }

    clearSavedRun();
    state.mode = 'race';
    state.raceId = race.id;
    state.paused = false;
    state.timeDilated = timeScale > 1;

    const rawSx = race.start?.x ?? race.line?.[0] ?? 0;
    const rawSz = race.start?.z ?? race.line?.[1] ?? 0;
    const clearStart = pushClearOfBuildings(rawSx, rawSz, 0.52);
    const sx = clearStart.x;
    const sz = clearStart.z;
    let heading = typeof race.start?.heading === 'number' && Number.isFinite(race.start.heading)
      ? race.start.heading
      : 0;
    if (typeof race.start?.heading !== 'number' && race.line && race.line.length >= 6) {
      heading = Math.atan2(-(race.line[3] - race.line[0]), -(race.line[4] - race.line[1]));
    }

    resetRunMetrics(sx, sz, heading);
    ensureVectorArea(sx, sz);
    runner.ensureLoaded();
    weather.setStartTime(race.startTimeLocal || '06:00');
    lastLocalClock = weather.getDenverClock();
    raceMgr.initRace(race);
    raceMgr.setRunnerMeta(state.runner);
    if (state.timeDilated) raceMgr.markTimeDilated();
    if (race.seaLevel) {
      virtualElevRefM = raceMgr.getVirtualElevationM();
      maxElevFt = (virtualElevRefM ?? 268) * M_TO_FT;
    }

    const isHardrock = (race.id || '').toLowerCase().includes('hardrock');
    hardrockRock.visible = isHardrock;
    syncDogsActive();

    syncRunnerVisuals(0.016, lastLocalClock.isNight, true);
    engine.cameraRig?.snapTo?.({ x: state.x, y: state.y, z: state.z }, state.heading);
    engine.setAppState?.('playing');
    emitHud(null, false);
    engine.events.emit('game:started', { mode: 'race', raceId: race.id, pos: { x: sx, z: sz, y: state.y } });
    toast(`${race.name} started! Real-time clock is live.`, 'ok', 4.5);
    persistRun();
  }

  function resumeSaved() {
    const saved = loadSavedRun();
    if (!saved) return false;

    const nowMs = Date.now();
    const awayS = Math.max(0, (nowMs - (saved.lastSavedEpochMs || nowMs)) / 1000);

    state.mode = saved.mode;
    state.raceId = saved.raceId || null;
    state.paused = false;
    state.finished = Boolean(saved.finished);
    state.dnf = Boolean(saved.dnf);
    state.x = saved.pos?.x ?? 0;
    state.z = saved.pos?.z ?? 0;
    ensureVectorArea(state.x, state.z);
    runner.ensureLoaded();
    const groundY = sampleGroundHeight(state.x, state.z);
    vertRefY = groundY;
    state.y = groundY;
    state.heading = saved.heading ?? 0;
    camPoseScratch.x = state.x;
    camPoseScratch.y = state.y;
    camPoseScratch.z = state.z;
    camPoseScratch.heading = state.heading;
    cachedReturnRoute = null;
    cachedRoutePerfMs = -Infinity;
    state.distanceM = saved.distanceM ?? 0;
    state.vertM = saved.vertM ?? 0;
    state.vertLossM = saved.vertLossM ?? 0;
    state.timeDilated = Boolean(saved.timeDilated || timeScale > 1);
    elapsedRunS = (saved.elapsedRunS ?? 0) + awayS;
    maxElevFt = saved.maxElevFt ?? (groundY * M_TO_FT);
    if (saved.simEpochMs) {
      weather.setSimEpochMs(saved.simEpochMs + awayS * 1000);
    } else {
      weather.setStartTime('morning');
      weather.advanceSimClock(elapsedRunS);
      weather.syncWorldClock(true);
    }
    if (saved.runnerProfile || saved.runner) {
      activeRunner = normalizeRunnerSelection(saved.runnerProfile || saved.runner);
      runner.setAppearance(activeRunner.kit);
      state.runner = runnerHudMeta(activeRunner);
      engine.events.emit('game:runnerChanged', { runner: activeRunner });
    }
    lastLocalClock = weather.getDenverClock();
    phys = { ...createPhysiology(activeRunner.stats), ...(saved.phys || {}) };
    if (!saved.phys?.energyMax) {
      applyRunnerStatsToPhysiology(phys, activeRunner.stats);
    }

    // Simulate resting physiology while away (real clock never stops!)
    if (awayS > 1) {
      const clock = weather.getDenverClock();
      let left = Math.min(awayS, 48 * 3600);
      while (left > 0) {
        const ch = Math.min(60, left);
        stepPhysiology(phys, ch, {
          speedMs: 0,
          grade: 0,
          elevationM: groundY,
          surface: 'trail',
          offTrail: false,
          tempC: 12,
          effort: 'idle',
          localHour: clock.hour,
          elapsedHours: elapsedRunS / 3600,
          isMoving: false,
          stats: activeRunner.stats,
        });
        left -= ch;
      }
    }

    if (state.mode === 'race' && saved.raceId) {
      const race = trailData?.races?.find((r) => r.id === saved.raceId);
      if (race) {
        raceMgr.initRace(race, saved.race);
        raceMgr.setRunnerMeta(state.runner);
        raceMgr.addWallGap(awayS);
        if (state.timeDilated) raceMgr.markTimeDilated();
        if (race.seaLevel) virtualElevRefM = raceMgr.getVirtualElevationM();
        hardrockRock.visible = (race.id || '').toLowerCase().includes('hardrock');
        state.checkpointIdx = saved.race?.checkpointIdx || 0;
      } else {
        state.mode = 'freerun';
        raceMgr.clear();
      }
    } else {
      raceMgr.clear();
      hardrockRock.visible = false;
    }

    stuckAnchorX = state.x;
    stuckAnchorZ = state.z;
    stuckTimerS = 0;
    syncDogsActive();
    syncRunnerVisuals(0.016, weather.getDenverClock().isNight, true);
    engine.cameraRig?.snapTo?.({ x: state.x, y: state.y, z: state.z }, state.heading);
    engine.setAppState?.('playing');

    const awayJoke = formatAwayJoke(awayS);
    if (awayJoke) toast(awayJoke, 'warn', 6.0);
    if (awayS >= 3600) unlockAchievement('chair_sitter');

    engine.events.emit('game:resumed', { awayS, awayMessage: awayJoke });
    emitHud(null, false);
    return true;
  }

  function resume() {
    if (state.mode === 'idle' && hasSavedRun()) {
      return resumeSaved();
    }
    state.paused = false;
    weather.syncWorldClock(true);
    engine.setAppState?.('playing');
    engine.events.emit('game:paused', { paused: false });
    return true;
  }

  function pause() {
    if (state.mode === 'idle') return;
    state.paused = true;
    persistRun();
    engine.setAppState?.('paused');
    engine.events.emit('game:paused', { paused: true });
  }

  function setTimeScale(scale) {
    const s = Math.max(1, Number(scale) || 1);
    timeScale = s;
    state.timeScale = s;
    if (s > 1 && state.mode !== 'idle') {
      state.timeDilated = true;
      raceMgr.markTimeDilated();
      unlockAchievement('time_lord');
    }
  }

  function teleport(x, z, heading = state.heading) {
    ensureVectorArea(x, z);
    const dry = findDryShore(x, z, engine, terrain, trailData);
    const clear = pushClearOfBuildings(dry.x, dry.z, 0.52);
    state.x = clear.x;
    state.z = clear.z;
    const groundY = sampleGroundHeight(state.x, state.z);
    vertRefY = groundY;
    if (raceMgr.getRace()?.seaLevel) {
      virtualElevRefM = raceMgr.getVirtualElevationM();
    }
    stuckAnchorX = state.x;
    stuckAnchorZ = state.z;
    stuckTimerS = 0;
    state.y = groundY;
    state.heading = heading;
    camPoseScratch.x = state.x;
    camPoseScratch.y = groundY;
    camPoseScratch.z = state.z;
    camPoseScratch.heading = heading;
    cachedReturnRoute = null;
    cachedRoutePerfMs = -Infinity;
    jumpOffset = 0;
    jumpVel = 0;
    if (dry.nudged || clear.pushed) ensureVectorArea(state.x, state.z);
    syncDogsActive();
    syncRunnerVisuals(0.016, weather.getDenverClock().isNight, true);
    engine.cameraRig?.snapTo?.({ x: state.x, y: state.y, z: state.z }, state.heading);
  }

  function computeAutopilotDir(nearest) {
    if (state.mode === 'race' && raceMgr.isActive()) {
      const target = raceMgr.getAutopilotTarget(state.x, state.z, 22);
      if (target) {
        if (target.offCourseM > 90 && trailData?.route) {
          const nowPerf = performance.now();
          const cooldownExpired = (nowPerf - cachedRoutePerfMs) > 2500;
          let needRecompute = cooldownExpired;
          if (!needRecompute && cachedReturnRoute && cachedReturnRoute.length >= 2) {
            const wp = cachedReturnRoute[cachedRouteIdx];
            if (wp && Math.hypot(wp.x - state.x, wp.z - state.z) < 12 && cachedRouteIdx < cachedReturnRoute.length - 1) {
              cachedRouteIdx++;
            }
            const curWp = cachedReturnRoute[cachedRouteIdx];
            if (curWp && Math.hypot(curWp.x - state.x, curWp.z - state.z) > 120) {
              needRecompute = true;
            }
          }
          if (needRecompute) {
            cachedRoutePerfMs = nowPerf;
            cachedReturnRoute = trailData.route({ x: state.x, z: state.z }, target) || null;
            cachedRouteIdx = 1;
          }
          if (cachedReturnRoute && cachedReturnRoute.length >= 2) {
            const p = cachedReturnRoute[Math.min(cachedRouteIdx, cachedReturnRoute.length - 1)];
            const dx = p.x - state.x;
            const dz = p.z - state.z;
            const len = Math.hypot(dx, dz) || 1;
            return { x: dx / len, z: dz / len };
          }
        } else {
          cachedReturnRoute = null;
          cachedRoutePerfMs = -Infinity;
        }
        const dx = target.x - state.x;
        const dz = target.z - state.z;
        const len = Math.hypot(dx, dz) || 1;
        return { x: dx / len, z: dz / len };
      }
    }

    // Free run autopilot: follow current trail forward along heading
    if (nearest) {
      const fwdX = -Math.sin(state.heading);
      const fwdZ = -Math.cos(state.heading);
      let tx = nearest.tx ?? fwdX;
      let tz = nearest.tz ?? fwdZ;
      const tLen = Math.hypot(tx, tz) || 1;
      tx /= tLen;
      tz /= tLen;
      if (fwdX * tx + fwdZ * tz < 0) {
        tx = -tx;
        tz = -tz;
      }
      // Pull slightly toward centerline
      const cx = (nearest.x - state.x) * 0.25;
      const cz = (nearest.z - state.z) * 0.25;
      const dx = tx + cx;
      const dz = tz + cz;
      const len = Math.hypot(dx, dz) || 1;
      return { x: dx / len, z: dz / len };
    }

    return { x: -Math.sin(state.heading), z: -Math.cos(state.heading) };
  }

  function stepSimulation(dtSim, input) {
    ensureVectorArea(state.x, state.z);
    const surfEval = evaluateSurface(state.x, state.z, terrain, trailData);
    lastSurfaceInfo = surfEval;

    const activeRace = state.mode === 'race' && raceMgr.isActive() ? raceMgr.getRace() : null;
    const isSeaLevelRace = Boolean(activeRace?.seaLevel);
    const virtualElevM = isSeaLevelRace ? raceMgr.getVirtualElevationM() : null;
    const physElevM = Number.isFinite(virtualElevM) ? virtualElevM : surfEval.elevM;

    const weatherState = weather.update(dtSim, {
      elevM: physElevM,
      surface: surfEval.surface,
      elapsedRunS,
      timeScale,
    });
    lastLocalClock = weatherState.clock;
    lastStormRisk = weatherState.stormRisk;

    for (const ev of weatherState.events) {
      if (ev.type === 'storm_start') {
        toast(pickStormWarning(), 'warn', 5.0);
        unlockAchievement('monsoon');
      } else if (ev.type === 'ridge_static') {
        toast('Your trekking poles are humming with static! Drop below treeline!', 'bad', 5.0);
      } else if (ev.type === 'lightning_strike') {
        fallTimer = 2.5;
        phys.stamina = Math.max(5, phys.stamina - 35);
        toast('CRACK! Close lightning strike on the ridge knocked you down!', 'bad', 5.5);
      }
    }

    // Handle stumble / fall recovery (clocks, physiology, and race timer still advance!)
    const isFallenNow = fallTimer > 0;
    if (isFallenNow) {
      fallTimer = Math.max(0, fallTimer - dtSim);
      state.speedMs = 0;
      state.gait = 'fallen';
      if (input.jump || autopilot) {
        fallTimer = Math.min(fallTimer, 0.3);
      }
    }
    if (stumbleTimer > 0) {
      stumbleTimer = Math.max(0, stumbleTimer - dtSim);
    }

    // Determine movement vector in world XZ
    let dirX = 0;
    let dirZ = 0;
    let moveMag = 0;

    if (isFallenNow) {
      moveMag = 0;
    } else if (raceMgr.isCeremony()) {
      moveMag = 0;
      state.gait = 'ceremony';
    } else if (autopilot) {
      const autoDir = computeAutopilotDir(surfEval.nearest);
      dirX = autoDir.x;
      dirZ = autoDir.z;
      moveMag = 1;
    } else {
      const mx = input.move?.x || 0;
      const my = input.move?.y || 0;
      moveMag = clamp(Math.hypot(mx, my), 0, 1);
      if (moveMag > 0.05) {
        const yaw = engine.cameraRig?.getYaw?.() || 0;
        const forwardX = -Math.sin(yaw);
        const forwardZ = -Math.cos(yaw);
        const rightX = Math.cos(yaw);
        const rightZ = -Math.sin(yaw);
        dirX = (forwardX * my + rightX * mx) / moveMag;
        dirZ = (forwardZ * my + rightZ * mx) / moveMag;

        // Subtle trail-keeping magnet (stronger on touch screens)
        const pulled = applyTrailCenterPull(state.x, state.z, dirX, dirZ, surfEval.nearest, isCoarsePointer);
        dirX = pulled.x;
        dirZ = pulled.z;
      }
    }

    // Sample terrain ahead to compute grade along travel direction before effort selection
    const aheadDist = 2.0;
    const hHere = sampleGroundHeight(state.x, state.z);
    const hAhead = moveMag > 0.05
      ? sampleGroundHeight(state.x + dirX * aheadDist, state.z + dirZ * aheadDist)
      : hHere;
    const rawGrade = moveMag > 0.05 ? (hAhead - hHere) / aheadDist : 0;
    state.grade = clamp(rawGrade, -1.5, 1.5);

    // Effort selection (with smart autopilot hiking on steep climbs, low stamina, or beat-up talus descents)
    let effort = 'idle';
    if (moveMag > 0.05) {
      if (input.sprint && phys.stamina > 8) {
        effort = 'sprint';
      } else if (input.hike) {
        effort = 'hike';
      } else if (paceMode !== 'auto') {
        effort = paceMode;
      } else if (autopilot) {
        if (phys.stamina < 25) autoHikeStaminaMode = true;
        else if (phys.stamina > 65) autoHikeStaminaMode = false;
        const hikeGradeThresh = (activeRace?.distanceMi || 0) >= 30 ? 0.13 : 0.18;
        if (
          state.grade >= hikeGradeThresh ||
          autoHikeStaminaMode ||
          (surfEval.surface === 'talus' && state.grade < -0.10 && phys.legs > 75)
        ) {
          effort = 'hike';
        } else {
          effort = 'run';
        }
      } else if (moveMag < 0.45) {
        effort = 'walk';
      } else {
        effort = 'run';
      }
    }

    // Compute speed from grade, surface, altitude, physiology, active runner stats, and race profile
    const target = computeTargetSpeed({
      effort,
      grade: state.grade,
      surface: surfEval.surface,
      surfaceInfo: surfEval.surfaceInfo,
      phys,
      stats: activeRunner.stats,
      race: activeRace,
    });

    const desiredSpeed = target.speedMs * moveMag;
    const accel = desiredSpeed > state.speedMs ? 4.5 : 6.5;
    state.speedMs += clamp(desiredSpeed - state.speedMs, -accel * dtSim, accel * dtSim);
    if (desiredSpeed < 0.05 && state.speedMs < 0.05) state.speedMs = 0;

    state.gait = isFallenNow
      ? 'fallen'
      : (raceMgr.isCeremony()
        ? 'ceremony'
        : (stumbleTimer > 0 ? 'stumble' : (state.speedMs < 0.12 ? 'idle' : target.gait)));

    let vx = dirX * state.speedMs;
    let vz = dirZ * state.speedMs;

    // Unclimbable cliff slide-back (relaxed on mapped trails/paths or within 10m of official race course;
    // never blocks returning toward a nearby trail <=30m or race course <=40m; guards against V-gully traps)
    const offCourseM = activeRace ? raceMgr.getOffCourseM() : Infinity;
    const onRaceCourse = Boolean(activeRace && offCourseM <= 10);
    const cliffLimit = (surfEval.onTrail || onRaceCourse) ? TRAIL_CLIFF_GRADE : CLIFF_GRADE;
    const normal = terrain.getNormal ? terrain.getNormal(state.x, state.z) : null;
    cliffOptsScratch.x = state.x;
    cliffOptsScratch.z = state.z;
    cliffOptsScratch.nearestTrail = surfEval.nearest;
    cliffOptsScratch.offCourseM = offCourseM;
    cliffOptsScratch.courseTarget = (activeRace && offCourseM > 10 && offCourseM <= 40)
      ? raceMgr.getAutopilotTarget(state.x, state.z, 8)
      : null;
    const cliffRes = resolveCliffSlide(vx, vz, normal, dtSim, cliffLimit, cliffOptsScratch);
    vx = cliffRes.vx;
    vz = cliffRes.vz;
    if (cliffRes.onCliff && elapsedRunS - lastCliffToastS > 12) {
      lastCliffToastS = elapsedRunS;
      toast(pickCliffWarning(), 'warn', 3.5);
    }

    // Integrate horizontal motion with building/pylon collision & diagonal shoreline glide
    const prevX = state.x;
    const prevZ = state.z;
    let nextX = state.x + vx * dtSim;
    let nextZ = state.z + vz * dtSim;

    // Push out of 3D buildings, mining ruins, and gondola/chairlift pylons
    const bldgRes = pushClearOfBuildings(nextX, nextZ, 0.48);
    if (bldgRes.pushed) {
      nextX = bldgRes.x;
      nextZ = bldgRes.z;
    }

    const nearWaterHint = Boolean(surfEval.cover && surfEval.cover.water > 0.2);
    // If somehow standing inside deep lake water (e.g. chunk finished streaming), nudge onto dry shore
    if (!surfEval.onTrail && isDeepLakeWater(state.x, state.z, engine, terrain, trailData, false, nearWaterHint)) {
      const dry = findDryShore(state.x, state.z, engine, terrain, trailData);
      if (dry.nudged) {
        nextX = dry.x;
        nextZ = dry.z;
      }
    } else if ((vx !== 0 || vz !== 0) && isDeepLakeWater(nextX, nextZ, engine, terrain, trailData, surfEval.onTrail, nearWaterHint)) {
      // Allow sliding along whichever axis stays dry on the shoreline, or ±35°/±70° diagonal glide
      const xDry = !isDeepLakeWater(nextX, state.z, engine, terrain, trailData, surfEval.onTrail, nearWaterHint);
      const zDry = !isDeepLakeWater(state.x, nextZ, engine, terrain, trailData, surfEval.onTrail, nearWaterHint);
      if (xDry) {
        nextZ = state.z;
      } else if (zDry) {
        nextX = state.x;
      } else {
        const dxStep = nextX - state.x;
        const dzStep = nextZ - state.z;
        let glided = false;
        for (let ai = 0; ai < SHORE_SLIDE_ANGLES.length; ai++) {
          const ang = SHORE_SLIDE_ANGLES[ai];
          const ca = Math.cos(ang);
          const sa = Math.sin(ang);
          const candX = state.x + (dxStep * ca - dzStep * sa) * 0.85;
          const candZ = state.z + (dxStep * sa + dzStep * ca) * 0.85;
          if (!isDeepLakeWater(candX, candZ, engine, terrain, trailData, surfEval.onTrail, nearWaterHint)) {
            nextX = candX;
            nextZ = candZ;
            glided = true;
            break;
          }
        }
        if (!glided) {
          nextX = state.x;
          nextZ = state.z;
          state.speedMs = 0;
        }
      }
      if (elapsedRunS - lastLakeToastS > 14) {
        lastLakeToastS = elapsedRunS;
        toast('Glacial alpine water is 38°F! Admire the turquoise from the shore.', 'info', 3.5);
      }
    }

    state.x = nextX;
    state.z = nextZ;

    // 1.8 s rolling-anchor unstuck safety net when actively pushing movement input
    if (moveMag > 0.35 && !isFallenNow && !raceMgr.isCeremony()) {
      stuckTimerS += dtSim;
      const movedFromAnchor = Math.hypot(state.x - stuckAnchorX, state.z - stuckAnchorZ);
      if (movedFromAnchor >= 0.25) {
        stuckAnchorX = state.x;
        stuckAnchorZ = state.z;
        stuckTimerS = 0;
      } else if (stuckTimerS >= 1.8) {
        let nudgedX = state.x;
        let nudgedZ = state.z;
        if (surfEval.nearest && surfEval.nearest.dist > 0.5 && surfEval.nearest.dist <= 40) {
          const tdx = surfEval.nearest.x - state.x;
          const tdz = surfEval.nearest.z - state.z;
          const tLen = Math.hypot(tdx, tdz) || 1;
          const step = Math.min(2.2, tLen);
          nudgedX = state.x + (tdx / tLen) * step;
          nudgedZ = state.z + (tdz / tLen) * step;
        } else {
          nudgedX = state.x + dirX * 1.4;
          nudgedZ = state.z + dirZ * 1.4;
        }
        const dry = findDryShore(nudgedX, nudgedZ, engine, terrain, trailData);
        const clear = pushClearOfBuildings(dry.x, dry.z, 0.52);
        state.x = clear.x;
        state.z = clear.z;
        stuckAnchorX = state.x;
        stuckAnchorZ = state.z;
        stuckTimerS = 0;
      }
    } else {
      stuckAnchorX = state.x;
      stuckAnchorZ = state.z;
      stuckTimerS = 0;
    }

    const stepDist = Math.hypot(state.x - prevX, state.z - prevZ);
    state.distanceM += stepDist;

    if (stepDist > 0.01 && !cliffRes.onCliff) {
      const targetHeading = Math.atan2(-vx, -vz);
      const diff = Math.atan2(Math.sin(targetHeading - state.heading), Math.cos(targetHeading - state.heading));
      state.heading += diff * Math.min(1, dtSim * 10);
    }

    // Ground elevation & vert tracking (sea-level races accumulate vert from virtual elevation profile
    // while keeping state.y 100% locked to real 3D ground height so runner never clips into asphalt!)
    const newGroundY = sampleGroundHeight(state.x, state.z);
    if (isSeaLevelRace) {
      const nextVirtElev = raceMgr.getVirtualElevationM();
      if (Number.isFinite(nextVirtElev)) {
        if (virtualElevRefM === null) {
          virtualElevRefM = nextVirtElev;
        } else {
          const vDelta = nextVirtElev - virtualElevRefM;
          if (Math.abs(vDelta) >= 0.4) {
            if (vDelta > 0) state.vertM += vDelta;
            else state.vertLossM += -vDelta;
            virtualElevRefM = nextVirtElev;
          }
        }
      }
    } else if (stepDist > 0.01) {
      const refDelta = newGroundY - vertRefY;
      if (Math.abs(refDelta) >= 1.5 && Math.abs(refDelta) < 18) {
        if (refDelta > 0) state.vertM += refDelta;
        else state.vertLossM += -refDelta;
        vertRefY = newGroundY;
      } else if (Math.abs(refDelta) >= 18) {
        // Large sudden LOD pop: re-anchor without fake vertical gain
        vertRefY = newGroundY;
      }
    } else if (Math.abs(newGroundY - vertRefY) >= 4) {
      vertRefY = newGroundY;
    }

    const effectiveElevM = isSeaLevelRace && Number.isFinite(virtualElevM) ? virtualElevM : newGroundY;
    const elevFt = effectiveElevM * M_TO_FT;
    if (elevFt > maxElevFt) maxElevFt = elevFt;

    // Jump / trail hop (always allowed so players can hop/scramble out of steep dips!)
    if (!isFallenNow && input.jump && jumpOffset <= 0.01) {
      jumpVel = 3.8;
      engine.events.emit('game:jump', { surface: surfEval.surface, speedMs: state.speedMs });
    }
    if (jumpOffset > 0 || jumpVel !== 0) {
      jumpVel -= 14.5 * dtSim;
      jumpOffset += jumpVel * dtSim;
      if (jumpOffset <= 0) {
        jumpOffset = 0;
        jumpVel = 0;
      }
    }
    // Exact terrain-locked grounding: zero smoothY lag on steep climbs/descents
    state.y = newGroundY + jumpOffset;

    // Trail-keeping & Leave No Trace warnings (never warn when legitimately on active race course)
    const offTrail = !surfEval.onTrail && !onRaceCourse && surfEval.surfaceInfo.offTrail;
    if (offTrail && stepDist > 0.05) {
      offTrailSeconds += dtSim;
      if (offTrailSeconds > 6 && elapsedRunS - lastLntToastS > 32) {
        lastLntToastS = elapsedRunS;
        lntWarningsCount++;
        toast(pickLntWarning(), 'warn', 4.5);
        if (lntWarningsCount >= 3) unlockAchievement('lnt_scold');
      }
    } else if (surfEval.onTrail || onRaceCourse) {
      offTrailSeconds = Math.max(0, offTrailSeconds - dtSim * 0.5);
    }

    // Step physiology using actual realized gait (target.gait) so auto power-hike gets hike economics!
    elapsedRunS += dtSim;
    const physEvents = stepPhysiology(phys, dtSim, {
      speedMs: state.speedMs,
      grade: state.grade,
      elevationM: effectiveElevM,
      surface: surfEval.surface,
      offTrail,
      tempC: weatherState.tempC,
      effort: target.gait,
      localHour: weatherState.clock.hour,
      elapsedHours: elapsedRunS / 3600,
      isMoving: state.speedMs > 0.2,
      stats: activeRunner.stats,
    });

    for (const ev of physEvents) {
      if (ev.type === 'bonk') toast(pickBonkQuote(), 'bad', 5.0);
      else if (ev.type === 'low_energy') toast('Low fuel! Eat something before you bonk.', 'warn', 4.0);
      else if (ev.type === 'dehydrated') toast('Dehydrated! Drink at a stream or aid station.', 'warn', 4.0);
      else if (ev.type === 'cramp') toast('Quad cramp! Ease the pace and get some salt.', 'warn', 4.0);
      else if (ev.type === 'vomit') toast('Overfilled your stomach on the climb. Rough reset.', 'bad', 4.5);
    }

    // Technical terrain trip/fall when tired
    const fallProb = isFallenNow
      ? 0
      : fallProbabilityPerSec(phys, state.speedMs, surfEval.surfaceInfo.stumbleMul, state.grade, activeRunner.stats, target.gait);
    if (fallProb > 0 && Math.random() < fallProb * dtSim) {
      phys.falls++;
      phys.legs = Math.min(100, phys.legs + 0.5);
      fallTimer = 2.4;
      state.speedMs = 0;
      toast('Caught a toe on a rock and hit the dirt! Press Space / tap to get up.', 'warn', 4.0);
    }

    // Stream proximity & auto-toast / refill opportunity
    const nearStream = surfEval.surface === 'creek' || surfEval.cover.water > 0.35;
    if (nearStream && !prevNearStream) {
      if (autopilot && phys.flasksMl < phys.flaskMaxMl * 0.6) {
        refillFlasks(phys, false);
        toast('Refilled flasks in the cold mountain stream.', 'ok', 3.0);
      } else {
        toast('Cold mountain stream! Tap Refill to top off your flasks.', 'info', 3.5);
      }
    }
    prevNearStream = nearStream;

    // Altitude / night / wildlife flavor & achievements
    if (elevFt > 11800 && elapsedRunS - lastAltToastS > 180) {
      lastAltToastS = elapsedRunS;
      toast(pickAltQuote(), 'joke', 4.5);
    }
    if (weatherState.clock.isNight && weatherState.clock.hour >= 0 && weatherState.clock.hour < 4 && state.speedMs > 0.5) {
      unlockAchievement('night_owl');
      if (elapsedRunS - lastNightToastS > 240) {
        lastNightToastS = elapsedRunS;
        toast(pickNightQuote(), 'joke', 4.5);
      }
    }

    if (elapsedRunS >= nextWildlifeS && state.speedMs > 0.5) {
      nextWildlifeS = elapsedRunS + 85 + Math.random() * 90;
      const w = pickWildlifeEvent({
        elevM: newGroundY,
        surface: surfEval.surface,
        trailName: surfEval.nearest?.name,
        x: state.x,
        z: state.z,
      });
      if (w) {
        toast(w.text, 'wildlife', 5.0);
        if (w.achievement) unlockAchievement(w.achievement);
      }
    }

    // Distance & elevation achievements
    if (state.distanceM >= MILE_M) unlockAchievement('first_mile');
    if (state.distanceM >= 10 * KM_M) unlockAchievement('ten_k');
    if (state.distanceM >= 26.2 * MILE_M) unlockAchievement('marathon');
    if (state.distanceM >= 50 * MILE_M) unlockAchievement('fifty_mi');
    if (state.distanceM >= 100 * MILE_M) unlockAchievement('hundred_mi');
    if (maxElevFt >= 13000) unlockAchievement('summit_13k');
    if (maxElevFt >= 14000) unlockAchievement('summit_14k');

    // Race update
    let nearAid = null;
    if (state.mode === 'race' && raceMgr.isActive()) {
      const raceRes = raceMgr.update(dtSim, state.x, state.z, state.speedMs, weatherState.clock.hour);
      nearAid = raceRes.nearAid;

      // Off-course race time penalty if sustained shortcutting > 55m off-course while moving
      if (raceMgr.getOffCourseM() > 55 && stepDist > 0.05) {
        raceOffCourseS += dtSim;
        if (raceOffCourseS >= 20) {
          raceOffCourseS = 0;
          raceMgr.addPenalty(30);
          toast('Off-course shortcut (+30s race penalty). Return to the flagged route!', 'warn', 4.5);
        }
      } else {
        raceOffCourseS = Math.max(0, raceOffCourseS - dtSim * 2);
      }

      // Smart autopilot aid station auto-fuel (calories, sodium, hydration, night coffee without overflowing stomach)
      if (autopilot && nearAid) {
        if (phys.flasksMl < phys.flaskMaxMl * 0.85) refillFlasks(phys, true);
        const cap = phys.stomachCap || 950;
        if (elapsedRunS - lastAutoAidRefuelS >= 18 && stomachLoad(phys) < cap * 0.62) {
          let ate = false;
          if (phys.drowsiness > 0.35 && nearAid.foods?.includes('coffee')) {
            eatItem(phys, 'coffee', state.speedMs);
            ate = true;
          } else if (phys.sodiumDeficitMg > 1200) {
            eatItem(phys, nearAid.foods?.includes('broth') ? 'broth' : 'potato', state.speedMs);
            ate = true;
          } else if (phys.energy < (phys.energyMax || 2200) * 0.72) {
            eatItem(phys, phys.energy < 950 ? 'quesadilla' : 'pbj', state.speedMs);
            ate = true;
          } else if (phys.waterDeficitMl > 600) {
            eatItem(phys, 'electro', state.speedMs);
            ate = true;
          }
          if (ate) lastAutoAidRefuelS = elapsedRunS;
        }
      }

      for (const rev of raceRes.events) {
        if (rev.type === 'checkpoint') {
          state.checkpointIdx = rev.index;
          // UI listens to 'game:checkpoint' and displays the checkpoint toast
          engine.events.emit('game:checkpoint', rev);
          persistRun();
        } else if (rev.type === 'ceremony_start') {
          toast('You made it to Silverton! Kissing the Hardrock...', 'ok', 4.0);
        } else if (rev.type === 'finish') {
          state.finished = true;
          if (rev.isHardrock) unlockAchievement('kiss_rock');
          clearSavedRun();
          engine.setAppState?.('results');
          engine.events.emit('game:finish', {
            mode: 'race',
            raceId: rev.raceId,
            raceName: rev.raceName,
            timeSec: rev.clockS,
            clockS: rev.clockS,
            rawClockS: rev.rawClockS,
            penaltiesSec: rev.penaltyS,
            penaltyS: rev.penaltyS,
            distM: state.distanceM,
            vertGainM: state.vertM,
            vertLossM: state.vertLossM,
            falls: phys.falls,
            kcalEaten: phys.kcalEaten,
            mlDrunk: phys.mlDrunk,
            timeDilated: rev.timeDilated,
            timeDilation: rev.timeDilated,
            statUncapped: Boolean(rev.statUncapped || activeRunner.statUncapped),
            asterisk: Boolean(rev.timeDilated || rev.statUncapped || activeRunner.statUncapped),
            runner: rev.runner || state.runner,
            pb: rev.pb,
            isNewPb: rev.isNewPb,
            splits: rev.splits,
            kissedRock: rev.isHardrock,
            ceremony: rev.isHardrock ? 'kiss_rock' : 'finish',
          });
        } else if (rev.type === 'dnf') {
          state.dnf = true;
          state.dnfReason = rev.reason;
          clearSavedRun();
          engine.setAppState?.('results');
          engine.events.emit('game:dnf', {
            raceId: raceMgr.getRace()?.id,
            raceName: raceMgr.getRace()?.name,
            reason: rev.reason,
            timeSec: raceMgr.getHudSummary(0)?.clockS ?? elapsedRunS,
            clockS: raceMgr.getHudSummary(0)?.clockS ?? elapsedRunS,
            distM: state.distanceM,
            vertGainM: state.vertM,
            runner: state.runner,
            statUncapped: Boolean(activeRunner.statUncapped),
            asterisk: Boolean(state.timeDilated || activeRunner.statUncapped),
          });
        }
      }
    }

    lastNearAid = nearAid;
    return { surfEval, weatherState, nearAid, nearStream };
  }

  function emitHud(nearAid, nearStream) {
    const surfEval = lastSurfaceInfo || evaluateSurface(state.x, state.z, terrain, trailData);
    const hydr01 = hydrationPct(phys) / 100;
    const stam01 = phys.stamina / 100;
    const onRaceLineHud = state.mode === 'race' && raceMgr.isActive() && raceMgr.getOffCourseM() <= 10;
    const onTrailEffective = surfEval.onTrail || onRaceLineHud;
    state.stamina = stam01;
    state.hydration = hydr01;
    state.surface = surfEval.surface;
    state.trailName = surfEval.nearest?.name || (onRaceLineHud ? (raceMgr.getRace()?.name || 'Race Course') : (surfEval.onTrail ? 'San Juan Trail' : 'Off-Trail'));
    state.autopilot = autopilot;

    const paceSecPerMi = state.speedMs > 0.25 ? MILE_M / state.speedMs : 0;
    const paceSecPerKm = state.speedMs > 0.25 ? KM_M / state.speedMs : 0;
    const paceMinPerMi = paceSecPerMi > 0 ? paceSecPerMi / 60 : 0;

    const rawRaceHud = state.mode === 'race'
      ? raceMgr.getHudSummary(state.speedMs, lastLocalClock.epochMs)
      : null;
    const raceHud = rawRaceHud ? {
      ...rawRaceHud,
      clockSec: rawRaceHud.clockS,
      etaSec: rawRaceHud.nextAidEtaS,
      finishEtaStr: rawRaceHud.etaLabel,
      cutoffSec: rawRaceHud.nextAidCutoffS,
      checkpointIdx: rawRaceHud.checkpointsPassed,
    } : null;

    const activeRaceHud = state.mode === 'race' && raceMgr.isActive() ? raceMgr.getRace() : null;
    const isSeaLevelHud = Boolean(activeRaceHud?.seaLevel);
    const virtElevHud = isSeaLevelHud ? raceMgr.getVirtualElevationM() : null;
    const displayElevM = Number.isFinite(virtElevHud) ? virtElevHud : state.y;

    engine.events.emit('hud', {
      mode: state.mode,
      paused: state.paused,
      finished: state.finished,
      dnf: state.dnf,
      dnfReason: state.dnfReason,
      speedMs: state.speedMs,
      paceMinPerMi,
      paceSecPerMi,
      paceSecPerKm,
      distanceM: state.distanceM,
      distM: state.distanceM,
      vertM: state.vertM,
      vertGainM: state.vertM,
      vertLossM: state.vertLossM,
      elevationM: displayElevM,
      elevM: displayElevM,
      elevFt: displayElevM * M_TO_FT,
      seaLevel: isSeaLevelHud,
      grade: state.grade,
      gait: state.gait,
      stamina: stam01,
      staminaPct: phys.stamina,
      energy: phys.energy,
      hydration: hydr01,
      hydrationPct: hydr01 * 100,
      legs: phys.legs,
      drowsiness: phys.drowsiness,
      altitudeFactor: phys.altitudeFactor,
      altitudePenalty: displayElevM * M_TO_FT > ALT_PENALTY_START_FT ? (1 - phys.altitudeFactor) : 0,
      flasksMl: phys.flasksMl,
      gelsCarried: phys.gelsCarried,
      surface: surfEval.surface,
      surfaceLabel: surfEval.surfaceInfo.label,
      trailName: state.trailName,
      trailDistM: surfEval.trailDistM,
      onTrail: onTrailEffective,
      offTrailSeconds,
      x: state.x,
      z: state.z,
      y: state.y,
      heading: state.heading,
      runnerHeight: runnerBoundsScratch.height,
      runnerRadius: runnerBoundsScratch.radius,
      runner: state.runner,
      race: raceHud,
      nearAid,
      nearStream,
      autopilot,
      paceMode,
      stormRisk: weather.isStormActive() ? 1 : lastStormRisk,
      stormActive: weather.isStormActive(),
      localTimeStr: lastLocalClock.label,
      fallen: fallTimer > 0,
      timeDilated: state.timeDilated,
      timeScale,
    });
  }

  function update(dt) {
    if (state.mode === 'idle') return;
    if (state.paused || state.finished || state.dnf) {
      syncRunnerVisuals(0, lastLocalClock.isNight);
      return;
    }

    const input = engine.input || { move: { x: 0, y: 0 }, look: { x: 0, y: 0 } };

    const totalSimDt = Math.min(dt, 0.1) * timeScale;
    const maxDistStepDt = 0.45 / Math.max(state.speedMs, 5.5);
    const maxStep = Math.min(0.10, maxDistStepDt);
    const maxSubsteps = 240;
    const substeps = Math.max(1, Math.min(maxSubsteps, Math.ceil(totalSimDt / maxStep)));
    const stepDt = totalSimDt / substeps;

    let stepOut = { nearAid: null, nearStream: false, weatherState: { clock: lastLocalClock } };
    for (let i = 0; i < substeps; i++) {
      stepOut = stepSimulation(stepDt, input);
      if (state.finished || state.dnf) break;
    }

    const { isFp, bounce } = syncRunnerVisuals(dt, stepOut.weatherState.clock.isNight);

    // Update camera pose scratch (and drive cameraRig unless main.js takes ownership)
    const camY = state.y + (isFp ? bounce * 0.7 : 0);
    camPoseScratch.x = state.x;
    camPoseScratch.y = camY;
    camPoseScratch.z = state.z;
    camPoseScratch.heading = state.heading;
    if (!engine.cameraRig?.externalUpdate) {
      engine.cameraRig?.update?.(dt, camPoseScratch, input);
    }

    emitHud(stepOut.nearAid, stepOut.nearStream);

    // Periodic save every 5 real seconds
    saveAccumS += dt;
    if (saveAccumS >= 5) {
      saveAccumS = 0;
      persistRun();
    }
  }

  // --- Event subscriptions ---
  function setAutopilot(next) {
    const enabled = Boolean(next);
    if (enabled === autopilot) return;
    autopilot = enabled;
    state.autopilot = autopilot;
    toast(autopilot ? 'Autopilot ON: following trail.' : 'Autopilot OFF: manual control.', 'info', 2.2);
  }

  const unsubs = [
    engine.events.on('input:autopilot-toggle', () => {
      setAutopilot(!autopilot);
    }),

    engine.events.on('ui:autopilot', (e) => {
      const next = typeof e?.enabled === 'boolean' ? e.enabled : !autopilot;
      setAutopilot(next);
    }),

    engine.events.on('ui:paceMode', (e) => {
      const m = e?.mode;
      if (['auto', 'walk', 'hike', 'run', 'sprint'].includes(m)) {
        paceMode = m;
      }
    }),

    engine.events.on('ui:eat', (e) => {
      const key = e?.key || 'gel';
      if (!FOODS[key]) return;
      if (!lastNearAid) {
        if (key !== 'gel') {
          toast('Reach an aid station to grab hot food!', 'warn', 2.5);
          return;
        }
        if (phys.gelsCarried <= 0) {
          toast('Out of gels! Restock at the next aid station.', 'warn', 2.5);
          return;
        }
        phys.gelsCarried--;
      }
      const res = eatItem(phys, key, state.speedMs);
      if (res.ok) {
        const f = FOODS[key];
        toast(`Ate ${f.name}${f.kcal ? ` (+${f.kcal} kcal)` : ''}${f.ml ? ` (+${f.ml} ml)` : ''}`, 'ok', 2.5);
      }
    }),

    engine.events.on('ui:refill', () => {
      if (lastNearAid || prevNearStream) {
        const atAid = Boolean(lastNearAid);
        const added = refillFlasks(phys, atAid);
        toast(
          atAid
            ? 'Flasks refilled & gels restocked at aid station!'
            : (added > 20 ? 'Flasks refilled with cold San Juan water!' : 'Flasks already full.'),
          'ok',
          2.5
        );
      } else {
        const sip = drinkFromFlask(phys, 200);
        toast(sip.ok ? 'Took a sip from your soft flask.' : 'Flasks are empty! Find a stream or aid station.', sip.ok ? 'ok' : 'warn', 2.5);
      }
    }),

    engine.events.on('ui:getup', () => {
      if (fallTimer > 0) fallTimer = 0.05;
    }),

    engine.events.on('ui:timeDilation', (e) => {
      setTimeScale(e?.scale ?? 1);
    }),

    engine.events.on('ui:kissRock', () => {
      raceMgr.triggerKissFinish();
    }),

    engine.events.on('ui:selectRunner', (sel) => {
      setRunner(sel);
    }),

    engine.events.on('dev:skipRace', (e) => {
      skipToRaceDistance(e?.meters ?? 0);
    }),

    engine.events.on('dev:advanceCheckpoint', () => {
      advanceCheckpoint();
    }),

    engine.events.on('engine:visibility', ({ hidden }) => {
      if (hidden) persistRun();
    }),

    engine.events.on('app:state', ({ state: appState }) => {
      if (appState === 'title' && state.mode !== 'idle') {
        persistRun();
        state.mode = 'idle';
        state.paused = false;
        hardrockRock.visible = false;
        runner.root.visible = false;
        dogs.setActive(false);
        updateRunnerBoundsScratch();
      }
    }),
  ];

  // Fallback late-update grounding pass (main.js already calls game.syncPostTerrain() right after
  // terrain.update(); this guards any standalone/test caller that doesn't call syncPostTerrain).
  const unsubLateUpdate = typeof engine.onLateUpdate === 'function'
    ? engine.onLateUpdate(() => {
      if (state.mode === 'idle') {
        runnerBoundsScratch.visible = false;
        return;
      }
      const freshGroundY = sampleGroundHeight(state.x, state.z);
      const targetY = freshGroundY + jumpOffset;
      if (Math.abs(targetY - state.y) > 0.002) {
        syncPostTerrain();
      } else {
        updateRunnerBoundsScratch();
      }
    })
    : null;

  const onBeforeUnload = () => {
    persistRun();
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  function dispose() {
    window.removeEventListener('beforeunload', onBeforeUnload);
    for (const u of unsubs) u?.();
    unsubLateUpdate?.();
    engine.scene.remove(runner.root);
    engine.scene.remove(hardrockRock);
    dogs.dispose();
    runner.dispose();
    hardrockRock.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
  }

  // --- Dev / Playtest helpers ---
  function skipToRaceDistance(meters) {
    if (state.mode !== 'race' || !raceMgr.isActive()) return false;
    const pt = raceMgr.getPointAtDistance(meters);
    if (!pt) return false;
    teleport(pt.x, pt.z, pt.heading);
    state.distanceM = Math.max(state.distanceM, pt.distM);
    return true;
  }

  function advanceCheckpoint() {
    if (state.mode !== 'race' || !raceMgr.isActive()) return false;
    const nextD = raceMgr.getNextCheckpointDist();
    return skipToRaceDistance(Math.max(0, nextD - 10));
  }

  function getSavedRunSummary() {
    if (!hasSavedRun()) return null;
    const saved = loadSavedRun();
    if (!saved) return null;
    return {
      ...saved,
      x: saved.pos?.x ?? 0,
      y: saved.pos?.y ?? 0,
      z: saved.pos?.z ?? 0,
    };
  }

  return {
    startFreeRun,
    startRace,
    resume,
    resumeSaved,
    pause,
    update,
    syncPostTerrain,
    state,
    // Runner roster & custom builder API
    getRoster: () => ({
      presets: TELLURIDE_RUNNERS,
      customArchetypes: CUSTOM_ARCHETYPES,
      swatches: RUNNER_KIT_SWATCHES,
      active: activeRunner,
    }),
    getActiveRunner: () => activeRunner,
    setRunner: (sel) => setRunner(sel),
    rollCustomRunner: (archetypeId) => rollRandomCustomRunner(archetypeId),
    // Save / PB / Achievement queries for UI
    getSavedRun: getSavedRunSummary,
    hasSavedRun,
    getPersonalBests: loadPersonalBests,
    getAchievements: () => ({ unlocked: loadAchievements(), catalog: ACHIEVEMENTS }),
    getDefaultStartTime: () => {
      try { return localStorage.getItem(START_TIME_KEY) || 'morning'; } catch { return 'morning'; }
    },
    // Dev / Playtest hooks
    teleport,
    teleportLonLat(lon, lat, heading = state.heading) {
      const { x, z } = lonLatToWorld(lon, lat);
      teleport(x, z, heading);
      return { x, z };
    },
    setTimeScale,
    setTimeOfDay: (h) => {
      weather.setTimeOfDay(h);
      lastLocalClock = weather.getDenverClock();
    },
    skipToRaceDistance,
    advanceCheckpoint,
    triggerStormNow: (dur) => weather.triggerStormNow(dur),
    getCameraPose: () => camPoseScratch,
    getRunnerBounds: () => runnerBoundsScratch,
    getDogsState: () => dogs.getDebugState(),
    dispose,
  };
}
