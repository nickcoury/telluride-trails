import * as THREE from 'three';

/**
 * Build a reusable unit [0..1] x [0..1] grid BufferGeometry with N x N quads
 * plus 4-edge boundary skirts for crack-free CDLOD terrain patches.
 * @param {number} N Grid divisions per side (must be even for CDLOD geomorphing)
 */
export function createPatchGeometry(N = 48) {
  const gridSegs = Math.max(4, N & ~1);
  const vertsPerSide = gridSegs + 1;
  const surfaceVertCount = vertsPerSide * vertsPerSide;
  const skirtVertCount = vertsPerSide * 4;
  const totalVerts = surfaceVertCount + skirtVertCount;

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const gridCoords = new Float32Array(totalVerts * 2);
  const skirts = new Float32Array(totalVerts);

  let vIdx = 0;
  for (let gz = 0; gz < vertsPerSide; gz++) {
    const v = gz / gridSegs;
    for (let gx = 0; gx < vertsPerSide; gx++) {
      const u = gx / gridSegs;
      positions[vIdx * 3] = u;
      positions[vIdx * 3 + 1] = 0;
      positions[vIdx * 3 + 2] = v;
      normals[vIdx * 3 + 1] = 1;
      gridCoords[vIdx * 2] = gx;
      gridCoords[vIdx * 2 + 1] = gz;
      skirts[vIdx] = 0;
      vIdx++;
    }
  }

  // Helper to append skirt vertex copying an existing surface vertex
  const northSkirtStart = vIdx;
  for (let gx = 0; gx < vertsPerSide; gx++) {
    const src = gx;
    positions.set(positions.subarray(src * 3, src * 3 + 3), vIdx * 3);
    normals[vIdx * 3 + 1] = 1;
    gridCoords.set(gridCoords.subarray(src * 2, src * 2 + 2), vIdx * 2);
    skirts[vIdx] = 1;
    vIdx++;
  }

  const southSkirtStart = vIdx;
  for (let gx = 0; gx < vertsPerSide; gx++) {
    const src = gridSegs * vertsPerSide + gx;
    positions.set(positions.subarray(src * 3, src * 3 + 3), vIdx * 3);
    normals[vIdx * 3 + 1] = 1;
    gridCoords.set(gridCoords.subarray(src * 2, src * 2 + 2), vIdx * 2);
    skirts[vIdx] = 1;
    vIdx++;
  }

  const westSkirtStart = vIdx;
  for (let gz = 0; gz < vertsPerSide; gz++) {
    const src = gz * vertsPerSide;
    positions.set(positions.subarray(src * 3, src * 3 + 3), vIdx * 3);
    normals[vIdx * 3 + 1] = 1;
    gridCoords.set(gridCoords.subarray(src * 2, src * 2 + 2), vIdx * 2);
    skirts[vIdx] = 1;
    vIdx++;
  }

  const eastSkirtStart = vIdx;
  for (let gz = 0; gz < vertsPerSide; gz++) {
    const src = gz * vertsPerSide + gridSegs;
    positions.set(positions.subarray(src * 3, src * 3 + 3), vIdx * 3);
    normals[vIdx * 3 + 1] = 1;
    gridCoords.set(gridCoords.subarray(src * 2, src * 2 + 2), vIdx * 2);
    skirts[vIdx] = 1;
    vIdx++;
  }

  const surfaceTris = gridSegs * gridSegs * 2;
  const skirtTris = gridSegs * 4 * 2;
  const IndexArray = totalVerts > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray((surfaceTris + skirtTris) * 3);

  let ptr = 0;
  for (let gz = 0; gz < gridSegs; gz++) {
    for (let gx = 0; gx < gridSegs; gx++) {
      const tl = gz * vertsPerSide + gx;
      const tr = tl + 1;
      const bl = tl + vertsPerSide;
      const br = bl + 1;
      // CCW upward (+Y)
      indices[ptr++] = tl;
      indices[ptr++] = bl;
      indices[ptr++] = tr;
      indices[ptr++] = tr;
      indices[ptr++] = bl;
      indices[ptr++] = br;
    }
  }

  // North skirt (-Z outward)
  for (let gx = 0; gx < gridSegs; gx++) {
    const s0 = gx;
    const s1 = gx + 1;
    const k0 = northSkirtStart + gx;
    const k1 = k0 + 1;
    indices[ptr++] = s0;
    indices[ptr++] = s1;
    indices[ptr++] = k0;
    indices[ptr++] = s1;
    indices[ptr++] = k1;
    indices[ptr++] = k0;
  }

  // South skirt (+Z outward)
  for (let gx = 0; gx < gridSegs; gx++) {
    const s0 = gridSegs * vertsPerSide + gx;
    const s1 = s0 + 1;
    const k0 = southSkirtStart + gx;
    const k1 = k0 + 1;
    indices[ptr++] = s0;
    indices[ptr++] = k0;
    indices[ptr++] = s1;
    indices[ptr++] = s1;
    indices[ptr++] = k0;
    indices[ptr++] = k1;
  }

  // West skirt (-X outward)
  for (let gz = 0; gz < gridSegs; gz++) {
    const s0 = gz * vertsPerSide;
    const s1 = s0 + vertsPerSide;
    const k0 = westSkirtStart + gz;
    const k1 = k0 + 1;
    indices[ptr++] = s0;
    indices[ptr++] = k0;
    indices[ptr++] = s1;
    indices[ptr++] = s1;
    indices[ptr++] = k0;
    indices[ptr++] = k1;
  }

  // East skirt (+X outward)
  for (let gz = 0; gz < gridSegs; gz++) {
    const s0 = gz * vertsPerSide + gridSegs;
    const s1 = s0 + vertsPerSide;
    const k0 = eastSkirtStart + gz;
    const k1 = k0 + 1;
    indices[ptr++] = s0;
    indices[ptr++] = s1;
    indices[ptr++] = k0;
    indices[ptr++] = s1;
    indices[ptr++] = k1;
    indices[ptr++] = k0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('aGridCoord', new THREE.BufferAttribute(gridCoords, 2));
  geo.setAttribute('aSkirt', new THREE.BufferAttribute(skirts, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.userData.gridSegs = gridSegs;
  return geo;
}
