import * as THREE from 'three';
import { lonLatToWorld } from '../core/geo.js';
import { hash2i, mulberry32 } from './noise.js';
import { SAN_JUAN_FOG_GLSL } from './atmosphere.js';
import { patchSanJuanMaterial } from './materialFog.js';

const WATER_CELL_M = 2000;
const MASK_CELL_M = 64;
const MAX_CREEK_BOULDERS = 1500;

const WATER_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec2 vFlowUv;
varying float vFoam;
varying float vTurquoise;
varying float vDepth;

attribute float aFoam;
attribute float aTurquoise;
attribute float aDepth;

#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  vFlowUv = uv;
  vFoam = aFoam;
  vTurquoise = aTurquoise;
  vDepth = aDepth;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const WATER_FRAG = /* glsl */ `
uniform sampler2D uNormalMap;
uniform float uReflective;

varying vec3 vWorldPos;
varying vec2 vFlowUv;
varying float vFoam;
varying float vTurquoise;
varying float vDepth;

#include <common>
#include <logdepthbuf_pars_fragment>
${SAN_JUAN_FOG_GLSL}

void main() {
  #include <logdepthbuf_fragment>

  vec3 viewVec = normalize(cameraPosition - vWorldPos);

  // Continuous cell-local isotropic UVs (no fragment fract() mipmap jump, zero Moire or lengthwise stripes!)
  mat2 rot37 = mat2(0.7986, -0.6018, 0.6018, 0.7986);
  vec2 uv1;
  vec2 uv2;
  if (vFoam > 0.005) {
    // Stream flow UVs are isotropic in world meters; vFlowUv.y flows downstream
    uv1 = vFlowUv + vec2(0.0, -uTime * 0.65);
    uv2 = rot37 * (vFlowUv * 1.73) + vec2(uTime * 0.14, -uTime * 0.95);
  } else {
    // Lake UVs: two non-collinear wind-drifting organic fBm octaves
    uv1 = vFlowUv + vec2(uTime * 0.018, -uTime * 0.024);
    uv2 = rot37 * (vFlowUv * 2.17) + vec2(-uTime * 0.029, uTime * 0.019);
  }

  vec4 t1 = texture2D(uNormalMap, uv1);
  vec4 t2 = texture2D(uNormalMap, uv2);
  vec3 n1 = t1.xyz * 2.0 - 1.0;
  vec3 n2 = t2.xyz * 2.0 - 1.0;
  float ripStrength = vFoam > 0.005 ? 0.52 : 0.30;
  vec3 N = normalize(vec3((n1.x + n2.x) * ripStrength, 1.0, (n1.y + n2.y) * ripStrength));

  // Water absorption palette:
  // Shallow rocky streambed/shoreline -> cold dark wet slate/pebble; deep lakes -> cobalt or glacial Ice Lake turquoise
  vec3 wetRockBed = vec3(0.022, 0.032, 0.034);
  vec3 creekDeep = vec3(0.024, 0.072, 0.088);
  vec3 lakeCobalt = vec3(0.020, 0.095, 0.155);
  vec3 glacialTurq = vec3(0.032, 0.355, 0.395);

  vec3 deepWaterCol = vFoam > 0.005
    ? mix(creekDeep, glacialTurq * 0.65, vTurquoise * 0.5)
    : mix(lakeCobalt, glacialTurq, vTurquoise);
  vec3 shallowBed = vFoam > 0.005
    ? wetRockBed
    : mix(vec3(0.030, 0.068, 0.086), vec3(0.095, 0.350, 0.372), vTurquoise);
  vec3 baseCol = mix(shallowBed, deepWaterCol, smoothstep(0.0, 0.58, vDepth));

  float ndv = clamp(dot(N, viewVec), 0.03, 1.0);
  float fresnel = 0.025 + 0.975 * pow(1.0 - ndv, 4.5);

  vec3 reflDir = reflect(-viewVec, N);
  vec3 skyRefl = mix(uHorizonColor * 0.82, uSkyAmbientColor * 1.12, clamp(reflDir.y * 1.4, 0.0, 1.0));
  if (uReflective > 0.5) {
    skyRefl *= 0.86 + 0.28 * clamp(reflDir.y * 2.0, 0.0, 1.0);
  }

  vec3 H = normalize(uSunDir + viewVec);
  float spec = pow(max(dot(N, H), 0.0), mix(110.0, 240.0, uReflective));
  vec3 sunSpec = uSunColor * spec * (0.95 + uReflective * 1.25) * (1.0 - uRainAmount * 0.85);

  float reflWeight = fresnel * (vFoam > 0.005 ? 0.38 : (0.52 + uReflective * 0.22));
  vec3 waterCol = mix(baseCol, skyRefl, reflWeight) + sunSpec;

  float alpha;
  if (vFoam > 0.005) {
    // Organic broken riffle whitewater pockets from fBm turbulence height (t1.a * t2.a), NEVER stripes!
    float turb = t1.a * t2.a * 2.35;
    float pocket = smoothstep(0.42, 0.92, turb) * vFoam * smoothstep(0.10, 0.55, vDepth);
    vec3 foamCol = (uSkyAmbientColor * 0.45 + uSunColor * 0.45) * 0.86;
    waterCol = mix(waterCol, foamCol, clamp(pocket, 0.0, 0.62));
    // Soft feathered wet creek banks (vDepth = 0 at bank edge -> 0.85 at thalweg)
    alpha = clamp(smoothstep(0.0, 0.42, vDepth) * 0.86, 0.0, 0.88);
    if (alpha < 0.03) discard;
  } else {
    // Lakes: feathered mineral-silt shoreline -> 0.992 opaque deep basin (hides underlying NAIP/LOD seams!)
    alpha = mix(0.32, 0.992, smoothstep(0.0, 0.42, vDepth));
  }

  waterCol = applySanJuanAtmosphere(waterCol, vWorldPos, cameraPosition);
  gl_FragColor = vec4(waterCol, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const WATERFALL_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const WATERFALL_FRAG = /* glsl */ `
uniform sampler2D uNormalMap;

varying vec2 vUv;
varying vec3 vWorldPos;

#include <common>
#include <logdepthbuf_pars_fragment>
${SAN_JUAN_FOG_GLSL}

