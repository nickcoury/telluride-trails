import * as THREE from 'three';
import { SAN_JUAN_FOG_GLSL } from '../atmosphere.js';
import { IMPOSTOR_GRID, IMPOSTOR_HALF_EXTENT, IMPOSTOR_CENTER_Y } from './impostorBaker.js';

const BAYER_4X4_GLSL = /* glsl */ `
float floraBayer4x4(vec2 fragCoord) {
  vec2 p = mod(floor(fragCoord), 4.0);
  int x = int(p.x);
  int y = int(p.y);
  int i = y * 4 + x;
  if (i == 0) return 0.0625;
  if (i == 1) return 0.5625;
  if (i == 2) return 0.1875;
  if (i == 3) return 0.6875;
  if (i == 4) return 0.8125;
  if (i == 5) return 0.3125;
  if (i == 6) return 0.9375;
  if (i == 7) return 0.4375;
  if (i == 8) return 0.2500;
  if (i == 9) return 0.7500;
  if (i == 10) return 0.1250;
  if (i == 11) return 0.6250;
  if (i == 12) return 1.0000;
  if (i == 13) return 0.5000;
  if (i == 14) return 0.8750;
  return 0.3750;
}
`;

function bindAtmosphereUniforms(shader, atmosphereUniforms) {
  Object.assign(shader.uniforms, {
    uSunDir: atmosphereUniforms.uSunDir,
    uMoonDir: atmosphereUniforms.uMoonDir,
    uSunColor: atmosphereUniforms.uSunColor,
    uSkyAmbientColor: atmosphereUniforms.uSkyAmbientColor,
    uGroundAmbientColor: atmosphereUniforms.uGroundAmbientColor,
    uHorizonColor: atmosphereUniforms.uHorizonColor,
    uFogColor: atmosphereUniforms.uFogColor,
    uFogDensity: atmosphereUniforms.uFogDensity,
    uFogBaseHeight: atmosphereUniforms.uFogBaseHeight,
    uFogHeightFalloff: atmosphereUniforms.uFogHeightFalloff,
    uAerialScatter: atmosphereUniforms.uAerialScatter,
    uRainAmount: atmosphereUniforms.uRainAmount,
    uTime: atmosphereUniforms.uTime,
  });
}

// ============================================================================
// 1. OPAQUE TREE BARK MATERIAL (Trunks, Limbs, Deadfall, Stumps)
// ============================================================================

export function createBarkMaterial(floraTextures, atmosphereUniforms, lodUniforms, { windStrength = 0.022, useLodFade = true } = {}) {
  const mat = new THREE.MeshLambertMaterial({
    map: floraTextures.barkAtlas,
    vertexColors: true,
    side: THREE.FrontSide,
  });

  mat.onBeforeCompile = (shader) => {
    bindAtmosphereUniforms(shader, atmosphereUniforms);
    if (useLodFade) {
      shader.uniforms.uLodStart = lodUniforms.uLodStart;
      shader.uniforms.uLodEnd = lodUniforms.uLodEnd;
    }

    shader.vertexShader =
      `varying vec3 vAtmosWorldPos;\nuniform float uTime;\nuniform float uRainAmount;\n` +
      (useLodFade ? `varying float vLodFade;\nuniform float uLodStart;\nuniform float uLodEnd;\n` : '') +
      shader.vertexShader;

    if (windStrength > 0) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 instOrigin = vec3(0.0);
        #endif
        float windGust = 1.0 + uRainAmount * 1.4;
        float hW = clamp(position.y, 0.0, 1.0);
        hW = hW * hW;
        float phase = instOrigin.x * 0.11 + instOrigin.z * 0.14 + uTime * (1.25 + uRainAmount * 0.8);
        transformed.x += sin(phase) * ${windStrength.toFixed(4)} * windGust * hW;
        transformed.z += cos(phase * 0.79 + 1.3) * ${(windStrength * 0.65).toFixed(4)} * windGust * hW;`
      );
    }

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 atmosWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        atmosWp = instanceMatrix * atmosWp;
        vec3 instCenter = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 instCenter = vec3(0.0);
      #endif
      atmosWp = modelMatrix * atmosWp;
      vAtmosWorldPos = atmosWp.xyz;
      ${useLodFade ? `vLodFade = 1.0 - smoothstep(uLodStart, uLodEnd, length(instCenter.xz - cameraPosition.xz));` : ''}`
    );

    shader.fragmentShader =
      `varying vec3 vAtmosWorldPos;\n${SAN_JUAN_FOG_GLSL}\n` +
      (useLodFade ? `varying float vLodFade;\n${BAYER_4X4_GLSL}\n` : '') +
      shader.fragmentShader;

    if (useLodFade) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `if (vLodFade < 0.01) discard;
        if (vLodFade < 0.99 && vLodFade < (1.0 - floraBayer4x4(gl_FragCoord.xy))) discard;
        #include <map_fragment>`
      );
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.rgb = applySanJuanAtmosphere(gl_FragColor.rgb, vAtmosWorldPos, cameraPosition);
      #include <tonemapping_fragment>`
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '');
  };

  mat.customProgramCacheKey = () => `flora_bark_${windStrength.toFixed(4)}_${useLodFade ? 'lod' : 'nolod'}`;
  return mat;
}

