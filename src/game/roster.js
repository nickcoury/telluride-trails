// Telluride Resident Runners Roster + Roll-Your-Own Custom Runner builder.
// Stats are on a 50..99 scale with 80 = strong local baseline (1.0x physics/physiology).

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export const STAT_MIN = 50;
export const STAT_MAX = 99;
export const STAT_BASELINE = 80;
export const CUSTOM_STAT_POOL = 435;
export const UNCAPPED_POOL_THRESHOLD = 445;

export const DEFAULT_KIT = Object.freeze({
  jerseyHex: 0xdd5226,
  shortsHex: 0x1e2530,
  accentHex: 0x38bdf8,
  capHex: 0x1d4e6b,
  brimHex: 0xd95428,
  hairStyle: 'short',
  hairHex: 0x3b2618,
  buildScale: [1.0, 1.0, 1.0],
});

export const RUNNER_KIT_SWATCHES = Object.freeze({
  jersey: Object.freeze([
    { label: 'Terracotta', hex: 0xdd5226 },
    { label: 'Alpine Spruce', hex: 0x1b5e3a },
    { label: 'Team Crimson', hex: 0xdc382c },
    { label: 'Glacial Teal', hex: 0x0d9488 },
    { label: 'Royal Cobalt', hex: 0x1d4ed8 },
    { label: 'Alpine Gold', hex: 0xd97706 },
    { label: 'Violet Dusk', hex: 0x7e22ce },
    { label: 'Slate Charcoal', hex: 0x334155 },
  ]),
  cap: Object.freeze([
    { label: 'Deep Navy', hex: 0x1d4e6b },
    { label: 'Snow White', hex: 0xf3f4f6 },
    { label: 'Sunset Orange', hex: 0xea580c },
    { label: 'Sunburst Gold', hex: 0xeab308 },
    { label: 'Ice Cyan', hex: 0x06b6d4 },
    { label: 'Charcoal', hex: 0x1e293b },
  ]),
  shorts: Object.freeze([
    { label: 'Obsidian', hex: 0x181c22 },
    { label: 'Slate', hex: 0x1e293b },
    { label: 'Granite', hex: 0x292524 },
    { label: 'Midnight', hex: 0x172554 },
  ]),
  hair: Object.freeze([
    { label: 'Espresso', hex: 0x3b2618 },
    { label: 'Chestnut', hex: 0x6b4423 },
    { label: 'Alpine Blonde', hex: 0xc29356 },
    { label: 'Raven', hex: 0x1c1917 },
  ]),
});

