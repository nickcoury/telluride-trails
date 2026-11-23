import {
  BBOX,
  lonLatToWorld,
  worldToLonLat,
  tileBoundsWorld,
  worldToTile,
} from '../core/geo.js';
import { fmtElev } from './format.js';

const POI_COLORS = {
  town: '#f4b942',
  trailhead: '#3ddc84',
  pass: '#e65c2e',
  peak: '#ff8a80',
  waterfall: '#67c8ff',
  lake: '#4da6ff',
  viewpoint: '#c792ea',
};

const POI_GLYPHS = {
  town: '●',
  trailhead: '▲',
  pass: '✕',
  peak: '⛰',
  waterfall: '💧',
  lake: '◆',
  viewpoint: '◉',
};

/**
 * Check if a tile (z, x, y) exists in a terraindata-style manifest.
 */
function hasTileInManifest(manifest, z, x, y) {
  const zEntry = manifest?.tiles?.[String(z)];
  if (!zEntry) return false;
  if (x < zEntry.xMin || x > zEntry.xMax || y < zEntry.yMin || y > zEntry.yMax) {
    return false;
  }
  if (zEntry.full) return true;
  const spans = zEntry.rows?.[String(y)];
  if (!Array.isArray(spans)) return false;
  for (let i = 0; i < spans.length; i += 2) {
    if (x >= spans[i] && x <= spans[i + 1]) return true;
  }
  return false;
}

/**
 * Create an interactive 2D pan/zoom San Juan map for Free Run start picking.
 */
