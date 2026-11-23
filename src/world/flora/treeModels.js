import * as THREE from 'three';
import { mulberry32 } from '../noise.js';
import { FOLIAGE_ATLAS_RECTS } from './floraTextures.js';

// ============================================================================
// Low-level Geometry Builders (zero leaks, typed arrays, baked AO & bent normals)
// ============================================================================

function makeBuilder() {
  return { pos: [], norm: [], uv: [], col: [], idx: [] };
}

function finalizeBuilder(b) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  geo.setIndex(b.idx);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Append a curved tapered tubular trunk/limb with bark UV strip mapping.
 * @param {ReturnType<typeof makeBuilder>} b
 * @param {Array<[number,number,number,number]>} spine - [x, y, z, radius]
 * @param {number} radialSegs
 * @param {[number,number]} uRange - [uMin, uMax] in barkAtlas
 * @param {number} vRepeat
 * @param {[number,number,number]} tint
 */
function addTaperedTube(b, spine, radialSegs, uRange, vRepeat = 1.0, tint = [1, 1, 1], vOffset = 0.0) {
  const rings = spine.length;
  const baseVert = b.pos.length / 3;
  const [u0, u1] = uRange;
  const uSpan = u1 - u0;

  let cumLen = 0;
  const cumLens = [0];
  for (let r = 1; r < rings; r++) {
    const dx = spine[r][0] - spine[r - 1][0];
    const dy = spine[r][1] - spine[r - 1][1];
    const dz = spine[r][2] - spine[r - 1][2];
    cumLen += Math.hypot(dx, dy, dz);
    cumLens.push(cumLen);
  }
  const invLen = cumLen > 1e-5 ? 1 / cumLen : 1;

  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const upRef = new THREE.Vector3(0, 0, 1);
  const altRef = new THREE.Vector3(1, 0, 0);

  for (let r = 0; r < rings; r++) {
    const [cx, cy, cz, rad] = spine[r];
    const prev = spine[Math.max(0, r - 1)];
    const next = spine[Math.min(rings - 1, r + 1)];
    tangent.set(next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]).normalize();
    if (tangent.lengthSq() < 1e-4) tangent.set(0, 1, 0);

    const ref = Math.abs(tangent.z) > 0.9 ? altRef : upRef;
    right.crossVectors(ref, tangent).normalize();
    fwd.crossVectors(tangent, right).normalize();

    const tNorm = cumLens[r] * invLen;
    const vCoord = vOffset + tNorm * vRepeat;
    // Ground contact AO near base of trunk
    const ao = r === 0 ? 0.62 : 0.78 + 0.24 * Math.min(1, tNorm * 1.4);

    for (let s = 0; s <= radialSegs; s++) {
      const uFrac = s / radialSegs;
      const ang = uFrac * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);

      // Subtle fluted root flare at very bottom ring
      const flare = r === 0 ? 1.0 + 0.14 * Math.sin(ang * 4.0) : 1.0;
      const nx = right.x * ca + fwd.x * sa;
      const ny = right.y * ca + fwd.y * sa;
      const nz = right.z * ca + fwd.z * sa;

      b.pos.push(cx + nx * rad * flare, cy + ny * rad * flare, cz + nz * rad * flare);
      b.norm.push(nx, ny, nz);
      b.uv.push(u0 + uFrac * uSpan, vCoord);
      b.col.push(tint[0] * ao, tint[1] * ao, tint[2] * ao);
    }
  }

  const stride = radialSegs + 1;
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < radialSegs; s++) {
      const a = baseVert + r * stride + s;
      const c = a + stride;
      b.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
}

/**
 * Append a V-folded curved conifer bough card (6 verts, 4 tris) radiating outward from (ox, oy, oz).
 * Folded along its central spine so it has real 3D thickness from both side and top-down views,
 * with smooth spherical canopy normals and inner-to-tip baked AO.
 */
