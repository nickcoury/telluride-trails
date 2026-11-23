import * as THREE from 'three';
import { mulberry32 } from '../noise.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Dilate opaque pixel RGB into transparent neighbors (keeping alpha = 0) and return a
 * WebGL2 DataTexture directly so HTML5 Canvas2D premultiplied putImageData NEVER wipes RGB
 * on alpha=0 texels (zero dark/black mipmap fringes on foliage and wildflowers!).
 */
function dilateToDataTexture(canvas, { passes = 3, srgb = true, anisotropy = 4 } = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const src = new Uint8Array(img.data.buffer.slice(0));
  const tmp = new Uint8Array(src);

  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (src[i * 4 + 3] > 20) filled[i] = 1;
  }

  for (let p = 0; p < passes; p++) {
    const nextFilled = new Uint8Array(filled);
    for (let y = 0; y < h; y++) {
      const yRow = y * w;
      for (let x = 0; x < w; x++) {
        const idx = yRow + x;
        if (filled[idx]) continue;

        let r = 0, g = 0, b = 0, count = 0;
        if (x > 0 && filled[idx - 1]) {
          const o = (idx - 1) * 4; r += src[o]; g += src[o + 1]; b += src[o + 2]; count++;
        }
        if (x + 1 < w && filled[idx + 1]) {
          const o = (idx + 1) * 4; r += src[o]; g += src[o + 1]; b += src[o + 2]; count++;
        }
        if (y > 0 && filled[idx - w]) {
          const o = (idx - w) * 4; r += src[o]; g += src[o + 1]; b += src[o + 2]; count++;
        }
        if (y + 1 < h && filled[idx + w]) {
          const o = (idx + w) * 4; r += src[o]; g += src[o + 1]; b += src[o + 2]; count++;
        }
        if (count > 0) {
          const o = idx * 4;
          tmp[o] = (r / count) | 0;
          tmp[o + 1] = (g / count) | 0;
          tmp[o + 2] = (b / count) | 0;
          nextFilled[idx] = 1;
        }
      }
    }
    src.set(tmp);
    filled.set(nextFilled);
  }

  const tex = new THREE.DataTexture(src, w, h, THREE.RGBAFormat);
  tex.flipY = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function canvasToDataTexture(canvas, { srgb = true, repeat = false, anisotropy = 4 } = {}) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const data = new Uint8Array(img.data.buffer.slice(0));
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.flipY = true;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = anisotropy;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================================
// 1. TREE FOLIAGE ATLAS (1024x1024, 2x2 quadrants of 512x512)
//    Q0 (top-left):     Engelmann Spruce bough spray (radiating needle sprigs)
//    Q1 (top-right):    Subalpine Fir fan spray (cooler blue-green flat needles)
//    Q2 (bottom-left):  Quaking Aspen leaf cluster (heart-shaped sunlit leaves)
//    Q3 (bottom-right): Riparian Willow arching lance-leaf sprays
// ============================================================================

function drawSpruceOrFirBranch(ctx, ox, oy, size, rng, isFir) {
  ctx.save();
  ctx.translate(ox, oy);

  // Branch attaches at bottom-center (0.5, 0.94) and fans outward/upward to (0.5, 0.06)
  const cx = size * 0.5;
  const baseY = size * 0.95;

  // Helper to paint a single needle-covered shoot along a quadratic curve
  function drawNeedleShoot(x0, y0, x1, y1, width, needleLen, density, isTip) {
    // Woody reddish-brown inner twig
    ctx.strokeStyle = isFir ? '#4d3a2c' : '#573b28';
    ctx.lineWidth = Math.max(1.8, width * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 2) return;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const steps = Math.max(12, Math.floor(len * density));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const sx = x0 + dx * t;
      const sy = y0 + dy * t;
      const taper = (1 - t * 0.35) * (0.65 + 0.35 * Math.sin(t * Math.PI));

      for (let side = -1; side <= 1; side += 2) {
        const angleSpread = isFir ? 0.58 : 0.72;
        const jitter = (rng() - 0.5) * 0.32;
        const nLen = needleLen * taper * (0.72 + rng() * 0.52);
        const dirX = ux * (0.48 + jitter) + px * side * angleSpread;
        const dirY = uy * (0.48 + jitter) + py * side * angleSpread;
        const dL = Math.hypot(dirX, dirY) || 1;
        const ex = sx + (dirX / dL) * nLen;
        const ey = sy + (dirY / dL) * nLen;

        // July new-growth sunlit tips vs rich velvety San Juan spruce/fir interior needles
        const tipGlow = isTip && t > 0.58 ? (t - 0.58) * 2.4 : 0;
        const depth = 0.68 + 0.44 * t + (rng() - 0.5) * 0.22;
        let r, g, b;
        if (isFir) {
          // Subalpine fir: luminous cool blue-spruce emerald with silvery glints
          r = Math.round((46 + tipGlow * 36) * depth);
          g = Math.round((102 + tipGlow * 48) * depth);
          b = Math.round((72 + tipGlow * 24) * depth);
        } else {
          // Engelmann spruce: rich velvety Rocky Mountain forest emerald
          r = Math.round((50 + tipGlow * 42) * depth);
          g = Math.round((108 + tipGlow * 52) * depth);
          b = Math.round((54 + tipGlow * 18) * depth);
        }
        ctx.strokeStyle = `rgb(${Math.min(220, Math.max(12, r))},${Math.min(235, Math.max(24, g))},${Math.min(180, Math.max(14, b))})`;
        ctx.lineWidth = isFir ? 2.4 + rng() * 1.4 : 2.1 + rng() * 1.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    }
  }

  // Main central woody spine
  ctx.strokeStyle = '#473224';
  ctx.lineWidth = size * 0.022;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, size * 0.14);
  ctx.stroke();

  // Layered lateral sub-branches radiating outward from the bough spine (bottom to tip)
  const pairCount = isFir ? 9 : 8;
  for (let p = 0; p < pairCount; p++) {
    const t = p / (pairCount - 1);
    const sy = baseY - size * (0.08 + t * 0.72);
    const span = size * (0.41 * Math.pow(1 - t * 0.68, 0.85));
    const lift = size * (0.10 + t * 0.08);

    for (let side = -1; side <= 1; side += 2) {
      const ex = cx + side * span * (0.85 + rng() * 0.24);
      const ey = sy - lift * (0.7 + rng() * 0.5);
      // Secondary sub-twiglets off each lateral
      const mx = cx + (ex - cx) * 0.52;
      const my = sy + (ey - sy) * 0.52;
      drawNeedleShoot(
        mx, my,
        mx + side * span * 0.34, my - lift * 0.58,
        size * 0.04, size * 0.052, 0.42, true
      );
      drawNeedleShoot(
        mx, my,
        mx + side * span * 0.28, my + lift * 0.22,
        size * 0.036, size * 0.048, 0.38, false
      );
      drawNeedleShoot(cx, sy, ex, ey, size * 0.05, size * 0.058, 0.46, true);
    }
  }

  // Dense terminal leader shoot at tip
  drawNeedleShoot(cx, size * 0.38, cx, size * 0.05, size * 0.046, size * 0.052, 0.52, true);
  drawNeedleShoot(cx, size * 0.28, cx - size * 0.14, size * 0.11, size * 0.036, size * 0.044, 0.44, true);
  drawNeedleShoot(cx, size * 0.28, cx + size * 0.14, size * 0.11, size * 0.036, size * 0.044, 0.44, true);

  // Inner dense shadow-needles near spine for fullness without solid blobs
  drawNeedleShoot(cx, baseY - size * 0.04, cx, size * 0.25, size * 0.06, size * 0.062, 0.40, false);

  ctx.restore();
}

