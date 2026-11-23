import * as THREE from 'three';
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

// UV rects [u0, v0, uScale, vScale] for 2x2 atlases with 2-texel inset to prevent mipmap bleeding
const ATLAS_RECTS = [
  [0.008, 0.508, 0.484, 0.484], // Q0 top-left: Spruce / Tussock Grass
  [0.508, 0.508, 0.484, 0.484], // Q1 top-right: Fir / Golden Sedge
  [0.008, 0.008, 0.484, 0.484], // Q2 bottom-left: Aspen / Blue Columbine
  [0.508, 0.008, 0.484, 0.484], // Q3 bottom-right: Krummholz-Willow / Paintbrush
];

/**
 * Merge an array of non-indexed or indexed geometries (having position, normal, color) into one BufferGeometry.
 */
function mergeColoredGeometries(parts) {
  let totalVerts = 0;
  const nonIndexed = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of nonIndexed) totalVerts += g.attributes.position.count;

  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const col = new Float32Array(totalVerts * 3);
  let offset = 0;

  for (const g of nonIndexed) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const c = g.attributes.color.array;
    pos.set(p, offset * 3);
    norm.set(n, offset * 3);
    col.set(c, offset * 3);
    offset += g.attributes.position.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function colorizeGeometry(geo, r, g, b, shadeBottom = 0.72) {
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
 * Unit-height (y in [0, 1]) 3D Engelmann Spruce or Subalpine Fir geometry.
 */
function buildConiferGeometry(isFir) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.012, 0.042, 0.85, 6);
  trunk.translate(0, 0.425, 0);
  parts.push(colorizeGeometry(trunk, 0.25, 0.16, 0.11, 0.8));

  const layers = isFir ? 9 : 8;
  const maxRad = isFir ? 0.14 : 0.18;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1); // 0 bottom -> 1 top
    const yBase = 0.16 + t * 0.72;
    const h = 0.24 - t * 0.09;
    const rad = maxRad * (1 - t * 0.78);
    const cone = new THREE.ConeGeometry(rad, h, 8, 1);
    const pos = cone.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const py = pos.getY(v);
      if (py < 0) {
        const ang = Math.atan2(pos.getZ(v), pos.getX(v));
        const j = 0.85 + 0.28 * Math.sin(ang * 3 + i * 1.9);
        pos.setX(v, pos.getX(v) * j);
        pos.setZ(v, pos.getZ(v) * j);
        pos.setY(v, py - 0.015 * Math.cos(ang * 4 + i));
      }
    }
    cone.computeVertexNormals();
    cone.rotateY(i * 0.55);
    cone.translate(0, yBase + h * 0.45, 0);
    const r = isFir ? 0.09 : 0.10;
    const g = isFir ? 0.22 : 0.25;
    const b = isFir ? 0.12 : 0.13;
    parts.push(colorizeGeometry(cone, r, g, b, 0.55));
  }
  return mergeColoredGeometries(parts);
}

/**
 * Unit-height (y in [0, 1]) 3D Quaking Aspen geometry (white trunk + airy crown lobes).
 */
function buildAspenGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.012, 0.032, 0.78, 6);
  trunk.translate(0, 0.39, 0);
  parts.push(colorizeGeometry(trunk, 0.86, 0.84, 0.78, 0.72));

  const fork = new THREE.CylinderGeometry(0.007, 0.014, 0.30, 5);
  fork.rotateZ(0.38);
  fork.translate(-0.06, 0.56, 0.02);
  parts.push(colorizeGeometry(fork, 0.84, 0.82, 0.76, 0.85));

  const lobes = [
    [0.0, 0.80, 0.0, 0.21],
    [-0.12, 0.67, 0.05, 0.17],
    [0.12, 0.70, -0.04, 0.16],
    [0.02, 0.58, 0.10, 0.15],
    [-0.04, 0.90, -0.02, 0.14],
  ];
  for (const [lx, ly, lz, lr] of lobes) {
    const ico = new THREE.IcosahedronGeometry(lr, 0);
    ico.scale(1.0, 1.15, 1.0);
    ico.translate(lx, ly, lz);
    parts.push(colorizeGeometry(ico, 0.62, 0.74, 0.25, 0.68));
  }
  return mergeColoredGeometries(parts);
}