// ============================================================================
// 2. TREE FOLIAGE MATERIAL (Spherical bent normals + quaking flutter + SSS + dither LOD)
// ============================================================================

export function createFoliageMaterial(
  floraTextures,
  atmosphereUniforms,
  lodUniforms,
  { windStrength = 0.022, flutter = 0.010, translucency = 0.65, alphaToCoverage = false } = {}
) {
  const mat = new THREE.MeshLambertMaterial({
    map: floraTextures.foliageAtlas,
    vertexColors: true,
    alphaTest: alphaToCoverage ? 0.36 : 0.42,
    alphaToCoverage,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    bindAtmosphereUniforms(shader, atmosphereUniforms);
    shader.uniforms.uLodStart = lodUniforms.uLodStart;
    shader.uniforms.uLodEnd = lodUniforms.uLodEnd;

    shader.vertexShader =
      `varying vec3 vAtmosWorldPos;\nvarying float vLodFade;\nuniform float uTime;\nuniform float uRainAmount;\nuniform float uLodStart;\nuniform float uLodEnd;\n` +
      shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 instOrigin = vec3(0.0);
      #endif
      float windGust = 1.0 + uRainAmount * 1.4;
      float hW = clamp(position.y, 0.0, 1.0);
      hW = hW * hW;
      float phase = instOrigin.x * 0.11 + instOrigin.z * 0.14 + uTime * (1.25 + uRainAmount * 0.8);
      // Primary trunk sway (matches barkMat identically so boughs stay attached to trunk!)
      transformed.x += sin(phase) * ${windStrength.toFixed(4)} * windGust * hW;
      transformed.z += cos(phase * 0.79 + 1.3) * ${(windStrength * 0.65).toFixed(4)} * windGust * hW;
      // High-frequency branch/leaf quaking shimmer (peaks at outer branch tips)
      float tipW = clamp(length(position.xz) * 2.8, 0.0, 1.0);
      float fPhase = uTime * (4.6 + uRainAmount * 3.0) + position.x * 19.0 + position.y * 13.0 + position.z * 17.0 + instOrigin.x * 0.37;
      transformed.x += sin(fPhase) * ${flutter.toFixed(4)} * tipW * windGust;
      transformed.y += cos(fPhase * 1.23) * ${(flutter * 0.55).toFixed(4)} * tipW * windGust;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 atmosWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        atmosWp = instanceMatrix * atmosWp;
        vec3 instCenter = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 instCenter = vec3(0.0);
      #endif
      atmosWp = modelMatrix * atmosWp;
      vAtmosWorldPos = atmosWp.xyz;
      vLodFade = 1.0 - smoothstep(uLodStart, uLodEnd, length(instCenter.xz - cameraPosition.xz));`
    );

    shader.fragmentShader =
      `varying vec3 vAtmosWorldPos;\nvarying float vLodFade;\n${SAN_JUAN_FOG_GLSL}\n${BAYER_4X4_GLSL}\n` +
      shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `if (vLodFade < 0.01) discard;
      if (vLodFade < 0.99 && vLodFade < (1.0 - floraBayer4x4(gl_FragCoord.xy))) discard;
      #include <map_fragment>`
    );

    // CRITICAL: Keep outward spherical canopy normals on back-facing DoubleSide leaf cards
    // so foliage NEVER flips upside-down and renders pitch black!
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      normal = normalize( vNormal );`
    );

    // Subsurface sunlight translucency + gentle canopy wrap scatter
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      vec3 fViewDir = normalize( cameraPosition - vAtmosWorldPos );
      float fBackLit = pow( clamp( dot( fViewDir, -uSunDir ), 0.0, 1.0 ), 3.2 );
      float fDay = smoothstep( -0.05, 0.22, uSunDir.y ) * ( 1.0 - uRainAmount * 0.8 );
      vec3 fSss = diffuseColor.rgb * uSunColor * ( 0.40 * fBackLit + 0.14 ) * fDay * ${(translucency * 0.31831).toFixed(4)};
      reflectedLight.directDiffuse += fSss;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.rgb = applySanJuanAtmosphere(gl_FragColor.rgb, vAtmosWorldPos, cameraPosition);
      #include <tonemapping_fragment>`
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '');
  };

  mat.customProgramCacheKey = () =>
    `flora_fol_${windStrength.toFixed(4)}_${flutter.toFixed(4)}_${translucency.toFixed(2)}_${alphaToCoverage ? 1 : 0}`;
  return mat;
}