function addFoldedBoughCard(
  b,
  { ox, oy, oz, yaw, length, width, droop, foldLift, rect, crownCenterY, tint, aoInner, aoOuter }
) {
  const baseVert = b.pos.length / 3;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  // Radial outward dir = (cy, 0, sy), side perpendicular = (-sy, 0, cy)
  const rx = cy, rz = sy;
  const sx = -sy, sz = cy;

  const [u0, v0, uS, vS] = rect;
  const hw = width * 0.5;
  const midL = length * 0.52;

  // 6 vertices:
  // 0: base-left, 1: base-center, 2: base-right
  // 3: mid-left,  4: mid-center,  5: mid-right
  // 6: tip-left,  7: tip-center,  8: tip-right (3x3 = 8 tris? Use 2x3 = 6 verts -> 4 tris for lean GPU budget!)
  // Compact 6-vert folded diamond/arch bough:
  // 0: inner-left, 1: inner-center, 2: inner-right
  // 3: outer-left, 4: outer-center (tip), 5: outer-right
  const pts = [
    [ox + rx * 0.01 + sx * (-hw * 0.55), oy - foldLift * 0.3, oz + rz * 0.01 + sz * (-hw * 0.55), u0, v0, aoInner],
    [ox + rx * 0.00, oy + foldLift * 0.35, oz + rz * 0.00, u0 + uS * 0.5, v0, aoInner * 0.92],
    [ox + rx * 0.01 + sx * (hw * 0.55), oy - foldLift * 0.3, oz + rz * 0.01 + sz * (hw * 0.55), u0 + uS, v0, aoInner],

    [ox + rx * (length * 0.86) + sx * (-hw), oy - droop * 0.82 - foldLift * 0.45, oz + rz * (length * 0.86) + sz * (-hw), u0, v0 + vS * 0.88, aoOuter * 0.96],
    [ox + rx * length, oy - droop + foldLift * 0.22, oz + rz * length, u0 + uS * 0.5, v0 + vS, aoOuter],
    [ox + rx * (length * 0.86) + sx * hw, oy - droop * 0.82 - foldLift * 0.45, oz + rz * (length * 0.86) + sz * hw, u0 + uS, v0 + vS * 0.88, aoOuter * 0.96],
  ];

  // Crossed vertical fin along midrib (4 verts, 2 tris) so bough NEVER looks paper-thin edge-on!
  const finH = width * 0.32;
  const finPts = [
    [ox + rx * (length * 0.12), oy - finH * 0.45, oz + rz * (length * 0.12), u0 + uS * 0.25, v0 + vS * 0.12, aoInner * 0.92],
    [ox + rx * (length * 0.12), oy + finH * 0.58, oz + rz * (length * 0.12), u0 + uS * 0.75, v0 + vS * 0.12, aoInner * 1.05],
    [ox + rx * (length * 0.96), oy - droop - finH * 0.36, oz + rz * (length * 0.96), u0 + uS * 0.25, v0 + vS * 0.96, aoOuter * 0.94],
    [ox + rx * (length * 0.96), oy - droop + finH * 0.48, oz + rz * (length * 0.96), u0 + uS * 0.75, v0 + vS * 0.96, aoOuter * 1.04],
  ];

  const allPts = pts.concat(finPts);
  for (let i = 0; i < allPts.length; i++) {
    const [vx, vy, vz, uu, vv, ao] = allPts[i];
    b.pos.push(vx, vy, vz);
    // Smooth ellipsoidal spherical canopy normal blended upward so foliage never turns black!
    let nx = vx;
    let ny = (vy - crownCenterY) * 0.62 + 0.24;
    let nz = vz;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    // Blend 35% toward sky up for soft natural sunlit foliage shading
    const bx = nx * 0.65;
    const by = ny * 0.65 + 0.35;
    const bz = nz * 0.65;
    const bl = Math.hypot(bx, by, bz) || 1;
    b.norm.push(bx / bl, by / bl, bz / bl);
    b.uv.push(uu, vv);
    b.col.push(tint[0] * ao, tint[1] * ao, tint[2] * ao);
  }

  // Folded horizontal bough (4 tris)
  b.idx.push(
    baseVert + 0, baseVert + 1, baseVert + 4,
    baseVert + 0, baseVert + 4, baseVert + 3,
    baseVert + 1, baseVert + 2, baseVert + 5,
    baseVert + 1, baseVert + 5, baseVert + 4
  );
  // Crossed vertical fin (2 tris)
  const f0 = baseVert + 6;
  b.idx.push(f0, f0 + 2, f0 + 3, f0, f0 + 3, f0 + 1);
}

/**
 * Append a cupped / angled leaf cluster card (4 verts, 2 tris) oriented around a 3D crown point.
 */