/**
 * Crossed vertical quad geometry (y in [0, 1]) for far tree impostors & krummholz/willow.
 */
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
    const nx = -Math.sin(ang) * 0.35;
    const nz = Math.cos(ang) * 0.35;
    const nl = Math.hypot(nx, 0.87, nz);
    const base = i * 4;

    positions.push(-dx, 0, -dz, dx, 0, dz, dx, 1, dz, -dx, 1, -dz);
    for (let v = 0; v < 4; v++) normals.push(nx / nl, 0.87 / nl, nz / nl);
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

/**
 * Determine species & scale from San Juan elevation, slope, cover mask, and noise.
 * Returns { kind: 0 spruce | 1 fir | 2 aspen | 3 krummholz/willow, height, widthScale, tint } or null.
 */
function pickTreeAt(x, z, y, normalY, surface, rng) {
  // Too steep for trees
  if (normalY < 0.64) return null;

  // Water exclusion
  if (surface.water > 0.25) return null;

  const hasCoverData =
    (surface.forest + surface.rock + surface.water + surface.snow + surface.grass) > 0.05;

  const forestWeight = hasCoverData
    ? surface.forest
    : (y < 3620 ? Math.max(0, (fbm2D(x * 0.0022, z * 0.0022, 3, 19) - 0.32) * 1.45) : 0);

  // Above San Juan treeline (~12,000 ft = 3,660m) -> no trees
  if (y > 3680) return null;

  // Treeline krummholz zone (3,430m - 3,680m)
  if (y > 3430) {
    const treelineFade = 1 - (y - 3430) / 250;
    const chance = Math.max(forestWeight, 0.22) * treelineFade * 0.65;
    if (rng() > chance || normalY < 0.68) return null;
    const h = 1.1 + rng() * 1.6;
    return {
      kind: 3, // Krummholz
      height: h,
      widthScale: h * (1.2 + rng() * 0.6),
      r: 0.78 + rng() * 0.22,
      g: 0.85 + rng() * 0.20,
      b: 0.72 + rng() * 0.18,
    };
  }

  // Valley & subalpine forest (below 3,430m)
  // Riparian willows in flat low valley floors (< 2,820m) where forest isn't dense
  if (y < 2820 && normalY > 0.92 && forestWeight < 0.35 && surface.grass > 0.2) {
    if (rng() < 0.14) {
      const h = 1.6 + rng() * 1.8;
      return {
        kind: 3,
        height: h,
        widthScale: h * 1.15,
        r: 0.62,
        g: 0.88,
        b: 0.52,
      };
    }
  }

  if (forestWeight < 0.16 || rng() > forestWeight * 1.12) return null;

  // Aspen grove clustering (2,550m - 3,360m, gentler slopes, warm patches)
  const groveNoise = fbm2D(x * 0.0042, z * 0.0042, 3, 503);
  const inAspenZone = y >= 2500 && y <= 3360 && normalY > 0.76;
  if (inAspenZone && groveNoise > 0.53 && rng() < (groveNoise - 0.45) * 1.9) {
    const h = 7.5 + rng() * 6.5;
    // Slight golden-autumn to bright-green variation across groves
    const gold = fbm2D(x * 0.0028, z * 0.0028, 2, 709);
    const isGold = gold > 0.48;
    return {
      kind: 2, // Quaking Aspen
      height: h,
      widthScale: h * (0.85 + rng() * 0.25),
      r: isGold ? 0.92 + rng() * 0.08 : 0.78 + rng() * 0.14,
      g: isGold ? 0.84 + rng() * 0.10 : 0.88 + rng() * 0.10,
      b: isGold ? 0.42 + rng() * 0.12 : 0.52 + rng() * 0.14,
    };
  }

  // Engelmann Spruce (0) vs Subalpine Fir (1)
  const isFir = y > 3050 ? rng() < 0.52 : rng() < 0.28;
  const elevShrink = y > 3200 ? 1 - ((y - 3200) / 300) * 0.42 : 1.0;
  const h = (9.0 + rng() * 9.5) * Math.max(0.45, elevShrink);
  const shade = 0.80 + rng() * 0.32;
  return {
    kind: isFir ? 1 : 0,
    height: h,
    widthScale: h * (0.70 + rng() * 0.18),
    r: shade * 0.95,
    g: shade * 1.02,
    b: shade * 0.96,
  };
}

