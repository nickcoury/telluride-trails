/**
 * Shared asset loader with concurrency limit, smart retries (no 4xx retry storms),
 * and bounded LRU JSON cache.
 */
export function createAssetLoader({ baseUrl = '/', maxConcurrent = 6, maxJsonCache = 128 } = {}) {
  const jsonCache = new Map();
  let active = 0;
  /** @type {Array<() => void>} */
  const waiters = [];

  function acquire() {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  }

  function resolveUrl(path) {
    if (/^https?:\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
      return path;
    }
    const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${cleanBase}${cleanPath}`;
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 429 || status >= 500;
  }

  async function fetchWithRetry(url, { signal, retries = 2 } = {}) {
    await acquire();
    try {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetch(url, { signal });
          if (!res.ok) {
            const err = new Error(`HTTP ${res.status} for ${url}`);
            err.status = res.status;
            if (!isRetryableStatus(res.status)) throw err;
            throw err;
          }
          return res;
        } catch (err) {
          lastErr = err;
          const nonRetryable = typeof err?.status === 'number' && !isRetryableStatus(err.status);
          if (signal?.aborted || nonRetryable || attempt === retries) throw err;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        }
      }
      throw lastErr;
    } finally {
      release();
    }
  }

  async function fetchJson(path, { cache = true, signal, retries = 2 } = {}) {
    const url = resolveUrl(path);
    if (cache && jsonCache.has(url)) {
      const hit = jsonCache.get(url);
      jsonCache.delete(url);
      jsonCache.set(url, hit);
      return hit;
    }
    const promise = fetchWithRetry(url, { signal, retries }).then((r) => r.json());
    if (cache) {
      jsonCache.set(url, promise);
      while (jsonCache.size > maxJsonCache) {
        const oldestKey = jsonCache.keys().next().value;
        jsonCache.delete(oldestKey);
      }
    }
    try {
      return await promise;
    } catch (err) {
      if (cache) jsonCache.delete(url);
      throw err;
    }
  }

  async function fetchBuffer(path, { signal, retries = 2 } = {}) {
    const res = await fetchWithRetry(resolveUrl(path), { signal, retries });
    return res.arrayBuffer();
  }

  async function loadImageBitmap(path, { signal, retries = 2, premultiplyAlpha = 'default' } = {}) {
    const res = await fetchWithRetry(resolveUrl(path), { signal, retries });
    const blob = await res.blob();
    return createImageBitmap(blob, { premultiplyAlpha });
  }

  return {
    resolveUrl,
    fetchJson,
    fetchBuffer,
    loadImageBitmap,
  };
}
