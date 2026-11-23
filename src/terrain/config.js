/**
 * Terrain renderer configuration, data source endpoints, and per-tier LOD/cache budgets.
 */

export const TERRAIN_SOURCES = {
  // Local manifest paths (relative to engine.assetsBase) produced by @terraindata
  localManifests: {
    terrain: 'data/terrain/manifest.json',
    imagery: 'data/imagery/manifest.json',
    cover: 'data/cover/manifest.json',
  },
  // Remote fallbacks used when local manifests are absent or outside local coverage
  allowRemoteFallback: true,
  remoteTerrainUrl: (z, x, y) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  remoteImageryUrl: (z, x, y) =>
    `https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/${z}/${y}/${x}`,
};

// Region covering Telluride + San Juans + 110 km skyline ring (matches terraindata horizon bounds)
export const REGION_BOUNDS = {
  west: -109.05,
  south: 36.95,
  east: -106.55,
  north: 38.9,
};

// Base elevation bounds (meters) used for conservative AABB before a tile loads
export const DEFAULT_MIN_ELEV_M = 1800;
export const DEFAULT_MAX_ELEV_M = 4450;

export const TERRAIN_TIER_CONFIG = {
  low: {
    patchGridSize: 24,
    minQuadZoom: 9,
    maxQuadZoom: 16,
    maxTerrainZoom: 14,
    maxImageryZoom: 15,
    maxCoverZoom: 13,
    lodDistanceFactor: 1.25,
    detailDrawDistance: 16000,
    horizonDrawDistance: 62000,
    detailLayers: 1, // minimal-fetch single dominant albedo modulation
    useNormalMaps: false,
    useTriplanar: false,
    useTrailMask: true,
    trailMaskSize: 128,
    trailMaskZoom: 15,
    trailMaskNearZoom: 15,
    castShadowRadiusM: 0,
    lruMaxBytes: 40 * 1024 * 1024,
    uploadsPerFrame: 2,
    maxConcurrentFetches: 4,
  },
  medium: {
    patchGridSize: 36,
    minQuadZoom: 9,
    maxQuadZoom: 16,
    maxTerrainZoom: 15,
    maxImageryZoom: 16,
    maxCoverZoom: 14,
    lodDistanceFactor: 1.45,
    detailDrawDistance: 34000,
    horizonDrawDistance: 66000,
    detailLayers: 2,
    useNormalMaps: true,
    useTriplanar: true,
    useTrailMask: true,
    trailMaskSize: 256,
    trailMaskZoom: 16,
    trailMaskNearZoom: 16,
    castShadowRadiusM: 0,
    lruMaxBytes: 64 * 1024 * 1024,
    uploadsPerFrame: 3,
    maxConcurrentFetches: 6,
  },
  high: {
    patchGridSize: 48,
    minQuadZoom: 9,
    maxQuadZoom: 17,
    maxTerrainZoom: 15,
    maxImageryZoom: 17,
    maxCoverZoom: 14,
    lodDistanceFactor: 1.55,
    detailDrawDistance: 52000,
    horizonDrawDistance: 72000,
    detailLayers: 3,
    useNormalMaps: true,
    useTriplanar: true,
    useTrailMask: true,
    trailMaskSize: 512,
    trailMaskZoom: 16,
    trailMaskNearZoom: 17,
    castShadowRadiusM: 1800,
    lruMaxBytes: 128 * 1024 * 1024,
    uploadsPerFrame: 5,
    maxConcurrentFetches: 8,
  },
  ultra: {
    patchGridSize: 64,
    minQuadZoom: 9,
    maxQuadZoom: 17,
    maxTerrainZoom: 15,
    maxImageryZoom: 17,
    maxCoverZoom: 14,
    lodDistanceFactor: 1.8,
    detailDrawDistance: 68000,
    horizonDrawDistance: 85000,
    detailLayers: 3,
    useNormalMaps: true,
    useTriplanar: true,
    useTrailMask: true,
    trailMaskSize: 512,
    trailMaskZoom: 16,
    trailMaskNearZoom: 17,
    castShadowRadiusM: 3200,
    lruMaxBytes: 192 * 1024 * 1024,
    uploadsPerFrame: 6,
    maxConcurrentFetches: 10,
  },
};

export function getTierConfig(tier) {
  return TERRAIN_TIER_CONFIG[tier] || TERRAIN_TIER_CONFIG.medium;
}