export function createVegetation(engine, terrain, trailData, atmosphere) {
  const { scene, events } = engine;
  const textures = engine.worldTextures;

  // Materials (patched with San Juan height fog + GPU wind)
  const spruceGeo = buildConiferGeometry(false);
  const firGeo = buildConiferGeometry(true);
  const aspenGeo = buildAspenGeometry();
  const impostorGeo = buildCrossedQuadGeometry(2, 0.92);
  const grassGeo = buildCrossedQuadGeometry(3, 0.72);

  const solidTreeMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ vertexColors: true }),
    atmosphere.uniforms,
    { wind: true, windStrength: 0.032 }
  );

  const impostorMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({
      map: textures.treeImpostor,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
    }),
    atmosphere.uniforms,
    { wind: true, windStrength: 0.026, atlasUv: true }
  );

  const grassMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({
      map: textures.grassFlower,
      alphaTest: 0.38,
      side: THREE.DoubleSide,
    }),
    atmosphere.uniforms,
    { wind: true, windStrength: 0.085, atlasUv: true, fadeStart: 28, fadeEnd: 88 }
  );

  // Global pooled InstancedMeshes (5 draw calls max across entire mountain range!)
  let tierCfg = TIER_CONFIG[engine.quality.tier] || TIER_CONFIG.medium;

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
    // Initialize instanceColor buffer
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
    grassMesh = (engine.quality.grass && tierCfg.maxGrass > 0)
      ? makeInstancedPool(grassGeo, grassMat, tierCfg.maxGrass, false, true, true)
      : null;
  }
  rebuildPools();

  // Chunk caches: key = `${cx},${cz}`
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

    for (let i = 0; i < baseCount; i++) {
      const x = x0 + rng() * TREE_CELL_M;
      const z = z0 + rng() * TREE_CELL_M;
      const y = terrain.getHeight(x, z);
      const norm = terrain.getNormal(x, z);
      const surf = terrain.getSurface(x, z);
      const spec = pickTreeAt(x, z, y, norm.y, surf, rng);
      if (!spec) continue;

      // Never place trees on trails or roads
      const near = trailData?.nearest?.(x, z, 4.2);
      if (near && near.dist < (near.kind === 'road' ? 5.5 : 3.2)) continue;

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
      lastUsed: performance.now(),
    };
  }

  function buildGrassChunk(cx, cz) {
    const rng = mulberry32(hash2i(cx, cz, 307));
    const count = Math.round(55 * tierCfg.density);
    const items = [];
    const x0 = cx * GRASS_CELL_M;
    const z0 = cz * GRASS_CELL_M;

    for (let i = 0; i < count; i++) {
      const x = x0 + rng() * GRASS_CELL_M;
      const z = z0 + rng() * GRASS_CELL_M;
      const y = terrain.getHeight(x, z);
      if (y > 4180) continue;

      const norm = terrain.getNormal(x, z);
      if (norm.y < 0.65) continue;

      const surf = terrain.getSurface(x, z);
      if (surf.water > 0.2 || surf.snow > 0.45 || surf.rock > 0.72) continue;

      const near = trailData?.nearest?.(x, z, 2.0);
      if (near && near.dist < 1.3) continue;

      // In alpine tundra (> 3450m) & meadows, add Colorado Blue Columbine + Indian Paintbrush!
      const flowerChance = y > 3350 ? 0.24 : 0.11;
      let kind = rng() < 0.62 ? 0 : 1; // grass or golden sedge
      if (rng() < flowerChance) {
        kind = rng() < 0.65 ? 2 : 3; // Blue Columbine or Indian Paintbrush
      }

      const scale = kind >= 2 ? (0.34 + rng() * 0.22) : (0.38 + rng() * 0.35);
      items.push({
        x,
        y: y - 0.03,
        z,
        rot: rng() * Math.PI,
        kind,
        scale,
        shade: 0.82 + rng() * 0.32,
      });
    }

    return {
      key: `${cx},${cz}`,
      cx,
      cz,
      centerH: terrain.getHeight(x0 + GRASS_CELL_M * 0.5, z0 + GRASS_CELL_M * 0.5),
      items,
      lastUsed: performance.now(),
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

    for (const chunk of treeChunks.values()) {
      const cdx = (chunk.cx + 0.5) * TREE_CELL_M - px;
      const cdz = (chunk.cz + 0.5) * TREE_CELL_M - pz;
      const cDist2 = cdx * cdx + cdz * cdz;
      if (cDist2 > (tierCfg.farRadius + TREE_CELL_M) ** 2) continue;

      const items = chunk.items;
      for (let i = 0; i < items.length; i++) {
        const t = items[i];
        const dx = t.x - px;
        const dz = t.z - pz;
        const d2 = dx * dx + dz * dz;
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
      for (const chunk of grassChunks.values()) {
        const cdx = (chunk.cx + 0.5) * GRASS_CELL_M - px;
        const cdz = (chunk.cz + 0.5) * GRASS_CELL_M - pz;
        if (cdx * cdx + cdz * cdz > (tierCfg.grassRadius + GRASS_CELL_M) ** 2) continue;

        const items = chunk.items;
        for (let i = 0; i < items.length && grCount < grassMesh.instanceMatrix.count; i++) {
          const g = items[i];
          const dx = g.x - px;
          const dz = g.z - pz;
          if (dx * dx + dz * dz > grR2) continue;
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
      grassMesh.count = grCount;
      grassMesh.instanceMatrix.needsUpdate = true;
      grassMesh.instanceColor.needsUpdate = true;
      grAttr.needsUpdate = true;
    }
  }

  const unsubQuality = events.on('quality:changed', () => {
    treeChunks.clear();
    grassChunks.clear();
    rebuildPools();
    poolsDirty = true;
  });

  // Invalidate nearby chunks when new terrain or vector data finishes streaming
  const unsubTerrain = events.on('terrain:tile', () => {
    poolsDirty = true;
  });

  function update(dt, playerPos) {
    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;
    const now = performance.now();

    // Time-sliced chunk streaming (at most 2 tree chunks + 2 grass chunks per frame)
    const treeRing = Math.ceil(tierCfg.farRadius / TREE_CELL_M);
    const pcx = Math.floor(px / TREE_CELL_M);
    const pcz = Math.floor(pz / TREE_CELL_M);

    let builtTrees = 0;
    outerTree: for (let r = 0; r <= treeRing && builtTrees < 2; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const cx = pcx + dx;
          const cz = pcz + dz;
          const dist = Math.hypot((cx + 0.5) * TREE_CELL_M - px, (cz + 0.5) * TREE_CELL_M - pz);
          if (dist > tierCfg.farRadius + TREE_CELL_M) continue;

          const key = `${cx},${cz}`;
          const existing = treeChunks.get(key);
          if (existing) {
            existing.lastUsed = now;
            continue;
          }
          treeChunks.set(key, buildTreeChunk(cx, cz));
          poolsDirty = true;
          builtTrees++;
          if (builtTrees >= 2) break outerTree;
        }
      }
    }

    // Grass streaming
    if (grassMesh && tierCfg.grassRadius > 0) {
      const grassRing = Math.ceil(tierCfg.grassRadius / GRASS_CELL_M);
      const gcx = Math.floor(px / GRASS_CELL_M);
      const gcz = Math.floor(pz / GRASS_CELL_M);
      let builtGrass = 0;
      outerGrass: for (let r = 0; r <= grassRing && builtGrass < 2; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
            const cx = gcx + dx;
            const cz = gcz + dz;
            const key = `${cx},${cz}`;
            const existing = grassChunks.get(key);
            if (existing) {
              existing.lastUsed = now;
              continue;
            }
            grassChunks.set(key, buildGrassChunk(cx, cz));
            poolsDirty = true;
            builtGrass++;
            if (builtGrass >= 2) break outerGrass;
          }
        }
      }
    }

    // Periodic height-refinement check: if higher-LOD terrain changed elevation under a chunk, rebuild it
    if (treeChunks.size > 0) {
      const keys = Array.from(treeChunks.keys());
      const key = keys[checkCursor % keys.length];
      checkCursor++;
      const ch = treeChunks.get(key);
      if (ch) {
        const newH = terrain.getHeight((ch.cx + 0.5) * TREE_CELL_M, (ch.cz + 0.5) * TREE_CELL_M);
        if (Math.abs(newH - ch.centerH) > 1.5) {
          treeChunks.delete(key);
          poolsDirty = true;
        }
      }
    }

    // Prune stale chunks beyond cache limits
    if (treeChunks.size > 480) {
      for (const [k, ch] of treeChunks) {
        if (now - ch.lastUsed > 20000) treeChunks.delete(k);
        if (treeChunks.size <= 360) break;
      }
    }
    if (grassChunks.size > 140) {
      for (const [k, ch] of grassChunks) {
        if (now - ch.lastUsed > 12000) grassChunks.delete(k);
        if (grassChunks.size <= 90) break;
      }
    }

    const moveDist = Math.hypot(px - lastPackX, pz - lastPackZ);
    if (poolsDirty || moveDist > 12) {
      packPools(px, pz);
      lastPackX = px;
      lastPackZ = pz;
      poolsDirty = false;
    }
  }

  function dispose() {
    unsubQuality();
    unsubTerrain();
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