export function createMap2D({ container, trailData, terrain, engine, getUnits, onPickLocation }) {
  const base = (engine?.assetsBase || '/telluride-trails/').replace(/\/?$/, '/');

  const wrap = document.createElement('div');
  wrap.className = 'map2d';
  wrap.innerHTML = `
    <canvas class="map2d__canvas" tabindex="0" aria-label="Interactive 2D map of Telluride and the San Juan Mountains. Drag to pan, scroll or pinch to zoom, click or tap any trail or point to start."></canvas>
    <div class="map2d__hud">
      <div class="map2d__legend" aria-hidden="true">
        <span><i style="background:#3ddc84"></i>Trailhead</span>
        <span><i style="background:#f4b942"></i>Town</span>
        <span><i style="background:#e65c2e"></i>Pass</span>
        <span><i style="background:#67c8ff"></i>Water</span>
      </div>
      <div class="map2d__controls">
        <button type="button" class="map2d__btn" data-action="zoom-in" aria-label="Zoom in">+</button>
        <button type="button" class="map2d__btn" data-action="zoom-out" aria-label="Zoom out">−</button>
        <button type="button" class="map2d__btn" data-action="reset" aria-label="Center on Telluride">⌖</button>
      </div>
    </div>
    <div class="map2d__hint">Tap a marker or any point on the map to snap to the nearest trail</div>
  `;
  container.appendChild(wrap);

  const canvas = wrap.querySelector('.map2d__canvas');
  const ctx = canvas.getContext('2d');

  // World bounds of playable bbox
  const sw = lonLatToWorld(BBOX.west, BBOX.south);
  const ne = lonLatToWorld(BBOX.east, BBOX.north);
  const worldCenterX = (sw.x + ne.x) * 0.5;
  const worldCenterZ = (sw.z + ne.z) * 0.5;

  // Camera state in world meters
  let viewX = 0; // Start centered on Telluride (0, 0)
  let viewZ = 0;
  let metersPerPx = 28; // ~7 km across a mobile screen
  const MIN_MPP = 1.8;
  const MAX_MPP = 180;

  let selectedPin = null; // { x, z, label }
  let disposed = false;
  let rafPending = false;

  // Manifests & tile caches
  let imageryManifest = null;
  let terrainManifest = null;
  let overviewMeta = null;
  let overviewImg = null;
  const imageryCache = new Map(); // key -> ImageBitmap | HTMLImageElement | 'loading' | null
  const reliefCache = new Map(); // key -> { canvas, heights: Float32Array, size: number } | 'loading' | null
  const MAX_TILE_CACHE = 84;

  function trimCache(map) {
    if (map.size <= MAX_TILE_CACHE) return;
    const keys = map.keys();
    while (map.size > MAX_TILE_CACHE) {
      const oldest = keys.next().value;
      map.delete(oldest);
    }
  }

  // Load instant shaded-relief + imagery overview for the full San Juan bbox
  fetch(`${base}data/imagery/overview.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((meta) => {
      if (!meta || disposed) return;
      overviewMeta = meta;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        if (disposed) return;
        overviewImg = img;
        scheduleDraw();
      };
      img.src = `${base}${meta.image || 'data/imagery/overview.webp'}`;
    })
    .catch(() => {});

  // Load manifests silently in background for high-zoom detail + elevation sampling
  fetch(`${base}data/imagery/manifest.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m && !disposed) {
        imageryManifest = m;
        scheduleDraw();
      }
    })
    .catch(() => {});

  fetch(`${base}data/terrain/manifest.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m && !disposed) {
        terrainManifest = m;
        scheduleDraw();
      }
    })
    .catch(() => {});

  // Also trigger initial loadArea around Telluride so trail lines appear on the map
  if (typeof trailData?.loadArea === 'function') {
    trailData.loadArea(0, 0, 12000).then(() => scheduleDraw()).catch(() => {});
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(100, Math.round(rect.width));
    const h = Math.max(100, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    scheduleDraw();
  }

  function worldToScreen(wx, wz) {
    const w = canvas.clientWidth || wrap.clientWidth || 320;
    const h = canvas.clientHeight || wrap.clientHeight || 320;
    return {
      sx: (wx - viewX) / metersPerPx + w * 0.5,
      sy: (wz - viewZ) / metersPerPx + h * 0.5,
    };
  }

  function screenToWorld(sx, sy) {
    const w = canvas.clientWidth || wrap.clientWidth || 320;
    const h = canvas.clientHeight || wrap.clientHeight || 320;
    return {
      wx: (sx - w * 0.5) * metersPerPx + viewX,
      wz: (sy - h * 0.5) * metersPerPx + viewZ,
    };
  }

  function pickZoomForMpp(manifest, mpp) {
    // Scaled Web Mercator width at Telluride lat (~37.94): ~31,605,000 m / 256 px = 123,457 m/px at z0
    const approxZ = Math.round(Math.log2(123457 / Math.max(0.5, mpp)));
    const minZ = manifest?.minZoom ?? 8;
    const maxZ = manifest?.maxZoom ?? 16;
    return Math.max(minZ, Math.min(maxZ, approxZ));
  }

  function requestImageryTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (imageryCache.has(key)) return imageryCache.get(key);
    if (!imageryManifest || !hasTileInManifest(imageryManifest, z, x, y)) {
      return null;
    }
    imageryCache.set(key, 'loading');
    const ext = imageryManifest.ext || 'webp';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      if (disposed) return;
      imageryCache.set(key, img);
      trimCache(imageryCache);
      scheduleDraw();
    };
    img.onerror = () => {
      imageryCache.set(key, null);
    };
    img.src = `${base}data/imagery/${z}/${x}/${y}.${ext}`;
    return 'loading';
  }

  function buildShadedReliefTile(img) {
    const S = 64; // fast downsample for crisp hillshade at 60fps
    const raw = document.createElement('canvas');
    raw.width = S;
    raw.height = S;
    const rctx = raw.getContext('2d', { willReadFrequently: true });
    rctx.drawImage(img, 0, 0, S, S);
    const data = rctx.getImageData(0, 0, S, S).data;

    const heights = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      heights[i] = r * 256 + g + b / 256 - 32768;
    }

    const out = document.createElement('canvas');
    out.width = S;
    out.height = S;
    const octx = out.getContext('2d');
    const outImg = octx.createImageData(S, S);
    const px = outImg.data;

    // NW directional light vector
    const lx = -0.62;
    const ly = -0.62;
    const lz = 0.48;
    const cellM = 38;

    for (let y = 0; y < S; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(S - 1, y + 1);
      for (let x = 0; x < S; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(S - 1, x + 1);
        const h = heights[y * S + x];
        const dzdx = (heights[y * S + x1] - heights[y * S + x0]) / ((x1 - x0) * cellM);
        const dzdy = (heights[y1 * S + x] - heights[y0 * S + x]) / ((y1 - y0) * cellM);
        const nx = -dzdx;
        const ny = -dzdy;
        const nz = 1.0;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        const shade = Math.max(0.18, Math.min(1.15, (nx * lx + ny * ly + nz * lz) / nLen + 0.3));

        // Hypsometric San Juan palette: valley pine -> subalpine -> alpine granite -> snow crest
        let cr, cg, cb;
        if (h < 2750) {
          cr = 42; cg = 74; cb = 58;
        } else if (h < 3350) {
          const t = (h - 2750) / 600;
          cr = 42 + t * 34; cg = 74 + t * 24; cb = 58 + t * 10;
        } else if (h < 3850) {
          const t = (h - 3350) / 500;
          cr = 76 + t * 62; cg = 98 + t * 38; cb = 68 + t * 52;
        } else {
          const t = Math.min(1, (h - 3850) / 450);
          cr = 138 + t * 88; cg = 136 + t * 92; cb = 120 + t * 112;
        }

        const idx = (y * S + x) * 4;
        px[idx] = Math.min(255, cr * shade);
        px[idx + 1] = Math.min(255, cg * shade);
        px[idx + 2] = Math.min(255, cb * shade);
        px[idx + 3] = 255;
      }
    }
    octx.putImageData(outImg, 0, 0);
    return { canvas: out, heights, size: S };
  }

  function requestReliefTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (reliefCache.has(key)) return reliefCache.get(key);
    if (!terrainManifest || !hasTileInManifest(terrainManifest, z, x, y)) {
      return null;
    }
    reliefCache.set(key, 'loading');
    const ext = terrainManifest.ext || 'webp';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => {
      if (disposed) return;
      try {
        const relief = buildShadedReliefTile(img);
        reliefCache.set(key, relief);
        trimCache(reliefCache);
        scheduleDraw();
      } catch {
        reliefCache.set(key, null);
      }
    };
    img.onerror = () => {
      reliefCache.set(key, null);
    };
    img.src = `${base}data/terrain/${z}/${x}/${y}.${ext}`;
    return 'loading';
  }

  function sampleCachedElevation(wx, wz) {
    // Prefer terrain.getHeight if resident and non-constant
    if (typeof terrain?.getHeight === 'function') {
      const h = terrain.getHeight(wx, wz);
      if (Number.isFinite(h) && h > 500) return h;
    }
    if (terrainManifest) {
      for (let z = terrainManifest.maxZoom ?? 14; z >= (terrainManifest.minZoom ?? 8); z--) {
        const t = worldToTile(wx, wz, z);
        const entry = reliefCache.get(`${z}/${t.x}/${t.y}`);
        if (entry && entry !== 'loading' && entry.heights) {
          const b = tileBoundsWorld(z, t.x, t.y);
          const u = Math.max(0, Math.min(0.999, (wx - b.minX) / (b.maxX - b.minX)));
          const v = Math.max(0, Math.min(0.999, (wz - b.minZ) / (b.maxZ - b.minZ)));
          const px = Math.floor(u * entry.size);
          const py = Math.floor(v * entry.size);
          return entry.heights[py * entry.size + px];
        }
      }
    }
    return 2667;
  }

  function drawPolyline(coords, stride = 3, closed = false) {
    if (!coords || coords.length < stride * 2) return;
    ctx.beginPath();
    for (let i = 0; i < coords.length; i += stride) {
      const { sx, sy } = worldToScreen(coords[i], coords[i + (stride === 3 ? 2 : 1)]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    if (closed) ctx.closePath();
  }

  function draw() {
    rafPending = false;
    if (disposed) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || wrap.clientWidth || 320;
    const h = canvas.clientHeight || wrap.clientHeight || 320;
    if (w < 10 || h < 10) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Base alpine slate background
    ctx.fillStyle = '#121d26';
    ctx.fillRect(0, 0, w, h);

    const topLeft = screenToWorld(0, 0);
    const botRight = screenToWorld(w, h);

    // 1. Render instant shaded-relief + imagery overview, plus high-zoom detail tiles when zoomed in
    if (overviewImg && overviewMeta?.worldBounds) {
      const wb = overviewMeta.worldBounds;
      const p0 = worldToScreen(wb.minX, wb.minZ);
      const p1 = worldToScreen(wb.maxX, wb.maxZ);
      ctx.drawImage(overviewImg, p0.sx, p0.sy, p1.sx - p0.sx, p1.sy - p0.sy);
    }

    const iZoom = imageryManifest ? pickZoomForMpp(imageryManifest, metersPerPx) : 13;

    if (imageryManifest && (metersPerPx < 22 || !overviewImg)) {
      const iMin = worldToTile(topLeft.wx, topLeft.wz, iZoom);
      const iMax = worldToTile(botRight.wx, botRight.wz, iZoom);
      const drawnImagery = new Set();
      if ((Math.abs(iMax.x - iMin.x) + 1) * (Math.abs(iMax.y - iMin.y) + 1) <= 64) {
        ctx.save();
        ctx.globalAlpha = overviewImg ? 0.85 : 0.92;
        for (let ty = Math.min(iMin.y, iMax.y); ty <= Math.max(iMin.y, iMax.y); ty++) {
          for (let tx = Math.min(iMin.x, iMax.x); tx <= Math.max(iMin.x, iMax.x); tx++) {
            const minZ = overviewImg ? 14 : (imageryManifest.minZoom ?? 8);
            for (let z = iZoom; z >= minZ; z--) {
              const shift = iZoom - z;
              const fx = tx >> shift;
              const fy = ty >> shift;
              if (!hasTileInManifest(imageryManifest, z, fx, fy)) continue;
              const k = `${z}/${fx}/${fy}`;
              if (drawnImagery.has(k)) break;
              const img = requestImageryTile(z, fx, fy);
              if (img && img !== 'loading') {
                drawnImagery.add(k);
                const b = tileBoundsWorld(z, fx, fy);
                const p0 = worldToScreen(b.minX, b.minZ);
                const p1 = worldToScreen(b.maxX, b.maxZ);
                ctx.drawImage(img, p0.sx, p0.sy, p1.sx - p0.sx + 0.6, p1.sy - p0.sy + 0.6);
                break;
              }
            }
          }
        }
        ctx.restore();
      }
    }

    // Request relief tile lazily around viewport center for accurate tap elevation fallback
    if (terrainManifest && !overviewImg) {
      const tZoom = pickZoomForMpp(terrainManifest, metersPerPx * 1.4);
      const tMin = worldToTile(topLeft.wx, topLeft.wz, tZoom);
      const tMax = worldToTile(botRight.wx, botRight.wz, tZoom);
      if ((Math.abs(tMax.x - tMin.x) + 1) * (Math.abs(tMax.y - tMin.y) + 1) <= 36) {
        for (let ty = Math.min(tMin.y, tMax.y); ty <= Math.max(tMin.y, tMax.y); ty++) {
          for (let tx = Math.min(tMin.x, tMax.x); tx <= Math.max(tMin.x, tMax.x); tx++) {
            const tile = requestReliefTile(tZoom, tx, ty);
            if (tile && tile !== 'loading' && tile.canvas) {
              const b = tileBoundsWorld(tZoom, tx, ty);
              const p0 = worldToScreen(b.minX, b.minZ);
              const p1 = worldToScreen(b.maxX, b.maxZ);
              ctx.drawImage(tile.canvas, p0.sx, p0.sy, p1.sx - p0.sx + 0.6, p1.sy - p0.sy + 0.6);
            }
          }
        }
      }
    }

    // 2. Subtle Topo Grid
    const gridStepM = metersPerPx > 45 ? 5000 : metersPerPx > 12 ? 2000 : 500;
    const gxStart = Math.floor(topLeft.wx / gridStepM) * gridStepM;
    const gzStart = Math.floor(topLeft.wz / gridStepM) * gridStepM;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = gxStart; x <= botRight.wx; x += gridStepM) {
      const { sx } = worldToScreen(x, 0);
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let z = gzStart; z <= botRight.wz; z += gridStepM) {
      const { sy } = worldToScreen(0, z);
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    // 3. Lakes & Waterways
    if (Array.isArray(trailData?.lakes)) {
      ctx.fillStyle = 'rgba(77, 166, 255, 0.45)';
      ctx.strokeStyle = 'rgba(103, 200, 255, 0.75)';
      ctx.lineWidth = 1.2;
      for (const lake of trailData.lakes) {
        if (!lake.coords) continue;
        drawPolyline(lake.coords, 3, true);
        ctx.fill();
        ctx.stroke();
      }
    }

    if (Array.isArray(trailData?.waterways)) {
      ctx.strokeStyle = 'rgba(103, 200, 255, 0.6)';
      ctx.lineWidth = metersPerPx < 15 ? 2 : 1.2;
      for (const ww of trailData.waterways) {
        if (!ww.coords) continue;
        drawPolyline(ww.coords, 3, false);
        ctx.stroke();
      }
    }

    // 4. Trails & Roads
    if (Array.isArray(trailData?.trails)) {
      for (const tr of trailData.trails) {
        if (!tr.coords) continue;
        const isRoad = tr.kind === 'road' || tr.kind === 'track';
        ctx.strokeStyle = isRoad ? 'rgba(220, 226, 232, 0.55)' : 'rgba(244, 185, 66, 0.75)';
        ctx.lineWidth = isRoad ? (metersPerPx < 12 ? 2.4 : 1.3) : (metersPerPx < 12 ? 2 : 1.2);
        ctx.setLineDash(isRoad ? [] : [4, 3]);
        drawPolyline(tr.coords, 3, false);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // 5. Race lines (Hardrock / classics) faintly shown as crimson/gold corridors
    if (Array.isArray(trailData?.races)) {
      ctx.strokeStyle = 'rgba(230, 92, 46, 0.42)';
      ctx.lineWidth = 2;
      for (const race of trailData.races) {
        if (!race.line || race.line.length < 6) continue;
        ctx.beginPath();
        for (let i = 0; i < race.line.length; i += 3) {
          const { sx, sy } = worldToScreen(race.line[i], race.line[i + 1]);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
    }

    // 6. POIs
    const pois = trailData?.pois || [];
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    const drawnLabels = [];
    for (const poi of pois) {
      const { sx, sy } = worldToScreen(poi.x, poi.z);
      if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) continue;

      const color = POI_COLORS[poi.kind] || '#e8eef6';
      ctx.beginPath();
      ctx.arc(sx, sy, poi.kind === 'town' ? 6 : 4.8, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#0d151c';
      ctx.stroke();

      // Declutter labels so towns & trailheads get priority
      const priority = poi.kind === 'town' || poi.kind === 'trailhead' || poi.kind === 'pass';
      if (metersPerPx < 55 || priority) {
        const collides = drawnLabels.some(
          (b) => Math.abs(b.sx - sx) < 92 && Math.abs(b.sy - sy) < 18
        );
        if (!collides) {
          drawnLabels.push({ sx, sy });
          ctx.fillStyle = 'rgba(13, 21, 28, 0.78)';
          const textW = ctx.measureText(poi.name).width;
          ctx.fillRect(sx + 8, sy - 9, textW + 8, 18);
          ctx.fillStyle = '#f4f6f8';
          ctx.fillText(poi.name, sx + 12, sy);
        }
      }
    }

    // 7. Selected pin
    if (selectedPin) {
      const { sx, sy } = worldToScreen(selectedPin.x, selectedPin.z);
      ctx.beginPath();
      ctx.arc(sx, sy, 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(230, 92, 46, 0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#e65c2e';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    // 8. Scale bar
    const targetPx = 76;
    const rawM = targetPx * metersPerPx;
    const niceSteps = [50, 100, 250, 500, 1000, 2000, 5000, 10000];
    const barM = niceSteps.find((s) => s >= rawM * 0.7) || 10000;
    const barPx = barM / metersPerPx;
    const units = getUnits?.() || 'imperial';
    const barLabel =
      units === 'metric'
        ? barM >= 1000
          ? `${barM / 1000} km`
          : `${barM} m`
        : `${(barM / 1609.344).toFixed(barM < 1000 ? 2 : 1)} mi`;

    ctx.fillStyle = 'rgba(13,21,28,0.72)';
    ctx.fillRect(10, h - 28, barPx + 16, 20);
    ctx.strokeStyle = '#f4f6f8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(18, h - 14);
    ctx.lineTo(18 + barPx, h - 14);
    ctx.stroke();
    ctx.fillStyle = '#f4f6f8';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(barLabel, 18, h - 21);

    ctx.restore();
  }

  function scheduleDraw() {
    if (rafPending || disposed) return;
    rafPending = true;
    requestAnimationFrame(draw);
  }

  function clampView() {
    const pad = 8000;
    const minX = Math.min(sw.x, ne.x) - pad;
    const maxX = Math.max(sw.x, ne.x) + pad;
    const minZ = Math.min(sw.z, ne.z) - pad;
    const maxZ = Math.max(sw.z, ne.z) + pad;
    viewX = Math.max(minX, Math.min(maxX, viewX));
    viewZ = Math.max(minZ, Math.min(maxZ, viewZ));
  }

  function handleTap(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { wx, wz } = screenToWorld(sx, sy);

    // 1. Check nearby POI within 20px screen hit radius
    let hitPoi = null;
    let bestPx = 22;
    for (const poi of trailData?.pois || []) {
      const p = worldToScreen(poi.x, poi.z);
      const d = Math.hypot(p.sx - sx, p.sy - sy);
      if (d < bestPx) {
        bestPx = d;
        hitPoi = poi;
      }
    }

    if (hitPoi) {
      selectedPin = { x: hitPoi.x, z: hitPoi.z, label: hitPoi.name };
      scheduleDraw();
      onPickLocation?.({
        x: hitPoi.x,
        z: hitPoi.z,
        y: Number.isFinite(hitPoi.y) ? hitPoi.y : sampleCachedElevation(hitPoi.x, hitPoi.z),
        name: hitPoi.name,
        kind: hitPoi.kind || 'poi',
        area: hitPoi.area || 'San Juans',
        description: hitPoi.description || '',
        heading: hitPoi.heading || 0,
        snapped: true,
        trailName: hitPoi.name,
        snapDistM: 0,
      });
      return;
    }

    // 2. Snap any tapped map point to nearest trail
    const snap = typeof trailData?.nearest === 'function' ? trailData.nearest(wx, wz, 1200) : null;
    const px = snap ? snap.x : wx;
    const pz = snap ? snap.z : wz;
    const elevM = sampleCachedElevation(px, pz);
    const { lon, lat } = worldToLonLat(px, pz);
    const heading =
      snap && (snap.tx || snap.tz) ? Math.atan2(-snap.tx, -snap.tz) : 0;

    selectedPin = { x: px, z: pz, label: snap?.name || 'Custom Drop' };
    scheduleDraw();

    onPickLocation?.({
      x: px,
      z: pz,
      y: elevM,
      name: snap?.name || `Custom Pin (${lat.toFixed(3)}°, ${lon.toFixed(3)}°)`,
      kind: snap ? snap.kind || 'trail' : 'off-trail',
      area: `${lat.toFixed(3)}°N, ${Math.abs(lon).toFixed(3)}°W`,
      heading,
      snapped: Boolean(snap),
      trailName: snap?.name || (snap ? 'Unnamed Trail' : 'Off-Trail Alpine'),
      snapDistM: snap ? Math.hypot(px - wx, pz - wz) : 0,
      elevLabel: fmtElev(elevM, getUnits?.() || 'imperial'),
    });
  }

  // Pointer pan + pinch-zoom state
  const pointers = new Map();
  let dragStart = null;
  let movedDist = 0;
  let lastPinchDist = 0;

  function onPointerDown(e) {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragStart = { x: e.clientX, y: e.clientY, vx: viewX, vz: viewZ };
      movedDist = 0;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      lastPinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      dragStart = null;
    }
  }

  function onPointerMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (lastPinchDist > 0 && d > 0) {
        const factor = lastPinchDist / d;
        metersPerPx = Math.max(MIN_MPP, Math.min(MAX_MPP, metersPerPx * factor));
        scheduleDraw();
      }
      lastPinchDist = d;
      return;
    }

    if (pointers.size === 1 && dragStart) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      movedDist = Math.max(movedDist, Math.hypot(dx, dy));
      viewX = dragStart.vx - dx * metersPerPx;
      viewZ = dragStart.vz - dy * metersPerPx;
      clampView();
      scheduleDraw();
    }
  }

  function onPointerUp(e) {
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) lastPinchDist = 0;
    if (wasSingle && dragStart && movedDist < 7) {
      handleTap(e.clientX, e.clientY);
    }
    if (pointers.size === 0) dragStart = null;
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const before = screenToWorld(sx, sy);
    const factor = e.deltaY > 0 ? 1.18 : 0.85;
    metersPerPx = Math.max(MIN_MPP, Math.min(MAX_MPP, metersPerPx * factor));
    const after = screenToWorld(sx, sy);
    viewX += before.wx - after.wx;
    viewZ += before.wz - after.wz;
    clampView();
    scheduleDraw();
  }

  function onKeyDown(e) {
    const step = 60 * metersPerPx;
    if (e.key === 'ArrowLeft') { viewX -= step; clampView(); scheduleDraw(); }
    else if (e.key === 'ArrowRight') { viewX += step; clampView(); scheduleDraw(); }
    else if (e.key === 'ArrowUp') { viewZ -= step; clampView(); scheduleDraw(); }
    else if (e.key === 'ArrowDown') { viewZ += step; clampView(); scheduleDraw(); }
    else if (e.key === '+' || e.key === '=') { metersPerPx = Math.max(MIN_MPP, metersPerPx * 0.8); scheduleDraw(); }
    else if (e.key === '-') { metersPerPx = Math.min(MAX_MPP, metersPerPx * 1.25); scheduleDraw(); }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('keydown', onKeyDown);

  wrap.querySelectorAll('.map2d__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.action;
      if (act === 'zoom-in') metersPerPx = Math.max(MIN_MPP, metersPerPx * 0.72);
      else if (act === 'zoom-out') metersPerPx = Math.min(MAX_MPP, metersPerPx * 1.38);
      else if (act === 'reset') {
        viewX = 0;
        viewZ = 0;
        metersPerPx = 28;
      }
      clampView();
      scheduleDraw();
    });
  });

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  // Re-draw when vector chunks stream in
  const unsubChunk = engine?.events?.on?.('data:chunk', () => scheduleDraw());

  return {
    focusPoint(x, z, mpp = 12) {
      viewX = x;
      viewZ = z;
      metersPerPx = Math.max(MIN_MPP, Math.min(MAX_MPP, mpp));
      selectedPin = { x, z, label: '' };
      if (typeof trailData?.loadArea === 'function') {
        trailData.loadArea(x, z, 6000).then(() => scheduleDraw()).catch(() => {});
      }
      clampView();
      scheduleDraw();
    },
    refresh: scheduleDraw,
    dispose() {
      disposed = true;
      ro.disconnect();
      if (unsubChunk) unsubChunk();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      wrap.remove();
    },
  };
}
