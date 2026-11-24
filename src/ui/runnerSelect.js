/**
 * Telluride Resident Runners & Custom Runner ("Roll Your Own") Modal Selector (#183).
 *
 * Consumes `game.getRoster()`, `game.getActiveRunner()`, `game.setRunner(sel)`,
 * `game.rollCustomRunner(archetypeId?)`, and `'game:runnerChanged'`, with built-in
 * fallback presets/swatches so UI stays resilient in isolation.
 */

const BALANCED_POOL_CAP = 435;
const STAT_MIN = 50;
const STAT_MAX = 99;

const STAT_DEFS = [
  { key: 'speed', short: 'SPD', label: 'Speed', hint: 'Flat & runnable singletrack pace' },
  { key: 'climbing', short: 'CLB', label: 'Climbing', hint: 'Power-hike speed & grade economy' },
  { key: 'technical', short: 'TEC', label: 'Technical', hint: 'Talus/scree footing & downhill quads' },
  { key: 'endurance', short: 'END', label: 'Endurance', hint: 'Glycogen tank, fueling & leg durability' },
  { key: 'altitude', short: 'ALT', label: 'Altitude', hint: 'Thin-air efficiency above 11,000 ft' },
];

const FALLBACK_JERSEY_SWATCHES = [
  { label: 'San Juan Pine', hex: 0x1b5e3a },
  { label: 'Telluride Red', hex: 0xdc382c },
  { label: 'Alpine Teal', hex: 0x0d9488 },
  { label: 'Hardrock Violet', hex: 0x7e22ce },
  { label: 'Alpenglow Ochre', hex: 0xd97706 },
  { label: 'Columbine Blue', hex: 0x1d4ed8 },
  { label: 'Tundra Olive', hex: 0x4d7c0f },
  { label: 'Canyon Coral', hex: 0xea580c },
];

const FALLBACK_CAP_SWATCHES = [
  { label: 'Summit Gold', hex: 0xeab308 },
  { label: 'Snow Crest', hex: 0xf3f4f6 },
  { label: 'Indian Paintbrush', hex: 0xf97316 },
  { label: 'Ice Lake Cyan', hex: 0x06b6d4 },
  { label: 'Midnight Slate', hex: 0x1e293b },
  { label: 'Forest Spruce', hex: 0x1b5e3a },
];

const QUICK_ARCHETYPES = [
  {
    id: 'balanced-local',
    label: 'Balanced Local',
    tag: 'Telluride, CO',
    stats: { speed: 85, climbing: 88, technical: 87, endurance: 87, altitude: 88 },
  },
  {
    id: 'rundola-vert',
    aliases: ['gondola-commuter'],
    label: 'Rundola Vert',
    tag: 'Oak St Gondola Base',
    stats: { speed: 82, climbing: 97, technical: 84, endurance: 80, altitude: 92 },
  },
  {
    id: 'hardrock-diesel',
    label: 'Hardrock Diesel',
    tag: 'San Juan High Route',
    stats: { speed: 76, climbing: 90, technical: 90, endurance: 96, altitude: 93 }, // 445 -> clamp 435 below
  },
  {
    id: 'flatlander-tourist',
    label: 'Flatlander Tourist',
    tag: 'Sea Level (Just Arrived)',
    stats: { speed: 84, climbing: 62, technical: 58, endurance: 68, altitude: 52 },
  },
];
// Keep Hardrock Diesel quick chip right on the 435-pt purist cap!
QUICK_ARCHETYPES[2].stats = { speed: 74, climbing: 89, technical: 88, endurance: 94, altitude: 90 };

