/**
 * Web Audio context manager for Telluride Trails.
 * - Lazy-initializes AudioContext on first user gesture (iOS/mobile unlock).
 * - Suspends cleanly on visibilitychange / engine:visibility to save battery.
 * - Routes music, sfx, and ambient buses through a gentle DynamicsCompressor limiter.
 * - Caps concurrent one-shot voices to prevent mobile audio thread glitching.
 * - Generates seamless crossfaded noise buffers & canyon impulse in small time slices.
 */

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const MAX_TOTAL_VOICES = 18;
const CATEGORY_CAPS = Object.freeze({
  footstep: 4,
  ui: 4,
  wildlife: 3,
  thunder: 2,
  music: 6,
  sfx: 5,
});

/**
 * Fill a seamlessly loopable noise buffer with a 45ms equal-power boundary crossfade.
 */
function buildNoiseBuffer(ctx, type, durationSec = 1.6) {
  const sr = ctx.sampleRate || 44100;
  const len = Math.max(4096, Math.floor(sr * durationSec));
  const fade = Math.min(Math.floor(sr * 0.045), Math.floor(len * 0.15));
  const total = len + fade;
  const raw = new Float32Array(total);

  if (type === 'white') {
    for (let i = 0; i < total; i++) {
      raw[i] = Math.random() * 2 - 1;
    }
  } else if (type === 'pink') {
    // Paul Kellet's refined pink noise filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < total; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // Brown / red noise (leaky integrator)
    let last = 0;
    for (let i = 0; i < total; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.024 * w) / 1.024;
      raw[i] = clamp(last * 3.4, -1, 1);
    }
  }

  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  out.set(raw.subarray(0, len));
  // Equal-power crossfade tail into head for click-free looping
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    const gOut = Math.cos(t * Math.PI * 0.5);
    const gIn = Math.sin(t * Math.PI * 0.5);
    out[i] = out[i] * gIn + raw[len + i] * gOut;
  }
  return buf;
}

/**
 * Stereo San Juan canyon impulse response (0.9s warm early reflections + tail) for thunder/music.
 */
function buildCanyonImpulse(ctx, durationSec = 0.95) {
  const sr = ctx.sampleRate || 44100;
  const len = Math.floor(sr * durationSec);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 3.8);
      const w = (Math.random() * 2 - 1) * env;
      // Gentle dark mountain-wall absorption
      lp = lp * 0.72 + w * 0.28;
      data[i] = lp * 0.45;
    }
  }
  return buf;
}

