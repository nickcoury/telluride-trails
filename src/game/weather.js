// Telluride real local time (America/Denver), ambient temperature model,
// and afternoon monsoon lightning risk on exposed high ridges.

import { M_TO_FT } from './constants.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function createWeatherSystem(engine, world) {
  let timeOffsetHours = 0; // optional dev override via setTimeOfDay(hour)
  let stormActive = false;
  let stormIntensity = 0;
  let stormTimerS = 0;
  let stormCooldownS = 90;
  let ridgeExposureS = 0;
  let lastWarningS = -999;

  function getDenverClock(now = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? now.getHours());
      const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? now.getMinutes());
      const rawHour = (hh % 24) + mm / 60;
      const hour = (rawHour + timeOffsetHours + 24) % 24;
      const h24 = Math.floor(hour);
      const m60 = Math.floor((hour - h24) * 60);
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12 = ((h24 + 11) % 12) + 1;
      const label = `${h12}:${String(m60).padStart(2, '0')} ${ampm}`;
      return { hour, label, isNight: hour >= 19.75 || hour < 6.25 };
    } catch {
      const hour = (now.getHours() + now.getMinutes() / 60 + timeOffsetHours + 24) % 24;
      return { hour, label: '12:00 PM', isNight: hour >= 20 || hour < 6 };
    }
  }

  function setTimeOfDay(hour) {
    const real = getDenverClock();
    const baseHour = (real.hour - timeOffsetHours + 24) % 24;
    timeOffsetHours = ((hour - baseHour) % 24 + 24) % 24;
    if (world?.setTimeOfDay) {
      const d = new Date();
      const h = Math.floor(hour);
      const m = Math.floor((hour - h) * 60);
      d.setHours(h, m, 0, 0);
      world.setTimeOfDay(d);
    }
  }

  /**
   * Ambient temperature in C from local hour and elevation (lapse rate ~6.5 C / 1000 m).
   */
  function getTemperatureC(localHour, elevM) {
    const baseAtTelluride = 13 + 9 * Math.cos(((localHour - 15) / 24) * Math.PI * 2);
    const lapse = ((elevM - 2667) / 1000) * 6.5;
    return baseAtTelluride - lapse - (stormActive ? 4.5 * stormIntensity : 0);
  }

  function emitStorm(active, intensity, lightning = false) {
    engine.events.emit('world:storm', { active, intensity, lightning });
  }

  function update(dt, { elevM, surface, elapsedRunS }) {
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
    stormCooldownS = Math.max(0, stormCooldownS - dt);

    if (!stormActive && isMonsoonWindow && highExposed && stormCooldownS <= 0) {
      // Chance ramps up in afternoon above treeline
      if (Math.random() < risk * 0.012 * dt) {
        stormActive = true;
        stormIntensity = 0.75 + Math.random() * 0.25;
        stormTimerS = 95 + Math.random() * 110;
        ridgeExposureS = 0;
        emitStorm(true, stormIntensity, true);
        events.push({ type: 'storm_start' });
      }
    }

    if (stormActive) {
      stormTimerS -= dt;
      if (highExposed) {
        ridgeExposureS += dt;
        if (ridgeExposureS > 28 && elapsedRunS - lastWarningS > 35) {
          lastWarningS = elapsedRunS;
          events.push({ type: 'ridge_static' });
        }
        // Very rare lightning close-call if camping on a 13er+ ridge during an active storm
        if (elevFt > 12400 && ridgeExposureS > 55 && Math.random() < 0.025 * dt) {
          ridgeExposureS = 15;
          emitStorm(true, 1.0, true);
          events.push({ type: 'lightning_strike' });
        }
      } else {
        ridgeExposureS = Math.max(0, ridgeExposureS - dt * 2);
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
