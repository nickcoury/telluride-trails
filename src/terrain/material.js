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
  float fogAmt = 1.0 - exp(-opticalDepth - dist * (0.000016 + uRainAmount * 0.00018) * uAerialScatter);
  fogAmt = clamp(fogAmt, 0.0, 1.0);

  float sunCos = max(dot(viewDir, uSunDir), 0.0);
  float mieGlow = pow(sunCos, 6.0) * 0.42 + pow(sunCos, 32.0) * 0.35;
  vec3 scatterColor = mix(uFogColor, uHorizonColor + uSunColor * 0.32, mieGlow * (1.0 - uRainAmount * 0.88));

  return mix(color, scatterColor, fogAmt);
}
`;

const VERTEX_HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightUvTransform;
uniform vec4 uTileBounds;
uniform vec2 uHeightTexSize;
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

// Sample vertex-aligned (N+1)x(N+1) stitched Terrarium grid: hUv=0 -> texel 0, hUv=1 -> texel N
float sampleHeightAtUv(vec2 hUv) {
  if (uFlags.x < 0.5) return 2667.0;
  vec2 maxCoord = max(uHeightTexSize - 1.0, vec2(0.0));
  vec2 fCoord = clamp(hUv, vec2(0.0), vec2(1.0)) * maxCoord;
  vec2 base = clamp(floor(fCoord), vec2(0.0), maxCoord);
  vec2 next = clamp(base + 1.0, vec2(0.0), maxCoord);
  vec2 f = clamp(fCoord - base, vec2(0.0), vec2(1.0));

  float h00 = decodeTerrarium(texelFetch(uHeightTex, ivec2(base), 0));
  float h10 = decodeTerrarium(texelFetch(uHeightTex, ivec2(next.x, base.y), 0));
  float h01 = decodeTerrarium(texelFetch(uHeightTex, ivec2(base.x, next.y), 0));
  float h11 = decodeTerrarium(texelFetch(uHeightTex, ivec2(next), 0));

  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

float samplePatchHeight(vec2 patchUv) {
  vec2 hUv = uHeightUvTransform.xy + patchUv * uHeightUvTransform.zw;
  return sampleHeightAtUv(hUv);
}
`;