export const TELLURIDE_RUNNERS = Object.freeze([
  {
    id: 'willie-milam',
    name: 'Willie Milam',
    aliases: ['Willie'],
    hometown: 'Ophir / Telluride, CO',
    specialty: 'Two-Time Imogene King',
    bio: 'U.S. Olympic Marathon Trials qualifier; back-to-back Imogene Pass Run champ (2:16:49 in 2022, 2:14:19 in 2023), 2× Telluride Mountain Run 24M winner (4:25), Bridal Veil 30K champ.',
    category: 'speed',
    stats: { speed: 98, climbing: 94, technical: 90, endurance: 89, altitude: 95 },
    ovr: 94,
    kit: {
      jerseyHex: 0x1b5e3a,
      shortsHex: 0x181c22,
      accentHex: 0xeab308,
      capHex: 0x1b5e3a,
      brimHex: 0xeab308,
      hairStyle: 'short',
      hairHex: 0x3b2618,
      buildScale: [0.97, 1.01, 0.97],
    },
  },
  {
    id: 'ryan-becker',
    name: 'Ryan Becker',
    aliases: ['Becker'],
    hometown: 'Telluride, CO',
    specialty: 'Team USA Mountain Specialist',
    bio: 'Team USA World Mountain & Trail Championships athlete; TMR 24M champion & CR (3:42:44), 2025 Rundola winner (20:28), Deep Creek Half champ, Speedgoat 50K & Broken Arrow standout.',
    category: 'climbers',
    stats: { speed: 94, climbing: 98, technical: 96, endurance: 91, altitude: 95 },
    ovr: 95,
    kit: {
      jerseyHex: 0xdc382c,
      shortsHex: 0x222933,
      accentHex: 0xf3f4f6,
      capHex: 0xf3f4f6,
      brimHex: 0xdc382c,
      hairStyle: 'short',
      hairHex: 0x4a3520,
      buildScale: [0.98, 1.0, 0.98],
    },
  },
  {
    id: 'lindsay-allison',
    name: 'Lindsay Allison',
    aliases: ['Lindsey Allison', 'Lindsey'],
    hometown: 'Telluride, CO',
    specialty: 'USATF 50K Champ & Rundola Winner',
    bio: "Telluride pro mountain/ultra runner (Altra); USATF Trail 50K National Champion, Rundola women's winner, 5th overall at TMR, Kodiak 100K/100M podium & UTMB CCC racer.",
    category: 'climbers',
    stats: { speed: 90, climbing: 93, technical: 92, endurance: 93, altitude: 94 },
    ovr: 92,
    kit: {
      jerseyHex: 0x0d9488,
      shortsHex: 0x172554,
      accentHex: 0xf97316,
      capHex: 0xf97316,
      brimHex: 0x172554,
      hairStyle: 'ponytail',
      hairHex: 0x6b4423,
      buildScale: [0.92, 0.96, 0.92],
    },
  },
  {
    id: 'anna-frost',
    name: 'Anna Frost ("Frosty")',
    aliases: ['Anna Frost', 'Frosty'],
    hometown: 'Telluride, CO',
    specialty: 'Two-Time Hardrock 100 Champion',
    bio: 'Back-to-back Hardrock 100 champion (2015 & 2016), Bear 100 & Transvulcania winner, longtime Telluride home-base icon.',
    category: 'ultra',
    stats: { speed: 87, climbing: 95, technical: 98, endurance: 97, altitude: 97 },
    ovr: 95,
    kit: {
      jerseyHex: 0x7e22ce,
      shortsHex: 0x18181b,
      accentHex: 0x06b6d4,
      capHex: 0x06b6d4,
      brimHex: 0x7e22ce,
      hairStyle: 'ponytail',
      hairHex: 0xc29356,
      buildScale: [0.92, 0.95, 0.92],
    },
  },
  {
    id: 'nick-coury',
    name: 'Nick Coury',
    aliases: ['Coury'],
    hometown: 'Telluride, CO',
    specialty: '24-Hour American Record & Hardrock Vet',
    bio: "Telluride resident, former Men's 24-Hour American Record holder (173.015 mi), multi-time Hardrock 100 top-10 (7th 2026, 8th 2022), 2026 Rundola overall winner (28:20), master of the negative split.",
    category: 'ultra',
    stats: { speed: 91, climbing: 88, technical: 87, endurance: 99, altitude: 92 },
    ovr: 92,
    kit: {
      jerseyHex: 0xd97706,
      shortsHex: 0x1e293b,
      accentHex: 0xfbbf24,
      capHex: 0x1e3a5f,
      brimHex: 0xd97706,
      hairStyle: 'short',
      hairHex: 0x3b2618,
      buildScale: [0.99, 1.02, 0.99],
    },
  },
  {
    id: 'dakota-jones',
    name: 'Dakota Jones',
    aliases: ['Dakota'],
    hometown: 'Telluride / San Juans',
    specialty: 'Telluride Mountain Run Founder',
    bio: 'Founded TMR ("T-Rad"); 2nd at Hardrock 100 at age 21, Pikes Peak Marathon, Transvulcania & Javelina 100 champ, Footprints Running founder.',
    category: 'ultra',
    stats: { speed: 91, climbing: 94, technical: 97, endurance: 94, altitude: 95 },
    ovr: 94,
    kit: {
      jerseyHex: 0x4d7c0f,
      shortsHex: 0x292524,
      accentHex: 0xb45309,
      capHex: 0xb45309,
      brimHex: 0x292524,
      hairStyle: 'short',
      hairHex: 0x4a3520,
      buildScale: [1.0, 1.01, 1.0],
    },
  },
  {
    id: 'seven-tudor',
    name: 'Seven Tudor',
    aliases: ['Seven'],
    hometown: 'Telluride, CO',
    specialty: 'Rundola Course Record Phenom',
    bio: "Standout young Telluride local who shattered the women's Rundola course record (26:20 in 2025) and crushes steep climbs.",
    category: 'climbers',
    stats: { speed: 92, climbing: 95, technical: 84, endurance: 78, altitude: 92 },
    ovr: 88,
    kit: {
      jerseyHex: 0x991b1b,
      shortsHex: 0x171717,
      accentHex: 0xf8fafc,
      capHex: 0xf8fafc,
      brimHex: 0x991b1b,
      hairStyle: 'ponytail',
      hairHex: 0x3b2618,
      buildScale: [0.91, 0.95, 0.91],
    },
  },
  {
    id: 'lisa-kiesler',
    name: 'Lisa Kiesler',
    aliases: ['Lisa'],
    hometown: 'Telluride, CO',
    specialty: 'Imogene Local Champion',
    bio: "Telluride resident who won the women's Imogene Pass Run (2:40:48), setting the local bar over the 13,114-ft pass.",
    category: 'speed',
    stats: { speed: 88, climbing: 91, technical: 89, endurance: 86, altitude: 92 },
    ovr: 89,
    kit: {
      jerseyHex: 0x1d4ed8,
      shortsHex: 0x1e293b,
      accentHex: 0xeab308,
      capHex: 0xeab308,
      brimHex: 0x1d4ed8,
      hairStyle: 'ponytail',
      hairHex: 0x85582c,
      buildScale: [0.93, 0.96, 0.93],
    },
  },
  {
    id: 'sarah-lavender-smith',
    name: 'Sarah Lavender Smith',
    aliases: ['Sarah Smith'],
    hometown: 'Telluride, CO',
    specialty: '100-Ultra Vet & Trail Author',
    bio: "Telluride-area resident, author of The Trail Runner's Companion, veteran of 100+ ultras (Hardrock 100, Western States, TMR 38M winner, Grand to Grand 170M women's champ).",
    category: 'ultra',
    stats: { speed: 76, climbing: 83, technical: 86, endurance: 96, altitude: 90 },
    ovr: 86,
    kit: {
      jerseyHex: 0x6366f1,
      shortsHex: 0x1e1b4b,
      accentHex: 0xf1f5f9,
      capHex: 0xf1f5f9,
      brimHex: 0x6366f1,
      hairStyle: 'ponytail',
      hairHex: 0x9a7b56,
      buildScale: [0.93, 0.96, 0.93],
    },
  },
  {
    id: 'greg-poettgen',
    name: 'Greg Poettgen',
    aliases: ['Greg'],
    hometown: 'Telluride, CO',
    specialty: 'T-Rad Co-Director & Ridge Grinder',
    bio: "Telluride Mountain Run co-director who marks, sweeps, and grinds the box canyon's ruggedest ridges.",
    category: 'climbers',
    stats: { speed: 80, climbing: 87, technical: 91, endurance: 89, altitude: 91 },
    ovr: 88,
    kit: {
      jerseyHex: 0xea580c,
      shortsHex: 0x334155,
      accentHex: 0x1e293b,
      capHex: 0x1e293b,
      brimHex: 0xea580c,
      hairStyle: 'short',
      hairHex: 0x4a3520,
      buildScale: [1.0, 1.0, 1.0],
    },
  },
  {
    id: 'erich-owen',
    name: 'Erich Owen',
    aliases: ['Erich'],
    hometown: 'Ophir, CO',
    specialty: 'Ophir Pass Workhorse',
    bio: 'High-valley Ophir resident and TMR / Colorado mountain ultra veteran.',
    category: 'ultra',
    stats: { speed: 79, climbing: 86, technical: 87, endurance: 88, altitude: 93 },
    ovr: 87,
    kit: {
      jerseyHex: 0x0369a1,
      shortsHex: 0x1f2937,
      accentHex: 0x3f6212,
      capHex: 0x3f6212,
      brimHex: 0x0369a1,
      hairStyle: 'short',
      hairHex: 0x3b2618,
      buildScale: [1.0, 1.0, 1.0],
    },
  },
]);

