import { fmtDist, fmtElev } from './format.js';

/**
 * Sample elevation profile points for a race.
 * Uses `race.elevations` if provided, else samples `terrain.getHeight` along `race.line`
 * if terrain has variation, else builds a representative alpine profile matching `race.gainFt`.
 * @param {object} race
 * @param {object} terrain
 * @returns {Array<{ dM: number, elevM: number, name?: string }>}
 */
export function getRaceProfile(race, terrain) {
  const totalM = (race?.distanceMi || 10) * 1609.344;
  const samples = 72;

  if (Array.isArray(race?.elevations) && race.elevations.length >= 2) {
    return race.elevations.map((elevM, i) => ({
      dM: (i / (race.elevations.length - 1)) * totalM,
      elevM,
    }));
  }

  const line = race?.line;
  if (line && line.length >= 6 && typeof terrain?.getHeight === 'function') {
    const pts = [];
    const stride = 3;
    const count = Math.floor(line.length / stride);
    let minE = Infinity;
    let maxE = -Infinity;
    for (let i = 0; i < samples; i++) {
      const idx = Math.min(count - 1, Math.round((i / (samples - 1)) * (count - 1)));
      const x = line[idx * stride];
      const z = line[idx * stride + 1];
      const dM = line[idx * stride + 2] ?? (i / (samples - 1)) * totalM;
      const h = terrain.getHeight(x, z);
      if (Number.isFinite(h)) {
        minE = Math.min(minE, h);
        maxE = Math.max(maxE, h);
        pts.push({ dM, elevM: h });
      }
    }
    if (pts.length >= 10 && maxE - minE > 25) {
      return pts;
    }
  }

  // Fallback representative alpine profile (until distant terrain tiles stream in)
  const baseM = 2670; // ~8,760 ft Telluride/Silverton valley floor
  const gainM = Math.max(200, (race?.gainFt || 2500) / 3.28084);
  const cps = race?.checkpoints || [];
  const peaks = Math.max(1, Math.min(6, Math.round(gainM / 950)));
  const amp = Math.min(1450, Math.max(320, gainM / peaks));

  const pts = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const dM = t * totalM;
    let wave = 0;
    if (peaks === 1) {
      // Point-to-point climb or up-and-down
      const isOneWay = (race?.id || '').includes('imogene') || (race?.id || '').includes('rundola');
      wave = isOneWay ? Math.pow(t, 0.9) * (race.id.includes('imogene') ? Math.sin(t * Math.PI * 0.72) : 1) : Math.sin(t * Math.PI);
    } else {
      wave = Math.abs(Math.sin(t * Math.PI * peaks)) * 0.85 + 0.15 * Math.sin(t * Math.PI * (peaks * 2 + 1));
    }
    let elevM = baseM + wave * amp;
    // Anchor near checkpoint elevations if supplied
    for (const cp of cps) {
      if (Number.isFinite(cp.elevM) || Number.isFinite(cp.y)) {
        const cpD = cp.d ?? 0;
        const dist = Math.abs(dM - cpD) / Math.max(1, totalM * 0.12);
        if (dist < 1) {
          const target = cp.elevM ?? cp.y;
          elevM = elevM * dist + target * (1 - dist);
        }
      }
    }
    pts.push({ dM, elevM });
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
  const pad = Math.max(40, (maxE - minE) * 0.14);
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
  const areaPath = `M ${toX(pts[0].dM).toFixed(1)},${B} ` +
    pts.map((p) => `L ${toX(p.dM).toFixed(1)},${toY(p.elevM).toFixed(1)}`).join(' ') +
    ` L ${toX(pts[pts.length - 1].dM).toFixed(1)},${B} Z`;

  const gradId = `elev-grad-${String(race.id || 'race').replace(/[^a-z0-9_-]/gi, '')}`;

  const cps = (race.checkpoints || []).slice(0, 8);
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
          <stop offset="0%" stop-color="#f4b942" stop-opacity="0.48" />
          <stop offset="100%" stop-color="#e65c2e" stop-opacity="0.04" />
        </linearGradient>
      </defs>
      <line x1="${L}" y1="${T}" x2="${R}" y2="${T}" stroke="rgba(255,255,255,0.08)" />
      <line x1="${L}" y1="${(T + B) / 2}" x2="${R}" y2="${(T + B) / 2}" stroke="rgba(255,255,255,0.06)" />
      <line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="rgba(255,255,255,0.14)" />
      ${cpSvg}
      <path d="${areaPath}" fill="url(#${gradId})" />
      <polyline points="${linePoints}" fill="none" stroke="#f4b942" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" />
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