function addLeafCard(
  b,
  { cx, cy, cz, size, pitch, yaw, roll, rect, crownCenterY, tint, aoBase, aoTop }
) {
  const baseVert = b.pos.length / 3;
  const euler = new THREE.Euler(pitch, yaw, roll, 'YXZ');
  const m = new THREE.Matrix4().makeRotationFromEuler(euler);
  const v = new THREE.Vector3();
  const hs = size * 0.5;
  const [u0, v0, uS, vS] = rect;

  const corners = [
    [-hs, -hs, 0, u0, v0, aoBase],
    [hs, -hs, 0, u0 + uS, v0, aoBase],
    [hs, hs, 0, u0 + uS, v0 + vS, aoTop],
    [-hs, hs, 0, u0, v0 + vS, aoTop],
  ];

  for (let i = 0; i < 4; i++) {
    v.set(corners[i][0], corners[i][1], corners[i][2]).applyMatrix4(m);
    const vx = cx + v.x;
    const vy = cy + v.y;
    const vz = cz + v.z;
    b.pos.push(vx, vy, vz);

    // Spherical crown normal radiating cleanly from canopy center
    let nx = vx;
    let ny = (vy - crownCenterY) * 0.95 + 0.18;
    let nz = vz;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx = (nx / l) * 0.68;
    ny = (ny / l) * 0.68 + 0.32;
    nz = (nz / l) * 0.68;
    const nl = Math.hypot(nx, ny, nz) || 1;
    b.norm.push(nx / nl, ny / nl, nz / nl);

    b.uv.push(corners[i][3], corners[i][4]);
    const ao = corners[i][5];
    b.col.push(tint[0] * ao, tint[1] * ao, tint[2] * ao);
  }

  b.idx.push(baseVert, baseVert + 1, baseVert + 2, baseVert, baseVert + 2, baseVert + 3);
}

// ============================================================================
// 1. ENGELMANN SPRUCE (Picea engelmannii) & SUBALPINE FIR (Abies lasiocarpa)
// ============================================================================

