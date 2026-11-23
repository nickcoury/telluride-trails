import * as THREE from 'three';
import { tileBoundsWorld } from '../core/geo.js';
import { hash2i, mulberry32, fbm2D } from './noise.js';
import { createFloraTextures } from './flora/floraTextures.js';
import {
  buildAngularBoulderGeometry,
  buildStratifiedSlabGeometry,
  buildScreeClusterGeometry,
} from './flora/rockModels.js';
import { createRockMaterial } from './flora/floraMaterials.js';
import { getOrCreateFloraMasks } from './flora/spatialMasks.js';

const ROCK_CELL_M = 140;
const SCREE_CELL_M = 40;

const TIER_ROCK_CFG = {
  low: {
    rockRadius: 280,
    screeRadius: 0,
    rockGrid: 6,
    screeGrid: 0,
    maxAngular: 200,
    maxSlab: 150,
    maxScree: 0,
    useNormalMap: false,
  },
  medium: {
    rockRadius: 380,
    screeRadius: 42,
    rockGrid: 8,
    screeGrid: 6,
    maxAngular: 420,
    maxSlab: 320,
    maxScree: 750,
    useNormalMap: true,
  },
  high: {
    rockRadius: 520,
    screeRadius: 64,
    rockGrid: 11,
    screeGrid: 10,
    maxAngular: 800,
    maxSlab: 620,
    maxScree: 2200,
    useNormalMap: true,
  },
  ultra: {
    rockRadius: 680,
    screeRadius: 88,
    rockGrid: 13,
    screeGrid: 12,
    maxAngular: 1300,
    maxSlab: 1000,
    maxScree: 3600,
    useNormalMap: true,
  },
};

function writeColor(arr, idx, r, g, b) {
  const o = idx * 3;
  arr[o] = r;
  arr[o + 1] = g;
  arr[o + 2] = b;
}

/**
 * Create streaming San Juan talus boulders, stratified outcrops, mossy streambank rocks,
 * and multi-stone scree cobble fields. Strictly excluded from lakes, town blocks, and trails;
 * time-sliced via engine.scheduler; immune to adaptive renderScale ticks.
 */
