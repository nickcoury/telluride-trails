import { SAN_JUAN_FOG_GLSL } from './atmosphere.js';

/**
 * Patch a Three.js built-in material (MeshLambertMaterial / MeshBasicMaterial)
 * with San Juan height-fog & aerial perspective, plus optional GPU wind sway,
 * DoubleSide foliage wrap lighting, and atlas UV rect.
 * @param {import('three').Material} material
 * @param {Record<string, {value: any}>} atmosphereUniforms
 * @param {{
 *   wind?: boolean,
 *   windStrength?: number,
 *   foliage?: boolean,
 *   atlasUv?: boolean,
 *   fadeStart?: number,
 *   fadeEnd?: number,
 * }} [opts]
 */
export function patchSanJuanMaterial(material, atmosphereUniforms, opts = {}) {
  const {
    wind = false,
    windStrength = 0.25,
    foliage = false,
    atlasUv = false,
    fadeStart = 0,
    fadeEnd = 0,
  } = opts;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uSunDir: atmosphereUniforms.uSunDir,
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

    let vertHeader = 'varying vec3 vAtmosWorldPos;\n';
    if (wind) {
      vertHeader += 'uniform float uTime;\nuniform float uRainAmount;\n';
    }
    if (atlasUv) {
      vertHeader += 'attribute vec4 aAtlasRect;\n';
    }
    if (fadeEnd > fadeStart) {
      vertHeader += 'varying float vDistAlpha;\n';
    }

    shader.vertexShader = vertHeader + shader.vertexShader;

    if (atlasUv) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
        #ifdef USE_MAP
          vMapUv = uv * aAtlasRect.zw + aAtlasRect.xy;
        #endif`
      );
    }

    if (wind) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 instOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 instOrigin = vec3(0.0);
        #endif
        float windGust = 1.0 + uRainAmount * 1.4;
        float hWeight = clamp(position.y, 0.0, 1.0);
        hWeight = hWeight * hWeight;
        float phase = instOrigin.x * 0.17 + instOrigin.z * 0.23 + uTime * (1.45 + uRainAmount * 0.9);
        float swayX = sin(phase) * ${windStrength.toFixed(3)} * windGust * hWeight;
        float swayZ = cos(phase * 0.83 + 1.1) * ${(windStrength * 0.65).toFixed(3)} * windGust * hWeight;
        transformed.x += swayX;
        transformed.z += swayZ;`
      );
    }

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 atmosWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        atmosWp = instanceMatrix * atmosWp;
      #endif
      atmosWp = modelMatrix * atmosWp;
      vAtmosWorldPos = atmosWp.xyz;
      ${fadeEnd > fadeStart ? `vDistAlpha = 1.0 - smoothstep(${fadeStart.toFixed(1)}, ${fadeEnd.toFixed(1)}, length(atmosWp.xz - cameraPosition.xz));` : ''}`
    );

    let fragHeader = `varying vec3 vAtmosWorldPos;\n${SAN_JUAN_FOG_GLSL}\n`;
    if (fadeEnd > fadeStart) {
      fragHeader += 'varying float vDistAlpha;\n';
    }
    shader.fragmentShader = fragHeader + shader.fragmentShader;

    if (fadeEnd > fadeStart) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        if (vDistAlpha < 0.05) discard;
        diffuseColor.a *= vDistAlpha;`
      );
    }

    if (foliage) {
      // Prevent DoubleSide back-face normal flip from crushing foliage/impostors/grass to pitch black,
      // and add translucent canopy wrap sunlight + full sky hemisphere bounce.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        vec3 foliageAlbedo = BRDF_Lambert( diffuseColor.rgb );
        float sunWrap = max( uSunDir.y, 0.0 ) * ( 1.0 - uRainAmount * 0.65 );
        reflectedLight.directDiffuse = max( reflectedLight.directDiffuse, foliageAlbedo * uSunColor * sunWrap * 0.68 );
        reflectedLight.indirectDiffuse = max( reflectedLight.indirectDiffuse, foliageAlbedo * uSkyAmbientColor * 0.82 );`
      );
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.rgb = applySanJuanAtmosphere(gl_FragColor.rgb, vAtmosWorldPos, cameraPosition);
      #include <tonemapping_fragment>`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `/* fog handled in linear space before tonemapping */`
    );
  };

  const wKey = wind ? windStrength.toFixed(4) : '0';
  material.customProgramCacheKey = () =>
    `sanjuan_${wKey}_${foliage ? 'f' : ''}_${atlasUv ? 'a' : ''}_${fadeStart}_${fadeEnd}`;
  return material;
}