export function buildConiferModel(isFir) {
  const rng = mulberry32(isFir ? 3041 : 1087);
  const trunkB = makeBuilder();
  const folB = makeBuilder();

  // Slightly curved organic trunk extending to y=-0.06 so roots stay planted on steep slopes
  const leanX = (rng() - 0.5) * 0.018;
  const leanZ = (rng() - 0.5) * 0.018;
  const rBase = isFir ? 0.027 : 0.033;
  const spine = [
    [0, -0.06, 0, rBase * 1.28],
    [0, 0.04, 0, rBase * 0.98],
    [leanX * 0.3, 0.26, leanZ * 0.3, rBase * 0.76],
    [leanX * 0.65, 0.52, leanZ * 0.65, rBase * 0.50],
    [leanX * 0.9, 0.78, leanZ * 0.9, rBase * 0.26],
    [leanX, 0.96, leanZ, 0.005],
  ];
  addTaperedTube(trunkB, spine, 6, [0.01, 0.24], 3.2, [1.12, 1.06, 1.00]);

  // Delicate weathered lower snag stubs beneath live crown
  const snagCount = isFir ? 2 : 3;
  for (let i = 0; i < snagCount; i++) {
    const a = (i / snagCount) * Math.PI * 2 + rng() * 0.9;
    const sy = 0.09 + rng() * 0.06;
    const len = 0.045 + rng() * 0.035;
    addTaperedTube(
      trunkB,
      [
        [Math.cos(a) * rBase * 0.6, sy, Math.sin(a) * rBase * 0.6, 0.005],
        [Math.cos(a) * len, sy - 0.018, Math.sin(a) * len, 0.002],
      ],
      4,
      [0.51, 0.74],
      0.8,
      [0.88, 0.85, 0.80]
    );
  }

  // Multi-tier radiating folded bough whorls (unbroken spire crown + velvety sunlit depth)
  const rect = isFir ? FOLIAGE_ATLAS_RECTS.fir : FOLIAGE_ATLAS_RECTS.spruce;
  const whorls = isFir ? 14 : 12;
  const yStart = isFir ? 0.07 : 0.10;
  const yEnd = 0.96;
  const maxRad = isFir ? 0.195 : 0.285;
  const crownCenterY = 0.48;

  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1);
    const wy = yStart + t * (yEnd - yStart);
    const tx = leanX * t;
    const tz = leanZ * t;

    // Natural organic profile: slight flare in lower third, full feathery taper into apex
    const profile = isFir
      ? Math.pow(1 - t, 0.82) * (0.90 + 0.18 * Math.sin(t * Math.PI))
      : Math.pow(1 - t, 0.72) * (0.94 + 0.22 * Math.sin(t * Math.PI * 0.85));
    const whorlRad = maxRad * Math.max(0.22, profile) * (0.90 + rng() * 0.22);
    const branches = t > 0.74 ? 4 : t > 0.35 ? 4 : 5;
    const baseYaw = w * 1.24 + rng() * 0.35;

    // Rich velvety conifer interior AO (never crushed to pure black under AgX!)
    const aoInner = 0.56 + t * 0.20;
    const aoOuter = 0.88 + t * 0.24;

    for (let j = 0; j < branches; j++) {
      const yaw = baseYaw + (j / branches) * Math.PI * 2 + (rng() - 0.5) * 0.34;
      const bLen = whorlRad * (0.86 + rng() * 0.32);
      const bWid = bLen * (isFir ? 1.22 : 1.32);
      // Lower spruce boughs sweep downward gracefully; upper fir tips sweep slightly up/flat
      const droop = isFir
        ? bLen * (0.34 - t * 0.30)
        : bLen * (0.48 - t * 0.34);
      const foldLift = bLen * 0.14;
      const shadeVar = 0.90 + rng() * 0.20;
      const tint = isFir
        ? [0.94 * shadeVar, 1.00 * shadeVar, 1.04 * shadeVar]
        : [0.98 * shadeVar, 1.02 * shadeVar, 0.95 * shadeVar];

      addFoldedBoughCard(folB, {
        ox: tx,
        oy: wy + (rng() - 0.5) * 0.025,
        oz: tz,
        yaw,
        length: bLen,
        width: bWid,
        droop,
        foldLift,
        rect,
        crownCenterY,
        tint,
        aoInner,
        aoOuter,
      });
    }
  }

  // Feathery upright pointed spire leader tuft at very apex (2 crossed vertical cards)
  for (let k = 0; k < 2; k++) {
    addLeafCard(folB, {
      cx: leanX,
      cy: 0.96,
      cz: leanZ,
      size: isFir ? 0.11 : 0.13,
      pitch: 0,
      yaw: k * Math.PI * 0.5 + 0.3,
      roll: 0,
      rect,
      crownCenterY,
      tint: [1.02, 1.08, 0.98],
      aoBase: 0.75,
      aoTop: 1.12,
    });
  }

  return {
    trunkGeo: finalizeBuilder(trunkB),
    foliageGeo: finalizeBuilder(folB),
  };
}

// ============================================================================
// 2. QUAKING ASPEN (Populus tremuloides) — Iconic white bark + airy sunlit crown
// ============================================================================

