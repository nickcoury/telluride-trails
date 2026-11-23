/**
 * Quality tier definitions, GPU/device auto-detection, saved preference hydration
 * (single source of truth), and dynamic renderScale controller with rolling frame-time
 * budget, hysteresis step-down/step-up, and granular change flags on 'quality:changed'.
 */

export const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];
const UI_SETTINGS_KEY = 'telluride_trails_settings_v1';

const TIER_PRESETS = {
  low: {
    tier: 'low',
    pixelRatio: 1.0,
    renderScale: 0.7,
    minRenderScale: 0.55,
    maxRenderScale: 0.85,
    shadows: false,
    shadowMapSize: 0,
    drawDistance: 20000,
    terrainLodBias: 1.35,
    treeDensity: 0.25,
    grass: false,
    water: 'simple',
    postFX: false,
    maxAnisotropy: 2,
    targetFps: 30,
  },
  medium: {
    tier: 'medium',
    pixelRatio: 1.5,
    renderScale: 0.9,
    minRenderScale: 0.65,
    maxRenderScale: 1.0,
    shadows: true,
    shadowMapSize: 1024,
    drawDistance: 34000,
    terrainLodBias: 1.1,
    treeDensity: 0.55,
    grass: true,
    water: 'simple',
    postFX: false,
    maxAnisotropy: 4,
    targetFps: 60,
  },
  high: {
    tier: 'high',
    pixelRatio: 2.0,
    renderScale: 1.0,
    minRenderScale: 0.75,
    maxRenderScale: 1.0,
    shadows: true,
    shadowMapSize: 2048,
    drawDistance: 50000,
    terrainLodBias: 1.0,
    treeDensity: 0.85,
    grass: true,
    water: 'reflective',
    postFX: false,
    maxAnisotropy: 8,
    targetFps: 60,
  },
  ultra: {
    tier: 'ultra',
    pixelRatio: 2.0,
    renderScale: 1.0,
    minRenderScale: 0.85,
    maxRenderScale: 1.0,
    shadows: true,
    shadowMapSize: 4096,
    drawDistance: 65000,
    terrainLodBias: 0.85,
    treeDensity: 1.0,
    grass: true,
    water: 'reflective',
    postFX: false,
    maxAnisotropy: 16,
    targetFps: 60,
  },
};

function readPersistedQuality() {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      qualityTier: parsed.qualityTier,
      renderScale: parsed.renderScale,
    };
  } catch {
    return null;
  }
}

export function isLowEndDeviceHint() {
  const ua = navigator.userAgent || '';
  const isIPadOS = /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  const isMobile = isIPadOS || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : isMobile ? 4 : 8;
  const urlTier = new URLSearchParams(window.location.search).get('tier');
  if (urlTier === 'low') return true;
  if (urlTier && TIER_PRESETS[urlTier]) return false;
  const saved = readPersistedQuality();
  if (saved?.qualityTier === 'low') return true;
  return isMobile && (cores <= 4 || mem <= 3);
}

function detectInitialTier(renderer) {
  const ua = navigator.userAgent || '';
  const isIPadOS = /Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  const isMobile = isIPadOS || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const cores = navigator.hardwareConcurrency || 4;
  const mem = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : isMobile ? 4 : 8;

  let gpuRenderer = '';
  try {
    const gl = renderer?.getContext?.();
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) gpuRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    }
  } catch {
    // Ignore restricted WebGL debug info
  }

  const lowerGpu = gpuRenderer.toLowerCase();
  const isSoftware = /swiftshader|llvmpipe|software/.test(lowerGpu);
  const isLowGpu = isSoftware || /mali-g5|mali-t|adreno \(tm\) [345]|powervr/.test(lowerGpu);
  const isDiscreteGpu = /nvidia|geforce|rtx|radeon rx|apple m[1-9]|arc /.test(lowerGpu);

  if (isLowGpu || (isMobile && !isIPadOS && (cores <= 4 || mem <= 3))) return 'low';
  if (isMobile) return 'medium';
  if (isDiscreteGpu && cores >= 8 && mem >= 8) return 'high';
  return cores >= 6 ? 'high' : 'medium';
}

