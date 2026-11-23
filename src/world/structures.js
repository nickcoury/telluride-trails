import * as THREE from 'three';
import { lonLatToWorld } from '../core/geo.js';
import { hash2i, mulberry32 } from './noise.js';
import { patchSanJuanMaterial } from './materialFog.js';

// Atlas UV layout: 4 cols x 2 rows
// Row 1 (top, v=0.5..1.0): 0=brick, 1=ochre, 2=sage, 3=MountainVillage stone
// Row 0 (bot, v=0.0..0.5): 4=slate, 5=rusted tin, 6=cedar roof, 7=standing-seam roof
function getAtlasRect(idx) {
  const col = idx % 4;
  const row = Math.floor(idx / 4); // 0 is top row in image -> v=[0.5,1]
  const u0 = col * 0.25 + 0.005;
  const u1 = (col + 1) * 0.25 - 0.005;
  const v0 = row === 0 ? 0.505 : 0.005;
  const v1 = row === 0 ? 0.995 : 0.495;
  return [u0, v0, u1, v1];
}

function mergeGeos(geos) {
  let totalVerts = 0;
  for (const g of geos) totalVerts += g.attributes.position.count;
  const pos = new Float32Array(totalVerts * 3);
  const norm = new Float32Array(totalVerts * 3);
  const uv = new Float32Array(totalVerts * 2);
  let off = 0;

  for (const g of geos) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    norm.set(g.attributes.normal.array, off * 3);
    uv.set(g.attributes.uv.array, off * 2);
    off += c;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/**
 * Build an extruded building BufferGeometry (walls + pitched/flat roof) with atlas UVs.
 */
function buildBuildingGeometry(coords, getCornerY, fallbackY, heightM, styleIdx, roofIdx) {
  const nPts = Math.floor(coords.length / 3);
  if (nPts < 3) return null;

  // Remove closing duplicate if closed ring
  const pts = [];
  for (let i = 0; i < nPts; i++) {
    const x = coords[i * 3];
    const z = coords[i * 3 + 2];
    if (i === nPts - 1 && Math.hypot(x - coords[0], z - coords[2]) < 0.1) break;
    pts.push({ x, z });
  }
  if (pts.length < 3) return null;

  // Canonical winding so wall normals (b - a) x (b_top - a) always point OUTWARD
  let signedArea = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    signedArea += a.x * b.z - b.x * a.z;
  }
  if (signedArea > 0) pts.reverse();

  // Compute centroid & min/max terrain elevation across all corners so hillside buildings never float
  let cx = 0, cz = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
    const cy = getCornerY(p.x, p.z, fallbackY);
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
  }
  cx /= pts.length;
  cz /= pts.length;
  const centerY = getCornerY(cx, cz, fallbackY);
  if (centerY < minY) minY = centerY;
  if (centerY > maxY) maxY = centerY;

  const [wu0, wv0, wu1, wv1] = getAtlasRect(styleIdx);
  const [ru0, rv0, ru1, rv1] = getAtlasRect(roofIdx);

  const pos = [];
  const norm = [];
  const uv = [];

  const foundationY = minY - 3.5;
  const eaveY = Math.max(minY + 2.2, centerY) + heightM;

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

  // Extrude walls
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const wallLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (wallLen < 0.2) continue;

    // Two triangles per wall face
    pushTri(a.x, foundationY, a.z, b.x, foundationY, b.z, b.x, eaveY, b.z, wu0, wv0, wu1, wv0, wu1, wv1);
    pushTri(a.x, foundationY, a.z, b.x, eaveY, b.z, a.x, eaveY, a.z, wu0, wv0, wu1, wv1, wu0, wv1);
  }

  // Pitched hip/pyramid roof peak at centroid for small/medium buildings, low hip for large ones
  const ridgeH = Math.min(3.4, Math.max(0.9, heightM * 0.32));
  const peakY = eaveY + ridgeH;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    pushTri(a.x, eaveY, a.z, b.x, eaveY, b.z, cx, peakY, cz, ru0, rv0, ru1, rv0, (ru0 + ru1) * 0.5, rv1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

// Historic San Juan landmarks (fallback/supplemental touches)
const BRIDAL_VEIL_PLANT = { lon: -107.7689, lat: 37.9214 };
const MINING_RUINS = [
  { name: 'Tomboy Mine Ruins', lon: -107.7524, lat: 37.9348 },
  { name: 'Governor Basin Mill', lon: -107.7615, lat: 37.9685 },
  { name: 'Animas Forks Ruins', lon: -107.5712, lat: 37.9311 },
];

export function createStructures(engine, terrain, trailData, atmosphere) {
  const { scene, events } = engine;
  const textures = engine.worldTextures;
  const root = new THREE.Group();
  root.name = 'SanJuanStructures';
  scene.add(root);

  const buildingMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ map: textures.buildingAtlas, side: THREE.FrontSide }),
    atmosphere.uniforms
  );
  const metalMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ color: 0x5d6770 }),
    atmosphere.uniforms
  );
  const cableMat = patchSanJuanMaterial(
    new THREE.LineBasicMaterial({ color: 0x22262b }),
    atmosphere.uniforms
  );
  const cabinBlueMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ color: 0x1e4d7a }),
    atmosphere.uniforms
  );
  const cabinGlassMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ color: 0x8fb4cc }),
    atmosphere.uniforms
  );
  const ruinWoodMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ color: 0x614e3d }),
    atmosphere.uniforms
  );
  const ruinTinMat = patchSanJuanMaterial(
    new THREE.MeshLambertMaterial({ color: 0x734b38 }),
    atmosphere.uniforms
  );

  const seenBuildings = new Set();
  const seenAerialways = new Set();
  const disposables = [];
  const animatedLifts = []; // { pts, totalLen, cabins: [{ group, dist, dir, speed }], isFallback, group }

  function pickBuildingStyle(b) {
    const h = Math.abs(Math.round((b.bbox?.[0] || 0) * 13 + (b.bbox?.[1] || 0) * 31));
    const town = (b.town || '').toLowerCase();
    if (town.includes('mountain village')) {
      return { wall: h % 3 === 0 ? 3 : 2, roof: 7 };
    }
    if ((b.kind || '').includes('industrial') || (b.name || '').toLowerCase().includes('power')) {
      return { wall: 0, roof: 7 };
    }
    const wall = h % 5; // brick, ochre, sage, stone, slate
    const roof = h % 2 === 0 ? 6 : 7;
    return { wall, roof };
  }

  const buildingBatches = []; // { items, mesh, sampleX, sampleZ, sampleY }

  function getCornerY(x, z, fallbackY) {
    const tY = terrain.getHeight(x, z);
    return Number.isFinite(tY) && tY > 100 ? tY : fallbackY;
  }

  function buildBatchGeometry(items) {
    const geos = [];
    for (const b of items) {
      const coords = b.coords;
      const fallbackY = b.baseY ?? coords[1] ?? 2667;
      const heightM = b.heightM || (b.levels ? b.levels * 3.3 : 6.2);
      const { wall, roof } = pickBuildingStyle(b);
      const g = buildBuildingGeometry(coords, getCornerY, fallbackY, heightM, wall, roof);
      if (g) geos.push(g);
    }
    return geos.length > 0 ? mergeGeos(geos) : null;
  }

  function processBuildingsBatch(list) {
    const added = [];
    for (const b of list) {
      const id = b.id || `${Math.round(b.coords?.[0] || 0)}_${Math.round(b.coords?.[2] || 0)}`;
      if (seenBuildings.has(id)) continue;
      seenBuildings.add(id);
      if (!b.coords || b.coords.length < 9) continue;
      added.push(b);
    }
    if (added.length === 0) return;

    const merged = buildBatchGeometry(added);
    if (merged) {
      const mesh = new THREE.Mesh(merged, buildingMat);
      mesh.castShadow = Boolean(engine.quality.shadows);
      mesh.receiveShadow = true;
      root.add(mesh);
      disposables.push(merged);
      const sx = added[0].coords[0];
      const sz = added[0].coords[2];
      buildingBatches.push({
        items: added,
        mesh,
        sampleX: sx,
        sampleZ: sz,
        sampleY: getCornerY(sx, sz, added[0].baseY ?? 2667),
      });
    }
  }

  // Reusable unit geometries for gondola cabins & lift towers
  const towerMastGeo = new THREE.BoxGeometry(0.75, 1, 0.75);
  const towerArmGeo = new THREE.BoxGeometry(5.6, 0.45, 0.55);
  const cabinBodyGeo = new THREE.BoxGeometry(2.0, 1.35, 2.5);
  const cabinWindowGeo = new THREE.BoxGeometry(2.05, 0.85, 2.1);
  const cabinHangerGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.8, 5);
  const chairSeatGeo = new THREE.BoxGeometry(1.7, 0.14, 0.55);
  const chairBackGeo = new THREE.BoxGeometry(1.7, 0.65, 0.12);

  function createCabinMesh(isGondola) {
    const g = new THREE.Group();
    if (isGondola) {
      const hanger = new THREE.Mesh(cabinHangerGeo, metalMat);
      hanger.position.y = -0.9;
      const body = new THREE.Mesh(cabinBodyGeo, cabinBlueMat);
      body.position.y = -2.2;
      const win = new THREE.Mesh(cabinWindowGeo, cabinGlassMat);
      win.position.y = -2.0;
      g.add(hanger, body, win);
    } else {
      const hanger = new THREE.Mesh(cabinHangerGeo, metalMat);
      hanger.position.y = -0.9;
      const seat = new THREE.Mesh(chairSeatGeo, metalMat);
      seat.position.y = -1.8;
      const back = new THREE.Mesh(chairBackGeo, cabinBlueMat);
      back.position.set(0, -1.5, -0.24);
      g.add(hanger, seat, back);
    }
    return g;
  }

  function addAerialway(aw, isFallback = false) {
    const id = aw.id || aw.name || `aw_${seenAerialways.size}`;
    if (seenAerialways.has(id)) return;
    seenAerialways.add(id);

    const awGroup = new THREE.Group();
    root.add(awGroup);

    const coords = aw.coords;
    if (!coords || coords.length < 6) return;

    const n = Math.floor(coords.length / 3);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3];
      const z = coords[i * 3 + 2];
      const ty = terrain.getHeight(x, z);
      const y = (Number.isFinite(ty) && ty > 100 ? ty : coords[i * 3 + 1]) + 11.5;
      pts.push(new THREE.Vector3(x, y, z));
    }

    // Determine pylon positions (explicit pylons or ~95m intervals)
    const pylonPts = [];
    if (aw.pylons && aw.pylons.length >= 2) {
      for (const p of aw.pylons) {
        const ty = terrain.getHeight(p.x, p.z);
        const y = (Number.isFinite(ty) && ty > 100 ? ty : p.y) + 11.5;
        pylonPts.push(new THREE.Vector3(p.x, y, p.z));
      }
    } else {
      let acc = 0;
      pylonPts.push(pts[0].clone());
      for (let i = 1; i < pts.length; i++) {
        acc += pts[i].distanceTo(pts[i - 1]);
        if (acc >= 95 || i === pts.length - 1) {
          pylonPts.push(pts[i].clone());
          acc = 0;
        }
      }
    }

    // Build lift towers
    for (let i = 0; i < pylonPts.length; i++) {
      const p = pylonPts[i];
      const next = pylonPts[Math.min(pylonPts.length - 1, i + 1)];
      const prev = pylonPts[Math.max(0, i - 1)];
      const yaw = Math.atan2(next.x - prev.x, next.z - prev.z);

      const towerH = 12.5;
      const mast = new THREE.Mesh(towerMastGeo, metalMat);
      mast.scale.set(1, towerH, 1);
      mast.position.set(p.x, p.y - towerH * 0.5, p.z);
      mast.rotation.y = yaw;
      awGroup.add(mast);

      const arm = new THREE.Mesh(towerArmGeo, metalMat);
      arm.position.set(p.x, p.y, p.z);
      arm.rotation.y = yaw;
      awGroup.add(arm);
    }

    // Dual haul cables (upbound + downbound offset +-2.1m) with catenary sag
    const cablePositions = [];
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
    const cableGeo = new THREE.BufferGeometry();
    cableGeo.setAttribute('position', new THREE.Float32BufferAttribute(cablePositions, 3));
    const cableLines = new THREE.LineSegments(cableGeo, cableMat);
    awGroup.add(cableLines);
    disposables.push(cableGeo);

    // Compute cumulative distance along pylonPts for smooth moving cabins
    const cum = [0];
    for (let i = 1; i < pylonPts.length; i++) {
      cum.push(cum[i - 1] + pylonPts[i].distanceTo(pylonPts[i - 1]));
    }
    const totalLen = cum[cum.length - 1];
    if (totalLen < 20) return;

    const isGondola = aw.kind === 'gondola' || aw.kind === 'cable_car' || (aw.name || '').toLowerCase().includes('gondola');
    const spacing = isGondola ? 85 : 55;
    const maxCabins = engine.quality.tier === 'low' ? 8 : 28;
    const countPerSide = Math.min(maxCabins, Math.max(2, Math.floor(totalLen / spacing)));
    const speed = isGondola ? 5.0 : 3.2;

    const cabins = [];
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < countPerSide; i++) {
        const mesh = createCabinMesh(isGondola);
        awGroup.add(mesh);
        cabins.push({
          mesh,
          dist: (i / countPerSide) * totalLen,
          side,
          dir: side,
          speed,
        });
      }
    }

    animatedLifts.push({ pylonPts, cum, totalLen, cabins, isFallback, awGroup, cableGeo });
  }

  function buildBridalVeilPowerPlant() {
    const { x, z } = lonLatToWorld(BRIDAL_VEIL_PLANT.lon, BRIDAL_VEIL_PLANT.lat);
    // Check if an OSM building already covers Bridal Veil Power Plant
    if (trailData?.buildings) {
      for (const b of trailData.buildings) {
        if (b.bbox && x >= b.bbox[0] - 40 && x <= b.bbox[2] + 40 && z >= b.bbox[1] - 40 && z <= b.bbox[3] + 40) {
          return;
        }
      }
    }
    const y = terrain.getHeight(x, z);
    const hw = 6.5, hd = 4.5;
    const coords = new Float32Array([
      x - hw, y, z - hd,
      x + hw, y, z - hd,
      x + hw, y, z + hd,
      x - hw, y, z + hd,
    ]);
    const g = buildBuildingGeometry(coords, getCornerY, Number.isFinite(y) && y > 100 ? y : 3120, 7.5, 0, 7);
    if (g) {
      const mesh = new THREE.Mesh(g, buildingMat);
      mesh.castShadow = Boolean(engine.quality.shadows);
      mesh.receiveShadow = true;
      root.add(mesh);
      disposables.push(g);
    }
  }

  function buildMiningRuins() {
    const binGeo = new THREE.BoxGeometry(4.2, 3.4, 3.2);
    const roofGeo = new THREE.BoxGeometry(4.8, 0.2, 3.8);
    const postGeo = new THREE.BoxGeometry(0.32, 6.2, 0.32);
    disposables.push(binGeo, roofGeo, postGeo);

    for (let i = 0; i < MINING_RUINS.length; i++) {
      const m = MINING_RUINS[i];
      const { x, z } = lonLatToWorld(m.lon, m.lat);
      const near = trailData?.nearest?.(x, z, 10);
      // Offset slightly off trail if right on top of one
      const ox = near && near.dist < 6 ? x + 9 : x;
      const oz = near && near.dist < 6 ? z + 7 : z;
      const y = terrain.getHeight(ox, oz);
      const baseY = Number.isFinite(y) && y > 100 ? y : 3550;

      const rng = mulberry32(hash2i(Math.round(ox), Math.round(oz), 99));
      const g = new THREE.Group();
      g.position.set(ox, baseY, oz);
      g.rotation.y = rng() * Math.PI * 2;

      // Timber ore bin frame
      const bin = new THREE.Mesh(binGeo, ruinWoodMat);
      bin.position.set(0, 1.5, 0);
      bin.rotation.z = 0.04;
      g.add(bin);

      // Slanted corrugated tin roof
      const roof = new THREE.Mesh(roofGeo, ruinTinMat);
      roof.position.set(0, 3.3, 0);
      roof.rotation.x = 0.25;
      g.add(roof);

      // Weathered headframe posts
      const post1 = new THREE.Mesh(postGeo, ruinWoodMat);
      post1.position.set(-1.5, 3.0, 2.2);
      post1.rotation.x = -0.22;
      const post2 = post1.clone();
      post2.position.set(1.5, 3.0, 2.2);
      g.add(post1, post2);

      root.add(g);
    }
  }

  function syncFromTrailData() {
    if (trailData?.buildings?.length) {
      processBuildingsBatch(trailData.buildings);
    }
    if (trailData?.aerialways?.length) {
      // Remove fallback gondola once real OSM aerialways arrive
      for (let i = animatedLifts.length - 1; i >= 0; i--) {
        if (animatedLifts[i].isFallback) {
          root.remove(animatedLifts[i].awGroup);
          animatedLifts[i].cableGeo.dispose();
          animatedLifts.splice(i, 1);
        }
      }
      for (const aw of trailData.aerialways) addAerialway(aw, false);
    }
  }
  syncFromTrailData();

  // Fallback Telluride Gondola line if trailData has no aerialways yet (stub mode)
  if (!trailData?.aerialways?.length) {
    const p1 = lonLatToWorld(-107.8130, 37.9354);
    const p2 = lonLatToWorld(-107.8268, 37.9261);
    const p3 = lonLatToWorld(-107.8473, 37.9328);
    addAerialway({
      id: 'fallback_telluride_gondola',
      name: 'Telluride Gondola',
      kind: 'gondola',
      coords: new Float32Array([p1.x, 2670, p1.z, p2.x, 3212, p2.z, p3.x, 2908, p3.z]),
    }, true);
  }

  buildBridalVeilPowerPlant();
  buildMiningRuins();

  const unsubChunk = events.on('data:chunk', syncFromTrailData);

  let batchCheckIdx = 0;
  let batchCheckTimer = 0;

  function update(dt) {
    // Re-snap a building batch if higher-LOD terrain streamed in beneath it
    batchCheckTimer += dt;
    if (batchCheckTimer > 0.6 && buildingBatches.length > 0) {
      batchCheckTimer = 0;
      const batch = buildingBatches[batchCheckIdx % buildingBatches.length];
      batchCheckIdx++;
      const curY = getCornerY(batch.sampleX, batch.sampleZ, batch.sampleY);
      if (Math.abs(curY - batch.sampleY) > 1.5) {
        const nextGeo = buildBatchGeometry(batch.items);
        if (nextGeo) {
          batch.mesh.geometry.dispose();
          batch.mesh.geometry = nextGeo;
          disposables.push(nextGeo);
          batch.sampleY = curY;
        }
      }
    }

    for (const lift of animatedLifts) {
      const { pylonPts, cum, totalLen, cabins } = lift;
      for (const c of cabins) {
        c.dist += c.dir * c.speed * dt;
        if (c.dist > totalLen) c.dist -= totalLen;
        if (c.dist < 0) c.dist += totalLen;

        // Binary/linear search segment
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

        c.mesh.position.set(
          THREE.MathUtils.lerp(a.x, b.x, t) + rx,
          THREE.MathUtils.lerp(a.y, b.y, t) - sag,
          THREE.MathUtils.lerp(a.z, b.z, t) + rz
        );
        c.mesh.rotation.y = Math.atan2(dx * c.dir, dz * c.dir);
      }
    }
  }

  function dispose() {
    unsubChunk();
    scene.remove(root);
    for (const g of disposables) g.dispose();
    towerMastGeo.dispose();
    towerArmGeo.dispose();
    cabinBodyGeo.dispose();
    cabinWindowGeo.dispose();
    cabinHangerGeo.dispose();
    chairSeatGeo.dispose();
    chairBackGeo.dispose();
    buildingMat.dispose();
    metalMat.dispose();
    cableMat.dispose();
    cabinBlueMat.dispose();
    cabinGlassMat.dispose();
    ruinWoodMat.dispose();
    ruinTinMat.dispose();
  }

  return { update, dispose };
}
