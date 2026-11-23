import * as THREE from 'three';
import { resolveTileSource } from './manifest.js';

function tileKey(kind, z, x, y) {
  return `${kind}:${z}/${x}/${y}`;
}

/**
 * Priority-queued, worker-decoded, LRU-evicted tile cache for terrain, imagery, and cover.
 * Ensures coarse-first progressive loading and budgeted GPU texture uploads per frame.
 */
export function createTileCache({ engine, manifests, tierConfig }) {
  let config = tierConfig;
  let disposed = false;

  const cache = new Map(); // key -> entry (MRU order via delete+set)
  const pendingQueue = new Map(); // key -> { key, kind, z, x, y, priority }
  const inflight = new Map(); // reqId -> { key, kind, z, x, y, priority }
  const inflightKeys = new Set();
  const uploadQueue = []; // decoded payloads waiting for budgeted GPU texture creation
  const failedAt = new Map(); // key -> timestamp ms
  const waiters = new Set(); // callbacks notified whenever a tile settles

  let totalBytes = 0;
  let nextReqId = 1;
  let currentMaxAniso = engine.quality.maxAnisotropy || 4;

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

  const workerCount = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency || 4) >= 4 ? 2 : 1;
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

  function createEntryFromDecoded(job, msg) {
    const { kind, z, x, y, key } = job;
    let texture = null;
    let bytes = 0;

    if (kind === 'terrain') {
      texture = new THREE.DataTexture(msg.rgba, msg.width, msg.height, THREE.RGBAFormat);
      texture.minFilter = THREE.NearestFilter;
      texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      bytes = msg.heights.byteLength + msg.rgba.byteLength;
      return {
        key,
        kind,
        z,
        x,
        y,
        width: msg.width,
        height: msg.height,
        heights: msg.heights,
        minH: msg.minH,
        maxH: msg.maxH,
        texture,
        bytes,
      };
    }

    if (kind === 'imagery') {
      texture = new THREE.Texture(msg.bitmap);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.flipY = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.anisotropy = currentMaxAniso;
      texture.needsUpdate = true;
      bytes = msg.width * msg.height * 4 * 1.33;
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
      };
    }

    // kind === 'cover'
    texture = new THREE.DataTexture(msg.rgba, msg.width, msg.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    bytes = msg.rgba.byteLength * 2;
    return {
      key,
      kind,
      z,
      x,
      y,
      width: msg.width,
      height: msg.height,
      rgba: msg.rgba,
      texture,
      bytes,
    };
  }

  function processUploads(limit = config.uploadsPerFrame) {
    const start = performance.now();
    let count = 0;
    while (uploadQueue.length > 0 && count < limit) {
      if (count > 0 && performance.now() - start > 4.0) break;
      const { job, msg } = uploadQueue.shift();

      if (cache.has(job.key)) {
        if (msg.bitmap) msg.bitmap.close();
        continue;
      }

      const entry = createEntryFromDecoded(job, msg);
      cache.set(job.key, entry);
      totalBytes += entry.bytes;
      count++;
      notifyWaiters(job.key);
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
      inflight.set(id, best);
      inflightKeys.add(best.key);

      const worker = workers[rrWorker++ % workers.length];
      worker.postMessage({ cmd: 'decode', id, kind: best.kind, url: src.url });
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

  /**
   * Request a tile if not already cached or recently failed.
   * Lower priority number = fetched sooner (coarse zooms boosted).
   */
  function request(kind, z, x, y, priority = 100) {
    const key = tileKey(kind, z, x, y);
    if (cache.has(key)) return cache.get(key);

    const failTime = failedAt.get(key);
    if (failTime && performance.now() - failTime < 30000) return null;

    if (inflightKeys.has(key)) return null;

    const existing = pendingQueue.get(key);
    if (existing) {
      if (priority < existing.priority) existing.priority = priority;
      return null;
    }

    pendingQueue.set(key, { key, kind, z, x, y, priority });
    pumpQueue();
    return null;
  }

  /**
   * Check whether a tile could potentially exist according to manifests/fallback.
   */
  function hasSource(kind, z, x, y) {
    const key = tileKey(kind, z, x, y);
    const failTime = failedAt.get(key);
    if (failTime && performance.now() - failTime < 30000) return false;
    return resolveTileSource(kind, z, x, y, manifests, engine.assetsBase) !== null;
  }

  function clearPendingFar() {
    // Keep queue bounded so rapid camera teleports don't stall behind stale tiles
    if (pendingQueue.size > 160) {
      const sorted = Array.from(pendingQueue.values()).sort((a, b) => a.priority - b.priority);
      pendingQueue.clear();
      for (let i = 0; i < 96; i++) {
        pendingQueue.set(sorted[i].key, sorted[i]);
      }
    }
  }

  function evict(pinnedKeys) {
    if (totalBytes <= config.lruMaxBytes) return;
    for (const [key, entry] of cache) {
      if (totalBytes <= config.lruMaxBytes * 0.88) break;
      if (entry.z <= 10 || (pinnedKeys && pinnedKeys.has(key))) continue;
      cache.delete(key);
      totalBytes -= entry.bytes;
      if (entry.texture) entry.texture.dispose();
      if (entry.bitmap) entry.bitmap.close();
    }
  }

  function setTierConfig(nextConfig) {
    config = nextConfig;
    currentMaxAniso = engine.quality.maxAnisotropy || 4;
    for (const entry of cache.values()) {
      if (entry.kind === 'imagery' && entry.texture) {
        entry.texture.anisotropy = currentMaxAniso;
        entry.texture.needsUpdate = true;
      }
    }
    pumpQueue();
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
    };
  }

  function dispose() {
    disposed = true;
    waiters.clear();
    pendingQueue.clear();
    uploadQueue.forEach((u) => u.msg?.bitmap?.close?.());
    uploadQueue.length = 0;
    for (const w of workers) w.terminate();
    workers.length = 0;
    for (const entry of cache.values()) {
      if (entry.texture) entry.texture.dispose();
      if (entry.bitmap) entry.bitmap.close();
    }
    cache.clear();
    fallbackHeightTex.dispose();
    fallbackImageryTex.dispose();
    fallbackCoverTex.dispose();
  }

  return {
    get,
    request,
    hasSource,
    processUploads,
    clearPendingFar,
    evict,
    setTierConfig,
    onTileSettled,
    getStats,
    fallbackHeightTex,
    fallbackImageryTex,
    fallbackCoverTex,
    dispose,
  };
}