/**
 * Alpha-tested depth material for dappled real branch shadows on high/ultra tiers.
 */
export function createFoliageDepthMaterial(floraTextures, atmosphereUniforms, { windStrength = 0.022 } = {}) {
  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: floraTextures.foliageAtlas,
    alphaTest: 0.44,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = atmosphereUniforms.uTime;
    shader.uniforms.uRainAmount = atmosphereUniforms.uRainAmount;
    shader.vertexShader = `uniform float uTime;\nuniform float uRainAmount;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 instOrigin = vec3(0.0);
      #endif
      float windGust = 1.0 + uRainAmount * 1.4;
      float hW = clamp(position.y, 0.0, 1.0);
      hW = hW * hW;
      float phase = instOrigin.x * 0.11 + instOrigin.z * 0.14 + uTime * (1.25 + uRainAmount * 0.8);
      transformed.x += sin(phase) * ${windStrength.toFixed(4)} * windGust * hW;
      transformed.z += cos(phase * 0.79 + 1.3) * ${(windStrength * 0.65).toFixed(4)} * windGust * hW;`
    );
  };
  mat.customProgramCacheKey = () => `flora_fol_depth_${windStrength.toFixed(4)}`;
  return mat;
}

// ============================================================================
// 3. HEMI-OCTAHEDRAL IMPOSTOR MATERIAL (2 tris/tree, matched dynamic lighting, dither LOD)
// ============================================================================

