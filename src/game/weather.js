// Telluride July mountain clock (America/Denver), ambient temperature model,
// and afternoon monsoon lightning risk on exposed high ridges.

import { M_TO_FT } from './constants.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Mid-July anchor in Telluride (MDT = UTC-6): 2026-07-18 00:00:00 MDT = 06:00:00 UTC
const JULY_MIDNIGHT_MDT_UTC_MS = Date.UTC(2026, 6, 18, 6, 0, 0);

// Aligned with src/ui/format.js START_TIME_OPTIONS
export const START_TIME_PRESETS = {
  dawn: 5.75,       // 5:45 AM
  morning: 8.0,     // 8:00 AM (default)
  midday: 12.5,     // 12:30 PM
  afternoon: 15.0,  // 3:00 PM (monsoon o'clock)
  golden: 19.83,    // 7:50 PM (July golden hour / alpenglow)
  night: 22.0,      // 10:00 PM (headlamp)
};

// Module-scoped formatter (constructed once, used only for initial 'now' wall-clock read)
let DENVER_TIME_FMT = null;
try {
  DENVER_TIME_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Denver',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
} catch {
  DENVER_TIME_FMT = null;
}

export function getRealDenverHour(now = new Date()) {
  if (DENVER_TIME_FMT) {
    try {
      const parts = DENVER_TIME_FMT.formatToParts(now);
      let hh = 0;
      let mm = 0;
      let ss = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.type === 'hour') hh = Number(p.value) % 24;
        else if (p.type === 'minute') mm = Number(p.value);
        else if (p.type === 'second') ss = Number(p.value);
      }
      return hh + mm / 60 + ss / 3600;
    } catch {
      // fall through
    }
  }
  return now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
}

export function parseStartTimeSpec(spec) {
  if (typeof spec === 'number' && Number.isFinite(spec)) {
    return ((spec % 24) + 24) % 24;
  }
  if (typeof spec === 'string') {
    const s = spec.trim().toLowerCase();
    if (s === 'now' || s === 'realtime' || s === 'real') {
      return getRealDenverHour();
    }
    if (s in START_TIME_PRESETS) {
      return START_TIME_PRESETS[s];
    }
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (m) {
      return clamp(Number(m[1]) + Number(m[2]) / 60, 0, 23.99);
    }
  }
  return START_TIME_PRESETS.morning;
}

