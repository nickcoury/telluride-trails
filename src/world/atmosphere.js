import * as THREE from 'three';
import { getCelestialPositions } from './astro.js';

/**
 * Shared GLSL height-fog + aerial-perspective snippet.
 * Shared with @terrain so terrain, vegetation, water, and structures blend seamlessly into the sky.
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
  float fogAmt = 1.0 - exp(-opticalDepth - dist * (0.000016 + uRainAmount * 0.00016) * uAerialScatter);
  fogAmt = clamp(fogAmt, 0.0, 1.0);

  float sunCos = max(dot(viewDir, uSunDir), 0.0);
  float mieGlow = pow(sunCos, 6.0) * 0.42 + pow(sunCos, 32.0) * 0.35;
  vec3 scatterColor = mix(uFogColor, uHorizonColor + uSunColor * 0.32, mieGlow * (1.0 - uRainAmount * 0.85));

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

  // Day/twilight/night blend from sun elevation
  float sunElev = uSunDir.y;
  float dayFactor = smoothstep(-0.08, 0.25, sunElev);
  float twilight = smoothstep(-0.22, 0.02, sunElev) * (1.0 - smoothstep(0.0, 0.28, sunElev));

  // Rayleigh gradient: deep San Juan high-altitude cobalt zenith -> pale azure/gold horizon
  vec3 zenithDay = mix(vec3(0.07, 0.22, 0.52), vec3(0.16, 0.20, 0.26), uRainAmount * 0.85);
  vec3 zenithNight = vec3(0.008, 0.014, 0.032);
  vec3 zenith = mix(zenithNight, zenithDay, dayFactor);

  float skyPow = pow(max(y, 0.0), 0.55);
  vec3 skyCol = mix(uHorizonColor, zenith, skyPow);

  // Alpenglow band near horizon opposite or near sun at sunrise/sunset
  float sunCos = max(dot(dir, uSunDir), 0.0);
  vec3 twilightTint = vec3(0.95, 0.36, 0.16) * twilight * pow(1.0 - max(y, 0.0), 3.0) * (0.4 + 0.6 * pow(sunCos, 2.0));
  skyCol += twilightTint;

  // Solar corona & crisp solar disc (suppressed by heavy storm clouds)
  float sunVisibility = dayFactor * (1.0 - uRainAmount * 0.9);
  float corona = pow(sunCos, 10.0) * 0.28 + pow(sunCos, 96.0) * 0.75;
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

    // Moon disc
    float moonCos = dot(dir, uMoonDir);
    if (moonCos > 0.9994) {
      float moonEdge = smoothstep(0.9994, 0.99965, moonCos);
      skyCol += vec3(0.82, 0.88, 0.98) * moonEdge * (0.35 + 0.65 * uMoonPhase) * nightFactor * (1.0 - uRainAmount * 0.85);
    }
    skyCol += vec3(0.35, 0.45, 0.65) * pow(max(moonCos, 0.0), 48.0) * 0.12 * nightFactor * (1.0 - uRainAmount);
  }

  // Procedural volumetric-looking cumulus / monsoon clouds
  if (y > 0.01) {
    vec2 cloudUv = dir.xz / (y + 0.14) * 1.35 + vec2(uTime * 0.008, uTime * 0.004);
    float c1 = fbmClouds(cloudUv);
    float c2 = fbmClouds(cloudUv * 2.2 - vec2(uTime * 0.012, 0.0));
    float density = c1 * 0.68 + c2 * 0.32;

    float coverage = mix(0.56, 0.25, clamp(uCloudCover + uRainAmount * 0.65, 0.0, 1.0));
    float cloudAlpha = smoothstep(coverage, coverage + 0.22, density);
    // Fade clouds neatly into horizon haze
    cloudAlpha *= smoothstep(0.01, 0.18, y);

    // Self-shadowing approximation (bright sunlit tops / silver lining, darker storm bases)
    float lit = clamp((density - coverage) * 2.2, 0.0, 1.0);
    float forwardLit = pow(sunCos, 4.0) * 0.55;
    vec3 cloudLight = mix(uSkyAmbientColor * 1.15, vec3(1.0, 0.98, 0.94) * max(dayFactor, 0.06), 0.7) + uSunColor * forwardLit;
    vec3 cloudDark = mix(vec3(0.18, 0.22, 0.29), vec3(0.08, 0.10, 0.14), uRainAmount) * max(dayFactor, 0.08);
    vec3 cloudCol = mix(cloudDark, cloudLight, mix(0.65, 0.25, uRainAmount) * (1.0 - lit * 0.45));

    // Lightning illumination inside storm clouds
    cloudCol += vec3(0.75, 0.85, 1.0) * uLightningFlash * (0.5 + 0.8 * density);

    skyCol = mix(skyCol, cloudCol, cloudAlpha * mix(0.82, 0.96, uRainAmount));
  }

  // Lightning sheet flash in sky
  skyCol += vec3(0.65, 0.78, 1.0) * uLightningFlash * 0.45;

  // Seamless horizon blend matching applySanJuanAtmosphere
  vec3 horizonBlend = mix(uFogColor, uHorizonColor + uSunColor * 0.25, pow(sunCos, 6.0) * 0.35 * (1.0 - uRainAmount * 0.85));
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
  // Wrap rain box (44m x 26m x 44m) seamlessly around camera
  vec3 boxSize = vec3(44.0, 26.0, 44.0);
  vec3 p = aOffset;
  p.y -= uTime * aSpeed;
  p.x -= uTime * 2.4; // slight canyon breeze slant

  vec3 rel = mod(p - uCamPos + boxSize * 0.5, boxSize) - boxSize * 0.5;
  vec3 worldCenter = uCamPos + rel;

  // Stretch streak vertically & tilt slightly with wind
  vec3 vertexPos = worldCenter + vec3(position.x * 0.011 + position.y * 0.07, position.y * 0.62, position.z * 0.011);
  float distFade = 1.0 - smoothstep(10.0, 22.0, length(rel.xz));
  vAlpha = distFade * 0.28;

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
  gl_FragColor = vec4(0.80, 0.86, 0.94, vAlpha * smoothstep(0.05, 0.5, uRainAmount));
}
`;

/**
 * Create the complete atmosphere, lighting, sky dome, clouds, shadow rig, and monsoon weather system.
 */
