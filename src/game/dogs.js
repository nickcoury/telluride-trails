// Ryan Becker & Lindsay Allison's two high-energy Telluride trail dogs Easter egg:
// - Dog 1: Golden-tan / fawn shepherd-cur mix (~0.56 m shoulder) with white chest blaze,
//   dark black muzzle mask, floppy dark-edged ears, navy GPS/Fi collar + pod, bushy curled golden/cream tail.
// - Dog 2: Glossy black & white Border Collie / cattle mix (~0.47 m shoulder) with speckled
//   "cookies-and-cream" muzzle, white chest bib & white neck ruff, 4 white socks, semi-prick ears,
//   bright crimson-red collar, and curved black tail with bright white tip.
// Active ONLY when activeRunner.id === 'ryan-becker' || activeRunner.id === 'lindsay-allison'.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

const _tmpColor = new THREE.Color();
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _scale = new THREE.Vector3();
const _pushScratch = { x: 0, z: 0, pushed: false };

function mergeParts(parts) {
  const prepared = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    p.geo.dispose();
    if (g.attributes.uv) g.deleteAttribute('uv');

    _pos.set(p.pos?.[0] ?? 0, p.pos?.[1] ?? 0, p.pos?.[2] ?? 0);
    _euler.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
    _quat.setFromEuler(_euler);
    _scale.set(p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.scale?.[2] ?? 1);
    _mat4.compose(_pos, _quat, _scale);
    g.applyMatrix4(_mat4);
    if (!g.attributes.normal) g.computeVertexNormals();

    _tmpColor.setHex(p.color);
    const vCount = g.attributes.position.count;
    const colors = new Float32Array(vCount * 3);
    for (let v = 0; v < vCount; v++) {
      colors[v * 3] = _tmpColor.r;
      colors[v * 3 + 1] = _tmpColor.g;
      colors[v * 3 + 2] = _tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    prepared.push(g);
  }
  const merged = mergeGeometries(prepared, false);
  for (let i = 0; i < prepared.length; i++) prepared[i].dispose();
  return merged;
}

function makeLeg(upperLen, lowerLen, upperR, lowerR, upperColor, lowerColor, pawColor) {
  const hip = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 });

  const upperGeo = mergeParts([
    { geo: new THREE.CapsuleGeometry(upperR, Math.max(0.04, upperLen - upperR * 1.4), 4, 7), pos: [0, -upperLen * 0.5, 0], color: upperColor },
  ]);
  const upperMesh = new THREE.Mesh(upperGeo, mat);
  upperMesh.castShadow = true;
  hip.add(upperMesh);

  const knee = new THREE.Group();
  knee.position.set(0, -upperLen, 0);
  hip.add(knee);

  const lowerGeo = mergeParts([
    { geo: new THREE.CapsuleGeometry(lowerR, Math.max(0.04, lowerLen - lowerR * 1.5), 4, 7), pos: [0, -lowerLen * 0.48, 0], color: lowerColor },
    // Rounded paw pad resting cleanly at y = -lowerLen
    { geo: new THREE.SphereGeometry(lowerR * 1.32, 7, 5), pos: [0, -lowerLen + lowerR * 0.65, -lowerR * 0.45], scale: [1.05, 0.58, 1.38], color: pawColor },
  ]);
  const lowerMesh = new THREE.Mesh(lowerGeo, mat);
  lowerMesh.castShadow = true;
  knee.add(lowerMesh);

  return { hip, knee };
}

/**
 * Dog 1: Golden-tan / fawn shepherd-cur mix (~0.56 m shoulder, ~0.82 m length).
 */