export function createWeatherSystem(engine, world) {
  let simEpochMs = JULY_MIDNIGHT_MDT_UTC_MS + START_TIME_PRESETS.morning * 3600000;
  let lastWorldSyncPerf = 0;
  let cachedMinuteKey = -1;
  let cachedLabel = '8:00 AM';

  let stormActive = false;
  let stormIntensity = 0;
  let stormTimerS = 0;
  let stormCooldownS = 90;
  let ridgeExposureS = 0;
  let lastWarningS = -999;

  // Scratch clock object reused to avoid per-substep allocations
  const clockOut = { hour: 8, label: '8:00 AM', isNight: false, epochMs: simEpochMs };

  function syncWorldClock(force = false) {
    const nowPerf = performance.now();
    if (!force && nowPerf - lastWorldSyncPerf < 250) return;
    lastWorldSyncPerf = nowPerf;
    world?.setTimeOfDay?.(new Date(simEpochMs));
  }

  function setStartTime(spec) {
    const hour = parseStartTimeSpec(spec);
    simEpochMs = JULY_MIDNIGHT_MDT_UTC_MS + hour * 3600000;
    cachedMinuteKey = -1;
    syncWorldClock(true);
    return hour;
  }

  function setSimEpochMs(epochMs) {
    if (Number.isFinite(epochMs)) {
      simEpochMs = epochMs;
      cachedMinuteKey = -1;
      syncWorldClock(true);
    }
  }

  function advanceSimClock(seconds) {
    simEpochMs += seconds * 1000;
  }

  function setTimeOfDay(hour) {
    return setStartTime(hour);
  }

  /**
   * Zero-allocation Telluride MDT clock derived directly from mid-July simEpochMs.
   */
  function getDenverClock() {
    const hoursFromMidnight = (simEpochMs - JULY_MIDNIGHT_MDT_UTC_MS) / 3600000;
    const hour = ((hoursFromMidnight % 24) + 24) % 24;
    const totalMins = Math.floor(hour * 60);
    if (totalMins !== cachedMinuteKey) {
      cachedMinuteKey = totalMins;
      const h24 = Math.floor(totalMins / 60) % 24;
      const m60 = totalMins % 60;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = ((h24 + 11) % 12) + 1;
      cachedLabel = `${h12}:${m60 < 10 ? '0' : ''}${m60} ${ampm}`;
    }
    clockOut.hour = hour;
    clockOut.label = cachedLabel;
    // Mid-July Telluride civil twilight: bright ~5:27 AM to ~8:39 PM
    clockOut.isNight = hour >= 20.65 || hour < 5.45;
    clockOut.epochMs = simEpochMs;
    return clockOut;
  }

  /**
   * Ambient temperature in C from local hour and elevation (mid-July San Juans).
   */
  function getTemperatureC(localHour, elevM) {
    const baseAtTelluride = 15 + 9 * Math.cos(((localHour - 15) / 24) * Math.PI * 2);
    const lapse = ((elevM - 2667) / 1000) * 6.5;
    return baseAtTelluride - lapse - (stormActive ? 4.5 * stormIntensity : 0);
  }

  function emitStorm(active, intensity, lightning = false) {
    engine.events.emit('world:storm', { active, intensity, lightning });
  }

  function update(dtSim, { elevM, surface, elapsedRunS, timeScale = 1 }) {
    advanceSimClock(dtSim);
    // Keep world sun locked to game clock during time dilation and periodic anti-drift sync (every 5s)
    const nowPerf = performance.now();
    if (timeScale > 1.05) {
      syncWorldClock(false);
    } else if (nowPerf - lastWorldSyncPerf >= 5000) {
      syncWorldClock(true);
    }

    const clock = getDenverClock();
    const elevFt = elevM * M_TO_FT;
    const isMonsoonWindow = clock.hour >= 12.0 && clock.hour <= 17.5;
    const highExposed = elevFt >= 11500 && surface !== 'forest';

    // Monsoon risk (0..1)
    let risk = 0;
    if (isMonsoonWindow) {
      const peak = 1 - Math.abs(clock.hour - 14.75) / 2.75;
      risk = clamp(peak * 0.65 + (highExposed ? 0.35 : 0), 0, 1);
    }

    const events = [];
    stormCooldownS = Math.max(0, stormCooldownS - dtSim);

    if (!stormActive && isMonsoonWindow && highExposed && stormCooldownS <= 0) {
      if (Math.random() < risk * 0.012 * dtSim) {
        stormActive = true;
        stormIntensity = 0.75 + Math.random() * 0.25;
        stormTimerS = 95 + Math.random() * 110;
        ridgeExposureS = 0;
        emitStorm(true, stormIntensity, true);
        events.push({ type: 'storm_start' });
      }
    }

    if (stormActive) {
      stormTimerS -= dtSim;
      if (highExposed) {
        ridgeExposureS += dtSim;
        if (ridgeExposureS > 28 && elapsedRunS - lastWarningS > 35) {
          lastWarningS = elapsedRunS;
          events.push({ type: 'ridge_static' });
        }
        if (elevFt > 12400 && ridgeExposureS > 55 && Math.random() < 0.025 * dtSim) {
          ridgeExposureS = 15;
          emitStorm(true, 1.0, true);
          events.push({ type: 'lightning_strike' });
        }
      } else {
        ridgeExposureS = Math.max(0, ridgeExposureS - dtSim * 2);
      }

      if (stormTimerS <= 0) {
        stormActive = false;
        stormIntensity = 0;
        stormCooldownS = 240;
        emitStorm(false, 0, false);
        events.push({ type: 'storm_end' });
      }
    }

    return {
      clock,
      tempC: getTemperatureC(clock.hour, elevM),
      stormRisk: risk,
      stormActive,
      stormIntensity,
      events,
    };
  }

  return {
    getDenverClock,
    setStartTime,
    setSimEpochMs,
    advanceSimClock,
    syncWorldClock,
    setTimeOfDay,
    update,
    triggerStormNow(durationS = 120) {
      stormActive = true;
      stormIntensity = 0.9;
      stormTimerS = durationS;
      emitStorm(true, stormIntensity, true);
    },
    isStormActive: () => stormActive,
  };
}
