// Dry, tongue-in-cheek humor, ETA jokes, Leave No Trace scolds,
// wildlife sightings, and Telluride / San Juan local flavor.

import { M_TO_FT } from './constants.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Format an absurdly honest real-time ETA string.
 */
export function formatRealTimeEta(etaSeconds) {
  if (!Number.isFinite(etaSeconds) || etaSeconds <= 0 || etaSeconds > 30 * 86400) {
    return { label: 'Eventually', joke: 'Estimated finish: Sometime this geological epoch.' };
  }
  const finishDate = new Date(Date.now() + etaSeconds * 1000);
  const day = DAYS[finishDate.getDay()];
  const hh = finishDate.getHours();
  const mm = String(finishDate.getMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  const timeStr = `${h12}:${mm} ${ampm}`;

  if (etaSeconds < 3600) {
    return { label: `${Math.ceil(etaSeconds / 60)}m`, joke: `Estimated finish: ${timeStr}. Almost time for a burger in town.` };
  }
  if (etaSeconds < 10 * 3600) {
    return { label: `${(etaSeconds / 3600).toFixed(1)}h`, joke: `Estimated finish: Today at ${timeStr}.` };
  }
  if (etaSeconds < 24 * 3600) {
    return { label: `${day} ${timeStr}`, joke: `Estimated finish: ${day} at ${timeStr}. Bring a headlamp.` };
  }
  const days = Math.floor(etaSeconds / 86400);
  if (days >= 2) {
    return { label: `${day} ${timeStr}`, joke: `Estimated finish: ${day} at ${timeStr}. Your loved ones have been notified.` };
  }
  return { label: `${day} ${timeStr}`, joke: `Estimated finish: ${day} at ${timeStr}. Hope you told your boss.` };
}

export function formatDurationClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function formatAwayJoke(awaySec) {
  const mins = Math.round(awaySec / 60);
  const hrs = (awaySec / 3600).toFixed(1);
  if (awaySec < 120) return null;
  if (awaySec < 3600) {
    return `You sat on a rock for ${mins} minutes. The San Juans did not pause.`;
  }
  return pick([
    `You took a ${hrs}-hour nap in the dirt. The race clock did not.`,
    `While you were gone for ${hrs} hours, marmots inspected your drop bag. Clock kept ticking.`,
    `${hrs} hours away. Good news: your legs rested. Bad news: it's still real time.`,
  ]);
}

export const LNT_WARNINGS = [
  'Leave No Trace! That alpine tundra took 300 years to grow and 0.4s for your trail shoes to squish.',
  'Stay on the trail! Shortcuts cause erosion — and slow you down anyway.',
  'Leave No Trace: busting through fragile wildflowers costs stamina and karma.',
  'Off-trail penalty! Even the marmots are judging your route choice.',
];

export const CLIFF_WARNINGS = [
  'That is a 50-degree cliff, not a trail.',
  'Technical climbing requires ropes, not Hokas. Sliding back.',
  'Gravity wins that argument. Find a switchback.',
];

export const BONK_QUOTES = [
  'Full bonk. Even a warm mashed potato sounds Michelin-starred right now.',
  'Glycogen tank empty. You are now powered exclusively by stubbornness.',
  'Hallucination check: that granite boulder does NOT have a burrito stand behind it.',
];

export const ALTITUDE_QUOTES = [
  'Welcome to 12,000+ ft. Oxygen is now a subscription feature.',
  'Your lungs filed a formal complaint with elevation.',
  'Above treeline: less air, better views, zero shade.',
];

export const NIGHT_QUOTES = [
  'It is 2 AM in the San Juans. Every pine tree looks vaguely like an aid station.',
  'Headlamp beam on. Just you, the stars, and 3,000 more feet of climbing.',
  'Night miles hit different. Mainly in the eyelids.',
];

export const STORM_WARNINGS = [
  'Afternoon San Juan monsoon building! Dark clouds over the ridge — get below treeline!',
  'Static electricity is buzzing in your hair! Lightning risk on exposed ridges!',
  'Thunder echoes off the basin walls. Maybe skip the summit selfie right now.',
];

export const DNF_CUTOFF_LINES = [
  'Cut off at the aid station. Good news: hot soup and a warm ride back to town.',
  'Missed the cutoff. The sweepers are handing you a blanket and a warm cup of broth.',
];

export function pickLntWarning() { return pick(LNT_WARNINGS); }
export function pickCliffWarning() { return pick(CLIFF_WARNINGS); }
export function pickBonkQuote() { return pick(BONK_QUOTES); }
export function pickAltQuote() { return pick(ALTITUDE_QUOTES); }
export function pickNightQuote() { return pick(NIGHT_QUOTES); }
export function pickStormWarning() { return pick(STORM_WARNINGS); }

/**
 * Location- and elevation-aware wildlife / trail flavor event generator.
 */
export function pickWildlifeEvent({ elevM, surface, trailName, x, z }) {
  const elevFt = elevM * M_TO_FT;
  const name = (trailName || '').toLowerCase();

  // Ice Lake / high peaks -> mountain goats
  if ((name.includes('ice lake') || elevFt > 12200) && Math.random() < 0.42) {
    return {
      achievement: 'goat_club',
      text: 'Mountain goats watch you from an impossibly sheer ledge, chewing grass like you’re the weird one.',
    };
  }

  // Talus / high elevation -> pikas
  if ((surface === 'talus' || surface === 'scree' || elevFt > 11800) && Math.random() < 0.45) {
    return {
      achievement: 'pika_fan',
      text: 'EEEP! A tiny round pika pops out of the talus and screams at your cadence.',
    };
  }

  // Drainages / creeks / willows -> moose
  if ((surface === 'creek' || name.includes('creek') || name.includes('willow') || elevFt < 10800) && Math.random() < 0.32) {
    return {
      achievement: 'moose_zone',
      text: 'A bull moose stands knee-deep in the creek willows. You politely yield the right-of-way.',
    };
  }

  // General alpine/forest flavor
  const general = [
    { text: 'A stout yellow-bellied marmot whistles from a sunlit rock. It thinks your split is soft.' },
    { text: 'A gray jay swoops onto a spruce branch, eyeing your PB&J.' },
    { text: 'Someone in a puffy vest asks if the gondola goes all the way to Imogene Pass.' },
    { text: 'A hiker yells "Looking strong!" You were definitely walking.' },
    { text: 'You hear distant cowbells. Either an aid station or free-range San Juan cattle.' },
  ];
  return pick(general);
}
