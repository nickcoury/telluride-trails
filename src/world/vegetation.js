import * as THREE from 'three';
import { tileBoundsWorld } from '../core/geo.js';
import { hash2i, mulberry32, fbm2D } from './noise.js';
import { patchSanJuanMaterial } from './materialFog.js';

const TREE_CELL_M = 200;
const GRASS_CELL_M = 48;

const TIER_CONFIG = {
  low: { nearRadius: 0, farRadius: 1500, grassRadius: 0, density: 0.32, maxNear: 0, maxImp: 3200, maxGrass: 0 },
  medium: { nearRadius: 85, farRadius: 2400, grassRadius: 36, density: 0.58, maxNear: 450, maxImp: 6500, maxGrass: 1800 },
  high: { nearRadius: 170, farRadius: 3800, grassRadius: 62, density: 0.88, maxNear: 1100, maxImp: 11000, maxGrass: 4200 },
  ultra: { nearRadius: 250, farRadius: 5200, grassRadius: 88, density: 1.0, maxNear: 1800, maxImp: 16000, maxGrass: 7200 },
};

// UV rects [u0, v0, uScale, vScale] with 2-texel inset to prevent mipmap bleeding
const ATLAS_RECTS = [
  [0.008, 0.508, 0.484, 0.484], // Q0 top-left: Spruce / Tussock Grass
  [0.508, 0.508, 0.484, 0.484], // Q1 top-right: Fir / Golden Sedge
  [0.008, 0.008, 0.484, 0.484], // Q2 bottom-left: Aspen / Blue Columbine
  [0.508, 0.008, 0.484, 0.484], // Q3 bottom-right: Krummholz-Willow / Paintbrush
];

