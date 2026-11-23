import { createEngine } from './core/engine.js';
import { createTerrain } from './terrain/index.js';
import { loadTrailData } from './data/index.js';
import { createWorld } from './world/index.js';
import { createGame } from './game/index.js';
import { createUI } from './ui/index.js';

async function bootstrap() {
  const canvas = document.getElementById('game-canvas');
  const engine = createEngine({ canvas });

  const terrain = createTerrain(engine);
  engine.cameraRig.setTerrain(terrain);

  const trailData = await loadTrailData(engine);
  const world = createWorld(engine, terrain, trailData);
  const game = createGame(engine, terrain, trailData, world);
  const ui = createUI(engine, { trailData, game });

  engine.onUpdate((dt) => {
    game.update(dt);
    const pos = game.state ? { x: game.state.x, y: game.state.y, z: game.state.z } : engine.camera.position;
    terrain.update(pos);
    world.update(dt, pos);
  });

  // Expose lightweight diagnostic handle for ?bench / ?dev verification
  const params = new URLSearchParams(window.location.search);
  if (params.has('bench') || params.has('dev')) {
    window.__TELLURIDE__ = {
      engine,
      terrain,
      trailData,
      world,
      game,
      ui,
      getStats: () => ({
        ...engine.stats,
        tier: engine.quality.tier,
        renderScale: engine.quality.renderScale,
        appState: engine.getAppState(),
      }),
    };
  }

  engine.start();

  if (params.has('bench')) {
    const startPoi = trailData.pois[0] || { x: 0, z: 0, heading: 0 };
    await terrain.preload(startPoi.x, startPoi.z, 1000);
    game.startFreeRun({ x: startPoi.x, z: startPoi.z, heading: startPoi.heading || 0 });
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Telluride Trails:', err);
});
