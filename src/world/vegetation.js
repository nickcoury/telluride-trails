import * as THREE from 'three';
import { tileBoundsWorld } from '../core/geo.js';
import { hash2i, mulberry32 } from './noise.js';
import { createFloraTextures, GROUND_FLORA_RECTS } from './flora/floraTextures.js';
import {
  buildConiferModel,
  buildAspenModel,
  buildWillowModel,
  buildKrummholzModel,
  buildDeadfallLogGeometry,
  buildStumpGeometry,
  buildGroundFloraClumpGeometry,
} from './flora/treeModels.js';
import { createImpostorAtlas } from './flora/impostorBaker.js';
import {
  createBarkMaterial,
  createFoliageMaterial,
  createFoliageDepthMaterial,
  createImpostorMaterial,
  createGroundFloraMaterial,
} from './flora/floraMaterials.js';
import { getOrCreateFloraMasks } from './flora/spatialMasks.js';
import { pickSanJuanTree, pickGroundFlora } from './flora/biomePlacement.js';

const CANOPY_CELL_M = 240;
const NEAR_CELL_M = 80;
const GRASS_CELL_M = 32;

const TIER_CFG = {
  low: {
    nearRadius: 0,
    farRadius: 1850,
    grassRadius: 0,
    canopyGrid: 9,
    nearGrid: 0,
    grassGrid: 0,
    maxSpruce: 0,
    maxFir: 0,
    maxAspen: 0,
    maxWillow: 0,
    maxKrummholz: 0,
    maxDeadfall: 0,
    maxImp: 6600,
    maxGrass: 0,
  },
  medium: {
    nearRadius: 105,
    farRadius: 2700,
    grassRadius: 42,
    canopyGrid: 12,
    nearGrid: 6,
    grassGrid: 14,
    maxSpruce: 400,
    maxFir: 260,
    maxAspen: 350,
    maxWillow: 220,
    maxKrummholz: 160,
    maxDeadfall: 80,
    maxImp: 11500,
    maxGrass: 5200,
  },
  high: {
    nearRadius: 155,
    farRadius: 3850,
    grassRadius: 64,
    canopyGrid: 14,
    nearGrid: 9,
    grassGrid: 22,
    maxSpruce: 1100,
    maxFir: 750,
    maxAspen: 900,
    maxWillow: 500,
    maxKrummholz: 360,
    maxDeadfall: 180,
    maxImp: 20000,
    maxGrass: 14000,
  },
  ultra: {
    nearRadius: 225,
    farRadius: 4900,
    grassRadius: 88,
    canopyGrid: 16,
    nearGrid: 10,
    grassGrid: 26,
    maxSpruce: 1900,
    maxFir: 1250,
    maxAspen: 1500,
    maxWillow: 800,
    maxKrummholz: 520,
    maxDeadfall: 280,
    maxImp: 28000,
    maxGrass: 24000,
  },
};

function writeYRotScaleMatrix(arr, idx, x, y, z, w, h, rot) {
  const o = idx * 16;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  arr[o] = c * w;
  arr[o + 1] = 0;
  arr[o + 2] = -s * w;
  arr[o + 3] = 0;
  arr[o + 4] = 0;
  arr[o + 5] = h;
  arr[o + 6] = 0;
  arr[o + 7] = 0;
  arr[o + 8] = s * w;
  arr[o + 9] = 0;
  arr[o + 10] = c * w;
  arr[o + 11] = 0;
  arr[o + 12] = x;
  arr[o + 13] = y;
  arr[o + 14] = z;
  arr[o + 15] = 1;
}

