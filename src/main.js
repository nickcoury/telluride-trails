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

  // Start Title screen in crisp sunlit mid-July Telluride morning (9:00 AM MDT)
  // so first impression is never pitch-dark November dusk. Starting a run overrides this.
  world.setTimeOfDay?.(9.0);

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
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Telluride Trails:', err);
});