const IMPOSTOR_VERT = /* glsl */ `
attribute vec4 aImpData; // (width, height, yaw, speciesIndex 0..3)

uniform float uTime;
uniform float uRainAmount;
uniform float uLodStart;
uniform float uLodEnd;
uniform float uFarStart;
uniform float uFarEnd;

varying vec2 vCellUv;
varying vec3 vInstColor;
varying vec3 vAtmosWorldPos;
varying float vYaw;
varying float vFadeIn;
varying float vFadeOut;
varying float vHorizDist;

vec2 dirToHemiOct(vec3 d) {
  d.y = max(d.y, 0.0001);
  vec3 p = d / (abs(d.x) + abs(d.y) + abs(d.z));
  return vec2(p.x + p.z, p.x - p.z) * 0.5 + 0.5;
}

vec2 cellToAtlasUv(vec2 cellIdx, vec2 localUv, vec2 quadOrigin) {
  float invN = 1.0 / ${IMPOSTOR_GRID.toFixed(1)};
  vec2 insetUv = localUv * 0.968 + 0.016;
  vec2 inQuad = (cellIdx + insetUv) * invN;
  return quadOrigin + inQuad * 0.5;
}

void main() {
  #ifdef USE_INSTANCING
    vec3 origin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  #else
    vec3 origin = vec3(0.0);
  #endif
  float w = aImpData.x;
  float h = aImpData.y;
  float yaw = aImpData.z;
  float sp = floor(aImpData.w + 0.5);

  vec3 centerWorld = origin + vec3(0.0, h * ${IMPOSTOR_CENTER_Y.toFixed(3)}, 0.0);
  vec3 toCamWorld = cameraPosition - centerWorld;
  float horizDist = length(toCamWorld.xz);
  vHorizDist = horizDist;
  vec3 viewDirW = normalize(toCamWorld);

  // Fade IN across [uLodStart, uLodEnd] (exact inverse of 3D mesh fade-out!)
  vFadeIn = uLodEnd > 1.0 ? smoothstep(uLodStart, uLodEnd, horizDist) : 1.0;
  vFadeOut = 1.0 - smoothstep(uFarStart, uFarEnd, horizDist);

  // Rotate viewDir from world space into tree-local space (inverse of Three.js Y rotation by +yaw)
  float cy = cos(yaw);
  float sy = sin(yaw);
  vec3 localDir = normalize(vec3(
    viewDirW.x * cy - viewDirW.z * sy,
    max(viewDirW.y, 0.001),
    viewDirW.x * sy + viewDirW.z * cy
  ));

  // Crisp nearest hemi-octahedral view (zero 3-way needle ghosting/alpha cancellation + 3x faster!)
  float N1 = ${(IMPOSTOR_GRID - 1).toFixed(1)};
  vec2 octGrid = clamp(dirToHemiOct(localDir), 0.0, 0.9999) * N1;
  vec2 cell = clamp(floor(octGrid + 0.5), vec2(0.0), vec2(N1));

  float qCol = mod(sp, 2.0);
  float qRow = floor(sp * 0.5);
  vec2 quadOrigin = vec2(qCol * 0.5, qRow * 0.5);
  vCellUv = cellToAtlasUv(cell, uv, quadOrigin);

  // Build exact camera-facing billboard basis matching OrthographicCamera in impostorBaker.js
  vec3 upRef = viewDirW.y > 0.995 ? vec3(-sy, 0.0, -cy) : vec3(0.0, 1.0, 0.0);
  vec3 billRight = normalize(cross(upRef, viewDirW));
  vec3 billUp = cross(viewDirW, billRight);

  float extent = ${(IMPOSTOR_HALF_EXTENT * 2.0).toFixed(3)};
  float billH = mix(h, w, viewDirW.y * viewDirW.y);
  // Subtle GPU wind sway on top half of billboard
  float windGust = 1.0 + uRainAmount * 1.4;
  float topMask = clamp(uv.y, 0.0, 1.0);
  float swayPhase = origin.x * 0.11 + origin.z * 0.14 + uTime * (1.25 + uRainAmount * 0.8);
  float sway = sin(swayPhase) * 0.022 * h * windGust * topMask * topMask;

  vec3 wp = centerWorld
    + billRight * (position.x * extent * w + sway)
    + billUp * (position.y * extent * billH);

  vAtmosWorldPos = wp;
  vYaw = yaw;
  #ifdef USE_INSTANCING_COLOR
    vInstColor = instanceColor;
  #else
    vInstColor = vec3(1.0);
  #endif

  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const IMPOSTOR_FRAG = /* glsl */ `
uniform sampler2D uAlbedoAtlas;
uniform sampler2D uNormalAtlas;
uniform vec3 uMoonDir;

varying vec2 vCellUv;
varying vec3 vInstColor;
varying vec3 vAtmosWorldPos;
varying float vYaw;
varying float vFadeIn;
varying float vFadeOut;
varying float vHorizDist;

${SAN_JUAN_FOG_GLSL}
${BAYER_4X4_GLSL}

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}

