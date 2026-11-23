import { AID_SNACKS, FOOD_CATALOG } from './format.js';

/**
 * Create mobile touch controls (virtual joystick, camera drag pad, action buttons,
 * contextual aid/stream/fall prompts) + desktop keyboard/gamepad hint strip.
 */
export function createTouchControls({ container, engine, getSettings }) {
  const wrap = document.createElement('div');
  wrap.className = 'touch-layer';
  wrap.innerHTML = `
    <div class="look-pad" aria-hidden="true"></div>

    <div class="context-actions" hidden></div>

    <div class="touch-controls">
      <div class="joystick" role="application" aria-label="Movement joystick">
        <div class="joystick__ring">
          <div class="joystick__knob"></div>
        </div>
      </div>

      <div class="action-pad">
        <button type="button" class="action-btn action-btn--auto" data-act="autopilot" aria-pressed="false" aria-label="Toggle trail autopilot">
          <span class="action-btn__icon" aria-hidden="true">🧭</span>
          <span class="action-btn__label">Auto</span>
        </button>
        <button type="button" class="action-btn action-btn--hike" data-act="hike" aria-pressed="false" aria-label="Toggle power hike mode">
          <span class="action-btn__icon" aria-hidden="true">🥾</span>
          <span class="action-btn__label">Hike</span>
        </button>
        <button type="button" class="action-btn action-btn--sprint" data-act="sprint" aria-label="Hold to sprint">
          <span class="action-btn__icon" aria-hidden="true">⚡</span>
          <span class="action-btn__label">Sprint</span>
        </button>
        <button type="button" class="action-btn action-btn--jump" data-act="jump" aria-label="Jump">
          <span class="action-btn__icon" aria-hidden="true">↑</span>
          <span class="action-btn__label">Jump</span>
        </button>
      </div>
    </div>

    <div class="desktop-hints" aria-label="Controls reference">
      <button type="button" class="hints-toggle" aria-expanded="false" aria-controls="hints-panel">
        <span class="gamepad-dot" hidden title="Gamepad connected">🎮</span>
        <span>Controls ?</span>
      </button>
      <div id="hints-panel" class="hints-panel" hidden>
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Move</div>
        <div><kbd>Shift</kbd> Sprint · <kbd>Ctrl</kbd> Hike · <kbd>Space</kbd> Jump</div>
        <div><kbd>Drag</kbd> Orbit · <kbd>Scroll</kbd> Zoom</div>
        <div><kbd>P</kbd> Autopilot · <kbd>C</kbd> Camera · <kbd>H</kbd> Photo · <kbd>Esc</kbd> Pause</div>
        <div class="hints-gamepad" hidden>🎮 Gamepad active: Left Stick move · Right Stick look · RT/LT sprint · A jump</div>
      </div>
    </div>
  `;
  container.appendChild(wrap);

  const lookPad = wrap.querySelector('.look-pad');
  const joystickEl = wrap.querySelector('.joystick');
  const knobEl = wrap.querySelector('.joystick__knob');
  const touchControlsEl = wrap.querySelector('.touch-controls');
  const contextEl = wrap.querySelector('.context-actions');
  const hikeBtn = wrap.querySelector('[data-act="hike"]');
  const autoBtn = wrap.querySelector('[data-act="autopilot"]');
  const sprintBtn = wrap.querySelector('[data-act="sprint"]');
  const jumpBtn = wrap.querySelector('[data-act="jump"]');
  const hintsToggle = wrap.querySelector('.hints-toggle');
  const hintsPanel = wrap.querySelector('#hints-panel');
  const gamepadDot = wrap.querySelector('.gamepad-dot');
  const gamepadHint = wrap.querySelector('.hints-gamepad');

  let hikeActive = false;
  let autopilotActive = false;
  let sprintActive = false;
  let joyPointerId = null;
  let joyOrigin = { x: 0, y: 0 };
  let lookPointerId = null;
  let lastLook = { x: 0, y: 0 };
  let lastContextSignature = '';

  function vibrate(pattern = 10) {
    if (!getSettings?.()?.haptics) return;
    if (typeof navigator?.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch {
        // ignore unsupported browser context
      }
    }
  }

  function syncTouchVisibility() {
    const mode = getSettings?.()?.touchControls || 'auto';
    const isCoarse = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    const showTouch = mode === 'always' || (mode === 'auto' && isCoarse);
    touchControlsEl.hidden = !showTouch;
    lookPad.style.display = showTouch ? 'block' : 'none';
  }
  syncTouchVisibility();

  // Virtual Joystick
  const MAX_RADIUS = 44;
  const DEADZONE = 0.12;

  function resetJoystick() {
    joyPointerId = null;
    joystickEl.classList.remove('is-active');
    knobEl.style.transform = 'translate3d(0, 0, 0)';
    engine.events.emit('ui:move', { x: 0, y: 0 });
  }

  function updateJoystick(clientX, clientY) {
    const dx = clientX - joyOrigin.x;
    const dy = clientY - joyOrigin.y;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(MAX_RADIUS, dist);
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * clamped;
    const ky = Math.sin(angle) * clamped;
    knobEl.style.transform = `translate3d(${kx.toFixed(1)}px, ${ky.toFixed(1)}px, 0)`;

    const norm = clamped / MAX_RADIUS;
    if (norm < DEADZONE) {
      engine.events.emit('ui:move', { x: 0, y: 0 });
    } else {
      const scaled = (norm - DEADZONE) / (1 - DEADZONE);
      engine.events.emit('ui:move', {
        x: Math.cos(angle) * scaled,
        y: -Math.sin(angle) * scaled, // up is +forward
      });
    }
  }

  joystickEl.addEventListener('pointerdown', (e) => {
    if (joyPointerId !== null) return;
    e.preventDefault();
    joyPointerId = e.pointerId;
    joystickEl.setPointerCapture(e.pointerId);
    const rect = joystickEl.getBoundingClientRect();
    joyOrigin = { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 };
    joystickEl.classList.add('is-active');
    vibrate(8);
    updateJoystick(e.clientX, e.clientY);
  });

  joystickEl.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyPointerId) return;
    updateJoystick(e.clientX, e.clientY);
  });

  joystickEl.addEventListener('pointerup', (e) => {
    if (e.pointerId === joyPointerId) resetJoystick();
  });
  joystickEl.addEventListener('pointercancel', (e) => {
    if (e.pointerId === joyPointerId) resetJoystick();
  });

  // Camera drag look pad (touch)
  lookPad.addEventListener('pointerdown', (e) => {
    if (lookPointerId !== null) return;
    lookPointerId = e.pointerId;
    lookPad.setPointerCapture(e.pointerId);
    lastLook = { x: e.clientX, y: e.clientY };
  });

  lookPad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== lookPointerId) return;
    const sens = (getSettings?.()?.lookSensitivity || 1.0) * 0.0045;
    const dx = (e.clientX - lastLook.x) * sens;
    const dy = (e.clientY - lastLook.y) * sens;
    lastLook = { x: e.clientX, y: e.clientY };
    engine.events.emit('ui:look', { dx, dy });
  });

  const endLook = (e) => {
    if (e.pointerId === lookPointerId) lookPointerId = null;
  };
  lookPad.addEventListener('pointerup', endLook);
  lookPad.addEventListener('pointercancel', endLook);

  // Action buttons
  hikeBtn.addEventListener('click', () => {
    hikeActive = !hikeActive;
    hikeBtn.setAttribute('aria-pressed', String(hikeActive));
    hikeBtn.classList.toggle('is-active', hikeActive);
    vibrate(10);
    engine.events.emit('ui:input', { hike: hikeActive });
    engine.events.emit('ui:paceMode', { mode: hikeActive ? 'hike' : 'auto' });
  });

  autoBtn.addEventListener('click', () => {
    autopilotActive = !autopilotActive;
    autoBtn.setAttribute('aria-pressed', String(autopilotActive));
    autoBtn.classList.toggle('is-active', autopilotActive);
    vibrate(12);
    engine.events.emit('ui:input', { autopilot: autopilotActive });
    engine.events.emit('ui:autopilot', { enabled: autopilotActive });
  });

  const setSprint = (on) => {
    if (sprintActive === on) return;
    sprintActive = on;
    sprintBtn.classList.toggle('is-active', on);
    if (on) vibrate(8);
    engine.events.emit('ui:input', { sprint: on });
  };

  sprintBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sprintBtn.setPointerCapture(e.pointerId);
    setSprint(true);
  });
  sprintBtn.addEventListener('pointerup', () => setSprint(false));
  sprintBtn.addEventListener('pointercancel', () => setSprint(false));
  sprintBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') setSprint(true);
  });
  sprintBtn.addEventListener('keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') setSprint(false);
  });

  jumpBtn.addEventListener('click', () => {
    vibrate(14);
    engine.events.emit('ui:input', { jump: true });
  });

  // Hints toggle
  hintsToggle.addEventListener('click', () => {
    const open = hintsToggle.getAttribute('aria-expanded') === 'true';
    hintsToggle.setAttribute('aria-expanded', String(!open));
    hintsPanel.hidden = open;
  });

  // Gamepad detection
  const onGamepadChange = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const connected = Array.from(pads).some((p) => p && p.connected);
    gamepadDot.hidden = !connected;
    gamepadHint.hidden = !connected;
  };
  window.addEventListener('gamepadconnected', onGamepadChange);
  window.addEventListener('gamepaddisconnected', onGamepadChange);
  onGamepadChange();

  // Sync autopilot button when keyboard 'P' toggles it
  const unsubAutoToggle = engine.events.on('input:autopilot-toggle', () => {
    autopilotActive = !autopilotActive;
    autoBtn.setAttribute('aria-pressed', String(autopilotActive));
    autoBtn.classList.toggle('is-active', autopilotActive);
    engine.events.emit('ui:autopilot', { enabled: autopilotActive });
  });

  // Contextual actions handler (event delegation)
  contextEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ctx]');
    if (!btn) return;
    vibrate(14);
    const act = btn.dataset.ctx;
    if (act === 'getup') {
      engine.events.emit('ui:getup');
    } else if (act === 'refill') {
      engine.events.emit('ui:refill');
    } else if (act === 'eat') {
      engine.events.emit('ui:eat', { key: btn.dataset.key || 'gel' });
    } else if (act === 'kiss') {
      engine.events.emit('ui:kissRock');
    }
  });

  function updateContext(hudState) {
    if (!hudState) return;

    if (typeof hudState.autopilot === 'boolean' && hudState.autopilot !== autopilotActive) {
      autopilotActive = hudState.autopilot;
      autoBtn.setAttribute('aria-pressed', String(autopilotActive));
      autoBtn.classList.toggle('is-active', autopilotActive);
    }

    const fallen = Boolean(hudState.fallen);
    const nearAid = hudState.nearAid;
    const aidName = typeof nearAid === 'object' ? nearAid?.name : nearAid ? 'Aid Station' : '';
    const aidFoods = Array.isArray(nearAid?.foods) && nearAid.foods.length ? nearAid.foods : null;
    const nearStream = Boolean(hudState.nearStream);
    const canKissRock = Boolean(hudState.canKissRock || hudState.race?.ceremonyActive);
    const gelsCarried = hudState.gelsCarried ?? 0;
    const lowEnergy = (hudState.stamina ?? hudState.energy ?? 1) < 0.65;
    const showQuickGel = !nearAid && gelsCarried > 0 && lowEnergy;
    const sig = `${fallen}|${aidName}|${aidFoods?.join(',') || ''}|${nearStream}|${canKissRock}|${showQuickGel ? gelsCarried : 0}`;
    if (sig === lastContextSignature) return;
    lastContextSignature = sig;

    if (!fallen && !nearAid && !nearStream && !canKissRock && !showQuickGel) {
      contextEl.hidden = true;
      contextEl.innerHTML = '';
      return;
    }

    let html = '';
    if (fallen) {
      html += `<button type="button" class="ctx-btn ctx-btn--danger" data-ctx="getup">🩹 Get Back Up</button>`;
    }
    if (canKissRock) {
      html += `<button type="button" class="ctx-btn ctx-btn--gold" data-ctx="kiss">🪨 Kiss the Hardrock!</button>`;
    }
    if (nearAid) {
      html += `<div class="ctx-aid-label">⛺ ${aidName || 'Aid Station'}</div>`;
      const items = aidFoods
        ? aidFoods.map((k) => ({ key: k, ...(FOOD_CATALOG[k] || { label: k, icon: '🍽', hint: '' }) }))
        : AID_SNACKS;
      for (const s of items) {
        html += `<button type="button" class="ctx-btn" data-ctx="eat" data-key="${s.key}" title="${s.hint}">${s.icon} ${s.label}</button>`;
      }
      html += `<button type="button" class="ctx-btn ctx-btn--water" data-ctx="refill">💧 Refill Flasks</button>`;
    } else if (nearStream) {
      html += `<button type="button" class="ctx-btn ctx-btn--water" data-ctx="refill">💧 Filter Stream Water</button>`;
    }
    if (showQuickGel) {
      html += `<button type="button" class="ctx-btn" data-ctx="eat" data-key="gel">⚡ Eat Gel (${gelsCarried})</button>`;
    }

    contextEl.innerHTML = html;
    contextEl.hidden = false;
  }

  return {
    syncTouchVisibility,
    updateContext,
    vibrate,
    setVisible(visible) {
      wrap.hidden = !visible;
      if (!visible) resetJoystick();
    },
    dispose() {
      unsubAutoToggle();
      window.removeEventListener('gamepadconnected', onGamepadChange);
      window.removeEventListener('gamepaddisconnected', onGamepadChange);
      wrap.remove();
    },
  };
}
