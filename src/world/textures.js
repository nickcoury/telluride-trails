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
  ctx.fillStyle = '#4d382b';
  ctx.fillRect(size * 0.48, size * 0.25, size * 0.04, size * 0.73);

  const tiers = isFir ? 19 : 17;
  const maxWidth = isFir ? size * 0.25 : size * 0.32;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = size * (0.06 + t * 0.81);
    const w = maxWidth * Math.pow(t, 0.78) + size * 0.025;
    const h = size * (0.07 + 0.04 * t);

    const branches = 5 + Math.floor(t * 7);
    for (let b = 0; b < branches; b++) {
      const bx = (b / (branches - 1) - 0.5) * 2 * w;
      const droop = Math.abs(bx) * (isFir ? 0.16 : 0.28) + (rng() - 0.5) * 4;
      const bw = (size * 0.055 + t * size * 0.04) * (0.75 + rng() * 0.45);
      const bh = h * (0.68 + rng() * 0.42);

      const shade = 0.78 + 0.34 * (1 - Math.abs(bx) / (w + 1)) * (1 - t * 0.18) + (rng() - 0.5) * 0.14;
      const r = Math.min(255, Math.round((isFir ? 46 : 52) * shade));
      const g = Math.min(255, Math.round((isFir ? 104 : 114) * shade));
      const bl = Math.min(255, Math.round((isFir ? 56 : 62) * shade));

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

  ctx.strokeStyle = '#dfdcd2';
  ctx.lineWidth = size * 0.030;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.98);
  ctx.quadraticCurveTo(size * 0.48, size * 0.62, size * 0.51, size * 0.22);
  ctx.stroke();

  ctx.fillStyle = '#33302b';
  for (let k = 0; k < 10; k++) {
    const ky = size * (0.42 + rng() * 0.52);
    ctx.fillRect(size * 0.485, ky, size * 0.03, 2);
  }

  ctx.lineWidth = size * 0.014;
  ctx.beginPath();
  ctx.moveTo(size * 0.5, size * 0.52);
  ctx.lineTo(size * 0.34, size * 0.33);
  ctx.moveTo(size * 0.5, size * 0.45);
  ctx.lineTo(size * 0.66, size * 0.28);
  ctx.stroke();

  const blobs = 72;
  for (let i = 0; i < blobs; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = Math.pow(rng(), 0.6) * size * 0.25;
    const cx = size * 0.5 + Math.cos(ang) * rad * 0.85;
    const cy = size * 0.34 + Math.sin(ang) * rad * 1.15;
    const lr = size * (0.04 + rng() * 0.052);
    const goldMix = rng();
    const r = Math.round(104 + goldMix * 105);
    const g = Math.round(148 + goldMix * 55);
    const b = Math.round(52 + (1 - goldMix) * 28);
    ctx.fillStyle = `rgba(${r},${g},${b},0.94)`;
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
  const clumps = 38;
  for (let i = 0; i < clumps; i++) {
    const t = rng();
    const cx = size * (0.16 + t * 0.68);
    const cy = size * (0.50 + (1 - Math.sin(t * Math.PI)) * 0.22 + (rng() - 0.5) * 0.16);
    const rad = size * (0.07 + rng() * 0.09);
    const shade = 0.78 + rng() * 0.38;
    ctx.fillStyle = `rgb(${Math.round(58 * shade)},${Math.round(106 * shade)},${Math.round(52 * shade)})`;
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

function createGrassFlowerAtlas(anisotropy) {
  const size = 256;
  const half = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(7103);

  // Q0 (0,0): Sunlit alpine tussock grass
  for (let i = 0; i < 20; i++) {
    const bx = half * (0.18 + rng() * 0.64);
    const lean = (bx - half * 0.5) * 0.85 + (rng() - 0.5) * 16;
    const topY = half * (0.10 + rng() * 0.32);
    const g = 148 + Math.round(rng() * 45);
    ctx.strokeStyle = `rgb(${86 + Math.round(rng() * 38)},${g},${52 + Math.round(rng() * 16)})`;
    ctx.lineWidth = 3.2 + rng() * 2.2;
    ctx.beginPath();
    ctx.moveTo(bx, half);
    ctx.quadraticCurveTo(bx + lean * 0.4, half * 0.55, bx + lean, topY);
    ctx.stroke();
  }

  // Q1 (half, 0): Golden alpine sedge
  for (let i = 0; i < 18; i++) {
    const bx = half + half * (0.18 + rng() * 0.64);
    const lean = (bx - (half + half * 0.5)) * 0.8 + (rng() - 0.5) * 18;
    const topY = half * (0.12 + rng() * 0.32);
    ctx.strokeStyle = `rgb(${146 + Math.round(rng() * 44)},${162 + Math.round(rng() * 36)},${66})`;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(bx, half);
    ctx.quadraticCurveTo(bx + lean * 0.4, half * 0.55, bx + lean, topY);
    ctx.stroke();
  }

  // Q2 (0, half): Colorado Blue Columbine!
  for (let i = 0; i < 10; i++) {
    const bx = half * (0.20 + rng() * 0.60);
    const tx = bx + (rng() - 0.5) * 26;
    const ty = half + half * (0.20 + rng() * 0.30);
    ctx.strokeStyle = '#629c52';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(bx, size);
    ctx.quadraticCurveTo((bx + tx) * 0.5, half + half * 0.65, tx, ty);
    ctx.stroke();

    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2;
      ctx.fillStyle = '#6c8cf0';
      ctx.beginPath();
      ctx.ellipse(tx + Math.cos(a) * 8, ty + Math.sin(a) * 8, 6, 3.5, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f8f9ff';
    ctx.beginPath();
    ctx.arc(tx, ty, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f5d156';
    ctx.beginPath();
    ctx.arc(tx, ty, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Q3 (half, half): Indian Paintbrush
  for (let i = 0; i < 10; i++) {
    const bx = half + half * (0.20 + rng() * 0.60);
    const tx = bx + (rng() - 0.5) * 22;
    const ty = half + half * (0.22 + rng() * 0.30);
    ctx.strokeStyle = '#669952';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(bx, size);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = '#eb593b';
    ctx.beginPath();
    ctx.ellipse(tx, ty - 4, 6, 10, (rng() - 0.5) * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff8654';
    ctx.beginPath();
    ctx.arc(tx, ty - 8, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  return finalizeTexture(c, { srgb: true, anisotropy });
}

/**
 * 4x2 Historic Telluride / Ouray / Silverton / Mountain Village facade & roof atlas.
 * Row 0: Victorian brick, Ochre clapboard, Sage clapboard, Mountain Village stone/timber
 * Row 1: Slate Victorian, Rusted mine iron/plinth stone, Cedar roof shingles, Standing-seam roof
 */
function createBuildingAtlas(anisotropy) {
  const c = makeCanvas(512, 256);
  const ctx = c.getContext('2d');
  const rng = mulberry32(31415);

  const cellW = 128;
  const cellH = 128;

  const styles = [
    { bg: '#8c4335', trim: '#b8a894', kind: 'brick' },
    { bg: '#bd924f', trim: '#cfc3ae', kind: 'clapboard' },
    { bg: '#687d6b', trim: '#c7c1b2', kind: 'clapboard' },
    { bg: '#6b5f54', trim: '#8a7a68', kind: 'stone' },
    { bg: '#56687c', trim: '#c5bfb2', kind: 'clapboard' },
    { bg: '#575049', trim: '#47413b', kind: 'plinth' },
    { bg: '#4e453e', trim: '#3d352f', kind: 'shingle' },
    { bg: '#3b4852', trim: '#2d3840', kind: 'seam' },
  ];

  styles.forEach((st, idx) => {
    const col = idx % 4;
    const row = Math.floor(idx / 4);
    const ox = col * cellW;
    const oy = row * cellH;
    ctx.fillStyle = st.bg;
    ctx.fillRect(ox, oy, cellW, cellH);

    if (st.kind === 'clapboard') {
      for (let y = 0; y < cellH; y += 5) {
        ctx.fillStyle = 'rgba(0,0,0,0.13)';
        ctx.fillRect(ox, oy + y, cellW, 1.2);
      }
    } else if (st.kind === 'brick') {
      for (let y = 0; y < cellH; y += 6) {
        ctx.fillStyle = 'rgba(210,192,175,0.18)';
        ctx.fillRect(ox, oy + y, cellW, 1);
        const shift = ((y / 6) % 2) * 7;
        for (let x = shift; x < cellW; x += 14) {
          ctx.fillRect(ox + x, oy + y, 1, 6);
        }
      }
    } else if (st.kind === 'stone' || st.kind === 'plinth') {
      for (let i = 0; i < 65; i++) {
        const sx = ox + rng() * (cellW - 14);
        const sy = oy + rng() * (cellH - 10);
        const shade = 72 + Math.round(rng() * 52);
        ctx.fillStyle = `rgb(${shade},${shade - 5},${shade - 10})`;
        ctx.fillRect(sx, sy, 10 + rng() * 12, 6 + rng() * 7);
      }
    } else if (st.kind === 'shingle') {
      for (let y = 0; y < cellH; y += 8) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(ox, oy + y, cellW, 1.5);
      }
    } else if (st.kind === 'seam') {
      for (let x = 0; x < cellW; x += 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(ox + x, oy, 1.5, cellH);
      }
    }

    // Proportional Victorian facade details on wall tiles (0..4):
    // Cornice top band + 2 neat upper rows of 4 slender sash windows + wainscot ground storefront
    if (idx < 5) {
      // Top cornice molding
      ctx.fillStyle = st.trim;
      ctx.fillRect(ox, oy + 2, cellW, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(ox, oy + 7, cellW, 2);

      // Stone/wood base wainscot at bottom 16px
      ctx.fillStyle = 'rgba(42,36,32,0.42)';
      ctx.fillRect(ox, oy + cellH - 16, cellW, 16);
      ctx.fillStyle = st.trim;
      ctx.fillRect(ox, oy + cellH - 17, cellW, 2);

      const cols = 4;
      const rows = 2;
      for (let r = 0; r < rows; r++) {
        for (let cc = 0; cc < cols; cc++) {
          const wx = ox + 10 + cc * 30;
          const wy = oy + 18 + r * 44;
          const ww = 13;
          const wh = 24;

          // Subtle muted sash frame + lintel
          ctx.fillStyle = st.trim;
          ctx.fillRect(wx - 2, wy - 3, ww + 4, 3);
          ctx.fillRect(wx - 1.5, wy, ww + 3, wh + 2);

          // Dark window glass with faint warm interior/sky tint
          ctx.fillStyle = '#212f3d';
          ctx.fillRect(wx, wy, ww, wh);
          ctx.fillStyle = 'rgba(135,165,190,0.18)';
          ctx.fillRect(wx + 1, wy + 1, ww - 2, wh * 0.42);

          // Delicate center mullion
          ctx.fillStyle = st.trim;
          ctx.fillRect(wx, wy + 11, ww, 1.5);
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
  let currentAniso = anisotropy;
  const textures = {
    treeImpostor: createTreeImpostorAtlas(anisotropy),
    grassFlower: createGrassFlowerAtlas(anisotropy),
    buildingAtlas: createBuildingAtlas(anisotropy),
    waterNormal: createWaterNormalTexture(anisotropy),
    mist: createMistTexture(anisotropy),
  };

  return {
    ...textures,
    setAnisotropy(val) {
      if (val === currentAniso) return;
      currentAniso = val;
      for (const tex of Object.values(textures)) {
        tex.anisotropy = val;
        tex.needsUpdate = true;
      }
    },
    refresh() {
      for (const tex of Object.values(textures)) {
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
