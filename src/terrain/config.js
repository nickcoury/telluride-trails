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
    patchGridSize: 20,
    minQuadZoom: 9,
    maxQuadZoom: 15,
    maxTerrainZoom: 14,
    maxImageryZoom: 15,
    maxCoverZoom: 13,
    lodDistanceFactor: 0.88,
    detailDrawDistance: 8000,
    horizonDrawDistance: 44000,
    detailLayers: 1, // minimal-fetch single dominant albedo modulation
    useNormalMaps: false,
    useTriplanar: false,
    useTrailMask: true,
    trailMaskSize: 128,
    trailMaskMaxCount: 10,
    trailMaskZoom: 15,
    trailMaskNearZoom: 15,
    castShadowRadiusM: 0,
    lruMaxBytes: 18 * 1024 * 1024, // keeps total scene VRAM (incl. detail/world/trail) well under 40 MB
    uploadsPerFrame: 2,
    maxConcurrentFetches: 4,
  },
  medium: {
    patchGridSize: 32,
    minQuadZoom: 9,
    maxQuadZoom: 16,
    maxTerrainZoom: 15,
    maxImageryZoom: 16,
    maxCoverZoom: 14,
    lodDistanceFactor: 0.92,
    detailDrawDistance: 11000,
    horizonDrawDistance: 50000,
    detailLayers: 2,
    useNormalMaps: true,
    useTriplanar: true,
    useTrailMask: true,
    trailMaskSize: 256,
    trailMaskMaxCount: 14,
    trailMaskZoom: 16,
    trailMaskNearZoom: 16,
    castShadowRadiusM: 0,
    lruMaxBytes: 24 * 1024 * 1024, // keeps total scene VRAM (incl. detail/world/trail) well under 64 MB
    uploadsPerFrame: 2,
    maxConcurrentFetches: 6,
  },
  high: {
    patchGridSize: 44,
    minQuadZoom: 9,
    maxQuadZoom: 17,
    maxTerrainZoom: 15,
    maxImageryZoom: 17,
    maxCoverZoom: 14,
    lodDistanceFactor: 1.48,
    detailDrawDistance: 52000,
    horizonDrawDistance: 72000,
    detailLayers: 3,
    useNormalMaps: true,
    useTriplanar: true,
    useTrailMask: true,
    trailMaskSize: 256, // 256px @ z17 (241m) = 0.94 m/px matching z17 NAIP, 4x faster & 4x less VRAM!
    trailMaskMaxCount: 20,
    trailMaskZoom: 16,
    trailMaskNearZoom: 17,
    castShadowRadiusM: 1800,
    lruMaxBytes: 82 * 1024 * 1024, // keeps total scene VRAM < 128 MB
    uploadsPerFrame: 4,
    maxConcurrentFetches: 8,
  },
  ultra: {
    patchGridSize: 48,
    minQuadZoom: 9,
    maxQuadZoom: 17,
    maxTerrainZoom: 15,
    maxImageryZoom: 17,
    maxCoverZoom: 14,
    lodDistanceFactor: 1.65,
    detailDrawDistance: 68000,
    horizonDrawDistance: 85000,
    detailLayers: 3,
    useNormalMaps: true,
    useTriplanar: true,
    useTrailMask: true,
    trailMaskSize: 256,
    trailMaskMaxCount: 24,
    trailMaskZoom: 16,
    trailMaskNearZoom: 17,
    castShadowRadiusM: 3200,
    lruMaxBytes: 136 * 1024 * 1024, // keeps total scene VRAM < 192 MB
    uploadsPerFrame: 5,
    maxConcurrentFetches: 10,
  },
};

export function getTierConfig(tier) {
  return TERRAIN_TIER_CONFIG[tier] || TERRAIN_TIER_CONFIG.medium;
}
