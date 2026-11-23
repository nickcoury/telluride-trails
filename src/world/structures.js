import * as THREE from 'three';
import { lonLatToWorld } from '../core/geo.js';
import { hash2i, mulberry32 } from './noise.js';
import { patchSanJuanMaterial } from './materialFog.js';

const BLDG_CELL_M = 1000;
const MASK_CELL_M = 64;
const MAX_PYLONS = 900;
const MAX_GONDOLA_CABINS = 120;
const MAX_LIFT_CHAIRS = 360;

// Atlas UV layout: 4 cols x 2 rows
// Row 0 (top, v=0.5..1.0): 0=brick, 1=ochre, 2=sage, 3=MountainVillage stone
// Row 1 (bot, v=0.0..0.5): 4=slate, 5=stone plinth, 6=cedar roof, 7=standing-seam roof
function getAtlasRect(idx) {
  const col = idx % 4;
  const row = Math.floor(idx / 4);
  const u0 = col * 0.25 + 0.005;
  const u1 = (col + 1) * 0.25 - 0.005;
  const v0 = row === 0 ? 0.505 : 0.005;
  const v1 = row === 0 ? 0.995 : 0.495;
  return [u0, v0, u1, v1];
}

function mergeBuildingParts(parts) {
  let totalVerts = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) totalVerts += parts[i].pos.length / 3;
  }
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  let off = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const c = p.pos.length / 3;
    pos.set(p.pos, off * 3);
    norm.set(p.norm, off * 3);
    uv.set(p.uv, off * 2);
    off += c;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
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
 * Build compact typed-array geometry data { pos, norm, uv } for one extruded building:
 * - Outward-facing wall normals
 * - Windowless stone foundation plinth below groundY (no half-buried hillside windows!)
 * - ~7.5m horizontal wall bay segmentation so Victorian sash windows keep natural proportions
 */
function buildBuildingPart(coords, terrain, fallbackY, heightM, styleIdx, roofIdx) {
  const nPts = Math.floor(coords.length / 3);
  if (nPts < 3) return null;

  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const x = coords[i * 3];
    const z = coords[i * 3 + 2];
    if (i === nPts - 1 && Math.hypot(x - coords[0], z - coords[2]) < 0.1) break;
    pts.push({ x, z });
  }
  if (pts.length < 3) return null;

  let signedArea = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    signedArea += a.x * b.z - b.x * a.z;
  }
  if (signedArea > 0) pts.reverse();

  let cx = 0, cz = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
    const cy = sampleElev(terrain, p.x, p.z, fallbackY);
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  cx /= pts.length;
  cz /= pts.length;
  const centerY = sampleElev(terrain, cx, cz, fallbackY);
  if (centerY < minY) minY = centerY;
  if (centerY > maxY) maxY = centerY;

  const [wu0, wv0, wu1, wv1] = getAtlasRect(styleIdx);
  const [pu0, pv0, pu1, pv1] = getAtlasRect(5); // Stone plinth for foundation skirt
  const [ru0, rv0, ru1, rv1] = getAtlasRect(roofIdx);

  const pos = [];
  const norm = [];
  const uv = [];

  const foundationY = minY - 3.5;
  const groundY = Math.min(maxY, centerY + 1.2);
  const eaveY = groundY + heightM;

  // Vertical UV slice if single-story (< 4.8m) so windows don't squish vertically
  const wallV0 = heightM < 4.8 ? wv0 + (wv1 - wv0) * 0.46 : wv0;

  const pushTri = (ax, ay, az, bx, by, bz, cxp, cyp, czp, u0, v0, u1, v1, u2, v2) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxp - ax, vy = cyp - ay, vz = czp - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    pos.push(ax, ay, az, bx, by, bz, cxp, cyp, czp);
    norm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    uv.push(u0, v0, u1, v1, u2, v2);
  };

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const wallLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (wallLen < 0.2) continue;

    // 1) Solid stone foundation plinth from foundationY to groundY (no buried windows!)
    pushTri(a.x, foundationY, a.z, b.x, foundationY, b.z, b.x, groundY, b.z, pu0, pv0, pu1, pv0, pu1, pv1);
    pushTri(a.x, foundationY, a.z, b.x, groundY, b.z, a.x, groundY, a.z, pu0, pv0, pu1, pv1, pu0, pv1);

    // 2) Subdivide upper wall into ~8m architectural bays so sash windows stay well-proportioned
    const bays = Math.max(1, Math.min(6, Math.round(wallLen / 8.0)));
    for (let k = 0; k < bays; k++) {
      const t0 = k / bays;
      const t1 = (k + 1) / bays;
      const x0 = a.x + (b.x - a.x) * t0;
      const z0 = a.z + (b.z - a.z) * t0;
      const x1 = a.x + (b.x - a.x) * t1;
      const z1 = a.z + (b.z - a.z) * t1;
      pushTri(x0, groundY, z0, x1, groundY, z1, x1, eaveY, z1, wu0, wallV0, wu1, wallV0, wu1, wv1);
      pushTri(x0, groundY, z0, x1, eaveY, z1, x0, eaveY, z0, wu0, wallV0, wu1, wv1, wu0, wv1);
    }
  }

  const ridgeH = Math.min(3.2, Math.max(0.85, heightM * 0.28));
  const peakY = eaveY + ridgeH;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    pushTri(a.x, eaveY, a.z, b.x, eaveY, b.z, cx, peakY, cz, ru0, rv0, ru1, rv0, (ru0 + ru1) * 0.5, rv1);
  }

  return {
    pos: new Float32Array(pos),
    norm: new Float32Array(norm),
    uv: new Float32Array(uv),
  };
}

