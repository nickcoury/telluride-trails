import { createEngine } from './core/engine.js';
import { lonLatToWorld } from './core/geo.js';
import { createTerrain } from './terrain/index.js';
import { loadTrailData } from './data/index.js';
import { createWorld } from './world/index.js';
import { createGame } from './game/index.js';
import { createUI } from './ui/index.js';
import { createAudio } from './audio/index.js';

async function bootstrap() {
  const canvas = document.getElementById('game-canvas');
  const engine = createEngine({ canvas });

  const terrain = createTerrain(engine);
  engine.cameraRig.setTerrain(terrain);
  engine.cameraRig.externalUpdate = true;

  const trailData = await loadTrailData(engine);
  const world = createWorld(engine, terrain, trailData);
  const game = createGame(engine, terrain, trailData, world);

  // Start Title screen in crisp late-afternoon mid-July Telluride sun (5:30 PM MDT — sun from WSW
  // illuminating Telluride town, Ajax Peak, and the Box Canyon headwall face-on). Starting a run overrides this.
  world.setTimeOfDay?.(17.5);

  // Wire UI/input pause transitions defensively (avoid double-calling if UI already called game)
  engine.events.on('ui:resume', () => {
    if (game.state?.paused) game.resume?.();
  });
  engine.events.on('ui:pause', () => {
    if (game.state && !game.state.paused && game.state.mode !== 'idle') game.pause?.();
  });
  engine.events.on('input:pause', () => {
    const s = engine.getAppState();
    if (s === 'playing') game.pause?.();
    else if (s === 'paused') game.resume?.();
  });

  // Reusable scratch objects (zero per-frame allocations)
  const _playerPose = { x: 0, y: 0, z: 0, heading: 0 };
  const _activePos = { x: 0, y: 0, z: 0 };

  // Canonical main-loop ordering:
  // input (engine) -> game -> camera (+updateMatrixWorld) -> terrain -> world -> audio (registered below) -> scheduler -> render
  engine.onUpdate((dt, t) => {
    const appState = engine.getAppState();
    game.update(dt);

    if (engine.cameraRig.isFlythrough()) {
      engine.cameraRig.update(dt, null, engine.input);
    } else if (appState === 'title') {
      engine.cameraRig.updateTitleScenic(dt, t);
    } else if (game.state && game.state.mode !== 'idle') {
      const pose = typeof game.getCameraPose === 'function' ? game.getCameraPose() : null;
      if (pose) {
        engine.cameraRig.update(dt, pose, engine.input);
      } else {
        _playerPose.x = game.state.x;
        _playerPose.y = game.state.y;
        _playerPose.z = game.state.z;
        _playerPose.heading = game.state.heading;
        engine.cameraRig.update(dt, _playerPose, engine.input);
      }
    }

    engine.camera.updateMatrixWorld();

    const useCameraFocus = appState === 'title' || engine.cameraRig.isFlythrough();
    if (!useCameraFocus && game.state && game.state.mode !== 'idle') {
      _activePos.x = game.state.x;
      _activePos.y = game.state.y;
      _activePos.z = game.state.z;
    } else {
      _activePos.x = engine.camera.position.x;
      _activePos.y = engine.camera.position.y;
      _activePos.z = engine.camera.position.z;
    }

    terrain.update(_activePos);
    world.update(dt, _activePos);
  });

  // Register audio AFTER main loop so audio.update reads fresh game/camera/world state
  const audio = createAudio(engine, { game, world, trailData, terrain });
  const ui = createUI(engine, { trailData, game, terrain });

  performance.mark('tt:title-ready');

  function teleportWorld(x, z, heading = 0) {
    const y = terrain.getHeight(x, z);
    if (typeof game.teleport === 'function') {
      game.teleport(x, z, heading);
    } else if (game.state) {
      game.state.x = x;
      game.state.z = z;
      game.state.y = y;
      game.state.heading = heading;
    }
    engine.cameraRig.snapTo({ x, y, z }, heading);
  }

  async function startFreeRunSafe(opts = {}) {
    const x = opts.x ?? 0;
    const z = opts.z ?? 0;
    const heading = opts.heading ?? 0;
    const startTime = opts.startTime ?? 'morning';
    // Preserve explicit null (realtime) rather than coalescing to 8
    const startHour = opts.startHour !== undefined ? opts.startHour : 8;
    engine.setAppState('loading');
    await terrain.preload(x, z, 1200);
    await trailData.loadArea(x, z, 1500);
    game.startFreeRun({ x, z, heading, startTime, startHour });
    performance.mark('tt:first-playable');
  }

  const params = new URLSearchParams(window.location.search);
  const isBench = params.has('bench');
  const isDev = params.has('dev');
  const isCaptureHero = params.has('captureHero');

  const heroEl = document.getElementById('title-hero-backdrop');
  if (isBench || isCaptureHero) {
    heroEl?.classList.add('is-instant-hidden');
  }
  if (isCaptureHero) {
    const uiRoot = document.getElementById('ui-root');
    if (uiRoot) uiRoot.style.display = 'none';
  }

  let titleRevealToken = 0;

  function hideHeroInstant() {
    titleRevealToken++;
    heroEl?.classList.add('is-instant-hidden');
    heroEl?.classList.remove('is-hidden');
    engine.cameraRig.setTitleDriftActive(false);
  }

  function scheduleLiveTitleReveal() {
    if (isBench || isCaptureHero || !heroEl) return;
    const token = ++titleRevealToken;
    engine.cameraRig.snapToTitleHero();
    heroEl.classList.remove('is-instant-hidden', 'is-hidden');

    // Wait past initial title paint, then wait until Telluride Box Canyon tiles are resident
    // before crossfading smoothly from the pre-rendered hero shot to the live 3D scene.
    setTimeout(async () => {
      if (token !== titleRevealToken || engine.getAppState() !== 'title') return;
      try {
        await terrain.ready;
        if (token !== titleRevealToken || engine.getAppState() !== 'title') return;
        await Promise.all([
          terrain.preload(0, 0, 900),
          trailData.loadArea(0, 0, 900),
        ]);
        if (token !== titleRevealToken || engine.getAppState() !== 'title') return;
        // Let a few frames upload/render decoded tiles so the live scene is crisp before reveal
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          if (token !== titleRevealToken || engine.getAppState() !== 'title') return;
        }
        heroEl.classList.remove('is-instant-hidden');
        heroEl.classList.add('is-hidden');
        engine.cameraRig.setTitleDriftActive(true);
      } catch {
        // Keep static hero visible if preload fails
      }
    }, 350);
  }

  engine.events.on('app:state', ({ state }) => {
    if (state === 'title') {
      scheduleLiveTitleReveal();
    } else {
      hideHeroInstant();
    }
  });

  if (isBench || isDev) {
    const perfApi = {
      getStats: () => ({
        ...engine.stats,
        tier: engine.quality.tier,
        auto: engine.quality.auto,
        renderScale: engine.quality.renderScale,
        appState: engine.getAppState(),
        camPos: {
          x: engine.camera.position.x,
          y: engine.camera.position.y,
          z: engine.camera.position.z,
        },
        playerPos: game.state
          ? { x: game.state.x, y: game.state.y, z: game.state.z }
          : null,
      }),
      setTier: (tier, lock = true) => engine.quality.setTier(tier, { auto: !lock }),
      teleport: teleportWorld,
      triggerContextLoss: () => {
        const gl = engine.renderer.getContext();
        const ext = gl?.getExtension('WEBGL_lose_context');
        if (!ext) return false;
        ext.loseContext();
        setTimeout(() => ext.restoreContext(), 400);
        return true;
      },
      setCameraFlythrough: (waypoints) => engine.cameraRig.setFlythrough(waypoints),
      startFreeRun: startFreeRunSafe,
    };

    const devApi = {
      teleport: teleportWorld,
      teleportLonLat: (lon, lat, heading = 0) => {
        const { x, z } = lonLatToWorld(lon, lat);
        teleportWorld(x, z, heading);
        return { x, z };
      },
      setTimeOfDay: (hourOrDate) => {
        if (hourOrDate instanceof Date) {
          const hour = hourOrDate.getHours() + hourOrDate.getMinutes() / 60;
          game.setTimeOfDay?.(hour);
          world.setTimeOfDay?.(hourOrDate);
        } else {
          const parsed = Number(hourOrDate);
          const hour = Number.isFinite(parsed) ? parsed : 12;
          game.setTimeOfDay?.(hour);
          world.setTimeOfDay?.(hour);
        }
      },
      triggerStormNow: (durSec) => game.triggerStormNow?.(durSec),
      setTimeScale: (mult) => {
        if (typeof game.setTimeScale === 'function') game.setTimeScale(mult);
        engine.events.emit('ui:timeDilation', { scale: mult });
      },
      skipToRaceDistance: (meters) => {
        if (typeof game.skipToRaceDistance === 'function') game.skipToRaceDistance(meters);
        else engine.events.emit('dev:skipRace', { meters });
      },
      advanceCheckpoint: () => {
        if (typeof game.advanceCheckpoint === 'function') game.advanceCheckpoint();
        else engine.events.emit('dev:advanceCheckpoint');
      },
      getGameState: () => ({ ...(game.state || {}) }),
    };

    window.__telluridePerf = perfApi;
    window.__tellurideDev = devApi;
    window.__TELLURIDE__ = {
      engine,
      terrain,
      trailData,
      world,
      game,
      audio,
      ui,
      ...perfApi,
      ...devApi,
    };
  }

  engine.start();

  if (isCaptureHero) {
    engine.cameraRig.snapToTitleHero();
    const hour = params.has('hour') ? Number(params.get('hour')) : 17.5;
    world.setTimeOfDay?.(Number.isFinite(hour) ? hour : 17.5);
    await terrain.ready;
    await Promise.all([
      terrain.preload(-1050, -60, 2200),
      terrain.preload(1500, 400, 2800),
      terrain.preload(4400, 1100, 2400),
      trailData.loadArea(0, 0, 2400),
    ]);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    window.__heroReady = true;
    return;
  }

  if (isBench) {
    const startPoi = trailData.pois[0] || { x: 0, z: 0, heading: 0 };
    const x = params.has('x') ? Number(params.get('x')) : startPoi.x;
    const z = params.has('z') ? Number(params.get('z')) : startPoi.z;
    const heading = params.has('heading') ? Number(params.get('heading')) : (startPoi.heading || 0);
    const parsedHour = params.has('hour') ? Number(params.get('hour')) : 8;
    const startHour = Number.isFinite(parsedHour) ? parsedHour : 8;
    await startFreeRunSafe({ x, z, heading, startTime: 'morning', startHour });
    if (params.get('autopilot') === '1') {
      engine.events.emit('ui:autopilot', { enabled: true });
    }
  } else {
    scheduleLiveTitleReveal();
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Telluride Trails:', err);
});
