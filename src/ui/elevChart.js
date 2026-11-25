import { sampleDem } from './demSampler.js';
import { fmtDist, fmtElev } from './format.js';

/**
 * Sample elevation profile points for a race.
 * Priority:
 * 1. `race.elevations` if pre-computed
 * 2. Real USGS 3DEP `sampleDem(x, z)` along `race.line` (covers full San Juan bbox)
 * 3. `terrain.getHeight(x, z)` if resident & varied
 * 4. Representative fallback while coarse DEM is still downloading (< 200 ms on first open)
 * @param {object} race
 * @param {object} terrain
 * @returns {Array<{ dM: number, elevM: number }>}
 */
export function getRaceProfile(race, terrain) {
  const line = race?.line;
  const stride = 3;
  const count = line ? Math.floor(line.length / stride) : 0;
  const totalM =
    count > 0 && line[(count - 1) * stride + 2] > 0
      ? line[(count - 1) * stride + 2]
      : (race?.distanceMi || 10) * 1609.344;
  const samples = 96;

  if (Array.isArray(race?.elevations) && race.elevations.length >= 2) {
    return race.elevations.map((elevM, i) => ({
      dM: (i / (race.elevations.length - 1)) * totalM,
      elevM,
    }));
  }

  if (count >= 2) {
    // Prefer real z10 Terrarium DEM across the entire San Juans
    const demPts = [];
    let demMin = Infinity;
    let demMax = -Infinity;
    for (let i = 0; i < samples; i++) {
      const targetD = (i / (samples - 1)) * totalM;
      // Binary search cumulative distance along race.line
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (line[mid * stride + 2] < targetD) lo = mid + 1;
        else hi = mid;
      }
      const idx1 = lo;
      const idx0 = Math.max(0, idx1 - 1);
      const d0 = line[idx0 * stride + 2];
      const d1 = line[idx1 * stride + 2];
      const t = d1 > d0 ? (targetD - d0) / (d1 - d0) : 0;
      const x = line[idx0 * stride] + (line[idx1 * stride] - line[idx0 * stride]) * t;
      const z = line[idx0 * stride + 1] + (line[idx1 * stride + 1] - line[idx0 * stride + 1]) * t;

      let h = sampleDem(x, z);
      if (h == null && typeof terrain?.getHeight === 'function') {
        const th = terrain.getHeight(x, z);
        if (Number.isFinite(th)) h = th;
      }
      if (h != null && Number.isFinite(h)) {
        if (h < demMin) demMin = h;
        if (h > demMax) demMax = h;
        demPts.push({ dM: targetD, elevM: h });
      }
    }
    if (demPts.length >= 16 && demMax - demMin > 25) {
      return demPts;
    }
  }

  // Fallback representative alpine profile (only shown for ~150 ms before z10 DEM loads)
  const baseM = 2670;
  const gainM = Math.max(200, (race?.gainFt || 2500) / 3.28084);
  const peaks = Math.max(1, Math.min(6, Math.round(gainM / 950)));
  const amp = Math.min(1450, Math.max(320, gainM / peaks));

  const pts = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const dM = t * totalM;
    const wave =
      peaks === 1
        ? Math.sin(t * Math.PI)
        : Math.abs(Math.sin(t * Math.PI * peaks)) * 0.85 + 0.15 * Math.sin(t * Math.PI * (peaks * 2 + 1));
    pts.push({ dM, elevM: baseM + wave * amp });
  }
  return pts;
}

/**
 * Create an accessible SVG elevation profile chart element.
 * @param {object} opts
 * @param {object} opts.race
 * @param {object} opts.terrain
 * @param {'imperial'|'metric'} opts.units
 * @returns {HTMLElement}
 */
export function createElevationChart({ race, terrain, units = 'imperial' }) {
  const pts = getRaceProfile(race, terrain);
  const totalM = Math.max(1, pts[pts.length - 1]?.dM || (race.distanceMi || 10) * 1609.344);

  let minE = Infinity;
  let maxE = -Infinity;
  for (const p of pts) {
    if (p.elevM < minE) minE = p.elevM;
    if (p.elevM > maxE) maxE = p.elevM;
  }
  const isEaster = Boolean(race?.easterEgg);
  const pad = Math.max(isEaster ? 18 : 40, (maxE - minE) * 0.14);
  const yMin = minE - pad * 0.4;
  const yMax = maxE + pad;
  const ySpan = Math.max(10, yMax - yMin);

  const W = 400;
  const H = 104;
  const L = 6;
  const R = W - 6;
  const T = 14;
  const B = H - 18;

  const toX = (dM) => L + (dM / totalM) * (R - L);
  const toY = (e) => B - ((e - yMin) / ySpan) * (B - T);

  const linePoints = pts.map((p) => `${toX(p.dM).toFixed(1)},${toY(p.elevM).toFixed(1)}`).join(' ');
  const areaPath =
    `M ${toX(pts[0].dM).toFixed(1)},${B} ` +
    pts.map((p) => `L ${toX(p.dM).toFixed(1)},${toY(p.elevM).toFixed(1)}`).join(' ') +
    ` L ${toX(pts[pts.length - 1].dM).toFixed(1)},${B} Z`;

  const gradId = `elev-grad-${String(race.id || 'race').replace(/[^a-z0-9_-]/gi, '')}`;
  const strokeColor = isEaster ? '#00b2a9' : '#f4b942';
  const gradTopColor = isEaster ? '#00b2a9' : '#f4b942';
  const gradBotColor = isEaster ? '#c4ced4' : '#e65c2e';

  const cps = (race.checkpoints || []).slice(0, 12);
  const cpSvg = cps
    .map((cp) => {
      const cx = toX(Math.min(totalM, Math.max(0, cp.d ?? 0)));
      return `<line x1="${cx.toFixed(1)}" y1="${T}" x2="${cx.toFixed(1)}" y2="${B}" stroke="rgba(255,255,255,0.16)" stroke-dasharray="2 3" />`;
    })
    .join('');

  const fig = document.createElement('figure');
  fig.className = 'elev-chart';
  fig.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="elev-chart__svg" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${gradTopColor}" stop-opacity="0.48" />
          <stop offset="100%" stop-color="${gradBotColor}" stop-opacity="0.06" />
        </linearGradient>
      </defs>
      <line x1="${L}" y1="${T}" x2="${R}" y2="${T}" stroke="rgba(255,255,255,0.08)" />
      <line x1="${L}" y1="${(T + B) / 2}" x2="${R}" y2="${(T + B) / 2}" stroke="rgba(255,255,255,0.06)" />
      <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="rgba(255,255,255,0.14)" />
      ${cpSvg}
      <path d="${areaPath}" fill="url(#${gradId})" />
      <polyline points="${linePoints}" fill="none" stroke="${strokeColor}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
      <text x="${L + 2}" y="${T - 3}" fill="rgba(244,246,248,0.72)" font-size="9" font-weight="600">High ${fmtElev(maxE, units)}</text>
      <text x="${R - 2}" y="${B + 12}" text-anchor="end" fill="rgba(244,246,248,0.65)" font-size="9">${fmtDist(totalM, units, 1)}</text>
      <text x="${L + 2}" y="${B + 12}" fill="rgba(244,246,248,0.65)" font-size="9">Low ${fmtElev(minE, units)}</text>
    </svg>
    <figcaption class="visually-hidden">
      Elevation profile for ${race.name}: distance ${fmtDist(totalM, units, 1)}, elevation range ${fmtElev(minE, units)} to ${fmtElev(maxE, units)}.
    </figcaption>
  `;
  return fig;
}