const BRIDAL_VEIL_PLANT = { lon: -107.7689, lat: 37.9214 };
const MINING_RUINS = [
  { name: 'Tomboy Mine Ruins', lon: -107.7524, lat: 37.9348, fallbackY: 3505 },
  { name: 'Governor Basin Mill', lon: -107.7615, lat: 37.9685, fallbackY: 3560 },
  { name: 'Animas Forks Ruins', lon: -107.5712, lat: 37.9311, fallbackY: 3415 },
];

// Curated historic downtown street corridors so even before vector chunks load, Main Streets have zero wild boulders/spruces
const HISTORIC_DOWNTOWN_CORRIDORS = [
  { lon0: -107.8195, lat0: 37.9355, lon1: -107.8045, lat1: 37.9395 }, // Telluride W/E Colorado Ave
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

  // --- Fast O(1) Spatial Building & Town-Street Mask shared with vegetation/rocks ---
  const maskGrid = new Map(); // key -> Float32Array|[minX,minZ,maxX,maxZ,...]
  const townCorridors = HISTORIC_DOWNTOWN_CORRIDORS.map((c) => {
    const a = lonLatToWorld(c.lon0, c.lat0);
    const b = lonLatToWorld(c.lon1, c.lat1);
    return [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)];
  });

  function indexBuildingBbox(minX, minZ, maxX, maxZ) {
    const pad = 24;
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
  };
  engine.worldBuildingMask = worldBuildingMask;

  const buildingMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ map: textures.buildingAtlas, side: THREE.FrontSide }),
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

  // --- OSM Buildings (grouped into 1000m cells, compact typed-array parts, time-sliced) ---
  const { x: bvPlantX, z: bvPlantZ } = lonLatToWorld(BRIDAL_VEIL_PLANT.lon, BRIDAL_VEIL_PLANT.lat);
  let hasRealBridalVeilBldg = false;

  const seenBuildings = new Set();
  const bldgCells = new Map(); // cellKey -> { entries, parts, mesh, dirty, sampleX, sampleZ, sampleY, resnapping }
  const buildQueue = [];
  let buildTaskScheduled = false;
  let cancelBuildTask = null;

  function pickBuildingStyle(b) {
    const h = Math.abs(Math.round((b.bbox?.[0] || 0) * 13 + (b.bbox?.[1] || 0) * 31));
    const town = (b.town || '').toLowerCase();
    if (town.includes('mountain village')) {
      return { wall: h % 3 === 0 ? 3 : 2, roof: 7 };
    }
    if ((b.kind || '').includes('industrial') || (b.name || '').toLowerCase().includes('power')) {
      return { wall: 0, roof: 7 };
    }
    return { wall: h % 5, roof: h % 2 === 0 ? 6 : 7 };
  }

  function flushDirtyCells() {
    if (disposed) return;
    for (const cell of bldgCells.values()) {
      if (!cell.dirty) continue;
      cell.dirty = false;
      const activeParts = [];
      for (let i = 0; i < cell.entries.length; i++) {
        if (cell.entries[i].isFallbackPlant && hasRealBridalVeilBldg) continue;
        if (cell.parts[i]) activeParts.push(cell.parts[i]);
      }
      if (activeParts.length === 0) continue;

      const merged = mergeBuildingParts(activeParts);
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
    }
  }

  function processBuildingSlice() {
    if (disposed) return false;
    const start = performance.now();
    let count = 0;
    while (buildQueue.length > 0 && count < 28 && performance.now() - start < 2.2) {
      const b = buildQueue.shift();
      const coords = b.coords;
      const sx = coords[0];
      const sz = coords[2];
      const isFallbackPlant = Boolean(b.isFallbackPlant);

      if (!isFallbackPlant && Math.hypot(sx - bvPlantX, sz - bvPlantZ) < 42) {
        hasRealBridalVeilBldg = true;
        // Mark Bridal Veil cell dirty in case fallback plant was already built
        const bvKey = `${Math.floor(bvPlantX / BLDG_CELL_M)}_${Math.floor(bvPlantZ / BLDG_CELL_M)}`;
        const bvCell = bldgCells.get(bvKey);
        if (bvCell) bvCell.dirty = true;
      }

      const fallbackY = b.baseY ?? coords[1] ?? 2667;
      const heightM = b.heightM || (b.levels ? b.levels * 3.3 : 6.2);
      const { wall, roof } = pickBuildingStyle(b);
      const part = buildBuildingPart(coords, terrain, fallbackY, heightM, wall, roof);
      count++;
      if (!part) continue;

      const key = `${Math.floor(sx / BLDG_CELL_M)}_${Math.floor(sz / BLDG_CELL_M)}`;
      let cell = bldgCells.get(key);
      if (!cell) {
        cell = {
          key,
          entries: [],
          parts: [],
          mesh: null,
          dirty: false,
          resnapping: false,
          sampleX: sx,
          sampleZ: sz,
          sampleY: sampleElev(terrain, sx, sz, fallbackY),
        };
        bldgCells.set(key, cell);
      }
      cell.entries.push({ b, partIdx: cell.parts.length, fallbackY, heightM, wall, roof, isFallbackPlant });
      cell.parts.push(part);
      cell.dirty = true;
    }

    if (buildQueue.length === 0) {
      flushDirtyCells();
      buildTaskScheduled = false;
      return false;
    }
    if (count > 0 && buildQueue.length % 90 < 28) {
      flushDirtyCells();
    }
    return true;
  }

  function enqueueBuildings(list) {
    let pushed = 0;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const id = b.id || `${Math.round(b.coords?.[0] || 0)}_${Math.round(b.coords?.[2] || 0)}`;
      if (seenBuildings.has(id)) continue;
      seenBuildings.add(id);
      if (!b.coords || b.coords.length < 9) continue;

      // Index building bbox immediately for vegetation/rock street exclusion
      if (b.bbox && b.bbox.length === 4) {
        indexBuildingBbox(b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]);
      } else {
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (let k = 0; k < b.coords.length; k += 3) {
          const x = b.coords[k], z = b.coords[k + 2];
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
        }
        indexBuildingBbox(minX, minZ, maxX, maxZ);
      }

      buildQueue.push(b);
      pushed++;
    }
    if (pushed > 0 && !buildTaskScheduled) {
      buildTaskScheduled = true;
      if (scheduler?.enqueue) {
        cancelBuildTask = scheduler.enqueue(processBuildingSlice, { priority: 12, label: 'world:buildings' });
      } else {
        while (processBuildingSlice()) { /* sync fallback */ }
      }
    }
  }

  // --- Aerialway Registry & Packing ---
  const seenAerialways = new Set();
  const animatedLifts = [];
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
    }
    const ruinsGeo = mergeColoredBoxes(ruinParts);
    disposables.add(ruinsGeo);
    const ruinsMesh = new THREE.Mesh(ruinsGeo, vertexColMat);
    ruinsMesh.castShadow = Boolean(engine.quality.shadows);
    ruinsMesh.receiveShadow = true;
    root.add(ruinsMesh);
  }

  if (trailData?.buildings?.length) {
    enqueueBuildings(trailData.buildings);
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
    const addedBldgs = payload?.added?.buildings ?? trailData?.buildings;
    if (addedBldgs?.length) {
      enqueueBuildings(addedBldgs);
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
  const unsubQuality = events.on('quality:changed', () => {
    const cast = Boolean(engine.quality.shadows);
    if (cast === lastShadows) return;
    lastShadows = cast;
    for (const cell of bldgCells.values()) {
      if (cell.mesh) cell.mesh.castShadow = cast;
    }
  });

  let cellCheckCursor = 0;
  let cellCheckTimer = 0;

  function update(dt, playerPos) {
    if (disposed) return;
    cableMat.color.copy(atmosphere.uniforms.uSkyAmbientColor.value).multiplyScalar(0.32);

    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;

    cellCheckTimer += dt;
    if (cellCheckTimer > 1.0 && bldgCells.size > 0 && !buildTaskScheduled) {
      cellCheckTimer = 0;
      const targetIdx = cellCheckCursor % bldgCells.size;
      cellCheckCursor = (cellCheckCursor + 1) | 0;
      let i = 0;
      let cell = null;
      for (const c of bldgCells.values()) {
        if (i === targetIdx) {
          cell = c;
          break;
        }
        i++;
      }
      if (cell && cell.mesh && !cell.resnapping) {
        const curY = sampleElev(terrain, cell.sampleX, cell.sampleZ, cell.sampleY);
        if (Math.abs(curY - cell.sampleY) > 1.8) {
          cell.sampleY = curY;
          cell.resnapping = true;
          let idx = 0;
          let cancelHandle = null;
          cancelHandle = scheduler?.enqueue?.(() => {
            if (disposed) return false;
            const t0 = performance.now();
            while (idx < cell.entries.length && performance.now() - t0 < 2.0) {
              const e = cell.entries[idx++];
              const nextP = buildBuildingPart(e.b.coords, terrain, e.fallbackY, e.heightM, e.wall, e.roof);
              if (nextP) cell.parts[e.partIdx] = nextP;
            }
            if (idx < cell.entries.length) return true;
            cell.resnapping = false;
            cell.dirty = true;
            if (cancelHandle) resnapCancels.delete(cancelHandle);
            flushDirtyCells();
            return false;
          }, { priority: 16, label: 'world:resnapBuildings' });
          if (cancelHandle) resnapCancels.add(cancelHandle);
        }
      }
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
    vertexColMat.dispose();
    cableMat.dispose();
    bldgCells.clear();
    maskGrid.clear();
    if (engine.worldBuildingMask === worldBuildingMask) {
      delete engine.worldBuildingMask;
    }
  }

  return { update, dispose };
}