function buildGoldenShepherdDog() {
  const root = new THREE.Group();
  root.name = 'trail-dog-fawn';

  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0.50, 0);
  root.add(bodyPivot);

  const coatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 });

  // Torso + white chest blaze + slate-navy GPS/Fi collar w/ tracker pod
  const torsoGeo = mergeParts([
    // Main ribcage & barrel (forward is -Z)
    { geo: new THREE.CapsuleGeometry(0.145, 0.44, 6, 10), pos: [0, 0.02, 0.0], rot: [Math.PI / 2, 0, 0], scale: [0.92, 1.0, 1.05], color: 0xb87d42 },
    // Slightly lighter golden shoulder/back highlight
    { geo: new THREE.SphereGeometry(0.145, 9, 7), pos: [0, 0.03, -0.18], scale: [0.94, 1.04, 1.12], color: 0xc78d50 },
    // Athletic tucked waist & rump
    { geo: new THREE.SphereGeometry(0.135, 9, 7), pos: [0, 0.03, 0.22], scale: [0.92, 0.98, 1.15], color: 0xb4793e },
    // Prominent white chest blaze
    { geo: new THREE.SphereGeometry(0.112, 8, 7), pos: [0, -0.02, -0.26], scale: [0.76, 1.05, 0.72], color: 0xf4f0e6 },
    // Wide dark slate-navy GPS / Fi collar
    { geo: new THREE.TorusGeometry(0.102, 0.024, 7, 14), pos: [0, 0.10, -0.29], rot: [0.92, 0, 0], color: 0x263244 },
    // Small black GPS tracker pod on collar side/throat
    { geo: new THREE.BoxGeometry(0.038, 0.030, 0.052), pos: [0.072, 0.068, -0.32], rot: [0.25, -0.4, 0], color: 0x111827 },
  ]);
  const torsoMesh = new THREE.Mesh(torsoGeo, coatMat);
  torsoMesh.castShadow = true;
  bodyPivot.add(torsoMesh);

  // Articulated neck + head with dark black muzzle mask & floppy dark-edged V ears
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.11, -0.28);
  bodyPivot.add(headPivot);

  const headGeo = mergeParts([
    // Neck
    { geo: new THREE.CapsuleGeometry(0.088, 0.14, 5, 8), pos: [0, 0.08, -0.05], rot: [0.42, 0, 0], color: 0xc48b4e },
    // Cranium
    { geo: new THREE.SphereGeometry(0.102, 9, 7), pos: [0, 0.175, -0.11], scale: [0.92, 0.92, 1.06], color: 0xc78d50 },
    // Darker eye-mask brow ridge
    { geo: new THREE.SphereGeometry(0.072, 8, 6), pos: [0, 0.172, -0.175], scale: [1.05, 0.75, 0.85], color: 0x3b2c22 },
    // Signature dark charcoal/black muzzle mask
    { geo: new THREE.CapsuleGeometry(0.048, 0.085, 5, 8), pos: [0, 0.142, -0.235], rot: [Math.PI / 2 + 0.08, 0, 0], scale: [0.92, 1.0, 0.88], color: 0x231f1d },
    // Glossy black nose
    { geo: new THREE.SphereGeometry(0.025, 7, 5), pos: [0, 0.152, -0.295], scale: [1.1, 0.85, 0.85], color: 0x111111 },
    // Warm eyes
    { geo: new THREE.SphereGeometry(0.014, 6, 5), pos: [-0.048, 0.185, -0.185], color: 0x1e130c },
    { geo: new THREE.SphereGeometry(0.014, 6, 5), pos: [0.048, 0.185, -0.185], color: 0x1e130c },
    // Floppy V-shaped dark-edged ears
    { geo: new THREE.ConeGeometry(0.046, 0.125, 5), pos: [-0.095, 0.175, -0.095], rot: [0.22, 0.12, 2.55], scale: [0.55, 1.0, 0.92], color: 0x35251a },
    { geo: new THREE.ConeGeometry(0.046, 0.125, 5), pos: [0.095, 0.175, -0.095], rot: [0.22, -0.12, -2.55], scale: [0.55, 1.0, 0.92], color: 0x35251a },
  ]);
  const headMesh = new THREE.Mesh(headGeo, coatMat);
  headMesh.castShadow = true;
  headPivot.add(headMesh);

  // Bushy upward-curled golden tail with pale cream feathered underside/tip
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.08, 0.34);
  bodyPivot.add(tailPivot);

  const tailGeo = mergeParts([
    { geo: new THREE.CapsuleGeometry(0.036, 0.14, 4, 7), pos: [0, 0.055, 0.075], rot: [0.85, 0, 0], color: 0xc2884b },
    { geo: new THREE.CapsuleGeometry(0.044, 0.16, 5, 7), pos: [0, 0.165, 0.145], rot: [0.25, 0, 0], color: 0xc99257 },
    { geo: new THREE.CapsuleGeometry(0.036, 0.11, 4, 7), pos: [0, 0.27, 0.135], rot: [-0.42, 0, 0], color: 0xede0c8 },
    { geo: new THREE.SphereGeometry(0.040, 7, 5), pos: [0, 0.16, 0.175], scale: [0.88, 1.35, 1.05], color: 0xe6d6bc },
  ]);
  const tailMesh = new THREE.Mesh(tailGeo, coatMat);
  tailMesh.castShadow = true;
  tailPivot.add(tailMesh);

  // 4 articulated 2-segment legs (upper 0.24 + lower 0.24 -> paws touch y = 0 at bodyPivot.y = 0.50)
  const fl = makeLeg(0.24, 0.24, 0.044, 0.031, 0xc2894c, 0xc78f54, 0xf3eee3);
  fl.hip.position.set(-0.095, -0.02, -0.22);
  bodyPivot.add(fl.hip);

  const fr = makeLeg(0.24, 0.24, 0.044, 0.031, 0xc2894c, 0xc78f54, 0xf3eee3);
  fr.hip.position.set(0.095, -0.02, -0.22);
  bodyPivot.add(fr.hip);

  const rl = makeLeg(0.25, 0.23, 0.050, 0.032, 0xb57a3f, 0xc2894c, 0xe8dcc8);
  rl.hip.position.set(-0.098, -0.02, 0.23);
  bodyPivot.add(rl.hip);

  const rr = makeLeg(0.25, 0.23, 0.050, 0.032, 0xb57a3f, 0xc2894c, 0xe8dcc8);
  rr.hip.position.set(0.098, -0.02, 0.23);
  bodyPivot.add(rr.hip);

  return {
    name: 'fawn',
    root,
    bodyPivot,
    headPivot,
    tailPivot,
    legs: { fl, fr, rl, rr },
    baseBodyY: 0.50,
    halfLen: 0.34,
  };
}

/**
 * Dog 2: Agile Black & White Border Collie / Cattle Mix (~0.47 m shoulder, ~0.72 m length).
 */
