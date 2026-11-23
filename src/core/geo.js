/**
 * World-space projection and Web Mercator tile math for Telluride Trails.
 * Scaled Web Mercator anchored at Telluride so map tiles are exact squares in world meters.
 */

export const LAT0 = 37.9375;
export const LON0 = -107.8123;

export const BBOX = Object.freeze({
  west: -108.02,
  south: 37.68,
  east: -107.25,
  north: 38.10,
});

export const R = 6378137;
export const K = Math.cos((LAT0 * Math.PI) / 180);

export const M_TO_FT = 3.28084;
export const FT_TO_M = 1 / M_TO_FT;
export const M_TO_MI = 1 / 1609.344;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const HALF_CIRCUMFERENCE = Math.PI * R;

function mercatorX(lonDeg) {
  return R * lonDeg * DEG_TO_RAD;
}

function mercatorY(latDeg) {
  const latRad = latDeg * DEG_TO_RAD;
  return R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
}

const MX0 = mercatorX(LON0);
const MY0 = mercatorY(LAT0);

/**
 * Convert WGS84 longitude/latitude (degrees) to Three.js world XZ (meters; +X east, -Z north).
 * @param {number} lon
 * @param {number} lat
 * @returns {{ x: number, z: number }}
 */
export function lonLatToWorld(lon, lat) {
  return {
    x: (mercatorX(lon) - MX0) * K,
    z: -(mercatorY(lat) - MY0) * K,
  };
}

/**
 * Convert Three.js world XZ (meters) back to WGS84 longitude/latitude (degrees).
 * @param {number} x
 * @param {number} z
 * @returns {{ lon: number, lat: number }}
 */
export function worldToLonLat(x, z) {
  const mx = x / K + MX0;
  const my = -z / K + MY0;
  const lon = (mx / R) * RAD_TO_DEG;
  const lat = (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * RAD_TO_DEG;
  return { lon, lat };
}

/**
 * Return exact world-space square bounds for Web Mercator tile (z, x, y).
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {{ minX: number, maxX: number, minZ: number, maxZ: number }}
 */
export function tileBoundsWorld(z, x, y) {
  const n = 2 ** z;
  const tileMercSize = (2 * HALF_CIRCUMFERENCE) / n;

  const mxLeft = -HALF_CIRCUMFERENCE + x * tileMercSize;
  const mxRight = mxLeft + tileMercSize;
  const myTop = HALF_CIRCUMFERENCE - y * tileMercSize;
  const myBottom = myTop - tileMercSize;

  return {
    minX: (mxLeft - MX0) * K,
    maxX: (mxRight - MX0) * K,
    minZ: -(myTop - MY0) * K,
    maxZ: -(myBottom - MY0) * K,
  };
}

/**
 * Return Web Mercator tile indices containing world coordinates (x, z) at zoom.
 * @param {number} x
 * @param {number} z
 * @param {number} zoom
 * @returns {{ z: number, x: number, y: number }}
 */
export function worldToTile(x, z, zoom) {
  const n = 2 ** zoom;
  const mx = x / K + MX0;
  const my = -z / K + MY0;
  const u = (mx / HALF_CIRCUMFERENCE + 1) * 0.5;
  const v = (1 - my / HALF_CIRCUMFERENCE) * 0.5;
  const tx = Math.max(0, Math.min(n - 1, Math.floor(u * n)));
  const ty = Math.max(0, Math.min(n - 1, Math.floor(v * n)));
  return { z: zoom, x: tx, y: ty };
}
