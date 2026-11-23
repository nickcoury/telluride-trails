import * as THREE from 'three';

const SAN_JUAN_FOG_GLSL = /* glsl */ `
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

const VERTEX_HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightUvTransform;
uniform vec4 uTileBounds;
uniform vec2 uHeightTexSize;
uniform vec2 uHeightTexelWorld;
uniform vec4 uMorphParams;
uniform vec3 uCamPos;
uniform vec4 uFlags;

attribute vec2 aGridCoord;
attribute float aSkirt;

varying vec3 vWorldPos;
varying vec2 vPatchUv;
varying vec2 vHeightUv;

float decodeTerrarium(vec4 t) {
  return (t.r * 255.0 * 256.0) + (t.g * 255.0) + (t.b * 255.0 / 256.0) - 32768.0;
}

float sampleHeightAtUv(vec2 hUv) {
  if (uFlags.x < 0.5) return 2667.0;
  vec2 maxCoord = max(uHeightTexSize - 1.0, vec2(0.0));
  vec2 fCoord = clamp(hUv, vec2(0.0), vec2(1.0)) * uHeightTexSize - 0.5;
  vec2 base = clamp(floor(fCoord), vec2(0.0), maxCoord);
  vec2 next = clamp(base + 1.0, vec2(0.0), maxCoord);
  vec2 f = clamp(fCoord - floor(fCoord), vec2(0.0), vec2(1.0));

  ivec2 i00 = ivec2(base);
  ivec2 i10 = ivec2(next.x, base.y);
  ivec2 i01 = ivec2(base.x, next.y);
  ivec2 i11 = ivec2(next);

  float h00 = decodeTerrarium(texelFetch(uHeightTex, i00, 0));
  float h10 = decodeTerrarium(texelFetch(uHeightTex, i10, 0));
  float h01 = decodeTerrarium(texelFetch(uHeightTex, i01, 0));
  float h11 = decodeTerrarium(texelFetch(uHeightTex, i11, 0));

  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

float samplePatchHeight(vec2 patchUv) {
  vec2 hUv = uHeightUvTransform.xy + patchUv * uHeightUvTransform.zw;
  return sampleHeightAtUv(hUv);
}
`;

const FRAG_HELPERS_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform sampler2D uImageryTex;
uniform sampler2D uCoverTex;
uniform sampler2D uTrailMaskTex;
uniform highp sampler2DArray uDetailAlbedoArray;
uniform highp sampler2DArray uDetailNrmRoughArray;

uniform vec4 uHeightUvTransform;
uniform vec4 uImageryUvTransform;
uniform vec4 uCoverUvTransform;
uniform vec4 uTrailUvTransform;
uniform vec2 uHeightTexSize;
uniform vec2 uHeightTexelWorld;
uniform vec3 uCamPos;
uniform vec4 uFlags;

varying vec3 vWorldPos;
varying vec2 vPatchUv;
varying vec2 vHeightUv;

float decodeTerrariumF(vec4 t) {
  return (t.r * 255.0 * 256.0) + (t.g * 255.0) + (t.b * 255.0 / 256.0) - 32768.0;
}