function writeTranslationMatrix(arr, idx, x, y, z) {
  const o = idx * 16;
  arr[o] = 1; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = 1; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = 1; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

function writeColor(arr, idx, r, g, b) {
  const o = idx * 3;
  arr[o] = r;
  arr[o + 1] = g;
  arr[o + 2] = b;
}

/**
 * Create the complete San Juan vegetation & ground-flora system:
 * - Sculpted 3D Engelmann Spruce, Subalpine Fir, white-barked Quaking Aspen,
 *   Riparian Willow thickets, Treeline Krummholz, and forest-floor deadfall/stumps
 * - Runtime GPU-baked hemi-octahedral impostors (1 draw call for up to 26k far trees)
 *   with matched dynamic sun/sky lighting and complementary Bayer 4x4 dither cross-fade LOD
 * - Lush meadow grass, wildflower drifts (columbine, paintbrush, lupine, arnica),
 *   alpine tundra cushions, and woodland fern/whortleberry undergrowth
 * - Deterministic stratified placement driven by NLCD/NAIP cover, elevation, slope, aspect,
 *   waterways, ski runs, trails, buildings, and exact lake polygon exclusion
 * - Strict engine.scheduler time-slicing (< 2.2 ms slices) and renderScale-immune quality handling
 */
export function createVegetation(engine, terrain, trailData, atmosphere) {
  const { scene, renderer, events, scheduler } = engine;
  let disposed = false;

  const floraTextures = createFloraTextures(engine.quality.maxAnisotropy || 4);
  engine.floraTextures = floraTextures;

  const masks = getOrCreateFloraMasks(engine, trailData);

  // Build sculpted 3D species geometries once
  const spruceModel = buildConiferModel(false);
  const firModel = buildConiferModel(true);
  const aspenModel = buildAspenModel();
  const willowModel = buildWillowModel();
  const krummholzModel = buildKrummholzModel();
  const deadfallGeo = buildDeadfallLogGeometry();
  const stumpGeo = buildStumpGeometry();
  const grassClumpGeo = buildGroundFloraClumpGeometry();
  const impQuadGeo = new THREE.PlaneGeometry(1, 1);

  // Runtime GPU-baked 4x4 hemi-octahedral impostors matching the exact 3D models
  // (512x512 on low saves ~14 MB VRAM; 1024x1024 on medium/high/ultra)
  const impostorAtlas = createImpostorAtlas(
    renderer,
    [
      { trunkGeo: spruceModel.trunkGeo, foliageGeo: spruceModel.foliageGeo, bgHex: 0x345b34 },
      { trunkGeo: firModel.trunkGeo, foliageGeo: firModel.foliageGeo, bgHex: 0x2c523c },
      { trunkGeo: aspenModel.trunkGeo, foliageGeo: aspenModel.foliageGeo, bgHex: 0x6b8b3e },
      { trunkGeo: willowModel.trunkGeo, foliageGeo: willowModel.foliageGeo, bgHex: 0x4b703a },
    ],
    floraTextures,
    engine.quality.tier === 'low' ? 512 : 1024
  );

  // Dynamic LOD uniforms shared across 3D tree materials & octahedral impostors
  let cfg = TIER_CFG[engine.quality.tier] || TIER_CFG.medium;
  const lodUniforms = {
    uLodStart: { value: cfg.nearRadius > 0 ? Math.max(0, cfg.nearRadius - 32) : 0 },
    uLodEnd: { value: cfg.nearRadius },
    uFarStart: { value: Math.max(400, cfg.farRadius - 360) },
    uFarEnd: { value: cfg.farRadius },
  };
  const grassLodUniforms = {
    uGrassFadeStart: { value: Math.max(12, cfg.grassRadius - 22) },
    uGrassFadeEnd: { value: Math.max(18, cfg.grassRadius) },
  };

  const hasMsaa = Boolean(renderer.getContext?.()?.getContextAttributes?.()?.antialias);

  // Materials (spherical bent normals, no backface blackouts, dithered LOD, GPU wind + quaking aspen)
  const barkMat = createBarkMaterial(floraTextures, atmosphere.uniforms, lodUniforms, {
    windStrength: 0.022,
    useLodFade: true,
  });
  const deadfallMat = createBarkMaterial(floraTextures, atmosphere.uniforms, lodUniforms, {
    windStrength: 0.0,
    useLodFade: true,
  });
  const coniferFolMat = createFoliageMaterial(floraTextures, atmosphere.uniforms, lodUniforms, {
    windStrength: 0.022,
    flutter: 0.008,
    translucency: 0.55,
    alphaToCoverage: hasMsaa,
  });
  const aspenFolMat = createFoliageMaterial(floraTextures, atmosphere.uniforms, lodUniforms, {
    windStrength: 0.026,
    flutter: 0.017, // unmistakable quaking aspen shimmer!
    translucency: 0.85,
    alphaToCoverage: hasMsaa,
  });
  const shrubFolMat = createFoliageMaterial(floraTextures, atmosphere.uniforms, lodUniforms, {
    windStrength: 0.016,
    flutter: 0.012,
    translucency: 0.72,
    alphaToCoverage: hasMsaa,
  });
  const foliageDepthMat = createFoliageDepthMaterial(floraTextures, atmosphere.uniforms, {
    windStrength: 0.022,
  });
  const impostorMat = createImpostorMaterial(impostorAtlas, atmosphere.uniforms, lodUniforms);
  const grassMat = createGroundFloraMaterial(floraTextures, atmosphere.uniforms, grassLodUniforms);

  // Root group for clean scene hierarchy & inspection
  const root = new THREE.Group();
  root.name = 'SanJuanFlora';
  scene.add(root);

  function makeInstancedPool(name, geo, mat, capacity, castShadow, receiveShadow, customDepthMat, extraAttr) {
    if (capacity <= 0) return null;
    const g = geo.clone();
    if (extraAttr) {
      g.setAttribute(
        extraAttr.name,
        new THREE.InstancedBufferAttribute(new Float32Array(capacity * extraAttr.size), extraAttr.size)
      );
    }
    const mesh = new THREE.InstancedMesh(g, mat, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    if (customDepthMat) mesh.customDepthMaterial = customDepthMat;

    const colArr = new Float32Array(capacity * 3);
    colArr.fill(1.0);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colArr, 3);
    root.add(mesh);
    return mesh;
  }

  const pools = {
    spruceTrunk: null,
    spruceFol: null,
    firTrunk: null,
    firFol: null,
    aspenTrunk: null,
    aspenFol: null,
    willowTrunk: null,
    willowFol: null,
    krummTrunk: null,
    krummFol: null,
    deadfall: null,
    stump: null,
    impostor: null,
    grass: null,
  };

  function disposePools() {
    for (const k of Object.keys(pools)) {
      const m = pools[k];
      if (m) {
        root.remove(m);
        m.geometry.dispose();
        m.dispose();
        pools[k] = null;
      }
    }
  }

  function rebuildPools() {
    disposePools();
    cfg = TIER_CFG[engine.quality.tier] || TIER_CFG.medium;
    const allowShadow = Boolean(engine.quality.shadows);
    const allowFolShadow = allowShadow && (engine.quality.tier === 'high' || engine.quality.tier === 'ultra');

    lodUniforms.uLodStart.value = cfg.nearRadius > 0 ? Math.max(0, cfg.nearRadius - 32) : 0;
    lodUniforms.uLodEnd.value = cfg.nearRadius;
    lodUniforms.uFarStart.value = Math.max(400, cfg.farRadius - 360);
    lodUniforms.uFarEnd.value = cfg.farRadius;
    grassLodUniforms.uGrassFadeStart.value = Math.max(12, cfg.grassRadius - 22);
    grassLodUniforms.uGrassFadeEnd.value = Math.max(18, cfg.grassRadius);

    pools.spruceTrunk = makeInstancedPool('SpruceTrunks', spruceModel.trunkGeo, barkMat, cfg.maxSpruce, allowShadow, true, null, null);
    pools.spruceFol = makeInstancedPool('SpruceFoliage', spruceModel.foliageGeo, coniferFolMat, cfg.maxSpruce, allowFolShadow, true, foliageDepthMat, null);

    pools.firTrunk = makeInstancedPool('FirTrunks', firModel.trunkGeo, barkMat, cfg.maxFir, allowShadow, true, null, null);
    pools.firFol = makeInstancedPool('FirFoliage', firModel.foliageGeo, coniferFolMat, cfg.maxFir, allowFolShadow, true, foliageDepthMat, null);

    pools.aspenTrunk = makeInstancedPool('AspenTrunks', aspenModel.trunkGeo, barkMat, cfg.maxAspen, allowShadow, true, null, null);
    pools.aspenFol = makeInstancedPool('AspenFoliage', aspenModel.foliageGeo, aspenFolMat, cfg.maxAspen, allowFolShadow, true, foliageDepthMat, null);

    pools.willowTrunk = makeInstancedPool('WillowStems', willowModel.trunkGeo, barkMat, cfg.maxWillow, false, true, null, null);
    pools.willowFol = makeInstancedPool('WillowFoliage', willowModel.foliageGeo, shrubFolMat, cfg.maxWillow, false, true, null, null);

    pools.krummTrunk = makeInstancedPool('KrummholzTrunks', krummholzModel.trunkGeo, barkMat, cfg.maxKrummholz, false, true, null, null);
    pools.krummFol = makeInstancedPool('KrummholzFoliage', krummholzModel.foliageGeo, coniferFolMat, cfg.maxKrummholz, false, true, null, null);

    pools.deadfall = makeInstancedPool('DeadfallLogs', deadfallGeo, deadfallMat, cfg.maxDeadfall, false, true, null, null);
    pools.stump = makeInstancedPool('ForestStumps', stumpGeo, deadfallMat, Math.ceil(cfg.maxDeadfall * 0.65), false, true, null, null);

    pools.impostor = makeInstancedPool('TreeImpostors', impQuadGeo, impostorMat, cfg.maxImp, false, false, null, { name: 'aImpData', size: 4 });
    pools.grass = engine.quality.grass && cfg.maxGrass > 0
      ? makeInstancedPool('GroundFlora', grassClumpGeo, grassMat, cfg.maxGrass, false, true, null, { name: 'aAtlasRect', size: 4 })
      : null;
  }

  rebuildPools();

  // ==========================================================================
  // Chunk Caches & Incremental Scheduler-Driven Builder
  // ==========================================================================

  const canopyChunks = new Map();
  const nearChunks = new Map();
  const grassChunks = new Map();

  let lastTier = engine.quality.tier;
  let lastShadows = Boolean(engine.quality.shadows);
  let lastGrass = Boolean(engine.quality.grass);
  let lastAniso = engine.quality.maxAnisotropy || 4;

  let treesDirty = true;
  let impDirty = true;
  let impNearDirty = true;
  let grassDirty = true;
  let lastPackX = 1e9;
  let lastPackZ = 1e9;
  let lastAnchorX = 1e9;
  let lastAnchorZ = 1e9;
  let needRescan = true;
  let lastRescanMs = -1000;
  let resnapCursor = 0;

  // Dual-priority queues: near flora + inner canopy build immediately (priority 10);
  // distant horizon impostors stream smoothly in background (priority 18) without starving rocks!
  const pendingNear = [];
  const pendingGrass = [];
  const pendingCanopyNear = [];
  const pendingCanopyFar = [];
  const queuedNearKeys = new Set();
  const queuedGrassKeys = new Set();
  const queuedCanopyKeys = new Set();
  let cancelNearTask = null;
  let cancelFarTask = null;

  function checkTrailClearance(x, z, kindMode) {
    // kindMode: 'tree' | 'deadfall' | 'grass'
    const maxQuery = kindMode === 'tree' ? 14.0 : kindMode === 'deadfall' ? 11.0 : 8.0;
    const near = trailData?.nearest?.(x, z, maxQuery);
    if (!near) return false;

    if (kindMode === 'tree') {
      // Mountain dirt roads (like See Forever Rd) clear 8.5m; singletrack clears 2.3m so spruce/aspen frame trail!
      const minClear = near.kind === 'road' ? 8.5 : near.kind === 'track' ? 4.8 : 2.3;
      return near.dist < minClear;
    }
    if (kindMode === 'deadfall') {
      const minClear = near.kind === 'road' ? 9.5 : near.kind === 'track' ? 4.5 : 1.7;
      return near.dist < minClear;
    }
    // grass / wildflowers hug right up to the singletrack edge (0.95m)!
    const minClear = near.kind === 'road' ? 5.5 : near.kind === 'track' ? 2.5 : 0.95;
    return near.dist < minClear;
  }

  function hasCoverAt(surf) {
    return surf.forest + surf.rock + surf.water + surf.snow + surf.grass > 0.05;
  }

  /**
   * Build one primary regional canopy chunk (240x240m, stratified grid).
   * Trees here render as 3D meshes inside nearRadius and crossfade 1:1 to hemi-octahedral impostors outside.
   */
  function buildCanopyChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 101));
    const g = cfg.canopyGrid;
    const step = CANOPY_CELL_M / g;
    const x0 = cx * CANOPY_CELL_M;
    const z0 = cz * CANOPY_CELL_M;
    const items = [];

    for (let gz = 0; gz < g; gz++) {
      for (let gx = 0; gx < g; gx++) {
        const x = x0 + (gx + 0.12 + rng() * 0.76) * step;
        const z = z0 + (gz + 0.12 + rng() * 0.76) * step;

        if (masks.isExcludedTownOrBuilding(x, z, 11.0)) continue;
        if (masks.isInLake(x, z, 2.5)) continue;
        if (checkTrailClearance(x, z, 'tree')) continue;

        const ww = masks.queryWaterway(x, z, 14.0);
        if (ww.found && ww.dist < ww.halfW + 0.75) continue;

        const y = terrain.getHeight(x, z);
        if (y > 3715) continue;
        const norm = terrain.getNormal(x, z);
        const surf = terrain.getSurface(x, z);
        if (surf.water > 0.16) continue;

        const onSki = masks.isOnSkiRun(x, z);
        const spec = pickSanJuanTree(x, z, y, norm, surf, ww, onSki, rng, false);
        if (!spec) continue;

        items.push({
          x,
          y: y - 0.18,
          z,
          rot: spec.rot,
          kind: spec.kind,
          h: spec.h,
          w: spec.w,
          r: spec.r,
          g: spec.g,
          b: spec.b,
        });
      }
    }

    const midX = x0 + CANOPY_CELL_M * 0.5;
    const midZ = z0 + CANOPY_CELL_M * 0.5;
    const midSurf = terrain.getSurface(midX, midZ);
    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(midX, midZ),
      hadCover: hasCoverAt(midSurf),
      items,
    };
  }

  /**
   * Build one high-density near-forest fill chunk (80x80m):
   * - Dense secondary spruce/fir/saplings & intimate clonal aspen grove stems
   * - Riparian willow thickets hugging Bear Creek / San Miguel River
   * - Forest floor deadfall logs & weathered stumps near trails
   */
  function buildNearChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 409));
    const g = cfg.nearGrid;
    const items = [];
    const logs = [];
    const stumps = [];
    const x0 = cx * NEAR_CELL_M;
    const z0 = cz * NEAR_CELL_M;

    if (g > 0) {
      const step = NEAR_CELL_M / g;
      for (let gz = 0; gz < g; gz++) {
        for (let gx = 0; gx < g; gx++) {
          const x = x0 + (gx + 0.14 + rng() * 0.72) * step;
          const z = z0 + (gz + 0.14 + rng() * 0.72) * step;

          if (masks.isExcludedTownOrBuilding(x, z, 10.5)) continue;
          if (masks.isInLake(x, z, 2.5)) continue;
          if (checkTrailClearance(x, z, 'tree')) continue;

          const ww = masks.queryWaterway(x, z, 14.0);
          if (ww.found && ww.dist < ww.halfW + 0.75) continue;

          const y = terrain.getHeight(x, z);
          if (y > 3715) continue;
          const norm = terrain.getNormal(x, z);
          const surf = terrain.getSurface(x, z);
          if (surf.water > 0.16) continue;

          const onSki = masks.isOnSkiRun(x, z);
          const spec = pickSanJuanTree(x, z, y, norm, surf, ww, onSki, rng, true);
          if (!spec) continue;

          items.push({
            x,
            y: y - 0.16,
            z,
            rot: spec.rot,
            kind: spec.kind,
            h: spec.h,
            w: spec.w,
            r: spec.r,
            g: spec.g,
            b: spec.b,
          });

          // Intimate clonal Aspen companion stem (real Telluride aspens grow in twin/cluster stems!)
          if (spec.kind === 2 && rng() < 0.42) {
            const ang = rng() * Math.PI * 2;
            const d = 1.9 + rng() * 2.4;
            const sx = x + Math.cos(ang) * d;
            const sz = z + Math.sin(ang) * d;
            if (
              !checkTrailClearance(sx, sz, 'tree') &&
              !masks.isExcludedTownOrBuilding(sx, sz, 10.5) &&
              !masks.isInLake(sx, sz, 2.5) &&
              !masks.isInWater(sx, sz, 0.75) &&
              !masks.isOnSkiRun(sx, sz)
            ) {
              const sy = terrain.getHeight(sx, sz);
              const sh = spec.h * (0.62 + rng() * 0.30);
              items.push({
                x: sx,
                y: sy - 0.14,
                z: sz,
                rot: rng() * Math.PI * 2,
                kind: 2,
                h: sh,
                w: sh * (0.72 + rng() * 0.20),
                r: spec.r * (0.94 + rng() * 0.10),
                g: spec.g * (0.96 + rng() * 0.08),
                b: spec.b * (0.94 + rng() * 0.10),
              });
            }
          }
        }
      }

      // Forest floor deadfall logs & weathered stumps (only in forested subalpine cells!)
      if (cfg.maxDeadfall > 0) {
        const logCandidates = 6;
        for (let i = 0; i < logCandidates; i++) {
          const lx = x0 + rng() * NEAR_CELL_M;
          const lz = z0 + rng() * NEAR_CELL_M;
          if (masks.isExcludedTownOrBuilding(lx, lz, 12.0)) continue;
          if (masks.isInLake(lx, lz, 3.0)) continue;
          if (masks.isInWater(lx, lz, 0.75) || masks.isOnSkiRun(lx, lz)) continue;
          if (checkTrailClearance(lx, lz, 'deadfall')) continue;

          const ly = terrain.getHeight(lx, lz);
          if (ly > 3460) continue;
          const ln = terrain.getNormal(lx, lz);
          if (ln.y < 0.72) continue;
          const ls = terrain.getSurface(lx, lz);
          if (ls.water > 0.12 || ls.forest < 0.24) continue;

          if (rng() < 0.55) {
            const sc = 0.75 + rng() * 0.75;
            const shade = 0.78 + rng() * 0.30;
            logs.push({ x: lx, y: ly - 0.06, z: lz, rot: rng() * Math.PI * 2, w: sc, h: sc, r: shade, g: shade * 1.02, b: shade * 0.96 });
          } else {
            const sc = 0.75 + rng() * 0.65;
            const shade = 0.76 + rng() * 0.28;
            stumps.push({ x: lx, y: ly - 0.04, z: lz, rot: rng() * Math.PI * 2, w: sc, h: sc, r: shade, g: shade * 0.98, b: shade * 0.92 });
          }
        }
      }
    }

    const midX = x0 + NEAR_CELL_M * 0.5;
    const midZ = z0 + NEAR_CELL_M * 0.5;
    const midSurf = terrain.getSurface(midX, midZ);
    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(midX, midZ),
      hadCover: hasCoverAt(midSurf),
      items,
      logs,
      stumps,
    };
  }

  /**
   * Build one lush ground-flora carpet chunk (32x32m):
   * meadow fescue, golden sedge, columbine/paintbrush/lupine/arnica drifts,
   * alpine tundra cushions, and forest-floor ferns/whortleberry.
   */
  function buildGrassChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 733));
    const g = cfg.grassGrid;
    const items = [];
    const x0 = cx * GRASS_CELL_M;
    const z0 = cz * GRASS_CELL_M;

    if (g > 0) {
      const step = GRASS_CELL_M / g;
      for (let gz = 0; gz < g; gz++) {
        for (let gx = 0; gx < g; gx++) {
          const x = x0 + (gx + 0.08 + rng() * 0.84) * step;
          const z = z0 + (gz + 0.08 + rng() * 0.84) * step;

          if (masks.isExcludedTownOrBuilding(x, z, 9.5)) continue;
          // STRICT lake & creek exclusion: NEVER sprout grass inside Ice Lake or streams!
          if (masks.isInLake(x, z, 2.2)) continue;
          if (checkTrailClearance(x, z, 'grass')) continue;

          const ww = masks.queryWaterway(x, z, 12.0);
          if (ww.found && ww.dist < ww.halfW + 0.75) continue;

          const y = terrain.getHeight(x, z);
          if (y > 4160) continue;
          const norm = terrain.getNormal(x, z);
          const surf = terrain.getSurface(x, z);
          if (surf.water > 0.10) continue;

          const spec = pickGroundFlora(x, z, y, norm, surf, ww, rng);
          if (!spec) continue;

          items.push({
            x,
            y: y - 0.03,
            z,
            rot: spec.rot,
            kind: spec.kind,
            w: spec.w,
            h: spec.h,
            r: spec.r,
            g: spec.g,
            b: spec.b,
          });
        }
      }
    }

    const midX = x0 + GRASS_CELL_M * 0.5;
    const midZ = z0 + GRASS_CELL_M * 0.5;
    const midSurf = terrain.getSurface(midX, midZ);
    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(midX, midZ),
      hadCover: hasCoverAt(midSurf),
      items,
    };
  }

  // ==========================================================================
  // Fast Zero-GC Instanced Buffer Packing
  // ==========================================================================

  function push3DTree(t, counts) {
    if (t.kind === 0 && pools.spruceTrunk && counts.sp < pools.spruceTrunk.instanceMatrix.count) {
      const idx = counts.sp++;
      writeYRotScaleMatrix(pools.spruceTrunk.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.spruceTrunk.instanceColor.array, idx, 1.0, 1.0, 1.0);
      writeYRotScaleMatrix(pools.spruceFol.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.spruceFol.instanceColor.array, idx, t.r, t.g, t.b);
      return;
    }
    if (t.kind === 1 && pools.firTrunk && counts.fi < pools.firTrunk.instanceMatrix.count) {
      const idx = counts.fi++;
      writeYRotScaleMatrix(pools.firTrunk.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.firTrunk.instanceColor.array, idx, 1.0, 1.0, 1.0);
      writeYRotScaleMatrix(pools.firFol.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.firFol.instanceColor.array, idx, t.r, t.g, t.b);
      return;
    }
    if (t.kind === 2 && pools.aspenTrunk && counts.as < pools.aspenTrunk.instanceMatrix.count) {
      const idx = counts.as++;
      writeYRotScaleMatrix(pools.aspenTrunk.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.aspenTrunk.instanceColor.array, idx, 1.0, 1.0, 1.0);
      writeYRotScaleMatrix(pools.aspenFol.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.aspenFol.instanceColor.array, idx, t.r, t.g, t.b);
      return;
    }
    if (t.kind === 3 && pools.willowTrunk && counts.wi < pools.willowTrunk.instanceMatrix.count) {
      const idx = counts.wi++;
      writeYRotScaleMatrix(pools.willowTrunk.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.willowTrunk.instanceColor.array, idx, 1.0, 1.0, 1.0);
      writeYRotScaleMatrix(pools.willowFol.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.willowFol.instanceColor.array, idx, t.r, t.g, t.b);
      return;
    }
    if (t.kind === 4 && pools.krummTrunk && counts.kr < pools.krummTrunk.instanceMatrix.count) {
      const idx = counts.kr++;
      writeYRotScaleMatrix(pools.krummTrunk.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.krummTrunk.instanceColor.array, idx, 1.0, 1.0, 1.0);
      writeYRotScaleMatrix(pools.krummFol.instanceMatrix.array, idx, t.x, t.y, t.z, t.w, t.h, t.rot);
      writeColor(pools.krummFol.instanceColor.array, idx, t.r, t.g, t.b);
    }
  }

  function finalizePool(mesh, count, extraAttrName) {
    if (!mesh) return;
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      if (extraAttrName) mesh.geometry.attributes[extraAttrName].needsUpdate = true;
    }
  }

  function packPools(px, pz, doTrees, doImp, doGrass) {
    const counts = { sp: 0, fi: 0, as: 0, wi: 0, kr: 0, log: 0, st: 0, imp: 0, gr: 0 };

    const nearR = cfg.nearRadius;
    const nearOuterR2 = nearR > 0 ? (nearR + 4) * (nearR + 4) : 0;
    // Overlap band [nearRadius - 34, nearRadius + 4] ensures seamless complementary Bayer crossfade!
    const impInnerR = nearR > 0 ? Math.max(0, nearR - 36) : 0;
    const impInnerR2 = impInnerR * impInnerR;
    const farR2 = cfg.farRadius * cfg.farRadius;

    // 1. Pack 3D Near-Forest Fill + Inner Canopy 3D Trees (ONLY when treesDirty or player moved!)
    if (doTrees) {
      if (nearR > 0) {
        const nRing = Math.ceil((nearR + 8) / NEAR_CELL_M);
        const ncx = Math.floor(px / NEAR_CELL_M);
        const ncz = Math.floor(pz / NEAR_CELL_M);
        const logCap = pools.deadfall ? pools.deadfall.instanceMatrix.count : 0;
        const stCap = pools.stump ? pools.stump.instanceMatrix.count : 0;
        const deadR2 = Math.min(nearOuterR2, 120 * 120);

        for (let r = 0; r <= nRing; r++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
              const ch = nearChunks.get(`${ncx + dx},${ncz + dz}`);
              if (!ch) continue;

              const items = ch.items;
              for (let i = 0; i < items.length; i++) {
                const t = items[i];
                const ddx = t.x - px;
                const ddz = t.z - pz;
                if (ddx * ddx + ddz * ddz <= nearOuterR2) {
                  push3DTree(t, counts);
                }
              }

              if (pools.deadfall && ch.logs.length > 0) {
                for (let i = 0; i < ch.logs.length && counts.log < logCap; i++) {
                  const l = ch.logs[i];
                  const ddx = l.x - px;
                  const ddz = l.z - pz;
                  if (ddx * ddx + ddz * ddz > deadR2) continue;
                  const idx = counts.log++;
                  writeYRotScaleMatrix(pools.deadfall.instanceMatrix.array, idx, l.x, l.y, l.z, l.w, l.h, l.rot);
                  writeColor(pools.deadfall.instanceColor.array, idx, l.r, l.g, l.b);
                }
              }
              if (pools.stump && ch.stumps.length > 0) {
                for (let i = 0; i < ch.stumps.length && counts.st < stCap; i++) {
                  const s = ch.stumps[i];
                  const ddx = s.x - px;
                  const ddz = s.z - pz;
                  if (ddx * ddx + ddz * ddz > deadR2) continue;
                  const idx = counts.st++;
                  writeYRotScaleMatrix(pools.stump.instanceMatrix.array, idx, s.x, s.y, s.z, s.w, s.h, s.rot);
                  writeColor(pools.stump.instanceColor.array, idx, s.r, s.g, s.b);
                }
              }
            }
          }
        }

        // Also include regional canopy trees inside nearRadius
        const nearCRing = Math.ceil((nearR + CANOPY_CELL_M) / CANOPY_CELL_M);
        const pcx = Math.floor(px / CANOPY_CELL_M);
        const pcz = Math.floor(pz / CANOPY_CELL_M);
        for (let r = 0; r <= nearCRing; r++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
              const ch = canopyChunks.get(`${pcx + dx},${pcz + dz}`);
              if (!ch) continue;
              const items = ch.items;
              for (let i = 0; i < items.length; i++) {
                const t = items[i];
                const ddx = t.x - px;
                const ddz = t.z - pz;
                if (ddx * ddx + ddz * ddz <= nearOuterR2) {
                  push3DTree(t, counts);
                }
              }
            }
          }
        }
      }

      finalizePool(pools.spruceTrunk, counts.sp);
      finalizePool(pools.spruceFol, counts.sp);
      finalizePool(pools.firTrunk, counts.fi);
      finalizePool(pools.firFol, counts.fi);
      finalizePool(pools.aspenTrunk, counts.as);
      finalizePool(pools.aspenFol, counts.as);
      finalizePool(pools.willowTrunk, counts.wi);
      finalizePool(pools.willowFol, counts.wi);
      finalizePool(pools.krummTrunk, counts.kr);
      finalizePool(pools.krummFol, counts.kr);
      finalizePool(pools.deadfall, counts.log);
      finalizePool(pools.stump, counts.st);
    }

    // 2. Pack Regional Hemi-Octahedral Impostors (ONLY when impDirty or player moved!)
    if (doImp && pools.impostor) {
      const cRing = Math.ceil(cfg.farRadius / CANOPY_CELL_M);
      const pcx = Math.floor(px / CANOPY_CELL_M);
      const pcz = Math.floor(pz / CANOPY_CELL_M);
      const impMesh = pools.impostor;
      const impCap = impMesh.instanceMatrix.count;
      const impMatArr = impMesh.instanceMatrix.array;
      const impColArr = impMesh.instanceColor.array;
      const impDataArr = impMesh.geometry.attributes.aImpData.array;

      impPack: for (let r = 0; r <= cRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const ch = canopyChunks.get(`${pcx + dx},${pcz + dz}`);
            if (!ch) continue;

            const items = ch.items;
            for (let i = 0; i < items.length; i++) {
              if (counts.imp >= impCap) break impPack;
              const t = items[i];
              const ddx = t.x - px;
              const ddz = t.z - pz;
              const d2 = ddx * ddx + ddz * ddz;
              if (d2 > farR2 || d2 < impInnerR2) continue;

              const idx = counts.imp++;
              writeTranslationMatrix(impMatArr, idx, t.x, t.y, t.z);
              writeColor(impColArr, idx, t.r, t.g, t.b);
              // Map kind 4 (Krummholz) to squashed Spruce (0) for far treeline silhouette
              const spIdx = t.kind === 4 ? 0 : t.kind;
              const iw = t.kind === 4 ? t.w * 1.15 : t.w;
              const ih = t.kind === 4 ? t.h * 0.85 : t.h;
              const di = idx * 4;
              impDataArr[di] = iw;
              impDataArr[di + 1] = ih;
              impDataArr[di + 2] = t.rot;
              impDataArr[di + 3] = spIdx;
            }
          }
        }
      }
      finalizePool(impMesh, counts.imp, 'aImpData');
    }

    // 3. Pack Ground Flora Carpet (ONLY when grassDirty or player moved!)
    if (doGrass && pools.grass && cfg.grassRadius > 0) {
      const gMesh = pools.grass;
      const gCap = gMesh.instanceMatrix.count;
      const gMatArr = gMesh.instanceMatrix.array;
      const gColArr = gMesh.instanceColor.array;
      const gRectArr = gMesh.geometry.attributes.aAtlasRect.array;
      const grR2 = cfg.grassRadius * cfg.grassRadius;
      const gRing = Math.ceil(cfg.grassRadius / GRASS_CELL_M);
      const gcx = Math.floor(px / GRASS_CELL_M);
      const gcz = Math.floor(pz / GRASS_CELL_M);

      grassPack: for (let r = 0; r <= gRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const ch = grassChunks.get(`${gcx + dx},${gcz + dz}`);
            if (!ch) continue;
            const items = ch.items;
            for (let i = 0; i < items.length; i++) {
              if (counts.gr >= gCap) break grassPack;
              const it = items[i];
              const ddx = it.x - px;
              const ddz = it.z - pz;
              if (ddx * ddx + ddz * ddz > grR2) continue;

              const idx = counts.gr++;
              writeYRotScaleMatrix(gMatArr, idx, it.x, it.y, it.z, it.w, it.h, it.rot);
              writeColor(gColArr, idx, it.r, it.g, it.b);
              const rect = GROUND_FLORA_RECTS[it.kind];
              const ri = idx * 4;
              gRectArr[ri] = rect[0];
              gRectArr[ri + 1] = rect[1];
              gRectArr[ri + 2] = rect[2];
              gRectArr[ri + 3] = rect[3];
            }
          }
        }
      }
      finalizePool(gMesh, counts.gr, 'aAtlasRect');
    }
  }

  // ==========================================================================
  // Queue Scheduling & Incremental Time-Sliced Build via engine.scheduler
  // ==========================================================================

  function enqueueMissingAround(px, pz) {
    // 1. Near-forest dense fill chunks (highest visual priority!)
    if (cfg.nearRadius > 0 && cfg.nearGrid > 0) {
      const nRing = Math.ceil((cfg.nearRadius + 24) / NEAR_CELL_M);
      const ncx = Math.floor(px / NEAR_CELL_M);
      const ncz = Math.floor(pz / NEAR_CELL_M);
      for (let r = 0; r <= nRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = ncx + dx;
            const cz = ncz + dz;
            const d = Math.hypot((cx + 0.5) * NEAR_CELL_M - px, (cz + 0.5) * NEAR_CELL_M - pz);
            if (d > cfg.nearRadius + NEAR_CELL_M) continue;
            const key = `${cx},${cz}`;
            if (nearChunks.has(key) || queuedNearKeys.has(key)) continue;
            queuedNearKeys.add(key);
            pendingNear.push({ cx, cz, key, d });
          }
        }
      }
    }

    // 2. Ground flora grass/wildflower chunks
    if (pools.grass && cfg.grassRadius > 0 && cfg.grassGrid > 0) {
      const gRing = Math.ceil((cfg.grassRadius + 16) / GRASS_CELL_M);
      const gcx = Math.floor(px / GRASS_CELL_M);
      const gcz = Math.floor(pz / GRASS_CELL_M);
      for (let r = 0; r <= gRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = gcx + dx;
            const cz = gcz + dz;
            const d = Math.hypot((cx + 0.5) * GRASS_CELL_M - px, (cz + 0.5) * GRASS_CELL_M - pz);
            if (d > cfg.grassRadius + GRASS_CELL_M) continue;
            const key = `${cx},${cz}`;
            if (grassChunks.has(key) || queuedGrassKeys.has(key)) continue;
            queuedGrassKeys.add(key);
            pendingGrass.push({ cx, cz, key, d });
          }
        }
      }
    }

    // 3. Regional canopy + octahedral impostor chunks (split into inner < 700m vs far horizon!)
    const cRing = Math.ceil(cfg.farRadius / CANOPY_CELL_M);
    const pcx = Math.floor(px / CANOPY_CELL_M);
    const pcz = Math.floor(pz / CANOPY_CELL_M);
    for (let r = 0; r <= cRing; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const d = Math.hypot((cx + 0.5) * CANOPY_CELL_M - px, (cz + 0.5) * CANOPY_CELL_M - pz);
          if (d > cfg.farRadius + CANOPY_CELL_M) continue;
          const key = `${cx},${cz}`;
          if (canopyChunks.has(key) || queuedCanopyKeys.has(key)) continue;
          queuedCanopyKeys.add(key);
          if (d < 720) pendingCanopyNear.push({ cx, cz, key, d });
          else pendingCanopyFar.push({ cx, cz, key, d });
        }
      }
    }

    pendingNear.sort((a, b) => a.d - b.d);
    pendingGrass.sort((a, b) => a.d - b.d);
    pendingCanopyNear.sort((a, b) => a.d - b.d);
    pendingCanopyFar.sort((a, b) => a.d - b.d);
  }

  let lastFarPackMs = -1000;

  function processNearBudget(budgetMs) {
    const start = performance.now();

    // Priority 1: Near-forest fill chunks right around camera/runner
    while (pendingNear.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingNear.shift();
      queuedNearKeys.delete(job.key);
      if (nearChunks.has(job.key)) continue;
      nearChunks.set(job.key, buildNearChunk(job.cx, job.cz));
      treesDirty = true;
    }

    // Priority 2: Ground flora grass/wildflower chunks
    while (pendingGrass.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingGrass.shift();
      queuedGrassKeys.delete(job.key);
      if (grassChunks.has(job.key)) continue;
      grassChunks.set(job.key, buildGrassChunk(job.cx, job.cz));
      grassDirty = true;
    }

    // Priority 3: Inner canopy chunks (< 720m) so near 3D trees & mid impostors populate immediately!
    while (pendingCanopyNear.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingCanopyNear.shift();
      queuedCanopyKeys.delete(job.key);
      if (canopyChunks.has(job.key)) continue;
      canopyChunks.set(job.key, buildCanopyChunk(job.cx, job.cz));
      if (cfg.nearRadius > 0 && job.d <= cfg.nearRadius + CANOPY_CELL_M) treesDirty = true;
      impDirty = true;
      impNearDirty = true;
    }

    return pendingNear.length > 0 || pendingGrass.length > 0 || pendingCanopyNear.length > 0;
  }

  function processFarBudget(budgetMs) {
    const start = performance.now();
    while (pendingCanopyFar.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingCanopyFar.shift();
      queuedCanopyKeys.delete(job.key);
      if (canopyChunks.has(job.key)) continue;
      canopyChunks.set(job.key, buildCanopyChunk(job.cx, job.cz));
      impDirty = true;
    }
    return pendingCanopyFar.length > 0;
  }

  function ensureSchedulerTasks() {
    if (disposed) return;
    if (!cancelNearTask && (pendingNear.length > 0 || pendingGrass.length > 0 || pendingCanopyNear.length > 0)) {
      cancelNearTask = scheduler.enqueue(
        () => {
          if (disposed) {
            cancelNearTask = null;
            return false;
          }
          const more = processNearBudget(1.9);
          if (!more) cancelNearTask = null;
          return more;
        },
        { priority: 10, label: 'flora:near' }
      );
    }
    if (!cancelFarTask && pendingCanopyFar.length > 0) {
      cancelFarTask = scheduler.enqueue(
        () => {
          if (disposed) {
            cancelFarTask = null;
            return false;
          }
          const more = processFarBudget(1.8);
          if (!more) cancelFarTask = null;
          return more;
        },
        { priority: 18, label: 'flora:far' }
      );
    }
  }

  function clearAllQueues() {
    pendingNear.length = 0;
    pendingGrass.length = 0;
    pendingCanopyNear.length = 0;
    pendingCanopyFar.length = 0;
    queuedNearKeys.clear();
    queuedGrassKeys.clear();
    queuedCanopyKeys.clear();
    if (cancelNearTask) {
      cancelNearTask();
      cancelNearTask = null;
    }
    if (cancelFarTask) {
      cancelFarTask();
      cancelFarTask = null;
    }
  }

  function deleteChunksInBounds(map, cellSize, minX, minZ, maxX, maxZ) {
    if (map.size === 0) return false;
    const pad = 20;
    const x0 = Math.floor((minX - pad) / cellSize);
    const x1 = Math.floor((maxX + pad) / cellSize);
    const z0 = Math.floor((minZ - pad) / cellSize);
    const z1 = Math.floor((maxZ + pad) / cellSize);
    let removed = false;
    // Iterate resident map entries (~20-400) instead of enumerating 14,000+ grid coordinates!
    for (const [k, ch] of map) {
      if (ch.cx >= x0 && ch.cx <= x1 && ch.cz >= z0 && ch.cz <= z1) {
        map.delete(k);
        removed = true;
      }
    }
    return removed;
  }

  function invalidateBounds(minX, minZ, maxX, maxZ) {
    let removed = false;
    if (deleteChunksInBounds(canopyChunks, CANOPY_CELL_M, minX, minZ, maxX, maxZ)) {
      removed = true;
      impDirty = true;
      impNearDirty = true;
      if (cfg.nearRadius > 0) treesDirty = true;
    }
    if (deleteChunksInBounds(nearChunks, NEAR_CELL_M, minX, minZ, maxX, maxZ)) {
      removed = true;
      treesDirty = true;
    }
    if (deleteChunksInBounds(grassChunks, GRASS_CELL_M, minX, minZ, maxX, maxZ)) {
      removed = true;
      grassDirty = true;
    }

    if (removed) {
      needRescan = true; // NEVER wipe active queues or fake a teleport!
    }
  }

  function resnapChunkInPlace(ch, cellSize, yOffset) {
    const midX = (ch.cx + 0.5) * cellSize;
    const midZ = (ch.cz + 0.5) * cellSize;
    const newH = terrain.getHeight(midX, midZ);
    const newSurf = terrain.getSurface(midX, midZ);

    // If cover tiles just finished streaming for a chunk built on fallback cover, rebuild it once!
    if (!ch.hadCover && hasCoverAt(newSurf)) {
      return 'rebuild';
    }
    if (Math.abs(newH - ch.centerH) <= 0.6) return 'ok';

    ch.centerH = newH;
    const items = ch.items;
    for (let i = 0; i < items.length; i++) {
      items[i].y = terrain.getHeight(items[i].x, items[i].z) - yOffset;
    }
    if (ch.logs) {
      for (let i = 0; i < ch.logs.length; i++) {
        ch.logs[i].y = terrain.getHeight(ch.logs[i].x, ch.logs[i].z) - 0.06;
      }
    }
    if (ch.stumps) {
      for (let i = 0; i < ch.stumps.length; i++) {
        ch.stumps[i].y = terrain.getHeight(ch.stumps[i].x, ch.stumps[i].z) - 0.04;
      }
    }
    return 'resnapped';
  }

  function evictFarthest(map, maxCount, px, pz, cellSize) {
    if (map.size <= maxCount) return;
    // Evict farthest chunks so memory stays strictly bounded on 100-mile runs & multi-teleports
    const toRemove = map.size - maxCount;
    const entries = [];
    for (const [k, ch] of map.entries()) {
      const dx = (ch.cx + 0.5) * cellSize - px;
      const dz = (ch.cz + 0.5) * cellSize - pz;
      entries.push({ k, d2: dx * dx + dz * dz });
    }
    entries.sort((a, b) => b.d2 - a.d2);
    for (let i = 0; i < toRemove; i++) {
      map.delete(entries[i].k);
    }
  }

  // ==========================================================================
  // Event Listeners (Guarded quality:changed — NEVER rebuild on renderScale!)
  // ==========================================================================

  const unsubQuality = events.on('quality:changed', (q) => {
    if (disposed) return;
    const nextTier = q?.tier ?? engine.quality.tier;
    const nextShadows = Boolean(engine.quality.shadows);
    const nextGrass = Boolean(engine.quality.grass);
    const nextAniso = q?.maxAnisotropy ?? engine.quality.maxAnisotropy ?? 4;

    if (nextAniso !== lastAniso) {
      lastAniso = nextAniso;
      floraTextures.setAnisotropy(nextAniso);
    }

    if (nextTier === lastTier && nextShadows === lastShadows && nextGrass === lastGrass) {
      return; // Pure renderScale adaptive tick -> ZERO work!
    }

    const tierChanged = nextTier !== lastTier;
    const grassChanged = nextGrass !== lastGrass;
    const shadowsChanged = nextShadows !== lastShadows;

    lastTier = nextTier;
    lastShadows = nextShadows;
    lastGrass = nextGrass;

    if (!tierChanged && !grassChanged && shadowsChanged) {
      // Shadow-only toggle: flip castShadow on existing pools without dropping any chunks!
      const allowFolShadow = nextShadows && (nextTier === 'high' || nextTier === 'ultra');
      if (pools.spruceTrunk) pools.spruceTrunk.castShadow = nextShadows;
      if (pools.spruceFol) pools.spruceFol.castShadow = allowFolShadow;
      if (pools.firTrunk) pools.firTrunk.castShadow = nextShadows;
      if (pools.firFol) pools.firFol.castShadow = allowFolShadow;
      if (pools.aspenTrunk) pools.aspenTrunk.castShadow = nextShadows;
      if (pools.aspenFol) pools.aspenFol.castShadow = allowFolShadow;
      return;
    }

    clearAllQueues();
    if (tierChanged) {
      canopyChunks.clear();
      nearChunks.clear();
      grassChunks.clear();
      const nextAtlasSize = nextTier === 'low' ? 512 : 1024;
      if (impostorAtlas.size !== nextAtlasSize) {
        impostorAtlas.resize(nextAtlasSize);
        impostorMat.uniforms.uAlbedoAtlas.value = impostorAtlas.albedoTex;
        impostorMat.uniforms.uNormalAtlas.value = impostorAtlas.normalTex;
      }
    } else if (grassChanged && !nextGrass) {
      grassChunks.clear();
    }
    rebuildPools();
    needRescan = true;
    treesDirty = true;
    impDirty = true;
    impNearDirty = true;
    grassDirty = true;
  });

  const unsubDataChunk = events.on('data:chunk', (payload) => {
    if (disposed) return;
    if (Array.isArray(payload?.bounds) && payload.bounds.length === 4) {
      invalidateBounds(payload.bounds[0], payload.bounds[1], payload.bounds[2], payload.bounds[3]);
    } else if (typeof payload?.tx === 'number' && typeof payload?.ty === 'number') {
      const b = tileBoundsWorld(13, payload.tx, payload.ty);
      invalidateBounds(b.minX, b.minZ, b.maxX, b.maxZ);
    }
  });

  const unsubWaterMask = events.on('world:watermask', (payload) => {
    if (disposed) return;
    const b = payload?.bounds;
    if (Array.isArray(b) && b.length === 4) {
      invalidateBounds(b[0], b[1], b[2], b[3]);
    } else if (b && typeof b.minX === 'number') {
      invalidateBounds(b.minX, b.minZ, b.maxX, b.maxZ);
    }
  });

  const unsubContextRestored = events.on('engine:contextrestored', () => {
    if (disposed) return;
    floraTextures.refresh();
    requestAnimationFrame(() => {
      if (disposed) return;
      floraTextures.refresh();
      impostorAtlas.rebake();
      impostorMat.uniforms.uAlbedoAtlas.value = impostorAtlas.albedoTex;
      impostorMat.uniforms.uNormalAtlas.value = impostorAtlas.normalTex;
    });
  });

  // ==========================================================================
  // Per-Frame Update (runs during 'loading', 'title', and 'playing' per #100/#102)
  // ==========================================================================

  function update(dt, playerPos) {
    if (disposed) return;
    const appState = engine.getAppState?.();
    const now = performance.now();

    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;

    const anchorMove = lastAnchorX < 1e8 ? Math.hypot(px - lastAnchorX, pz - lastAnchorZ) : 0;
    const isTeleport = lastAnchorX < 1e8 && anchorMove > 350;
    if (isTeleport) {
      clearAllQueues();
      needRescan = true;
    }

    if (lastAnchorX >= 1e8 || anchorMove > 22 || (needRescan && (appState === 'loading' || now - lastRescanMs > 220))) {
      enqueueMissingAround(px, pz);
      lastAnchorX = px;
      lastAnchorZ = pz;
      needRescan = false;
      lastRescanMs = now;
    }

    if (appState === 'loading') {
      // During the 6 settle frames behind the opaque loading screen, warm inner forest + grass immediately!
      processNearBudget(10.0);
      processFarBudget(3.0);
    } else {
      ensureSchedulerTasks();
    }

    // Incremental terrain height & cover refinement check (3 chunks per frame -> < 0.08 ms)
    resnapCursor = (resnapCursor + 1) | 0;
    if (nearChunks.size > 0) {
      const nRing = Math.ceil((cfg.nearRadius + 8) / NEAR_CELL_M);
      const nSpan = nRing * 2 + 1;
      const ncx = Math.floor(px / NEAR_CELL_M);
      const ncz = Math.floor(pz / NEAR_CELL_M);
      const idx = resnapCursor % (nSpan * nSpan);
      const key = `${ncx + (idx % nSpan) - nRing},${ncz + Math.floor(idx / nSpan) - nRing}`;
      const ch = nearChunks.get(key);
      if (ch) {
        const res = resnapChunkInPlace(ch, NEAR_CELL_M, 0.16);
        if (res === 'rebuild') {
          nearChunks.delete(key);
          needRescan = true;
          treesDirty = true;
        } else if (res === 'resnapped') {
          treesDirty = true;
        }
      }
    }
    if (grassChunks.size > 0) {
      const gRing = Math.ceil(cfg.grassRadius / GRASS_CELL_M);
      const gSpan = gRing * 2 + 1;
      const gcx = Math.floor(px / GRASS_CELL_M);
      const gcz = Math.floor(pz / GRASS_CELL_M);
      const idx = resnapCursor % (gSpan * gSpan);
      const key = `${gcx + (idx % gSpan) - gRing},${gcz + Math.floor(idx / gSpan) - gRing}`;
      const ch = grassChunks.get(key);
      if (ch) {
        const res = resnapChunkInPlace(ch, GRASS_CELL_M, 0.03);
        if (res === 'rebuild') {
          grassChunks.delete(key);
          needRescan = true;
          grassDirty = true;
        } else if (res === 'resnapped') {
          grassDirty = true;
        }
      }
    }
    if (canopyChunks.size > 0) {
      const cRing = Math.ceil(cfg.farRadius / CANOPY_CELL_M);
      const cSpan = cRing * 2 + 1;
      const pcx = Math.floor(px / CANOPY_CELL_M);
      const pcz = Math.floor(pz / CANOPY_CELL_M);
      const idx = resnapCursor % (cSpan * cSpan);
      const key = `${pcx + (idx % cSpan) - cRing},${pcz + Math.floor(idx / cSpan) - cRing}`;
      const ch = canopyChunks.get(key);
      if (ch) {
        const res = resnapChunkInPlace(ch, CANOPY_CELL_M, 0.18);
        if (res === 'rebuild') {
          canopyChunks.delete(key);
          needRescan = true;
          impDirty = true;
          if (cfg.nearRadius > 0) treesDirty = true;
        } else if (res === 'resnapped') {
          impDirty = true;
          if (cfg.nearRadius > 0) treesDirty = true;
        }
      }
    }

    // Distance-based bounded LRU cache eviction (zero memory growth across 100mi / multi-teleports!)
    if (canopyChunks.size > 460) evictFarthest(canopyChunks, 380, px, pz, CANOPY_CELL_M);
    if (nearChunks.size > 85) evictFarthest(nearChunks, 60, px, pz, NEAR_CELL_M);
    if (grassChunks.size > 120) evictFarthest(grassChunks, 85, px, pz, GRASS_CELL_M);

    const moved = Math.hypot(px - lastPackX, pz - lastPackZ) > 12;
    const doTrees = moved || treesDirty;
    const doGrass = moved || grassDirty;
    const doImp =
      moved ||
      impNearDirty ||
      (impDirty && (appState === 'loading' || now - lastFarPackMs > 160));
    if (doTrees || doImp || doGrass) {
      packPools(px, pz, doTrees, doImp, doGrass);
      if (moved) {
        lastPackX = px;
        lastPackZ = pz;
      }
      if (doTrees) treesDirty = false;
      if (doGrass) grassDirty = false;
      if (doImp) {
        impDirty = false;
        impNearDirty = false;
        lastFarPackMs = now;
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearAllQueues();
    unsubQuality();
    unsubDataChunk();
    unsubWaterMask();
    unsubContextRestored();
    disposePools();
    scene.remove(root);

    spruceModel.trunkGeo.dispose();
    spruceModel.foliageGeo.dispose();
    firModel.trunkGeo.dispose();
    firModel.foliageGeo.dispose();
    aspenModel.trunkGeo.dispose();
    aspenModel.foliageGeo.dispose();
    willowModel.trunkGeo.dispose();
    willowModel.foliageGeo.dispose();
    krummholzModel.trunkGeo.dispose();
    krummholzModel.foliageGeo.dispose();
    deadfallGeo.dispose();
    stumpGeo.dispose();
    grassClumpGeo.dispose();
    impQuadGeo.dispose();

    barkMat.dispose();
    deadfallMat.dispose();
    coniferFolMat.dispose();
    aspenFolMat.dispose();
    shrubFolMat.dispose();
    foliageDepthMat.dispose();
    impostorMat.dispose();
    grassMat.dispose();

    impostorAtlas.dispose();
    floraTextures.dispose();
    if (engine.floraTextures === floraTextures) {
      delete engine.floraTextures;
    }
    masks.release();
    canopyChunks.clear();
    nearChunks.clear();
    grassChunks.clear();
  }

  return { update, dispose };
}
