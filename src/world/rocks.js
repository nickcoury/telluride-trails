import * as THREE from 'three';
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

  // Displace shared vertices deterministically by quantized position so seams stay watertight
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = Math.round(x * 100) * 73856093 ^ Math.round(y * 100) * 19349663 ^ Math.round(z * 100) * 83492791;
    const rng = mulberry32((key ^ seed) >>> 0);
    const disp = 0.72 + rng() * 0.46;
    const nx = x * disp;
    const ny = y * (y < 0 ? 0.65 : disp * 0.82); // flatter base so rocks sit naturally in talus
    const nz = z * disp;
    pos.setXYZ(i, nx, ny, nz);

    const ao = ny < 0 ? 0.65 : 0.80 + Math.min(0.25, ny * 0.25);
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

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * ROCK_CELL_M;
      const z = z0 + rng() * ROCK_CELL_M;
      const y = terrain.getHeight(x, z);
      const norm = terrain.getNormal(x, z);
      const surf = terrain.getSurface(x, z);

      if (surf.water > 0.25) continue;

      const slopeFactor = Math.max(0, 1 - norm.y);
      const alpineFactor = y > 3450 ? Math.min(1, (y - 3450) / 450) : 0;
      const rockProb = Math.min(1, surf.rock * 1.15 + slopeFactor * 1.8 + alpineFactor * 0.45);
      if (rockProb < 0.22 || rng() > rockProb) continue;

      const near = trailData?.nearest?.(x, z, 2.8);
      if (near && near.dist < 1.9) continue;

      // Talus boulder size: larger near cliff bases & alpine basins
      const s = (0.45 + Math.pow(rng(), 1.8) * 2.4) * (0.7 + rockProb * 0.5);
      const sx = s * (0.8 + rng() * 0.6);
      const sy = s * (0.55 + rng() * 0.55);
      const sz = s * (0.8 + rng() * 0.6);

      // San Juan palette: alpine grey granite vs warm sandstone vs iron oxide redbed
      const mineral = fbm2D(x * 0.0018, z * 0.0018, 2, 811);
      const shade = 0.72 + rng() * 0.38;
      let r = 0.44 * shade;
      let g = 0.43 * shade;
      let b = 0.44 * shade;
      if (mineral > 0.58) {
        // Red Mountain / San Juan iron-rich ochre-rust tint
        r = 0.54 * shade;
        g = 0.39 * shade;
        b = 0.33 * shade;
      } else if (mineral < 0.36) {
        // Pale quartzite / granite
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
      lastUsed: performance.now(),
    };
  }

  function buildClutterChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 829));
    const count = Math.round(45 * cfg.density);
    const items = [];
    const x0 = cx * CLUTTER_CELL_M;
    const z0 = cz * CLUTTER_CELL_M;

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * CLUTTER_CELL_M;
      const z = z0 + rng() * CLUTTER_CELL_M;
      const y = terrain.getHeight(x, z);
      const norm = terrain.getNormal(x, z);
      const surf = terrain.getSurface(x, z);
      if (surf.water > 0.2 || norm.y < 0.45) continue;

      const near = trailData?.nearest?.(x, z, 2.5);
      // Allow tiny trailside pebbles near edges, keep center clear
      if (near && near.dist < 0.7) continue;

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
      lastUsed: performance.now(),
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
    for (const ch of rockChunks.values()) {
      const cdx = (ch.cx + 0.5) * ROCK_CELL_M - px;
      const cdz = (ch.cz + 0.5) * ROCK_CELL_M - pz;
      if (cdx * cdx + cdz * cdz > (cfg.rockRadius + ROCK_CELL_M) ** 2) continue;

      for (let i = 0; i < ch.items.length && rCount < boulderMesh.instanceMatrix.count; i++) {
        const it = ch.items[i];
        const dx = it.x - px;
        const dz = it.z - pz;
        if (dx * dx + dz * dz > r2) continue;
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
    boulderMesh.count = rCount;
    boulderMesh.instanceMatrix.needsUpdate = true;
    boulderMesh.instanceColor.needsUpdate = true;

    if (clutterMesh) {
      let cCount = 0;
      const c2 = cfg.clutterRadius * cfg.clutterRadius;
      for (const ch of clutterChunks.values()) {
        const cdx = (ch.cx + 0.5) * CLUTTER_CELL_M - px;
        const cdz = (ch.cz + 0.5) * CLUTTER_CELL_M - pz;
        if (cdx * cdx + cdz * cdz > (cfg.clutterRadius + CLUTTER_CELL_M) ** 2) continue;

        for (let i = 0; i < ch.items.length && cCount < clutterMesh.instanceMatrix.count; i++) {
          const it = ch.items[i];
          const dx = it.x - px;
          const dz = it.z - pz;
          if (dx * dx + dz * dz > c2) continue;
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
      clutterMesh.count = cCount;
      clutterMesh.instanceMatrix.needsUpdate = true;
      clutterMesh.instanceColor.needsUpdate = true;
    }
  }

  const unsubQuality = events.on('quality:changed', () => {
    rockChunks.clear();
    clutterChunks.clear();
    rebuildPools();
    dirty = true;
  });

  function update(dt, playerPos) {
    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;
    const now = performance.now();

    const ring = Math.ceil(cfg.rockRadius / ROCK_CELL_M);
    const pcx = Math.floor(px / ROCK_CELL_M);
    const pcz = Math.floor(pz / ROCK_CELL_M);
    let built = 0;

    outer: for (let r = 0; r <= ring && built < 2; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const key = `${cx},${cz}`;
          const existing = rockChunks.get(key);
          if (existing) {
            existing.lastUsed = now;
            continue;
          }
          rockChunks.set(key, buildRockChunk(cx, cz));
          dirty = true;
          built++;
          if (built >= 2) break outer;
        }
      }
    }

    if (clutterMesh && cfg.clutterRadius > 0) {
      const cRing = Math.ceil(cfg.clutterRadius / CLUTTER_CELL_M);
      const ccx = Math.floor(px / CLUTTER_CELL_M);
      const ccz = Math.floor(pz / CLUTTER_CELL_M);
      let cBuilt = 0;
      outerC: for (let r = 0; r <= cRing && cBuilt < 2; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = ccx + dx;
            const cz = ccz + dz;
            const key = `${cx},${cz}`;
            const existing = clutterChunks.get(key);
            if (existing) {
              existing.lastUsed = now;
              continue;
            }
            clutterChunks.set(key, buildClutterChunk(cx, cz));
            dirty = true;
            cBuilt++;
            if (cBuilt >= 2) break outerC;
          }
        }
      }
    }

    if (rockChunks.size > 0) {
      const keys = Array.from(rockChunks.keys());
      const key = keys[checkCursor % keys.length];
      checkCursor++;
      const ch = rockChunks.get(key);
      if (ch) {
        const newH = terrain.getHeight((ch.cx + 0.5) * ROCK_CELL_M, (ch.cz + 0.5) * ROCK_CELL_M);
        if (Math.abs(newH - ch.centerH) > 1.5) {
          rockChunks.delete(key);
          dirty = true;
        }
      }
    }

    if (rockChunks.size > 260) {
      for (const [k, ch] of rockChunks) {
        if (now - ch.lastUsed > 16000) rockChunks.delete(k);
        if (rockChunks.size <= 180) break;
      }
    }
    if (clutterChunks.size > 120) {
      for (const [k, ch] of clutterChunks) {
        if (now - ch.lastUsed > 10000) clutterChunks.delete(k);
        if (clutterChunks.size <= 80) break;
      }
    }

    if (dirty || Math.hypot(px - lastPackX, pz - lastPackZ) > 10) {
      pack(px, pz);
      lastPackX = px;
      lastPackZ = pz;
      dirty = false;
    }
  }

  function dispose() {
    unsubQuality();
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