function buildBorderCollieDog() {
  const root = new THREE.Group();
  root.name = 'trail-dog-collie';

  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0.43, 0);
  root.add(bodyPivot);

  const coatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.04 });

  // Glossy black torso + white chest bib + bright crimson-red collar
  const torsoGeo = mergeParts([
    { geo: new THREE.CapsuleGeometry(0.128, 0.38, 6, 10), pos: [0, 0.015, 0.0], rot: [Math.PI / 2, 0, 0], scale: [0.92, 1.0, 1.04], color: 0x15171a },
    { geo: new THREE.SphereGeometry(0.128, 9, 7), pos: [0, 0.02, -0.16], scale: [0.94, 1.02, 1.1], color: 0x171a1e },
    { geo: new THREE.SphereGeometry(0.122, 9, 7), pos: [0, 0.02, 0.19], scale: [0.92, 0.98, 1.12], color: 0x15171a },
    // Crisp white chest bib
    { geo: new THREE.SphereGeometry(0.105, 8, 7), pos: [0, -0.015, -0.225], scale: [0.82, 1.08, 0.72], color: 0xf5f7fa },
    // Bright crimson-red collar + tiny silver tag
    { geo: new THREE.TorusGeometry(0.088, 0.020, 7, 14), pos: [0, 0.09, -0.245], rot: [0.92, 0, 0], color: 0xdc2626 },
    { geo: new THREE.CylinderGeometry(0.013, 0.013, 0.005, 8), pos: [0, 0.015, -0.295], rot: [Math.PI / 2, 0, 0], color: 0xe2e8f0 },
  ]);
  const torsoMesh = new THREE.Mesh(torsoGeo, coatMat);
  torsoMesh.castShadow = true;
  bodyPivot.add(torsoMesh);

  // Articulated head with white neck ruff behind ears, cookies-and-cream speckled muzzle, semi-prick ears
  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.095, -0.24);
  bodyPivot.add(headPivot);

  const headGeo = mergeParts([
    // Black neck front + white ruff patch at back of neck behind ears (matches frame_01 & frame_06!)
    { geo: new THREE.CapsuleGeometry(0.078, 0.12, 5, 8), pos: [0, 0.07, -0.04], rot: [0.42, 0, 0], color: 0x16181c },
    { geo: new THREE.SphereGeometry(0.072, 8, 6), pos: [0, 0.085, 0.005], scale: [0.95, 1.1, 0.65], color: 0xf5f7fa },
    // Jet-black cranium
    { geo: new THREE.SphereGeometry(0.092, 9, 7), pos: [0, 0.155, -0.095], scale: [0.92, 0.92, 1.06], color: 0x15171a },
    // White forehead blaze strip tapering toward muzzle
    { geo: new THREE.BoxGeometry(0.026, 0.055, 0.045), pos: [0, 0.165, -0.170], rot: [0.35, 0, 0], color: 0xf5f7fa },
    // White speckled "cookies-and-cream" muzzle
    { geo: new THREE.CapsuleGeometry(0.042, 0.075, 5, 8), pos: [0, 0.126, -0.205], rot: [Math.PI / 2 + 0.06, 0, 0], scale: [0.92, 1.0, 0.88], color: 0xf1f4f8 },
    // Cookies-and-cream dark speckles on snout sides
    { geo: new THREE.SphereGeometry(0.012, 5, 4), pos: [-0.036, 0.132, -0.205], color: 0x1b1e23 },
    { geo: new THREE.SphereGeometry(0.011, 5, 4), pos: [0.035, 0.130, -0.215], color: 0x1b1e23 },
    { geo: new THREE.SphereGeometry(0.010, 5, 4), pos: [-0.024, 0.145, -0.232], color: 0x1b1e23 },
    { geo: new THREE.SphereGeometry(0.010, 5, 4), pos: [0.022, 0.142, -0.190], color: 0x1b1e23 },
    // Black nose
    { geo: new THREE.SphereGeometry(0.022, 7, 5), pos: [0, 0.134, -0.260], scale: [1.1, 0.85, 0.85], color: 0x0f1114 },
    // Alert eyes
    { geo: new THREE.SphereGeometry(0.013, 6, 5), pos: [-0.044, 0.168, -0.165], color: 0x261a12 },
    { geo: new THREE.SphereGeometry(0.013, 6, 5), pos: [0.044, 0.168, -0.165], color: 0x261a12 },
    // Semi-prick alert Border Collie ears (tall black base + slight forward-tipped top)
    { geo: new THREE.ConeGeometry(0.038, 0.105, 5), pos: [-0.064, 0.245, -0.088], rot: [-0.18, 0, 0.24], scale: [0.65, 1.0, 0.82], color: 0x141619 },
    { geo: new THREE.ConeGeometry(0.038, 0.105, 5), pos: [0.064, 0.245, -0.088], rot: [-0.18, 0, -0.24], scale: [0.65, 1.0, 0.82], color: 0x141619 },
  ]);
  const headMesh = new THREE.Mesh(headGeo, coatMat);
  headMesh.castShadow = true;
  headPivot.add(headMesh);

  // Curled black tail with bright white tip
  const tailPivot = new THREE.Group();
  tailPivot.position.set(0, 0.065, 0.30);
  bodyPivot.add(tailPivot);

  const tailGeo = mergeParts([
    { geo: new THREE.CapsuleGeometry(0.030, 0.14, 4, 7), pos: [0, 0.05, 0.07], rot: [0.85, 0, 0], color: 0x15171a },
    { geo: new THREE.CapsuleGeometry(0.032, 0.14, 4, 7), pos: [0, 0.15, 0.14], rot: [0.22, 0, 0], color: 0x15171a },
    { geo: new THREE.CapsuleGeometry(0.034, 0.10, 5, 7), pos: [0, 0.22, 0.11], rot: [-0.55, 0, 0], color: 0xf8fafc },
  ]);
  const tailMesh = new THREE.Mesh(tailGeo, coatMat);
  tailMesh.castShadow = true;
  tailPivot.add(tailMesh);

  // 4 articulated legs with crisp white socks & paws on ALL 4 feet (0.205 + 0.205 -> paws at y = 0)
  const fl = makeLeg(0.205, 0.205, 0.038, 0.027, 0x15171a, 0xf5f7fa, 0xf8fafc);
  fl.hip.position.set(-0.084, -0.02, -0.19);
  bodyPivot.add(fl.hip);

  const fr = makeLeg(0.205, 0.205, 0.038, 0.027, 0x15171a, 0xf5f7fa, 0xf8fafc);
  fr.hip.position.set(0.084, -0.02, -0.19);
  bodyPivot.add(fr.hip);

  const rl = makeLeg(0.215, 0.195, 0.044, 0.028, 0x15171a, 0xf5f7fa, 0xf8fafc);
  rl.hip.position.set(-0.086, -0.02, 0.20);
  bodyPivot.add(rl.hip);

  const rr = makeLeg(0.215, 0.195, 0.044, 0.028, 0x15171a, 0xf5f7fa, 0xf8fafc);
  rr.hip.position.set(0.086, -0.02, 0.20);
  bodyPivot.add(rr.hip);

  return {
    name: 'collie',
    root,
    bodyPivot,
    headPivot,
    tailPivot,
    legs: { fl, fr, rl, rr },
    baseBodyY: 0.43,
    halfLen: 0.29,
  };
}

