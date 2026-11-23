import { getTierConfig } from './config.js';
import { createDetailAssets } from './detailAssets.js';
import { loadManifests } from './manifest.js';
import { createTerrainMaterialPool } from './material.js';
import { createTerrainQuadtree } from './quadtree.js';
import { createTileCache } from './tileCache.js';
import { createTrailMaskManager } from './trailMask.js';

/**
 * Streaming CDLOD terrain renderer for Telluride & the San Juan Mountains.
 * Implements the PLAN.md createTerrain(engine) contract.
 */
export function createTerrain(engine) {
  let disposed = false;
  let manifestsReady = false;
  let detailLoadStarted = false;
  let tierConfig = getTierConfig(engine.quality.tier);

  const manifests = {
    terrain: null,
    imagery: null,
    cover: null,
  };

  const detailAssets = createDetailAssets(engine);
  const tileCache = createTileCache({ engine, manifests, tierConfig });
  const trailMask = createTrailMaskManager({ engine, tierConfig });
  const materialPool = createTerrainMaterialPool({ engine, detailAssets });
  materialPool.setShaderMode(engine.quality.tier);

  const quadtree = createTerrainQuadtree({
    engine,
    tileCache,
    materialPool,
    trailMask,
    tierConfig,
  });

  const ready = loadManifests(engine.assetsBase)
    .then((loaded) => {
      if (disposed) return;
      manifests.terrain = loaded.terrain;
      manifests.imagery = loaded.imagery;
      manifests.cover = loaded.cover;
      manifestsReady = true;
      quadtree.refreshBounds(manifests);
    })
    .catch((err) => {
      console.warn('[terrain] manifest load error, using remote fallback:', err);
      manifestsReady = true;
    });

  function ensureDetailTexturesLoaded() {
    if (disposed) return Promise.resolve();
    detailLoadStarted = true;
    return detailAssets.loadTierTextures(engine.quality.tier);
  }

  let currentTier = engine.quality.tier;
  let currentAniso = engine.quality.maxAnisotropy || 4;

  // Strictly ignore renderScale-only quality:changed ticks (zero rebuilds / zero GPU re-uploads!)
  const offQuality = engine.events.on('quality:changed', (q) => {
    if (disposed) return;
    const nextTier = q?.tier ?? engine.quality.tier;
    const nextAniso = q?.maxAnisotropy ?? engine.quality.maxAnisotropy ?? 4;
    const tierChanged = nextTier !== currentTier;
    const anisoChanged = nextAniso !== currentAniso;

    if (!tierChanged && !anisoChanged) {
      return;
    }

    if (anisoChanged) {
      currentAniso = nextAniso;
      detailAssets.setAnisotropy(nextAniso);
    }

    if (tierChanged) {
      currentTier = nextTier;
      tierConfig = getTierConfig(nextTier);
      materialPool.setShaderMode(nextTier);
      quadtree.setTierConfig(tierConfig);
      if (detailLoadStarted) {
        detailAssets.loadTierTextures(nextTier);
      }
    } else if (anisoChanged) {
      tileCache.setTierConfig(tierConfig);
    }
  });

  // Defer PBR detail WebPs until leaving Title screen so Title cold payload stays < 1.5 MB!
  const offAppState = engine.events.on('app:state', ({ state }) => {
    if (state !== 'title') {
      ensureDetailTexturesLoaded();
    }
  });

  const offContextRestored = engine.events.on('engine:contextrestored', () => {
    detailAssets.getAlbedoArray().needsUpdate = true;
    detailAssets.getNormalRoughArray().needsUpdate = true;
    tileCache.onContextRestored();
    trailMask.onContextRestored();
  });

  function update(cameraPos) {
    if (disposed || !manifestsReady) return;
    // Run during 'loading' too so @ui's loading-curtain settle frames populate the spawn view!
    quadtree.update(cameraPos);
  }

  function getHeight(x, z) {
    return quadtree.getHeight(x, z);
  }

  function getRenderedHeight(x, z) {
    return quadtree.getRenderedHeight(x, z);
  }

  function getNormal(x, z) {
    return quadtree.getNormal(x, z);
  }

  function getSurface(x, z) {
    return quadtree.getSurface(x, z);
  }

  async function preload(x, z, radiusM = 1200) {
    await ready;
    if (disposed) return;
    const isTitle = engine.getAppState?.() === 'title';
    if (isTitle) {
      await quadtree.preload(x, z, radiusM);
    } else {
      // Await BOTH high-zoom raster tiles AND parallelized 512px detail PBR arrays before play starts!
      await Promise.all([quadtree.preload(x, z, radiusM), ensureDetailTexturesLoaded()]);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    offQuality();
    offAppState();
    offContextRestored();
    quadtree.dispose();
    materialPool.dispose();
    trailMask.dispose();
    tileCache.dispose();
    detailAssets.dispose();
  }

  return {
    update,
    getHeight,
    getRenderedHeight,
    getNormal,
    getSurface,
    preload,
    ready,
    getStats: () => quadtree.getStats(),
    dispose,
  };
}
