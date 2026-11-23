import { tileBoundsWorld, worldToTile } from '../core/geo.js';

const DEM_ZOOM = 10;
const X_MIN = 204;
const X_MAX = 206;
const Y_MIN = 394;
const Y_MAX = 396;
const TILE_SIZE = 256;

/** @type {Map<string, Float32Array>} */
const demTiles = new Map();
let demLoadPromise = null;
let demReady = false;

/**
 * Lazy-load coarse z10 Terrarium DEM tiles covering the playable San Juan bbox (~340 KB total).
 * Never called on Title screen; triggered only when Free Run or Races screen opens.
 * @param {string} assetsBase
 * @returns {Promise<boolean>}
 */
export function ensureDemLoaded(assetsBase = '/telluride-trails/') {
  if (demReady) return Promise.resolve(true);
  if (demLoadPromise) return demLoadPromise;

  const base = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;
  const scratch = document.createElement('canvas');
  scratch.width = TILE_SIZE;
  scratch.height = TILE_SIZE;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  const jobs = [];
  for (let ty = Y_MIN; ty <= Y_MAX; ty++) {
    for (let tx = X_MIN; tx <= X_MAX; tx++) {
      jobs.push(
        new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.decoding = 'async';
          img.onload = () => {
            try {
              sctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
              sctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
              const px = sctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
              const heights = new Float32Array(TILE_SIZE * TILE_SIZE);
              for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
                heights[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
              }
              demTiles.set(`${tx}_${ty}`, heights);
            } catch {
              // ignore decode errors
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = `${base}data/terrain/${DEM_ZOOM}/${tx}/${ty}.webp`;
        })
      );
    }
  }

  demLoadPromise = Promise.all(jobs).then(() => {
    demReady = demTiles.size > 0;
    return demReady;
  });
  return demLoadPromise;
}

export function isDemReady() {
  return demReady;
}

/**
 * Sample bilinearly interpolated USGS 3DEP elevation (meters) at world (wx, wz).
 * @param {number} wx
 * @param {number} wz
 * @returns {number|null}
 */
export function sampleDem(wx, wz) {
  if (demTiles.size === 0) return null;
  const { x: tx, y: ty } = worldToTile(wx, wz, DEM_ZOOM);
  const grid = demTiles.get(`${tx}_${ty}`);
  if (!grid) return null;

  const b = tileBoundsWorld(DEM_ZOOM, tx, ty);
  const u = Math.max(0, Math.min(0.9999, (wx - b.minX) / (b.maxX - b.minX))) * (TILE_SIZE - 1);
  const v = Math.max(0, Math.min(0.9999, (wz - b.minZ) / (b.maxZ - b.minZ))) * (TILE_SIZE - 1);
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const x1 = Math.min(TILE_SIZE - 1, x0 + 1);
  const y1 = Math.min(TILE_SIZE - 1, y0 + 1);
  const fx = u - x0;
  const fy = v - y0;

  const h00 = grid[y0 * TILE_SIZE + x0];
  const h10 = grid[y0 * TILE_SIZE + x1];
  const h01 = grid[y1 * TILE_SIZE + x0];
  const h11 = grid[y1 * TILE_SIZE + x1];

  const h0 = h00 + (h10 - h00) * fx;
  const h1 = h01 + (h11 - h01) * fx;
  return h0 + (h1 - h0) * fy;
}

/** @type {WeakMap<object, { minX: number, maxX: number, minZ: number, maxZ: number }>} */
const boundsCache = new WeakMap();

/**
 * Compute and memoize world-space XZ AABB for a polyline feature with packed Float32Array coords.
 * @param {object} item
 * @param {number} zOffset - index offset of Z in stride (2 for [x,y,z], 1 for [x,z,cumDist])
 * @param {number} stride
 * @returns {{ minX: number, maxX: number, minZ: number, maxZ: number } | null}
 */
export function getFeatureBounds(item, zOffset = 2, stride = 3) {
  if (!item) return null;
  let cached = boundsCache.get(item);
  if (cached) return cached;

  if (Array.isArray(item.bbox) && item.bbox.length === 4) {
    cached = {
      minX: item.bbox[0],
      minZ: item.bbox[1],
      maxX: item.bbox[2],
      maxZ: item.bbox[3],
    };
    boundsCache.set(item, cached);
    return cached;
  }

  const arr = item.coords || item.line;
  if (!arr || arr.length < stride) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i <= arr.length - stride; i += stride) {
    const x = arr[i];
    const z = arr[i + zOffset];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  cached = { minX, maxX, minZ, maxZ };
  boundsCache.set(item, cached);
  return cached;
}