function addBlobShadow(dogGroup, radius) {
  const geo = new THREE.CircleGeometry(radius, 12);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x0b1016,
    transparent: true,
    opacity: 0.30,
    depthWrite: false,
  });
  const blob = new THREE.Mesh(geo, mat);
  blob.position.y = 0.03;
  blob.userData.noShadow = true;
  dogGroup.add(blob);
  return blob;
}

/**
 * Create the pair of high-energy trail dogs for Ryan Becker & Lindsay Allison.
 */
export function createTrailDogs(engine) {
  const group = new THREE.Group();
  group.name = 'telluride-trail-dogs';
  group.visible = false;
  engine.scene.add(group);

  const dog1Model = buildGoldenShepherdDog();
  const dog2Model = buildBorderCollieDog();
  const blob1 = addBlobShadow(dog1Model.root, 0.36);
  const blob2 = addBlobShadow(dog2Model.root, 0.31);
  group.add(dog1Model.root);
  group.add(dog2Model.root);

  let active = false;
  let disposed = false;
  let shadowsEnabled = Boolean(engine.quality?.shadows);

  // Shared pack behavior clock so the two dogs coordinate play-sparring cleanly!
  let packClock = 0;
  let sparCooldown = 11.0;
  let sparTimer = 0;
  let sparX = 0;
  let sparZ = 0;

  const dogs = [
    {
      idx: 0,
      model: dog1Model,
      blob: blob1,
      x: 0, y: 0, z: 0,
      vx: 0, vz: 0,
      heading: 0,
      pitch: 0,
      speed: 0,
      hopY: 0,
      gaitPhase: 0,
      tailPhase: 0,
      mode: 'zoomie_dart', // 'zoomie_dart' | 'play_spar' | 'scout_lookback' | 'heel_orbit'
      modeTimer: 4.5,
      targetX: 0,
      targetZ: 0,
      orbitAngle: 0.4,
      orbitDir: 1,
      orbitR: 3.1,
      spinAccum: 0,
      bowAmt: 0,
    },
    {
      idx: 1,
      model: dog2Model,
      blob: blob2,
      x: 0, y: 0, z: 0,
      vx: 0, vz: 0,
      heading: 0,
      pitch: 0,
      speed: 0,
      hopY: 0,
      gaitPhase: 1.8,
      tailPhase: 1.2,
      mode: 'zoomie_dart',
      modeTimer: 5.5,
      targetX: 0,
      targetZ: 0,
      orbitAngle: 3.5,
      orbitDir: -1,
      orbitR: 2.5,
      spinAccum: 0,
      bowAmt: 0,
    },
  ];

  function applyShadowSetting() {
    for (let i = 0; i < dogs.length; i++) {
      dogs[i].blob.visible = !shadowsEnabled;
      dogs[i].model.root.traverse((obj) => {
        if (obj.isMesh && !obj.userData?.noShadow) {
          obj.castShadow = shadowsEnabled;
          obj.receiveShadow = false;
        }
      });
    }
  }
  applyShadowSetting();

  function setShadowsEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === shadowsEnabled) return;
    shadowsEnabled = next;
    applyShadowSetting();
  }

  function snapDogToGround(d, getGroundY) {
    if (typeof getGroundY !== 'function') return;
    const fx = -Math.sin(d.heading);
    const fz = -Math.cos(d.heading);
    const hl = d.model.halfLen;
    const hCenter = getGroundY(d.x, d.z);
    const hFront = getGroundY(d.x + fx * hl, d.z + fz * hl);
    const hRear = getGroundY(d.x - fx * hl, d.z - fz * hl);
    const baseH = Math.max(hCenter, (hFront + hRear) * 0.5);
    const targetPitch = clamp(Math.atan2(hFront - hRear, hl * 2), -0.68, 0.68);
    d.y = Number.isFinite(baseH) ? baseH : d.y;
    d.pitch = targetPitch;
    d.model.root.position.set(d.x, d.y + d.hopY, d.z);
    d.model.root.rotation.order = 'YXZ';
    d.model.root.rotation.set(d.pitch, d.heading, 0);
  }

  function placeBesideRunner(rx, rz, rHeading, getGroundY) {
    const fwdX = -Math.sin(rHeading);
    const fwdZ = -Math.cos(rHeading);
    const rightX = Math.cos(rHeading);
    const rightZ = -Math.sin(rHeading);
    for (let i = 0; i < dogs.length; i++) {
      const d = dogs[i];
      const side = i === 0 ? 1 : -1;
      let sx = rx + fwdX * (2.6 + i * 1.1) + rightX * (side * 1.9);
      let sz = rz + fwdZ * (2.6 + i * 1.1) + rightZ * (side * 1.9);
      if (engine.worldBuildingMask?.pushOutOfBuilding) {
        const res = engine.worldBuildingMask.pushOutOfBuilding(sx, sz, 0.45, _pushScratch);
        if (res?.pushed) {
          sx = res.x;
          sz = res.z;
        }
      }
      d.x = sx;
      d.z = sz;
      d.vx = 0;
      d.vz = 0;
      d.heading = rHeading;
      d.speed = 0;
      d.hopY = 0;
      d.mode = 'zoomie_dart';
      d.modeTimer = 2.5 + i * 1.4;
      d.targetX = sx + fwdX * 14 + rightX * side * 6;
      d.targetZ = sz + fwdZ * 14 + rightZ * side * 6;
      snapDogToGround(d, getGroundY);
    }
    sparTimer = 0;
    sparCooldown = 10.0;
  }

  function setActive(enabled, rx = 0, rz = 0, rHeading = 0, getGroundY = null) {
    const next = Boolean(enabled);
    if (next === active) {
      if (active && getGroundY) {
        // If runner teleported far away, bring dogs right beside runner
        const d0 = Math.hypot(dogs[0].x - rx, dogs[0].z - rz);
        if (d0 > 92) placeBesideRunner(rx, rz, rHeading, getGroundY);
      }
      return;
    }
    active = next;
    group.visible = active;
    if (active) {
      placeBesideRunner(rx, rz, rHeading, getGroundY);
    }
  }

  function pickZoomieTarget(d, rx, rz, rHeading, wideBurst) {
    const fwdX = -Math.sin(rHeading);
    const fwdZ = -Math.cos(rHeading);
    const rightX = Math.cos(rHeading);
    const rightZ = -Math.sin(rHeading);

    // Periodically blast off on wide 25..78m zoomies/scent loops, mostly 5..24m ahead/flanking
    const forwardDist = wideBurst
      ? (18 + Math.random() * 52)
      : (4 + Math.random() * 19);
    const lateralSign = (d.idx === 0 ? 1 : -1) * (Math.random() < 0.35 ? -1 : 1);
    const lateralDist = wideBurst
      ? lateralSign * (14 + Math.random() * 34)
      : lateralSign * (2.2 + Math.random() * 10.5);

    d.targetX = rx + fwdX * forwardDist + rightX * lateralDist;
    d.targetZ = rz + fwdZ * forwardDist + rightZ * lateralDist;
  }

  function animateDog(d, dt, rx, rz, otherDog) {
    const m = d.model;
    const spd = d.speed;
    const isSparring = d.mode === 'play_spar';
    const isOrbit = d.mode === 'heel_orbit';

    // High-energy tail wag (helicopter fast during scout_lookback, play_spar, and heel_orbit!)
    const wagFreq = isSparring || isOrbit || d.mode === 'scout_lookback' ? 18.0 : (spd > 3.5 ? 11.5 : 8.0);
    d.tailPhase = (d.tailPhase + dt * wagFreq) % (Math.PI * 2);
    const wagAmp = isSparring || d.mode === 'scout_lookback' ? 0.62 : 0.42;
    m.tailPivot.rotation.y = Math.sin(d.tailPhase) * wagAmp;
    m.tailPivot.rotation.x = isSparring ? 0.28 : (spd > 4.5 ? -0.18 : 0.08);

    // Target play-bow amount: Black/White dog bows low during play_spar and intermittently during heel_orbit
    const wantBow = (isSparring && d.idx === 1) || (isOrbit && d.idx === 1 && Math.sin(packClock * 2.1) > 0.45);
    d.bowAmt = lerp(d.bowAmt, wantBow ? 1 : 0, Math.min(1, dt * 10));

    // Playful vertical hops (Dog 1 hops/spins in play_spar; both hop occasionally during heel_orbit)
    let targetHop = 0;
    if (isSparring && d.idx === 0) {
      targetHop = Math.max(0, Math.sin(packClock * 9.5)) * 0.24;
    } else if (isOrbit && Math.sin(packClock * 5.2 + d.idx * 2.1) > 0.72) {
      targetHop = Math.max(0, Math.sin((packClock * 5.2 + d.idx * 2.1) * 3)) * 0.16;
    }

    if (spd > 0.35 && !isSparring) {
      // Rotary gallop above 3.6 m/s, energetic trot below
      const isGallop = spd > 3.6;
      const strideFreq = isGallop ? clamp(spd * 2.05, 7.5, 16.5) : clamp(spd * 2.9, 4.0, 10.5);
      d.gaitPhase = (d.gaitPhase + dt * strideFreq) % (Math.PI * 2);

      const p = d.gaitPhase;
      const swingAmp = isGallop ? 0.88 : clamp(0.32 + spd * 0.14, 0.35, 0.72);
      // Gallop uses paired front + rear phase; trot uses diagonal pairs
      const pFL = p;
      const pFR = isGallop ? p + 0.55 : p + Math.PI;
      const pRL = isGallop ? p + Math.PI : p + Math.PI;
      const pRR = isGallop ? p + Math.PI + 0.55 : p;

      const sFL = Math.sin(pFL);
      const sFR = Math.sin(pFR);
      const sRL = Math.sin(pRL);
      const sRR = Math.sin(pRR);

      m.legs.fl.hip.rotation.x = sFL * swingAmp;
      m.legs.fr.hip.rotation.x = sFR * swingAmp;
      m.legs.rl.hip.rotation.x = sRL * swingAmp;
      m.legs.rr.hip.rotation.x = sRR * swingAmp;

      // Knee bend during leg swing recovery
      m.legs.fl.knee.rotation.x = -Math.max(0, -sFL) * (isGallop ? 1.05 : 0.65);
      m.legs.fr.knee.rotation.x = -Math.max(0, -sFR) * (isGallop ? 1.05 : 0.65);
      m.legs.rl.knee.rotation.x = Math.max(0, sRL) * (isGallop ? 0.95 : 0.55);
      m.legs.rr.knee.rotation.x = Math.max(0, sRR) * (isGallop ? 0.95 : 0.55);

      const gallopBounce = isGallop ? Math.max(0, Math.sin(p * 2)) * 0.08 : Math.abs(Math.sin(p)) * 0.03;
      d.hopY = Math.max(targetHop, gallopBounce);
      m.bodyPivot.position.y = m.baseBodyY - d.bowAmt * 0.06;
      m.bodyPivot.rotation.x = (isGallop ? Math.cos(p) * 0.14 : 0) - d.bowAmt * 0.38;
      m.headPivot.rotation.x = -m.bodyPivot.rotation.x * 0.65;
      m.headPivot.rotation.y = 0;
    } else if (isSparring) {
      // Signature couch/kitchen play-wrestling pose!
      d.hopY = targetHop;
      if (d.idx === 1) {
        // Black & white collie: deep play-bow + alternating front paw bat up!
        m.bodyPivot.position.y = m.baseBodyY - 0.09 * d.bowAmt;
        m.bodyPivot.rotation.x = -0.44 * d.bowAmt;
        const pawWave = Math.sin(packClock * 11.5);
        m.legs.fl.hip.rotation.x = -0.65 + Math.max(0, pawWave) * 1.15;
        m.legs.fr.hip.rotation.x = -0.65 + Math.max(0, -pawWave) * 1.15;
        m.legs.fl.knee.rotation.x = 0.75;
        m.legs.fr.knee.rotation.x = 0.75;
        m.legs.rl.hip.rotation.x = 0.18;
        m.legs.rr.hip.rotation.x = 0.18;
        m.legs.rl.knee.rotation.x = -0.15;
        m.legs.rr.knee.rotation.x = -0.15;
        m.headPivot.rotation.x = 0.42;
        m.headPivot.rotation.y = Math.sin(packClock * 7.5) * 0.35;
      } else {
        // Golden tan shepherd: bouncy spar stance + joyful play-hop & head bob
        m.bodyPivot.position.y = m.baseBodyY;
        m.bodyPivot.rotation.x = 0.14 * Math.sin(packClock * 9.5);
        m.legs.fl.hip.rotation.x = -0.35 * Math.max(0, Math.sin(packClock * 9.5));
        m.legs.fr.hip.rotation.x = -0.35 * Math.max(0, Math.cos(packClock * 9.5));
        m.legs.rl.hip.rotation.x = 0.22;
        m.legs.rr.hip.rotation.x = 0.22;
        m.legs.fl.knee.rotation.x = -0.25;
        m.legs.fr.knee.rotation.x = -0.25;
        m.legs.rl.knee.rotation.x = 0.15;
        m.legs.rr.knee.rotation.x = 0.15;
        m.headPivot.rotation.x = -0.12 + Math.sin(packClock * 9.5) * 0.18;
        m.headPivot.rotation.y = Math.sin(packClock * 6.0) * 0.30;
      }
    } else {
      // Alert stopped stance (scout_lookback or paused heel): look toward runner or buddy!
      d.hopY = targetHop;
      m.bodyPivot.position.y = m.baseBodyY - d.bowAmt * 0.08;
      m.bodyPivot.rotation.x = -d.bowAmt * 0.38;
      m.legs.fl.hip.rotation.x = -d.bowAmt * 0.55;
      m.legs.fr.hip.rotation.x = -d.bowAmt * 0.55;
      m.legs.rl.hip.rotation.x = d.bowAmt * 0.15;
      m.legs.rr.hip.rotation.x = d.bowAmt * 0.15;
      m.legs.fl.knee.rotation.x = d.bowAmt * 0.6;
      m.legs.fr.knee.rotation.x = d.bowAmt * 0.6;
      m.legs.rl.knee.rotation.x = 0;
      m.legs.rr.knee.rotation.x = 0;

      // Turn head slightly toward runner
      const lookX = (d.mode === 'play_spar' && otherDog) ? otherDog.x : rx;
      const lookZ = (d.mode === 'play_spar' && otherDog) ? otherDog.z : rz;
      const desiredYaw = Math.atan2(-(lookX - d.x), -(lookZ - d.z));
      const relYaw = Math.atan2(Math.sin(desiredYaw - d.heading), Math.cos(desiredYaw - d.heading));
      m.headPivot.rotation.y = clamp(relYaw, -0.75, 0.75);
      m.headPivot.rotation.x = d.bowAmt * 0.35 + Math.sin(packClock * 3.5 + d.idx) * 0.04;
    }
  }

  function update(dt, ctx) {
    if (!active || disposed) return;
    const safeDt = clamp(dt, 0, 0.08);
    if (safeDt <= 0) return;

    const {
      x: rx,
      z: rz,
      heading: rHeading,
      speedMs: rSpeed,
      getGroundY,
      isWater = null,
      visible = true,
    } = ctx;

    group.visible = visible;
    if (!visible) return;

    packClock += safeDt;
    const runnerStopped = rSpeed < 1.2;

    // Teleport safety if runner jumped/skipped >95 m away
    if (Math.hypot(dogs[0].x - rx, dogs[0].z - rz) > 95 || Math.hypot(dogs[1].x - rx, dogs[1].z - rz) > 95) {
      placeBesideRunner(rx, rz, rHeading, getGroundY);
    }

    // Trigger signature play_spar every 12..22 s when dogs are within reasonable range
    if (sparTimer > 0) {
      sparTimer -= safeDt;
      if (sparTimer <= 0) {
        sparCooldown = 12 + Math.random() * 10;
        for (let i = 0; i < 2; i++) {
          dogs[i].mode = 'zoomie_dart';
          dogs[i].modeTimer = 3.5 + Math.random() * 3.5;
          pickZoomieTarget(dogs[i], rx, rz, rHeading, Math.random() < 0.35);
        }
      }
    } else {
      sparCooldown -= safeDt;
      if (sparCooldown <= 0) {
        const d0 = Math.hypot(dogs[0].x - rx, dogs[0].z - rz);
        const d1 = Math.hypot(dogs[1].x - rx, dogs[1].z - rz);
        if (d0 < 36 && d1 < 36) {
          sparTimer = 2.4 + Math.random() * 1.1;
          const fwdX = -Math.sin(rHeading);
          const fwdZ = -Math.cos(rHeading);
          const rightX = Math.cos(rHeading);
          const rightZ = -Math.sin(rHeading);
          const distAhead = runnerStopped ? 2.8 : (6.5 + Math.random() * 6.0);
          const side = (Math.random() < 0.5 ? -1 : 1) * (1.8 + Math.random() * 2.5);
          sparX = rx + fwdX * distAhead + rightX * side;
          sparZ = rz + fwdZ * distAhead + rightZ * side;
          dogs[0].mode = 'play_spar';
          dogs[1].mode = 'play_spar';
          dogs[0].spinAccum = 0;
        } else {
          sparCooldown = 3.0;
        }
      }
    }

    const pushBuilding = engine.worldBuildingMask?.pushOutOfBuilding;

    for (let i = 0; i < 2; i++) {
      const d = dogs[i];
      const other = dogs[1 - i];
      const distR = Math.hypot(d.x - rx, d.z - rz);

      // Urgent recall if dog ever exceeds 65 m from runner (strict <90 m max tether!)
      const urgentRecall = distR > 65;

      // Mode transitions when not in coordinated play_spar
      if (d.mode !== 'play_spar') {
        if (runnerStopped && !urgentRecall && d.mode !== 'heel_orbit') {
          d.mode = 'heel_orbit';
          d.modeTimer = 3.0 + Math.random() * 3.0;
          d.orbitR = 1.9 + i * 0.95 + Math.random() * 0.8;
          d.orbitDir = i === 0 ? 1 : -1;
        } else if (!runnerStopped && d.mode === 'heel_orbit') {
          d.mode = 'zoomie_dart';
          d.modeTimer = 3.0 + Math.random() * 3.5;
          pickZoomieTarget(d, rx, rz, rHeading, false);
        }

        d.modeTimer -= safeDt;
        if (d.modeTimer <= 0 && !runnerStopped) {
          const roll = Math.random();
          if (roll < 0.28) {
            d.mode = 'scout_lookback';
            d.modeTimer = 2.6 + Math.random() * 1.8;
            const fwdX = -Math.sin(rHeading);
            const fwdZ = -Math.cos(rHeading);
            const rightX = Math.cos(rHeading);
            const rightZ = -Math.sin(rHeading);
            const ahead = 10 + Math.random() * 18;
            const lat = (i === 0 ? 1 : -1) * (1.2 + Math.random() * 3.2);
            d.targetX = rx + fwdX * ahead + rightX * lat;
            d.targetZ = rz + fwdZ * ahead + rightZ * lat;
          } else {
            d.mode = 'zoomie_dart';
            d.modeTimer = 3.2 + Math.random() * 4.0;
            // ~30% chance of a wide 25..78 m off-trail zoomie loop!
            pickZoomieTarget(d, rx, rz, rHeading, Math.random() < 0.30);
          }
        }
      }

      // Compute desired target & speed for this frame
      let goalX = d.targetX;
      let goalZ = d.targetZ;
      let desiredSpeed = 6.8;
      let forceHeading = null;

      if (urgentRecall) {
        const fwdX = -Math.sin(rHeading);
        const fwdZ = -Math.cos(rHeading);
        goalX = rx + fwdX * 6;
        goalZ = rz + fwdZ * 6;
        desiredSpeed = 9.5;
      } else if (d.mode === 'play_spar') {
        const off = i === 0 ? -0.62 : 0.62;
        goalX = sparX + off;
        goalZ = sparZ;
        const dToSpot = Math.hypot(goalX - d.x, goalZ - d.z);
        if (dToSpot > 0.65) {
          desiredSpeed = 7.4;
        } else {
          desiredSpeed = 0;
          // Face each other — Dog 1 also does a joyful 360° spin mid-spar!
          const faceOther = Math.atan2(-(other.x - d.x), -(other.z - d.z));
          if (i === 0 && d.spinAccum < Math.PI * 2) {
            d.spinAccum += safeDt * 7.8;
            forceHeading = faceOther + d.spinAccum;
          } else {
            forceHeading = faceOther;
          }
        }
      } else if (d.mode === 'heel_orbit') {
        d.orbitAngle += safeDt * d.orbitDir * (1.45 + i * 0.35);
        const wobbleR = d.orbitR + Math.sin(packClock * 2.4 + i * 1.7) * 0.55;
        goalX = rx + Math.cos(d.orbitAngle) * wobbleR;
        goalZ = rz + Math.sin(d.orbitAngle) * wobbleR;
        desiredSpeed = 3.4 + (i === 1 ? 0.5 : 0);
      } else if (d.mode === 'scout_lookback') {
        const dToScout = Math.hypot(goalX - d.x, goalZ - d.z);
        if (dToScout > 1.6) {
          desiredSpeed = Math.max(rSpeed + 3.2, 6.8);
        } else {
          desiredSpeed = 0;
          forceHeading = Math.atan2(-(rx - d.x), -(rz - d.z));
        }
      } else {
        // zoomie_dart: S-curve burst with slight sine weave
        const dToGoal = Math.hypot(goalX - d.x, goalZ - d.z);
        if (dToGoal < 2.4) {
          pickZoomieTarget(d, rx, rz, rHeading, Math.random() < 0.28);
          goalX = d.targetX;
          goalZ = d.targetZ;
        }
        const wave = Math.sin(packClock * 3.4 + i * 2.3) * 1.6;
        goalX += Math.cos(rHeading) * wave;
        goalZ += -Math.sin(rHeading) * wave;
        desiredSpeed = clamp(Math.max(rSpeed * 1.65, 5.4) + (i === 1 ? 0.65 : 0), 5.0, 9.4);
      }

      // Steer smoothly toward goal
      const dx = goalX - d.x;
      const dz = goalZ - d.z;
      const distGoal = Math.hypot(dx, dz);
      const targetVx = distGoal > 0.15 && desiredSpeed > 0.1 ? (dx / distGoal) * desiredSpeed : 0;
      const targetVz = distGoal > 0.15 && desiredSpeed > 0.1 ? (dz / distGoal) * desiredSpeed : 0;

      const accel = Math.min(1, safeDt * 6.5);
      d.vx = lerp(d.vx, targetVx, accel);
      d.vz = lerp(d.vz, targetVz, accel);

      let nextX = d.x + d.vx * safeDt;
      let nextZ = d.z + d.vz * safeDt;

      // Hard max 90 m tether clamp
      const nextDistR = Math.hypot(nextX - rx, nextZ - rz);
      if (nextDistR > 88.5) {
        const pull = 88.5 / nextDistR;
        nextX = rx + (nextX - rx) * pull;
        nextZ = rz + (nextZ - rz) * pull;
      }

      // Enforce 1.15 m clearance around runner so dogs never clip through runner's legs
      const postDistR = Math.hypot(nextX - rx, nextZ - rz);
      if (postDistR < 1.15) {
        const ang = postDistR > 0.02 ? Math.atan2(nextZ - rz, nextX - rx) : (rHeading + (i === 0 ? 1.2 : -1.2));
        nextX = rx + Math.cos(ang) * 1.18;
        nextZ = rz + Math.sin(ang) * 1.18;
      }

      // Soft dog-to-dog separation (0.75 m outside play_spar, 0.55 m during spar)
      const minSep = d.mode === 'play_spar' ? 0.55 : 0.85;
      const sepDx = nextX - other.x;
      const sepDz = nextZ - other.z;
      const sepD = Math.hypot(sepDx, sepDz);
      if (sepD > 0.01 && sepD < minSep) {
        const push = (minSep - sepD) * 0.5;
        nextX += (sepDx / sepD) * push;
        nextZ += (sepDz / sepD) * push;
      }

      // Avoid buildings & gondola pylons
      if (pushBuilding) {
        const res = pushBuilding(nextX, nextZ, 0.42, _pushScratch);
        if (res?.pushed) {
          nextX = res.x;
          nextZ = res.z;
        }
      }

      // Avoid deep lake water
      if (typeof isWater === 'function' && isWater(nextX, nextZ)) {
        nextX = d.x;
        nextZ = d.z;
        d.vx *= -0.5;
        d.vz *= -0.5;
        if (d.mode === 'zoomie_dart') {
          pickZoomieTarget(d, rx, rz, rHeading, false);
        }
      }

      d.x = nextX;
      d.z = nextZ;
      d.speed = Math.hypot(d.vx, d.vz);

      if (forceHeading !== null) {
        const diff = Math.atan2(Math.sin(forceHeading - d.heading), Math.cos(forceHeading - d.heading));
        d.heading += diff * Math.min(1, safeDt * 12);
      } else if (d.speed > 0.25) {
        const targetH = Math.atan2(-d.vx, -d.vz);
        const diff = Math.atan2(Math.sin(targetH - d.heading), Math.cos(targetH - d.heading));
        d.heading += diff * Math.min(1, safeDt * 10);
      }

      animateDog(d, safeDt, rx, rz, other);
      snapDogToGround(d, getGroundY);
    }
  }

  function resnapGround(getGroundY) {
    if (!active || disposed || !group.visible) return;
    snapDogToGround(dogs[0], getGroundY);
    snapDogToGround(dogs[1], getGroundY);
  }

  function getDebugState() {
    return {
      active,
      visible: group.visible,
      dogs: dogs.map((d) => ({
        name: d.model.name,
        x: d.x,
        y: d.y,
        z: d.z,
        speed: d.speed,
        mode: d.mode,
      })),
    };
  }

  function dispose() {
    disposed = true;
    engine.scene.remove(group);
    group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (let i = 0; i < mats.length; i++) mats[i]?.dispose?.();
      }
    });
  }

  return {
    group,
    setActive,
    isActive: () => active,
    setShadowsEnabled,
    update,
    resnapGround,
    getDebugState,
    dispose,
  };
}
