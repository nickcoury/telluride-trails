// Rigged, skinned CC0 human trail runner (Quaternius Universal Base Characters +
// Universal Animation Library) with smooth AnimationMixer locomotion blending,
// ground-speed stride matching (no foot sliding), uphill slope lean, power-hike
// posture, merged vertex-colored bone-attached trail gear (hydration vest, soft
// flasks, trucker cap, sunglasses, headlamp, GPS watch), and lazy loading behind
// a slim placeholder.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

// Measured vertical clearances from runner.glb bone origins down to outsole bottom
const SOLE_BELOW_BALL = 0.025;
const SOLE_BELOW_FOOT = 0.106;

// Reusable scratch objects for zero-allocation per-frame 2-bone leg IK & slope grounding
const _vHip = new THREE.Vector3();
const _vKnee = new THREE.Vector3();
const _vAnkle = new THREE.Vector3();
const _vBall = new THREE.Vector3();
const _vLeaf = new THREE.Vector3();
const _vTarget = new THREE.Vector3();
const _vDir = new THREE.Vector3();
const _vPole = new THREE.Vector3();
const _vAnimPole = new THREE.Vector3();
const _vCur = new THREE.Vector3();
const _vNew = new THREE.Vector3();
const _vKneeNew = new THREE.Vector3();
const _vAnkleNew = new THREE.Vector3();
const _vFwd = new THREE.Vector3();
const _vRight = new THREE.Vector3();
const _vUp = new THREE.Vector3(0, 1, 0);
const _vNorm = new THREE.Vector3();
const _vTmp = new THREE.Vector3();
const _qDelta = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qParentInv = new THREE.Quaternion();
const _qOrigFoot = new THREE.Quaternion();
const _qSlope = new THREE.Quaternion();
const _qLocal = new THREE.Quaternion();
const _qBasePivot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

// Calibrated natural ground speeds (m/s) for each UAL1 locomotion clip so
// timeScale = speedMs / naturalSpeed keeps feet planted with zero sliding.
const NATURAL_SPEEDS = {
  walk: 1.42,
  crouch: 1.25,
  jog: 3.05,
  sprint: 5.05,
};

function applyWorldDeltaToBone(bone, qWorldDelta) {
  if (!bone.parent) {
    bone.quaternion.premultiply(qWorldDelta).normalize();
    return;
  }
  bone.parent.getWorldQuaternion(_qParent);
  _qParentInv.copy(_qParent).invert();
  _qLocal.copy(_qParentInv).multiply(qWorldDelta).multiply(_qParent).multiply(bone.quaternion);
  bone.quaternion.copy(_qLocal).normalize();
}

function measureFootSole(footBone, ballBone, leafBone, out, scaleY = 1) {
  footBone.getWorldPosition(_vAnkle);
  const footClear = SOLE_BELOW_FOOT * scaleY;
  const ballClear = SOLE_BELOW_BALL * scaleY;
  let soleY = _vAnkle.y - footClear;
  out.heelX = _vAnkle.x;
  out.heelZ = _vAnkle.z;
  out.ballX = _vAnkle.x;
  out.ballZ = _vAnkle.z;

  if (ballBone) {
    ballBone.getWorldPosition(_vBall);
    out.ballX = _vBall.x;
    out.ballZ = _vBall.z;
    const ballSole = _vBall.y - ballClear;
    if (ballSole < soleY) soleY = ballSole;
  }
  if (leafBone) {
    leafBone.getWorldPosition(_vLeaf);
    const leafSole = _vLeaf.y - ballClear;
    if (leafSole < soleY) soleY = leafSole;
  }
  out.soleY = soleY;
  return out;
}

/**
 * Closed-form 2-bone analytical leg IK in world space (thigh -> calf -> foot)
 * with forward knee-pole constraint and foot slope-pitch preservation.
 */
function solveTwoBoneLegIK(thigh, calf, foot, deltaY, fwdX, fwdZ, rightX, rightZ, footPitchRad) {
  if (!thigh || !calf || !foot) return;

  foot.getWorldQuaternion(_qOrigFoot);
  thigh.getWorldPosition(_vHip);
  calf.getWorldPosition(_vKnee);
  foot.getWorldPosition(_vAnkle);

  const a = _vHip.distanceTo(_vKnee);
  const b = _vKnee.distanceTo(_vAnkle);
  if (a < 0.05 || b < 0.05) return;

  _vTarget.set(_vAnkle.x, _vAnkle.y + deltaY, _vAnkle.z);
  _vDir.subVectors(_vTarget, _vHip);
  const rawDist = _vDir.length();
  if (rawDist < 1e-4) return;
  _vDir.multiplyScalar(1 / rawDist);

  const minD = Math.abs(a - b) + 0.06;
  const maxD = (a + b) * 0.992;
  const d = clamp(rawDist, minD, maxD);

  // Knee bend pole perpendicular to hip->ankle axis, constrained to runner forward hemisphere
  _vFwd.set(fwdX, 0, fwdZ);
  _vPole.copy(_vFwd).addScaledVector(_vDir, -_vFwd.dot(_vDir));
  if (_vPole.lengthSq() < 1e-5) {
    _vPole.set(0, 1, 0).addScaledVector(_vDir, -_vDir.y);
  }
  _vPole.normalize();

  _vAnimPole.subVectors(_vKnee, _vHip);
  _vAnimPole.addScaledVector(_vDir, -_vAnimPole.dot(_vDir));
  if (_vAnimPole.lengthSq() > 0.0009 && _vAnimPole.dot(_vPole) > 0) {
    _vAnimPole.normalize();
    _vPole.multiplyScalar(0.45).addScaledVector(_vAnimPole, 0.55);
    _vPole.addScaledVector(_vDir, -_vPole.dot(_vDir));
    if (_vPole.lengthSq() > 1e-5) _vPole.normalize();
  }

  // Law of cosines for exact knee position
  const cosAlpha = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinAlpha = Math.sqrt(Math.max(0, 1 - cosAlpha * cosAlpha));
  _vKneeNew.copy(_vHip).addScaledVector(_vDir, a * cosAlpha).addScaledVector(_vPole, a * sinAlpha);
  _vAnkleNew.copy(_vHip).addScaledVector(_vDir, d);

  // Rotate thigh so calf aligns to _vKneeNew
  _vCur.subVectors(_vKnee, _vHip).normalize();
  _vNew.subVectors(_vKneeNew, _vHip).normalize();
  _qDelta.setFromUnitVectors(_vCur, _vNew);
  applyWorldDeltaToBone(thigh, _qDelta);
  thigh.updateMatrixWorld(true);

  // Rotate calf so ankle aligns to _vAnkleNew
  calf.getWorldPosition(_vKnee);
  foot.getWorldPosition(_vAnkle);
  _vCur.subVectors(_vAnkle, _vKnee).normalize();
  _vNew.subVectors(_vAnkleNew, _vKnee).normalize();
  _qDelta.setFromUnitVectors(_vCur, _vNew);
  applyWorldDeltaToBone(calf, _qDelta);
  calf.updateMatrixWorld(true);

  // Preserve pre-IK foot orientation plus gentle slope pitch so sole hugs the hillside
  _vRight.set(rightX, 0, rightZ);
  _qSlope.setFromAxisAngle(_vRight, footPitchRad);
  calf.getWorldQuaternion(_qParent);
  _qParentInv.copy(_qParent).invert();
  foot.quaternion.copy(_qParentInv).multiply(_qSlope).multiply(_qOrigFoot).normalize();
  foot.updateMatrixWorld(true);
}

