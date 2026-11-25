import * as THREE from 'three';
import { lonLatToWorld } from '../core/geo.js';
import { hash2i, mulberry32 } from './noise.js';
import { patchSanJuanMaterial } from './materialFog.js';

const BLDG_CELL_M = 1000;
const MASK_CELL_M = 64;
const ROAD_HASH_M = 64;
const MAX_PYLONS = 900;
const MAX_GONDOLA_CABINS = 120;
const MAX_LIFT_CHAIRS = 360;

const MAIN_STREET_RE = /colorado ave|greene st|blair st|main st|glasgow ave|gunnison ave|silver st/i;
const _pushOut = { x: 0, z: 0, pushed: false };

/**
 * 1024x1024 4x4 Victorian & San Juan PBR Trimsheet Atlas UV Rects:
 * Row 0 (v=0.75..1.00): 0=Red Brick Storefront, 1=Ochre Clapboard Storefront, 2=Cream Sandstone Bank, 3=Sage Mercantile
 * Row 1 (v=0.50..0.75): 4=Slate Painted Lady, 5=Barn-Red Miner Cottage, 6=Cream Victorian House, 7=Mountain Village Chalet
 * Row 2 (v=0.25..0.50): 8=Brick Side Wall, 9=Ochre/Cream Clapboard Side, 10=Sage/Slate Clapboard Side, 11=Timber/Stone Side
 * Row 3 (v=0.00..0.25): 12=Cedar Shingle Roof, 13=Standing-Seam Metal Roof, 14=Trim/Porch/Granite, 15=Street/Curb/Sidewalk
 */
function getCellRect(idx, pad = 0.003) {
  const col = idx & 3;
  const row = idx >> 2;
  const u0 = col * 0.25 + pad;
  const u1 = (col + 1) * 0.25 - pad;
  const v0 = (3 - row) * 0.25 + pad;
  const v1 = (4 - row) * 0.25 - pad;
  return [u0, v0, u1, v1];
}

// Sub-regions of Cell 14 (Trim / Porch Decking / Cut Granite Foundation)
const TRIM_UV = [0.504, 0.194, 0.746, 0.246];
const PORCH_DECK_UV = [0.504, 0.130, 0.746, 0.182];
const GRANITE_UV = [0.504, 0.004, 0.746, 0.120];

// Sub-regions of Cell 15 (Town Asphalt / Granite Curb / Sandstone Sidewalk)
const ASPHALT_U0 = 0.753;
const ASPHALT_U1 = 0.871;
const CURB_U0 = 0.876;
const CURB_U1 = 0.889;
const SIDEWALK_U0 = 0.893;
const SIDEWALK_U1 = 0.996;
const STREET_V0 = 0.005;
const STREET_V1 = 0.245;

function mergePartBuffers(parts) {
  let totalVerts = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    totalVerts += p.pos.length / 3;
    if (p.bounds) {
      if (p.bounds[0] < minX) minX = p.bounds[0];
      if (p.bounds[1] < minY) minY = p.bounds[1];
      if (p.bounds[2] < minZ) minZ = p.bounds[2];
      if (p.bounds[3] > maxX) maxX = p.bounds[3];
      if (p.bounds[4] > maxY) maxY = p.bounds[4];
      if (p.bounds[5] > maxZ) maxZ = p.bounds[5];
    }
  }
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  const col = new Float32Array(totalVerts * 3);
  let off = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const c = p.pos.length / 3;
    pos.set(p.pos, off * 3);
    norm.set(p.norm, off * 3);
    uv.set(p.uv, off * 2);
    col.set(p.col, off * 3);
    off += c;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (minX <= maxX) {
    out.boundingBox = new THREE.Box3(
      new THREE.Vector3(minX, minY, minZ),
      new THREE.Vector3(maxX, maxY, maxZ)
    );
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const rad = Math.hypot(maxX - cx, maxY - cy, maxZ - cz);
    out.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), rad);
  } else {
    out.computeBoundingSphere();
  }
  return out;
}

function colorizeBox(w, h, d, tx, ty, tz, r, g, b, rx = 0, ry = 0, rz = 0) {
  const raw = new THREE.BoxGeometry(w, h, d);
  const box = raw.toNonIndexed();
  raw.dispose();
  if (rx) box.rotateX(rx);
  if (ry) box.rotateY(ry);
  if (rz) box.rotateZ(rz);
  box.translate(tx, ty, tz);
  const count = box.attributes.position.count;
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = b;
  }
  box.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return box;
}

function mergeColoredBoxes(parts) {
  let totalVerts = 0;
  for (const g of parts) totalVerts += g.attributes.position.count;
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const col = new Float32Array(totalVerts * 3);
  let off = 0;
  for (const g of parts) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    norm.set(g.attributes.normal.array, off * 3);
    col.set(g.attributes.color.array, off * 3);
    off += c;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

function buildPylonGeometry() {
  return mergeColoredBoxes([
    colorizeBox(0.72, 12.5, 0.72, 0, -6.25, 0, 0.36, 0.40, 0.44),
    colorizeBox(5.6, 0.45, 0.55, 0, 0, 0, 0.42, 0.46, 0.50),
  ]);
}

function buildGondolaCabinGeometry() {
  return mergeColoredBoxes([
    colorizeBox(0.10, 1.8, 0.10, 0, -0.9, 0, 0.36, 0.40, 0.44),
    colorizeBox(2.0, 1.35, 2.5, 0, -2.2, 0, 0.12, 0.30, 0.48),
    colorizeBox(2.06, 0.78, 2.1, 0, -2.02, 0, 0.56, 0.71, 0.80),
  ]);
}

function buildLiftChairGeometry() {
  return mergeColoredBoxes([
    colorizeBox(0.09, 1.8, 0.09, 0, -0.9, 0, 0.36, 0.40, 0.44),
    colorizeBox(1.75, 0.14, 0.55, 0, -1.8, 0, 0.25, 0.28, 0.32),
    colorizeBox(1.75, 0.65, 0.12, 0, -1.5, -0.24, 0.14, 0.32, 0.50),
  ]);
}

function sampleElev(terrain, x, z, fallbackY) {
  const h = terrain.getHeight(x, z);
  if (!Number.isFinite(h)) return fallbackY;
  if (h === 2667 && Number.isFinite(fallbackY) && Math.abs(fallbackY - 2667) > 22) {
    return fallbackY;
  }
  return h;
}

/**
 * Create a geometry builder accumulating position, normal, uv, and RGB vertex ambient occlusion / tint.
 */
function createPartBuilder() {
  const pos = [];
  const norm = [];
  const uv = [];
  const col = [];

  function pushTri(
    ax, ay, az, bx, by, bz, cx, cy, cz,
    u0, v0, u1, v1, u2, v2,
    c0r = 1, c0g = 1, c0b = 1,
    c1r = c0r, c1g = c0g, c1b = c0b,
    c2r = c0r, c2g = c0g, c2b = c0b
  ) {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    norm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    uv.push(u0, v0, u1, v1, u2, v2);
    col.push(c0r, c0g, c0b, c1r, c1g, c1b, c2r, c2g, c2b);
  }

  /**
   * Push a CCW quad (0=bottom-left, 1=bottom-right, 2=top-right, 3=top-left when viewed from front).
   */
  function pushQuad(
    x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3,
    u0, v0, u1, v1,
    aoBot = 1.0, aoTop = 1.0, tintR = 1.0, tintG = 1.0, tintB = 1.0
  ) {
    const br = aoBot * tintR, bg = aoBot * tintG, bb = aoBot * tintB;
    const tr = aoTop * tintR, tg = aoTop * tintG, tb = aoTop * tintB;
    pushTri(
      x0, y0, z0, x1, y1, z1, x2, y2, z2,
      u0, v0, u1, v0, u1, v1,
      br, bg, bb, br, bg, bb, tr, tg, tb
    );
    pushTri(
      x0, y0, z0, x2, y2, z2, x3, y3, z3,
      u0, v0, u1, v1, u0, v1,
      br, bg, bb, tr, tg, tb, tr, tg, tb
    );
  }

  /**
   * Push a 4-sided vertical post or chimney shaft (no top/bottom unseen caps needed for posts; optional cap).
   */
  function pushVerticalPrism(cx, cz, ux, uz, hw, hd, y0, y1, u0, v0, u1, v1, aoBot, aoTop, capTop = false, tint = 1.0) {
    const px = -uz, pz = ux;
    // 4 corners in XZ so consecutive edges wind withsignedArea < 0 (outward normals):
    // c0=(-u,+p), c1=(-u,-p), c2=(+u,-p), c3=(+u,+p)? Let's check c0->c1: d = (0, -2p).
    // Wait: let u=(1,0), p=(0,1): c0=(-1,1), c1=(-1,-1) -> dx=0, dz=-2 -> (-dz,dx)=(+2,0) WRONG!
    // Check c0=(-1,-1), c1=(-1,+1), c2=(+1,+1), c3=(+1,-1):
    // c0->c1: dx=0, dz=+2 -> (-dz,dx)=(-2,0) = -u (OUTWARD!).
    // c1->c2: dx=+2, dz=0 -> (-dz,dx)=(0,+2) = +p (OUTWARD!).
    // c2->c3: dx=0, dz=-2 -> (-dz,dx)=(+2,0) = +u (OUTWARD!).
    // c3->c0: dx=-2, dz=0 -> (-dz,dx)=(0,-2) = -p (OUTWARD!).
    const x0 = cx - ux * hw - px * hd, z0 = cz - uz * hw - pz * hd;
    const x1 = cx - ux * hw + px * hd, z1 = cz - uz * hw + pz * hd;
    const x2 = cx + ux * hw + px * hd, z2 = cz + uz * hw + pz * hd;
    const x3 = cx + ux * hw - px * hd, z3 = cz + uz * hw - pz * hd;

    pushQuad(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y1, z0, u0, v0, u1, v1, aoBot, aoTop, tint, tint, tint);
    pushQuad(x1, y0, z1, x2, y0, z2, x2, y1, z2, x1, y1, z1, u0, v0, u1, v1, aoBot, aoTop, tint, tint, tint);
    pushQuad(x2, y0, z2, x3, y0, z3, x3, y1, z3, x2, y1, z2, u0, v0, u1, v1, aoBot, aoTop, tint, tint, tint);
    pushQuad(x3, y0, z3, x0, y0, z0, x0, y1, z0, x3, y1, z3, u0, v0, u1, v1, aoBot, aoTop, tint, tint, tint);
    if (capTop) {
      // Check upward normal: (x1-x0) x (x2-x0) for u=(1,0), p=(0,1): (0,0,2) x (2,0,2) = (0, +4, 0) UPWARD!
      pushQuad(x0, y1, z0, x1, y1, z1, x2, y1, z2, x3, y1, z3, TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3], aoTop, aoTop, 0.72, 0.70, 0.68);
    }
  }

  return {
    pushTri,
    pushQuad,
    pushVerticalPrism,
    finish() {
      if (pos.length === 0) return null;
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      const posArr = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        posArr[i] = x; posArr[i + 1] = y; posArr[i + 2] = z;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return {
        pos: posArr,
        norm: new Float32Array(norm),
        uv: new Float32Array(uv),
        col: new Float32Array(col),
        bounds: [minX, minY, minZ, maxX, maxY, maxZ],
      };
    },
  };
}

/**
 * Deterministically classify a building into one of 4 San Juan architectural archetypes
 * with authentic height, facade, side-wall, roof, porch, and false-front parameters.
 */
