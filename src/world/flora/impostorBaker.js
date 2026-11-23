import * as THREE from 'three';

export const IMPOSTOR_GRID = 4;        // 4x4 hemi-octahedral views per species
export const IMPOSTOR_HALF_EXTENT = 0.58; // Ortho half-extent around (0, IMPOSTOR_CENTER_Y, 0)
export const IMPOSTOR_CENTER_Y = 0.49;

const DEFAULT_ATLAS_SIZE = 1024;

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying vec3 vObjNormal;
void main() {
  vUv = uv;
  #ifdef USE_COLOR
    vCol = color;
  #else
    vCol = vec3(1.0);
  #endif
  vObjNormal = normalize(normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BAKE_ALBEDO_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec3 vCol;

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec4 tex = texture2D(uMap, vUv);
  if (uAlphaTest > 0.0 && tex.a < uAlphaTest) discard;
  // uMap is sRGB DataTexture -> hardware-decoded to linear; multiply by AO vertex color,
  // encode back to sRGB for 8-bit dark-foliage precision, and output SOLID alpha=1.0
  // so GPU mipmaps preserve crisp canopy coverage out to 4+ km (no alpha-test erosion!).
  vec3 linCol = tex.rgb * vCol;
  gl_FragColor = vec4(clamp(linearToSrgb(linCol), 0.0, 1.0), 1.0);
}
`;

const BAKE_NORMAL_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uAlphaTest;
uniform float uTranslucency;
varying vec2 vUv;
varying vec3 vObjNormal;

void main() {
  if (uAlphaTest > 0.0) {
    float a = texture2D(uMap, vUv).a;
    if (a < uAlphaTest) discard;
  }
  vec3 n = normalize(vObjNormal);
  // RGB = object-space bent normal in [0,1]; A = foliage subsurface translucency mask
  gl_FragColor = vec4(n * 0.5 + 0.5, uTranslucency);
}
`;

/**
 * Map normalized hemi-octahedral coordinates (u, v) in [-1, 1]^2 to a unit upper-hemisphere view vector.
 */
function hemiOctToDir(u, v, out) {
  const ox = 0.5 * (u + v);
  const oz = 0.5 * (u - v);
  const oy = 1.0 - Math.abs(ox) - Math.abs(oz);
  return out.set(ox, Math.max(oy, 0.0001), oz).normalize();
}

/**
 * Runtime GPU baker that renders 4 species of real 3D tree models into paired 1024x1024
 * hemi-octahedral albedo & bent-normal atlases so distant trees match near 3D trees 1:1
 * with full dynamic sun/sky lighting and top-down parallax.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {Array<{ trunkGeo: THREE.BufferGeometry, foliageGeo: THREE.BufferGeometry, bgHex: number }>} speciesModels
 * @param {{ barkAtlas: THREE.Texture, foliageAtlas: THREE.Texture }} floraTextures
 */
export function createImpostorAtlas(renderer, speciesModels, floraTextures, initialSize = DEFAULT_ATLAS_SIZE) {
  let atlasSize = initialSize;
  const rtOpts = {
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: true,
  };

  function makeRT(size) {
    const rt = new THREE.WebGLRenderTarget(size, size, rtOpts);
    // Store explicit sRGB-encoded values in RGBA8 for dark-foliage precision; decoded explicitly in impostor shader
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  }

  let albedoRT = makeRT(atlasSize);
  let normalRT = makeRT(atlasSize);

  const bakeBarkAlbMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_ALBEDO_FRAG,
    defines: { USE_COLOR: '' },
    uniforms: {
      uMap: { value: floraTextures.barkAtlas },
      uAlphaTest: { value: 0.0 },
    },
    side: THREE.FrontSide,
  });

  const bakeFolAlbMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_ALBEDO_FRAG,
    defines: { USE_COLOR: '' },
    uniforms: {
      uMap: { value: floraTextures.foliageAtlas },
      uAlphaTest: { value: 0.24 },
    },
    side: THREE.DoubleSide,
  });

  const bakeBarkNrmMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_NORMAL_FRAG,
    uniforms: {
      uMap: { value: floraTextures.barkAtlas },
      uAlphaTest: { value: 0.0 },
      uTranslucency: { value: 0.0 },
    },
    side: THREE.FrontSide,
  });

  const bakeFolNrmMat = new THREE.ShaderMaterial({
    vertexShader: BAKE_VERT,
    fragmentShader: BAKE_NORMAL_FRAG,
    uniforms: {
      uMap: { value: floraTextures.foliageAtlas },
      uAlphaTest: { value: 0.24 },
      uTranslucency: { value: 1.0 },
    },
    side: THREE.DoubleSide,
  });

  const bakeScene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(
    -IMPOSTOR_HALF_EXTENT,
    IMPOSTOR_HALF_EXTENT,
    IMPOSTOR_HALF_EXTENT,
    -IMPOSTOR_HALF_EXTENT,
    0.1,
    8.0
  );

  const center = new THREE.Vector3(0, IMPOSTOR_CENTER_Y, 0);
  const viewDir = new THREE.Vector3();
  const prevViewport = new THREE.Vector4();
  const prevScissor = new THREE.Vector4();

  function bake() {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevToneMapping = renderer.toneMapping;
    const prevShadowEnabled = renderer.shadowMap.enabled;
    const prevClearAlpha = renderer.getClearAlpha();
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevScissorTest = renderer.getScissorTest();
    renderer.getViewport(prevViewport);
    renderer.getScissor(prevScissor);

    try {
      const setRtRect = (rt, x, y, w, h) => {
        rt.viewport.set(x, y, w, h);
        rt.scissor.set(x, y, w, h);
        rt.scissorTest = true;
        renderer.setRenderTarget(rt);
      };

      renderer.autoClear = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = false;

      const N = IMPOSTOR_GRID;
      const quadSize = atlasSize / 2;
      const cellSize = quadSize / N;
      const count = Math.min(4, speciesModels.length);

      const setRawClear = (r, g, b, a) => {
        // Bypass premultipliedAlpha=true (which zeroes RGB when a=0!) and write exact sRGB/normal clear bytes
        renderer.state.buffers.color.setClear(r, g, b, a, false);
      };

      for (let pass = 0; pass < 2; pass++) {
        const isNormal = pass === 1;
        const rt = isNormal ? normalRT : albedoRT;

        // First clear entire atlas render target cleanly (non-premultiplied so RGB never zeroes to black!)
        setRtRect(rt, 0, 0, atlasSize, atlasSize);
        if (isNormal) {
          setRawClear(0.5, 0.86, 0.5, 0.7);
        } else {
          setRawClear(0.20, 0.35, 0.20, 0.0);
        }
        renderer.clear(true, true, false);

        for (let s = 0; s < count; s++) {
          const sp = speciesModels[s];
          const qCol = s & 1;
          const qRow = s >> 1;
          const qx = qCol * quadSize;
          const qy = qRow * quadSize;

          // Clear species quadrant with species-matched raw sRGB edge-bleed RGB (alpha=0) so mipmaps never darken!
          setRtRect(rt, qx, qy, quadSize, quadSize);
          if (isNormal) {
            setRawClear(0.5, 0.86, 0.5, 0.7);
          } else {
            const hex = sp.bgHex ?? 0x325832;
            setRawClear(
              ((hex >> 16) & 255) / 255,
              ((hex >> 8) & 255) / 255,
              (hex & 255) / 255,
              0.0
            );
          }
          renderer.clear(true, true, false);

          const trunkMesh = new THREE.Mesh(sp.trunkGeo, isNormal ? bakeBarkNrmMat : bakeBarkAlbMat);
          const folMesh = new THREE.Mesh(sp.foliageGeo, isNormal ? bakeFolNrmMat : bakeFolAlbMat);
          bakeScene.add(trunkMesh, folMesh);

          for (let gy = 0; gy < N; gy++) {
            const v = (gy / (N - 1)) * 2.0 - 1.0;
            for (let gx = 0; gx < N; gx++) {
              const u = (gx / (N - 1)) * 2.0 - 1.0;
              hemiOctToDir(u, v, viewDir);

              cam.position.copy(center).addScaledVector(viewDir, 2.5);
              if (viewDir.y > 0.995) {
                cam.up.set(0, 0, -1);
              } else {
                cam.up.set(0, 1, 0);
              }
              cam.lookAt(center);
              cam.updateMatrixWorld();

              const vx = qx + gx * cellSize;
              const vy = qy + gy * cellSize;
              setRtRect(rt, vx, vy, cellSize, cellSize);
              renderer.clear(false, true, false); // clear depth for cell
              renderer.render(bakeScene, cam);
            }
          }

          bakeScene.remove(trunkMesh, folMesh);
        }

        // Restore full RT viewport so mipmap generation covers full atlas texture
        rt.viewport.set(0, 0, atlasSize, atlasSize);
        rt.scissor.set(0, 0, atlasSize, atlasSize);
        rt.scissorTest = false;
      }
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setViewport(prevViewport);
      renderer.setScissor(prevScissor);
      renderer.setScissorTest(prevScissorTest);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
      renderer.toneMapping = prevToneMapping;
      renderer.shadowMap.enabled = prevShadowEnabled;
    }

    albedoRT.texture.needsUpdate = true;
    normalRT.texture.needsUpdate = true;
  }

  bake();

  function resize(nextSize) {
    if (nextSize === atlasSize) return;
    atlasSize = nextSize;
    albedoRT.dispose();
    normalRT.dispose();
    albedoRT = makeRT(atlasSize);
    normalRT = makeRT(atlasSize);
    bake();
  }

  function dispose() {
    albedoRT.dispose();
    normalRT.dispose();
    bakeBarkAlbMat.dispose();
    bakeFolAlbMat.dispose();
    bakeBarkNrmMat.dispose();
    bakeFolNrmMat.dispose();
  }

  return {
    get size() { return atlasSize; },
    get albedoTex() { return albedoRT.texture; },
    get normalTex() { return normalRT.texture; },
    resize,
    rebake: bake,
    dispose,
  };
}