export function buildAspenModel() {
  const rng = mulberry32(6143);
  const trunkB = makeBuilder();
  const folB = makeBuilder();

  // Sinuous slender chalky-white trunk (barkAtlas Col 1: [0.26..0.49], v=0..1 maps base dark -> white top!)
  const bend1X = (rng() - 0.5) * 0.045;
  const bend1Z = (rng() - 0.5) * 0.045;
  const bend2X = bend1X * 0.4 + (rng() - 0.5) * 0.035;
  const bend2Z = bend1Z * 0.4 + (rng() - 0.5) * 0.035;

  const spine = [
    [0, -0.06, 0, 0.036],
    [0, 0.06, 0, 0.028],
    [bend1X * 0.6, 0.28, bend1Z * 0.6, 0.023],
    [bend1X, 0.50, bend1Z, 0.018],
    [bend2X, 0.72, bend2Z, 0.012],
    [bend2X * 1.15, 0.88, bend2Z * 1.15, 0.005],
  ];
  addTaperedTube(trunkB, spine, 7, [0.26, 0.49], 1.0, [1.0, 1.0, 1.0]);

  // 4 graceful ascending pale-white secondary limbs framing the airy crown
  const limbSpecs = [
    { startIdx: 3, yaw: 0.4, reach: 0.16, endY: 0.76 },
    { startIdx: 3, yaw: 2.5, reach: 0.15, endY: 0.79 },
    { startIdx: 4, yaw: 4.3, reach: 0.14, endY: 0.88 },
    { startIdx: 4, yaw: 1.5, reach: 0.12, endY: 0.91 },
  ];
  const crownNodes = [[bend2X, 0.88, bend2Z, 0.19]];

  for (const ls of limbSpecs) {
    const s = spine[ls.startIdx];
    const ex = s[0] + Math.cos(ls.yaw) * ls.reach;
    const ez = s[2] + Math.sin(ls.yaw) * ls.reach;
    const mx = (s[0] + ex) * 0.5;
    const my = s[1] + (ls.endY - s[1]) * 0.58;
    const mz = (s[2] + ez) * 0.5;
    addTaperedTube(
      trunkB,
      [
        [s[0], s[1], s[2], 0.012],
        [mx, my, mz, 0.008],
        [ex, ls.endY, ez, 0.004],
      ],
      5,
      [0.27, 0.48],
      0.55,
      [0.98, 0.98, 0.96],
      0.38
    );
    crownNodes.push([ex, ls.endY, ez, 0.165]);
  }
  crownNodes.push([bend1X, 0.64, bend1Z, 0.15]);

  // Airy multi-lobed leaf clusters (30 intersecting sunlit leaf cards)
  const rect = FOLIAGE_ATLAS_RECTS.aspen;
  const crownCenterY = 0.74;

  for (let n = 0; n < crownNodes.length; n++) {
    const [nx, ny, nz, rad] = crownNodes[n];
    const cards = n === 0 ? 7 : 5;
    for (let i = 0; i < cards; i++) {
      const phi = (i / cards) * Math.PI * 2 + rng() * 0.8;
      const dist = rad * (0.28 + rng() * 0.62);
      const dy = (rng() - 0.42) * rad * 0.85;
      const cx = nx + Math.cos(phi) * dist;
      const cy = Math.max(0.45, Math.min(0.99, ny + dy));
      const cz = nz + Math.sin(phi) * dist;

      // Mix oblique, vertical, and canopy-top angles for lush 3D volume from every view
      const pitch = (rng() - 0.5) * 1.15;
      const yaw = phi + (rng() - 0.5) * 0.9;
      const roll = (rng() - 0.5) * 0.7;
      const size = (0.25 + rng() * 0.13) * (n === 0 ? 1.12 : 1.02);

      const heightAO = 0.74 + Math.max(0, (cy - 0.45) / 0.55) * 0.34;
      const shade = 0.92 + rng() * 0.16;
      addLeafCard(folB, {
        cx,
        cy,
        cz,
        size,
        pitch,
        yaw,
        roll,
        rect,
        crownCenterY,
        tint: [shade, shade * 1.03, shade * 0.95],
        aoBase: heightAO * 0.72,
        aoTop: heightAO * 1.05,
      });
    }
  }

  return {
    trunkGeo: finalizeBuilder(trunkB),
    foliageGeo: finalizeBuilder(folB),
  };
}

// ============================================================================
// 3. RIPARIAN WILLOW THICKET (Salix) — Multi-stem fountain hugging creeks
// ============================================================================

export function buildWillowModel() {
  const rng = mulberry32(7727);
  const trunkB = makeBuilder();
  const folB = makeBuilder();
  const rect = FOLIAGE_ATLAS_RECTS.willow;
  const crownCenterY = 0.42;

  // 7 arching slender woody stems fanning out from a broad root cluster
  const stems = 7;
  for (let i = 0; i < stems; i++) {
    const yaw = (i / stems) * Math.PI * 2 + (rng() - 0.5) * 0.45;
    const reach = 0.28 + rng() * 0.18;
    const h = 0.62 + rng() * 0.24;
    addTaperedTube(
      trunkB,
      [
        [Math.cos(yaw) * 0.05, -0.08, Math.sin(yaw) * 0.05, 0.022],
        [Math.cos(yaw) * reach * 0.52, h * 0.56, Math.sin(yaw) * reach * 0.52, 0.013],
        [Math.cos(yaw) * reach, h, Math.sin(yaw) * reach, 0.006],
      ],
      4,
      [0.76, 0.99],
      1.0,
      [0.95, 0.92, 0.88]
    );
  }

  // 20 billowing willow leaf spray cards forming a full rounded fountain thicket
  for (let i = 0; i < 20; i++) {
    const ring = i < 12 ? 1 : 0;
    const yaw = (i / (ring ? 12 : 8)) * Math.PI * 2 + rng() * 0.5;
    const rad = ring ? 0.24 + rng() * 0.22 : 0.06 + rng() * 0.14;
    const cy = ring ? 0.36 + rng() * 0.30 : 0.62 + rng() * 0.24;
    const cx = Math.cos(yaw) * rad;
    const cz = Math.sin(yaw) * rad;
    const shade = 0.88 + rng() * 0.22;

    addLeafCard(folB, {
      cx,
      cy,
      cz,
      size: 0.42 + rng() * 0.16,
      pitch: ring ? 0.38 + (rng() - 0.5) * 0.35 : (rng() - 0.5) * 0.65,
      yaw: yaw + Math.PI * 0.5,
      roll: (rng() - 0.5) * 0.5,
      rect,
      crownCenterY,
      tint: [0.94 * shade, 1.02 * shade, 0.92 * shade],
      aoBase: 0.55,
      aoTop: 1.06,
    });
  }

  return {
    trunkGeo: finalizeBuilder(trunkB),
    foliageGeo: finalizeBuilder(folB),
  };
}

