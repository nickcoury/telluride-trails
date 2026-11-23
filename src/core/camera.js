import * as THREE from 'three';

/**
 * Chase / orbit / first-person / photo camera rig with:
 * - Fast-in / smooth-out spring-arm line-of-sight checks against terrain, buildings, and aerialway pylons
 * - Lower-middle runner framing on mobile (portrait & landscape) so runner stays clear of top HUD
 * - Slope-aware lookahead on steep climbs/descents (e.g. Original Rundola 30-75% grade)
 * - Zero-allocation runner screen-space bounding-box projection for UI overlay collision avoidance
 * - Scenic Telluride Box Canyon title overlook and scripted flythrough support
 */
export function createCameraRig({ camera, events }) {
  const MODES = ['chase', 'orbit', 'first-person', 'photo'];
  let mode = 'chase';
  let yaw = 0;
  let pitch = 0.24;
  let distance = 7.2;
  let invertY = false;

  // Default scenic title overlook: west end of Telluride Valley above West Colorado Ave
  // looking east into Telluride Box Canyon toward Ajax Peak, Ingram Falls, and Bridal Veil Falls.
  const TITLE_BASE_POS = { x: -1050, y: 2945, z: -60 };
  const TITLE_LOOK_AT = { x: 5200, y: 3290, z: 1150 };

  const targetPos = new THREE.Vector3(0, 2680, 0);
  const currentPos = new THREE.Vector3(TITLE_BASE_POS.x, TITLE_BASE_POS.y, TITLE_BASE_POS.z);
  const currentLookAt = new THREE.Vector3(TITLE_LOOK_AT.x, TITLE_LOOK_AT.y, TITLE_LOOK_AT.z);
  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();
  const _camRight = new THREE.Vector3();
  const _projPt = new THREE.Vector3();

  // Spring-arm smoothed collision state (fast-in, smooth-out)
  let armDistance = distance;
  let armExtraY = 0;
  let smoothGrade = 0;

  let terrainRef = null;
  let trailDataRef = null;
  let getBuildingMaskFn = null;
  let flythrough = null; // { waypoints, index, elapsed, active }
  let updatedThisFrame = false;
  let titleDriftActive = false;
  let titleDriftClock = 0;

  // Reusable screen-rect scratch (CSS viewport pixels, getBoundingClientRect-compatible)
  const _screenRect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    cx: 0,
    cy: 0,
    visible: false,
  };

  // LOS sample fractions along runner -> camera ray
  const LOS_FRACS = [0.12, 0.24, 0.38, 0.52, 0.66, 0.82, 1.0];

  // Static viewport framing presets (zero per-frame allocations)
  // Mobile portrait & landscape frame the runner in lower-middle (~58%-83% Y) with generous
  // headroom for top HUD + toasts while keeping feet above bottom controls.
  const FRAMING_PORTRAIT = Object.freeze({
    distScale: 1.0,
    lookAtY: 2.42,
    baseEyeOffset: 1.50,
    lookAheadM: 1.5,
    minDist: 2.5,
  });
  const FRAMING_LANDSCAPE = Object.freeze({
    distScale: 0.96,
    lookAtY: 2.38,
    baseEyeOffset: 1.48,
    lookAheadM: 1.45,
    minDist: 2.4,
  });
  const FRAMING_DESKTOP = Object.freeze({
    distScale: 1.0,
    lookAtY: 1.95,
    baseEyeOffset: 1.65,
    lookAheadM: 1.35,
    minDist: 2.4,
  });

  camera.position.copy(currentPos);
  camera.lookAt(currentLookAt);
  camera.updateMatrixWorld();

  const unsubToggle = events.on('input:camera-toggle', () => {
    const cycle = ['chase', 'orbit', 'first-person'];
    const idx = cycle.indexOf(mode);
    const next = cycle[(idx + 1) % cycle.length];
    setMode(next);
  });

  const unsubMode = events.on('ui:cameraMode', (payload) => {
    if (payload?.mode) setMode(payload.mode);
  });

  const unsubSettings = events.on('ui:settings', (s) => {
    if (typeof s?.invertY === 'boolean') invertY = s.invertY;
  });

  function setTerrain(terrain) {
    terrainRef = terrain;
  }

  function setWorldContext({ trailData = null, getBuildingMask = null } = {}) {
    trailDataRef = trailData;
    getBuildingMaskFn = getBuildingMask;
  }

  function setMode(nextMode) {
    if (!MODES.includes(nextMode) || mode === nextMode) return;
    mode = nextMode;
    events.emit('camera:mode', { mode });
  }

  function beginFrame() {
    updatedThisFrame = false;
  }

  function sampleGroundY(x, z) {
    if (!terrainRef) return NaN;
    const h =
      typeof terrainRef.getRenderedHeight === 'function'
        ? terrainRef.getRenderedHeight(x, z)
        : terrainRef.getHeight(x, z);
    return Number.isFinite(h) ? h : NaN;
  }

  function clampAboveTerrain(pos, clearance = 1.25) {
    const hCenter = sampleGroundY(pos.x, pos.z);
    if (Number.isFinite(hCenter) && pos.y < hCenter + clearance) {
      pos.y = hCenter + clearance;
    }
  }

  /**
   * Compute viewport-responsive framing parameters so the runner sits comfortably
   * in the lower-middle of mobile portrait & landscape screens (~55%-82% Y),
   * clear of both the top HUD and bottom touch controls. Zero allocations.
   */
  function getFramingParams() {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    if (w <= 680 && h >= w) return FRAMING_PORTRAIT;
    if (h <= 520 && w > h) return FRAMING_LANDSCAPE;
    return FRAMING_DESKTOP;
  }

  /**
   * Find closest unobstructed distance along the horizontal camera ray (dirX, dirZ)
   * against OSM buildings and nearby aerialway pylons. Zero allocations.
   */
  function computeObstaclePullIn(rx, ry, rz, dirX, dirZ, maxDist, minDist) {
    let clampedDist = maxDist;

    // 1. Buildings (O(1) spatial hash check along arm)
    const bMask = getBuildingMaskFn ? getBuildingMaskFn() : null;
    if (bMask && typeof bMask.isNearBuilding === 'function') {
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const d = (maxDist * i) / steps;
        if (d >= clampedDist) break;
        const sx = rx + dirX * d;
        const sz = rz + dirZ * d;
        if (bMask.isNearBuilding(sx, sz, 1.15)) {
          clampedDist = Math.max(minDist, d - 1.25);
          break;
        }
      }
    }

    // 2. Gondola / ski lift pylons along the camera arm
    const aerialways = trailDataRef?.aerialways;
    if (aerialways && aerialways.length > 0) {
      const searchR2 = (clampedDist + 3.0) * (clampedDist + 3.0);
      const pylonPad2 = 1.85 * 1.85;
      for (let a = 0; a < aerialways.length; a++) {
        const pylons = aerialways[a]?.pylons;
        if (!pylons) continue;
        for (let p = 0; p < pylons.length; p++) {
          const py = pylons[p];
          const vx = py.x - rx;
          const vz = py.z - rz;
          const d2 = vx * vx + vz * vz;
          if (d2 > searchR2) continue;
          // Project pylon onto horizontal camera ray (dirX, dirZ)
          const proj = vx * dirX + vz * dirZ;
          if (proj <= 0.6 || proj >= clampedDist) continue;
          const perpX = vx - dirX * proj;
          const perpZ = vz - dirZ * proj;
          if (perpX * perpX + perpZ * perpZ < pylonPad2) {
            // Check vertical overlap (pylons stand ~12-22m above ground)
            if (ry >= py.y - 3.0 && ry <= py.y + 24.0) {
              clampedDist = Math.max(minDist, proj - 1.6);
            }
          }
        }
      }
    }

    return clampedDist;
  }

  /**
   * Solve terrain line-of-sight between runner torso (rx, anchorY, rz) and camera arm
   * so convex crests, steep uphill/downhill chutes, and canyon walls never occlude the runner.
   * Returns { dist, camY } written into _losOut (zero allocations).
   */
  const _losOut = { dist: 7.2, camY: 0 };
  function solveTerrainLOS(rx, ry, rz, dirX, dirZ, nominalDist, nominalCamY, minDist) {
    const anchorY = ry + 0.65; // runner lower-thigh/knee visibility anchor so legs stay unoccluded over crests
    let dist = nominalDist;
    let bestCamY = nominalCamY;

    if (!terrainRef) {
      _losOut.dist = dist;
      _losOut.camY = bestCamY;
      return _losOut;
    }

    // Two-pass solver: pass 1 checks LOS at `dist`; if terrain requires excessive vertical
    // lift (steep wall/crest directly behind runner), pull camera in closer and re-check LOS.
    for (let pass = 0; pass < 2; pass++) {
      let reqCamY = nominalCamY;
      let worstOccludingFrac = 1.0;
      let maxExcessLift = 0;

      for (let i = 0; i < LOS_FRACS.length; i++) {
        const t = LOS_FRACS[i];
        const sx = rx + dirX * (dist * t);
        const sz = rz + dirZ * (dist * t);
        const groundY = sampleGroundY(sx, sz);
        if (!Number.isFinite(groundY)) continue;

        // Clearance ramps from 0.38 m near runner up to 1.35 m at camera endpoint
        const clearance = 0.25 + 1.1 * t;
        // Exact ray equation: anchorY + (camY - anchorY) * t >= groundY + clearance
        const minCamYForSample = anchorY + (groundY + clearance - anchorY) / t;
        if (minCamYForSample > reqCamY) {
          const lift = minCamYForSample - nominalCamY;
          if (lift > maxExcessLift) {
            maxExcessLift = lift;
            worstOccludingFrac = t;
          }
          reqCamY = minCamYForSample;
        }
      }

      // If lifting camera alone would push it overly high/steep (> ~48 deg look-down),
      // pull the camera in closer ahead of the occluding terrain ridge and re-evaluate.
      const maxComfortCamY = ry + dist * 0.92 + 2.6;
      if (pass === 0 && reqCamY > maxComfortCamY && dist > minDist + 0.25) {
        const pullFactor = Math.max(0.45, Math.min(0.85, worstOccludingFrac * 0.88));
        dist = Math.max(minDist, dist * pullFactor);
        continue;
      }

      bestCamY = Math.min(reqCamY, ry + dist * 1.45 + 5.5);
      break;
    }

    // Final endpoint floor guarantee
    const endGroundY = sampleGroundY(rx + dirX * dist, rz + dirZ * dist);
    if (Number.isFinite(endGroundY) && bestCamY < endGroundY + 1.35) {
      bestCamY = endGroundY + 1.35;
    }

    _losOut.dist = dist;
    _losOut.camY = bestCamY;
    return _losOut;
  }

  /**
   * Sample macro forward trail grade along (-dirX, -dirZ) using a blended 4 m + 12 m lookahead
   * so steep climbs (e.g. Original Rundola 35-75%) smoothly pitch the camera UP the mountain
   * without jittering over local 1 m micro-bumps.
   */
  function sampleForwardGrade(rx, ry, rz, dirX, dirZ) {
    const yNear = sampleGroundY(rx - dirX * 4.0, rz - dirZ * 4.0);
    const yFar = sampleGroundY(rx - dirX * 12.0, rz - dirZ * 12.0);
    let g = 0;
    if (Number.isFinite(yNear) && Number.isFinite(yFar)) {
      g = 0.55 * ((yNear - ry) / 4.0) + 0.45 * ((yFar - ry) / 12.0);
    } else if (Number.isFinite(yNear)) {
      g = (yNear - ry) / 4.0;
    } else if (Number.isFinite(yFar)) {
      g = (yFar - ry) / 12.0;
    }
    return Math.max(-0.65, Math.min(0.85, g));
  }

  function snapTo(pos, heading = 0) {
    flythrough = null;
    targetPos.set(pos.x, pos.y, pos.z);
    yaw = heading;
    const framing = getFramingParams();
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const grade = sampleForwardGrade(pos.x, pos.y, pos.z, dirX, dirZ);
    smoothGrade = grade;
    const uphill = Math.min(0.80, Math.max(0, grade));

    const targetDist = Math.max(framing.minDist, distance * framing.distScale * (1 + uphill * 0.14));
    const horizDist = Math.cos(pitch) * targetDist;
    const slopeCamBias = -uphill * 2.75;
    const slopeLookBias = uphill * 1.10 + Math.min(0, grade) * 0.35;
    const nominalCamY = pos.y + Math.sin(pitch) * targetDist + framing.baseEyeOffset + slopeCamBias;

    const obsDist = computeObstaclePullIn(pos.x, pos.y, pos.z, dirX, dirZ, horizDist, framing.minDist);
    const los = solveTerrainLOS(pos.x, pos.y, pos.z, dirX, dirZ, obsDist, nominalCamY, framing.minDist);

    armDistance = los.dist;
    armExtraY = Math.max(0, los.camY - nominalCamY);

    currentPos.set(pos.x + dirX * los.dist, los.camY, pos.z + dirZ * los.dist);
    currentLookAt.set(
      pos.x - dirX * framing.lookAheadM,
      pos.y + framing.lookAtY + slopeLookBias,
      pos.z - dirZ * framing.lookAheadM
    );
    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
    camera.updateMatrixWorld();
  }

  function setFlythrough(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      flythrough = null;
      return;
    }
    flythrough = {
      waypoints: waypoints.map((w) => ({
        x: w.x ?? 0,
        y: w.y ?? (Number.isFinite(sampleGroundY(w.x ?? 0, w.z ?? 0)) ? sampleGroundY(w.x ?? 0, w.z ?? 0) + 12 : 2700),
        z: w.z ?? 0,
        lookX: w.lookX ?? w.x ?? 0,
        lookY: w.lookY ?? (w.y ?? 2680),
        lookZ: w.lookZ ?? (w.z ?? 0) - 50,
        duration: Math.max(0.2, w.duration ?? 3),
      })),
      index: 0,
      elapsed: 0,
      active: true,
    };
  }

  function updateFlythrough(dt) {
    const wps = flythrough.waypoints;
    if (wps.length === 1) {
      const w = wps[0];
      currentPos.set(w.x, w.y, w.z);
      currentLookAt.set(w.lookX, w.lookY, w.lookZ);
      camera.position.copy(currentPos);
      camera.lookAt(currentLookAt);
      camera.updateMatrixWorld();
      return;
    }
    flythrough.elapsed += dt;
    while (flythrough.elapsed >= wps[flythrough.index].duration) {
      flythrough.elapsed -= wps[flythrough.index].duration;
      flythrough.index = (flythrough.index + 1) % wps.length;
    }
    const a = wps[flythrough.index];
    const b = wps[(flythrough.index + 1) % wps.length];
    const t = Math.min(1, flythrough.elapsed / a.duration);
    const s = t * t * (3 - 2 * t);
    currentPos.set(
      a.x + (b.x - a.x) * s,
      a.y + (b.y - a.y) * s,
      a.z + (b.z - a.z) * s
    );
    clampAboveTerrain(currentPos, 1.5);
    currentLookAt.set(
      a.lookX + (b.lookX - a.lookX) * s,
      a.lookY + (b.lookY - a.lookY) * s,
      a.lookZ + (b.lookZ - a.lookZ) * s
    );
    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
    camera.updateMatrixWorld();
  }

  function setTitleDriftActive(active) {
    titleDriftActive = Boolean(active);
    if (!titleDriftActive) titleDriftClock = 0;
  }

  function snapToTitleHero() {
    flythrough = null;
    titleDriftActive = false;
    titleDriftClock = 0;
    currentPos.set(TITLE_BASE_POS.x, TITLE_BASE_POS.y, TITLE_BASE_POS.z);
    currentLookAt.set(TITLE_LOOK_AT.x, TITLE_LOOK_AT.y, TITLE_LOOK_AT.z);
    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
    camera.updateMatrixWorld();
  }

  function updateTitleScenic(dt) {
    updatedThisFrame = true;
    if (flythrough?.active) {
      updateFlythrough(Math.min(0.1, dt));
      return;
    }
    if (!titleDriftActive) {
      currentPos.set(TITLE_BASE_POS.x, TITLE_BASE_POS.y, TITLE_BASE_POS.z);
      currentLookAt.set(TITLE_LOOK_AT.x, TITLE_LOOK_AT.y, TITLE_LOOK_AT.z);
      camera.position.copy(currentPos);
      camera.lookAt(currentLookAt);
      camera.updateMatrixWorld();
      return;
    }
    titleDriftClock += Math.min(0.1, dt);
    const ramp = Math.min(1, titleDriftClock / 6.0);
    const ease = ramp * ramp * (3 - 2 * ramp);
    const phase = titleDriftClock * 0.065;
    const x = TITLE_BASE_POS.x + Math.sin(phase) * 110 * ease;
    const z = TITLE_BASE_POS.z + (1 - Math.cos(phase * 0.7)) * 110 * ease;
    const groundY = sampleGroundY(x, z);
    const baseY = Math.max(TITLE_BASE_POS.y, (Number.isFinite(groundY) ? groundY : 2680) + 140);
    const y = baseY + Math.sin(phase * 0.5) * 22 * ease;
    currentPos.set(x, y, z);
    currentLookAt.set(
      TITLE_LOOK_AT.x,
      TITLE_LOOK_AT.y + Math.sin(phase * 0.6) * 32 * ease,
      TITLE_LOOK_AT.z + Math.sin(phase * 0.4) * 120 * ease
    );
    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
    camera.updateMatrixWorld();
  }

  function update(dt, playerPose, input) {
    updatedThisFrame = true;
    const clampedDt = Math.min(0.1, dt);

    if (flythrough?.active) {
      updateFlythrough(clampedDt);
      return;
    }

    if (input) {
      const signY = invertY ? -1 : 1;
      if (Math.abs(input.look.x) > 0 || Math.abs(input.look.y) > 0) {
        yaw -= input.look.x;
        pitch = Math.max(-0.35, Math.min(1.2, pitch + input.look.y * signY));
      } else if (mode === 'chase' && playerPose && typeof playerPose.heading === 'number') {
        const diff = Math.atan2(
          Math.sin(playerPose.heading - yaw),
          Math.cos(playerPose.heading - yaw)
        );
        yaw += diff * Math.min(1, clampedDt * 2.6);
      }

      if (input.zoomDelta) {
        const maxDist = mode === 'photo' ? 80 : 28;
        distance = Math.max(2.4, Math.min(maxDist, distance + input.zoomDelta));
      }
    }

    if (playerPose) {
      targetPos.set(playerPose.x, playerPose.y, playerPose.z);
    }

    if (mode === 'first-person') {
      desiredPos.set(targetPos.x, targetPos.y + 1.68, targetPos.z);
      desiredLook.set(
        desiredPos.x - Math.sin(yaw) * Math.cos(pitch) * 12,
        desiredPos.y - Math.sin(pitch) * 12,
        desiredPos.z - Math.cos(yaw) * Math.cos(pitch) * 12
      );
      const fpSmooth = 1 - Math.exp(-20 * clampedDt);
      currentPos.lerp(desiredPos, fpSmooth);
      currentLookAt.lerp(desiredLook, fpSmooth);
    } else {
      const framing = getFramingParams();
      const dirX = Math.sin(yaw);
      const dirZ = Math.cos(yaw);

      // Sample macro forward trail grade so steep climbs (35-75% on Original Rundola) pitch the
      // chase camera UP the mountain (showing gondola towers, ridge & sky ahead) while keeping
      // the runner consistently framed in the lower-middle (~58%-83% Y) clear of top HUD/toasts.
      const rawGrade =
        mode === 'chase'
          ? sampleForwardGrade(targetPos.x, targetPos.y, targetPos.z, dirX, dirZ)
          : 0;
      smoothGrade += (rawGrade - smoothGrade) * (1 - Math.exp(-5.5 * clampedDt));
      const uphill = Math.min(0.80, Math.max(0, smoothGrade));

      const targetDist = Math.max(framing.minDist, distance * framing.distScale * (1 + uphill * 0.14));
      const horizDist = Math.cos(pitch) * targetDist;
      const slopeCamBias = -uphill * 2.75;
      const slopeLookBias = uphill * 1.10 + Math.min(0, smoothGrade) * 0.35;
      const nominalCamY = targetPos.y + Math.sin(pitch) * targetDist + framing.baseEyeOffset + slopeCamBias;

      // 1. Check buildings & gondola pylons along camera arm (in chase & orbit; photo allows free framing)
      const obsDist =
        mode === 'photo'
          ? horizDist
          : computeObstaclePullIn(targetPos.x, targetPos.y, targetPos.z, dirX, dirZ, horizDist, framing.minDist);

      // 2. Solve terrain line-of-sight along runner -> camera arm
      const los = solveTerrainLOS(
        targetPos.x,
        targetPos.y,
        targetPos.z,
        dirX,
        dirZ,
        obsDist,
        nominalCamY,
        framing.minDist
      );

      // Fast-in (instant clip avoidance), smooth-out (gentle spring relaxation)
      const distAlpha = los.dist < armDistance ? 1 - Math.exp(-28 * clampedDt) : 1 - Math.exp(-6 * clampedDt);
      armDistance += (los.dist - armDistance) * distAlpha;

      const desiredExtraY = Math.max(0, los.camY - nominalCamY);
      const liftAlpha = desiredExtraY > armExtraY ? 1 - Math.exp(-26 * clampedDt) : 1 - Math.exp(-5.5 * clampedDt);
      armExtraY += (desiredExtraY - armExtraY) * liftAlpha;

      desiredPos.set(
        targetPos.x + dirX * armDistance,
        nominalCamY + armExtraY,
        targetPos.z + dirZ * armDistance
      );

      // Look ahead and up the slope so runner stays in lower-middle (~58%-83% Y) with uphill vista
      const lookAhead = mode === 'chase' ? framing.lookAheadM : 0.35;
      const lookY = mode === 'chase' ? framing.lookAtY + slopeLookBias : 1.5;
      desiredLook.set(
        targetPos.x - dirX * lookAhead,
        targetPos.y + lookY,
        targetPos.z - dirZ * lookAhead
      );

      const posSmooth = 1 - Math.exp(-14 * clampedDt);
      const lookSmooth = 1 - Math.exp(-12 * clampedDt);
      currentPos.lerp(desiredPos, posSmooth);
      currentLookAt.lerp(desiredLook, lookSmooth);

      // Hard post-lerp guarantee: camera never dips under terrain, clips obstacles, or breaks LOS on rapid turns
      const postDx = currentPos.x - targetPos.x;
      const postDz = currentPos.z - targetPos.z;
      const postDist = Math.hypot(postDx, postDz);
      if (postDist > 0.05) {
        const postDirX = postDx / postDist;
        const postDirZ = postDz / postDist;
        const postObsDist =
          mode === 'photo'
            ? postDist
            : computeObstaclePullIn(
                targetPos.x,
                targetPos.y,
                targetPos.z,
                postDirX,
                postDirZ,
                postDist,
                framing.minDist
              );
        const postLos = solveTerrainLOS(
          targetPos.x,
          targetPos.y,
          targetPos.z,
          postDirX,
          postDirZ,
          postObsDist,
          currentPos.y,
          framing.minDist
        );
        if (postLos.dist < postDist - 0.01) {
          currentPos.x = targetPos.x + postDirX * postLos.dist;
          currentPos.z = targetPos.z + postDirZ * postLos.dist;
          armDistance = Math.min(armDistance, postLos.dist);
        }
        if (currentPos.y < postLos.camY) {
          currentPos.y = postLos.camY;
        }
      }
      clampAboveTerrain(currentPos, 1.25);
    }

    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
    camera.updateMatrixWorld();
  }

  /**
   * Project the runner's 3D world bounding capsule (feet at y, head at y + height, lateral radius)
   * into CSS viewport pixel coordinates (getBoundingClientRect-compatible). Zero allocations.
   */
  function projectRunnerScreenRect(pos, height = 1.85, radius = 0.42) {
    if (!pos || mode === 'first-person') {
      _screenRect.visible = false;
      _screenRect.width = 0;
      _screenRect.height = 0;
      return _screenRect;
    }

    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;

    // Extract camera right axis from matrixWorld column 0
    _camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let inFrontCount = 0;

    // Project 4 extreme points: feet, head, left shoulder, right shoulder
    for (let i = 0; i < 4; i++) {
      if (i === 0) {
        _projPt.set(pos.x, pos.y, pos.z);
      } else if (i === 1) {
        _projPt.set(pos.x, pos.y + height, pos.z);
      } else if (i === 2) {
        _projPt.set(
          pos.x - _camRight.x * radius,
          pos.y + height * 0.55,
          pos.z - _camRight.z * radius
        );
      } else {
        _projPt.set(
          pos.x + _camRight.x * radius,
          pos.y + height * 0.55,
          pos.z + _camRight.z * radius
        );
      }
      _projPt.project(camera);
      // Skip points behind camera / outside clip depth so negative-w projection never flips bbox
      if (_projPt.z < -1 || _projPt.z > 1) continue;
      inFrontCount++;
      const sx = (_projPt.x * 0.5 + 0.5) * w;
      const sy = (-_projPt.y * 0.5 + 0.5) * h;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy;
      if (sy > maxY) maxY = sy;
    }

    if (inFrontCount === 0 || !Number.isFinite(minX) || maxX < 0 || minX > w || maxY < 0 || minY > h) {
      _screenRect.visible = false;
      _screenRect.width = 0;
      _screenRect.height = 0;
      return _screenRect;
    }

    // Add a small 8px visual padding halo around the runner silhouette
    const pad = 8;
    const left = Math.max(0, minX - pad);
    const right = Math.min(w, maxX + pad);
    const top = Math.max(0, minY - pad);
    const bottom = Math.min(h, maxY + pad);

    _screenRect.left = left;
    _screenRect.top = top;
    _screenRect.right = right;
    _screenRect.bottom = bottom;
    _screenRect.width = Math.max(0, right - left);
    _screenRect.height = Math.max(0, bottom - top);
    _screenRect.cx = (left + right) * 0.5;
    _screenRect.cy = (top + bottom) * 0.5;
    _screenRect.visible = _screenRect.width > 1 && _screenRect.height > 1;
    return _screenRect;
  }

  function dispose() {
    unsubToggle();
    unsubMode();
    unsubSettings();
  }

  return {
    beginFrame,
    hasUpdatedThisFrame: () => updatedThisFrame,
    isFlythrough: () => Boolean(flythrough?.active),
    update,
    updateTitleScenic,
    setTitleDriftActive,
    snapToTitleHero,
    snapTo,
    setMode,
    setTerrain,
    setWorldContext,
    setFlythrough,
    projectRunnerScreenRect,
    getMode: () => mode,
    getYaw: () => yaw,
    dispose,
  };
}