const FALLBACK_PRESETS = [
  {
    id: 'ryan-becker',
    name: 'Ryan Becker',
    hometown: 'Telluride, CO',
    specialty: 'Team USA Mountain Specialist',
    category: 'climbers',
    bio: 'Team USA World Mountain & Trail Championships athlete; TMR 24M CR (3:42:44), 2025 Rundola winner (20:28), Deep Creek Half champ.',
    stats: { speed: 94, climbing: 98, technical: 96, endurance: 91, altitude: 95 },
    ovr: 95,
    kit: { jerseyHex: 0xdc382c, shortsHex: 0x222933, accentHex: 0xf3f4f6, capHex: 0xf3f4f6, brimHex: 0xdc382c, hairStyle: 'short' },
  },
  {
    id: 'anna-frost',
    name: 'Anna Frost ("Frosty")',
    aliases: ['Frosty'],
    hometown: 'Telluride, CO',
    specialty: 'Two-Time Hardrock 100 Champion',
    category: 'ultra',
    bio: 'Back-to-back Hardrock 100 champion (2015 & 2016), Bear 100 & Transvulcania winner, longtime Telluride home-base icon.',
    stats: { speed: 87, climbing: 95, technical: 98, endurance: 97, altitude: 97 },
    ovr: 95,
    kit: { jerseyHex: 0x7e22ce, shortsHex: 0x18181b, accentHex: 0x06b6d4, capHex: 0x06b6d4, brimHex: 0x7e22ce, hairStyle: 'ponytail' },
  },
  {
    id: 'willie-milam',
    name: 'Willie Milam',
    hometown: 'Ophir / Telluride, CO',
    specialty: 'Two-Time Imogene King',
    category: 'speed',
    bio: 'U.S. Olympic Marathon Trials qualifier; back-to-back Imogene Pass Run champ (2:14:19), 2× TMR 24M winner, Bridal Veil 30K champ.',
    stats: { speed: 98, climbing: 94, technical: 90, endurance: 89, altitude: 95 },
    ovr: 94,
    kit: { jerseyHex: 0x1b5e3a, shortsHex: 0x181c22, accentHex: 0xeab308, capHex: 0x1b5e3a, brimHex: 0xeab308, hairStyle: 'short' },
  },
  {
    id: 'dakota-jones',
    name: 'Dakota Jones',
    hometown: 'Telluride / San Juans',
    specialty: 'Telluride Mountain Run Founder',
    category: 'ultra',
    bio: 'Founded TMR ("T-Rad"); 2nd at Hardrock 100 at age 21, Pikes Peak Marathon, Transvulcania & Javelina 100 champ.',
    stats: { speed: 91, climbing: 94, technical: 97, endurance: 94, altitude: 95 },
    ovr: 94,
    kit: { jerseyHex: 0x4d7c0f, shortsHex: 0x292524, accentHex: 0xb45309, capHex: 0xb45309, brimHex: 0x292524, hairStyle: 'short' },
  },
  {
    id: 'lindsay-allison',
    name: 'Lindsay Allison',
    aliases: ['Lindsey Allison'],
    hometown: 'Telluride, CO',
    specialty: 'USATF 50K Champ & Rundola Winner',
    category: 'climbers',
    bio: 'Telluride pro mountain/ultra runner; USATF Trail 50K National Champion, Rundola women’s winner, Kodiak 100K/100M podium.',
    stats: { speed: 90, climbing: 93, technical: 92, endurance: 93, altitude: 94 },
    ovr: 92,
    kit: { jerseyHex: 0x0d9488, shortsHex: 0x172554, accentHex: 0xf97316, capHex: 0xf97316, brimHex: 0x172554, hairStyle: 'ponytail' },
  },
  {
    id: 'nick-coury',
    name: 'Nick Coury',
    hometown: 'Telluride, CO',
    specialty: '24-Hour American Record & Hardrock Vet',
    category: 'ultra',
    bio: 'Telluride resident, former Men’s 24-Hour American Record holder (173.015 mi), multi-time Hardrock 100 top-10, 2026 Rundola winner.',
    stats: { speed: 91, climbing: 88, technical: 87, endurance: 99, altitude: 92 },
    ovr: 92,
    kit: { jerseyHex: 0xd97706, shortsHex: 0x1e293b, accentHex: 0xfbbf24, capHex: 0x1e3a5f, brimHex: 0xd97706, hairStyle: 'short' },
  },
  {
    id: 'seven-tudor',
    name: 'Seven Tudor',
    hometown: 'Telluride, CO',
    specialty: 'Rundola Course Record Phenom',
    category: 'climbers',
    bio: 'Standout Telluride local mountain runner and vertical specialist up the steep box-canyon climbs.',
    stats: { speed: 92, climbing: 96, technical: 89, endurance: 84, altitude: 93 },
    ovr: 91,
    kit: { jerseyHex: 0x2563eb, shortsHex: 0x0f172a, accentHex: 0x38bdf8, capHex: 0x0f172a, brimHex: 0x38bdf8, hairStyle: 'short' },
  },
  {
    id: 'lisa-kiesler',
    name: 'Lisa Kiesler',
    aliases: ['Lisa'],
    hometown: 'Telluride, CO',
    specialty: 'Imogene Local Champion',
    category: 'speed',
    bio: "Telluride resident who won the women's Imogene Pass Run (2:40:48), setting the local bar over the 13,114-ft pass.",
    stats: { speed: 88, climbing: 91, technical: 89, endurance: 86, altitude: 92 },
    ovr: 89,
    kit: { jerseyHex: 0x1d4ed8, shortsHex: 0x1e293b, accentHex: 0xeab308, capHex: 0xeab308, brimHex: 0x1d4ed8, hairStyle: 'ponytail' },
  },
  {
    id: 'sarah-lavender-smith',
    name: 'Sarah Lavender Smith',
    hometown: 'Telluride, CO',
    specialty: '100-Ultra Vet & Trail Author',
    category: 'ultra',
    bio: 'Telluride-area resident, author of The Trail Runner’s Companion, veteran of 100+ ultras including Hardrock 100 & TMR 38M winner.',
    stats: { speed: 76, climbing: 83, technical: 86, endurance: 96, altitude: 90 },
    ovr: 86,
    kit: { jerseyHex: 0x6366f1, shortsHex: 0x1e1b4b, accentHex: 0xf1f5f9, capHex: 0xf1f5f9, brimHex: 0x6366f1, hairStyle: 'ponytail' },
  },
  {
    id: 'greg-poettgen',
    name: 'Greg Poettgen',
    hometown: 'Telluride, CO',
    specialty: 'T-Rad Co-Director & Ridge Grinder',
    category: 'climbers',
    bio: 'Telluride Mountain Run co-director who marks, sweeps, and grinds the box canyon’s ruggedest high ridges.',
    stats: { speed: 80, climbing: 87, technical: 91, endurance: 89, altitude: 91 },
    ovr: 88,
    kit: { jerseyHex: 0xea580c, shortsHex: 0x334155, accentHex: 0x1e293b, capHex: 0x1e293b, brimHex: 0xea580c, hairStyle: 'short' },
  },
  {
    id: 'erich-owen',
    name: 'Erich Owen',
    hometown: 'Ophir, CO',
    specialty: 'Ophir Pass Workhorse',
    category: 'ultra',
    bio: 'High-valley Ophir resident and Telluride Mountain Run / Colorado mountain ultra veteran.',
    stats: { speed: 79, climbing: 86, technical: 87, endurance: 88, altitude: 93 },
    ovr: 87,
    kit: { jerseyHex: 0x0369a1, shortsHex: 0x1f2937, accentHex: 0x3f6212, capHex: 0x3f6212, brimHex: 0x0369a1, hairStyle: 'short' },
  },
];

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toCssHex(val, fallback = '#f4b942') {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return `#${(val & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  if (typeof val === 'string' && val.trim()) {
    const s = val.trim();
    if (s.startsWith('#')) return s;
    if (/^0x[0-9a-f]+$/i.test(s)) {
      return `#${(parseInt(s, 16) & 0xffffff).toString(16).padStart(6, '0')}`;
    }
  }
  return fallback;
}

