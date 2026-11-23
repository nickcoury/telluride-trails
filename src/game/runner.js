// Articulated 3D trail runner character + procedural locomotion blender
// (idle, walk, hike, power-hike with hands-on-knees, run, sprint, stumble, fall, kiss-the-rock).
// Character faces local -Z so rotation.y = heading aligns with core/camera.js.

import * as THREE from 'three';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

function makeCapsuleLimb(radiusTop, radiusBottom, length, mat) {
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 8);
  geo.translate(0, -length * 0.5, 0);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/**
 * Create the 3D trail runner rig.
 */
export function createRunnerCharacter() {
  const root = new THREE.Group();
  root.name = 'trail-runner';

  // Soft contact blob shadow (for low quality tier without shadow maps)
  const blobGeo = new THREE.CircleGeometry(0.45, 16);
  blobGeo.rotateX(-Math.PI / 2);
  const blobMat = new THREE.MeshBasicMaterial({
    color: 0x0b1016,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const blobShadow = new THREE.Mesh(blobGeo, blobMat);
  blobShadow.position.y = 0.03;
  root.add(blobShadow);

  // Materials (mountain runner palette: coral-orange tech tee, slate shorts, cobalt vest, bright shoes)
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xdba988, roughness: 0.72 });
  const shirtMat = new THREE.MeshStandardMaterial({ color: 0xe85a2b, roughness: 0.75 });
  const shortsMat = new THREE.MeshStandardMaterial({ color: 0x222933, roughness: 0.85 });
  const vestMat = new THREE.MeshStandardMaterial({ color: 0x1d4e6b, roughness: 0.7 });
  const flaskMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.35 });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0xf43f5e, roughness: 0.55 });
  const soleMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, roughness: 0.65 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x2b6cb0, roughness: 0.75 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.2, metalness: 0.6 });
  const watchMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x10b981, emissiveIntensity: 0.4 });
  const lampBodyMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.4 });
  const lampLensMat = new THREE.MeshStandardMaterial({ color: 0xfffbeb, emissive: 0xfef08a, emissiveIntensity: 0.0 });

  // Pelvis / Hips (origin ~0.92m above ground)
  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const pelvisMesh = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.20), shortsMat);
  pelvisMesh.castShadow = true;
  hips.add(pelvisMesh);

  // Torso
  const torso = new THREE.Group();
  torso.position.y = 0.08;
  hips.add(torso);

  const chestMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.14, 0.44, 10), shirtMat);
  chestMesh.scale.set(1.12, 1, 0.78);
  chestMesh.position.y = 0.22;
  chestMesh.castShadow = true;
  torso.add(chestMesh);

  // Hydration vest + back pack + 2 front soft flasks
  const vestBack = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.10), vestMat);
  vestBack.position.set(0, 0.23, 0.12);
  vestBack.castShadow = true;
  torso.add(vestBack);

  for (const side of [-1, 1]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.05), vestMat);
    strap.position.set(side * 0.095, 0.24, -0.105);
    torso.add(strap);

    const flask = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.022, 0.14, 8), flaskMat);
    flask.position.set(side * 0.095, 0.20, -0.13);
    torso.add(flask);
  }

  // Head + Trucker Cap + Sunglasses + Headlamp
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.48, 0);
  torso.add(headGroup);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 8), skinMat);
  neck.position.y = 0.02;
  headGroup.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), skinMat);
  head.position.y = 0.14;
  head.scale.set(0.92, 1.06, 0.98);
  head.castShadow = true;
  headGroup.add(head);

  const capCrown = new THREE.Mesh(new THREE.SphereGeometry(0.121, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.54), capMat);
  capCrown.position.y = 0.155;
  capCrown.rotation.x = 0.12;
  headGroup.add(capCrown);

  const capBrim = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.015, 0.12), capMat);
  capBrim.position.set(0, 0.195, -0.115);
  capBrim.rotation.x = 0.12;
  headGroup.add(capBrim);

  const shades = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.036, 0.04), glassMat);
  shades.position.set(0, 0.155, -0.098);
  headGroup.add(shades);

  // Headlamp
  const headlamp = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.03), lampBodyMat);
  headlamp.position.set(0, 0.225, -0.115);
  headGroup.add(headlamp);

  const lampLens = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.015, 8), lampLensMat);
  lampLens.rotation.x = Math.PI / 2;
  lampLens.position.set(0, 0.225, -0.13);
  headGroup.add(lampLens);

  const headlampLight = new THREE.SpotLight(0xfff7dc, 0, 42, Math.PI * 0.24, 0.55, 1.4);
  headlampLight.position.set(0, 0.225, -0.14);
  const headlampTarget = new THREE.Object3D();
  headlampTarget.position.set(0, -0.6, -12);
  headGroup.add(headlampLight);
  headGroup.add(headlampTarget);
  headlampLight.target = headlampTarget;

  // Arms
  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.21, 0.40, 0);
    torso.add(shoulder);

    const upper = makeCapsuleLimb(0.046, 0.038, 0.27, skinMat);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.054, 0.049, 0.12, 8), shirtMat);
    sleeve.position.y = -0.055;
    upper.add(sleeve);
    shoulder.add(upper);

    const elbow = new THREE.Group();
    elbow.position.y = -0.27;
    shoulder.add(elbow);

    const fore = makeCapsuleLimb(0.036, 0.028, 0.24, skinMat);
    elbow.add(fore);

    if (side < 0) {
      const watch = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.032, 0.068), watchMat);
      watch.position.y = -0.19;
      elbow.add(watch);
    }

    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.034, 8, 6), skinMat);
    hand.position.y = -0.255;
    elbow.add(hand);

    return { shoulder, elbow };
  }

  const armL = makeArm(-1);
  const armR = makeArm(1);

  // Legs
  function makeLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.10, -0.04, 0);
    hips.add(hip);

    const thigh = makeCapsuleLimb(0.072, 0.054, 0.42, skinMat);
    const shortLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.079, 0.072, 0.21, 8), shortsMat);
    shortLeg.position.y = -0.10;
    thigh.add(shortLeg);
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);

    const calf = makeCapsuleLimb(0.050, 0.034, 0.40, skinMat);
    knee.add(calf);

    const ankle = new THREE.Group();
    ankle.position.y = -0.40;
    knee.add(ankle);

    // Trail shoe facing -Z
    const shoeUpper = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.068, 0.23), shoeMat);
    shoeUpper.position.set(0, -0.025, -0.045);
    shoeUpper.castShadow = true;
    ankle.add(shoeUpper);

    const shoeSole = new THREE.Mesh(new THREE.BoxGeometry(0.098, 0.032, 0.245), soleMat);
    shoeSole.position.set(0, -0.062, -0.045);
    ankle.add(shoeSole);

    return { hip, knee, ankle };
  }

  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // Animation state
  let stridePhase = 0;
  let powerHikeWeight = 0;
  let runWeight = 0;
  let sprintWeight = 0;
  let fallPose = 0;
  let kissPose = 0;
  let idleTime = 0;

  function setShadowsEnabled(enabled) {
    blobShadow.visible = !enabled;
    root.traverse((obj) => {
      if (obj.isMesh && obj !== blobShadow) {
        obj.castShadow = Boolean(enabled);
      }
    });
  }

  function updatePose(dt, params) {
    const {
      speedMs = 0,
      grade = 0,
      gait = 'idle',
      isStumbling = false,
      isFallen = false,
      isKissingRock = false,
      nightMode = false,
      visible = true,
      allowHeadlamp = true,
    } = params;

    root.visible = visible;
    idleTime += dt;

    // Headlamp toggle at night
    const lampOn = Boolean(nightMode && allowHeadlamp);
    headlampLight.intensity = lampOn ? 3.2 : 0;
    lampLensMat.emissiveIntensity = lampOn ? 2.5 : 0;

    if (!visible) return 0;

    // Target blend weights
    const targetPH = gait === 'power-hike' ? 1 : 0;
    const targetSprint = gait === 'sprint' ? 1 : 0;
    const targetRun = gait === 'run' || gait === 'sprint' ? 1 : 0;
    const targetFall = isFallen ? 1 : 0;
    const targetKiss = isKissingRock ? 1 : 0;

    const blendRate = Math.min(1, dt * 8.5);
    powerHikeWeight = lerp(powerHikeWeight, targetPH, blendRate);
    runWeight = lerp(runWeight, targetRun, blendRate);
    sprintWeight = lerp(sprintWeight, targetSprint, blendRate);
    fallPose = lerp(fallPose, targetFall, Math.min(1, dt * 10));
    kissPose = lerp(kissPose, targetKiss, Math.min(1, dt * 4.5));

    // Stride frequency scales with speed
    const moving = speedMs > 0.15 && !isFallen && !isKissingRock;
    const cadence = moving ? clamp(1.3 + speedMs * 0.55, 1.4, 3.6) : 0;
    if (moving) {
      stridePhase = (stridePhase + dt * cadence * Math.PI * 2) % (Math.PI * 2);
    }

    const moveBlend = clamp(speedMs / 1.2, 0, 1) * (1 - fallPose) * (1 - kissPose);
    const s = Math.sin(stridePhase);
    const c = Math.cos(stridePhase);

    // Base stride amplitudes blended across walk -> hike -> power-hike -> run -> sprint
    const legAmp = lerp(0.42, 0.85, runWeight) + 0.25 * sprintWeight;
    const kneeAmp = lerp(0.55, 1.25, runWeight) + 0.30 * sprintWeight;
    const armAmp = lerp(0.35, 0.92, runWeight) + 0.25 * sprintWeight;

    // Power-hike overrides: hands push down toward thighs/knees in rhythm with uphill drive
    const hipPitchL = (s * legAmp + 0.24 * powerHikeWeight) * moveBlend;
    const hipPitchR = (-s * legAmp + 0.24 * powerHikeWeight) * moveBlend;

    const kneeFlexL = Math.max(0.08, (-c * 0.5 + 0.48) * kneeAmp) * moveBlend;
    const kneeFlexR = Math.max(0.08, (c * 0.5 + 0.48) * kneeAmp) * moveBlend;

    // Slight crouch when power hiking or running fast
    const bounce = Math.abs(s) * lerp(0.025, 0.075, runWeight) * moveBlend;
    const breath = Math.sin(idleTime * 2.2) * 0.008;
    const crouch = 0.08 * powerHikeWeight + 0.03 * runWeight;

    hips.position.y = lerp(0.92 - crouch + bounce + breath, 0.22, fallPose);
    hips.position.y = lerp(hips.position.y, 0.58, kissPose);
    hips.rotation.x = lerp(0, -1.25, fallPose); // fallen face-down/sideways
    hips.rotation.z = lerp(0, 0.35, fallPose);
    hips.rotation.y = Math.sin(stridePhase) * 0.06 * moveBlend;

    // Torso lean: uphill slope lean + power-hike lean + sprint lean + kiss-the-rock bow
    const slopeLean = clamp(grade * 0.55, -0.15, 0.35);
    const normalTorsoPitch = -(slopeLean + 0.14 * runWeight + 0.38 * powerHikeWeight + 0.10 * sprintWeight) * moveBlend;
    const stumbleWobble = isStumbling ? Math.sin(idleTime * 24) * 0.25 : 0;
    torso.rotation.x = lerp(normalTorsoPitch + stumbleWobble, -0.95, kissPose);
    torso.rotation.y = -Math.sin(stridePhase) * 0.09 * moveBlend;

    // Head stabilizes to look ahead
    headGroup.rotation.x = -torso.rotation.x * 0.65 + (isKissingRock ? -0.35 : 0);
    headGroup.rotation.y = Math.sin(idleTime * 0.7) * 0.05 * (1 - moveBlend);

    // Legs (negative rotation.x swings leg forward toward -Z in Three.js? Wait:
    // Around +X axis: right-hand rule rotates +Y toward +Z, and -Y (our limb down) toward -Z?
    // Wait: let's verify! Limb hangs along -Y: point (0, -L, 0).
    // Rotating around +X by +theta: y' = y*cos - z*sin = -L*cos, z' = y*sin + z*cos = -L*sin!
    // So +theta moves the foot toward -Z (FORWARD)! And knee bending backward needs -theta!)
    legL.hip.rotation.x = lerp(hipPitchL, 0.2, fallPose);
    legR.hip.rotation.x = lerp(hipPitchR, -0.3, fallPose);
    legL.knee.rotation.x = lerp(-kneeFlexL, -0.5, Math.max(fallPose, kissPose * 1.4));
    legR.knee.rotation.x = lerp(-kneeFlexR, -0.4, Math.max(fallPose, kissPose * 1.4));
    legL.ankle.rotation.x = clamp(-legL.hip.rotation.x * 0.35, -0.35, 0.35);
    legR.ankle.rotation.x = clamp(-legR.hip.rotation.x * 0.35, -0.35, 0.35);

    // Arms: normal swing vs power-hike hands-on-knees push!
    const normArmL = -s * armAmp * moveBlend;
    const normArmR = s * armAmp * moveBlend;
    const normElbow = -lerp(0.35, 1.45, runWeight) * moveBlend - 0.15;

    // Power-hike arm pose: arms reach forward/down toward quads/knees
    const phArmL = 0.65 + s * 0.28;
    const phArmR = 0.65 - s * 0.28;
    const phElbow = -0.55;

    armL.shoulder.rotation.x = lerp(normArmL, phArmL, powerHikeWeight);
    armR.shoulder.rotation.x = lerp(normArmR, phArmR, powerHikeWeight);
    armL.elbow.rotation.x = lerp(normElbow, phElbow, powerHikeWeight);
    armR.elbow.rotation.x = lerp(normElbow, phElbow, powerHikeWeight);

    // Slight inward arm angle on power-hike so hands land near thighs
    armL.shoulder.rotation.z = lerp(0.08, -0.14, powerHikeWeight);
    armR.shoulder.rotation.z = lerp(-0.08, 0.14, powerHikeWeight);

    if (isStumbling) {
      armL.shoulder.rotation.z = 0.65;
      armR.shoulder.rotation.z = -0.65;
    }

    return bounce;
  }

  return {
    root,
    updatePose,
    setShadowsEnabled,
    dispose() {
      root.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
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

  // Ram emblem plaque on top face
  const plaqueGeo = new THREE.CylinderGeometry(0.32, 0.34, 0.08, 12);
  const plaqueMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.5, metalness: 0.3 });
  const plaque = new THREE.Mesh(plaqueGeo, plaqueMat);
  plaque.position.set(0, 1.24, 0);
  group.add(plaque);

  return group;
}
