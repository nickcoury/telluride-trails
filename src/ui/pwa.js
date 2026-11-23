/**
 * PWA manifest link injection (fallback if index.html omits it),
 * service worker registration, and install prompt hook.
 */

let deferredInstallPrompt = null;

export function setupPWA(assetsBase = '/telluride-trails/') {
  const base = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;

  // Ensure manifest & icon links exist in <head> even before architect edits index.html
  if (!document.querySelector('link[rel="manifest"]')) {
    const manifestLink = document.createElement('link');
    manifestLink.rel = 'manifest';
    manifestLink.href = `${base}manifest.webmanifest`;
    document.head.appendChild(manifestLink);
  }
  if (!document.querySelector('link[rel="icon"]')) {
    const iconLink = document.createElement('link');
    iconLink.rel = 'icon';
    iconLink.type = 'image/svg+xml';
    iconLink.href = `${base}assets/ui/icon.svg`;
    document.head.appendChild(iconLink);
  }
  if (!document.querySelector('link[rel="apple-touch-icon"]')) {
    const appleIcon = document.createElement('link');
    appleIcon.rel = 'apple-touch-icon';
    appleIcon.href = `${base}assets/ui/icon-192.png`;
    document.head.appendChild(appleIcon);
  }

  // Register Service Worker (safe in production & preview; skip during Vite HMR dev server)
  if ('serviceWorker' in navigator && window.location.protocol !== 'file:') {
    const isLocalDev =
      window.location.hostname === 'localhost' && window.location.port === '5173';
    if (!isLocalDev) {
      const registerSw = () => {
        navigator.serviceWorker
          .register(`${base}sw.js`, { scope: base })
          .then(async () => {
            const reg = await navigator.serviceWorker.ready;
            const sw = reg?.active || navigator.serviceWorker.controller;
            if (!sw) return;
            const urlSet = new Set();
            document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach((el) => {
              const u = el.src || el.href;
              if (u && u.startsWith(window.location.origin)) urlSet.add(u);
            });
            for (const entry of performance.getEntriesByType?.('resource') || []) {
              const u = entry.name;
              if (
                u &&
                u.startsWith(window.location.origin) &&
                (u.includes('/assets/') || u.endsWith('/title-hero.webp')) &&
                /\.(js|css|svg|png|webp|avif|glb)$/i.test(u)
              ) {
                urlSet.add(u);
              }
            }
            if (urlSet.size) {
              sw.postMessage({ type: 'CACHE_URLS', urls: [...urlSet] });
            }
          })
          .catch((err) => {
            console.warn('[pwa] service worker registration failed:', err);
          });
      };
      if (document.readyState === 'complete') {
        registerSw();
      } else {
        window.addEventListener('load', registerSw, { once: true });
      }
    }
  }

  const installListeners = new Set();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    for (const fn of installListeners) fn(true);
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    for (const fn of installListeners) fn(false);
  });

  return {
    canInstall: () => Boolean(deferredInstallPrompt),
    onInstallChange(fn) {
      installListeners.add(fn);
      return () => installListeners.delete(fn);
    },
    async promptInstall() {
      if (!deferredInstallPrompt) return false;
      deferredInstallPrompt.prompt();
      const res = await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      for (const fn of installListeners) fn(false);
      return res?.outcome === 'accepted';
    },
  };
}
