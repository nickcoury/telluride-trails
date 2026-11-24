import { fmtClock, fmtDist, fmtElev, fmtPace, fmtVert } from './format.js';
import { escapeHtml, getActiveRunnerSummary } from './runnerSelect.js';
import { saveRecord } from './storage.js';

let supportsDisplayTransition;
function canTransitionDisplay() {
  if (supportsDisplayTransition !== undefined) return supportsDisplayTransition;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransition = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransition;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

/**
 * Animated close helper for <dialog> per modern-web-guidance top-layer fallback.
 */
export async function closeDialogSmooth(dialog) {
  if (!dialog?.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const anims = dialog.getAnimations?.({ subtree: true }) || [];
    if (anims.length > 0) {
      await Promise.race([
        Promise.allSettled(anims.map((a) => a.finished)),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  if (dialog.open) dialog.close();
}

/**
 * Attach light-dismiss fallback for browsers lacking native `closedby="any"`.
 */
function attachClosedByFallback(dialog, onCloseRequest) {
  // Prevent Escape key inside modal dialogs from bubbling to window (`input.js` `input:pause`)
  dialog.addEventListener(
    'keydown',
    (e) => {
      if (e.code === 'Escape' || e.key === 'Escape') {
        e.stopPropagation();
      }
    },
    true
  );
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    onCloseRequest(dialog);
  });
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e)) onCloseRequest(dialog);
    });
  }
}

/**
 * Create and manage modal dialogs: Pause, Settings, Credits, Results.
 */
