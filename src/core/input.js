/**
 * Unified input system merging keyboard, mouse drag/wheel, gamepad, and UI touch events.
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
    autopilot: false,
  };

  let pointerDown = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let mouseLookX = 0;
  let mouseLookY = 0;
  let wheelDelta = 0;
  let prevPauseKey = false;
  let prevAutoKey = false;
  let prevCamKey = false;
  let prevJumpGamepad = false;
  let prevPauseGamepad = false;

  function onKeyDown(e) {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    keys.add(e.code);
    if (e.code === 'Escape') {
      events.emit('input:pause');
    } else if (e.code === 'KeyP') {
      events.emit('input:autopilot-toggle');
    } else if (e.code === 'KeyC') {
      events.emit('input:camera-toggle');
    }
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  function onBlur() {
    keys.clear();
    pointerDown = false;
  }

  function onPointerDown(e) {
    if (e.target !== domElement) return;
    if (e.pointerType === 'touch') return; // UI handles touch look/joystick or emits ui:look
    pointerDown = true;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
  }

  function onPointerMove(e) {
    if (!pointerDown) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    mouseLookX += dx * 0.004;
    mouseLookY += dy * 0.004;
  }

  function onPointerUp() {
    pointerDown = false;
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
    if (typeof v.autopilot === 'boolean') touchState.autopilot = v.autopilot;
  });

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  domElement.addEventListener('wheel', onWheel, { passive: true });

  function update() {
    let kx = 0;
    let ky = 0;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) kx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) kx += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) ky += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) ky -= 1;

    // Normalize keyboard diagonal
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

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const dead = (v) => (Math.abs(v) < 0.15 ? 0 : v);
      gx += dead(pad.axes[0] || 0);
      gy -= dead(pad.axes[1] || 0);
      glx += dead(pad.axes[2] || 0) * 0.04;
      gly += dead(pad.axes[3] || 0) * 0.04;
      gpSprint = gpSprint || Boolean(pad.buttons[6]?.pressed || pad.buttons[7]?.pressed || pad.buttons[10]?.pressed);
      gpHike = gpHike || Boolean(pad.buttons[4]?.pressed);
      const jumpNow = Boolean(pad.buttons[0]?.pressed);
      if (jumpNow && !prevJumpGamepad) gpJump = true;
      prevJumpGamepad = jumpNow;

      const pauseNow = Boolean(pad.buttons[9]?.pressed);
      if (pauseNow && !prevPauseGamepad) events.emit('input:pause');
      prevPauseGamepad = pauseNow;
    }

    const mx = Math.max(-1, Math.min(1, kx + gx + touchState.moveX));
    const my = Math.max(-1, Math.min(1, ky + gy + touchState.moveY));
    state.move.x = mx;
    state.move.y = my;

    state.look.x = mouseLookX + touchState.lookX + glx;
    state.look.y = mouseLookY + touchState.lookY + gly;
    mouseLookX = 0;
    mouseLookY = 0;
    touchState.lookX = 0;
    touchState.lookY = 0;

    state.zoomDelta = wheelDelta;
    wheelDelta = 0;

    state.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') || gpSprint || touchState.sprint;
    state.hike = keys.has('ControlLeft') || keys.has('AltLeft') || gpHike || touchState.hike;
    state.jump = keys.has('Space') || gpJump || touchState.jump;
    touchState.jump = false;

    const autoKey = keys.has('KeyP');
    state.autopilot = (autoKey && !prevAutoKey) || touchState.autopilot;
    prevAutoKey = autoKey;

    const pauseKey = keys.has('Escape');
    state.pause = pauseKey && !prevPauseKey;
    prevPauseKey = pauseKey;

    const camKey = keys.has('KeyC');
    state.cameraModeToggle = camKey && !prevCamKey;
    prevCamKey = camKey;
  }

  function dispose() {
    unsubMove();
    unsubLook();
    unsubActions();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    domElement.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    domElement.removeEventListener('wheel', onWheel);
  }

  return Object.assign(state, { update, dispose });
}
