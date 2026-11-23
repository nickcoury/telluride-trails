/**
 * Quality tier definitions, GPU/device auto-detection, and dynamic renderScale controller.
 */

export const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];

const TIER_PRESETS = {
  low: {
    tier: 'low',
    pixelRatio: 1.0,
    renderScale: 0.7,
    minRenderScale: 0.55,
    maxRenderScale: 0.85,
    shadows: false,
    shadowMapSize: 0,
    drawDistance: 18000,
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
    drawDistance: 32000,
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
    postFX: true,
    maxAnisotropy: 16,
    targetFps: 60,
  },
};

function detectInitialTier(renderer) {
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;

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
  const isLowGpu = /mali-g5|mali-t|adreno \(tm\) [345]|powervr|swiftshader|llvmpipe/.test(lowerGpu);
  const isDiscreteGpu = /nvidia|geforce|rtx|radeon rx|apple m[1-9]|arc /.test(lowerGpu);

  if (isLowGpu || (isMobile && (cores <= 4 || mem <= 3))) return 'low';
  if (isMobile) return 'medium';
  if (isDiscreteGpu && cores >= 8 && mem >= 8) return 'high';
  return cores >= 6 ? 'high' : 'medium';
}

export function createQualityManager({ renderer, events }) {
  let autoMode = true;
  let currentTier = detectInitialTier(renderer);
  const state = {
    ...TIER_PRESETS[currentTier],
    auto: true,
    gpuInfo: '',
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

  // Rolling frame time tracker for adaptive resolution and tier hysteresis
  const FRAME_WINDOW = 60;
  const frameTimes = new Float32Array(FRAME_WINDOW);
  let frameCount = 0;
  let frameIndex = 0;
  let overBudgetFrames = 0;
  let underBudgetFrames = 0;
  let lastScaleAdjustTime = 0;

  function applyTierPreset(tier, preserveAuto = autoMode) {
    const preset = TIER_PRESETS[tier] || TIER_PRESETS.medium;
    currentTier = preset.tier;
    Object.assign(state, preset);
    state.auto = preserveAuto;
    state.pixelRatio = Math.min(window.devicePixelRatio || 1, preset.pixelRatio);
    state.maxAnisotropy = Math.min(preset.maxAnisotropy, maxAnisoCap);
  }

  function emitChange(reason) {
    events.emit('quality:changed', { ...state, reason });
  }

  function setTier(tier, { auto = false } = {}) {
    if (!TIER_PRESETS[tier]) return;
    autoMode = auto;
    applyTierPreset(tier, auto);
    overBudgetFrames = 0;
    underBudgetFrames = 0;
    emitChange(auto ? 'auto-tier' : 'user');
  }

  function setAuto(enabled) {
    autoMode = Boolean(enabled);
    state.auto = autoMode;
    if (autoMode) {
      applyTierPreset(detectInitialTier(renderer), true);
    }
    emitChange('auto-toggle');
  }

  function setRenderScale(scale) {
    const clamped = Math.max(0.45, Math.min(1.25, Number(scale) || 1));
    if (Math.abs(clamped - state.renderScale) < 0.01) return;
    state.renderScale = clamped;
    emitChange('renderScale');
  }

  function getEffectivePixelRatio() {
    const base = Math.min(window.devicePixelRatio || 1, state.pixelRatio);
    return Math.max(0.5, base * state.renderScale);
  }

  function recordFrame(frameMs, nowSec) {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 500) return;

    frameTimes[frameIndex] = frameMs;
    frameIndex = (frameIndex + 1) % FRAME_WINDOW;
    if (frameCount < FRAME_WINDOW) frameCount++;

    if (!autoMode || frameCount < 30) return;
    if (nowSec - lastScaleAdjustTime < 1.5) return;

    let sum = 0;
    for (let i = 0; i < frameCount; i++) sum += frameTimes[i];
    const avgMs = sum / frameCount;
    const budgetMs = 1000 / state.targetFps;

    if (avgMs > budgetMs * 1.18) {
      overBudgetFrames++;
      underBudgetFrames = 0;
    } else if (avgMs < budgetMs * 0.72) {
      underBudgetFrames++;
      overBudgetFrames = 0;
    } else {
      overBudgetFrames = Math.max(0, overBudgetFrames - 1);
      underBudgetFrames = Math.max(0, underBudgetFrames - 1);
    }

    if (overBudgetFrames >= 3) {
      lastScaleAdjustTime = nowSec;
      overBudgetFrames = 0;
      if (state.renderScale > state.minRenderScale + 0.05) {
        state.renderScale = Math.max(state.minRenderScale, +(state.renderScale - 0.1).toFixed(2));
        emitChange('adaptive-downscale');
      } else {
        const idx = QUALITY_TIERS.indexOf(currentTier);
        if (idx > 0) {
          applyTierPreset(QUALITY_TIERS[idx - 1], true);
          emitChange('adaptive-tier-down');
        }
      }
    } else if (underBudgetFrames >= 6) {
      lastScaleAdjustTime = nowSec;
      underBudgetFrames = 0;
      if (state.renderScale < state.maxRenderScale - 0.04) {
        state.renderScale = Math.min(state.maxRenderScale, +(state.renderScale + 0.05).toFixed(2));
        emitChange('adaptive-upscale');
      }
    }
  }

  applyTierPreset(currentTier, true);

  return Object.assign(state, {
    setTier,
    setAuto,
    setRenderScale,
    getEffectivePixelRatio,
    recordFrame,
    getPreset: (tier) => ({ ...(TIER_PRESETS[tier] || TIER_PRESETS.medium) }),
  });
}