export function createQualityManager({ renderer, events }) {
  const params = new URLSearchParams(window.location.search);
  const urlTier = params.get('tier');
  const lockTierParam = params.get('lockTier');

  const detectedMaxTier = detectInitialTier(renderer);
  const saved = !urlTier ? readPersistedQuality() : null;

  let autoMode = true;
  let currentTier = detectedMaxTier;
  let initialScaleOverride = null;

  if (TIER_PRESETS[urlTier]) {
    currentTier = urlTier;
    if (lockTierParam === '1' || lockTierParam === 'true') {
      autoMode = false;
    }
  } else if (saved) {
    if (saved.qualityTier === 'auto') {
      autoMode = true;
    } else if (TIER_PRESETS[saved.qualityTier]) {
      currentTier = saved.qualityTier;
      autoMode = false;
    }
    if (Number.isFinite(saved.renderScale) && saved.renderScale !== 1.0) {
      initialScaleOverride = Math.max(0.45, Math.min(1.25, Number(saved.renderScale)));
    }
  }

  if (lockTierParam === '1' || lockTierParam === 'true') {
    autoMode = false;
  }

  const state = {
    ...TIER_PRESETS[currentTier],
    auto: autoMode,
    gpuInfo: '',
    avgFrameMs: 16.6,
    p95FrameMs: 16.6,
    p99FrameMs: 16.6,
  };

  try {
    const gl = renderer?.getContext?.();
    const dbg = gl?.getExtension?.('WEBGL_debug_renderer_info');
    if (dbg) state.gpuInfo = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
  } catch {
    // ignore
  }

  const maxAnisoCap = renderer?.capabilities?.getMaxAnisotropy?.() || 4;
  state.maxAnisotropy = Math.min(state.maxAnisotropy, maxAnisoCap);

  // Rolling frame-time ring buffer (wall interval + JS CPU time for 60 Hz vsync recovery)
  const FRAME_WINDOW = 90;
  const frameTimes = new Float32Array(FRAME_WINDOW);
  const cpuTimes = new Float32Array(FRAME_WINDOW);
  const sortedScratch = new Float32Array(FRAME_WINDOW);
  let frameCount = 0;
  let frameIndex = 0;
  let avgCpuMs = 4.0;
  let overBudgetStreak = 0;
  let underBudgetStreak = 0;
  let lastTierChangeTime = -10;
  let lastScaleAdjustTime = 0;

  function applyTierPreset(tier, preserveAuto = autoMode) {
    const preset = TIER_PRESETS[tier] || TIER_PRESETS.medium;
    currentTier = preset.tier;
    Object.assign(state, preset);
    state.auto = preserveAuto;
    state.pixelRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatio);
    state.maxAnisotropy = Math.min(preset.maxAnisotropy, maxAnisoCap);
  }

  function snapshotFlags(prev) {
    return {
      tierChanged: state.tier !== prev.tier,
      renderScaleChanged: Math.abs(state.renderScale - prev.renderScale) >= 0.005,
      anisotropyChanged: state.maxAnisotropy !== prev.maxAnisotropy,
      shadowsChanged: state.shadows !== prev.shadows || state.shadowMapSize !== prev.shadowMapSize,
      drawDistanceChanged: state.drawDistance !== prev.drawDistance,
      autoChanged: state.auto !== prev.auto,
    };
  }

  function emitChange(reason, flags) {
    events.emit('quality:changed', {
      ...state,
      reason,
      ...flags,
    });
  }

  function applyPatch({ tier, auto, renderScale } = {}, reason = 'user') {
    const prev = {
      tier: state.tier,
      auto: state.auto,
      renderScale: state.renderScale,
      maxAnisotropy: state.maxAnisotropy,
      shadows: state.shadows,
      shadowMapSize: state.shadowMapSize,
      drawDistance: state.drawDistance,
    };

    if (tier === 'auto') {
      autoMode = true;
      applyTierPreset(detectInitialTier(renderer), true);
    } else {
      if (typeof auto === 'boolean') {
        autoMode = auto;
        state.auto = autoMode;
      }
      if (tier && TIER_PRESETS[tier]) {
        applyTierPreset(tier, autoMode);
      } else if (auto === true && !prev.auto) {
        applyTierPreset(detectInitialTier(renderer), true);
      }
    }

    if (typeof renderScale === 'number' && Number.isFinite(renderScale)) {
      state.renderScale = Math.max(0.45, Math.min(1.25, renderScale));
    }

    const flags = snapshotFlags(prev);
    if (flags.tierChanged || flags.renderScaleChanged || flags.autoChanged || flags.shadowsChanged) {
      overBudgetStreak = 0;
      underBudgetStreak = 0;
      emitChange(reason, flags);
    }
  }

  function setTier(tier, { auto = false } = {}) {
    if (!TIER_PRESETS[tier]) return;
    applyPatch({ tier, auto: Boolean(auto) }, auto ? 'auto-tier' : 'user');
  }

  function setAuto(enabled) {
    applyPatch({ auto: Boolean(enabled), tier: enabled ? 'auto' : undefined }, 'auto-toggle');
  }

  function setRenderScale(scale) {
    const clamped = Math.max(0.45, Math.min(1.25, Number(scale) || 1));
    applyPatch({ renderScale: clamped }, 'renderScale');
  }

  function getEffectivePixelRatio() {
    const base = Math.min(window.devicePixelRatio || 1, state.pixelRatio);
    return Math.max(0.5, base * state.renderScale);
  }

  function updatePercentiles() {
    if (frameCount === 0) return;
    let sum = 0;
    let cpuSum = 0;
    for (let i = 0; i < frameCount; i++) {
      const v = frameTimes[i];
      sum += v;
      cpuSum += cpuTimes[i];
      sortedScratch[i] = v;
    }
    const slice = sortedScratch.subarray(0, frameCount);
    slice.sort();
    state.avgFrameMs = sum / frameCount;
    avgCpuMs = cpuSum / frameCount;
    state.p95FrameMs = slice[Math.min(frameCount - 1, Math.floor(frameCount * 0.95))];
    state.p99FrameMs = slice[Math.min(frameCount - 1, Math.floor(frameCount * 0.99))];
  }

  function recordFrame(frameMs, nowSec, cpuMs = frameMs) {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 500) return;

    frameTimes[frameIndex] = frameMs;
    cpuTimes[frameIndex] = Number.isFinite(cpuMs) && cpuMs > 0 ? Math.min(500, cpuMs) : frameMs;
    frameIndex = (frameIndex + 1) % FRAME_WINDOW;
    if (frameCount < FRAME_WINDOW) frameCount++;

    if (frameIndex % 15 === 0) {
      updatePercentiles();
    }

    if (!autoMode || frameCount < 45) return;
    if (nowSec - lastScaleAdjustTime < 1.5) return;

    updatePercentiles();
    const budgetMs = 1000 / state.targetFps;
    const effectiveMs = state.avgFrameMs * 0.65 + state.p95FrameMs * 0.35;

    const isOverBudget = effectiveMs > budgetMs * 1.18;
    const hasUpscaleHeadroom =
      state.targetFps < 55
        ? effectiveMs < budgetMs * 0.68
        : effectiveMs <= budgetMs * 1.05 && avgCpuMs < budgetMs * 0.55;

    if (isOverBudget) {
      overBudgetStreak++;
      underBudgetStreak = 0;
    } else if (hasUpscaleHeadroom) {
      underBudgetStreak++;
      overBudgetStreak = 0;
    } else {
      overBudgetStreak = Math.max(0, overBudgetStreak - 1);
      underBudgetStreak = Math.max(0, underBudgetStreak - 1);
    }

    if (overBudgetStreak >= 3) {
      lastScaleAdjustTime = nowSec;
      overBudgetStreak = 0;
      const prev = { ...state };
      if (state.renderScale > state.minRenderScale + 0.04) {
        state.renderScale = Math.max(state.minRenderScale, +(state.renderScale - 0.1).toFixed(2));
        emitChange('adaptive-downscale', snapshotFlags(prev));
      } else {
        const idx = QUALITY_TIERS.indexOf(currentTier);
        if (idx > 0 && nowSec - lastTierChangeTime > 5) {
          lastTierChangeTime = nowSec;
          applyTierPreset(QUALITY_TIERS[idx - 1], true);
          emitChange('adaptive-tier-down', snapshotFlags(prev));
        }
      }
    } else if (underBudgetStreak >= 6) {
      lastScaleAdjustTime = nowSec;
      underBudgetStreak = 0;
      const prev = { ...state };
      if (state.renderScale < state.maxRenderScale - 0.04) {
        state.renderScale = Math.min(state.maxRenderScale, +(state.renderScale + 0.05).toFixed(2));
        emitChange('adaptive-upscale', snapshotFlags(prev));
      } else {
        const idx = QUALITY_TIERS.indexOf(currentTier);
        const maxAllowedIdx = QUALITY_TIERS.indexOf(detectedMaxTier);
        const hasTierUpHeadroom =
          state.targetFps < 55
            ? effectiveMs < budgetMs * 0.52
            : effectiveMs <= budgetMs * 1.05 && avgCpuMs < budgetMs * 0.42;
        if (
          idx >= 0 &&
          idx < maxAllowedIdx &&
          nowSec - lastTierChangeTime > 12 &&
          hasTierUpHeadroom
        ) {
          lastTierChangeTime = nowSec;
          applyTierPreset(QUALITY_TIERS[idx + 1], true);
          emitChange('adaptive-tier-up', snapshotFlags(prev));
        }
      }
    }
  }

  const unsubUiQuality = events.on('ui:quality', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    applyPatch(payload, 'user');
  });

  applyTierPreset(currentTier, autoMode);
  if (initialScaleOverride !== null) {
    state.renderScale = initialScaleOverride;
  }

  function dispose() {
    unsubUiQuality();
  }

  return Object.assign(state, {
    setTier,
    setAuto,
    setRenderScale,
    applyPatch,
    getEffectivePixelRatio,
    recordFrame,
    dispose,
    getPreset: (tier) => ({ ...(TIER_PRESETS[tier] || TIER_PRESETS.medium) }),
  });
}
