import * as THREE from 'three';
import { tileBoundsWorld, worldToTile } from '../core/geo.js';

const UNPAVED_SURFACE_RE =
  /\b(unpaved|dirt|gravel|fine_gravel|ground|earth|sand|rock|compacted|mud|grass|wood|pebblestone|cobblestone)\b/i;
const PAVED_SURFACE_RE = /\b(asphalt|paved|concrete|concrete:plates)\b/i;
const TOWN_STREET_NAME_RE =
  /\b(avenue|ave|street|st|drive|dr|court|ct|way|lane|ln|place|pl|boulevard|blvd|colorado|pacific|columbia|galena|gregory|oak|pine|spruce|fir|willow|aspen|main|greene|blair|reese|snowden|mahoney|davis|butcher)\b/i;

function classifyFeature(item, engine) {
  const kind = item.kind || 'trail';
  const surface = item.surface || '';
  const name = item.name || '';
  const coords = item.coords;

  // Approximate midpoint for town corridor check
  const midIdx = Math.floor(coords.length / 6) * 3;
  const midX = coords[midIdx];
  const midY = coords[midIdx + 1];
  const midZ = coords[midIdx + 2];
  const inTown = Boolean(engine.worldBuildingMask?.isInTownCorridor?.(midX, midZ));

  if (kind === 'road') {
    // Check UNPAVED first so "unpaved" never matches "paved"!
    if (UNPAVED_SURFACE_RE.test(surface)) {
      return {
        category: 'dirt',
        widthM: Math.max(3.6, item.widthM || 4.4),
        strength: 0.96,
        hasSidewalk: false,
      };
    }
    if (PAVED_SURFACE_RE.test(surface)) {
      const isMain = /\b(colorado|main|greene|highway|hwy)\b/i.test(name);
      return {
        category: 'paved',
        widthM: Math.max(isMain ? 9.5 : 6.6, item.widthM || (isMain ? 9.5 : 6.6)),
        strength: 1.0,
        // Sidewalks/curbs ONLY inside actual town corridors, never on mountain highways!
        hasSidewalk: inTown,
      };
    }
    // Unspecified surface: classify as paved ONLY inside town corridors or low-elevation named town streets;
    // backcountry mountain roads (Imogene Pass Rd, Bridal Veil Rd, Tomboy Rd) are rugged dirt roads!
    if (inTown || (midY < 2840 && TOWN_STREET_NAME_RE.test(name))) {
      const isMain = /\b(colorado|main|greene)\b/i.test(name);
      return {
        category: 'paved',
        widthM: Math.max(isMain ? 9.5 : 6.4, item.widthM || (isMain ? 9.5 : 6.4)),
        strength: 1.0,
        hasSidewalk: inTown && Boolean(name),
      };
    }
    return {
      category: 'dirt',
      widthM: Math.max(3.4, item.widthM || 4.2),
      strength: 0.94,
      hasSidewalk: false,
    };
  }

  if (kind === 'track') {
    return {
      category: 'dirt',
      widthM: Math.max(2.8, item.widthM || 3.4),
      strength: 0.92,
      hasSidewalk: false,
    };
  }

  // trail / path singletrack
  return {
    category: 'dirt',
    widthM: Math.max(1.5, Math.min(2.6, item.widthM || 1.9)),
    strength: 0.94,
    hasSidewalk: false,
  };
}

/**
 * Rasterizes vector trails, jeep roads, and paved town streets from @traildata into
 * 3-channel semantic RGB CanvasTextures (zero getImageData CPU readback):
 *   R = dirt singletrack / jeep track / unpaved road tread & soft worn shoulder
 *   G = paved asphalt carriageway
 *   B = concrete sidewalk & curb apron flanking paved town streets
 * Features spatial AABB invalidation on data:chunk and 2-frame deferred disposal.
 */
