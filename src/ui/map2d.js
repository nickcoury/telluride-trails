import {
  BBOX,
  lonLatToWorld,
  worldToLonLat,
  tileBoundsWorld,
  worldToTile,
} from '../core/geo.js';
import { ensureDemLoaded, getFeatureBounds, sampleDem } from './demSampler.js';
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
      <div class="map2d__legend-wrap">
        <button type="button" class="map2d__legend-toggle" aria-expanded="false">Legend ▾</button>
        <div class="map2d__legend" aria-hidden="true">
          <span><i style="background:#3ddc84"></i>Trailhead</span>
          <span><i style="background:#f4b942"></i>Town</span>
          <span><i style="background:#e65c2e"></i>Pass</span>
          <span><i style="background:#ff8a80"></i>Peak</span>
          <span><i style="background:#67c8ff"></i>Water</span>
          <span><i style="background:#c792ea"></i>Viewpoint</span>
        </div>
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
  const legendWrap = wrap.querySelector('.map2d__legend-wrap');
  const legendToggleBtn = wrap.querySelector('.map2d__legend-toggle');
  let legendOpen = false;
  legendToggleBtn?.addEventListener('click', () => {
    legendOpen = !legendOpen;
    legendWrap.classList.toggle('is-open', legendOpen);
    legendToggleBtn.setAttribute('aria-expanded', String(legendOpen));
    legendToggleBtn.textContent = legendOpen ? 'Legend ▴' : 'Legend ▾';
    scheduleDraw();
  });

  // World bounds of playable bbox
  const sw = lonLatToWorld(BBOX.west, BBOX.south);
  const ne = lonLatToWorld(BBOX.east, BBOX.north);

  // Camera state in world meters (start centered on Telluride)
  let viewX = 0;
  let viewZ = 0;
  let metersPerPx = 28;
  const MIN_MPP = 1.8;
  const MAX_MPP = 180;

  let selectedPin = null;
  let disposed = false;
  let rafPending = false;
  let streamTimer = null;

  // Manifests & tile caches
  let imageryManifest = null;
  let overviewMeta = null;
  let overviewImg = null;
  const imageryCache = new Map();
  const MAX_TILE_CACHE = 84;

  function trimCache(map) {
    if (map.size <= MAX_TILE_CACHE) return;
    const keys = map.keys();
    while (map.size > MAX_TILE_CACHE) {
      map.delete(keys.next().value);
    }
  }

  // Load instant shaded-relief + imagery overview FIRST (high priority so it paints immediately)
  fetch(`${base}data/imagery/overview.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((meta) => {
      if (!meta || disposed) return;
      overviewMeta = meta;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.fetchPriority = 'high';
      img.onload = () => {
        if (disposed) return;
        overviewImg = img;
        scheduleDraw();
      };
      img.src = `${base}${meta.image || 'data/imagery/overview.webp'}`;
    })
    .catch(() => {});

  // Defer coarse DEM preload slightly so overview.webp & vector chunks paint first
  const demWarmTimer = setTimeout(() => {
    if (!disposed) ensureDemLoaded(base).catch(() => {});
  }, 450);

  fetch(`${base}data/imagery/manifest.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m && !disposed) {
        imageryManifest = m;
        scheduleDraw();
      }
    })
    .catch(() => {});

  function scheduleVectorStream() {
    if (typeof trailData?.loadArea !== 'function' || disposed) return;
    if (streamTimer) clearTimeout(streamTimer);
    streamTimer = setTimeout(() => {
      if (disposed) return;
      const radius = Math.min(12000, Math.max(3500, metersPerPx * 280));
      trailData.loadArea(viewX, viewZ, radius).then(() => scheduleDraw()).catch(() => {});
    }, 180);
  }
  scheduleVectorStream();

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

  function sampleBestElevation(wx, wz) {
    const demH = sampleDem(wx, wz);
    if (demH !== null && Number.isFinite(demH)) return demH;
    if (typeof terrain?.getHeight === 'function') {
      const h = terrain.getHeight(wx, wz);
      if (Number.isFinite(h) && h > 500) return h;
    }
    return 2667;
  }

  function draw() {
    rafPending = false;
    if (disposed) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || wrap.clientWidth || 320;
    const h = canvas.clientHeight || wrap.clientHeight || 320;
    if (w < 10 || h < 10) return;

    const halfW = w * 0.5;
    const halfH = h * 0.5;
    const invMpp = 1 / metersPerPx;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#121d26';
    ctx.fillRect(0, 0, w, h);

    const topLeft = screenToWorld(0, 0);
    const botRight = screenToWorld(w, h);
    const minWX = Math.min(topLeft.wx, botRight.wx);
    const maxWX = Math.max(topLeft.wx, botRight.wx);
    const minWZ = Math.min(topLeft.wz, botRight.wz);
    const maxWZ = Math.max(topLeft.wz, botRight.wz);

    // 1. Instant shaded-relief + imagery overview + high-zoom tiles when zoomed in
    if (overviewImg && overviewMeta?.worldBounds) {
      const wb = overviewMeta.worldBounds;
      const x0 = (wb.minX - viewX) * invMpp + halfW;
      const y0 = (wb.minZ - viewZ) * invMpp + halfH;
      const x1 = (wb.maxX - viewX) * invMpp + halfW;
      const y1 = (wb.maxZ - viewZ) * invMpp + halfH;
      ctx.drawImage(overviewImg, x0, y0, x1 - x0, y1 - y0);
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
                const x0 = (b.minX - viewX) * invMpp + halfW;
                const y0 = (b.minZ - viewZ) * invMpp + halfH;
                const x1 = (b.maxX - viewX) * invMpp + halfW;
                const y1 = (b.maxZ - viewZ) * invMpp + halfH;
                ctx.drawImage(img, x0, y0, x1 - x0 + 0.6, y1 - y0 + 0.6);
                break;
              }
            }
          }
        }
        ctx.restore();
      }
    }

    // 2. Subtle Topo Grid
    const gridStepM = metersPerPx > 45 ? 5000 : metersPerPx > 12 ? 2000 : 500;
    const gxStart = Math.floor(minWX / gridStepM) * gridStepM;
    const gzStart = Math.floor(minWZ / gridStepM) * gridStepM;
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = gxStart; x <= maxWX; x += gridStepM) {
      const sx = (x - viewX) * invMpp + halfW;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let z = gzStart; z <= maxWZ; z += gridStepM) {
      const sy = (z - viewZ) * invMpp + halfH;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.stroke();

    const step3 = metersPerPx > 40 ? 9 : 3;

    // 3. Lakes & Waterways (AABB-culled & batched)
    if (Array.isArray(trailData?.lakes) && trailData.lakes.length > 0) {
      ctx.fillStyle = 'rgba(77, 166, 255, 0.45)';
      ctx.strokeStyle = 'rgba(103, 200, 255, 0.75)';
      ctx.lineWidth = 1.2;
      for (let l = 0; l < trailData.lakes.length; l++) {
        const lake = trailData.lakes[l];
        const b = getFeatureBounds(lake, 2, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const c = lake.coords;
        if (!c || c.length < 6) continue;
        ctx.beginPath();
        ctx.moveTo((c[0] - viewX) * invMpp + halfW, (c[2] - viewZ) * invMpp + halfH);
        for (let i = 3; i < c.length; i += 3) {
          ctx.lineTo((c[i] - viewX) * invMpp + halfW, (c[i + 2] - viewZ) * invMpp + halfH);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    if (Array.isArray(trailData?.waterways) && trailData.waterways.length > 0) {
      ctx.strokeStyle = 'rgba(103, 200, 255, 0.6)';
      ctx.lineWidth = metersPerPx < 15 ? 2 : 1.2;
      ctx.beginPath();
      let anyWater = false;
      for (let wIdx = 0; wIdx < trailData.waterways.length; wIdx++) {
        const ww = trailData.waterways[wIdx];
        const b = getFeatureBounds(ww, 2, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const c = ww.coords;
        if (!c || c.length < 6) continue;
        ctx.moveTo((c[0] - viewX) * invMpp + halfW, (c[2] - viewZ) * invMpp + halfH);
        for (let i = step3; i < c.length; i += step3) {
          ctx.lineTo((c[i] - viewX) * invMpp + halfW, (c[i + 2] - viewZ) * invMpp + halfH);
        }
        const last = c.length - 3;
        ctx.lineTo((c[last] - viewX) * invMpp + halfW, (c[last + 2] - viewZ) * invMpp + halfH);
        anyWater = true;
      }
      if (anyWater) ctx.stroke();
    }

    // 4. Trails & Roads (AABB-culled & batched into 2 strokes total)
    if (Array.isArray(trailData?.trails) && trailData.trails.length > 0) {
      const trails = trailData.trails;

      ctx.strokeStyle = 'rgba(220, 226, 232, 0.55)';
      ctx.lineWidth = metersPerPx < 12 ? 2.4 : 1.3;
      ctx.beginPath();
      let anyRoad = false;
      for (let t = 0; t < trails.length; t++) {
        const tr = trails[t];
        if (tr.kind !== 'road' && tr.kind !== 'track') continue;
        const b = getFeatureBounds(tr, 2, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const c = tr.coords;
        ctx.moveTo((c[0] - viewX) * invMpp + halfW, (c[2] - viewZ) * invMpp + halfH);
        for (let i = step3; i < c.length; i += step3) {
          ctx.lineTo((c[i] - viewX) * invMpp + halfW, (c[i + 2] - viewZ) * invMpp + halfH);
        }
        const last = c.length - 3;
        ctx.lineTo((c[last] - viewX) * invMpp + halfW, (c[last + 2] - viewZ) * invMpp + halfH);
        anyRoad = true;
      }
      if (anyRoad) ctx.stroke();

      ctx.strokeStyle = 'rgba(244, 185, 66, 0.78)';
      ctx.lineWidth = metersPerPx < 12 ? 2 : 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      let anyTrail = false;
      for (let t = 0; t < trails.length; t++) {
        const tr = trails[t];
        if (tr.kind === 'road' || tr.kind === 'track') continue;
        const b = getFeatureBounds(tr, 2, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const c = tr.coords;
        ctx.moveTo((c[0] - viewX) * invMpp + halfW, (c[2] - viewZ) * invMpp + halfH);
        for (let i = step3; i < c.length; i += step3) {
          ctx.lineTo((c[i] - viewX) * invMpp + halfW, (c[i + 2] - viewZ) * invMpp + halfH);
        }
        const last = c.length - 3;
        ctx.lineTo((c[last] - viewX) * invMpp + halfW, (c[last + 2] - viewZ) * invMpp + halfH);
        anyTrail = true;
      }
      if (anyTrail) ctx.stroke();
      ctx.setLineDash([]);
    }

    // 5. Race lines (AABB-culled & batched)
    if (Array.isArray(trailData?.races) && trailData.races.length > 0) {
      ctx.strokeStyle = 'rgba(230, 92, 46, 0.42)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let anyRace = false;
      const rStep = metersPerPx > 35 ? 12 : 3;
      for (let r = 0; r < trailData.races.length; r++) {
        const race = trailData.races[r];
        const b = getFeatureBounds(race, 1, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const line = race.line;
        if (!line || line.length < 6) continue;
        ctx.moveTo((line[0] - viewX) * invMpp + halfW, (line[1] - viewZ) * invMpp + halfH);
        for (let i = rStep; i < line.length; i += rStep) {
          ctx.lineTo((line[i] - viewX) * invMpp + halfW, (line[i + 1] - viewZ) * invMpp + halfH);
        }
        const last = line.length - 3;
        ctx.lineTo((line[last] - viewX) * invMpp + halfW, (line[last + 1] - viewZ) * invMpp + halfH);
        anyRace = true;
      }
      if (anyRace) ctx.stroke();
    }

    // 6. POIs (priority-sorted + exact screen-space AABB collision culling + UI overlay exclusion)
    const pois = trailData?.pois || [];
    const KIND_RANK = {
      town: 0,
      trailhead: 1,
      pass: 2,
      peak: 3,
      waterfall: 4,
      lake: 5,
      viewpoint: 6,
    };
    const visiblePois = [];
    for (let i = 0; i < pois.length; i++) {
      const poi = pois[i];
      const sx = (poi.x - viewX) * invMpp + halfW;
      const sy = (poi.z - viewZ) * invMpp + halfH;
      if (sx < -24 || sx > w + 24 || sy < -24 || sy > h + 24) continue;
      visiblePois.push({ poi, sx, sy, rank: KIND_RANK[poi.kind] ?? 7 });
    }
    visiblePois.sort((a, b) => a.rank - b.rank || (b.poi.freeRun ? 1 : 0) - (a.poi.freeRun ? 1 : 0));

    // Draw all visible marker dots first
    for (let i = visiblePois.length - 1; i >= 0; i--) {
      const { poi, sx, sy } = visiblePois[i];
      const color = POI_COLORS[poi.kind] || '#e8eef6';
      ctx.beginPath();
      ctx.arc(sx, sy, poi.kind === 'town' ? 6 : 4.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = '#0d151c';
      ctx.stroke();
    }

    // Reserve UI overlay exclusion boxes (legend top-left, zoom buttons top-right, hint/scale bottom-left)
    const isMobileCompact = w < 680;
    const legendBoxW = isMobileCompact && !legendOpen ? 98 : Math.min(w - 60, 410);
    const legendBoxH = isMobileCompact && legendOpen ? 92 : 48;
    const placedBoxes = [
      { x0: 0, y0: 0, x1: legendBoxW, y1: legendBoxH },
      { x0: w - 62, y0: 0, x1: w, y1: 162 },
      { x0: 0, y0: h - 76, x1: Math.min(w, 410), y1: h },
    ];

    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < visiblePois.length; i++) {
      const { poi, sx, sy, rank } = visiblePois[i];
      if (metersPerPx >= 55 && rank > 2) continue;
      if (sx < 8 || sx > w - 8 || sy < 14 || sy > h - 14) continue;

      const textW = ctx.measureText(poi.name).width;
      const boxW = textW + 10;
      const boxH = 18;
      // Place label to the right of marker, or flip to left if near right edge
      const placeLeft = sx + 9 + boxW > w - 8;
      const bx0 = placeLeft ? sx - 9 - boxW : sx + 9;
      const by0 = sy - boxH * 0.5;
      const candidate = {
        x0: Math.min(sx - 7, bx0 - 3),
        y0: by0 - 2,
        x1: Math.max(sx + 7, bx0 + boxW + 3),
        y1: by0 + boxH + 2,
      };
      if (candidate.x0 < 4 || candidate.x1 > w - 4) continue;

      let collides = false;
      for (let j = 0; j < placedBoxes.length; j++) {
        const b = placedBoxes[j];
        if (candidate.x0 < b.x1 && candidate.x1 > b.x0 && candidate.y0 < b.y1 && candidate.y1 > b.y0) {
          collides = true;
          break;
        }
      }
      if (collides) continue;

      placedBoxes.push(candidate);
      ctx.fillStyle = 'rgba(13, 21, 28, 0.82)';
      ctx.fillRect(bx0, by0, boxW, boxH);
      ctx.fillStyle = '#f4f6f8';
      ctx.fillText(poi.name, bx0 + 5, sy);
    }

    // 7. Selected pin
    if (selectedPin) {
      const sx = (selectedPin.x - viewX) * invMpp + halfW;
      const sy = (selectedPin.z - viewZ) * invMpp + halfH;
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
    const barPx = barM * invMpp;
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

  async function handleTap(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const { wx, wz } = screenToWorld(sx, sy);

    // 1. Check nearby POI within 22px screen hit radius
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
        y: Number.isFinite(hitPoi.y) ? hitPoi.y : sampleBestElevation(hitPoi.x, hitPoi.z),
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

    // 2. Ensure vector chunk at tapped location is resident before snapping to nearest trail!
    if (typeof trailData?.loadArea === 'function') {
      try {
        await Promise.all([trailData.loadArea(wx, wz, 2200), ensureDemLoaded(base)]);
      } catch {
        // ignore offline/chunk errors
      }
    }
    if (disposed) return;

    const snap = typeof trailData?.nearest === 'function' ? trailData.nearest(wx, wz, 1200) : null;
    const px = snap ? snap.x : wx;
    const pz = snap ? snap.z : wz;
    const elevM = sampleBestElevation(px, pz);
    const { lon, lat } = worldToLonLat(px, pz);
    const heading = snap && (snap.tx || snap.tz) ? Math.atan2(-snap.tx, -snap.tz) : 0;

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
    try {
      canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore synthetic or inactive pointer ids
    }
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
        scheduleVectorStream();
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
      scheduleVectorStream();
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
    scheduleVectorStream();
  }

  function onKeyDown(e) {
    const step = 60 * metersPerPx;
    if (e.key === 'ArrowLeft') { viewX -= step; clampView(); scheduleDraw(); scheduleVectorStream(); }
    else if (e.key === 'ArrowRight') { viewX += step; clampView(); scheduleDraw(); scheduleVectorStream(); }
    else if (e.key === 'ArrowUp') { viewZ -= step; clampView(); scheduleDraw(); scheduleVectorStream(); }
    else if (e.key === 'ArrowDown') { viewZ += step; clampView(); scheduleDraw(); scheduleVectorStream(); }
    else if (e.key === '+' || e.key === '=') { metersPerPx = Math.max(MIN_MPP, metersPerPx * 0.8); scheduleDraw(); scheduleVectorStream(); }
    else if (e.key === '-') { metersPerPx = Math.min(MAX_MPP, metersPerPx * 1.25); scheduleDraw(); scheduleVectorStream(); }
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
      scheduleVectorStream();
    });
  });

  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  resize();

  const unsubChunk = engine?.events?.on?.('data:chunk', () => scheduleDraw());
  const unsubEvict = engine?.events?.on?.('data:evict', () => scheduleDraw());

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
      clearTimeout(demWarmTimer);
      if (streamTimer) clearTimeout(streamTimer);
      ro.disconnect();
      if (unsubChunk) unsubChunk();
      if (unsubEvict) unsubEvict();
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
