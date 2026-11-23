import * as THREE from 'three';
import { mulberry32 } from './noise.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function finalizeTexture(canvas, { srgb = true, repeat = false, anisotropy = 4, linearFilter = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  } else {
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }
  tex.anisotropy = anisotropy;
  tex.magFilter = linearFilter ? THREE.LinearFilter : THREE.NearestFilter;
  tex.minFilter = linearFilter ? THREE.LinearMipmapLinearFilter : THREE.NearestMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Draw a realistic conifer (Engelmann spruce / subalpine fir) silhouette into a quadrant.
 */
function drawConiferImpostor(ctx, ox, oy, size, rng, isFir) {
  ctx.save();
  ctx.translate(ox, oy);

  // Trunk
  ctx.fillStyle = '#3a2a20';
  ctx.fillRect(size * 0.48, size * 0.25, size * 0.04, size * 0.73);

  const tiers = isFir ? 18 : 16;
  const maxWidth = isFir ? size * 0.28 : size * 0.36;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1); // 0 = top, 1 = bottom
    const y = size * (0.06 + t * 0.80);
    const w = maxWidth * Math.pow(t, 0.78) + size * 0.025;
    const h = size * (0.07 + 0.04 * t);

    // Sub-branches on this tier
    const branches = 5 + Math.floor(t * 7);
    for (let b = 0; b < branches; b++) {
      const bx = (b / (branches - 1) - 0.5) * 2 * w;
      const droop = Math.abs(bx) * (isFir ? 0.16 : 0.28) + (rng() - 0.5) * 4;
      const bw = (size * 0.055 + t * size * 0.04) * (0.7 + rng() * 0.5);
      const bh = h * (0.65 + rng() * 0.45);

      const shade = 0.72 + 0.36 * (1 - Math.abs(bx) / (w + 1)) * (1 - t * 0.20) + (rng() - 0.5) * 0.16;
      const r = Math.round((isFir ? 34 : 38) * shade);
      const g = Math.round((isFir ? 82 : 90) * shade);
      const bl = Math.round((isFir ? 44 : 48) * shade);

      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.beginPath();
      ctx.moveTo(size * 0.5 + bx, y + droop - bh * 0.5);
      ctx.lineTo(size * 0.5 + bx - bw * 0.55, y + droop + bh * 0.5);
      ctx.lineTo(size * 0.5 + bx + bw * 0.55, y + droop + bh * 0.5);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * Draw a Quaking Aspen impostor (white bark + golden-green fluttering canopy).
 */
function drawAspenImpostor(ctx, ox, oy, size, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  // Slender white trunk + 2 forks
  ctx.strokeStyle = '#d9d6cc';
  ctx.lineWidth = size * 0.032;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.98);
  ctx.quadraticCurveTo(size * 0.48, size * 0.62, size * 0.51, size * 0.22);
  ctx.stroke();

  // Dark aspen bark knots
  ctx.fillStyle = '#33302b';
  for (let k = 0; k < 10; k++) {
    const ky = size * (0.42 + rng() * 0.52);
    ctx.fillRect(size * 0.485, ky, size * 0.03, 2);
  }

  // Secondary upper branches
  ctx.lineWidth = size * 0.014;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.52);
  ctx.lineTo(size * 0.34, size * 0.33);
  ctx.moveTo(size * 0.5, size * 0.45);
  ctx.lineTo(size * 0.66, size * 0.28);
  ctx.stroke();

  // Leaf clusters (warm green + gold San Juan aspen palette)
  const blobs = 65;
  for (let i = 0; i < blobs; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.pow(rng(), 0.6) * size * 0.25;
    const cx = size * 0.5 + Math.cos(ang) * rad * 0.85;
    const cy = size * 0.34 + Math.sin(ang) * rad * 1.15;
    const lr = size * (0.04 + rng() * 0.055);
    const goldMix = rng();
    const r = Math.round(92 + goldMix * 115);
    const g = Math.round(135 + goldMix * 62);
    const b = Math.round(42 + (1 - goldMix) * 28);
    ctx.fillStyle = `rgba(${r},${g},${b},0.92)`;
    ctx.beginPath();
    ctx.arc(cx, cy, lr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw Krummholz / Riparian Willow shrub impostor.
 */
function drawKrummholzImpostor(ctx, ox, oy, size, rng) {
  ctx.save();
  ctx.translate(ox, oy);
  const clumps = 36;
  for (let i = 0; i < clumps; i++) {
    const t = rng();
    const cx = size * (0.16 + t * 0.68);
    const cy = size * (0.50 + (1 - Math.sin(t * Math.PI)) * 0.22 + (rng() - 0.5) * 0.16);
    const rad = size * (0.07 + rng() * 0.09);
    const shade = 0.65 + rng() * 0.45;
    ctx.fillStyle = `rgb(${Math.round(44 * shade)},${Math.round(78 * shade)},${Math.round(40 * shade)})`;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function createTreeImpostorAtlas(anisotropy) {
  const size = 512;
  const half = 256;
  const canvas = makeCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(4217);

  drawConiferImpostor(ctx, 0, 0, half, rng, false);      // Q0: Engelmann Spruce
  drawConiferImpostor(ctx, half, 0, half, rng, true);    // Q1: Subalpine Fir
  drawAspenImpostor(ctx, 0, half, half, rng);            // Q2: Quaking Aspen
  drawKrummholzImpostor(ctx, half, half, half, rng);     // Q3: Krummholz / Willow

  return finalizeTexture(canvas, { srgb: true, anisotropy });
}

function createAspenBarkTexture(anisotropy) {
  const c = makeCanvas(128, 256);
  const ctx = c.getContext('2d');
  const rng = mulberry32(8831);
  ctx.fillStyle = '#ddd9ce';
  ctx.fillRect(0, 0, 128, 256);

  for (let i = 0; i < 60; i++) {
    const y = rng() * 256;
    const h = 1 + rng() * 3;
    ctx.fillStyle = `rgba(180,175,165,${0.25 + rng() * 0.3})`;
    ctx.fillRect(0, y, 128, h);
  }
  // Characteristic black eye-scars
  for (let i = 0; i < 24; i++) {
    const x = rng() * 110;
    const y = rng() * 250;
    const w = 10 + rng() * 26;
    ctx.fillStyle = '#2b2824';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.5, 2.2 + rng() * 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  return finalizeTexture(c, { srgb: true, repeat: true, anisotropy });
}

function createConiferBarkTexture(anisotropy) {
  const c = makeCanvas(128, 256);
  const ctx = c.getContext('2d');
  const rng = mulberry32(9912);
  ctx.fillStyle = '#433228';
  ctx.fillRect(0, 0, 128, 256);

  for (let i = 0; i < 160; i++) {
    const x = rng() * 128;
    const y = rng() * 256;
    const w = 4 + rng() * 10;
    const h = 18 + rng() * 44;
    const v = rng();
    ctx.fillStyle = v > 0.5 ? 'rgba(88,66,52,0.45)' : 'rgba(28,19,14,0.5)';
    ctx.fillRect(x, y, w, h);
  }
  return finalizeTexture(c, { srgb: true, repeat: true, anisotropy });
}

function createGrassFlowerAtlas(anisotropy) {
  const size = 256;
  const half = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(7103);

  // Q0 (0,0): Alpine tussock grass
  for (let i = 0; i < 18; i++) {
    const bx = half * (0.2 + rng() * 0.6);
    const lean = (bx - half * 0.5) * 0.9 + (rng() - 0.5) * 18;
    const topY = half * (0.1 + rng() * 0.35);
    const g = 105 + Math.round(rng() * 55);
    ctx.strokeStyle = `rgb(${55 + Math.round(rng() * 35)},${g},${36})`;
    ctx.lineWidth = 3 + rng() * 2.5;
    ctx.beginPath();
    ctx.moveTo(bx, half);
    ctx.quadraticCurveTo(bx + lean * 0.4, half * 0.55, bx + lean, topY);
    ctx.stroke();
  }

  // Q1 (half, 0): Golden alpine sedge
  for (let i = 0; i < 16; i++) {
    const bx = half + half * (0.2 + rng() * 0.6);
    const lean = (bx - (half + half * 0.5)) * 0.8 + (rng() - 0.5) * 20;
    const topY = half * (0.12 + rng() * 0.35);
    ctx.strokeStyle = `rgb(${115 + Math.round(rng() * 45)},${125 + Math.round(rng() * 40)},${45})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(bx, half);
    ctx.quadraticCurveTo(bx + lean * 0.4, half * 0.55, bx + lean, topY);
    ctx.stroke();
  }

  // Q2 (0, half): Colorado Blue Columbine!
  for (let i = 0; i < 9; i++) {
    const bx = half * (0.22 + rng() * 0.56);
    const tx = bx + (rng() - 0.5) * 28;
    const ty = half + half * (0.18 + rng() * 0.32);
    ctx.strokeStyle = '#3d6e35';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(bx, size);
    ctx.quadraticCurveTo((bx + tx) * 0.5, half + half * 0.65, tx, ty);
    ctx.stroke();

    // 5 blue-violet outer sepals + white inner cup + yellow center
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      ctx.fillStyle = '#5b7be0';
      ctx.beginPath();
      ctx.ellipse(tx + Math.cos(a) * 8, ty + Math.sin(a) * 8, 6, 3.5, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f5f6ff';
    ctx.beginPath();
    ctx.arc(tx, ty, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2c94c';
    ctx.beginPath();
    ctx.arc(tx, ty, 2.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Q3 (half, half): Indian Paintbrush (scarlet/coral alpine wildflower)
  for (let i = 0; i < 9; i++) {
    const bx = half + half * (0.22 + rng() * 0.56);
    const tx = bx + (rng() - 0.5) * 24;
    const ty = half + half * (0.20 + rng() * 0.32);
    ctx.strokeStyle = '#476b37';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(bx, size);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = '#e04f33';
    ctx.beginPath();
    ctx.ellipse(tx, ty - 4, 6, 10, (rng() - 0.5) * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff7b47';
    ctx.beginPath();
    ctx.arc(tx, ty - 8, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  return finalizeTexture(c, { srgb: true, anisotropy });
}

/**
 * Tileable 4x2 building facade & roof atlas:
 * Row 0: Victorian brick, Ochre clapboard, Sage clapboard, Mountain Village timber/stone
 * Row 1: Slate Victorian, Rusted mine iron, Cedar roof shingles, Standing-seam metal roof
 */
function createBuildingAtlas(anisotropy) {
  const c = makeCanvas(512, 256);
  const ctx = c.getContext('2d');
  const rng = mulberry32(31415);

  const cellW = 128;
  const cellH = 128;

  const styles = [
    { bg: '#8a3d2f', kind: 'brick' },
    { bg: '#c99b4e', kind: 'clapboard' },
    { bg: '#6e826e', kind: 'clapboard' },
    { bg: '#6e6257', kind: 'stone' },
    { bg: '#5a6d82', kind: 'clapboard' },
    { bg: '#734d39', kind: 'corrugated' },
    { bg: '#4f463f', kind: 'shingle' },
    { bg: '#38464f', kind: 'seam' },
  ];

  styles.forEach((st, idx) => {
    const col = idx % 4;
    const row = Math.floor(idx / 4);
    const ox = col * cellW;
    const oy = row * cellH;
    ctx.fillStyle = st.bg;
    ctx.fillRect(ox, oy, cellW, cellH);

    if (st.kind === 'clapboard') {
      for (let y = 0; y < cellH; y += 8) {
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(ox, oy + y, cellW, 2);
      }
    } else if (st.kind === 'brick') {
      for (let y = 0; y < cellH; y += 8) {
        ctx.fillStyle = 'rgba(210,195,180,0.22)';
        ctx.fillRect(ox, oy + y, cellW, 1.5);
        const shift = ((y / 8) % 2) * 8;
        for (let x = shift; x < cellW; x += 16) {
          ctx.fillRect(ox + x, oy + y, 1.5, 8);
        }
      }
    } else if (st.kind === 'stone') {
      for (let i = 0; i < 45; i++) {
        const sx = ox + rng() * (cellW - 18);
        const sy = oy + rng() * (cellH - 12);
        const shade = 75 + Math.round(rng() * 65);
        ctx.fillStyle = `rgb(${shade},${shade - 6},${shade - 12})`;
        ctx.fillRect(sx, sy, 14 + rng() * 14, 8 + rng() * 8);
      }
    } else if (st.kind === 'corrugated') {
      for (let x = 0; x < cellW; x += 6) {
        ctx.fillStyle = x % 12 === 0 ? 'rgba(0,0,0,0.28)' : 'rgba(220,140,80,0.14)';
        ctx.fillRect(ox + x, oy, 3, cellH);
      }
    } else if (st.kind === 'shingle') {
      for (let y = 0; y < cellH; y += 10) {
        ctx.fillStyle = 'rgba(0,0,0,0.24)';
        ctx.fillRect(ox, oy + y, cellW, 2);
      }
    } else if (st.kind === 'seam') {
      for (let x = 0; x < cellW; x += 16) {
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(ox + x, oy, 2, cellH);
      }
    }

    // Add Victorian sash windows on wall tiles (0..4)
    if (idx < 5) {
      const cols = 3;
      const rows = 2;
      for (let r = 0; r < rows; r++) {
        for (let cc = 0; cc < cols; cc++) {
          const wx = ox + 14 + cc * 38;
          const wy = oy + 16 + r * 54;
          // Trim
          ctx.fillStyle = '#ece6d8';
          ctx.fillRect(wx - 3, wy - 4, 24, 34);
          // Glass
          ctx.fillStyle = '#253545';
          ctx.fillRect(wx, wy, 18, 26);
          // Mullion
          ctx.fillStyle = '#ece6d8';
          ctx.fillRect(wx + 8, wy, 2, 26);
          ctx.fillRect(wx, wy + 12, 18, 2);
        }
      }
    }
  });

  return finalizeTexture(c, { srgb: true, repeat: false, anisotropy });
}

/**
 * Tileable normal map for animated water ripples (analytical multi-wave).
 */
function createWaterNormalTexture(anisotropy) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;

  const waves = [
    { fx: 2, fy: 3, amp: 0.45 },
    { fx: -4, fy: 2, amp: 0.30 },
    { fx: 5, fy: -5, amp: 0.22 },
    { fx: -7, fy: -3, amp: 0.16 },
    { fx: 9, fy: 7, amp: 0.10 },
  ];

  const TWO_PI = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let dhdu = 0;
      let dhdv = 0;
      for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        const phase = TWO_PI * (w.fx * u + w.fy * v + i * 0.37);
        const cval = Math.cos(phase);
        dhdu += w.amp * w.fx * cval * 0.14;
        dhdv += w.amp * w.fy * cval * 0.14;
      }
      const nx = -dhdu;
      const ny = -dhdv;
      const nz = 1.0;
      const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      const p = (y * size + x) * 4;
      data[p] = Math.round((nx * invLen * 0.5 + 0.5) * 255);
      data[p + 1] = Math.round((ny * invLen * 0.5 + 0.5) * 255);
      data[p + 2] = Math.round((nz * invLen * 0.5 + 0.5) * 255);
      data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finalizeTexture(c, { srgb: false, repeat: true, anisotropy });
}

function createMistTexture(anisotropy) {
  const size = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.65)');
  grad.addColorStop(0.45, 'rgba(245,250,255,0.28)');
  grad.addColorStop(1, 'rgba(240,248,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return finalizeTexture(c, { srgb: true, anisotropy });
}

/**
 * Create and cache the shared procedural world texture set.
 * @param {number} [anisotropy=4]
 */
export function createWorldTextures(anisotropy = 4) {
  const textures = {
    treeImpostor: createTreeImpostorAtlas(anisotropy),
    aspenBark: createAspenBarkTexture(anisotropy),
    coniferBark: createConiferBarkTexture(anisotropy),
    grassFlower: createGrassFlowerAtlas(anisotropy),
    buildingAtlas: createBuildingAtlas(anisotropy),
    waterNormal: createWaterNormalTexture(anisotropy),
    mist: createMistTexture(anisotropy),
  };

  return {
    ...textures,
    setAnisotropy(val) {
      for (const tex of Object.values(textures)) {
        tex.anisotropy = val;
        tex.needsUpdate = true;
      }
    },
    dispose() {
      for (const tex of Object.values(textures)) {
        tex.dispose();
      }
    },
  };
}
