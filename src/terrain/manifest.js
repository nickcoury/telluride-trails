import { REGION_BOUNDS, TERRAIN_SOURCES } from './config.js';

function tileCenterLonLat(z, x, y) {
  const n = 2 ** z;
  const lon = ((x + 0.5) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lon, lat };
}

function inBounds(lon, lat, bounds) {
  if (!bounds) return false;
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

/**
 * Check if tile (z, x, y) is listed in a terraindata manifest.json.
 * Supports both `{ full: true, xMin, xMax, yMin, yMax }` and
 * `{ full: false, rows: { "<y>": [x0, x1, ...] } }` inclusive span pairs.
 */
export function manifestHasTile(manifest, z, x, y) {
  if (!manifest || !manifest.tiles) return false;
  const level = manifest.tiles[String(z)];
  if (!level) return false;
  if (x < level.xMin || x > level.xMax || y < level.yMin || y > level.yMax) {
    return false;
  }
  if (level.full) return true;
  const spans = level.rows?.[String(y)];
  if (!spans || spans.length === 0) return false;
  for (let i = 0; i < spans.length; i += 2) {
    if (x >= spans[i] && x <= spans[i + 1]) return true;
  }
  return false;
}

/**
 * Load all available local raster manifests in parallel.
 * Missing manifests return null so remote fallback works seamlessly.
 */
export async function loadManifests(assetsBase = '/') {
  const base = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;
  const kinds = ['terrain', 'imagery', 'cover'];
  const entries = await Promise.all(
    kinds.map(async (kind) => {
      const url = `${base}${TERRAIN_SOURCES.localManifests[kind]}`;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return [kind, null];
        const json = await res.json();
        return [kind, json];
      } catch {
        return [kind, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Resolve fetch URL for a tile, preferring local manifest assets and falling back
 * to remote Terrarium/USGS endpoints when local data is absent or outside local bbox.
 * @returns {{ url: string, source: 'local'|'remote', ext: string } | null}
 */
export function resolveTileSource(kind, z, x, y, manifests, assetsBase = '/') {
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return null;

  const base = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`;
  const manifest = manifests?.[kind] || null;
  const { lon, lat } = tileCenterLonLat(z, x, y);

  if (manifest) {
    if (manifestHasTile(manifest, z, x, y)) {
      const ext = manifest.ext || (kind === 'cover' ? 'png' : 'webp');
      return {
        url: `${base}data/${kind}/${z}/${x}/${y}.${ext}`,
        source: 'local',
        ext,
      };
    }
    // Inside local manifest bbox: do not hit remote for absent corridor/zoom tiles;
    // quadtree will naturally use the resident parent zoom from local data.
    if (inBounds(lon, lat, manifest.bounds) && z >= (manifest.minZoom ?? 8)) {
      return null;
    }
  }

  if (!TERRAIN_SOURCES.allowRemoteFallback) return null;
  if (!inBounds(lon, lat, REGION_BOUNDS)) return null;

  // Outside local manifest bbox (distant 60km horizon ring), cap remote fetches at z <= 12
  if (manifest && z > 12) return null;

  if (kind === 'terrain') {
    return { url: TERRAIN_SOURCES.remoteTerrainUrl(z, x, y), source: 'remote', ext: 'png' };
  }
  if (kind === 'imagery') {
    return { url: TERRAIN_SOURCES.remoteImageryUrl(z, x, y), source: 'remote', ext: 'jpg' };
  }
  return null;
}
