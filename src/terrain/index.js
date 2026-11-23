import * as THREE from 'three';

/**
 * STUB terrain module (owned by @terrain).
 * Implements PLAN.md createTerrain(engine) contract with harmless placeholder geometry.
 */
export function createTerrain(engine) {
  const BASE_ELEV_M = 2667; // Telluride ~8,750 ft

  const group = new THREE.Group();
  group.name = 'stub-terrain';

  const geo = new THREE.PlaneGeometry(4000, 4000, 32, 32);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, getHeight(x, z));
  }
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x4f6846,
    roughness: 0.92,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  group.add(mesh);
  engine.scene.add(group);

  function getHeight(x, z) {
    // Gentle valley walls north/south to give visual shape around Telluride stub
    return BASE_ELEV_M + Math.sin(x * 0.002) * 18 + (z * z) * 0.00012;
  }

  function getNormal(x, z) {
    const e = 1.0;
    const hL = getHeight(x - e, z);
    const hR = getHeight(x + e, z);
    const hD = getHeight(x, z - e);
    const hU = getHeight(x, z + e);
    const v = new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
    return { x: v.x, y: v.y, z: v.z };
  }

  function getSurface(x, z) {
    const h = getHeight(x, z);
    if (h > 3500) return { forest: 0.05, rock: 0.65, water: 0, snow: 0.1, grass: 0.2 };
    return { forest: 0.4, rock: 0.1, water: 0, snow: 0, grass: 0.5 };
  }

  function update() {}

  async function preload() {
    return Promise.resolve();
  }

  function dispose() {
    engine.scene.remove(group);
    geo.dispose();
    mat.dispose();
  }

  return {
    update,
    getHeight,
    getNormal,
    getSurface,
    preload,
    ready: Promise.resolve(),
    dispose,
  };
}