export const CUSTOM_ARCHETYPES = Object.freeze([
  {
    id: 'balanced-local',
    label: 'Balanced Local',
    hometown: 'Telluride, CO',
    specialty: 'Box Canyon All-Rounder',
    stats: { speed: 85, climbing: 88, technical: 87, endurance: 87, altitude: 88 },
  },
  {
    id: 'rundola-vert',
    label: 'Rundola Vert',
    aliases: ['gondola-commuter'],
    hometown: 'Telluride, CO',
    specialty: 'Gondola Commuter',
    stats: { speed: 88, climbing: 97, technical: 83, endurance: 77, altitude: 90 },
  },
  {
    id: 'hardrock-diesel',
    label: 'Hardrock Diesel',
    hometown: 'Silverton / Telluride, CO',
    specialty: '48-Hour San Juan Engine',
    stats: { speed: 75, climbing: 88, technical: 89, endurance: 96, altitude: 87 },
  },
  {
    id: 'ophir-talus-goat',
    label: 'Ophir Talus Goat',
    hometown: 'Ophir, CO',
    specialty: 'Scree & Ridge Scrambler',
    stats: { speed: 80, climbing: 92, technical: 96, endurance: 81, altitude: 86 },
  },
  {
    id: 'ski-patroller',
    label: 'Ski Patroller Off-Season',
    hometown: 'Mountain Village, CO',
    specialty: 'Bootpack Vert Machine',
    stats: { speed: 82, climbing: 93, technical: 94, endurance: 78, altitude: 88 },
  },
  {
    id: 'seven-summits',
    label: '7-Summits Linkup Fiend',
    hometown: 'Telluride, CO',
    specialty: 'Dawn-to-Dusk Peak Bagger',
    stats: { speed: 79, climbing: 91, technical: 88, endurance: 89, altitude: 88 },
  },
  {
    id: 'flatlander-tourist',
    label: 'Flatlander Tourist',
    hometown: 'Sea Level, USA',
    specialty: 'Hard Mode (Just Arrived Yesterday)',
    stats: { speed: 86, climbing: 66, technical: 62, endurance: 75, altitude: 56 },
  },
]);

