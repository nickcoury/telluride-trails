import * as THREE from 'three';
import { lonLatToWorld, tileBoundsWorld, worldToTile } from '../core/geo.js';
import { DEFAULT_MAX_ELEV_M, DEFAULT_MIN_ELEV_M, REGION_BOUNDS } from './config.js';
import { createPatchGeometry } from './geometry.js';

const _projView = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _box = new THREE.Box3();
const _vec = new THREE.Vector3();

function computeUvTransform(patchZ, patchX, patchY, tileZ, tileX, tileY) {
  const dz = patchZ - tileZ;
  if (dz <= 0) return [0, 0, 1, 1];
  const span = 2 ** dz;
  const scale = 1 / span;
  const offX = (patchX - tileX * span) * scale;
  const offY = (patchY - tileY * span) * scale;
  return [offX, offY, scale, scale];
}

function sampleTileBilinear(data, width, height, stride, channelOffset, u, v) {
  const fx = Math.max(0, Math.min(1, u)) * width - 0.5;
  const fy = Math.max(0, Math.min(1, v)) * height - 0.5;
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)));
  const x1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)));
  const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
  const tx = Math.max(0, Math.min(1, fx - Math.floor(fx)));
  const ty = Math.max(0, Math.min(1, fy - Math.floor(fy)));

  const v00 = data[(y0 * width + x0) * stride + channelOffset];
  const v10 = data[(y0 * width + x1) * stride + channelOffset];
  const v01 = data[(y1 * width + x0) * stride + channelOffset];
  const v11 = data[(y1 * width + x1) * stride + channelOffset];

  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

/**
 * Streaming CDLOD quadtree manager + synchronous height/normal/surface queries.
 */
