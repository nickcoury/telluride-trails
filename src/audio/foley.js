/**
 * Runner foley synthesizer:
 * - Cadence/gait-synced footsteps across 10 San Juan surfaces
 *   (road, track, trail, path, grass, forest, scree, talus, snow, creek)
 * - Jump takeoff / landing thud and fall impact
 * - Effort-, altitude-, and fatigue-driven breathing bed
 */

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const GAIT_CADENCE_BASE = {
  idle: 0,
  fallen: 0,
  ceremony: 0,
  walk: 1.75,
  hike: 2.0,
  'power-hike': 2.05,
  run: 2.7,
  sprint: 3.35,
  stumble: 3.4,
};

export function createFoleySystem(audioCtx, engine) {
  let stepAccum = 0;
  let stepSide = 1; // -1 left, +1 right
  let prevFallen = false;
  let prevJumpPressed = false;
  let lastHud = null;

  // Breathing continuous graph (lazy-built on unlock)
  let breathStarted = false;
  let breathSrc = null;
  let breathFilter = null;
  let breathGain = null;
  let breathPhase = 0;

  function ensureBreathNodes() {
    if (breathStarted || !audioCtx.isUnlocked || !audioCtx.context) return;
    const ctx = audioCtx.context;
    const pink = audioCtx.getNoiseBuffer('pink');
    if (!pink) return;

    breathSrc = ctx.createBufferSource();
    breathSrc.buffer = pink;
    breathSrc.loop = true;

    breathFilter = ctx.createBiquadFilter();
    breathFilter.type = 'bandpass';
    breathFilter.frequency.value = 680;
    breathFilter.Q.value = 1.65;

    breathGain = ctx.createGain();
    breathGain.gain.value = 0;

    breathSrc.connect(breathFilter);
    breathFilter.connect(breathGain);
    breathGain.connect(audioCtx.sfxGain);
    breathSrc.start(0, Math.random() * 0.8);
    breathStarted = true;
  }

  function playNoiseBurst(ctx, buf, {
    startTime,
    duration,
    offset = Math.random() * 0.8,
    filterType = 'bandpass',
    freq = 900,
    freqEnd = null,
    q = 1.2,
    gain = 0.2,
    pan = 0,
    attack = 0.004,
  }) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, startTime);
    if (freqEnd !== null) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), startTime + duration);
    }
    filter.Q.value = q;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(gain, startTime + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    let tail = env;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -0.95, 0.95);
      env.connect(panner);
      tail = panner;
    }

    src.connect(filter);
    filter.connect(env);
    tail.connect(audioCtx.sfxGain);

    src.start(startTime, offset % Math.max(0.1, buf.duration - duration - 0.05), duration + 0.02);
    src.stop(startTime + duration + 0.03);
    return src;
  }

  function playSineBlip(ctx, { startTime, duration, freq, freqEnd, gain, pan = 0 }) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    if (freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), startTime + duration);
    }
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, startTime);
    env.gain.linearRampToValueAtTime(gain, startTime + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -0.95, 0.95);
      env.connect(panner);
      panner.connect(audioCtx.sfxGain);
    } else {
      env.connect(audioCtx.sfxGain);
    }
    osc.connect(env);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.01);
  }

  function triggerFootstep(surface, gait, speedMs, camMode) {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('footstep', 320);
    if (!release) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const pink = audioCtx.getNoiseBuffer('pink');
    const brown = audioCtx.getNoiseBuffer('brown');
    const white = audioCtx.getNoiseBuffer('white');
    if (!pink || !brown || !white) {
      release();
      return;
    }

    stepSide = -stepSide;
    const pan = stepSide * 0.13;
    const pitchJit = (stepSide > 0 ? 1.04 : 0.96) * (0.94 + Math.random() * 0.12);

    const gaitWeight = gait === 'sprint' ? 1.2 : gait === 'run' ? 1.0 : gait === 'power-hike' ? 0.92 : 0.72;
    const camMul = camMode === 'first-person' ? 1.15 : camMode === 'orbit' ? 0.65 : 0.85;
    const vol = clamp((0.14 + speedMs * 0.025) * gaitWeight * camMul, 0.08, 0.38);

    // Base low heel/sole thump present on solid ground
    if (surface !== 'creek') {
      playNoiseBurst(ctx, brown, {
        startTime: now,
        duration: surface === 'talus' ? 0.085 : 0.075,
        filterType: 'lowpass',
        freq: (surface === 'snow' ? 145 : surface === 'grass' ? 160 : 220) * pitchJit,
        q: 0.9,
        gain: vol * (surface === 'grass' ? 0.55 : 0.78),
        pan,
      });
    }

    switch (surface) {
      case 'road': {
        // Crisp packed-dirt / asphalt tap
        playNoiseBurst(ctx, pink, {
          startTime: now,
          duration: 0.055,
          filterType: 'bandpass',
          freq: 980 * pitchJit,
          freqEnd: 620,
          q: 1.5,
          gain: vol * 0.62,
          pan,
        });
        break;
      }
      case 'track': {
        // Dry jeep-road gravel crunch
        playNoiseBurst(ctx, pink, {
          startTime: now,
          duration: 0.095,
          filterType: 'bandpass',
          freq: 1450 * pitchJit,
          freqEnd: 920,
          q: 1.3,
          gain: vol * 0.72,
          pan,
        });
        break;
      }
      case 'scree': {
        // Loose scree: boot plant + granular pebble slide
        playNoiseBurst(ctx, white, {
          startTime: now,
          duration: 0.11,
          filterType: 'bandpass',
          freq: 2600 * pitchJit,
          freqEnd: 1400,
          q: 1.8,
          gain: vol * 0.75,
          pan,
        });
        playNoiseBurst(ctx, white, {
          startTime: now + 0.045,
          duration: 0.14,
          filterType: 'highpass',
          freq: 2200 * pitchJit,
          q: 1.1,
          gain: vol * 0.42,
          pan: pan + (Math.random() - 0.5) * 0.12,
        });
        break;
      }
      case 'talus': {
        // Resonant granite boot clack + tiny rock tick
        playNoiseBurst(ctx, pink, {
          startTime: now,
          duration: 0.065,
          filterType: 'bandpass',
          freq: 1050 * pitchJit,
          freqEnd: 520,
          q: 3.4,
          gain: vol * 0.85,
          pan,
        });
        if (Math.random() < 0.35) {
          playSineBlip(ctx, {
            startTime: now + 0.025,
            duration: 0.04,
            freq: 1450 * pitchJit,
            freqEnd: 880,
            gain: vol * 0.14,
            pan,
          });
        }
        break;
      }
      case 'snow': {
        // Signature cold alpine snow squeak + muffled compression crunch
        playNoiseBurst(ctx, white, {
          startTime: now,
          duration: 0.11,
          filterType: 'bandpass',
          freq: 1850 * pitchJit,
          freqEnd: 2450 * pitchJit,
          q: 5.2,
          gain: vol * 0.58,
          pan,
          attack: 0.012,
        });
        break;
      }
      case 'creek': {
        // Bright cold stream splash + water droplets
        playNoiseBurst(ctx, white, {
          startTime: now,
          duration: 0.19,
          filterType: 'bandpass',
          freq: 1150 * pitchJit,
          freqEnd: 2900,
          q: 1.1,
          gain: vol * 0.88,
          pan,
          attack: 0.008,
        });
        playSineBlip(ctx, {
          startTime: now + 0.04,
          duration: 0.055,
          freq: 1100 * pitchJit,
          freqEnd: 1750,
          gain: vol * 0.16,
          pan: pan - 0.08,
        });
        playSineBlip(ctx, {
          startTime: now + 0.09,
          duration: 0.05,
          freq: 1480 * pitchJit,
          freqEnd: 2100,
          gain: vol * 0.12,
          pan: pan + 0.09,
        });
        break;
      }
      case 'forest': {
        // Soft pine duff + occasional dry twig snap
        playNoiseBurst(ctx, pink, {
          startTime: now,
          duration: 0.11,
          filterType: 'bandpass',
          freq: 2200 * pitchJit,
          q: 1.0,
          gain: vol * 0.45,
          pan,
        });
        if (Math.random() < 0.25) {
          playNoiseBurst(ctx, white, {
            startTime: now + 0.015,
            duration: 0.032,
            filterType: 'bandpass',
            freq: 3100 * pitchJit,
            q: 2.8,
            gain: vol * 0.5,
            pan,
          });
        }
        break;
      }
      case 'grass': {
        // Soft tundra turf + dry grass swish
        playNoiseBurst(ctx, pink, {
          startTime: now,
          duration: 0.10,
          filterType: 'bandpass',
          freq: 2400 * pitchJit,
          freqEnd: 1600,
          q: 1.2,
          gain: vol * 0.36,
          pan,
        });
        break;
      }
      case 'path':
      case 'trail':
      default: {
        // Singletrack dirt grit + subtle toe push-off
        playNoiseBurst(ctx, pink, {
          startTime: now,
          duration: 0.08,
          filterType: 'bandpass',
          freq: (surface === 'path' ? 1680 : 1320) * pitchJit,
          freqEnd: 780,
          q: 1.4,
          gain: vol * 0.58,
          pan,
        });
        break;
      }
    }

    // Power-hike subtle hands-on-quads / fabric brush
    if (gait === 'power-hike') {
      playNoiseBurst(ctx, pink, {
        startTime: now + 0.04,
        duration: 0.065,
        filterType: 'bandpass',
        freq: 920,
        q: 1.5,
        gain: vol * 0.22,
        pan: -pan,
      });
    }
  }

  function triggerFallImpact() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('sfx', 450);
    if (!release) return;
    const ctx = audioCtx.context;
    const now = ctx.currentTime;
    const brown = audioCtx.getNoiseBuffer('brown');
    const pink = audioCtx.getNoiseBuffer('pink');
    if (brown) {
      playNoiseBurst(ctx, brown, {
        startTime: now,
        duration: 0.22,
        filterType: 'lowpass',
        freq: 190,
        freqEnd: 75,
        q: 1.0,
        gain: 0.42,
      });
    }
    if (pink) {
      playNoiseBurst(ctx, pink, {
        startTime: now + 0.03,
        duration: 0.26,
        filterType: 'bandpass',
        freq: 1450,
        freqEnd: 650,
        q: 1.2,
        gain: 0.22,
      });
    }
  }

  function triggerJumpScuff() {
    if (!audioCtx.isReady) return;
    const release = audioCtx.acquireVoice('footstep', 200);
    if (!release) return;
    const ctx = audioCtx.context;
    const pink = audioCtx.getNoiseBuffer('pink');
    if (!pink) return;
    playNoiseBurst(ctx, pink, {
      startTime: ctx.currentTime,
      duration: 0.07,
      filterType: 'bandpass',
      freq: 1500,
      freqEnd: 2200,
      q: 1.3,
      gain: 0.16,
    });
  }

  function updateBreathing(dt, hud, appState) {
    ensureBreathNodes();
    if (!breathStarted || !audioCtx.context || !breathGain) return;

    const ctx = audioCtx.context;
    const now = ctx.currentTime;

    if (appState !== 'playing' || !hud || hud.paused || !audioCtx.isReady) {
      breathGain.gain.setTargetAtTime(0, now, 0.12);
      return;
    }

    const gait = hud.gait || 'idle';
    const effortMap = {
      idle: 0.05,
      walk: 0.20,
      hike: 0.38,
      'power-hike': 0.68,
      run: 0.62,
      sprint: 0.96,
      stumble: 0.72,
      fallen: 0.55,
      ceremony: 0.15,
    };
    const baseEffort = effortMap[gait] ?? 0.25;
    const speedFactor = clamp((hud.speedMs || 0) / 4.2, 0, 1);
    const gradeFactor = clamp((hud.grade || 0) * 1.8, 0, 0.35);
    const altStress = clamp(((hud.elevFt || 8750) - 9600) / 4400, 0, 1);
    const fatigue = clamp(1 - (hud.stamina ?? 1), 0, 1);

    const intensity = clamp(
      Math.max(baseEffort, speedFactor * 0.8) * 0.55 +
      gradeFactor * 0.25 +
      altStress * 0.25 +
      fatigue * 0.35,
      0,
      1
    );

    const camMode = engine.cameraRig?.getMode?.() || 'chase';
    const camMul = camMode === 'first-person' ? 1.35 : camMode === 'orbit' ? 0.55 : 0.85;

    // Only clearly audible when working above a relaxed idle
    const audibleAmt = clamp((intensity - 0.16) / 0.84, 0, 1);
    const breathHz = 0.24 + intensity * 0.58; // 14 -> 49 breaths/min
    breathPhase = (breathPhase + dt * breathHz) % 1;

    // Asymmetric natural breath envelope: 0..0.42 inhale, 0.46..0.92 exhale
    let env = 0;
    let targetFreq = 640;
    if (breathPhase < 0.42) {
      const p = breathPhase / 0.42;
      env = Math.sin(p * Math.PI) * 0.78;
      targetFreq = 860 + intensity * 380; // airy inhale
    } else if (breathPhase >= 0.46 && breathPhase < 0.92) {
      const p = (breathPhase - 0.46) / 0.46;
      env = Math.sin(p * Math.PI);
      targetFreq = 480 + intensity * 210; // deeper exhale
    }

    const targetGain = audibleAmt * audibleAmt * 0.085 * camMul * env;
    breathFilter.frequency.setTargetAtTime(targetFreq, now, 0.04);
    breathGain.gain.setTargetAtTime(targetGain, now, 0.035);
  }

  function update(dt, hud, appState) {
    lastHud = hud;
    updateBreathing(dt, hud, appState);

    if (appState !== 'playing' || !hud || hud.paused || !audioCtx.isReady) {
      prevFallen = Boolean(hud?.fallen);
      return;
    }

    // Fall & jump one-shots
    const fallen = Boolean(hud.fallen);
    if (fallen && !prevFallen) {
      triggerFallImpact();
    }
    prevFallen = fallen;

    const jumpPressed = Boolean(engine.input?.jump);
    if (jumpPressed && !prevJumpPressed && !fallen) {
      triggerJumpScuff();
    }
    prevJumpPressed = jumpPressed;

    // Cadence-synced footsteps
    const speedMs = hud.speedMs || 0;
    const gait = hud.gait || 'idle';
    if (speedMs > 0.18 && !fallen && gait !== 'idle' && gait !== 'ceremony') {
      const baseCadence = GAIT_CADENCE_BASE[gait] ?? 2.2;
      // Modulate gently by actual speed so uphill power-hiking feels deliberate
      const cadence = clamp(baseCadence * (0.72 + clamp(speedMs / 3.2, 0.15, 0.55)), 1.45, 4.1);
      stepAccum += dt * cadence;
      if (stepAccum >= 1) {
        stepAccum -= Math.floor(stepAccum);
        const camMode = engine.cameraRig?.getMode?.() || 'chase';
        triggerFootstep(hud.surface || 'trail', gait, speedMs, camMode);
      }
    } else {
      stepAccum = 0.65; // next step triggers promptly when movement resumes
    }
  }

  function dispose() {
    if (breathSrc) {
      try { breathSrc.stop(); } catch {}
      breathSrc.disconnect();
      breathSrc = null;
    }
    if (breathFilter) breathFilter.disconnect();
    if (breathGain) breathGain.disconnect();
    breathStarted = false;
  }

  return {
    update,
    dispose,
    getLastHud: () => lastHud,
  };
}
