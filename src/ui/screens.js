import { createElevationChart } from './elevChart.js';
import {
  TRIVIA,
  fmtClock,
  fmtDist,
  fmtElev,
  fmtShortDist,
  getRaceDisclaimer,
} from './format.js';
import { createMap2D } from './map2d.js';
import { getBestRecord, peekSavedRun } from './storage.js';

const KIND_LABELS = {
  trailhead: 'Trailhead',
  town: 'Town',
  pass: 'Pass',
  peak: 'Peak',
  waterfall: 'Waterfall',
  lake: 'Lake',
  viewpoint: 'Viewpoint',
  trail: 'Trail',
};

/**
 * Create the screen manager: Title, Free Run Picker (List + 2D Map + Confirm Sheet),
 * Races Select, and Loading Screen with San Juan trivia.
 */
export function createScreens({
  container,
  engine,
  trailData,
  terrain,
  game,
  pwa,
  getSettings,
  onStartFreeRun,
  onStartRace,
  onResumeSaved,
  onOpenSettings,
  onOpenCredits,
}) {
  const root = document.createElement('div');
  root.className = 'screens-layer';
  root.innerHTML = `
    <!-- TITLE SCREEN -->
    <main class="screen screen--title" data-screen="title">
      <div class="title-hero" aria-hidden="true">
        <svg class="title-hero__crest" viewBox="0 0 1200 320" preserveAspectRatio="none">
          <defs>
            <linearGradient id="tt-ridge-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#192c3e" stop-opacity="0.72" />
              <stop offset="100%" stop-color="#0d151c" stop-opacity="0.96" />
            </linearGradient>
          </defs>
          <path d="M0 245 L110 155 L205 198 L335 88 L430 165 L540 112 L655 182 L790 64 L915 152 L1045 96 L1145 162 L1200 135 L1200 320 L0 320 Z" fill="url(#tt-ridge-grad)" />
          <path d="M335 88 L385 130 L345 142 L318 122 L292 138 Z" fill="rgba(244,246,248,0.16)" />
          <path d="M790 64 L848 118 L802 128 L774 106 L745 126 Z" fill="rgba(244,246,248,0.2)" />
        </svg>
      </div>

      <div class="title-card">
        <div class="title-eyebrow">Telluride &amp; the San Juan Mountains · 37.94°N</div>
        <h1 class="title-heading">TELLURIDE <em>TRAILS</em></h1>
        <p class="title-tagline">Real elevation. Real orthoimagery. 100% real-time trail running — because 36 hours in the San Juans shouldn’t be rushed.</p>

        <div class="resume-banner" hidden></div>

        <nav class="title-actions" aria-label="Main menu">
          <button type="button" class="btn btn--primary btn--lg" data-nav="freerun">
            <span>🏔 Free Run</span>
            <small>Pick any trailhead, peak, or map point</small>
          </button>
          <button type="button" class="btn btn--accent btn--lg" data-nav="races">
            <span>🏁 Races</span>
            <small>Hardrock 100, Imogene, Rundola &amp; classics</small>
          </button>
        </nav>

        <div class="title-secondary">
          <button type="button" class="btn btn--ghost" data-act="settings">⚙ Settings</button>
          <button type="button" class="btn btn--ghost" data-act="credits">📜 Credits &amp; Data</button>
          <button type="button" class="btn btn--ghost" data-act="install" hidden>📲 Install App</button>
        </div>
      </div>
    </main>

    <!-- FREE RUN PICKER -->
    <section class="screen screen--picker" data-screen="freerun" hidden aria-label="Free Run Location Picker">
      <header class="screen-head">
        <button type="button" class="btn btn--ghost btn--sm" data-nav="title">← Back</button>
        <h1>Free Run</h1>
        <div class="picker-mode-tabs" role="tablist" aria-label="Picker view">
          <button type="button" class="tab-btn is-active" role="tab" aria-selected="true" data-picker-tab="list">List</button>
          <button type="button" class="tab-btn" role="tab" aria-selected="false" data-picker-tab="map">2D Map</button>
        </div>
      </header>

      <div class="picker-body">
        <div class="picker-list-pane">
          <search class="picker-search">
            <label for="poi-search" class="visually-hidden">Search trailheads, peaks, towns</label>
            <input id="poi-search" type="search" placeholder="Search Bear Creek, Imogene, Bridal Veil..." autocomplete="off" />
          </search>
          <div class="picker-filters" role="group" aria-label="Filter locations">
            <button type="button" class="chip is-active" data-filter="all">All</button>
            <button type="button" class="chip" data-filter="trailhead">Trailheads</button>
            <button type="button" class="chip" data-filter="peak_pass">Peaks &amp; Passes</button>
            <button type="button" class="chip" data-filter="town">Towns</button>
            <button type="button" class="chip" data-filter="water">Falls &amp; Lakes</button>
          </div>
          <div class="poi-groups"></div>
        </div>

        <div class="picker-map-pane"></div>
      </div>

      <aside class="confirm-sheet" hidden aria-label="Confirm starting point">
        <div class="confirm-sheet__info">
          <div class="confirm-sheet__badge" data-confirm="badge"></div>
          <h2 class="confirm-sheet__title" data-confirm="title"></h2>
          <p class="confirm-sheet__meta" data-confirm="meta"></p>
          <p class="confirm-sheet__desc" data-confirm="desc" hidden></p>
        </div>
        <div class="confirm-sheet__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-confirm="cancel">Cancel</button>
          <button type="button" class="btn btn--primary" data-confirm="go">Start Run →</button>
        </div>
      </aside>
    </section>

    <!-- RACES SELECT -->
    <section class="screen screen--races" data-screen="races" hidden aria-label="Race Selection">
      <header class="screen-head">
        <button type="button" class="btn btn--ghost btn--sm" data-nav="title">← Back</button>
        <h1>San Juan Races</h1>
        <span class="screen-head__tag">1s = 1s Real Time</span>
      </header>
      <div class="races-grid"></div>
    </section>

    <!-- LOADING SCREEN -->
    <section class="screen screen--loading" data-screen="loading" hidden aria-label="Loading terrain">
      <div class="loading-card">
        <div class="loading-crest" aria-hidden="true">⛰️</div>
        <h2 class="loading-title">Streaming the San Juans…</h2>
        <p class="loading-stage" data-loading="stage">Fetching USGS 3DEP elevation &amp; trail corridor</p>
        <div class="loading-progress-wrap">
          <progress class="loading-progress" max="100" value="12"></progress>
          <span class="loading-pct" data-loading="pct">12%</span>
        </div>
        <blockquote class="loading-trivia">
          <span class="loading-trivia__eyebrow">San Juan Field Note</span>
          <p data-loading="trivia"></p>
        </blockquote>
        <button type="button" class="btn btn--ghost btn--sm" data-loading="next-trivia">Next Note →</button>
      </div>
    </section>
  `;
  container.appendChild(root);

  const titleEl = root.querySelector('[data-screen="title"]');
  const freerunEl = root.querySelector('[data-screen="freerun"]');
  const racesEl = root.querySelector('[data-screen="races"]');
  const loadingEl = root.querySelector('[data-screen="loading"]');

  const resumeBanner = root.querySelector('.resume-banner');
  const installBtn = root.querySelector('[data-act="install"]');
  const poiSearchInput = root.querySelector('#poi-search');
  const poiGroupsEl = root.querySelector('.poi-groups');
  const pickerMapPane = root.querySelector('.picker-map-pane');
  const pickerBody = root.querySelector('.picker-body');
  const confirmSheet = root.querySelector('.confirm-sheet');
  const racesGridEl = root.querySelector('.races-grid');

  const loadingStageEl = root.querySelector('[data-loading="stage"]');
  const loadingPctEl = root.querySelector('[data-loading="pct"]');
  const loadingBarEl = root.querySelector('.loading-progress');
  const loadingTriviaEl = root.querySelector('[data-loading="trivia"]');

  let activeScreen = 'title';
  let activeFilter = 'all';
  let searchQuery = '';
  let pickedLocation = null;
  let map2d = null;
  let triviaIdx = Math.floor(Math.random() * TRIVIA.length);
  let triviaTimer = null;

  // PWA Install hook
  if (pwa) {
    installBtn.hidden = !pwa.canInstall();
    pwa.onInstallChange((can) => {
      installBtn.hidden = !can;
    });
    installBtn.addEventListener('click', () => pwa.promptInstall());
  }

  function refreshResumeBanner() {
    const saved = peekSavedRun(game);
    if (!saved) {
      resumeBanner.hidden = true;
      resumeBanner.innerHTML = '';
      return;
    }
    const units = getSettings()?.units || 'imperial';
    const dist = fmtDist(saved.distM ?? saved.distanceM ?? 0, units, 2);
    const label = saved.raceName || (saved.raceId ? `Race: ${saved.raceId}` : 'Saved Free Run');
    const clock = saved.clockS ?? saved.elapsedSec ? ` · ${fmtClock(saved.clockS ?? saved.elapsedSec)}` : '';
    resumeBanner.hidden = false;
    resumeBanner.innerHTML = `
      <div class="resume-banner__text">
        <strong>Resume In-Progress Run</strong>
        <span>${label} · ${dist}${clock}</span>
      </div>
      <button type="button" class="btn btn--primary btn--sm" data-act="resume-saved">Resume →</button>
    `;
  }

  function showConfirmSheet(loc) {
    pickedLocation = loc;
    const units = getSettings()?.units || 'imperial';
    confirmSheet.querySelector('[data-confirm="badge"]').textContent =
      loc.snapped ? `${KIND_LABELS[loc.kind] || 'Trail'} · Snapped` : 'Off-Trail Pin';
    confirmSheet.querySelector('[data-confirm="title"]').textContent = loc.name || 'Custom Location';
    const elevStr = fmtElev(loc.y, units);
    const snapStr =
      loc.snapped && loc.snapDistM > 5
        ? ` · Snapped ${fmtShortDist(loc.snapDistM, units)} to ${loc.trailName || 'trail'}`
        : loc.area
          ? ` · ${loc.area}`
          : '';
    confirmSheet.querySelector('[data-confirm="meta"]').textContent = `${elevStr}${snapStr}`;
    const descEl = confirmSheet.querySelector('[data-confirm="desc"]');
    if (loc.description) {
      descEl.textContent = loc.description;
      descEl.hidden = false;
    } else {
      descEl.textContent = '';
      descEl.hidden = true;
    }
    confirmSheet.hidden = false;
  }

  function hideConfirmSheet() {
    pickedLocation = null;
    confirmSheet.hidden = true;
  }

  function renderPOIs() {
    const pois = trailData?.pois || [];
    const units = getSettings()?.units || 'imperial';
    const q = searchQuery.trim().toLowerCase();

    const filtered = pois.filter((p) => {
      if (!q && activeFilter === 'all' && pois.some((x) => x.freeRun) && !p.freeRun) {
        return false;
      }
      if (q && !`${p.name} ${p.area || ''} ${p.kind || ''} ${p.description || ''}`.toLowerCase().includes(q)) {
        return false;
      }
      if (activeFilter === 'trailhead') return p.kind === 'trailhead' || p.kind === 'viewpoint';
      if (activeFilter === 'peak_pass') return p.kind === 'peak' || p.kind === 'pass';
      if (activeFilter === 'town') return p.kind === 'town';
      if (activeFilter === 'water') return p.kind === 'waterfall' || p.kind === 'lake';
      return true;
    });

    if (!filtered.length) {
      poiGroupsEl.innerHTML = '<p class="empty-msg">No spots match that filter. Try tapping anywhere on the 2D map!</p>';
      return;
    }

    const groups = new Map();
    for (const poi of filtered) {
      const area = poi.area || 'San Juan Mountains';
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area).push(poi);
    }

    poiGroupsEl.innerHTML = '';
    for (const [area, items] of groups) {
      const section = document.createElement('section');
      section.className = 'poi-group';
      section.innerHTML = `<h2 class="poi-group__title">${area}</h2><ul class="poi-list"></ul>`;
      const ul = section.querySelector('.poi-list');
      for (const poi of items) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'poi-item';
        btn.innerHTML = `
          <span class="poi-item__main">
            <strong>${poi.name}</strong>
            <small>${KIND_LABELS[poi.kind] || 'Spot'}</small>
          </span>
          <span class="poi-item__elev">${fmtElev(poi.y, units)}</span>
        `;
        btn.addEventListener('click', () => {
          ensureMap2D();
          map2d?.focusPoint(poi.x, poi.z, 10);
          showConfirmSheet({
            x: poi.x,
            z: poi.z,
            y: poi.y,
            name: poi.name,
            kind: poi.kind || 'trailhead',
            area: poi.area || area,
            description: poi.description || '',
            heading: poi.heading || 0,
            snapped: true,
            trailName: poi.name,
            snapDistM: 0,
          });
        });
        li.appendChild(btn);
        ul.appendChild(li);
      }
      poiGroupsEl.appendChild(section);
    }
  }

  function ensureMap2D() {
    if (map2d) return;
    map2d = createMap2D({
      container: pickerMapPane,
      trailData,
      terrain,
      engine,
      getUnits: () => getSettings()?.units || 'imperial',
      onPickLocation: (loc) => showConfirmSheet(loc),
    });
  }

  function renderRaces() {
    const races = trailData?.races || [];
    const units = getSettings()?.units || 'imperial';
    racesGridEl.innerHTML = '';

    if (!races.length) {
      racesGridEl.innerHTML = '<p class="empty-msg">No race routes loaded yet.</p>';
      return;
    }

    for (const race of races) {
      const card = document.createElement('article');
      card.className = 'race-card';
      const distM = (race.distanceMi || 0) * 1609.344;
      const gainM = (race.gainFt || 0) / 3.28084;
      const best = getBestRecord(race.id);
      const bestHtml = best
        ? `<span class="race-pb">🏆 PB: ${fmtClock(best.elapsedSec)}${best.timeDilated ? ' *' : ''}</span>`
        : '';

      const cps = Array.isArray(race.checkpoints) ? race.checkpoints : [];
      const cpListHtml = cps.length
        ? `<details class="race-cps">
            <summary>Aid Stations &amp; Checkpoints (${cps.length})</summary>
            <ul>
              ${cps
                .map(
                  (cp) =>
                    `<li><span>${cp.name}</span><span>${fmtDist(cp.d || 0, units, 1)}${cp.cutoffH ? ` · Cutoff ${cp.cutoffH}h` : ''}</span></li>`
                )
                .join('')}
            </ul>
          </details>`
        : '';

      card.innerHTML = `
        <div class="race-card__head">
          <div>
            <h2>${race.name}</h2>
            ${bestHtml}
          </div>
          <span class="race-start-pill">Start ${race.startTimeLocal || '06:00'}</span>
        </div>

        <p class="race-blurb">${race.blurb || ''}</p>

        <div class="race-disclaimer" role="note">
          <span aria-hidden="true">⏱️</span>
          <span>${getRaceDisclaimer(race)}</span>
        </div>

        <dl class="race-stats">
          <div><dt>Distance</dt><dd>${fmtDist(distM, units, 1)}</dd></div>
          <div><dt>Vert Gain</dt><dd>${fmtElev(gainM, units)}</dd></div>
          <div><dt>Cutoff</dt><dd>${race.cutoffH ? `${race.cutoffH} hrs` : 'None'}</dd></div>
        </dl>

        <div class="race-chart-slot"></div>
        ${cpListHtml}

        <button type="button" class="btn btn--primary race-start-btn" data-race-id="${race.id}">
          Start ${race.name} →
        </button>
      `;

      const chartSlot = card.querySelector('.race-chart-slot');
      chartSlot.appendChild(createElevationChart({ race, terrain, units }));

      card.querySelector('.race-start-btn').addEventListener('click', () => {
        onStartRace?.(race);
      });
      racesGridEl.appendChild(card);
    }
  }

  function showTrivia() {
    loadingTriviaEl.textContent = TRIVIA[triviaIdx % TRIVIA.length];
  }

  function setLoadingProgress(pct, stageText) {
    const clamped = Math.max(0, Math.min(100, Math.round(pct)));
    loadingBarEl.value = clamped;
    loadingPctEl.textContent = `${clamped}%`;
    if (stageText) loadingStageEl.textContent = stageText;
  }

  function showScreen(name) {
    activeScreen = name;
    titleEl.hidden = name !== 'title';
    freerunEl.hidden = name !== 'freerun';
    racesEl.hidden = name !== 'races';
    loadingEl.hidden = name !== 'loading';

    if (triviaTimer) {
      clearInterval(triviaTimer);
      triviaTimer = null;
    }

    if (name === 'title') {
      refreshResumeBanner();
    } else if (name === 'freerun') {
      renderPOIs();
      ensureMap2D();
      setTimeout(() => map2d?.refresh(), 40);
    } else if (name === 'races') {
      renderRaces();
    } else if (name === 'loading') {
      showTrivia();
      triviaTimer = setInterval(() => {
        triviaIdx = (triviaIdx + 1) % TRIVIA.length;
        showTrivia();
      }, 4500);
    }
  }

  // Event delegation inside screens
  root.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-nav]');
    if (navBtn) {
      showScreen(navBtn.dataset.nav);
      return;
    }
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      const act = actBtn.dataset.act;
      if (act === 'settings') onOpenSettings?.();
      else if (act === 'credits') onOpenCredits?.();
      else if (act === 'resume-saved') onResumeSaved?.();
      return;
    }
    const tabBtn = e.target.closest('[data-picker-tab]');
    if (tabBtn) {
      const tab = tabBtn.dataset.pickerTab;
      pickerBody.dataset.mode = tab;
      freerunEl.querySelectorAll('[data-picker-tab]').forEach((b) => {
        const active = b.dataset.pickerTab === tab;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      if (tab === 'map') {
        ensureMap2D();
        setTimeout(() => map2d?.refresh(), 40);
      }
      return;
    }
    const filterBtn = e.target.closest('[data-filter]');
    if (filterBtn) {
      activeFilter = filterBtn.dataset.filter;
      freerunEl.querySelectorAll('[data-filter]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.filter === activeFilter);
      });
      renderPOIs();
      return;
    }
    if (e.target.closest('[data-loading="next-trivia"]')) {
      triviaIdx = (triviaIdx + 1) % TRIVIA.length;
      showTrivia();
    }
  });

  poiSearchInput.addEventListener('input', () => {
    searchQuery = poiSearchInput.value;
    renderPOIs();
  });

  confirmSheet.querySelector('[data-confirm="cancel"]').addEventListener('click', hideConfirmSheet);
  confirmSheet.querySelector('[data-confirm="go"]').addEventListener('click', () => {
    if (!pickedLocation) return;
    const loc = { ...pickedLocation };
    hideConfirmSheet();
    onStartFreeRun?.(loc);
  });

  refreshResumeBanner();

  return {
    showScreen,
    getActiveScreen: () => activeScreen,
    setLoadingProgress,
    refresh() {
      if (activeScreen === 'title') refreshResumeBanner();
      else if (activeScreen === 'freerun') {
        renderPOIs();
        map2d?.refresh();
      } else if (activeScreen === 'races') renderRaces();
    },
    dispose() {
      if (triviaTimer) clearInterval(triviaTimer);
      map2d?.dispose();
      root.remove();
    },
  };
}