function drawAspenLeafCluster(ctx, ox, oy, size, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  // Delicate pale-grey/greenish aspen twigs radiating inside the cluster
  const twigs = [
    [0.50, 0.94, 0.50, 0.16],
    [0.50, 0.72, 0.22, 0.36],
    [0.50, 0.68, 0.78, 0.34],
    [0.50, 0.48, 0.28, 0.20],
    [0.50, 0.44, 0.72, 0.18],
    [0.50, 0.80, 0.26, 0.62],
    [0.50, 0.78, 0.74, 0.60],
  ];
  ctx.strokeStyle = '#9c9b88';
  ctx.lineCap = 'round';
  for (let i = 0; i < twigs.length; i++) {
    const [x0, y0, x1, y1] = twigs[i];
    ctx.lineWidth = i === 0 ? size * 0.011 : size * 0.007;
    ctx.beginPath();
    ctx.moveTo(x0 * size, y0 * size);
    ctx.quadraticCurveTo(
      ((x0 + x1) * 0.5 + (rng() - 0.5) * 0.06) * size,
      ((y0 + y1) * 0.5 + (rng() - 0.5) * 0.06) * size,
      x1 * size,
      y1 * size
    );
    ctx.stroke();
  }

  // Paint ~155 distinct rounded-heart Quaking Aspen leaves with sunlit July emerald/lime/silver shimmer
  const leafCount = 155;
  for (let i = 0; i < leafCount; i++) {
    // Cluster leaves organically around the twigs leaving airy sky gaps!
    const twig = twigs[Math.floor(rng() * twigs.length)];
    const t = 0.15 + rng() * 0.85;
    const baseX = (twig[0] + (twig[2] - twig[0]) * t) * size;
    const baseY = (twig[1] + (twig[3] - twig[1]) * t) * size;
    const spread = size * (0.04 + rng() * 0.12);
    const ang = rng() * Math.PI * 2;
    const lx = Math.max(size * 0.08, Math.min(size * 0.92, baseX + Math.cos(ang) * spread));
    const ly = Math.max(size * 0.07, Math.min(size * 0.91, baseY + Math.sin(ang) * spread));

    const r = size * (0.028 + rng() * 0.022);
    const rot = rng() * Math.PI * 2;

    // July Telluride aspen color: luminous fresh emerald-lime, silver-green undersides, subtle warm chartreuse
    const sunRoll = rng();
    let cr, cg, cb;
    if (sunRoll < 0.22) {
      // Pale silvery-sage flipped underside (characteristic aspen shimmer!)
      cr = 136 + Math.round(rng() * 24);
      cg = 166 + Math.round(rng() * 24);
      cb = 104 + Math.round(rng() * 20);
    } else if (sunRoll < 0.82) {
      // Vibrant sunlit July aspen green-chartreuse
      cr = 92 + Math.round(rng() * 44);
      cg = 142 + Math.round(rng() * 42);
      cb = 44 + Math.round(rng() * 26);
    } else {
      // Deep shaded interior leaf
      cr = 58 + Math.round(rng() * 26);
      cg = 104 + Math.round(rng() * 28);
      cb = 36 + Math.round(rng() * 16);
    }

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(rot);

    // Subtle petiole stem
    ctx.strokeStyle = 'rgba(130,136,92,0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, r * 0.95);
    ctx.lineTo(0, r * 1.45);
    ctx.stroke();

    // Heart / ovate pointed aspen leaf shape
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.beginPath();
    ctx.moveTo(0, -r * 1.15); // pointed tip
    ctx.bezierCurveTo(r * 0.95, -r * 0.45, r * 1.05, r * 0.72, 0, r * 0.92);
    ctx.bezierCurveTo(-r * 1.05, r * 0.72, -r * 0.95, -r * 0.45, 0, -r * 1.15);
    ctx.closePath();
    ctx.fill();

    // Delicate midrib highlight
    ctx.strokeStyle = `rgba(${Math.min(255, cr + 34)},${Math.min(255, cg + 34)},${Math.min(255, cb + 20)},0.45)`;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(0, r * 0.75);
    ctx.lineTo(0, -r * 0.85);
    ctx.stroke();

    ctx.restore();
  }

  ctx.restore();
}