const RANDOM_FIRST_NAMES = [
  'Aspen', 'Bridal', 'Canyon', 'Cortez', 'Dallas', 'Dolores', 'Gold', 'Imogene',
  'Ingram', 'Jud', 'Kendall', 'Lizard', 'Marshall', 'Ophir', 'Pandora', 'Red',
  'Ridge', 'San Juan', 'See', 'Sneffels', 'Tomboy', 'Wasatch', 'Wilson',
];
const RANDOM_LAST_NAMES = [
  'Grinder', 'Strider', 'Climber', 'Local', 'Scrambler', 'Pacer', 'Chaser',
  'Goat', 'Diesel', 'Crusher', 'Runner', 'Hiker', 'Trekker', 'Ridge',
];

function parseHexColor(val, fallback) {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return (val >>> 0) & 0xffffff;
  }
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/^#|^0x/i, '');
    if (/^[0-9a-f]{6}$/i.test(cleaned)) {
      return parseInt(cleaned, 16);
    }
  }
  return fallback;
}

export function sanitizeStats(raw = {}) {
  return {
    speed: Math.round(clamp(Number(raw.speed ?? STAT_BASELINE) || STAT_BASELINE, STAT_MIN, STAT_MAX)),
    climbing: Math.round(clamp(Number(raw.climbing ?? STAT_BASELINE) || STAT_BASELINE, STAT_MIN, STAT_MAX)),
    technical: Math.round(clamp(Number(raw.technical ?? STAT_BASELINE) || STAT_BASELINE, STAT_MIN, STAT_MAX)),
    endurance: Math.round(clamp(Number(raw.endurance ?? STAT_BASELINE) || STAT_BASELINE, STAT_MIN, STAT_MAX)),
    altitude: Math.round(clamp(Number(raw.altitude ?? STAT_BASELINE) || STAT_BASELINE, STAT_MIN, STAT_MAX)),
  };
}