void main() {
  #include <logdepthbuf_fragment>
  vec2 uv1 = vec2(vUv.x * 2.4, vUv.y * 3.5 + uTime * 1.45);
  vec2 uv2 = vec2(vUv.x * 4.8 + 0.3, vUv.y * 5.0 + uTime * 2.15);
  float s1 = texture2D(uNormalMap, uv1).a;
  float s2 = texture2D(uNormalMap, uv2).a;
  float streaks = smoothstep(0.24, 0.84, s1 * 0.55 + s2 * 0.45);

  float edgeMask = pow(max(sin(vUv.x * 3.14159265), 0.0), 1.18);
  float topLipFade = smoothstep(0.0, 0.15, 1.0 - vUv.y);
  float bottomSplash = smoothstep(0.0, 0.28, vUv.y);
  float alpha = clamp((0.30 + streaks * 0.65) * edgeMask * topLipFade * (0.35 + 0.65 * bottomSplash), 0.0, 0.88);
  if (alpha < 0.03) discard;

  vec3 lightCol = uSkyAmbientColor * 0.52 + uSunColor * 0.62;
  vec3 waterCol = mix(vec3(0.38, 0.52, 0.60) * lightCol, vec3(0.92, 0.96, 1.0) * lightCol, streaks);
  waterCol = applySanJuanAtmosphere(waterCol, vWorldPos, cameraPosition);

  gl_FragColor = vec4(waterCol, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const MIST_VERT = /* glsl */ `
attribute float aSeed;
uniform float uTime;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  if (aSeed < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
  } else {
    float life = fract(aSeed + uTime * 0.22);
    vec3 pos = position;
    pos.y += life * 16.0;
    pos.x += sin(aSeed * 31.4 + uTime * 0.8) * (2.0 + life * 7.0);
    pos.z += cos(aSeed * 21.7 + uTime * 0.7) * (2.0 + life * 7.0);
    vAlpha = sin(life * 3.14159265) * 0.36;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = clamp((240.0 + life * 320.0) / max(-mvPosition.z, 1.0), 3.0, 64.0);
    gl_Position = projectionMatrix * mvPosition;
  }
  #include <logdepthbuf_vertex>
}
`;

const MIST_FRAG = /* glsl */ `
uniform sampler2D uMistMap;
varying float vAlpha;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec4 tex = texture2D(uMistMap, gl_PointCoord);
  float a = tex.a * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(tex.rgb * 0.92, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const ICONIC_WATERFALLS = [
  { id: 'iconic_bridal_veil', name: 'Bridal Veil Falls', lon: -107.7689, lat: 37.9211, heightM: 111, fallbackY: 3090 },
  { id: 'iconic_ingram', name: 'Ingram Falls', lon: -107.7753, lat: 37.9286, heightM: 65, fallbackY: 3250 },
  { id: 'iconic_cornet', name: 'Cornet Creek Falls', lon: -107.8075, lat: 37.9438, heightM: 24, fallbackY: 2810 },
  { id: 'iconic_bear_creek_ouray', name: 'Bear Creek Falls', lon: -107.6634, lat: 37.9912, heightM: 69, fallbackY: 2630 },
];

function sampleElev(terrain, x, z, fallbackY) {
  const h = terrain.getHeight(x, z);
  if (!Number.isFinite(h)) return fallbackY;
  if (h === 2667 && Number.isFinite(fallbackY) && Math.abs(fallbackY - 2667) > 22) {
    return fallbackY;
  }
  return h;
}

function buildCobbleGeometry() {
  const geo = new THREE.IcosahedronGeometry(1.0, 1);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = (Math.round(x * 100) * 73856093) ^ (Math.round(y * 100) * 19349663) ^ (Math.round(z * 100) * 83492791);
    const rng = mulberry32((k ^ 4421) >>> 0);
    const d = 0.80 + rng() * 0.34;
    // Smooth water-worn river cobble (flattened vertically)
    pos.setXYZ(i, x * d, y * (y < 0 ? 0.45 : 0.62 * d), z * d);
    const wet = y < 0.05 ? 0.52 : 0.78 + Math.min(0.20, y * 0.22);
    colors[i * 3] = wet;
    colors[i * 3 + 1] = wet * 1.02;
    colors[i * 3 + 2] = wet * 1.04;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function mergeWaterParts(parts) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const p of parts) {
    if (!p) continue;
    totalVerts += p.pos.length / 3;
    totalIndices += p.idx.length;
  }
  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const foams = new Float32Array(totalVerts);
  const turq = new Float32Array(totalVerts);
  const depths = new Float32Array(totalVerts);
  const indices = totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

  let vOff = 0;
  let iOff = 0;
  for (const p of parts) {
    if (!p) continue;
    const vCount = p.pos.length / 3;
    positions.set(p.pos, vOff * 3);
    uvs.set(p.uv, vOff * 2);
    foams.set(p.foam, vOff);
    turq.set(p.turq, vOff);
    depths.set(p.depth, vOff);
    for (let k = 0; k < p.idx.length; k++) {
      indices[iOff + k] = p.idx[k] + vOff;
    }
    vOff += vCount;
    iOff += p.idx.length;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('aFoam', new THREE.BufferAttribute(foams, 1));
  geo.setAttribute('aTurquoise', new THREE.BufferAttribute(turq, 1));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  // Fast flat-array bounding box & sphere (avoids slow Vector3.fromBufferAttribute loop in V8)
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (minX <= maxX) {
    geo.boundingBox = new THREE.Box3(
      new THREE.Vector3(minX, minY, minZ),
      new THREE.Vector3(maxX, maxY, maxZ)
    );
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(cx, cy, cz),
      Math.hypot(maxX - cx, maxY - cy, maxZ - cz)
    );
  } else {
    geo.computeBoundingSphere();
  }
  return geo;
}

function distSqToSegmentXZ(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  let t = 0;
  if (lenSq > 1e-4) {
    t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  }
  const ex = px - (ax + dx * t);
  const ez = pz - (az + dz * t);
  return ex * ex + ez * ez;
}

function pointInRingOrNearEdge(px, pz, ringXZ, padM) {
  const n = ringXZ.length >> 1;
  if (n < 3) return false;
  let inside = false;
  const padSq = padM * padM;
  let nearEdge = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ringXZ[i * 2], zi = ringXZ[i * 2 + 1];
    const xj = ringXZ[j * 2], zj = ringXZ[j * 2 + 1];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-9) + xi) {
      inside = !inside;
    }
    if (padM !== 0 && !nearEdge && distSqToSegmentXZ(px, pz, xj, zj, xi, zi) <= padSq) {
      nearEdge = true;
      if (padM > 0) return true;
    }
  }
  if (padM < 0 && inside && nearEdge) return false;
  return inside;
}

export function createWater(engine, terrain, trailData, atmosphere) {
  const { scene, events, scheduler } = engine;
  const textures = engine.worldTextures;
  const root = new THREE.Group();
  root.name = 'SanJuanWater';
  scene.add(root);

  let disposed = false;

  // --- Spatial Water Exclusion Mask exported for @flora & @gameplay (Ice Lake, Blue Lakes, rivers!) ---
  const lakeGrid = new Map();   // cellKey -> Array<{ minX, minZ, maxX, maxZ, ringXZ: Float32Array }>
  const streamGrid = new Map(); // cellKey -> Float32Array|Array [ax, az, bx, bz, halfW, ...]

  function maskKey(cx, cz) {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  function indexLakeMask(lake) {
    const coords = lake.coords;
    if (!coords || coords.length < 9) return null;
    const n = Math.floor(coords.length / 3);
    const ringXZ = new Float32Array(n * 2);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = coords[i * 3];
      const z = coords[i * 3 + 2];
      ringXZ[i * 2] = x;
      ringXZ[i * 2 + 1] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const entry = { minX, minZ, maxX, maxZ, ringXZ };
    const pad = 16;
    const cx0 = Math.floor((minX - pad) / MASK_CELL_M);
    const cx1 = Math.floor((maxX + pad) / MASK_CELL_M);
    const cz0 = Math.floor((minZ - pad) / MASK_CELL_M);
    const cz1 = Math.floor((maxZ + pad) / MASK_CELL_M);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = maskKey(cx, cz);
        let arr = lakeGrid.get(k);
        if (!arr) {
          arr = [];
          lakeGrid.set(k, arr);
        }
        arr.push(entry);
      }
    }
    return [minX, minZ, maxX, maxZ];
  }

  function indexWaterwayMask(w) {
    const raw = w.coords;
    if (!raw || raw.length < 6) return null;
    const isRiver = w.kind === 'river';
    const hasName = Boolean(w.name && w.name.trim().length > 0);
    const halfW = (isRiver ? Math.max(5.0, Math.min(10.5, w.widthM || 6.8)) : hasName ? 1.8 : 0.6) * 0.5;

    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i <= raw.length - 6; i += 3) {
      const ax = raw[i], az = raw[i + 2];
      const bx = raw[i + 3], bz = raw[i + 5];
      if (ax < minX) minX = ax; if (bx < minX) minX = bx;
      if (ax > maxX) maxX = ax; if (bx > maxX) maxX = bx;
      if (az < minZ) minZ = az; if (bz < minZ) minZ = bz;
      if (az > maxZ) maxZ = az; if (bz > maxZ) maxZ = bz;

      const pad = halfW + 8;
      const cx0 = Math.floor((Math.min(ax, bx) - pad) / MASK_CELL_M);
      const cx1 = Math.floor((Math.max(ax, bx) + pad) / MASK_CELL_M);
      const cz0 = Math.floor((Math.min(az, bz) - pad) / MASK_CELL_M);
      const cz1 = Math.floor((Math.max(az, bz) + pad) / MASK_CELL_M);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = maskKey(cx, cz);
          let arr = streamGrid.get(k);
          if (!arr) {
            arr = [];
            streamGrid.set(k, arr);
          }
          arr.push(ax, az, bx, bz, halfW);
        }
      }
    }
    return [minX, minZ, maxX, maxZ];
  }

  const worldWaterMask = {
    isInLake(x, z, padM = 1.5) {
      const bucket = lakeGrid.get(maskKey(Math.floor(x / MASK_CELL_M), Math.floor(z / MASK_CELL_M)));
      if (!bucket) return false;
      for (let i = 0; i < bucket.length; i++) {
        const l = bucket[i];
        if (x < l.minX - padM || x > l.maxX + padM || z < l.minZ - padM || z > l.maxZ + padM) continue;
        if (pointInRingOrNearEdge(x, z, l.ringXZ, padM)) return true;
      }
      return false;
    },
    isInWater(x, z, padM = 1.5) {
      if (this.isInLake(x, z, padM)) return true;
      const sBucket = streamGrid.get(maskKey(Math.floor(x / MASK_CELL_M), Math.floor(z / MASK_CELL_M)));
      if (!sBucket) return false;
      for (let i = 0; i < sBucket.length; i += 5) {
        const thresh = sBucket[i + 4] + padM;
        if (distSqToSegmentXZ(x, z, sBucket[i], sBucket[i + 1], sBucket[i + 2], sBucket[i + 3]) <= thresh * thresh) {
          return true;
        }
      }
      return false;
    },
  };
  engine.worldWaterMask = worldWaterMask;

  const waterUniforms = {
    ...atmosphere.uniforms,
    uNormalMap: { value: textures.waterNormal },
    uReflective: { value: engine.quality.water === 'reflective' ? 1.0 : 0.0 },
  };

  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: waterUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const waterfallMat = new THREE.ShaderMaterial({
    vertexShader: WATERFALL_VERT,
    fragmentShader: WATERFALL_FRAG,
    uniforms: waterUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mistMat = new THREE.ShaderMaterial({
    vertexShader: MIST_VERT,
    fragmentShader: MIST_FRAG,
    uniforms: {
      uTime: atmosphere.uniforms.uTime,
      uMistMap: { value: textures.mist },
    },
    transparent: true,
    depthWrite: false,
  });

  const disposables = new Set();
  const resnapCancels = new Set();

  // Instanced wet creek cobbles & riffle boulders (1 draw call for rocky mountain brooks!)
  const cobbleGeo = buildCobbleGeometry();
  disposables.add(cobbleGeo);
  const cobbleMat = patchSanJuanMaterial(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.36, // wet river-rock sheen!
      metalness: 0.04,
      flatShading: true,
    }),
    atmosphere.uniforms
  );
  const cobbleMesh = new THREE.InstancedMesh(cobbleGeo, cobbleMat, MAX_CREEK_BOULDERS);
  cobbleMesh.count = 0;
  cobbleMesh.frustumCulled = false;
  cobbleMesh.receiveShadow = true;
  const _initCol = new THREE.Color(1, 1, 1);
  for (let i = 0; i < MAX_CREEK_BOULDERS; i++) cobbleMesh.setColorAt(i, _initCol);
  cobbleMesh.instanceColor.needsUpdate = true;
  root.add(cobbleMesh);

  const seenWaterways = new Set();
  const seenLakes = new Set();
  const seenWaterfalls = new Set();

  // 2000m x 2000m merged water cells
  const waterCells = new Map(); // cellKey -> { entries, parts, cobbles, mesh, dirty, resnapping, sampleX, sampleZ, sampleY }
  const pendingQueue = [];
  let taskScheduled = false;
  let cancelTask = null;
  let cobblesDirty = true;
  let lastCobbleX = 1e9;
  let lastCobbleZ = 1e9;

  const mistPosList = [];
  const mistSeedList = [];
  let mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  mistGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute([], 1));
  disposables.add(mistGeo);
  const mistPoints = new THREE.Points(mistGeo, mistMat);
  mistPoints.frustumCulled = false;
  mistPoints.renderOrder = 4;
  root.add(mistPoints);

  const waterfallNodes = [];

  function rebuildMistPoints() {
    if (disposed) return;
    const nextGeo = new THREE.BufferGeometry();
    nextGeo.setAttribute('position', new THREE.Float32BufferAttribute(mistPosList, 3));
    nextGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(mistSeedList, 1));
    disposables.delete(mistGeo);
    mistGeo.dispose();
    mistGeo = nextGeo;
    disposables.add(mistGeo);
    mistPoints.geometry = mistGeo;
  }

  function isGlacialTurquoise(name, y) {
    const n = (name || '').toLowerCase();
    if (/ice lake|island lake|blue lake|clear lake|columbine lake|turquoise/.test(n)) return 1.0;
    return y > 3500 ? 0.72 : 0.0;
  }

  /**
   * Build a 2-zone lake mesh (feathered shallow shoreline ring -> opaque deep turquoise interior)
   * with continuous cell-local world UVs so there are ZERO Moire stripes and ZERO terrain LOD seams!
   */
  function buildLakePart(lake) {
    const coords = lake.coords;
    if (!coords || coords.length < 9) return null;

    const ring = [];
    let sumY = 0;
    let cx = 0, cz = 0;
    const rawCount = Math.floor(coords.length / 3);
    for (let i = 0; i < rawCount; i++) {
      const x = coords[i * 3];
      const z = coords[i * 3 + 2];
      if (i === rawCount - 1 && Math.hypot(x - coords[0], z - coords[2]) < 0.1) break;
      ring.push(new THREE.Vector2(x, z));
      sumY += coords[i * 3 + 1];
      cx += x;
      cz += z;
    }
    const n = ring.length;
    if (n < 3) return null;
    cx /= n;
    cz /= n;

    const baseY = Number.isFinite(lake.y) ? lake.y : sumY / rawCount;
    const tVal = isGlacialTurquoise(lake.name, baseY);
    const cellOriginX = Math.floor(cx / WATER_CELL_M) * WATER_CELL_M;
    const cellOriginZ = Math.floor(cz / WATER_CELL_M) * WATER_CELL_M;

    // Ensure consistent CCW 2D winding in (x, z) so inward bisector normal always points into the lake!
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 < 0) ring.reverse();

    // Sample flat lake-center DEM so lakeY sits +0.24m above z15 water floor without flooding shore knolls!
    const centerDemY = sampleElev(terrain, cx, cz, baseY);
    const refSurfaceY = Number.isFinite(centerDemY)
      ? Math.max(baseY, Math.min(baseY + 0.85, centerDemY))
      : baseY;
    const lakeY = refSurfaceY + 0.24;

    // Outer ring (shoreline aDepth=0) + constant 1.8m inward-normal inset polygon (aDepth=1)
    const innerTris = THREE.ShapeUtils.triangulateShape(ring, []);
    if (!innerTris || innerTris.length === 0) return null;

    const vertCount = n * 2;
    const pos = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const foam = new Float32Array(vertCount);
    const turq = new Float32Array(vertCount);
    const depth = new Float32Array(vertCount);

    const insetM = 1.8;
    for (let i = 0; i < n; i++) {
      const prev = ring[(i - 1 + n) % n];
      const cur = ring[i];
      const next = ring[(i + 1) % n];
      // With area2 > 0, edge (a -> b) has inward left-hand normal (-dy, dx) / len!
      let e0x = cur.x - prev.x, e0y = cur.y - prev.y;
      const l0 = Math.hypot(e0x, e0y) || 1;
      e0x /= l0; e0y /= l0;
      let e1x = next.x - cur.x, e1y = next.y - cur.y;
      const l1 = Math.hypot(e1x, e1y) || 1;
      e1x /= l1; e1y /= l1;

      let inx = -e0y - e1y;
      let inz = e0x + e1x;
      const inLen = Math.hypot(inx, inz);
      if (inLen > 0.05) {
        inx /= inLen;
        inz /= inLen;
      } else {
        inx = -e1y;
        inz = e1x;
      }
      const maxInset = Math.min(insetM, Math.min(l0, l1) * 0.35);
      const ox = cur.x;
      const oz = cur.y;
      const ix = ox + inx * maxInset;
      const iz = oz + inz * maxInset;

      // Outer vertex i (shoreline)
      pos[i * 3] = ox;
      pos[i * 3 + 1] = lakeY - 0.03;
      pos[i * 3 + 2] = oz;
      uv[i * 2] = (ox - cellOriginX) * 0.055;
      uv[i * 2 + 1] = (oz - cellOriginZ) * 0.055;
      foam[i] = 0.0;
      turq[i] = tVal;
      depth[i] = 0.0;

      // Inner vertex n + i (deep lake)
      const k = n + i;
      pos[k * 3] = ix;
      pos[k * 3 + 1] = lakeY;
      pos[k * 3 + 2] = iz;
      uv[k * 2] = (ix - cellOriginX) * 0.055;
      uv[k * 2 + 1] = (iz - cellOriginZ) * 0.055;
      foam[k] = 0.0;
      turq[k] = tVal;
      depth[k] = 1.0;
    }

    // Skirt quads connecting outer ring -> inner ring + triangulated inner ring
    const idx = new Uint32Array(n * 6 + innerTris.length * 3);
    let ptr = 0;
    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      idx[ptr++] = i;
      idx[ptr++] = ni;
      idx[ptr++] = n + ni;
      idx[ptr++] = i;
      idx[ptr++] = n + ni;
      idx[ptr++] = n + i;
    }
    for (let t = 0; t < innerTris.length; t++) {
      idx[ptr++] = n + innerTris[t][0];
      idx[ptr++] = n + innerTris[t][1];
      idx[ptr++] = n + innerTris[t][2];
    }

    return { x: cx, z: cz, pos, uv, foam, turq, depth, idx, cobbles: null };
  }

  /**
   * Build a thalweg-gravitated 3-strip mountain brook/river with independent bank elevations,
   * isotropic world-meter UVs, and wet bank/riffle cobbles!
   */
  function buildWaterwayPart(w) {
    const raw = w.coords;
    if (!raw || raw.length < 6) return null;

    const isRiver = w.kind === 'river';
    const hasName = Boolean(w.name && w.name.trim().length > 0);
    let widthM;
    if (isRiver) {
      widthM = Math.max(5.0, Math.min(10.0, w.widthM || 6.5));
    } else if (hasName) {
      widthM = Math.max(1.3, Math.min(2.3, w.widthM ? Math.min(w.widthM, 2.3) : 1.75));
    } else {
      widthM = 0.68;
    }
    const halfW = widthM * 0.5;

    const pts = [];
    const nPts = Math.floor(raw.length / 3);
    for (let i = 0; i < nPts - 1; i++) {
      const ax = raw[i * 3], ay = raw[i * 3 + 1], az = raw[i * 3 + 2];
      const bx = raw[(i + 1) * 3], by = raw[(i + 1) * 3 + 1], bz = raw[(i + 1) * 3 + 2];
      const dist = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(dist / 6.5));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        pts.push({
          x: ax + (bx - ax) * t,
          y: ay + (by - ay) * t,
          z: az + (bz - az) * t,
        });
      }
    }
    pts.push({ x: raw[(nPts - 1) * 3], y: raw[(nPts - 1) * 3 + 1], z: raw[(nPts - 1) * 3 + 2] });
    if (pts.length < 2) return null;

    // Gravitate stream centerline slightly toward the local DEM gully/thalweg minimum (±4.5m)
    const rawShifted = new Float32Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      const rx = -dz / len;
      const rz = dx / len;

      let bestOff = 0;
      let bestH = sampleElev(terrain, p.x, p.z, p.y);
      for (let off = -4.5; off <= 4.5; off += 2.25) {
        if (off === 0) continue;
        const hTest = sampleElev(terrain, p.x + rx * off, p.z + rz * off, p.y);
        if (hTest < bestH - 0.12) {
          bestH = hTest;
          bestOff = off;
        }
      }
      rawShifted[i * 2] = p.x + rx * bestOff;
      rawShifted[i * 2 + 1] = p.z + rz * bestOff;
    }
    // 3-point smooth shifted XZ so channel meanders naturally without kinks
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i].x = rawShifted[(i - 1) * 2] * 0.25 + rawShifted[i * 2] * 0.5 + rawShifted[(i + 1) * 2] * 0.25;
      pts[i].z = rawShifted[(i - 1) * 2 + 1] * 0.25 + rawShifted[i * 2 + 1] * 0.5 + rawShifted[(i + 1) * 2 + 1] * 0.25;
    }
    pts[0].x = rawShifted[0]; pts[0].z = rawShifted[1];
    pts[pts.length - 1].x = rawShifted[(pts.length - 1) * 2];
    pts[pts.length - 1].z = rawShifted[(pts.length - 1) * 2 + 1];

    // 3 vertices per cross-section: Left Bank (0), Thalweg Center (1), Right Bank (2)
    const vertCount = pts.length * 3;
    const pos = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const foam = new Float32Array(vertCount);
    const turq = new Float32Array(vertCount);
    const depth = new Float32Array(vertCount);
    const idx = new Uint32Array((pts.length - 1) * 12);

    const cobbles = [];
    const rng = mulberry32(hash2i(Math.round(pts[0].x), Math.round(pts[0].z), 613));
    const maxFoam = isRiver || hasName ? 0.65 : 0.36;
    const uvScale = 0.34; // isotropic meter-to-UV scale!

    let cumDist = 0;
    let idxPtr = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      if (i > 0) cumDist += Math.hypot(p.x - prev.x, p.z - prev.z);

      const rx = -dz / len;
      const rz = dx / len;
      // Organic natural bank width undulation
      const widthMod = 0.84 + 0.32 * Math.sin(cumDist * 0.19 + i * 0.7);
      const hw = halfW * widthMod;

      const lx = p.x - rx * hw, lz = p.z - rz * hw;
      const rxp = p.x + rx * hw, rzp = p.z + rz * hw;

      const yL = sampleElev(terrain, lx, lz, p.y) + 0.03;
      const yR = sampleElev(terrain, rxp, rzp, p.y) + 0.03;
      const yC = Math.min(sampleElev(terrain, p.x, p.z, p.y), (yL + yR) * 0.5) + 0.06;

      const segDs = Math.max(1, Math.hypot(next.x - prev.x, next.z - prev.z));
      const slope = Math.abs(next.y - prev.y) / segDs;
      const fVal = Math.min(maxFoam, 0.12 + slope * 2.2);

      const vBase = i * 3;
      // Left bank
      pos[vBase * 3] = lx; pos[vBase * 3 + 1] = yL; pos[vBase * 3 + 2] = lz;
      uv[vBase * 2] = -hw * uvScale; uv[vBase * 2 + 1] = cumDist * uvScale;
      foam[vBase] = fVal * 0.7; turq[vBase] = 0.14; depth[vBase] = 0.0;

      // Center thalweg
      pos[(vBase + 1) * 3] = p.x; pos[(vBase + 1) * 3 + 1] = yC; pos[(vBase + 1) * 3 + 2] = p.z;
      uv[(vBase + 1) * 2] = 0.0; uv[(vBase + 1) * 2 + 1] = cumDist * uvScale;
      foam[vBase + 1] = fVal; turq[vBase + 1] = 0.18; depth[vBase + 1] = 0.85;

      // Right bank
      pos[(vBase + 2) * 3] = rxp; pos[(vBase + 2) * 3 + 1] = yR; pos[(vBase + 2) * 3 + 2] = rzp;
      uv[(vBase + 2) * 2] = hw * uvScale; uv[(vBase + 2) * 2 + 1] = cumDist * uvScale;
      foam[vBase + 2] = fVal * 0.7; turq[vBase + 2] = 0.14; depth[vBase + 2] = 0.0;

      const inLakeCur = worldWaterMask.isInLake(p.x, p.z, -0.5);

      // Scatter wet creek boulders/cobbles along named creeks & rivers (never inside lake basins!)
      if (!inLakeCur && (isRiver || hasName) && i % 2 === 0 && rng() < 0.72) {
        const side = rng() < 0.5 ? -1 : 1;
        const bankFrac = rng() < 0.25 ? (rng() - 0.5) * 0.9 : side * (0.72 + rng() * 0.42);
        const bx = p.x + rx * hw * bankFrac;
        const bz = p.z + rz * hw * bankFrac;
        const by = sampleElev(terrain, bx, bz, p.y);
        const s = (isRiver ? 0.38 : 0.24) + Math.pow(rng(), 1.8) * (isRiver ? 0.75 : 0.48);
        const shade = 0.24 + rng() * 0.18; // dark wet river granite/slate
        cobbles.push({
          x: bx,
          y: by - s * 0.14,
          z: bz,
          ry: rng() * Math.PI * 2,
          sx: s * (0.85 + rng() * 0.45),
          sy: s * (0.55 + rng() * 0.35),
          sz: s * (0.85 + rng() * 0.45),
          r: shade * 0.96,
          g: shade * 0.98,
          b: shade * 1.04,
        });
      }

      if (i < pts.length - 1 && !(inLakeCur && worldWaterMask.isInLake(pts[i + 1].x, pts[i + 1].z, -0.5))) {
        const b = i * 3;
        const n0 = b + 3;
        const o = idxPtr;
        idxPtr += 12;
        // Left strip (b, b+1, n0, n0+1)
        idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = n0;
        idx[o + 3] = b + 1; idx[o + 4] = n0 + 1; idx[o + 5] = n0;
        // Right strip (b+1, b+2, n0+1, n0+2)
        idx[o + 6] = b + 1; idx[o + 7] = b + 2; idx[o + 8] = n0 + 1;
        idx[o + 9] = b + 2; idx[o + 10] = n0 + 2; idx[o + 11] = n0 + 1;
      }
    }

    if (idxPtr === 0) return null;
    return { x: pts[0].x, z: pts[0].z, pos, uv, foam, turq, depth, idx: idx.subarray(0, idxPtr), cobbles };
  }

  let pendingHead = 0;
  let waterSinceFlush = 0;
  let waterLastFlushMs = 0;

  function flushWaterCells(maxCells = Infinity) {
    if (disposed) return false;
    let ops = 0;
    let hasMore = false;
    for (const cell of waterCells.values()) {
      if (!cell.dirty || cell.parts.length === 0) continue;
      if (ops >= maxCells) {
        hasMore = true;
        break;
      }
      cell.dirty = false;
      const merged = mergeWaterParts(cell.parts);
      if (cell.mesh) {
        disposables.delete(cell.mesh.geometry);
        cell.mesh.geometry.dispose();
        cell.mesh.geometry = merged;
      } else {
        const mesh = new THREE.Mesh(merged, waterMat);
        mesh.renderOrder = 2;
        root.add(mesh);
        cell.mesh = mesh;
      }
      disposables.add(merged);
      cobblesDirty = true;
      ops++;
    }
    return hasMore;
  }

  function processWaterSlice() {
    if (disposed) return false;
    const start = performance.now();
    let count = 0;
    while (pendingHead < pendingQueue.length && count < 18 && performance.now() - start < 2.0) {
      const entry = pendingQueue[pendingHead++];
      const part = entry.type === 'lake' ? buildLakePart(entry.item) : buildWaterwayPart(entry.item);
      count++;
      if (!part) continue;

      const key = `${Math.floor(part.x / WATER_CELL_M)}_${Math.floor(part.z / WATER_CELL_M)}`;
      let cell = waterCells.get(key);
      if (!cell) {
        const fallbackY = entry.type === 'lake' ? (entry.item.y ?? 2800) : (entry.item.coords?.[1] ?? 2800);
        cell = {
          key,
          cx: (Math.floor(part.x / WATER_CELL_M) + 0.5) * WATER_CELL_M,
          cz: (Math.floor(part.z / WATER_CELL_M) + 0.5) * WATER_CELL_M,
          entries: [],
          parts: [],
          mesh: null,
          dirty: false,
          resnapping: false,
          probes: [{ x: part.x, z: part.z, y: sampleElev(terrain, part.x, part.z, fallbackY), fb: fallbackY }],
        };
        waterCells.set(key, cell);
      } else if (cell.probes.length < 4) {
        const fallbackY = entry.type === 'lake' ? (entry.item.y ?? 2800) : (entry.item.coords?.[1] ?? 2800);
        cell.probes.push({ x: part.x, z: part.z, y: sampleElev(terrain, part.x, part.z, fallbackY), fb: fallbackY });
      }
      cell.entries.push({ type: entry.type, item: entry.item, partIdx: cell.parts.length });
      cell.parts.push(part);
      cell.dirty = true;
    }
    if (pendingHead >= 128 || pendingHead >= pendingQueue.length) {
      if (pendingHead >= pendingQueue.length) {
        pendingQueue.length = 0;
      } else {
        pendingQueue.splice(0, pendingHead);
      }
      pendingHead = 0;
    }

    waterSinceFlush += count;
    const now = performance.now();
    if (pendingHead >= pendingQueue.length) {
      const moreDirty = flushWaterCells(1);
      waterSinceFlush = 0;
      waterLastFlushMs = now;
      if (moreDirty) return true;
      taskScheduled = false;
      return false;
    }
    if (waterSinceFlush >= 64 && now - waterLastFlushMs >= 400) {
      waterSinceFlush = 0;
      waterLastFlushMs = now;
      flushWaterCells(1);
    }
    return true;
  }

  function enqueueWaterBatch(lakes, waterways) {
    let added = 0;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const expand = (b) => {
      if (!b) return;
      if (b[0] < minX) minX = b[0];
      if (b[1] < minZ) minZ = b[1];
      if (b[2] > maxX) maxX = b[2];
      if (b[3] > maxZ) maxZ = b[3];
    };

    if (lakes) {
      for (let i = 0; i < lakes.length; i++) {
        const l = lakes[i];
        const id = l.id || l.name || JSON.stringify(l.bbox);
        if (seenLakes.has(id)) continue;
        seenLakes.add(id);
        expand(indexLakeMask(l));
        pendingQueue.push({ type: 'lake', item: l });
        added++;
      }
    }
    if (waterways) {
      for (let i = 0; i < waterways.length; i++) {
        const w = waterways[i];
        const id = w.id || `${w.name || 'stream'}_${seenWaterways.size}`;
        if (seenWaterways.has(id)) continue;
        seenWaterways.add(id);
        expand(indexWaterwayMask(w));
        pendingQueue.push({ type: 'waterway', item: w });
        added++;
      }
    }
    if (added > 0) {
      if (Number.isFinite(minX)) {
        events.emit('world:watermask', { bounds: [minX, minZ, maxX, maxZ] });
      }
      if (!taskScheduled) {
        taskScheduled = true;
        if (scheduler?.enqueue) {
          cancelTask = scheduler.enqueue(processWaterSlice, { priority: 14, label: 'world:water' });
        } else {
          while (processWaterSlice()) { /* sync fallback */ }
        }
      }
    }
  }

  const _cMat = new THREE.Matrix4();
  const _cPos = new THREE.Vector3();
  const _cQuat = new THREE.Quaternion();
  const _cScale = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);
  const _cCol = new THREE.Color();

  function packCobbles(px, pz) {
    let count = 0;
    const rad = engine.quality.tier === 'low' ? 90 : 250;
    const r2 = rad * rad;
    const cx0 = Math.floor((px - rad) / WATER_CELL_M);
    const cx1 = Math.floor((px + rad) / WATER_CELL_M);
    const cz0 = Math.floor((pz - rad) / WATER_CELL_M);
    const cz1 = Math.floor((pz + rad) / WATER_CELL_M);

    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = waterCells.get(`${cx}_${cz}`);
        if (!cell) continue;
        for (let p = 0; p < cell.parts.length; p++) {
          const cobs = cell.parts[p]?.cobbles;
          if (!cobs) continue;
          for (let i = 0; i < cobs.length && count < MAX_CREEK_BOULDERS; i++) {
            const c = cobs[i];
            const dx = c.x - px;
            const dz = c.z - pz;
            if (dx * dx + dz * dz > r2) continue;
            _cPos.set(c.x, c.y, c.z);
            _cQuat.setFromAxisAngle(_yAxis, c.ry);
            _cScale.set(c.sx, c.sy, c.sz);
            _cMat.compose(_cPos, _cQuat, _cScale);
            _cCol.setRGB(c.r, c.g, c.b);
            cobbleMesh.setMatrixAt(count, _cMat);
            cobbleMesh.setColorAt(count, _cCol);
            count++;
          }
        }
      }
    }
    cobbleMesh.count = count;
    cobbleMesh.instanceMatrix.needsUpdate = true;
    cobbleMesh.instanceColor.needsUpdate = true;
  }

  function computeCliffFacing(x, z) {
    const norm = terrain.getNormal(x, z);
    let fx = norm.x;
    let fz = norm.z;
    const fl = Math.hypot(fx, fz);
    if (fl < 0.04) {
      fx = -1;
      fz = 0;
    } else {
      fx /= fl;
      fz /= fl;
    }
    return { fx, fz, yaw: Math.atan2(fx, fz) };
  }

  function addWaterfall(wf, isFallback = false) {
    const id = wf.id || `${wf.name}_${Math.round(wf.x)}_${Math.round(wf.z)}`;
    if (seenWaterfalls.has(id)) return false;

    let inheritedHeight = wf.heightM;
    for (let i = waterfallNodes.length - 1; i >= 0; i--) {
      const existing = waterfallNodes[i];
      if (Math.hypot(existing.x - wf.x, existing.z - wf.z) < 220) {
        if (isFallback) return false;
        if (existing.isFallback) {
          if (!inheritedHeight) inheritedHeight = existing.h;
          root.remove(existing.sheetMesh);
          disposables.delete(existing.sheetMesh.geometry);
          existing.sheetMesh.geometry.dispose();
          for (let m = 0; m < existing.mistCount; m++) {
            mistSeedList[existing.mistOffset + m] = -1;
          }
          waterfallNodes.splice(i, 1);
        } else {
          return false;
        }
      }
    }
    seenWaterfalls.add(id);

    const h = inheritedHeight || 45;
    const width = Math.max(5, Math.min(20, h * 0.16));
    const { fx, fz, yaw } = computeCliffFacing(wf.x, wf.z);

    const sheetGeo = new THREE.PlaneGeometry(width, h, 4, 8);
    const pos = sheetGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const py = pos.getY(i);
      const t = (h * 0.5 - py) / h;
      pos.setZ(i, Math.pow(t, 1.4) * Math.min(10, h * 0.14));
    }
    sheetGeo.computeVertexNormals();
    sheetGeo.computeBoundingSphere();
    disposables.add(sheetGeo);

    const fallbackY = wf.fallbackY ?? wf.y ?? 2800;
    const baseY = sampleElev(terrain, wf.x, wf.z, fallbackY);

    const sheetMesh = new THREE.Mesh(sheetGeo, waterfallMat);
    sheetMesh.position.set(wf.x + fx * 3, baseY, wf.z + fz * 3);
    sheetMesh.rotation.y = yaw;
    sheetMesh.renderOrder = 3;
    root.add(sheetMesh);

    const mistCount = engine.quality.tier === 'low' ? 10 : 26;
    const mistOffset = mistSeedList.length;
    const poolY = baseY - h * 0.45;
    for (let i = 0; i < mistCount; i++) {
      mistPosList.push(
        wf.x + fx * 6 + (Math.random() - 0.5) * width,
        poolY + Math.random() * 6,
        wf.z + fz * 6 + (Math.random() - 0.5) * width
      );
      mistSeedList.push(Math.random());
    }

    waterfallNodes.push({
      x: wf.x,
      z: wf.z,
      h,
      width,
      fallbackY,
      baseY,
      fx,
      fz,
      isFallback,
      mistOffset,
      mistCount,
      sheetMesh,
    });
    return true;
  }

  enqueueWaterBatch(trailData?.lakes, trailData?.waterways);
  let wfAdded = false;
  if (trailData?.waterfalls) {
    for (const wf of trailData.waterfalls) {
      if (addWaterfall(wf, false)) wfAdded = true;
    }
  }
  for (const ic of ICONIC_WATERFALLS) {
    const { x, z } = lonLatToWorld(ic.lon, ic.lat);
    if (addWaterfall({ id: ic.id, name: ic.name, x, y: ic.fallbackY, fallbackY: ic.fallbackY, z, heightM: ic.heightM }, true)) {
      wfAdded = true;
    }
  }
  if (wfAdded) rebuildMistPoints();

  const unsubChunk = events.on('data:chunk', (payload) => {
    if (disposed) return;
    const addedLakes = payload?.added?.lakes ?? trailData?.lakes;
    const addedWw = payload?.added?.waterways ?? trailData?.waterways;
    enqueueWaterBatch(addedLakes, addedWw);

    const addedWf = payload?.added?.waterfalls ?? trailData?.waterfalls;
    if (addedWf?.length) {
      let dirtyMist = false;
      for (const wf of addedWf) {
        if (addWaterfall(wf, false)) dirtyMist = true;
      }
      if (dirtyMist) rebuildMistPoints();
    }
  });

  let lastWaterMode = engine.quality.water;
  let lastTier = engine.quality.tier;
  const unsubQuality = events.on('quality:changed', () => {
    const mode = engine.quality.water;
    if (mode !== lastWaterMode) {
      lastWaterMode = mode;
      waterUniforms.uReflective.value = mode === 'reflective' ? 1.0 : 0.0;
    }
    const tier = engine.quality.tier;
    if (tier !== lastTier) {
      lastTier = tier;
      cobblesDirty = true;
    }
  });

  let refreshTimer = 0;
  let cellCheckCursor = 0;

  function update(dt, playerPos) {
    if (disposed) return;
    const px = playerPos?.x ?? engine.camera.position.x;
    const pz = playerPos?.z ?? engine.camera.position.z;

    if (cobblesDirty || Math.hypot(px - lastCobbleX, pz - lastCobbleZ) > 14) {
      packCobbles(px, pz);
      lastCobbleX = px;
      lastCobbleZ = pz;
      cobblesDirty = false;
    }

    refreshTimer += dt;
    if (refreshTimer > 0.8) {
      refreshTimer = 0;
      let mistDirty = false;
      const mistPosAttr = mistGeo.attributes.position;
      for (const wf of waterfallNodes) {
        const ty = sampleElev(terrain, wf.x, wf.z, wf.fallbackY);
        const dy = ty - wf.baseY;
        if (Math.abs(dy) > 1.5) {
          wf.baseY = ty;
          const { fx, fz, yaw } = computeCliffFacing(wf.x, wf.z);
          wf.fx = fx;
          wf.fz = fz;
          wf.sheetMesh.position.set(wf.x + fx * 3, ty, wf.z + fz * 3);
          wf.sheetMesh.rotation.y = yaw;

          if (mistPosAttr && mistPosAttr.array.length >= (wf.mistOffset + wf.mistCount) * 3) {
            const arr = mistPosAttr.array;
            for (let m = 0; m < wf.mistCount; m++) {
              const pIdx = (wf.mistOffset + m) * 3;
              arr[pIdx + 1] += dy;
              mistPosList[pIdx + 1] = arr[pIdx + 1];
            }
            mistDirty = true;
          }
        }
      }
      if (mistDirty && mistPosAttr) {
        mistPosAttr.needsUpdate = true;
      }

      // Re-snap water cells near the player when higher-zoom DEM tiles refine lake/creek elevations!
      if (waterCells.size > 0 && !taskScheduled) {
        let checked = 0;
        for (const c of waterCells.values()) {
          if (!c.mesh || c.resnapping) continue;
          const nearPlayer = Math.hypot(px - c.cx, pz - c.cz) < 3200;
          if (!nearPlayer && ((checked + cellCheckCursor) % 4 !== 0)) {
            checked++;
            continue;
          }
          checked++;
          let moved = false;
          for (let p = 0; p < c.probes.length; p++) {
            const pr = c.probes[p];
            const curY = sampleElev(terrain, pr.x, pr.z, pr.fb);
            if (Math.abs(curY - pr.y) > 0.25) {
              pr.y = curY;
              moved = true;
            }
          }
          if (moved) {
            c.resnapping = true;
            let idx = 0;
            let handle = null;
            handle = scheduler?.enqueue?.(() => {
              if (disposed) return false;
              const t0 = performance.now();
              while (idx < c.entries.length && performance.now() - t0 < 2.0) {
                const e = c.entries[idx++];
                const nextP = e.type === 'lake' ? buildLakePart(e.item) : buildWaterwayPart(e.item);
                if (nextP) c.parts[e.partIdx] = nextP;
              }
              if (idx < c.entries.length) return true;
              c.resnapping = false;
              c.dirty = true;
              if (handle) resnapCancels.delete(handle);
              flushWaterCells(1);
              return false;
            }, { priority: 15, label: 'world:resnapWater' });
            if (handle) resnapCancels.add(handle);
            break;
          }
        }
        cellCheckCursor = (cellCheckCursor + 1) | 0;
      }
    }
  }

  function dispose() {
    disposed = true;
    unsubChunk();
    unsubQuality();
    if (cancelTask) cancelTask();
    for (const c of resnapCancels) c();
    resnapCancels.clear();
    scene.remove(root);
    cobbleMesh.dispose();
    for (const g of disposables) g.dispose();
    disposables.clear();
    waterMat.dispose();
    waterfallMat.dispose();
    mistMat.dispose();
    cobbleMat.dispose();
    waterCells.clear();
    lakeGrid.clear();
    streamGrid.clear();
    if (engine.worldWaterMask === worldWaterMask) {
      delete engine.worldWaterMask;
    }
  }

  return { update, dispose };
}
