import { getFeatureBounds } from './demSampler.js';
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

function setText(el, val) {
  if (el._prevText !== val) {
    el._prevText = val;
    el.textContent = val;
  }
}

function setHidden(el, hidden) {
  const b = Boolean(hidden);
  if (el.hidden !== b) el.hidden = b;
}

/**
 * In-game HUD: telemetry, race bar, AABB-culled minimap/compass, toast queue, and photo mode overlay.
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
      <span class="photo-bar__hint">Drag to orbit · Scroll/pinch to zoom</span>
      <button type="button" class="btn btn--primary btn--sm" data-photo="snap">📸 Save Snapshot</button>
      <button type="button" class="btn btn--ghost btn--sm" data-photo="exit">Exit Photo Mode (H)</button>
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
  let prevCamModeBeforePhoto = 'chase';
  let lastMinimapDrawMs = 0;
  let lastMiniX = NaN;
  let lastMiniZ = NaN;
  let lastMiniHeading = NaN;
  let lastMiniTrailCount = -1;
  let activeTimeScale = 1;
  let lastHudData = null;
  let lastStamPct = -1;
  let lastHydPct = -1;

  function showToast(text, tone = 'info', durationMs = 4500) {
    if (!text) return;
    const toast = document.createElement('div');
    toast.className = `hud-toast hud-toast--${tone}`;
    toast.textContent = text;
    toastsEl.appendChild(toast);

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
    const next = Boolean(on);
    if (photoMode === next) return;
    photoMode = next;
    wrap.classList.toggle('is-photo-mode', photoMode);
    photoBarEl.hidden = !photoMode;
    if (photoMode) {
      const cur = engine.cameraRig?.getMode?.() || 'chase';
      if (cur !== 'photo') prevCamModeBeforePhoto = cur;
      engine.cameraRig?.setMode?.('photo');
    } else if (engine.cameraRig?.getMode?.() === 'photo') {
      engine.cameraRig?.setMode?.(prevCamModeBeforePhoto || 'chase');
    }
    engine.events.emit('ui:photoMode', { enabled: photoMode });
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
          // Force synchronous render before reading WebGL buffer (preserveDrawingBuffer is false)
          if (engine.renderer && engine.scene && engine.camera) {
            engine.renderer.render(engine.scene, engine.camera);
          }
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
    if (e.repeat || wrap.hidden) return;
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'KeyH') {
      setPhotoMode(!photoMode);
    }
  };
  window.addEventListener('keydown', onKeyDown);

  const unsubCam = engine.events.on('camera:mode', ({ mode }) => {
    const labels = { chase: 'Chase', orbit: 'Orbit', 'first-person': '1st Person', photo: 'Photo' };
    setText(camLabelEl, labels[mode] || mode);
  });

  const unsubDilation = engine.events.on('ui:timeDilation', ({ scale }) => {
    activeTimeScale = Number(scale) || 1;
    if (activeTimeScale > 1) {
      setHidden(dilationBadgeEl, false);
      setText(dilationBadgeEl, `${activeTimeScale}× *`);
    } else {
      setHidden(dilationBadgeEl, true);
    }
  });

  function drawMinimap(data, force = false) {
    if (photoMode) return;
    const now = performance.now();
    if (!force && now - lastMinimapDrawMs < 200) return;

    const px = data.x ?? 0;
    const pz = data.z ?? 0;
    const heading = data.heading ?? 0;
    const trailList = trailData?.trails;
    const trailCount = Array.isArray(trailList) ? trailList.length : 0;

    if (
      !force &&
      Number.isFinite(lastMiniX) &&
      Math.hypot(px - lastMiniX, pz - lastMiniZ) < 2.0 &&
      Math.abs(heading - lastMiniHeading) < 0.035 &&
      trailCount === lastMiniTrailCount
    ) {
      return;
    }

    lastMinimapDrawMs = now;
    lastMiniX = px;
    lastMiniZ = pz;
    lastMiniHeading = heading;
    lastMiniTrailCount = trailCount;

    const W = minimapCanvas.width;
    const H = minimapCanvas.height;
    const cx = W * 0.5;
    const cy = H * 0.5;
    const scale = 0.12; // 1 px ~ 8.33 m -> 566 m radius
    const viewRadiusM = 620;
    const minWX = px - viewRadiusM;
    const maxWX = px + viewRadiusM;
    const minWZ = pz - viewRadiusM;
    const maxWZ = pz + viewRadiusM;

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

    // AABB-culled & batched nearby trails (2 draw calls total, zero object allocs)
    if (trailCount > 0) {
      // Pass 1: roads & 4x4 tracks
      minimapCtx.strokeStyle = 'rgba(220, 226, 232, 0.45)';
      minimapCtx.lineWidth = 1.5;
      minimapCtx.beginPath();
      let hasRoads = false;
      for (let t = 0; t < trailCount; t++) {
        const tr = trailList[t];
        if (tr.kind !== 'road' && tr.kind !== 'track') continue;
        const b = getFeatureBounds(tr, 2, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const c = tr.coords;
        minimapCtx.moveTo(cx + (c[0] - px) * scale, cy + (c[2] - pz) * scale);
        for (let i = 3; i < c.length; i += 3) {
          minimapCtx.lineTo(cx + (c[i] - px) * scale, cy + (c[i + 2] - pz) * scale);
        }
        hasRoads = true;
      }
      if (hasRoads) minimapCtx.stroke();

      // Pass 2: singletrack trails & paths
      minimapCtx.strokeStyle = 'rgba(244, 185, 66, 0.75)';
      minimapCtx.lineWidth = 1.6;
      minimapCtx.beginPath();
      let hasTrails = false;
      for (let t = 0; t < trailCount; t++) {
        const tr = trailList[t];
        if (tr.kind === 'road' || tr.kind === 'track') continue;
        const b = getFeatureBounds(tr, 2, 3);
        if (!b || b.maxX < minWX || b.minX > maxWX || b.maxZ < minWZ || b.minZ > maxWZ) continue;
        const c = tr.coords;
        minimapCtx.moveTo(cx + (c[0] - px) * scale, cy + (c[2] - pz) * scale);
        for (let i = 3; i < c.length; i += 3) {
          minimapCtx.lineTo(cx + (c[i] - px) * scale, cy + (c[i + 2] - pz) * scale);
        }
        hasTrails = true;
      }
      if (hasTrails) minimapCtx.stroke();
    }

    // Active race line (Liang-Barsky 2D box segment clipping so long segments crossing view never drop)
    const raceObj = data.race?.id ? trailData?.races?.find((r) => r.id === data.race.id) : null;
    const raceLine = data.race?.line || raceObj?.line;
    if (raceLine && raceLine.length >= 6) {
      minimapCtx.strokeStyle = '#e65c2e';
      minimapCtx.lineWidth = 2.4;
      minimapCtx.beginPath();
      const clipR = 720;
      let anySeg = false;
      for (let i = 0; i <= raceLine.length - 6; i += 3) {
        const x0 = raceLine[i] - px;
        const z0 = raceLine[i + 1] - pz;
        const x1 = raceLine[i + 3] - px;
        const z1 = raceLine[i + 4] - pz;
        if (
          (x0 < -clipR && x1 < -clipR) ||
          (x0 > clipR && x1 > clipR) ||
          (z0 < -clipR && z1 < -clipR) ||
          (z0 > clipR && z1 > clipR)
        ) {
          continue;
        }
        // Liang-Barsky clip against [-clipR, clipR]^2
        let t0 = 0;
        let t1 = 1;
        const dx = x1 - x0;
        const dz = z1 - z0;
        const checks = [
          [-dx, x0 + clipR],
          [dx, clipR - x0],
          [-dz, z0 + clipR],
          [dz, clipR - z0],
        ];
        let reject = false;
        for (let k = 0; k < 4; k++) {
          const p = checks[k][0];
          const q = checks[k][1];
          if (p === 0) {
            if (q < 0) {
              reject = true;
              break;
            }
          } else {
            const r = q / p;
            if (p < 0) {
              if (r > t1) { reject = true; break; }
              if (r > t0) t0 = r;
            } else {
              if (r < t0) { reject = true; break; }
              if (r < t1) t1 = r;
            }
          }
        }
        if (reject) continue;
        minimapCtx.moveTo(cx + (x0 + dx * t0) * scale, cy + (z0 + dz * t0) * scale);
        minimapCtx.lineTo(cx + (x0 + dx * t1) * scale, cy + (z0 + dz * t1) * scale);
        anySeg = true;
      }
      if (anySeg) minimapCtx.stroke();
    }

    // Next aid marker
    const nextCp =
      data.race?.nextAidPos ||
      (raceObj?.checkpoints && data.race?.checkpointIdx != null
        ? raceObj.checkpoints[data.race.checkpointIdx]
        : null);
    if (nextCp && Number.isFinite(nextCp.x) && Number.isFinite(nextCp.z)) {
      const ax = cx + (nextCp.x - px) * scale;
      const ay = cy + (nextCp.z - pz) * scale;
      if (ax >= -6 && ax <= W + 6 && ay >= -6 && ay <= H + 6) {
        minimapCtx.fillStyle = '#3ddc84';
        minimapCtx.beginPath();
        minimapCtx.arc(ax, ay, 4.2, 0, Math.PI * 2);
        minimapCtx.fill();
      }
    }

    // Runner directional arrow (heading=0 is -Z North = up on minimap)
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
    setText(
      trailNameEl,
      data.trailName || (data.onTrail === false ? 'Off-Trail San Juans' : 'San Juan Trail')
    );
    const surfaceLabel =
      data.onTrail === false ? '⚠ Off-Trail' : data.surfaceLabel || data.surface || 'Trail';
    setText(surfaceEl, String(surfaceLabel));
    const surfKey = data.onTrail === false ? 'offtrail' : String(data.surface || 'trail').toLowerCase();
    if (surfaceEl.dataset.surface !== surfKey) surfaceEl.dataset.surface = surfKey;

    if (data.localTimeStr) {
      setHidden(timeEl, false);
      setText(timeEl, data.localTimeStr);
    } else {
      setHidden(timeEl, true);
    }

    const showStorm = Boolean(data.stormActive) || (data.stormRisk ?? 0) > 0.55;
    setHidden(stormEl, !showStorm);
    if (showStorm) {
      setText(stormEl, data.stormActive ? '⛈️ Monsoon Active!' : '⚡ Ridge Storm Risk');
    }

    // Compass
    const comp = fmtCompass(data.heading ?? 0);
    setText(compassDirEl, comp.cardinal);
    setText(compassDegEl, `${String(comp.deg).padStart(3, '0')}°`);

    // Telemetry
    setText(paceEl, fmtPace(data, units));
    const distM = data.distM ?? data.distanceM ?? 0;
    const vertM = data.vertGainM ?? data.vertM ?? 0;
    const elevM = data.elevM ?? data.elevationM ?? 2667;
    const gradePct = Math.round((data.grade ?? 0) * 100);
    setText(distEl, fmtDist(distM, units, 2));
    setText(vertEl, fmtVert(vertM, units));
    setText(elevEl, `${fmtElev(elevM, units)} · ${gradePct >= 0 ? '+' : ''}${gradePct}%`);

    // Stamina & Hydration
    const stamPct = Math.round(Math.max(0, Math.min(1, data.stamina ?? 1)) * 100);
    const hydPct = Math.round(Math.max(0, Math.min(1, data.hydration ?? 1)) * 100);
    if (stamPct !== lastStamPct) {
      lastStamPct = stamPct;
      staminaFill.style.setProperty('--pct', `${stamPct}%`);
      staminaMeter.dataset.warn = stamPct < 25 ? 'low' : 'ok';
    }
    if (hydPct !== lastHydPct) {
      lastHydPct = hydPct;
      hydrationFill.style.setProperty('--pct', `${hydPct}%`);
      hydrationMeter.dataset.warn = hydPct < 25 ? 'low' : 'ok';
    }

    // Gait / altitude badge
    if (data.gait || (data.altitudeFactor && data.altitudeFactor < 0.9)) {
      setHidden(gaitEl, false);
      const parts = [];
      if (data.gait) parts.push(String(data.gait).toUpperCase());
      if (data.altitudeFactor && data.altitudeFactor < 0.9) parts.push('🏔 Thin Air');
      setText(gaitEl, parts.join(' · '));
    } else {
      setHidden(gaitEl, true);
    }

    // Race bar
    const race = data.race;
    if (race && (data.mode?.startsWith?.('race') || race.id)) {
      setHidden(raceBarEl, false);
      const clockSec = race.clockSec ?? race.clockS ?? data.elapsedSec ?? 0;
      setText(raceClockEl, fmtClock(clockSec));
      const dilated = Boolean(
        data.timeDilated || race.timeDilated || (data.timeScale && data.timeScale > 1)
      );
      if (dilated) {
        setHidden(dilationBadgeEl, false);
        setText(dilationBadgeEl, `${data.timeScale || activeTimeScale || '?'}× *`);
      } else if (activeTimeScale <= 1) {
        setHidden(dilationBadgeEl, true);
      }

      if (race.nextAidName) {
        const aidDist = fmtShortDist(race.nextAidDistM ?? 0, units);
        const aidEtaSec = race.etaSec ?? race.nextAidEtaS;
        const aidEta = aidEtaSec ? ` (~${fmtDurationHuman(aidEtaSec)})` : '';
        setText(nextAidEl, `Next: ${race.nextAidName} · ${aidDist}${aidEta}`);
      } else {
        setText(
          nextAidEl,
          race.checkpointIdx !== undefined
            ? `Checkpoint ${race.checkpointIdx}/${race.totalCheckpoints || '?'}`
            : 'On Course'
        );
      }
      if (race.etaJoke || race.finishEtaStr || race.etaLabel) {
        setText(finishEtaEl, race.etaJoke || race.finishEtaStr || race.etaLabel);
      } else if (Number.isFinite(race.remainingSec ?? race.etaS)) {
        setText(finishEtaEl, fmtRealTimeFinishEta(race.remainingSec ?? race.etaS));
      } else {
        setText(finishEtaEl, 'Real-time clock running');
      }

      const remCutoff = Number.isFinite(race.cutoffRemainingSec)
        ? race.cutoffRemainingSec
        : Number.isFinite(race.cutoffSec ?? race.nextAidCutoffS)
          ? (race.cutoffSec ?? race.nextAidCutoffS) - clockSec
          : null;
      if (remCutoff !== null) {
        setText(cutoffEl, `Cutoff in ${fmtDurationHuman(Math.max(0, remCutoff))}`);
      } else if (race.cutoffH) {
        setText(cutoffEl, `Cutoff ${race.cutoffH}h`);
      } else {
        setText(cutoffEl, '');
      }
    } else {
      setHidden(raceBarEl, true);
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
