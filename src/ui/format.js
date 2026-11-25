import { M_TO_FT, M_TO_MI } from '../core/geo.js';

export const KM_TO_M = 1000;

/**
 * Format elevation in imperial (ft) or metric (m).
 * @param {number} meters
 * @param {'imperial'|'metric'} units
 * @returns {string}
 */
export function fmtElev(meters, units = 'imperial') {
  if (!Number.isFinite(meters)) return units === 'metric' ? '-- m' : '-- ft';
  if (units === 'metric') {
    return `${Math.round(meters).toLocaleString()} m`;
  }
  return `${Math.round(meters * M_TO_FT).toLocaleString()} ft`;
}

/**
 * Format vertical gain/loss with explicit sign.
 * @param {number} meters
 * @param {'imperial'|'metric'} units
 * @returns {string}
 */
export function fmtVert(meters, units = 'imperial') {
  if (!Number.isFinite(meters)) return units === 'metric' ? '+0 m' : '+0 ft';
  const sign = meters >= 0 ? '+' : '-';
  const abs = Math.abs(meters);
  if (units === 'metric') {
    return `${sign}${Math.round(abs).toLocaleString()} m`;
  }
  return `${sign}${Math.round(abs * M_TO_FT).toLocaleString()} ft`;
}

/**
 * Format distance (mi or km).
 * @param {number} meters
 * @param {'imperial'|'metric'} units
 * @param {number} decimals
 * @returns {string}
 */
export function fmtDist(meters, units = 'imperial', decimals = 2) {
  if (!Number.isFinite(meters) || meters < 0) {
    return units === 'metric' ? '0.00 km' : '0.00 mi';
  }
  if (units === 'metric') {
    return `${(meters / KM_TO_M).toFixed(decimals)} km`;
  }
  return `${(meters * M_TO_MI).toFixed(decimals)} mi`;
}

/**
 * Format short distance (ft/mi or m/km) for trail snap or aid proximity.
 * @param {number} meters
 * @param {'imperial'|'metric'} units
 * @returns {string}
 */
export function fmtShortDist(meters, units = 'imperial') {
  if (!Number.isFinite(meters) || meters < 0) return '--';
  if (units === 'metric') {
    if (meters < 1000) return `${Math.round(meters)} m`;
    return `${(meters / 1000).toFixed(1)} km`;
  }
  const feet = meters * M_TO_FT;
  if (feet < 900) return `${Math.round(feet)} ft`;
  return `${(meters * M_TO_MI).toFixed(2)} mi`;
}

/**
 * Format running pace in mm:ss /mi or /km.
 * @param {{ paceSecPerMi?: number, paceSecPerKm?: number, paceMinPerMi?: number, speedMs?: number }} data
 * @param {'imperial'|'metric'} units
 * @returns {string}
 */
export function fmtPace(data, units = 'imperial') {
  let secPerUnit = 0;
  if (units === 'metric') {
    if (data?.paceSecPerKm > 0) {
      secPerUnit = data.paceSecPerKm;
    } else if (data?.paceSecPerMi > 0) {
      secPerUnit = data.paceSecPerMi / 1.609344;
    } else if (data?.speedMs > 0.25) {
      secPerUnit = 1000 / data.speedMs;
    }
  } else {
    if (data?.paceSecPerMi > 0) {
      secPerUnit = data.paceSecPerMi;
    } else if (data?.paceMinPerMi > 0) {
      secPerUnit = data.paceMinPerMi * 60;
    } else if (data?.speedMs > 0.25) {
      secPerUnit = 1609.344 / data.speedMs;
    }
  }

  if (!Number.isFinite(secPerUnit) || secPerUnit <= 0 || secPerUnit > 3600) {
    return `--:-- /${units === 'metric' ? 'km' : 'mi'}`;
  }
  const mins = Math.floor(secPerUnit / 60);
  const secs = Math.floor(secPerUnit % 60);
  return `${mins}:${String(secs).padStart(2, '0')} /${units === 'metric' ? 'km' : 'mi'}`;
}

/**
 * Format stopwatch clock HH:MM:SS (supports >24h).
 * @param {number} seconds
 * @param {boolean} withSeconds
 * @returns {string}
 */
