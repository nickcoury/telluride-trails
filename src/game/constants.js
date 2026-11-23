// Core constants, unit conversions, surface modifiers, aid menu, and achievements
// for Telluride Trails.

export const M_TO_FT = 3.28084;
export const FT_TO_M = 0.3048;
export const MILE_M = 1609.344;
export const KM_M = 1000;

// Altitude physiology thresholds (Telluride town ~8,750 ft, Imogene ~13,114 ft, Sneffels ~14,150 ft)
export const ALT_PENALTY_START_FT = 11000;
export const ALT_PENALTY_START_M = ALT_PENALTY_START_FT * FT_TO_M; // ~3352.8 m
export const ALT_SEVERE_FT = 13200;

// Slope / cliff limits
// ~42 deg slope = tan(42 deg) ~ 0.90 grade (unclimbable off-trail rock cliff / scree wall)
export const CLIFF_GRADE = 0.90;
// ~53.5 deg slope = 1.35 grade allowed on mapped trails/paths or official race lines (e.g. Original Rundola)
export const TRAIL_CLIFF_GRADE = 1.35;
export const POWER_HIKE_GRADE = 0.13; // >13% uphill -> hands-on-knees power hike

// Trail keeping radii (meters)
export const TRAIL_SNAP_RADIUS_M = {
  road: 7.0,
  track: 6.0,
  trail: 4.5,
  path: 4.0,
};

// Surface movement multipliers and technical stumble factors
export const SURFACES = {
  road:   { label: 'Dirt / Town Road', speedMul: 1.06, staminaMul: 0.92, stumbleMul: 0.4, dustColor: 0xb8a389 },
  track:  { label: '4x4 Jeep Road',    speedMul: 0.98, staminaMul: 1.00, stumbleMul: 0.9, dustColor: 0xa68e74 },
  trail:  { label: 'Singletrack',      speedMul: 1.00, staminaMul: 1.00, stumbleMul: 1.0, dustColor: 0x9b8265 },
  path:   { label: 'Alpine Path',      speedMul: 0.95, staminaMul: 1.04, stumbleMul: 1.2, dustColor: 0x998877 },
  grass:  { label: 'Alpine Tundra',    speedMul: 0.78, staminaMul: 1.28, stumbleMul: 1.4, dustColor: 0x7d8a55, offTrail: true },
  forest: { label: 'Forest / Bushwhack', speedMul: 0.66, staminaMul: 1.45, stumbleMul: 1.9, dustColor: 0x5c5340, offTrail: true },
  scree:  { label: 'Loose Scree',      speedMul: 0.68, staminaMul: 1.40, stumbleMul: 2.4, dustColor: 0x8f8b85 },
  talus:  { label: 'Talus / Boulders', speedMul: 0.52, staminaMul: 1.65, stumbleMul: 3.2, dustColor: 0x7d7a75 },
  snow:   { label: 'Snowfield',        speedMul: 0.70, staminaMul: 1.42, stumbleMul: 1.8, dustColor: 0xdde8f2 },
  creek:  { label: 'Creek Crossing',   speedMul: 0.56, staminaMul: 1.35, stumbleMul: 2.0, dustColor: 0x99c4d6 },
};

// Aid station menu (ultratrail classics + San Juan flavor)
export const FOODS = {
  water:      { name: 'Cold Water',       kcal: 0,   ml: 220, na: 0,   caf: 0,   bulk: 0,   drink: true },
  electro:    { name: 'Tailwind / Electro', kcal: 50, ml: 220, na: 220, caf: 0,  bulk: 0,   drink: true },
  cola:       { name: 'Flat Coke',        kcal: 75,  ml: 180, na: 10,  caf: 18,  bulk: 0,   drink: true },
  broth:      { name: 'Hot Miso Broth',   kcal: 20,  ml: 220, na: 520, caf: 0,  bulk: 0,   drink: true, night: true },
  coffee:     { name: 'Camp Coffee',      kcal: 5,   ml: 150, na: 0,   caf: 100, bulk: 0,   drink: true, night: true },
  watermelon: { name: 'Watermelon',       kcal: 45,  ml: 90,  na: 5,   caf: 0,  bulk: 45 },
  banana:     { name: 'Banana',           kcal: 105, ml: 0,   na: 2,   caf: 0,  bulk: 95 },
  gel:        { name: 'Alpine Gel',       kcal: 100, ml: 0,   na: 70,  caf: 25, bulk: 30 },
  potato:     { name: 'Salted Potato',    kcal: 65,  ml: 0,   na: 310, caf: 0,  bulk: 55 },
  pbj:        { name: 'PB&J Quarter',     kcal: 110, ml: 0,   na: 90,  caf: 0,  bulk: 80 },
  quesadilla: { name: 'Cheese Quesadilla',kcal: 240, ml: 0,   na: 440, caf: 0,  bulk: 190 },
  pickle:     { name: 'Pickle Spear',     kcal: 5,   ml: 25,  na: 460, caf: 0,  bulk: 20 },
  gummies:    { name: 'Ginger Chews',     kcal: 80,  ml: 0,   na: 15,  caf: 0,  bulk: 25 },
  bacon:      { name: 'Aid Station Bacon',kcal: 140, ml: 0,   na: 380, caf: 0,  bulk: 90 },
};

export const ACHIEVEMENTS = {
  first_mile:   { id: 'first_mile',   title: 'Warming Up',            desc: 'Logged your first mile in the San Juans.' },
  ten_k:        { id: 'ten_k',        title: 'Box Canyon Strider',    desc: 'Covered 10 km on foot.' },
  marathon:     { id: 'marathon',     title: 'Still Just Warming Up', desc: 'Covered 26.2 miles in one run.' },
  fifty_mi:     { id: 'fifty_mi',     title: 'Ultrarunner',           desc: 'Covered 50 miles. Your toenails are reconsidering.' },
  hundred_mi:   { id: 'hundred_mi',   title: 'Centurion',             desc: '100 miles on foot. Mostly vertical.' },
  summit_13k:   { id: 'summit_13k',   title: 'Thin Air Club',         desc: 'Climbed above 13,000 ft.' },
  summit_14k:   { id: 'summit_14k',   title: 'Fourteener',            desc: 'Reached 14,000+ ft under your own power.' },
  kiss_rock:    { id: 'kiss_rock',    title: 'Kissed the Rock',       desc: 'Finished Hardrock 100 and kissed the Hardrock.' },
  monsoon:      { id: 'monsoon',      title: 'Static Haircut',        desc: 'Caught above treeline in an afternoon San Juan monsoon.' },
  night_owl:    { id: 'night_owl',    title: 'Headlamp Warrior',      desc: 'Kept moving between midnight and 4 AM.' },
  lnt_scold:    { id: 'lnt_scold',    title: 'Tundra Stomper',        desc: 'Received 3 Leave No Trace warnings. Stay on the trail!' },
  pika_fan:     { id: 'pika_fan',     title: 'EEEP!',                 desc: 'Spotted a pika on high-alpine talus.' },
  goat_club:    { id: 'goat_club',    title: 'Mountain Goat',         desc: 'Shared a high ridge with San Juan mountain goats.' },
  moose_zone:   { id: 'moose_zone',   title: 'Willow Diplomacy',      desc: 'Encountered a moose in the creek willows.' },
  chair_sitter: { id: 'chair_sitter', title: 'Chair Sitter',          desc: 'Left a real-time run paused for over an hour while the clock kept ticking.' },
  time_lord:    { id: 'time_lord',    title: 'Asterisk Earned*',      desc: 'Used Time Dilation. We saw that.' },
};
