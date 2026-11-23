import {
  fmtClock,
  fmtCompass,
  fmtDist,
  fmtDurationHuman,
  fmtElev,
  fmtPace,
  fmtRealTimeFinishEta,
  fmtShortDist,
  fmtVert,
} from './format.js';

/**
 * In-game HUD: telemetry, race bar, minimap/compass, toast queue, and photo mode overlay.
 */
export function createHUD({ container, engine, trailData, getSettings, onPause, onVibrate }) {
  const wrap = document.createElement('div');
  wrap.className = 'hud-layer';
  wrap.hidden = true;
  wrap.innerHTML = `
    <div class="hud-top-area">
      <header class="hud-top">
        <div class="hud-trail-pill">
          <span class="hud-trail-name">Telluride Trail</span>
          <span class="hud-surface-badge" data-surface="trail">Trail</span>
          <span class="hud-time-badge" hidden></span>
          <span class="hud-storm-badge" hidden>⛈️ Ridge Storm</span>
        </div>

        <div class="hud-top-actions">
          <div class="hud-compass" aria-label="Compass heading">
            <span class="hud-compass__dir">N</span>
            <span class="hud-compass__deg">000°</span>
          </div>
          <button type="button" class="hud-icon-btn" data-hud-act="camera" aria-label="Switch camera view">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            <span class="hud-cam-label">Chase</span>
          </button>
          <button type="button" class="hud-icon-btn" data-hud-act="photo" aria-label="Toggle photo mode">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          </button>
          <button type="button" class="hud-icon-btn hud-icon-btn--pause" data-hud-act="pause" aria-label="Pause run">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          </button>
        </div>
      </header>

      <div class="hud-sub-row">
        <section class="hud-stats" aria-label="Runner telemetry">
          <div class="hud-stat">
            <span class="hud-stat__label">Pace</span>
            <span class="hud-stat__val" data-field="pace">--:--</span>
          </div>
          <div class="hud-stat">
            <span class="hud-stat__label">Distance</span>
            <span class="hud-stat__val" data-field="dist">0.00 mi</span>
          </div>
          <div class="hud-stat">
            <span class="hud-stat__label">Vert</span>
            <span class="hud-stat__val" data-field="vert">+0 ft</span>
          </div>
          <div class="hud-stat">
            <span class="hud-stat__label">Elev / Grade</span>
            <span class="hud-stat__val" data-field="elev">8,750 ft · 0%</span>
          </div>

          <div class="hud-meters">
            <div class="hud-meter" data-meter="stamina">
              <span class="hud-meter__label">⚡ Stamina</span>
              <div class="hud-meter__track"><div class="hud-meter__fill" style="--pct: 100%"></div></div>
            </div>
            <div class="hud-meter" data-meter="hydration">
              <span class="hud-meter__label">💧 Water</span>
              <div class="hud-meter__track"><div class="hud-meter__fill" style="--pct: 100%"></div></div>
            </div>
          </div>
          <div class="hud-gait-badge" data-field="gait" hidden></div>
        </section>

        <section class="hud-race-bar" hidden aria-label="Race progress">
          <div class="hud-race-bar__main">
            <span class="hud-race-clock" data-field="raceClock">0:00:00</span>
            <span class="hud-dilation-badge" hidden></span>
            <span class="hud-race-aid" data-field="nextAid">Next Aid: --</span>
          </div>
          <div class="hud-race-bar__sub">
            <span data-field="finishEta">Est. finish: --</span>
            <span data-field="cutoff"></span>
          </div>
        </section>
      </div>
    </div>

    <aside class="hud-minimap" aria-label="Trail minimap">
      <canvas class="hud-minimap__canvas" width="136" height="136"></canvas>
      <span class="hud-minimap__north" aria-hidden="true">N</span>
    </aside>

    <div class="hud-toasts" aria-live="polite" aria-atomic="false"></div>

    <div class="photo-bar" hidden>
      <button type="button" class="btn btn--primary" data-photo="snap">📸 Save Snapshot</button>
      <button type="button" class="btn btn--ghost" data-photo="exit">Exit Photo Mode (H)</button>
    </div>
  `;
  container.appendChild(wrap);

  const trailNameEl = wrap.querySelector('.hud-trail-name');
  const surfaceEl = wrap.querySelector('.hud-surface-badge');
  const timeEl = wrap.querySelector('.hud-time-badge');
  const stormEl = wrap.querySelector('.hud-storm-badge');
  const compassDirEl = wrap.querySelector('.hud-compass__dir');
  const compassDegEl = wrap.querySelector('.hud-compass__deg');
  const camLabelEl = wrap.querySelector('.hud-cam-label');

  const paceEl = wrap.querySelector('[data-field="pace"]');
  const distEl = wrap.querySelector('[data-field="dist"]');
  const vertEl = wrap.querySelector('[data-field="vert"]');
  const elevEl = wrap.querySelector('[data-field="elev"]');
  const gaitEl = wrap.querySelector('[data-field="gait"]');
  const staminaFill = wrap.querySelector('[data-meter="stamina"] .hud-meter__fill');
  const staminaMeter = wrap.querySelector('[data-meter="stamina"]');
  const hydrationFill = wrap.querySelector('[data-meter="hydration"] .hud-meter__fill');
  const hydrationMeter = wrap.querySelector('[data-meter="hydration"]');

  const raceBarEl = wrap.querySelector('.hud-race-bar');
  const raceClockEl = wrap.querySelector('[data-field="raceClock"]');
  const dilationBadgeEl = wrap.querySelector('.hud-dilation-badge');
  const nextAidEl = wrap.querySelector('[data-field="nextAid"]');
  const finishEtaEl = wrap.querySelector('[data-field="finishEta"]');
  const cutoffEl = wrap.querySelector('[data-field="cutoff"]');

  const minimapCanvas = wrap.querySelector('.hud-minimap__canvas');
  const minimapCtx = minimapCanvas.getContext('2d');
  const toastsEl = wrap.querySelector('.hud-toasts');
  const photoBarEl = wrap.querySelector('.photo-bar');

  let photoMode = false;
  let lastMinimapDrawMs = 0;
  let activeTimeScale = 1;
  let lastHudData = null;

  function showToast(text, tone = 'info', durationMs = 4500) {
    if (!text) return;
    const toast = document.createElement('div');
    toast.className = `hud-toast hud-toast--${tone}`;
    toast.textContent = text;
    toastsEl.appendChild(toast);

    // Keep max 3 stacked toasts
    while (toastsEl.children.length > 3) {
      toastsEl.firstElementChild.remove();
    }

    requestAnimationFrame(() => toast.classList.add('is-visible'));
    setTimeout(() => {
      toast.classList.remove('is-visible');
      setTimeout(() => toast.remove(), 260);
    }, durationMs);
  }

  function setPhotoMode(on) {
    photoMode = Boolean(on);
    wrap.classList.toggle('is-photo-mode', photoMode);
    photoBarEl.hidden = !photoMode;
  }

  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.hudAct;
    if (act === 'pause') {
      onVibrate?.(10);
      onPause?.();
    } else if (act === 'camera') {
      onVibrate?.(8);
      engine.events.emit('input:camera-toggle');
    } else if (act === 'photo') {
      onVibrate?.(8);
      setPhotoMode(!photoMode);
    } else if (btn.dataset.photo === 'exit') {
      setPhotoMode(false);
    } else if (btn.dataset.photo === 'snap') {
      const gameCanvas = document.getElementById('game-canvas');
      if (gameCanvas) {
        try {
          const url = gameCanvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = url;
          a.download = `telluride-trails-${Date.now()}.png`;
          a.click();
          showToast('Snapshot saved!', 'ok', 2500);
        } catch {
          showToast('Could not capture snapshot on this browser.', 'warn', 3000);
        }
      }
    }
  });

  // Keyboard shortcut 'H' for photo mode
  const onKeyDown = (e) => {
    if (wrap.hidden) return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'KeyH') {
      setPhotoMode(!photoMode);
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const unsubCam = engine.events.on('camera:mode', ({ mode }) => {
    const labels = { chase: 'Chase', orbit: 'Orbit', 'first-person': '1st Person' };
    camLabelEl.textContent = labels[mode] || mode;
  });

  const unsubDilation = engine.events.on('ui:timeDilation', ({ scale }) => {
    activeTimeScale = Number(scale) || 1;
    if (activeTimeScale > 1) {
      dilationBadgeEl.hidden = false;
      dilationBadgeEl.textContent = `${activeTimeScale}× *`;
    } else {
      dilationBadgeEl.hidden = true;
    }
  });

  function drawMinimap(data) {
    const now = performance.now();
    if (now - lastMinimapDrawMs < 80) return;
    lastMinimapDrawMs = now;

    const W = minimapCanvas.width;
    const H = minimapCanvas.height;
    const cx = W * 0.5;
    const cy = H * 0.5;
    const px = data.x ?? 0;
    const pz = data.z ?? 0;
    const scale = 0.12; // 1 px ~ 8.3 m -> ~560 m radius visible

    minimapCtx.clearRect(0, 0, W, H);
    minimapCtx.fillStyle = 'rgba(12, 20, 28, 0.86)';
    minimapCtx.fillRect(0, 0, W, H);

    // Subtle range rings
    minimapCtx.strokeStyle = 'rgba(255,255,255,0.08)';
    minimapCtx.lineWidth = 1;
    minimapCtx.beginPath();
    minimapCtx.arc(cx, cy, W * 0.25, 0, Math.PI * 2);
    minimapCtx.arc(cx, cy, W * 0.44, 0, Math.PI * 2);
    minimapCtx.stroke();

    const toMini = (wx, wz) => ({
      x: cx + (wx - px) * scale,
      y: cy + (wz - pz) * scale,
    });

    // Nearby trails
    if (Array.isArray(trailData?.trails)) {
      for (const tr of trailData.trails) {
        if (!tr.coords || tr.coords.length < 6) continue;
        minimapCtx.strokeStyle =
          tr.kind === 'road' || tr.kind === 'track'
            ? 'rgba(220, 226, 232, 0.45)'
            : 'rgba(244, 185, 66, 0.72)';
        minimapCtx.lineWidth = 1.6;
        minimapCtx.beginPath();
        let started = false;
        for (let i = 0; i < tr.coords.length; i += 3) {
          const pt = toMini(tr.coords[i], tr.coords[i + 2]);
          if (!started) {
            minimapCtx.moveTo(pt.x, pt.y);
            started = true;
          } else {
            minimapCtx.lineTo(pt.x, pt.y);
          }
        }
        minimapCtx.stroke();
      }
    }

    // Active race line
    const raceLine = data.race?.line || trailData?.races?.find((r) => r.id === data.race?.id)?.line;
    if (raceLine && raceLine.length >= 6) {
      minimapCtx.strokeStyle = '#e65c2e';
      minimapCtx.lineWidth = 2.4;
      minimapCtx.beginPath();
      for (let i = 0; i < raceLine.length; i += 3) {
        const pt = toMini(raceLine[i], raceLine[i + 1]);
        if (i === 0) minimapCtx.moveTo(pt.x, pt.y);
        else minimapCtx.lineTo(pt.x, pt.y);
      }
      minimapCtx.stroke();
    }

    // Next aid marker
    if (data.race?.nextAidPos) {
      const ap = toMini(data.race.nextAidPos.x, data.race.nextAidPos.z);
      minimapCtx.fillStyle = '#3ddc84';
      minimapCtx.beginPath();
      minimapCtx.arc(ap.x, ap.y, 4, 0, Math.PI * 2);
      minimapCtx.fill();
    }

    // Runner directional arrow (heading=0 is -Z North = up on minimap)
    const heading = data.heading ?? 0;
    minimapCtx.save();
    minimapCtx.translate(cx, cy);
    minimapCtx.rotate(-heading);
    minimapCtx.fillStyle = '#ffffff';
    minimapCtx.strokeStyle = '#e65c2e';
    minimapCtx.lineWidth = 2;
    minimapCtx.beginPath();
    minimapCtx.moveTo(0, -7);
    minimapCtx.lineTo(5, 6);
    minimapCtx.lineTo(0, 3);
    minimapCtx.lineTo(-5, 6);
    minimapCtx.closePath();
    minimapCtx.fill();
    minimapCtx.stroke();
    minimapCtx.restore();
  }

  function update(data) {
    if (!data) return;
    lastHudData = data;
    const units = getSettings?.()?.units || 'imperial';

    // Trail + surface + weather
    trailNameEl.textContent = data.trailName || (data.onTrail === false ? 'Off-Trail San Juans' : 'San Juan Trail');
    const surfaceLabel =
      data.onTrail === false
        ? '⚠ Off-Trail'
        : data.surfaceLabel || data.surface || 'Trail';
    surfaceEl.textContent = String(surfaceLabel);
    surfaceEl.dataset.surface = data.onTrail === false ? 'offtrail' : String(data.surface || 'trail').toLowerCase();

    if (data.localTimeStr) {
      timeEl.hidden = false;
      timeEl.textContent = data.localTimeStr;
    } else {
      timeEl.hidden = true;
    }

    const showStorm = Boolean(data.stormActive) || (data.stormRisk ?? 0) > 0.55;
    stormEl.hidden = !showStorm;
    if (showStorm) {
      stormEl.textContent = data.stormActive ? '⛈️ Monsoon Active!' : '⚡ Ridge Storm Risk';
    }

    // Compass
    const comp = fmtCompass(data.heading ?? 0);
    compassDirEl.textContent = comp.cardinal;
    compassDegEl.textContent = `${String(comp.deg).padStart(3, '0')}°`;

    // Telemetry
    paceEl.textContent = fmtPace(data, units);
    const distM = data.distM ?? data.distanceM ?? 0;
    const vertM = data.vertGainM ?? data.vertM ?? 0;
    const elevM = data.elevM ?? data.elevationM ?? 2667;
    const gradePct = Math.round((data.grade ?? 0) * 100);
    distEl.textContent = fmtDist(distM, units, 2);
    vertEl.textContent = fmtVert(vertM, units);
    elevEl.textContent = `${fmtElev(elevM, units)} · ${gradePct >= 0 ? '+' : ''}${gradePct}%`;

    // Stamina & Hydration
    const stam = Math.max(0, Math.min(1, data.stamina ?? data.energy ?? 1));
    const hyd = Math.max(0, Math.min(1, data.hydration ?? 1));
    staminaFill.style.setProperty('--pct', `${Math.round(stam * 100)}%`);
    staminaMeter.dataset.warn = stam < 0.25 ? 'low' : 'ok';
    hydrationFill.style.setProperty('--pct', `${Math.round(hyd * 100)}%`);
    hydrationMeter.dataset.warn = hyd < 0.25 ? 'low' : 'ok';

    // Gait / altitude badge
    if (data.gait || (data.altitudeFactor && data.altitudeFactor < 0.9)) {
      gaitEl.hidden = false;
      const parts = [];
      if (data.gait) parts.push(String(data.gait).toUpperCase());
      if (data.altitudeFactor && data.altitudeFactor < 0.9) parts.push('🏔 Thin Air');
      gaitEl.textContent = parts.join(' · ');
    } else {
      gaitEl.hidden = true;
    }

    // Race bar
    const race = data.race;
    if (race && (data.mode?.startsWith?.('race') || race.id)) {
      raceBarEl.hidden = false;
      raceClockEl.textContent = fmtClock(race.clockSec ?? race.clockS ?? data.elapsedSec ?? 0);
      const dilated = Boolean(data.timeDilated || race.timeDilated || (data.timeScale && data.timeScale > 1));
      if (dilated) {
        dilationBadgeEl.hidden = false;
        dilationBadgeEl.textContent = `${data.timeScale || activeTimeScale || '?'}× *`;
      } else if (activeTimeScale <= 1) {
        dilationBadgeEl.hidden = true;
      }

      if (race.nextAidName) {
        const aidDist = fmtShortDist(race.nextAidDistM ?? 0, units);
        const aidEtaSec = race.etaSec ?? race.nextAidEtaS;
        const aidEta = aidEtaSec ? ` (~${fmtDurationHuman(aidEtaSec)})` : '';
        nextAidEl.textContent = `Next: ${race.nextAidName} · ${aidDist}${aidEta}`;
      } else {
        nextAidEl.textContent = race.checkpointIdx !== undefined
          ? `Checkpoint ${race.checkpointIdx}/${race.totalCheckpoints || '?'}`
          : 'On Course';
      }
      if (race.etaJoke || race.finishEtaStr || race.etaLabel) {
        finishEtaEl.textContent = race.etaJoke || race.finishEtaStr || race.etaLabel;
      } else if (Number.isFinite(race.remainingSec)) {
        finishEtaEl.textContent = fmtRealTimeFinishEta(race.remainingSec);
      } else {
        finishEtaEl.textContent = 'Real-time clock running';
      }
      if (Number.isFinite(race.cutoffRemainingSec)) {
        cutoffEl.textContent = `Cutoff in ${fmtDurationHuman(race.cutoffRemainingSec)}`;
      } else if (race.cutoffH) {
        cutoffEl.textContent = `Cutoff ${race.cutoffH}h`;
      } else {
        cutoffEl.textContent = '';
      }
    } else {
      raceBarEl.hidden = true;
    }

    drawMinimap(data);
  }

  return {
    update,
    showToast,
    setPhotoMode,
    isPhotoMode: () => photoMode,
    refreshUnits() {
      if (lastHudData) update(lastHudData);
    },
    setVisible(visible) {
      wrap.hidden = !visible;
      if (!visible) setPhotoMode(false);
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      unsubCam();
      unsubDilation();
      wrap.remove();
    },
  };
}
