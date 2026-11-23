/**
 * Astronomical sun and moon position calculator for Telluride, CO.
 * World axes: +X = East, +Y = Up, -Z = North (+Z = South).
 */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export const TELLURIDE_LAT = 37.9375;
export const TELLURIDE_LON = -107.8123;

/**
 * Convert Julian days since J2000.0 from a JS Date.
 * @param {Date} date
 * @returns {number}
 */
function toDaysJ2000(dateOrMs) {
  const ms = typeof dateOrMs === 'number' ? dateOrMs : dateOrMs.getTime();
  return ms / 86400000 - 10957.5;
}

/**
 * Convert astronomical azimuth (radians clockwise from North) & altitude (radians above horizon)
 * to a normalized Three.js direction vector (+X east, +Y up, -Z north).
 * @param {number} azimuthRad
 * @param {number} altitudeRad
 * @param {{x:number, y:number, z:number}} [out]
 * @returns {{x:number, y:number, z:number}}
 */
function azAltToDir(azimuthRad, altitudeRad, out = { x: 0, y: 1, z: 0 }) {
  const cosAlt = Math.cos(altitudeRad);
  out.x = cosAlt * Math.sin(azimuthRad);
  out.y = Math.sin(altitudeRad);
  out.z = -cosAlt * Math.cos(azimuthRad);
  return out;
}

/**
 * Compute Sun direction, altitude, azimuth, and Moon direction/phase for a Date.
 * Based on Meeus / SunCalc simplified solar & lunar orbital elements (accurate to ~0.01°-0.3°).
 * @param {Date} date
 * @param {number} [latDeg=TELLURIDE_LAT]
 * @param {number} [lonDeg=TELLURIDE_LON]
 */
export function getCelestialPositions(dateOrMs, latDeg = TELLURIDE_LAT, lonDeg = TELLURIDE_LON, out = null) {
  const d = toDaysJ2000(dateOrMs);
  const phi = latDeg * DEG2RAD;
  const lw = -lonDeg * DEG2RAD; // west longitude positive in SunCalc convention

  const e = 23.4397 * DEG2RAD; // obliquity of the ecliptic

  // --- Sun ---
  const M = (357.5291 + 0.98560028 * d) * DEG2RAD;
  const C = (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) * DEG2RAD;
  const P = 102.9372 * DEG2RAD;
  const L = M + C + P + Math.PI;

  const sunDec = Math.asin(Math.sin(e) * Math.sin(L));
  const sunRA = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));

  const siderealTime = (280.16 + 360.9856235 * d) * DEG2RAD - lw;
  const sunH = siderealTime - sunRA;

  const sunAlt = Math.asin(
    Math.sin(phi) * Math.sin(sunDec) + Math.cos(phi) * Math.cos(sunDec) * Math.cos(sunH)
  );
  // Azimuth measured from South in SunCalc -> convert to clockwise from North (+PI)
  const sunAzSouth = Math.atan2(
    Math.sin(sunH),
    Math.cos(sunH) * Math.sin(phi) - Math.tan(sunDec) * Math.cos(phi)
  );
  const sunAz = sunAzSouth + Math.PI;

  // --- Moon ---
  const moonL = (218.316 + 13.176396 * d) * DEG2RAD;
  const moonM = (134.963 + 13.064993 * d) * DEG2RAD;
  const moonF = (93.272 + 13.229350 * d) * DEG2RAD;

  const moonLon = moonL + 6.289 * DEG2RAD * Math.sin(moonM);
  const moonLat = 5.128 * DEG2RAD * Math.sin(moonF);

  const moonRA = Math.atan2(
    Math.sin(moonLon) * Math.cos(e) - Math.tan(moonLat) * Math.sin(e),
    Math.cos(moonLon)
  );
  const moonDec = Math.asin(
    Math.sin(moonLat) * Math.cos(e) + Math.cos(moonLat) * Math.sin(e) * Math.sin(moonLon)
  );
  const moonH = siderealTime - moonRA;
  const moonAlt = Math.asin(
    Math.sin(phi) * Math.sin(moonDec) + Math.cos(phi) * Math.cos(moonDec) * Math.cos(moonH)
  );
  const moonAzSouth = Math.atan2(
    Math.sin(moonH),
    Math.cos(moonH) * Math.sin(phi) - Math.tan(moonDec) * Math.cos(phi)
  );
  const moonAz = moonAzSouth + Math.PI;

  // Lunar illuminated fraction (0 = new, 1 = full)
  const sunMoonAngle = Math.acos(
    Math.max(-1, Math.min(1,
      Math.sin(sunDec) * Math.sin(moonDec) +
      Math.cos(sunDec) * Math.cos(moonDec) * Math.cos(sunRA - moonRA)
    ))
  );
  const moonPhase = 0.5 * (1 - Math.cos(sunMoonAngle));

  const res = out || { sunDir: { x: 0, y: 1, z: 0 }, moonDir: { x: 0, y: 1, z: 0 } };
  azAltToDir(sunAz, sunAlt, res.sunDir);
  azAltToDir(moonAz, moonAlt, res.moonDir);
  res.sunAltDeg = sunAlt * RAD2DEG;
  res.sunAzDeg = ((sunAz * RAD2DEG) % 360 + 360) % 360;
  res.moonAltDeg = moonAlt * RAD2DEG;
  res.moonPhase = moonPhase;
  res.localSolarHour = (((sunH * RAD2DEG) / 15 + 12) % 24 + 24) % 24;
  return res;
}