function classifyBuilding(b, cx, cz, polyArea, nearRoad) {
  const seed = hash2i(Math.round(cx * 2), Math.round(cz * 2), 409);
  const rng = mulberry32(seed);
  const r0 = rng();
  const r1 = rng();
  const r2 = rng();
  const r3 = rng();

  const town = (b.town || '').toLowerCase();
  const kind = (b.kind || '').toLowerCase();
  const name = (b.name || '').toLowerCase();
  const rawH = b.heightM || (b.levels ? b.levels * 3.3 : 6.6);
  const isDefaultOsmH = Math.abs(rawH - 6.6) < 0.25;

  // 1. Industrial / Landmark Powerhouse
  if (kind.includes('industrial') || name.includes('power')) {
    return {
      archetype: 'industrial',
      heightM: rawH,
      frontCell: 0,
      sideCell: 8,
      roofCell: 13,
      hasPorch: false,
      hasFalseFront: false,
      hasChimney: true,
      roofPitch: 0.56,
      tint: [0.96, 0.94, 0.92],
    };
  }

  // 2. Mountain Village Timber & River-Rock Ski Chalets / Lodges
  if (town.includes('mountain village')) {
    const heightM = isDefaultOsmH
      ? (polyArea > 220 ? 8.2 + r0 * 3.4 : 6.0 + r0 * 2.8)
      : rawH;
    return {
      archetype: 'chalet',
      heightM,
      frontCell: 7,
      sideCell: 11,
      roofCell: 13,
      hasPorch: r1 < 0.45,
      hasFalseFront: false,
      hasChimney: r2 < 0.78,
      roofPitch: 0.72 + r3 * 0.16,
      tint: [0.95 + r1 * 0.08, 0.94 + r2 * 0.07, 0.92 + r3 * 0.07],
    };
  }

  // 3. Historic Commercial Main-Street Storefront (Colorado Ave, Greene St, Blair St, Main St, etc.)
  const onMainStreet =
    nearRoad &&
    nearRoad.kind === 'road' &&
    nearRoad.dist < 33 &&
    MAIN_STREET_RE.test(nearRoad.name || '');
  const isCommercialKind =
    kind === 'commercial' || kind === 'retail' || kind === 'hotel' || kind === 'public' || kind === 'civic';

  if ((isCommercialKind || (onMainStreet && polyArea > 44)) && kind !== 'house' && kind !== 'cabin') {
    let heightM = rawH;
    if (isDefaultOsmH) {
      if (r0 < 0.22 && polyArea < 165) {
        heightM = 4.45 + r1 * 0.50; // Single-story false-front saloon / mercantile
      } else if (r0 > 0.80 && polyArea > 125) {
        heightM = 9.6 + r1 * 2.1;   // Grand 3-story brick Victorian hotel / opera block
      } else {
        heightM = 6.7 + r1 * 1.95;  // Classic 2-story Victorian main-street storefront
      }
    }
    const frontCell = Math.floor(r2 * 4); // 0=Red Brick, 1=Ochre Clapboard, 2=Cream Sandstone, 3=Sage Mercantile
    const sideMap = [8, 9, 8, 10];
    return {
      archetype: 'commercial',
      heightM,
      frontCell,
      sideCell: sideMap[frontCell],
      roofCell: r3 < 0.70 ? 13 : 12,
      hasPorch: r1 < 0.72 && (!nearRoad || nearRoad.dist > 5.8),
      hasFalseFront: true,
      steppedParapet: frontCell === 1 || frontCell === 3 || r0 < 0.58,
      parapetRise: 1.25 + r3 * 0.65,
      hasChimney: r2 < 0.35,
      roofPitch: 0.08,
      tint: [0.95 + r0 * 0.09, 0.95 + r1 * 0.08, 0.94 + r2 * 0.08],
    };
  }

  // 4. Historic Victorian Painted-Lady / Miner's Gabled Cottage
  let heightM = rawH;
  if (isDefaultOsmH) {
    if (r0 < 0.38 && polyArea < 135) {
      heightM = 3.85 + r1 * 0.75; // Cozy 1-story Telluride miner's cottage
    } else if (r0 > 0.88 && polyArea > 110) {
      heightM = 7.9 + r1 * 1.25;  // Tall 2.5-story Victorian residence
    } else {
      heightM = 5.75 + r1 * 1.80; // Classic 1.5-2 story Painted Lady
    }
  }
  const housePalette = [4, 5, 6, 4, 6, 5];
  const frontCell = housePalette[Math.floor(r2 * housePalette.length)];
  const sideMap = { 4: 10, 5: 8, 6: 9 };
  return {
    archetype: 'victorian_house',
    heightM,
    frontCell,
    sideCell: sideMap[frontCell] ?? 9,
    roofCell: r3 < 0.52 ? 12 : 13,
    hasPorch: r1 < 0.64 && (!nearRoad || nearRoad.dist > 5.4),
    hasFalseFront: false,
    hasChimney: r2 < 0.68,
    roofPitch: 0.54 + r3 * 0.20, // ~28° to 36° Victorian gable pitch
    tint: [0.94 + r0 * 0.10, 0.94 + r1 * 0.09, 0.94 + r2 * 0.09],
  };
}

/**
 * Build rich Victorian / San Juan architectural geometry for one building footprint:
 * - Outward CCW normals everywhere
 * - Street-facing wall detection toward nearest road (storefront / front door faces the street; side walls use sparse-window Row 2!)
 * - Per-wall street-grade sill + ground-contact AO + deep 9m granite foundation strictly below sill (zero floating buildings or dark above-grade plinth bands)
 * - Western stepped false-front parapets + 3D projecting cornices + covered boardwalk awnings with posts on Main Streets
 * - True pitched 3D gable roofs with overhanging eaves, gable end pediments, brick chimneys, and front porches on Victorian cottages & chalets
 */