function mergeColoredGeometries(parts) {
  let totalVerts = 0;
  const nonIndexed = parts.map((g) => {
    if (g.index) {
      const ni = g.toNonIndexed();
      g.dispose(); // dispose indexed source geometry immediately so nothing leaks
      return ni;
    }
    return g;
  });
  for (const g of nonIndexed) totalVerts += g.attributes.position.count;

  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const col = new Float32Array(totalVerts * 3);
  let offset = 0;

  for (const g of nonIndexed) {
    pos.set(g.attributes.position.array, offset * 3);
    norm.set(g.attributes.normal.array, offset * 3);
    col.set(g.attributes.color.array, offset * 3);
    offset += g.attributes.position.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function colorizeGeometry(geo, r, g, b, shadeBottom = 0.74) {
  const count = geo.attributes.position.count;
  const pos = geo.attributes.position.array;
  const colors = new Float32Array(count * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const y = pos[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(0.001, maxY - minY);
  for (let i = 0; i < count; i++) {
    const t = (pos[i * 3 + 1] - minY) / span;
    const s = shadeBottom + (1 - shadeBottom) * t;
    colors[i * 3] = r * s;
    colors[i * 3 + 1] = g * s;
    colors[i * 3 + 2] = b * s;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * Unit-height (y in [0, 1]) fuller multi-tier Engelmann Spruce / Subalpine Fir.
 */
function buildConiferGeometry(isFir) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.012, 0.038, 0.86, 6);
  trunk.translate(0, 0.43, 0);
  parts.push(colorizeGeometry(trunk, 0.28, 0.19, 0.13, 0.82));

  const layers = isFir ? 10 : 9;
  const maxRad = isFir ? 0.15 : 0.19;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const yBase = 0.14 + t * 0.74;
    const h = 0.23 - t * 0.08;
    const rad = maxRad * (1 - t * 0.76);
    const cone = new THREE.ConeGeometry(rad, h, 9, 1);
    const pos = cone.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const py = pos.getY(v);
      if (py < 0) {
        const ang = Math.atan2(pos.getZ(v), pos.getX(v));
        const j = 0.84 + 0.28 * Math.sin(ang * 4 + i * 2.1);
        pos.setX(v, pos.getX(v) * j);
        pos.setZ(v, pos.getZ(v) * j);
        pos.setY(v, py - 0.018 * Math.cos(ang * 3 + i));
      }
    }
    cone.computeVertexNormals();
    cone.rotateY(i * 0.62);
    cone.translate(0, yBase + h * 0.45, 0);
    const r = isFir ? 0.13 : 0.15;
    const g = isFir ? 0.30 : 0.34;
    const b = isFir ? 0.16 : 0.18;
    parts.push(colorizeGeometry(cone, r, g, b, 0.72));
  }
  return mergeColoredGeometries(parts);
}

/**
 * Unit-height (y in [0, 1]) airy Quaking Aspen geometry (slender white trunk + soft rounded crown lobes).
 */
function buildAspenGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.011, 0.028, 0.80, 6);
  trunk.translate(0, 0.40, 0);
  parts.push(colorizeGeometry(trunk, 0.88, 0.86, 0.80, 0.78));

  const fork1 = new THREE.CylinderGeometry(0.006, 0.013, 0.30, 5);
  fork1.rotateZ(0.36);
  fork1.translate(-0.055, 0.57, 0.02);
  parts.push(colorizeGeometry(fork1, 0.86, 0.84, 0.78, 0.85));

  const fork2 = new THREE.CylinderGeometry(0.006, 0.012, 0.26, 5);
  fork2.rotateZ(-0.34);
  fork2.translate(0.05, 0.62, -0.02);
  parts.push(colorizeGeometry(fork2, 0.86, 0.84, 0.78, 0.85));

  const lobes = [
    [0.0, 0.82, 0.0, 0.16],
    [-0.11, 0.69, 0.05, 0.135],
    [0.11, 0.72, -0.04, 0.13],
    [0.03, 0.59, 0.09, 0.12],
    [-0.04, 0.62, -0.08, 0.12],
    [0.07, 0.84, 0.04, 0.115],
    [-0.08, 0.81, -0.03, 0.115],
    [0.0, 0.92, 0.0, 0.105],
  ];
  for (const [lx, ly, lz, lr] of lobes) {
    const ico = new THREE.IcosahedronGeometry(lr, 1);
    ico.scale(1.05, 0.92, 1.05);
    ico.translate(lx, ly, lz);
    parts.push(colorizeGeometry(ico, 0.64, 0.76, 0.27, 0.76));
  }
  return mergeColoredGeometries(parts);
}