void main() {
  if (vFadeIn < 0.01 || vFadeOut < 0.01) discard;
  float bayer = floraBayer4x4(gl_FragCoord.xy);
  // Exact inverse of 3D mesh fade-out dither (3D discards when fadeOut < 1 - bayer, impostor discards when fadeIn < bayer)
  if (vFadeIn < 0.99 && vFadeIn < bayer) discard;
  if (vFadeOut < 0.99 && vFadeOut < bayer) discard;

  vec4 a0 = texture2D(uAlbedoAtlas, vCellUv);
  // Distance-compensated alpha cutoff defeats GPU mipmap alpha erosion on fine spruce needles at 500m-4km!
  float alphaCut = mix(0.42, 0.14, smoothstep(140.0, 1500.0, vHorizDist));
  if (a0.a < alphaCut) discard;

  vec3 albedo = srgbToLinear(a0.rgb) * vInstColor;

  vec4 nMix = texture2D(uNormalAtlas, vCellUv);
  vec3 localN = normalize(nMix.rgb * 2.0 - 1.0);
  float translucency = nMix.a;

  // Rotate local bent normal back to world space by +vYaw (Three.js right-handed Y rotation)
  float cy = cos(vYaw);
  float sy = sin(vYaw);
  vec3 worldN = normalize(vec3(
    localN.x * cy + localN.z * sy,
    localN.y,
    -localN.x * sy + localN.z * cy
  ));

  // Physically matched lighting equation matching Three.js MeshLambertMaterial + atmosphere.js
  float sunY = uSunDir.y;
  float dayF = smoothstep(-0.06, 0.24, sunY);
  float sunInt = sunY > -0.03
    ? (0.28 + 2.4 * smoothstep(-0.03, 0.20, sunY)) * (1.0 - uRainAmount * 0.78)
    : 0.72 * (1.0 - uRainAmount * 0.55);
  float hemiInt = (0.62 + 0.40 * dayF) * (1.0 - uRainAmount * 0.35);

  vec3 lightDir = sunY > -0.03
    ? uSunDir
    : normalize(vec3(uMoonDir.x, max(uMoonDir.y, 0.28), uMoonDir.z));

  float ndl = max(dot(worldN, lightDir), 0.0);
  float wrapNdl = clamp((dot(worldN, lightDir) + 0.24) / 1.24, 0.0, 1.0);
  vec3 direct = albedo * uSunColor * mix(ndl, wrapNdl, translucency * 0.45) * sunInt * 0.31831;

  vec3 hemiCol = mix(uGroundAmbientColor, uSkyAmbientColor, worldN.y * 0.5 + 0.5);
  vec3 indirect = albedo * hemiCol * hemiInt;

  vec3 toCam = normalize(cameraPosition - vAtmosWorldPos);
  float backLit = pow(clamp(dot(toCam, -uSunDir), 0.0, 1.0), 3.2);
  vec3 sss = albedo * uSunColor * (0.40 * backLit + 0.14) * dayF * (1.0 - uRainAmount * 0.8) * translucency * 0.22;

  vec3 col = direct + indirect + sss;
  col = applySanJuanAtmosphere(col, vAtmosWorldPos, cameraPosition);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createImpostorMaterial(impostorAtlas, atmosphereUniforms, lodUniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: IMPOSTOR_VERT,
    fragmentShader: IMPOSTOR_FRAG,
    uniforms: {
      ...atmosphereUniforms,
      uAlbedoAtlas: { value: impostorAtlas.albedoTex },
      uNormalAtlas: { value: impostorAtlas.normalTex },
      uLodStart: lodUniforms.uLodStart,
      uLodEnd: lodUniforms.uLodEnd,
      uFarStart: lodUniforms.uFarStart,
      uFarEnd: lodUniforms.uFarEnd,
    },
    side: THREE.DoubleSide,
    depthWrite: true,
    transparent: false,
  });
}

// ============================================================================
// 4. GROUND FLORA MATERIAL (Meadow Grass, Wildflowers, Tundra Cushions, Ferns)
// ============================================================================