// ============================================================================
// 4. TREELINE KRUMMHOLZ — Wind-flagged gnarled alpine timberline conifer
// ============================================================================

export function buildKrummholzModel() {
  const rng = mulberry32(9157);
  const trunkB = makeBuilder();
  const folB = makeBuilder();
  const rect = FOLIAGE_ATLAS_RECTS.spruce;
  const crownCenterY = 0.42;

  // Gnarled sun-bleached weathered trunk hugging low & leaning leeward (+X)
  addTaperedTube(
    trunkB,
    [
      [-0.10, -0.10, 0, 0.068],
      [-0.04, 0.14, 0.02, 0.056],
      [0.10, 0.34, -0.02, 0.042],
      [0.30, 0.52, 0.02, 0.024],
      [0.48, 0.62, 0.01, 0.010],
    ],
    6,
    [0.51, 0.74],
    1.8,
    [1.18, 1.15, 1.08]
  );

  // Subtle bleached deadwood limb tucked beside crown
  addTaperedTube(
    trunkB,
    [
      [-0.02, 0.22, 0.01, 0.024],
      [-0.14, 0.44, -0.03, 0.013],
      [-0.22, 0.58, -0.01, 0.005],
    ],
    5,
    [0.51, 0.74],
    1.2,
    [1.22, 1.18, 1.12]
  );

  // Dense wind-sculpted matted evergreen cushion + tufted leeward spruce boughs (full 3D volume!)
  for (let i = 0; i < 18; i++) {
    const t = i / 17;
    const ox = -0.10 + t * 0.54 + (rng() - 0.5) * 0.14;
    const oy = 0.14 + Math.sin(t * Math.PI * 0.88) * 0.52 + (rng() - 0.5) * 0.12;
    const oz = (rng() - 0.5) * 0.36;
    const yaw = (rng() - 0.5) * 1.45; // wind-flagged toward +X
    const shade = 0.88 + rng() * 0.24;

    addFoldedBoughCard(folB, {
      ox,
      oy,
      oz,
      yaw,
      length: 0.28 + rng() * 0.22,
      width: 0.36 + rng() * 0.18,
      droop: 0.05 + rng() * 0.08,
      foldLift: 0.05,
      rect,
      crownCenterY,
      tint: [0.92 * shade, 0.98 * shade, 0.86 * shade],
      aoInner: 0.58,
      aoOuter: 1.04,
    });
  }

  // Upright dense needle tufts inside the wind-matted dome so it reads bushy from every steep angle
  for (let k = 0; k < 10; k++) {
    const t = k / 9;
    addLeafCard(folB, {
      cx: -0.05 + t * 0.45 + (rng() - 0.5) * 0.18,
      cy: 0.34 + Math.sin(t * Math.PI) * 0.34 + (rng() - 0.5) * 0.10,
      cz: (rng() - 0.5) * 0.32,
      size: 0.34 + rng() * 0.14,
      pitch: (rng() - 0.5) * 0.7,
      yaw: rng() * Math.PI,
      roll: (rng() - 0.5) * 0.4,
      rect,
      crownCenterY,
      tint: [0.94, 1.02, 0.88],
      aoBase: 0.65,
      aoTop: 1.08,
    });
  }

  return {
    trunkGeo: finalizeBuilder(trunkB),
    foliageGeo: finalizeBuilder(folB),
  };
}