export function createAudioContextManager(engine) {
  let ctx = null;
  let masterGain = null;
  let musicGain = null;
  let sfxGain = null;
  let ambientGain = null;
  let limiter = null;
  let canyonConvolver = null;

  let unlocked = false;
  let disposed = false;
  let isHidden = typeof document !== 'undefined' ? document.hidden : false;
  let suspendTimer = 0;

  const settings = {
    master: 0.75,
    music: 0.55,
    sfx: 0.85,
    muted: false,
  };

  const buffers = {
    white: null,
    pink: null,
    brown: null,
    canyon: null,
  };

  let activeVoices = 0;
  const categoryCounts = Object.create(null);
  const unlockCallbacks = new Set();

  function applyBusGains(immediate = false) {
    if (!ctx || !masterGain) return;
    const now = ctx.currentTime;
    const targetMaster = settings.muted || isHidden ? 0 : clamp(settings.master, 0, 1);
    const targetMusic = clamp(settings.music, 0, 1);
    const targetSfx = clamp(settings.sfx, 0, 1);
    const targetAmbient = clamp(settings.sfx, 0, 1);

    if (immediate) {
      masterGain.gain.setValueAtTime(targetMaster, now);
      musicGain.gain.setValueAtTime(targetMusic, now);
      sfxGain.gain.setValueAtTime(targetSfx, now);
      ambientGain.gain.setValueAtTime(targetAmbient, now);
    } else {
      masterGain.gain.setTargetAtTime(targetMaster, now, 0.035);
      musicGain.gain.setTargetAtTime(targetMusic, now, 0.045);
      sfxGain.gain.setTargetAtTime(targetSfx, now, 0.035);
      ambientGain.gain.setTargetAtTime(targetAmbient, now, 0.045);
    }
  }

  function scheduleBuffersAsync() {
    if (!ctx || disposed) return;
    const steps = [
      () => { if (!buffers.pink && ctx) buffers.pink = buildNoiseBuffer(ctx, 'pink', 1.6); },
      () => { if (!buffers.brown && ctx) buffers.brown = buildNoiseBuffer(ctx, 'brown', 1.8); },
      () => { if (!buffers.white && ctx) buffers.white = buildNoiseBuffer(ctx, 'white', 1.2); },
      () => {
        if (!buffers.canyon && ctx) {
          buffers.canyon = buildCanyonImpulse(ctx, 0.95);
          if (canyonConvolver) canyonConvolver.buffer = buffers.canyon;
        }
      },
    ];
    let idx = 0;
    const nextSlice = () => {
      if (disposed || !ctx) return;
      if (idx < steps.length) {
        steps[idx++]();
        if (idx < steps.length) {
          setTimeout(nextSlice, 16);
        }
      }
    };
    setTimeout(nextSlice, 0);
  }

  function ensureContext() {
    if (ctx || disposed) return ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;

    ctx = new AudioCtx({ latencyHint: 'interactive' });

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 18;
    limiter.ratio.value = 4.5;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.16;

    masterGain = ctx.createGain();
    musicGain = ctx.createGain();
    sfxGain = ctx.createGain();
    ambientGain = ctx.createGain();

    musicGain.connect(limiter);
    sfxGain.connect(limiter);
    ambientGain.connect(limiter);
    limiter.connect(masterGain);
    masterGain.connect(ctx.destination);

    canyonConvolver = ctx.createConvolver();
    const canyonWet = ctx.createGain();
    canyonWet.gain.value = 0.24;
    canyonConvolver.connect(canyonWet);
    canyonWet.connect(limiter);

    applyBusGains(true);
    scheduleBuffersAsync();
    return ctx;
  }

  function unlock() {
    if (disposed) return false;
    const c = ensureContext();
    if (!c) return false;

    if (c.state === 'suspended' && !isHidden) {
      c.resume().catch(() => {});
    }

    if (!unlocked) {
      unlocked = true;
      // iOS Safari silent 1-sample buffer unlock inside gesture
      try {
        const buf = c.createBuffer(1, 1, 22050);
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        src.start(0);
      } catch {
        // ignore
      }
      applyBusGains(false);
      for (const cb of unlockCallbacks) {
        try {
          cb(c);
        } catch (err) {
          console.warn('[audio] unlock listener error:', err);
        }
      }
    }
    return true;
  }

  function onVisibilityChange(hidden) {
    isHidden = Boolean(hidden);
    if (!ctx) return;
    if (suspendTimer) {
      clearTimeout(suspendTimer);
      suspendTimer = 0;
    }
    if (isHidden) {
      applyBusGains(false);
      suspendTimer = setTimeout(() => {
        if (isHidden && ctx && ctx.state === 'running') {
          ctx.suspend().catch(() => {});
        }
      }, 45);
    } else if (unlocked) {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      applyBusGains(false);
    }
  }

  // Gesture unlock hooks (capture phase so they fire before stopPropagation)
  const gestureEvents = ['pointerdown', 'touchstart', 'keydown', 'click'];
  const onGesture = () => {
    unlock();
    if (unlocked && ctx && ctx.state === 'running') {
      for (const ev of gestureEvents) {
        window.removeEventListener(ev, onGesture, true);
      }
    }
  };
  for (const ev of gestureEvents) {
    window.addEventListener(ev, onGesture, { capture: true, passive: true });
  }

  const onDocVis = () => onVisibilityChange(document.hidden);
  document.addEventListener('visibilitychange', onDocVis);
  const unsubVis = engine?.events?.on?.('engine:visibility', ({ hidden }) => {
    onVisibilityChange(hidden);
  });

  function getNoiseBuffer(type = 'pink') {
    if (!ctx) return null;
    if (!buffers[type]) {
      buffers[type] = buildNoiseBuffer(ctx, type, type === 'brown' ? 1.8 : 1.5);
    }
    return buffers[type];
  }

  /**
   * Acquire a voice slot in the pool. Returns a release() function or null if capped.
   */
  function acquireVoice(category = 'sfx', autoReleaseMs = 3000) {
    if (!ctx || isHidden || settings.muted || settings.master <= 0.001) return null;
    const catCap = CATEGORY_CAPS[category] ?? 6;
    const catCount = categoryCounts[category] || 0;
    if (activeVoices >= MAX_TOTAL_VOICES || catCount >= catCap) {
      return null;
    }

    activeVoices++;
    categoryCounts[category] = catCount + 1;
    let released = false;
    const timer = autoReleaseMs > 0
      ? setTimeout(() => release(), autoReleaseMs)
      : 0;

    function release() {
      if (released) return;
      released = true;
      if (timer) clearTimeout(timer);
      activeVoices = Math.max(0, activeVoices - 1);
      categoryCounts[category] = Math.max(0, (categoryCounts[category] || 1) - 1);
    }

    return release;
  }

  function setSettings(patch = {}) {
    if (typeof patch.master === 'number' && Number.isFinite(patch.master)) {
      settings.master = clamp(patch.master, 0, 1);
    }
    if (typeof patch.music === 'number' && Number.isFinite(patch.music)) {
      settings.music = clamp(patch.music, 0, 1);
    }
    if (typeof patch.sfx === 'number' && Number.isFinite(patch.sfx)) {
      settings.sfx = clamp(patch.sfx, 0, 1);
    }
    if (typeof patch.muted === 'boolean') {
      settings.muted = patch.muted;
    }
    applyBusGains(false);
  }

  function onUnlock(fn) {
    unlockCallbacks.add(fn);
    if (unlocked && ctx) {
      try {
        fn(ctx);
      } catch (err) {
        console.warn('[audio] onUnlock callback error:', err);
      }
    }
    return () => unlockCallbacks.delete(fn);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (suspendTimer) clearTimeout(suspendTimer);
    for (const ev of gestureEvents) {
      window.removeEventListener(ev, onGesture, true);
    }
    document.removeEventListener('visibilitychange', onDocVis);
    unsubVis?.();
    unlockCallbacks.clear();
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }
  }

  return {
    get context() { return ctx; },
    get masterGain() { return masterGain; },
    get musicGain() { return musicGain; },
    get sfxGain() { return sfxGain; },
    get ambientGain() { return ambientGain; },
    get canyonConvolver() { return canyonConvolver; },
    get isUnlocked() { return unlocked; },
    get isReady() { return Boolean(ctx && unlocked && !isHidden && !settings.muted); },
    get activeVoices() { return activeVoices; },
    unlock,
    onUnlock,
    getNoiseBuffer,
    acquireVoice,
    setSettings,
    getSettings: () => ({ ...settings }),
    dispose,
  };
}