/**
 * Bake transforms and sRGB hex colors into a single merged non-indexed BufferGeometry
 * so multi-part gear renders in 1 draw call. Disposes temporary part geometries.
 */
function mergeColoredParts(parts) {
  const prepared = [];
  const tmpColor = new THREE.Color();
  const mat4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    p.geo.dispose();
    if (g.attributes.uv) g.deleteAttribute('uv');

    pos.set(p.pos?.[0] ?? 0, p.pos?.[1] ?? 0, p.pos?.[2] ?? 0);
    euler.set(p.rot?.[0] ?? 0, p.rot?.[1] ?? 0, p.rot?.[2] ?? 0);
    quat.setFromEuler(euler);
    scale.set(p.scale?.[0] ?? 1, p.scale?.[1] ?? 1, p.scale?.[2] ?? 1);
    mat4.compose(pos, quat, scale);
    g.applyMatrix4(mat4);
    if (!g.attributes.normal) g.computeVertexNormals();

    tmpColor.setHex(p.color);
    const vCount = g.attributes.position.count;
    const colors = new Float32Array(vCount * 3);
    for (let v = 0; v < vCount; v++) {
      colors[v * 3] = tmpColor.r;
      colors[v * 3 + 1] = tmpColor.g;
      colors[v * 3 + 2] = tmpColor.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    prepared.push(g);
  }

  const merged = mergeGeometries(prepared, false);
  for (let i = 0; i < prepared.length; i++) prepared[i].dispose();
  return merged;
}

const FALLBACK_KIT = {
  jerseyHex: 0xdd5226,
  shortsHex: 0x1e2530,
  accentHex: 0x38bdf8,
  capHex: 0x1d4e6b,
  brimHex: 0xd95428,
  hairStyle: 'short',
  hairHex: 0x3b2618,
  buildScale: [1, 1, 1],
};

function buildPlaceholderGeo(kit = FALLBACK_KIT) {
  return mergeColoredParts([
    { geo: new THREE.CapsuleGeometry(0.18, 0.52, 6, 10), pos: [0, 1.18, 0], color: kit.jerseyHex ?? 0xdd5226 },
    { geo: new THREE.CapsuleGeometry(0.14, 0.56, 6, 10), pos: [0, 0.56, 0], color: kit.shortsHex ?? 0x222a35 },
    { geo: new THREE.SphereGeometry(0.115, 10, 8), pos: [0, 1.66, 0], color: 0xd8a480 },
    { geo: new THREE.SphereGeometry(0.122, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.52), pos: [0, 1.68, 0], color: kit.capHex ?? 0x1d4e6b },
  ]);
}

function buildPlaceholder(kit = FALLBACK_KIT) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 });
  const mesh = new THREE.Mesh(buildPlaceholderGeo(kit), mat);
  mesh.name = 'runner-placeholder';
  mesh.castShadow = true;
  return mesh;
}

function buildHydrationVestGeo(kit = FALLBACK_KIT) {
  const packBase = kit.shortsHex ?? 0x183446;
  const trimColor = kit.accentHex ?? 0xe85a2b;
  const parts = [
    // Contoured rear hydration pack (local -Z is behind chest in UAL/UBC bone space)
    { geo: new THREE.BoxGeometry(0.24, 0.34, 0.095), pos: [0, 0.01, -0.155], color: packBase },
    { geo: new THREE.BoxGeometry(0.20, 0.14, 0.055), pos: [0, 0.06, -0.205], color: trimColor },
    { geo: new THREE.BoxGeometry(0.16, 0.022, 0.012), pos: [0, -0.07, -0.206], color: 0xdbeafe },
    // Dual chest sternum straps
    { geo: new THREE.BoxGeometry(0.15, 0.014, 0.014), pos: [0, 0.05, 0.135], color: trimColor },
    { geo: new THREE.BoxGeometry(0.15, 0.014, 0.014), pos: [0, -0.03, 0.135], color: trimColor },
  ];

  for (const side of [-1, 1]) {
    parts.push(
      { geo: new THREE.BoxGeometry(0.035, 0.18, 0.20), pos: [side * 0.145, -0.03, -0.04], color: packBase },
      { geo: new THREE.BoxGeometry(0.052, 0.035, 0.24), pos: [side * 0.10, 0.175, -0.02], color: packBase },
      { geo: new THREE.BoxGeometry(0.056, 0.28, 0.03), pos: [side * 0.095, 0.03, 0.125], color: packBase },
      // Front 500ml soft flask + bite valve
      { geo: new THREE.CylinderGeometry(0.025, 0.020, 0.145, 10), pos: [side * 0.095, 0.02, 0.148], color: 0x38bdf8 },
      { geo: new THREE.CylinderGeometry(0.014, 0.018, 0.024, 8), pos: [side * 0.095, 0.102, 0.148], color: 0x111827 },
    );
  }
  return mergeColoredParts(parts);
}

