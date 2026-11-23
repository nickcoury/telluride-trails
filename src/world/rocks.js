import * as THREE from 'three';
import { tileBoundsWorld } from '../core/geo.js';
import { hash2i, mulberry32, fbm2D } from './noise.js';
import { patchSanJuanMaterial } from './materialFog.js';

const ROCK_CELL_M = 160;
const CLUTTER_CELL_M = 48;

const TIER_ROCK_CFG = {
  low: { rockRadius: 320, clutterRadius: 0, density: 0.35, maxRocks: 400, maxClutter: 0 },
  medium: { rockRadius: 520, clutterRadius: 0, density: 0.65, maxRocks: 900, maxClutter: 0 },
  high: { rockRadius: 780, clutterRadius: 36, density: 0.90, maxRocks: 1600, maxClutter: 1200 },
  ultra: { rockRadius: 1050, clutterRadius: 55, density: 1.0, maxRocks: 2400, maxClutter: 2200 },
};

function buildAngularRockGeometry(radius = 1, detail = 1, seed = 41) {
  const geo = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geo.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = Math.round(x * 100) * 73856093 ^ Math.round(y * 100) * 19349663 ^ Math.round(z * 100) * 83492791;
    const rng = mulberry32((key ^ seed) >>> 0);
    const disp = 0.72 + rng() * 0.46;
    const nx = x * disp;
    const ny = y * (y < 0 ? 0.65 : disp * 0.82);
    const nz = z * disp;
    pos.setXYZ(i, nx, ny, nz);

    const ao = ny < 0 ? 0.68 : 0.82 + Math.min(0.24, ny * 0.24);
    colors[i * 3] = ao;
    colors[i * 3 + 1] = ao;
    colors[i * 3 + 2] = ao;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

export function createRocks(engine, terrain, trailData, atmosphere) {
  const { scene, events } = engine;

  const boulderGeo = buildAngularRockGeometry(1.0, 1, 1337);
  const clutterGeo = buildAngularRockGeometry(0.18, 0, 9001);

  const rockMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    atmosphere.uniforms
  );

  let cfg = TIER_ROCK_CFG[engine.quality.tier] || TIER_ROCK_CFG.medium;
  let lastTier = engine.quality.tier;
  let lastShadows = Boolean(engine.quality.shadows);

  let boulderMesh = null;
  let clutterMesh = null;

  function makePool(geo, mat, capacity, castShadow) {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    const c = new THREE.Color(1, 1, 1);
    for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setColorAt(i, c);
    mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    return mesh;
  }

  function rebuildPools() {
    for (const m of [boulderMesh, clutterMesh]) {
      if (m) {
        scene.remove(m);
        m.dispose();
      }
    }
    cfg = TIER_ROCK_CFG[engine.quality.tier] || TIER_ROCK_CFG.medium;
    const allowShadow = Boolean(engine.quality.shadows);
    boulderMesh = makePool(boulderGeo, rockMat, cfg.maxRocks, allowShadow);
    clutterMesh = cfg.maxClutter > 0 ? makePool(clutterGeo, rockMat, cfg.maxClutter, false) : null;
  }
  rebuildPools();

  const rockChunks = new Map();
  const clutterChunks = new Map();
  let dirty = true;
  let lastPackX = 1e9;
  let lastPackZ = 1e9;
  let checkCursor = 0;

  function buildRockChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 557));
    const count = Math.round(38 * cfg.density);
    const items = [];
    const x0 = cx * ROCK_CELL_M;
    const z0 = cz * ROCK_CELL_M;
    const bldgMask = engine.worldBuildingMask;

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * ROCK_CELL_M;
      const z = z0 + rng() * ROCK_CELL_M;

      // Never place wild boulders inside town blocks, plazas, or near buildings
      if (bldgMask) {
        if (bldgMask.isInTownCorridor(x, z) || bldgMask.isNearBuilding(x, z, 20.0)) continue;
      }

      const near = trailData?.nearest?.(x, z, 13.5);
      if (near) {
        const minClear = near.kind === 'road' ? 12.5 : near.kind === 'track' ? 5.0 : 2.8;
        if (near.dist < minClear) continue;
      }

      const y = terrain.getHeight(x, z);
      const norm = terrain.getNormal(x, z);
      const surf = terrain.getSurface(x, z);

      if (surf.water > 0.25) continue;

      const slopeFactor = Math.max(0, 1 - norm.y);
      const alpineFactor = y > 3450 ? Math.min(1, (y - 3450) / 450) : 0;
      const rockProb = Math.min(1, surf.rock * 1.15 + slopeFactor * 1.8 + alpineFactor * 0.45);
      if (rockProb < 0.24 || rng() > rockProb) continue;

      const s = (0.45 + Math.pow(rng(), 1.8) * 2.4) * (0.7 + rockProb * 0.5);
      const sx = s * (0.8 + rng() * 0.6);
      const sy = s * (0.55 + rng() * 0.55);
      const sz = s * (0.8 + rng() * 0.6);

      const mineral = fbm2D(x * 0.0018, z * 0.0018, 2, 811);
      const shade = 0.72 + rng() * 0.38;
      let r = 0.44 * shade;
      let g = 0.43 * shade;
      let b = 0.44 * shade;
      if (mineral > 0.58) {
        r = 0.54 * shade;
        g = 0.39 * shade;
        b = 0.33 * shade;
      } else if (mineral < 0.36) {
        r = 0.54 * shade;
        g = 0.53 * shade;
        b = 0.52 * shade;
      }

      items.push({
        x,
        y: y - sy * 0.22,
        z,
        rx: rng() * 0.5,
        ry: rng() * Math.PI * 2,
        rz: rng() * 0.5,
        sx,
        sy,
        sz,
        r,
        g,
        b,
      });
    }

    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(x0 + ROCK_CELL_M * 0.5, z0 + ROCK_CELL_M * 0.5),
      items,
    };
  }

  function buildClutterChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 829));
    const count = Math.round(42 * cfg.density);
    const items = [];
    const x0 = cx * CLUTTER_CELL_M;
    const z0 = cz * CLUTTER_CELL_M;
    const bldgMask = engine.worldBuildingMask;

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * CLUTTER_CELL_M;
      const z = z0 + rng() * CLUTTER_CELL_M;

      if (bldgMask && (bldgMask.isInTownCorridor(x, z) || bldgMask.isNearBuilding(x, z, 14.0))) continue;

      const near = trailData?.nearest?.(x, z, 10.0);
      if (near) {
        const minClear = near.kind === 'road' ? 9.0 : near.kind === 'track' ? 3.0 : 1.0;
        if (near.dist < minClear) continue;
      }

      const y = terrain.getHeight(x, z);
      const norm = terrain.getNormal(x, z);
      const surf = terrain.getSurface(x, z);
      if (surf.water > 0.2 || norm.y < 0.45) continue;

      const s = 0.6 + rng() * 1.4;
      const shade = 0.65 + rng() * 0.4;
      items.push({
        x,
        y: y - 0.04,
        z,
        ry: rng() * Math.PI * 2,
        sx: s * (0.8 + rng() * 0.6),
        sy: s * 0.55,
        sz: s * (0.8 + rng() * 0.6),
        r: 0.46 * shade,
        g: 0.43 * shade,
        b: 0.40 * shade,
      });
    }

    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(x0 + CLUTTER_CELL_M * 0.5, z0 + CLUTTER_CELL_M * 0.5),
      items,
    };
  }

  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _euler = new THREE.Euler();
  const _scale = new THREE.Vector3();
  const _col = new THREE.Color();

  function pack(px, pz) {
    let rCount = 0;
    const r2 = cfg.rockRadius * cfg.rockRadius;
    const ring = Math.ceil(cfg.rockRadius / ROCK_CELL_M);
    const pcx = Math.floor(px / ROCK_CELL_M);
    const pcz = Math.floor(pz / ROCK_CELL_M);

    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        const ch = rockChunks.get(`${pcx + dx},${pcz + dz}`);
        if (!ch) continue;

        for (let i = 0; i < ch.items.length && rCount < boulderMesh.instanceMatrix.count; i++) {
          const it = ch.items[i];
          const ddx = it.x - px;
          const ddz = it.z - pz;
          if (ddx * ddx + ddz * ddz > r2) continue;
          _pos.set(it.x, it.y, it.z);
          _euler.set(it.rx, it.ry, it.rz);
          _quat.setFromEuler(_euler);
          _scale.set(it.sx, it.sy, it.sz);
          _mat.compose(_pos, _quat, _scale);
          _col.setRGB(it.r, it.g, it.b);
          boulderMesh.setMatrixAt(rCount, _mat);
          boulderMesh.setColorAt(rCount, _col);
          rCount++;
        }
      }
    }
    boulderMesh.count = rCount;
    boulderMesh.instanceMatrix.needsUpdate = true;
    boulderMesh.instanceColor.needsUpdate = true;

    if (clutterMesh) {
      let cCount = 0;
      const c2 = cfg.clutterRadius * cfg.clutterRadius;
      const cRing = Math.ceil(cfg.clutterRadius / CLUTTER_CELL_M);
      const ccx = Math.floor(px / CLUTTER_CELL_M);
      const ccz = Math.floor(pz / CLUTTER_CELL_M);

      for (let dz = -cRing; dz <= cRing; dz++) {
        for (let dx = -cRing; dx <= cRing; dx++) {
          const ch = clutterChunks.get(`${ccx + dx},${ccz + dz}`);
          if (!ch) continue;

          for (let i = 0; i < ch.items.length && cCount < clutterMesh.instanceMatrix.count; i++) {
            const it = ch.items[i];
            const ddx = it.x - px;
            const ddz = it.z - pz;
            if (ddx * ddx + ddz * ddz > c2) continue;
            _pos.set(it.x, it.y, it.z);
            _euler.set(0, it.ry, 0);
            _quat.setFromEuler(_euler);
            _scale.set(it.sx, it.sy, it.sz);
            _mat.compose(_pos, _quat, _scale);
            _col.setRGB(it.r, it.g, it.b);
            clutterMesh.setMatrixAt(cCount, _mat);
            clutterMesh.setColorAt(cCount, _col);
            cCount++;
          }
        }
      }
      clutterMesh.count = cCount;
      clutterMesh.instanceMatrix.needsUpdate = true;
      clutterMesh.instanceColor.needsUpdate = true;
    }
  }

  // Guarded quality listener: ignore pure renderScale adaptive ticks!
  const unsubQuality = events.on('quality:changed', (q) => {
    const nextTier = q?.tier ?? engine.quality.tier;
    const nextShadows = Boolean(engine.quality.shadows);
    if (nextTier === lastTier && nextShadows === lastShadows) return;

    const tierChanged = nextTier !== lastTier;
    lastTier = nextTier;
    lastShadows = nextShadows;
    if (tierChanged) {
      rockChunks.clear();
      clutterChunks.clear();
    }
    rebuildPools();
    dirty = true;
  });

  // Invalidate overlapping rock cells when road/town vector chunks arrive
  const unsubChunk = events.on('data:chunk', (payload) => {
    if (typeof payload?.tx === 'number' && typeof payload?.ty === 'number') {
      const b = tileBoundsWorld(13, payload.tx, payload.ty);
      const pad = 20;
      const rcx0 = Math.floor((b.minX - pad) / ROCK_CELL_M);
      const rcx1 = Math.floor((b.maxX + pad) / ROCK_CELL_M);
      const rcz0 = Math.floor((b.minZ - pad) / ROCK_CELL_M);
      const rcz1 = Math.floor((b.maxZ + pad) / ROCK_CELL_M);
      for (let cz = rcz0; cz <= rcz1; cz++) {
        for (let cx = rcx0; cx <= rcx1; cx++) {
          if (rockChunks.delete(`${cx},${cz}`)) dirty = true;
        }
      }
      const ccx0 = Math.floor((b.minX - pad) / CLUTTER_CELL_M);
      const ccx1 = Math.floor((b.maxX + pad) / CLUTTER_CELL_M);
      const ccz0 = Math.floor((b.minZ - pad) / CLUTTER_CELL_M);
      const ccz1 = Math.floor((b.maxZ + pad) / CLUTTER_CELL_M);
      for (let cz = ccz0; cz <= ccz1; cz++) {
        for (let cx = ccx0; cx <= ccx1; cx++) {
          if (clutterChunks.delete(`${cx},${cz}`)) dirty = true;
        }
      }
    }
  });

  function update(dt, playerPos) {
    const appState = engine.getAppState?.();
    if (appState === 'title' || appState === 'loading') return;

    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;
    const t0 = performance.now();

    const ring = Math.ceil(cfg.rockRadius / ROCK_CELL_M);
    const pcx = Math.floor(px / ROCK_CELL_M);
    const pcz = Math.floor(pz / ROCK_CELL_M);
    let built = 0;

    outer: for (let r = 0; r <= ring; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const key = `${cx},${cz}`;
          if (rockChunks.has(key)) continue;

          rockChunks.set(key, buildRockChunk(cx, cz));
          dirty = true;
          built++;
          if (built >= 1 || performance.now() - t0 > 1.2) break outer;
        }
      }
    }

    if (clutterMesh && cfg.clutterRadius > 0 && performance.now() - t0 < 1.5) {
      const cRing = Math.ceil(cfg.clutterRadius / CLUTTER_CELL_M);
      const ccx = Math.floor(px / CLUTTER_CELL_M);
      const ccz = Math.floor(pz / CLUTTER_CELL_M);
      let cBuilt = 0;
      outerC: for (let r = 0; r <= cRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = ccx + dx;
            const cz = ccz + dz;
            const key = `${cx},${cz}`;
            if (clutterChunks.has(key)) continue;

            clutterChunks.set(key, buildClutterChunk(cx, cz));
            dirty = true;
            cBuilt++;
            if (cBuilt >= 2 || performance.now() - t0 > 1.8) break outerC;
          }
        }
      }
    }

    const span = ring * 2 + 1;
    const totalCells = span * span;
    if (totalCells > 0) {
      const idx = checkCursor % totalCells;
      checkCursor = (checkCursor + 1) | 0;
      const dx = (idx % span) - ring;
      const dz = Math.floor(idx / span) - ring;
      const key = `${pcx + dx},${pcz + dz}`;
      const ch = rockChunks.get(key);
      if (ch) {
        const newH = terrain.getHeight((ch.cx + 0.5) * ROCK_CELL_M, (ch.cz + 0.5) * ROCK_CELL_M);
        if (Math.abs(newH - ch.centerH) > 1.5) {
          rockChunks.delete(key);
          dirty = true;
        }
      }
    }

    while (rockChunks.size > 220) {
      const oldest = rockChunks.keys().next().value;
      if (oldest === undefined) break;
      rockChunks.delete(oldest);
    }
    while (clutterChunks.size > 90) {
      const oldest = clutterChunks.keys().next().value;
      if (oldest === undefined) break;
      clutterChunks.delete(oldest);
    }

    if (dirty || Math.hypot(px - lastPackX, pz - lastPackZ) > 12) {
      pack(px, pz);
      lastPackX = px;
      lastPackZ = pz;
      dirty = false;
    }
  }

  function dispose() {
    unsubQuality();
    unsubChunk();
    for (const m of [boulderMesh, clutterMesh]) {
      if (m) {
        scene.remove(m);
        m.dispose();
      }
    }
    boulderGeo.dispose();
    clutterGeo.dispose();
    rockMat.dispose();
    rockChunks.clear();
    clutterChunks.clear();
  }

  return { update, dispose };
}
