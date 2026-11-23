import * as THREE from 'three';
import { mulberry32 } from '../noise.js';

/**
 * Sculpt a geologically fractured San Juan talus boulder using cleavage planes + strata ridges,
 * with box-projected UVs (no polar stretching) and crevice/base AO vertex colors.
 */
function sculptFracturedRock(detail, seed, { sx = 1.0, sy = 0.78, sz = 1.0, planeCount = 11 } = {}) {
  const rng = mulberry32(seed);
  const raw = new THREE.IcosahedronGeometry(1.0, detail);
  // IcosahedronGeometry is already non-indexed in Three.js r174; only convert if indexed
  const geo = raw.index ? raw.toNonIndexed() : raw;
  if (geo !== raw) raw.dispose();

  // Generate random cleavage fracture planes around unit sphere
  const planes = [];
  for (let i = 0; i < planeCount; i++) {
    const theta = rng() * Math.PI * 2;
    const phi = Math.acos(2 * rng() - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(theta);
    const dist = 0.62 + rng() * 0.28;
    const cut = 0.52 + rng() * 0.34;
    planes.push({ nx, ny, nz, dist, cut });
  }

  // Deterministic vertex displacement by quantized original position (keeps shared seams welded!)
  const pos = geo.attributes.position;
  const count = pos.count;
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);

  const dispCache = new Map();
  for (let i = 0; i < count; i++) {
    const ox = pos.getX(i);
    const oy = pos.getY(i);
    const oz = pos.getZ(i);
    const key = `${Math.round(ox * 1000)},${Math.round(oy * 1000)},${Math.round(oz * 1000)}`;
    let p = dispCache.get(key);
    if (!p) {
      let x = ox;
      let y = oy;
      let z = oz;

      // Apply geological fracture cleavage planes
      for (let k = 0; k < planes.length; k++) {
        const pl = planes[k];
        const over = x * pl.nx + y * pl.ny + z * pl.nz - pl.dist;
        if (over > 0) {
          x -= pl.nx * over * pl.cut;
          y -= pl.ny * over * pl.cut;
          z -= pl.nz * over * pl.cut;
        }
      }

      // Subtle volcanic strata ledge & organic micro-roughness
      const strata = 1.0 + 0.06 * Math.sin(y * 7.5 + x * 2.1);
      const rough = 0.94 + 0.12 * Math.sin(x * 9.3 + z * 11.7) * Math.cos(y * 8.1 - x * 4.3);
      x *= sx * strata * rough;
      y *= (y < 0 ? sy * 0.68 : sy) * rough;
      z *= sz * strata * rough;

      p = [x, y, z];
      dispCache.set(key, p);
    }
    pos.setXYZ(i, p[0], p[1], p[2]);
  }

  // Compute crisp organic vertex normals (per-triangle face normal blended with radial smooth normal
  // so edges catch crisp sunlight without looking like faceted low-poly origami!)
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const rn = new THREE.Vector3();
  const normals = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    e1.subVectors(vB, vA);
    e2.subVectors(vC, vA);
    fn.crossVectors(e1, e2).normalize();

    const ax = Math.abs(fn.x);
    const ay = Math.abs(fn.y);
    const az = Math.abs(fn.z);

    for (let k = 0; k < 3; k++) {
      const idx = i + k;
      const vx = pos.getX(idx);
      const vy = pos.getY(idx);
      const vz = pos.getZ(idx);

      // Blend 72% face normal + 28% smooth outward normal for authentic chiselled rock lighting
      rn.set(vx, vy, vz).normalize();
      const nx = fn.x * 0.72 + rn.x * 0.28;
      const ny = fn.y * 0.72 + rn.y * 0.28;
      const nz = fn.z * 0.72 + rn.z * 0.28;
      const inv = 1 / (Math.hypot(nx, ny, nz) || 1);
      normals[idx * 3] = nx * inv;
      normals[idx * 3 + 1] = ny * inv;
      normals[idx * 3 + 2] = nz * inv;

      // Box-projected UVs based on dominant face normal axis
      const uvScale = 0.65;
      if (ay >= ax && ay >= az) {
        uvs[idx * 2] = vx * uvScale + 0.5;
        uvs[idx * 2 + 1] = vz * uvScale + 0.5;
      } else if (ax >= az) {
        uvs[idx * 2] = vz * uvScale + 0.5;
        uvs[idx * 2 + 1] = vy * uvScale + 0.5;
      } else {
        uvs[idx * 2] = vx * uvScale + 0.5;
        uvs[idx * 2 + 1] = vy * uvScale + 0.5;
      }

      // Ground contact AO + sunlit top face highlight
      const rLen = Math.hypot(vx, vy, vz);
      const creviceAO = Math.min(1.06, Math.max(0.55, 0.45 + rLen * 0.65));
      const vertAO = vy < 0 ? 0.54 : 0.78 + Math.min(0.28, Math.max(0, fn.y) * 0.28);
      const ao = creviceAO * vertAO;
      colors[idx * 3] = ao;
      colors[idx * 3 + 1] = ao;
      colors[idx * 3 + 2] = ao;
    }
  }

  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Variant A: Blocky angular fractured San Juan granite/andesite boulder (80 tris + normal map).
 */
export function buildAngularBoulderGeometry() {
  return sculptFracturedRock(1, 1337, { sx: 1.05, sy: 0.84, sz: 0.96, planeCount: 11 });
}

/**
 * Variant B: Wider stratified volcanic slab / alpine outcrop boulder (80 tris + normal map).
 */
export function buildStratifiedSlabGeometry() {
  return sculptFracturedRock(1, 4919, { sx: 1.28, sy: 0.56, sz: 1.02, planeCount: 10 });
}

/**
 * Variant C: Natural multi-stone scree cobble cluster (4 stones merged into 1 instance = 80 tris!)
 * so talus fields & trail margins feel rich and rocky at tiny GPU cost.
 */
export function buildScreeClusterGeometry() {
  const specs = [
    { seed: 7001, tx: 0.0, ty: 0.0, tz: 0.0, s: 0.24, sx: 1.15, sy: 0.65, sz: 0.92, ry: 0.2 },
    { seed: 7013, tx: 0.42, ty: -0.02, tz: 0.28, s: 0.17, sx: 0.95, sy: 0.58, sz: 1.18, ry: 1.8 },
    { seed: 7027, tx: -0.36, ty: -0.01, tz: 0.31, s: 0.14, sx: 1.22, sy: 0.52, sz: 0.85, ry: 3.1 },
    { seed: 7039, tx: 0.12, ty: -0.02, tz: -0.40, s: 0.19, sx: 1.05, sy: 0.62, sz: 1.05, ry: 4.5 },
  ];

  const parts = specs.map((sp) => {
    const g = sculptFracturedRock(0, sp.seed, { sx: sp.sx, sy: sp.sy, sz: sp.sz, planeCount: 6 });
    g.scale(sp.s, sp.s, sp.s);
    g.rotateY(sp.ry);
    g.translate(sp.tx, sp.ty, sp.tz);
    return g;
  });

  let total = 0;
  for (const p of parts) total += p.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const norm = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const col = new Float32Array(total * 3);

  let off = 0;
  for (const p of parts) {
    const c = p.attributes.position.count;
    pos.set(p.attributes.position.array, off * 3);
    norm.set(p.attributes.normal.array, off * 3);
    uv.set(p.attributes.uv.array, off * 2);
    col.set(p.attributes.color.array, off * 3);
    off += c;
    p.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.computeBoundingSphere();
  return merged;
}
