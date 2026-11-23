import { createWorldTextures } from './textures.js';
import { createAtmosphere } from './atmosphere.js';
import { createVegetation } from './vegetation.js';
import { createRocks } from './rocks.js';
import { createWater } from './water.js';
import { createStructures } from './structures.js';

/**
 * Create the living San Juan world:
 * - Physically-based atmosphere, real Telluride July sun/moon/stars, clouds, height/aerial fog, headlamp, monsoon weather
 * - Streaming deterministic vegetation (Engelmann spruce, subalpine fir, aspen groves, krummholz, willows, tundra/columbines)
 * - Streaming rocks/talus/boulders & near-player ground clutter
 * - Rivers, streams, glacial turquoise lakes, animated waterfalls + mist
 * - Extruded OSM buildings, Telluride gondola & ski lifts, Bridal Veil power plant, historic mining ruins
 *
 * @param {ReturnType<import('../core/engine.js').createEngine>} engine
 * @param {ReturnType<import('../terrain/index.js').createTerrain>} terrain
 * @param {Awaited<ReturnType<import('../data/index.js').loadTrailData>>} trailData
 */
export function createWorld(engine, terrain, trailData) {
  const worldTextures = createWorldTextures(engine.quality.maxAnisotropy || 4);
  engine.worldTextures = worldTextures;

  const atmosphere = createAtmosphere(engine, terrain);
  // Create structures & water before vegetation/rocks so worldBuildingMask & worldWaterMask are registered immediately
  const structures = createStructures(engine, terrain, trailData, atmosphere);
  const water = createWater(engine, terrain, trailData, atmosphere);
  const vegetation = createVegetation(engine, terrain, trailData, atmosphere);
  const rocks = createRocks(engine, terrain, trailData, atmosphere);

  const unsubQuality = engine.events.on('quality:changed', (q) => {
    worldTextures.setAnisotropy(q?.maxAnisotropy ?? engine.quality.maxAnisotropy ?? 4);
  });
  const unsubContextRestored = engine.events.on('engine:contextrestored', () => {
    worldTextures.refresh();
  });

  function update(dt, playerPos) {
    atmosphere.update(dt, playerPos);
    structures.update(dt, playerPos);
    vegetation.update(dt, playerPos);
    rocks.update(dt, playerPos);
    water.update(dt, playerPos);
  }

  function setTimeOfDay(date) {
    atmosphere.setTimeOfDay(date);
  }

  function setWeather(opts) {
    atmosphere.setWeather(opts);
  }

  function triggerMonsoon(durationSec, intensity) {
    atmosphere.triggerMonsoon(durationSec, intensity);
  }

  function dispose() {
    unsubQuality();
    unsubContextRestored();
    water.dispose();
    rocks.dispose();
    vegetation.dispose();
    structures.dispose();
    atmosphere.dispose();
    worldTextures.dispose();
    if (engine.worldTextures === worldTextures) {
      delete engine.worldTextures;
    }
  }

  return {
    update,
    setTimeOfDay,
    setWeather,
    triggerMonsoon,
    uniforms: atmosphere.uniforms,
    dispose,
  };
}
