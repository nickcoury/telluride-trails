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

// Calibrated natural ground speeds (m/s) for each UAL1 locomotion clip so
// timeScale = speedMs / naturalSpeed keeps feet planted with zero sliding.
const NATURAL_SPEEDS = {
  walk: 1.42,
  crouch: 1.25,
  jog: 3.05,
  sprint: 5.05,
};

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

function buildPlaceholder() {
  const geo = mergeColoredParts([
    { geo: new THREE.CapsuleGeometry(0.18, 0.52, 6, 10), pos: [0, 1.18, 0], color: 0xdd5226 },
    { geo: new THREE.CapsuleGeometry(0.14, 0.56, 6, 10), pos: [0, 0.56, 0], color: 0x222a35 },
    { geo: new THREE.SphereGeometry(0.115, 10, 8), pos: [0, 1.66, 0], color: 0xd8a480 },
    { geo: new THREE.SphereGeometry(0.122, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.52), pos: [0, 1.68, 0], color: 0x1d4e6b },
  ]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'runner-placeholder';
  mesh.castShadow = true;
  return mesh;
}

function buildHydrationVest() {
  const parts = [
    // Contoured rear hydration pack (local -Z is behind chest in UAL/UBC bone space)
    { geo: new THREE.BoxGeometry(0.24, 0.34, 0.095), pos: [0, 0.01, -0.155], color: 0x183446 },
    { geo: new THREE.BoxGeometry(0.20, 0.14, 0.055), pos: [0, 0.06, -0.205], color: 0xe85a2b },
    { geo: new THREE.BoxGeometry(0.16, 0.022, 0.012), pos: [0, -0.07, -0.206], color: 0xdbeafe },
    // Dual chest sternum straps
    { geo: new THREE.BoxGeometry(0.15, 0.014, 0.014), pos: [0, 0.05, 0.135], color: 0xe85a2b },
    { geo: new THREE.BoxGeometry(0.15, 0.014, 0.014), pos: [0, -0.03, 0.135], color: 0xe85a2b },
  ];

  for (const side of [-1, 1]) {
    parts.push(
      { geo: new THREE.BoxGeometry(0.035, 0.18, 0.20), pos: [side * 0.145, -0.03, -0.04], color: 0x183446 },
      { geo: new THREE.BoxGeometry(0.052, 0.035, 0.24), pos: [side * 0.10, 0.175, -0.02], color: 0x183446 },
      { geo: new THREE.BoxGeometry(0.056, 0.28, 0.03), pos: [side * 0.095, 0.03, 0.125], color: 0x183446 },
      // Front 500ml soft flask + bite valve
      { geo: new THREE.CylinderGeometry(0.025, 0.020, 0.145, 10), pos: [side * 0.095, 0.02, 0.148], color: 0x38bdf8 },
      { geo: new THREE.CylinderGeometry(0.014, 0.018, 0.024, 8), pos: [side * 0.095, 0.102, 0.148], color: 0x111827 },
    );
  }

  const mesh = new THREE.Mesh(
    mergeColoredParts(parts),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.05 })
  );
  mesh.name = 'gear-hydration-vest';
  mesh.castShadow = true;
  return mesh;
}

