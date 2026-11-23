import * as THREE from 'three';
import { getCelestialPositions } from './astro.js';

/**
 * Shared GLSL height-fog + aerial-perspective snippet.
 * Shared with @terrain2 so terrain, vegetation, water, and structures blend seamlessly into the sky.
 */
export const SAN_JUAN_FOG_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbientColor;
uniform vec3 uGroundAmbientColor;
uniform vec3 uHorizonColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogBaseHeight;
uniform float uFogHeightFalloff;
uniform float uAerialScatter;
uniform float uRainAmount;
uniform float uTime;

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
  float fogAmt = 1.0 - exp(-opticalDepth - dist * (0.000016 + uRainAmount * 0.00018) * uAerialScatter);
  fogAmt = clamp(fogAmt, 0.0, 1.0);

  float sunCos = max(dot(viewDir, uSunDir), 0.0);
  float mieGlow = pow(sunCos, 6.0) * 0.42 + pow(sunCos, 32.0) * 0.35;
  vec3 scatterColor = mix(uFogColor, uHorizonColor + uSunColor * 0.32, mieGlow * (1.0 - uRainAmount * 0.88));

  return mix(color, scatterColor, fogAmt);
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldDir;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vWorldDir = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uMoonPhase;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbientColor;
uniform vec3 uHorizonColor;
uniform vec3 uFogColor;
uniform float uRainAmount;
uniform float uCloudCover;
uniform float uLightningFlash;
uniform float uTime;

varying vec3 vWorldDir;