export function statPoolTotal(stats) {
  const s = sanitizeStats(stats);
  return s.speed + s.climbing + s.technical + s.endurance + s.altitude;
}

export function computeOvr(stats) {
  const s = sanitizeStats(stats);
  return Math.round(
    s.speed * 0.20 +
    s.climbing * 0.23 +
    s.technical * 0.19 +
    s.endurance * 0.22 +
    s.altitude * 0.16
  );
}

export function isUncappedCustom(profile) {
  if (!profile) return false;
  const isCustom = Boolean(profile.isCustom || profile.id === 'custom');
  if (!isCustom) return false;
  if (profile.uncapped || profile.statUncapped) return true;
  return statPoolTotal(profile.stats) > UNCAPPED_POOL_THRESHOLD;
}

export function sanitizeKit(raw = {}) {
  const hairStyle = raw.hairStyle === 'ponytail' ? 'ponytail' : 'short';
  const rawScale = Array.isArray(raw.buildScale) && raw.buildScale.length === 3 ? raw.buildScale : null;
  const buildScale = rawScale
    ? [
      clamp(Number(rawScale[0]) || 1, 0.85, 1.12),
      clamp(Number(rawScale[1]) || 1, 0.88, 1.12),
      clamp(Number(rawScale[2]) || 1, 0.85, 1.12),
    ]
    : (hairStyle === 'ponytail' ? [0.93, 0.96, 0.93] : [1.0, 1.0, 1.0]);

  return {
    jerseyHex: parseHexColor(raw.jerseyHex ?? raw.jersey, DEFAULT_KIT.jerseyHex),
    shortsHex: parseHexColor(raw.shortsHex ?? raw.shorts, DEFAULT_KIT.shortsHex),
    accentHex: parseHexColor(raw.accentHex ?? raw.accent, DEFAULT_KIT.accentHex),
    capHex: parseHexColor(raw.capHex ?? raw.cap, DEFAULT_KIT.capHex),
    brimHex: parseHexColor(raw.brimHex ?? raw.brim, DEFAULT_KIT.brimHex),
    hairStyle,
    hairHex: parseHexColor(raw.hairHex ?? raw.hair, DEFAULT_KIT.hairHex),
    buildScale,
  };
}