export function createRocks(engine, terrain, trailData, atmosphere) {
  const { scene, events, scheduler } = engine;
  let disposed = false;

  const ownedTextures = !engine.floraTextures;
  const floraTextures = engine.floraTextures || createFloraTextures(engine.quality.maxAnisotropy || 4);
  const masks = getOrCreateFloraMasks(engine, trailData);

  const angularGeo = buildAngularBoulderGeometry();
  const slabGeo = buildStratifiedSlabGeometry();
  const screeGeo = buildScreeClusterGeometry();

  const pbrRockMat = createRockMaterial(floraTextures, atmosphere.uniforms, { useNormalMap: true });
  const lowRockMat = createRockMaterial(floraTextures, atmosphere.uniforms, { useNormalMap: false });

  const root = new THREE.Group();
  root.name = 'SanJuanRocks';
  scene.add(root);

  let cfg = TIER_ROCK_CFG[engine.quality.tier] || TIER_ROCK_CFG.medium;
  let lastTier = engine.quality.tier;
  let lastShadows = Boolean(engine.quality.shadows);

  let angularMesh = null;
  let slabMesh = null;
  let screeMesh = null;

  function makePool(name, geo, mat, capacity, castShadow) {
    if (capacity <= 0) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    const colArr = new Float32Array(capacity * 3);
    colArr.fill(1.0);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colArr, 3);
    root.add(mesh);
    return mesh;
  }

  function disposePools() {
    for (const m of [angularMesh, slabMesh, screeMesh]) {
      if (m) {
        root.remove(m);
        m.dispose();
      }
    }
    angularMesh = null;
    slabMesh = null;
    screeMesh = null;
  }

  function rebuildPools() {
    disposePools();
    cfg = TIER_ROCK_CFG[engine.quality.tier] || TIER_ROCK_CFG.medium;
    const allowShadow = Boolean(engine.quality.shadows);
    const mat = cfg.useNormalMap ? pbrRockMat : lowRockMat;
    angularMesh = makePool('TalusBouldersA', angularGeo, mat, cfg.maxAngular, allowShadow);
    slabMesh = makePool('TalusBouldersB', slabGeo, mat, cfg.maxSlab, allowShadow);
    screeMesh = cfg.maxScree > 0 ? makePool('ScreeCobbles', screeGeo, mat, cfg.maxScree, false) : null;
  }

  rebuildPools();

  const rockChunks = new Map();
  const screeChunks = new Map();
  const pendingRockNear = [];
  const pendingRockFar = [];
  const pendingScree = [];
  const queuedRockKeys = new Set();
  const queuedScreeKeys = new Set();

  let cancelNearTask = null;
  let cancelFarTask = null;
  let dirty = true;
  let nearDirty = true;
  let lastPackX = 1e9;
  let lastPackZ = 1e9;
  let lastAnchorX = 1e9;
  let lastAnchorZ = 1e9;
  let needRescan = true;
  let lastRescanMs = -1000;
  let lastFarPackMs = -1000;
  let resnapCursor = 0;

  function hasCoverAt(surf) {
    return surf.forest + surf.rock + surf.water + surf.snow + surf.grass > 0.05;
  }

  function pickSanJuanMineralColor(x, z, nearStream, rng) {
    const mineral = fbm2D(x * 0.0019, z * 0.0019, 2, 811);
    const shade = 0.80 + rng() * 0.34;
    if (nearStream) {
      // Wet mossy dark river/creek cobble & boulder
      return [0.64 * shade, 0.70 * shade, 0.62 * shade];
    }
    if (mineral > 0.56) {
      // Telluride / Red Mountain iron-oxide rust-ochre volcanic breccia
      return [1.04 * shade, 0.78 * shade, 0.62 * shade];
    }
    if (mineral < 0.35) {
      // Pale weathered San Juan granodiorite / quartz-grey granite
      return [1.02 * shade, 1.00 * shade, 0.96 * shade];
    }
    // Classic charcoal-slate San Juan andesite
    return [0.80 * shade, 0.79 * shade, 0.81 * shade];
  }

  function buildRockChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 557));
    const g = cfg.rockGrid;
    const step = ROCK_CELL_M / g;
    const x0 = cx * ROCK_CELL_M;
    const z0 = cz * ROCK_CELL_M;
    const items = [];

    for (let gz = 0; gz < g; gz++) {
      for (let gx = 0; gx < g; gx++) {
        const x = x0 + (gx + 0.10 + rng() * 0.80) * step;
        const z = z0 + (gz + 0.10 + rng() * 0.80) * step;

        if (masks.isExcludedTownOrBuilding(x, z, 18.0)) continue;
        if (masks.isInLake(x, z, 2.2)) continue;

        const near = trailData?.nearest?.(x, z, 12.0);
        if (near) {
          const minClear = near.kind === 'road' ? 8.5 : near.kind === 'track' ? 3.8 : 1.9;
          if (near.dist < minClear) continue;
        }

        const y = terrain.getHeight(x, z);
        const norm = terrain.getNormal(x, z);
        const surf = terrain.getSurface(x, z);
        if (surf.water > 0.14) continue;

        const ww = masks.queryWaterway(x, z, 8.5);
        const isStreamBank = ww.found && ww.dist >= ww.halfW * 0.6 && ww.dist <= ww.halfW + 6.5;

        const slopeFactor = Math.max(0, 1 - norm.y);
        const alpineFactor = y > 3440 ? Math.min(1, (y - 3440) / 420) : 0;
        const talusClump = fbm2D(x * 0.016, z * 0.016, 2, 643);

        let rockProb =
          surf.rock * 1.15 +
          slopeFactor * 1.65 +
          alpineFactor * 0.42 +
          (isStreamBank ? 0.58 : 0);

        // Occasional natural mossy trailside/forest boulders even in lower-rock woods
        if (rockProb < 0.24 && surf.forest > 0.25 && talusClump > 0.62) {
          rockProb = 0.28;
        }
        rockProb = Math.min(0.95, rockProb * (0.65 + talusClump * 0.65));
        if (rockProb < 0.18 || rng() > rockProb) continue;

        const baseScale = (0.42 + Math.pow(rng(), 1.65) * 2.25) * (0.72 + rockProb * 0.48);
        const sx = baseScale * (0.82 + rng() * 0.52);
        const sy = baseScale * (0.58 + rng() * 0.48);
        const sz = baseScale * (0.82 + rng() * 0.52);
        const [r, gCol, b] = pickSanJuanMineralColor(x, z, isStreamBank, rng);
        const variant = rng() < 0.56 ? 0 : 1;

        items.push({
          x,
          y: y - sy * 0.28,
          z,
          rx: (rng() - 0.5) * 0.45,
          ry: rng() * Math.PI * 2,
          rz: (rng() - 0.5) * 0.45,
          sx,
          sy,
          sz,
          r,
          g: gCol,
          b,
          variant,
        });
      }
    }

    const midX = x0 + ROCK_CELL_M * 0.5;
    const midZ = z0 + ROCK_CELL_M * 0.5;
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

  function buildScreeChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 829));
    const g = cfg.screeGrid;
    const items = [];
    const x0 = cx * SCREE_CELL_M;
    const z0 = cz * SCREE_CELL_M;

    if (g > 0) {
      const step = SCREE_CELL_M / g;
      for (let gz = 0; gz < g; gz++) {
        for (let gx = 0; gx < g; gx++) {
          const x = x0 + (gx + 0.10 + rng() * 0.80) * step;
          const z = z0 + (gz + 0.10 + rng() * 0.80) * step;

          if (masks.isExcludedTownOrBuilding(x, z, 13.0)) continue;
          if (masks.isInLake(x, z, 1.8)) continue;

          const near = trailData?.nearest?.(x, z, 9.0);
          if (near) {
            const minClear = near.kind === 'road' ? 6.0 : near.kind === 'track' ? 2.6 : 0.95;
            if (near.dist < minClear) continue;
          }

          const y = terrain.getHeight(x, z);
          const norm = terrain.getNormal(x, z);
          const surf = terrain.getSurface(x, z);
          if (surf.water > 0.14 || norm.y < 0.48) continue;

          const ww = masks.queryWaterway(x, z, 7.0);
          if (ww.found && ww.dist < ww.halfW + 0.35) continue;
          const isBank = ww.found && ww.dist <= ww.halfW + 5.0;

          const slope = Math.max(0, 1 - norm.y);
          const alpine = y > 3420 ? Math.min(1, (y - 3420) / 450) : 0;
          const screeProb = Math.min(0.95, surf.rock * 0.95 + slope * 1.15 + alpine * 0.42 + (isBank ? 0.55 : 0.14));
          if (rng() > screeProb) continue;

          const s = 0.65 + Math.pow(rng(), 1.2) * 1.35;
          const [r, gCol, b] = pickSanJuanMineralColor(x, z, isBank, rng);
          items.push({
            x,
            y: y - 0.04,
            z,
            ry: rng() * Math.PI * 2,
            sx: s * (0.85 + rng() * 0.40),
            sy: s * (0.65 + rng() * 0.35),
            sz: s * (0.85 + rng() * 0.40),
            r,
            g: gCol,
            b,
          });
        }
      }
    }

    const midX = x0 + SCREE_CELL_M * 0.5;
    const midZ = z0 + SCREE_CELL_M * 0.5;
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

  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  const _scale = new THREE.Vector3();

  function finalizePool(mesh, count) {
    if (!mesh) return;
    mesh.count = count;
    mesh.visible = count > 0;
    if (count > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  function pack(px, pz) {
    let aCount = 0;
    let sCount = 0;
    const r2 = cfg.rockRadius * cfg.rockRadius;
    const ring = Math.ceil(cfg.rockRadius / ROCK_CELL_M);
    const pcx = Math.floor(px / ROCK_CELL_M);
    const pcz = Math.floor(pz / ROCK_CELL_M);
    const aCap = angularMesh ? angularMesh.instanceMatrix.count : 0;
    const sCap = slabMesh ? slabMesh.instanceMatrix.count : 0;

    // Pack nearest-first so foreground talus never loses slots to distant ridges
    for (let r = 0; r <= ring; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const ch = rockChunks.get(`${pcx + dx},${pcz + dz}`);
          if (!ch) continue;
          const items = ch.items;
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const ddx = it.x - px;
            const ddz = it.z - pz;
            if (ddx * ddx + ddz * ddz > r2) continue;

            _pos.set(it.x, it.y, it.z);
            _euler.set(it.rx, it.ry, it.rz);
            _quat.setFromEuler(_euler);
            _scale.set(it.sx, it.sy, it.sz);
            _mat.compose(_pos, _quat, _scale);

            if (it.variant === 0 && angularMesh && aCount < aCap) {
              angularMesh.setMatrixAt(aCount, _mat);
              writeColor(angularMesh.instanceColor.array, aCount, it.r, it.g, it.b);
              aCount++;
            } else if (slabMesh && sCount < sCap) {
              slabMesh.setMatrixAt(sCount, _mat);
              writeColor(slabMesh.instanceColor.array, sCount, it.r, it.g, it.b);
              sCount++;
            }
          }
        }
      }
    }
    finalizePool(angularMesh, aCount);
    finalizePool(slabMesh, sCount);

    if (screeMesh && cfg.screeRadius > 0) {
      let cCount = 0;
      const cCap = screeMesh.instanceMatrix.count;
      const c2 = cfg.screeRadius * cfg.screeRadius;
      const cRing = Math.ceil(cfg.screeRadius / SCREE_CELL_M);
      const ccx = Math.floor(px / SCREE_CELL_M);
      const ccz = Math.floor(pz / SCREE_CELL_M);

      screeLoop: for (let r = 0; r <= cRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const ch = screeChunks.get(`${ccx + dx},${ccz + dz}`);
            if (!ch) continue;
            const items = ch.items;
            for (let i = 0; i < items.length; i++) {
              if (cCount >= cCap) break screeLoop;
              const it = items[i];
              const ddx = it.x - px;
              const ddz = it.z - pz;
              if (ddx * ddx + ddz * ddz > c2) continue;

              _pos.set(it.x, it.y, it.z);
              _euler.set(0, it.ry, 0);
              _quat.setFromEuler(_euler);
              _scale.set(it.sx, it.sy, it.sz);
              _mat.compose(_pos, _quat, _scale);
              screeMesh.setMatrixAt(cCount, _mat);
              writeColor(screeMesh.instanceColor.array, cCount, it.r, it.g, it.b);
              cCount++;
            }
          }
        }
      }
      finalizePool(screeMesh, cCount);
    }
  }

  function enqueueMissingAround(px, pz) {
    if (screeMesh && cfg.screeRadius > 0) {
      const cRing = Math.ceil((cfg.screeRadius + 16) / SCREE_CELL_M);
      const ccx = Math.floor(px / SCREE_CELL_M);
      const ccz = Math.floor(pz / SCREE_CELL_M);
      for (let r = 0; r <= cRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = ccx + dx;
            const cz = ccz + dz;
            const d = Math.hypot((cx + 0.5) * SCREE_CELL_M - px, (cz + 0.5) * SCREE_CELL_M - pz);
            if (d > cfg.screeRadius + SCREE_CELL_M) continue;
            const key = `${cx},${cz}`;
            if (screeChunks.has(key) || queuedScreeKeys.has(key)) continue;
            queuedScreeKeys.add(key);
            pendingScree.push({ cx, cz, key, d });
          }
        }
      }
    }

    const rRing = Math.ceil(cfg.rockRadius / ROCK_CELL_M);
    const pcx = Math.floor(px / ROCK_CELL_M);
    const pcz = Math.floor(pz / ROCK_CELL_M);
    for (let r = 0; r <= rRing; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const d = Math.hypot((cx + 0.5) * ROCK_CELL_M - px, (cz + 0.5) * ROCK_CELL_M - pz);
          if (d > cfg.rockRadius + ROCK_CELL_M) continue;
          const key = `${cx},${cz}`;
          if (rockChunks.has(key) || queuedRockKeys.has(key)) continue;
          queuedRockKeys.add(key);
          if (d < 340) pendingRockNear.push({ cx, cz, key, d });
          else pendingRockFar.push({ cx, cz, key, d });
        }
      }
    }

    pendingScree.sort((a, b) => a.d - b.d);
    pendingRockNear.sort((a, b) => a.d - b.d);
    pendingRockFar.sort((a, b) => a.d - b.d);
  }

  function processNearBudget(budgetMs) {
    const start = performance.now();
    while (pendingScree.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingScree.shift();
      queuedScreeKeys.delete(job.key);
      if (screeChunks.has(job.key)) continue;
      screeChunks.set(job.key, buildScreeChunk(job.cx, job.cz));
      dirty = true;
      nearDirty = true;
    }
    while (pendingRockNear.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingRockNear.shift();
      queuedRockKeys.delete(job.key);
      if (rockChunks.has(job.key)) continue;
      rockChunks.set(job.key, buildRockChunk(job.cx, job.cz));
      dirty = true;
      nearDirty = true;
    }
    return pendingScree.length > 0 || pendingRockNear.length > 0;
  }

  function processFarBudget(budgetMs) {
    const start = performance.now();
    while (pendingRockFar.length > 0 && performance.now() - start < budgetMs) {
      const job = pendingRockFar.shift();
      queuedRockKeys.delete(job.key);
      if (rockChunks.has(job.key)) continue;
      rockChunks.set(job.key, buildRockChunk(job.cx, job.cz));
      dirty = true;
    }
    return pendingRockFar.length > 0;
  }

  function ensureSchedulerTasks() {
    if (disposed) return;
    if (!cancelNearTask && (pendingScree.length > 0 || pendingRockNear.length > 0)) {
      cancelNearTask = scheduler.enqueue(
        () => {
          if (disposed) {
            cancelNearTask = null;
            return false;
          }
          const more = processNearBudget(1.4);
          if (!more) cancelNearTask = null;
          return more;
        },
        { priority: 11, label: 'flora:rocks-near' }
      );
    }
    if (!cancelFarTask && pendingRockFar.length > 0) {
      cancelFarTask = scheduler.enqueue(
        () => {
          if (disposed) {
            cancelFarTask = null;
            return false;
          }
          const more = processFarBudget(1.0);
          if (!more) cancelFarTask = null;
          return more;
        },
        { priority: 19, label: 'flora:rocks-far' }
      );
    }
  }

  function clearQueues() {
    pendingRockNear.length = 0;
    pendingRockFar.length = 0;
    pendingScree.length = 0;
    queuedRockKeys.clear();
    queuedScreeKeys.clear();
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
    // Iterate resident map entries (~20-260) instead of enumerating 10,000+ grid coordinates!
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
    if (deleteChunksInBounds(rockChunks, ROCK_CELL_M, minX, minZ, maxX, maxZ)) removed = true;
    if (deleteChunksInBounds(screeChunks, SCREE_CELL_M, minX, minZ, maxX, maxZ)) removed = true;
    if (removed) {
      dirty = true;
      nearDirty = true;
      needRescan = true;
    }
  }

  function resnapInPlace(ch, cellSize, isScree) {
    const midX = (ch.cx + 0.5) * cellSize;
    const midZ = (ch.cz + 0.5) * cellSize;
    const newH = terrain.getHeight(midX, midZ);
    const newSurf = terrain.getSurface(midX, midZ);
    if (!ch.hadCover && hasCoverAt(newSurf)) return 'rebuild';
    if (Math.abs(newH - ch.centerH) <= 0.6) return 'ok';
    ch.centerH = newH;
    const items = ch.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      it.y = terrain.getHeight(it.x, it.z) - (isScree ? 0.04 : it.sy * 0.28);
    }
    return 'resnapped';
  }

  function evictFarthest(map, maxCount, px, pz, cellSize) {
    if (map.size <= maxCount) return;
    const toRemove = map.size - maxCount;
    const list = [];
    for (const [k, ch] of map.entries()) {
      const dx = (ch.cx + 0.5) * cellSize - px;
      const dz = (ch.cz + 0.5) * cellSize - pz;
      list.push({ k, d2: dx * dx + dz * dz });
    }
    list.sort((a, b) => b.d2 - a.d2);
    for (let i = 0; i < toRemove; i++) map.delete(list[i].k);
  }

  // Guarded quality listener: NEVER rebuild on pure renderScale ticks!
  const unsubQuality = events.on('quality:changed', (q) => {
    if (disposed) return;
    const nextTier = q?.tier ?? engine.quality.tier;
    const nextShadows = Boolean(engine.quality.shadows);
    if (nextTier === lastTier && nextShadows === lastShadows) return;

    const tierChanged = nextTier !== lastTier;
    lastTier = nextTier;
    lastShadows = nextShadows;

    if (!tierChanged) {
      if (angularMesh) angularMesh.castShadow = nextShadows;
      if (slabMesh) slabMesh.castShadow = nextShadows;
      return;
    }

    clearQueues();
    rockChunks.clear();
    screeChunks.clear();
    rebuildPools();
    needRescan = true;
    nearDirty = true;
    dirty = true;
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
    if (ownedTextures) floraTextures.refresh();
  });

  function update(dt, playerPos) {
    if (disposed) return;
    const appState = engine.getAppState?.();
    const now = performance.now();

    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;

    const anchorMove = lastAnchorX < 1e8 ? Math.hypot(px - lastAnchorX, pz - lastAnchorZ) : 0;
    if (lastAnchorX < 1e8 && anchorMove > 350) {
      clearQueues();
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
      processNearBudget(4.5);
      processFarBudget(1.5);
    } else {
      ensureSchedulerTasks();
    }

    resnapCursor = (resnapCursor + 1) | 0;
    if (rockChunks.size > 0) {
      const ring = Math.ceil(cfg.rockRadius / ROCK_CELL_M);
      const span = ring * 2 + 1;
      const pcx = Math.floor(px / ROCK_CELL_M);
      const pcz = Math.floor(pz / ROCK_CELL_M);
      const idx = resnapCursor % (span * span);
      const key = `${pcx + (idx % span) - ring},${pcz + Math.floor(idx / span) - ring}`;
      const ch = rockChunks.get(key);
      if (ch) {
        const res = resnapInPlace(ch, ROCK_CELL_M, false);
        if (res === 'rebuild') {
          rockChunks.delete(key);
          needRescan = true;
          dirty = true;
        } else if (res === 'resnapped') {
          dirty = true;
        }
      }
    }
    if (screeChunks.size > 0) {
      const cRing = Math.ceil(cfg.screeRadius / SCREE_CELL_M);
      const span = cRing * 2 + 1;
      const ccx = Math.floor(px / SCREE_CELL_M);
      const ccz = Math.floor(pz / SCREE_CELL_M);
      const idx = resnapCursor % (span * span);
      const key = `${ccx + (idx % span) - cRing},${ccz + Math.floor(idx / span) - cRing}`;
      const ch = screeChunks.get(key);
      if (ch) {
        const res = resnapInPlace(ch, SCREE_CELL_M, true);
        if (res === 'rebuild') {
          screeChunks.delete(key);
          needRescan = true;
          nearDirty = true;
          dirty = true;
        } else if (res === 'resnapped') {
          nearDirty = true;
          dirty = true;
        }
      }
    }

    if (rockChunks.size > 260) evictFarthest(rockChunks, 210, px, pz, ROCK_CELL_M);
    if (screeChunks.size > 120) evictFarthest(screeChunks, 85, px, pz, SCREE_CELL_M);

    const shouldPack =
      nearDirty ||
      Math.hypot(px - lastPackX, pz - lastPackZ) > 12 ||
      (dirty && (appState === 'loading' || now - lastFarPackMs > 150));
    if (shouldPack) {
      pack(px, pz);
      lastPackX = px;
      lastPackZ = pz;
      dirty = false;
      nearDirty = false;
      lastFarPackMs = now;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearQueues();
    unsubQuality();
    unsubDataChunk();
    unsubWaterMask();
    unsubContextRestored();
    disposePools();
    scene.remove(root);
    angularGeo.dispose();
    slabGeo.dispose();
    screeGeo.dispose();
    pbrRockMat.dispose();
    lowRockMat.dispose();
    if (ownedTextures) floraTextures.dispose();
    masks.release();
    rockChunks.clear();
    screeChunks.clear();
  }

  return { update, dispose };
}