// ============================================================================
// 5. FOREST FLOOR DEADFALL LOGS & WEATHERED STUMPS
// ============================================================================

export function buildDeadfallLogGeometry() {
  const b = makeBuilder();
  // Fallen weathered mossy log lying horizontally along X (~4m unit length when scaled 1..1.6)
  const spine = [
    [-2.0, 0.16, 0.05, 0.22],
    [-1.1, 0.18, -0.04, 0.20],
    [0.0, 0.17, 0.02, 0.17],
    [1.1, 0.14, 0.07, 0.14],
    [2.0, 0.11, -0.03, 0.09],
  ];
  addTaperedTube(b, spine, 7, [0.51, 0.74], 3.5, [0.92, 0.91, 0.86]);

  // Two broken snag limbs sticking up naturally off the fallen trunk
  addTaperedTube(
    b,
    [
      [-0.5, 0.18, 0.0, 0.07],
      [-0.1, 0.52, 0.22, 0.045],
      [0.12, 0.72, 0.34, 0.02],
    ],
    5,
    [0.51, 0.74],
    1.2,
    [0.95, 0.93, 0.88]
  );
  addTaperedTube(
    b,
    [
      [0.7, 0.15, 0.04, 0.055],
      [1.05, 0.38, -0.26, 0.022],
    ],
    5,
    [0.51, 0.74],
    1.0,
    [0.90, 0.92, 0.85]
  );
  return finalizeBuilder(b);
}

export function buildStumpGeometry() {
  const b = makeBuilder();
  const spine = [
    [0, -0.18, 0, 0.44],
    [0, 0.04, 0, 0.30],
    [0.02, 0.35, -0.01, 0.25],
    [0.03, 0.62, 0.01, 0.23],
    [0.03, 0.64, 0.01, 0.02], // cap
  ];
  addTaperedTube(b, spine, 8, [0.01, 0.24], 1.2, [0.85, 0.80, 0.74]);
  return finalizeBuilder(b);
}

// ============================================================================
// 6. 3D MULTI-PLANE GROUND FLORA CLUMP (Grass / Wildflowers / Tundra / Ferns)
//    3 intersecting, outward-splayed planes (12 verts, 6 tris) so meadows read
//    lush from BOTH runner eye level AND looking down at your feet!
// ============================================================================

export function buildGroundFloraClumpGeometry() {
  const b = makeBuilder();
  const planes = 3;
  const baseW = 1.08;
  const topW = 1.28;
  const splay = 0.16; // gentle outward arch so looking down shows full lush grass!

  for (let i = 0; i < planes; i++) {
    const ang = (i / planes) * Math.PI + 0.21;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const px = -sa;
    const pz = ca;
    const baseVert = b.pos.length / 3;

    const hwb = baseW * 0.5;
    const hwt = topW * 0.5;
    const leanSign = i % 2 === 0 ? 1 : -1;
    const ox = px * splay * leanSign;
    const oz = pz * splay * leanSign;

    // 4 vertices: bottom-left, bottom-right, top-right, top-left
    const verts = [
      [-ca * hwb, -0.04, -sa * hwb, 0, 0, 0.52],
      [ca * hwb, -0.04, sa * hwb, 1, 0, 0.52],
      [ca * hwt + ox, 1.0, sa * hwt + oz, 1, 1, 1.08],
      [-ca * hwt + ox, 1.0, -sa * hwt + oz, 0, 1, 1.08],
    ];

    for (let k = 0; k < 4; k++) {
      const [vx, vy, vz, uu, vv, ao] = verts[k];
      b.pos.push(vx, vy, vz);
      // Bent upward meadow normal (blends with terrain slope lighting, NEVER turns black!)
      const nx = (vx * 0.22);
      const ny = 0.96;
      const nz = (vz * 0.22);
      const nl = Math.hypot(nx, ny, nz) || 1;
      b.norm.push(nx / nl, ny / nl, nz / nl);
      b.uv.push(uu, vv);
      b.col.push(ao, ao, ao);
    }

    b.idx.push(baseVert, baseVert + 1, baseVert + 2, baseVert, baseVert + 2, baseVert + 3);
  }

  return finalizeBuilder(b);
}