export function toNumHex(val, fallback = 0xdc382c) {
  if (typeof val === 'number' && Number.isFinite(val)) return val & 0xffffff;
  if (typeof val === 'string') {
    const clean = val.trim().replace(/^#|^0x/i, '');
    const n = parseInt(clean, 16);
    if (Number.isFinite(n)) return n & 0xffffff;
  }
  return fallback;
}

export function calcOvr(stats) {
  if (!stats) return 80;
  const s = Number(stats.speed) || 80;
  const c = Number(stats.climbing) || 80;
  const t = Number(stats.technical) || 80;
  const e = Number(stats.endurance) || 80;
  const a = Number(stats.altitude) || 80;
  return Math.round(s * 0.2 + c * 0.23 + t * 0.19 + e * 0.22 + a * 0.16);
}

export function fmtRunnerShortName(name = 'Runner') {
  const nickMatch = String(name).match(/\("([^"]+)"\)/);
  if (nickMatch) return nickMatch[1];
  const clean = String(name).replace(/\s*\([^)]*\)/g, '').trim();
  if (clean.length <= 8) return clean;
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) {
    const first = parts[0];
    const initials = parts
      .slice(1)
      .map((p) => `${p[0]}.`)
      .join('');
    const cand = `${first} ${initials}`;
    if (cand.length <= 12) return cand;
  }
  return `${clean.slice(0, 10)}…`;
}

export function getActiveRunnerSummary(game) {
  const r = typeof game?.getActiveRunner === 'function' ? game.getActiveRunner() : null;
  if (r && r.name) {
    const ovr = Number.isFinite(r.ovr) ? r.ovr : calcOvr(r.stats);
    return {
      id: r.id || 'custom',
      name: r.name,
      shortName: fmtRunnerShortName(r.name),
      hometown: r.hometown || 'Telluride, CO',
      ovr,
      isCustom: Boolean(r.isCustom || r.id === 'custom'),
      statUncapped: Boolean(r.statUncapped),
      jerseyCss: toCssHex(r.kit?.jerseyHex, '#dc382c'),
      capCss: toCssHex(r.kit?.capHex ?? r.kit?.accentHex, '#eab308'),
    };
  }
  return {
    id: 'willie-milam',
    name: 'Willie Milam',
    shortName: 'Willie M.',
    hometown: 'Ophir / Telluride, CO',
    ovr: 94,
    isCustom: false,
    statUncapped: false,
    jerseyCss: '#1b5e3a',
    capCss: '#eab308',
  };
}