function buildHydrationVest(kit = FALLBACK_KIT) {
  const mesh = new THREE.Mesh(
    buildHydrationVestGeo(kit),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.05 })
  );
  mesh.name = 'gear-hydration-vest';
  mesh.castShadow = true;
  return mesh;
}

function buildHeadCapGeo(kit = FALLBACK_KIT) {
  const capColor = kit.capHex ?? 0x1d4e6b;
  const brimColor = kit.brimHex ?? 0xd95428;
  const meshBackColor = kit.shortsHex ?? 0x2a3441;
  return mergeColoredParts([
    // Trucker trail cap crown snugged cleanly onto skull brow
    {
      geo: new THREE.SphereGeometry(0.113, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.56),
      pos: [0, 0.104, -0.008],
      rot: [-0.08, 0, 0],
      scale: [0.95, 1.0, 1.04],
      color: capColor,
    },
    // Rear dark mesh panel accent
    {
      geo: new THREE.SphereGeometry(0.114, 12, 8, Math.PI * 0.72, Math.PI * 1.56, 0.12, Math.PI * 0.44),
      pos: [0, 0.104, -0.008],
      rot: [-0.08, 0, 0],
      scale: [0.95, 1.0, 1.04],
      color: meshBackColor,
    },
    // Curved trail cap brim pointing +Z (forward in bone local space)
    {
      geo: new THREE.CylinderGeometry(0.098, 0.102, 0.011, 14, 1, false, -Math.PI * 0.42, Math.PI * 0.84),
      pos: [0, 0.118, 0.055],
      rot: [0.07, 0, 0],
      scale: [1.02, 1, 1.42],
      color: brimColor,
    },
    // Wraparound trail sunglasses
    {
      geo: new THREE.BoxGeometry(0.142, 0.032, 0.036),
      pos: [0, 0.084, 0.095],
      color: 0x111827,
    },
    // Headlamp elastic strap + compact forehead housing
    {
      geo: new THREE.TorusGeometry(0.108, 0.008, 6, 18),
      pos: [0, 0.132, -0.006],
      rot: [Math.PI / 2 - 0.08, 0, 0],
      scale: [0.96, 1.05, 1],
      color: 0x1f2937,
    },
    {
      geo: new THREE.BoxGeometry(0.044, 0.025, 0.022),
      pos: [0, 0.138, 0.108],
      color: 0x374151,
    },
  ]);
}

function buildPonytailMesh(hairHex = 0x4a3120) {
  // Single merged sculpted ponytail exiting the back of the trucker cap (local -Z)
  const geo = mergeColoredParts([
    { geo: new THREE.TorusGeometry(0.024, 0.007, 6, 12), pos: [0, 0.092, -0.115], rot: [0.25, 0, 0], color: 0x1e293b },
    { geo: new THREE.CapsuleGeometry(0.028, 0.075, 5, 8), pos: [0, 0.068, -0.145], rot: [0.68, 0, 0], color: 0xffffff },
    { geo: new THREE.ConeGeometry(0.028, 0.11, 8), pos: [0, -0.010, -0.185], rot: [2.72, 0, 0], color: 0xffffff },
  ]);
  const mat = new THREE.MeshStandardMaterial({
    color: hairHex,
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.02,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'gear-ponytail';
  mesh.castShadow = true;
  mesh.visible = false;
  return mesh;
}

function buildHeadGear(kit = FALLBACK_KIT) {
  const gear = new THREE.Group();
  gear.name = 'gear-head';

  // Merge all static cap + shades + headlamp housing parts into 1 draw call
  const staticMesh = new THREE.Mesh(
    buildHeadCapGeo(kit),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.08 })
  );
  staticMesh.name = 'gear-head-cap';
  staticMesh.castShadow = true;
  gear.add(staticMesh);

  // Merged ponytail mesh toggled via kit.hairStyle === 'ponytail'
  const ponytailMesh = buildPonytailMesh(kit.hairHex ?? 0x4a3120);
  ponytailMesh.visible = kit.hairStyle === 'ponytail';
  gear.add(ponytailMesh);

  // Separate tiny emissive lens mesh (no shadow casting)
  const lampLensMat = new THREE.MeshStandardMaterial({
    color: 0xfffbeb,
    emissive: 0xfef08a,
    emissiveIntensity: 0.0,
    roughness: 0.2,
  });
  const lampLens = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10), lampLensMat);
  lampLens.name = 'gear-headlamp-lens';
  lampLens.rotation.x = Math.PI / 2;
  lampLens.position.set(0, 0.138, 0.120);
  lampLens.castShadow = false;
  lampLens.userData.noShadow = true;
  gear.add(lampLens);

  return { gear, staticMesh, ponytailMesh, lampLensMat };
}

function buildGpsWatch() {
  const mesh = new THREE.Mesh(
    mergeColoredParts([
      { geo: new THREE.CylinderGeometry(0.036, 0.036, 0.028, 10), pos: [0, 0, 0], color: 0x111827 },
      { geo: new THREE.CylinderGeometry(0.022, 0.022, 0.012, 10), pos: [0, 0, -0.034], rot: [Math.PI / 2, 0, 0], color: 0x10b981 },
    ]),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 })
  );
  mesh.name = 'gear-gps-watch';
  mesh.position.set(0, 0.205, 0);
  mesh.castShadow = false;
  mesh.userData.noShadow = true;
  return mesh;
}

/**
 * Create the rigged, skinned 3D trail runner character with lazy GLB loading.
 * @param {string} [assetsBase='./']
 */
