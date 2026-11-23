/**
 * Fast O(1) spatial hash for lake polygon exclusion, waterway riparian detection / channel
 * exclusion, and Telluride Ski Area piste clearings. Shared between vegetation.js and rocks.js.
 */

const CELL_M = 128;
const GRID_OFFSET = 4096;
const GRID_STRIDE = 8192;

function cellKey(cx, cz) {
  return (cx + GRID_OFFSET) * GRID_STRIDE + (cz + GRID_OFFSET);
}

function pointToSegDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-6) {
    const ex = px - ax;
    const ez = pz - az;
    return ex * ex + ez * ez;
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / l2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx - px;
  const cz = az + t * dz - pz;
  return cx * cx + cz * cz;
}

function pointInPolyXZ(px, pz, ring) {
  let inside = false;
  const n = ring.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    const intersect =
      zi > pz !== zj > pz &&
      px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToPolyEdgeSq(px, pz, ring) {
  let best = Infinity;
  const n = ring.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d2 = pointToSegDistSq(
      px,
      pz,
      ring[j * 2],
      ring[j * 2 + 1],
      ring[i * 2],
      ring[i * 2 + 1]
    );
    if (d2 < best) best = d2;
  }
  return best;
}

export function getOrCreateFloraMasks(engine, trailData) {
  if (engine._floraSpatialMasks) {
    engine._floraSpatialMasks._refCount++;
    return engine._floraSpatialMasks;
  }

  const lakeGrid = new Map();
  const seenLakes = new Set();

  const waterwayGrid = new Map();
  const seenWaterways = new Set();

  const skiGrid = new Map();
  const seenSkiRuns = new Set();

  function addLake(lake) {
    if (!lake?.coords || lake.coords.length < 9) return;
    const id = lake.id || `${lake.coords[0].toFixed(1)}_${lake.coords[2].toFixed(1)}`;
    if (seenLakes.has(id)) return;
    seenLakes.add(id);

    const coords = lake.coords;
    const n = Math.floor(coords.length / 3);
    const ring = new Float32Array(n * 2);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3];
      const z = coords[i * 3 + 2];
      ring[i * 2] = x;
      ring[i * 2 + 1] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const entry = { minX, minZ, maxX, maxZ, ring };
    const pad = 16;
    const cx0 = Math.floor((minX - pad) / CELL_M);
    const cx1 = Math.floor((maxX + pad) / CELL_M);
    const cz0 = Math.floor((minZ - pad) / CELL_M);
    const cz1 = Math.floor((maxZ + pad) / CELL_M);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cellKey(cx, cz);
        let arr = lakeGrid.get(k);
        if (!arr) {
          arr = [];
          lakeGrid.set(k, arr);
        }
        arr.push(entry);
      }
    }
  }

  function addWaterway(w) {
    if (!w?.coords || w.coords.length < 6) return;
    const id = w.id || `${w.coords[0].toFixed(1)}_${w.coords[2].toFixed(1)}`;
    if (seenWaterways.has(id)) return;
    seenWaterways.add(id);

    const isRiver = w.kind === 'river';
    const hasName = Boolean(w.name && w.name.trim().length > 0);
    let widthM;
    if (isRiver) {
      widthM = Math.max(5.0, Math.min(10.5, w.widthM || 6.8));
    } else if (hasName) {
      widthM = Math.max(1.4, Math.min(2.8, w.widthM ? Math.min(w.widthM, 2.8) : 2.0));
    } else {
      widthM = 0.9;
    }
    const halfW = widthM * 0.5;
    const flags = (isRiver ? 2 : 0) | (hasName ? 1 : 0);

    const coords = w.coords;
    const n = Math.floor(coords.length / 3);
    const pad = 18;
    for (let i = 0; i < n - 1; i++) {
      const ax = coords[i * 3];
      const az = coords[i * 3 + 2];
      const bx = coords[(i + 1) * 3];
      const bz = coords[(i + 1) * 3 + 2];
      const cx0 = Math.floor((Math.min(ax, bx) - pad) / CELL_M);
      const cx1 = Math.floor((Math.max(ax, bx) + pad) / CELL_M);
      const cz0 = Math.floor((Math.min(az, bz) - pad) / CELL_M);
      const cz1 = Math.floor((Math.max(az, bz) + pad) / CELL_M);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cellKey(cx, cz);
          let arr = waterwayGrid.get(k);
          if (!arr) {
            arr = [];
            waterwayGrid.set(k, arr);
          }
          // Compact 6-number stride: ax, az, bx, bz, halfW, flags
          arr.push(ax, az, bx, bz, halfW, flags);
        }
      }
    }
  }

  function addSkiRun(sr) {
    if (!sr?.coords || sr.coords.length < 6) return;
    const id = sr.id || `${sr.coords[0].toFixed(1)}_${sr.coords[2].toFixed(1)}`;
    if (seenSkiRuns.has(id)) return;
    seenSkiRuns.add(id);

    const diff = (sr.difficulty || '').toLowerCase();
    // Wide groomed green/blue runs ~12-14m half-width; tighter expert chutes ~7m
    const halfW = diff === 'easy' || diff === 'novice' ? 14.0 : diff === 'intermediate' ? 12.0 : 8.0;
    const coords = sr.coords;
    const n = Math.floor(coords.length / 3);
    const pad = halfW + 4;
    for (let i = 0; i < n - 1; i++) {
      const ax = coords[i * 3];
      const az = coords[i * 3 + 2];
      const bx = coords[(i + 1) * 3];
      const bz = coords[(i + 1) * 3 + 2];
      const cx0 = Math.floor((Math.min(ax, bx) - pad) / CELL_M);
      const cx1 = Math.floor((Math.max(ax, bx) + pad) / CELL_M);
      const cz0 = Math.floor((Math.min(az, bz) - pad) / CELL_M);
      const cz1 = Math.floor((Math.max(az, bz) + pad) / CELL_M);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cellKey(cx, cz);
          let arr = skiGrid.get(k);
          if (!arr) {
            arr = [];
            skiGrid.set(k, arr);
          }
          arr.push(ax, az, bx, bz, halfW);
        }
      }
    }
  }

  function ingestBatch(lakes, waterways, skiRuns) {
    if (lakes) for (let i = 0; i < lakes.length; i++) addLake(lakes[i]);
    if (waterways) for (let i = 0; i < waterways.length; i++) addWaterway(waterways[i]);
    if (skiRuns) for (let i = 0; i < skiRuns.length; i++) addSkiRun(skiRuns[i]);
  }

  ingestBatch(trailData?.lakes, trailData?.waterways, trailData?.skiRuns);

  const unsubChunk = engine.events.on('data:chunk', (payload) => {
    const added = payload?.added;
    if (added) {
      ingestBatch(added.lakes, added.waterways, added.skiRuns);
    }
  });

  function isInLake(x, z, padM = 2.0) {
    if (engine.worldWaterMask?.isInLake?.(x, z, padM)) return true;
    const bucket = lakeGrid.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (!bucket) return false;
    const pad2 = padM * padM;
    for (let i = 0; i < bucket.length; i++) {
      const l = bucket[i];
      if (x < l.minX - padM || x > l.maxX + padM || z < l.minZ - padM || z > l.maxZ + padM) continue;
      if (pointInPolyXZ(x, z, l.ring)) return true;
      if (padM > 0 && distToPolyEdgeSq(x, z, l.ring) <= pad2) return true;
    }
    return false;
  }

  const _wwRes = { found: false, dist: Infinity, halfW: 0, isRiver: false, hasName: false };

  function queryWaterway(x, z, maxDist = 14.0) {
    _wwRes.found = false;
    _wwRes.dist = Infinity;
    _wwRes.halfW = 0;
    _wwRes.isRiver = false;
    _wwRes.hasName = false;

    const bucket = waterwayGrid.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (!bucket) return _wwRes;

    let bestD2 = maxDist * maxDist;
    for (let i = 0; i < bucket.length; i += 6) {
      const d2 = pointToSegDistSq(x, z, bucket[i], bucket[i + 1], bucket[i + 2], bucket[i + 3]);
      if (d2 < bestD2) {
        bestD2 = d2;
        _wwRes.found = true;
        _wwRes.dist = Math.sqrt(d2);
        _wwRes.halfW = bucket[i + 4];
        const fl = bucket[i + 5];
        _wwRes.isRiver = (fl & 2) !== 0;
        _wwRes.hasName = (fl & 1) !== 0;
      }
    }
    return _wwRes;
  }

  function isInWater(x, z, padM = 1.2) {
    if (engine.worldWaterMask?.isInWater?.(x, z, padM)) return true;
    if (isInLake(x, z, padM)) return true;
    const ww = queryWaterway(x, z, 12.0);
    return ww.found && ww.dist < ww.halfW + padM;
  }

  function isOnSkiRun(x, z) {
    const bucket = skiGrid.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    if (!bucket) return false;
    for (let i = 0; i < bucket.length; i += 5) {
      const hw = bucket[i + 4];
      const d2 = pointToSegDistSq(x, z, bucket[i], bucket[i + 1], bucket[i + 2], bucket[i + 3]);
      if (d2 < hw * hw) return true;
    }
    return false;
  }

  function isExcludedTownOrBuilding(x, z, buildingPadM = 9.0) {
    const bldgMask = engine.worldBuildingMask;
    if (!bldgMask) return false;
    return bldgMask.isInTownCorridor(x, z) || bldgMask.isNearBuilding(x, z, buildingPadM);
  }

  const api = {
    _refCount: 1,
    isInLake,
    isInWater,
    queryWaterway,
    isOnSkiRun,
    isExcludedTownOrBuilding,
    release() {
      api._refCount--;
      if (api._refCount <= 0) {
        unsubChunk();
        lakeGrid.clear();
        waterwayGrid.clear();
        skiGrid.clear();
        seenLakes.clear();
        seenWaterways.clear();
        seenSkiRuns.clear();
        if (engine._floraSpatialMasks === api) {
          delete engine._floraSpatialMasks;
        }
      }
    },
  };

  engine._floraSpatialMasks = api;
  return api;
}