#include <common>
#include <logdepthbuf_pars_fragment>

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbmClouds(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p = rot * p * 2.07 + vec2(13.1, 7.7);
    a *= 0.5;
  }
  return v;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vWorldDir);
  float y = dir.y;
  float horizonMask = pow(1.0 - clamp(abs(y), 0.0, 1.0), 4.5);

  float sunElev = uSunDir.y;
  float dayFactor = smoothstep(-0.08, 0.25, sunElev);
  float goldenBand = smoothstep(-0.20, 0.04, sunElev) * (1.0 - smoothstep(0.08, 0.44, sunElev));

  // Rayleigh gradient: deep San Juan high-altitude cobalt zenith -> storm charcoal in monsoon
  vec3 zenithDay = mix(vec3(0.07, 0.22, 0.52), vec3(0.045, 0.058, 0.085), uRainAmount * 0.92);
  vec3 zenithNight = vec3(0.008, 0.014, 0.032);
  vec3 zenith = mix(zenithNight, zenithDay, dayFactor);

  float skyPow = pow(max(y, 0.0), 0.55);
  vec3 skyCol = mix(uHorizonColor, zenith, skyPow);

  // Golden hour & twilight warm alpenglow near horizon
  float sunCos = max(dot(dir, uSunDir), 0.0);
  vec3 twilightTint = vec3(0.96, 0.38, 0.14) * goldenBand * pow(1.0 - max(y, 0.0), 2.8) * (0.35 + 0.65 * pow(sunCos, 1.8));
  skyCol += twilightTint * (1.0 - uRainAmount * 0.85);

  // Solar corona & crisp solar disc (suppressed by heavy storm clouds)
  float sunVisibility = dayFactor * (1.0 - uRainAmount * 0.94);
  float corona = pow(sunCos, 10.0) * 0.30 + pow(sunCos, 96.0) * 0.78;
  float sunDisc = smoothstep(0.99935, 0.99975, dot(dir, uSunDir));
  skyCol += uSunColor * (corona + sunDisc * 4.5) * sunVisibility;

  // Stars & Moon at night
  float nightFactor = 1.0 - smoothstep(-0.14, 0.04, sunElev);
  if (nightFactor > 0.01 && y > 0.0) {
    vec2 starUv = dir.xz / (y + 0.35) * 95.0;
    vec2 starCell = floor(starUv);
    float starRnd = hash21(starCell);
    if (starRnd > 0.975) {
      vec2 delta = fract(starUv) - 0.5;
      float starBright = smoothstep(0.28, 0.0, length(delta)) * (starRnd - 0.975) * 40.0;
      float twinkle = 0.75 + 0.25 * sin(uTime * 2.5 + starRnd * 120.0);
      skyCol += vec3(0.85, 0.90, 1.0) * starBright * twinkle * nightFactor * (1.0 - uRainAmount);
    }

    float moonCos = dot(dir, uMoonDir);
    if (moonCos > 0.9994) {
      float moonEdge = smoothstep(0.9994, 0.99965, moonCos);
      skyCol += vec3(0.82, 0.88, 0.98) * moonEdge * (0.35 + 0.65 * uMoonPhase) * nightFactor * (1.0 - uRainAmount * 0.85);
    }
    skyCol += vec3(0.35, 0.45, 0.65) * pow(max(moonCos, 0.0), 48.0) * 0.12 * nightFactor * (1.0 - uRainAmount);
  }

  // Procedural volumetric-looking cumulus / monsoon thunderhead clouds
  if (y > 0.01) {
    vec2 cloudUv = dir.xz / (y + 0.14) * 1.35 + vec2(uTime * 0.008, uTime * 0.004);
    float c1 = fbmClouds(cloudUv);
    float c2 = fbmClouds(cloudUv * 2.2 - vec2(uTime * 0.012, 0.0));
    float density = c1 * 0.68 + c2 * 0.32;

    float coverage = mix(0.56, 0.14, clamp(uCloudCover + uRainAmount * 0.75, 0.0, 1.0));
    float cloudAlpha = smoothstep(coverage, coverage + 0.20, density);
    cloudAlpha *= smoothstep(0.01, 0.16, y);

    float lit = clamp((density - coverage) * 2.2, 0.0, 1.0);
    float forwardLit = pow(sunCos, 4.0) * 0.55 * (1.0 - uRainAmount * 0.85);
    vec3 clearCloudTop = mix(uSkyAmbientColor * 1.15, vec3(1.0, 0.97, 0.92) * max(dayFactor, 0.06), 0.7) + uSunColor * forwardLit;
    vec3 stormCloudTop = vec3(0.09, 0.11, 0.15) * max(dayFactor, 0.12);
    vec3 cloudLight = mix(clearCloudTop, stormCloudTop, uRainAmount * 0.88);
    vec3 cloudDark = mix(vec3(0.18, 0.22, 0.29), vec3(0.032, 0.042, 0.062), uRainAmount) * max(dayFactor, 0.08);
    vec3 cloudCol = mix(cloudDark, cloudLight, mix(0.68, 0.28, uRainAmount) * (1.0 - lit * 0.42));

    cloudCol += vec3(0.78, 0.88, 1.0) * uLightningFlash * (0.6 + 0.9 * density);

    skyCol = mix(skyCol, cloudCol, cloudAlpha * mix(0.82, 0.98, uRainAmount));
  }

  skyCol += vec3(0.68, 0.80, 1.0) * uLightningFlash * 0.48;

  vec3 horizonBlend = mix(uFogColor, uHorizonColor + uSunColor * 0.25, pow(sunCos, 6.0) * 0.35 * (1.0 - uRainAmount * 0.88));
  skyCol = mix(skyCol, horizonBlend, horizonMask * (y < 0.0 ? 1.0 : 0.72));

  gl_FragColor = vec4(skyCol, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const RAIN_VERT = /* glsl */ `
attribute vec3 aOffset;
attribute float aSpeed;
uniform vec3 uCamPos;
uniform float uTime;
varying float vAlpha;

#include <common>
#include <logdepthbuf_pars_vertex>

void main() {
  vec3 boxSize = vec3(38.0, 24.0, 38.0);
  vec3 p = aOffset;
  p.y -= uTime * aSpeed;
  p.x -= uTime * 3.2; // monsoon gust slant

  vec3 rel = mod(p - uCamPos + boxSize * 0.5, boxSize) - boxSize * 0.5;
  vec3 worldCenter = uCamPos + rel;

  // Crisp wind-slanted rain streak with near-camera fade so drops never block the lens
  vec3 vertexPos = worldCenter + vec3(position.x * 0.015 + position.y * 0.11, position.y * 0.85, position.z * 0.015);
  float nearFade = smoothstep(1.2, 3.6, length(rel));
  float farFade = 1.0 - smoothstep(9.0, 19.0, length(rel.xz));
  float tipFade = 1.0 - abs(position.y) * 1.45;
  vAlpha = nearFade * farFade * max(tipFade, 0.25) * 0.52;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(vertexPos, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const RAIN_FRAG = /* glsl */ `
uniform float uRainAmount;
varying float vAlpha;

#include <common>
#include <logdepthbuf_pars_fragment>

void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(0.76, 0.84, 0.95, vAlpha * smoothstep(0.04, 0.42, uRainAmount));
}
`;

/**
 * Create the complete atmosphere, lighting, sky dome, clouds, shadow rig, headlamp, and monsoon system.
 */
export function createAtmosphere(engine, terrain) {
  const { scene, renderer, events } = engine;

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.5, 0.6, 0.4).normalize() },
    uMoonDir: { value: new THREE.Vector3(-0.4, 0.4, -0.5).normalize() },
    uMoonPhase: { value: 0.75 },
    uSunColor: { value: new THREE.Color(0xfff1d6) },
    uSkyAmbientColor: { value: new THREE.Color(0x7ca6d8) },
    uGroundAmbientColor: { value: new THREE.Color(0x3a4033) },
    uHorizonColor: { value: new THREE.Color(0xaec8e4) },
    uFogColor: { value: new THREE.Color(0x9cb9d8) },
    uFogDensity: { value: 0.000024 },
    uFogBaseHeight: { value: 2667.0 },
    uFogHeightFalloff: { value: 0.00085 },
    uAerialScatter: { value: 0.85 },
    uRainAmount: { value: 0.0 },
    uCloudCover: { value: 0.25 },
    uLightningFlash: { value: 0.0 },
    uTime: { value: 0.0 },
  };
  scene.userData.atmosphereUniforms = uniforms;
  engine.atmosphereUniforms = uniforms;

  const sceneFog = new THREE.FogExp2(0x9cb9d8, 0.000018);
  scene.fog = sceneFog;

  // Sky dome: radius 8000 + depthTest:false + renderOrder:-1000 so it NEVER clips on low tier's camera.far
  const skyGeo = new THREE.SphereGeometry(8000, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  scene.add(skyMesh);

  // Lights
  const hemiLight = new THREE.HemisphereLight(0x8db4e0, 0x3b4232, 0.75);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xfff4df, 2.4);
  sunLight.castShadow = Boolean(engine.quality.shadows);
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 450;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.035;
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Runner headlamp (SpotLight on medium+, cheap PointLight on low + terrain-draped light pool)
  const headlampSpot = new THREE.SpotLight(0xfff4df, 0, 75, Math.PI * 0.28, 0.58, 1.15);
  headlampSpot.castShadow = false;
  headlampSpot.visible = false;
  scene.add(headlampSpot);
  scene.add(headlampSpot.target);

  const headlampCheap = new THREE.PointLight(0xfff4df, 0, 38, 1.2);
  headlampCheap.castShadow = false;
  headlampCheap.visible = false;
  scene.add(headlampCheap);

  const poolSegX = 6;
  const poolSegZ = 8;
  const headlampPoolGeo = new THREE.PlaneGeometry(14, 24, poolSegX, poolSegZ);
  headlampPoolGeo.rotateX(-Math.PI * 0.5);
  const poolCount = headlampPoolGeo.attributes.position.count;
  const poolColors = new Float32Array(poolCount * 3);
  for (let i = 0; i < poolCount; i++) {
    const lx = headlampPoolGeo.attributes.position.getX(i) / 7.0;
    const lz = (headlampPoolGeo.attributes.position.getZ(i) + 12.0) / 24.0;
    const coneWidth = 0.22 + (1.0 - lz) * 0.78;
    const radial = Math.max(0, 1.0 - Math.pow(lx / coneWidth, 2.0));
    const longi = Math.sin(Math.min(1, Math.max(0, lz)) * Math.PI);
    const w = Math.pow(radial, 1.4) * Math.pow(longi, 0.85) * 0.34;
    poolColors[i * 3] = w * 1.05;
    poolColors[i * 3 + 1] = w * 0.96;
    poolColors[i * 3 + 2] = w * 0.80;
  }
  headlampPoolGeo.setAttribute('color', new THREE.BufferAttribute(poolColors, 3));
  const poolLocalXZ = new Float32Array(poolCount * 2);
  for (let i = 0; i < poolCount; i++) {
    poolLocalXZ[i * 2] = headlampPoolGeo.attributes.position.getX(i);
    poolLocalXZ[i * 2 + 1] = 13.5 - headlampPoolGeo.attributes.position.getZ(i);
  }
  const headlampPoolMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const headlampPoolMesh = new THREE.Mesh(headlampPoolGeo, headlampPoolMat);
  headlampPoolMesh.frustumCulled = false;
  headlampPoolMesh.visible = false;
  headlampPoolMesh.renderOrder = 5;
  scene.add(headlampPoolMesh);

  // Rain streaks (GPU instanced, 1 draw call)
  const rainCount = 1500;
  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.index = quadGeo.index;
  rainGeo.attributes.position = quadGeo.attributes.position;
  const offsets = new Float32Array(rainCount * 3);
  const speeds = new Float32Array(rainCount);
  for (let i = 0; i < rainCount; i++) {
    offsets[i * 3] = (Math.random() - 0.5) * 38;
    offsets[i * 3 + 1] = Math.random() * 24;
    offsets[i * 3 + 2] = (Math.random() - 0.5) * 38;
    speeds[i] = 18 + Math.random() * 9;
  }
  rainGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  rainGeo.setAttribute('aSpeed', new THREE.InstancedBufferAttribute(speeds, 1));
  quadGeo.dispose();

  const rainUniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uTime: uniforms.uTime,
    uRainAmount: uniforms.uRainAmount,
  };
  const rainMat = new THREE.ShaderMaterial({
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    uniforms: rainUniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const rainMesh = new THREE.Mesh(rainGeo, rainMat);
  rainMesh.frustumCulled = false;
  rainMesh.visible = false;
  rainMesh.renderOrder = 20;
  scene.add(rainMesh);

  // Distant lightning bolt mesh
  const boltGeo = new THREE.BufferGeometry();
  const boltPositions = new Float32Array(12 * 3);
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPositions, 3));
  const boltMat = new THREE.LineBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0.95 });
  const boltLine = new THREE.Line(boltGeo, boltMat);
  boltLine.frustumCulled = false;
  boltLine.visible = false;
  scene.add(boltLine);

  // Environment PMREM reflection for high/ultra reflective water (radius 45 < PMREM far 100)
  let pmremGen = null;
  let envRT = null;
  let envScene = null;
  let envSkyMesh = null;
  let lastEnvSunY = -99;
  let lastEnvRain = -1;

  function updateEnvMapIfNeeded(force = false) {
    const reflective = engine.quality.water === 'reflective';
    if (!reflective) {
      if (scene.environment) scene.environment = null;
      return;
    }
    const sunDelta = Math.abs(uniforms.uSunDir.value.y - lastEnvSunY);
    const rainDelta = Math.abs(uniforms.uRainAmount.value - lastEnvRain);
    if (!force && sunDelta < 0.06 && rainDelta < 0.18 && scene.environment) return;

    if (!pmremGen) {
      pmremGen = new THREE.PMREMGenerator(renderer);
      pmremGen.compileEquirectangularShader();
      envScene = new THREE.Scene();
      envSkyMesh = new THREE.Mesh(new THREE.SphereGeometry(45, 16, 10), skyMat);
      envScene.add(envSkyMesh);
    }
    const nextRT = pmremGen.fromScene(envScene, 0.02);
    if (envRT) envRT.dispose();
    envRT = nextRT;
    scene.environment = envRT.texture;
    lastEnvSunY = uniforms.uSunDir.value.y;
    lastEnvRain = uniforms.uRainAmount.value;
  }

  let lastTier = engine.quality.tier;
  let lastShadows = Boolean(engine.quality.shadows);
  let lastShadowMapSize = engine.quality.shadowMapSize || 0;
  let lastWaterMode = engine.quality.water;

  function configureShadows() {
    const tier = engine.quality.tier;
    const enabled = Boolean(engine.quality.shadows) && engine.quality.shadowMapSize > 0;
    sunLight.castShadow = enabled;
    if (!enabled) return;

    const size = engine.quality.shadowMapSize;
    if (sunLight.shadow.mapSize.width !== size) {
      sunLight.shadow.mapSize.set(size, size);
      if (sunLight.shadow.map) {
        sunLight.shadow.map.dispose();
        sunLight.shadow.map = null;
      }
    }
    const radius = tier === 'ultra' ? 140 : tier === 'high' ? 88 : 52;
    const cam = sunLight.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.updateProjectionMatrix();
  }
  configureShadows();

  // Mid-July Telluride clock state (zero per-frame Date/Intl allocations, freezes cleanly when paused)
  const denverFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  function projectToMidJulyTellurideMs(d) {
    if (d.getUTCFullYear() === 2026 && d.getUTCMonth() === 6) return d.getTime();
    const parts = denverFmt.formatToParts(d);
    let hh = 12, mm = 0, ss = 0;
    for (const p of parts) {
      if (p.type === 'hour') hh = Number(p.value) % 24;
      else if (p.type === 'minute') mm = Number(p.value);
      else if (p.type === 'second') ss = Number(p.value);
    }
    return Date.UTC(2026, 6, 15, hh + 6, mm, ss, d.getMilliseconds());
  }

  let simEpochMs = projectToMidJulyTellurideMs(new Date());
  let astroTimer = 999; // trigger immediate calculation on frame 0
  let astroDirty = true;
  const _astroScratch = { sunDir: { x: 0, y: 1, z: 0 }, moonDir: { x: 0, y: 1, z: 0 }, moonPhase: 0.75 };

  let latestRunnerHeading = null;

  let targetRain = 0.0;
  let targetCloud = 0.25;
  let monsoonRemaining = 0;
  let lightningTimer = 4.0;
  let lightningFlash = 0;
  let boltVisibleTimer = 0;

  function setTimeOfDay(date) {
    let nextMs = null;
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      nextMs = projectToMidJulyTellurideMs(date);
    } else if (typeof date === 'number' && Number.isFinite(date)) {
      const hNorm = ((date % 24) + 24) % 24;
      const wholeH = Math.floor(hNorm);
      const mins = Math.floor((hNorm - wholeH) * 60);
      const secs = Math.round(((hNorm - wholeH) * 60 - mins) * 60);
      nextMs = Date.UTC(2026, 6, 15, wholeH + 6, mins, secs, 0);
    } else if (date == null) {
      nextMs = projectToMidJulyTellurideMs(new Date());
    }
    if (nextMs !== null) {
      // Only force immediate celestial recalc when jumped by > 5 seconds
      if (Math.abs(nextMs - simEpochMs) > 5000) {
        astroDirty = true;
      }
      simEpochMs = nextMs;
    }
  }

  function setWeather({ monsoon, rain, cloudCover } = {}) {
    if (typeof monsoon === 'number') {
      targetRain = Math.max(0, Math.min(1, monsoon));
      if (targetRain <= 0.01) monsoonRemaining = 0;
      targetCloud = targetRain > 0.01 ? Math.max(targetCloud, 0.25 + targetRain * 0.72) : 0.25;
    }
    if (typeof rain === 'number') {
      targetRain = Math.max(0, Math.min(1, rain));
      if (targetRain <= 0.01) monsoonRemaining = 0;
    }
    if (typeof cloudCover === 'number') targetCloud = Math.max(0, Math.min(1, cloudCover));
  }

  function triggerMonsoon(durationSec = 180, intensity = 0.9) {
    monsoonRemaining = Math.max(0, durationSec);
    setWeather({ monsoon: intensity, cloudCover: 0.95 });
    events.emit('world:monsoon', { active: true, intensity, durationSec });
  }

  const unsubStorm = events.on('world:storm', (payload = {}) => {
    const active = payload.active !== false;
    const intensity = active ? Math.max(0.25, Math.min(1, payload.intensity ?? 0.88)) : 0;
    setWeather({
      monsoon: intensity,
      cloudCover: active ? Math.max(0.82, 0.40 + intensity * 0.60) : 0.25,
    });
    if (active && payload.lightning && lightningTimer > 1.5) {
      lightningTimer = 0.25;
    }
  });

  const unsubHud = events.on('hud', (hud) => {
    if (hud && typeof hud.heading === 'number' && Number.isFinite(hud.heading)) {
      latestRunnerHeading = hud.heading;
    }
  });

  // Guarded quality listener: ignore pure renderScale adaptive ticks!
  const unsubQuality = events.on('quality:changed', (q) => {
    const nextTier = q?.tier ?? engine.quality.tier;
    const nextShadows = Boolean(engine.quality.shadows);
    const nextShadowSize = engine.quality.shadowMapSize || 0;
    const nextWater = engine.quality.water;

    if (nextTier !== lastTier || nextShadows !== lastShadows || nextShadowSize !== lastShadowMapSize) {
      lastTier = nextTier;
      lastShadows = nextShadows;
      lastShadowMapSize = nextShadowSize;
      configureShadows();
    }
    if (nextWater !== lastWaterMode) {
      lastWaterMode = nextWater;
      updateEnvMapIfNeeded(true);
    }
  });

  const unsubContextRestored = events.on('engine:contextrestored', () => {
    if (pmremGen) {
      pmremGen.dispose();
      pmremGen = null;
    }
    if (envRT) {
      envRT.dispose();
      envRT = null;
    }
    lastEnvSunY = -99;
    configureShadows();
    updateEnvMapIfNeeded(true);
  });

  // Scratch vectors/colors (zero per-frame allocations)
  const _daySun = new THREE.Color(0xfff3de);
  const _goldSun = new THREE.Color(0xff8430);
  const _moonCol = new THREE.Color(0x9cb8e8);
  const _daySky = new THREE.Color(0x74a3dc);
  const _twilightSky = new THREE.Color(0x88688c);
  const _nightSky = new THREE.Color(0x2e436e);
  const _stormSky = new THREE.Color(0x283242);
  const _dayHorizon = new THREE.Color(0xb8d0e8);
  const _goldHorizon = new THREE.Color(0xe88a56);
  const _nightHorizon = new THREE.Color(0x26395c);
  const _stormHorizon = new THREE.Color(0x323d4e);
  const _dayFog = new THREE.Color(0xa6c1de);
  const _stormFog = new THREE.Color(0x384455);
  const _groundDay = new THREE.Color(0x444b39);
  const _groundNight = new THREE.Color(0x222c3f);
  const _lightDir = new THREE.Vector3();
  const _headDir = new THREE.Vector3();

  function spawnLightningBolt(anchorPos) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 1400 + Math.random() * 2600;
    const bx = anchorPos.x + Math.cos(angle) * dist;
    const bz = anchorPos.z + Math.sin(angle) * dist;
    const topY = anchorPos.y + 1800 + Math.random() * 600;
    const botY = anchorPos.y - 200;

    let cx = bx;
    let cz = bz;
    const pos = boltGeo.attributes.position.array;
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      pos[i * 3] = cx;
      pos[i * 3 + 1] = THREE.MathUtils.lerp(topY, botY, t);
      pos[i * 3 + 2] = cz;
      cx += (Math.random() - 0.5) * 140;
      cz += (Math.random() - 0.5) * 140;
    }
    boltGeo.attributes.position.needsUpdate = true;
    boltVisibleTimer = 0.16;
    boltLine.visible = true;
    lightningFlash = 1.0;

    events.emit('world:lightning', { x: bx, z: bz, dist });
  }

  function update(dt, playerPos) {
    const isPaused = engine.getAppState?.() === 'paused';
    const simDt = isPaused ? 0 : dt;
    uniforms.uTime.value += simDt;

    if (!isPaused) {
      simEpochMs += simDt * 1000;
      if (monsoonRemaining > 0) {
        monsoonRemaining -= simDt;
        if (monsoonRemaining <= 0) {
          targetRain = 0;
          targetCloud = 0.28;
          events.emit('world:monsoon', { active: false });
        }
      }
    }

    const weatherLerp = Math.min(1, dt * 0.55);
    uniforms.uRainAmount.value = THREE.MathUtils.lerp(uniforms.uRainAmount.value, targetRain, weatherLerp);
    uniforms.uCloudCover.value = THREE.MathUtils.lerp(uniforms.uCloudCover.value, targetCloud, weatherLerp);

    const rainAmt = uniforms.uRainAmount.value;
    rainMesh.visible = rainAmt > 0.04;
    if (rainMesh.visible) {
      rainUniforms.uCamPos.value.copy(engine.camera.position);
    }

    if (rainAmt > 0.35 && !isPaused) {
      lightningTimer -= simDt;
      if (lightningTimer <= 0) {
        lightningTimer = 4 + Math.random() * 10;
        spawnLightningBolt(playerPos || engine.camera.position);
      }
    }
    if (lightningFlash > 0) {
      lightningFlash = Math.max(0, lightningFlash - dt * 4.5);
    }
    if (boltVisibleTimer > 0) {
      boltVisibleTimer -= dt;
      if (boltVisibleTimer <= 0) boltLine.visible = false;
    }
    uniforms.uLightningFlash.value = lightningFlash;

    // 1 Hz throttled zero-GC astronomical Sun + Moon update
    astroTimer += simDt;
    if (astroDirty || astroTimer >= 1.0) {
      astroTimer = 0;
      astroDirty = false;
      getCelestialPositions(simEpochMs, undefined, undefined, _astroScratch);
      uniforms.uSunDir.value.set(_astroScratch.sunDir.x, _astroScratch.sunDir.y, _astroScratch.sunDir.z).normalize();
      uniforms.uMoonDir.value.set(_astroScratch.moonDir.x, _astroScratch.moonDir.y, _astroScratch.moonDir.z).normalize();
      uniforms.uMoonPhase.value = _astroScratch.moonPhase;
    }

    const sunY = uniforms.uSunDir.value.y;
    const day = THREE.MathUtils.smoothstep(sunY, -0.06, 0.24);
    // Warm golden hour starts around ~6:15 PM (sunY ~ 0.45) and peaks 6:45-8:15 PM
    const gold = THREE.MathUtils.smoothstep(sunY, -0.06, 0.06) * (1 - THREE.MathUtils.smoothstep(sunY, 0.14, 0.46));
    const night = 1 - THREE.MathUtils.smoothstep(sunY, -0.10, 0.04);

    uniforms.uSunColor.value.copy(_daySun).lerp(_goldSun, gold * 0.92);
    if (sunY < -0.02) {
      uniforms.uSunColor.value.lerp(_moonCol, night);
    }

    uniforms.uSkyAmbientColor.value
      .copy(_nightSky)
      .lerp(_daySky, day)
      .lerp(_twilightSky, gold * 0.62)
      .lerp(_stormSky, rainAmt * 0.85);

    uniforms.uHorizonColor.value
      .copy(_nightHorizon)
      .lerp(_dayHorizon, day)
      .lerp(_goldHorizon, gold * 0.85)
      .lerp(_stormHorizon, rainAmt * 0.88);

    uniforms.uFogColor.value
      .copy(_nightHorizon)
      .lerp(_dayFog, day)
      .lerp(_goldHorizon, gold * 0.55)
      .lerp(_stormFog, rainAmt * 0.88);

    uniforms.uGroundAmbientColor.value.copy(_groundNight).lerp(_groundDay, day);

    const tierFogMult = engine.quality.tier === 'low' ? 1.55 : engine.quality.tier === 'medium' ? 1.15 : 1.0;
    uniforms.uFogDensity.value = (0.000018 + rainAmt * 0.00024) * tierFogMult;
    uniforms.uAerialScatter.value = engine.quality.tier === 'low' ? 0.65 : 0.90;

    sceneFog.color.copy(uniforms.uFogColor.value);
    sceneFog.density = uniforms.uFogDensity.value * 0.75;

    // Update Three.js scene lights
    hemiLight.color.copy(uniforms.uSkyAmbientColor.value);
    hemiLight.groundColor.copy(uniforms.uGroundAmbientColor.value);
    hemiLight.intensity = (0.62 + 0.40 * day + lightningFlash * 1.4) * (1 - rainAmt * 0.35);

    const anchor = playerPos || engine.camera.position;
    if (sunY > -0.03) {
      _lightDir.copy(uniforms.uSunDir.value);
      sunLight.color.copy(uniforms.uSunColor.value);
      sunLight.intensity = (0.28 + 2.4 * THREE.MathUtils.smoothstep(sunY, -0.03, 0.20)) * (1 - rainAmt * 0.78) + lightningFlash * 2.8;
    } else {
      _lightDir.copy(uniforms.uMoonDir.value);
      if (_lightDir.y < 0.28) _lightDir.y = 0.28;
      _lightDir.normalize();
      sunLight.color.copy(_moonCol);
      sunLight.intensity = (0.48 + 0.32 * uniforms.uMoonPhase.value) * (1 - rainAmt * 0.55) + lightningFlash * 2.8;
    }

    // Runner headlamp aimed along runner heading (never backward into runner's face in orbit mode!)
    const headlampAmt = 1.0 - THREE.MathUtils.smoothstep(sunY, -0.04, 0.06);
    if (headlampAmt > 0.02) {
      const hdg = typeof playerPos?.heading === 'number' ? playerPos.heading : latestRunnerHeading;
      if (typeof hdg === 'number' && Number.isFinite(hdg)) {
        _headDir.set(-Math.sin(hdg), 0, -Math.cos(hdg));
      } else {
        engine.camera.getWorldDirection(_headDir);
        _headDir.y = 0;
        if (_headDir.lengthSq() < 0.001) _headDir.set(0, 0, -1);
        _headDir.normalize();
      }

      if (engine.quality.tier === 'low') {
        headlampSpot.visible = false;
        headlampCheap.visible = true;
        headlampCheap.intensity = 4.2 * headlampAmt;
        headlampCheap.position.set(
          anchor.x + _headDir.x * 4.0,
          anchor.y + 1.8,
          anchor.z + _headDir.z * 4.0
        );
      } else {
        headlampCheap.visible = false;
        headlampSpot.visible = true;
        headlampSpot.intensity = 12.0 * headlampAmt;
        headlampSpot.position.set(anchor.x, anchor.y + 1.65, anchor.z);
        headlampSpot.target.position.set(
          anchor.x + _headDir.x * 16,
          anchor.y - 1.2,
          anchor.z + _headDir.z * 16
        );
      }

      if (terrain?.getHeight) {
        headlampPoolMesh.visible = true;
        headlampPoolMat.opacity = headlampAmt;
        const rx = -_headDir.z;
        const rz = _headDir.x;
        const posArr = headlampPoolGeo.attributes.position.array;
        for (let i = 0; i < poolCount; i++) {
          const lx = poolLocalXZ[i * 2];
          const fwd = poolLocalXZ[i * 2 + 1];
          const wx = anchor.x + rx * lx + _headDir.x * fwd;
          const wz = anchor.z + rz * lx + _headDir.z * fwd;
          posArr[i * 3] = wx;
          posArr[i * 3 + 1] = terrain.getHeight(wx, wz) + 0.14;
          posArr[i * 3 + 2] = wz;
        }
        headlampPoolGeo.attributes.position.needsUpdate = true;
      }
    } else {
      headlampSpot.visible = false;
      headlampCheap.visible = false;
      headlampPoolMesh.visible = false;
    }

    // Snap directional shadow target to texel grid to eliminate shadow edge shimmer
    let targetX = anchor.x;
    let targetY = anchor.y;
    let targetZ = anchor.z;
    if (sunLight.castShadow && sunLight.shadow.mapSize.width > 0) {
      const frustumWidth = sunLight.shadow.camera.right - sunLight.shadow.camera.left;
      const texelSize = frustumWidth / sunLight.shadow.mapSize.width;
      targetX = Math.round(targetX / texelSize) * texelSize;
      targetZ = Math.round(targetZ / texelSize) * texelSize;
    }
    sunLight.target.position.set(targetX, targetY, targetZ);
    sunLight.position.set(
      targetX + _lightDir.x * 220,
      targetY + _lightDir.y * 220,
      targetZ + _lightDir.z * 220
    );

    skyMesh.position.copy(engine.camera.position);

    updateEnvMapIfNeeded(false);
  }

  function dispose() {
    unsubStorm();
    unsubHud();
    unsubQuality();
    unsubContextRestored();
    scene.remove(skyMesh);
    scene.remove(hemiLight);
    scene.remove(sunLight);
    scene.remove(sunLight.target);
    scene.remove(headlampSpot);
    scene.remove(headlampSpot.target);
    scene.remove(headlampCheap);
    scene.remove(headlampPoolMesh);
    scene.remove(rainMesh);
    scene.remove(boltLine);
    skyGeo.dispose();
    skyMat.dispose();
    headlampPoolGeo.dispose();
    headlampPoolMat.dispose();
    rainGeo.dispose();
    rainMat.dispose();
    boltGeo.dispose();
    boltMat.dispose();
    if (envRT) envRT.dispose();
    if (envSkyMesh) envSkyMesh.geometry.dispose();
    if (pmremGen) pmremGen.dispose();
  }

  return {
    uniforms,
    sunLight,
    hemiLight,
    setTimeOfDay,
    setWeather,
    triggerMonsoon,
    update,
    dispose,
  };
}
