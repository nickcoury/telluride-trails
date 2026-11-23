import * as THREE from 'three';
import { lonLatToWorld } from '../core/geo.js';
import { SAN_JUAN_FOG_GLSL } from './atmosphere.js';

const WATER_CELL_M = 2000;

const WATER_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec2 vFlowUv;
varying float vFoam;
varying float vTurquoise;

attribute float aFoam;
attribute float aTurquoise;

#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  vFlowUv = uv;
  vFoam = aFoam;
  vTurquoise = aTurquoise;
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

#include <common>
#include <logdepthbuf_pars_fragment>
${SAN_JUAN_FOG_GLSL}

void main() {
  #include <logdepthbuf_fragment>

  vec3 viewVec = normalize(cameraPosition - vWorldPos);
  // Wrap world UVs with fract() so 50km+ coordinates (Lake City) retain mobile precision
  vec2 uv1 = fract(vWorldPos.xz * 0.065) + vec2(0.0, -fract(uTime * 0.35));
  vec2 uv2 = fract(vWorldPos.xz * 0.13) + vec2(fract(uTime * 0.08), -fract(uTime * 0.55));
  if (vFoam > 0.005) {
    uv1 = vec2(vFlowUv.x, fract(vFlowUv.y * 0.35 - uTime * 1.05));
    uv2 = vec2(vFlowUv.x * 1.6, fract(vFlowUv.y * 0.55 - uTime * 1.45)) + vec2(0.15, 0.0);
  }

  vec3 n1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
  vec3 N = normalize(vec3((n1.x + n2.x) * 0.36, 1.0, (n1.y + n2.y) * 0.36));

  // Base water tint: Ice Lake / Blue Lakes vivid glacial turquoise vs deep mountain creek slate-blue
  vec3 cobaltDeep = vec3(0.025, 0.105, 0.155);
  vec3 turquoiseDeep = vec3(0.045, 0.38, 0.41);
  vec3 baseCol = mix(cobaltDeep, turquoiseDeep, vTurquoise);

  float ndv = clamp(dot(N, viewVec), 0.02, 1.0);
  float fresnel = 0.03 + 0.97 * pow(1.0 - ndv, 4.2);

  vec3 reflDir = reflect(-viewVec, N);
  vec3 skyRefl = mix(uHorizonColor * 0.85, uSkyAmbientColor * 1.15, clamp(reflDir.y * 1.4, 0.0, 1.0));
  if (uReflective > 0.5) {
    skyRefl *= 0.85 + 0.3 * clamp(reflDir.y * 2.0, 0.0, 1.0);
  }

  vec3 H = normalize(uSunDir + viewVec);
  float spec = pow(max(dot(N, H), 0.0), mix(96.0, 220.0, uReflective));
  vec3 sunSpec = uSunColor * spec * (1.0 + uReflective * 1.3) * (1.0 - uRainAmount * 0.85);

  vec3 waterCol = mix(baseCol, skyRefl, fresnel * (0.58 + uReflective * 0.24)) + sunSpec;

  float alpha = 0.90;
  if (vFoam > 0.005) {
    // Subtle broken riffle foam (never an opaque white stripe on ski hills!)
    float ripple = clamp(n1.x * 0.65 + n2.y * 0.65 + 0.28, 0.0, 1.0);
    float fAmt = clamp(ripple * vFoam * 0.72, 0.0, 0.55);
    vec3 foamCol = (uSkyAmbientColor * 0.48 + uSunColor * 0.42) * 0.82;
    waterCol = mix(waterCol, foamCol, fAmt);
    // Soft feathered creek banks
    float bankMask = sin(clamp(vFlowUv.x, 0.0, 1.0) * 3.14159265);
    alpha = 0.82 * pow(max(bankMask, 0.0), 0.50);
    if (alpha < 0.03) discard;
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
  vec2 uv1 = vec2(vUv.x * 2.4, fract(vUv.y * 3.5 + uTime * 1.45));
  vec2 uv2 = vec2(vUv.x * 4.8 + 0.3, fract(vUv.y * 5.0 + uTime * 2.15));
  float s1 = texture2D(uNormalMap, uv1).r;
  float s2 = texture2D(uNormalMap, uv2).g;
  float streaks = smoothstep(0.26, 0.86, s1 * 0.55 + s2 * 0.45);

  // Soft cliff-lip & plunge-pool feathering so sheet blends organically into rock & mist
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

function mergeWaterParts(parts) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const p of parts) {
    totalVerts += p.pos.length / 3;
    totalIndices += p.idx.length;
  }
  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const foams = new Float32Array(totalVerts);
  const turq = new Float32Array(totalVerts);
  const indices = totalVerts > 65535 ? new Uint32Array(totalIndices) : new Uint16Array(totalIndices);

  let vOff = 0;
  let iOff = 0;
  for (const p of parts) {
    const vCount = p.pos.length / 3;
    positions.set(p.pos, vOff * 3);
    uvs.set(p.uv, vOff * 2);
    foams.set(p.foam, vOff);
    turq.set(p.turq, vOff);
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
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

export function createWater(engine, terrain, trailData, atmosphere) {
  const { scene, events, scheduler } = engine;
  const textures = engine.worldTextures;
  const root = new THREE.Group();
  root.name = 'SanJuanWater';
  scene.add(root);

  let disposed = false;

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

  const seenWaterways = new Set();
  const seenLakes = new Set();
  const seenWaterfalls = new Set();
  const disposables = new Set();

  const waterCells = new Map();
  const pendingQueue = [];
  let taskScheduled = false;
  let cancelTask = null;

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
    if (/ice lake|island lake|blue lake|clear lake|turquoise/.test(n)) return 1.0;
    return y > 3500 ? 0.65 : 0.0;
  }

  function buildLakePart(lake) {
    const coords = lake.coords;
    if (!coords || coords.length < 9) return null;

    const contour = [];
    let sumY = 0;
    const count = Math.floor(coords.length / 3);
    for (let i = 0; i < count; i++) {
      contour.push(new THREE.Vector2(coords[i * 3], coords[i * 3 + 2]));
      sumY += coords[i * 3 + 1];
    }
    const baseY = Number.isFinite(lake.y) ? lake.y : sumY / Math.max(1, count);
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!tris || tris.length === 0) return null;

    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const foam = new Float32Array(count);
    const turq = new Float32Array(count);
    const tVal = isGlacialTurquoise(lake.name, baseY);

    for (let i = 0; i < count; i++) {
      const x = coords[i * 3];
      const z = coords[i * 3 + 2];
      pos[i * 3] = x;
      pos[i * 3 + 1] = baseY + 0.15;
      pos[i * 3 + 2] = z;
      uv[i * 2] = (x % 200) * 0.05;
      uv[i * 2 + 1] = (z % 200) * 0.05;
      foam[i] = 0.0;
      turq[i] = tVal;
    }

    const idx = new Uint32Array(tris.length * 3);
    for (let t = 0; t < tris.length; t++) {
      idx[t * 3] = tris[t][0];
      idx[t * 3 + 1] = tris[t][1];
      idx[t * 3 + 2] = tris[t][2];
    }

    return { x: coords[0], z: coords[2], pos, uv, foam, turq, idx };
  }

  function buildWaterwayPart(w) {
    const raw = w.coords;
    if (!raw || raw.length < 6) return null;

    const pts = [];
    const nPts = Math.floor(raw.length / 3);
    for (let i = 0; i < nPts - 1; i++) {
      const ax = raw[i * 3], ay = raw[i * 3 + 1], az = raw[i * 3 + 2];
      const bx = raw[(i + 1) * 3], by = raw[(i + 1) * 3 + 1], bz = raw[(i + 1) * 3 + 2];
      const dist = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(dist / 9));
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

    // Realistic mountain channel widths: rivers 5-10m, named creeks ~1.8m, minor hillside rills ~0.75m
    const isRiver = w.kind === 'river';
    const hasName = Boolean(w.name && w.name.trim().length > 0);
    let widthM;
    if (isRiver) {
      widthM = Math.max(5.0, Math.min(10.5, w.widthM || 6.8));
    } else if (hasName) {
      widthM = Math.max(1.3, Math.min(2.5, w.widthM ? Math.min(w.widthM, 2.5) : 1.9));
    } else {
      widthM = 0.75;
    }
    const halfW = widthM * 0.5;

    const vertCount = pts.length * 2;
    const pos = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const foam = new Float32Array(vertCount);
    const turq = new Float32Array(vertCount);
    const idx = new Uint32Array((pts.length - 1) * 6);

    const maxFoam = isRiver || hasName ? 0.52 : 0.28;
    let cumDist = 0;
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
      const wy = sampleElev(terrain, p.x, p.z, p.y) + 0.09;

      const segDs = Math.max(1, Math.hypot(next.x - prev.x, next.z - prev.z));
      const slope = Math.abs(next.y - prev.y) / segDs;
      const fVal = Math.min(maxFoam, 0.08 + slope * 1.45);

      pos[i * 6] = p.x - rx * halfW;
      pos[i * 6 + 1] = wy;
      pos[i * 6 + 2] = p.z - rz * halfW;

      pos[i * 6 + 3] = p.x + rx * halfW;
      pos[i * 6 + 4] = wy;
      pos[i * 6 + 5] = p.z + rz * halfW;

      uv[i * 4] = 0;
      uv[i * 4 + 1] = cumDist * 0.15;
      uv[i * 4 + 2] = 1;
      uv[i * 4 + 3] = cumDist * 0.15;

      foam[i * 2] = fVal;
      foam[i * 2 + 1] = fVal;
      turq[i * 2] = 0.16;
      turq[i * 2 + 1] = 0.16;

      if (i < pts.length - 1) {
        const b = i * 2;
        const o = i * 6;
        idx[o] = b; idx[o + 1] = b + 1; idx[o + 2] = b + 2;
        idx[o + 3] = b + 1; idx[o + 4] = b + 3; idx[o + 5] = b + 2;
      }
    }

    return { x: pts[0].x, z: pts[0].z, pos, uv, foam, turq, idx };
  }

  function flushWaterCells() {
    if (disposed) return;
    for (const cell of waterCells.values()) {
      if (!cell.dirty || cell.parts.length === 0) continue;
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
    }
  }

  function processWaterSlice() {
    if (disposed) return false;
    const start = performance.now();
    let count = 0;
    while (pendingQueue.length > 0 && count < 22 && performance.now() - start < 2.0) {
      const entry = pendingQueue.shift();
      const part = entry.type === 'lake' ? buildLakePart(entry.item) : buildWaterwayPart(entry.item);
      count++;
      if (!part) continue;

      const key = `${Math.floor(part.x / WATER_CELL_M)}_${Math.floor(part.z / WATER_CELL_M)}`;
      let cell = waterCells.get(key);
      if (!cell) {
        cell = { parts: [], mesh: null, dirty: false };
        waterCells.set(key, cell);
      }
      cell.parts.push(part);
      cell.dirty = true;
    }

    if (pendingQueue.length === 0) {
      flushWaterCells();
      taskScheduled = false;
      return false;
    }
    if (count > 0 && pendingQueue.length % 66 < 22) {
      flushWaterCells();
    }
    return true;
  }

  function enqueueWaterBatch(lakes, waterways) {
    let added = 0;
    if (lakes) {
      for (let i = 0; i < lakes.length; i++) {
        const l = lakes[i];
        const id = l.id || l.name || JSON.stringify(l.bbox);
        if (seenLakes.has(id)) continue;
        seenLakes.add(id);
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
        pendingQueue.push({ type: 'waterway', item: w });
        added++;
      }
    }
    if (added > 0 && !taskScheduled) {
      taskScheduled = true;
      if (scheduler?.enqueue) {
        cancelTask = scheduler.enqueue(processWaterSlice, { priority: 14, label: 'world:water' });
      } else {
        while (processWaterSlice()) { /* sync fallback */ }
      }
    }
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
        if (isFallback) {
          return false; // Real OSM waterfall already present
        }
        if (existing.isFallback) {
          // Real OSM waterfall arrived: retire iconic fallback & inherit curated height if OSM lacks it
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
  const unsubQuality = events.on('quality:changed', () => {
    const mode = engine.quality.water;
    if (mode === lastWaterMode) return;
    lastWaterMode = mode;
    waterUniforms.uReflective.value = mode === 'reflective' ? 1.0 : 0.0;
  });

  let refreshTimer = 0;
  function update(dt) {
    if (disposed) return;
    refreshTimer += dt;
    if (refreshTimer > 1.5) {
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

          // Shift plunge-pool mist vertices to stay synced with refined waterfall base
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
    }
  }

  function dispose() {
    disposed = true;
    unsubChunk();
    unsubQuality();
    if (cancelTask) cancelTask();
    scene.remove(root);
    for (const g of disposables) g.dispose();
    disposables.clear();
    waterMat.dispose();
    waterfallMat.dispose();
    mistMat.dispose();
    waterCells.clear();
  }

  return { update, dispose };
}
