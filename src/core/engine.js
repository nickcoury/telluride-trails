import * as THREE from 'three';
import { createEventBus } from './events.js';
import { createQualityManager, isLowEndDeviceHint } from './quality.js';
import { createInput } from './input.js';
import { createScheduler } from './scheduler.js';
import { createCameraRig } from './camera.js';
import { createAssetLoader } from './assets.js';

/**
 * Core engine: WebGL2 renderer (AgX tonemapping, sRGB, standard depth with tight near=0.65
 * for hardware Early-Z on mobile + 120 km far plane for San Juan horizons), GPU+CPU wall-time
 * adaptive quality, unified input, frame-budget-aware scheduler, asset loader, camera rig,
 * context-loss recovery, visibility pause, and app state machine.
 */
export function createEngine({ canvas }) {
  const events = createEventBus();
  const lowEndHint = isLowEndDeviceHint();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !lowEndHint,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#8db3d9');

  // near=0.65, far=120000: preserves mobile hardware Early-Z (no gl_FragDepth) with crisp precision
  // near the runner (~1 mm at 100 m) and unclipped 40 km sky dome / 110 km far-horizon ring.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.65, 120000);

  const quality = createQualityManager({ renderer, events });
  const input = createInput({ domElement: canvas, events });
  const scheduler = createScheduler(6);
  const cameraRig = createCameraRig({ camera, events });
  const assets = createAssetLoader({ baseUrl: import.meta.env.BASE_URL });
  const clock = new THREE.Clock();

  let appState = 'title'; // 'title' | 'loading' | 'playing' | 'paused' | 'results'
  let contextLost = false;
  let pausedByVisibility = false;
  let rafId = 0;
  let lastRafTime = 0;
  let lastShadowsEnabled = Boolean(quality.shadows);

  renderer.shadowMap.enabled = lastShadowsEnabled;
  renderer.shadowMap.autoUpdate = lastShadowsEnabled;

  const updateCallbacks = new Set();
  const lateUpdateCallbacks = new Set();

  function markMaterialsForShadowToggle() {
    scene.traverse((obj) => {
      const mat = obj.material;
      if (!mat) return;
      if (Array.isArray(mat)) {
        for (let i = 0; i < mat.length; i++) {
          if (mat[i]) mat[i].needsUpdate = true;
        }
      } else {
        mat.needsUpdate = true;
      }
    });
  }

  function syncRendererSettings() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(quality.getEffectivePixelRatio());
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    // Keep far plane >= 120 km so 40 km sky dome & 110 km San Juan horizon ring never clip on low tier
    camera.far = Math.max(120000, quality.drawDistance * 2.0);
    camera.updateProjectionMatrix();

    const nextShadows = Boolean(quality.shadows);
    if (nextShadows !== lastShadowsEnabled) {
      lastShadowsEnabled = nextShadows;
      renderer.shadowMap.enabled = nextShadows;
      renderer.shadowMap.autoUpdate = nextShadows;
      renderer.shadowMap.needsUpdate = true;
      markMaterialsForShadowToggle();
    }
  }

  syncRendererSettings();
  const unsubQuality = events.on('quality:changed', syncRendererSettings);
  window.addEventListener('resize', syncRendererSettings);
  window.addEventListener('orientationchange', syncRendererSettings);
  const vv = window.visualViewport;
  if (vv) vv.addEventListener('resize', syncRendererSettings);

  function onContextLost(e) {
    e.preventDefault();
    contextLost = true;
    lastRafTime = 0;
    events.emit('engine:contextlost');
  }

  function onContextRestored() {
    contextLost = false;
    lastRafTime = 0;
    syncRendererSettings();
    renderer.shadowMap.needsUpdate = true;
    events.emit('engine:contextrestored');
  }

  function onVisibilityChange() {
    pausedByVisibility = document.hidden;
    lastRafTime = 0;
    if (!pausedByVisibility) {
      clock.getDelta();
    }
    events.emit('engine:visibility', { hidden: pausedByVisibility });
  }

  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  document.addEventListener('visibilitychange', onVisibilityChange);

  function setAppState(nextState) {
    if (appState === nextState) return;
    const prev = appState;
    appState = nextState;
    events.emit('app:state', { state: nextState, prev });
  }

  function onUpdate(fn) {
    updateCallbacks.add(fn);
    return () => updateCallbacks.delete(fn);
  }

  function onLateUpdate(fn) {
    lateUpdateCallbacks.add(fn);
    return () => lateUpdateCallbacks.delete(fn);
  }

  const stats = {
    fps: 60,
    frameMs: 16.6,
    cpuMs: 4.0,
    avgMs: 16.6,
    p95Ms: 16.6,
    p99Ms: 16.6,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    schedulerQueue: 0,
  };

  function tick(now) {
    rafId = requestAnimationFrame(tick);
    if (contextLost || pausedByVisibility) return;

    const frameStart = performance.now();
    const rafDeltaMs =
      lastRafTime > 0 ? Math.max(4, Math.min(250, now - lastRafTime)) : 16.67;
    lastRafTime = now;

    const dt = Math.min(0.1, clock.getDelta());
    const t = clock.elapsedTime;

    cameraRig.beginFrame();
    input.update(dt);

    for (const fn of updateCallbacks) {
      fn(dt, t);
    }

    for (const fn of lateUpdateCallbacks) {
      fn(dt, t);
    }

    // Frame-budget-aware scheduler slice: <= 6 ms, shrinks if JS update was already heavy
    const targetFrameMs = 1000 / Math.max(30, quality.targetFps || 60);
    const spentMs = performance.now() - frameStart;
    const sliceBudgetMs = Math.max(1.5, Math.min(6, Math.min(8, targetFrameMs * 0.45) - spentMs));
    scheduler.runSlice(sliceBudgetMs);

    renderer.render(scene, camera);

    const cpuMs = performance.now() - frameStart;
    // Measure max(cpuMs, rafDeltaMs) so GPU-bound mobile slowdowns trigger adaptive scaling
    const effectiveFrameMs = Math.max(cpuMs, rafDeltaMs);
    quality.recordFrame(effectiveFrameMs, t);

    stats.cpuMs = cpuMs;
    stats.frameMs = effectiveFrameMs;
    stats.avgMs = quality.avgFrameMs;
    stats.p95Ms = quality.p95FrameMs;
    stats.p99Ms = quality.p99FrameMs;
    stats.fps = rafDeltaMs > 0 ? Math.round(1000 / rafDeltaMs) : 60;
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.geometries = renderer.info.memory.geometries;
    stats.textures = renderer.info.memory.textures;
    stats.programs = renderer.info.programs?.length || 0;
    stats.schedulerQueue = scheduler.size();
  }

  function start() {
    if (rafId) return;
    lastRafTime = 0;
    clock.start();
    rafId = requestAnimationFrame(tick);
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    unsubQuality();
    window.removeEventListener('resize', syncRendererSettings);
    window.removeEventListener('orientationchange', syncRendererSettings);
    if (vv) vv.removeEventListener('resize', syncRendererSettings);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    cameraRig.dispose();
    quality.dispose();
    input.dispose();
    scheduler.clear();
    renderer.dispose();
  }

  return {
    renderer,
    scene,
    camera,
    cameraRig,
    clock,
    events,
    quality,
    input,
    scheduler,
    assets,
    stats,
    onUpdate,
    onLateUpdate,
    setAppState,
    getAppState: () => appState,
    assetsBase: import.meta.env.BASE_URL,
    start,
    dispose,
  };
}
