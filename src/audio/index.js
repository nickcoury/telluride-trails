/**
 * Telluride Trails Audio Module (owned by @audio).
 * Exports createAudio(engine, { game, world, trailData, terrain }).
 *
 * Features:
 * - Lazy Web Audio initialization + iOS silent-buffer gesture unlock + interruption recovery
 * - Automatic visibilitychange / engine:visibility suspend & resume
 * - Voice-capped, zero-jank, zero-retention procedural synthesis (0 KB external audio assets)
 * - Surface-dependent footsteps synced to gait/cadence (10 San Juan surfaces) + jump landing
 * - Effort/altitude/fatigue breathing
 * - Contextual ambient beds (ridge wind, aspen leaves, mid-July day birds, night crickets, town murmur)
 * - O(1) spatial-grid positional rivers/waterfalls, 3D gondola hum, monsoon rain + delayed canyon thunder
 * - UI clicks, de-duplicated toast/checkpoint/achievement chimes, Hardrock rock kiss & finish fanfare
 * - Gentle procedural menu music loop
 */

import { createAudioContextManager } from './context.js';
import { createFoleySystem } from './foley.js';
import { createAmbientSystem } from './ambient.js';
import { createMenuMusic } from './music.js';
import { createUiSfxSystem } from './uiSfx.js';

const AUDIO_STORAGE_KEY = 'telluride_trails_audio_v1';
const UI_SETTINGS_KEY = 'telluride_trails_settings_v1';

function readInitialSettings() {
  const out = { master: 0.75, music: 0.65, sfx: 0.85, muted: false };
  try {
    const rawAudio = localStorage.getItem(AUDIO_STORAGE_KEY);
    if (rawAudio) {
      const a = JSON.parse(rawAudio);
      if (typeof a.master === 'number') out.master = a.master;
      if (typeof a.music === 'number') out.music = a.music;
      if (typeof a.sfx === 'number') out.sfx = a.sfx;
      if (typeof a.muted === 'boolean') out.muted = a.muted;
    }
    const rawUi = localStorage.getItem(UI_SETTINGS_KEY);
    if (rawUi) {
      const u = JSON.parse(rawUi);
      if (typeof u.audio === 'boolean') out.muted = !u.audio;
      if (typeof u.volume === 'number') out.master = u.volume;
      if (typeof u.musicVolume === 'number') out.music = u.musicVolume;
      if (typeof u.sfxVolume === 'number') out.sfx = u.sfxVolume;
    }
  } catch {
    // ignore storage failures
  }
  return out;
}

function saveAudioSettings(settings) {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

export function createAudio(engine, { game, world, trailData, terrain } = {}) {
  const audioCtx = createAudioContextManager(engine);
  audioCtx.setSettings(readInitialSettings());

  const foley = createFoleySystem(audioCtx, engine, { terrain });
  const ambient = createAmbientSystem(audioCtx, engine, { terrain, trailData, world });
  const menuMusic = createMenuMusic(audioCtx);
  const uiSfx = createUiSfxSystem(audioCtx, engine);

  let latestHud = null;
  let appState = engine?.getAppState?.() || 'title';
  let disposed = false;

  menuMusic.setAppState(appState);

  function applyAudioPatch(patch = {}, persist = true) {
    const next = {};
    if (typeof patch.master === 'number') next.master = patch.master;
    if (typeof patch.music === 'number') next.music = patch.music;
    if (typeof patch.sfx === 'number') next.sfx = patch.sfx;
    if (typeof patch.muted === 'boolean') next.muted = patch.muted;
    audioCtx.setSettings(next);
    if (persist) saveAudioSettings(audioCtx.getSettings());
  }

  // Dedicated audio settings event (emitted by UI on init & slider/toggle updates)
  const unsubUiAudio = engine?.events?.on?.('ui:audio', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    applyAudioPatch(payload, true);
  });

  // Compatibility with UI's general settings event
  const unsubUiSettings = engine?.events?.on?.('ui:settings', (s) => {
    if (!s || typeof s !== 'object') return;
    const patch = {};
    if (typeof s.audio === 'boolean') patch.muted = !s.audio;
    if (typeof s.volume === 'number') patch.master = s.volume;
    if (typeof s.master === 'number') patch.master = s.master;
    if (typeof s.music === 'number') patch.music = s.music;
    if (typeof s.musicVolume === 'number') patch.music = s.musicVolume;
    if (typeof s.sfx === 'number') patch.sfx = s.sfx;
    if (typeof s.sfxVolume === 'number') patch.sfx = s.sfxVolume;
    if (typeof s.muted === 'boolean') patch.muted = s.muted;
    applyAudioPatch(patch, false);
  });

  const unsubHud = engine?.events?.on?.('hud', (hud) => {
    latestHud = hud;
  });

  const unsubAppState = engine?.events?.on?.('app:state', ({ state }) => {
    appState = state || appState;
    menuMusic.setAppState(appState);
  });

  function update(dt) {
    if (disposed) return;
    const safeDt = Math.min(0.1, Math.max(0, dt || 0));
    const curState = engine?.getAppState?.() || appState;
    if (curState !== appState) {
      appState = curState;
      menuMusic.setAppState(appState);
    }
    foley.update(safeDt, latestHud, appState);
    ambient.update(safeDt, latestHud, appState);
  }

  // Register onLateUpdate so audio reads same-frame HUD/clearance after game & world update
  const unsubUpdate = (engine?.onLateUpdate || engine?.onUpdate)?.(update);

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubUpdate?.();
    unsubUiAudio?.();
    unsubUiSettings?.();
    unsubHud?.();
    unsubAppState?.();
    uiSfx.dispose();
    menuMusic.dispose();
    ambient.dispose();
    foley.dispose();
    audioCtx.dispose();
  }

  return {
    update,
    unlock: () => audioCtx.unlock(),
    setSettings: (patch) => applyAudioPatch(patch, true),
    getSettings: () => audioCtx.getSettings(),
    getState: () => ({
      unlocked: audioCtx.isUnlocked,
      ready: audioCtx.isReady,
      hasNoiseBuffers: audioCtx.hasNoiseBuffers,
      contextState: audioCtx.context?.state || 'uninitialized',
      activeVoices: audioCtx.activeVoices,
      appState,
      settings: audioCtx.getSettings(),
      spatial: ambient.getSpatialStats(),
    }),
    triggerThunderNow: (p) => ambient.triggerThunderNow(p),
    game,
    dispose,
  };
}