export function createRunnerSelect({ container, engine, game, onRunnerChanged, onShowToast }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'tt-dialog tt-dialog--runner';
  dlg.setAttribute('aria-labelledby', 'runner-dlg-title');
  dlg.setAttribute('closedby', 'any');

  dlg.innerHTML = `
    <div class="tt-dialog__head">
      <h2 id="runner-dlg-title">Choose Your Runner</h2>
      <button type="button" class="tt-dialog__close" data-runner-close aria-label="Close runner selector">✕</button>
    </div>

    <div class="runner-tabs" role="tablist" aria-label="Runner mode">
      <button type="button" class="runner-tab is-active" role="tab" aria-selected="true" aria-controls="runner-pane-locals" id="rtab-locals" data-rtab="locals">
        🏔 Telluride Locals
      </button>
      <button type="button" class="runner-tab" role="tab" aria-selected="false" aria-controls="runner-pane-custom" id="rtab-custom" data-rtab="custom">
        🎲 Custom Runner
      </button>
    </div>

    <div class="tt-dialog__body runner-dlg-body">
      <!-- TAB 1: TELLURIDE LOCALS -->
      <section id="runner-pane-locals" class="runner-pane" role="tabpanel" aria-labelledby="rtab-locals">
        <div class="runner-toolbar">
          <div class="runner-cat-chips" role="group" aria-label="Filter by specialty">
            <button type="button" class="chip is-active" data-rcat="all">All</button>
            <button type="button" class="chip" data-rcat="climbers">Climbers</button>
            <button type="button" class="chip" data-rcat="ultra">Ultra/100M</button>
            <button type="button" class="chip" data-rcat="speed">Speed</button>
          </div>
          <label for="runner-search" class="visually-hidden">Search runners</label>
          <input id="runner-search" class="runner-search-input" type="search" placeholder="Search name, Ophir, Hardrock, Lindsey…" autocomplete="off" />
        </div>
        <div class="runner-cards" data-runner-list></div>
      </section>

      <!-- TAB 2: CUSTOM RUNNER -->
      <section id="runner-pane-custom" class="runner-pane" role="tabpanel" aria-labelledby="rtab-custom" hidden>
        <div class="custom-top-grid">
          <div class="tt-field-group">
            <label class="tt-field-label" for="cust-name">Runner Name</label>
            <input id="cust-name" class="runner-text-input" type="text" maxlength="28" value="Box Canyon Local" autocomplete="off" />
          </div>
          <div class="tt-field-group">
            <label class="tt-field-label" for="cust-home">Hometown / Tag</label>
            <input id="cust-home" class="runner-text-input" type="text" maxlength="32" value="Telluride, CO" autocomplete="off" />
          </div>
        </div>

        <div class="custom-roll-bar">
          <button type="button" class="btn btn--secondary btn--sm" data-custom-act="roll">🎲 Roll Random Build</button>
          <div class="custom-arch-chips" role="group" aria-label="Quick archetypes">
            ${QUICK_ARCHETYPES.map((a) => `<button type="button" class="chip" data-arch="${a.id}">${escapeHtml(a.label)}</button>`).join('')}
          </div>
        </div>

        <div class="custom-stats-head">
          <div class="custom-ovr-pill">OVR <strong data-cust-ovr>87</strong></div>
          <div class="custom-pool-badge" data-cust-pool>Pool Remaining: 0 pts</div>
          <label class="custom-uncap-toggle">
            <input id="cust-uncapped" type="checkbox" />
            <span>Uncapped (*)</span>
          </label>
        </div>
        <p class="custom-uncap-warn" data-cust-warn hidden>
          ⚠️ Uncapped custom stats (&gt;${BALANCED_POOL_CAP} pts) stamp an asterisk (<code>*</code>) on race results &amp; PBs.
        </p>

        <div class="custom-sliders">
          ${STAT_DEFS.map(
            (st) => `
            <div class="custom-stat-row">
              <label class="custom-stat-label" for="cust-stat-${st.key}" title="${escapeHtml(st.hint)}">
                <strong>${st.short}</strong> <span>${st.label}</span>
              </label>
              <input id="cust-stat-${st.key}" class="tt-range custom-stat-range" type="range" min="${STAT_MIN}" max="${STAT_MAX}" step="1" value="85" data-stat-key="${st.key}" />
              <output class="custom-stat-val" for="cust-stat-${st.key}" data-stat-val="${st.key}">85</output>
            </div>
          `
          ).join('')}
        </div>

        <div class="custom-kit-box">
          <div class="tt-field-group">
            <span class="tt-field-label">Jersey Color</span>
            <div class="swatch-row" data-swatch-group="jersey" role="radiogroup" aria-label="Jersey color"></div>
          </div>
          <div class="tt-field-group">
            <span class="tt-field-label">Cap &amp; Vest Accent</span>
            <div class="swatch-row" data-swatch-group="cap" role="radiogroup" aria-label="Cap and accent color"></div>
          </div>
          <div class="tt-field-group">
            <span class="tt-field-label">Hair &amp; Headwear</span>
            <div class="seg-group" role="group" aria-label="Hair style">
              <button type="button" class="seg-btn is-active" data-hair="short">Short + Cap</button>
              <button type="button" class="seg-btn" data-hair="ponytail">Ponytail + Cap</button>
            </div>
          </div>
        </div>

        <button type="button" class="btn btn--primary custom-confirm-btn" data-custom-act="apply">
          Run as Box Canyon Local →
        </button>
      </section>
    </div>
  `;

  container.appendChild(dlg);

  // Prevent Escape from bubbling to window gameplay pause handler
  dlg.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') e.stopPropagation();
    },
    true
  );

  const listEl = dlg.querySelector('[data-runner-list]');
  const searchInput = dlg.querySelector('#runner-search');
  const localsPane = dlg.querySelector('#runner-pane-locals');
  const customPane = dlg.querySelector('#runner-pane-custom');

  const nameInput = dlg.querySelector('#cust-name');
  const homeInput = dlg.querySelector('#cust-home');
  const uncappedInput = dlg.querySelector('#cust-uncapped');
  const uncapWarnEl = dlg.querySelector('[data-cust-warn]');
  const ovrOutEl = dlg.querySelector('[data-cust-ovr]');
  const poolBadgeEl = dlg.querySelector('[data-cust-pool]');
  const jerseySwatchRow = dlg.querySelector('[data-swatch-group="jersey"]');
  const capSwatchRow = dlg.querySelector('[data-swatch-group="cap"]');
  const applyCustomBtn = dlg.querySelector('[data-custom-act="apply"]');

  let activeTab = 'locals';
  let activeCat = 'all';
  let searchQuery = '';

  const customState = {
    name: 'Box Canyon Local',
    hometown: 'Telluride, CO',
    uncapped: false,
    stats: { speed: 85, climbing: 88, technical: 87, endurance: 87, altitude: 88 },
    jerseyHex: 0x1b5e3a,
    capHex: 0xeab308,
    hairStyle: 'short',
  };

  function getRosterData() {
    const live = typeof game?.getRoster === 'function' ? game.getRoster() : null;
    const presets = Array.isArray(live?.presets) && live.presets.length ? live.presets : FALLBACK_PRESETS;
    const rawJerseys = live?.swatches?.jerseys || live?.swatches?.jersey || FALLBACK_JERSEY_SWATCHES;
    const rawCaps = live?.swatches?.caps || live?.swatches?.accents || live?.swatches?.cap || FALLBACK_CAP_SWATCHES;

    const jerseys = (Array.isArray(rawJerseys) ? rawJerseys : FALLBACK_JERSEY_SWATCHES)
      .slice(0, 8)
      .map((s, idx) =>
        typeof s === 'object'
          ? { label: s.label || s.name || `Color ${idx + 1}`, hex: toNumHex(s.hex ?? s.color, 0x1b5e3a) }
          : { label: `Color ${idx + 1}`, hex: toNumHex(s, 0x1b5e3a) }
      );
    while (jerseys.length < 8) {
      jerseys.push(FALLBACK_JERSEY_SWATCHES[jerseys.length % FALLBACK_JERSEY_SWATCHES.length]);
    }

    const caps = (Array.isArray(rawCaps) ? rawCaps : FALLBACK_CAP_SWATCHES)
      .slice(0, 6)
      .map((s, idx) =>
        typeof s === 'object'
          ? { label: s.label || s.name || `Accent ${idx + 1}`, hex: toNumHex(s.hex ?? s.color, 0xeab308) }
          : { label: `Accent ${idx + 1}`, hex: toNumHex(s, 0xeab308) }
      );
    while (caps.length < 6) {
      caps.push(FALLBACK_CAP_SWATCHES[caps.length % FALLBACK_CAP_SWATCHES.length]);
    }

    return { presets, jerseys, caps };
  }

  function applySelectionToGame(sel) {
    if (typeof game?.setRunner === 'function') {
      game.setRunner(sel);
    } else {
      engine.events?.emit?.('ui:selectRunner', sel);
    }
    onRunnerChanged?.(getActiveRunnerSummary(game));
  }

  function setTab(tab) {
    activeTab = tab === 'custom' ? 'custom' : 'locals';
    dlg.querySelectorAll('[data-rtab]').forEach((b) => {
      const on = b.dataset.rtab === activeTab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    localsPane.hidden = activeTab !== 'locals';
    customPane.hidden = activeTab !== 'custom';
    dlg.scrollTop = 0;
  }

  function statsSum(st) {
    return (
      (Number(st.speed) || 80) +
      (Number(st.climbing) || 80) +
      (Number(st.technical) || 80) +
      (Number(st.endurance) || 80) +
      (Number(st.altitude) || 80)
    );
  }

  function clampPoolStats(statsObj) {
    let total = statsSum(statsObj);
    if (customState.uncapped || total <= BALANCED_POOL_CAP) return;
    // Proportionally trim excess down to BALANCED_POOL_CAP while respecting STAT_MIN
    const keys = ['speed', 'climbing', 'technical', 'endurance', 'altitude'];
    let safety = 60;
    while (total > BALANCED_POOL_CAP && safety-- > 0) {
      let trimmed = false;
      for (const k of keys) {
        if (total <= BALANCED_POOL_CAP) break;
        if (statsObj[k] > STAT_MIN) {
          statsObj[k]--;
          total--;
          trimmed = true;
        }
      }
      if (!trimmed) break;
    }
  }

  function syncCustomUI() {
    nameInput.value = customState.name;
    homeInput.value = customState.hometown;
    uncappedInput.checked = customState.uncapped;

    const sum = statsSum(customState.stats);
    const rem = BALANCED_POOL_CAP - sum;
    const isOverCap = sum > BALANCED_POOL_CAP;
    const ovr = calcOvr(customState.stats);

    ovrOutEl.textContent = `${ovr}${isOverCap ? '*' : ''}`;
    if (customState.uncapped) {
      poolBadgeEl.textContent = `Total: ${sum} pts ${isOverCap ? '(Uncapped *)' : `(Purist ≤${BALANCED_POOL_CAP})`}`;
      poolBadgeEl.dataset.tone = isOverCap ? 'warn' : 'ok';
    } else {
      poolBadgeEl.textContent = `Pool Remaining: ${Math.max(0, rem)} pts (${sum}/${BALANCED_POOL_CAP})`;
      poolBadgeEl.dataset.tone = rem === 0 ? 'full' : 'ok';
    }
    uncapWarnEl.hidden = !(customState.uncapped || isOverCap);

    for (const st of STAT_DEFS) {
      const val = customState.stats[st.key];
      const rangeEl = dlg.querySelector(`[data-stat-key="${st.key}"]`);
      const outEl = dlg.querySelector(`[data-stat-val="${st.key}"]`);
      if (rangeEl) rangeEl.value = String(val);
      if (outEl) outEl.textContent = String(val);
    }

    const { jerseys, caps } = getRosterData();
    jerseySwatchRow.innerHTML = jerseys
      .map((sw) => {
        const active = sw.hex === customState.jerseyHex;
        return `<button type="button" class="swatch-btn ${active ? 'is-active' : ''}" data-swatch-jersey="${sw.hex}" role="radio" aria-checked="${active}" aria-label="${escapeHtml(sw.label)}" title="${escapeHtml(sw.label)}" style="--sw:${toCssHex(sw.hex)}"></button>`;
      })
      .join('');

    capSwatchRow.innerHTML = caps
      .map((sw) => {
        const active = sw.hex === customState.capHex;
        return `<button type="button" class="swatch-btn ${active ? 'is-active' : ''}" data-swatch-cap="${sw.hex}" role="radio" aria-checked="${active}" aria-label="${escapeHtml(sw.label)}" title="${escapeHtml(sw.label)}" style="--sw:${toCssHex(sw.hex)}"></button>`;
      })
      .join('');

    dlg.querySelectorAll('[data-hair]').forEach((b) => {
      const on = b.dataset.hair === customState.hairStyle;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });

    const displayName = (customState.name || 'Box Canyon Local').trim() || 'Box Canyon Local';
    applyCustomBtn.textContent = `Run as ${displayName}${isOverCap ? ' (*)' : ''} →`;
  }

  function renderLocals() {
    const { presets } = getRosterData();
    const active = getActiveRunnerSummary(game);
    const q = searchQuery.trim().toLowerCase();

    const filtered = presets.filter((r) => {
      if (activeCat !== 'all') {
        const cat = String(r.category || '').toLowerCase();
        if (cat !== activeCat) return false;
      }
      if (!q) return true;
      const hay = [
        r.name,
        r.hometown,
        r.specialty,
        r.bio,
        ...(Array.isArray(r.aliases) ? r.aliases : []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    if (!filtered.length) {
      listEl.innerHTML = `<p class="empty-msg">No Telluride runners match "${escapeHtml(searchQuery)}".</p>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((r) => {
        const isSelected = !active.isCustom && active.id === r.id;
        const ovr = Number.isFinite(r.ovr) ? r.ovr : calcOvr(r.stats);
        const jerseyCss = toCssHex(r.kit?.jerseyHex, '#dc382c');
        const capCss = toCssHex(r.kit?.capHex ?? r.kit?.accentHex, '#f3f4f6');
        const statsHtml = STAT_DEFS.map((st) => {
          const val = Math.round(Number(r.stats?.[st.key]) || 80);
          const pct = Math.max(8, Math.min(100, Math.round(((val - 45) / 54) * 100)));
          const elite = val >= 94 ? 'is-elite' : '';
          return `
            <div class="rcard-stat ${elite}">
              <span class="rcard-stat__k">${st.short}</span>
              <div class="rcard-stat__bar"><div style="inline-size:${pct}%"></div></div>
              <span class="rcard-stat__v">${val}</span>
            </div>
          `;
        }).join('');

        return `
          <article class="runner-card ${isSelected ? 'is-selected' : ''}" data-preset-card="${escapeHtml(r.id)}">
            <div class="runner-card__head">
              <div class="runner-kit-badge" style="--jersey:${jerseyCss};--cap:${capCss}" aria-hidden="true">
                <span class="runner-kit-badge__cap"></span>
              </div>
              <div class="runner-card__titles">
                <div class="runner-card__name-row">
                  <h3>${escapeHtml(r.name)}</h3>
                  <span class="runner-ovr-pill">OVR ${ovr}</span>
                </div>
                <div class="runner-card__meta">${escapeHtml(r.hometown || 'Telluride, CO')} · <strong>${escapeHtml(r.specialty || 'Mountain Runner')}</strong></div>
              </div>
            </div>
            <p class="runner-card__bio">${escapeHtml(r.bio || '')}</p>
            <div class="runner-card__stats">${statsHtml}</div>
            <button type="button" class="btn ${isSelected ? 'btn--secondary' : 'btn--primary'} btn--sm runner-select-btn" data-select-preset="${escapeHtml(r.id)}">
              ${isSelected ? '✓ Active Runner' : `Select ${escapeHtml(fmtRunnerShortName(r.name))}`}
            </button>
          </article>
        `;
      })
      .join('');
  }

  function hydrateCustomFromActive() {
    const cur = typeof game?.getActiveRunner === 'function' ? game.getActiveRunner() : null;
    if (cur && (cur.isCustom || cur.id === 'custom')) {
      customState.name = cur.name || 'Box Canyon Local';
      customState.hometown = cur.hometown || 'Telluride, CO';
      if (cur.stats) {
        for (const st of STAT_DEFS) {
          if (Number.isFinite(cur.stats[st.key])) {
            customState.stats[st.key] = Math.max(STAT_MIN, Math.min(STAT_MAX, Math.round(cur.stats[st.key])));
          }
        }
      }
      customState.uncapped = Boolean(cur.uncapped || cur.statUncapped || statsSum(customState.stats) > BALANCED_POOL_CAP);
      if (cur.kit) {
        customState.jerseyHex = toNumHex(cur.kit.jerseyHex, customState.jerseyHex);
        customState.capHex = toNumHex(cur.kit.capHex ?? cur.kit.accentHex, customState.capHex);
        customState.hairStyle = cur.kit.hairStyle === 'ponytail' ? 'ponytail' : 'short';
      }
    }
  }

  function rollRandom(archetypeId) {
    let rolled = null;
    if (typeof game?.rollCustomRunner === 'function') {
      try {
        rolled = game.rollCustomRunner(archetypeId);
      } catch {
        rolled = null;
      }
    }
    if (rolled && rolled.stats) {
      if (rolled.name && (customState.name === 'Box Canyon Local' || archetypeId)) {
        customState.name = String(rolled.name).slice(0, 28);
      }
      if (rolled.hometown) customState.hometown = String(rolled.hometown).slice(0, 32);
      for (const st of STAT_DEFS) {
        customState.stats[st.key] = Math.max(
          STAT_MIN,
          Math.min(STAT_MAX, Math.round(Number(rolled.stats[st.key]) || 80))
        );
      }
      if (!customState.uncapped) clampPoolStats(customState.stats);
      if (rolled.kit) {
        customState.jerseyHex = toNumHex(rolled.kit.jerseyHex, customState.jerseyHex);
        customState.capHex = toNumHex(rolled.kit.capHex ?? rolled.kit.accentHex, customState.capHex);
        if (rolled.kit.hairStyle) customState.hairStyle = rolled.kit.hairStyle === 'ponytail' ? 'ponytail' : 'short';
      }
      syncCustomUI();
      return;
    }

    // Local fallback roller within BALANCED_POOL_CAP
    const { jerseys, caps } = getRosterData();
    const arch = QUICK_ARCHETYPES.find((a) => a.id === archetypeId);
    if (arch) {
      customState.stats = { ...arch.stats };
      customState.hometown = arch.tag;
    } else {
      const raw = {};
      for (const st of STAT_DEFS) {
        raw[st.key] = Math.floor(68 + Math.random() * 29);
      }
      customState.stats = raw;
      if (!customState.uncapped) clampPoolStats(customState.stats);
      customState.jerseyHex = jerseys[Math.floor(Math.random() * jerseys.length)].hex;
      customState.capHex = caps[Math.floor(Math.random() * caps.length)].hex;
      customState.hairStyle = Math.random() < 0.4 ? 'ponytail' : 'short';
    }
    syncCustomUI();
  }

  // Event listeners inside modal
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-runner-close]')) {
      dlg.close();
      return;
    }
    const tabBtn = e.target.closest('[data-rtab]');
    if (tabBtn) {
      setTab(tabBtn.dataset.rtab);
      return;
    }
    const catBtn = e.target.closest('[data-rcat]');
    if (catBtn) {
      activeCat = catBtn.dataset.rcat;
      dlg.querySelectorAll('[data-rcat]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.rcat === activeCat);
      });
      renderLocals();
      return;
    }
    const presetBtn = e.target.closest('[data-select-preset]');
    if (presetBtn) {
      const id = presetBtn.dataset.selectPreset;
      const { presets } = getRosterData();
      const found = presets.find((p) => p.id === id);
      applySelectionToGame(found ? { type: 'preset', id: found.id } : { id });
      renderLocals();
      onShowToast?.(`🏃 Selected ${found?.name || id}`, 'ok', 2200);
      dlg.close();
      return;
    }
    const archBtn = e.target.closest('[data-arch]');
    if (archBtn) {
      const archId = archBtn.dataset.arch;
      dlg.querySelectorAll('[data-arch]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.arch === archId);
      });
      const localArch = QUICK_ARCHETYPES.find((a) => a.id === archId);
      if (localArch) {
        customState.stats = { ...localArch.stats };
        customState.hometown = localArch.tag;
        if (!customState.uncapped) clampPoolStats(customState.stats);
        syncCustomUI();
      } else {
        rollRandom(archId);
      }
      return;
    }
    const jSw = e.target.closest('[data-swatch-jersey]');
    if (jSw) {
      customState.jerseyHex = Number(jSw.dataset.swatchJersey);
      syncCustomUI();
      return;
    }
    const cSw = e.target.closest('[data-swatch-cap]');
    if (cSw) {
      customState.capHex = Number(cSw.dataset.swatchCap);
      syncCustomUI();
      return;
    }
    const hairBtn = e.target.closest('[data-hair]');
    if (hairBtn) {
      customState.hairStyle = hairBtn.dataset.hair === 'ponytail' ? 'ponytail' : 'short';
      syncCustomUI();
      return;
    }
    const custAct = e.target.closest('[data-custom-act]');
    if (custAct) {
      if (custAct.dataset.customAct === 'roll') {
        dlg.querySelectorAll('[data-arch]').forEach((b) => b.classList.remove('is-active'));
        rollRandom();
      } else if (custAct.dataset.customAct === 'apply') {
        const cleanName = (nameInput.value || 'Box Canyon Local').trim().slice(0, 28) || 'Box Canyon Local';
        const cleanHome = (homeInput.value || 'Telluride, CO').trim().slice(0, 32) || 'Telluride, CO';
        customState.name = cleanName;
        customState.hometown = cleanHome;
        if (!customState.uncapped) clampPoolStats(customState.stats);
        const sum = statsSum(customState.stats);
        const statUncapped = sum > BALANCED_POOL_CAP;
        const ovr = calcOvr(customState.stats);
        const payload = {
          type: 'custom',
          id: 'custom',
          isCustom: true,
          name: cleanName,
          hometown: cleanHome,
          specialty: statUncapped ? 'Uncapped Custom Runner (*)' : 'Custom San Juan Runner',
          uncapped: statUncapped,
          statUncapped,
          stats: { ...customState.stats },
          ovr,
          kit: {
            jerseyHex: customState.jerseyHex,
            shortsHex: 0x1e293b,
            accentHex: customState.capHex,
            capHex: customState.capHex,
            brimHex: customState.jerseyHex,
            hairStyle: customState.hairStyle,
          },
        };
        applySelectionToGame(payload);
        onShowToast?.(`🏃 Running as ${cleanName} (OVR ${ovr}${statUncapped ? '*' : ''})`, 'ok', 2400);
        dlg.close();
      }
    }
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value;
    renderLocals();
  });

  nameInput.addEventListener('input', () => {
    customState.name = nameInput.value.slice(0, 28);
    const displayName = customState.name.trim() || 'Box Canyon Local';
    const isOverCap = statsSum(customState.stats) > BALANCED_POOL_CAP;
    applyCustomBtn.textContent = `Run as ${displayName}${isOverCap ? ' (*)' : ''} →`;
  });

  homeInput.addEventListener('input', () => {
    customState.hometown = homeInput.value.slice(0, 32);
  });

  uncappedInput.addEventListener('change', () => {
    customState.uncapped = uncappedInput.checked;
    if (!customState.uncapped) {
      clampPoolStats(customState.stats);
    }
    syncCustomUI();
  });

  dlg.querySelectorAll('.custom-stat-range').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.statKey;
      let val = Math.max(STAT_MIN, Math.min(STAT_MAX, Number(input.value) || 80));
      if (!customState.uncapped) {
        const othersSum = statsSum(customState.stats) - customState.stats[key];
        const maxAllowed = Math.max(STAT_MIN, Math.min(STAT_MAX, BALANCED_POOL_CAP - othersSum));
        if (val > maxAllowed) val = maxAllowed;
      }
      customState.stats[key] = val;
      syncCustomUI();
    });
  });

  const unsubChanged = engine.events?.on?.('game:runnerChanged', () => {
    if (dlg.open) {
      renderLocals();
      hydrateCustomFromActive();
      syncCustomUI();
    }
    onRunnerChanged?.(getActiveRunnerSummary(game));
  });

  return {
    open(initialTab) {
      hydrateCustomFromActive();
      renderLocals();
      syncCustomUI();
      if (initialTab) setTab(initialTab);
      else {
        const cur = getActiveRunnerSummary(game);
        setTab(cur.isCustom ? 'custom' : 'locals');
      }
      if (!dlg.open) dlg.showModal();
      dlg.scrollTop = 0;
    },
    close() {
      if (dlg.open) dlg.close();
    },
    getSummary: () => getActiveRunnerSummary(game),
    dispose() {
      if (unsubChanged) unsubChanged();
      dlg.remove();
    },
  };
}
