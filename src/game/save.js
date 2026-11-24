// localStorage persistence for active runs, personal bests, and achievements.

const SAVE_KEY = 'telluride_trails.run.v1';
const PB_KEY = 'telluride_trails.pbs.v1';
const ACH_KEY = 'telluride_trails.achievements.v1';
const RUNNER_KEY = 'telluride_trails.runner.v1';

const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch {
      return false;
    }
  },
  del(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore private browsing / storage quota errors
    }
  },
};

// In-memory cache for unlocked achievements so per-substep checks are O(1) with zero localStorage reads.
let achCache = null;

function ensureAchCache() {
  if (!achCache) {
    achCache = store.get(ACH_KEY) || {};
  }
  return achCache;
}

export function hasSavedRun() {
  const s = store.get(SAVE_KEY);
  return Boolean(s && s.mode && s.pos && !s.finished && !s.dnf);
}

export function loadSavedRun() {
  return store.get(SAVE_KEY);
}

export function writeSavedRun(data) {
  return store.set(SAVE_KEY, {
    ...data,
    version: 1,
    lastSavedEpochMs: Date.now(),
  });
}

export function clearSavedRun() {
  store.del(SAVE_KEY);
}

export function loadSelectedRunner() {
  return store.get(RUNNER_KEY);
}

export function saveSelectedRunner(profile) {
  if (!profile) return false;
  if (profile.isCustom || profile.id === 'custom') {
    return store.set(RUNNER_KEY, {
      id: 'custom',
      isCustom: true,
      name: profile.name,
      hometown: profile.hometown,
      specialty: profile.specialty,
      stats: profile.stats,
      kit: profile.kit,
      uncapped: Boolean(profile.statUncapped || profile.uncapped),
    });
  }
  return store.set(RUNNER_KEY, { id: profile.id });
}

export function loadPersonalBests() {
  return store.get(PB_KEY) || {};
}

export function recordPersonalBest(raceId, { clockS, timeDilated, statUncapped, runnerId, runnerName, dateIso }) {
  if (!raceId) return { isNewPb: false, best: null };
  const pbs = loadPersonalBests();
  const prev = pbs[raceId];
  const asterisk = Boolean(timeDilated || statUncapped);
  const prevAsterisk = Boolean(prev && (prev.asterisk || prev.timeDilated || prev.statUncapped));
  // Clean (non-asterisked) runs always beat asterisked runs, or fastest within same category
  let isNewPb = false;
  if (!prev) {
    isNewPb = true;
  } else if (!asterisk && prevAsterisk) {
    isNewPb = true;
  } else if (asterisk === prevAsterisk && clockS < prev.clockS) {
    isNewPb = true;
  }

  if (isNewPb) {
    pbs[raceId] = {
      clockS,
      timeDilated: Boolean(timeDilated),
      statUncapped: Boolean(statUncapped),
      asterisk,
      runnerId: runnerId || null,
      runnerName: runnerName || null,
      dateIso: dateIso || new Date().toISOString(),
    };
    store.set(PB_KEY, pbs);
  }
  return { isNewPb, best: pbs[raceId] };
}

export function loadAchievements() {
  return { ...ensureAchCache() };
}

export function isAchievementUnlocked(id) {
  return Boolean(ensureAchCache()[id]);
}

export function saveAchievement(id) {
  const all = ensureAchCache();
  if (all[id]) return false;
  all[id] = { unlockedAt: Date.now() };
  store.set(ACH_KEY, all);
  return true;
}
