import * as THREE from 'three';

const LAYERS = ['rock', 'talus', 'dirt', 'grass', 'forest', 'snow'];

const FALLBACK_COLORS = [
  [124, 83, 49],   // rock
  [120, 113, 100], // talus
  [71, 53, 35],    // dirt
  [80, 74, 34],    // grass
  [102, 88, 65],   // forest
  [196, 200, 206], // snow
];

const FALLBACK_ROUGHNESS = [220, 210, 224, 236, 228, 198];

/**
 * Tileable procedural fallback arrays with genuine multi-octave grain & Sobel normals
 * so terrain never looks like featureless grey plastic even on the Title screen or offline.
 */
function makeProceduralDetailArrays(maxAnisotropy = 4) {
  const size = 64;
  const depth = LAYERS.length;
  const albData = new Uint8Array(size * size * depth * 4);
  const nrmData = new Uint8Array(size * size * depth * 4);
  const heightField = new Float32Array(size * size);

  for (let l = 0; l < depth; l++) {
    const [br, bg, bb] = FALLBACK_COLORS[l];
    const rough = FALLBACK_ROUGHNESS[l];
    const layerOffset = l * size * size * 4;
    const amp = l === 5 ? 0.35 : l === 0 || l === 1 ? 1.15 : 0.9;

    for (let y = 0; y < size; y++) {
      const ty = (y / size) * Math.PI * 2;
      for (let x = 0; x < size; x++) {
        const tx = (x / size) * Math.PI * 2;
        const w1 = Math.sin(tx * 2 + l * 1.7) * Math.cos(ty * 2 - l * 2.3) * 0.45;
        const w2 = Math.sin(tx * 5 - ty * 3 + l * 3.1) * 0.3;
        const h1 = (((x * 73856093) ^ (y * 19349663) ^ (l * 83492791)) & 255) / 255 - 0.5;
        const h2 = ((((x >> 1) * 2654435761) ^ ((y >> 1) * 2246822519) ^ (l * 3266489917)) & 255) / 255 - 0.5;
        const hVal = (w1 + w2 + h1 * 0.9 + h2 * 0.7) * amp;
        heightField[y * size + x] = hVal;

        const delta = hVal * 26;
        const p = layerOffset + (y * size + x) * 4;
        albData[p] = Math.max(0, Math.min(255, Math.round(br + delta)));
        albData[p + 1] = Math.max(0, Math.min(255, Math.round(bg + delta * 0.96)));
        albData[p + 2] = Math.max(0, Math.min(255, Math.round(bb + delta * 0.92)));
        albData[p + 3] = 255;
      }
    }

    // Derive tileable tangent normals from heightField
    for (let y = 0; y < size; y++) {
      const ym = (y + size - 1) & (size - 1);
      const yp = (y + 1) & (size - 1);
      for (let x = 0; x < size; x++) {
        const xm = (x + size - 1) & (size - 1);
        const xp = (x + 1) & (size - 1);
        const dx = (heightField[y * size + xp] - heightField[y * size + xm]) * 0.55;
        const dy = (heightField[yp * size + x] - heightField[ym * size + x]) * 0.55;
        const invLen = 1 / Math.hypot(dx, dy, 1);
        const p = layerOffset + (y * size + x) * 4;
        nrmData[p] = Math.max(0, Math.min(255, Math.round((-dx * invLen * 0.5 + 0.5) * 255)));
        nrmData[p + 1] = Math.max(0, Math.min(255, Math.round((-dy * invLen * 0.5 + 0.5) * 255)));
        nrmData[p + 2] = rough;
        nrmData[p + 3] = 255;
      }
    }
  }

  const albedoArray = configureArrayTex(
    new THREE.DataArrayTexture(albData, size, size, depth),
    THREE.SRGBColorSpace,
    maxAnisotropy,
  );
  const nrmRoughArray = configureArrayTex(
    new THREE.DataArrayTexture(nrmData, size, size, depth),
    THREE.NoColorSpace,
    maxAnisotropy,
  );

  return { albedoArray, nrmRoughArray };
}

function configureArrayTex(tex, colorSpace, maxAnisotropy) {
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

async function fetchLayerPixels(url, targetSize) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(targetSize, targetSize)
      : Object.assign(document.createElement('canvas'), { width: targetSize, height: targetSize });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, targetSize, targetSize);
  bitmap.close();
  return new Uint8Array(ctx.getImageData(0, 0, targetSize, targetSize).data.buffer);
}

/**
 * Manages the 6-layer CC0 PBR detail texture arrays (albedo + packed normal/roughness).
 * Starts immediately with procedural arrays (zero network on Title screen), then upgrades
 * in parallel via Promise.all() when entering play. Low tier skips *_nrm_rough.webp completely.
 */