export function fmtClock(seconds, withSeconds = true) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(rem).padStart(2, '0');
  return withSeconds ? `${h}:${mm}:${ss}` : `${h}:${mm}`;
}

/**
 * Format compact duration (e.g. "36h 14m" or "42m").
 * @param {number} seconds
 * @returns {string}
 */
export function fmtDurationHuman(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--';
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Format heading radians (Three.js: 0 = -Z north, +PI/2 = -X west or +X east depending on convention)
 * Wait: in camera.js: forwardX = -Math.sin(yaw), forwardZ = -Math.cos(yaw)
 * So yaw=0 -> (0, -1) = North (-Z). yaw=-PI/2 -> (+1, 0) = East (+X).
 * In gameplay stub: heading = Math.atan2(-vx, -vz). For East (vx=1, vz=0), heading = -PI/2.
 * So compass azimuth deg clockwise from North = ((-heading * 180 / Math.PI) % 360 + 360) % 360.
 * @param {number} headingRad
 * @returns {{ deg: number, cardinal: string }}
 */
export function fmtCompass(headingRad = 0) {
  const deg = (((-headingRad * 180) / Math.PI) % 360 + 360) % 360;
  const rounded = Math.round(deg) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(deg / 45) % 8;
  return { deg: rounded, cardinal: dirs[idx] };
}

/**
 * Generate a tongue-in-cheek real-time finish ETA string.
 * @param {number} remainingSec
 * @returns {string}
 */
export function fmtRealTimeFinishEta(remainingSec) {
  if (!Number.isFinite(remainingSec) || remainingSec <= 0) return 'Finish: Anytime now';
  if (remainingSec > 120 * 3600) return 'Est. finish: Next month (keep moving!)';
  const etaDate = new Date(Date.now() + remainingSec * 1000);
  const day = etaDate.toLocaleDateString('en-US', { weekday: 'short' });
  const time = etaDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const hours = remainingSec / 3600;
  if (hours > 30) return `Est. finish: ${day} ${time} (tell your boss)`;
  if (hours > 12) return `Est. finish: ${day} ${time} (pack a headlamp)`;
  return `Est. finish: ${day} ${time}`;
}

/**
 * Format humorous race disclaimer based on race distance/cutoff.
 * @param {object} race
 * @returns {string}
 */
export function getRaceDisclaimer(race) {
  const id = (race?.id || '').toLowerCase();
  const dist = race?.distanceMi || 0;
  const gainStr = Math.round(race?.gainFt || 1810).toLocaleString();
  if (id.includes('spurs') || race?.easterEgg) {
    return '13.1 real-time miles of net-downhill Texas asphalt (~1:08–1:35 real hours). Zero talus, zero 13,000-ft passes, 100% thick sea-level oxygen — Telluride ultrarunners report existential dread moving their legs this fast.';
  }
  if (id.includes('hardrock') || dist >= 90) {
    return 'This race takes ~36 real hours. Yes, really. Your clock runs even when you close the tab.';
  }
  if (dist >= 40) {
    return 'Real-time mountain ultra: expect 10–18 real hours on your feet. Hydrate or hallucinate.';
  }
  if (id.includes('imogene') || dist >= 15) {
    return 'Real-time climb over a 13,114 ft pass. Roughly 2.5–4 real hours of joyful suffering.';
  }
  if (id.includes('rundola') && (id.includes('original') || id.includes('gondola') || (dist > 0 && dist < 1.8))) {
    return `${gainStr} ft straight up the ~31% gondola cut in real time — 1.1 miles of hands-on-knees vertical grind (~21–38 real min) while tourists wave down from the cabins.`;
  }
  if (id.includes('rundola')) {
    return `${gainStr} ft of relentless real-time climbing from Oak St Gondola Plaza up the Telluride Trail switchbacks (~21–38 real min; locals race it before coffee).`;
  }
  if (dist > 0 && dist < 3.5) {
    return `${gainStr} ft of lung-searing San Juan vertical in ${dist.toFixed(1)} real-time miles. Short on distance, long on calf regret.`;
  }
  return '100% real-time mountain clock. Save & resume anytime, or sit at an aid station too long.';
}

export const FOOD_CATALOG = {
  water: { label: 'Water', icon: '💧', hint: 'Hydration' },
  electro: { label: 'Electrolytes', icon: '🧂', hint: 'Sodium + fluid' },
  cola: { label: 'Flat Cola', icon: '🥤', hint: 'Caffeine + sugar' },
  broth: { label: 'Hot Broth', icon: '🍲', hint: 'Warm salt + soul' },
  coffee: { label: 'Coffee', icon: '☕', hint: 'Wake up' },
  watermelon: { label: 'Watermelon', icon: '🍉', hint: 'Cold & sweet' },
  banana: { label: 'Banana', icon: '🍌', hint: 'Potassium' },
  gel: { label: 'Gel', icon: '⚡', hint: 'Quick carbs' },
  potato: { label: 'Salt Potato', icon: '🥔', hint: 'Aid station classic' },
  pbj: { label: 'PB&J', icon: '🥪', hint: 'Real trail food' },
  quesadilla: { label: 'Quesadilla', icon: '🫓', hint: 'Hot grease + carbs' },
  pickle: { label: 'Pickle', icon: '🥒', hint: 'Cramp insurance' },
  gummies: { label: 'Gummies', icon: '🍬', hint: 'Chewable fuel' },
  bacon: { label: 'Bacon', icon: '🥓', hint: 'Ultra luxury' },
};

export const START_TIME_OPTIONS = [
  { id: 'morning', label: 'Morning (8:00 AM)', hour: 8.0 },
  { id: 'dawn', label: 'Dawn (5:45 AM)', hour: 5.75 },
  { id: 'midday', label: 'Midday (12:30 PM)', hour: 12.5 },
  { id: 'afternoon', label: 'Afternoon (Monsoon o’clock)', hour: 15.0 },
  { id: 'golden', label: 'Golden Hour (7:50 PM)', hour: 19.83 },
  { id: 'night', label: 'Night (Headlamp)', hour: 22.0 },
  { id: 'realtime', label: 'Right now (Real clock)', hour: null },
];

export const AID_SNACKS = [
  { key: 'gel', ...FOOD_CATALOG.gel },
  { key: 'pbj', ...FOOD_CATALOG.pbj },
  { key: 'pickle', ...FOOD_CATALOG.pickle },
  { key: 'broth', ...FOOD_CATALOG.broth },
  { key: 'cola', ...FOOD_CATALOG.cola },
];

export const TRIVIA = [
  'Hardrock 100 runners climb and descend 33,197 feet — more than Mount Everest from sea level, then back down.',
  'At the Hardrock 100 finish in Silverton, there is no tape to break: finishers kiss the painted Hardrock stone.',
  'The Telluride Gondola is the only free public transit of its kind in the US, climbing ~1,810 ft over Coonskin Ridge to San Sophia Station (10,540 ft).',
  'Imogene Pass sits at 13,114 ft between Ouray and Telluride. The Imogene Pass Run has linked the two mining towns since 1974.',
  'Bridal Veil Falls plunges 365 feet at the east end of Telluride’s box canyon, topped by the historic 1907 Smuggler-Union hydroelectric power plant.',
  'Grant Swamp Pass (12,950 ft) on the Hardrock course isn’t a trail — it’s a notorious wall of loose San Juan talus and sliding scree.',
  'Afternoon summer monsoons roll onto the San Juan ridges like clockwork after noon. Lightning is your cue to descend fast.',
  'Telluride sits at 8,750 ft in a glacially carved box canyon. Even walking uphill to get coffee counts as altitude training.',
  'Handies Peak (14,048 ft) is the highest point on the Hardrock 100 course — and one of Colorado’s most scenic 14ers.',
  'In real time, 1 second here = 1 second in the mountains. You can close the tab, sleep, and wake up still at Kroger’s Canteen (13,100 ft).',
  'The Rundola climbs straight up beneath the Telluride Gondola cabins to San Sophia Station — tourists wave down at runners gasping for air.',
  'Silverton’s Kendall Mountain sits right across the Animas River from town, hosting a brutal out-and-back skyrun to 13,066 ft.',
];