function drawWillowSprays(ctx, ox, oy, size, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  // Arching reddish-olive willow whips radiating from bottom-center
  const stems = 11;
  for (let s = 0; s < stems; s++) {
    const frac = (s / (stems - 1) - 0.5) * 2; // -1..1
    const x0 = size * (0.5 + frac * 0.10);
    const y0 = size * 0.96;
    const x1 = size * (0.5 + frac * 0.44 + (rng() - 0.5) * 0.08);
    const y1 = size * (0.14 + Math.abs(frac) * 0.24 + rng() * 0.12);
    const cx = (x0 + x1) * 0.5 + frac * size * 0.05;
    const cy = Math.min(y0, y1) - size * 0.06;

    ctx.strokeStyle = '#6e4e35';
    ctx.lineWidth = size * 0.008;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();

    // Narrow lance-shaped willow leaves along each whip
    const leaves = 26;
    for (let i = 2; i < leaves; i++) {
      const t = i / leaves;
      const it = 1 - t;
      const lx = it * it * x0 + 2 * it * t * cx + t * t * x1;
      const ly = it * it * y0 + 2 * it * t * cy + t * t * y1;
      const tx = 2 * it * (cx - x0) + 2 * t * (x1 - cx);
      const ty = 2 * it * (cy - y0) + 2 * t * (y1 - cy);
      const baseAng = Math.atan2(ty, tx);

      for (let side = -1; side <= 1; side += 2) {
        if (rng() < 0.25) continue;
        const lAng = baseAng + side * (0.55 + rng() * 0.45);
        const lLen = size * (0.055 + rng() * 0.042) * (1 - t * 0.25);
        const lWid = lLen * 0.22;
        const silver = rng() < 0.35;
        const cr = silver ? 106 + Math.round(rng() * 24) : 68 + Math.round(rng() * 34);
        const cg = silver ? 136 + Math.round(rng() * 26) : 114 + Math.round(rng() * 38);
        const cb = silver ? 88 + Math.round(rng() * 20) : 54 + Math.round(rng() * 22);

        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(lAng);
        ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(lLen * 0.45, -lWid, lLen, 0);
        ctx.quadraticCurveTo(lLen * 0.45, lWid, 0, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  ctx.restore();
}

function createFoliageAtlas(anisotropy) {
  const size = 1024;
  const half = 512;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(8191);

  drawSpruceOrFirBranch(ctx, 0, 0, half, rng, false);    // Q0 top-left (UV v: 0.5..1.0)
  drawSpruceOrFirBranch(ctx, half, 0, half, rng, true);  // Q1 top-right
  drawAspenLeafCluster(ctx, 0, half, half, rng);         // Q2 bottom-left (UV v: 0.0..0.5)
  drawWillowSprays(ctx, half, half, half, rng);          // Q3 bottom-right

  return dilateToDataTexture(c, { passes: 4, srgb: true, anisotropy });
}

// ============================================================================
// 2. BARK ATLAS (512x512, 4 vertical strips of 128x512)
//    Col 0 [0.00..0.25]: Engelmann Spruce / Subalpine Fir scaly cinnamon-grey bark
//    Col 1 [0.25..0.50]: Quaking Aspen chalky white bark + black eye scars + dark furrowed base
//    Col 2 [0.50..0.75]: Weathered silver-grey deadfall / stump / krummholz wood + moss
//    Col 3 [0.75..1.00]: Riparian Willow reddish-olive multi-stem bark
// ============================================================================

function createBarkAtlas(anisotropy) {
  const w = 512;
  const h = 512;
  const colW = 128;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const rng = mulberry32(2309);

  // Col 0: Engelmann Spruce / Fir scaly bark
  ctx.fillStyle = '#473429';
  ctx.fillRect(0, 0, colW, h);
  for (let i = 0; i < 420; i++) {
    const sx = rng() * colW;
    const sy = rng() * h;
    const sw = 6 + rng() * 14;
    const sh = 14 + rng() * 34;
    const v = 0.65 + rng() * 0.65;
    const warm = rng() > 0.45 ? 1.12 : 0.92;
    ctx.fillStyle = `rgb(${Math.round(74 * v * warm)},${Math.round(52 * v)},${Math.round(41 * v)})`;
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = 'rgba(20,13,10,0.42)';
    ctx.fillRect(sx, sy, 2, sh);
  }

  // Col 1: Iconic Colorado Quaking Aspen chalky white bark + black scars + dark furrowed base!
  // Note: Canvas y=0 is UV v=1 (top of trunk), y=h is UV v=0 (ground base of trunk)
  const aspenX = colW;
  const aspenGrad = ctx.createLinearGradient(aspenX, 0, aspenX, h);
  aspenGrad.addColorStop(0.0, '#d8dfd0'); // greenish-cream upper canopy bark
  aspenGrad.addColorStop(0.35, '#e8e7df'); // iconic chalky white mid trunk
  aspenGrad.addColorStop(0.76, '#dddad0');
  aspenGrad.addColorStop(0.88, '#6a655c'); // dark furrowed base transition
  aspenGrad.addColorStop(1.0, '#36332e');  // elk-rubbed rough dark ground base
  ctx.fillStyle = aspenGrad;
  ctx.fillRect(aspenX, 0, colW, h);

  // Subtle vertical powdery mottling
  for (let i = 0; i < 160; i++) {
    const sx = aspenX + rng() * colW;
    const sy = rng() * (h * 0.85);
    ctx.fillStyle = rng() < 0.5 ? 'rgba(182,192,168,0.22)' : 'rgba(255,254,248,0.24)';
    ctx.fillRect(sx, sy, 4 + rng() * 12, 16 + rng() * 38);
  }

  // Characteristic black horizontal eye-shaped branch scars & lenticels
  for (let i = 0; i < 62; i++) {
    const sx = aspenX + 4 + rng() * (colW - 14);
    const sy = 14 + rng() * (h * 0.80);
    const sw = 8 + rng() * 20;
    const sh = 2.5 + rng() * 4.5;
    ctx.fillStyle = 'rgba(34,31,28,0.88)';
    ctx.beginPath();
    ctx.ellipse(sx, sy, sw * 0.5, sh * 0.5, (rng() - 0.5) * 0.15, 0, Math.PI * 2);
    ctx.fill();
    // Classic arched black eyebrow crack above larger knots
    if (sw > 16) {
      ctx.strokeStyle = 'rgba(28,25,22,0.82)';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(sx - sw * 0.72, sy + 2);
      ctx.quadraticCurveTo(sx, sy - sh * 1.1, sx + sw * 0.72, sy + 2);
      ctx.stroke();
    }
  }
  // Rough dark fissures at very bottom (v < 0.16)
  for (let i = 0; i < 95; i++) {
    const sx = aspenX + rng() * colW;
    const sy = h * 0.80 + rng() * (h * 0.20);
    ctx.fillStyle = 'rgba(24,22,19,0.65)';
    ctx.fillRect(sx, sy, 2 + rng() * 4, 14 + rng() * 30);
  }

  // Col 2: Weathered silver-grey alpine deadfall / krummholz wood + mossy pockets
  const deadX = colW * 2;
  ctx.fillStyle = '#7c766d';
  ctx.fillRect(deadX, 0, colW, h);
  for (let i = 0; i < 320; i++) {
    const sx = deadX + rng() * colW;
    const sy = rng() * h;
    const v = 0.68 + rng() * 0.52;
    ctx.fillStyle = `rgb(${Math.round(126 * v)},${Math.round(119 * v)},${Math.round(108 * v)})`;
    ctx.fillRect(sx, sy, 2 + rng() * 6, 22 + rng() * 55);
  }
  // Deep sun-checked grain cracks
  for (let i = 0; i < 70; i++) {
    const sx = deadX + rng() * colW;
    const sy = rng() * h;
    ctx.fillStyle = 'rgba(32,28,24,0.58)';
    ctx.fillRect(sx, sy, 1.8, 28 + rng() * 70);
  }
  // Subtle green forest moss speckles along deadfall
  for (let i = 0; i < 34; i++) {
    const sx = deadX + 6 + rng() * (colW - 12);
    const sy = rng() * h;
    ctx.fillStyle = `rgba(${58 + Math.round(rng() * 24)},${88 + Math.round(rng() * 32)},${42 + Math.round(rng() * 14)},0.65)`;
    ctx.beginPath();
    ctx.ellipse(sx, sy, 6 + rng() * 10, 10 + rng() * 18, rng(), 0, Math.PI * 2);
    ctx.fill();
  }

  // Col 3: Riparian willow reddish-olive woody bark
  const wilX = colW * 3;
  ctx.fillStyle = '#5c4632';
  ctx.fillRect(wilX, 0, colW, h);
  for (let i = 0; i < 240; i++) {
    const sx = wilX + rng() * colW;
    const sy = rng() * h;
    const v = 0.72 + rng() * 0.48;
    ctx.fillStyle = `rgb(${Math.round(104 * v)},${Math.round(74 * v)},${Math.round(48 * v)})`;
    ctx.fillRect(sx, sy, 2 + rng() * 5, 24 + rng() * 50);
  }

  return canvasToDataTexture(c, { srgb: true, repeat: true, anisotropy });
}

// ============================================================================
// 3. GROUND FLORA ATLAS (1024x1024, 4 cols x 2 rows = 8 tiles of 256x512)
//    Row 0 (UV v: 0.5..1.0):
//      0: Lush Mountain Meadow Grass / Fescue (dense multi-height arching carpet)
//      1: Alpine Sedge & Golden Bunchgrass
//      2: Colorado Blue Columbine (Aquilegia coerulea)
//      3: Scarlet Indian Paintbrush (Castilleja miniata)
//    Row 1 (UV v: 0.0..0.5):
//      4: Mountain Lupine (Lupinus argenteus — purple/indigo spires!)
//      5: Alpine Tundra Cushion + Golden Alpine Avens (high >11,500 ft!)
//      6: Subalpine Woodland Fern & Grouse Whortleberry (forest floor!)
//      7: Mountain Arnica / Sunlit Wildflower Meadow Mix
// ============================================================================

function drawMeadowGrassTile(ctx, ox, oy, tw, th, rng, golden) {
  ctx.save();
  ctx.translate(ox, oy);

  // Dense lush arching blades filling lower 75% so grass carpets the ground seamlessly
  const count = 48;
  for (let i = 0; i < count; i++) {
    const bx = tw * (0.08 + rng() * 0.84);
    const lean = (bx - tw * 0.5) * 0.95 + (rng() - 0.5) * tw * 0.34;
    const topY = th * (0.14 + rng() * 0.44);
    const w = 3.2 + rng() * 4.4;

    const shade = 0.68 + rng() * 0.42;
    let r, g, b;
    if (golden) {
      r = Math.round((122 + rng() * 42) * shade);
      g = Math.round((134 + rng() * 34) * shade);
      b = Math.round((56 + rng() * 20) * shade);
    } else {
      r = Math.round((68 + rng() * 36) * shade);
      g = Math.round((118 + rng() * 44) * shade);
      b = Math.round((44 + rng() * 18) * shade);
    }

    const grad = ctx.createLinearGradient(bx, th, bx + lean, topY);
    grad.addColorStop(0.0, `rgb(${Math.round(r * 0.55)},${Math.round(g * 0.60)},${Math.round(b * 0.52)})`);
    grad.addColorStop(0.55, `rgb(${r},${g},${b})`);
    grad.addColorStop(1.0, `rgb(${Math.min(225, Math.round(r * 1.25))},${Math.min(235, Math.round(g * 1.18))},${Math.min(140, Math.round(b * 1.1))})`);

    ctx.fillStyle = grad;
    const cx = bx + lean * 0.42;
    const cy = th * 0.58 + topY * 0.42;
    ctx.beginPath();
    ctx.moveTo(bx - w * 0.5, th);
    ctx.quadraticCurveTo(cx - w * 0.35, cy, bx + lean, topY);
    ctx.quadraticCurveTo(cx + w * 0.35, cy, bx + w * 0.5, th);
    ctx.closePath();
    ctx.fill();

    // Occasional feathery alpine fescue seed plume on tallest stems
    if (rng() < 0.24 && topY < th * 0.32) {
      ctx.fillStyle = golden ? 'rgba(206,192,126,0.9)' : 'rgba(182,176,118,0.85)';
      for (let k = 0; k < 5; k++) {
        ctx.beginPath();
        ctx.ellipse(
          bx + lean + (rng() - 0.5) * 10,
          topY + k * 6,
          2.6, 5.5, (rng() - 0.5) * 0.5, 0, Math.PI * 2
        );
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawColumbineTile(ctx, ox, oy, tw, th, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  // Lush basal grass + scalloped green columbine leaves at bottom
  drawMeadowGrassTile(ctx, 0, th * 0.28, tw, th * 0.72, rng, false);

  for (let i = 0; i < 16; i++) {
    const lx = tw * (0.14 + rng() * 0.72);
    const ly = th * (0.68 + rng() * 0.26);
    ctx.fillStyle = `rgb(${54 + Math.round(rng() * 24)},${102 + Math.round(rng() * 28)},${46 + Math.round(rng() * 16)})`;
    ctx.beginPath();
    ctx.arc(lx, ly, 10 + rng() * 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // 8 iconic Colorado Blue Columbine blossoms on slender arching stems
  for (let i = 0; i < 8; i++) {
    const bx = tw * (0.18 + (i / 7) * 0.64 + (rng() - 0.5) * 0.08);
    const tx = bx + (rng() - 0.5) * 44;
    const ty = th * (0.14 + rng() * 0.34);

    ctx.strokeStyle = '#538a45';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(bx, th);
    ctx.quadraticCurveTo((bx + tx) * 0.5, th * 0.62, tx, ty);
    ctx.stroke();

    const fScale = 1.0 + rng() * 0.38;
    // 5 lavender-blue outer sepals (star)
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * Math.PI * 2 + rng() * 0.2;
      ctx.fillStyle = '#6c8ef2';
      ctx.beginPath();
      ctx.ellipse(
        tx + Math.cos(a) * 14 * fScale,
        ty + Math.sin(a) * 14 * fScale,
        11 * fScale, 5.5 * fScale, a, 0, Math.PI * 2
      );
      ctx.fill();
    }
    // 5 crisp creamy-white inner cup petals
    for (let p = 0; p < 5; p++) {
      const a = ((p + 0.5) / 5) * Math.PI * 2;
      ctx.fillStyle = '#f5f7ff';
      ctx.beginPath();
      ctx.ellipse(
        tx + Math.cos(a) * 6.5 * fScale,
        ty + Math.sin(a) * 6.5 * fScale,
        6.5 * fScale, 4.5 * fScale, a, 0, Math.PI * 2
      );
      ctx.fill();
    }
    // Bright golden stamen center
    ctx.fillStyle = '#f4cf4a';
    ctx.beginPath();
    ctx.arc(tx, ty, 4.8 * fScale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPaintbrushTile(ctx, ox, oy, tw, th, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  drawMeadowGrassTile(ctx, 0, th * 0.30, tw, th * 0.70, rng, false);

  // 10 vivid crimson/scarlet Indian Paintbrush spikes
  for (let i = 0; i < 10; i++) {
    const bx = tw * (0.14 + (i / 9) * 0.72 + (rng() - 0.5) * 0.08);
    const tx = bx + (rng() - 0.5) * 34;
    const ty = th * (0.15 + rng() * 0.34);

    ctx.strokeStyle = '#5c8549';
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    ctx.moveTo(bx, th);
    ctx.quadraticCurveTo((bx + tx) * 0.5, th * 0.65, tx, ty + 18);
    ctx.stroke();

    // Narrow lance leaves on stem
    for (let l = 0; l < 4; l++) {
      const ly = ty + 35 + l * 26;
      const lx = bx + (tx - bx) * (1 - (ly - ty) / (th - ty));
      const side = l % 2 === 0 ? -1 : 1;
      ctx.strokeStyle = '#659050';
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + side * 14, ly - 14);
      ctx.stroke();
    }

    // Ragged flame-red & orange-scarlet flower bracts
    for (let b = 0; b < 11; b++) {
      const bt = b / 10;
      const brY = ty + 28 * (1 - bt);
      const brX = tx + (rng() - 0.5) * 14 * (1 - bt * 0.35);
      const col = bt > 0.6 ? '#ff5c33' : bt > 0.25 ? '#e43822' : '#bd2b24';
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(brX, brY, 4.5 + rng() * 4, 9 + rng() * 5, (rng() - 0.5) * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawLupineTile(ctx, ox, oy, tw, th, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  drawMeadowGrassTile(ctx, 0, th * 0.34, tw, th * 0.66, rng, false);

  // Palmate fan-shaped silvery-green lupine basal leaves
  for (let i = 0; i < 10; i++) {
    const lx = tw * (0.14 + rng() * 0.72);
    const ly = th * (0.66 + rng() * 0.24);
    for (let f = 0; f < 7; f++) {
      const a = (f / 7) * Math.PI * 2;
      ctx.strokeStyle = '#6b9463';
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + Math.cos(a) * 18, ly + Math.sin(a) * 14);
      ctx.stroke();
    }
  }

  // 7 tall indigo-violet Mountain Lupine flower spires
  for (let i = 0; i < 7; i++) {
    const bx = tw * (0.16 + (i / 6) * 0.68 + (rng() - 0.5) * 0.06);
    const tx = bx + (rng() - 0.5) * 26;
    const ty = th * (0.10 + rng() * 0.26);

    ctx.strokeStyle = '#5c8452';
    ctx.lineWidth = 4.0;
    ctx.beginPath();
    ctx.moveTo(bx, th);
    ctx.lineTo(tx, ty + 20);
    ctx.stroke();

    const spireLen = th * (0.28 + rng() * 0.14);
    const florets = 22;
    for (let f = 0; f < florets; f++) {
      const ft = f / (florets - 1);
      const fy = ty + spireLen * (1 - ft);
      const spread = (1 - ft * 0.68) * 15;
      const fx = tx + (rng() - 0.5) * spread * 1.4;
      const purple = rng();
      ctx.fillStyle = purple < 0.35 ? '#7c62d8' : purple < 0.75 ? '#5b4dc6' : '#9c86eb';
      ctx.beginPath();
      ctx.ellipse(fx, fy, 6.5, 4.8, (rng() - 0.5) * 0.8, 0, Math.PI * 2);
      ctx.fill();
      if (rng() < 0.45) {
        ctx.fillStyle = 'rgba(235,235,255,0.75)';
        ctx.beginPath();
        ctx.arc(fx, fy - 1.5, 2.0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

function drawAlpineTundraTile(ctx, ox, oy, tw, th, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  // Feathery alpine tundra tuft: radiating short moss-sedge blades + tiny basal leaf rosettes
  // (organic open gaps prevent solid X-card edges when viewed from above at Ice Lake Basin!)
  for (let i = 0; i < 64; i++) {
    const u = rng();
    const spread = (u - 0.5) * 2.0;
    const domeH = Math.cos(spread * Math.PI * 0.48);
    const bx = tw * (0.14 + u * 0.72);
    const by = th * (0.86 + rng() * 0.14);
    const lean = spread * (28 + rng() * 26) + (rng() - 0.5) * 18;
    const tipY = th * (0.34 + (1.0 - domeH) * 0.34 + rng() * 0.20);
    const tone = rng();
    const r = Math.round(74 + tone * 44);
    const g = Math.round(112 + tone * 44);
    const b = Math.round(44 + tone * 20);
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineWidth = 3.2 + rng() * 2.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx + lean * 0.45, (by + tipY) * 0.52, bx + lean, tipY);
    ctx.stroke();
  }

  // Delicate basal moss/avens leaf rosettes tucked near the base
  for (let i = 0; i < 42; i++) {
    const u = 0.14 + rng() * 0.72;
    const domeH = Math.sin(((u - 0.14) / 0.72) * Math.PI);
    const cx = tw * u;
    const cy = th * (0.64 + (1 - domeH) * 0.20 + rng() * 0.16);
    const rad = 5 + rng() * 7;
    const tone = rng();
    ctx.fillStyle = `rgb(${Math.round(64 + tone * 38)},${Math.round(106 + tone * 42)},${Math.round(40 + tone * 18)})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rad, rad * 0.6, (rng() - 0.5) * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  // Bright golden Alpine Avens (Geum rossii) & pink Moss Campion alpine blossoms on slender stems
  for (let i = 0; i < 14; i++) {
    const u = 0.18 + rng() * 0.64;
    const domeH = Math.sin(((u - 0.18) / 0.64) * Math.PI);
    const fx = tw * u;
    const fy = th * (0.28 + (1 - domeH) * 0.24 + rng() * 0.24);
    ctx.strokeStyle = '#5c7f3e';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(fx + (rng() - 0.5) * 10, th * 0.95);
    ctx.quadraticCurveTo(fx + (rng() - 0.5) * 8, (fy + th * 0.95) * 0.5, fx, fy);
    ctx.stroke();

    const isPink = rng() < 0.24;
    if (isPink) {
      ctx.fillStyle = '#ed7eb0';
      ctx.beginPath();
      ctx.arc(fx, fy, 5.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = '#f6d238';
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(fx + Math.cos(a) * 4.8, fy + Math.sin(a) * 4.8, 3.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#d48d18';
      ctx.beginPath();
      ctx.arc(fx, fy, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawWoodlandFernTile(ctx, ox, oy, tw, th, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  // Arching subalpine woodland fern fronds + glossy grouse whortleberry undergrowth (forest floor!)
  const fronds = 9;
  for (let f = 0; f < fronds; f++) {
    const frac = (f / (fronds - 1) - 0.5) * 2;
    const x0 = tw * (0.5 + frac * 0.14);
    const y0 = th * 0.98;
    const x1 = tw * (0.5 + frac * 0.44 + (rng() - 0.5) * 0.08);
    const y1 = th * (0.20 + Math.abs(frac) * 0.28 + rng() * 0.12);
    const cx = (x0 + x1) * 0.5;
    const cy = Math.min(y0, y1) - th * 0.08;

    ctx.strokeStyle = '#3f6934';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();

    const pinnae = 18;
    for (let i = 2; i < pinnae; i++) {
      const t = i / pinnae;
      const it = 1 - t;
      const px = it * it * x0 + 2 * it * t * cx + t * t * x1;
      const py = it * it * y0 + 2 * it * t * cy + t * t * y1;
      const tx = 2 * it * (cx - x0) + 2 * t * (x1 - cx);
      const ty = 2 * it * (cy - y0) + 2 * t * (y1 - cy);
      const ang = Math.atan2(ty, tx);
      const pLen = (1 - t * 0.7) * 24 + 5;

      for (let side = -1; side <= 1; side += 2) {
        const shade = 0.72 + t * 0.34 + (rng() - 0.5) * 0.15;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang + side * 1.15);
        ctx.fillStyle = `rgb(${Math.round(52 * shade)},${Math.round(108 * shade)},${Math.round(44 * shade)})`;
        ctx.beginPath();
        ctx.ellipse(pLen * 0.5, 0, pLen * 0.55, 4.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  // Low dark woody whortleberry shrub leaves at base
  for (let i = 0; i < 36; i++) {
    const lx = tw * (0.08 + rng() * 0.84);
    const ly = th * (0.64 + rng() * 0.32);
    ctx.fillStyle = `rgb(${44 + Math.round(rng() * 24)},${88 + Math.round(rng() * 32)},${38 + Math.round(rng() * 14)})`;
    ctx.beginPath();
    ctx.ellipse(lx, ly, 8 + rng() * 6, 5 + rng() * 4, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawArnicaMeadowTile(ctx, ox, oy, tw, th, rng) {
  ctx.save();
  ctx.translate(ox, oy);

  drawMeadowGrassTile(ctx, 0, th * 0.28, tw, th * 0.72, rng, false);

  // Sunny yellow Heartleaf Arnica / Aspen Sunflower daisies (iconic under Telluride aspens!)
  for (let i = 0; i < 9; i++) {
    const bx = tw * (0.14 + (i / 8) * 0.72 + (rng() - 0.5) * 0.08);
    const tx = bx + (rng() - 0.5) * 38;
    const ty = th * (0.16 + rng() * 0.34);

    ctx.strokeStyle = '#5a8f46';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(bx, th);
    ctx.quadraticCurveTo((bx + tx) * 0.5, th * 0.64, tx, ty);
    ctx.stroke();

    const fS = 0.9 + rng() * 0.35;
    for (let p = 0; p < 10; p++) {
      const a = (p / 10) * Math.PI * 2;
      ctx.fillStyle = '#f5ca32';
      ctx.beginPath();
      ctx.ellipse(tx + Math.cos(a) * 10 * fS, ty + Math.sin(a) * 10 * fS, 8.5 * fS, 3.2 * fS, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#c47c1a';
    ctx.beginPath();
    ctx.arc(tx, ty, 5.2 * fS, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function createGroundFloraAtlas(anisotropy) {
  const w = 1024;
  const h = 1024;
  const tw = 256;
  const th = 512;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  const rng = mulberry32(9973);

  // Row 0 (top of canvas -> UV v: 0.5..1.0)
  drawMeadowGrassTile(ctx, 0 * tw, 0, tw, th, rng, false);      // 0: Lush green fescue meadow grass
  drawMeadowGrassTile(ctx, 1 * tw, 0, tw, th, rng, true);       // 1: Golden alpine sedge
  drawColumbineTile(ctx, 2 * tw, 0, tw, th, rng);               // 2: Colorado Blue Columbine
  drawPaintbrushTile(ctx, 3 * tw, 0, tw, th, rng);              // 3: Scarlet Indian Paintbrush

  // Row 1 (bottom of canvas -> UV v: 0.0..0.5)
  drawLupineTile(ctx, 0 * tw, th, tw, th, rng);                 // 4: Mountain Lupine
  drawAlpineTundraTile(ctx, 1 * tw, th, tw, th, rng);           // 5: Alpine Tundra Cushion + Avens
  drawWoodlandFernTile(ctx, 2 * tw, th, tw, th, rng);           // 6: Forest Floor Ferns / Whortleberry
  drawArnicaMeadowTile(ctx, 3 * tw, th, tw, th, rng);           // 7: Heartleaf Arnica / Aspen Daisies

  return dilateToDataTexture(c, { passes: 4, srgb: true, anisotropy });
}

// ============================================================================
// 4. SAN JUAN VOLCANIC ROCK DETAIL ALBEDO + NORMAL MAP (512x512 seamless)
//    Fractured granite/andesite strata + subtle alpine crustose lichen
// ============================================================================

function createRockTextures(anisotropy) {
  const size = 256;
  const heightField = new Float32Array(size * size);

  // Seamless periodic multi-octave fractured rock height field stored directly in CPU Uint8Arrays
  // so WebGL context loss / restore NEVER blanks rock albedo or normal maps!
  const dAlb = new Uint8Array(size * size * 4);

  // Use torus-wrapped coordinates or tiled fbm via blended periodic noise
  function tileNoise(u, v, freq, salt) {
    // 2x2 wrap blend for seamless tiling
    const x = u * freq;
    const y = v * freq;
    const ix0 = Math.floor(x) % freq;
    const iy0 = Math.floor(y) % freq;
    const ix1 = (ix0 + 1) % freq;
    const iy1 = (iy0 + 1) % freq;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const h = (a, b) => {
      let n = (a * 374761393 + b * 668265263 + salt * 1442695041) | 0;
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    };
    const v00 = h(ix0, iy0);
    const v10 = h(ix1, iy0);
    const v01 = h(ix0, iy1);
    const v11 = h(ix1, iy1);
    return v00 + (v10 - v00) * ux + (v01 - v00) * uy + (v00 - v10 - v01 + v11) * ux * uy;
  }

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const n1 = tileNoise(u, v, 4, 11);
      const n2 = tileNoise(u, v, 8, 29);
      const n3 = tileNoise(u, v, 16, 53);
      const n4 = tileNoise(u, v, 32, 97);
      // Ridged fracture cracks
      const crack1 = Math.abs(tileNoise(u, v * 1.0, 6, 131) - 0.5) * 2.0;
      const crack2 = Math.abs(tileNoise(u * 1.0, v, 12, 193) - 0.5) * 2.0;
      const crevice = Math.min(1.0, Math.pow(crack1, 0.35) * 0.72 + Math.pow(crack2, 0.4) * 0.35);

      // Horizontal volcanic breccia strata
      const strata = 0.5 + 0.5 * Math.sin((v * 5 + n1 * 0.9 + n2 * 0.35) * Math.PI * 2);
      const hVal = (n1 * 0.35 + n2 * 0.25 + n3 * 0.20 + n4 * 0.12 + strata * 0.08) * (0.55 + 0.45 * crevice);
      heightField[y * size + x] = hVal;

      // Neutral light-mid base albedo so per-instance vertex/instance color tints accurately!
      const speck = (n4 - 0.5) * 34;
      const baseLum = (138 + hVal * 62 + speck) * (0.72 + 0.28 * crevice);

      // Subtle yellow-green alpine crustose lichen spots on raised faces
      const lichen = tileNoise(u, v, 10, 409) * tileNoise(u, v, 24, 521);
      const isLichen = hVal > 0.52 && lichen > 0.56 ? Math.min(1, (lichen - 0.56) * 5.0) : 0;

      const p = (y * size + x) * 4;
      const r = baseLum * (1 - isLichen * 0.22) + isLichen * 18;
      const g = baseLum * (1 - isLichen * 0.05) + isLichen * 34;
      const b = baseLum * (1 - isLichen * 0.48);

      dAlb[p] = Math.min(255, Math.max(24, Math.round(r)));
      dAlb[p + 1] = Math.min(255, Math.max(24, Math.round(g)));
      dAlb[p + 2] = Math.min(255, Math.max(22, Math.round(b)));
      dAlb[p + 3] = 255;
    }
  }
  // Tangent-space normal map from heightField
  const dNrm = new Uint8Array(size * size * 4);
  const strength = 3.2;

  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const dx = (heightField[y * size + xp] - heightField[y * size + xm]) * strength;
      const dy = (heightField[yp * size + x] - heightField[ym * size + x]) * strength;
      const nx = -dx;
      const ny = -dy;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const p = (y * size + x) * 4;
      dNrm[p] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      dNrm[p + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      dNrm[p + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      dNrm[p + 3] = 255;
    }
  }

  const makeRockTex = (arr, srgb) => {
    const tex = new THREE.DataTexture(arr, size, size, THREE.RGBAFormat);
    tex.flipY = true;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = anisotropy;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  };

  return {
    rockAlbedo: makeRockTex(dAlb, true),
    rockNormal: makeRockTex(dNrm, false),
  };
}

// ============================================================================
// Atlas UV Rects (exact 2-texel inset to prevent mipmap bleed between tiles)
// ============================================================================

export const FOLIAGE_ATLAS_RECTS = {
  spruce: [0.004, 0.504, 0.492, 0.492],
  fir: [0.504, 0.504, 0.492, 0.492],
  aspen: [0.004, 0.004, 0.492, 0.492],
  willow: [0.504, 0.004, 0.492, 0.492],
};

// 4 cols x 2 rows in groundFloraAtlas (u0, v0, uScale, vScale)
export const GROUND_FLORA_RECTS = [
  [0.006, 0.506, 0.238, 0.488], // 0: Lush green fescue grass
  [0.256, 0.506, 0.238, 0.488], // 1: Golden alpine sedge
  [0.506, 0.506, 0.238, 0.488], // 2: Colorado Blue Columbine
  [0.756, 0.506, 0.238, 0.488], // 3: Scarlet Indian Paintbrush
  [0.006, 0.006, 0.238, 0.488], // 4: Mountain Lupine
  [0.256, 0.006, 0.238, 0.488], // 5: Alpine Tundra Cushion + Avens
  [0.506, 0.006, 0.238, 0.488], // 6: Forest Floor Ferns / Whortleberry
  [0.756, 0.006, 0.238, 0.488], // 7: Heartleaf Arnica / Aspen Daisies
];

export function createFloraTextures(anisotropy = 4) {
  let currentAniso = anisotropy;
  const foliageAtlas = createFoliageAtlas(anisotropy);
  const barkAtlas = createBarkAtlas(anisotropy);
  const groundFloraAtlas = createGroundFloraAtlas(anisotropy);
  const { rockAlbedo, rockNormal } = createRockTextures(anisotropy);

  const all = [foliageAtlas, barkAtlas, groundFloraAtlas, rockAlbedo, rockNormal];

  return {
    foliageAtlas,
    barkAtlas,
    groundFloraAtlas,
    rockAlbedo,
    rockNormal,
    setAnisotropy(val) {
      if (val === currentAniso) return;
      currentAniso = val;
      for (const tex of all) {
        tex.anisotropy = val;
        tex.needsUpdate = true;
      }
    },
    refresh() {
      for (const tex of all) {
        tex.needsUpdate = true;
      }
    },
    dispose() {
      for (const tex of all) {
        tex.dispose();
      }
    },
  };
}