export function createDetailAssets(engine) {
  const base = engine.assetsBase.endsWith('/') ? engine.assetsBase : `${engine.assetsBase}/`;
  const initial = makeProceduralDetailArrays(engine.quality.maxAnisotropy || 4);

  let albedoArray = initial.albedoArray;
  let nrmRoughArray = initial.nrmRoughArray;
  let disposed = false;
  let upgradedAlbedoSize = 0;
  let upgradedNormalSize = 0;
  let loadGen = 0;
  let activePromise = null;
  let activeTargetKey = '';
  let currentAnisotropy = engine.quality.maxAnisotropy || 4;

  const listeners = new Set();

  function onUpdate(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    for (const fn of listeners) fn({ albedoArray, nrmRoughArray });
  }

  function loadTierTextures(tier) {
    if (disposed) return Promise.resolve();
    const targetAlbedoSize = tier === 'low' || tier === 'medium' ? 256 : 512;
    const needNormals = tier !== 'low';
    // Medium uses 256px albedo + 256px normals (116 texels/m = <1cm texels, saving 12 MB VRAM on mid phones!)
    const targetNormalSize = tier === 'medium' ? 256 : 512;
    const albedoDone = upgradedAlbedoSize >= targetAlbedoSize;
    const normalsDone = !needNormals || upgradedNormalSize >= targetNormalSize;

    if (albedoDone && normalsDone) {
      return Promise.resolve();
    }

    const targetKey = `${targetAlbedoSize}:${needNormals ? targetNormalSize : 0}`;
    if (activePromise && activeTargetKey === targetKey) {
      return activePromise;
    }

    const myGen = ++loadGen;
    activeTargetKey = targetKey;

    const promise = (async () => {
      try {
        const depth = LAYERS.length;

        // Fetch albedo and (when tier !== 'low') normal/roughness layers in parallel!
        const albPromise =
          upgradedAlbedoSize < targetAlbedoSize
            ? Promise.all(
                LAYERS.map((name) =>
                  fetchLayerPixels(`${base}assets/terrain/${name}_albedo.webp`, targetAlbedoSize),
                ),
              )
            : Promise.resolve(null);

        const nrmPromise =
          needNormals && upgradedNormalSize < targetNormalSize
            ? Promise.all(
                LAYERS.map((name) =>
                  fetchLayerPixels(`${base}assets/terrain/${name}_nrm_rough.webp`, targetNormalSize),
                ),
              )
            : Promise.resolve(null);

        const [albLayers, nrmLayers] = await Promise.all([albPromise, nrmPromise]);
        if (disposed || myGen !== loadGen) return;

        let changed = false;

        if (albLayers) {
          const albStride = targetAlbedoSize * targetAlbedoSize * 4;
          const albBuf = new Uint8Array(albStride * depth);
          for (let i = 0; i < depth; i++) {
            albBuf.set(albLayers[i], i * albStride);
          }
          const nextAlbedo = configureArrayTex(
            new THREE.DataArrayTexture(albBuf, targetAlbedoSize, targetAlbedoSize, depth),
            THREE.SRGBColorSpace,
            currentAnisotropy,
          );
          const prevAlbedo = albedoArray;
          albedoArray = nextAlbedo;
          upgradedAlbedoSize = targetAlbedoSize;
          changed = true;
          notify();
          prevAlbedo.dispose();
          changed = false;
        }

        if (nrmLayers) {
          const nrmStride = targetNormalSize * targetNormalSize * 4;
          const nrmBuf = new Uint8Array(nrmStride * depth);
          for (let i = 0; i < depth; i++) {
            nrmBuf.set(nrmLayers[i], i * nrmStride);
          }
          const nextNrm = configureArrayTex(
            new THREE.DataArrayTexture(nrmBuf, targetNormalSize, targetNormalSize, depth),
            THREE.NoColorSpace,
            currentAnisotropy,
          );
          const prevNrm = nrmRoughArray;
          nrmRoughArray = nextNrm;
          upgradedNormalSize = targetNormalSize;
          notify();
          prevNrm.dispose();
        } else if (changed) {
          notify();
        }
      } catch (err) {
        console.warn('[terrain] detail texture upgrade skipped, keeping procedural fallback:', err);
      } finally {
        if (myGen === loadGen) {
          activePromise = null;
          activeTargetKey = '';
        }
      }
    })();

    activePromise = promise;
    return promise;
  }

  function setAnisotropy(aniso) {
    if (aniso === currentAnisotropy) return;
    currentAnisotropy = aniso;
    albedoArray.anisotropy = aniso;
    albedoArray.needsUpdate = true;
    nrmRoughArray.anisotropy = aniso;
    nrmRoughArray.needsUpdate = true;
  }

  function dispose() {
    disposed = true;
    loadGen++;
    listeners.clear();
    albedoArray.dispose();
    nrmRoughArray.dispose();
  }

  return {
    getAlbedoArray: () => albedoArray,
    getNormalRoughArray: () => nrmRoughArray,
    loadTierTextures,
    setAnisotropy,
    onUpdate,
    dispose,
  };
}
