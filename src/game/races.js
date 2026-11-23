// Race manager: progressive polyline tracking, aid stations & checkpoints,
// splits, cutoffs, DNF, Hardrock finish ceremony, and personal bests.

import { FOODS } from './constants.js';
import { formatDurationClock, formatRealTimeEta } from './humor.js';
import { recordPersonalBest } from './save.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Precomputed aid station menus (zero per-frame allocations)
const DAY_AID_MENU = Object.entries(FOODS)
  .filter(([, f]) => !f.night)
  .map(([key]) => key);
const NIGHT_AID_MENU = Object.keys(FOODS);

export function createRaceManager() {
  let activeRace = null;
  let segCount = 0;
  let totalDistM = 0;
  let lastSegIdx = 0;
  let courseDistM = 0;
  let offCourseM = 0;
  let checkpointIdx = 0;
  let checkpoints = [];
  let splits = [];
  let clockS = 0;
  let startEpochMs = 0;
  let timeDilated = false;
  let finished = false;
  let dnf = false;
  let dnfReason = null;
  let penaltyS = 0;
  let ceremonyTimer = 0;
  let ceremonyActive = false;

  function initRace(raceObj, restored = null) {
    activeRace = raceObj;
    const line = raceObj.line;
    segCount = line ? Math.floor(line.length / 3) : 0;
    totalDistM = segCount > 0 ? line[(segCount - 1) * 3 + 2] : (raceObj.distanceMi || 1) * 1609.344;

    // Normalize checkpoints / aid stations
    const rawCps = raceObj.checkpoints || raceObj.aid || [];
    checkpoints = rawCps.map((cp, idx) => ({
      index: idx,
      name: cp.name || `Checkpoint ${idx + 1}`,
      d: cp.d ?? cp.distM ?? 0,
      x: cp.x,
      z: cp.z,
      cutoffH: cp.cutoffH ?? null,
      passed: false,
    })).sort((a, b) => a.d - b.d);

    // Defensive fix if intermediate checkpoint cutoffs were authored as remaining-hours (decreasing)
    const interCuts = checkpoints.slice(0, -1).map((c) => c.cutoffH).filter((v) => v != null);
    if (interCuts.length >= 2 && interCuts[0] > interCuts[interCuts.length - 1] && raceObj.cutoffH) {
      for (let i = 0; i < checkpoints.length - 1; i++) {
        if (checkpoints[i].cutoffH != null) {
          checkpoints[i].cutoffH = Math.max(0.5, raceObj.cutoffH - checkpoints[i].cutoffH);
        }
      }
    }

    if (restored) {
      lastSegIdx = restored.lastSegIdx || 0;
      courseDistM = restored.courseDistM || 0;
      offCourseM = restored.offCourseM || 0;
      checkpointIdx = restored.checkpointIdx || 0;
      splits = restored.splits || [];
      clockS = restored.clockS || 0;
      startEpochMs = restored.startEpochMs || Date.now();
      timeDilated = Boolean(restored.timeDilated);
      finished = Boolean(restored.finished);
      dnf = Boolean(restored.dnf);
      dnfReason = restored.dnfReason || null;
      penaltyS = restored.penaltyS || 0;
      for (let i = 0; i < checkpointIdx && i < checkpoints.length; i++) {
        checkpoints[i].passed = true;
      }
    } else {
      lastSegIdx = 0;
      courseDistM = 0;
      offCourseM = 0;
      checkpointIdx = 0;
      splits = [];
      clockS = 0;
      startEpochMs = Date.now();
      timeDilated = false;
      finished = false;
      dnf = false;
      dnfReason = null;
      penaltyS = 0;
    }
    ceremonyTimer = 0;
    ceremonyActive = false;
  }

  function clear() {
    activeRace = null;
    checkpoints = [];
    splits = [];
    finished = false;
    dnf = false;
    ceremonyActive = false;
  }

  /**
   * Find closest point on race polyline near lastSegIdx (with wide fallback).
   */
  function projectOnCourse(px, pz) {
    if (!activeRace || segCount < 2) {
      return { distOnLine: courseDistM, offCourse: 0, segIdx: 0, x: px, z: pz };
    }
    const line = activeRace.line;
    const winStart = Math.max(0, lastSegIdx - 18);
    const winEnd = Math.min(segCount - 2, lastSegIdx + 65);

    let bestDistSq = Infinity;
    let bestSeg = lastSegIdx;
    let bestT = 0;
    let bestX = px;
    let bestZ = pz;

    const searchRange = (from, to) => {
      for (let i = from; i <= to; i++) {
        const ax = line[i * 3];
        const az = line[i * 3 + 1];
        const bx = line[(i + 1) * 3];
        const bz = line[(i + 1) * 3 + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        let t = 0;
        if (lenSq > 1e-6) {
          t = clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1);
        }
        const cx = ax + dx * t;
        const cz = az + dz * t;
        const dSq = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestSeg = i;
          bestT = t;
          bestX = cx;
          bestZ = cz;
        }
      }
    };

    searchRange(winStart, winEnd);
    // If very far (>180m) from local window, do full scan (handles teleport / skipToRaceDistance)
    if (bestDistSq > 180 * 180) {
      searchRange(0, segCount - 2);
    }

    lastSegIdx = bestSeg;
    const d0 = line[bestSeg * 3 + 2];
    const d1 = line[(bestSeg + 1) * 3 + 2];
    const dOnLine = d0 + (d1 - d0) * bestT;
    const offM = Math.sqrt(bestDistSq);

    return { distOnLine: dOnLine, offCourse: offM, segIdx: bestSeg, x: bestX, z: bestZ };
  }

  /**
   * Lookahead target point on race line for autopilot.
   */
  function getAutopilotTarget(px, pz, lookaheadM = 20) {
    if (!activeRace || segCount < 2) return null;
    const proj = projectOnCourse(px, pz);
    const targetDist = Math.min(totalDistM, proj.distOnLine + lookaheadM);
    const line = activeRace.line;
    for (let i = proj.segIdx; i < segCount - 1; i++) {
      const d0 = line[i * 3 + 2];
      const d1 = line[(i + 1) * 3 + 2];
      if (d1 >= targetDist || i === segCount - 2) {
        const span = Math.max(0.01, d1 - d0);
        const t = clamp((targetDist - d0) / span, 0, 1);
        return {
          x: line[i * 3] + (line[(i + 1) * 3] - line[i * 3]) * t,
          z: line[i * 3 + 1] + (line[(i + 1) * 3 + 1] - line[i * 3 + 1]) * t,
          offCourseM: proj.offCourse,
        };
      }
    }
    const last = segCount - 1;
    return { x: line[last * 3], z: line[last * 3 + 1], offCourseM: proj.offCourse };
  }

  /**
   * Get food menu available at an aid station (night items added during evening/night hours).
   */
  function getAidMenu(localHour) {
    const isNight = localHour >= 19 || localHour < 6.5;
    return isNight ? NIGHT_AID_MENU : DAY_AID_MENU;
  }

  /**
   * Update race progress, checkpoints, cutoffs, aid proximity, and finish.
   */
  function update(dtSim, px, pz, speedMs, localHour) {
    const events = [];
    if (!activeRace || finished || dnf) return { events, nearAid: null };

    clockS += dtSim;
    const effectiveClockS = clockS + penaltyS;

    const proj = projectOnCourse(px, pz);
    offCourseM = proj.offCourse;
    // Allow forward progress when near course (<= 65m)
    if (offCourseM <= 65 && proj.distOnLine > courseDistM) {
      courseDistM = proj.distOnLine;
    }

    // Check overall race cutoff (including any off-course penalty seconds)
    if (activeRace.cutoffH && effectiveClockS > activeRace.cutoffH * 3600) {
      dnf = true;
      dnfReason = `Exceeded overall ${activeRace.cutoffH}h course cutoff.`;
      events.push({ type: 'dnf', reason: dnfReason });
      return { events, nearAid: null };
    }

    // Check next checkpoint / aid station
    let nearAid = null;
    for (let i = 0; i < checkpoints.length; i++) {
      const cp = checkpoints[i];
      const dToCp = Math.hypot(px - cp.x, pz - cp.z);
      const isFinishCp = i === checkpoints.length - 1 && (cp.d >= totalDistM - 60 || /finish|kiss the rock/i.test(cp.name));
      if (!ceremonyActive && !isFinishCp && dToCp <= 32) {
        nearAid = { name: cp.name, foods: getAidMenu(localHour) };
      }
      if (!cp.passed && i === checkpointIdx && (dToCp <= 28 || (offCourseM <= 55 && courseDistM >= cp.d - 15))) {
        cp.passed = true;
        checkpointIdx++;
        const prevSplitS = splits.length ? splits[splits.length - 1].clockS : 0;
        const splitS = effectiveClockS - prevSplitS;
        const cutoffS = cp.cutoffH ? cp.cutoffH * 3600 : null;
        const deltaCutoffS = cutoffS != null ? cutoffS - effectiveClockS : null;

        if (cutoffS != null && effectiveClockS > cutoffS) {
          dnf = true;
          dnfReason = `Missed cutoff at ${cp.name} (${formatDurationClock(cutoffS)}).`;
          events.push({ type: 'dnf', reason: dnfReason, checkpoint: cp.name });
          return { events, nearAid };
        }

        const entry = {
          name: cp.name,
          index: i + 1,
          total: checkpoints.length,
          clockS: effectiveClockS,
          splitS,
          cutoffS,
          deltaCutoffS,
          timeDilated,
        };
        splits.push(entry);
        events.push({ type: 'checkpoint', ...entry });
      }
    }

    // Finish detection: require >=85% of course covered so 0-checkpoint loop races never instant-finish
    const fin = activeRace.finish || (segCount > 0 ? { x: activeRace.line[(segCount - 1) * 3], z: activeRace.line[(segCount - 1) * 3 + 1] } : null);
    const dToFinish = fin ? Math.hypot(px - fin.x, pz - fin.z) : Math.max(0, totalDistM - courseDistM);
    const allCpsPassed = checkpointIdx >= checkpoints.length;
    const minCourseCovered = courseDistM >= totalDistM * 0.85;
    const nearEnd = courseDistM >= totalDistM - 35 || (allCpsPassed && minCourseCovered && dToFinish <= 24);

    if (nearEnd && !ceremonyActive) {
      nearAid = null;
      const isHardrock = (activeRace.id || '').toLowerCase().includes('hardrock');
      if (isHardrock) {
        ceremonyActive = true;
        ceremonyTimer = 3.5;
        events.push({ type: 'ceremony_start' });
      } else {
        completeFinish(events);
      }
    } else if (ceremonyActive) {
      nearAid = null;
      ceremonyTimer -= Math.min(dtSim, 0.25);
      if (ceremonyTimer <= 0) {
        ceremonyActive = false;
        completeFinish(events);
      }
    }

    return { events, nearAid };
  }

  function completeFinish(events) {
    if (finished) return;
    finished = true;
    const finalClockS = clockS + penaltyS;
    const { isNewPb, best } = recordPersonalBest(activeRace.id, {
      clockS: finalClockS,
      timeDilated,
    });
    events.push({
      type: 'finish',
      raceId: activeRace.id,
      raceName: activeRace.name,
      clockS: finalClockS,
      rawClockS: clockS,
      penaltyS,
      timeDilated,
      isNewPb,
      pb: best,
      splits: [...splits],
      isHardrock: (activeRace.id || '').toLowerCase().includes('hardrock'),
    });
  }

  /**
   * Dev/playtest helper: skip along race polyline to a given distance or next checkpoint.
   */
  function getPointAtDistance(targetM) {
    if (!activeRace || segCount < 2) return null;
    const d = clamp(targetM, 0, totalDistM);
    const line = activeRace.line;
    for (let i = 0; i < segCount - 1; i++) {
      const d0 = line[i * 3 + 2];
      const d1 = line[(i + 1) * 3 + 2];
      if (d1 >= d || i === segCount - 2) {
        const span = Math.max(0.01, d1 - d0);
        const t = clamp((d - d0) / span, 0, 1);
        const x = line[i * 3] + (line[(i + 1) * 3] - line[i * 3]) * t;
        const z = line[i * 3 + 1] + (line[(i + 1) * 3 + 1] - line[i * 3 + 1]) * t;
        const dx = line[(i + 1) * 3] - line[i * 3];
        const dz = line[(i + 1) * 3 + 1] - line[i * 3 + 1];
        const heading = Math.atan2(-dx, -dz);
        lastSegIdx = i;
        courseDistM = d;
        // Mark earlier checkpoints passed so skip works seamlessly
        for (let c = 0; c < checkpoints.length; c++) {
          if (checkpoints[c].d <= d - 20) {
            checkpoints[c].passed = true;
            checkpointIdx = Math.max(checkpointIdx, c + 1);
          }
        }
        return { x, z, heading, distM: d };
      }
    }
    return null;
  }

  function getHudSummary(speedMs, simEpochMs = Date.now()) {
    if (!activeRace) return null;
    const nextCp = checkpoints[checkpointIdx] || null;
    const remTotalM = Math.max(0, totalDistM - courseDistM);
    const effectiveSpeed = speedMs > 0.35 ? speedMs : 1.75; // conservative ultrarunner estimate when paused/stopped
    const etaS = remTotalM / effectiveSpeed;
    const etaInfo = formatRealTimeEta(etaS, simEpochMs);

    const nextAidDistM = nextCp ? Math.max(0, nextCp.d - courseDistM) : remTotalM;
    const nextAidEtaS = nextAidDistM / effectiveSpeed;
    const nextCutoffS = nextCp?.cutoffH ? nextCp.cutoffH * 3600 : (activeRace.cutoffH ? activeRace.cutoffH * 3600 : null);
    const totalClockS = clockS + penaltyS;
    const cutoffRemainingSec = nextCutoffS != null ? Math.max(0, nextCutoffS - totalClockS) : null;
    const nextAidPos = nextCp
      ? { x: nextCp.x, z: nextCp.z }
      : (activeRace.finish ? { x: activeRace.finish.x, z: activeRace.finish.z } : null);

    return {
      id: activeRace.id,
      name: activeRace.name,
      clockS: totalClockS,
      rawClockS: clockS,
      penaltyS,
      timeDilated,
      courseDistM,
      totalDistM,
      finishDistM: remTotalM,
      offCourseM,
      nextAidName: nextCp ? nextCp.name : 'Finish',
      nextAidPos,
      nextAidDistM,
      nextAidEtaS,
      nextAidCutoffS: nextCutoffS,
      cutoffH: activeRace.cutoffH ?? null,
      cutoffRemainingSec,
      remainingSec: etaS,
      etaS,
      etaLabel: etaInfo.label,
      etaJoke: etaInfo.joke,
      checkpointsPassed: checkpointIdx,
      totalCheckpoints: checkpoints.length,
      splits,
      ceremonyActive,
    };
  }

  return {
    initRace,
    clear,
    update,
    getAutopilotTarget,
    getPointAtDistance,
    getHudSummary,
    markTimeDilated() { timeDilated = true; },
    addPenalty(sec) { penaltyS += sec; },
    addWallGap(sec) {
      if (activeRace && !finished && !dnf) clockS += sec;
    },
    triggerKissFinish() {
      if (ceremonyActive) ceremonyTimer = Math.min(ceremonyTimer, 0.8);
    },
    getNextCheckpointDist() {
      if (checkpointIdx < checkpoints.length) return checkpoints[checkpointIdx].d;
      return totalDistM;
    },
    isActive: () => Boolean(activeRace),
    isFinished: () => finished,
    isDnf: () => dnf,
    isCeremony: () => ceremonyActive,
    getOffCourseM: () => offCourseM,
    getRace: () => activeRace,
    serialize() {
      if (!activeRace) return null;
      return {
        raceId: activeRace.id,
        lastSegIdx,
        courseDistM,
        offCourseM,
        checkpointIdx,
        splits,
        clockS,
        startEpochMs,
        timeDilated,
        finished,
        dnf,
        dnfReason,
        penaltyS,
      };
    },
  };
}