function buildCrossedQuadGeometry(planes = 2, width = 0.88) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let i = 0; i < planes; i++) {
    const ang = (i / planes) * Math.PI;
    const hw = width * 0.5;
    const dx = Math.cos(ang) * hw;
    const dz = Math.sin(ang) * hw;
    const nx = -Math.sin(ang) * 0.25;
    const nz = Math.cos(ang) * 0.25;
    const nl = Math.hypot(nx, 0.94, nz);
    const base = i * 4;

    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    for (let v = 0; v < 4; v++) normals.push(nx / nl, 0.94 / nl, nz / nl);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function pickTreeAt(x, z, y, normalY, surface, rng) {
  if (normalY < 0.64 || surface.water > 0.25 || y > 3680) return null;

  const hasCoverData =
    surface.forest + surface.rock + surface.water + surface.snow + surface.grass > 0.05;

  const forestWeight = hasCoverData
    ? surface.forest
    : y < 3620 ? Math.max(0, (fbm2D(x * 0.0022, z * 0.0022, 3, 19) - 0.32) * 1.45) : 0;

  if (y > 3430) {
    const treelineFade = 1 - (y - 3430) / 250;
    const chance = Math.max(forestWeight, 0.22) * treelineFade * 0.65;
    if (rng() > chance || normalY < 0.68) return null;
    const h = 1.1 + rng() * 1.6;
    return {
      kind: 3,
      height: h,
      widthScale: h * (1.2 + rng() * 0.5),
      r: 0.84 + rng() * 0.16,
      g: 0.90 + rng() * 0.14,
      b: 0.78 + rng() * 0.14,
    };
  }

  if (y < 2820 && normalY > 0.92 && forestWeight < 0.35 && surface.grass > 0.2) {
    if (rng() < 0.14) {
      const h = 1.6 + rng() * 1.8;
      return {
        kind: 3,
        height: h,
        widthScale: h * 1.15,
        r: 0.72,
        g: 0.92,
        b: 0.62,
      };
    }
  }

  if (forestWeight < 0.16 || rng() > forestWeight * 1.12) return null;

  const groveNoise = fbm2D(x * 0.0042, z * 0.0042, 3, 503);
  const inAspenZone = y >= 2500 && y <= 3360 && normalY > 0.76;
  if (inAspenZone && groveNoise > 0.53 && rng() < (groveNoise - 0.45) * 1.9) {
    const h = 7.5 + rng() * 6.5;
    const gold = fbm2D(x * 0.0028, z * 0.0028, 2, 709);
    const isGold = gold > 0.48;
    return {
      kind: 2,
      height: h,
      widthScale: h * (0.85 + rng() * 0.22),
      r: isGold ? 0.92 + rng() * 0.08 : 0.80 + rng() * 0.14,
      g: isGold ? 0.84 + rng() * 0.10 : 0.90 + rng() * 0.10,
      b: isGold ? 0.44 + rng() * 0.12 : 0.54 + rng() * 0.14,
    };
  }

  const isFir = y > 3050 ? rng() < 0.52 : rng() < 0.28;
  const elevShrink = y > 3200 ? 1 - ((y - 3200) / 300) * 0.42 : 1.0;
  const h = (9.0 + rng() * 9.5) * Math.max(0.45, elevShrink);
  const shade = 0.84 + rng() * 0.28;
  return {
    kind: isFir ? 1 : 0,
    height: h,
    widthScale: h * (0.72 + rng() * 0.18),
    r: shade * 0.96,
    g: shade * 1.02,
    b: shade * 0.96,
  };
}

export function createVegetation(engine, terrain, trailData, atmosphere) {
  const { scene, events } = engine;
  const textures = engine.worldTextures;

  const spruceGeo = buildConiferGeometry(false);
  const firGeo = buildConiferGeometry(true);
  const aspenGeo = buildAspenGeometry();
  const impostorGeo = buildCrossedQuadGeometry(2, 0.92);
  const grassGeo = buildCrossedQuadGeometry(3, 0.72);

  const solidTreeMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ vertexColors: true }),
    atmosphere.uniforms,
    { wind: true, windStrength: 0.032, foliage: true }
  );

  const impostorMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({
      map: textures.treeImpostor,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
    }),
    atmosphere.uniforms,
    { wind: true, windStrength: 0.026, foliage: true, atlasUv: true }
  );

  const grassMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({
      map: textures.grassFlower,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
    }),
    atmosphere.uniforms,
    { wind: true, windStrength: 0.085, foliage: true, atlasUv: true, fadeStart: 28, fadeEnd: 88 }
  );

  let tierCfg = TIER_CONFIG[engine.quality.tier] || TIER_CONFIG.medium;
  let lastTier = engine.quality.tier;
  let lastShadows = Boolean(engine.quality.shadows);
  let lastGrass = Boolean(engine.quality.grass);

  function makeInstancedPool(geo, mat, maxCount, castShadow, receiveShadow, hasAtlasRect) {
    const capacity = Math.max(1, maxCount);
    const g = geo.clone();
    if (hasAtlasRect) {
      g.setAttribute('aAtlasRect', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
    }
    const mesh = new THREE.InstancedMesh(g, mat, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    const dummyColor = new THREE.Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) mesh.setColorAt(i, dummyColor);
    mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    return mesh;
  }

  let spruceMesh = null;
  let firMesh = null;
  let aspenMesh = null;
  let impostorMesh = null;
  let grassMesh = null;

  function rebuildPools() {
    for (const m of [spruceMesh, firMesh, aspenMesh, impostorMesh, grassMesh]) {
      if (m) {
        scene.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
    }
    tierCfg = TIER_CONFIG[engine.quality.tier] || TIER_CONFIG.medium;
    const allowShadow = Boolean(engine.quality.shadows);

    spruceMesh = tierCfg.maxNear > 0
      ? makeInstancedPool(spruceGeo, solidTreeMat, tierCfg.maxNear, allowShadow, true, false)
      : null;
    firMesh = tierCfg.maxNear > 0
      ? makeInstancedPool(firGeo, solidTreeMat, Math.ceil(tierCfg.maxNear * 0.6), allowShadow, true, false)
      : null;
    aspenMesh = tierCfg.maxNear > 0
      ? makeInstancedPool(aspenGeo, solidTreeMat, Math.ceil(tierCfg.maxNear * 0.65), allowShadow, true, false)
      : null;
    impostorMesh = makeInstancedPool(impostorGeo, impostorMat, tierCfg.maxImp, false, false, true);
    grassMesh = engine.quality.grass && tierCfg.maxGrass > 0
      ? makeInstancedPool(grassGeo, grassMat, tierCfg.maxGrass, false, true, true)
      : null;
  }
  rebuildPools();

  const treeChunks = new Map();
  const grassChunks = new Map();
  let lastPackX = 1e9;
  let lastPackZ = 1e9;
  let poolsDirty = true;
  let checkCursor = 0;

  function buildTreeChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 101));
    const baseCount = Math.round(52 * tierCfg.density);
    const items = [];
    const x0 = cx * TREE_CELL_M;
    const z0 = cz * TREE_CELL_M;
    const bldgMask = engine.worldBuildingMask;

    for (let i = 0; i < baseCount; i++) {
      const x = x0 + rng() * TREE_CELL_M;
      const z = z0 + rng() * TREE_CELL_M;

      // Never spawn forest trees inside historic downtown blocks or near OSM buildings
      if (bldgMask) {
        if (bldgMask.isInTownCorridor(x, z) || bldgMask.isNearBuilding(x, z, 12.0)) continue;
      }

      // Generous road/street/trail clearance (15m off town roads, 6.5m off 4x4 tracks, 4m off trails)
      const near = trailData?.nearest?.(x, z, 16.0);
      if (near) {
        const minClear = near.kind === 'road' ? 15.0 : near.kind === 'track' ? 6.5 : 4.0;
        if (near.dist < minClear) continue;
      }

      const y = terrain.getHeight(x, z);
      const norm = terrain.getNormal(x, z);
      const surf = terrain.getSurface(x, z);
      const spec = pickTreeAt(x, z, y, norm.y, surf, rng);
      if (!spec) continue;

      items.push({
        x,
        y: y - 0.15,
        z,
        rot: rng() * Math.PI * 2,
        kind: spec.kind,
        h: spec.height,
        w: spec.widthScale,
        r: spec.r,
        g: spec.g,
        b: spec.b,
      });
    }

    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(x0 + TREE_CELL_M * 0.5, z0 + TREE_CELL_M * 0.5),
      items,
    };
  }

  function buildGrassChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 307));
    const count = Math.round(52 * tierCfg.density);
    const items = [];
    const x0 = cx * GRASS_CELL_M;
    const z0 = cz * GRASS_CELL_M;
    const bldgMask = engine.worldBuildingMask;

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * GRASS_CELL_M;
      const z = z0 + rng() * GRASS_CELL_M;

      // Keep wild tussock grass off town streets and building footprints
      if (bldgMask) {
        if (bldgMask.isInTownCorridor(x, z) || bldgMask.isNearBuilding(x, z, 10.0)) continue;
      }

      const near = trailData?.nearest?.(x, z, 10.5);
      if (near) {
        const minClear = near.kind === 'road' ? 9.5 : near.kind === 'track' ? 3.5 : 1.8;
        if (near.dist < minClear) continue;
      }

      const y = terrain.getHeight(x, z);
      if (y > 4180) continue;

      const norm = terrain.getNormal(x, z);
      if (norm.y < 0.65) continue;

      const surf = terrain.getSurface(x, z);
      if (surf.water > 0.2 || surf.snow > 0.45 || surf.rock > 0.72) continue;

      const flowerChance = y > 3350 ? 0.24 : 0.12;
      let kind = rng() < 0.62 ? 0 : 1;
      if (rng() < flowerChance) {
        kind = rng() < 0.65 ? 2 : 3;
      }

      const scale = kind >= 2 ? 0.34 + rng() * 0.22 : 0.38 + rng() * 0.35;
      items.push({
        x,
        y: y - 0.03,
        z,
        rot: rng() * Math.PI,
        kind,
        scale,
        shade: 0.88 + rng() * 0.24,
      });
    }

    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(x0 + GRASS_CELL_M * 0.5, z0 + GRASS_CELL_M * 0.5),
      items,
    };
  }

  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _col = new THREE.Color();

  function packPools(px, pz) {
    let spCount = 0;
    let fiCount = 0;
    let asCount = 0;
    let impCount = 0;
    let grCount = 0;

    const nearR2 = tierCfg.nearRadius * tierCfg.nearRadius;
    const farR2 = tierCfg.farRadius * tierCfg.farRadius;
    const impAttr = impostorMesh.geometry.attributes.aAtlasRect;

    const treeRing = Math.ceil(tierCfg.farRadius / TREE_CELL_M);
    const pcx = Math.floor(px / TREE_CELL_M);
    const pcz = Math.floor(pz / TREE_CELL_M);

    for (let dz = -treeRing; dz <= treeRing; dz++) {
      for (let dx = -treeRing; dx <= treeRing; dx++) {
        const chunk = treeChunks.get(`${pcx + dx},${pcz + dz}`);
        if (!chunk) continue;

        const items = chunk.items;
        for (let i = 0; i < items.length; i++) {
          const t = items[i];
          const ddx = t.x - px;
          const ddz = t.z - pz;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > farR2) continue;

          _pos.set(t.x, t.y, t.z);
          _quat.setFromAxisAngle(_yAxis, t.rot);
          _col.setRGB(t.r, t.g, t.b);

          if (d2 < nearR2 && t.kind !== 3) {
            _scale.set(t.w, t.h, t.w);
            _mat.compose(_pos, _quat, _scale);
            if (t.kind === 0 && spruceMesh && spCount < spruceMesh.instanceMatrix.count) {
              spruceMesh.setMatrixAt(spCount, _mat);
              spruceMesh.setColorAt(spCount, _col);
              spCount++;
              continue;
            }
            if (t.kind === 1 && firMesh && fiCount < firMesh.instanceMatrix.count) {
              firMesh.setMatrixAt(fiCount, _mat);
              firMesh.setColorAt(fiCount, _col);
              fiCount++;
              continue;
            }
            if (t.kind === 2 && aspenMesh && asCount < aspenMesh.instanceMatrix.count) {
              aspenMesh.setMatrixAt(asCount, _mat);
              aspenMesh.setColorAt(asCount, _col);
              asCount++;
              continue;
            }
          }

          if (impCount < impostorMesh.instanceMatrix.count) {
            _scale.set(t.w, t.h, t.w);
            _mat.compose(_pos, _quat, _scale);
            impostorMesh.setMatrixAt(impCount, _mat);
            impostorMesh.setColorAt(impCount, _col);
            const rect = ATLAS_RECTS[t.kind];
            impAttr.setXYZW(impCount, rect[0], rect[1], rect[2], rect[3]);
            impCount++;
          }
        }
      }
    }

    if (spruceMesh) {
      spruceMesh.count = spCount;
      spruceMesh.instanceMatrix.needsUpdate = true;
      spruceMesh.instanceColor.needsUpdate = true;
    }
    if (firMesh) {
      firMesh.count = fiCount;
      firMesh.instanceMatrix.needsUpdate = true;
      firMesh.instanceColor.needsUpdate = true;
    }
    if (aspenMesh) {
      aspenMesh.count = asCount;
      aspenMesh.instanceMatrix.needsUpdate = true;
      aspenMesh.instanceColor.needsUpdate = true;
    }
    impostorMesh.count = impCount;
    impostorMesh.instanceMatrix.needsUpdate = true;
    impostorMesh.instanceColor.needsUpdate = true;
    impAttr.needsUpdate = true;

    if (grassMesh) {
      const grR2 = tierCfg.grassRadius * tierCfg.grassRadius;
      const grAttr = grassMesh.geometry.attributes.aAtlasRect;
      const grassRing = Math.ceil(tierCfg.grassRadius / GRASS_CELL_M);
      const gcx = Math.floor(px / GRASS_CELL_M);
      const gcz = Math.floor(pz / GRASS_CELL_M);

      for (let dz = -grassRing; dz <= grassRing; dz++) {
        for (let dx = -grassRing; dx <= grassRing; dx++) {
          const chunk = grassChunks.get(`${gcx + dx},${gcz + dz}`);
          if (!chunk) continue;

          const items = chunk.items;
          for (let i = 0; i < items.length && grCount < grassMesh.instanceMatrix.count; i++) {
            const g = items[i];
            const ddx = g.x - px;
            const ddz = g.z - pz;
            if (ddx * ddx + ddz * ddz > grR2) continue;
            _pos.set(g.x, g.y, g.z);
            _quat.setFromAxisAngle(_yAxis, g.rot);
            _scale.set(g.scale, g.scale, g.scale);
            _mat.compose(_pos, _quat, _scale);
            _col.setRGB(g.shade, g.shade, g.shade);
            grassMesh.setMatrixAt(grCount, _mat);
            grassMesh.setColorAt(grCount, _col);
            const rect = ATLAS_RECTS[g.kind];
            grAttr.setXYZW(grCount, rect[0], rect[1], rect[2], rect[3]);
            grCount++;
          }
        }
      }
      grassMesh.count = grCount;
      grassMesh.instanceMatrix.needsUpdate = true;
      grassMesh.instanceColor.needsUpdate = true;
      grAttr.needsUpdate = true;
    }
  }

  // Guarded quality listener: ignore pure renderScale adaptive adjustments!
  const unsubQuality = events.on('quality:changed', (q) => {
    const nextTier = q?.tier ?? engine.quality.tier;
    const nextShadows = Boolean(engine.quality.shadows);
    const nextGrass = Boolean(engine.quality.grass);
    if (nextTier === lastTier && nextShadows === lastShadows && nextGrass === lastGrass) return;

    const tierChanged = nextTier !== lastTier;
    lastTier = nextTier;
    lastShadows = nextShadows;
    lastGrass = nextGrass;
    if (tierChanged) {
      treeChunks.clear();
      grassChunks.clear();
    }
    rebuildPools();
    poolsDirty = true;
  });

  // Invalidate overlapping vegetation cells when new road/trail/building vector chunks stream in!
  const unsubChunk = events.on('data:chunk', (payload) => {
    if (typeof payload?.tx === 'number' && typeof payload?.ty === 'number') {
      const b = tileBoundsWorld(13, payload.tx, payload.ty);
      const pad = 20;
      const tcx0 = Math.floor((b.minX - pad) / TREE_CELL_M);
      const tcx1 = Math.floor((b.maxX + pad) / TREE_CELL_M);
      const tcz0 = Math.floor((b.minZ - pad) / TREE_CELL_M);
      const tcz1 = Math.floor((b.maxZ + pad) / TREE_CELL_M);
      for (let cz = tcz0; cz <= tcz1; cz++) {
        for (let cx = tcx0; cx <= tcx1; cx++) {
          if (treeChunks.delete(`${cx},${cz}`)) poolsDirty = true;
        }
      }
      const gcx0 = Math.floor((b.minX - pad) / GRASS_CELL_M);
      const gcx1 = Math.floor((b.maxX + pad) / GRASS_CELL_M);
      const gcz0 = Math.floor((b.minZ - pad) / GRASS_CELL_M);
      const gcz1 = Math.floor((b.maxZ + pad) / GRASS_CELL_M);
      for (let cz = gcz0; cz <= gcz1; cz++) {
        for (let cx = gcx0; cx <= gcx1; cx++) {
          if (grassChunks.delete(`${cx},${cz}`)) poolsDirty = true;
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

    const treeRing = Math.ceil(tierCfg.farRadius / TREE_CELL_M);
    const pcx = Math.floor(px / TREE_CELL_M);
    const pcz = Math.floor(pz / TREE_CELL_M);

    let builtTrees = 0;
    outerTree: for (let r = 0; r <= treeRing; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const dist = Math.hypot((cx + 0.5) * TREE_CELL_M - px, (cz + 0.5) * TREE_CELL_M - pz);
          if (dist > tierCfg.farRadius + TREE_CELL_M) continue;

          const key = `${cx},${cz}`;
          if (treeChunks.has(key)) continue;

          treeChunks.set(key, buildTreeChunk(cx, cz));
          poolsDirty = true;
          builtTrees++;
          if (builtTrees >= 2 || performance.now() - t0 > 1.4) break outerTree;
        }
      }
    }

    if (grassMesh && tierCfg.grassRadius > 0 && performance.now() - t0 < 1.6) {
      const grassRing = Math.ceil(tierCfg.grassRadius / GRASS_CELL_M);
      const gcx = Math.floor(px / GRASS_CELL_M);
      const gcz = Math.floor(pz / GRASS_CELL_M);
      let builtGrass = 0;
      outerGrass: for (let r = 0; r <= grassRing; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = gcx + dx;
            const cz = gcz + dz;
            const key = `${cx},${cz}`;
            if (grassChunks.has(key)) continue;

            grassChunks.set(key, buildGrassChunk(cx, cz));
            poolsDirty = true;
            builtGrass++;
            if (builtGrass >= 2 || performance.now() - t0 > 1.8) break outerGrass;
          }
        }
      }
    }

    const span = treeRing * 2 + 1;
    const totalRingCells = span * span;
    if (totalRingCells > 0) {
      const idx = checkCursor % totalRingCells;
      checkCursor = (checkCursor + 1) | 0;
      const dx = (idx % span) - treeRing;
      const dz = Math.floor(idx / span) - treeRing;
      const key = `${pcx + dx},${pcz + dz}`;
      const ch = treeChunks.get(key);
      if (ch) {
        const newH = terrain.getHeight((ch.cx + 0.5) * TREE_CELL_M, (ch.cz + 0.5) * TREE_CELL_M);
        if (Math.abs(newH - ch.centerH) > 1.5) {
          treeChunks.delete(key);
          poolsDirty = true;
        }
      }
    }

    while (treeChunks.size > 420) {
      const oldestKey = treeChunks.keys().next().value;
      if (oldestKey === undefined) break;
      treeChunks.delete(oldestKey);
    }
    while (grassChunks.size > 110) {
      const oldestKey = grassChunks.keys().next().value;
      if (oldestKey === undefined) break;
      grassChunks.delete(oldestKey);
    }

    const moveDist = Math.hypot(px - lastPackX, pz - lastPackZ);
    if (poolsDirty || moveDist > 14) {
      packPools(px, pz);
      lastPackX = px;
      lastPackZ = pz;
      poolsDirty = false;
    }
  }

  function dispose() {
    unsubQuality();
    unsubChunk();
    for (const m of [spruceMesh, firMesh, aspenMesh, impostorMesh, grassMesh]) {
      if (m) {
        scene.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
    }
    spruceGeo.dispose();
    firGeo.dispose();
    aspenGeo.dispose();
    impostorGeo.dispose();
    grassGeo.dispose();
    solidTreeMat.dispose();
    impostorMat.dispose();
    grassMat.dispose();
    treeChunks.clear();
    grassChunks.clear();
  }

  return { update, dispose };
}