function buildBuildingPart(b, terrain, trailData, nearestMainStreet) {
  const coords = b.coords;
  const nPts = Math.floor((coords?.length || 0) / 3);
  if (nPts < 3) return null;

  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const x = coords[i * 3];
    const z = coords[i * 3 + 2];
    if (i === nPts - 1 && Math.hypot(x - coords[0], z - coords[2]) < 0.12) break;
    if (pts.length > 0) {
      const prev = pts[pts.length - 1];
      if (Math.hypot(x - prev.x, z - prev.z) < 0.15) continue;
    }
    pts.push({ x, z, y: 0 });
  }
  if (pts.length < 3) return null;

  let signedArea2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    signedArea2 += a.x * c.z - c.x * a.z;
  }
  if (signedArea2 > 0) {
    pts.reverse();
    signedArea2 = -signedArea2;
  }
  const polyArea = Math.abs(signedArea2) * 0.5;
  if (polyArea < 6.0) return null;

  const fallbackY = b.baseY ?? coords[1] ?? 2667;
  let cx = 0, cz = 0;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    cx += p.x;
    cz += p.z;
    const py = sampleElev(terrain, p.x, p.z, fallbackY);
    p.y = py;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  cx /= pts.length;
  cz /= pts.length;
  const centerY = sampleElev(terrain, cx, cz, fallbackY);
  if (centerY < minY) minY = centerY;
  if (centerY > maxY) maxY = centerY;

  const nearMain = nearestMainStreet ? nearestMainStreet(cx, cz, 38) : null;
  const nearRoad = nearMain || trailData?.nearest?.(cx, cz, 42) || null;
  const spec = classifyBuilding(b, cx, cz, polyArea, nearRoad);
  const [tr, tg, tb] = spec.tint;

  // Identify street-facing front wall edge (faces toward nearest road & reasonably wide >= 3.6m)
  let frontEdgeIdx = 0;
  let bestFrontScore = -Infinity;
  const dirToRoadX = nearRoad ? nearRoad.x - cx : 0;
  const dirToRoadZ = nearRoad ? nearRoad.z - cz : 1;
  const dirToRoadLen = Math.hypot(dirToRoadX, dirToRoadZ) || 1;
  const rdx = dirToRoadX / dirToRoadLen;
  const rdz = dirToRoadZ / dirToRoadLen;

  let longestEdgeIdx = 0;
  let longestEdgeLen = 0;

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len > longestEdgeLen) {
      longestEdgeLen = len;
      longestEdgeIdx = i;
    }
    if (len < 3.4) continue;
    const ox = -dz / len;
    const oz = dx / len;
    const align = nearRoad ? ox * rdx + oz * rdz : (oz * 0.7 + ox * 0.3);
    const score = align * 2.2 + Math.min(len, 16) * 0.08;
    if (score > bestFrontScore) {
      bestFrontScore = score;
      frontEdgeIdx = i;
    }
  }

  const fa = pts[frontEdgeIdx];
  const fb = pts[(frontEdgeIdx + 1) % pts.length];
  const frontMidY = sampleElev(terrain, (fa.x + fb.x) * 0.5, (fa.z + fb.z) * 0.5, fallbackY);
  const frontGradeY = (fa.y + fb.y + frontMidY) / 3;

  // Level horizontal eave line anchored to street-front grade
  const baseGradeY = Math.max(minY, Math.min(maxY, frontGradeY));
  const eaveY = baseGradeY + spec.heightM;
  const foundationY = minY - 9.0; // Deep 9m cut-granite skirt prevents any streaming DEM gap

  const [fu0, fv0, fu1, fv1] = getCellRect(spec.frontCell);
  const [su0, sv0, su1, sv1] = getCellRect(spec.sideCell);
  const [ru0, rv0, ru1, rv1] = getCellRect(spec.roofCell);

  // Single-story UV window cropping so 1-story buildings never squash 2 stories of windows
  const isSingleStory = spec.heightM < 5.1;
  const frontV0 = fv0;
  const frontV1 = isSingleStory
    ? fv0 + (fv1 - fv0) * (spec.archetype === 'commercial' ? 0.52 : 0.51)
    : fv1;
  const sideV0 = sv0;
  const sideV1 = isSingleStory ? sv0 + (sv1 - sv0) * 0.52 : sv1;

  const pb = createPartBuilder();

  // 1. Extrude Foundation Skirt + Architectural Wall Bays
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    const dx = c.x - a.x;
    const dz = c.z - a.z;
    const wallLen = Math.hypot(dx, dz);
    if (wallLen < 0.2) continue;

    const isFront = i === frontEdgeIdx;
    const midY = sampleElev(terrain, (a.x + c.x) * 0.5, (a.z + c.z) * 0.5, fallbackY);
    // Bring brick/clapboard/storefront right down to this wall's local ground grade (no dark floating plinth band!)
    const localGrade = Math.min(eaveY - 2.6, Math.max(minY - 0.15, Math.min(a.y, c.y, midY) + 0.04));

    // Cut San Juan granite foundation strictly below localGrade
    pb.pushQuad(
      a.x, foundationY, a.z,
      c.x, foundationY, c.z,
      c.x, localGrade, c.z,
      a.x, localGrade, a.z,
      GRANITE_UV[0], GRANITE_UV[1], GRANITE_UV[2], GRANITE_UV[3],
      0.52, 0.72, 0.92, 0.91, 0.90
    );

    const isHouseFront = isFront && spec.archetype === 'victorian_house';
    const bayWidth = isHouseFront ? 13.5 : (isFront ? 7.6 : 8.5);
    const bays = Math.max(1, Math.min(7, Math.round(wallLen / bayWidth)));
    const doorBay = Math.floor(bays * 0.5);

    // Lower AO band (0..1.8m) grounds the facade into the sidewalk/terrain; upper band rises to eave shadow
    const wallH = Math.max(2.4, eaveY - localGrade);
    const splitFrac = Math.min(0.42, 1.75 / wallH);
    const splitY = localGrade + wallH * splitFrac;
    const eaveAO = spec.archetype === 'commercial' ? 0.90 : 0.80;

    for (let k = 0; k < bays; k++) {
      const useFrontCell = isFront && (!isHouseFront || k === doorBay);
      const wu0 = useFrontCell ? fu0 : su0;
      const wu1 = useFrontCell ? fu1 : su1;
      const wv0 = useFrontCell ? frontV0 : sideV0;
      const wv1 = useFrontCell ? frontV1 : sideV1;
      const t0 = k / bays;
      const t1 = (k + 1) / bays;
      const x0 = a.x + dx * t0, z0 = a.z + dz * t0;
      const x1 = a.x + dx * t1, z1 = a.z + dz * t1;

      if (wallH > 8.6 && !isSingleStory) {
        // 3+ story landmark hotels/blocks: ground floor + repeated upper window story + top cornice story (never stretched or wrapped across cells!)
        const vSpan = wv1 - wv0;
        const vGroundTop = wv0 + vSpan * 0.50;
        const vUpperBot = wv0 + vSpan * 0.52;
        const vUpperNoCornice = wv0 + vSpan * 0.90;
        const groundTopY = localGrade + 3.85;
        const midSplitY = localGrade + 1.65;
        const vMidAO = wv0 + (vGroundTop - wv0) * (1.65 / 3.85);

        // Ground story (with base AO band)
        pb.pushQuad(x0, localGrade, z0, x1, localGrade, z1, x1, midSplitY, z1, x0, midSplitY, z0, wu0, wv0, wu1, vMidAO, 0.68, 1.0, tr, tg, tb);
        pb.pushQuad(x0, midSplitY, z0, x1, midSplitY, z1, x1, groundTopY, z1, x0, groundTopY, z0, wu0, vMidAO, wu1, vGroundTop, 1.0, 0.98, tr, tg, tb);

        // Repeat upper sash-window stories cleanly up to eaveY
        const remH = eaveY - groundTopY;
        const upperFloors = Math.max(2, Math.round(remH / 3.3));
        for (let uf = 0; uf < upperFloors; uf++) {
          const fy0 = groundTopY + (remH * uf) / upperFloors;
          const fy1 = groundTopY + (remH * (uf + 1)) / upperFloors;
          const isTop = uf === upperFloors - 1;
          pb.pushQuad(
            x0, fy0, z0, x1, fy0, z1, x1, fy1, z1, x0, fy1, z0,
            wu0, vUpperBot, wu1, isTop ? wv1 : vUpperNoCornice,
            0.98, isTop ? eaveAO : 0.98, tr, tg, tb
          );
        }
      } else {
        const splitV = wv0 + (wv1 - wv0) * splitFrac;
        pb.pushQuad(
          x0, localGrade, z0, x1, localGrade, z1, x1, splitY, z1, x0, splitY, z0,
          wu0, wv0, wu1, splitV,
          0.68, 1.0, tr, tg, tb
        );
        pb.pushQuad(
          x0, splitY, z0, x1, splitY, z1, x1, eaveY, z1, x0, eaveY, z0,
          wu0, splitV, wu1, wv1,
          1.0, eaveAO, tr, tg, tb
        );
      }
    }
  }

  // Front wall frame vectors
  const fdx = fb.x - fa.x;
  const fdz = fb.z - fa.z;
  const frontLen = Math.hypot(fdx, fdz) || 1;
  const ftx = fdx / frontLen, ftz = fdz / frontLen;
  const fox = -ftz, foz = ftx; // Outward toward street

  // 2. Commercial Western False-Front Parapet + Projecting 3D Cornice + Shed Roof
  if (spec.hasFalseFront && frontLen >= 3.5) {
    const pDepth = Math.min(0.42, Math.max(0.28, polyArea / (frontLen * 12)));
    const centerRise = spec.parapetRise;
    const wingRise = spec.steppedParapet ? centerRise * 0.52 : centerRise * 0.88;

    // Upper facade strip UV from storefront cell (brick/clapboard above windows)
    const pUv0 = fv0 + (fv1 - fv0) * 0.80;
    const pUv1 = fv0 + (fv1 - fv0) * 0.93;

    const steps = spec.steppedParapet && frontLen >= 5.6
      ? [
          [0.0, 0.22, wingRise],
          [0.22, 0.78, centerRise],
          [0.78, 1.0, wingRise],
        ]
      : [[0.0, 1.0, centerRise]];

    for (let s = 0; s < steps.length; s++) {
      const [s0, s1, rise] = steps[s];
      const topY = eaveY + rise;
      const ax0 = fa.x + fdx * s0, az0 = fa.z + fdz * s0;
      const ax1 = fa.x + fdx * s1, az1 = fa.z + fdz * s1;
      const bx0 = ax0 - fox * pDepth, bz0 = az0 - foz * pDepth;
      const bx1 = ax1 - fox * pDepth, bz1 = az1 - foz * pDepth;

      // Front face of parapet
      pb.pushQuad(ax0, eaveY, az0, ax1, eaveY, az1, ax1, topY, az1, ax0, topY, az0, fu0, pUv0, fu1, pUv1, 0.94, 1.0, tr, tg, tb);
      // Rear face of parapet (facing shed roof)
      pb.pushQuad(bx1, eaveY, bz1, bx0, eaveY, bz0, bx0, topY, bz0, bx1, topY, bz1, su0, pUv0, su1, pUv1, 0.78, 0.90, tr, tg, tb);
      // Left & right side cheeks of parapet step
      pb.pushQuad(bx0, eaveY, bz0, ax0, eaveY, az0, ax0, topY, az0, bx0, topY, bz0, su0, pUv0, su0 + 0.05, pUv1, 0.84, 0.96, tr, tg, tb);
      pb.pushQuad(ax1, eaveY, az1, bx1, eaveY, bz1, bx1, topY, bz1, ax1, topY, az1, su0, pUv0, su0 + 0.05, pUv1, 0.84, 0.96, tr, tg, tb);

      // 3D Projecting Bracketed Cornice Molding (+0.24m proud of facade!)
      const cOut = 0.24;
      const cH = 0.22;
      const cx0 = ax0 + fox * cOut - ftx * 0.08, cz0 = az0 + foz * cOut - ftz * 0.08;
      const cx1 = ax1 + fox * cOut + ftx * 0.08, cz1 = az1 + foz * cOut + ftz * 0.08;
      // Front fascia of cornice
      pb.pushQuad(cx0, topY - cH, cz0, cx1, topY - cH, cz1, cx1, topY + 0.04, cz1, cx0, topY + 0.04, cz0, TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3], 0.88, 1.02);
      // Top coping cap (from back of parapet to front of cornice!)
      pb.pushQuad(bx0, topY + 0.04, bz0, cx0, topY + 0.04, cz0, cx1, topY + 0.04, cz1, bx1, topY + 0.04, bz1, TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3], 0.98, 0.98);
      // Shaded cornice soffit underside (casts crisp shadow reading from street!)
      pb.pushQuad(ax0, topY - cH, az0, ax1, topY - cH, az1, cx1, topY - cH, cz1, cx0, topY - cH, cz0, TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3], 0.50, 0.55);
    }

    // Low-sloped shed roof behind parapet (drains toward rear alley)
    let maxBackDist = 1.0;
    for (let i = 0; i < pts.length; i++) {
      const d = -((pts[i].x - fa.x) * fox + (pts[i].z - fa.z) * foz);
      if (d > maxBackDist) maxBackDist = d;
    }
    const roofFrontY = eaveY + 0.36;
    const roofRearY = eaveY + 0.04;
    const roofYAt = (x, z) => {
      const backD = Math.max(0, Math.min(1, -((x - fa.x) * fox + (z - fa.z) * foz) / maxBackDist));
      return roofFrontY + (roofRearY - roofFrontY) * backD;
    };
    const cRoofY = roofYAt(cx, cz);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const c = pts[(i + 1) % pts.length];
      const ya = roofYAt(a.x, a.z);
      const yc = roofYAt(c.x, c.z);
      pb.pushTri(
        a.x, ya, a.z, c.x, yc, c.z, cx, cRoofY, cz,
        ru0, rv0, ru1, rv0, (ru0 + ru1) * 0.5, rv1,
        0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.96, 0.96, 0.96
      );
      // Seal modest side/rear parapet coping up to ya..yc
      if (i !== frontEdgeIdx) {
        const copTopA = ya + 0.22;
        const copTopC = yc + 0.22;
        pb.pushQuad(
          a.x, eaveY, a.z, c.x, eaveY, c.z, c.x, copTopC, c.z, a.x, copTopA, a.z,
          TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3],
          0.88, 0.98, tr, tg, tb
        );
      }
    }
  } else {
    // 3. True Pitched 3D Gable Roof (or Hipped + Street Gable Dormer on complex L-footprints)
    // Compute OBB aligned with either front edge or longest edge
    const refEdge = pts[longestEdgeIdx];
    const refNext = pts[(longestEdgeIdx + 1) % pts.length];
    const ldx = refNext.x - refEdge.x, ldz = refNext.z - refEdge.z;
    const lLen = Math.hypot(ldx, ldz) || 1;

    // On ~65% of rectangular houses, run ridge perpendicular to street so classic Victorian gable faces the street!
    const streetGable = (hash2i(Math.round(cx), Math.round(cz), 77) & 3) !== 0;
    let rx = streetGable ? -fox : ldx / lLen;
    let rz = streetGable ? -foz : ldz / lLen;
    const rNorm = Math.hypot(rx, rz) || 1;
    rx /= rNorm; rz /= rNorm;
    const px = -rz, pz = rx;

    let minR = Infinity, maxR = -Infinity, minP = Infinity, maxP = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - cx, dz = pts[i].z - cz;
      const pr = dx * rx + dz * rz;
      const pp = dx * px + dz * pz;
      if (pr < minR) minR = pr;
      if (pr > maxR) maxR = pr;
      if (pp < minP) minP = pp;
      if (pp > maxP) maxP = pp;
    }

    // Don't let gable span exceed ridge length * 1.35 (swap axes if wider than long so roof proportions stay natural!)
    if ((maxP - minP) > (maxR - minR) * 1.32) {
      const tmpX = rx, tmpZ = rz;
      rx = px; rz = pz;
      // recompute p = (-rz, rx)
      const npx = -rz, npz = rx;
      minR = Infinity; maxR = -Infinity; minP = Infinity; maxP = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i].x - cx, dz = pts[i].z - cz;
        const pr = dx * rx + dz * rz;
        const pp = dx * npx + dz * npz;
        if (pr < minR) minR = pr;
        if (pr > maxR) maxR = pr;
        if (pp < minP) minP = pp;
        if (pp > maxP) maxP = pp;
      }
    }
    const gpx = -rz, gpz = rx;
    const obbArea = Math.max(1, (maxR - minR) * (maxP - minP));
    const fillRatio = polyArea / obbArea;

    if (fillRatio >= 0.74) {
      // Crisp 3D Overhanging Gable Roof + Gable End Pediment Triangles + Soffit AO!
      const overhang = spec.archetype === 'chalet' ? 0.52 : 0.38;
      const pMid = (minP + maxP) * 0.5;
      const wallHalfSpan = (maxP - minP) * 0.5;
      const roofHalfSpan = wallHalfSpan + overhang;
      const r0 = minR - overhang;
      const r1 = maxR + overhang;
      const ridgeH = Math.min(4.2, Math.max(1.15, wallHalfSpan * spec.roofPitch));
      const peakY = eaveY + ridgeH;
      const dropY = eaveY - overhang * spec.roofPitch * 0.45;

      const pt = (rc, pc, y) => [cx + rx * rc + gpx * pc, y, cz + rz * rc + gpz * pc];

      const R0 = pt(r0, pMid, peakY);
      const R1 = pt(r1, pMid, peakY);
      const E0p = pt(r0, pMid + roofHalfSpan, dropY);
      const E1p = pt(r1, pMid + roofHalfSpan, dropY);
      const E0m = pt(r0, pMid - roofHalfSpan, dropY);
      const E1m = pt(r1, pMid - roofHalfSpan, dropY);

      // +P roof slope & -P roof slope (mathematically verified upward + outward normals!)
      pb.pushQuad(
        E0p[0], E0p[1], E0p[2], E1p[0], E1p[1], E1p[2], R1[0], R1[1], R1[2], R0[0], R0[1], R0[2],
        ru0, rv0, ru1, rv1, 0.90, 1.02
      );
      pb.pushQuad(
        E1m[0], E1m[1], E1m[2], E0m[0], E0m[1], E0m[2], R0[0], R0[1], R0[2], R1[0], R1[1], R1[2],
        ru0, rv0, ru1, rv1, 0.90, 1.02
      );

      // Downward-facing dark under-eave soffit deck (seals all overhangs with rich shadow AO = 0.50!)
      pb.pushQuad(
        E1p[0], dropY, E1p[2], E0p[0], dropY, E0p[2], E0m[0], dropY, E0m[2], E1m[0], dropY, E1m[2],
        TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3], 0.50, 0.50
      );

      // Vertical Gable End Pediment Triangles at minR (-r outward) and maxR (+r outward)
      const G0m = pt(minR, pMid - wallHalfSpan, eaveY);
      const G0p = pt(minR, pMid + wallHalfSpan, eaveY);
      const G0t = pt(minR, pMid, peakY - 0.04);
      const guvMid = (su0 + su1) * 0.5;
      const gvBot = sv0 + (sv1 - sv0) * 0.56;
      const gvTop = sv0 + (sv1 - sv0) * 0.94;

      pb.pushTri(
        G0m[0], G0m[1], G0m[2], G0p[0], G0p[1], G0p[2], G0t[0], G0t[1], G0t[2],
        su0, gvBot, su1, gvBot, guvMid, gvTop,
        0.86 * tr, 0.86 * tg, 0.86 * tb,
        0.86 * tr, 0.86 * tg, 0.86 * tb,
        0.74 * tr, 0.74 * tg, 0.74 * tb
      );

      const G1p = pt(maxR, pMid + wallHalfSpan, eaveY);
      const G1m = pt(maxR, pMid - wallHalfSpan, eaveY);
      const G1t = pt(maxR, pMid, peakY - 0.04);
      pb.pushTri(
        G1p[0], G1p[1], G1p[2], G1m[0], G1m[1], G1m[2], G1t[0], G1t[1], G1t[2],
        su0, gvBot, su1, gvBot, guvMid, gvTop,
        0.86 * tr, 0.86 * tg, 0.86 * tb,
        0.86 * tr, 0.86 * tg, 0.86 * tb,
        0.74 * tr, 0.74 * tg, 0.74 * tb
      );

      // Brick Victorian Chimney on ~68% of gabled roofs
      if (spec.hasChimney) {
        const [cu0, cv0, cu1, cv1] = getCellRect(8); // Brick texture
        const chimR = minR + (maxR - minR) * 0.32;
        const chimP = pMid + wallHalfSpan * 0.28;
        const chimX = cx + rx * chimR + gpx * chimP;
        const chimZ = cz + rz * chimR + gpz * chimP;
        pb.pushVerticalPrism(
          chimX, chimZ, rx, rz, 0.28, 0.28,
          eaveY + 0.2, peakY + 0.85,
          cu0, cv0 + 0.04, cu0 + 0.08, cv0 + 0.16,
          0.80, 1.0, true, 0.95
        );
      }
    } else {
      // Non-rectangular / L-wing footprint: watertight pitched hip roof + street-facing Victorian cross-gable pediment!
      const ridgeH = Math.min(3.4, Math.max(1.25, Math.sqrt(polyArea) * 0.24));
      const peakY = eaveY + ridgeH;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const c = pts[(i + 1) % pts.length];
        // Slight eave flare (+0.28m outward)
        const adx = a.x - cx, adz = a.z - cz;
        const al = Math.hypot(adx, adz) || 1;
        const cdx = c.x - cx, cdz = c.z - cz;
        const cl = Math.hypot(cdx, cdz) || 1;
        const ax = a.x + (adx / al) * 0.26, az = a.z + (adz / al) * 0.26;
        const cxp = c.x + (cdx / cl) * 0.26, czp = c.z + (cdz / cl) * 0.26;
        pb.pushTri(
          ax, eaveY - 0.08, az, cxp, eaveY - 0.08, czp, cx, peakY, cz,
          ru0, rv0, ru1, rv0, (ru0 + ru1) * 0.5, rv1,
          0.88, 0.88, 0.88, 0.88, 0.88, 0.88, 1.0, 1.0, 1.0
        );
      }
      if (frontLen >= 4.2) {
        // Street-facing decorative Victorian gable dormer/pediment
        const g0x = fa.x + fdx * 0.22, g0z = fa.z + fdz * 0.22;
        const g1x = fa.x + fdx * 0.78, g1z = fa.z + fdz * 0.78;
        const gmx = (g0x + g1x) * 0.5, gmz = (g0z + g1z) * 0.5;
        const gTopY = eaveY + Math.min(2.1, frontLen * 0.22);
        const bmx = gmx - fox * 2.2, bmz = gmz - foz * 2.2;
        pb.pushTri(
          g0x, eaveY, g0z, g1x, eaveY, g1z, gmx, gTopY, gmz,
          su0, sv0 + 0.12, su1, sv0 + 0.12, (su0 + su1) * 0.5, sv1 - 0.02,
          0.90 * tr, 0.90 * tg, 0.90 * tb, 0.90 * tr, 0.90 * tg, 0.90 * tb, 0.82 * tr, 0.82 * tg, 0.82 * tb
        );
        pb.pushTri(g0x, eaveY, g0z, gmx, gTopY, gmz, bmx, gTopY - 0.15, bmz, ru0, rv0, ru1, rv1, ru0, rv1, 0.92, 0.92, 0.92);
        pb.pushTri(gmx, gTopY, gmz, g1x, eaveY, g1z, bmx, gTopY - 0.15, bmz, ru0, rv1, ru1, rv0, ru1, rv1, 0.92, 0.92, 0.92);
      }
    }
  }

  // 4. 3D Covered Front Porch / Main-Street Boardwalk Awning with Wooden Posts
  if (spec.hasPorch && frontLen >= 4.6) {
    const isComm = spec.archetype === 'commercial';
    const margin = isComm ? 0.04 : 0.12;
    const pLen = frontLen * (1 - 2 * margin);
    if (pLen >= 3.6) {
      const depth = isComm ? 1.80 : 1.50;
      const px0 = fa.x + fdx * margin, pz0 = fa.z + fdz * margin;
      const px1 = fa.x + fdx * (1 - margin), pz1 = fa.z + fdz * (1 - margin);
      const ox0 = px0 + fox * depth, oz0 = pz0 + foz * depth;
      const ox1 = px1 + fox * depth, oz1 = pz1 + foz * depth;

      const gOut0 = sampleElev(terrain, ox0, oz0, frontGradeY);
      const gOut1 = sampleElev(terrain, ox1, oz1, frontGradeY);
      const porchGrade = Math.max(minY - 0.2, Math.min(frontGradeY, (gOut0 + gOut1) * 0.5) + (isComm ? 0.06 : 0.20));

      const wallAttachY = Math.min(eaveY - 0.25, porchGrade + (isComm ? 3.35 : 2.80));
      const dripEdgeY = wallAttachY - (isComm ? 0.48 : 0.38);

      // Sloped porch/awning roof top (upward normal: (px0 -> ox0 -> ox1 -> px1)!)
      pb.pushQuad(
        px0, wallAttachY, pz0,
        ox0, dripEdgeY, oz0,
        ox1, dripEdgeY, oz1,
        px1, wallAttachY, pz1,
        ru0, rv0, ru1, rv1,
        0.88, 0.98
      );
      // Shaded awning soffit underside (downward normal)
      pb.pushQuad(
        px0, wallAttachY - 0.07, pz0,
        px1, wallAttachY - 0.07, pz1,
        ox1, dripEdgeY - 0.07, oz1,
        ox0, dripEdgeY - 0.07, oz0,
        TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3],
        0.48, 0.56
      );
      // Front trim fascia beam along drip edge
      pb.pushQuad(
        ox0, dripEdgeY - 0.14, oz0,
        ox1, dripEdgeY - 0.14, oz1,
        ox1, dripEdgeY + 0.02, oz1,
        ox0, dripEdgeY + 0.02, oz0,
        TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3],
        0.86, 0.98
      );

      // Raised wooden porch deck on Victorian houses
      if (!isComm) {
        const deckSkirtBot = Math.min(gOut0, gOut1, porchGrade) - 1.4;
        pb.pushQuad(
          px0, porchGrade, pz0,
          ox0, porchGrade, oz0,
          ox1, porchGrade, oz1,
          px1, porchGrade, pz1,
          PORCH_DECK_UV[0], PORCH_DECK_UV[1], PORCH_DECK_UV[2], PORCH_DECK_UV[3],
          0.78, 0.92
        );
        // Front & side porch skirts so porch never floats on sloped yards
        pb.pushQuad(ox0, deckSkirtBot, oz0, ox1, deckSkirtBot, oz1, ox1, porchGrade, oz1, ox0, porchGrade, oz0, GRANITE_UV[0], GRANITE_UV[1], GRANITE_UV[2], GRANITE_UV[3], 0.55, 0.78);
        pb.pushQuad(px0, deckSkirtBot, pz0, ox0, deckSkirtBot, oz0, ox0, porchGrade, oz0, px0, porchGrade, pz0, GRANITE_UV[0], GRANITE_UV[1], GRANITE_UV[2], GRANITE_UV[3], 0.55, 0.78);
        pb.pushQuad(ox1, deckSkirtBot, oz1, px1, deckSkirtBot, pz1, px1, porchGrade, pz1, ox1, porchGrade, oz1, GRANITE_UV[0], GRANITE_UV[1], GRANITE_UV[2], GRANITE_UV[3], 0.55, 0.78);
      }

      // Slender 3D painted wooden porch/boardwalk posts down to sidewalk/deck
      const nPosts = Math.max(2, Math.min(4, Math.round(pLen / 3.8) + 1));
      for (let k = 0; k < nPosts; k++) {
        const s = nPosts === 1 ? 0.5 : k / (nPosts - 1);
        const postX = ox0 + (ox1 - ox0) * (0.04 + s * 0.92);
        const postZ = oz0 + (oz1 - oz0) * (0.04 + s * 0.92);
        const postBot = isComm ? sampleElev(terrain, postX, postZ, porchGrade) - 0.35 : porchGrade;
        pb.pushVerticalPrism(
          postX, postZ, ftx, ftz, 0.065, 0.065,
          postBot, dripEdgeY - 0.06,
          TRIM_UV[0], TRIM_UV[1], TRIM_UV[2], TRIM_UV[3],
          0.66, 0.92, false, 0.96
        );
      }
    }
  }

  return pb.finish();
}