export function createTrailMaskManager({ engine, tierConfig }) {
  const MAX_MASKS = 48;
  let maskSize = tierConfig?.trailMaskSize || 256;

  const segments = []; // { id, minX, maxX, minZ, maxZ, widthM, strength, category, hasSidewalk, coords }
  const seenIds = new Set();
  const maskCache = new Map(); // key -> { empty, minX, maxX, minZ, maxZ, size, canvas?, texture }
  const pendingBuild = new Set();
  const canvasPool = new Map(); // size -> HTMLCanvasElement[]
  const deferredRelease = []; // { entry, framesLeft }
  let disposed = false;

  const fallbackMaskTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  fallbackMaskTex.colorSpace = THREE.NoColorSpace;
  fallbackMaskTex.minFilter = THREE.LinearFilter;
  fallbackMaskTex.magFilter = THREE.LinearFilter;
  fallbackMaskTex.flipY = false;
  fallbackMaskTex.needsUpdate = true;

  function acquireCanvas(size) {
    const pool = canvasPool.get(size);
    if (pool && pool.length > 0) return pool.pop();
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      return c;
    }
    return new OffscreenCanvas(size, size);
  }

  function releaseEntryNow(entry) {
    if (!entry || entry.empty) return;
    entry.texture.dispose();
    if (entry.canvas) {
      let pool = canvasPool.get(entry.size);
      if (!pool) {
        pool = [];
        canvasPool.set(entry.size, pool);
      }
      if (pool.length < MAX_MASKS) pool.push(entry.canvas);
    }
  }

  function releaseEntry(entry) {
    if (!entry || entry.empty) return;
    // Defer disposal & canvas pooling by 2 frames so active draw calls never read disposed/recycled textures
    deferredRelease.push({ entry, framesLeft: 2 });
  }

  function flushDeferred() {
    for (let i = deferredRelease.length - 1; i >= 0; i--) {
      if (--deferredRelease[i].framesLeft <= 0) {
        releaseEntryNow(deferredRelease[i].entry);
        deferredRelease.splice(i, 1);
      }
    }
  }

  function addTrailFeature(item) {
    if (!item || !item.coords || item.coords.length < 6) return null;
    const id = item.id ?? `${item.kind}:${item.coords[0]}:${item.coords[2]}`;
    if (seenIds.has(id)) return null;
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

    const cls = classifyFeature(item, engine);
    const pad = cls.widthM * 1.5 + (cls.hasSidewalk ? 4.0 : 1.5);

    const seg = {
      id,
      minX: minX - pad,
      maxX: maxX + pad,
      minZ: minZ - pad,
      maxZ: maxZ + pad,
      widthM: cls.widthM,
      strength: cls.strength,
      category: cls.category,
      hasSidewalk: cls.hasSidewalk,
      coords,
    };
    segments.push(seg);
    return seg;
  }

  function ingestTrails(trails) {
    if (!Array.isArray(trails) || trails.length === 0) return;
    let addMinX = Infinity;
    let addMaxX = -Infinity;
    let addMinZ = Infinity;
    let addMaxZ = -Infinity;
    let added = 0;

    for (let i = 0; i < trails.length; i++) {
      const seg = addTrailFeature(trails[i]);
      if (seg) {
        added++;
        if (seg.minX < addMinX) addMinX = seg.minX;
        if (seg.maxX > addMaxX) addMaxX = seg.maxX;
        if (seg.minZ < addMinZ) addMinZ = seg.minZ;
        if (seg.maxZ > addMaxZ) addMaxZ = seg.maxZ;
      }
    }

    if (added > 0 && maskCache.size > 0) {
      // Only invalidate cached tiles whose bounds intersect the newly ingested trail chunk
      for (const [key, entry] of maskCache) {
        if (
          entry.maxX < addMinX ||
          entry.minX > addMaxX ||
          entry.maxZ < addMinZ ||
          entry.minZ > addMaxZ
        ) {
          continue;
        }
        releaseEntry(entry);
        maskCache.delete(key);
      }
    }
  }

  const offChunk = engine.events.on('data:chunk', (payload) => {
    const trails = payload?.added?.trails || payload?.trails;
    if (trails) ingestTrails(trails);
  });

  function strokePolyline(ctx, c, bounds, invW, invH, size) {
    ctx.beginPath();
    for (let i = 0; i < c.length; i += 3) {
      const px = (c[i] - bounds.minX) * invW * size;
      const py = (c[i + 2] - bounds.minZ) * invH * size;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function buildMaskForTile(z, x, y, key, size = maskSize) {
    if (disposed) return null;
    const bounds = tileBoundsWorld(z, x, y);
    const tileW = bounds.maxX - bounds.minX;
    const tileH = bounds.maxZ - bounds.minZ;

    const dirtHits = [];
    const pavedHits = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (
        s.maxX < bounds.minX ||
        s.minX > bounds.maxX ||
        s.maxZ < bounds.minZ ||
        s.minZ > bounds.maxZ
      ) {
        continue;
      }
      if (s.category === 'paved') pavedHits.push(s);
      else dirtHits.push(s);
    }

    if (dirtHits.length === 0 && pavedHits.length === 0) {
      const emptyEntry = {
        empty: true,
        minX: bounds.minX,
        maxX: bounds.maxX,
        minZ: bounds.minZ,
        maxZ: bounds.maxZ,
        size,
        texture: fallbackMaskTex,
      };
      maskCache.set(key, emptyEntry);
      return null;
    }

    const canvas = acquireCanvas(size);
    const ctx = canvas.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 'lighten' writes max() independently per RGB channel so R (dirt), G (asphalt), B (sidewalk/curb) never clobber!
    ctx.globalCompositeOperation = 'lighten';

    const invW = 1 / tileW;
    const invH = 1 / tileH;
    const pxPerM = size * invW;

    // 1. Dirt singletrack, jeep roads, and tracks -> R channel
    for (let h = 0; h < dirtHits.length; h++) {
      const seg = dirtHits[h];
      const pxWidth = Math.max(1.5, seg.widthM * pxPerM);
      const shoulderR = Math.round(seg.strength * 115);
      const coreR = Math.round(Math.min(1, seg.strength) * 255);

      ctx.strokeStyle = `rgb(${shoulderR},0,0)`;
      ctx.lineWidth = pxWidth * 1.75;
      strokePolyline(ctx, seg.coords, bounds, invW, invH, size);

      ctx.strokeStyle = `rgb(${coreR},0,0)`;
      ctx.lineWidth = pxWidth;
      strokePolyline(ctx, seg.coords, bounds, invW, invH, size);
    }

    // 2. Paved town street sidewalks/curbs -> B channel, and asphalt roadway -> G channel
    for (let h = 0; h < pavedHits.length; h++) {
      const seg = pavedHits[h];
      const pxWidth = Math.max(2.2, seg.widthM * pxPerM);
      if (seg.hasSidewalk) {
        const apronPx = pxWidth + Math.max(1.6, 3.8 * pxPerM);
        ctx.strokeStyle = 'rgb(0,0,235)';
        ctx.lineWidth = apronPx;
        strokePolyline(ctx, seg.coords, bounds, invW, invH, size);
      }
      ctx.strokeStyle = 'rgb(0,255,0)';
      ctx.lineWidth = pxWidth;
      strokePolyline(ctx, seg.coords, bounds, invW, invH, size);
    }

    ctx.globalCompositeOperation = 'source-over';

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;

    if (maskCache.size >= MAX_MASKS) {
      const oldestKey = maskCache.keys().next().value;
      const oldest = maskCache.get(oldestKey);
      releaseEntry(oldest);
      maskCache.delete(oldestKey);
    }

    maskCache.set(key, {
      empty: false,
      minX: bounds.minX,
      maxX: bounds.maxX,
      minZ: bounds.minZ,
      maxZ: bounds.maxZ,
      size,
      canvas,
      texture: tex,
    });
    return tex;
  }

  /**
   * Look up or build a semantic RGB trail/road mask for tile (z, x, y).
   * Immediate camera tiles (syncIfImmediate = true) build synchronously (<0.8ms)
   * so singletrack & Main St asphalt appear on frame 1; farther tiles schedule at priority 2.
   */
  function getMaskForTile(z, x, y, syncIfImmediate = false) {
    if (segments.length === 0 || z < 14) return null;
    const key = `${z}/${x}/${y}@${maskSize}`;
    const entry = maskCache.get(key);
    if (entry) {
      maskCache.delete(key);
      maskCache.set(key, entry);
      return entry.empty ? null : entry.texture;
    }

    if (syncIfImmediate) {
      pendingBuild.delete(key);
      return buildMaskForTile(z, x, y, key, maskSize);
    }

    if (!pendingBuild.has(key)) {
      pendingBuild.add(key);
      engine.scheduler.enqueue(
        () => {
          pendingBuild.delete(key);
          if (!disposed) buildMaskForTile(z, x, y, key, maskSize);
          return false;
        },
        { priority: 2, label: `trail-mask-${key}` },
      );
    }
    return null;
  }

  function warmAround(x, z, zoom) {
    if (segments.length === 0 || zoom < 14) return;
    const t = worldToTile(x, z, zoom);
    getMaskForTile(zoom, t.x, t.y, true);
  }

  function setTierConfig(nextConfig) {
    const nextSize = nextConfig?.trailMaskSize || 256;
    if (nextSize === maskSize) return;
    maskSize = nextSize;
    for (const entry of maskCache.values()) {
      releaseEntry(entry);
    }
    maskCache.clear();
    pendingBuild.clear();
  }

  function onContextRestored() {
    fallbackMaskTex.needsUpdate = true;
    for (const entry of maskCache.values()) {
      if (!entry.empty && entry.texture) {
        entry.texture.needsUpdate = true;
      }
    }
  }

  function dispose() {
    disposed = true;
    offChunk();
    pendingBuild.clear();
    for (const entry of maskCache.values()) {
      releaseEntryNow(entry);
    }
    for (const item of deferredRelease) {
      releaseEntryNow(item.entry);
    }
    deferredRelease.length = 0;
    maskCache.clear();
    canvasPool.clear();
    fallbackMaskTex.dispose();
  }

  return {
    ingestTrails,
    getMaskForTile,
    warmAround,
    flushDeferred,
    setTierConfig,
    onContextRestored,
    fallbackMaskTex,
    dispose,
  };
}
