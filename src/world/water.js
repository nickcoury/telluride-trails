import * as THREE from 'three';
import { lonLatToWorld } from '../core/geo.js';
import { SAN_JUAN_FOG_GLSL } from './atmosphere.js';

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
uniform float uTime;
uniform float uReflective;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbientColor;
uniform vec3 uHorizonColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogBaseHeight;
uniform float uFogHeightFalloff;
uniform float uAerialScatter;
uniform float uRainAmount;

varying vec3 vWorldPos;
varying vec2 vFlowUv;
varying float vFoam;
varying float vTurquoise;

#include <common>
#include <logdepthbuf_pars_fragment>

vec3 applySanJuanAtmosphere(vec3 color, vec3 worldPos, vec3 camPos) {
  vec3 toFrag = worldPos - camPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 0.0001);
  float h0 = camPos.y - uFogBaseHeight;
  float h1 = worldPos.y - uFogBaseHeight;
  float falloff = max(uFogHeightFalloff, 0.00001);
  float dH = (h1 - h0) * falloff;
  float avgExp = abs(dH) > 0.001
    ? (exp(-clamp(h0 * falloff, -10.0, 10.0)) - exp(-clamp(h1 * falloff, -10.0, 10.0))) / dH
    : exp(-clamp(h0 * falloff, -10.0, 10.0));
  float opticalDepth = uFogDensity * dist * avgExp;
  float fogAmt = clamp(1.0 - exp(-opticalDepth - dist * (0.000016 + uRainAmount * 0.00016) * uAerialScatter), 0.0, 1.0);
  float sunCos = max(dot(viewDir, uSunDir), 0.0);
  float mieGlow = pow(sunCos, 6.0) * 0.42 + pow(sunCos, 32.0) * 0.35;
  vec3 scatterColor = mix(uFogColor, uHorizonColor + uSunColor * 0.32, mieGlow * (1.0 - uRainAmount * 0.85));
  return mix(color, scatterColor, fogAmt);
}

