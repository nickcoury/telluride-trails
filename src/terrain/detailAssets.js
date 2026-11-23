import * as THREE from 'three';

const LAYERS = ['rock', 'talus', 'dirt', 'grass', 'forest', 'snow'];

const FALLBACK_COLORS = [
  [128, 126, 122], // rock
  [138, 134, 126], // talus
  [126, 98, 70],   // dirt
  [104, 124, 72],  // grass
  [68, 86, 54],    // forest
  [235, 240, 246], // snow
];

const FALLBACK_ROUGHNESS = [225, 232, 220, 215, 225, 165];

function makeProceduralDetailArrays(maxAnisotropy = 4) {
  const size = 64;
  const depth = LAYERS.length;
  const albData = new Uint8Array(size * size * depth * 4);
  const nrmData = new Uint8Array(size * size * depth * 4);

  for (let l = 0; l < depth; l++) {
    const [br, bg, bb] = FALLBACK_COLORS[l];
    const rough = FALLBACK_ROUGHNESS[l];
    const layerOffset = l * size * size * 4;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Simple tileable hash noise for immediate procedural grain
        const n =
          Math.sin((x / size) * Math.PI * 4 + l * 1.7) *
          Math.cos((y / size) * Math.PI * 4 - l * 2.3);
        const h = ((x * 73856093) ^ (y * 19349663) ^ (l * 83492791)) & 255;
        const delta = (h / 255 - 0.5) * 22 + n * 10;

        const p = layerOffset + (y * size + x) * 4;
        albData[p] = Math.max(0, Math.min(255, Math.round(br + delta)));
        albData[p + 1] = Math.max(0, Math.min(255, Math.round(bg + delta)));
        albData[p + 2] = Math.max(0, Math.min(255, Math.round(bb + delta)));
        albData[p + 3] = 255;

        nrmData[p] = 128;
        nrmData[p + 1] = 128;
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
 * Starts immediately with lightweight procedural arrays, then upgrades lazily to 512x512 WebPs.
 */
export function createDetailAssets(engine) {
  const base = engine.assetsBase.endsWith('/') ? engine.assetsBase : `${engine.assetsBase}/`;
  const initial = makeProceduralDetailArrays(engine.quality.maxAnisotropy || 4);

  let albedoArray = initial.albedoArray;
  let nrmRoughArray = initial.nrmRoughArray;
  let disposed = false;
  let upgradedSize = 0;

  const listeners = new Set();

  function onUpdate(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    for (const fn of listeners) fn({ albedoArray, nrmRoughArray });
  }

  async function loadTierTextures(tier) {
    const targetSize = tier === 'low' ? 256 : 512;
    const needNormals = tier !== 'low';
    if (upgradedSize >= targetSize && (!needNormals || nrmRoughArray.image.width >= targetSize)) {
      return;
    }

    try {
      const depth = LAYERS.length;
      const albBuf = new Uint8Array(targetSize * targetSize * depth * 4);
      const layerStride = targetSize * targetSize * 4;

      // Load albedos sequentially/in small batches so we don't spike memory or network
      for (let i = 0; i < depth; i++) {
        if (disposed) return;
        const pixels = await fetchLayerPixels(`${base}assets/terrain/${LAYERS[i]}_albedo.webp`, targetSize);
        albBuf.set(pixels, i * layerStride);
      }

      if (disposed) return;
      const nextAlbedo = configureArrayTex(
        new THREE.DataArrayTexture(albBuf, targetSize, targetSize, depth),
        THREE.SRGBColorSpace,
        engine.quality.maxAnisotropy || 4,
      );
      const prevAlbedo = albedoArray;
      albedoArray = nextAlbedo;
      upgradedSize = targetSize;
      notify();
      prevAlbedo.dispose();

      if (needNormals) {
        const nrmBuf = new Uint8Array(targetSize * targetSize * depth * 4);
        for (let i = 0; i < depth; i++) {
          if (disposed) return;
          const pixels = await fetchLayerPixels(
            `${base}assets/terrain/${LAYERS[i]}_nrm_rough.webp`,
            targetSize,
          );
          nrmBuf.set(pixels, i * layerStride);
        }
        if (disposed) return;
        const nextNrm = configureArrayTex(
          new THREE.DataArrayTexture(nrmBuf, targetSize, targetSize, depth),
          THREE.NoColorSpace,
          engine.quality.maxAnisotropy || 4,
        );
        const prevNrm = nrmRoughArray;
        nrmRoughArray = nextNrm;
        notify();
        prevNrm.dispose();
      }
    } catch (err) {
      console.warn('[terrain] detail texture upgrade skipped, keeping procedural fallback:', err);
    }
  }

  function setAnisotropy(aniso) {
    albedoArray.anisotropy = aniso;
    albedoArray.needsUpdate = true;
    nrmRoughArray.anisotropy = aniso;
    nrmRoughArray.needsUpdate = true;
  }

  function dispose() {
    disposed = true;
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
