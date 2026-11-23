const SETTINGS_KEY = 'telluride_trails_settings_v1';
const RECORDS_KEY = 'telluride_trails_records_v1';

export const DEFAULT_SETTINGS = Object.freeze({
  units: 'imperial', // 'imperial' | 'metric'
  qualityTier: 'auto', // 'auto' | 'low' | 'medium' | 'high' | 'ultra'
  renderScale: 1.0,
  audio: true,
  volume: 0.75,
  musicVolume: 0.65,
  sfxVolume: 0.85,
  touchControls: 'auto', // 'auto' | 'always' | 'off'
  haptics: true,
  invertY: false,
  lookSensitivity: 1.0,
  freeRunStartTime: 'morning',
});

/**
 * Load persisted UI/game settings merged with defaults.
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist settings updates to localStorage.
 * @param {Partial<typeof DEFAULT_SETTINGS>} next
 */
export function saveSettings(next) {
  try {
    const merged = { ...loadSettings(), ...next };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS, ...next };
  }
}

/**
 * Load race/run records from localStorage.
 * @returns {Array<object>}
 */
export function loadRecords() {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append a completed/DNF run record (caps at 50 entries).
 * @param {object} record
 */
export function saveRecord(record) {
  try {
    const existing = loadRecords();
    existing.unshift({ ...record, savedAt: Date.now() });
    localStorage.setItem(RECORDS_KEY, JSON.stringify(existing.slice(0, 50)));
  } catch {
    // ignore storage quota errors
  }
}

/**
 * Return best finish time (seconds) for a raceId, reading gameplay's PB store first
 * and falling back to UI records, preferring clean (non-time-dilated) runs.
 * @param {string} raceId
 * @param {object} [game]
 * @returns {{ elapsedSec: number, timeDilated: boolean }|null}
 */
export function getBestRecord(raceId, game) {
  if (!raceId) return null;
  try {
    const pbs =
      typeof game?.getPersonalBests === 'function'
        ? game.getPersonalBests()
        : JSON.parse(localStorage.getItem('telluride_trails.pbs.v1') || '{}');
    const gpBest = pbs?.[raceId];
    if (gpBest && Number.isFinite(gpBest.clockS) && gpBest.clockS > 0) {
      return {
        elapsedSec: gpBest.clockS,
        timeDilated: Boolean(gpBest.timeDilated),
      };
    }
  } catch {
    // fallback to local records
  }

  const records = loadRecords().filter((r) => r.raceId === raceId && !r.dnf && r.elapsedSec > 0);
  if (!records.length) return null;
  const clean = records.filter((r) => !r.timeDilated);
  const pool = clean.length ? clean : records;
  return pool.reduce((best, cur) => (cur.elapsedSec < best.elapsedSec ? cur : best), pool[0]);
}

/**
 * Peek saved run state from gameplay API or known localStorage keys.
 * @param {object} game
 * @returns {object|null}
 */
export function peekSavedRun(game) {
  try {
    if (typeof game?.getSavedRun === 'function') {
      const saved = game.getSavedRun();
      if (saved) return saved;
    }
    const candidateKeys = [
      'telluride_trails.run.v1',
      'telluride_trails_save_v1',
      'telluride_trails_save',
      'telluride-trails-save',
      'tt_save_v1',
    ];
    for (const key of candidateKeys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.mode && !parsed.finished && !parsed.dnf) {
        return {
          ...parsed,
          x: parsed.x ?? parsed.pos?.x ?? 0,
          y: parsed.y ?? parsed.pos?.y ?? 0,
          z: parsed.z ?? parsed.pos?.z ?? 0,
        };
      }
    }
  } catch {
    // ignore
  }
  return null;
}