export function findPresetRunner(id) {
  if (!id || typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  return TELLURIDE_RUNNERS.find((r) => r.id === key) || null;
}

/**
 * Normalize a preset ID, preset object, or custom runner payload into a full runner profile.
 */
export function normalizeRunnerSelection(sel) {
  if (typeof sel === 'string') {
    const preset = findPresetRunner(sel);
    if (preset) {
      return {
        ...preset,
        aliases: preset.aliases ? [...preset.aliases] : [],
        stats: { ...preset.stats },
        kit: sanitizeKit(preset.kit),
        isCustom: false,
        uncapped: false,
        statUncapped: false,
      };
    }
  }

  if (sel && typeof sel === 'object') {
    const isCustom = Boolean(sel.isCustom || sel.id === 'custom');
    if (!isCustom && typeof sel.id === 'string') {
      const preset = findPresetRunner(sel.id);
      if (preset) {
        return {
          ...preset,
          aliases: preset.aliases ? [...preset.aliases] : [],
          stats: { ...preset.stats },
          kit: sanitizeKit(preset.kit),
          isCustom: false,
          uncapped: false,
          statUncapped: false,
        };
      }
    }

    if (isCustom || sel.stats || sel.name) {
      const name = (typeof sel.name === 'string' ? sel.name.trim() : '').slice(0, 28) || 'Box Canyon Local';
      const hometown = (typeof sel.hometown === 'string' ? sel.hometown.trim() : '').slice(0, 28) || 'Telluride, CO';
      const specialty = (typeof sel.specialty === 'string' ? sel.specialty.trim() : '').slice(0, 48) || 'Custom San Juan Runner';
      const stats = sanitizeStats(sel.stats);
      const kit = sanitizeKit(sel.kit);
      const ovr = computeOvr(stats);
      const totalPts = statPoolTotal(stats);
      const uncapped = Boolean(sel.uncapped || sel.statUncapped || totalPts > UNCAPPED_POOL_THRESHOLD);
      return {
        id: 'custom',
        name,
        aliases: [],
        hometown,
        specialty,
        bio: sel.bio || `Custom runner (${totalPts} stat pts).`,
        category: 'custom',
        stats,
        ovr,
        kit,
        isCustom: true,
        uncapped,
        statUncapped: uncapped,
      };
    }
  }

  // Fallback to Telluride default preset
  return normalizeRunnerSelection(TELLURIDE_RUNNERS[0].id);
}

/**
 * Roll a randomized Telluride custom runner (optionally seeded by an archetype ID).
 */
export function rollRandomCustomRunner(archetypeId = null, rng = Math.random) {
  let arch = null;
  if (typeof archetypeId === 'string' && archetypeId.trim()) {
    const key = archetypeId.trim().toLowerCase();
    arch = CUSTOM_ARCHETYPES.find(
      (a) => a.id === key || (Array.isArray(a.aliases) && a.aliases.includes(key))
    ) || null;
  }
  if (!arch) {
    arch = CUSTOM_ARCHETYPES[Math.floor(rng() * CUSTOM_ARCHETYPES.length)];
  }

  // Apply gentle ±3 jitter while staying within balanced pool (or archetype's own budget if lower)
  const keys = ['speed', 'climbing', 'technical', 'endurance', 'altitude'];
  const baseTotal = statPoolTotal(arch.stats);
  const targetPool = Math.min(CUSTOM_STAT_POOL, baseTotal);
  const stats = { ...arch.stats };
  for (let i = 0; i < keys.length; i++) {
    const jitter = Math.round((rng() * 2 - 1) * 3);
    stats[keys[i]] = clamp(stats[keys[i]] + jitter, STAT_MIN, STAT_MAX);
  }
  // Rebalance to targetPool cleanly
  let diff = targetPool - statPoolTotal(stats);
  let guard = 0;
  while (diff !== 0 && guard++ < 60) {
    const k = keys[Math.floor(rng() * keys.length)];
    if (diff > 0 && stats[k] < STAT_MAX) {
      stats[k]++;
      diff--;
    } else if (diff < 0 && stats[k] > STAT_MIN) {
      stats[k]--;
      diff++;
    }
  }

  const jSw = RUNNER_KIT_SWATCHES.jersey[Math.floor(rng() * RUNNER_KIT_SWATCHES.jersey.length)];
  const cSw = RUNNER_KIT_SWATCHES.cap[Math.floor(rng() * RUNNER_KIT_SWATCHES.cap.length)];
  const sSw = RUNNER_KIT_SWATCHES.shorts[Math.floor(rng() * RUNNER_KIT_SWATCHES.shorts.length)];
  const hSw = RUNNER_KIT_SWATCHES.hair[Math.floor(rng() * RUNNER_KIT_SWATCHES.hair.length)];
  const hairStyle = rng() < 0.45 ? 'ponytail' : 'short';
  const first = RANDOM_FIRST_NAMES[Math.floor(rng() * RANDOM_FIRST_NAMES.length)];
  const last = RANDOM_LAST_NAMES[Math.floor(rng() * RANDOM_LAST_NAMES.length)];

  return normalizeRunnerSelection({
    id: 'custom',
    isCustom: true,
    name: archetypeId ? arch.label : `${first} ${last}`,
    hometown: arch.hometown,
    specialty: arch.specialty,
    stats,
    uncapped: false,
    kit: {
      jerseyHex: jSw.hex,
      shortsHex: sSw.hex,
      accentHex: cSw.hex,
      capHex: cSw.hex,
      brimHex: jSw.hex,
      hairStyle,
      hairHex: hSw.hex,
      buildScale: hairStyle === 'ponytail' ? [0.93, 0.96, 0.93] : [0.99, 1.0, 0.99],
    },
  });
}
