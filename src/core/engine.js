import * as THREE from 'three';
import { createEventBus } from './events.js';
import { createQualityManager } from './quality.js';
import { createInput } from './input.js';
import { createScheduler } from './scheduler.js';
import { createCameraRig } from './camera.js';
import { createAssetLoader } from './assets.js';

/**
 * Core engine: WebGL2 renderer (AgX tonemapping, sRGB, logarithmic depth for 60 km views),
 * adaptive quality, unified input, time-sliced task scheduler, asset loader, camera rig,
 * context-loss recovery, visibility pause, and app state machine.
 */
export function createEngine({ canvas }) {
  const events = createEventBus();

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#8db3d9');

  const camera = new THREE.PerspectiveCamera(60, 1, 0.35, 90000);
  camera.position.set(0, 2675, 12);

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

  const updateCallbacks = new Set();
  const lateUpdateCallbacks = new Set();

  function syncRendererSettings() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(quality.getEffectivePixelRatio());
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.far = Math.max(30000, quality.drawDistance * 1.45);
    camera.updateProjectionMatrix();
    renderer.shadowMap.enabled = Boolean(quality.shadows);
  }

  syncRendererSettings();
  events.on('quality:changed', syncRendererSettings);
  window.addEventListener('resize', syncRendererSettings);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    contextLost = true;
    events.emit('engine:contextlost');
  });

  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    syncRendererSettings();
    events.emit('engine:contextrestored');
  });

  document.addEventListener('visibilitychange', () => {
    pausedByVisibility = document.hidden;
    if (!pausedByVisibility) {
      clock.getDelta();
    }
    events.emit('engine:visibility', { hidden: pausedByVisibility });
  });

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

  function tick() {
    rafId = requestAnimationFrame(tick);
    if (contextLost || pausedByVisibility) return;

    const frameStart = performance.now();
    const dt = Math.min(0.1, clock.getDelta());
    const t = clock.elapsedTime;

    input.update();

    for (const fn of updateCallbacks) {
      fn(dt, t);
    }

    for (const fn of lateUpdateCallbacks) {
      fn(dt, t);
    }

    scheduler.runSlice(6);
    renderer.render(scene, camera);

    const frameMs = performance.now() - frameStart;
    quality.recordFrame(frameMs, t);

    stats.frameMs = frameMs;
    stats.avgMs = quality.avgFrameMs;
    stats.p95Ms = quality.p95FrameMs;
    stats.p99Ms = quality.p99FrameMs;
    stats.fps = dt > 0 ? Math.round(1 / dt) : 60;
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.geometries = renderer.info.memory.geometries;
    stats.textures = renderer.info.memory.textures;
    stats.programs = renderer.info.programs?.length || 0;
    stats.schedulerQueue = scheduler.size();
  }

  function start() {
    if (rafId) return;
    clock.start();
    tick();
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    window.removeEventListener('resize', syncRendererSettings);
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