float sampleHeightFrag(vec2 hUv) {
  if (uFlags.x < 0.5) return 2667.0;
  vec2 maxCoord = max(uHeightTexSize - 1.0, vec2(0.0));
  vec2 fCoord = clamp(hUv, vec2(0.0), vec2(1.0)) * uHeightTexSize - 0.5;
  vec2 base = clamp(floor(fCoord), vec2(0.0), maxCoord);
  vec2 next = clamp(base + 1.0, vec2(0.0), maxCoord);
  vec2 f = clamp(fCoord - floor(fCoord), vec2(0.0), vec2(1.0));

  float h00 = decodeTerrariumF(texelFetch(uHeightTex, ivec2(base), 0));
  float h10 = decodeTerrariumF(texelFetch(uHeightTex, ivec2(next.x, base.y), 0));
  float h01 = decodeTerrariumF(texelFetch(uHeightTex, ivec2(base.x, next.y), 0));
  float h11 = decodeTerrariumF(texelFetch(uHeightTex, ivec2(next), 0));

  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

vec3 computeTerrainWorldNormal(vec2 hUv) {
  vec2 duv = 1.0 / max(uHeightTexSize, vec2(1.0));
  float hL = sampleHeightFrag(hUv - vec2(duv.x, 0.0));
  float hR = sampleHeightFrag(hUv + vec2(duv.x, 0.0));
  float hN = sampleHeightFrag(hUv - vec2(0.0, duv.y));
  float hS = sampleHeightFrag(hUv + vec2(0.0, duv.y));
  float dx = max(uHeightTexelWorld.x * 2.0, 0.5);
  float dz = max(uHeightTexelWorld.y * 2.0, 0.5);
  return normalize(vec3((hL - hR) / dx, 1.0, (hN - hS) / dz));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec4 sampleTriplanarAlbedo(vec3 wp, vec3 wn, float layer, float scale) {
  vec3 blend = pow(abs(wn), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);
  vec4 xProj = texture(uDetailAlbedoArray, vec3(wp.zy * scale, layer));
  vec4 yProj = texture(uDetailAlbedoArray, vec3(wp.xz * scale, layer));
  vec4 zProj = texture(uDetailAlbedoArray, vec3(wp.xy * scale, layer));
  return xProj * blend.x + yProj * blend.y + zProj * blend.z;
}

vec3 sampleTriplanarNrmRough(vec3 wp, vec3 wn, float layer, float scale) {
  vec3 blend = pow(abs(wn), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);
  vec3 xProj = texture(uDetailNrmRoughArray, vec3(wp.zy * scale, layer)).rgb;
  vec3 yProj = texture(uDetailNrmRoughArray, vec3(wp.xz * scale, layer)).rgb;
  vec3 zProj = texture(uDetailNrmRoughArray, vec3(wp.xy * scale, layer)).rgb;
  return xProj * blend.x + yProj * blend.y + zProj * blend.z;
}
`;

export function createTerrainMaterialPool({ engine, detailAssets }) {
  const sharedUniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uDetailAlbedoArray: { value: detailAssets.getAlbedoArray() },
    uDetailNrmRoughArray: { value: detailAssets.getNormalRoughArray() },
    // Atmosphere defaults until @world attaches scene.userData.atmosphereUniforms
    uSunDir: { value: new THREE.Vector3(0.45, 0.72, 0.52).normalize() },
    uSunColor: { value: new THREE.Color(0xfff1dc) },
    uSkyAmbientColor: { value: new THREE.Color(0x8cb8e8) },
    uGroundAmbientColor: { value: new THREE.Color(0x4a453b) },
    uHorizonColor: { value: new THREE.Color(0xaec6df) },
    uFogColor: { value: new THREE.Color(0x9fb8d4) },
    uFogDensity: { value: 0.000018 },
    uFogBaseHeight: { value: 2650.0 },
    uFogHeightFalloff: { value: 0.00065 },
    uAerialScatter: { value: 0.65 },
    uRainAmount: { value: 0.0 },
    uTime: { value: 0.0 },
  };

  const offDetailUpdate = detailAssets.onUpdate(({ albedoArray, nrmRoughArray }) => {
    sharedUniforms.uDetailAlbedoArray.value = albedoArray;
    sharedUniforms.uDetailNrmRoughArray.value = nrmRoughArray;
  });

  function syncAtmosphere(cameraPos, timeSec) {
    sharedUniforms.uCamPos.value.copy(cameraPos);
    sharedUniforms.uTime.value = timeSec;

    const ext = engine.scene.userData?.atmosphereUniforms;
    if (!ext) return;

    if (ext.uSunDir?.value) sharedUniforms.uSunDir.value.copy(ext.uSunDir.value);
    if (ext.uSunColor?.value) sharedUniforms.uSunColor.value.copy(ext.uSunColor.value);
    if (ext.uSkyAmbientColor?.value) sharedUniforms.uSkyAmbientColor.value.copy(ext.uSkyAmbientColor.value);
    if (ext.uGroundAmbientColor?.value) sharedUniforms.uGroundAmbientColor.value.copy(ext.uGroundAmbientColor.value);
    if (ext.uHorizonColor?.value) sharedUniforms.uHorizonColor.value.copy(ext.uHorizonColor.value);
    if (ext.uFogColor?.value) sharedUniforms.uFogColor.value.copy(ext.uFogColor.value);
    if (ext.uFogDensity !== undefined) sharedUniforms.uFogDensity.value = ext.uFogDensity.value;
    if (ext.uFogBaseHeight !== undefined) sharedUniforms.uFogBaseHeight.value = ext.uFogBaseHeight.value;
    if (ext.uFogHeightFalloff !== undefined) sharedUniforms.uFogHeightFalloff.value = ext.uFogHeightFalloff.value;
    if (ext.uAerialScatter !== undefined) sharedUniforms.uAerialScatter.value = ext.uAerialScatter.value;
    if (ext.uRainAmount !== undefined) sharedUniforms.uRainAmount.value = ext.uRainAmount.value;
    if (ext.uTime !== undefined) sharedUniforms.uTime.value = ext.uTime.value;
  }

  let currentShaderMode = 'high'; // 'low' | 'medium' | 'high'

  function patchSurfaceMaterial(mat, patchUniforms, shaderMode) {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, sharedUniforms, patchUniforms);

      shader.vertexShader = VERTEX_HEIGHT_GLSL + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec2 patchUv = position.xz;
        vec2 worldXZ = uTileBounds.xy + patchUv * uTileBounds.zw;
        float h = samplePatchHeight(patchUv);

        // CDLOD geomorphing toward coarse parent triangulation
        float stepUv = 1.0 / max(uMorphParams.z, 2.0);
        vec2 odd = mod(aGridCoord, 2.0);
        float hasOdd = step(0.5, odd.x + odd.y);
        if (hasOdd > 0.5) {
          float distToCam = length(vec3(worldXZ.x, h, worldXZ.y) - uCamPos);
          float morphK = clamp((distToCam - uMorphParams.x) * uMorphParams.y, 0.0, 1.0);
          vec2 dA = (odd.x > 0.5 && odd.y > 0.5) ? vec2(stepUv, -stepUv) : odd * stepUv;
          float hA = samplePatchHeight(patchUv - dA);
          float hB = samplePatchHeight(patchUv + dA);
          h = mix(h, 0.5 * (hA + hB), morphK);
        }

        h -= aSkirt * uMorphParams.w;

        vec3 transformed = vec3(worldXZ.x, h, worldXZ.y);
        vWorldPos = transformed;
        vPatchUv = patchUv;
        vHeightUv = uHeightUvTransform.xy + patchUv * uHeightUvTransform.zw;
        `,
      );

      const isLow = shaderMode === 'low';
      const isHigh = shaderMode === 'high';

      shader.fragmentShader =
        FRAG_HELPERS_GLSL + '\n' + SAN_JUAN_FOG_GLSL + '\n' + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec3 terrainWorldN = computeTerrainWorldNormal(vHeightUv);
        float terrainSlope = clamp(1.0 - terrainWorldN.y, 0.0, 1.0);
        float elev = vWorldPos.y;
        float camDist = length(vWorldPos - uCamPos);

        // Macro variation noise (kills tiling & adds natural geological/alpine variation)
        float macroA = valueNoise2(vWorldPos.xz * 0.011);
        float macroB = valueNoise2(vWorldPos.xz * 0.043 + 17.3);
        float macroVar = macroA * 0.65 + macroB * 0.35;

        // Cover weights (R=forest, G=rock/talus, B=water, A=tundra/grass)
        vec4 coverSample = vec4(0.0);
        if (uFlags.z > 0.5) {
          vec2 cUv = uCoverUvTransform.xy + vPatchUv * uCoverUvTransform.zw;
          coverSample = texture2D(uCoverTex, cUv);
        } else {
          // Physically grounded San Juan cover fallback from elevation, slope & aspect
          float forestAlt = 1.0 - smoothstep(3420.0, 3680.0, elev + (macroVar - 0.5) * 140.0);
          float cliffMask = smoothstep(0.22, 0.48, terrainSlope);
          float alpineMask = smoothstep(3350.0, 3650.0, elev);
          coverSample.r = forestAlt * (1.0 - cliffMask) * 0.75;
          coverSample.g = clamp(cliffMask + smoothstep(3650.0, 4050.0, elev) * 0.65, 0.0, 1.0);
          coverSample.a = clamp((1.0 - cliffMask) * (0.45 + alpineMask * 0.35), 0.0, 1.0);
        }

        // Layer blend weights: rock(0), talus(1), dirt(2), grass(3), forest(4), snow(5)
        float cliffW = smoothstep(0.24, 0.52, terrainSlope);
        float steepTalus = smoothstep(0.12, 0.30, terrainSlope) * (1.0 - cliffW * 0.65);
        float snowLine = smoothstep(3780.0, 4150.0, elev + (macroVar - 0.5) * 180.0 - terrainWorldN.z * 110.0)
                       * (1.0 - smoothstep(0.32, 0.58, terrainSlope));
        float wRock = clamp(cliffW + coverSample.g * 0.45, 0.0, 1.0);
        float wTalus = clamp(steepTalus * 0.75 + coverSample.g * 0.55 * (1.0 - cliffW), 0.0, 1.0);
        float wForest = clamp(coverSample.r * (1.0 - cliffW), 0.0, 1.0);
        float wGrass = clamp(coverSample.a * (1.0 - cliffW), 0.0, 1.0);
        float wDirt = clamp(0.15 * (1.0 - wForest) * (1.0 - wGrass) * (1.0 - cliffW), 0.0, 1.0);
        float wSnow = clamp(snowLine, 0.0, 1.0);

        float trailMask = 0.0;
        if (uFlags.w > 0.5) {
          vec2 tUv = uTrailUvTransform.xy + vPatchUv * uTrailUvTransform.zw;
          trailMask = texture2D(uTrailMaskTex, tUv).r;
        }

        // Normalize base weights
        float wSum = max(wRock + wTalus + wDirt + wGrass + wForest, 0.0001);
        wRock /= wSum;
        wTalus /= wSum;
        wDirt /= wSum;
        wGrass /= wSum;
        wForest /= wSum;

        // Base orthoimagery (or procedural San Juan palette if imagery still streaming)
        vec3 baseColor;
        if (uFlags.y > 0.5) {
          vec2 iUv = uImageryUvTransform.xy + vPatchUv * uImageryUvTransform.zw;
          baseColor = texture2D(uImageryTex, iUv).rgb;
        } else {
          vec3 cRock = vec3(0.24, 0.22, 0.21);
          vec3 cTalus = vec3(0.30, 0.28, 0.25);
          vec3 cGrass = vec3(0.16, 0.24, 0.10);
          vec3 cForest = vec3(0.08, 0.14, 0.07);
          vec3 cDirt = vec3(0.28, 0.21, 0.14);
          baseColor = cRock * wRock + cTalus * wTalus + cGrass * wGrass + cForest * wForest + cDirt * wDirt;
          baseColor = mix(baseColor, vec3(0.84, 0.87, 0.92), wSnow * 0.8);
        }

        // Detail PBR sampling with smooth distance fade
        float nearFade = 1.0 - smoothstep(140.0, 820.0, camDist);
        float cliffFade = 1.0 - smoothstep(400.0, 2600.0, camDist);
        float terrainRoughness = 0.90;
        vec3 detailTangentN = vec3(0.0);

        ${
          isLow
            ? /* glsl */ `
          if (nearFade > 0.01) {
            vec2 detUv = vWorldPos.xz * 0.16;
            vec3 dRock = texture(uDetailAlbedoArray, vec3(detUv * 0.65, 0.0)).rgb;
            vec3 dGrass = texture(uDetailAlbedoArray, vec3(detUv, 3.0)).rgb;
            vec3 dDirt = texture(uDetailAlbedoArray, vec3(detUv * 1.15, 2.0)).rgb;
            vec3 det = mix(dGrass, dRock, clamp(wRock + wTalus * 0.6, 0.0, 1.0));
            det = mix(det, dDirt, trailMask);
            baseColor = mix(baseColor, baseColor * (0.68 + det * 1.75), nearFade * 0.65);
          }
          `
            : /* glsl */ `
          vec3 detAlb = vec3(0.5);
          vec3 detNR = vec3(0.5, 0.5, 0.9);

          if (nearFade > 0.01 || cliffFade > 0.01) {
            vec2 uv1 = vWorldPos.xz * 0.18;
            vec2 uv2 = vWorldPos.xz * 0.045 + vec2(macroA * 0.35, macroB * 0.35);

            // Triplanar rock on steep canyon walls / cliffs so textures never stretch
            vec3 rockAlb = sampleTriplanarAlbedo(vWorldPos, terrainWorldN, 0.0, 0.095).rgb;
            vec3 rockNR = sampleTriplanarNrmRough(vWorldPos, terrainWorldN, 0.0, 0.095);

            if (nearFade > 0.01) {
              vec3 talusAlb = mix(
                texture(uDetailAlbedoArray, vec3(uv1 * 0.85, 1.0)).rgb,
                texture(uDetailAlbedoArray, vec3(uv2, 1.0)).rgb,
                0.35
              );
              vec3 dirtAlb = texture(uDetailAlbedoArray, vec3(uv1 * 1.2, 2.0)).rgb;
              vec3 grassAlb = mix(
                texture(uDetailAlbedoArray, vec3(uv1, 3.0)).rgb,
                texture(uDetailAlbedoArray, vec3(uv2 * 1.4, 3.0)).rgb,
                0.38
              );
              vec3 forestAlb = texture(uDetailAlbedoArray, vec3(uv1 * 0.9, 4.0)).rgb;
              vec3 snowAlb = texture(uDetailAlbedoArray, vec3(uv1 * 0.6, 5.0)).rgb;

              detAlb = rockAlb * wRock + talusAlb * wTalus + dirtAlb * wDirt + grassAlb * wGrass + forestAlb * wForest;
              detAlb = mix(detAlb, snowAlb, wSnow * 0.85);
              detAlb = mix(detAlb, dirtAlb, trailMask);

              vec3 talusNR = texture(uDetailNrmRoughArray, vec3(uv1 * 0.85, 1.0)).rgb;
              vec3 dirtNR = texture(uDetailNrmRoughArray, vec3(uv1 * 1.2, 2.0)).rgb;
              vec3 grassNR = texture(uDetailNrmRoughArray, vec3(uv1, 3.0)).rgb;
              vec3 forestNR = texture(uDetailNrmRoughArray, vec3(uv1 * 0.9, 4.0)).rgb;

              detNR = rockNR * wRock + talusNR * wTalus + dirtNR * wDirt + grassNR * wGrass + forestNR * wForest;
              detNR = mix(detNR, dirtNR, trailMask);
            } else {
              detAlb = mix(vec3(0.5), rockAlb, wRock);
              detNR = mix(vec3(0.5, 0.5, 0.9), rockNR, wRock);
            }

            // Blend detail micro-contrast onto orthoimagery, preserving aerial color while adding crisp ground texture
            float detMix = max(nearFade * 0.78, cliffFade * wRock * 0.72);
            vec3 modulated = baseColor * clamp(0.68 + detAlb * 1.75, 0.45, 1.55);
            // At very close range (<60m), allow detail texture natural hues to shine on rock & dirt
            float closeBlend = (1.0 - smoothstep(18.0, 95.0, camDist)) * (wRock * 0.45 + wTalus * 0.35 + trailMask * 0.55);
            baseColor = mix(baseColor, mix(modulated, detAlb, closeBlend), detMix);

            // Macro tone modulation to eliminate repetition
            baseColor *= 0.90 + macroVar * 0.20;

            ${
              isHigh
                ? /* glsl */ `
              float nrmStr = max(nearFade * 0.85, cliffFade * wRock * 0.75);
              detailTangentN = vec3((detNR.rg * 2.0 - 1.0) * nrmStr, 0.0);
              terrainRoughness = mix(0.92, clamp(detNR.b, 0.45, 0.98), max(nearFade, cliffFade * wRock));
              `
                : /* glsl */ `
              float nrmStr = nearFade * 0.55;
              detailTangentN = vec3((detNR.rg * 2.0 - 1.0) * nrmStr, 0.0);
              terrainRoughness = mix(0.92, clamp(detNR.b, 0.5, 0.98), nearFade);
              `
            }
          }
          `
        }

        // Trail & road dirt ribbon overlay (smooth shoulder blend, zero z-fighting)
        if (trailMask > 0.03) {
          vec3 trailColor = vec3(0.32, 0.24, 0.16) * (0.85 + macroB * 0.3);
          if (uFlags.y > 0.5) {
            trailColor = mix(baseColor * vec3(1.12, 0.98, 0.82), trailColor, 0.55);
          }
          baseColor = mix(baseColor, trailColor, clamp(trailMask * 0.85, 0.0, 0.9));
          terrainRoughness = mix(terrainRoughness, 0.86, trailMask * 0.6);
        }

        // Wetness darkening & sheen during monsoon rain
        if (uRainAmount > 0.01) {
          baseColor *= mix(1.0, 0.72, uRainAmount * 0.65);
          terrainRoughness = mix(terrainRoughness, 0.38, uRainAmount * (0.45 + wRock * 0.4));
        }

        diffuseColor.rgb *= baseColor;
        `,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `
        vec3 perturbedWorldN = terrainWorldN;
        if (length(detailTangentN.xy) > 0.001) {
          vec3 tVec = normalize(cross(vec3(0.0, 0.0, -1.0), terrainWorldN));
          vec3 bVec = cross(terrainWorldN, tVec);
          perturbedWorldN = normalize(terrainWorldN + tVec * detailTangentN.x + bVec * detailTangentN.y);
        }
        vec3 normal = normalize((viewMatrix * vec4(perturbedWorldN, 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;
        `,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor = terrainRoughness;
        `,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <tonemapping_fragment>',
        /* glsl */ `
        gl_FragColor.rgb = applySanJuanAtmosphere(gl_FragColor.rgb, vWorldPos, uCamPos);
        #include <tonemapping_fragment>
        `,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `/* fog handled in linear space before tonemapping */`,
      );
    };

    mat.customProgramCacheKey = () => `telluride-terrain-surface-${shaderMode}-v1`;
  }

  function patchDepthMaterial(depthMat, patchUniforms) {
    depthMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, sharedUniforms, patchUniforms);
      shader.vertexShader = VERTEX_HEIGHT_GLSL + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec2 patchUv = position.xz;
        vec2 worldXZ = uTileBounds.xy + patchUv * uTileBounds.zw;
        float h = samplePatchHeight(patchUv);
        float stepUv = 1.0 / max(uMorphParams.z, 2.0);
        vec2 odd = mod(aGridCoord, 2.0);
        if (step(0.5, odd.x + odd.y) > 0.5) {
          float distToCam = length(vec3(worldXZ.x, h, worldXZ.y) - uCamPos);
          float morphK = clamp((distToCam - uMorphParams.x) * uMorphParams.y, 0.0, 1.0);
          vec2 dA = (odd.x > 0.5 && odd.y > 0.5) ? vec2(stepUv, -stepUv) : odd * stepUv;
          h = mix(h, 0.5 * (samplePatchHeight(patchUv - dA) + samplePatchHeight(patchUv + dA)), morphK);
        }
        h -= aSkirt * uMorphParams.w;
        vec3 transformed = vec3(worldXZ.x, h, worldXZ.y);
        vWorldPos = transformed;
        vPatchUv = patchUv;
        vHeightUv = uHeightUvTransform.xy + patchUv * uHeightUvTransform.zw;
        `,
      );
    };
    depthMat.customProgramCacheKey = () => 'telluride-terrain-depth-v1';
  }

  const slots = [];

  function createSlot(fallbackHeightTex, fallbackImageryTex, fallbackCoverTex, fallbackTrailTex) {
    const patchUniforms = {
      uHeightTex: { value: fallbackHeightTex },
      uImageryTex: { value: fallbackImageryTex },
      uCoverTex: { value: fallbackCoverTex },
      uTrailMaskTex: { value: fallbackTrailTex },
      uHeightUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uImageryUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uCoverUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uTrailUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uTileBounds: { value: new THREE.Vector4(0, 0, 1000, 1000) },
      uHeightTexSize: { value: new THREE.Vector2(256, 256) },
      uHeightTexelWorld: { value: new THREE.Vector2(15, 15) },
      uMorphParams: { value: new THREE.Vector4(1000, 0.001, 48, 8) },
      uFlags: { value: new THREE.Vector4(0, 0, 0, 0) },
    };

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.0,
    });
    patchSurfaceMaterial(material, patchUniforms, currentShaderMode);

    const depthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    patchDepthMaterial(depthMaterial, patchUniforms);

    const slot = { material, depthMaterial, uniforms: patchUniforms, shaderMode: currentShaderMode };
    slots.push(slot);
    return slot;
  }

  function setShaderMode(tier) {
    const nextMode = tier === 'low' ? 'low' : tier === 'medium' ? 'medium' : 'high';
    if (nextMode === currentShaderMode) return;
    currentShaderMode = nextMode;
    for (const slot of slots) {
      if (slot.shaderMode !== nextMode) {
        slot.shaderMode = nextMode;
        patchSurfaceMaterial(slot.material, slot.uniforms, nextMode);
        slot.material.needsUpdate = true;
      }
    }
  }

  function dispose() {
    offDetailUpdate();
    for (const slot of slots) {
      slot.material.dispose();
      slot.depthMaterial.dispose();
    }
    slots.length = 0;
  }

  return {
    createSlot,
    syncAtmosphere,
    setShaderMode,
    dispose,
  };
}
