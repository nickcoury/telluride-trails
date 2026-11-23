/* Telluride Trails Service Worker — App shell + bounded tile cache */
const SHELL_CACHE = 'tt-shell-v1';
const TILE_CACHE = 'tt-tiles-v1';
const MAX_TILE_ENTRIES = 1500;

const BASE_PATH = new URL('./', self.location.href).pathname;
const SHELL_PRECACHE = [
  BASE_PATH,
  `${BASE_PATH}index.html`,
  `${BASE_PATH}manifest.webmanifest`,
  `${BASE_PATH}assets/ui/icon.svg`,
  `${BASE_PATH}assets/ui/icon-192.png`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_PRECACHE).catch(() => {}))
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

function isDataTileRequest(url) {
  const p = url.pathname;
  return (
    p.includes('/data/terrain/') ||
    p.includes('/data/imagery/') ||
    p.includes('/data/cover/') ||
    p.includes('/data/vector/')
  );
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
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  if (keys.length <= MAX_TILE_ENTRIES) return;
  const excess = keys.length - MAX_TILE_ENTRIES;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

async function cacheFirstTile(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const clone = response.clone();
    cache.put(request, clone).then(() => trimTileCache()).catch(() => {});
  }
  return response;
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
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

async function staleWhileRevalidateShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

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

  if (isDataTileRequest(url)) {
    event.respondWith(cacheFirstTile(request));
    return;
  }

  if (request.mode === 'navigate' || url.pathname.endsWith('index.html')) {
    event.respondWith(networkFirstShell(request));
    return;
  }

  if (
    url.pathname.includes('/assets/') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.json')
  ) {
    event.respondWith(staleWhileRevalidateShell(request));
  }
});
