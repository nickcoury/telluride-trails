import * as THREE from 'three';

/**
 * STUB world module (owned by @world).
 * Implements PLAN.md createWorld(engine, terrain, trailData) contract.
 */
export function createWorld(engine) {
  const hemi = new THREE.HemisphereLight(0xdbeafe, 0x3b4d36, 0.9);
  const sun = new THREE.DirectionalLight(0xfff4df, 1.8);
  sun.position.set(300, 500, 200);
  engine.scene.add(hemi);
  engine.scene.add(sun);

  function update() {}
  function setTimeOfDay() {}
  function dispose() {
    engine.scene.remove(hemi);
    engine.scene.remove(sun);
  }

  return { update, setTimeOfDay, dispose };
}
