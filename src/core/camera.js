import * as THREE from 'three';

/**
 * Chase / orbit / first-person / photo camera rig with smooth damping,
 * terrain clearance (with lookahead), and scripted flythrough support.
 */
export function createCameraRig({ camera, events }) {
  const MODES = ['chase', 'orbit', 'first-person', 'photo'];
  let mode = 'chase';
  let yaw = 0;
  let pitch = 0.25;
  let distance = 7.5;
  let invertY = false;

  const targetPos = new THREE.Vector3(0, 2670, 0);
  const currentPos = new THREE.Vector3(0, 2673, 8);
  const currentLookAt = new THREE.Vector3(0, 2671, 0);
  const desiredPos = new THREE.Vector3();
  const desiredLook = new THREE.Vector3();

  let terrainRef = null;
  let flythrough = null; // { waypoints: [{x,y,z,lookX,lookY,lookZ,duration}], elapsed, active }

  events.on('input:camera-toggle', () => {
    const cycle = ['chase', 'orbit', 'first-person'];
    const idx = cycle.indexOf(mode);
    mode = cycle[(idx + 1) % cycle.length];
    events.emit('camera:mode', { mode });
  });

  events.on('ui:cameraMode', (payload) => {
    if (payload?.mode) setMode(payload.mode);
  });

  events.on('ui:settings', (s) => {
    if (typeof s?.invertY === 'boolean') invertY = s.invertY;
  });

  function setTerrain(terrain) {
    terrainRef = terrain;
  }

  function setMode(nextMode) {
    if (MODES.includes(nextMode)) {
      mode = nextMode;
      events.emit('camera:mode', { mode });
    }
  }

  function clampAboveTerrain(pos, clearance = 1.25) {
    if (!terrainRef) return;
    const hCenter = terrainRef.getHeight(pos.x, pos.z);
    if (Number.isFinite(hCenter) && pos.y < hCenter + clearance) {
      pos.y = hCenter + clearance;
    }
  }

  function snapTo(pos, heading = 0) {
    flythrough = null;
    targetPos.set(pos.x, pos.y, pos.z);
    yaw = heading;
    const ox = Math.sin(yaw) * Math.cos(pitch) * distance;
    const oz = Math.cos(yaw) * Math.cos(pitch) * distance;
    const oy = Math.sin(pitch) * distance + 1.8;
    currentPos.set(pos.x + ox, pos.y + oy, pos.z + oz);
    clampAboveTerrain(currentPos, 1.4);
    currentLookAt.set(pos.x, pos.y + 1.5, pos.z);
    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
  }

  function setFlythrough(waypoints) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      flythrough = null;
      return;
    }
    flythrough = {
      waypoints: waypoints.map((w) => ({
        x: w.x ?? 0,
        y: w.y ?? (terrainRef ? terrainRef.getHeight(w.x ?? 0, w.z ?? 0) + 12 : 2700),
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
      return;
    }
    const cur = wps[flythrough.index];
    const next = wps[(flythrough.index + 1) % wps.length];
    flythrough.elapsed += dt;
    while (flythrough.elapsed >= cur.duration) {
      flythrough.elapsed -= cur.duration;
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
  }

  function update(dt, playerPose, input) {
    const clampedDt = Math.min(0.1, dt);

    if (flythrough?.active) {
      updateFlythrough(clampedDt);
      return;
    }

    if (input) {
      const signY = invertY ? -1 : 1;
      if (Math.abs(input.look.x) > 0 || Math.abs(input.look.y) > 0) {
        yaw -= input.look.x;
        pitch = Math.max(-0.4, Math.min(1.25, pitch + input.look.y * signY));
      } else if (mode === 'chase' && playerPose && typeof playerPose.heading === 'number') {
        const diff = Math.atan2(
          Math.sin(playerPose.heading - yaw),
          Math.cos(playerPose.heading - yaw)
        );
        yaw += diff * Math.min(1, clampedDt * 2.4);
      }

      if (input.zoomDelta) {
        const maxDist = mode === 'photo' ? 80 : 28;
        distance = Math.max(2.2, Math.min(maxDist, distance + input.zoomDelta));
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
      const horiz = Math.cos(pitch) * distance;
      const vert = Math.sin(pitch) * distance + 1.8;
      desiredPos.set(
        targetPos.x + Math.sin(yaw) * horiz,
        targetPos.y + vert,
        targetPos.z + Math.cos(yaw) * horiz
      );

      // Sample along camera arm & endpoint so steep terrain slopes don't clip the camera
      if (terrainRef) {
        for (const frac of [0.5, 0.8, 1.0]) {
          const sx = targetPos.x + (desiredPos.x - targetPos.x) * frac;
          const sz = targetPos.z + (desiredPos.z - targetPos.z) * frac;
          const groundY = terrainRef.getHeight(sx, sz);
          if (Number.isFinite(groundY)) {
            const minCamY = groundY + 1.25;
            if (desiredPos.y < minCamY) desiredPos.y = minCamY;
          }
        }
      }

      desiredLook.set(targetPos.x, targetPos.y + 1.45, targetPos.z);
      const smooth = 1 - Math.exp(-10 * clampedDt);
      currentPos.lerp(desiredPos, smooth);
      clampAboveTerrain(currentPos, 1.0);
      currentLookAt.lerp(desiredLook, smooth);
    }

    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
  }

  return {
    update,
    snapTo,
    setMode,
    setTerrain,
    setFlythrough,
    getMode: () => mode,
    getYaw: () => yaw,
  };
}
