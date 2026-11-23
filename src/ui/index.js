import '../styles/main.css';
import { setupPWA } from './pwa.js';
import { loadSettings, saveSettings } from './storage.js';
import { createHUD } from './hud.js';
import { createTouchControls } from './touchControls.js';
import { createDialogs } from './dialogs.js';
import { createScreens } from './screens.js';

/**
 * Telluride Trails UI Entry Point (PLAN.md contract).
 * @param {object} engine
 * @param {{ trailData: object, game: object, terrain?: object }} deps
 */
export function createUI(engine, { trailData, game, terrain } = {}) {
  const root = document.getElementById('ui-root') || document.body;
  root.classList.add('tt-ui-root');

  const pwa = setupPWA(engine.assetsBase);
  let settings = loadSettings();
  let lastRaceId = null;

  // Apply persisted settings (respecting URL ?tier= overrides for perfqa/dev)
  const params = new URLSearchParams(window.location.search);
  if (!params.has('tier')) {
    if (settings.qualityTier === 'auto') {
      engine.quality?.setAuto?.(true);
    } else if (settings.qualityTier) {
      engine.quality?.setTier?.(settings.qualityTier, { auto: false });
    }
    if (Number.isFinite(settings.renderScale) && settings.renderScale !== 1.0) {
      engine.quality?.setRenderScale?.(settings.renderScale);
    }
  }
  engine.events.emit('ui:settings', { ...settings });
  engine.events.emit('ui:audio', {
    master: settings.volume ?? 0.75,
    music: settings.musicVolume ?? 0.65,
    sfx: settings.sfxVolume ?? 0.85,
    muted: !settings.audio,
  });

  const getSettings = () => settings;

  const touchControls = createTouchControls({
    container: root,
    engine,
    getSettings,
  });
  touchControls.setVisible(false);

  const hud = createHUD({
    container: root,
    engine,
    trailData,
    getSettings,
    onPause: () => {
      game.pause?.();
      engine.events.emit('ui:pause');
    },
    onVibrate: (p) => touchControls.vibrate(p),
  });

  const dialogs = createDialogs({
    container: root,
    engine,
    getSettings,
    onUpdateSettings: (patch) => {
      settings = saveSettings(patch);
      engine.events.emit('ui:settings', { ...settings });
  engine.events.emit('ui:audio', {
    master: settings.volume ?? 0.75,
    music: settings.musicVolume ?? 0.65,
    sfx: settings.sfxVolume ?? 0.85,
    muted: !settings.audio,
  });
      touchControls.syncTouchVisibility();
      hud.refreshUnits();
      screens.refresh();
    },
    onResume: () => {
      game.resume?.();
      engine.events.emit('ui:resume');
    },
    onQuitToTitle: () => {
      if (typeof game.saveAndQuit === 'function') game.saveAndQuit();
      else if (typeof game.pause === 'function') game.pause();
      engine.setAppState?.('title');
      screens.showScreen('title');
    },
    onShowToast: (text, tone, ms) => hud.showToast(text, tone, ms),
  });

  async function preloadAndLaunch({ x, z, stageLabel, launchFn }) {
    dialogs.resetDilationFlag();
    engine.setAppState?.('loading');
    screens.showScreen('loading');
    screens.setLoadingProgress(8, stageLabel || 'Streaming USGS 3DEP terrain…');

    let progress = 10;
    const pulse = setInterval(() => {
      progress = Math.min(88, progress + 7);
      screens.setLoadingProgress(progress);
    }, 140);

    try {
      const tasks = [];
      if (typeof terrain?.preload === 'function') {
        tasks.push(terrain.preload(x, z, 1200));
      }
      if (typeof trailData?.loadArea === 'function') {
        tasks.push(trailData.loadArea(x, z, 1800));
      }
      await Promise.all(tasks);
      screens.setLoadingProgress(100, 'Lacing trail shoes…');
    } catch (err) {
      console.warn('[ui] preload warning:', err);
    } finally {
      clearInterval(pulse);
    }

    launchFn();
    performance.mark('tt:first-playable');
  }

  const screens = createScreens({
    container: root,
    engine,
    trailData,
    terrain,
    game,
    pwa,
    getSettings,
    onSaveStartTime: (freeRunStartTime) => {
      settings = saveSettings({ freeRunStartTime });
    },
    onStartFreeRun: (loc) => {
      lastRaceId = null;
      const x = loc.x ?? 0;
      const z = loc.z ?? 0;
      const heading = loc.heading ?? 0;
      const startTime = loc.startTime || settings.freeRunStartTime || 'morning';
      const startHour = loc.startHour;
      preloadAndLaunch({
        x,
        z,
        stageLabel: `Preloading ${loc.name || 'San Juan trailhead'}…`,
        launchFn: () => {
          game.startFreeRun({ x, z, heading, startTime, startHour });
          engine.events.emit('ui:freerun', { x, z, heading, startTime, startHour });
        },
      });
    },
    onStartRace: (race) => {
      lastRaceId = race.id;
      const sx = race.start?.x ?? 0;
      const sz = race.start?.z ?? 0;
      preloadAndLaunch({
        x: sx,
        z: sz,
        stageLabel: `Staging start line for ${race.name}…`,
        launchFn: () => {
          game.startRace(race.id);
          engine.events.emit('ui:race', { id: race.id });
        },
      });
    },
    onResumeSaved: () => {
      const saved = game.getSavedRun?.();
      const sx = saved?.x ?? 0;
      const sz = saved?.z ?? 0;
      lastRaceId = saved?.raceId || null;
      preloadAndLaunch({
        x: sx,
        z: sz,
        stageLabel: 'Restoring saved mountain run…',
        launchFn: () => {
          if (typeof game.resumeSaved === 'function') game.resumeSaved();
          else game.resume?.();
          engine.events.emit('ui:resumeSaved');
        },
      });
    },
    onOpenSettings: () => dialogs.openSettings(),
    onOpenCredits: () => dialogs.openCredits(),
  });

  // App state machine listener
  const unsubAppState = engine.events.on('app:state', ({ state }) => {
    if (state === 'title') {
      hud.setVisible(false);
      touchControls.setVisible(false);
      dialogs.closePause();
      screens.showScreen('title');
    } else if (state === 'loading') {
      hud.setVisible(false);
      touchControls.setVisible(false);
      screens.showScreen('loading');
    } else if (state === 'playing') {
      screens.showScreen('none');
      dialogs.closePause();
      hud.setVisible(true);
      touchControls.setVisible(!hud.isPhotoMode());
    } else if (state === 'paused') {
      dialogs.openPause();
    } else if (state === 'results') {
      hud.setVisible(false);
      touchControls.setVisible(false);
    }
  });

  // Live HUD & game events
  const unsubHud = engine.events.on('hud', (data) => {
    hud.update(data);
    touchControls.updateContext(data);
    // Keep touch controls hidden during photo mode
    if (engine.getAppState?.() === 'playing') {
      touchControls.setVisible(!hud.isPhotoMode());
    }
  });

  const unsubToast = engine.events.on('game:toast', (payload) => {
    if (!payload) return;
    const text = typeof payload === 'string' ? payload : payload.text;
    const tone = payload.tone || payload.kind || 'info';
    const ms = payload.durationMs || (payload.durationS ? payload.durationS * 1000 : 4500);
    hud.showToast(text, tone, ms);
    if (tone === 'warn' || tone === 'danger' || tone === 'bad') {
      touchControls.vibrate([30, 20, 30]);
    }
  });

  const unsubCp = engine.events.on('game:checkpoint', (cp) => {
    const name = cp?.name || 'Checkpoint';
    hud.showToast(`📍 Reached ${name}`, 'ok', 4000);
    touchControls.vibrate([15, 30, 15]);
  });

  const unsubAch = engine.events.on('game:achievement', (ach) => {
    const title = ach?.title || ach?.name || String(ach);
    hud.showToast(`🏆 Achievement: ${title}`, 'ok', 5000);
    touchControls.vibrate([20, 40, 20]);
  });

  const unsubFinish = engine.events.on('game:finish', (res) => {
    engine.setAppState?.('results');
    touchControls.vibrate([30, 40, 60]);
    dialogs.showResults(
      { raceId: lastRaceId, ...res, dnf: false },
      {
        onRestartRace: (raceId) => {
          const race = trailData?.races?.find((r) => r.id === raceId);
          if (race) {
            preloadAndLaunch({
              x: race.start?.x ?? 0,
              z: race.start?.z ?? 0,
              stageLabel: `Restarting ${race.name}…`,
              launchFn: () => game.startRace(race.id),
            });
          }
        },
      }
    );
  });

  const unsubDnf = engine.events.on('game:dnf', (res) => {
    engine.setAppState?.('results');
    dialogs.showResults(
      { raceId: lastRaceId, ...res, dnf: true },
      {
        onRestartRace: (raceId) => {
          const race = trailData?.races?.find((r) => r.id === raceId);
          if (race) {
            preloadAndLaunch({
              x: race.start?.x ?? 0,
              z: race.start?.z ?? 0,
              stageLabel: `Restarting ${race.name}…`,
              launchFn: () => game.startRace(race.id),
            });
          }
        },
      }
    );
  });

  const unsubPreloadProg = engine.events.on('terrain:preload-progress', (p) => {
    const pct = typeof p === 'number' ? p * 100 : p?.pct ?? (p?.loaded / Math.max(1, p?.total)) * 100;
    if (Number.isFinite(pct)) screens.setLoadingProgress(pct, p?.stage);
  });

  // Refresh POI/race screens if vector chunks or data finish loading
  const unsubDataChunk = engine.events.on('data:chunk', () => {
    screens.refresh();
  });

  // Initial screen unless ?bench already moved state away from 'title'
  if (engine.getAppState?.() === 'title') {
    screens.showScreen('title');
  }

  return {
    showScreen: (name) => screens.showScreen(name),
    showToast: (text, tone, ms) => hud.showToast(text, tone, ms),
    dispose() {
      unsubAppState();
      unsubHud();
      unsubToast();
      unsubCp();
      unsubAch();
      unsubFinish();
      unsubDnf();
      unsubPreloadProg();
      unsubDataChunk();
      hud.dispose();
      touchControls.dispose();
      dialogs.dispose();
      screens.dispose();
    },
  };
}