export function createDialogs({
  container,
  engine,
  game,
  getSettings,
  onUpdateSettings,
  onOpenRunnerSelect,
  onResume,
  onQuitToTitle,
  onShowToast,
}) {
  // 1. PAUSE DIALOG
  const pauseDlg = document.createElement('dialog');
  pauseDlg.className = 'tt-dialog';
  pauseDlg.setAttribute('aria-labelledby', 'pause-dlg-title');
  pauseDlg.setAttribute('closedby', 'any');
  pauseDlg.innerHTML = `
    <div class="tt-dialog__head">
      <h2 id="pause-dlg-title">Run Paused</h2>
      <button type="button" class="tt-dialog__close" data-dlg-close aria-label="Resume run">✕</button>
    </div>
    <div class="tt-dialog__body">
      <div class="pause-runner-row">
        <span class="pause-runner-label" data-pause-runner>🏃 Runner: Willie Milam (OVR 94)</span>
        <button type="button" class="btn btn--ghost btn--sm" data-pause-act="runner">Swap ▸</button>
      </div>
      <p class="tt-dialog__note">Note: In true real-time mode, closing the tab keeps the race clock ticking. Pausing here freezes your legs while you catch your breath.</p>

      <div class="tt-btn-stack">
        <button type="button" class="btn btn--primary" data-pause-act="resume" autofocus>▶ Resume Run</button>
        <button type="button" class="btn btn--secondary" data-pause-act="settings">⚙ Settings</button>
      </div>

      <div class="tt-field-group">
        <span class="tt-field-label">Camera Mode</span>
        <div class="seg-group" role="group" aria-label="Camera mode">
          <button type="button" class="seg-btn" data-cam="chase">Chase</button>
          <button type="button" class="seg-btn" data-cam="orbit">Orbit</button>
          <button type="button" class="seg-btn" data-cam="first-person">1st Person</button>
        </div>
      </div>

      <div class="tt-field-group">
        <span class="tt-field-label">Time Dilation (Cheat)</span>
        <div class="seg-group" role="group" aria-label="Time dilation speed">
          <button type="button" class="seg-btn is-active" data-scale="1">1× Real</button>
          <button type="button" class="seg-btn" data-scale="10">10×</button>
          <button type="button" class="seg-btn" data-scale="60">60×</button>
          <button type="button" class="seg-btn" data-scale="360">360×</button>
        </div>
        <p class="tt-field-hint">Using &gt;1× permanently stamps an asterisk (<code>*</code>) on your race result.</p>
      </div>

      <button type="button" class="btn btn--ghost btn--danger-text" data-pause-act="quit">Save &amp; Return to Title</button>
    </div>
  `;

  // 2. SETTINGS DIALOG
  const settingsDlg = document.createElement('dialog');
  settingsDlg.className = 'tt-dialog';
  settingsDlg.setAttribute('aria-labelledby', 'settings-dlg-title');
  settingsDlg.setAttribute('closedby', 'any');
  settingsDlg.innerHTML = `
    <div class="tt-dialog__head">
      <h2 id="settings-dlg-title">Settings</h2>
      <button type="button" class="tt-dialog__close" data-dlg-close aria-label="Close settings">✕</button>
    </div>
    <div class="tt-dialog__body">
      <div class="tt-field-group">
        <label class="tt-field-label" for="set-quality">Graphics Quality Tier</label>
        <select id="set-quality" class="tt-select">
          <option value="auto">Auto (Adaptive)</option>
          <option value="low">Low (Mobile Battery / 30+ fps)</option>
          <option value="medium">Medium (Balanced / 60 fps)</option>
          <option value="high">High (Shadows &amp; Reflective Water)</option>
          <option value="ultra">Ultra (Desktop Max + PostFX)</option>
        </select>
      </div>

      <div class="tt-field-group">
        <div class="tt-field-row">
          <label class="tt-field-label" for="set-scale">Render Scale</label>
          <span class="tt-field-val" id="set-scale-val">100%</span>
        </div>
        <input id="set-scale" class="tt-range" type="range" min="0.55" max="1.25" step="0.05" value="1.0" />
      </div>

      <div class="tt-field-group">
        <span class="tt-field-label">Units</span>
        <div class="seg-group" role="group" aria-label="Measurement units">
          <button type="button" class="seg-btn" data-units="imperial">Imperial (ft / mi)</button>
          <button type="button" class="seg-btn" data-units="metric">Metric (m / km)</button>
        </div>
      </div>

      <div class="tt-field-group">
        <span class="tt-field-label">Touch Controls</span>
        <div class="seg-group" role="group" aria-label="Touch controls visibility">
          <button type="button" class="seg-btn" data-touch="auto">Auto</button>
          <button type="button" class="seg-btn" data-touch="always">Always On</button>
          <button type="button" class="seg-btn" data-touch="off">Off</button>
        </div>
      </div>

      <label class="tt-toggle">
        <span>Audio &amp; Ambient Mountain Sound</span>
        <input id="set-audio" type="checkbox" />
      </label>

      <div class="tt-field-group">
        <div class="tt-field-row">
          <label class="tt-field-label" for="set-vol">Master Volume</label>
          <span class="tt-field-val" id="set-vol-val">75%</span>
        </div>
        <input id="set-vol" class="tt-range" type="range" min="0" max="1" step="0.05" value="0.75" />
      </div>

      <div class="tt-field-group">
        <div class="tt-field-row">
          <label class="tt-field-label" for="set-music">Menu Music Volume</label>
          <span class="tt-field-val" id="set-music-val">65%</span>
        </div>
        <input id="set-music" class="tt-range" type="range" min="0" max="1" step="0.05" value="0.65" />
      </div>

      <div class="tt-field-group">
        <div class="tt-field-row">
          <label class="tt-field-label" for="set-sfx">Trail &amp; UI SFX Volume</label>
          <span class="tt-field-val" id="set-sfx-val">85%</span>
        </div>
        <input id="set-sfx" class="tt-range" type="range" min="0" max="1" step="0.05" value="0.85" />
      </div>

      <label class="tt-toggle">
        <span>Haptic Feedback (Vibrate on Mobile)</span>
        <input id="set-haptics" type="checkbox" />
      </label>

      <label class="tt-toggle">
        <span>Invert Camera Look Y-Axis</span>
        <input id="set-invert" type="checkbox" />
      </label>

      <div class="tt-field-group">
        <div class="tt-field-row">
          <label class="tt-field-label" for="set-sens">Camera Look Sensitivity</label>
          <span class="tt-field-val" id="set-sens-val">1.0×</span>
        </div>
        <input id="set-sens" class="tt-range" type="range" min="0.4" max="2.2" step="0.1" value="1.0" />
      </div>

      <button type="button" class="btn btn--primary" data-dlg-close>Done</button>
    </div>
  `;

  // 3. CREDITS DIALOG
  const creditsDlg = document.createElement('dialog');
  creditsDlg.className = 'tt-dialog';
  creditsDlg.setAttribute('aria-labelledby', 'credits-dlg-title');
  creditsDlg.setAttribute('closedby', 'any');
  creditsDlg.innerHTML = `
    <div class="tt-dialog__head">
      <h2 id="credits-dlg-title">Credits &amp; Open Data</h2>
      <button type="button" class="tt-dialog__close" data-dlg-close aria-label="Close credits">✕</button>
    </div>
    <div class="tt-dialog__body tt-credits">
      <p><strong>Telluride Trails</strong> is built on real elevation, orthoimagery, land cover, and trail geometry of Telluride and the San Juan Mountains, Colorado.</p>
      <ul>
        <li><strong>Elevation:</strong> USGS 3DEP Digital Elevation Model via AWS Open Data Terrarium Tiles (Public Domain).</li>
        <li><strong>Orthoimagery:</strong> USGS National Map <code>USGSImageryOnly</code> / NAIP aerial photography (Public Domain).</li>
        <li><strong>Trails, Peaks, Waterways &amp; Buildings:</strong> Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, licensed under the Open Database License (ODbL).</li>
        <li><strong>Land Cover:</strong> Multi-Resolution Land Characteristics (MRLC) NLCD 2021 (Public Domain).</li>
        <li><strong>3D Engine:</strong> <a href="https://threejs.org/" target="_blank" rel="noopener">Three.js</a> (MIT License), bundled via Vite.</li>
        <li><strong>Runner Character &amp; Animations:</strong> <a href="https://quaternius.com/" target="_blank" rel="noopener">Quaternius</a> — Universal Base Characters &amp; Universal Animation Library (CC0 1.0), with a custom trail-running outfit.</li>
        <li><strong>Terrain Detail Textures:</strong> <a href="https://polyhaven.com/textures" target="_blank" rel="noopener">Poly Haven</a> — cliff_side, gray_rocks, stony_dirt_path, sparse_grass, forest_ground_04, snow_02 (CC0 1.0).</li>
        <li><strong>Other Assets:</strong> Procedurally generated in-browser or CC0 / public domain.</li>
        <li><strong>Inspiration:</strong> Sibling project <a href="https://github.com/nickcoury/track24" target="_blank" rel="noopener">track24</a> — another absurdly real-time ultramarathon.</li>
      </ul>
      <button type="button" class="btn btn--primary" data-dlg-close autofocus>Close</button>
    </div>
  `;

  // 4. RESULTS DIALOG
  const resultsDlg = document.createElement('dialog');
  resultsDlg.className = 'tt-dialog tt-dialog--wide';
  resultsDlg.setAttribute('aria-labelledby', 'results-dlg-title');
  resultsDlg.setAttribute('closedby', 'closerequest');
  resultsDlg.innerHTML = `<div class="tt-dialog__body" id="results-body"></div>`;

  container.append(pauseDlg, settingsDlg, creditsDlg, resultsDlg);

  let currentTimeScale = 1;
  let wasDilationUsed = false;

  // Pause dialog actions
  attachClosedByFallback(pauseDlg, () => {
    closeDialogSmooth(pauseDlg);
    onResume?.();
  });

  pauseDlg.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('[data-dlg-close]');
    const actBtn = e.target.closest('[data-pause-act]');
    const camBtn = e.target.closest('[data-cam]');
    const scaleBtn = e.target.closest('[data-scale]');

    if (closeBtn) {
      closeDialogSmooth(pauseDlg);
      onResume?.();
    } else if (actBtn) {
      const act = actBtn.dataset.pauseAct;
      if (act === 'resume') {
        closeDialogSmooth(pauseDlg);
        onResume?.();
      } else if (act === 'settings') {
        syncSettingsControls();
        settingsDlg.showModal();
      } else if (act === 'runner') {
        onOpenRunnerSelect?.();
      } else if (act === 'quit') {
        closeDialogSmooth(pauseDlg);
        onQuitToTitle?.();
      }
    } else if (camBtn) {
      const mode = camBtn.dataset.cam;
      engine.events.emit('ui:cameraMode', { mode });
      syncPauseCamera(mode);
    } else if (scaleBtn) {
      const scale = Number(scaleBtn.dataset.scale) || 1;
      currentTimeScale = scale;
      if (scale > 1) wasDilationUsed = true;
      pauseDlg.querySelectorAll('[data-scale]').forEach((b) => {
        b.classList.toggle('is-active', Number(b.dataset.scale) === scale);
      });
      engine.events.emit('ui:timeDilation', { scale });
      if (scale > 1) {
        onShowToast?.(`Time Dilation ${scale}× enabled (*asterisk stamped on finish)`, 'warn', 3500);
      }
    }
  });

  function syncPauseCamera(mode) {
    pauseDlg.querySelectorAll('[data-cam]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.cam === mode);
    });
  }

  // Settings dialog actions
  attachClosedByFallback(settingsDlg, (d) => closeDialogSmooth(d));
  settingsDlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-dlg-close]')) {
      closeDialogSmooth(settingsDlg);
      return;
    }
    const unitBtn = e.target.closest('[data-units]');
    if (unitBtn) {
      onUpdateSettings?.({ units: unitBtn.dataset.units });
      syncSettingsControls();
      return;
    }
    const touchBtn = e.target.closest('[data-touch]');
    if (touchBtn) {
      onUpdateSettings?.({ touchControls: touchBtn.dataset.touch });
      syncSettingsControls();
    }
  });

  const qSelect = settingsDlg.querySelector('#set-quality');
  const scaleInput = settingsDlg.querySelector('#set-scale');
  const scaleVal = settingsDlg.querySelector('#set-scale-val');
  const audioCheck = settingsDlg.querySelector('#set-audio');
  const volInput = settingsDlg.querySelector('#set-vol');
  const volVal = settingsDlg.querySelector('#set-vol-val');
  const musicInput = settingsDlg.querySelector('#set-music');
  const musicVal = settingsDlg.querySelector('#set-music-val');
  const sfxInput = settingsDlg.querySelector('#set-sfx');
  const sfxVal = settingsDlg.querySelector('#set-sfx-val');
  const hapticsCheck = settingsDlg.querySelector('#set-haptics');
  const invertCheck = settingsDlg.querySelector('#set-invert');
  const sensInput = settingsDlg.querySelector('#set-sens');
  const sensVal = settingsDlg.querySelector('#set-sens-val');

  qSelect.addEventListener('change', () => {
    const tier = qSelect.value;
    onUpdateSettings?.({ qualityTier: tier });
    if (tier === 'auto') {
      engine.events.emit('ui:quality', { tier: 'auto', auto: true });
    } else {
      engine.events.emit('ui:quality', { tier, auto: false });
    }
    syncSettingsControls();
  });

  scaleInput.addEventListener('input', () => {
    const val = Number(scaleInput.value);
    scaleVal.textContent = `${Math.round(val * 100)}%`;
    onUpdateSettings?.({ renderScale: val });
    engine.events.emit('ui:quality', { renderScale: val });
  });

  audioCheck.addEventListener('change', () => {
    onUpdateSettings?.({ audio: audioCheck.checked });
  });
  volInput.addEventListener('input', () => {
    const v = Number(volInput.value);
    volVal.textContent = `${Math.round(v * 100)}%`;
    onUpdateSettings?.({ volume: v });
  });
  musicInput.addEventListener('input', () => {
    const v = Number(musicInput.value);
    musicVal.textContent = `${Math.round(v * 100)}%`;
    onUpdateSettings?.({ musicVolume: v });
  });
  sfxInput.addEventListener('input', () => {
    const v = Number(sfxInput.value);
    sfxVal.textContent = `${Math.round(v * 100)}%`;
    onUpdateSettings?.({ sfxVolume: v });
  });
  hapticsCheck.addEventListener('change', () => {
    onUpdateSettings?.({ haptics: hapticsCheck.checked });
  });
  invertCheck.addEventListener('change', () => {
    onUpdateSettings?.({ invertY: invertCheck.checked });
  });
  sensInput.addEventListener('input', () => {
    const s = Number(sensInput.value);
    sensVal.textContent = `${s.toFixed(1)}×`;
    onUpdateSettings?.({ lookSensitivity: s });
  });

  function syncSettingsControls() {
    const s = getSettings();
    qSelect.value = s.qualityTier || (engine.quality?.auto ? 'auto' : engine.quality?.tier) || 'auto';
    const rs = engine.quality?.renderScale ?? s.renderScale ?? 1.0;
    scaleInput.value = String(rs);
    scaleVal.textContent = `${Math.round(rs * 100)}%`;
    settingsDlg.querySelectorAll('[data-units]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.units === s.units);
    });
    settingsDlg.querySelectorAll('[data-touch]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.touch === s.touchControls);
    });
    audioCheck.checked = Boolean(s.audio);
    volInput.value = String(s.volume ?? 0.75);
    volVal.textContent = `${Math.round((s.volume ?? 0.75) * 100)}%`;
    musicInput.value = String(s.musicVolume ?? 0.65);
    musicVal.textContent = `${Math.round((s.musicVolume ?? 0.65) * 100)}%`;
    sfxInput.value = String(s.sfxVolume ?? 0.85);
    sfxVal.textContent = `${Math.round((s.sfxVolume ?? 0.85) * 100)}%`;
    hapticsCheck.checked = Boolean(s.haptics);
    invertCheck.checked = Boolean(s.invertY);
    sensInput.value = String(s.lookSensitivity ?? 1.0);
    sensVal.textContent = `${(s.lookSensitivity ?? 1.0).toFixed(1)}×`;
  }

  const unsubQuality = engine.events?.on?.('quality:changed', () => {
    if (settingsDlg.open) syncSettingsControls();
  });

  // Credits dialog
  attachClosedByFallback(creditsDlg, (d) => closeDialogSmooth(d));
  creditsDlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-dlg-close]')) closeDialogSmooth(creditsDlg);
  });

  // Results dialog
  attachClosedByFallback(resultsDlg, () => {
    closeDialogSmooth(resultsDlg);
    onQuitToTitle?.();
  });

  function showResults(result, { onRestartRace } = {}) {
    const units = getSettings()?.units || 'imperial';
    const elapsedSec = result?.clockS ?? result?.elapsedSec ?? result?.timeSec ?? 0;
    const distM = result?.distM ?? result?.distanceM ?? 0;
    const vertM = result?.vertGainM ?? result?.vertM ?? 0;
    const dnf = Boolean(result?.dnf);
    const activeR = getActiveRunnerSummary(game);
    const rName = result?.runner?.name || result?.runnerName || activeR.name;
    const rOvr = Number.isFinite(result?.runner?.ovr) ? result.runner.ovr : activeR.ovr;
    const statUncapped = Boolean(
      result?.statUncapped || result?.runner?.statUncapped || activeR.statUncapped
    );
    const timeDilated = Boolean(
      result?.timeDilated ||
        result?.timeDilationUsed ||
        wasDilationUsed ||
        currentTimeScale > 1
    );
    const hasAsterisk = Boolean(result?.asterisk || timeDilated || statUncapped);
    const raceName = result?.raceName || result?.name || 'San Juan Trail Run';
    const splits = Array.isArray(result?.splits) ? result.splits : [];
    const penalties = result?.penaltiesSec ?? result?.offTrailPenaltySec ?? 0;
    const avgPace = fmtPace({ speedMs: elapsedSec > 0 ? distM / elapsedSec : 0 }, units);
    const isNewPb = Boolean(result?.isNewPb);
    const kissed = Boolean(
      result?.kissedRock || result?.ceremony === 'kiss_rock' || result?.ceremony === 'kissed'
    );

    if (result?.raceId) {
      saveRecord({
        raceId: result.raceId,
        raceName,
        elapsedSec,
        distM,
        vertM,
        dnf,
        timeDilated,
        statUncapped,
        asterisk: hasAsterisk,
        runnerName: rName,
      });
    }

    const timeStr = `${fmtClock(elapsedSec)}${hasAsterisk ? ' *' : ''}`;
    const runnerLabel = `Runner: ${rName} (OVR ${rOvr}${statUncapped ? '*' : ''})`;
    const shareText = `Telluride Trails — ${raceName}: ${dnf ? 'DNF' : 'Finished'} in ${timeStr} · ${runnerLabel} (${fmtDist(distM, units, 1)}, ${fmtVert(vertM, units)} vert).`;

    const asteriskReason =
      timeDilated && statUncapped
        ? 'Time Dilation & Uncapped Custom Stats'
        : statUncapped
          ? 'Uncapped Custom Runner Stats'
          : 'Time Dilation';

    const splitsRows = splits.length
      ? `<table class="results-table">
          <caption>Checkpoint Splits</caption>
          <thead><tr><th scope="col">Aid / Checkpoint</th><th scope="col">Split</th><th scope="col">Elapsed</th></tr></thead>
          <tbody>
            ${splits
              .map(
                (sp) =>
                  `<tr><td>${escapeHtml(sp.name || 'Checkpoint')}</td><td>${fmtClock(sp.splitSec ?? sp.splitS ?? 0)}</td><td>${fmtClock(sp.elapsedSec ?? sp.clockS ?? 0)}</td></tr>`
              )
              .join('')}
          </tbody>
        </table>`
      : '';

    const body = resultsDlg.querySelector('#results-body');
    body.innerHTML = `
      <div class="results-hero">
        <div class="results-badge ${dnf ? 'results-badge--dnf' : 'results-badge--fin'}">
          ${dnf ? '⛰ DNF — Mountains Win Today' : kissed ? '🪨 Hardrock Finisher!' : isNewPb ? '🏆 New Personal Best!' : '🏔 Finisher!'}
        </div>
        <h2 id="results-dlg-title" tabindex="-1" autofocus>${escapeHtml(raceName)}</h2>
        <p class="results-runner">🏃 ${escapeHtml(runnerLabel)}</p>
        <div class="results-clock">${timeStr}</div>
        ${hasAsterisk ? `<p class="results-asterisk">* Completed with ${asteriskReason} (non-purist finish).</p>` : ''}
        ${result?.dnfReason || result?.reason ? `<p class="results-dnf-reason">${escapeHtml(result.dnfReason || result.reason)}</p>` : ''}
      </div>

      <dl class="results-grid">
        <div><dt>Distance</dt><dd>${fmtDist(distM, units, 2)}</dd></div>
        <div><dt>Vert Gain</dt><dd>${fmtVert(vertM, units)}</dd></div>
        <div><dt>Avg Pace</dt><dd>${avgPace}</dd></div>
        <div><dt>Off-Trail Penalty</dt><dd>${penalties > 0 ? `+${Math.round(penalties)}s` : 'Clean (0s)'}</dd></div>
        ${Number.isFinite(result?.falls) ? `<div><dt>Trail Trips</dt><dd>${result.falls}</dd></div>` : ''}
        ${Number.isFinite(result?.kcalEaten) ? `<div><dt>Calories</dt><dd>${Math.round(result.kcalEaten)} kcal</dd></div>` : ''}
      </dl>

      ${splitsRows}

      <div class="results-actions">
        <button type="button" class="btn btn--secondary" data-res="share">📤 Share Result</button>
        ${result?.raceId ? '<button type="button" class="btn btn--primary" data-res="again">Run Again</button>' : ''}
        <button type="button" class="btn btn--ghost" data-res="title">Back to Title</button>
      </div>
    `;

    body.querySelector('[data-res="share"]')?.addEventListener('click', async () => {
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Telluride Trails', text: shareText });
          return;
        } catch {
          // fallback to clipboard
        }
      }
      try {
        await navigator.clipboard.writeText(shareText);
        onShowToast?.('Result copied to clipboard!', 'ok', 2500);
      } catch {
        onShowToast?.(shareText, 'info', 4000);
      }
    });

    body.querySelector('[data-res="again"]')?.addEventListener('click', () => {
      closeDialogSmooth(resultsDlg);
      onRestartRace?.(result.raceId);
    });

    body.querySelector('[data-res="title"]')?.addEventListener('click', () => {
      closeDialogSmooth(resultsDlg);
      onQuitToTitle?.();
    });

    if (!resultsDlg.open) resultsDlg.showModal();
    const titleEl = body.querySelector('#results-dlg-title');
    titleEl?.focus?.({ preventScroll: true });
    resultsDlg.scrollTop = 0;
    body.scrollTop = 0;
  }

  const pauseRunnerEl = pauseDlg.querySelector('[data-pause-runner]');
  function syncPauseRunner() {
    if (!pauseRunnerEl) return;
    const r = getActiveRunnerSummary(game);
    pauseRunnerEl.textContent = `🏃 Runner: ${r.name} (OVR ${r.ovr}${r.statUncapped ? '*' : ''})`;
  }

  return {
    openPause() {
      syncPauseCamera(engine.cameraRig?.getMode?.() || 'chase');
      syncPauseRunner();
      if (!pauseDlg.open) pauseDlg.showModal();
    },
    syncPauseRunner,
    closePause() {
      closeDialogSmooth(pauseDlg);
    },
    openSettings() {
      syncSettingsControls();
      if (!settingsDlg.open) settingsDlg.showModal();
    },
    openCredits() {
      if (!creditsDlg.open) creditsDlg.showModal();
    },
    showResults,
    resetDilationFlag() {
      currentTimeScale = 1;
      wasDilationUsed = false;
      pauseDlg.querySelectorAll('[data-scale]').forEach((b) => {
        b.classList.toggle('is-active', Number(b.dataset.scale) === 1);
      });
    },
    dispose() {
      unsubQuality?.();
      pauseDlg.remove();
      settingsDlg.remove();
      creditsDlg.remove();
      resultsDlg.remove();
    },
  };
}
