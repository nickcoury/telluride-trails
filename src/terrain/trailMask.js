import * as THREE from 'three';
import { tileBoundsWorld } from '../core/geo.js';

/**
 * Rasterizes vector trails/roads/tracks from @traildata into per-tile 1-channel masks
 * for crisp, zero-z-fighting dirt ribbons directly in the terrain shader.
 */
export function createTrailMaskManager({ engine }) {
  const MAX_MASKS = 28;
  const MASK_SIZE = 512;

  const segments = []; // { id, minX, maxX, minZ, maxZ, widthM, strength, coords }
  const seenIds = new Set();
  const maskCache = new Map(); // tileKey -> { texture, revision, bytes }
  const pendingBuild = new Set();
  let revision = 1;
  let disposed = false;

  const fallbackMaskTex = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat);
  fallbackMaskTex.minFilter = THREE.LinearFilter;
  fallbackMaskTex.magFilter = THREE.LinearFilter;
  fallbackMaskTex.flipY = false;
  fallbackMaskTex.needsUpdate = true;

  let canvas = null;
  let ctx = null;

  function ensureCanvas() {
    if (canvas) return;
    canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(MASK_SIZE, MASK_SIZE)
        : Object.assign(document.createElement('canvas'), { width: MASK_SIZE, height: MASK_SIZE });
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  }

  function addTrailFeature(item) {
    if (!item || !item.coords || item.coords.length < 6) return;
    const id = item.id ?? `${item.kind}:${item.coords[0]}:${item.coords[2]}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const coords = item.coords;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < coords.length; i += 3) {
      const x = coords[i];
      const z = coords[i + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const kind = item.kind || 'trail';
    const isPaved = kind === 'road' && /asphalt|paved|concrete/i.test(item.surface || '');
    const defaultW = kind === 'road' ? 5.2 : kind === 'track' ? 3.5 : 2.1;
    const widthM = Math.max(1.6, item.widthM || defaultW);
    const strength = isPaved ? 0.36 : kind === 'road' ? 0.92 : kind === 'track' ? 0.88 : 0.84;

    segments.push({
      id,
      minX: minX - widthM,
      maxX: maxX + widthM,
      minZ: minZ - widthM,
      maxZ: maxZ + widthM,
      widthM,
      strength,
      coords,
    });
  }

  function ingestTrails(trails) {
    if (!Array.isArray(trails) || trails.length === 0) return;
    let added = 0;
    for (let i = 0; i < trails.length; i++) {
      const prevLen = segments.length;
      addTrailFeature(trails[i]);
      if (segments.length > prevLen) added++;
    }
    if (added > 0) {
      revision++;
      // Invalidate stale cached masks so new trails appear cleanly
      for (const entry of maskCache.values()) {
        entry.texture.dispose();
      }
      maskCache.clear();
    }
  }

  const offChunk = engine.events.on('data:chunk', (payload) => {
    const trails = payload?.added?.trails || payload?.trails;
    if (trails) ingestTrails(trails);
  });

  function buildMaskForTile(z, x, y, key) {
    if (disposed) return;
    const bounds = tileBoundsWorld(z, x, y);
    const tileW = bounds.maxX - bounds.minX;
    const tileH = bounds.maxZ - bounds.minZ;

    // Collect intersecting trails
    const hits = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.maxX < bounds.minX || s.minX > bounds.maxX || s.maxZ < bounds.minZ || s.minZ > bounds.maxZ) {
        continue;
      }
      hits.push(s);
    }

    if (hits.length === 0) {
      // Cache lightweight empty marker (shares fallbackMaskTex)
      maskCache.set(key, { empty: true, texture: fallbackMaskTex, revision });
      return;
    }

    ensureCanvas();
    ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pxPerM = MASK_SIZE / tileW;

    for (let h = 0; h < hits.length; h++) {
      const seg = hits[h];
      const c = seg.coords;
      const pxWidth = Math.max(1.25, seg.widthM * pxPerM);

      // Soft shoulder pass
      ctx.beginPath();
      for (let i = 0; i < c.length; i += 3) {
        const px = ((c[i] - bounds.minX) / tileW) * MASK_SIZE;
        const py = ((c[i + 2] - bounds.minZ) / tileH) * MASK_SIZE;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = `rgba(255,255,255,${(seg.strength * 0.42).toFixed(2)})`;
      ctx.lineWidth = pxWidth * 1.65;
      ctx.stroke();

      // Core ribbon pass
      ctx.strokeStyle = `rgba(255,255,255,${seg.strength.toFixed(2)})`;
      ctx.lineWidth = pxWidth;
      ctx.stroke();
    }

    const img = ctx.getImageData(0, 0, MASK_SIZE, MASK_SIZE).data;
    const red = new Uint8Array(MASK_SIZE * MASK_SIZE);
    for (let i = 0; i < red.length; i++) {
      red[i] = img[i * 4];
    }

    const tex = new THREE.DataTexture(red, MASK_SIZE, MASK_SIZE, THREE.RedFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    // LRU cap
    if (maskCache.size >= MAX_MASKS) {
      const oldestKey = maskCache.keys().next().value;
      const oldest = maskCache.get(oldestKey);
      if (oldest && !oldest.empty) oldest.texture.dispose();
      maskCache.delete(oldestKey);
    }

    maskCache.set(key, { empty: false, texture: tex, revision });
  }

  /**
   * Look up or lazily schedule a trail mask for tile (z, x, y).
   * Only builds masks for detail zooms (z >= 14) when trail segments exist.
   */
  function getMaskForTile(z, x, y) {
    if (segments.length === 0 || z < 14) return null;
    const key = `${z}/${x}/${y}`;
    const entry = maskCache.get(key);
    if (entry) {
      maskCache.delete(key);
      maskCache.set(key, entry);
      return entry.empty ? null : entry.texture;
    }

    if (!pendingBuild.has(key)) {
      pendingBuild.add(key);
      engine.scheduler.enqueue(
        () => {
          pendingBuild.delete(key);
          if (!disposed) buildMaskForTile(z, x, y, key);
          return false;
        },
        { priority: 12, label: `trail-mask-${key}` },
      );
    }
    return null;
  }

  function dispose() {
    disposed = true;
    offChunk();
    pendingBuild.clear();
    for (const entry of maskCache.values()) {
      if (!entry.empty) entry.texture.dispose();
    }
    maskCache.clear();
    fallbackMaskTex.dispose();
  }

  return {
    ingestTrails,
    getMaskForTile,
    fallbackMaskTex,
    dispose,
  };
}
