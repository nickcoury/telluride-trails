/**
 * Gentle, unobtrusive procedural San Juan menu music loop:
 * - Warm felt-harp / Rhodes arpeggiated chords in D Major (Dadd9 -> Bm7 -> Gmaj7 -> A6sus4)
 * - Sparse stochastic D-major pentatonic mountain melody
 * - Lookahead Web Audio scheduler that pauses completely when in-game
 * - Zero graph node retention (all scheduled plucks disconnect on ended)
 */

const NOTE = {
  G2: 98.00,
  A2: 110.00,
  B2: 123.47,
  D3: 146.83,
  E3: 164.81,
  Fs3: 185.00,
  G3: 196.00,
  A3: 220.00,
  B3: 246.94,
  D4: 293.66,
  E4: 329.63,
  Fs4: 369.99,
  A4: 440.00,
  B4: 493.88,
  D5: 587.33,
  E5: 659.25,
  Fs5: 739.99,
  A5: 880.00,
};

const CHORDS = [
  [NOTE.D3, NOTE.A3, NOTE.E4, NOTE.Fs4], // Dadd9
  [NOTE.B2, NOTE.Fs3, NOTE.A3, NOTE.D4], // Bm7
  [NOTE.G2, NOTE.D3, NOTE.Fs3, NOTE.B3], // Gmaj7
  [NOTE.A2, NOTE.E3, NOTE.Fs3, NOTE.D4], // A6sus4
];

const MELODY_POOL = [NOTE.D4, NOTE.E4, NOTE.Fs4, NOTE.A4, NOTE.B4, NOTE.D5, NOTE.E5, NOTE.Fs5, NOTE.A5];

export function createMenuMusic(audioCtx) {
  let mixGain = null;
  let warmFilter = null;
  let delayNode = null;
  let delayFeedback = null;
  let graphBuilt = false;

  let active = false;
  let timerId = 0;
  let nextStepTime = 0;
  let stepIdx = 0;
  let disposed = false;

  const STEP_SEC = 0.44; // ~68 BPM eighth-note pulse

  function ensureGraph() {
    if (graphBuilt || !audioCtx.isUnlocked || !audioCtx.context) return;
    const ctx = audioCtx.context;

    warmFilter = ctx.createBiquadFilter();
    warmFilter.type = 'lowpass';
    warmFilter.frequency.value = 1850;
    warmFilter.Q.value = 0.6;

    mixGain = ctx.createGain();
    mixGain.gain.value = active ? 1 : 0;

    // Gentle alpine delay (380ms subtle echo)
    delayNode = ctx.createDelay(1.0);
    delayNode.delayTime.value = 0.38;
    delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.24;
    const delayWet = ctx.createGain();
    delayWet.gain.value = 0.22;

    warmFilter.connect(mixGain);
    warmFilter.connect(delayNode);
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);
    delayNode.connect(delayWet);
    delayWet.connect(mixGain);

    mixGain.connect(audioCtx.musicGain);
    graphBuilt = true;
  }

  function schedulePluck(freq, time, duration, amp, isBass = false) {
    if (!audioCtx.isReady || !warmFilter) return;
    const release = audioCtx.acquireVoice('music', Math.ceil(duration * 1000) + 120);
    if (!release) return;

    const ctx = audioCtx.context;
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(freq, time);
    osc2.frequency.setValueAtTime(isBass ? freq * 2 : freq * 1.002, time);

    const g1 = ctx.createGain();
    const g2 = ctx.createGain();
    g1.gain.value = 0.65;
    g2.gain.value = isBass ? 0.22 : 0.35;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, time);
    env.gain.linearRampToValueAtTime(amp, time + 0.025);
    env.gain.exponentialRampToValueAtTime(amp * 0.28, time + duration * 0.45);
    env.gain.exponentialRampToValueAtTime(0.0001, time + duration);

    osc1.connect(g1);
    osc2.connect(g2);
    g1.connect(env);
    g2.connect(env);
    env.connect(warmFilter);

    osc1.onended = () => {
      try { env.disconnect(); } catch {}
      release();
    };
    osc1.start(time);
    osc2.start(time);
    osc1.stop(time + duration + 0.03);
    osc2.stop(time + duration + 0.03);
  }

  function tickScheduler() {
    if (disposed || !active || !audioCtx.isReady || !audioCtx.context) return;
    ensureGraph();
    if (!graphBuilt) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    if (nextStepTime < now) {
      nextStepTime = now + 0.06;
    }

    while (nextStepTime < now + 0.26) {
      const bar = Math.floor(stepIdx / 8) % CHORDS.length;
      const beatInBar = stepIdx % 8;
      const chord = CHORDS[bar];

      if (beatInBar === 0) {
        schedulePluck(chord[0], nextStepTime, 2.8, 0.085, true);
      } else if (beatInBar === 4) {
        schedulePluck(chord[1], nextStepTime, 1.9, 0.055, false);
      }

      if (beatInBar === 1 || beatInBar === 3 || beatInBar === 6) {
        const note = chord[(beatInBar + bar) % chord.length];
        schedulePluck(note, nextStepTime, 1.45, 0.042, false);
      }

      if ((beatInBar === 2 || beatInBar === 5) && Math.random() < 0.58) {
        const mNote = MELODY_POOL[Math.floor(Math.random() * MELODY_POOL.length)];
        schedulePluck(mNote, nextStepTime, 1.75, 0.032, false);
      }

      stepIdx = (stepIdx + 1) % (CHORDS.length * 8);
      nextStepTime += STEP_SEC;
    }
  }

  function setAppState(appState) {
    const shouldPlay = appState === 'title' || appState === 'loading';
    if (shouldPlay === active && graphBuilt) return;
    active = shouldPlay;

    if (active) {
      ensureGraph();
      if (mixGain && audioCtx.context) {
        mixGain.gain.setTargetAtTime(1, audioCtx.context.currentTime, 0.35);
      }
      if (!timerId) {
        if (audioCtx.context) nextStepTime = audioCtx.context.currentTime + 0.08;
        timerId = setInterval(tickScheduler, 140);
      }
    } else {
      if (mixGain && audioCtx.context) {
        mixGain.gain.setTargetAtTime(0, audioCtx.context.currentTime, 0.45);
      }
      if (timerId) {
        clearInterval(timerId);
        timerId = 0;
      }
    }
  }

  const unsubUnlock = audioCtx.onUnlock(() => {
    if (active) {
      ensureGraph();
      if (mixGain && audioCtx.context) {
        mixGain.gain.setTargetAtTime(1, audioCtx.context.currentTime, 0.35);
      }
      if (!timerId) {
        nextStepTime = audioCtx.context.currentTime + 0.08;
        timerId = setInterval(tickScheduler, 140);
      }
    }
  });

  function dispose() {
    disposed = true;
    active = false;
    unsubUnlock?.();
    if (timerId) {
      clearInterval(timerId);
      timerId = 0;
    }
    if (warmFilter) warmFilter.disconnect();
    if (delayNode) delayNode.disconnect();
    if (delayFeedback) delayFeedback.disconnect();
    if (mixGain) mixGain.disconnect();
  }

  return {
    setAppState,
    dispose,
  };
}