/**
 * Build terrain-draped 3D town street roadbed + raised cut-granite curbs + sandstone sidewalks
 * for one urban `road` polyline, with automatic intersection curb-cuts where cross-streets meet!
 */
function buildTownStreetPart(road, terrain, isInsideCrossStreet) {
  const coords = road.coords;
  const nRaw = Math.floor((coords?.length || 0) / 3);
  if (nRaw < 2) return null;

  const isMain = MAIN_STREET_RE.test(road.name || '') || (road.widthM || 0) >= 7.0;
  const halfRoad = isMain ? 3.85 : Math.max(2.65, Math.min(3.6, (road.widthM || 5.4) * 0.52));
  const curbW = 0.16;
  const walkW = isMain ? 1.95 : 1.35;

  // Subdivide road polyline every ~4.5m so street & sidewalks hug sloped mountain towns seamlessly
  const spine = [];
  let cumDist = 0;
  for (let i = 0; i < nRaw; i++) {
    const x = coords[i * 3];
    const fallbackY = coords[i * 3 + 1];
    const z = coords[i * 3 + 2];
    if (i === 0) {
      spine.push({ x, z, fallbackY, d: 0 });
    } else {
      const prev = spine[spine.length - 1];
      const segLen = Math.hypot(x - prev.x, z - prev.z);
      if (segLen < 0.25) continue;
      const steps = Math.max(1, Math.ceil(segLen / 2.6));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const sx = prev.x + (x - prev.x) * t;
        const sz = prev.z + (z - prev.z) * t;
        const sy = prev.fallbackY + (fallbackY - prev.fallbackY) * t;
        cumDist += segLen / steps;
        spine.push({ x: sx, z: sz, fallbackY: sy, d: cumDist });
      }
    }
  }
  if (spine.length < 2) return null;

  // Compute smooth mitered unit normals along spine
  const frames = new Array(spine.length);
  for (let i = 0; i < spine.length; i++) {
    const a = spine[Math.max(0, i - 1)];
    const c = spine[Math.min(spine.length - 1, i + 1)];
    let tx = c.x - a.x;
    let tz = c.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    // Left normal (-tz, tx), Right normal (tz, -tx)
    // Wait: let's verify upward normal for strip advancing along +t = (0, 1) (+Z):
    // If left = (+1, 0) and right = (-1, 0):
    // From a_right=(-1,0,0) -> a_left=(+1,0,0) -> b_left=(+1,0,1):
    // u = (+2,0,0), v = (+2,0,1) -> u x v = (0, -2, 0) DOWNWARD!
    // Whereas if rx = -tz, rz = tx: for t=(0,1), r=(-1,0), so -r=(+1,0):
    // Quad (a - r, a + r, b + r, b - r) = ((+1,0,0), (-1,0,0), (-1,0,1), (+1,0,1)):
    // u = (-2,0,0), v = (-2,0,1) -> u x v = (0, -(-2)*1, 0) = (0, +2, 0) UPWARD!!
    const rx = -tz;
    const rz = tx;
    const cy = sampleElev(terrain, spine[i].x, spine[i].z, spine[i].fallbackY);
    const roadX1 = spine[i].x + rx * halfRoad, roadZ1 = spine[i].z + rz * halfRoad;
    const roadX0 = spine[i].x - rx * halfRoad, roadZ0 = spine[i].z - rz * halfRoad;
    const yRoadPos = sampleElev(terrain, roadX1, roadZ1, cy) + 0.022;
    const yRoadNeg = sampleElev(terrain, roadX0, roadZ0, cy) + 0.022;
    const yRoadMid = cy + 0.026;

    const walkOuter = halfRoad + curbW + walkW;
    const cxPos = spine[i].x + rx * (halfRoad + 0.1), czPos = spine[i].z + rz * (halfRoad + 0.1);
    const cxNeg = spine[i].x - rx * (halfRoad + 0.1), czNeg = spine[i].z - rz * (halfRoad + 0.1);
    const wxPos = spine[i].x + rx * walkOuter, wzPos = spine[i].z + rz * walkOuter;
    const wxNeg = spine[i].x - rx * walkOuter, wzNeg = spine[i].z - rz * walkOuter;

    const cutPos =
      isInsideCrossStreet(wxPos, wzPos, road.id, tx, tz) ||
      isInsideCrossStreet(cxPos, czPos, road.id, tx, tz);
    const cutNeg =
      isInsideCrossStreet(wxNeg, wzNeg, road.id, tx, tz) ||
      isInsideCrossStreet(cxNeg, czNeg, road.id, tx, tz);

    const curbRisePos = cutPos ? 0.0 : 0.11;
    const curbRiseNeg = cutNeg ? 0.0 : 0.11;

    const yWalkInPos = yRoadPos + curbRisePos;
    const yWalkOutPos = sampleElev(terrain, wxPos, wzPos, cy) + (cutPos ? 0.020 : 0.105);
    const yWalkInNeg = yRoadNeg + curbRiseNeg;
    const yWalkOutNeg = sampleElev(terrain, wxNeg, wzNeg, cy) + (cutNeg ? 0.020 : 0.105);

    frames[i] = {
      x: spine[i].x,
      z: spine[i].z,
      d: spine[i].d,
      rx,
      rz,
      yRoadMid,
      yRoadPos,
      yRoadNeg,
      yWalkInPos,
      yWalkOutPos,
      yWalkInNeg,
      yWalkOutNeg,
      cutPos,
      cutNeg,
    };
  }

  const pb = createPartBuilder();
  const midU = (ASPHALT_U0 + ASPHALT_U1) * 0.5;

  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    // Tile V cleanly within Cell 15 [STREET_V0..STREET_V1] per segment so RepeatWrapping isn't needed across trimsheet cells
    const segLen = Math.max(0.2, b.d - a.d);
    const vSpan = Math.min(STREET_V1 - STREET_V0, (segLen / 7.5) * (STREET_V1 - STREET_V0));
    const v0 = STREET_V0;
    const v1 = STREET_V0 + vSpan;

    // 1) Crowned Asphalt Roadbed: (-halfRoad -> 0) and (0 -> +halfRoad), verified +Y upward normal!
    const axNeg = a.x - a.rx * halfRoad, azNeg = a.z - a.rz * halfRoad;
    const bxNeg = b.x - b.rx * halfRoad, bzNeg = b.z - b.rz * halfRoad;
    const axPos = a.x + a.rx * halfRoad, azPos = a.z + a.rz * halfRoad;
    const bxPos = b.x + b.rx * halfRoad, bzPos = b.z + b.rz * halfRoad;

    pb.pushQuad(
      axNeg, a.yRoadNeg, azNeg,
      a.x, a.yRoadMid, a.z,
      b.x, b.yRoadMid, b.z,
      bxNeg, b.yRoadNeg, bzNeg,
      ASPHALT_U0, v0, midU, v1,
      0.94, 0.98
    );
    pb.pushQuad(
      a.x, a.yRoadMid, a.z,
      axPos, a.yRoadPos, azPos,
      bxPos, b.yRoadPos, bzPos,
      b.x, b.yRoadMid, b.z,
      midU, v0, ASPHALT_U1, v1,
      0.98, 0.94
    );

    // 2) Positive-side (+r) Granite Curb + Sandstone Sidewalk (suppressed cleanly in cross-intersections!)
    if (!a.cutPos && !b.cutPos) {
      const cOff = halfRoad + curbW;
      const wOff = cOff + walkW;
      const acx = a.x + a.rx * cOff, acz = a.z + a.rz * cOff;
      const bcx = b.x + b.rx * cOff, bcz = b.z + b.rz * cOff;
      const awx = a.x + a.rx * wOff, awz = a.z + a.rz * wOff;
      const bwx = b.x + b.rx * wOff, bwz = b.z + b.rz * wOff;

      // Curb bevel
      pb.pushQuad(
        axPos, a.yRoadPos, azPos,
        acx, a.yWalkInPos, acz,
        bcx, b.yWalkInPos, bcz,
        bxPos, b.yRoadPos, bzPos,
        CURB_U0, v0, CURB_U1, v1,
        0.78, 0.96
      );
      // Sandstone sidewalk deck
      pb.pushQuad(
        acx, a.yWalkInPos, acz,
        awx, a.yWalkOutPos, awz,
        bwx, b.yWalkOutPos, bwz,
        bcx, b.yWalkInPos, bcz,
        SIDEWALK_U0, v0, SIDEWALK_U1, v1,
        0.96, 0.92
      );
      // Outer sidewalk edge skirt down into ground (-0.22m) so cross-slope edges never float!
      pb.pushQuad(
        awx, a.yWalkOutPos, awz,
        awx, a.yWalkOutPos - 0.24, awz,
        bwx, b.yWalkOutPos - 0.24, bwz,
        bwx, b.yWalkOutPos, bwz,
        CURB_U0, v0, CURB_U1, v1,
        0.86, 0.65
      );
    }

    // 3) Negative-side (-r) Granite Curb + Sandstone Sidewalk
    if (!a.cutNeg && !b.cutNeg) {
      const cOff = halfRoad + curbW;
      const wOff = cOff + walkW;
      const acx = a.x - a.rx * cOff, acz = a.z - a.rz * cOff;
      const bcx = b.x - b.rx * cOff, bcz = b.z - b.rz * cOff;
      const awx = a.x - a.rx * wOff, awz = a.z - a.rz * wOff;
      const bwx = b.x - b.rx * wOff, bwz = b.z - b.rz * wOff;

      // Note ordering from -wOff -> -cOff -> -halfRoad so normal points +Y!
      pb.pushQuad(
        acx, a.yWalkInNeg, acz,
        axNeg, a.yRoadNeg, azNeg,
        bxNeg, b.yRoadNeg, bzNeg,
        bcx, b.yWalkInNeg, bcz,
        CURB_U1, v0, CURB_U0, v1,
        0.96, 0.78
      );
      pb.pushQuad(
        awx, a.yWalkOutNeg, awz,
        acx, a.yWalkInNeg, acz,
        bcx, b.yWalkInNeg, bcz,
        bwx, b.yWalkOutNeg, bwz,
        SIDEWALK_U1, v0, SIDEWALK_U0, v1,
        0.92, 0.96
      );
      pb.pushQuad(
        awx, a.yWalkOutNeg - 0.24, awz,
        awx, a.yWalkOutNeg, awz,
        bwx, b.yWalkOutNeg, bwz,
        bwx, b.yWalkOutNeg - 0.24, bwz,
        CURB_U0, v0, CURB_U1, v1,
        0.65, 0.86
      );
    }
  }

  return pb.finish();
}

