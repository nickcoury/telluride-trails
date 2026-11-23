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

function drawConiferImpostor(ctx, ox, oy, size, rng, isFir) {
  ctx.save();
  ctx.translate(ox, oy);
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

  drawConiferImpostor(ctx, 0, 0, half, rng, false);
  drawConiferImpostor(ctx, half, 0, half, rng, true);
  drawAspenImpostor(ctx, 0, half, half, rng);
  drawKrummholzImpostor(ctx, half, half, half, rng);

  return finalizeTexture(canvas, { srgb: true, anisotropy });
}

function createGrassFlowerAtlas(anisotropy) {
  const size = 256;
  const half = 128;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(7103);

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
 * Create a 1024x1024 4x4 Victorian & San Juan PBR Trimsheet Atlas (Albedo + Normal + Roughness):
 * Row 0 (cells 0..3):  Commercial Victorian Main-Street Storefronts (Red Brick, Ochre Clapboard, Cream Sandstone, Sage Mercantile)
 * Row 1 (cells 4..7):  Victorian Cottages & Mountain Chalets (Slate Painted Lady, Barn-Red Miner Cottage, Cream House, Stone/Timber Lodge)
 * Row 2 (cells 8..11): Secondary Side/Rear Walls with sparse windows (Red Brick, Ochre Clapboard, Sage/Slate Clapboard, Timber/Stone)
 * Row 3 (cells 12..15): Cedar Shingle Roof (12), Standing-Seam Metal Roof (13), Porch/Cornice/Stone Trim (14), Town Street & Sidewalk (15)
 */
function createBuildingPBRAtlases(anisotropy) {
  const size = 1024;
  const cell = 256;
  const albCanvas = makeCanvas(size, size);
  const ctx = albCanvas.getContext('2d');

  // Parallel height (R) + roughness (G) canvas so we derive exact normalMap & roughnessMap!
  const hrCanvas = makeCanvas(size, size);
  const hctx = hrCanvas.getContext('2d');
  // Default neutral height=128, roughness=200 (~0.78)
  hctx.fillStyle = 'rgb(128,200,0)';
  hctx.fillRect(0, 0, size, size);

  const rng = mulberry32(918273);

  function fillWallBackground(ox, oy, w, h, kind, baseHex, roughVal) {
    ctx.fillStyle = baseHex;
    ctx.fillRect(ox, oy, w, h);
    hctx.fillStyle = `rgb(132,${roughVal},0)`;
    hctx.fillRect(ox, oy, w, h);

    if (kind === 'brick') {
      const rowH = 7;
      for (let y = 0; y < h; y += rowH) {
        // Mortar groove
        ctx.fillStyle = 'rgba(218,204,188,0.28)';
        ctx.fillRect(ox, oy + y, w, 1.4);
        hctx.fillStyle = 'rgb(88,235,0)';
        hctx.fillRect(ox, oy + y, w, 1.5);

        const shift = ((y / rowH) % 2) * 10;
        for (let x = 0; x < w; x += 20) {
          const bx = ox + ((x + shift) % w);
          // Individual brick color variation
          const v = (rng() - 0.5) * 26;
          ctx.fillStyle = v > 0 ? `rgba(255,190,150,${(v / 140).toFixed(3)})` : `rgba(25,10,8,${(-v / 110).toFixed(3)})`;
          ctx.fillRect(bx, oy + y + 1.5, 18, rowH - 1.5);
          // Vertical mortar
          ctx.fillStyle = 'rgba(215,200,185,0.24)';
          ctx.fillRect(bx, oy + y, 1.3, rowH);
          hctx.fillStyle = 'rgb(92,235,0)';
          hctx.fillRect(bx, oy + y, 1.5, rowH);
        }
      }
    } else if (kind === 'clapboard') {
      const lapH = 8;
      for (let y = 0; y < h; y += lapH) {
        // Crisp horizontal shadow under each clapboard lap
        ctx.fillStyle = 'rgba(0,0,0,0.20)';
        ctx.fillRect(ox, oy + y + lapH - 1.8, w, 1.8);
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(ox, oy + y, w, 1.2);
        // Sawtooth bevel height ramp for crisp normal-mapped lap siding
        hctx.fillStyle = `rgb(158,${roughVal},0)`;
        hctx.fillRect(ox, oy + y + lapH - 3, w, 2);
        hctx.fillStyle = `rgb(92,${roughVal + 15},0)`;
        hctx.fillRect(ox, oy + y + lapH - 1, w, 1);

        // Subtle weathered plank grain
        if (rng() < 0.45) {
          ctx.fillStyle = `rgba(0,0,0,${(rng() * 0.06).toFixed(3)})`;
          ctx.fillRect(ox, oy + y + 1, w, lapH - 2);
        }
      }
    } else if (kind === 'stone') {
      for (let y = 0; y < h; y += 14) {
        const shift = ((y / 14) % 2) * 14;
        for (let x = -14; x < w; x += 28) {
          const sw = 24 + (rng() - 0.5) * 6;
          const sh = 11 + (rng() - 0.5) * 2;
          const sx = Math.max(ox, ox + x + shift);
          const clampW = Math.min(sw, ox + w - sx);
          if (clampW <= 2) continue;
          const shade = 88 + Math.round((rng() - 0.5) * 38);
          ctx.fillStyle = `rgb(${shade + 8},${shade + 2},${shade - 6})`;
          ctx.fillRect(sx + 1, oy + y + 1, clampW - 1, sh);
          hctx.fillStyle = `rgb(${135 + Math.round((rng() - 0.5) * 35)},228,0)`;
          hctx.fillRect(sx + 1, oy + y + 1, clampW - 1, sh);
        }
      }
    } else if (kind === 'timber_stone') {
      // Upper 62% warm cedar logs/planks, lower 38% river stone
      const splitH = Math.round(h * 0.62);
      fillWallBackground(ox, oy, w, splitH, 'clapboard', '#7d5638', 185);
      fillWallBackground(ox, oy + splitH, w, h - splitH, 'stone', '#5c554e', 225);
      // Heavy timber belt beam
      ctx.fillStyle = '#4a3321';
      ctx.fillRect(ox, oy + splitH - 5, w, 8);
      hctx.fillStyle = 'rgb(175,195,0)';
      hctx.fillRect(ox, oy + splitH - 5, w, 8);
    }
  }

  function drawSashWindow(wx, wy, ww, wh, trimCol, shutterCol = null, arched = false) {
    // Optional Victorian louvered shutters
    if (shutterCol) {
      const sw = Math.max(6, Math.round(ww * 0.34));
      ctx.fillStyle = shutterCol;
      ctx.fillRect(wx - sw - 3, wy + 2, sw, wh - 2);
      ctx.fillRect(wx + ww + 3, wy + 2, sw, wh - 2);
      hctx.fillStyle = 'rgb(162,175,0)';
      hctx.fillRect(wx - sw - 3, wy + 2, sw, wh - 2);
      hctx.fillRect(wx + ww + 3, wy + 2, sw, wh - 2);
    }

    // Projecting stone/wood lintel & sill
    ctx.fillStyle = trimCol;
    if (arched) {
      ctx.beginPath();
      ctx.arc(wx + ww * 0.5, wy + 5, ww * 0.5 + 4, Math.PI, 0);
      ctx.fill();
    } else {
      ctx.fillRect(wx - 4, wy - 6, ww + 8, 6);
    }
    // Outer casing
    ctx.fillRect(wx - 3, wy, ww + 6, wh + 3);
    // Projecting sill + subtle drop shadow
    ctx.fillRect(wx - 5, wy + wh + 1, ww + 10, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(wx - 4, wy + wh + 5, ww + 8, 3);

    hctx.fillStyle = 'rgb(176,165,0)';
    hctx.fillRect(wx - 4, wy - 5, ww + 8, wh + 10);

    // Recessed dark reflective glass (roughness = 28 -> 0.11 shiny glass!)
    const grad = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
    grad.addColorStop(0, '#2a3f54');
    grad.addColorStop(0.45, '#192634');
    grad.addColorStop(1, '#24313d');
    ctx.fillStyle = grad;
    ctx.fillRect(wx, wy + 1, ww, wh - 1);

    // Warm interior curtain / brass lamp hint in some panes
    if (rng() < 0.45) {
      ctx.fillStyle = 'rgba(215,185,135,0.16)';
      ctx.fillRect(wx + 2, wy + wh * 0.52, ww - 4, wh * 0.44);
    }
    // Crisp diagonal sky glint
    ctx.fillStyle = 'rgba(185,215,245,0.16)';
    ctx.beginPath();
    ctx.moveTo(wx + 2, wy + 2);
    ctx.lineTo(wx + ww * 0.65, wy + 2);
    ctx.lineTo(wx + 2, wy + wh * 0.55);
    ctx.closePath();
    ctx.fill();

    // Glass height recessed (90) + ultra-low roughness (28 = smooth reflective glass!)
    hctx.fillStyle = 'rgb(90,28,0)';
    hctx.fillRect(wx, wy + 1, ww, wh - 1);

    // Delicate 2-over-2 Victorian muntins & meeting rail
    ctx.fillStyle = trimCol;
    ctx.fillRect(wx, wy + Math.round(wh * 0.48), ww, 2.5);
    ctx.fillRect(wx + Math.round(ww * 0.48), wy + 1, 2, wh - 1);
    hctx.fillStyle = 'rgb(155,160,0)';
    hctx.fillRect(wx, wy + Math.round(wh * 0.48), ww, 2.5);
  }

  function drawCorniceAndPilasters(ox, oy, trimCol, accentCol) {
    // Projecting Victorian bracketed cornice at top
    ctx.fillStyle = trimCol;
    ctx.fillRect(ox, oy, cell, 12);
    ctx.fillStyle = accentCol;
    ctx.fillRect(ox, oy + 12, cell, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(ox, oy + 18, cell, 4);
    // Decorative corbel brackets
    ctx.fillStyle = trimCol;
    for (let x = 8; x < cell; x += 24) {
      ctx.fillRect(ox + x, oy + 8, 6, 12);
    }
    hctx.fillStyle = 'rgb(195,155,0)';
    hctx.fillRect(ox, oy, cell, 18);

    // Left & right corner pilaster trim boards
    ctx.fillStyle = trimCol;
    ctx.fillRect(ox, oy, 7, cell);
    ctx.fillRect(ox + cell - 7, oy, 7, cell);
    hctx.fillStyle = 'rgb(168,160,0)';
    hctx.fillRect(ox, oy, 7, cell);
    hctx.fillRect(ox + cell - 7, oy, 7, cell);
  }

  function drawStorefrontGroundFloor(ox, oy, trimCol, shopCol, signBg) {
    const topY = oy + 142;
    const botY = oy + cell;

    // Signboard frieze band between 1st & 2nd floor
    ctx.fillStyle = trimCol;
    ctx.fillRect(ox + 4, topY - 16, cell - 8, 16);
    ctx.fillStyle = signBg;
    ctx.fillRect(ox + 12, topY - 13, cell - 24, 10);
    // Subtle gold signboard pinstripe
    ctx.strokeStyle = 'rgba(235,205,135,0.55)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(ox + 15, topY - 11, cell - 30, 6);
    hctx.fillStyle = 'rgb(182,150,0)';
    hctx.fillRect(ox + 4, topY - 16, cell - 8, 16);

    // Ground-floor wooden/cast-iron storefront framing
    ctx.fillStyle = shopCol;
    ctx.fillRect(ox + 5, topY, cell - 10, botY - topY);
    hctx.fillStyle = 'rgb(156,145,0)';
    hctx.fillRect(ox + 5, topY, cell - 10, botY - topY);

    // Transom glass row across top of storefront
    for (let i = 0; i < 3; i++) {
      const tx = ox + 16 + i * 78;
      ctx.fillStyle = '#203040';
      ctx.fillRect(tx, topY + 6, 68, 14);
      hctx.fillStyle = 'rgb(92,30,0)';
      hctx.fillRect(tx, topY + 6, 68, 14);
    }

    // Left & Right large Victorian display windows + recessed center double-door
    const dispPanels = [ox + 16, ox + 168];
    for (const dx of dispPanels) {
      ctx.fillStyle = '#1d2d3c';
      ctx.fillRect(dx, topY + 26, 72, 62);
      // Warm interior display glow
      ctx.fillStyle = 'rgba(225,185,125,0.22)';
      ctx.fillRect(dx + 4, topY + 46, 64, 38);
      // Sky reflection diagonal
      ctx.fillStyle = 'rgba(180,215,245,0.18)';
      ctx.beginPath();
      ctx.moveTo(dx + 2, topY + 28);
      ctx.lineTo(dx + 52, topY + 28);
      ctx.lineTo(dx + 2, topY + 72);
      ctx.closePath();
      ctx.fill();
      hctx.fillStyle = 'rgb(88,24,0)';
      hctx.fillRect(dx, topY + 26, 72, 62);

      // Paneled wood kickplate below display glass
      ctx.strokeStyle = trimCol;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(dx + 2, topY + 93, 68, 16);
    }

    // Center recessed double entryway door
    const doorX = ox + 100;
    ctx.fillStyle = 'rgba(0,0,0,0.36)';
    ctx.fillRect(doorX - 4, topY + 26, 60, 88);
    ctx.fillStyle = '#4a2e1d';
    ctx.fillRect(doorX, topY + 30, 25, 84);
    ctx.fillRect(doorX + 27, topY + 30, 25, 84);
    // Door glass panes
    ctx.fillStyle = '#203242';
    ctx.fillRect(doorX + 4, topY + 36, 17, 40);
    ctx.fillRect(doorX + 31, topY + 36, 17, 40);
    hctx.fillStyle = 'rgb(82,35,0)';
    hctx.fillRect(doorX + 4, topY + 36, 44, 40);

    // Pale granite threshold sill at street grade (2px, no floating black band!)
    ctx.fillStyle = '#9e9589';
    ctx.fillRect(ox, botY - 4, cell, 4);
  }

  // --- ROW 0: Commercial Main-Street Storefronts (Cells 0..3) ---
  const storefronts = [
    { kind: 'brick', bg: '#8b3e30', rough: 222, trim: '#cbbda6', shop: '#2b4238', sign: '#4a221b', arched: true },
    { kind: 'clapboard', bg: '#c2944c', rough: 168, trim: '#e2d7c1', shop: '#593327', sign: '#2c3d35', arched: false },
    { kind: 'brick', bg: '#b8aa96', rough: 215, trim: '#635b52', shop: '#2c333a', sign: '#242b33', arched: true },
    { kind: 'clapboard', bg: '#5c7362', rough: 170, trim: '#d8cfb8', shop: '#3e332a', sign: '#3d2620', arched: false },
  ];
  storefronts.forEach((st, cIdx) => {
    const ox = cIdx * cell;
    const oy = 0;
    fillWallBackground(ox, oy, cell, cell, st.kind, st.bg, st.rough);
    drawCorniceAndPilasters(ox, oy, st.trim, st.shop);
    // Upper story: 3 well-proportioned Victorian windows
    for (let w = 0; w < 3; w++) {
      drawSashWindow(ox + 28 + w * 78, oy + 38, 36, 68, st.trim, null, st.arched);
    }
    drawStorefrontGroundFloor(ox, oy, st.trim, st.shop, st.sign);
  });

  // --- ROW 1: Victorian Cottages & Alpine Chalets (Cells 4..7) ---
  const cottages = [
    { kind: 'clapboard', bg: '#556c84', rough: 165, trim: '#e4dccb', shutter: '#2f3e36', cols: 2 },
    { kind: 'clapboard', bg: '#8f3f34', rough: 172, trim: '#dfd6c3', shutter: '#35453d', cols: 2 },
    { kind: 'clapboard', bg: '#cfc1a3', rough: 165, trim: '#5f7062', shutter: '#6e3a30', cols: 3 },
    { kind: 'timber_stone', bg: '#755338', rough: 195, trim: '#cbb99d', shutter: null, cols: 3 },
  ];
  cottages.forEach((ct, idx) => {
    const ox = idx * cell;
    const oy = cell;
    fillWallBackground(ox, oy, cell, cell, ct.kind, ct.bg, ct.rough);
    drawCorniceAndPilasters(ox, oy, ct.trim, '#3f3831');

    const spacing = ct.cols === 2 ? 108 : 74;
    const startX = ct.cols === 2 ? 48 : 30;
    // Upper floor windows
    for (let c = 0; c < ct.cols; c++) {
      drawSashWindow(ox + startX + c * spacing, oy + 36, 34, 58, ct.trim, ct.shutter, false);
    }
    // Ground floor: front door in bay 0 + parlor windows in remaining bays
    const doorX = ox + startX;
    ctx.fillStyle = ct.trim;
    ctx.fillRect(doorX - 4, oy + 146, 44, 108);
    ctx.fillStyle = '#4d2f1e';
    ctx.fillRect(doorX, oy + 150, 36, 104);
    ctx.fillStyle = '#223344';
    ctx.fillRect(doorX + 6, oy + 158, 24, 38);
    hctx.fillStyle = 'rgb(90,32,0)';
    hctx.fillRect(doorX + 6, oy + 158, 24, 38);

    for (let c = 1; c < ct.cols; c++) {
      drawSashWindow(ox + startX + c * spacing, oy + 148, 36, 62, ct.trim, ct.shutter, false);
    }
    // Subtle sandstone foundation sill at grade
    ctx.fillStyle = '#8d8479';
    ctx.fillRect(ox, oy + cell - 6, cell, 6);
  });

  // --- ROW 2: Secondary Side / Party Walls with Sparse Windows (Cells 8..11) ---
  const sideWalls = [
    { kind: 'brick', bg: '#8a3d2f', rough: 224, trim: '#c7b8a1', winCount: 1 },
    { kind: 'clapboard', bg: '#c6b496', rough: 168, trim: '#e2d8c3', winCount: 2 },
    { kind: 'clapboard', bg: '#576d77', rough: 170, trim: '#ded6c3', winCount: 1 },
    { kind: 'timber_stone', bg: '#6e5038', rough: 200, trim: '#c4b296', winCount: 1 },
  ];
  sideWalls.forEach((sw, idx) => {
    const ox = idx * cell;
    const oy = cell * 2;
    fillWallBackground(ox, oy, cell, cell, sw.kind, sw.bg, sw.rough);
    drawCorniceAndPilasters(ox, oy, sw.trim, '#3c352f');
    if (sw.winCount >= 1) {
      drawSashWindow(ox + 108, oy + 46, 30, 54, sw.trim, null, false);
    }
    if (sw.winCount >= 2) {
      drawSashWindow(ox + 68, oy + 154, 30, 54, sw.trim, null, false);
    }
    ctx.fillStyle = '#8a8176';
    ctx.fillRect(ox, oy + cell - 6, cell, 6);
  });

  // --- ROW 3: Roofs, Porch/Stone Trim & Town Street/Sidewalk (Cells 12..15) ---
  const r3y = cell * 3;

  // Cell 12: Weathered Cedar Shingle Roof
  ctx.fillStyle = '#4a4038';
  ctx.fillRect(0, r3y, cell, cell);
  hctx.fillStyle = 'rgb(128,222,0)';
  hctx.fillRect(0, r3y, cell, cell);
  for (let y = 0; y < cell; y += 10) {
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, r3y + y + 8, cell, 2);
    hctx.fillStyle = 'rgb(92,228,0)';
    hctx.fillRect(0, r3y + y + 8, cell, 2);
    for (let x = 0; x < cell; x += 14) {
      const sh = (rng() - 0.5) * 24;
      ctx.fillStyle = sh > 0 ? `rgba(180,155,130,${(sh / 150).toFixed(3)})` : `rgba(15,12,10,${(-sh / 110).toFixed(3)})`;
      ctx.fillRect(x, r3y + y, 13, 8);
    }
  }

  // Cell 13: Standing-Seam Oxidized Metal Roof (roughness = 108 -> crisp metallic sheen!)
  const ox13 = cell;
  ctx.fillStyle = '#3a4750';
  ctx.fillRect(ox13, r3y, cell, cell);
  hctx.fillStyle = 'rgb(128,108,0)';
  hctx.fillRect(ox13, r3y, cell, cell);
  for (let x = 0; x < cell; x += 16) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(ox13 + x, r3y, 2, cell);
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.fillRect(ox13 + x + 2, r3y, 2, cell);
    hctx.fillStyle = 'rgb(185,95,0)';
    hctx.fillRect(ox13 + x, r3y, 3, cell);
  }

  // Cell 14: Top half = Painted Victorian Trim / Porch Decking; Bottom half = Cut San Juan Foundation Granite
  const ox14 = cell * 2;
  ctx.fillStyle = '#cfc3ad';
  ctx.fillRect(ox14, r3y, cell, 64);
  hctx.fillStyle = 'rgb(155,155,0)';
  hctx.fillRect(ox14, r3y, cell, 64);
  // Porch plank decking (y = 64..128)
  ctx.fillStyle = '#6e5239';
  ctx.fillRect(ox14, r3y + 64, cell, 64);
  for (let y = 64; y < 128; y += 8) {
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(ox14, r3y + y, cell, 1.5);
    hctx.fillStyle = 'rgb(96,195,0)';
    hctx.fillRect(ox14, r3y + y, cell, 2);
  }
  // Cut foundation granite (y = 128..256)
  fillWallBackground(ox14, r3y + 128, cell, 128, 'stone', '#6e675f', 225);

  // Cell 15: Town Street Cross-Section Trimsheet!
  // Left half (x = 0..128): Weathered dark Colorado town asphalt roadbed + aggregate
  // Right half (x = 128..256): Granite curb edge + warm sandstone/concrete sidewalk pavers!
  const ox15 = cell * 3;
  ctx.fillStyle = '#383a3e';
  ctx.fillRect(ox15, r3y, 128, cell);
  hctx.fillStyle = 'rgb(120,218,0)';
  hctx.fillRect(ox15, r3y, 128, cell);
  // Asphalt fine mineral aggregate & subtle natural wear
  for (let i = 0; i < 1400; i++) {
    const ax = ox15 + rng() * 127;
    const ay = r3y + rng() * (cell - 1);
    const v = 50 + Math.round(rng() * 18);
    ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
    ctx.fillRect(ax, ay, 1, 1);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.016)';
  ctx.fillRect(ox15 + 32, r3y, 20, cell);
  ctx.fillRect(ox15 + 76, r3y, 20, cell);
  ctx.fillStyle = 'rgba(186,150,74,0.16)';
  ctx.fillRect(ox15 + 63, r3y, 2, cell);

  // Right half: Granite curb (x=128..144) + warm Telluride red-sandstone/concrete sidewalk slabs (x=144..256)
  ctx.fillStyle = '#8f887e';
  ctx.fillRect(ox15 + 128, r3y, 16, cell);
  hctx.fillStyle = 'rgb(175,205,0)';
  hctx.fillRect(ox15 + 128, r3y, 16, cell);

  ctx.fillStyle = '#a39382';
  ctx.fillRect(ox15 + 144, r3y, 112, cell);
  hctx.fillStyle = 'rgb(148,198,0)';
  hctx.fillRect(ox15 + 144, r3y, 112, cell);
  for (let y = 0; y < cell; y += 24) {
    ctx.fillStyle = 'rgba(40,32,26,0.26)';
    ctx.fillRect(ox15 + 144, r3y + y, 112, 2);
    hctx.fillStyle = 'rgb(100,220,0)';
    hctx.fillRect(ox15 + 144, r3y + y, 112, 2);
    // Subtle slab tone variation
    const tone = (rng() - 0.5) * 16;
    ctx.fillStyle = tone > 0 ? `rgba(255,235,210,${(tone / 160).toFixed(3)})` : `rgba(30,20,15,${(-tone / 140).toFixed(3)})`;
    ctx.fillRect(ox15 + 145, r3y + y + 2, 110, 22);
  }
  ctx.fillStyle = 'rgba(40,32,26,0.22)';
  ctx.fillRect(ox15 + 198, r3y, 2, cell);

  // Derive 512x512 Normal Map & Roughness Map from hrCanvas
  const pbrSize = 512;
  const smallHr = makeCanvas(pbrSize, pbrSize);
  const sctx = smallHr.getContext('2d');
  sctx.drawImage(hrCanvas, 0, 0, pbrSize, pbrSize);
  const src = sctx.getImageData(0, 0, pbrSize, pbrSize).data;

  const nrmCanvas = makeCanvas(pbrSize, pbrSize);
  const nctx = nrmCanvas.getContext('2d');
  const nrmImg = nctx.createImageData(pbrSize, pbrSize);
  const nd = nrmImg.data;

  const rghCanvas = makeCanvas(pbrSize, pbrSize);
  const rctx = rghCanvas.getContext('2d');
  const rghImg = rctx.createImageData(pbrSize, pbrSize);
  const rd = rghImg.data;

  const strength = 2.6;
  for (let y = 0; y < pbrSize; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(pbrSize - 1, y + 1);
    for (let x = 0; x < pbrSize; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(pbrSize - 1, x + 1);
      const idx = (y * pbrSize + x) * 4;
      const hL = src[(y * pbrSize + xm) * 4] / 255;
      const hR = src[(y * pbrSize + xp) * 4] / 255;
      const hU = src[(ym * pbrSize + x) * 4] / 255;
      const hD = src[(yp * pbrSize + x) * 4] / 255;

      const nx = (hL - hR) * strength;
      const ny = (hU - hD) * strength;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);

      nd[idx] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      nd[idx + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      nd[idx + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      nd[idx + 3] = 255;

      const rVal = src[idx + 1];
      rd[idx] = rVal;
      rd[idx + 1] = rVal;
      rd[idx + 2] = rVal;
      rd[idx + 3] = 255;
    }
  }
  nctx.putImageData(nrmImg, 0, 0);
  rctx.putImageData(rghImg, 0, 0);

  return {
    buildingAtlas: finalizeTexture(albCanvas, { srgb: true, repeat: false, anisotropy }),
    buildingNormal: finalizeTexture(nrmCanvas, { srgb: false, repeat: false, anisotropy }),
    buildingRoughness: finalizeTexture(rghCanvas, { srgb: false, repeat: false, anisotropy }),
  };
}

/**
 * Seamlessly periodic 4-octave organic fBm + domain-warped water normal & turbulence map.
 * Completely eliminates sine-wave Moiré on lakes and lengthwise stripes on mountain creeks!
 */
function createWaterNormalTexture(anisotropy) {
  const size = 256;
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;

  // Periodic value noise on integer period P so tile wraps 100% seamlessly
  function hashP(ix, iy, p, salt) {
    const wx = ((ix % p) + p) % p;
    const wy = ((iy % p) + p) % p;
    let h = (wx * 374761393 + wy * 668265263 + salt * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function periodicNoise(u, v, p, salt) {
    const x = u * p;
    const y = v * p;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hashP(ix, iy, p, salt);
    const b = hashP(ix + 1, iy, p, salt);
    const c0 = hashP(ix, iy + 1, p, salt);
    const d = hashP(ix + 1, iy + 1, p, salt);
    return a + (b - a) * sx + (c0 - a) * sy + (a - b - c0 + d) * sx * sy;
  }

  const heights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      // Domain warp so ripples curve organically like wind-blown alpine water
      const wx = periodicNoise(u, v, 5, 11) * 0.12;
      const wy = periodicNoise(u, v, 5, 29) * 0.12;
      const h =
        periodicNoise(u + wx, v + wy, 6, 101) * 0.44 +
        periodicNoise(u - wy, v + wx, 13, 211) * 0.28 +
        periodicNoise(u + wx * 0.5, v - wy * 0.5, 27, 307) * 0.18 +
        periodicNoise(u, v, 53, 419) * 0.10;
      heights[y * size + x] = h;
    }
  }

  const bumpScale = 3.2;
  for (let y = 0; y < size; y++) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const hL = heights[y * size + xm];
      const hR = heights[y * size + xp];
      const hU = heights[ym * size + x];
      const hD = heights[yp * size + x];

      const nx = (hL - hR) * bumpScale;
      const ny = (hU - hD) * bumpScale;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);

      const p = (y * size + x) * 4;
      data[p] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[p + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[p + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      // Store organic foam/turbulence height in alpha!
      data[p + 3] = Math.min(255, Math.max(0, Math.round(heights[y * size + x] * 255)));
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
  const bldgPbr = createBuildingPBRAtlases(anisotropy);
  const textures = {
    treeImpostor: createTreeImpostorAtlas(anisotropy),
    grassFlower: createGrassFlowerAtlas(anisotropy),
    buildingAtlas: bldgPbr.buildingAtlas,
    buildingNormal: bldgPbr.buildingNormal,
    buildingRoughness: bldgPbr.buildingRoughness,
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