function buildHeadGear() {
  const gear = new THREE.Group();
  gear.name = 'gear-head';

  // Merge all static cap + shades + headlamp housing parts into 1 draw call
  const staticMesh = new THREE.Mesh(
    mergeColoredParts([
      // Trucker trail cap crown snugged cleanly onto skull brow
      {
        geo: new THREE.SphereGeometry(0.113, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.56),
        pos: [0, 0.104, -0.008],
        rot: [-0.08, 0, 0],
        scale: [0.95, 1.0, 1.04],
        color: 0x1d4e6b,
      },
      // Rear dark mesh panel accent
      {
        geo: new THREE.SphereGeometry(0.114, 12, 8, Math.PI * 0.72, Math.PI * 1.56, 0.12, Math.PI * 0.44),
        pos: [0, 0.104, -0.008],
        rot: [-0.08, 0, 0],
        scale: [0.95, 1.0, 1.04],
        color: 0x2a3441,
      },
      // Curved trail cap brim pointing +Z (forward in bone local space)
      {
        geo: new THREE.CylinderGeometry(0.098, 0.102, 0.011, 14, 1, false, -Math.PI * 0.42, Math.PI * 0.84),
        pos: [0, 0.118, 0.055],
        rot: [0.07, 0, 0],
        scale: [1.02, 1, 1.42],
        color: 0xd95428,
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
    ]),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.08 })
  );
  staticMesh.name = 'gear-head-cap';
  staticMesh.castShadow = true;
  gear.add(staticMesh);

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

  return { gear, lampLensMat };
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
  let idleTime = 0;
  let strideClock = 0;

  function applyShadowSetting() {
    blobShadow.visible = !shadowsEnabledState;
    root.traverse((obj) => {
      if (obj.isMesh && !obj.userData?.noShadow) {
        obj.castShadow = Boolean(shadowsEnabledState);
        obj.receiveShadow = false;
      }
    });
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
        gltfScene.traverse((obj) => {
          if (obj.isSkinnedMesh || obj.isMesh) {
            obj.frustumCulled = false;
            obj.castShadow = Boolean(shadowsEnabledState);
            if (obj.material) {
              obj.material.envMapIntensity = 0.65;
            }
          }
          if (obj.isBone) {
            bones[obj.name] = obj;
          }
        });

        // Attach merged trail-running gear directly to skeleton bones (4 meshes total)
        if (bones.spine_03) {
          bones.spine_03.add(buildHydrationVest());
        } else if (bones.spine_02) {
          bones.spine_02.add(buildHydrationVest());
        }

        if (bones.Head) {
          const hg = buildHeadGear();
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
        applyShadowSetting();
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

    // Estimate first-person stride bob even when model hidden in 1st person
    const moving = speedMs > 0.15 && !isFallen && !isKissingRock && !isAirborne;
    if (moving) {
      const cadence = clamp(1.4 + speedMs * 0.52, 1.5, 3.5);
      strideClock = (strideClock + dt * cadence * Math.PI * 2) % (Math.PI * 2);
    }
    const fpBounce = moving ? Math.abs(Math.sin(strideClock)) * clamp(speedMs / 4.5, 0.25, 1) * 0.065 : 0;

    if (!visible) return fpBounce;

    // Simple subtle bob on placeholder while GLB is streaming
    if (!loaded || !mixer) {
      placeholder.position.y = fpBounce * 0.8;
      placeholder.rotation.x = clamp(-grade * 0.4, -0.25, 0.25);
      return fpBounce;
    }

    const safeDt = Math.min(0.06, Math.max(0, dt));
    smoothGrade = lerp(smoothGrade, clamp(grade, -0.45, 0.55), Math.min(1, safeDt * 7));

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

    // Compute normalized locomotion & action target weights
    let tIdle = 0;
    let tWalk = 0;
    let tJog = 0;
    let tSprint = 0;
    let tPowerHike = 0;
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
      tPowerHike = 0.62;
      tWalk = 0.38;
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

    const blend = Math.min(1, safeDt * 10);
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
    applyActionWeight(actions.idle, weights.idle, 1.0);
    applyActionWeight(actions.walk, weights.walk, clamp(effectiveSpeed / NATURAL_SPEEDS.walk, 0.55, 1.55));
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

    // Post-mixer procedural bone overlays: slope lean, power-hike torso pitch, stumble wobble, head stabilization
    const uprightMask = Math.max(0, 1 - weights.fall - weights.getup - weights.ceremony);
    if (uprightMask > 0.05) {
      const moveMask = clamp(speedMs / 0.9, 0, 1) * uprightMask;
      const slopePitch = clamp(smoothGrade * 0.62, -0.18, 0.34) * moveMask;
      const phExtra = weights.powerHike * 0.22;
      const stumbleZ = isStumbling ? Math.sin(idleTime * 22) * 0.22 : 0;

      if (bones.spine_01) {
        bones.spine_01.rotation.x += (slopePitch + phExtra) * 0.45;
        bones.spine_01.rotation.z += stumbleZ * 0.5;
      }
      if (bones.spine_02) {
        bones.spine_02.rotation.x += (slopePitch + phExtra) * 0.55;
        bones.spine_02.rotation.z += stumbleZ * 0.5;
      }
      if (bones.Head) {
        bones.Head.rotation.x -= (slopePitch + phExtra) * 0.65;
      }
    }

    modelPivot.position.y = 0.01;

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
    updatePose,
    setShadowsEnabled,
    dispose() {
      disposed = true;
      if (mixer) {
        mixer.stopAllAction();
        if (gltfScene) mixer.uncacheRoot(gltfScene);
      }
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
