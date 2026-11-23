/* Telluride Trails Service Worker — App shell + bounded immutable tile cache */
const CACHE_VERSION = 'v4';
const SHELL_CACHE = `tt-shell-${CACHE_VERSION}`;
const TILE_CACHE = `tt-tiles-${CACHE_VERSION}`;
const MAX_TILE_ENTRIES = 1500;
const TRIM_EVERY_N_WRITES = 50;

const BASE_PATH = new URL('./', self.location.href).pathname;
const SHELL_PRECACHE = [
  BASE_PATH,
  `${BASE_PATH}index.html`,
  `${BASE_PATH}title-hero.webp`,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}assets/ui/icon.svg`,
  `${BASE_PATH}assets/ui/icon-192.png`,
];

let tileWritesSinceTrim = 0;
let trimming = false;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL_PRECACHE.map((u) => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Only immutable raster tiles (.webp/.png/.jpg) and numbered vector tile chunks
 * use cache-first. Mutable manifests and top-level JSON metadata use network-first!
 */
function isImmutableDataTile(url) {
  const p = url.pathname;
  if (
    p.endsWith('/manifest.json') ||
    p.endsWith('/races.json') ||
    p.endsWith('/pois.json') ||
    p.endsWith('/overview.json') ||
    p.endsWith('/graph.json') ||
    p.endsWith('/corridor_tiles.json')
  ) {
    return false;
  }
  if (p.includes('/data/terrain/') || p.includes('/data/imagery/') || p.includes('/data/cover/')) {
    return /\.(webp|png|jpg|jpeg)$/i.test(p);
  }
  if (p.includes('/data/vector/')) {
    return p.includes('/chunks/') || /\/\d+_\d+\.json$/i.test(p);
  }
  return false;
}

function isMutableDataJson(url) {
  const p = url.pathname;
  return p.includes('/data/') && p.endsWith('.json');
}

function isDevAsset(url) {
  const p = url.pathname;
  return (
    p.includes('/@vite/') ||
    p.includes('/@fs/') ||
    p.includes('/node_modules/') ||
    p.includes('/src/')
  );
}

async function trimTileCache() {
  if (trimming) return;
  trimming = true;
  try {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    if (keys.length <= MAX_TILE_ENTRIES) return;
    const excess = keys.length - MAX_TILE_ENTRIES;
    for (let i = 0; i < excess; i++) {
      await cache.delete(keys[i]);
    }
  } finally {
    trimming = false;
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(SHELL_CACHE).then((cache) =>
        Promise.all(
          data.urls
            .filter((u) => typeof u === 'string' && u.startsWith(self.location.origin))
            .map((u) => cache.add(u).catch(() => {}))
        )
      )
    );
  }
});

async function cacheFirstTile(request, event) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const clone = response.clone();
    tileWritesSinceTrim++;
    const shouldTrim = tileWritesSinceTrim >= TRIM_EVERY_N_WRITES;
    if (shouldTrim) tileWritesSinceTrim = 0;
    const bgWork = cache
      .put(request, clone)
      .then(() => (shouldTrim ? trimTileCache() : undefined))
      .catch(() => {});
    event.waitUntil(bgWork);
  }
  return response;
}

async function networkFirstShell(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const clone = response.clone();
      event.waitUntil(cache.put(request, clone).catch(() => {}));
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const indexFallback = await cache.match(`${BASE_PATH}index.html`);
      if (indexFallback) return indexFallback;
    }
    throw err;
  }
}

async function staleWhileRevalidateShell(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        return cache
          .put(request, response.clone())
          .catch(() => {})
          .then(() => response);
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(networkPromise);

  if (cached) return cached;
  const res = await networkPromise;
  if (res) return res;
  throw new Error('Offline and not cached');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isDevAsset(url)) return;

  if (isImmutableDataTile(url)) {
    event.respondWith(cacheFirstTile(request, event));
    return;
  }

  if (
    request.mode === 'navigate' ||
    url.pathname.endsWith('index.html') ||
    isMutableDataJson(url)
  ) {
    event.respondWith(networkFirstShell(request, event));
    return;
  }

  if (
    url.pathname.includes('/assets/') ||
    url.pathname.endsWith('/title-hero.webp') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.json') ||
    /\.(js|css|svg|png|webp|avif|jpg|jpeg|glb|ktx2|mp3|ogg|wav|woff2)$/i.test(url.pathname)
  ) {
    event.respondWith(staleWhileRevalidateShell(request, event));
  }
});
