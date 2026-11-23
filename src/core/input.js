/**
 * Unified input system merging keyboard, mouse drag/wheel, gamepad, and UI touch events.
 * Latches discrete key triggers (Escape, KeyP, KeyC, Space) in keydown so quick taps
 * between animation frames are never dropped.
 */
export function createInput({ domElement, events }) {
  const state = {
    move: { x: 0, y: 0 },
    look: { x: 0, y: 0 },
    sprint: false,
    hike: false,
    jump: false,
    autopilot: false,
    pause: false,
    cameraModeToggle: false,
    zoomDelta: 0,
  };

  const keys = new Set();
  const touchState = {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    sprint: false,
    hike: false,
    jump: false,
  };

  let pointerDown = false;
  let activePointerId = -1;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let mouseLookX = 0;
  let mouseLookY = 0;
  let wheelDelta = 0;

  // Latched edge triggers consumed once per update() tick
  let latchedPause = false;
  let latchedAutopilot = false;
  let latchedCamera = false;
  let latchedJump = false;

  // Per-gamepad edge-trigger state (supports multiple connected pads cleanly)
  const prevJumpByPad = new Map();
  const prevPauseByPad = new Map();

  function clearTransientInputs() {
    keys.clear();
    pointerDown = false;
    activePointerId = -1;
    touchState.moveX = 0;
    touchState.moveY = 0;
    touchState.lookX = 0;
    touchState.lookY = 0;
    touchState.sprint = false;
    touchState.jump = false;
    mouseLookX = 0;
    mouseLookY = 0;
    wheelDelta = 0;
  }

  function hasOpenModalDialog() {
    return Boolean(document.querySelector('dialog[open]'));
  }

  function onKeyDown(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    keys.add(e.code);
    if (e.repeat) return;

    if (e.code === 'Escape') {
      // Native <dialog> handles Escape via its 'cancel' event; only toggle pause if no modal dialog is open.
      if (!hasOpenModalDialog()) {
        latchedPause = true;
        events.emit('input:pause');
      }
    } else if (e.code === 'KeyP') {
      latchedAutopilot = true;
      events.emit('input:autopilot-toggle');
    } else if (e.code === 'KeyC') {
      latchedCamera = true;
      events.emit('input:camera-toggle');
    } else if (e.code === 'Space') {
      latchedJump = true;
    }
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  function onBlur() {
    clearTransientInputs();
  }

  function onVisibilityChange() {
    if (document.hidden) clearTransientInputs();
  }

  function onPointerDown(e) {
    if (e.target !== domElement) return;
    if (e.pointerType === 'touch') return; // UI handles touch look/joystick via ui:look / ui:move
    if (e.button !== 0) return; // Primary button only
    pointerDown = true;
    activePointerId = e.pointerId;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
  }

  function onPointerMove(e) {
    if (!pointerDown || e.pointerType === 'touch' || e.pointerId !== activePointerId) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    mouseLookX += dx * 0.004;
    mouseLookY += dy * 0.004;
  }

  function onPointerUp(e) {
    if (e.pointerId !== activePointerId) return;
    pointerDown = false;
    activePointerId = -1;
  }

  function onWheel(e) {
    if (e.target !== domElement) return;
    wheelDelta += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) * 0.01);
  }

  // UI touch input hooks
  const unsubMove = events.on('ui:move', (v) => {
    touchState.moveX = v?.x || 0;
    touchState.moveY = v?.y || 0;
  });
  const unsubLook = events.on('ui:look', (v) => {
    touchState.lookX += v?.dx || v?.x || 0;
    touchState.lookY += v?.dy || v?.y || 0;
  });
  const unsubActions = events.on('ui:input', (v) => {
    if (!v) return;
    if (typeof v.sprint === 'boolean') touchState.sprint = v.sprint;
    if (typeof v.hike === 'boolean') touchState.hike = v.hike;
    if (typeof v.jump === 'boolean') touchState.jump = v.jump;
  });
  const unsubZoom = events.on('ui:zoom', (v) => {
    if (Number.isFinite(v?.delta)) wheelDelta += v.delta;
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);
  domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  domElement.addEventListener('wheel', onWheel, { passive: true });

  function update(dt = 1 / 60) {
    const safeDt = Math.min(0.1, Math.max(0.001, dt || 1 / 60));

    let kx = 0;
    let ky = 0;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) kx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) ky += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) ky -= 1;

    const kLen = Math.hypot(kx, ky);
    if (kLen > 1) {
      kx /= kLen;
      ky /= kLen;
    }

    let gx = 0;
    let gy = 0;
    let glx = 0;
    let gly = 0;
    let gpSprint = false;
    let gpHike = false;
    let gpJump = false;
    let gpPause = false;

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const lookSpeedRadPerSec = 2.4;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected) continue;
      const pid = pad.index ?? i;
      const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);
      gx += dead(pad.axes[0] || 0);
      gy -= dead(pad.axes[1] || 0);
      glx += dead(pad.axes[2] || 0) * lookSpeedRadPerSec * safeDt;
      gly += dead(pad.axes[3] || 0) * lookSpeedRadPerSec * safeDt;
      gpSprint =
        gpSprint ||
        Boolean(pad.buttons[6]?.pressed || pad.buttons[7]?.pressed || pad.buttons[10]?.pressed);
      gpHike = gpHike || Boolean(pad.buttons[4]?.pressed);

      const jumpNow = Boolean(pad.buttons[0]?.pressed);
      if (jumpNow && !prevJumpByPad.get(pid)) gpJump = true;
      prevJumpByPad.set(pid, jumpNow);

      const pauseNow = Boolean(pad.buttons[9]?.pressed);
      if (pauseNow && !prevPauseByPad.get(pid)) {
        gpPause = true;
        events.emit('input:pause');
      }
      prevPauseByPad.set(pid, pauseNow);
    }

    state.move.x = Math.max(-1, Math.min(1, kx + gx + touchState.moveX));
    state.move.y = Math.max(-1, Math.min(1, ky + gy + touchState.moveY));

    state.look.x = mouseLookX + touchState.lookX + glx;
    state.look.y = mouseLookY + touchState.lookY + gly;
    mouseLookX = 0;
    mouseLookY = 0;
    touchState.lookX = 0;
    touchState.lookY = 0;

    state.zoomDelta = wheelDelta;
    wheelDelta = 0;

    state.sprint =
      keys.has('ShiftLeft') || keys.has('ShiftRight') || gpSprint || touchState.sprint;
    state.hike =
      keys.has('ControlLeft') || keys.has('AltLeft') || gpHike || touchState.hike;

    state.jump = latchedJump || keys.has('Space') || gpJump || touchState.jump;
    latchedJump = false;
    touchState.jump = false;

    state.autopilot = latchedAutopilot;
    latchedAutopilot = false;

    state.pause = latchedPause || gpPause;
    latchedPause = false;

    state.cameraModeToggle = latchedCamera;
    latchedCamera = false;
  }

  function dispose() {
    unsubMove();
    unsubLook();
    unsubActions();
    unsubZoom();
    prevJumpByPad.clear();
    prevPauseByPad.clear();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    domElement.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    domElement.removeEventListener('wheel', onWheel);
  }

  return Object.assign(state, { update, dispose });
}