export function createRunnerCharacter(assetsBase = './') {
  const root = new THREE.Group();
  root.name = 'trail-runner';

  // Soft contact blob shadow (shown on low tier when real shadow maps are off)
  const blobGeo = new THREE.CircleGeometry(0.46, 16);
  blobGeo.rotateX(-Math.PI / 2);
  const blobMat = new THREE.MeshBasicMaterial({
    color: 0x0b1016,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  const blobShadow = new THREE.Mesh(blobGeo, blobMat);
  blobShadow.position.y = 0.03;
  blobShadow.userData.noShadow = true;
  root.add(blobShadow);

  // Lightweight single-mesh placeholder shown only while runner.glb streams in lazily
  const placeholder = buildPlaceholder();
  root.add(placeholder);

  // Model pivot rotated PI around Y so +Z GLB faces local -Z matching cameraRig
  const modelPivot = new THREE.Group();
  modelPivot.name = 'runner-rig-pivot';
  modelPivot.rotation.y = Math.PI;
  modelPivot.visible = false;
  root.add(modelPivot);

  let loadStarted = false;
  let loaded = false;
  let disposed = false;
  let shadowsEnabledState = true;
  let mixer = null;
  let actions = {};
  let bones = {};
  let lampLensMat = null;
  let gltfScene = null;
  let vestMesh = null;
  let headCapMesh = null;
  let ponytailMesh = null;
  let bodyMaterial = null;
  let origBodyMap = null;
  let origBodyPixels = null; // { width, height, data: Uint8ClampedArray }
  let tintCanvas = null;
  let tintCtx = null;
  let tintedBodyTex = null;
  let activeKit = { ...FALLBACK_KIT, buildScale: [...FALLBACK_KIT.buildScale] };
  let currentScaleY = 1.0;

  // Smooth locomotion blend weights
  const weights = {
    idle: 1,
    walk: 0,
    jog: 0,
    sprint: 0,
    powerHike: 0,
    jump: 0,
    fall: 0,
    getup: 0,
    ceremony: 0,
  };

  let wasFallen = false;
  let getupTimer = 0;
  let wasAirborne = false;
  let jumpLandTimer = 0;
  let smoothGrade = 0;
  let smoothPowerHike = 0;
  let pelvisOffsetY = 0;
  let currentVisualHeight = 1.74;
  let idleTime = 0;
  let strideClock = 0;
  const footMeasureL = { soleY: 0, heelX: 0, heelZ: 0, ballX: 0, ballZ: 0 };
  const footMeasureR = { soleY: 0, heelX: 0, heelZ: 0, ballX: 0, ballZ: 0 };

  function applyShadowSetting() {
    blobShadow.visible = !shadowsEnabledState;
    root.traverse((obj) => {
      if (obj.isMesh && !obj.userData?.noShadow) {
        obj.castShadow = Boolean(shadowsEnabledState);
        obj.receiveShadow = false;
      }
    });
  }

  function replaceMeshGeometry(mesh, nextGeo) {
    if (!mesh || !nextGeo) return;
    const prev = mesh.geometry;
    mesh.geometry = nextGeo;
    if (prev && prev !== nextGeo) prev.dispose();
  }

  function initBodyTextureCache(mat) {
    if (!mat?.map?.image || typeof document === 'undefined') return;
    bodyMaterial = mat;
    origBodyMap = mat.map;
    const img = origBodyMap.image;
    const w = img.naturalWidth || img.width || 512;
    const h = img.naturalHeight || img.height || 512;
    if (!w || !h) return;

    tintCanvas = document.createElement('canvas');
    tintCanvas.width = w;
    tintCanvas.height = h;
    tintCtx = tintCanvas.getContext('2d', { willReadFrequently: true });
    if (!tintCtx) return;
    tintCtx.drawImage(img, 0, 0, w, h);
    const snap = tintCtx.getImageData(0, 0, w, h);
    origBodyPixels = { width: w, height: h, data: new Uint8ClampedArray(snap.data) };

    tintedBodyTex = new THREE.CanvasTexture(tintCanvas);
    tintedBodyTex.flipY = origBodyMap.flipY;
    tintedBodyTex.colorSpace = origBodyMap.colorSpace;
    tintedBodyTex.wrapS = origBodyMap.wrapS;
    tintedBodyTex.wrapT = origBodyMap.wrapT;
    tintedBodyTex.anisotropy = origBodyMap.anisotropy;
    bodyMaterial.map = tintedBodyTex;
    bodyMaterial.needsUpdate = true;
  }

  function updateTintedBodyTexture(kit) {
    if (!origBodyPixels || !tintCtx || !tintedBodyTex) return;
    const { width, height, data: src } = origBodyPixels;
    const imgData = tintCtx.createImageData(width, height);
    const dst = imgData.data;

    const jHex = kit.jerseyHex ?? FALLBACK_KIT.jerseyHex;
    const jR = (jHex >> 16) & 255;
    const jG = (jHex >> 8) & 255;
    const jB = jHex & 255;

    const sHex = kit.shortsHex ?? FALLBACK_KIT.shortsHex;
    const sR = (sHex >> 16) & 255;
    const sG = (sHex >> 8) & 255;
    const sB = sHex & 255;

    const aHex = kit.accentHex ?? FALLBACK_KIT.accentHex;
    const aR = (aHex >> 16) & 255;
    const aG = (aHex >> 8) & 255;
    const aB = aHex & 255;

    for (let i = 0; i < src.length; i += 4) {
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      const a = src[i + 3];

      // Coral/terracotta jersey pixels (clearly distinct from peach skin where b > 105 & r/g ~ 1.33)
      if (r > 68 && r > 1.35 * g && r > 1.5 * b && b < 95) {
        const lum = clamp((0.299 * r + 0.587 * g + 0.114 * b) / 98, 0.35, 1.35);
        dst[i] = clamp(Math.round(jR * lum), 0, 255);
        dst[i + 1] = clamp(Math.round(jG * lum), 0, 255);
        dst[i + 2] = clamp(Math.round(jB * lum), 0, 255);
      } else if (b > 110 && b > r * 1.35 && b > g * 1.15) {
        // Blue shoe upper accents -> blend toward runner accent color
        const lum = clamp((0.299 * r + 0.587 * g + 0.114 * b) / 118, 0.45, 1.3);
        dst[i] = clamp(Math.round(aR * lum), 0, 255);
        dst[i + 1] = clamp(Math.round(aG * lum), 0, 255);
        dst[i + 2] = clamp(Math.round(aB * lum), 0, 255);
      } else if (r < 62 && g < 68 && b < 78 && b >= r - 2 && (r + g + b) > 40) {
        // Cool dark charcoal shorts -> subtle re-tint toward kit shortsHex preserving folds
        const lum = clamp((0.299 * r + 0.587 * g + 0.114 * b) / 34, 0.55, 1.45);
        dst[i] = clamp(Math.round(sR * lum), 0, 255);
        dst[i + 1] = clamp(Math.round(sG * lum), 0, 255);
        dst[i + 2] = clamp(Math.round(sB * lum), 0, 255);
      } else {
        dst[i] = r;
        dst[i + 1] = g;
        dst[i + 2] = b;
      }
      dst[i + 3] = a;
    }

    tintCtx.putImageData(imgData, 0, 0);
    tintedBodyTex.needsUpdate = true;
  }

  function applyAppearanceToMeshes() {
    const kit = activeKit;
    const sc = Array.isArray(kit.buildScale) && kit.buildScale.length === 3
      ? kit.buildScale
      : FALLBACK_KIT.buildScale;
    const sx = clamp(Number(sc[0]) || 1, 0.85, 1.12);
    const sy = clamp(Number(sc[1]) || 1, 0.88, 1.12);
    const sz = clamp(Number(sc[2]) || 1, 0.85, 1.12);
    currentScaleY = sy;

    modelPivot.scale.set(sx, sy, sz);
    placeholder.scale.set(sx, sy, sz);
    replaceMeshGeometry(placeholder, buildPlaceholderGeo(kit));

    if (vestMesh) {
      replaceMeshGeometry(vestMesh, buildHydrationVestGeo(kit));
    }
    if (headCapMesh) {
      replaceMeshGeometry(headCapMesh, buildHeadCapGeo(kit));
    }
    if (ponytailMesh) {
      ponytailMesh.visible = kit.hairStyle === 'ponytail';
      ponytailMesh.material.color.setHex(kit.hairHex ?? FALLBACK_KIT.hairHex);
    }
    if (loaded) {
      updateTintedBodyTexture(kit);
    }
    applyShadowSetting();
  }

  function setAppearance(kit) {
    if (!kit || typeof kit !== 'object' || disposed) return;
    activeKit = {
      ...FALLBACK_KIT,
      ...kit,
      buildScale: Array.isArray(kit.buildScale) && kit.buildScale.length === 3
        ? [...kit.buildScale]
        : [...FALLBACK_KIT.buildScale],
    };
    applyAppearanceToMeshes();
  }

  function applyActionWeight(act, weight, timeScale = null) {
    if (!act) return;
    if (weight < 0.002) {
      if (act.enabled || act.getEffectiveWeight() !== 0) {
        act.setEffectiveWeight(0);
        act.enabled = false;
      }
      return;
    }
    if (!act.enabled) act.enabled = true;
    act.setEffectiveWeight(weight);
    if (timeScale !== null) act.setEffectiveTimeScale(timeScale);
  }

  function ensureLoaded() {
    if (loadStarted || disposed) return;
    loadStarted = true;

    const base = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;
    const url = `${base}assets/game/runner.glb`;
    const loader = new GLTFLoader();

    loader.load(
      url,
      (gltf) => {
        if (disposed) {
          disposeScene(gltf.scene);
          return;
        }
        gltfScene = gltf.scene;

        // Ensure SkinnedMesh never flickers/culls near camera & map key bones
        let bodyMatCandidate = null;
        gltfScene.traverse((obj) => {
          if (obj.isSkinnedMesh || obj.isMesh) {
            obj.frustumCulled = false;
            obj.castShadow = Boolean(shadowsEnabledState);
            if (obj.material) {
              obj.material.envMapIntensity = 0.65;
              if (obj.name === 'SuperHero_Male' || obj.material.name === 'MI_Superhero_Male') {
                bodyMatCandidate = obj.material;
              }
            }
          }
          if (obj.isBone) {
            bones[obj.name] = obj;
          }
        });

        if (bodyMatCandidate) {
          initBodyTextureCache(bodyMatCandidate);
        }

        // Attach merged trail-running gear directly to skeleton bones
        vestMesh = buildHydrationVest(activeKit);
        if (bones.spine_03) {
          bones.spine_03.add(vestMesh);
        } else if (bones.spine_02) {
          bones.spine_02.add(vestMesh);
        }

        if (bones.Head) {
          const hg = buildHeadGear(activeKit);
          headCapMesh = hg.staticMesh;
          ponytailMesh = hg.ponytailMesh;
          lampLensMat = hg.lampLensMat;
          bones.Head.add(hg.gear);
        }

        if (bones.lowerarm_l) {
          bones.lowerarm_l.add(buildGpsWatch());
        }

        modelPivot.add(gltfScene);

        // Configure AnimationMixer and all 11 UAL1 clips (inactive clips start disabled)
        mixer = new THREE.AnimationMixer(gltfScene);
        const byName = new Map(gltf.animations.map((c) => [c.name, c]));

        const setupLoop = (key, clipName) => {
          const clip = byName.get(clipName);
          if (!clip) return;
          const act = mixer.clipAction(clip);
          act.setLoop(THREE.LoopRepeat, Infinity);
          act.play();
          const isInit = key === 'idle';
          act.enabled = isInit;
          act.setEffectiveWeight(isInit ? 1 : 0);
          actions[key] = act;
        };

        const setupOnce = (key, clipName) => {
          const clip = byName.get(clipName);
          if (!clip) return;
          const act = mixer.clipAction(clip);
          act.setLoop(THREE.LoopOnce, 1);
          act.clampWhenFinished = true;
          act.play();
          act.enabled = false;
          act.setEffectiveWeight(0);
          actions[key] = act;
        };

        setupLoop('idle', 'Idle_Loop');
        setupLoop('walk', 'Walk_Loop');
        setupLoop('jog', 'Jog_Fwd_Loop');
        setupLoop('sprint', 'Sprint_Loop');
        setupLoop('powerHike', 'Crouch_Fwd_Loop');
        setupLoop('jumpLoop', 'Jump_Loop');
        setupLoop('ceremony', 'Fixing_Kneeling');

        setupOnce('jumpStart', 'Jump_Start');
        setupOnce('jumpLand', 'Jump_Land');
        setupOnce('fall', 'Death01');
        setupOnce('getup', 'Roll');

        loaded = true;
        placeholder.visible = false;
        modelPivot.visible = true;
        applyAppearanceToMeshes();
      },
      undefined,
      (err) => {
        console.warn('[runner] Failed to load runner.glb, keeping placeholder:', err);
      }
    );
  }

  function setShadowsEnabled(enabled) {
    shadowsEnabledState = Boolean(enabled);
    applyShadowSetting();
  }

  function updatePose(dt, params) {
    const {
      speedMs = 0,
      grade = 0,
      gait = 'idle',
      isStumbling = false,
      isFallen = false,
      isAirborne = false,
      isKissingRock = false,
      nightMode = false,
      visible = true,
      allowHeadlamp = true,
      getGroundY = null,
      terrainNormal = null,
      heading = root.rotation.y,
      snapGround = false,
    } = params;

    root.visible = visible;
    idleTime += dt;

    // Kick off lazy load once runner is actually needed in a run
    if (visible && !loadStarted) {
      ensureLoaded();
    }

    // Headlamp emissive lens glow at dusk/night
    if (lampLensMat) {
      lampLensMat.emissiveIntensity = nightMode && allowHeadlamp ? 3.2 : 0.0;
    }

    // Align low-tier contact blob shadow flush to sloped terrain
    if (blobShadow.visible) {
      if (terrainNormal && Number.isFinite(terrainNormal.y)) {
        const cosH = Math.cos(heading);
        const sinH = Math.sin(heading);
        _vNorm.set(
          terrainNormal.x * cosH - terrainNormal.z * sinH,
          Math.max(0.15, terrainNormal.y),
          terrainNormal.x * sinH + terrainNormal.z * cosH
        ).normalize();
        blobShadow.quaternion.setFromUnitVectors(_vUp, _vNorm);
        blobShadow.position.set(_vNorm.x * 0.04, _vNorm.y * 0.04, _vNorm.z * 0.04);
      } else {
        blobShadow.quaternion.identity();
        blobShadow.position.set(0, 0.03, 0);
      }
    }

    // Estimate first-person stride bob even when model hidden in 1st person
    const moving = speedMs > 0.15 && !isFallen && !isKissingRock && !isAirborne;
    if (moving) {
      const cadence = clamp(1.4 + speedMs * 0.52, 1.5, 3.5);
      strideClock = (strideClock + dt * cadence * Math.PI * 2) % (Math.PI * 2);
    }
    const fpBounce = moving ? Math.abs(Math.sin(strideClock)) * clamp(speedMs / 4.5, 0.25, 1) * 0.065 : 0;

    if (!visible) {
      currentVisualHeight = isFallen ? 0.55 : isKissingRock ? 1.25 : 1.74;
      return fpBounce;
    }

    // Simple subtle bob on placeholder while GLB is streaming
    if (!loaded || !mixer) {
      placeholder.position.y = fpBounce * 0.8;
      placeholder.rotation.x = clamp(-grade * 0.4, -0.25, 0.25);
      currentVisualHeight = 1.78;
      return fpBounce;
    }

    const safeDt = Math.min(0.06, Math.max(0, dt));
    const gradeRate = snapGround ? 1 : Math.min(1, safeDt * 8);
    smoothGrade = lerp(smoothGrade, clamp(grade, -0.75, 0.85), gradeRate);
    const targetPowerHike = gait === 'power-hike' && !isFallen && !isKissingRock && !isAirborne && speedMs >= 0.12 ? 1 : 0;
    smoothPowerHike = lerp(smoothPowerHike, targetPowerHike, gradeRate);

    // Fall / Get-up state transitions
    if (isFallen && !wasFallen) {
      if (actions.fall) {
        actions.fall.enabled = true;
        actions.fall.reset();
        actions.fall.setEffectiveTimeScale(1.35);
        actions.fall.play();
      }
      getupTimer = 0;
    } else if (!isFallen && wasFallen) {
      getupTimer = 0.72;
      if (actions.getup) {
        actions.getup.enabled = true;
        actions.getup.reset();
        actions.getup.setEffectiveTimeScale(1.65);
        actions.getup.play();
      }
    }
    wasFallen = isFallen;
    if (getupTimer > 0) getupTimer = Math.max(0, getupTimer - safeDt);

    // Jump transitions
    if (isAirborne && !wasAirborne) {
      if (actions.jumpStart) {
        actions.jumpStart.enabled = true;
        actions.jumpStart.reset();
        actions.jumpStart.setEffectiveTimeScale(1.4);
        actions.jumpStart.play();
      }
      jumpLandTimer = 0;
    } else if (!isAirborne && wasAirborne) {
      jumpLandTimer = 0.22;
      if (actions.jumpLand) {
        actions.jumpLand.enabled = true;
        actions.jumpLand.reset();
        actions.jumpLand.setEffectiveTimeScale(1.6);
        actions.jumpLand.play();
      }
    }
    wasAirborne = isAirborne;
    if (jumpLandTimer > 0) jumpLandTimer = Math.max(0, jumpLandTimer - safeDt);

    // Compute normalized locomotion & action target weights.
    // Note: power-hike drives full upright Walk_Loop + procedural uphill torso lean + 2-bone
    // slope leg IK (never blending Crouch_Fwd_Loop with Walk_Loop, which drops the pelvis
    // while keeping straight legs and buries shoes ~9cm into the ground).
    let tIdle = 0;
    let tWalk = 0;
    let tJog = 0;
    let tSprint = 0;
    const tPowerHike = 0;
    let tJump = 0;
    let tFall = 0;
    let tGetup = 0;
    let tCeremony = 0;

    if (isKissingRock) {
      tCeremony = 1;
    } else if (isFallen) {
      tFall = 1;
    } else if (getupTimer > 0) {
      tGetup = 1;
    } else if (isAirborne) {
      tJump = 1;
    } else if (speedMs < 0.12) {
      tIdle = 1;
    } else if (gait === 'power-hike') {
      tWalk = 1;
    } else if (gait === 'walk' || gait === 'hike' || speedMs < 1.95) {
      const f = clamp((speedMs - 1.35) / 0.85, 0, 1);
      tWalk = 1 - f * 0.35;
      tJog = f * 0.35;
      if (gait === 'walk' || gait === 'hike') {
        tWalk = 1;
        tJog = 0;
      }
    } else if (gait === 'sprint' || speedMs >= 4.0) {
      const f = clamp((speedMs - 3.3) / 1.1, 0, 1);
      tJog = 1 - f;
      tSprint = f;
    } else {
      if (speedMs < 2.2) {
        const f = clamp((speedMs - 1.2) / 1.0, 0, 1);
        tWalk = 1 - f;
        tJog = f;
      } else if (speedMs < 3.6) {
        tJog = 1;
      } else {
        const f = clamp((speedMs - 3.6) / 1.2, 0, 1);
        tJog = 1 - f;
        tSprint = f;
      }
    }

    const blend = snapGround ? 1 : Math.min(1, safeDt * 10);
    const snapZero = (cur, tgt, rate) => {
      const v = lerp(cur, tgt, rate);
      return tgt === 0 && v < 0.002 ? 0 : v;
    };
    weights.idle = snapZero(weights.idle, tIdle, blend);
    weights.walk = snapZero(weights.walk, tWalk, blend);
    weights.jog = snapZero(weights.jog, tJog, blend);
    weights.sprint = snapZero(weights.sprint, tSprint, blend);
    weights.powerHike = snapZero(weights.powerHike, tPowerHike, blend);
    weights.jump = snapZero(weights.jump, tJump, Math.min(1, safeDt * 14));
    weights.fall = snapZero(weights.fall, tFall, Math.min(1, safeDt * 12));
    weights.getup = snapZero(weights.getup, tGetup, Math.min(1, safeDt * 12));
    weights.ceremony = snapZero(weights.ceremony, tCeremony, Math.min(1, safeDt * 6));

    // Match clip playback rates directly to ground speed & disable zero-weight clips
    const effectiveSpeed = Math.max(0.4, speedMs);
    const walkNatural = lerp(NATURAL_SPEEDS.walk, NATURAL_SPEEDS.walk * 0.85, smoothPowerHike);
    applyActionWeight(actions.idle, weights.idle, 1.0);
    applyActionWeight(actions.walk, weights.walk, clamp(effectiveSpeed / walkNatural, 0.55, 1.55));
    applyActionWeight(actions.powerHike, weights.powerHike, clamp(effectiveSpeed / NATURAL_SPEEDS.crouch, 0.6, 1.6));
    applyActionWeight(actions.jog, weights.jog, clamp(effectiveSpeed / NATURAL_SPEEDS.jog, 0.65, 1.45));
    applyActionWeight(actions.sprint, weights.sprint, clamp(effectiveSpeed / NATURAL_SPEEDS.sprint, 0.72, 1.35));
    applyActionWeight(actions.jumpLoop, weights.jump);
    applyActionWeight(actions.jumpStart, isAirborne ? weights.jump * 0.45 : 0);
    applyActionWeight(actions.jumpLand, jumpLandTimer > 0 ? clamp(jumpLandTimer / 0.22, 0, 0.85) : 0);
    applyActionWeight(actions.fall, weights.fall);
    applyActionWeight(actions.getup, weights.getup);
    applyActionWeight(actions.ceremony, weights.ceremony);

    mixer.update(safeDt);

    // Post-mixer procedural bone overlays: slope lean, uphill power-hike posture, stumble wobble, head stabilization
    const uprightMask = Math.max(0, 1 - weights.fall - weights.getup - weights.ceremony);
    if (uprightMask > 0.05) {
      const moveMask = clamp(speedMs / 0.65, 0, 1) * uprightMask;
      const slopePitch = clamp(smoothGrade * 0.58, -0.20, 0.42) * moveMask;
      const phExtra = smoothPowerHike * clamp(0.18 + Math.max(0, smoothGrade) * 0.25, 0.18, 0.34) * uprightMask;
      const stumbleZ = isStumbling ? Math.sin(idleTime * 22) * 0.22 : 0;

      if (bones.spine_01) {
        bones.spine_01.rotation.x += (slopePitch + phExtra) * 0.48;
        bones.spine_01.rotation.z += stumbleZ * 0.5;
      }
      if (bones.spine_02) {
        bones.spine_02.rotation.x += (slopePitch + phExtra) * 0.52;
        bones.spine_02.rotation.z += stumbleZ * 0.5;
      }
      if (bones.Head) {
        bones.Head.rotation.x -= (slopePitch + phExtra) * 0.72;
      }
    }

    // Reset pivot before exact steep-slope grounding & 2-bone analytical leg IK
    modelPivot.position.y = 0;
    modelPivot.quaternion.copy(_qBasePivot);

    const hasLegBones = Boolean(
      bones.thigh_l && bones.calf_l && bones.foot_l &&
      bones.thigh_r && bones.calf_r && bones.foot_r
    );

    if (typeof getGroundY === 'function' && hasLegBones) {
      const rootY = root.position.y;
      const fwdX = -Math.sin(heading);
      const fwdZ = -Math.cos(heading);
      const rightX = Math.cos(heading);
      const rightZ = -Math.sin(heading);

      if (isFallen || isKissingRock || weights.fall > 0.35 || weights.ceremony > 0.35) {
        // Align fallen/kneeling body gently to terrain normal so torso & limbs rest ON the hillside
        if (terrainNormal && Number.isFinite(terrainNormal.y)) {
          const cosH = Math.cos(heading);
          const sinH = Math.sin(heading);
          _vNorm.set(
            terrainNormal.x * cosH - terrainNormal.z * sinH,
            Math.max(0.25, terrainNormal.y),
            terrainNormal.x * sinH + terrainNormal.z * cosH
          ).normalize();
          _qSlope.setFromUnitVectors(_vUp, _vNorm);
          modelPivot.quaternion.copy(_qSlope).multiply(_qBasePivot);
        }
        root.updateMatrixWorld(true);
        measureFootSole(bones.foot_l, bones.ball_l, bones.ball_leaf_l, footMeasureL, currentScaleY);
        measureFootSole(bones.foot_r, bones.ball_r, bones.ball_leaf_r, footMeasureR, currentScaleY);
        const gL = Math.max(
          getGroundY(footMeasureL.heelX, footMeasureL.heelZ),
          getGroundY(footMeasureL.ballX, footMeasureL.ballZ)
        );
        const gR = Math.max(
          getGroundY(footMeasureR.heelX, footMeasureR.heelZ),
          getGroundY(footMeasureR.ballX, footMeasureR.ballZ)
        );
        let maxPen = Math.max(0, gL - footMeasureL.soleY, gR - footMeasureR.soleY);
        if (bones.pelvis) {
          bones.pelvis.getWorldPosition(_vTmp);
          const gPelvis = getGroundY(_vTmp.x, _vTmp.z);
          maxPen = Math.max(maxPen, gPelvis + 0.08 - _vTmp.y);
        }
        pelvisOffsetY = clamp(maxPen + 0.015, 0, 0.55);
        modelPivot.position.y = pelvisOffsetY;
        root.updateMatrixWorld(true);
      } else {
        // Step 1: Measure animated feet at neutral pivot (y=0) to extract natural swing lift
        root.updateMatrixWorld(true);
        measureFootSole(bones.foot_l, bones.ball_l, bones.ball_leaf_l, footMeasureL, currentScaleY);
        measureFootSole(bones.foot_r, bones.ball_r, bones.ball_leaf_r, footMeasureR, currentScaleY);

        const animLiftL = Math.max(0, footMeasureL.soleY - rootY);
        const animLiftR = Math.max(0, footMeasureR.soleY - rootY);

        // Sample exact terrain height at BOTH heel & forefoot so neither clips into convex/steep terrain
        const gL = Math.max(
          getGroundY(footMeasureL.heelX, footMeasureL.heelZ),
          getGroundY(footMeasureL.ballX, footMeasureL.ballZ)
        );
        const gR = Math.max(
          getGroundY(footMeasureR.heelX, footMeasureR.heelZ),
          getGroundY(footMeasureR.ballX, footMeasureR.ballZ)
        );

        // Step 2: Shift pelvis down toward the lower stance foot on steep grades so the downhill
        // leg reaches the slope naturally while the uphill knee flexes up onto the higher ground.
        const targetPelvisY = isAirborne
          ? 0
          : clamp(Math.min(gL, gR) - rootY, -0.28, 0.14);
        const pelvisRate = snapGround ? 1 : Math.min(1, safeDt * 18);
        pelvisOffsetY = lerp(pelvisOffsetY, targetPelvisY, pelvisRate);
        modelPivot.position.y = pelvisOffsetY;
        root.updateMatrixWorld(true);

        // Step 3: Solve per-leg 2-bone analytical IK to lock stance soles to gL/gR and lift swing feet over uphill terrain
        if (!isAirborne && weights.getup < 0.25) {
          measureFootSole(bones.foot_l, bones.ball_l, bones.ball_leaf_l, footMeasureL, currentScaleY);
          measureFootSole(bones.foot_r, bones.ball_r, bones.ball_leaf_r, footMeasureR, currentScaleY);

          const deltaL = clamp((gL + animLiftL) - footMeasureL.soleY, -0.36, 0.50);
          const deltaR = clamp((gR + animLiftR) - footMeasureR.soleY, -0.36, 0.50);

          const groundPitch = terrainNormal && Number.isFinite(terrainNormal.y) && terrainNormal.y > 0.1
            ? Math.atan2(-(terrainNormal.x * fwdX + terrainNormal.z * fwdZ), terrainNormal.y)
            : Math.atan(smoothGrade);
          const baseFootPitch = clamp(groundPitch * 0.65, -0.42, 0.48);
          const pitchL = baseFootPitch * clamp(1 - animLiftL / 0.12, 0.15, 1);
          const pitchR = baseFootPitch * clamp(1 - animLiftR / 0.12, 0.15, 1);

          solveTwoBoneLegIK(bones.thigh_l, bones.calf_l, bones.foot_l, deltaL, fwdX, fwdZ, rightX, rightZ, pitchL);
          solveTwoBoneLegIK(bones.thigh_r, bones.calf_r, bones.foot_r, deltaR, fwdX, fwdZ, rightX, rightZ, pitchR);
        }

        // Step 4: Guaranteed zero-penetration safety floor clamp (covers extreme >70% kinks & airborne uphill landings)
        measureFootSole(bones.foot_l, bones.ball_l, bones.ball_leaf_l, footMeasureL, currentScaleY);
        measureFootSole(bones.foot_r, bones.ball_r, bones.ball_leaf_r, footMeasureR, currentScaleY);
        const maxPen = Math.max(0, gL - footMeasureL.soleY, gR - footMeasureR.soleY);
        if (maxPen > 0.001) {
          modelPivot.position.y += Math.min(0.45, maxPen);
          root.updateMatrixWorld(true);
        }
      }
    } else {
      modelPivot.position.y = 0.025 * currentScaleY;
      root.updateMatrixWorld(true);
    }

    // Track exact visual head-top height relative to root.position.y for UI screen-bbox occlusion guard
    if (bones.Head) {
      bones.Head.getWorldPosition(_vTmp);
      currentVisualHeight = clamp((_vTmp.y + 0.24 * currentScaleY) - root.position.y, 0.55, 2.05);
    } else {
      currentVisualHeight = (isFallen ? 0.55 : isKissingRock ? 1.25 : 1.74) * currentScaleY;
    }

    return fpBounce;
  }

  function disposeScene(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
            if (m[k]) m[k].dispose();
          }
          m.dispose();
        }
      }
    });
  }

  return {
    root,
    ensureLoaded,
    isLoaded: () => loaded,
    getVisualHeight: () => currentVisualHeight,
    setAppearance,
    updatePose,
    setShadowsEnabled,
    dispose() {
      disposed = true;
      if (mixer) {
        mixer.stopAllAction();
        if (gltfScene) mixer.uncacheRoot(gltfScene);
      }
      if (origBodyMap && origBodyMap !== bodyMaterial?.map) {
        origBodyMap.dispose();
      }
      origBodyMap = null;
      tintedBodyTex = null;
      origBodyPixels = null;
      tintCanvas = null;
      tintCtx = null;
      disposeScene(root);
    },
  };
}

/**
 * Create the iconic Hardrock 100 painted finish boulder ("Kiss the Hardrock").
 */
export function createHardrockMonument() {
  const group = new THREE.Group();
  group.name = 'hardrock-finish-stone';

  const baseMat = new THREE.MeshStandardMaterial({ color: 0x6f6861, roughness: 0.92 });
  const rockGeo = new THREE.DodecahedronGeometry(0.85, 1);
  const rock = new THREE.Mesh(rockGeo, baseMat);
  rock.scale.set(1.2, 0.85, 1.0);
  rock.position.y = 0.62;
  rock.castShadow = true;
  rock.receiveShadow = true;
  group.add(rock);

  const plaqueGeo = new THREE.CylinderGeometry(0.32, 0.34, 0.08, 12);
  const plaqueMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5, metalness: 0.3 });
  const plaque = new THREE.Mesh(plaqueGeo, plaqueMat);
  plaque.position.set(0, 1.24, 0);
  group.add(plaque);

  return group;
}