const BRIDAL_VEIL_PLANT = { lon: -107.7689, lat: 37.9214 };
const MINING_RUINS = [
  { name: 'Tomboy Mine Ruins', lon: -107.7524, lat: 37.9348, fallbackY: 3505 },
  { name: 'Governor Basin Mill', lon: -107.7615, lat: 37.9685, fallbackY: 3560 },
  { name: 'Animas Forks Ruins', lon: -107.5712, lat: 37.9311, fallbackY: 3415 },
];

// Curated historic downtown street corridors so Main Streets have zero wild boulders/spruces and instant street framing
const HISTORIC_DOWNTOWN_CORRIDORS = [
  { lon0: -107.8195, lat0: 37.9355, lon1: -107.8045, lat1: 37.9395 }, // Telluride W/E Colorado & Pacific Ave
  { lon0: -107.8520, lat0: 37.9308, lon1: -107.8435, lat1: 37.9352 }, // Mountain Village Core
  { lon0: -107.6685, lat0: 37.8085, lon1: -107.6615, lat1: 37.8160 }, // Silverton Greene & Blair St
  { lon0: -107.6745, lat0: 38.0185, lon1: -107.6685, lat1: 38.0275 }, // Ouray Main St
];

export function createStructures(engine, terrain, trailData, atmosphere) {
  const { scene, events, scheduler } = engine;
  const textures = engine.worldTextures;
  const root = new THREE.Group();
  root.name = 'SanJuanStructures';
  scene.add(root);

  let disposed = false;

  // --- Fast O(1) Spatial Building, Collider & Town-Street Mask shared with vegetation/rocks/gameplay ---
  const maskGrid = new Map();
  const bldgColliderGrid = new Map(); // 64m integer hash -> array of building/ruin polygon colliders
  const roadSegHash = new Map(); // 64m integer hash -> array of town street segment records
  const animatedLifts = [];
  let hasRealBridalVeilBldg = false;
  const townCorridors = HISTORIC_DOWNTOWN_CORRIDORS.map((c) => {
    const a = lonLatToWorld(c.lon0, c.lat0);
    const b = lonLatToWorld(c.lon1, c.lat1);
    return [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)];
  });

  function indexBuildingBbox(minX, minZ, maxX, maxZ) {
    const pad = 28;
    const cx0 = Math.floor((minX - pad) / MASK_CELL_M);
    const cx1 = Math.floor((maxX + pad) / MASK_CELL_M);
    const cz0 = Math.floor((minZ - pad) / MASK_CELL_M);
    const cz1 = Math.floor((maxZ + pad) / MASK_CELL_M);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = (cx + 4096) * 8192 + (cz + 4096);
        let arr = maskGrid.get(k);
        if (!arr) {
          arr = [];
          maskGrid.set(k, arr);
        }
        arr.push(minX, minZ, maxX, maxZ);
      }
    }
  }

  function indexBuildingCollider(coords, minX, minZ, maxX, maxZ, isFallbackPlant = false) {
    const rawPts = Math.floor((coords?.length || 0) / 3);
    if (rawPts < 3) return;
    let nPts = rawPts;
    if (
      nPts > 3 &&
      Math.hypot(coords[(nPts - 1) * 3] - coords[0], coords[(nPts - 1) * 3 + 2] - coords[2]) < 0.12
    ) {
      nPts--;
    }
    if (nPts < 3) return;

    // Precompute polygon winding sign so outward wall normals are exact with zero per-frame work
    let signedArea2 = 0;
    for (let i = 0; i < nPts; i++) {
      const j = (i + 1) % nPts;
      signedArea2 += coords[i * 3] * coords[j * 3 + 2] - coords[j * 3] * coords[i * 3 + 2];
    }
    if (Math.abs(signedArea2) < 1.0) return;

    const rec = {
      coords,
      nPts,
      minX,
      minZ,
      maxX,
      maxZ,
      outSign: signedArea2 < 0 ? 1 : -1,
      isFallbackPlant,
    };

    const pad = 2.0;
    const cx0 = Math.floor((minX - pad) / MASK_CELL_M);
    const cx1 = Math.floor((maxX + pad) / MASK_CELL_M);
    const cz0 = Math.floor((minZ - pad) / MASK_CELL_M);
    const cz1 = Math.floor((maxZ + pad) / MASK_CELL_M);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = (cx + 4096) * 8192 + (cz + 4096);
        let arr = bldgColliderGrid.get(k);
        if (!arr) {
          arr = [];
          bldgColliderGrid.set(k, arr);
        }
        arr.push(rec);
      }
    }
  }

  function isInsideCrossStreet(x, z, selfId) {
    const cx = Math.floor(x / ROAD_HASH_M);
    const cz = Math.floor(z / ROAD_HASH_M);
    const bucket = roadSegHash.get((cx + 4096) * 8192 + (cz + 4096));
    if (!bucket) return false;
    for (let i = 0; i < bucket.length; i++) {
      const s = bucket[i];
      if (s.roadId === selfId) continue;
      let t = ((x - s.x0) * s.dx + (z - s.z0) * s.dz) * s.invLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = x - (s.x0 + s.dx * t);
      const ez = z - (s.z0 + s.dz * t);
      if (ex * ex + ez * ez <= s.halfW * s.halfW) return true;
    }
    return false;
  }

  const worldBuildingMask = {
    isInTownCorridor(x, z) {
      for (let i = 0; i < townCorridors.length; i++) {
        const c = townCorridors[i];
        if (x >= c[0] && x <= c[2] && z >= c[1] && z <= c[3]) return true;
      }
      return false;
    },
    isNearBuilding(x, z, padM = 8) {
      const cx = Math.floor(x / MASK_CELL_M);
      const cz = Math.floor(z / MASK_CELL_M);
      const bucket = maskGrid.get((cx + 4096) * 8192 + (cz + 4096));
      if (!bucket) return false;
      for (let i = 0; i < bucket.length; i += 4) {
        if (
          x >= bucket[i] - padM &&
          x <= bucket[i + 2] + padM &&
          z >= bucket[i + 1] - padM &&
          z <= bucket[i + 3] + padM
        ) {
          return true;
        }
      }
      return false;
    },
    pushOutOfBuilding(x, z, radiusM = 0.48, out = _pushOut) {
      let px = x;
      let pz = z;
      let pushed = false;
      const pushDist = radiusM + 0.02;
      const radSq = radiusM * radiusM;

      // Up to 2 relaxation passes cleanly handle concave corners and adjacent party-wall buildings
      for (let pass = 0; pass < 2; pass++) {
        let passPushed = false;
        const cx0 = Math.floor((px - radiusM) / MASK_CELL_M);
        const cx1 = Math.floor((px + radiusM) / MASK_CELL_M);
        const cz0 = Math.floor((pz - radiusM) / MASK_CELL_M);
        const cz1 = Math.floor((pz + radiusM) / MASK_CELL_M);

        for (let cz = cz0; cz <= cz1; cz++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const bucket = bldgColliderGrid.get((cx + 4096) * 8192 + (cz + 4096));
            if (!bucket) continue;
            for (let bi = 0; bi < bucket.length; bi++) {
              const rec = bucket[bi];
              if (rec.isFallbackPlant && hasRealBridalVeilBldg) continue;
              if (
                px < rec.minX - radiusM ||
                px > rec.maxX + radiusM ||
                pz < rec.minZ - radiusM ||
                pz > rec.maxZ + radiusM
              ) {
                continue;
              }

              const c = rec.coords;
              const nPts = rec.nPts;
              const outSign = rec.outSign;
              let inside = false;
              let bestDSq = Infinity;
              let bestQx = px;
              let bestQz = pz;
              let bestNx = 1;
              let bestNz = 0;

              for (let i = 0; i < nPts; i++) {
                const j = i + 1 < nPts ? i + 1 : 0;
                const ax = c[i * 3];
                const az = c[i * 3 + 2];
                const bx = c[j * 3];
                const bz = c[j * 3 + 2];

                // Even-odd point-in-polygon test in XZ
                if ((az > pz) !== (bz > pz) && px < ((bx - ax) * (pz - az)) / (bz - az) + ax) {
                  inside = !inside;
                }

                // Closest point on edge (a -> b)
                const edx = bx - ax;
                const edz = bz - az;
                const lenSq = edx * edx + edz * edz;
                if (lenSq < 1e-6) continue;
                let t = ((px - ax) * edx + (pz - az) * edz) / lenSq;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                const qx = ax + edx * t;
                const qz = az + edz * t;
                const vx = px - qx;
                const vz = pz - qz;
                const dSq = vx * vx + vz * vz;
                if (dSq < bestDSq) {
                  bestDSq = dSq;
                  bestQx = qx;
                  bestQz = qz;
                  const invLen = 1 / Math.sqrt(lenSq);
                  bestNx = -edz * invLen * outSign;
                  bestNz = edx * invLen * outSign;
                }
              }

              if (inside) {
                px = bestQx + bestNx * pushDist;
                pz = bestQz + bestNz * pushDist;
                pushed = true;
                passPushed = true;
              } else if (bestDSq < radSq) {
                const dist = Math.sqrt(bestDSq);
                let nx = bestNx;
                let nz = bestNz;
                if (dist > 1e-5) {
                  nx = (px - bestQx) / dist;
                  nz = (pz - bestQz) / dist;
                }
                px = bestQx + nx * pushDist;
                pz = bestQz + nz * pushDist;
                pushed = true;
                passPushed = true;
              }
            }
          }
        }

        // Gondola & chairlift tower pylons (0.65m tower half-width + runner radius)
        const pylonClear = 0.65 + radiusM;
        const pylonClearSq = pylonClear * pylonClear;
        const pylonPush = pylonClear + 0.02;
        for (let l = 0; l < animatedLifts.length; l++) {
          const lift = animatedLifts[l];
          if (
            px < lift.minX - pylonClear ||
            px > lift.maxX + pylonClear ||
            pz < lift.minZ - pylonClear ||
            pz > lift.maxZ + pylonClear
          ) {
            continue;
          }
          const pts = lift.pylonPts;
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const dx = px - p.x;
            const dz = pz - p.z;
            const dSq = dx * dx + dz * dz;
            if (dSq < pylonClearSq) {
              const dist = Math.sqrt(dSq);
              const nx = dist > 1e-5 ? dx / dist : 1;
              const nz = dist > 1e-5 ? dz / dist : 0;
              px = p.x + nx * pylonPush;
              pz = p.z + nz * pylonPush;
              pushed = true;
              passPushed = true;
            }
          }
        }

        if (!passPushed) break;
      }

      out.x = px;
      out.z = pz;
      out.pushed = pushed;
      return out;
    },
    getWalkableDeckHeight(x, z) {
      const cx = Math.floor(x / ROAD_HASH_M);
      const cz = Math.floor(z / ROAD_HASH_M);
      const bucket = roadSegHash.get((cx + 4096) * 8192 + (cz + 4096));
      if (!bucket) return -Infinity;

      let bestY = -Infinity;
      for (let i = 0; i < bucket.length; i++) {
        const s = bucket[i];
        const rx = x - s.x0;
        const rz = z - s.z0;
        const tRaw = (rx * s.dx + rz * s.dz) * s.invLenSq;
        let t = tRaw;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = x - (s.x0 + s.dx * t);
        const ez = z - (s.z0 + s.dz * t);
        const dSq = ex * ex + ez * ez;
        if (dSq > s.walkOuterSq) continue;

        // Avoid projecting ghost sidewalks past dead-end segment endpoints (keep miter margin <= 0.45m)
        if (tRaw < 0 || tRaw > 1) {
          const along = Math.abs(ex * s.tx + ez * s.tz);
          if (along > 0.45) continue;
        }

        const dist = Math.sqrt(dSq);
        const fbY = s.y0 + (s.y1 - s.y0) * t;
        let offset;
        if (dist <= s.halfRoad) {
          // Crowned asphalt roadbed (+0.026m centerline -> +0.022m gutter edge)
          offset = 0.026 - 0.004 * (dist / s.halfRoad);
        } else {
          // Suppress curb/sidewalk lift inside cross-street intersections (matching buildTownStreetPart)
          if (isInsideCrossStreet(x, z, s.roadId)) continue;
          const curbEdge = s.halfRoad + s.curbW;
          if (dist <= curbEdge) {
            // Granite curb ramp (+0.022m -> +0.132m)
            offset = 0.022 + 0.11 * ((dist - s.halfRoad) / s.curbW);
          } else {
            // Sandstone sidewalk deck (+0.132m inner curb -> +0.105m outer edge)
            offset = 0.132 - 0.027 * ((dist - curbEdge) / s.walkW);
          }
        }

        const deckY = sampleElev(terrain, x, z, fbY) + offset;
        if (deckY > bestY) bestY = deckY;
      }
      return bestY;
    },
  };
  engine.worldBuildingMask = worldBuildingMask;

  // --- PBR Materials sharing the 1024x1024 Victorian & San Juan Trimsheet ---
  const useNormalsInit = engine.quality.tier !== 'low';
  const buildingMat = patchSanJuanMaterial(
    new THREE.MeshStandardMaterial({
      map: textures.buildingAtlas,
      normalMap: useNormalsInit ? textures.buildingNormal : null,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughnessMap: textures.buildingRoughness,
      roughness: 1.0,
      metalness: 0.06,
      vertexColors: true,
      side: THREE.FrontSide,
    }),
    atmosphere.uniforms
  );

  const townStreetMat = patchSanJuanMaterial(
    new THREE.MeshStandardMaterial({
      map: textures.buildingAtlas,
      normalMap: useNormalsInit ? textures.buildingNormal : null,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughnessMap: textures.buildingRoughness,
      roughness: 1.0,
      metalness: 0.02,
      vertexColors: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -3,
    }),
    atmosphere.uniforms
  );

  const vertexColMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ vertexColors: true }),
    atmosphere.uniforms
  );
  const cableMat = patchSanJuanMaterial(
    new THREE.LineBasicMaterial({ color: 0x22262b }),
    atmosphere.uniforms
  );

  const disposables = new Set();
  const resnapCancels = new Set();

  // --- Global Instanced Aerialways (4 draw calls total) ---
  const pylonGeo = buildPylonGeometry();
  const gondolaCabinGeo = buildGondolaCabinGeometry();
  const chairGeo = buildLiftChairGeometry();
  disposables.add(pylonGeo);
  disposables.add(gondolaCabinGeo);
  disposables.add(chairGeo);

  const pylonMesh = new THREE.InstancedMesh(pylonGeo, vertexColMat, MAX_PYLONS);
  pylonMesh.count = 0;
  pylonMesh.frustumCulled = false;
  root.add(pylonMesh);

  const gondolaCabinMesh = new THREE.InstancedMesh(gondolaCabinGeo, vertexColMat, MAX_GONDOLA_CABINS);
  gondolaCabinMesh.count = 0;
  gondolaCabinMesh.frustumCulled = false;
  root.add(gondolaCabinMesh);

  const chairMesh = new THREE.InstancedMesh(chairGeo, vertexColMat, MAX_LIFT_CHAIRS);
  chairMesh.count = 0;
  chairMesh.frustumCulled = false;
  root.add(chairMesh);

  let cableGeo = new THREE.BufferGeometry();
  cableGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  disposables.add(cableGeo);
  const cableLines = new THREE.LineSegments(cableGeo, cableMat);
  cableLines.frustumCulled = false;
  root.add(cableLines);

  // --- Town Road Spatial Hash for Clean Curb-Cut Intersections & Main-Street Storefront Detection ---
  const seenRoads = new Set();
  const seenMainStreets = new Set();
  const mainStreetSegs = [];
  const pendingTownRoads = [];

  function indexMainStreets(trailsList) {
    if (!trailsList?.length) return;
    for (let i = 0; i < trailsList.length; i++) {
      const t = trailsList[i];
      if (!t || t.kind !== 'road' || !t.coords || t.coords.length < 6) continue;
      if (!MAIN_STREET_RE.test(t.name || '')) continue;
      const id = t.id || `ms_${Math.round(t.coords[0])}_${Math.round(t.coords[2])}`;
      if (seenMainStreets.has(id)) continue;
      seenMainStreets.add(id);
      const c = t.coords;
      for (let k = 0; k <= c.length - 6; k += 3) {
        const x0 = c[k], z0 = c[k + 2];
        const dx = c[k + 3] - x0, dz = c[k + 5] - z0;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 0.04) continue;
        mainStreetSegs.push({ x0, z0, dx, dz, invLenSq: 1 / lenSq, name: t.name || 'Main Street' });
      }
    }
  }

  function nearestMainStreet(x, z, maxDist = 38) {
    let bestD2 = maxDist * maxDist;
    let best = null;
    for (let i = 0; i < mainStreetSegs.length; i++) {
      const s = mainStreetSegs[i];
      if (Math.abs(x - s.x0) > maxDist + Math.abs(s.dx) || Math.abs(z - s.z0) > maxDist + Math.abs(s.dz)) continue;
      let t = ((x - s.x0) * s.dx + (z - s.z0) * s.dz) * s.invLenSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = s.x0 + s.dx * t;
      const pz = s.z0 + s.dz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { dist: Math.sqrt(d2), x: px, z: pz, kind: 'road', name: s.name };
      }
    }
    return best;
  }

  function indexRoadSegments(road) {
    const c = road.coords;
    if (!c || c.length < 6) return;
    const isMain = MAIN_STREET_RE.test(road.name || '') || (road.widthM || 0) >= 7.0;
    const halfRoad = isMain ? 3.85 : Math.max(2.65, Math.min(3.6, (road.widthM || 5.4) * 0.52));
    const curbW = 0.16;
    const walkW = isMain ? 1.95 : 1.35;
    const walkOuter = halfRoad + curbW + walkW;
    const walkOuterSq = walkOuter * walkOuter;
    const halfW = isMain ? 3.90 : Math.max(2.70, Math.min(3.65, (road.widthM || 5.4) * 0.53));
    for (let i = 0; i <= c.length - 6; i += 3) {
      const x0 = c[i], y0 = c[i + 1], z0 = c[i + 2];
      const x1 = c[i + 3], y1 = c[i + 4], z1 = c[i + 5];
      const dx = x1 - x0, dz = z1 - z0;
      const lenSq = dx * dx + dz * dz;
      if (lenSq < 0.04) continue;
      const len = Math.sqrt(lenSq);
      const rec = {
        roadId: road.id,
        x0,
        z0,
        y0,
        y1,
        dx,
        dz,
        invLenSq: 1 / lenSq,
        tx: dx / len,
        tz: dz / len,
        halfW,
        halfRoad,
        curbW,
        walkW,
        walkOuter,
        walkOuterSq,
      };
      const cx0 = Math.floor((Math.min(x0, x1) - walkOuter) / ROAD_HASH_M);
      const cx1 = Math.floor((Math.max(x0, x1) + walkOuter) / ROAD_HASH_M);
      const cz0 = Math.floor((Math.min(z0, z1) - walkOuter) / ROAD_HASH_M);
      const cz1 = Math.floor((Math.max(z0, z1) + walkOuter) / ROAD_HASH_M);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = (cx + 4096) * 8192 + (cz + 4096);
          let arr = roadSegHash.get(k);
          if (!arr) {
            arr = [];
            roadSegHash.set(k, arr);
          }
          arr.push(rec);
        }
      }
    }
  }

  // --- OSM Buildings & Town Streets (grouped into 1000m cells, time-sliced) ---
  const { x: bvPlantX, z: bvPlantZ } = lonLatToWorld(BRIDAL_VEIL_PLANT.lon, BRIDAL_VEIL_PLANT.lat);

  const seenBuildings = new Set();
  const bldgCells = new Map();
  const buildQueue = []; // items: { type: 'bldg'|'street', data }
  let buildTaskScheduled = false;
  let cancelBuildTask = null;

  function getOrCreateCell(sx, sz, fallbackY) {
    const key = `${Math.floor(sx / BLDG_CELL_M)}_${Math.floor(sz / BLDG_CELL_M)}`;
    let cell = bldgCells.get(key);
    if (!cell) {
      const cx = (Math.floor(sx / BLDG_CELL_M) + 0.5) * BLDG_CELL_M;
      const cz = (Math.floor(sz / BLDG_CELL_M) + 0.5) * BLDG_CELL_M;
      cell = {
        key,
        cx,
        cz,
        entries: [],
        parts: [],
        mesh: null,
        dirty: false,
        streetEntries: [],
        streetParts: [],
        streetMesh: null,
        streetDirty: false,
        resnapping: false,
        probes: [{ x: sx, z: sz, y: sampleElev(terrain, sx, sz, fallbackY), fb: fallbackY }],
      };
      bldgCells.set(key, cell);
    } else if (cell.probes.length < 5) {
      // Spread up to 5 probe points >= 140m apart across the 1000m cell for rock-solid DEM refinement detection
      let farEnough = true;
      for (let i = 0; i < cell.probes.length; i++) {
        if (Math.hypot(sx - cell.probes[i].x, sz - cell.probes[i].z) < 140) {
          farEnough = false;
          break;
        }
      }
      if (farEnough) {
        cell.probes.push({ x: sx, z: sz, y: sampleElev(terrain, sx, sz, fallbackY), fb: fallbackY });
      }
    }
    return cell;
  }

  function flushDirtyCells(maxOps = Infinity) {
    if (disposed) return false;
    let ops = 0;
    let hasMore = false;
    for (const cell of bldgCells.values()) {
      if (cell.dirty) {
        if (ops >= maxOps) {
          hasMore = true;
          break;
        }
        cell.dirty = false;
        const activeParts = [];
        for (let i = 0; i < cell.entries.length; i++) {
          if (cell.entries[i].isFallbackPlant && hasRealBridalVeilBldg) continue;
          if (cell.parts[i]) activeParts.push(cell.parts[i]);
        }
        if (activeParts.length > 0) {
          const merged = mergePartBuffers(activeParts);
          if (cell.mesh) {
            disposables.delete(cell.mesh.geometry);
            cell.mesh.geometry.dispose();
            cell.mesh.geometry = merged;
          } else {
            const mesh = new THREE.Mesh(merged, buildingMat);
            mesh.castShadow = Boolean(engine.quality.shadows);
            mesh.receiveShadow = true;
            root.add(mesh);
            cell.mesh = mesh;
          }
          disposables.add(merged);
          ops++;
        }
      }

      if (cell.streetDirty) {
        if (ops >= maxOps) {
          hasMore = true;
          break;
        }
        cell.streetDirty = false;
        const activeStreets = [];
        for (let i = 0; i < cell.streetParts.length; i++) {
          if (cell.streetParts[i]) activeStreets.push(cell.streetParts[i]);
        }
        if (activeStreets.length > 0) {
          const merged = mergePartBuffers(activeStreets);
          if (cell.streetMesh) {
            disposables.delete(cell.streetMesh.geometry);
            cell.streetMesh.geometry.dispose();
            cell.streetMesh.geometry = merged;
          } else {
            const smesh = new THREE.Mesh(merged, townStreetMat);
            smesh.castShadow = false;
            smesh.receiveShadow = true;
            root.add(smesh);
            cell.streetMesh = smesh;
          }
          disposables.add(merged);
          ops++;
        }
      }
    }
    return hasMore;
  }

  let buildQueueHead = 0;
  let buildQueueNeedsSort = false;
  let lastSortCamX = 1e9;
  let lastSortCamZ = 1e9;
  let immediateNearFlushed = false;
  let sinceLastFlush = 0;
  let lastFlushMs = 0;

  function compactBuildQueue() {
    if (buildQueueHead === 0) return;
    if (buildQueueHead >= buildQueue.length) {
      buildQueue.length = 0;
      buildQueueHead = 0;
    } else {
      buildQueue.splice(0, buildQueueHead);
      buildQueueHead = 0;
    }
  }

  function sortBuildQueueNearCamera() {
    compactBuildQueue();
    const camX = engine.camera?.position?.x ?? 0;
    const camZ = engine.camera?.position?.z ?? 0;
    for (let i = 0; i < buildQueue.length; i++) {
      const c = buildQueue[i].data.coords;
      const dx = (c?.[0] || 0) - camX;
      const dz = (c?.[2] || 0) - camZ;
      buildQueue[i].d2 = dx * dx + dz * dz;
    }
    buildQueue.sort((a, b) => a.d2 - b.d2);
    buildQueueNeedsSort = false;
    lastSortCamX = camX;
    lastSortCamZ = camZ;
    immediateNearFlushed = false;
  }

  function scheduleBuildWorker() {
    buildQueueNeedsSort = true;
    if (buildTaskScheduled || buildQueueHead >= buildQueue.length) return;
    buildTaskScheduled = true;
    if (scheduler?.enqueue) {
      cancelBuildTask = scheduler.enqueue(processBuildSlice, { priority: 6, label: 'world:towns' });
    } else {
      while (processBuildSlice()) { /* sync fallback */ }
    }
  }

  function processBuildSlice() {
    if (disposed) return false;
    const camX = engine.camera?.position?.x ?? 0;
    const camZ = engine.camera?.position?.z ?? 0;
    if (buildQueueHead < buildQueue.length && (buildQueueNeedsSort || Math.hypot(camX - lastSortCamX, camZ - lastSortCamZ) > 350)) {
      sortBuildQueueNearCamera();
    }
    const start = performance.now();
    let count = 0;
    while (buildQueueHead < buildQueue.length && count < 28 && performance.now() - start < 2.2) {
      const job = buildQueue[buildQueueHead++];
      count++;
      if (job.type === 'bldg') {
        const b = job.data;
        const coords = b.coords;
        const sx = coords[0];
        const sz = coords[2];
        const isFallbackPlant = Boolean(b.isFallbackPlant);

        if (!isFallbackPlant && Math.hypot(sx - bvPlantX, sz - bvPlantZ) < 42) {
          hasRealBridalVeilBldg = true;
          const bvKey = `${Math.floor(bvPlantX / BLDG_CELL_M)}_${Math.floor(bvPlantZ / BLDG_CELL_M)}`;
          const bvCell = bldgCells.get(bvKey);
          if (bvCell) bvCell.dirty = true;
        }

        const fallbackY = b.baseY ?? coords[1] ?? 2667;
        const part = buildBuildingPart(b, terrain, trailData, nearestMainStreet);
        if (!part) continue;

        const cell = getOrCreateCell(sx, sz, fallbackY);
        cell.entries.push({ b, partIdx: cell.parts.length, fallbackY, isFallbackPlant });
        cell.parts.push(part);
        cell.dirty = true;
      } else if (job.type === 'street') {
        const road = job.data;
        const sx = road.coords[0];
        const fallbackY = road.coords[1] ?? 2667;
        const sz = road.coords[2];
        const part = buildTownStreetPart(road, terrain, isInsideCrossStreet);
        if (!part) continue;

        const cell = getOrCreateCell(sx, sz, fallbackY);
        cell.streetEntries.push({ road, partIdx: cell.streetParts.length, fallbackY });
        cell.streetParts.push(part);
        cell.streetDirty = true;
      }
    }
    if (buildQueueHead >= 256 || buildQueueHead >= buildQueue.length) {
      compactBuildQueue();
    }
    sinceLastFlush += count;
    const now = performance.now();

    if (buildQueueHead >= buildQueue.length) {
      const moreDirty = flushDirtyCells(1);
      sinceLastFlush = 0;
      lastFlushMs = now;
      if (moreDirty) return true;
      buildTaskScheduled = false;
      return false;
    }
    if (!immediateNearFlushed && sinceLastFlush >= 28) {
      immediateNearFlushed = true;
      sinceLastFlush = 0;
      lastFlushMs = now;
      flushDirtyCells(1);
    } else if (sinceLastFlush >= 140 && now - lastFlushMs >= 450) {
      sinceLastFlush = 0;
      lastFlushMs = now;
      flushDirtyCells(1);
    }
    return true;
  }

  function enqueueBuildings(list) {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const id = b.id || `${Math.round(b.coords?.[0] || 0)}_${Math.round(b.coords?.[2] || 0)}`;
      if (seenBuildings.has(id)) continue;
      seenBuildings.add(id);
      if (!b.coords || b.coords.length < 9) continue;

      let minX, minZ, maxX, maxZ;
      if (b.bbox && b.bbox.length === 4) {
        minX = b.bbox[0];
        minZ = b.bbox[1];
        maxX = b.bbox[2];
        maxZ = b.bbox[3];
      } else {
        minX = Infinity; minZ = Infinity; maxX = -Infinity; maxZ = -Infinity;
        for (let k = 0; k < b.coords.length; k += 3) {
          const x = b.coords[k], z = b.coords[k + 2];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
      }
      indexBuildingBbox(minX, minZ, maxX, maxZ);
      indexBuildingCollider(b.coords, minX, minZ, maxX, maxZ, Boolean(b.isFallbackPlant));

      buildQueue.push({ type: 'bldg', data: b });
    }
    // Re-evaluate any roads that arrived before building bboxes were indexed
    if (pendingTownRoads.length > 0) {
      const retry = pendingTownRoads.splice(0, pendingTownRoads.length);
      enqueueTownRoads(retry);
    }
    scheduleBuildWorker();
  }

  function enqueueTownRoads(trailsList) {
    const accepted = [];
    for (let i = 0; i < trailsList.length; i++) {
      const t = trailsList[i];
      if (!t || t.kind !== 'road' || !t.coords || t.coords.length < 6) continue;
      const id = t.id || `rd_${Math.round(t.coords[0])}_${Math.round(t.coords[2])}`;
      if (seenRoads.has(id)) continue;

      // Check if start, midpoint, or end of road is inside a town street zone (near buildings or downtown corridor)
      const n = Math.floor(t.coords.length / 3);
      const midIdx = Math.floor(n / 2) * 3;
      const endIdx = (n - 1) * 3;
      const inTown =
        worldBuildingMask.isInTownCorridor(t.coords[midIdx], t.coords[midIdx + 2]) ||
        worldBuildingMask.isNearBuilding(t.coords[midIdx], t.coords[midIdx + 2], 32) ||
        worldBuildingMask.isNearBuilding(t.coords[0], t.coords[2], 26) ||
        worldBuildingMask.isNearBuilding(t.coords[endIdx], t.coords[endIdx + 2], 26);

      if (!inTown) {
        // Hold briefly in case buildings in the same chunk haven't been indexed yet
        if (pendingTownRoads.length < 600) pendingTownRoads.push(t);
        continue;
      }

      seenRoads.add(id);
      indexRoadSegments(t);
      accepted.push(t);
    }
    // Push street build jobs AFTER all new road segments in this batch are indexed so intersections curb-cut cleanly
    for (let i = 0; i < accepted.length; i++) {
      buildQueue.push({ type: 'street', data: accepted[i] });
    }
    if (accepted.length > 0) scheduleBuildWorker();
  }

  // --- Aerialway Registry & Packing ---
  const seenAerialways = new Set();
  const _mat = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3(1, 1, 1);
  const _yAxis = new THREE.Vector3(0, 1, 0);

  function rebuildAerialwayBuffers() {
    if (disposed) return;
    let pylonIdx = 0;
    const cablePositions = [];

    for (const lift of animatedLifts) {
      const { pylonPts } = lift;
      for (let i = 0; i < pylonPts.length && pylonIdx < MAX_PYLONS; i++) {
        const p = pylonPts[i];
        const next = pylonPts[Math.min(pylonPts.length - 1, i + 1)];
        const prev = pylonPts[Math.max(0, i - 1)];
        const yaw = Math.atan2(next.x - prev.x, next.z - prev.z);
        _pos.set(p.x, p.y, p.z);
        _quat.setFromAxisAngle(_yAxis, yaw);
        _mat.compose(_pos, _quat, _scale);
        pylonMesh.setMatrixAt(pylonIdx++, _mat);
      }

      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < pylonPts.length - 1; i++) {
          const a = pylonPts[i];
          const b = pylonPts[i + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const len = Math.max(0.001, Math.hypot(dx, dz));
          const rx = (-dz / len) * 2.1 * side;
          const rz = (dx / len) * 2.1 * side;
          const sag = Math.min(3.5, len * 0.022);
          const segs = 4;
          for (let s = 0; s < segs; s++) {
            const t0 = s / segs;
            const t1 = (s + 1) / segs;
            const sag0 = 4 * sag * t0 * (1 - t0);
            const sag1 = 4 * sag * t1 * (1 - t1);
            cablePositions.push(
              THREE.MathUtils.lerp(a.x, b.x, t0) + rx,
              THREE.MathUtils.lerp(a.y, b.y, t0) - sag0,
              THREE.MathUtils.lerp(a.z, b.z, t0) + rz,
              THREE.MathUtils.lerp(a.x, b.x, t1) + rx,
              THREE.MathUtils.lerp(a.y, b.y, t1) - sag1,
              THREE.MathUtils.lerp(a.z, b.z, t1) + rz
            );
          }
        }
      }
    }

    pylonMesh.count = pylonIdx;
    pylonMesh.instanceMatrix.needsUpdate = true;

    const nextCableGeo = new THREE.BufferGeometry();
    nextCableGeo.setAttribute('position', new THREE.Float32BufferAttribute(cablePositions, 3));
    disposables.delete(cableGeo);
    cableGeo.dispose();
    cableGeo = nextCableGeo;
    disposables.add(cableGeo);
    cableLines.geometry = cableGeo;
  }

  function registerAerialway(aw, isFallback = false) {
    const id = aw.id || aw.name || `aw_${seenAerialways.size}`;
    if (seenAerialways.has(id)) return false;
    seenAerialways.add(id);

    const coords = aw.coords;
    if (!coords || coords.length < 6) return false;

    const n = Math.floor(coords.length / 3);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3];
      const fallbackY = coords[i * 3 + 1];
      const z = coords[i * 3 + 2];
      const y = sampleElev(terrain, x, z, fallbackY) + 11.5;
      pts.push(new THREE.Vector3(x, y, z));
    }

    const pylonPts = [];
    if (aw.pylons && aw.pylons.length >= 2) {
      for (const p of aw.pylons) {
        const y = sampleElev(terrain, p.x, p.z, p.y) + 11.5;
        pylonPts.push(new THREE.Vector3(p.x, y, p.z));
      }
    } else {
      let acc = 0;
      pylonPts.push(pts[0].clone());
      for (let i = 1; i < pts.length; i++) {
        acc += pts[i].distanceTo(pts[i - 1]);
        if (acc >= 105 || i === pts.length - 1) {
          pylonPts.push(pts[i].clone());
          acc = 0;
        }
      }
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const cum = [0];
    for (let i = 0; i < pylonPts.length; i++) {
      const p = pylonPts[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      if (i > 0) cum.push(cum[i - 1] + p.distanceTo(pylonPts[i - 1]));
    }
    const totalLen = cum[cum.length - 1];
    if (totalLen < 20) return false;

    const isGondola =
      aw.kind === 'gondola' || aw.kind === 'cable_car' || (aw.name || '').toLowerCase().includes('gondola');
    const spacing = isGondola ? 90 : 75;
    const capPerLift = isGondola ? 24 : 14;
    const countPerSide = Math.min(capPerLift, Math.max(2, Math.floor(totalLen / spacing)));
    const speed = isGondola ? 5.0 : 3.2;

    const cabins = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < countPerSide; i++) {
        cabins.push({
          dist: (i / countPerSide) * totalLen,
          side,
          dir: side,
          speed,
        });
      }
    }

    animatedLifts.push({ id, isFallback, isGondola, pylonPts, cum, totalLen, minX, maxX, minZ, maxZ, cabins });
    return true;
  }

  function buildLandmarks() {
    const bvy = sampleElev(terrain, bvPlantX, bvPlantZ, 3120);
    const hw = 6.5, hd = 4.5;
    enqueueBuildings([{
      id: 'landmark_bridal_veil_plant',
      name: 'Bridal Veil Powerhouse',
      kind: 'industrial',
      isFallbackPlant: true,
      baseY: bvy,
      heightM: 7.5,
      bbox: [bvPlantX - hw, bvPlantZ - hd, bvPlantX + hw, bvPlantZ + hd],
      coords: new Float32Array([
        bvPlantX - hw, bvy, bvPlantZ - hd,
        bvPlantX + hw, bvy, bvPlantZ - hd,
        bvPlantX + hw, bvy, bvPlantZ + hd,
        bvPlantX - hw, bvy, bvPlantZ + hd,
      ]),
    }]);

    const ruinParts = [];
    for (let i = 0; i < MINING_RUINS.length; i++) {
      const m = MINING_RUINS[i];
      const { x, z } = lonLatToWorld(m.lon, m.lat);
      const near = trailData?.nearest?.(x, z, 10);
      const ox = near && near.dist < 6 ? x + 9 : x;
      const oz = near && near.dist < 6 ? z + 7 : z;
      const baseY = sampleElev(terrain, ox, oz, m.fallbackY);
      const rng = mulberry32(hash2i(Math.round(ox), Math.round(oz), 99));
      const yaw = rng() * Math.PI * 2;

      const sub = mergeColoredBoxes([
        colorizeBox(4.2, 3.4, 3.2, 0, 1.5, 0, 0.38, 0.30, 0.23, 0, 0, 0.04),
        colorizeBox(4.8, 0.2, 3.8, 0, 3.3, 0, 0.45, 0.29, 0.22, 0.25, 0, 0),
        colorizeBox(0.32, 6.2, 0.32, -1.5, 3.0, 2.2, 0.36, 0.28, 0.21, -0.22, 0, 0),
        colorizeBox(0.32, 6.2, 0.32, 1.5, 3.0, 2.2, 0.36, 0.28, 0.21, -0.22, 0, 0),
      ]);
      sub.rotateY(yaw);
      sub.translate(ox, baseY, oz);
      ruinParts.push(sub);

      // Register rotated mining-ruin footprint (4.4m x 3.8m cabin + headframe base) in bldgColliderGrid
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const rx0 = -2.2, rz0 = -1.7;
      const rx1 = 2.2, rz1 = 2.4;
      const rCoords = new Float32Array(12);
      const corners = [
        [rx0, rz0],
        [rx1, rz0],
        [rx1, rz1],
        [rx0, rz1],
      ];
      let rMinX = Infinity, rMinZ = Infinity, rMaxX = -Infinity, rMaxZ = -Infinity;
      for (let c = 0; c < 4; c++) {
        const lx = corners[c][0];
        const lz = corners[c][1];
        // Three.js rotateY(yaw): x' = x*cos + z*sin, z' = -x*sin + z*cos
        const wx = ox + lx * cosY + lz * sinY;
        const wz = oz - lx * sinY + lz * cosY;
        rCoords[c * 3] = wx;
        rCoords[c * 3 + 1] = baseY;
        rCoords[c * 3 + 2] = wz;
        if (wx < rMinX) rMinX = wx;
        if (wx > rMaxX) rMaxX = wx;
        if (wz < rMinZ) rMinZ = wz;
        if (wz > rMaxZ) rMaxZ = wz;
      }
      indexBuildingBbox(rMinX, rMinZ, rMaxX, rMaxZ);
      indexBuildingCollider(rCoords, rMinX, rMinZ, rMaxX, rMaxZ, false);
    }
    const ruinsGeo = mergeColoredBoxes(ruinParts);
    disposables.add(ruinsGeo);
    const ruinsMesh = new THREE.Mesh(ruinsGeo, vertexColMat);
    ruinsMesh.castShadow = Boolean(engine.quality.shadows);
    ruinsMesh.receiveShadow = true;
    root.add(ruinsMesh);
  }

  // Index initial Main Streets & buildings first so Main Street classification and road filter work immediately
  if (trailData?.trails?.length) {
    indexMainStreets(trailData.trails);
  }
  if (trailData?.buildings?.length) {
    enqueueBuildings(trailData.buildings);
  }
  if (trailData?.trails?.length) {
    enqueueTownRoads(trailData.trails);
  }
  if (trailData?.aerialways?.length) {
    let changed = false;
    for (const aw of trailData.aerialways) {
      if (registerAerialway(aw, false)) changed = true;
    }
    if (changed) rebuildAerialwayBuffers();
  } else {
    const p1 = lonLatToWorld(-107.8130, 37.9354);
    const p2 = lonLatToWorld(-107.8268, 37.9261);
    const p3 = lonLatToWorld(-107.8473, 37.9328);
    if (registerAerialway({
      id: 'fallback_telluride_gondola',
      name: 'Telluride Gondola',
      kind: 'gondola',
      coords: new Float32Array([p1.x, 2670, p1.z, p2.x, 3212, p2.z, p3.x, 2908, p3.z]),
    }, true)) {
      rebuildAerialwayBuffers();
    }
  }
  buildLandmarks();

  const unsubChunk = events.on('data:chunk', (payload) => {
    if (disposed) return;
    const addedTrails = payload?.added?.trails ?? trailData?.trails;
    if (addedTrails?.length) {
      indexMainStreets(addedTrails);
    }
    const addedBldgs = payload?.added?.buildings ?? trailData?.buildings;
    if (addedBldgs?.length) {
      enqueueBuildings(addedBldgs);
    }
    if (addedTrails?.length) {
      enqueueTownRoads(addedTrails);
    }
    const addedAw = payload?.added?.aerialways ?? trailData?.aerialways;
    if (addedAw?.length) {
      let changed = false;
      for (let i = animatedLifts.length - 1; i >= 0; i--) {
        if (animatedLifts[i].isFallback) {
          animatedLifts.splice(i, 1);
          changed = true;
        }
      }
      for (const aw of addedAw) {
        if (registerAerialway(aw, false)) changed = true;
      }
      if (changed) rebuildAerialwayBuffers();
    }
  });

  let lastShadows = Boolean(engine.quality.shadows);
  let lastNormals = engine.quality.tier !== 'low';
  const unsubQuality = events.on('quality:changed', () => {
    const cast = Boolean(engine.quality.shadows);
    if (cast !== lastShadows) {
      lastShadows = cast;
      for (const cell of bldgCells.values()) {
        if (cell.mesh) cell.mesh.castShadow = cast;
      }
    }
    const useNrm = engine.quality.tier !== 'low';
    if (useNrm !== lastNormals) {
      lastNormals = useNrm;
      buildingMat.normalMap = useNrm ? textures.buildingNormal : null;
      buildingMat.needsUpdate = true;
      townStreetMat.normalMap = useNrm ? textures.buildingNormal : null;
      townStreetMat.needsUpdate = true;
    }
  });

  let cellCheckCursor = 0;
  let cellCheckTimer = 0;

  function triggerCellResnap(cell) {
    cell.resnapping = true;
    let bIdx = 0;
    let sIdx = 0;
    let cancelHandle = null;
    cancelHandle = scheduler?.enqueue?.(() => {
      if (disposed) return false;
      const t0 = performance.now();
      while (bIdx < cell.entries.length && performance.now() - t0 < 2.0) {
        const e = cell.entries[bIdx++];
        const nextP = buildBuildingPart(e.b, terrain, trailData, nearestMainStreet);
        if (nextP) cell.parts[e.partIdx] = nextP;
      }
      while (bIdx >= cell.entries.length && sIdx < cell.streetEntries.length && performance.now() - t0 < 2.0) {
        const se = cell.streetEntries[sIdx++];
        const nextS = buildTownStreetPart(se.road, terrain, isInsideCrossStreet);
        if (nextS) cell.streetParts[se.partIdx] = nextS;
      }
      if (bIdx < cell.entries.length || sIdx < cell.streetEntries.length) return true;
      if (cell.entries.length > 0 && !cell.resnapFlushedBldg) {
        cell.resnapFlushedBldg = true;
        cell.dirty = true;
        flushDirtyCells(1);
        if (cell.streetEntries.length > 0) return true;
      }
      if (cell.streetEntries.length > 0) {
        cell.streetDirty = true;
        flushDirtyCells(1);
      }
      cell.resnapFlushedBldg = false;
      cell.resnapping = false;
      if (cancelHandle) resnapCancels.delete(cancelHandle);
      return false;
    }, { priority: 15, label: 'world:resnapTownCell' });
    if (cancelHandle) resnapCancels.add(cancelHandle);
  }

  function update(dt, playerPos) {
    if (disposed) return;
    cableMat.color.copy(atmosphere.uniforms.uSkyAmbientColor.value).multiplyScalar(0.32);

    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;

    // Fast 5-point DEM refinement resnap check (prioritizes cells within 2.5 km of player!)
    cellCheckTimer += dt;
    if (cellCheckTimer > 0.35 && bldgCells.size > 0 && !buildTaskScheduled) {
      cellCheckTimer = 0;
      const nCells = bldgCells.size;
      let checked = 0;
      for (const c of bldgCells.values()) {
        if (c.resnapping || (!c.mesh && !c.streetMesh)) continue;
        const nearPlayer = Math.hypot(px - c.cx, pz - c.cz) < 2500;
        if (!nearPlayer && ((checked + cellCheckCursor) % 4 !== 0)) {
          checked++;
          continue;
        }
        checked++;
        let moved = false;
        for (let p = 0; p < c.probes.length; p++) {
          const pr = c.probes[p];
          const curY = sampleElev(terrain, pr.x, pr.z, pr.fb);
          if (Math.abs(curY - pr.y) > 0.25) {
            pr.y = curY;
            moved = true;
          }
        }
        if (moved) {
          triggerCellResnap(c);
          break; // one cell resnap scheduled per tick keeps frame times silky smooth
        }
      }
      cellCheckCursor = (cellCheckCursor + 1) | 0;
    }

    let gondIdx = 0;
    let chairIdx = 0;
    const cullPad = 2800;

    for (let l = 0; l < animatedLifts.length; l++) {
      const lift = animatedLifts[l];
      if (
        px < lift.minX - cullPad || px > lift.maxX + cullPad ||
        pz < lift.minZ - cullPad || pz > lift.maxZ + cullPad
      ) {
        continue;
      }

      const { pylonPts, cum, totalLen, cabins, isGondola } = lift;
      const targetMesh = isGondola ? gondolaCabinMesh : chairMesh;
      const maxCap = isGondola ? MAX_GONDOLA_CABINS : MAX_LIFT_CHAIRS;

      for (let i = 0; i < cabins.length; i++) {
        const curIdx = isGondola ? gondIdx : chairIdx;
        if (curIdx >= maxCap) break;

        const c = cabins[i];
        c.dist += c.dir * c.speed * dt;
        if (c.dist > totalLen) c.dist -= totalLen;
        if (c.dist < 0) c.dist += totalLen;

        let seg = 0;
        while (seg < cum.length - 2 && cum[seg + 1] < c.dist) seg++;
        const segLen = Math.max(0.001, cum[seg + 1] - cum[seg]);
        const t = (c.dist - cum[seg]) / segLen;
        const a = pylonPts[seg];
        const b = pylonPts[seg + 1];

        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const hLen = Math.max(0.001, Math.hypot(dx, dz));
        const rx = (-dz / hLen) * 2.1 * c.side;
        const rz = (dx / hLen) * 2.1 * c.side;
        const sag = Math.min(3.5, hLen * 0.022) * 4 * t * (1 - t);

        _pos.set(
          THREE.MathUtils.lerp(a.x, b.x, t) + rx,
          THREE.MathUtils.lerp(a.y, b.y, t) - sag,
          THREE.MathUtils.lerp(a.z, b.z, t) + rz
        );
        _quat.setFromAxisAngle(_yAxis, Math.atan2(dx * c.dir, dz * c.dir));
        _mat.compose(_pos, _quat, _scale);
        targetMesh.setMatrixAt(curIdx, _mat);

        if (isGondola) gondIdx++;
        else chairIdx++;
      }
    }

    if (gondolaCabinMesh.count !== gondIdx || gondIdx > 0) {
      gondolaCabinMesh.count = gondIdx;
      gondolaCabinMesh.instanceMatrix.needsUpdate = true;
    }
    if (chairMesh.count !== chairIdx || chairIdx > 0) {
      chairMesh.count = chairIdx;
      chairMesh.instanceMatrix.needsUpdate = true;
    }
  }

  function dispose() {
    disposed = true;
    unsubChunk();
    unsubQuality();
    if (cancelBuildTask) cancelBuildTask();
    for (const c of resnapCancels) c();
    resnapCancels.clear();
    scene.remove(root);
    pylonMesh.dispose();
    gondolaCabinMesh.dispose();
    chairMesh.dispose();
    for (const g of disposables) g.dispose();
    disposables.clear();
    buildingMat.dispose();
    townStreetMat.dispose();
    vertexColMat.dispose();
    cableMat.dispose();
    bldgCells.clear();
    maskGrid.clear();
    bldgColliderGrid.clear();
    roadSegHash.clear();
    if (engine.worldBuildingMask === worldBuildingMask) {
      delete engine.worldBuildingMask;
    }
  }

  return { update, dispose };
}
