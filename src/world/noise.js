/**
 * Deterministic hashing, PRNG, and procedural noise helpers for world placement.
 */

/**
 * Hash two integer cell coordinates and a salt into an unsigned 32-bit integer.
 * @param {number} ix
 * @param {number} iz
 * @param {number} [salt=0]
 * @returns {number}
 */
export function hash2i(ix, iz, salt = 0) {
  let h = (ix * 374761393 + iz * 668265263 + salt * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Fast seeded PRNG returning floats in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashFloat(ix, iz, salt = 0) {
  return hash2i(ix, iz, salt) / 4294967296;
}

/**
 * Smooth 2D value noise in [0, 1].
 * @param {number} x
 * @param {number} z
 * @param {number} [salt=0]
 * @returns {number}
 */
export function noise2D(x, z, salt = 0) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);

  const a = hashFloat(ix, iz, salt);
  const b = hashFloat(ix + 1, iz, salt);
  const c = hashFloat(ix, iz + 1, salt);
  const d = hashFloat(ix + 1, iz + 1, salt);

  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/**
 * Multi-octave 2D fBm noise in [0, 1].
 * @param {number} x
 * @param {number} z
 * @param {number} [octaves=3]
 * @param {number} [salt=0]
 * @returns {number}
 */
export function fbm2D(x, z, octaves = 3, salt = 0) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(x * freq, z * freq, salt + i * 97);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
