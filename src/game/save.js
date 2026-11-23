// localStorage persistence for active runs, personal bests, and achievements.

const SAVE_KEY = 'telluride_trails.run.v1';
const PB_KEY = 'telluride_trails.pbs.v1';
const ACH_KEY = 'telluride_trails.achievements.v1';

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

export function loadPersonalBests() {
  return store.get(PB_KEY) || {};
}

export function recordPersonalBest(raceId, { clockS, timeDilated, dateIso }) {
  if (!raceId) return { isNewPb: false, best: null };
  const pbs = loadPersonalBests();
  const prev = pbs[raceId];
  // Clean (non-dilated) runs always beat dilated runs, or fastest within same category
  let isNewPb = false;
  if (!prev) {
    isNewPb = true;
  } else if (!timeDilated && prev.timeDilated) {
    isNewPb = true;
  } else if (Boolean(timeDilated) === Boolean(prev.timeDilated) && clockS < prev.clockS) {
    isNewPb = true;
  }

  if (isNewPb) {
    pbs[raceId] = { clockS, timeDilated: Boolean(timeDilated), dateIso: dateIso || new Date().toISOString() };
    store.set(PB_KEY, pbs);
  }
  return { isNewPb, best: pbs[raceId] };
}

export function loadAchievements() {
  return store.get(ACH_KEY) || {};
}

export function saveAchievement(id) {
  const all = loadAchievements();
  if (all[id]) return false;
  all[id] = { unlockedAt: Date.now() };
  store.set(ACH_KEY, all);
  return true;
}