void main() {
  #include <logdepthbuf_fragment>

  vec3 viewVec = normalize(cameraPosition - vWorldPos);
  // Dual scrolling normal maps along flow direction (vFlowUv.y is downstream)
  vec2 uv1 = vWorldPos.xz * 0.065 + vec2(0.0, -uTime * 0.35);
  vec2 uv2 = vWorldPos.xz * 0.13 + vec2(uTime * 0.08, -uTime * 0.55);
  if (vFoam > 0.01) {
    uv1 = vFlowUv * vec2(1.0, 0.35) + vec2(0.0, -uTime * 1.15);
    uv2 = vFlowUv * vec2(1.6, 0.55) + vec2(0.15, -uTime * 1.65);
  }

  vec3 n1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
  vec3 N = normalize(vec3((n1.x + n2.x) * 0.38, 1.0, (n1.y + n2.y) * 0.38));

  // Base water tint: Ice Lake / Blue Lakes vivid glacial turquoise vs deep alpine cobalt
  vec3 cobaltDeep = vec3(0.03, 0.13, 0.19);
  vec3 turquoiseDeep = vec3(0.05, 0.38, 0.41);
  vec3 baseCol = mix(cobaltDeep, turquoiseDeep, vTurquoise);

  // Fresnel sky reflection
  float ndv = clamp(dot(N, viewVec), 0.02, 1.0);
  float fresnel = 0.03 + 0.97 * pow(1.0 - ndv, 4.2);

  vec3 reflDir = reflect(-viewVec, N);
  vec3 skyRefl = mix(uHorizonColor, uSkyAmbientColor * 1.25, clamp(reflDir.y * 1.4, 0.0, 1.0));
  if (uReflective > 0.5) {
    // Richer mountain/sky contrast on reflective tier
    skyRefl *= 0.85 + 0.3 * clamp(reflDir.y * 2.0, 0.0, 1.0);
  }

  // Sun specular sparkle
  vec3 H = normalize(uSunDir + viewVec);
  float spec = pow(max(dot(N, H), 0.0), mix(96.0, 220.0, uReflective));
  vec3 sunSpec = uSunColor * spec * (1.2 + uReflective * 1.4) * (1.0 - uRainAmount * 0.85);

  vec3 waterCol = mix(baseCol, skyRefl, fresnel * (0.65 + uReflective * 0.25)) + sunSpec;

  // Rapids / whitewater foam on steep streams
  if (vFoam > 0.01) {
    float foamPattern = clamp((n1.x * 0.5 + n2.y * 0.5 + 0.55) * vFoam, 0.0, 1.0);
    float edgeFoam = smoothstep(0.32, 0.49, abs(vFlowUv.x - 0.5));
    float fAmt = clamp(foamPattern * 0.85 + edgeFoam * vFoam * 0.45, 0.0, 0.92);
    vec3 foamCol = (uSkyAmbientColor * 0.45 + uSunColor * 0.55) * 0.95;
    waterCol = mix(waterCol, foamCol, fAmt);
  }

  waterCol = applySanJuanAtmosphere(waterCol, vWorldPos, cameraPosition);
  gl_FragColor = vec4(waterCol, 0.90);
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
  vec2 uv1 = vec2(vUv.x * 2.2, vUv.y * 3.5 + uTime * 1.45);
  vec2 uv2 = vec2(vUv.x * 4.5 + 0.3, vUv.y * 5.0 + uTime * 2.15);
  float s1 = texture2D(uNormalMap, uv1).r;
  float s2 = texture2D(uNormalMap, uv2).g;
  float streaks = smoothstep(0.28, 0.86, s1 * 0.55 + s2 * 0.45);

  float edgeMask = sin(vUv.x * 3.14159265);
  float bottomSplash = smoothstep(0.0, 0.25, vUv.y);
  float alpha = clamp((0.35 + streaks * 0.65) * pow(edgeMask, 0.65) * (0.45 + 0.55 * bottomSplash), 0.0, 0.92);
  if (alpha < 0.04) discard;

  vec3 lightCol = uSkyAmbientColor * 0.52 + uSunColor * 0.68;
  vec3 waterCol = mix(vec3(0.42, 0.56, 0.64) * lightCol, vec3(0.95, 0.98, 1.0) * lightCol, streaks);
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
  float life = fract(aSeed + uTime * 0.22);
  vec3 pos = position;
  pos.y += life * 16.0;
  pos.x += sin(aSeed * 31.4 + uTime * 0.8) * (2.0 + life * 7.0);
  pos.z += cos(aSeed * 21.7 + uTime * 0.7) * (2.0 + life * 7.0);
  vAlpha = sin(life * 3.14159265) * 0.38;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_PointSize = clamp((240.0 + life * 320.0) / max(-mvPosition.z, 1.0), 3.0, 64.0);
  gl_Position = projectionMatrix * mvPosition;
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

// Curated iconic San Juan waterfalls (merged with OSM data if present, fallback if missing)
const ICONIC_WATERFALLS = [
  { id: 'iconic_bridal_veil', name: 'Bridal Veil Falls', lon: -107.7689, lat: 37.9211, heightM: 111 },
  { id: 'iconic_ingram', name: 'Ingram Falls', lon: -107.7753, lat: 37.9286, heightM: 65 },
  { id: 'iconic_cornet', name: 'Cornet Creek Falls', lon: -107.8075, lat: 37.9438, heightM: 24 },
  { id: 'iconic_bear_creek_ouray', name: 'Bear Creek Falls', lon: -107.6634, lat: 37.9912, heightM: 69 },
];

export function createWater(engine, terrain, trailData, atmosphere) {
  const { scene, events } = engine;
  const textures = engine.worldTextures;
  const root = new THREE.Group();
  root.name = 'SanJuanWater';
  scene.add(root);

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
  const meshes = [];
  const waterfallNodes = []; // track for height refinement if terrain streams in later

  function isGlacialTurquoise(name, y) {
    const n = (name || '').toLowerCase();
    if (/ice lake|island lake|blue lake|clear lake|turquoise/.test(n)) return 1.0;
    return y > 3500 ? 0.65 : 0.0;
  }

  function addLake(lake) {
    const id = lake.id || lake.name || JSON.stringify(lake.bbox);
    if (seenLakes.has(id)) return;
    seenLakes.add(id);

    const coords = lake.coords;
    if (!coords || coords.length < 9) return;

    const contour = [];
    let sumY = 0;
    const count = Math.floor(coords.length / 3);
    for (let i = 0; i < count; i++) {
      contour.push(new THREE.Vector2(coords[i * 3], coords[i * 3 + 2]));
      sumY += coords[i * 3 + 1];
    }
    const baseY = Number.isFinite(lake.y) ? lake.y : sumY / Math.max(1, count);
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!tris || tris.length === 0) return;

    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const foams = new Float32Array(count);
    const turq = new Float32Array(count);
    const tVal = isGlacialTurquoise(lake.name, baseY);

    for (let i = 0; i < count; i++) {
      const x = coords[i * 3];
      const z = coords[i * 3 + 2];
      positions[i * 3] = x;
      positions[i * 3 + 1] = baseY + 0.15;
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x * 0.05;
      uvs[i * 2 + 1] = z * 0.05;
      foams[i] = 0.0;
      turq[i] = tVal;
    }

    const indices = [];
    for (const [a, b, c] of tris) indices.push(a, b, c);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aFoam', new THREE.BufferAttribute(foams, 1));
    geo.setAttribute('aTurquoise', new THREE.BufferAttribute(turq, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, waterMat);
    mesh.renderOrder = 2;
    root.add(mesh);
    meshes.push(mesh);
  }

  function addWaterway(w) {
    const id = w.id || `${w.name || 'stream'}_${seenWaterways.size}`;
    if (seenWaterways.has(id)) return;
    seenWaterways.add(id);

    const raw = w.coords;
    if (!raw || raw.length < 6) return;

    // Resample polyline to <= 12m segments so ribbons follow terrain smoothly
    const pts = [];
    const nPts = Math.floor(raw.length / 3);
    for (let i = 0; i < nPts - 1; i++) {
      const ax = raw[i * 3], ay = raw[i * 3 + 1], az = raw[i * 3 + 2];
      const bx = raw[(i + 1) * 3], by = raw[(i + 1) * 3 + 1], bz = raw[(i + 1) * 3 + 2];
      const dist = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.ceil(dist / 12));
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
    if (pts.length < 2) return;

    const halfW = (w.widthM || (w.kind === 'river' ? 7.5 : 2.8)) * 0.5;
    const vertCount = pts.length * 2;
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const foams = new Float32Array(vertCount);
    const turq = new Float32Array(vertCount);
    const indices = [];

    let cumDist = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      if (i > 0) cumDist += Math.hypot(p.x - prev.x, p.z - prev.z);

      // Right normal in XZ
      const rx = -dz / len;
      const rz = dx / len;
      const h = terrain.getHeight(p.x, p.z);
      const wy = (Number.isFinite(h) && h > 100 ? h : p.y) + 0.16;

      // Grade -> whitewater foam
      const segDs = Math.max(1, Math.hypot(next.x - prev.x, next.z - prev.z));
      const slope = Math.abs(next.y - prev.y) / segDs;
      const foam = Math.min(1.0, 0.22 + slope * 5.2);

      positions[i * 6] = p.x - rx * halfW;
      positions[i * 6 + 1] = wy;
      positions[i * 6 + 2] = p.z - rz * halfW;

      positions[i * 6 + 3] = p.x + rx * halfW;
      positions[i * 6 + 4] = wy;
      positions[i * 6 + 5] = p.z + rz * halfW;

      uvs[i * 4] = 0;
      uvs[i * 4 + 1] = cumDist * 0.15;
      uvs[i * 4 + 2] = 1;
      uvs[i * 4 + 3] = cumDist * 0.15;

      foams[i * 2] = foam;
      foams[i * 2 + 1] = foam;
      turq[i * 2] = 0.18;
      turq[i * 2 + 1] = 0.18;

      if (i < pts.length - 1) {
        const b = i * 2;
        indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aFoam', new THREE.BufferAttribute(foams, 1));
    geo.setAttribute('aTurquoise', new THREE.BufferAttribute(turq, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, waterMat);
    mesh.renderOrder = 2;
    root.add(mesh);
    meshes.push(mesh);
  }

  function addWaterfall(wf) {
    const id = wf.id || `${wf.name}_${Math.round(wf.x)}_${Math.round(wf.z)}`;
    if (seenWaterfalls.has(id)) return;
    // Skip iconic fallback if an OSM waterfall is already within 200m
    for (const existing of waterfallNodes) {
      if (Math.hypot(existing.x - wf.x, existing.z - wf.z) < 200) return;
    }
    seenWaterfalls.add(id);

    const h = wf.heightM || 45;
    const width = Math.max(5, Math.min(22, h * 0.18));
    const norm = terrain.getNormal(wf.x, wf.z);
    // Outward cliff horizontal facing direction
    let fx = norm.x;
    let fz = norm.z;
    const fl = Math.hypot(fx, fz);
    if (fl < 0.05) {
      fx = -1;
      fz = 0;
    } else {
      fx /= fl;
      fz /= fl;
    }
    const yaw = Math.atan2(fx, fz);

    // Slightly sloped vertical ribbon facing outward from cliff
    const sheetGeo = new THREE.PlaneGeometry(width, h, 4, 8);
    const pos = sheetGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const py = pos.getY(i);
      const t = (h * 0.5 - py) / h; // 0 top -> 1 bottom
      pos.setZ(i, Math.pow(t, 1.4) * Math.min(10, h * 0.14));
    }
    sheetGeo.computeVertexNormals();

    const terrainY = terrain.getHeight(wf.x, wf.z);
    const baseY = Number.isFinite(terrainY) && terrainY > 100 ? terrainY : (wf.y || 2800);

    const sheetMesh = new THREE.Mesh(sheetGeo, waterfallMat);
    sheetMesh.position.set(wf.x + fx * 3, baseY, wf.z + fz * 3);
    sheetMesh.rotation.y = yaw;
    sheetMesh.renderOrder = 3;
    root.add(sheetMesh);
    meshes.push(sheetMesh);

    // Rising plunge-pool mist particles
    const mistCount = engine.quality.tier === 'low' ? 12 : 34;
    const mistGeo = new THREE.BufferGeometry();
    const mistPos = new Float32Array(mistCount * 3);
    const mistSeed = new Float32Array(mistCount);
    const poolY = baseY - h * 0.45;
    for (let i = 0; i < mistCount; i++) {
      mistPos[i * 3] = wf.x + fx * 6 + (Math.random() - 0.5) * width;
      mistPos[i * 3 + 1] = poolY + Math.random() * 6;
      mistPos[i * 3 + 2] = wf.z + fz * 6 + (Math.random() - 0.5) * width;
      mistSeed[i] = Math.random();
    }
    mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPos, 3));
    mistGeo.setAttribute('aSeed', new THREE.BufferAttribute(mistSeed, 1));
    const mistPoints = new THREE.Points(mistGeo, mistMat);
    mistPoints.renderOrder = 4;
    root.add(mistPoints);
    meshes.push(mistPoints);

    waterfallNodes.push({ x: wf.x, z: wf.z, h, fx, fz, sheetMesh, mistPoints });
  }

  function syncFromTrailData() {
    if (trailData?.lakes) {
      for (const l of trailData.lakes) addLake(l);
    }
    if (trailData?.waterways) {
      for (const w of trailData.waterways) addWaterway(w);
    }
    if (trailData?.waterfalls) {
      for (const wf of trailData.waterfalls) addWaterfall(wf);
    }
    // Always ensure iconic San Juan waterfalls are represented
    for (const ic of ICONIC_WATERFALLS) {
      const { x, z } = lonLatToWorld(ic.lon, ic.lat);
      addWaterfall({ id: ic.id, name: ic.name, x, y: terrain.getHeight(x, z), z, heightM: ic.heightM });
    }
  }
  syncFromTrailData();

  const unsubChunk = events.on('data:chunk', syncFromTrailData);
  const unsubQuality = events.on('quality:changed', () => {
    waterUniforms.uReflective.value = engine.quality.water === 'reflective' ? 1.0 : 0.0;
  });

  let refreshTimer = 0;
  function update(dt) {
    refreshTimer += dt;
    // Gently re-snap iconic waterfalls if higher-detail terrain streams in under them
    if (refreshTimer > 1.5) {
      refreshTimer = 0;
      for (const wf of waterfallNodes) {
        const ty = terrain.getHeight(wf.x, wf.z);
        if (Number.isFinite(ty) && ty > 100 && Math.abs(wf.sheetMesh.position.y - ty) > 2.0) {
          wf.sheetMesh.position.y = ty;
        }
      }
    }
  }

  function dispose() {
    unsubChunk();
    unsubQuality();
    scene.remove(root);
    for (const m of meshes) {
      m.geometry.dispose();
    }
    waterMat.dispose();
    waterfallMat.dispose();
    mistMat.dispose();
  }

  return { update, dispose };
}
