/**
 * Per-frame zero-allocation Runner Screen-Space Occlusion Guard (#166).
 *
 * Projects the 3D runner capsule/AABB into 2D CSS viewport coordinates each frame
 * (after game + camera update) and ensures no UI overlay covers the runner:
 *  - Relocates `.hud-toasts` (`top` / `top-left` / `bottom`) and `.context-actions`
 *    (`side-right` / `top` / `bottom-gap` / `bottom-above`) to a 0-overlap safe zone.
 *  - Fades any anchored HUD widget (`.hud-trail-pill`, `.hud-stats`, `.hud-race-bar`,
 *    `.hud-minimap`, `.joystick`, `.action-pad`) to ~24% opacity (`.is-runner-occluded`)
 *    whenever the runner's projected screen bbox intersects it.
 */
export function createRunnerGuard({ engine, game, root }) {
  const hudLayer = root.querySelector('.hud-layer');
  const topAreaEl = root.querySelector('.hud-top-area');
  const trailPillEl = root.querySelector('.hud-trail-pill');
  const statsEl = root.querySelector('.hud-stats');
  const raceBarEl = root.querySelector('.hud-race-bar');
  const minimapEl = root.querySelector('.hud-minimap');
  const toastsEl = root.querySelector('.hud-toasts');
  const contextEl = root.querySelector('.context-actions');
  const joystickEl = root.querySelector('.joystick');
  const actionPadEl = root.querySelector('.action-pad');

  // Pre-allocated scratch rect storage (zero per-frame heap allocations)
  const runnerBox = { x0: 0, y0: 0, x1: 0, y1: 0, visible: false };
  const topAreaRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const trailRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const statsRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const raceRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const miniRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const joyRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const actRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const chosenCtxRect = { x0: 0, y0: 0, x1: 0, y1: 0, ok: false };
  const candRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  let eventBounds = null;
  const unsubBounds = engine.events?.on?.('game:runnerBounds', (b) => {
    eventBounds = b;
  });

  let cachedVw = 0;
  let cachedVh = 0;
  let lastSig = '';
  let lastMeasureMs = 0;
  let toastW = 230;
  let toastH = 34;
  let ctxW = 240;
  let ctxH = 36;
  let wasActive = false;
  let curToastZone = '';
  let curCtxZone = '';

  const anchoredTargets = [
    [trailPillEl, trailRect],
    [statsEl, statsRect],
    [raceBarEl, raceRect],
    [minimapEl, miniRect],
    [joystickEl, joyRect],
    [actionPadEl, actRect],
  ];

  function setClass(el, cls, on) {
    if (!el) return;
    if (el.classList.contains(cls) !== on) {
      el.classList.toggle(cls, on);
    }
  }

  function readRect(el, out) {
    if (!el || el.hidden) {
      out.ok = false;
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      out.ok = false;
      return;
    }
    out.x0 = r.left;
    out.y0 = r.top;
    out.x1 = r.right;
    out.y1 = r.bottom;
    out.ok = true;
  }

  function overlapArea(a, b) {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    if (ox <= 0) return 0;
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (oy <= 0) return 0;
    return ox * oy;
  }

  function clearAll() {
    if (!wasActive) return;
    wasActive = false;
    runnerBox.visible = false;
    for (let i = 0; i < anchoredTargets.length; i++) {
      setClass(anchoredTargets[i][0], 'is-runner-occluded', false);
    }
    setClass(toastsEl, 'is-runner-occluded', false);
    setClass(contextEl, 'is-runner-occluded', false);
  }

  function projectRunner(vw, vh) {
    // Prefer engine.getRunnerScreenRect() from core/camera.js (#168) when available
    if (typeof engine.getRunnerScreenRect === 'function') {
      const sr = engine.getRunnerScreenRect();
      if (!sr || !sr.visible) return false;
      runnerBox.x0 = Math.max(0, sr.left);
      runnerBox.y0 = Math.max(0, sr.top);
      runnerBox.x1 = Math.min(vw, sr.right);
      runnerBox.y1 = Math.min(vh, sr.bottom);
      runnerBox.visible = runnerBox.x1 > runnerBox.x0 && runnerBox.y1 > runnerBox.y0;
      return runnerBox.visible;
    }

    const cam = engine.camera;
    if (!cam?.matrixWorldInverse || !cam?.projectionMatrix) return false;

    const rb =
      typeof game?.getRunnerBounds === 'function'
        ? game.getRunnerBounds()
        : typeof engine?.getRunnerBounds === 'function'
          ? engine.getRunnerBounds()
          : eventBounds;

    if (rb && rb.visible === false) return false;

    const pose = !rb && typeof game?.getCameraPose === 'function' ? game.getCameraPose() : null;
    const st = game?.state;
    const wx = rb?.x ?? pose?.x ?? st?.x;
    const wy = rb?.y ?? pose?.y ?? st?.y;
    const wz = rb?.z ?? pose?.z ?? st?.z;
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) return false;

    const h = rb?.height ?? (st?.fallen ? 0.65 : 1.85);
    const r = rb?.radius ?? 0.42;

    const m = cam.matrixWorldInverse.elements;
    const p = cam.projectionMatrix.elements;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let anyFront = false;

    for (let ix = -1; ix <= 1; ix += 2) {
      const cxW = wx + ix * r;
      for (let iz = -1; iz <= 1; iz += 2) {
        const czW = wz + iz * r;
        for (let iy = 0; iy <= 1; iy++) {
          const cyW = wy + iy * h;
          const vx = m[0] * cxW + m[4] * cyW + m[8] * czW + m[12];
          const vy = m[1] * cxW + m[5] * cyW + m[9] * czW + m[13];
          const vz = m[2] * cxW + m[6] * cyW + m[10] * czW + m[14];
          if (vz >= -0.2) continue;
          const wClip = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
          if (wClip <= 0.0001) continue;
          const invW = 1 / wClip;
          const sx = ((p[0] * vx + p[4] * vy + p[8] * vz + p[12]) * invW * 0.5 + 0.5) * vw;
          const sy = (-(p[1] * vx + p[5] * vy + p[9] * vz + p[13]) * invW * 0.5 + 0.5) * vh;
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
          anyFront = true;
        }
      }
    }

    if (!anyFront || maxX < 0 || minX > vw || maxY < 0 || minY > vh) return false;

    const pad = 6;
    runnerBox.x0 = Math.max(0, minX - pad);
    runnerBox.y0 = Math.max(0, minY - pad);
    runnerBox.x1 = Math.min(vw, maxX + pad);
    runnerBox.y1 = Math.min(vh, maxY + pad);
    runnerBox.visible = runnerBox.x1 > runnerBox.x0 && runnerBox.y1 > runnerBox.y0;
    return runnerBox.visible;
  }

  function refreshCachedRects(vw, vh, now) {
    const toastCount = toastsEl ? toastsEl.childElementCount : 0;
    const ctxHidden = !contextEl || contextEl.hidden;
    const sig = `${vw}x${vh}|${raceBarEl?.hidden ? 1 : 0}|${statsEl?.classList.contains('is-expanded') ? 1 : 0}|${minimapEl?.classList.contains('is-expanded') ? 1 : 0}|${hudLayer?.classList.contains('is-hud-minimized') ? 1 : 0}|${toastCount}|${ctxHidden ? 1 : 0}|${contextEl?.className || ''}`;

    if (sig === lastSig && now - lastMeasureMs < 180) return;
    lastSig = sig;
    lastMeasureMs = now;
    cachedVw = vw;
    cachedVh = vh;

    readRect(topAreaEl, topAreaRect);
    readRect(trailPillEl, trailRect);
    readRect(statsEl, statsRect);
    readRect(raceBarEl, raceRect);
    readRect(minimapEl, miniRect);
    readRect(joystickEl, joyRect);
    readRect(actionPadEl, actRect);

    if (toastCount > 0 && toastsEl) {
      const r = toastsEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        toastW = r.width;
        toastH = r.height;
      }
    }
    if (!ctxHidden && contextEl) {
      const r = contextEl.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        ctxW = r.width;
        ctxH = r.height;
      }
    }
  }

  function setCand(x0, y0, w, h) {
    candRect.x0 = x0;
    candRect.y0 = y0;
    candRect.x1 = x0 + w;
    candRect.y1 = y0 + h;
  }

  function update() {
    if (
      engine.getAppState?.() !== 'playing' ||
      !hudLayer ||
      hudLayer.hidden ||
      hudLayer.classList.contains('is-photo-mode') ||
      engine.cameraRig?.getMode?.() === 'first-person'
    ) {
      clearAll();
      return;
    }

    const vw = engine.width || window.innerWidth;
    const vh = engine.height || window.innerHeight;
    if (vw <= 0 || vh <= 0) return;

    if (!projectRunner(vw, vh)) {
      clearAll();
      return;
    }

    wasActive = true;
    window.__tellurideRunnerScreenBox = runnerBox;

    const now = performance.now();
    refreshCachedRects(vw, vh, now);

    // 1. Anchored overlays: fade to ~24% opacity if runner bbox intersects
    for (let i = 0; i < anchoredTargets.length; i++) {
      const el = anchoredTargets[i][0];
      const rect = anchoredTargets[i][1];
      if (!el || !rect.ok) {
        setClass(el, 'is-runner-occluded', false);
        continue;
      }
      // Keep active thumb joystick readable while dragging unless heavily covered
      const hit = overlapArea(rect, runnerBox) > 0;
      setClass(el, 'is-runner-occluded', hit);
    }

    let topHudBottom = topAreaRect.ok ? topAreaRect.y1 : 44;
    if (statsRect.ok && statsRect.y1 > topHudBottom) topHudBottom = statsRect.y1;
    if (raceRect.ok && raceRect.y1 > topHudBottom) topHudBottom = raceRect.y1;
    const miniBottomIfRight = miniRect.ok ? miniRect.y1 : topHudBottom;
    const joyRight = joyRect.ok ? joyRect.x1 : 8;
    const joyTop = joyRect.ok ? joyRect.y0 : vh - 8;
    const actLeft = actRect.ok ? actRect.x0 : vw - 8;
    const actTop = actRect.ok ? actRect.y0 : vh - 8;
    const bottomControlsTop = Math.min(joyTop, actTop);
    const centerGapW = actLeft - joyRight - 16;

    const hudStaticPenalty = () => {
      let pen = 0;
      if (statsRect.ok) pen += overlapArea(candRect, statsRect);
      if (raceRect.ok) pen += overlapArea(candRect, raceRect);
      if (miniRect.ok) pen += overlapArea(candRect, miniRect);
      return pen;
    };

    // 2. Relocate `.context-actions` (Aid strip, Expanded 2-row Aid tray, Eat Gel, Stream, Get Up, Kiss Rock)
    chosenCtxRect.ok = false;
    if (contextEl && !contextEl.hidden) {
      const isSidePill = contextEl.classList.contains('context-actions--side');

      let bestZone = 'top';
      let bestScore = Infinity;
      let bestRunnerOv = Infinity;
      let bestX0 = 0;
      let bestY0 = 0;
      let bestW = ctxW;

      // Candidate 1 (for single quick-gel / stream pills): side-right above action-pad
      if (isSidePill) {
        const sx0 = Math.max(8, vw - 8 - ctxW);
        const sy0 = Math.max(topHudBottom + 6, actTop - 8 - ctxH);
        setCand(sx0, sy0, ctxW, ctxH);
        const rOv = overlapArea(candRect, runnerBox);
        const sOv = hudStaticPenalty();
        bestZone = 'side-right';
        bestScore = rOv * 4 + sOv;
        bestRunnerOv = rOv;
        bestX0 = sx0;
        bestY0 = sy0;
        bestW = ctxW;
      }

      // Candidate 2: bottom-gap (between joystick & action-pad when wide enough, e.g. landscape/desktop)
      if (bestScore > 0 && centerGapW >= 240) {
        const bw = Math.min(ctxW, centerGapW);
        const bx0 = joyRight + 8 + (centerGapW - bw) * 0.5;
        const by0 = vh - 6 - ctxH;
        setCand(bx0, by0, bw, ctxH);
        const rOv = overlapArea(candRect, runnerBox);
        const sOv = hudStaticPenalty();
        const sc = rOv * 4 + sOv;
        if (sc < bestScore) {
          bestZone = 'bottom-gap';
          bestScore = sc;
          bestRunnerOv = rOv;
          bestX0 = bx0;
          bestY0 = by0;
          bestW = bw;
        }
      }

      // Candidate 3: top safe zone right below HUD (and below minimap if strip reaches top-right)
      if (bestScore > 0) {
        const tx0 = Math.max(8, (vw - ctxW) * 0.5);
        const hitsMinimapX = miniRect.ok && tx0 + ctxW > miniRect.x0 - 4;
        const ty0 = (hitsMinimapX ? Math.max(topHudBottom, miniBottomIfRight) : topHudBottom) + 6;
        setCand(tx0, ty0, ctxW, ctxH);
        const rOv = overlapArea(candRect, runnerBox);
        const sOv = hudStaticPenalty();
        const sc = rOv * 4 + sOv;
        if (sc < bestScore) {
          bestZone = 'top';
          bestScore = sc;
          bestRunnerOv = rOv;
          bestX0 = tx0;
          bestY0 = ty0;
          bestW = ctxW;
        }
      }

      // Candidate 4 (landscape): top-left column under telemetry, completely left of centered runner
      if (bestScore > 0 && vw >= 520) {
        const lw = Math.min(ctxW, Math.min(280, vw * 0.41));
        const lx0 = 8;
        const ly0 = topHudBottom + 6;
        setCand(lx0, ly0, lw, ctxH);
        const rOv = overlapArea(candRect, runnerBox);
        const jOv = joyRect.ok ? overlapArea(candRect, joyRect) : 0;
        const sOv = hudStaticPenalty();
        const sc = rOv * 4 + jOv * 2 + sOv;
        if (sc < bestScore) {
          bestZone = 'top-left';
          bestScore = sc;
          bestRunnerOv = rOv;
          bestX0 = lx0;
          bestY0 = ly0;
          bestW = lw;
        }
      }

      // Candidate 5: bottom-above (above touch controls, when runner is high on screen)
      if (bestScore > 0) {
        const ax0 = Math.max(8, (vw - ctxW) * 0.5);
        const ay0 = Math.max(topHudBottom + 6, bottomControlsTop - 6 - ctxH);
        setCand(ax0, ay0, ctxW, ctxH);
        const rOv = overlapArea(candRect, runnerBox);
        const sOv = hudStaticPenalty();
        const sc = rOv * 4 + sOv;
        if (sc < bestScore) {
          bestZone = 'bottom-above';
          bestScore = sc;
          bestRunnerOv = rOv;
          bestX0 = ax0;
          bestY0 = ay0;
          bestW = ctxW;
        }
      }

      if (curCtxZone !== bestZone) {
        curCtxZone = bestZone;
        contextEl.dataset.ctxZone = bestZone;
      }
      if (bestZone === 'top' || bestZone === 'top-left') {
        contextEl.style.setProperty('--ctx-top-px', `${Math.round(bestY0)}px`);
      }
      chosenCtxRect.x0 = bestX0;
      chosenCtxRect.y0 = bestY0;
      chosenCtxRect.x1 = bestX0 + bestW;
      chosenCtxRect.y1 = bestY0 + ctxH;
      chosenCtxRect.ok = true;

      setClass(contextEl, 'is-runner-occluded', bestRunnerOv > 0);
    } else {
      setClass(contextEl, 'is-runner-occluded', false);
    }

    // 3. Relocate `.hud-toasts` (`top` / `top-left` / `bottom-gap` / `bottom-above`) avoiding runner, HUD & context bar
    if (toastsEl && toastsEl.childElementCount > 0) {
      let bestTZone = 'top';
      let bestTOverlap = Infinity;
      let bestRunnerOv = Infinity;
      let bestTY0 = topHudBottom + 6;

      // Candidate A: Top centered below HUD (and below context-actions if context is at 'top')
      {
        const tx0 = (vw - toastW) * 0.5;
        const hitsMini = miniRect.ok && tx0 + toastW > miniRect.x0 - 4;
        let ty0 = (hitsMini ? Math.max(topHudBottom, miniBottomIfRight) : topHudBottom) + 6;
        if (chosenCtxRect.ok && (curCtxZone === 'top' || curCtxZone === 'top-left')) {
          ty0 = Math.max(ty0, chosenCtxRect.y1 + 5);
        }
        setCand(tx0, ty0, toastW, toastH);
        const rOv = overlapArea(candRect, runnerBox);
        const cOv = chosenCtxRect.ok ? overlapArea(candRect, chosenCtxRect) : 0;
        const sOv = hudStaticPenalty();
        bestTZone = 'top';
        bestTOverlap = rOv * 4 + cOv * 2 + sOv;
        bestRunnerOv = rOv;
        bestTY0 = ty0;
      }

      // Candidate B: Top-left under telemetry (ideal in landscape when runner head is high in center)
      if (bestTOverlap > 0 && vw >= 520) {
        const lw = Math.min(toastW, Math.min(280, vw * 0.41));
        const estH = toastW > lw + 10 ? Math.min(54, toastH * 1.55) : toastH;
        const lx0 = 8;
        let ly0 = topHudBottom + 6;
        if (chosenCtxRect.ok && curCtxZone === 'top-left') {
          ly0 = Math.max(ly0, chosenCtxRect.y1 + 5);
        }
        setCand(lx0, ly0, lw, estH);
        const rOv = overlapArea(candRect, runnerBox);
        const cOv = chosenCtxRect.ok ? overlapArea(candRect, chosenCtxRect) : 0;
        const jOv = joyRect.ok ? overlapArea(candRect, joyRect) : 0;
        const sOv = hudStaticPenalty();
        const tot = rOv * 4 + cOv * 2 + jOv * 2 + sOv;
        if (tot < bestTOverlap) {
          bestTZone = 'top-left';
          bestTOverlap = tot;
          bestRunnerOv = rOv;
          bestTY0 = ly0;
        }
      }

      // Candidate C: Bottom safe zone (in bottom gap if wide enough, else above bottom controls)
      if (bestTOverlap > 0) {
        const fitsGap = centerGapW >= 220 && toastW <= centerGapW && (!chosenCtxRect.ok || curCtxZone !== 'bottom-gap');
        const bx0 = fitsGap ? joyRight + 8 + (centerGapW - toastW) * 0.5 : (vw - toastW) * 0.5;
        const by0 = fitsGap ? vh - 6 - toastH : bottomControlsTop - 8 - toastH;
        setCand(bx0, by0, toastW, toastH);
        const rOv = overlapArea(candRect, runnerBox);
        const cOv = chosenCtxRect.ok ? overlapArea(candRect, chosenCtxRect) : 0;
        const sOv = hudStaticPenalty();
        const tot = rOv * 4 + cOv * 2 + sOv;
        if (tot < bestTOverlap) {
          bestTZone = fitsGap ? 'bottom-gap' : 'bottom-above';
          bestTOverlap = tot;
          bestRunnerOv = rOv;
          bestTY0 = by0;
        }
      }

      if (curToastZone !== bestTZone) {
        curToastZone = bestTZone;
        toastsEl.dataset.toastZone = bestTZone;
      }
      toastsEl.style.setProperty('--toast-y-px', `${Math.round(bestTY0)}px`);
      setClass(toastsEl, 'is-runner-occluded', bestRunnerOv > 0);
    } else {
      setClass(toastsEl, 'is-runner-occluded', false);
    }
  }

  const unsubLate =
    typeof engine.onLateUpdate === 'function'
      ? engine.onLateUpdate(update)
      : engine.onUpdate?.(update);

  return {
    update,
    getRunnerScreenBox: () => runnerBox,
    dispose() {
      if (unsubBounds) unsubBounds();
      if (unsubLate) unsubLate();
      clearAll();
    },
  };
}