const FRAG_HELPERS_GLSL = /* glsl */ `
uniform sampler2D uNormalAoTex;
uniform sampler2D uImageryTex;
uniform sampler2D uCoverTex;
uniform sampler2D uTrailMaskTex;
uniform highp sampler2DArray uDetailAlbedoArray;
uniform highp sampler2DArray uDetailNrmRoughArray;

uniform vec4 uImageryUvTransform;
uniform vec4 uCoverUvTransform;
uniform vec4 uTrailUvTransform;
uniform vec2 uHeightTexSize;
uniform vec3 uCamPos;
uniform vec4 uFlags;

varying vec3 vWorldPos;
varying vec2 vPatchUv;
varying vec2 vHeightUv;

float hash21(vec2 p) {
  // Periodic every 30 integer cells so 500 m camera-anchor shifts (all scales yield multiples of 30) are bit-exact seamless
  p = mod(p, 30.0);
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

// 2-axis dominant-plane triplanar on steep cliffs (4 fetches instead of 6 for albedo+normal, crisp strata)
vec3 sampleTriplanarCliffAlb(vec3 wp, vec3 wn, float scale) {
  vec3 blend = pow(abs(wn), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);
  vec3 col = vec3(0.0);
  if (blend.x > 0.04) col += texture(uDetailAlbedoArray, vec3(wp.zy * scale, 0.0)).rgb * blend.x;
  if (blend.y > 0.04) col += texture(uDetailAlbedoArray, vec3(wp.xz * scale, 0.0)).rgb * blend.y;
  if (blend.z > 0.04) col += texture(uDetailAlbedoArray, vec3(wp.xy * scale, 0.0)).rgb * blend.z;
  return col;
}

vec3 sampleTriplanarCliffNR(vec3 wp, vec3 wn, float scale) {
  vec3 blend = pow(abs(wn), vec3(4.0));
  blend /= max(blend.x + blend.y + blend.z, 0.0001);
  vec3 nr = vec3(0.0);
  if (blend.x > 0.04) nr += texture(uDetailNrmRoughArray, vec3(wp.zy * scale, 0.0)).rgb * blend.x;
  if (blend.y > 0.04) nr += texture(uDetailNrmRoughArray, vec3(wp.xz * scale, 0.0)).rgb * blend.y;
  if (blend.z > 0.04) nr += texture(uDetailNrmRoughArray, vec3(wp.xy * scale, 0.0)).rgb * blend.z;
  return nr;
}

// Center-normalized detail contrast multiplier centered at 1.0 with full tactile relief
vec3 normalizeDetailContrast(vec3 alb, float expectedMean, float contrastBoost) {
  vec3 ratio = alb / max(expectedMean, 0.025);
  return clamp(vec3(1.0) + (ratio - vec3(1.0)) * contrastBoost, vec3(0.32), vec3(1.75));
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
        // 1 hardware-bilinear fetch for precomputed terrain world normal + cavity/ridge AO!
        vec2 nUv = (clamp(vHeightUv, 0.0, 1.0) * max(uHeightTexSize - 1.0, vec2(0.0)) + 0.5) / max(uHeightTexSize, vec2(1.0));
        vec4 nAoSample = texture2D(uNormalAoTex, nUv);
        vec2 nXZ = nAoSample.rg * 2.0 - 1.0;
        float nY = sqrt(max(0.002, 1.0 - dot(nXZ, nXZ)));
        vec3 terrainWorldN = normalize(vec3(nXZ.x, nY, nXZ.y));
        float terrainAO = mix(0.66, 1.06, nAoSample.b);
        float terrainSlope = clamp(1.0 - terrainWorldN.y, 0.0, 1.0);
        float elev = vWorldPos.y;
        float camDist = length(vWorldPos - uCamPos);

        // Camera-anchored continuous local coordinates (500 m steps): sub-mm mobile mediump precision at 60 km+,
        // ZERO dFdx/dFdy mipmap wrap seams anywhere on screen, and exact integer UV continuity across 500 m crossings!
        vec2 relXZ = vWorldPos.xz - floor(uCamPos.xz / 500.0) * 500.0;

        // Multi-scale macro noise (500*0.06 = 30, 500*0.18 = 90 -> exact multiples of hash21's 30-cell period)
        float macroA = valueNoise2(relXZ * 0.06);  // 16.7 m wavelength
        float macroB = valueNoise2(relXZ * 0.18 + 17.3); // 5.5 m wavelength
        float macroVar = macroA * 0.62 + macroB * 0.38;

        // 1 fetch: Real NAIP orthoimagery (linearized by hardware SRGB8_ALPHA8)
        vec3 rawImg = vec3(0.14);
        float rawLum = 0.14;
        float imgSat = 0.0;
        if (uFlags.y > 0.5) {
          vec2 iUv = uImageryUvTransform.xy + vPatchUv * uImageryUvTransform.zw;
          rawImg = texture2D(uImageryTex, iUv).rgb;
          rawLum = dot(rawImg, vec3(0.299, 0.587, 0.114));
          float maxC = max(rawImg.r, max(rawImg.g, rawImg.b));
          float minC = min(rawImg.r, min(rawImg.g, rawImg.b));
          imgSat = (maxC - minC) / max(maxC, 0.001);
        }

        // 1 fetch: Cover mask (R=forest, G=rock/talus, B=water, A=tundra/grass)
        vec4 coverSample = vec4(0.0);
        if (uFlags.z > 0.5) {
          vec2 cUv = uCoverUvTransform.xy + vPatchUv * uCoverUvTransform.zw;
          coverSample = texture2D(uCoverTex, cUv);
        } else {
          float forestAlt = 1.0 - smoothstep(3420.0, 3680.0, elev + (macroVar - 0.5) * 140.0);
          float cliffMask = smoothstep(0.22, 0.48, terrainSlope);
          float alpineMask = smoothstep(3350.0, 3650.0, elev);
          coverSample.r = forestAlt * (1.0 - cliffMask) * 0.75;
          coverSample.g = clamp(cliffMask + smoothstep(3650.0, 4050.0, elev) * 0.65, 0.0, 1.0);
          coverSample.a = clamp((1.0 - cliffMask) * (0.45 + alpineMask * 0.35), 0.0, 1.0);
        }

        // 1 fetch (when active): Semantic RGB trail/road mask (R=dirt trail, G=paved asphalt, B=sidewalk/curb)
        vec3 trailSample = vec3(0.0);
        if (uFlags.w > 0.5) {
          vec2 tUv = uTrailUvTransform.xy + vPatchUv * uTrailUvTransform.zw;
          trailSample = texture2D(uTrailMaskTex, tUv).rgb;
        }
        float asphaltMask = smoothstep(0.18, 0.58, trailSample.g);
        float curbApron = smoothstep(0.15, 0.55, trailSample.b) * (1.0 - asphaltMask);
        // Organic noise-perturbed edge on dirt singletrack & jeep roads so edges feel naturally worn
        float edgeNoise = (macroB - 0.5) * 0.24;
        float dirtTrailMask = smoothstep(0.14, 0.52, trailSample.r + edgeNoise * step(0.04, trailSample.r)) * (1.0 - asphaltMask);

        // Imagery-hue material cues (sub-meter NAIP refines 30m NLCD cover!)
        float imgGreenness = uFlags.y > 0.5 ? clamp((rawImg.g - max(rawImg.r, rawImg.b) * 0.90) * 6.5, 0.0, 1.0) : 0.0;
        float imgRedEarth = uFlags.y > 0.5
          ? clamp((rawImg.r - rawImg.g * 1.06) * 5.5, 0.0, 1.0) * clamp((rawImg.r - rawImg.b * 1.25) * 4.5, 0.0, 1.0)
          : 0.0;
        float imgDarkForest = uFlags.y > 0.5 ? smoothstep(0.13, 0.025, rawLum) * smoothstep(3620.0, 3260.0, elev) : 0.0;
        float imgPaleScree = uFlags.y > 0.5 ? smoothstep(0.13, 0.34, rawLum) * (1.0 - smoothstep(0.08, 0.26, imgSat)) : 0.0;

        // Physically grounded layer weights: rock(0), talus(1), dirt(2), grass(3), forest(4), snow(5)
        // Note: terrainSlope = 1 - ny = 1 - cos(angle): 22deg=0.07, 31deg=0.14, 42deg=0.26, 48deg=0.33
        float cliffW = smoothstep(0.14, 0.32, terrainSlope);
        float steepTalus = smoothstep(0.06, 0.17, terrainSlope) * (1.0 - cliffW * 0.72);
        float alpineElev = smoothstep(3450.0, 3820.0, elev);
        float northCouloir = smoothstep(-0.10, -0.40, terrainWorldN.z);
        float snowLine = smoothstep(4040.0, 4340.0, elev + (macroVar - 0.5) * 140.0)
                       * northCouloir
                       * (1.0 - smoothstep(0.20, 0.38, terrainSlope));

        float wRock = clamp(cliffW * 1.15 + coverSample.g * 0.38 * smoothstep(0.08, 0.26, terrainSlope), 0.0, 1.0);
        float wTalus = clamp(
          steepTalus * 0.72 + coverSample.g * 0.68 * (1.0 - cliffW * 0.75) + alpineElev * imgPaleScree * 0.55,
          0.0,
          1.0
        );
        float wForest = clamp((coverSample.r * 0.85 + imgDarkForest * 0.45) * (1.0 - cliffW) * (1.0 - alpineElev * 0.8), 0.0, 1.0);
        float wGrass = clamp((coverSample.a * 0.85 + imgGreenness * 0.58) * (1.0 - cliffW), 0.0, 1.0);
        float wDirt = clamp(
          0.16 * (1.0 - wForest * 0.7) * (1.0 - wGrass * 0.6) * (1.0 - cliffW) + imgRedEarth * 0.55 + alpineElev * 0.18 * (1.0 - wGrass),
          0.0,
          1.0
        );
        float wSnow = clamp(snowLine * 0.72, 0.0, 0.72);

        float wSum = max(wRock + wTalus + wDirt + wGrass + wForest, 0.0001);
        wRock /= wSum;
        wTalus /= wSum;
        wDirt /= wSum;
        wGrass /= wSum;
        wForest /= wSum;

        // Calibrated macro orthoimagery: preserves deep forest & vibrant meadow colors while gently rolling off bright sunlit highlights
        vec3 baseColor;
        if (uFlags.y > 0.5) {
          float targetLum = (rawLum / (1.0 + rawLum * 1.35)) * 1.08;
          baseColor = rawImg * (targetLum / max(rawLum, 0.0005));
          // Subtle vibrance restoration for crisp high-altitude Colorado light
          float calLum = dot(baseColor, vec3(0.299, 0.587, 0.114));
          baseColor = max(mix(vec3(calLum), baseColor, 1.15), vec3(0.008));

          // Gentle mid-July guard ONLY for blown-out white snowdrifts on sunlit passes (preserves real San Juan iron-oxide/scree colors!)
          float highAlpine = smoothstep(3520.0, 3860.0, elev) * (1.0 - wSnow);
          if (highAlpine > 0.01 && rawLum > 0.42 && imgSat < 0.12) {
            float glarePatch = smoothstep(0.42, 0.68, rawLum) * (1.0 - smoothstep(0.05, 0.12, imgSat));
            vec3 screeWarm = mix(vec3(0.145, 0.125, 0.105), vec3(0.105, 0.115, 0.070), wGrass);
            baseColor = mix(baseColor, screeWarm * (0.82 + macroVar * 0.36), highAlpine * glarePatch * 0.58);
          }
        } else {
          vec3 cRock = vec3(0.14, 0.115, 0.095);
          vec3 cTalus = vec3(0.16, 0.15, 0.135);
          vec3 cGrass = vec3(0.085, 0.13, 0.052);
          vec3 cForest = vec3(0.045, 0.082, 0.038);
          vec3 cDirt = vec3(0.14, 0.10, 0.065);
          baseColor = cRock * wRock + cTalus * wTalus + cGrass * wGrass + cForest * wForest + cDirt * wDirt;
          baseColor = mix(baseColor, vec3(0.62, 0.66, 0.72), wSnow * 0.75);
        }

        // Keep clean calibrated macro imagery copy (unpolluted by off-road grass/dirt) for paved streets & sidewalks
        vec3 macroImageryCol = baseColor;

        // Apply subtle DEM cavity/ridge ambient occlusion across macro terrain
        baseColor *= terrainAO;

        // Detail PBR sampling ranges
        float microFade = 1.0 - smoothstep(14.0, 75.0, camDist);
        float nearFade = 1.0 - smoothstep(110.0, 560.0, camDist);
        float cliffFade = 1.0 - smoothstep(360.0, 2200.0, camDist);
        float terrainRoughness = 0.90;
        vec2 detailNormalXY = vec2(0.0);
        vec3 dirtMicroAlb = vec3(0.055, 0.038, 0.024);
        vec3 dirtMicroNR = vec3(0.5, 0.5, 0.88);
        vec3 talusMicroAlb = vec3(0.175);

        // Zero-fetch crisp procedural turf/pebble micro-grain (500*3.6=1800, 500*10.8=5400 -> exact multiples of 30)
        float fineGrain1 = valueNoise2(relXZ * 3.6 + 5.1);
        float fineGrain2 = valueNoise2(relXZ * 10.8 + 19.7);
        float microTurf = (fineGrain1 * 0.55 + fineGrain2 * 0.45) - 0.5;

        ${
          isLow
            ? /* glsl */ `
          // MINIMAL-FETCH LOW TIER: 1 single detail albedo fetch (zero normal array, zero triplanar!)
          if (nearFade > 0.01 && asphaltMask < 0.85) {
            float domLayer = 3.0;
            float domMean = 0.052;
            float domScale = 0.36;
            if (dirtTrailMask > 0.08) {
              domLayer = 2.0; domMean = 0.044; domScale = 0.42;
            } else if (wRock >= wTalus && wRock >= wGrass && wRock >= wForest) {
              domLayer = 0.0; domMean = 0.115; domScale = 0.16;
            } else if (wTalus >= wGrass && wTalus >= wForest) {
              domLayer = 1.0; domMean = 0.175; domScale = 0.32;
            } else if (wForest >= wGrass) {
              domLayer = 4.0; domMean = 0.112; domScale = 0.34;
            }
            vec3 domAlb = texture(uDetailAlbedoArray, vec3(relXZ * domScale, domLayer)).rgb;
            if (domLayer > 1.5 && domLayer < 2.5) dirtMicroAlb = domAlb;
            vec3 contrast = normalizeDetailContrast(domAlb, domMean, 1.40);
            baseColor = mix(baseColor, baseColor * contrast * (1.0 + microTurf * 0.22 * microFade), nearFade * 0.84);
          }
          `
            : /* glsl */ `
          if ((nearFade > 0.01 || (cliffFade > 0.01 && wRock > 0.06)) && asphaltMask < 0.92) {
            // Rational orthonormal Pythagorean rotations: 7-24-25 (0.96, 0.28) & 3-4-5 (0.6, 0.8)
            // Across 500 m camera-anchor steps, rotMicro shifts by (+-480, +-140) and rotMeso by (+-300, +-400):
            // all UV products are exact integers -> ZERO wrap seams & ZERO anchor-crossing pop!
            vec2 uvWarp = vec2(macroA - 0.5, macroB - 0.5) * 0.18;
            vec2 rotMicro = vec2(relXZ.x * 0.96 - relXZ.y * 0.28, relXZ.x * 0.28 + relXZ.y * 0.96);
            vec2 rotMeso = vec2(relXZ.x * 0.60 + relXZ.y * 0.80, -relXZ.x * 0.80 + relXZ.y * 0.60);
            vec2 uvMicro = rotMicro * 0.40 + uvWarp;
            vec2 uvMeso = rotMeso * 0.10 + vec2(macroA * 0.34, macroB * 0.34);
            float mesoWeight = mix(0.20, 0.52, smoothstep(14.0, 95.0, camDist));

            // 0: Rock (triplanar on steep cliffs using continuous camera-anchored coords, active-culled)
            vec3 rockAlb = vec3(0.115);
            vec3 rockNR = vec3(0.5, 0.5, 0.86);
            float rockH = 0.5;
            if (wRock > 0.03) {
              if (cliffW > 0.08 && cliffFade > 0.01) {
                vec3 triPos = vec3(relXZ.x, vWorldPos.y, relXZ.y);
                rockAlb = sampleTriplanarCliffAlb(triPos, terrainWorldN, 0.12);
                ${isHigh ? `if (camDist < 120.0) rockAlb = mix(rockAlb, sampleTriplanarCliffAlb(triPos, terrainWorldN, 0.04), 0.30);` : ''}
                rockNR = sampleTriplanarCliffNR(triPos, terrainWorldN, 0.12);
              } else {
                rockAlb = texture(uDetailAlbedoArray, vec3(uvMicro * 0.50, 0.0)).rgb;
                rockNR = texture(uDetailNrmRoughArray, vec3(uvMicro * 0.50, 0.0)).rgb;
              }
              rockH = clamp(dot(rockAlb, vec3(0.35, 0.45, 0.2)) / 0.16, 0.0, 1.0);
            }

            // 1: Angular alpine talus / scree
            vec3 talusAlb = vec3(0.175);
            vec3 talusNR = vec3(0.5, 0.5, 0.84);
            float talusH = 0.5;
            if (nearFade > 0.01 && (wTalus > 0.03 || (dirtTrailMask > 0.03 && elev > 3350.0))) {
              talusAlb = texture(uDetailAlbedoArray, vec3(uvMicro * 0.75, 1.0)).rgb;
              ${isHigh ? `talusAlb = mix(talusAlb, texture(uDetailAlbedoArray, vec3(uvMeso * 0.90, 1.0)).rgb, mesoWeight * 0.9);` : ''}
              talusNR = texture(uDetailNrmRoughArray, vec3(uvMicro * 0.75, 1.0)).rgb;
              talusMicroAlb = talusAlb;
              talusH = clamp(dot(talusAlb, vec3(0.33, 0.34, 0.33)) / 0.24, 0.0, 1.0);
            }

            // 2: Stony trail dirt & soil
            vec3 dirtAlb = vec3(0.046, 0.034, 0.022);
            vec3 dirtNR = vec3(0.5, 0.5, 0.88);
            float dirtH = 0.5;
            if (nearFade > 0.01 && (wDirt > 0.03 || dirtTrailMask > 0.03)) {
              dirtAlb = texture(uDetailAlbedoArray, vec3(uvMicro * 1.25, 2.0)).rgb;
              ${isHigh ? `dirtAlb = mix(dirtAlb, texture(uDetailAlbedoArray, vec3(uvMeso * 1.10, 2.0)).rgb, mesoWeight * 0.8);` : ''}
              dirtNR = texture(uDetailNrmRoughArray, vec3(uvMicro * 1.25, 2.0)).rgb;
              dirtMicroAlb = dirtAlb;
              dirtMicroNR = dirtNR;
              dirtH = clamp(dot(dirtAlb, vec3(0.4, 0.4, 0.2)) / 0.08, 0.0, 1.0);
            }

            // 3: Alpine grass / meadow tundra
            vec3 grassAlb = vec3(0.058, 0.052, 0.020);
            vec3 grassNR = vec3(0.5, 0.5, 0.92);
            float grassH = 0.5;
            if (nearFade > 0.01 && wGrass > 0.03) {
              grassAlb = texture(uDetailAlbedoArray, vec3(uvMicro, 3.0)).rgb;
              ${isHigh ? `grassAlb = mix(grassAlb, texture(uDetailAlbedoArray, vec3(uvMeso * 1.20, 3.0)).rgb, mesoWeight * 0.85);` : ''}
              grassNR = texture(uDetailNrmRoughArray, vec3(uvMicro, 3.0)).rgb;
              grassH = clamp(dot(grassAlb, vec3(0.3, 0.55, 0.15)) / 0.075, 0.0, 1.0);
            }

            // 4: Forest floor pine duff & needles
            vec3 forestAlb = vec3(0.115, 0.095, 0.068);
            vec3 forestNR = vec3(0.5, 0.5, 0.90);
            float forestH = 0.5;
            if (nearFade > 0.01 && wForest > 0.03) {
              forestAlb = texture(uDetailAlbedoArray, vec3(uvMicro, 4.0)).rgb;
              ${isHigh ? `forestAlb = mix(forestAlb, texture(uDetailAlbedoArray, vec3(uvMeso, 4.0)).rgb, mesoWeight * 0.85);` : ''}
              forestNR = texture(uDetailNrmRoughArray, vec3(uvMicro, 4.0)).rgb;
              forestH = clamp(dot(forestAlb, vec3(0.4, 0.4, 0.2)) / 0.16, 0.0, 1.0);
            }

            // 5: High north-couloir summer snow (only when present)
            vec3 snowAlb = vec3(0.42);
            if (nearFade > 0.01 && wSnow > 0.03) {
              snowAlb = texture(uDetailAlbedoArray, vec3(uvMicro * 0.50, 5.0)).rgb;
            }

            // Height-based splat blending: crisp interlocking patches of talus, grass tufts, pine duff & cliff rock!
            float nJitter = (macroB - 0.5) * 0.18;
            float hR = wRock   > 0.03 ? wRock   + rockH   * 0.28 + 0.04 : -1.0;
            float hT = wTalus  > 0.03 ? wTalus  + talusH  * 0.30 + nJitter : -1.0;
            float hD = wDirt   > 0.03 ? wDirt   + dirtH   * 0.24 - nJitter : -1.0;
            float hG = wGrass  > 0.03 ? wGrass  + grassH  * 0.26 + nJitter * 0.8 : -1.0;
            float hF = wForest > 0.03 ? wForest + forestH * 0.26 - nJitter * 0.6 : -1.0;
            float maxH = max(max(hR, hT), max(max(hD, hG), hF));
            float depth = 0.13;

            float bR = max(hR - (maxH - depth), 0.0);
            float bT = max(hT - (maxH - depth), 0.0);
            float bD = max(hD - (maxH - depth), 0.0);
            float bG = max(hG - (maxH - depth), 0.0);
            float bF = max(hF - (maxH - depth), 0.0);
            float bSum = max(bR + bT + bD + bG + bF, 0.0001);
            bR /= bSum; bT /= bSum; bD /= bSum; bG /= bSum; bF /= bSum;

            // Per-layer contrast-normalized detail multipliers (crisp micro-relief, zero washout!)
            vec3 cR = normalizeDetailContrast(rockAlb, 0.115, 1.35);
            vec3 cT = normalizeDetailContrast(talusAlb, 0.175, 1.42);
            vec3 cD = normalizeDetailContrast(dirtAlb, 0.044, 1.22);
            vec3 cG = normalizeDetailContrast(grassAlb, 0.052, 1.98);
            vec3 cF = normalizeDetailContrast(forestAlb, 0.112, 1.65);

            vec3 detailContrast = cR * bR + cT * bT + cD * bD + cG * bG + cF * bF;
            // Add crisp procedural blade/needle/pebble micro-texture on smooth meadows & forest floor
            float turfRelief = 1.0 + microTurf * (0.34 * bG + 0.28 * bF + 0.20 * bD + 0.14 * bT) * microFade;
            detailContrast *= turfRelief;

            // Organic meadow/tundra patchwork variegation (emerald grass, golden sedge, dark soil pockets)
            vec3 meadowTint = mix(vec3(0.84, 1.06, 0.72), vec3(1.12, 1.02, 0.68), smoothstep(0.28, 0.74, macroB));
            vec3 forestTint = mix(vec3(0.78, 0.86, 0.64), vec3(0.96, 0.82, 0.62), smoothstep(0.32, 0.72, fineGrain1));

            // Hue-grounded physical PBR layer tints
            vec3 pbrRock = rockAlb * vec3(1.04, 1.00, 0.96);
            vec3 pbrTalus = talusAlb * vec3(0.84, 0.81, 0.78);
            vec3 pbrDirt = dirtAlb * vec3(1.58, 1.54, 1.44);
            vec3 pbrGrass = grassAlb * vec3(1.22, 1.78, 0.98) * meadowTint;
            vec3 pbrForest = forestAlb * vec3(0.82, 0.78, 0.64) * forestTint;
            vec3 pbrAlb = pbrRock * bR + pbrTalus * bT + pbrDirt * bD + pbrGrass * bG + pbrForest * bF;

            float macroLum = clamp(dot(baseColor, vec3(0.299, 0.587, 0.114)), 0.032, 0.28);
            float pbrLum = max(dot(pbrAlb, vec3(0.299, 0.587, 0.114)), 0.018);
            vec3 lumMatchedPbr = pbrAlb * clamp(macroLum / pbrLum, 0.48, 1.75) * turfRelief;

            vec3 modulated = baseColor * detailContrast * mix(vec3(1.0), meadowTint, bG * 0.35 * nearFade);
            float pbrColorMix = clamp(microFade * (0.38 + bR * 0.34 + bT * 0.32 + bD * 0.22 + bG * 0.16) + cliffW * 0.44 * cliffFade, 0.0, 0.80);
            vec3 detailedColor = mix(modulated, lumMatchedPbr, pbrColorMix);

            // Mid-July high-alpine volcanic rust/ochre/charcoal geological variation on talus & scree
            if (alpineElev > 0.05 && (bT + bR) > 0.22) {
              vec3 ironOchre = vec3(1.10, 0.96, 0.85);
              vec3 charcoalAndesite = vec3(0.86, 0.89, 0.95);
              detailedColor *= mix(charcoalAndesite, ironOchre, smoothstep(0.26, 0.74, macroA)) * (0.92 + macroB * 0.16);
            }

            if (wSnow > 0.03) {
              vec3 snowCol = mix(vec3(0.55, 0.59, 0.65), snowAlb * 1.35, nearFade * 0.65);
              detailedColor = mix(detailedColor, snowCol, wSnow * 0.80);
            }

            float detAmt = max(nearFade * 0.95, cliffFade * cliffW * 0.88);
            baseColor = mix(baseColor, detailedColor, detAmt);

            // Subtle macro tone modulation to eliminate repetition across wide basins
            baseColor *= 0.90 + macroVar * 0.20;

            // Strong per-layer normal perturbation + procedural micro-tuft bump on meadows/forests!
            vec2 nR = (rockNR.rg * 2.0 - 1.0) * 1.70;
            vec2 nT = (talusNR.rg * 2.0 - 1.0) * 1.60;
            vec2 nD = (dirtNR.rg * 2.0 - 1.0) * 1.95;
            vec2 nG = (grassNR.rg * 2.0 - 1.0) * 2.15;
            vec2 nF = (forestNR.rg * 2.0 - 1.0) * 2.05;
            vec2 blendedN = nR * bR + nT * bT + nD * bD + nG * bG + nF * bF;

            // Fine procedural micro-bump on grass/forest/soil (500*9.6 = 4800 -> exact multiple of 30)
            float fxN = valueNoise2(relXZ * 9.6 + vec2(0.18, 0.0)) - valueNoise2(relXZ * 9.6 - vec2(0.18, 0.0));
            float fzN = valueNoise2(relXZ * 9.6 + vec2(0.0, 0.18)) - valueNoise2(relXZ * 9.6 - vec2(0.0, 0.18));
            blendedN += vec2(fxN, fzN) * (0.85 * bG + 0.65 * bF + 0.35 * bD) * microFade;

            float blendedRough = rockNR.b * bR + talusNR.b * bT + dirtNR.b * bD + grassNR.b * bG + forestNR.b * bF;
            float nrmGain = ${isHigh ? 'max(nearFade * 1.0, cliffFade * cliffW * 0.95)' : 'max(nearFade * 0.78, cliffFade * cliffW * 0.75)'};
            detailNormalXY = blendedN * nrmGain * (1.0 - wSnow * 0.85);
            terrainRoughness = mix(0.92, clamp(blendedRough, 0.48, 0.98), max(nearFade, cliffFade * cliffW));
          }
          `
        }

        // === SEMANTIC TRAILS, JEEP ROADS, PAVED ASPHALT & SIDEWALKS ===

        // 1. Dirt singletrack, rocky jeep roads, and mountain tracks (R channel)
        if (dirtTrailMask > 0.02) {
          vec3 dirtContrast = normalizeDetailContrast(dirtMicroAlb, 0.044, 1.28);
          float highTrail = smoothstep(3350.0, 3850.0, elev);
          // Authentic dusty Colorado montane trail soil (brown-tan-grey, NOT terracotta orange!) -> rocky grey-ochre scree above treeline
          vec3 montaneDust = vec3(0.108, 0.091, 0.071);
          vec3 alpineScreeRd = vec3(0.132, 0.123, 0.110);
          vec3 trailSoil = mix(montaneDust, alpineScreeRd, highTrail) * (0.86 + macroVar * 0.28);
          // On high alpine jeep roads (Imogene Pass), blend crushed talus pebbles into the rocky track!
          vec3 rockyContrast = highTrail > 0.05
            ? mix(dirtContrast, normalizeDetailContrast(talusMicroAlb, 0.175, 1.32), highTrail * 0.45)
            : dirtContrast;
          vec3 pbrTrail = trailSoil * rockyContrast * (1.0 + microTurf * 0.18 * microFade);
          vec3 trailCol = uFlags.y > 0.5
            ? mix(pbrTrail, macroImageryCol * terrainAO * vec3(1.02, 0.96, 0.88) * rockyContrast, 0.30)
            : pbrTrail;
          baseColor = mix(baseColor, trailCol, clamp(dirtTrailMask * 0.88, 0.0, 0.92));
          ${
            !isLow
              ? /* glsl */ `
            vec2 trailN = (dirtMicroNR.rg * 2.0 - 1.0) * 1.95 * nearFade;
            detailNormalXY = mix(detailNormalXY, trailN, dirtTrailMask * 0.88);
            terrainRoughness = mix(terrainRoughness, clamp(dirtMicroNR.b, 0.76, 0.96), dirtTrailMask * 0.8);
            `
              : ''
          }
        }

        // 2. Concrete sidewalk & curb apron alongside paved town streets ONLY (B * (1 - G))
        if (curbApron > 0.02) {
          float aggFine = valueNoise2(relXZ * 24.0);
          float aggMed = valueNoise2(relXZ * 6.0 + 4.1);
          float slabX = abs(fract(relXZ.x * 0.60) - 0.5);
          float slabZ = abs(fract(relXZ.y * 0.60) - 0.5);
          float jointLine = 1.0 - smoothstep(0.475, 0.50, max(slabX, slabZ)) * 0.24 * microFade;
          vec3 sidewalkBase = vec3(0.155, 0.150, 0.140) * (0.90 + aggFine * 0.12 + aggMed * 0.08) * jointLine;
          // Preserve desaturated macro NAIP building shadows without letting off-road grass bleed onto concrete
          float swImgLum = dot(macroImageryCol, vec3(0.299, 0.587, 0.114));
          vec3 swCol = uFlags.y > 0.5
            ? mix(sidewalkBase, mix(sidewalkBase, vec3(swImgLum * 0.92, swImgLum * 0.90, swImgLum * 0.86), 0.45), 0.55)
            : sidewalkBase;
          // Crisp dark curb gutter line right at the asphalt boundary
          float curbSeam = smoothstep(0.02, 0.18, trailSample.g) * (1.0 - asphaltMask);
          swCol *= 1.0 - curbSeam * 0.42;
          baseColor = mix(baseColor, swCol, curbApron * 0.86);
          ${
            !isLow
              ? /* glsl */ `
            float gx = valueNoise2(relXZ * 24.0 + vec2(0.12, 0.0)) - aggFine;
            float gz = valueNoise2(relXZ * 24.0 + vec2(0.0, 0.12)) - aggFine;
            detailNormalXY = mix(detailNormalXY, vec2(gx, gz) * 0.45 * microFade, curbApron * 0.85);
            terrainRoughness = mix(terrainRoughness, 0.86, curbApron * 0.85);
            `
              : ''
          }
        }

        // 3. Paved Telluride / Ouray / Silverton town asphalt (G channel)
        if (asphaltMask > 0.02) {
          // Fine isotropic asphalt mineral aggregate (500*{36,84,0.6,1.44,48} all exact multiples of 30)
          float gritFine = valueNoise2(relXZ * 36.0 + 1.3);
          float gritUltra = valueNoise2(relXZ * 84.0 + 7.9);
          float wear = valueNoise2(relXZ * 0.60 + 9.2);
          float crack = smoothstep(0.47, 0.50, abs(valueNoise2(relXZ * 1.44 + 2.3) - 0.5));
          float grain = 0.85 + gritFine * 0.16 + gritUltra * 0.14 - (1.0 - crack) * 0.06 * microFade;

          // Authentic cool weathered charcoal-slate asphalt (~0.048-0.068 linear, completely free of grass/dirt hues!)
          vec3 asphaltCore = vec3(0.050, 0.053, 0.058) * grain * (0.88 + wear * 0.24);
          // Let crisp z17 NAIP road shadows & pale lane/crosswalk markings come through cleanly (desaturated!)
          float roadImgLum = dot(macroImageryCol, vec3(0.299, 0.587, 0.114));
          float markingHint = uFlags.y > 0.5 ? smoothstep(0.22, 0.44, rawLum) * (1.0 - smoothstep(0.10, 0.24, imgSat)) : 0.0;
          vec3 shadedAsphalt = asphaltCore * mix(0.75, 1.18, smoothstep(0.04, 0.24, roadImgLum));
          vec3 finalRoad = mix(shadedAsphalt, vec3(0.24, 0.235, 0.22) * grain, markingHint * 0.42);

          baseColor = mix(baseColor, finalRoad, asphaltMask * 0.94);
          ${
            !isLow
              ? /* glsl */ `
            float ax = valueNoise2(relXZ * 48.0 + vec2(0.15, 0.0)) - valueNoise2(relXZ * 48.0 - vec2(0.15, 0.0));
            float az = valueNoise2(relXZ * 48.0 + vec2(0.0, 0.15)) - valueNoise2(relXZ * 48.0 - vec2(0.0, 0.15));
            vec2 asphaltN = vec2(ax, az) * 0.72 * microFade;
            detailNormalXY = mix(detailNormalXY, asphaltN, asphaltMask * 0.95);
            terrainRoughness = mix(terrainRoughness, mix(0.74, 0.84, wear), asphaltMask * 0.94);
            `
              : ''
          }
        }

        // Wetness darkening & sheen during monsoon rain
        if (uRainAmount > 0.01) {
          baseColor *= mix(1.0, 0.68, uRainAmount * (0.60 + asphaltMask * 0.25));
          terrainRoughness = mix(terrainRoughness, mix(0.36, 0.22, asphaltMask), uRainAmount * (0.50 + wRock * 0.35 + asphaltMask * 0.45));
        }

        diffuseColor.rgb *= baseColor;
        `,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        /* glsl */ `
        vec3 perturbedWorldN = terrainWorldN;
        if (dot(detailNormalXY, detailNormalXY) > 0.0001) {
          vec3 refAxis = abs(terrainWorldN.z) < 0.9 ? vec3(0.0, 0.0, -1.0) : vec3(1.0, 0.0, 0.0);
          vec3 tVec = normalize(cross(refAxis, terrainWorldN));
          vec3 bVec = cross(terrainWorldN, tVec);
          perturbedWorldN = normalize(terrainWorldN + tVec * detailNormalXY.x + bVec * detailNormalXY.y);
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

    mat.customProgramCacheKey = () => `telluride-terrain-surface-${shaderMode}-v4`;
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
    depthMat.customProgramCacheKey = () => 'telluride-terrain-depth-v2';
  }

  const slots = [];

  function createSlot(
    fallbackHeightTex,
    fallbackNormalAoTex,
    fallbackImageryTex,
    fallbackCoverTex,
    fallbackTrailTex,
  ) {
    const patchUniforms = {
      uHeightTex: { value: fallbackHeightTex },
      uNormalAoTex: { value: fallbackNormalAoTex },
      uImageryTex: { value: fallbackImageryTex },
      uCoverTex: { value: fallbackCoverTex },
      uTrailMaskTex: { value: fallbackTrailTex },
      uHeightUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uImageryUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uCoverUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uTrailUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
      uTileBounds: { value: new THREE.Vector4(0, 0, 1000, 1000) },
      uHeightTexSize: { value: new THREE.Vector2(257, 257) },
      uMorphParams: { value: new THREE.Vector4(1000, 0.001, 48, 6) },
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