export function createAtmosphere(engine) {
  const { scene, renderer, events } = engine;

  // Shared uniforms referenced by terrain, vegetation, water, and structures
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
    uFogBaseHeight: { value: 2667.0 }, // Telluride town elevation (m)
    uFogHeightFalloff: { value: 0.00085 },
    uAerialScatter: { value: 0.85 },
    uRainAmount: { value: 0.0 },
    uCloudCover: { value: 0.25 },
    uLightningFlash: { value: 0.0 },
    uTime: { value: 0.0 },
  };
  scene.userData.atmosphereUniforms = uniforms;
  engine.atmosphereUniforms = uniforms;

  // Exponential fog fallback for standard Three.js materials
  const sceneFog = new THREE.FogExp2(0x9cb9d8, 0.000018);
  scene.fog = sceneFog;

  // Sky dome (centered on camera every frame)
  const skyGeo = new THREE.SphereGeometry(40000, 32, 20);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -100;
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

  // Rain streaks (GPU instanced, 1 draw call)
  const rainCount = 900;
  const quadGeo = new THREE.PlaneGeometry(1, 1);
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.index = quadGeo.index;
  rainGeo.attributes.position = quadGeo.attributes.position;
  const offsets = new Float32Array(rainCount * 3);
  const speeds = new Float32Array(rainCount);
  for (let i = 0; i < rainCount; i++) {
    offsets[i * 3] = (Math.random() - 0.5) * 44;
    offsets[i * 3 + 1] = Math.random() * 26;
    offsets[i * 3 + 2] = (Math.random() - 0.5) * 44;
    speeds[i] = 17 + Math.random() * 9;
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

  // Distant lightning bolt mesh (shown briefly on strikes)
  const boltGeo = new THREE.BufferGeometry();
  const boltPositions = new Float32Array(12 * 3);
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPositions, 3));
  const boltMat = new THREE.LineBasicMaterial({ color: 0xeaf4ff, transparent: true, opacity: 0.95 });
  const boltLine = new THREE.Line(boltGeo, boltMat);
  boltLine.frustumCulled = false;
  boltLine.visible = false;
  scene.add(boltLine);

  // Environment PMREM reflection for high/ultra reflective water
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
      envSkyMesh = new THREE.Mesh(new THREE.SphereGeometry(100, 16, 10), skyMat);
      envScene.add(envSkyMesh);
    }
    const nextRT = pmremGen.fromScene(envScene, 0.02);
    if (envRT) envRT.dispose();
    envRT = nextRT;
    scene.environment = envRT.texture;
    lastEnvSunY = uniforms.uSunDir.value.y;
    lastEnvRain = uniforms.uRainAmount.value;
  }

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

  // Time & weather state
  let overrideDate = null;
  let overrideTimestampMs = 0;
  let overrideSetAtPerf = 0;

  let targetRain = 0.0;
  let targetCloud = 0.25;
  let monsoonRemaining = 0;
  let lightningTimer = 4.0;
  let lightningFlash = 0;
  let boltVisibleTimer = 0;

  function setTimeOfDay(date) {
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      overrideDate = date;
      overrideTimestampMs = date.getTime();
      overrideSetAtPerf = performance.now();
    } else if (typeof date === 'number') {
      // Allow hour-of-day shortcut in Telluride local time (MDT/MST approx UTC-6)
      const d = new Date();
      const wholeH = Math.floor(date);
      const mins = Math.round((date - wholeH) * 60);
      d.setUTCHours((wholeH + 6) % 24, mins, 0, 0);
      overrideDate = d;
      overrideTimestampMs = d.getTime();
      overrideSetAtPerf = performance.now();
    } else {
      overrideDate = null;
    }
    lastEnvSunY = -99; // trigger env refresh
  }

  function setWeather({ monsoon, rain, cloudCover } = {}) {
    if (typeof monsoon === 'number') {
      targetRain = Math.max(0, Math.min(1, monsoon));
      targetCloud = Math.max(targetCloud, 0.25 + targetRain * 0.72);
    }
    if (typeof rain === 'number') targetRain = Math.max(0, Math.min(1, rain));
    if (typeof cloudCover === 'number') targetCloud = Math.max(0, Math.min(1, cloudCover));
  }

  function triggerMonsoon(durationSec = 180, intensity = 0.9) {
    monsoonRemaining = Math.max(0, durationSec);
    setWeather({ monsoon: intensity, cloudCover: 0.92 });
    events.emit('world:monsoon', { active: true, intensity, durationSec });
  }

  const unsubWeather = events.on('world:weather', (payload) => setWeather(payload));
  const unsubGameWeather = events.on('game:weather', (payload) => setWeather(payload));
  const unsubStorm = events.on('world:storm', (payload = {}) => {
    const active = payload.active !== false;
    const intensity = active ? Math.max(0.2, Math.min(1, payload.intensity ?? 0.85)) : 0;
    setWeather({
      monsoon: intensity,
      cloudCover: active ? Math.max(0.75, 0.35 + intensity * 0.65) : 0.25,
    });
    if (active && payload.lightning && lightningTimer > 1.5) {
      lightningTimer = 0.25;
    }
  });
  const unsubMonsoon = events.on('world:triggerMonsoon', (p = {}) =>
    triggerMonsoon(p.durationSec ?? 180, p.intensity ?? 0.9)
  );
  const unsubQuality = events.on('quality:changed', () => {
    configureShadows();
    updateEnvMapIfNeeded(true);
  });

  // Scratch vectors/colors (zero per-frame allocations)
  const _daySun = new THREE.Color(0xfff3de);
  const _goldSun = new THREE.Color(0xff8e47);
  const _moonCol = new THREE.Color(0x88a2cc);
  const _daySky = new THREE.Color(0x74a3dc);
  const _twilightSky = new THREE.Color(0x6c6596);
  const _nightSky = new THREE.Color(0x1e2c4a);
  const _stormSky = new THREE.Color(0x454f5e);
  const _dayHorizon = new THREE.Color(0xb8d0e8);
  const _goldHorizon = new THREE.Color(0xdf9570);
  const _nightHorizon = new THREE.Color(0x1f2d47);
  const _stormHorizon = new THREE.Color(0x525d6d);
  const _dayFog = new THREE.Color(0xa6c1de);
  const _stormFog = new THREE.Color(0x596472);
  const _groundDay = new THREE.Color(0x444b39);
  const _groundNight = new THREE.Color(0x161f2e);
  const _lightDir = new THREE.Vector3();

  function spawnLightningBolt(anchorPos) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 1600 + Math.random() * 2800;
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
    boltVisibleTimer = 0.14;
    boltLine.visible = true;
    lightningFlash = 1.0;

    events.emit('world:lightning', { x: bx, z: bz, dist });
  }

  function update(dt, playerPos) {
    uniforms.uTime.value += dt;

    // Monsoon countdown & gentle transition
    if (monsoonRemaining > 0) {
      monsoonRemaining -= dt;
      if (monsoonRemaining <= 0) {
        targetRain = 0;
        targetCloud = 0.28;
        events.emit('world:monsoon', { active: false });
      }
    }
    const weatherLerp = Math.min(1, dt * 0.45);
    uniforms.uRainAmount.value = THREE.MathUtils.lerp(uniforms.uRainAmount.value, targetRain, weatherLerp);
    uniforms.uCloudCover.value = THREE.MathUtils.lerp(uniforms.uCloudCover.value, targetCloud, weatherLerp);

    const rainAmt = uniforms.uRainAmount.value;
    rainMesh.visible = rainAmt > 0.04;
    if (rainMesh.visible) {
      rainUniforms.uCamPos.value.copy(engine.camera.position);
    }

    // Lightning in heavy monsoon
    if (rainAmt > 0.35) {
      lightningTimer -= dt;
      if (lightningTimer <= 0) {
        lightningTimer = 4 + Math.random() * 11;
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

    // Real astronomical Sun + Moon for Telluride
    const now = overrideDate
      ? new Date(overrideTimestampMs + (performance.now() - overrideSetAtPerf))
      : new Date();
    const astro = getCelestialPositions(now);

    uniforms.uSunDir.value.set(astro.sunDir.x, astro.sunDir.y, astro.sunDir.z).normalize();
    uniforms.uMoonDir.value.set(astro.moonDir.x, astro.moonDir.y, astro.moonDir.z).normalize();
    uniforms.uMoonPhase.value = astro.moonPhase;

    const sunY = uniforms.uSunDir.value.y;
    const day = THREE.MathUtils.smoothstep(sunY, -0.06, 0.24);
    const gold = THREE.MathUtils.smoothstep(sunY, -0.08, 0.06) * (1 - THREE.MathUtils.smoothstep(sunY, 0.05, 0.34));
    const night = 1 - THREE.MathUtils.smoothstep(sunY, -0.10, 0.04);

    // Sun & ambient palette
    uniforms.uSunColor.value.copy(_daySun).lerp(_goldSun, gold);
    if (sunY < -0.02) {
      uniforms.uSunColor.value.lerp(_moonCol, night);
    }

    uniforms.uSkyAmbientColor.value
      .copy(_nightSky)
      .lerp(_daySky, day)
      .lerp(_twilightSky, gold * 0.65)
      .lerp(_stormSky, rainAmt * 0.72);

    uniforms.uHorizonColor.value
      .copy(_nightHorizon)
      .lerp(_dayHorizon, day)
      .lerp(_goldHorizon, gold * 0.75)
      .lerp(_stormHorizon, rainAmt * 0.8);

    uniforms.uFogColor.value
      .copy(_nightHorizon)
      .lerp(_dayFog, day)
      .lerp(_goldHorizon, gold * 0.45)
      .lerp(_stormFog, rainAmt * 0.82);

    uniforms.uGroundAmbientColor.value.copy(_groundNight).lerp(_groundDay, day);

    // Fog density scales gently with tier draw distance + monsoon mist
    const tierFogMult = engine.quality.tier === 'low' ? 1.55 : engine.quality.tier === 'medium' ? 1.15 : 1.0;
    uniforms.uFogDensity.value = (0.000018 + rainAmt * 0.00018) * tierFogMult;
    uniforms.uAerialScatter.value = engine.quality.tier === 'low' ? 0.65 : 0.90;

    sceneFog.color.copy(uniforms.uFogColor.value);
    sceneFog.density = uniforms.uFogDensity.value * 0.75;

    // Update Three.js scene lights
    hemiLight.color.copy(uniforms.uSkyAmbientColor.value);
    hemiLight.groundColor.copy(uniforms.uGroundAmbientColor.value);
    hemiLight.intensity = (0.42 + 0.56 * day + lightningFlash * 1.4) * (1 - rainAmt * 0.25);

    const anchor = playerPos || engine.camera.position;
    if (sunY > -0.03) {
      _lightDir.copy(uniforms.uSunDir.value);
      sunLight.color.copy(uniforms.uSunColor.value);
      sunLight.intensity = (0.2 + 2.5 * THREE.MathUtils.smoothstep(sunY, -0.03, 0.20)) * (1 - rainAmt * 0.72) + lightningFlash * 2.5;
    } else {
      _lightDir.copy(uniforms.uMoonDir.value);
      if (_lightDir.y < 0.12) _lightDir.y = 0.12;
      _lightDir.normalize();
      sunLight.color.copy(_moonCol);
      sunLight.intensity = (0.18 + 0.35 * astro.moonPhase) * (1 - rainAmt * 0.7) + lightningFlash * 2.5;
    }

    // Snap directional shadow target to texel grid to eliminate shadow edge shimmer
    let targetX = anchor.x;
    let targetY = anchor.y;
    let targetZ = anchor.z;
    if (sunLight.castShadow && sunLight.shadow.mapSize.width > 0) {
      const frustumWidth = (sunLight.shadow.camera.right - sunLight.shadow.camera.left);
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

    // Keep sky dome centered on camera
    skyMesh.position.copy(engine.camera.position);

    updateEnvMapIfNeeded(false);
  }

  function dispose() {
    unsubWeather();
    unsubGameWeather();
    unsubStorm();
    unsubMonsoon();
    unsubQuality();
    scene.remove(skyMesh);
    scene.remove(hemiLight);
    scene.remove(sunLight);
    scene.remove(sunLight.target);
    scene.remove(rainMesh);
    scene.remove(boltLine);
    skyGeo.dispose();
    skyMat.dispose();
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
