/**
 * UI & game event SFX synthesizer:
 * - Tactile UI button/control clicks
 * - Tone-aware toast cues (info, ok, warn, bad, wildlife, joke)
 * - Aid station checkpoint cowbell + chime
 * - Eat / flask refill micro-SFX
 * - Achievement arpeggio
 * - Hardrock rock-kiss ceremony & finish fanfare
 */

const DRINK_KEYS = new Set(['water', 'electro', 'cola', 'broth', 'coffee']);

export function createUiSfxSystem(audioCtx, engine) {
  let lastClickMs = 0;
  let lastToastMs = 0;

  function playTone(freq, startTime, duration, {
    type = 'sine',
    gain = 0.09,
    attack = 0.006,
    freqEnd = null,
    filterFreq = 0,
    reverb = false,
  } = {}) {
    if (!audioCtx.isReady || !audioCtx.context) return;
    const ctx = audioCtx.context;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    if (freqEnd !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), startTime + duration);
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(gain, startTime + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    let last = osc;
    if (filterFreq > 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = filterFreq;
      last.connect(lp);
      last = lp;
    }
    last.connect(env);
    env.connect(audioCtx.sfxGain);
    if (reverb && audioCtx.canyonConvolver) {
      env.connect(audioCtx.canyonConvolver);
    }

    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  function playCowbell(startTime, gain = 0.09) {
    if (!audioCtx.isReady || !audioCtx.context) return;
    const ctx = audioCtx.context;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 820;
    bp.Q.value = 2.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(gain, startTime + 0.004);
    env.gain.exponentialRampToValueAtTime(gain * 0.3, startTime + 0.08);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.42);

    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'square';
    o2.type = 'square';
    o1.frequency.setValueAtTime(545, startTime);
    o2.frequency.setValueAtTime(815, startTime);

    o1.connect(bp);
    o2.connect(bp);
    bp.connect(env);
    env.connect(audioCtx.sfxGain);
    if (audioCtx.canyonConvolver) env.connect(audioCtx.canyonConvolver);

    o1.start(startTime);
    o2.start(startTime);
    o1.stop(startTime + 0.45);
    o2.stop(startTime + 0.45);
  }

  function playUiClick() {
    const nowMs = performance.now();
    if (nowMs - lastClickMs < 45) return;
    lastClickMs = nowMs;

    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 120);
    if (!release) return;

    const t = audioCtx.context.currentTime;
    playTone(720, t, 0.042, { type: 'triangle', gain: 0.045, attack: 0.002, freqEnd: 460 });
  }

  function playToast(tone = 'info') {
    const nowMs = performance.now();
    if (nowMs - lastToastMs < 180) return;
    lastToastMs = nowMs;

    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 650);
    if (!release) return;

    const t = audioCtx.context.currentTime;
    if (tone === 'ok') {
      playTone(587.33, t, 0.14, { type: 'sine', gain: 0.065 });
      playTone(880.0, t + 0.075, 0.22, { type: 'sine', gain: 0.065, reverb: true });
    } else if (tone === 'warn') {
      playTone(523.25, t, 0.11, { type: 'triangle', gain: 0.06 });
      playTone(440.0, t + 0.09, 0.16, { type: 'triangle', gain: 0.055 });
    } else if (tone === 'bad' || tone === 'danger') {
      playTone(293.66, t, 0.16, { type: 'triangle', gain: 0.08, filterFreq: 1100 });
      playTone(220.0, t + 0.11, 0.24, { type: 'triangle', gain: 0.075, filterFreq: 950 });
    } else if (tone === 'wildlife') {
      playTone(880, t, 0.16, { type: 'sine', gain: 0.045, reverb: true });
      playTone(1318.5, t + 0.09, 0.24, { type: 'sine', gain: 0.04, reverb: true });
    } else {
      playTone(659.25, t, 0.09, { type: 'sine', gain: 0.045 });
    }
  }

  function playCheckpoint() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 1100);
    if (!release) return;
    const t = audioCtx.context.currentTime;
    playCowbell(t, 0.095);
    playTone(587.33, t + 0.08, 0.26, { type: 'triangle', gain: 0.08, reverb: true });
    playTone(880.0, t + 0.17, 0.34, { type: 'sine', gain: 0.085, reverb: true });
    playTone(1174.66, t + 0.27, 0.45, { type: 'sine', gain: 0.07, reverb: true });
  }

  function playAchievement() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 1400);
    if (!release) return;
    const t = audioCtx.context.currentTime;
    const notes = [587.33, 739.99, 880.0, 1174.66, 1318.51];
    for (let i = 0; i < notes.length; i++) {
      playTone(notes[i], t + i * 0.075, 0.48, {
        type: i % 2 === 0 ? 'sine' : 'triangle',
        gain: 0.075,
        reverb: true,
      });
    }
  }

  function playEatOrDrink(isDrink) {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('sfx', 400);
    if (!release) return;
    const ctx = audioCtx.context;
    const t = ctx.currentTime;

    if (isDrink) {
      playTone(340, t, 0.09, { type: 'sine', gain: 0.075, freqEnd: 640 });
      playTone(460, t + 0.08, 0.09, { type: 'sine', gain: 0.065, freqEnd: 790 });
    } else {
      const white = audioCtx.getNoiseBuffer('white');
      if (white) {
        const src = ctx.createBufferSource();
        src.buffer = white;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2400;
        bp.Q.value = 1.6;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(0.07, t + 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
        src.connect(bp);
        bp.connect(env);
        env.connect(audioCtx.sfxGain);
        src.start(t, Math.random() * 0.4, 0.1);
      }
      playTone(280, t + 0.04, 0.06, { type: 'triangle', gain: 0.05, freqEnd: 180 });
    }
  }

  function playRockKiss() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 2200);
    if (!release) return;
    const t = audioCtx.context.currentTime;
    // Warm reverent Hardrock stone-kiss swell
    playTone(293.66, t, 1.4, { type: 'triangle', gain: 0.09, attack: 0.12, filterFreq: 1400, reverb: true });
    playTone(440.0, t + 0.06, 1.4, { type: 'sine', gain: 0.08, attack: 0.12, reverb: true });
    playTone(739.99, t + 0.18, 1.5, { type: 'sine', gain: 0.07, attack: 0.14, reverb: true });
    playCowbell(t + 0.45, 0.08);
  }

  function playFinishFanfare(ceremony) {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 3000);
    if (!release) return;
    const t = audioCtx.context.currentTime;

    // Triumphant D-major alpine fanfare
    const fanfare = [
      { f: 293.66, dt: 0.00, dur: 0.25, type: 'sawtooth', g: 0.06 },
      { f: 440.00, dt: 0.14, dur: 0.25, type: 'sawtooth', g: 0.06 },
      { f: 587.33, dt: 0.28, dur: 0.42, type: 'sawtooth', g: 0.075 },
      { f: 739.99, dt: 0.46, dur: 0.65, type: 'triangle', g: 0.085 },
      { f: 880.00, dt: 0.62, dur: 1.50, type: 'triangle', g: 0.09 },
      { f: 1174.66, dt: 0.66, dur: 1.60, type: 'sine', g: 0.08 },
      { f: 587.33, dt: 0.62, dur: 1.55, type: 'sine', g: 0.075 },
    ];
    for (const n of fanfare) {
      playTone(n.f, t + n.dt, n.dur, {
        type: n.type,
        gain: n.g,
        attack: 0.02,
        filterFreq: n.type === 'sawtooth' ? 1600 : 0,
        reverb: true,
      });
    }
    playCowbell(t + 0.28, 0.09);
    if (ceremony === 'kiss_rock') {
      playCowbell(t + 0.64, 0.10);
    }
  }

  function playDnfCue() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 1400);
    if (!release) return;
    const t = audioCtx.context.currentTime;
    playTone(440.0, t, 0.35, { type: 'sine', gain: 0.07, reverb: true });
    playTone(349.23, t + 0.22, 0.45, { type: 'sine', gain: 0.07, reverb: true });
    playTone(293.66, t + 0.46, 0.75, { type: 'triangle', gain: 0.065, filterFreq: 1100, reverb: true });
  }

  function playStartCue() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('ui', 700);
    if (!release) return;
    const t = audioCtx.context.currentTime;
    playTone(587.33, t, 0.18, { type: 'triangle', gain: 0.065, reverb: true });
    playTone(880.0, t + 0.10, 0.34, { type: 'sine', gain: 0.075, reverb: true });
  }

  // Delegated UI click listener (unlocks audio + plays crisp UI click)
  const onDocClick = (e) => {
    const target = e.target?.closest?.(
      'button, [role="button"], .chip, .tab-btn, .seg-btn, .poi-card, .race-card, input[type="checkbox"]'
    );
    if (!target) return;
    audioCtx.unlock();
    playUiClick();
  };
  document.addEventListener('click', onDocClick, { capture: true, passive: true });

  // Event bus listeners
  const unsubs = [
    engine?.events?.on?.('game:toast', (p) => playToast(p?.tone || p?.kind || 'info')),
    engine?.events?.on?.('game:checkpoint', () => playCheckpoint()),
    engine?.events?.on?.('game:achievement', () => playAchievement()),
    engine?.events?.on?.('game:started', () => playStartCue()),
    engine?.events?.on?.('game:resumed', () => playStartCue()),
    engine?.events?.on?.('game:finish', (res) => playFinishFanfare(res?.ceremony)),
    engine?.events?.on?.('game:dnf', () => playDnfCue()),
    engine?.events?.on?.('ui:kissRock', () => playRockKiss()),
    engine?.events?.on?.('ui:eat', (e) => playEatOrDrink(DRINK_KEYS.has(e?.key))),
    engine?.events?.on?.('ui:refill', () => playEatOrDrink(true)),
    engine?.events?.on?.('ui:getup', () => playUiClick()),
  ];

  function dispose() {
    document.removeEventListener('click', onDocClick, true);
    for (const u of unsubs) u?.();
  }

  return {
    playUiClick,
    playToast,
    playCheckpoint,
    playAchievement,
    playFinishFanfare,
    playRockKiss,
    dispose,
  };
}
