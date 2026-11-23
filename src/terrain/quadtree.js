import * as THREE from 'three';
import { K, lonLatToWorld, R, tileBoundsWorld, worldToTile } from '../core/geo.js';
import { DEFAULT_MAX_ELEV_M, DEFAULT_MIN_ELEV_M, REGION_BOUNDS } from './config.js';
import { createPatchGeometry } from './geometry.js';
import { getHorizonBounds } from './manifest.js';

const DEG_TO_RAD = Math.PI / 180;
const HALF_CIRC = Math.PI * R;
const INV_TWO_HALF_CIRC = 1 / (2 * HALF_CIRC);
const MX0 = R * -107.8123 * DEG_TO_RAD;
const MY0 = R * Math.log(Math.tan(Math.PI / 4 + (37.9375 * DEG_TO_RAD) / 2));

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

/**
 * Bilinear sample on a vertex-aligned (N+1)x(N+1) height grid (0..N maps exactly to u,v in [0..1]).
 */
function sampleVertexHeightBilinear(data, width, height, u, v) {
  const maxX = width - 1;
  const maxY = height - 1;
  const fx = Math.max(0, Math.min(1, u)) * maxX;
  const fy = Math.max(0, Math.min(1, v)) * maxY;
  const x0 = Math.min(maxX, Math.floor(fx));
  const x1 = Math.min(maxX, x0 + 1);
  const y0 = Math.min(maxY, Math.floor(fy));
  const y1 = Math.min(maxY, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = data[y0 * width + x0];
  const v10 = data[y0 * width + x1];
  const v01 = data[y1 * width + x0];
  const v11 = data[y1 * width + x1];

  const top = v00 + (v10 - v00) * tx;
  const bot = v01 + (v11 - v01) * tx;
  return top + (bot - top) * ty;
}

/**
 * Bilinear sample on an area-registered tile (e.g., 256x256 cover RGBA PNG).
 */
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
 * - Leaf-only tile requests (eliminates 584-tile intermediate-zoom thrash!)
 * - Distance-first priority queue (near-camera z15-z17 tiles ALWAYS beat 40 km horizon tiles!)
 * - Seamless edge-stitched 257x257 heights + precomputed normal/AO maps
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
      tileCache.fallbackNormalAoTex,
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

  const roots = [];
  function buildRoots(boundsRect = REGION_BOUNDS) {
    roots.length = 0;
    const nwWorld = lonLatToWorld(boundsRect.west, boundsRect.north);
    const seWorld = lonLatToWorld(boundsRect.east, boundsRect.south);
    const rootZoom = config.minQuadZoom;
    const nwTile = worldToTile(nwWorld.x, nwWorld.z, rootZoom);
    const seTile = worldToTile(seWorld.x, seWorld.z, rootZoom);

    for (let ty = nwTile.y; ty <= seTile.y; ty++) {
      for (let tx = nwTile.x; tx <= seTile.x; tx++) {
        roots.push({ z: rootZoom, x: tx, y: ty, bounds: tileBoundsWorld(rootZoom, tx, ty) });
      }
    }
  }
  buildRoots(REGION_BOUNDS);

  function refreshBounds(manifests) {
    buildRoots(getHorizonBounds(manifests));
  }

  /**
   * Look up best resident ancestor (read-only during walk) and direct target zoom for a LEAF node.
   * Only fetches a coarse fallback (<= z11) when NO ancestor is resident at all, then jumps
   * directly to bestSourceZ — eliminating intermediate zoom staircase thrash!
   */
  function findLeafEntryAndTargets(kind, z, x, y, minZ, maxZ) {
    const startZ = Math.min(z, maxZ);
    let bestResident = null;
    let bestSourceZ = -1;
    let coarseFallbackZ = -1;

    let cz = startZ;
    let cx = x >> Math.max(0, z - startZ);
    let cy = y >> Math.max(0, z - startZ);

    while (cz >= minZ) {
      if (tileCache.hasSource(kind, cz, cx, cy)) {
        if (bestSourceZ === -1) bestSourceZ = cz;
        if (cz <= 11 && coarseFallbackZ === -1) coarseFallbackZ = cz;
      }
      if (!bestResident) {
        const entry = tileCache.get(kind, cz, cx, cy);
        if (entry) {
          bestResident = entry;
          if (bestSourceZ !== -1) break;
        }
      }
      cz--;
      cx >>= 1;
      cy >>= 1;
    }

    let primaryTarget = null;
    let coarseTarget = null;

    if (bestSourceZ !== -1 && (!bestResident || bestResident.z < bestSourceZ)) {
      const dz = z - bestSourceZ;
      primaryTarget = { z: bestSourceZ, x: x >> dz, y: y >> dz };

      // If nothing is resident yet for this leaf, also request ONE cheap coarse fallback (z <= 11)
      if (!bestResident && coarseFallbackZ !== -1 && coarseFallbackZ < bestSourceZ) {
        const dzC = z - coarseFallbackZ;
        coarseTarget = { z: coarseFallbackZ, x: x >> dzC, y: y >> dzC };
      }
    }

    return { resident: bestResident, primaryTarget, coarseTarget };
  }

  function findResidentTerrainFast(z, x, y, minZ, maxZ) {
    const startZ = Math.min(z, maxZ);
    let cz = startZ;
    let cx = x >> Math.max(0, z - startZ);
    let cy = y >> Math.max(0, z - startZ);
    while (cz >= minZ) {
      const entry = tileCache.getFast('terrain', cz, cx, cy);
      if (entry) return entry;
      cz--;
      cx >>= 1;
      cy >>= 1;
    }
    return null;
  }

  function splitDistanceForZoom(z, bounds) {
    const size = bounds.maxX - bounds.minX;
    const bias = Math.max(0.5, engine.quality.terrainLodBias || 1.0);
    // Keep z17 splits tight around the runner (~270m) so only 4-16 immediate patches subdivide to z17
    const zoomFactor = z >= 16 ? 0.56 : config.lodDistanceFactor;
    return (size * zoomFactor) / bias;
  }

  /**
   * Distance-first request priority: near-camera z15-z17 tiles ALWAYS beat distant horizon tiles!
   */
  function computeRequestPriority(distCam, targetZ, kindOffset) {
    if (distCam < 2000) {
      return distCam + targetZ * 15 + kindOffset;
    }
    if (distCam < 18000) {
      return 3000 + distCam + targetZ * 80 + kindOffset;
    }
    return 25000 + distCam + targetZ * 120 + kindOffset;
  }

  const leaves = [];
  const pinnedKeys = new Set();
  const activeTargetKeys = new Set();

  function walkNode(z, x, y, bounds, camPos, focusPos, isTitle) {
    const maxTerrainZ = isTitle ? Math.min(14, config.maxTerrainZoom) : config.maxTerrainZoom;
    const residentH = findResidentTerrainFast(z, x, y, config.minQuadZoom, maxTerrainZ);
    const minH = residentH ? residentH.minH - 12 : DEFAULT_MIN_ELEV_M;
    const maxH = residentH ? residentH.maxH + 12 : DEFAULT_MAX_ELEV_M;

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
    const maxAllowedZoom = isTitle
      ? Math.min(14, config.maxQuadZoom)
      : distCam > config.detailDrawDistance
        ? Math.min(12, config.maxQuadZoom)
        : config.maxQuadZoom;

    if (z < maxAllowedZoom && minDist < splitDist) {
      const nz = z + 1;
      const nx0 = x * 2;
      const ny0 = y * 2;
      const midX = (bounds.minX + bounds.maxX) * 0.5;
      const midZ = (bounds.minZ + bounds.maxZ) * 0.5;

      walkNode(nz, nx0, ny0, { minX: bounds.minX, maxX: midX, minZ: bounds.minZ, maxZ: midZ }, camPos, focusPos, isTitle);
      walkNode(nz, nx0 + 1, ny0, { minX: midX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: midZ }, camPos, focusPos, isTitle);
      walkNode(nz, nx0, ny0 + 1, { minX: bounds.minX, maxX: midX, minZ: midZ, maxZ: bounds.maxZ }, camPos, focusPos, isTitle);
      walkNode(nz, nx0 + 1, ny0 + 1, { minX: midX, maxX: bounds.maxX, minZ: midZ, maxZ: bounds.maxZ }, camPos, focusPos, isTitle);
      return;
    }

    // Leaf node ONLY — never request tiles for internal nodes!
    leaves.push({ z, x, y, bounds, distCam, splitDist });
  }

  function update(focusPos) {
    trailMask.flushDeferred?.();
    const isTitle = engine.getAppState?.() === 'title';
    const cam = engine.camera;
    cam.updateMatrixWorld();
    _projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projView);

    const camPos = cam.position;
    const focusVec = focusPos ? _vec.set(focusPos.x || 0, focusPos.y || camPos.y, focusPos.z || 0) : camPos;

    materialPool.syncAtmosphere(camPos, engine.clock.elapsedTime);

    leaves.length = 0;
    pinnedKeys.clear();
    activeTargetKeys.clear();

    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      walkNode(r.z, r.x, r.y, r.bounds, camPos, focusVec, isTitle);
    }

    // Sort leaves front-to-back for early-Z GPU efficiency and near-first tile streaming!
    leaves.sort((a, b) => a.distCam - b.distCam);

    activeMeshCount = 0;
    const gridSegs = config.patchGridSize & ~1;
    const shadowsEnabled = Boolean(engine.quality.shadows);
    const maxTerrainZ = isTitle ? Math.min(14, config.maxTerrainZoom) : config.maxTerrainZoom;
    const maxImgZ = isTitle ? Math.min(15, config.maxImageryZoom) : config.maxImageryZoom;

    for (let i = 0; i < leaves.length; i++) {
      const leaf = leaves[i];
      const { z, x, y, bounds, distCam, splitDist } = leaf;
      const tileSize = bounds.maxX - bounds.minX;

      // 1. Terrain elevation + normal/AO
      const terrainInfo = findLeafEntryAndTargets('terrain', z, x, y, config.minQuadZoom, maxTerrainZ);
      if (terrainInfo.coarseTarget) {
        const t = terrainInfo.coarseTarget;
        const p = computeRequestPriority(distCam, t.z, -50);
        activeTargetKeys.add(`terrain:${t.z}/${t.x}/${t.y}`);
        tileCache.request('terrain', t.z, t.x, t.y, p);
      }
      if (terrainInfo.primaryTarget) {
        const t = terrainInfo.primaryTarget;
        const p = computeRequestPriority(distCam, t.z, 0);
        activeTargetKeys.add(`terrain:${t.z}/${t.x}/${t.y}`);
        tileCache.request('terrain', t.z, t.x, t.y, p);
      }

      // 2. NAIP Orthoimagery (distance-first so z16/z17 under the runner loads FIRST!)
      const imageryInfo = findLeafEntryAndTargets('imagery', z, x, y, config.minQuadZoom, maxImgZ);
      if (imageryInfo.coarseTarget) {
        const t = imageryInfo.coarseTarget;
        const p = computeRequestPriority(distCam, t.z, -20);
        activeTargetKeys.add(`imagery:${t.z}/${t.x}/${t.y}`);
        tileCache.request('imagery', t.z, t.x, t.y, p);
      }
      if (imageryInfo.primaryTarget) {
        const t = imageryInfo.primaryTarget;
        const p = computeRequestPriority(distCam, t.z, 25);
        activeTargetKeys.add(`imagery:${t.z}/${t.x}/${t.y}`);
        tileCache.request('imagery', t.z, t.x, t.y, p);
      }

      // 3. Cover mask (skip on title to keep title cold payload < 1.5 MB)
      const coverInfo = isTitle
        ? { resident: null, primaryTarget: null, coarseTarget: null }
        : findLeafEntryAndTargets('cover', z, x, y, 13, config.maxCoverZoom);
      if (coverInfo.primaryTarget) {
        const t = coverInfo.primaryTarget;
        const p = computeRequestPriority(distCam, t.z, 60);
        activeTargetKeys.add(`cover:${t.z}/${t.x}/${t.y}`);
        tileCache.request('cover', t.z, t.x, t.y, p);
      }

      const mesh = acquireMeshSlot();
      const { uniforms } = mesh.userData.slot;

      uniforms.uTileBounds.value.set(bounds.minX, bounds.minZ, tileSize, bounds.maxZ - bounds.minZ);

      // Height + precomputed Normal/AO textures
      const hEntry = terrainInfo.resident;
      if (hEntry) {
        pinnedKeys.add(hEntry.key);
        const hUv = computeUvTransform(z, x, y, hEntry.z, hEntry.x, hEntry.y);
        uniforms.uHeightTex.value = hEntry.texture;
        uniforms.uNormalAoTex.value = hEntry.normalAoTex || tileCache.fallbackNormalAoTex;
        uniforms.uHeightUvTransform.value.set(hUv[0], hUv[1], hUv[2], hUv[3]);
        uniforms.uHeightTexSize.value.set(hEntry.width, hEntry.height);
        uniforms.uFlags.value.x = 1;
      } else {
        uniforms.uHeightTex.value = tileCache.fallbackHeightTex;
        uniforms.uNormalAoTex.value = tileCache.fallbackNormalAoTex;
        uniforms.uHeightUvTransform.value.set(0, 0, 1, 1);
        uniforms.uHeightTexSize.value.set(1, 1);
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

      // Semantic RGB trail/asphalt/curb mask (z17 right under camera on high/ultra = 0.47 m/px!)
      let trailTex = null;
      if (!isTitle && config.useTrailMask && z >= 14 && distCam < 3800) {
        const desiredMaskZ =
          distCam < 360 && z >= config.trailMaskNearZoom
            ? config.trailMaskNearZoom
            : Math.min(z, config.trailMaskZoom || 16);
        const maskZ = Math.max(14, Math.min(z, desiredMaskZ));
        const dzTrail = z - maskZ;
        const mtx = x >> dzTrail;
        const mty = y >> dzTrail;
        const isImmediate = distCam < 260;
        trailTex = trailMask.getMaskForTile(maskZ, mtx, mty, isImmediate);
        if (trailTex) {
          const tUv = computeUvTransform(z, x, y, maskZ, mtx, mty);
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
      // Modest safety skirt (edge stitching + parent feathering already guarantee 0.000m seams!)
      const skirtDepth = Math.max(4.0, Math.min(28.0, tileSize * 0.015));
      uniforms.uMorphParams.value.set(morphStart, invMorphSpan, gridSegs, skirtDepth);

      mesh.receiveShadow = shadowsEnabled && distCam < config.detailDrawDistance;
      mesh.castShadow =
        shadowsEnabled && config.castShadowRadiusM > 0 && distCam < config.castShadowRadiusM;
    }

    // Hide unused pooled meshes
    for (let i = activeMeshCount; i < meshPool.length; i++) {
      meshPool[i].visible = false;
    }

    tileCache.clearPendingFar(activeTargetKeys);
    tileCache.evict(pinnedKeys);
  }

  let lastTerrainEntry = null;

  function findBestTerrainEntry(x, z) {
    const maxZ = config.maxTerrainZoom;
    if (
      lastTerrainEntry &&
      !lastTerrainEntry.evicted &&
      lastTerrainEntry.z === maxZ &&
      x >= lastTerrainEntry.bounds.minX &&
      x <= lastTerrainEntry.bounds.maxX &&
      z >= lastTerrainEntry.bounds.minZ &&
      z <= lastTerrainEntry.bounds.maxZ
    ) {
      return lastTerrainEntry;
    }

    const n = 1 << maxZ;
    const mx = x / K + MX0;
    const my = -z / K + MY0;
    const u = (mx + HALF_CIRC) * INV_TWO_HALF_CIRC;
    const v = (HALF_CIRC - my) * INV_TWO_HALF_CIRC;
    let tx = Math.max(0, Math.min(n - 1, (u * n) | 0));
    let ty = Math.max(0, Math.min(n - 1, (v * n) | 0));

    const minZ = config.minQuadZoom;
    for (let tz = maxZ; tz >= minZ; tz--) {
      const entry = tileCache.getFast('terrain', tz, tx, ty);
      if (entry && entry.heights) {
        lastTerrainEntry = entry;
        return entry;
      }
      tx >>= 1;
      ty >>= 1;
    }
    return null;
  }

  /**
   * Synchronous height query using best resident stitched 257x257 terrain tile. Never throws.
   */
  function getHeight(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 2667;
    const entry = findBestTerrainEntry(x, z);
    if (!entry) return 2667;
    const b = entry.bounds;
    const u = (x - b.minX) * entry.invW;
    const v = (z - b.minZ) * entry.invH;
    return sampleVertexHeightBilinear(entry.heights, entry.width, entry.height, u, v);
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

    const maxCoverZ = config.maxCoverZoom;
    const nCover = 1 << maxCoverZ;
    const mx = x / K + MX0;
    const my = -z / K + MY0;
    let cx = Math.max(0, Math.min(nCover - 1, ((mx + HALF_CIRC) * INV_TWO_HALF_CIRC * nCover) | 0));
    let cy = Math.max(0, Math.min(nCover - 1, ((HALF_CIRC - my) * INV_TWO_HALF_CIRC * nCover) | 0));

    for (let tz = maxCoverZ; tz >= 13; tz--) {
      const entry = tileCache.getFast('cover', tz, cx, cy);
      if (entry && entry.rgba) {
        const b = entry.bounds;
        const u = (x - b.minX) * entry.invW;
        const v = (z - b.minZ) * entry.invH;
        forest = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 0, u, v) / 255;
        rock = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 1, u, v) / 255;
        water = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 2, u, v) / 255;
        grass = sampleTileBilinear(entry.rgba, entry.width, entry.height, 4, 3, u, v) / 255;
        foundCover = true;
        break;
      }
      cx >>= 1;
      cy >>= 1;
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
    if (h > 4040 && slope < 0.44 && n.z < -0.1) {
      const northAspect = Math.max(0, Math.min(1, (-0.1 - n.z) / 0.4));
      snow = Math.min(0.65, ((h - 4040) / 320) * northAspect * (1 - slope * 1.1));
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
   * Preload resident high-detail terrain (z15), imagery (z15-z17), and cover (z13-z14)
   * around (x, z) before resolving. Uses negative blocking priorities so preload tiles
   * are never dropped or starved by background horizon tiles.
   */
  function preload(x, z, radiusM = 1200) {
    tileCache.processUploads(64, 16);

    const isTitle = engine.getAppState?.() === 'title';
    const r = Math.max(250, radiusM || 1200);
    const needed = new Set();

    let done = false;
    let timer = 0;
    let off = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (off) off();
      // Full flush so every decoded tile is GPU-resident before loading screen drops!
      tileCache.processUploads(999, Infinity);
      if (!isTitle && config.useTrailMask) {
        trailMask.warmAround(x, z, config.trailMaskNearZoom || 16);
      }
    };

    const addRect = (kind, tz, rad, blocking = true, prioBase = -1000) => {
      const minT = worldToTile(x - rad, z - rad, tz);
      const maxT = worldToTile(x + rad, z + rad, tz);
      const x0 = Math.min(minT.x, maxT.x);
      const x1 = Math.max(minT.x, maxT.x);
      const y0 = Math.min(minT.y, maxT.y);
      const y1 = Math.max(minT.y, maxT.y);

      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (!tileCache.getFast(kind, tz, tx, ty) && tileCache.hasSource(kind, tz, tx, ty)) {
            const key = `${kind}:${tz}/${tx}/${ty}`;
            if (blocking) needed.add(key);
            const prio = blocking ? prioBase + tz : 30000 + tz * 100;
            tileCache.request(kind, tz, tx, ty, prio);
          }
        }
      }
    };

    return new Promise((resolve) => {
      let totalNeeded = 0;
      const resolvePreload = () => {
        finish();
        engine.events.emit('terrain:preload-progress', { loaded: totalNeeded, total: totalNeeded });
        resolve();
      };

      off = tileCache.onTileSettled((key) => {
        if (needed.delete(key)) {
          const loaded = Math.max(0, totalNeeded - needed.size);
          engine.events.emit('terrain:preload-progress', { loaded, total: totalNeeded });
          if (needed.size === 0) {
            resolvePreload();
          } else {
            queueMicrotask(() => tileCache.processUploads(16, 16));
          }
        }
      });

      if (isTitle) {
        // Lightweight title preload (stays well under 1.5 MB cold budget while delivering crisp Telluride backdrop)
        addRect('terrain', 9, 3000, true, -2000);
        addRect('terrain', 11, 5000, true, -1800);
        addRect('terrain', 13, 2200, true, -1500);
        if (config.maxTerrainZoom >= 14) addRect('terrain', 14, 900, true, -1200);

        addRect('imagery', 10, 5000, true, -1900);
        addRect('imagery', 13, 2200, true, -1400);
        if (config.maxImageryZoom >= 14) addRect('imagery', 14, 1100, true, -1100);
      } else {
        // Full near-photoreal playable preload: crisp z15 DEM, z15-z17 NAIP imagery, z13-z14 cover!
        addRect('terrain', 9, 3000, true, -3000);
        addRect('terrain', 11, 5000, true, -2800);
        addRect('terrain', 13, Math.max(r, 1800), true, -2400);
        if (config.maxTerrainZoom >= 14) addRect('terrain', 14, Math.min(r, 1050), true, -2000);
        if (config.maxTerrainZoom >= 15) addRect('terrain', 15, Math.min(r, 820), true, -1800);

        addRect('imagery', 10, 5000, true, -2700);
        addRect('imagery', 13, Math.max(r, 1600), true, -2200);
        addRect('imagery', 14, Math.min(r, 950), true, -1900);
        if (config.maxImageryZoom >= 15) addRect('imagery', 15, Math.min(r, 700), true, -1700);
        if (config.maxImageryZoom >= 16) addRect('imagery', 16, Math.min(r, 420), true, -1600);
        if (config.maxImageryZoom >= 17) addRect('imagery', 17, 200, true, -1550);

        addRect('cover', 13, Math.max(r, 1500), true, -1500);
        if (config.maxCoverZoom >= 14) addRect('cover', 14, Math.min(r, 750), true, -1400);

        // Warm far skyline asynchronously without blowing low-tier 40 MB VRAM budget
        const horizonWarmR = config.lruMaxBytes <= 48 * 1024 * 1024 ? 26000 : 50000;
        addRect('terrain', 9, horizonWarmR, false);
        addRect('imagery', 9, horizonWarmR, false);
      }

      totalNeeded = needed.size;
      engine.events.emit('terrain:preload-progress', { loaded: 0, total: totalNeeded });

      if (totalNeeded === 0) {
        resolvePreload();
        return;
      }

      timer = setTimeout(() => {
        if (needed.size > 0) {
          console.warn('[terrain] preload timeout remaining:', needed.size);
        }
        resolvePreload();
      }, 10000);
    });
  }

  function setTierConfig(nextConfig) {
    config = nextConfig;
    lastTerrainEntry = null;
    currentGeo = getGeometry(config.patchGridSize);
    tileCache.setTierConfig(nextConfig);
    trailMask.setTierConfig(nextConfig);
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
    refreshBounds,
    setTierConfig,
    getStats,
    dispose,
  };
}
