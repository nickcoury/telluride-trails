import * as THREE from 'three';

/**
 * Chase / orbit / first-person camera rig with smooth damping and terrain clearance.
 */
export function createCameraRig({ camera, events }) {
  const MODES = ['chase', 'orbit', 'first-person'];
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

  events.on('input:camera-toggle', () => {
    const idx = MODES.indexOf(mode);
    mode = MODES[(idx + 1) % MODES.length];
    events.emit('camera:mode', { mode });
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

  function snapTo(pos, heading = 0) {
    targetPos.copy(pos);
    yaw = heading;
    const ox = Math.sin(yaw) * Math.cos(pitch) * distance;
    const oz = Math.cos(yaw) * Math.cos(pitch) * distance;
    const oy = Math.sin(pitch) * distance + 1.8;
    currentPos.set(pos.x + ox, pos.y + oy, pos.z + oz);
    currentLookAt.set(pos.x, pos.y + 1.5, pos.z);
    camera.position.copy(currentPos);
    camera.lookAt(currentLookAt);
  }

  function update(dt, playerPose, input) {
    const clampedDt = Math.min(0.1, dt);
    if (input) {
      const signY = invertY ? -1 : 1;
      if (Math.abs(input.look.x) > 0 || Math.abs(input.look.y) > 0) {
        yaw -= input.look.x;
        pitch = Math.max(-0.4, Math.min(1.25, pitch + input.look.y * signY));
      } else if (mode === 'chase' && playerPose && typeof playerPose.heading === 'number') {
        // Gently align behind runner when not dragging camera
        const diff = Math.atan2(Math.sin(playerPose.heading - yaw), Math.cos(playerPose.heading - yaw));
        yaw += diff * Math.min(1, clampedDt * 2.2);
      }

      if (input.zoomDelta) {
        distance = Math.max(2.5, Math.min(28, distance + input.zoomDelta));
      }
    }

    if (playerPose) {
      targetPos.set(playerPose.x, playerPose.y, playerPose.z);
    }

    if (mode === 'first-person') {
      desiredPos.set(targetPos.x, targetPos.y + 1.68, targetPos.z);
      desiredLook.set(
        desiredPos.x - Math.sin(yaw) * Math.cos(pitch) * 10,
        desiredPos.y - Math.sin(pitch) * 10,
        desiredPos.z - Math.cos(yaw) * Math.cos(pitch) * 10
      );
      currentPos.lerp(desiredPos, Math.min(1, clampedDt * 18));
      currentLookAt.lerp(desiredLook, Math.min(1, clampedDt * 18));
    } else {
      const horiz = Math.cos(pitch) * distance;
      const vert = Math.sin(pitch) * distance + 1.8;
      desiredPos.set(
        targetPos.x + Math.sin(yaw) * horiz,
        targetPos.y + vert,
        targetPos.z + Math.cos(yaw) * horiz
      );

      // Keep camera above terrain
      if (terrainRef) {
        const groundY = terrainRef.getHeight(desiredPos.x, desiredPos.z);
        if (Number.isFinite(groundY) && desiredPos.y < groundY + 1.2) {
          desiredPos.y = groundY + 1.2;
        }
      }

      desiredLook.set(targetPos.x, targetPos.y + 1.45, targetPos.z);
      const smooth = 1 - Math.exp(-10 * clampedDt);
      currentPos.lerp(desiredPos, smooth);
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
    getMode: () => mode,
    getYaw: () => yaw,
  };
}
