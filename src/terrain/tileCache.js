import * as THREE from 'three';
import { tileBoundsWorld } from '../core/geo.js';
import { resolveTileSource } from './manifest.js';

function tileKey(kind, z, x, y) {
  return `${kind}:${z}/${x}/${y}`;
}

function numKey(z, x, y) {
  return (z * 262144 + x) * 262144 + y;
}

function encodeTerrariumPixel(out, p, elevM) {
  const v = Math.max(0, Math.min(65535.996, elevM + 32768.0));
  const r = Math.floor(v / 256.0);
  const rem = v - r * 256.0;
  const g = Math.floor(rem);
  const b = Math.max(0, Math.min(255, Math.round((rem - g) * 256.0)));
  out[p] = r;
  out[p + 1] = g;
  out[p + 2] = b;
  out[p + 3] = 255;
}

function sampleVertexGridBilinear(heights, size, u, v) {
  const maxIdx = size - 1;
  const fx = Math.max(0, Math.min(1, u)) * maxIdx;
  const fy = Math.max(0, Math.min(1, v)) * maxIdx;
  const x0 = Math.min(maxIdx, Math.floor(fx));
  const x1 = Math.min(maxIdx, x0 + 1);
  const y0 = Math.min(maxIdx, Math.floor(fy));
  const y1 = Math.min(maxIdx, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = heights[y0 * size + x0];
  const v10 = heights[y0 * size + x1];
  const v01 = heights[y1 * size + x0];
  const v11 = heights[y1 * size + x1];
  return v00 + (v10 - v00) * tx + ((v01 + (v11 - v01) * tx) - (v00 + (v10 - v00) * tx)) * ty;
}

/**
 * Priority-queued, worker-decoded, seamlessly edge-stitched, LRU-evicted tile cache
 * for terrain (257x257 vertex-aligned height + precomputed normal/AO), imagery, and cover.
 */
export function createTileCache({ engine, manifests, tierConfig }) {
  let config = tierConfig;
  let disposed = false;

  const cache = new Map(); // key -> entry (MRU order)
  const terrainFast = new Map(); // numKey -> entry
  const coverFast = new Map(); // numKey -> entry
  const pendingQueue = new Map(); // key -> { key, kind, z, x, y, priority }
  const inflight = new Map(); // reqId -> { key, kind, z, x, y, priority, worker }
  const inflightKeys = new Set();
  const uploadQueue = []; // decoded payloads waiting for budgeted GPU texture creation
  const uploadKeys = new Set();
  const failedAt = new Map(); // key -> timestamp ms
  const waiters = new Set(); // callbacks notified whenever a tile settles

  let totalBytes = 0;
  let nextReqId = 1;
  let currentMaxAniso = engine.quality.maxAnisotropy || 4;
  const fetchCounts = { terrain: 0, imagery: 0, cover: 0 };

  // Fallback 1x1 textures so shader uniforms always have a valid bound sampler
  const fallbackHeightTex = new THREE.DataTexture(
    new Uint8Array([138, 107, 0, 255]), // ~2667m
    1,
    1,
    THREE.RGBAFormat,
  );
  fallbackHeightTex.minFilter = THREE.NearestFilter;
  fallbackHeightTex.magFilter = THREE.NearestFilter;
  fallbackHeightTex.flipY = false;
  fallbackHeightTex.needsUpdate = true;

  const fallbackNormalAoTex = new THREE.DataTexture(
    new Uint8Array([128, 128, 224, 0]), // up normal (0,1,0), AO=0.88, slope=0
    1,
    1,
    THREE.RGBAFormat,
  );
  fallbackNormalAoTex.colorSpace = THREE.NoColorSpace;
  fallbackNormalAoTex.minFilter = THREE.LinearFilter;
  fallbackNormalAoTex.magFilter = THREE.LinearFilter;
  fallbackNormalAoTex.flipY = false;
  fallbackNormalAoTex.needsUpdate = true;

  const fallbackImageryTex = new THREE.DataTexture(
    new Uint8Array([92, 106, 82, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  fallbackImageryTex.colorSpace = THREE.SRGBColorSpace;
  fallbackImageryTex.minFilter = THREE.LinearFilter;
  fallbackImageryTex.magFilter = THREE.LinearFilter;
  fallbackImageryTex.flipY = false;
  fallbackImageryTex.needsUpdate = true;

  const fallbackCoverTex = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
    THREE.RGBAFormat,
  );
  fallbackCoverTex.minFilter = THREE.LinearFilter;
  fallbackCoverTex.magFilter = THREE.LinearFilter;
  fallbackCoverTex.flipY = false;
  fallbackCoverTex.needsUpdate = true;

  const workerCount =
    typeof navigator !== 'undefined' && (navigator.hardwareConcurrency || 4) >= 4 ? 2 : 1;
  const workers = [];
  let rrWorker = 0;

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => handleWorkerMessage(e.data);
    w.onerror = (err) => console.error('[terrain:worker] error:', err);
    workers.push(w);
  }

  function notifyWaiters(key) {
    for (const fn of waiters) fn(key);
  }

  /**
   * Recompute normal+AO along a border strip after stitching/feathering heights so
   * there are zero lighting creases across tile seams.
   */
  function refreshBorderNormals(entry, x0, x1, y0, y1) {
    const gw = entry.width;
    const gh = entry.height;
    const heights = entry.heights;
    const out = entry.normalAoRgba;
    const cellM = Math.max(0.25, (entry.bounds.maxX - entry.bounds.minX) / (gw - 1));
    const inv2Cell = 0.5 / cellM;
    const invCell = 1.0 / cellM;

    const sx0 = Math.max(0, x0);
    const sx1 = Math.min(gw - 1, x1);
    const sy0 = Math.max(0, y0);
    const sy1 = Math.min(gh - 1, y1);

    for (let gy = sy0; gy <= sy1; gy++) {
      const ym = gy > 0 ? gy - 1 : 0;
      const yp = gy < gh - 1 ? gy + 1 : gh - 1;
      const invDz = gy > 0 && gy < gh - 1 ? inv2Cell : invCell;
      for (let gx = sx0; gx <= sx1; gx++) {
        const xm = gx > 0 ? gx - 1 : 0;
        const xp = gx < gw - 1 ? gx + 1 : gw - 1;
        const invDx = gx > 0 && gx < gw - 1 ? inv2Cell : invCell;

        const hC = heights[gy * gw + gx];
        const hL = heights[gy * gw + xm];
        const hR = heights[gy * gw + xp];
        const hN = heights[ym * gw + gx];
        const hS = heights[yp * gw + gx];

        const dX = (hL - hR) * invDx;
        const dZ = (hN - hS) * invDz;
        const invLen = 1.0 / Math.hypot(dX, 1.0, dZ);
        const nx = dX * invLen;
        const ny = invLen;
        const nz = dZ * invLen;
        const avgNbr = 0.25 * (hL + hR + hN + hS);
        const ao = Math.max(0.45, Math.min(1.0, 0.80 + (hC - avgNbr) * invCell * 0.55));
        const slope = Math.max(0, Math.min(1, 1.0 - ny));

        const p = (gy * gw + gx) * 4;
        out[p] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
        out[p + 1] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
        out[p + 2] = Math.round(ao * 255);
        out[p + 3] = Math.round(slope * 255);
      }
    }
    entry.normalAoTex.needsUpdate = true;
  }

  /**
   * Average shared normal pixels along a stitched seam between two same-zoom tiles.
   */
  function averageSeamNormals(a, b, vertical) {
    const gw = a.width;
    const gh = a.height;
    const outA = a.normalAoRgba;
    const outB = b.normalAoRgba;
    if (vertical) {
      // a's East col (gw-1) <-> b's West col (0)
      for (let gy = 0; gy < gh; gy++) {
        const pA = (gy * gw + (gw - 1)) * 4;
        const pB = (gy * gw) * 4;
        for (let c = 0; c < 4; c++) {
          const avg = (outA[pA + c] + outB[pB + c]) >> 1;
          outA[pA + c] = avg;
          outB[pB + c] = avg;
        }
      }
    } else {
      // a's South row (gh-1) <-> b's North row (0)
      const rowA = (gh - 1) * gw;
      for (let gx = 0; gx < gw; gx++) {
        const pA = (rowA + gx) * 4;
        const pB = gx * 4;
        for (let c = 0; c < 4; c++) {
          const avg = (outA[pA + c] + outB[pB + c]) >> 1;
          outA[pA + c] = avg;
          outB[pB + c] = avg;
        }
      }
    }
    a.normalAoTex.needsUpdate = true;
    b.normalAoTex.needsUpdate = true;
  }

  /**
   * Seamlessly stitch a newly uploaded terrain tile against:
   * 1. Any resident same-zoom cardinal neighbors (exact 0.000 m shared boundary!)
   * 2. Its parent (z-1) tile along edges whose same-zoom neighbor is NOT resident yet
   *    (or doesn't exist in the z15 manifest), completely eliminating vertical cliff step walls!
   * When a missing neighbor later arrives, we restore the unfeathered margin and stitch exact.
   */
  function stitchTerrainTile(entry) {
    const { z, x, y, width: gw, height: gh, srcSize: w } = entry;
    const maxG = gw - 1;
    const FEATHER_PX = 8;

    const stitchVertical = (left, right) => {
      const lE = left.edgeE;
      const rW = right.edgeW;
      if (!lE || !rW || left.width !== right.width) return;

      // Restore any feathered margin on left's East edge & right's West edge before stitching
      restoreFeatheredMargin(left, 'E');
      restoreFeatheredMargin(right, 'W');

      for (let gy = 0; gy < gh; gy++) {
        const y0 = gy > 0 ? gy - 1 : 0;
        const y1 = gy < w ? gy : w - 1;
        const h = 0.25 * (lE[y0] + lE[y1] + rW[y0] + rW[y1]);
        const idxL = gy * gw + maxG;
        const idxR = gy * gw;
        left.heights[idxL] = h;
        right.heights[idxR] = h;
        encodeTerrariumPixel(left.rgba, idxL * 4, h);
        encodeTerrariumPixel(right.rgba, idxR * 4, h);
      }
      left.stitchedE = true;
      right.stitchedW = true;
      left.texture.needsUpdate = true;
      right.texture.needsUpdate = true;
      refreshBorderNormals(left, maxG - 2, maxG, 0, maxG);
      refreshBorderNormals(right, 0, 2, 0, maxG);
      averageSeamNormals(left, right, true);
    };

    const stitchHorizontal = (north, south) => {
      const nS = north.edgeS;
      const sN = south.edgeN;
      if (!nS || !sN || north.width !== south.width) return;

      restoreFeatheredMargin(north, 'S');
      restoreFeatheredMargin(south, 'N');

      const rowN = maxG * gw;
      for (let gx = 0; gx < gw; gx++) {
        const x0 = gx > 0 ? gx - 1 : 0;
        const x1 = gx < w ? gx : w - 1;
        const h = 0.25 * (nS[x0] + nS[x1] + sN[x0] + sN[x1]);
        const idxN = rowN + gx;
        const idxS = gx;
        north.heights[idxN] = h;
        south.heights[idxS] = h;
        encodeTerrariumPixel(north.rgba, idxN * 4, h);
        encodeTerrariumPixel(south.rgba, idxS * 4, h);
      }
      north.stitchedS = true;
      south.stitchedN = true;
      north.texture.needsUpdate = true;
      south.texture.needsUpdate = true;
      refreshBorderNormals(north, 0, maxG, maxG - 2, maxG);
      refreshBorderNormals(south, 0, maxG, 0, 2);
      averageSeamNormals(north, south, false);
    };

    function saveUnfeatheredMargin(tile, side) {
      if (!tile.savedMargins) tile.savedMargins = {};
      if (tile.savedMargins[side]) return;
      const buf = new Float32Array(gw * FEATHER_PX);
      if (side === 'W') {
        for (let gy = 0; gy < gh; gy++) {
          for (let d = 0; d < FEATHER_PX; d++) buf[gy * FEATHER_PX + d] = tile.heights[gy * gw + d];
        }
      } else if (side === 'E') {
        for (let gy = 0; gy < gh; gy++) {
          for (let d = 0; d < FEATHER_PX; d++) buf[gy * FEATHER_PX + d] = tile.heights[gy * gw + (maxG - d)];
        }
      } else if (side === 'N') {
        for (let d = 0; d < FEATHER_PX; d++) {
          for (let gx = 0; gx < gw; gx++) buf[d * gw + gx] = tile.heights[d * gw + gx];
        }
      } else if (side === 'S') {
        for (let d = 0; d < FEATHER_PX; d++) {
          for (let gx = 0; gx < gw; gx++) buf[d * gw + gx] = tile.heights[(maxG - d) * gw + gx];
        }
      }
      tile.savedMargins[side] = buf;
    }

    function restoreFeatheredMargin(tile, side) {
      const buf = tile.savedMargins?.[side];
      if (!buf) return;
      if (side === 'W') {
        for (let gy = 0; gy < gh; gy++) {
          for (let d = 0; d < FEATHER_PX; d++) {
            const idx = gy * gw + d;
            tile.heights[idx] = buf[gy * FEATHER_PX + d];
            encodeTerrariumPixel(tile.rgba, idx * 4, tile.heights[idx]);
          }
        }
        refreshBorderNormals(tile, 0, FEATHER_PX + 1, 0, maxG);
      } else if (side === 'E') {
        for (let gy = 0; gy < gh; gy++) {
          for (let d = 0; d < FEATHER_PX; d++) {
            const idx = gy * gw + (maxG - d);
            tile.heights[idx] = buf[gy * FEATHER_PX + d];
            encodeTerrariumPixel(tile.rgba, idx * 4, tile.heights[idx]);
          }
        }
        refreshBorderNormals(tile, maxG - FEATHER_PX - 1, maxG, 0, maxG);
      } else if (side === 'N') {
        for (let d = 0; d < FEATHER_PX; d++) {
          for (let gx = 0; gx < gw; gx++) {
            const idx = d * gw + gx;
            tile.heights[idx] = buf[d * gw + gx];
            encodeTerrariumPixel(tile.rgba, idx * 4, tile.heights[idx]);
          }
        }
        refreshBorderNormals(tile, 0, maxG, 0, FEATHER_PX + 1);
      } else if (side === 'S') {
        for (let d = 0; d < FEATHER_PX; d++) {
          for (let gx = 0; gx < gw; gx++) {
            const idx = (maxG - d) * gw + gx;
            tile.heights[idx] = buf[d * gw + gx];
            encodeTerrariumPixel(tile.rgba, idx * 4, tile.heights[idx]);
          }
        }
        refreshBorderNormals(tile, 0, maxG, maxG - FEATHER_PX - 1, maxG);
      }
      delete tile.savedMargins[side];
      tile.texture.needsUpdate = true;
    }

    function featherEdgeToParent(tile, side, parent) {
      if (!parent || !parent.heights) return;
      saveUnfeatheredMargin(tile, side);
      const offX = (tile.x & 1) * 0.5;
      const offY = (tile.y & 1) * 0.5;

      if (side === 'W' || side === 'E') {
        for (let gy = 0; gy < gh; gy++) {
          const pv = offY + (gy / maxG) * 0.5;
          for (let d = 0; d < FEATHER_PX; d++) {
            const gx = side === 'W' ? d : maxG - d;
            const pu = offX + (gx / maxG) * 0.5;
            const pH = sampleVertexGridBilinear(parent.heights, parent.width, pu, pv);
            const t = 1 - d / FEATHER_PX;
            const blend = t * t * (3 - 2 * t);
            const idx = gy * gw + gx;
            tile.heights[idx] = tile.heights[idx] * (1 - blend) + pH * blend;
            encodeTerrariumPixel(tile.rgba, idx * 4, tile.heights[idx]);
          }
        }
        refreshBorderNormals(
          tile,
          side === 'W' ? 0 : maxG - FEATHER_PX - 1,
          side === 'W' ? FEATHER_PX + 1 : maxG,
          0,
          maxG,
        );
      } else {
        for (let gx = 0; gx < gw; gx++) {
          const pu = offX + (gx / maxG) * 0.5;
          for (let d = 0; d < FEATHER_PX; d++) {
            const gy = side === 'N' ? d : maxG - d;
            const pv = offY + (gy / maxG) * 0.5;
            const pH = sampleVertexGridBilinear(parent.heights, parent.width, pu, pv);
            const t = 1 - d / FEATHER_PX;
            const blend = t * t * (3 - 2 * t);
            const idx = gy * gw + gx;
            tile.heights[idx] = tile.heights[idx] * (1 - blend) + pH * blend;
            encodeTerrariumPixel(tile.rgba, idx * 4, tile.heights[idx]);
          }
        }
        refreshBorderNormals(
          tile,
          0,
          maxG,
          side === 'N' ? 0 : maxG - FEATHER_PX - 1,
          side === 'N' ? FEATHER_PX + 1 : maxG,
        );
      }
      tile.texture.needsUpdate = true;
    }

    const parent = z > config.minQuadZoom ? terrainFast.get(numKey(z - 1, x >> 1, y >> 1)) : null;

    const nbrW = terrainFast.get(numKey(z, x - 1, y));
    if (nbrW) stitchVertical(nbrW, entry);
    else if (parent) featherEdgeToParent(entry, 'W', parent);

    const nbrE = terrainFast.get(numKey(z, x + 1, y));
    if (nbrE) stitchVertical(entry, nbrE);
    else if (parent) featherEdgeToParent(entry, 'E', parent);

    const nbrN = terrainFast.get(numKey(z, x, y - 1));
    if (nbrN) stitchHorizontal(nbrN, entry);
    else if (parent) featherEdgeToParent(entry, 'N', parent);

    const nbrS = terrainFast.get(numKey(z, x, y + 1));
    if (nbrS) stitchHorizontal(entry, nbrS);
    else if (parent) featherEdgeToParent(entry, 'S', parent);

    // Exact 4-way corner stitch where 4 same-zoom tiles meet (0.000m corner seams on sheer cliffs)
    const stitchCorner4 = (tl, tr, bl, br) => {
      if (!tl || !tr || !bl || !br) return;
      const h = 0.25 * (tl.edgeE[w - 1] + tr.edgeW[w - 1] + bl.edgeE[0] + br.edgeW[0]);
      const targets = [
        [tl, maxG * gw + maxG],
        [tr, maxG * gw],
        [bl, maxG],
        [br, 0],
      ];
      for (let i = 0; i < 4; i++) {
        const [t, idx] = targets[i];
        t.heights[idx] = h;
        encodeTerrariumPixel(t.rgba, idx * 4, h);
        t.texture.needsUpdate = true;
      }
    };
    const nbrNW = terrainFast.get(numKey(z, x - 1, y - 1));
    const nbrNE = terrainFast.get(numKey(z, x + 1, y - 1));
    const nbrSW = terrainFast.get(numKey(z, x - 1, y + 1));
    const nbrSE = terrainFast.get(numKey(z, x + 1, y + 1));
    if (nbrNW && nbrN && nbrW) stitchCorner4(nbrNW, nbrN, nbrW, entry);
    if (nbrN && nbrNE && nbrE) stitchCorner4(nbrN, nbrNE, entry, nbrE);
    if (nbrW && nbrSW && nbrS) stitchCorner4(nbrW, entry, nbrSW, nbrS);
    if (nbrE && nbrS && nbrSE) stitchCorner4(entry, nbrE, nbrS, nbrSE);

    // If any z+1 children were already loaded with un-stitched edges, feather them cleanly to us
    if (z < config.maxTerrainZoom) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dx = 0; dx <= 1; dx++) {
          const child = terrainFast.get(numKey(z + 1, x * 2 + dx, y * 2 + dy));
          if (!child) continue;
          if (!child.stitchedW && !child.savedMargins?.W) featherEdgeToParent(child, 'W', entry);
          if (!child.stitchedE && !child.savedMargins?.E) featherEdgeToParent(child, 'E', entry);
          if (!child.stitchedN && !child.savedMargins?.N) featherEdgeToParent(child, 'N', entry);
          if (!child.stitchedS && !child.savedMargins?.S) featherEdgeToParent(child, 'S', entry);
        }
      }
    }
  }

  function handleWorkerMessage(msg) {
    if (disposed || !msg) return;
    const job = inflight.get(msg.id);
    if (!job) {
      if (msg.bitmap) msg.bitmap.close();
      return;
    }
    inflight.delete(msg.id);
    inflightKeys.delete(job.key);

    if (!msg.ok) {
      if (msg.bitmap) msg.bitmap.close();
      if (!msg.aborted) {
        failedAt.set(job.key, performance.now());
      }
      notifyWaiters(job.key);
      pumpQueue();
      return;
    }

    uploadQueue.push({ job, msg });
    uploadKeys.add(job.key);
    uploadQueue.sort((a, b) => a.job.priority - b.job.priority);
    scheduleUploadSlice();
    pumpQueue();
  }

  let uploadScheduled = false;
  function scheduleUploadSlice() {
    if (uploadScheduled || disposed || uploadQueue.length === 0) return;
    uploadScheduled = true;
    engine.scheduler.enqueue(
      () => {
        uploadScheduled = false;
        if (disposed) return false;
        processUploads(config.uploadsPerFrame);
        if (uploadQueue.length > 0) {
          scheduleUploadSlice();
        }
        return false;
      },
      { priority: 5, label: 'terrain-gpu-upload' },
    );
  }

  function decodeBitmapOnMainThread(kind, bitmap, tileWorldSize) {
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const data = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
    if (kind === 'cover') return { width: w, height: h, rgba: data };

    // Terrain fallback decode (only on browsers lacking OffscreenCanvas in workers)
    const raw = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      raw[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
    }
    const gw = w + 1;
    const gh = h + 1;
    const heights = new Float32Array(gw * gh);
    const rgba = new Uint8Array(gw * gh * 4);
    const normalAoRgba = new Uint8Array(gw * gh * 4);
    let minH = Infinity;
    let maxH = -Infinity;
    for (let gy = 0; gy < gh; gy++) {
      const y0 = gy > 0 ? gy - 1 : 0;
      const y1 = gy < h ? gy : h - 1;
      for (let gx = 0; gx < gw; gx++) {
        const x0 = gx > 0 ? gx - 1 : 0;
        const x1 = gx < w ? gx : w - 1;
        const elev =
          0.25 * (raw[y0 * w + x0] + raw[y0 * w + x1] + raw[y1 * w + x0] + raw[y1 * w + x1]);
        const idx = gy * gw + gx;
        heights[idx] = elev;
        if (elev < minH) minH = elev;
        if (elev > maxH) maxH = elev;
        encodeTerrariumPixel(rgba, idx * 4, elev);
        normalAoRgba[idx * 4] = 128;
        normalAoRgba[idx * 4 + 1] = 128;
        normalAoRgba[idx * 4 + 2] = 215;
        normalAoRgba[idx * 4 + 3] = 0;
      }
    }
    const edgeW = new Float32Array(h);
    const edgeE = new Float32Array(h);
    const edgeN = new Float32Array(w);
    const edgeS = new Float32Array(w);
    for (let y = 0; y < h; y++) {
      edgeW[y] = raw[y * w];
      edgeE[y] = raw[y * w + (w - 1)];
    }
    for (let x = 0; x < w; x++) {
      edgeN[x] = raw[x];
      edgeS[x] = raw[(h - 1) * w + x];
    }
    const cellM = Math.max(0.25, (tileWorldSize || 1000) / w);
    const inv2Cell = 0.5 / cellM;
    const invCell = 1.0 / cellM;
    for (let gy = 0; gy < gh; gy++) {
      const ym = gy > 0 ? gy - 1 : 0;
      const yp = gy < gh - 1 ? gy + 1 : gh - 1;
      const invDz = gy > 0 && gy < gh - 1 ? inv2Cell : invCell;
      for (let gx = 0; gx < gw; gx++) {
        const xm = gx > 0 ? gx - 1 : 0;
        const xp = gx < gw - 1 ? gx + 1 : gw - 1;
        const invDx = gx > 0 && gx < gw - 1 ? inv2Cell : invCell;
        const hC = heights[gy * gw + gx];
        const hL = heights[gy * gw + xm];
        const hR = heights[gy * gw + xp];
        const hN = heights[ym * gw + gx];
        const hS = heights[yp * gw + gx];
        const dX = (hL - hR) * invDx;
        const dZ = (hN - hS) * invDz;
        const invLen = 1.0 / Math.hypot(dX, 1.0, dZ);
        const ao = Math.max(0.45, Math.min(1.0, 0.8 + (hC - 0.25 * (hL + hR + hN + hS)) * invCell * 0.55));
        const p = (gy * gw + gx) * 4;
        normalAoRgba[p] = Math.max(0, Math.min(255, Math.round((dX * invLen * 0.5 + 0.5) * 255)));
        normalAoRgba[p + 1] = Math.max(0, Math.min(255, Math.round((dZ * invLen * 0.5 + 0.5) * 255)));
        normalAoRgba[p + 2] = Math.round(ao * 255);
        normalAoRgba[p + 3] = Math.round(Math.max(0, Math.min(1, 1 - invLen)) * 255);
      }
    }
    return {
      width: gw,
      height: gh,
      srcSize: w,
      heights,
      rgba,
      normalAoRgba,
      edgeW,
      edgeE,
      edgeN,
      edgeS,
      minH,
      maxH,
    };
  }

  function createEntryFromDecoded(job, msg) {
    const { kind, z, x, y, key } = job;
    if (msg.needsMainDecode && msg.bitmap) {
      Object.assign(msg, decodeBitmapOnMainThread(kind, msg.bitmap, msg.tileWorldSize));
      msg.bitmap = null;
    }

    const now = performance.now();

    if (kind === 'terrain') {
      const texture = new THREE.DataTexture(msg.rgba, msg.width, msg.height, THREE.RGBAFormat);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;

      const normalAoTex = new THREE.DataTexture(
        msg.normalAoRgba,
        msg.width,
        msg.height,
        THREE.RGBAFormat,
      );
      normalAoTex.colorSpace = THREE.NoColorSpace;
      normalAoTex.minFilter = THREE.LinearFilter;
      normalAoTex.magFilter = THREE.LinearFilter;
      normalAoTex.generateMipmaps = false;
      normalAoTex.flipY = false;
      normalAoTex.wrapS = THREE.ClampToEdgeWrapping;
      normalAoTex.wrapT = THREE.ClampToEdgeWrapping;
      normalAoTex.needsUpdate = true;

      const bytes =
        msg.heights.byteLength + msg.rgba.byteLength + msg.normalAoRgba.byteLength;
      const bounds = tileBoundsWorld(z, x, y);
      return {
        key,
        kind,
        z,
        x,
        y,
        bounds,
        invW: 1 / (bounds.maxX - bounds.minX),
        invH: 1 / (bounds.maxZ - bounds.minZ),
        width: msg.width,
        height: msg.height,
        srcSize: msg.srcSize || msg.width - 1,
        heights: msg.heights,
        rgba: msg.rgba,
        normalAoRgba: msg.normalAoRgba,
        edgeW: msg.edgeW,
        edgeE: msg.edgeE,
        edgeN: msg.edgeN,
        edgeS: msg.edgeS,
        minH: msg.minH,
        maxH: msg.maxH,
        texture,
        normalAoTex,
        bytes,
        loadedAt: now,
      };
    }

    if (kind === 'imagery') {
      const texture = new THREE.Texture(msg.bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = currentMaxAniso;
      texture.needsUpdate = true;
      const bytes = Math.round(msg.width * msg.height * 4 * 1.33);
      return {
        key,
        kind,
        z,
        x,
        y,
        width: msg.width,
        height: msg.height,
        bitmap: msg.bitmap,
        texture,
        bytes,
        loadedAt: now,
      };
    }

    // kind === 'cover'
    const texture = new THREE.DataTexture(msg.rgba, msg.width, msg.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    const bytes = msg.rgba.byteLength * 2;
    const bounds = tileBoundsWorld(z, x, y);
    return {
      key,
      kind,
      z,
      x,
      y,
      bounds,
      invW: 1 / (bounds.maxX - bounds.minX),
      invH: 1 / (bounds.maxZ - bounds.minZ),
      width: msg.width,
      height: msg.height,
      rgba: msg.rgba,
      texture,
      bytes,
      loadedAt: now,
    };
  }

  let isUploading = false;
  function processUploads(limit = config.uploadsPerFrame, timeBudgetMs = limit <= 2 ? 2.5 : 3.5) {
    if (isUploading) return;
    isUploading = true;
    try {
      const start = performance.now();
      let count = 0;
      while (uploadQueue.length > 0 && count < limit) {
        if (count > 0 && performance.now() - start > timeBudgetMs) break;
        const { job, msg } = uploadQueue.shift();
        uploadKeys.delete(job.key);

        if (cache.has(job.key)) {
          if (msg.bitmap) msg.bitmap.close();
          notifyWaiters(job.key);
          continue;
        }

        const entry = createEntryFromDecoded(job, msg);
        cache.set(job.key, entry);
        if (entry.kind === 'terrain') {
          terrainFast.set(numKey(entry.z, entry.x, entry.y), entry);
          stitchTerrainTile(entry);
        } else if (entry.kind === 'cover') {
          coverFast.set(numKey(entry.z, entry.x, entry.y), entry);
        }
        totalBytes += entry.bytes;
        count++;
        notifyWaiters(job.key);
      }
      if (totalBytes > config.lruMaxBytes * 1.12) {
        evict(lastPinnedKeys);
      }
    } finally {
      isUploading = false;
    }
  }

  function pumpQueue() {
    if (disposed) return;
    while (inflight.size < config.maxConcurrentFetches && pendingQueue.size > 0) {
      let best = null;
      for (const item of pendingQueue.values()) {
        if (!best || item.priority < best.priority) best = item;
      }
      if (!best) break;
      pendingQueue.delete(best.key);

      if (cache.has(best.key) || inflightKeys.has(best.key)) continue;

      const src = resolveTileSource(
        best.kind,
        best.z,
        best.x,
        best.y,
        manifests,
        engine.assetsBase,
      );
      if (!src) {
        failedAt.set(best.key, performance.now() + 600000);
        notifyWaiters(best.key);
        continue;
      }

      const id = nextReqId++;
      const worker = workers[rrWorker++ % workers.length];
      best.worker = worker;
      inflight.set(id, best);
      inflightKeys.add(best.key);

      let tileWorldSize = 0;
      if (best.kind === 'terrain') {
        const b = tileBoundsWorld(best.z, best.x, best.y);
        tileWorldSize = b.maxX - b.minX;
      }

      fetchCounts[best.kind] = (fetchCounts[best.kind] || 0) + 1;
      worker.postMessage({
        cmd: 'decode',
        id,
        kind: best.kind,
        url: src.url,
        tileWorldSize,
      });
    }
  }

  function get(kind, z, x, y) {
    const key = tileKey(kind, z, x, y);
    const entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
      return entry;
    }
    return null;
  }

  function getFast(kind, z, x, y) {
    if (kind === 'terrain') return terrainFast.get(numKey(z, x, y)) || null;
    if (kind === 'cover') return coverFast.get(numKey(z, x, y)) || null;
    return cache.get(tileKey(kind, z, x, y)) || null;
  }

  function request(kind, z, x, y, priority = 100) {
    const key = tileKey(kind, z, x, y);
    if (cache.has(key)) return cache.get(key);

    const failTime = failedAt.get(key);
    if (failTime && performance.now() - failTime < 30000) return null;

    if (inflightKeys.has(key) || uploadKeys.has(key)) return null;

    const existing = pendingQueue.get(key);
    if (existing) {
      if (priority < existing.priority) existing.priority = priority;
      return null;
    }

    pendingQueue.set(key, { key, kind, z, x, y, priority });
    pumpQueue();
    return null;
  }

  function hasSource(kind, z, x, y) {
    const key = tileKey(kind, z, x, y);
    const failTime = failedAt.get(key);
    if (failTime && performance.now() - failTime < 30000) return false;
    return resolveTileSource(kind, z, x, y, manifests, engine.assetsBase) !== null;
  }

  /**
   * Drop stale far-away pending requests (never dropping near-camera or preload requests)
   * and abort inflight fetches that are no longer relevant after large teleports.
   */
  function clearPendingFar(activeTargetKeys = null) {
    if (pendingQueue.size > 140) {
      const sorted = Array.from(pendingQueue.values()).sort((a, b) => a.priority - b.priority);
      pendingQueue.clear();
      for (let i = 0; i < sorted.length; i++) {
        const item = sorted[i];
        // Always retain blocking preload items (priority < 0) and top 110 closest/needed tiles
        if (i < 110 || item.priority < 0 || (activeTargetKeys && activeTargetKeys.has(item.key))) {
          pendingQueue.set(item.key, item);
        } else {
          notifyWaiters(item.key);
        }
      }
    }

    // Abort stale non-preload inflight fetches after a teleport when far tiles hog worker slots
    if (activeTargetKeys && inflight.size >= config.maxConcurrentFetches) {
      for (const [id, job] of inflight) {
        if (job.priority >= 25000 && !activeTargetKeys.has(job.key)) {
          job.worker?.postMessage?.({ cmd: 'abort', id });
        }
      }
    }
  }

  let lastPinnedKeys = null;
  let preloadPinnedKeys = null;
  function setPreloadPinned(keys, clearTarget = null) {
    if (clearTarget) {
      if (preloadPinnedKeys === clearTarget) preloadPinnedKeys = null;
      return;
    }
    preloadPinnedKeys = keys || null;
    if (keys) lastPinnedKeys = keys;
  }

  function evict(pinnedKeys = lastPinnedKeys) {
    if (pinnedKeys) lastPinnedKeys = pinnedKeys;
    if (totalBytes <= config.lruMaxBytes) return;
    const now = performance.now();
    const targetBytes = config.lruMaxBytes * 0.85;
    const graceMs = totalBytes > config.lruMaxBytes * 1.15 ? 0 : 1500;

    for (const [key, entry] of cache) {
      if (totalBytes <= targetBytes) break;
      if ((pinnedKeys && pinnedKeys.has(key)) || (preloadPinnedKeys && preloadPinnedKeys.has(key))) {
        continue;
      }
      // Keep z<=9 cached when under hard cap, but allow evicting off-frustum z9 tiles on low-VRAM tiers
      if (entry.z <= 9 && totalBytes <= config.lruMaxBytes * 1.05) continue;
      if (graceMs > 0 && now - entry.loadedAt < graceMs) continue;

      cache.delete(key);
      entry.evicted = true;
      if (entry.kind === 'terrain') {
        terrainFast.delete(numKey(entry.z, entry.x, entry.y));
        const nW = terrainFast.get(numKey(entry.z, entry.x - 1, entry.y));
        if (nW) nW.stitchedE = false;
        const nE = terrainFast.get(numKey(entry.z, entry.x + 1, entry.y));
        if (nE) nE.stitchedW = false;
        const nN = terrainFast.get(numKey(entry.z, entry.x, entry.y - 1));
        if (nN) nN.stitchedS = false;
        const nS = terrainFast.get(numKey(entry.z, entry.x, entry.y + 1));
        if (nS) nS.stitchedN = false;
        if (entry.normalAoTex) entry.normalAoTex.dispose();
      } else if (entry.kind === 'cover') {
        coverFast.delete(numKey(entry.z, entry.x, entry.y));
      }
      totalBytes -= entry.bytes;
      if (entry.texture) entry.texture.dispose();
      if (entry.bitmap) entry.bitmap.close();
    }
  }

  function setTierConfig(nextConfig) {
    config = nextConfig;
    const nextAniso = engine.quality.maxAnisotropy || 4;
    if (nextAniso !== currentMaxAniso) {
      currentMaxAniso = nextAniso;
      for (const entry of cache.values()) {
        if (entry.kind === 'imagery' && entry.texture) {
          entry.texture.anisotropy = currentMaxAniso;
          entry.texture.needsUpdate = true;
        }
      }
    }
    pumpQueue();
  }

  function onContextRestored() {
    fallbackHeightTex.needsUpdate = true;
    fallbackNormalAoTex.needsUpdate = true;
    fallbackImageryTex.needsUpdate = true;
    fallbackCoverTex.needsUpdate = true;
    for (const entry of cache.values()) {
      if (entry.texture) entry.texture.needsUpdate = true;
      if (entry.normalAoTex) entry.normalAoTex.needsUpdate = true;
    }
  }

  function onTileSettled(fn) {
    waiters.add(fn);
    return () => waiters.delete(fn);
  }

  function getStats() {
    return {
      cachedTiles: cache.size,
      totalMB: +(totalBytes / (1024 * 1024)).toFixed(2),
      pending: pendingQueue.size,
      inflight: inflight.size,
      uploadQueue: uploadQueue.length,
      fetches: { ...fetchCounts },
    };
  }

  function dispose() {
    disposed = true;
    waiters.clear();
    pendingQueue.clear();
    uploadQueue.forEach((u) => u.msg?.bitmap?.close?.());
    uploadQueue.length = 0;
    uploadKeys.clear();
    terrainFast.clear();
    coverFast.clear();
    for (const [id, job] of inflight) {
      job.worker?.postMessage?.({ cmd: 'abort', id });
    }
    inflight.clear();
    inflightKeys.clear();
    for (const w of workers) w.terminate();
    workers.length = 0;
    for (const entry of cache.values()) {
      if (entry.texture) entry.texture.dispose();
      if (entry.normalAoTex) entry.normalAoTex.dispose();
      if (entry.bitmap) entry.bitmap.close();
    }
    cache.clear();
    fallbackHeightTex.dispose();
    fallbackNormalAoTex.dispose();
    fallbackImageryTex.dispose();
    fallbackCoverTex.dispose();
  }

  return {
    get,
    getFast,
    request,
    hasSource,
    processUploads,
    clearPendingFar,
    evict,
    setPreloadPinned,
    setTierConfig,
    onContextRestored,
    onTileSettled,
    getStats,
    fallbackHeightTex,
    fallbackNormalAoTex,
    fallbackImageryTex,
    fallbackCoverTex,
    dispose,
  };
}