export function createTerrainQuadtree({ engine, tileCache, materialPool, trailMask, tierConfig }) {
  let config = tierConfig;
  const rootGroup = new THREE.Group();
  rootGroup.name = 'telluride-terrain';
  engine.scene.add(rootGroup);

  const geometries = new Map();
  function getGeometry(gridSize) {
    const key = Math.max(4, gridSize & ~1);
    if (!geometries.has(key)) {
      geometries.set(key, createPatchGeometry(key));
    }
    return geometries.get(key);
  }

  let currentGeo = getGeometry(config.patchGridSize);
  const meshPool = [];
  let activeMeshCount = 0;

  function acquireMeshSlot() {
    if (activeMeshCount < meshPool.length) {
      const m = meshPool[activeMeshCount++];
      if (m.geometry !== currentGeo) m.geometry = currentGeo;
      m.visible = true;
      return m;
    }
    const slot = materialPool.createSlot(
      tileCache.fallbackHeightTex,
      tileCache.fallbackImageryTex,
      tileCache.fallbackCoverTex,
      trailMask.fallbackMaskTex,
    );
    const mesh = new THREE.Mesh(currentGeo, slot.material);
    mesh.customDepthMaterial = slot.depthMaterial;
    mesh.frustumCulled = false; // Quadtree performs exact 3D AABB frustum culling
    mesh.matrixAutoUpdate = false;
    mesh.userData.slot = slot;
    rootGroup.add(mesh);
    meshPool.push(mesh);
    activeMeshCount++;
    return mesh;
  }

  // Root tiles at minQuadZoom (z=9) covering REGION_BOUNDS
  const nwWorld = lonLatToWorld(REGION_BOUNDS.west, REGION_BOUNDS.north);
  const seWorld = lonLatToWorld(REGION_BOUNDS.east, REGION_BOUNDS.south);
  const rootZoom = config.minQuadZoom;
  const nwTile = worldToTile(nwWorld.x, nwWorld.z, rootZoom);
  const seTile = worldToTile(seWorld.x, seWorld.z, rootZoom);

  const roots = [];
  for (let ty = nwTile.y; ty <= seTile.y; ty++) {
    for (let tx = nwTile.x; tx <= seTile.x; tx++) {
      roots.push({ z: rootZoom, x: tx, y: ty, bounds: tileBoundsWorld(rootZoom, tx, ty) });
    }
  }

  function findBestEntryAndTarget(kind, z, x, y, minZ, maxZ) {
    const startZ = Math.min(z, maxZ);
    let bestResident = null;
    let bestSourceZ = -1;

    let cz = startZ;
    let cx = x >> Math.max(0, z - startZ);
    let cy = y >> Math.max(0, z - startZ);

    while (cz >= minZ) {
      if (bestSourceZ === -1 && tileCache.hasSource(kind, cz, cx, cy)) {
        bestSourceZ = cz;
      }
      const entry = tileCache.get(kind, cz, cx, cy);
      if (entry) {
        bestResident = entry;
        break;
      }
      cz--;
      cx >>= 1;
      cy >>= 1;
    }

    // Determine target coordinates to fetch if resident isn't already the highest source
    let target = null;
    if (bestSourceZ !== -1 && (!bestResident || bestResident.z < bestSourceZ)) {
      const dz = z - bestSourceZ;
      target = {
        z: bestSourceZ,
        x: x >> dz,
        y: y >> dz,
      };
    }

    return { resident: bestResident, target };
  }

  function splitDistanceForZoom(z, bounds) {
    const size = bounds.maxX - bounds.minX;
    const bias = Math.max(0.5, engine.quality.terrainLodBias || 1.0);
    return (size * config.lodDistanceFactor) / bias;
  }

  const leaves = [];
  const pinnedKeys = new Set();

  function walkNode(z, x, y, bounds, camPos, focusPos) {
    // Look up best cached terrain entry for tight Y bounds
    const terrainInfo = findBestEntryAndTarget('terrain', z, x, y, config.minQuadZoom, config.maxTerrainZoom);
    const minH = terrainInfo.resident ? terrainInfo.resident.minH - 12 : DEFAULT_MIN_ELEV_M;
    const maxH = terrainInfo.resident ? terrainInfo.resident.maxH + 12 : DEFAULT_MAX_ELEV_M;

    _box.min.set(bounds.minX, minH, bounds.minZ);
    _box.max.set(bounds.maxX, maxH, bounds.maxZ);

    const distCam = _box.distanceToPoint(camPos);
    if (distCam > config.horizonDrawDistance) return;

    // Keep nearby patches un-culled so fast camera rotation never reveals a missing tile
    const distFocus = _box.distanceToPoint(focusPos);
    if (distCam > 900 && distFocus > 700 && !_frustum.intersectsBox(_box)) {
      return;
    }

    const splitDist = splitDistanceForZoom(z, bounds);
    const minDist = Math.min(distCam, distFocus);
    const maxAllowedZoom =
      distCam > config.detailDrawDistance ? Math.min(12, config.maxQuadZoom) : config.maxQuadZoom;

    // Coarse-first: always prioritize fetching current node's terrain if missing
    if (terrainInfo.target) {
      const p = terrainInfo.target.z * 10000 + distCam * 0.1;
      tileCache.request('terrain', terrainInfo.target.z, terrainInfo.target.x, terrainInfo.target.y, p);
    }

    if (z < maxAllowedZoom && minDist < splitDist) {
      const nz = z + 1;
      const nx0 = x * 2;
      const ny0 = y * 2;
      const midX = (bounds.minX + bounds.maxX) * 0.5;
      const midZ = (bounds.minZ + bounds.maxZ) * 0.5;

      walkNode(nz, nx0, ny0, { minX: bounds.minX, maxX: midX, minZ: bounds.minZ, maxZ: midZ }, camPos, focusPos);
      walkNode(nz, nx0 + 1, ny0, { minX: midX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: midZ }, camPos, focusPos);
      walkNode(nz, nx0, ny0 + 1, { minX: bounds.minX, maxX: midX, minZ: midZ, maxZ: bounds.maxZ }, camPos, focusPos);
      walkNode(nz, nx0 + 1, ny0 + 1, { minX: midX, maxX: bounds.maxX, minZ: midZ, maxZ: bounds.maxZ }, camPos, focusPos);
      return;
    }

    leaves.push({ z, x, y, bounds, distCam, splitDist, terrainInfo });
  }

  function update(focusPos) {
    const cam = engine.camera;
    cam.updateMatrixWorld();
    _projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);

    const camPos = cam.position;
    const focusVec = focusPos ? _vec.set(focusPos.x || 0, focusPos.y || camPos.y, focusPos.z || 0) : camPos;

    materialPool.syncAtmosphere(camPos, engine.clock.elapsedTime);

    leaves.length = 0;
    pinnedKeys.clear();

    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      walkNode(r.z, r.x, r.y, r.bounds, camPos, focusVec);
    }

    // Sort leaves front-to-back for early-Z GPU efficiency and tile request priority
    leaves.sort((a, b) => a.distCam - b.distCam);

    activeMeshCount = 0;
    const gridSegs = config.patchGridSize & ~1;
    const shadowsEnabled = Boolean(engine.quality.shadows);

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const { z, x, y, bounds, distCam, splitDist, terrainInfo } = leaf;
      const tileSize = bounds.maxX - bounds.minX;

      const imageryInfo = findBestEntryAndTarget('imagery', z, x, y, config.minQuadZoom, config.maxImageryZoom);
      if (imageryInfo.target) {
        const p = imageryInfo.target.z * 10000 + distCam * 0.1 + 500;
        tileCache.request('imagery', imageryInfo.target.z, imageryInfo.target.x, imageryInfo.target.y, p);
      }

      const coverInfo = findBestEntryAndTarget('cover', z, x, y, 12, config.maxCoverZoom);
      if (coverInfo.target) {
        const p = coverInfo.target.z * 10000 + distCam * 0.1 + 1200;
        tileCache.request('cover', coverInfo.target.z, coverInfo.target.x, coverInfo.target.y, p);
      }

      const mesh = acquireMeshSlot();
      const { uniforms } = mesh.userData.slot;

      uniforms.uTileBounds.value.set(bounds.minX, bounds.minZ, tileSize, bounds.maxZ - bounds.minZ);

      // Height texture & UV transform
      const hEntry = terrainInfo.resident;
      if (hEntry) {
        pinnedKeys.add(hEntry.key);
        const hUv = computeUvTransform(z, x, y, hEntry.z, hEntry.x, hEntry.y);
        uniforms.uHeightTex.value = hEntry.texture;
        uniforms.uHeightUvTransform.value.set(hUv[0], hUv[1], hUv[2], hUv[3]);
        uniforms.uHeightTexSize.value.set(hEntry.width, hEntry.height);
        const hTileBounds = tileBoundsWorld(hEntry.z, hEntry.x, hEntry.y);
        uniforms.uHeightTexelWorld.value.set(
          (hTileBounds.maxX - hTileBounds.minX) / hEntry.width,
          (hTileBounds.maxZ - hTileBounds.minZ) / hEntry.height,
        );
        uniforms.uFlags.value.x = 1;
      } else {
        uniforms.uHeightTex.value = tileCache.fallbackHeightTex;
        uniforms.uHeightUvTransform.value.set(0, 0, 1, 1);
        uniforms.uHeightTexSize.value.set(1, 1);
        uniforms.uHeightTexelWorld.value.set(tileSize, tileSize);
        uniforms.uFlags.value.x = 0;
      }

      // Imagery texture & UV transform
      const iEntry = imageryInfo.resident;
      if (iEntry) {
        pinnedKeys.add(iEntry.key);
        const iUv = computeUvTransform(z, x, y, iEntry.z, iEntry.x, iEntry.y);
        uniforms.uImageryTex.value = iEntry.texture;
        uniforms.uImageryUvTransform.value.set(iUv[0], iUv[1], iUv[2], iUv[3]);
        uniforms.uFlags.value.y = 1;
      } else {
        uniforms.uImageryTex.value = tileCache.fallbackImageryTex;
        uniforms.uImageryUvTransform.value.set(0, 0, 1, 1);
        uniforms.uFlags.value.y = 0;
      }

      // Cover texture & UV transform
      const cEntry = coverInfo.resident;
      if (cEntry) {
        pinnedKeys.add(cEntry.key);
        const cUv = computeUvTransform(z, x, y, cEntry.z, cEntry.x, cEntry.y);
        uniforms.uCoverTex.value = cEntry.texture;
        uniforms.uCoverUvTransform.value.set(cUv[0], cUv[1], cUv[2], cUv[3]);
        uniforms.uFlags.value.z = 1;
      } else {
        uniforms.uCoverTex.value = tileCache.fallbackCoverTex;
        uniforms.uCoverUvTransform.value.set(0, 0, 1, 1);
        uniforms.uFlags.value.z = 0;
      }

      // Trail mask texture (only near player / high-zoom patches)
      let trailTex = null;
      if (config.useTrailMask && z >= 14 && distCam < 5000) {
        const dzTrail = z - 14;
        const tx14 = x >> dzTrail;
        const ty14 = y >> dzTrail;
        trailTex = trailMask.getMaskForTile(14, tx14, ty14);
        if (trailTex) {
          const tUv = computeUvTransform(z, x, y, 14, tx14, ty14);
          uniforms.uTrailMaskTex.value = trailTex;
          uniforms.uTrailUvTransform.value.set(tUv[0], tUv[1], tUv[2], tUv[3]);
          uniforms.uFlags.value.w = 1;
        }
      }
      if (!trailTex) {
        uniforms.uTrailMaskTex.value = trailMask.fallbackMaskTex;
        uniforms.uTrailUvTransform.value.set(0, 0, 1, 1);
        uniforms.uFlags.value.w = 0;
      }

      // CDLOD geomorph range toward parent level (z - 1)
      let morphStart = 1e9;
      let invMorphSpan = 0;
      if (z > config.minQuadZoom) {
        const parentSplit = splitDist * 2.0;
        morphStart = parentSplit * 0.72;
        const morphEnd = parentSplit * 0.98;
        invMorphSpan = 1.0 / Math.max(1.0, morphEnd - morphStart);
      }
      const skirtDepth = Math.max(3.0, tileSize * 0.014);
      uniforms.uMorphParams.value.set(morphStart, invMorphSpan, gridSegs, skirtDepth);

      mesh.receiveShadow = shadowsEnabled && distCam < config.detailDrawDistance;
      mesh.castShadow = shadowsEnabled && config.castShadowRadiusM > 0 && distCam < config.castShadowRadiusM;
    }

    // Hide unused pooled meshes
    for (let i = activeMeshCount; i < meshPool.length; i++) {
      meshPool[i].visible = false;
    }

    tileCache.processUploads(config.uploadsPerFrame);
    tileCache.clearPendingFar();
    tileCache.evict(pinnedKeys);
  }

  /**
   * Synchronous height query using best resident terrain tile (bilinear). Never throws.
   */
  function getHeight(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 2667;
    for (let tz = config.maxTerrainZoom; tz >= config.minQuadZoom; tz--) {
      const t = worldToTile(x, z, tz);
      const entry = tileCache.get('terrain', tz, t.x, t.y);
      if (entry && entry.heights) {
        const b = tileBoundsWorld(tz, t.x, t.y);
        const u = (x - b.minX) / (b.maxX - b.minX);
        const v = (z - b.minZ) / (b.maxZ - b.minZ);
        return sampleTileBilinear(entry.heights, entry.width, entry.height, 1, 0, u, v);
      }
    }
    return 2667;
  }

  /**
   * Synchronous world normal query from best resident terrain tile. Never throws.
   */
  function getNormal(x, z) {
    const e = 3.5;
    const hL = getHeight(x - e, z);
    const hR = getHeight(x + e, z);
    const hN = getHeight(x, z - e);
    const hS = getHeight(x, z + e);
    const nx = hL - hR;
    const ny = 2 * e;
    const nz = hN - hS;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /**
   * Synchronous surface mix from cover tiles + elevation/slope fallback.
   * @returns {{ forest: number, rock: number, water: number, snow: number, grass: number }}
   */
  function getSurface(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return { forest: 0.3, rock: 0.2, water: 0, snow: 0, grass: 0.5 };
    }
    const h = getHeight(x, z);
    const n = getNormal(x, z);
    const slope = Math.max(0, Math.min(1, 1 - n.y));

    let forest = 0;
    let rock = 0;
    let water = 0;
    let grass = 0;
    let foundCover = false;

    for (let tz = config.maxCoverZoom; tz >= 12; tz--) {
      const t = worldToTile(x, z, tz);
      const entry = tileCache.get('cover', tz, t.x, t.y);
      if (entry && entry.rgba) {
        const b = tileBoundsWorld(tz, t.x, t.y);
        const u = (x - b.minX) / (b.maxX - b.minX);
        const v = (z - b.minZ) / (b.maxZ - b.minZ);
        forest = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 0, u, v) / 255;
        rock = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 1, u, v) / 255;
        water = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 2, u, v) / 255;
        grass = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 3, u, v) / 255;
        foundCover = true;
        break;
      }
    }

    if (!foundCover) {
      const cliff = Math.max(0, Math.min(1, (slope - 0.18) / 0.3));
      const alpine = Math.max(0, Math.min(1, (h - 3350) / 350));
      const aboveTreeline = Math.max(0, Math.min(1, (h - 3450) / 250));
      forest = (1 - aboveTreeline) * (1 - cliff) * 0.7;
      rock = Math.min(1, cliff + Math.max(0, (h - 3650) / 400) * 0.65);
      grass = (1 - cliff) * (0.4 + alpine * 0.35);
    }

    if (slope > 0.28) {
      const cliffBoost = Math.min(1, (slope - 0.28) / 0.28);
      rock = Math.max(rock, cliffBoost);
      forest *= 1 - cliffBoost * 0.8;
      grass *= 1 - cliffBoost * 0.7;
    }

    let snow = 0;
    if (h > 3780 && slope < 0.55) {
      snow = Math.min(1, ((h - 3780) / 380) * (1 - slope * 0.9));
    }

    return {
      forest: +Math.max(0, Math.min(1, forest)).toFixed(3),
      rock: +Math.max(0, Math.min(1, rock)).toFixed(3),
      water: +Math.max(0, Math.min(1, water)).toFixed(3),
      snow: +Math.max(0, Math.min(1, snow)).toFixed(3),
      grass: +Math.max(0, Math.min(1, grass)).toFixed(3),
    };
  }

  /**
   * Preload terrain, imagery, and cover tiles around (x, z) within radiusM.
   */
  function preload(x, z, radiusM = 1200) {
    const r = Math.max(200, radiusM || 1200);
    const needed = new Set();

    const addRect = (kind, tz, rad) => {
      const minT = worldToTile(x - rad, z - rad, tz);
      const maxT = worldToTile(x + rad, z + rad, tz);
      const x0 = Math.min(minT.x, maxT.x);
      const x1 = Math.max(minT.x, maxT.x);
      const y0 = Math.min(minT.y, maxT.y);
      const y1 = Math.max(minT.y, maxT.y);

      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (!tileCache.get(kind, tz, tx, ty) && tileCache.hasSource(kind, tz, tx, ty)) {
            const key = `${kind}:${tz}/${tx}/${ty}`;
            needed.add(key);
            tileCache.request(kind, tz, tx, ty, tz * 100);
          }
        }
      }
    };

    // Coarse skyline + immediate detail around spawn
    addRect('terrain', 9, 45000);
    addRect('terrain', 11, 25000);
    addRect('terrain', 13, Math.max(r, 3500));
    if (config.maxTerrainZoom >= 14) addRect('terrain', 14, r);
    if (config.maxTerrainZoom >= 15) addRect('terrain', 15, Math.min(r, 1200));

    addRect('imagery', 10, 35000);
    addRect('imagery', 13, Math.max(r, 2500));
    if (config.maxImageryZoom >= 15) addRect('imagery', 15, Math.min(r, 1200));

    addRect('cover', 13, Math.max(r, 2500));

    if (needed.size === 0) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        tileCache.processUploads(999);
        resolve();
      };

      const off = tileCache.onTileSettled((key) => {
        if (needed.delete(key)) {
          tileCache.processUploads(16);
          if (needed.size === 0) finish();
        }
      });

      const timer = setTimeout(finish, 12000);
    });
  }

  function setTierConfig(nextConfig) {
    config = nextConfig;
    currentGeo = getGeometry(config.patchGridSize);
    tileCache.setTierConfig(nextConfig);
  }

  function getStats() {
    return {
      activePatches: activeMeshCount,
      poolSize: meshPool.length,
      ...tileCache.getStats(),
    };
  }

  function dispose() {
    engine.scene.remove(rootGroup);
    for (const geo of geometries.values()) geo.dispose();
    geometries.clear();
    meshPool.length = 0;
  }

  return {
    update,
    getHeight,
    getNormal,
    getSurface,
    preload,
    setTierConfig,
    getStats,
    dispose,
  };
}