export function createGroundFloraMaterial(floraTextures, atmosphereUniforms, grassLodUniforms) {
  const mat = new THREE.MeshLambertMaterial({
    map: floraTextures.groundFloraAtlas,
    vertexColors: true,
    alphaTest: 0.38,
    side: THREE.DoubleSide,
  });

  mat.onBeforeCompile = (shader) => {
    bindAtmosphereUniforms(shader, atmosphereUniforms);
    shader.uniforms.uGrassFadeStart = grassLodUniforms.uGrassFadeStart;
    shader.uniforms.uGrassFadeEnd = grassLodUniforms.uGrassFadeEnd;

    shader.vertexShader =
      `attribute vec4 aAtlasRect;\nvarying vec3 vAtmosWorldPos;\nvarying float vGrassFade;\nuniform float uTime;\nuniform float uRainAmount;\nuniform float uGrassFadeStart;\nuniform float uGrassFadeEnd;\n` +
      shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_MAP
        vMapUv = uv * aAtlasRect.zw + aAtlasRect.xy;
      #endif`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 gOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
      #else
        vec3 gOrigin = vec3(0.0);
      #endif
      float gDist = length(gOrigin.xz - cameraPosition.xz);
      float gFade = 1.0 - smoothstep(uGrassFadeStart, uGrassFadeEnd, gDist);
      vGrassFade = gFade;
      // Smoothly shrink grass into the ground at outer edge so ZERO pop is ever visible!
      transformed.y *= mix(0.25, 1.0, gFade);
      // Travelling meadow wind waves bending blade tips
      float tip = clamp(position.y, 0.0, 1.0);
      tip = tip * tip;
      float gust = 1.0 + uRainAmount * 1.5;
      float wave = sin(gOrigin.x * 0.19 + gOrigin.z * 0.14 - uTime * (2.2 + uRainAmount * 1.4));
      float micro = sin(gOrigin.x * 0.85 - gOrigin.z * 0.72 + uTime * 3.8) * 0.35;
      transformed.x += (wave + micro) * 0.105 * gust * tip;
      transformed.z += (wave * 0.65 - micro) * 0.075 * gust * tip;`
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 atmosWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        atmosWp = instanceMatrix * atmosWp;
      #endif
      atmosWp = modelMatrix * atmosWp;
      vAtmosWorldPos = atmosWp.xyz;`
    );

    shader.fragmentShader =
      `varying vec3 vAtmosWorldPos;\nvarying float vGrassFade;\n${SAN_JUAN_FOG_GLSL}\n${BAYER_4X4_GLSL}\n` +
      shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `if (vGrassFade < 0.02) discard;
      if (vGrassFade < 0.98 && vGrassFade < floraBayer4x4(gl_FragCoord.xy)) discard;
      #include <map_fragment>`
    );

    // Keep bent upward meadow normals on DoubleSide back faces!
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      normal = normalize( vNormal );`
    );

    // Subtle sunlit grass blade translucency
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      vec3 gView = normalize( cameraPosition - vAtmosWorldPos );
      float gBack = pow( clamp( dot( gView, -uSunDir ), 0.0, 1.0 ), 2.6 );
      float gDay = smoothstep( -0.05, 0.22, uSunDir.y ) * ( 1.0 - uRainAmount * 0.8 );
      reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * ( 0.26 * gBack + 0.08 ) * gDay * 0.31831;`
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.rgb = applySanJuanAtmosphere(gl_FragColor.rgb, vAtmosWorldPos, cameraPosition);
      #include <tonemapping_fragment>`
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '');
  };

  mat.customProgramCacheKey = () => 'flora_ground_carpet_v1';
  return mat;
}

// ============================================================================
// 5. SAN JUAN VOLCANIC ROCK MATERIAL (Textured + Normal Map on medium+)
// ============================================================================

export function createRockMaterial(floraTextures, atmosphereUniforms, { useNormalMap = true } = {}) {
  const mat = useNormalMap
    ? new THREE.MeshStandardMaterial({
        map: floraTextures.rockAlbedo,
        normalMap: floraTextures.rockNormal,
        normalScale: new THREE.Vector2(1.15, 1.15),
        roughness: 0.92,
        metalness: 0.02,
        vertexColors: true,
      })
    : new THREE.MeshLambertMaterial({
        map: floraTextures.rockAlbedo,
        vertexColors: true,
      });

  mat.onBeforeCompile = (shader) => {
    bindAtmosphereUniforms(shader, atmosphereUniforms);

    shader.vertexShader = `varying vec3 vAtmosWorldPos;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 atmosWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        atmosWp = instanceMatrix * atmosWp;
      #endif
      atmosWp = modelMatrix * atmosWp;
      vAtmosWorldPos = atmosWp.xyz;`
    );

    shader.fragmentShader = `varying vec3 vAtmosWorldPos;\n${SAN_JUAN_FOG_GLSL}\n` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.rgb = applySanJuanAtmosphere(gl_FragColor.rgb, vAtmosWorldPos, cameraPosition);
      #include <tonemapping_fragment>`
    );
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '');
  };

  mat.customProgramCacheKey = () => `flora_rock_${useNormalMap ? 'pbr' : 'lambert'}`;
  return mat;
}
