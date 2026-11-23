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

  const trailData = await loadTrailData(engine);
  const world = createWorld(engine, terrain, trailData);
  const game = createGame(engine, terrain, trailData, world);
  const audio = createAudio(engine, { game, world, trailData, terrain });
  const ui = createUI(engine, { trailData, game, terrain });

  performance.mark('tt:title-ready');

  // Wire UI state transitions if UI emits standard events without calling game directly
  engine.events.on('ui:resume', () => {
    game.resume?.();
  });
  engine.events.on('ui:pause', () => {
    game.pause?.();
  });
  engine.events.on('input:pause', () => {
    const s = engine.getAppState();
    if (s === 'playing') game.pause?.();
    else if (s === 'paused') game.resume?.();
  });

  engine.onUpdate((dt) => {
    game.update(dt);
    const pos = game.state
      ? { x: game.state.x, y: game.state.y, z: game.state.z }
      : engine.camera.position;
    terrain.update(pos);
    world.update(dt, pos);
  });

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
    const startHour = opts.startHour ?? 8;
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
        let date;
        let hour;
        if (hourOrDate instanceof Date) {
          date = hourOrDate;
          hour = date.getHours() + date.getMinutes() / 60;
        } else {
          hour = Number(hourOrDate) || 12;
          date = new Date();
          date.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
        }
        game.setTimeOfDay?.(hour);
        world.setTimeOfDay?.(date);
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
    const startHour = params.has('hour') ? Number(params.get('hour')) : 8;
    await startFreeRunSafe({ x, z, heading, startTime: 'morning', startHour });
    if (params.get('autopilot') === '1') {
      engine.events.emit('ui:autopilot', { enabled: true });
    }
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Telluride Trails:', err);
});
