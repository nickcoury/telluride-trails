import * as THREE from 'three';

/**
 * STUB gameplay module (owned by @gameplay).
 * Implements PLAN.md createGame(engine, terrain, trailData, world) contract.
 */
export function createGame(engine, terrain) {
  const runnerGeo = new THREE.CapsuleGeometry(0.32, 1.0, 4, 8);
  const runnerMat = new THREE.MeshStandardMaterial({ color: 0xe6532c });
  const runnerMesh = new THREE.Mesh(runnerGeo, runnerMat);
  engine.scene.add(runnerMesh);

  const state = {
    mode: 'idle',
    paused: false,
    x: 0,
    z: 0,
    y: terrain.getHeight(0, 0),
    heading: 0,
    distanceM: 0,
    vertM: 0,
    speedMs: 0,
    stamina: 1,
    hydration: 1,
  };

  function syncMesh() {
    state.y = terrain.getHeight(state.x, state.z);
    runnerMesh.position.set(state.x, state.y + 0.85, state.z);
    runnerMesh.rotation.y = state.heading;
  }
  syncMesh();

  function startFreeRun({ x = 0, z = 0, heading = 0 } = {}) {
    state.mode = 'freerun';
    state.paused = false;
    state.x = x;
    state.z = z;
    state.heading = heading;
    syncMesh();
    engine.cameraRig?.snapTo?.({ x: state.x, y: state.y, z: state.z }, state.heading);
    engine.setAppState?.('playing');
  }

  function startRace(raceId) {
    state.mode = `race:${raceId}`;
    startFreeRun({ x: 0, z: 0, heading: 0 });
  }

  function resume() {
    state.paused = false;
    engine.setAppState?.('playing');
  }

  function pause() {
    state.paused = true;
    engine.setAppState?.('paused');
  }

  function update(dt) {
    if (state.paused || state.mode === 'idle') return;
    const { move } = engine.input;
    const speed = engine.input.sprint ? 5.2 : engine.input.hike ? 1.8 : 3.2;
    const yaw = engine.cameraRig?.getYaw?.() || 0;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    const vx = (forwardX * move.y + rightX * move.x) * speed;
    const vz = (forwardZ * move.y + rightZ * move.x) * speed;
    state.x += vx * dt;
    state.z += vz * dt;
    state.speedMs = Math.hypot(vx, vz);
    if (state.speedMs > 0.1) {
      state.heading = Math.atan2(-vx, -vz);
      state.distanceM += state.speedMs * dt;
    }
    syncMesh();
    engine.cameraRig?.update?.(dt, { x: state.x, y: state.y, z: state.z, heading: state.heading }, engine.input);
    engine.events.emit('hud', {
      paceMinPerMi: state.speedMs > 0.2 ? 26.8224 / state.speedMs : 0,
      distanceM: state.distanceM,
      vertM: state.vertM,
      elevationM: state.y,
      grade: 0,
      stamina: state.stamina,
      hydration: state.hydration,
      trailName: 'Telluride Stub Trail',
    });
  }

  return {
    startFreeRun,
    startRace,
    resume,
    pause,
    update,
    state,
  };
}
