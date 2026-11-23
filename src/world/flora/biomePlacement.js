import { fbm2D } from '../noise.js';

/**
 * Ecological San Juan Mountain species selector for a candidate tree/shrub point.
 * Driven by NLCD+NAIP cover (`terrain.getSurface`), slope (`normal.y`), solar aspect
 * (`normal.z` — south-facing slopes favor Telluride clonal aspen groves; north-facing
 * slopes favor dense Engelmann spruce & subalpine fir), elevation, and waterways.
 *
 * Species IDs:
 *   0 = Engelmann Spruce (broad tiered conifer)
 *   1 = Subalpine Fir (narrow Gothic spire conifer)
 *   2 = Quaking Aspen (white-barked clonal grove)
 *   3 = Riparian Willow Thicket (multi-stem creek/wetland shrub)
 *   4 = Treeline Krummholz (wind-flagged alpine timberline conifer)
 *
 * @param {number} x
 * @param {number} z
 * @param {number} y - elevation in meters
 * @param {{ x: number, y: number, z: number }} norm
 * @param {{ forest: number, rock: number, water: number, snow: number, grass: number }} surf
 * @param {{ found: boolean, dist: number, halfW: number, isRiver: boolean, hasName: boolean }} ww
 * @param {boolean} onSkiRun
 * @param {() => number} rng
 * @param {boolean} isNearFill - true for high-density understory/clonal fill ring
 */
export function pickSanJuanTree(x, z, y, norm, surf, ww, onSkiRun, rng, isNearFill = false) {
  const normalY = norm.y;
  // Never place trees in open water, deep snow couloirs, on sheer rock cliffs, or high above treeline
  if (surf.water > 0.16 || surf.snow > 0.35 || normalY < 0.54 || y > 3710) return null;

  // 1. RIPARIAN WILLOW THICKETS along creeks, rivers & NLCD valley wetlands (even on ski-run drainages!)
  if (y < 3490 && normalY > 0.72) {
    const nearStreamBank = ww.found && ww.dist >= ww.halfW + 0.7 && ww.dist <= ww.halfW + (ww.isRiver ? 13.5 : 9.0);
    const isWetland = surf.water >= 0.04 && surf.water <= 0.16 && surf.grass > 0.45 && normalY > 0.86;
    const isValleyMeadowSwale =
      y < 2760 && normalY > 0.94 && surf.grass > 0.55 && surf.forest < 0.35 && fbm2D(x * 0.009, z * 0.009, 2, 419) > 0.62;

    if (nearStreamBank || isWetland || isValleyMeadowSwale) {
      const bankProximity = nearStreamBank
        ? Math.max(0.25, 1.0 - (ww.dist - ww.halfW) / (ww.isRiver ? 13.5 : 9.0))
        : isWetland ? 0.65 : 0.30;
      const clumpNoise = fbm2D(x * 0.024, z * 0.024, 2, 613);
      if (clumpNoise > 0.34 && rng() < bankProximity * (isNearFill ? 0.88 : 0.65)) {
        const h = 1.65 + rng() * 1.85;
        const w = h * (1.18 + rng() * 0.45);
        const shade = 0.86 + rng() * 0.24;
        return {
          kind: 3,
          h,
          w,
          rot: rng() * Math.PI * 2,
          r: shade * 0.92,
          g: shade * 1.02,
          b: shade * 0.88,
        };
      }
    }
  }

  // Keep tall forest trees off groomed Telluride ski runs (willows in drainages above are fine)
  if (onSkiRun) return null;

  const hasCoverData =
    surf.forest + surf.rock + surf.water + surf.snow + surf.grass > 0.05;
  const rawForest = hasCoverData
    ? surf.forest
    : y < 3600 ? Math.max(0, (fbm2D(x * 0.0022, z * 0.0022, 3, 19) - 0.30) * 1.45) : 0;

  // 2. TREELINE KRUMMHOLZ (~11,220 - 12,170 ft / 3,420 - 3,710 m)
  if (y > 3420) {
    const treelineFade = Math.max(0, 1.0 - (y - 3420) / 290);
    // Krummholz clusters in leeward pockets along rocky/tundra timberline
    const kNoise = fbm2D(x * 0.011, z * 0.011, 3, 911);
    const chance = Math.max(rawForest * 0.9, 0.26) * treelineFade * (kNoise > 0.40 ? 0.92 : 0.22);
    if (normalY < 0.62 || surf.rock > 0.82 || rng() > chance) return null;

    const h = (1.05 + rng() * 1.35) * (0.65 + treelineFade * 0.45);
    const shade = 0.82 + rng() * 0.24;
    // Consistently wind-flagged leeward (predominant WSW -> ENE San Juan ridgetop wind)
    return {
      kind: 4,
      h,
      w: h * (1.25 + rng() * 0.45),
      rot: 0.35 + (rng() - 0.5) * 0.55,
      r: shade * 0.90,
      g: shade * 0.96,
      b: shade * 0.84,
    };
  }

  // Aspect cue: +Z is South in Three.js world space -> normal.z > 0 means sunlit south-facing slope!
  // (Jud Wiebe north canyon wall faces +Z south -> prime Telluride Quaking Aspen belt!)
  const southAspect = Math.max(-1, Math.min(1, norm.z * 2.2));
  const clonalMacro = fbm2D(x * 0.0036, z * 0.0036, 3, 503);
  const clonalDetail = fbm2D(x * 0.011, z * 0.011, 2, 709);
  const clonalSignal = clonalMacro * 0.72 + clonalDetail * 0.28;

  // 3. QUAKING ASPEN CLONAL GROVES (mid slopes ~8,100 - 10,950 ft / 2,470 - 3,340 m)
  // Triggered strongly by NLCD deciduous/mixed signature (forest >= 0.16 && grass >= 0.22)
  // AND south/west-facing mid-elevation sunny slopes (Jud Wiebe, lower Bear Creek).
  const inAspenElev = y >= 2460 && y <= 3340 && normalY > 0.68 && surf.rock < 0.48;
  if (inAspenElev) {
    // NLCD class 41 (Deciduous Aspen) encodes forest~0.78, grass~0.32 vs Evergreen forest~0.94, grass~0.10
    const deciduousRatio = rawForest > 0.08 ? surf.grass / (rawForest + surf.grass + 0.05) : 0;
    const aspectBonus = southAspect > -0.12 ? 0.14 * Math.max(0, southAspect + 0.12) : -0.10;
    const deciduousBonus = deciduousRatio > 0.22 && rawForest > 0.14 ? 0.16 : 0;
    const aspenScore = clonalSignal + aspectBonus + deciduousBonus;

    // Allow clonal aspen pockets on sunlit aspen-meadow edges (like Jud Wiebe where forest~0.20, grass~0.72)
    const allowEdgeGrove = rawForest >= 0.15 || (southAspect > 0.15 && surf.grass > 0.45 && clonalMacro > 0.56);
    if (allowEdgeGrove && aspenScore > 0.55) {
      const groveDensity = Math.min(0.95, (aspenScore - 0.52) * 2.6 * Math.max(0.45, rawForest * 1.35));
      if (rng() < groveDensity) {
        // Multi-age clonal stems: tall mature trees + slender younger grove stems in nearFill
        const h = isNearFill
          ? 6.8 + rng() * 6.8
          : 9.5 + rng() * 6.5;
        const w = h * (0.72 + rng() * 0.24);
        // July Telluride aspen foliage: sunlit fresh emerald-lime with subtle clone-to-clone hue variation
        const cloneHue = fbm2D(x * 0.0028, z * 0.0028, 2, 823);
        const shade = 0.88 + rng() * 0.22;
        return {
          kind: 2,
          h,
          w,
          rot: rng() * Math.PI * 2,
          r: shade * (0.90 + cloneHue * 0.18),
          g: shade * (0.98 + cloneHue * 0.08),
          b: shade * (0.86 - cloneHue * 0.08),
        };
      }
    }
  }

  // 4. ENGELMANN SPRUCE & SUBALPINE FIR STANDS
  // Natural nonlinear forest density curve so forest=0.25..0.50 produces clumped subalpine groves
  // and forest=0.75..1.0 produces true lush closed-canopy Colorado spruce-fir forest!
  if (rawForest < 0.12 || surf.rock > 0.68) return null;

  const pocketNoise = fbm2D(x * 0.013, z * 0.013, 2, 271);
  // Clump sparser edge forest into natural pockets instead of uniform lonely trees
  const effectiveForest = rawForest < 0.50
    ? rawForest * (0.55 + pocketNoise * 1.15)
    : Math.min(1.0, 0.52 + (rawForest - 0.50) * 0.96);

  const acceptProb = Math.min(0.96, effectiveForest * (isNearFill ? 1.05 : 1.12));
  if (rng() > acceptProb) return null;

  // Species mix: Subalpine Fir (narrow Gothic spire) increases with elevation & shaded north slopes!
  const firBias =
    (y > 3020 ? 0.46 : 0.28) +
    (southAspect < 0 ? Math.min(0.16, -southAspect * 0.16) : -0.06);
  const isFir = rng() < firBias;

  // Natural height tapering near treeline + multi-age vertical layering in nearFill
  const elevShrink = y > 3180 ? Math.max(0.42, 1.0 - ((y - 3180) / 340) * 0.52) : 1.0;
  const baseH = isNearFill
    ? (5.5 + Math.pow(rng(), 0.78) * 14.5) // young saplings + mid-canopy trees
    : (11.5 + rng() * 11.5);               // towering mature 11.5-23m spruce & fir!
  const h = baseH * elevShrink;
  const w = h * (isFir ? 0.78 + rng() * 0.22 : 0.88 + rng() * 0.24);

  const shade = 0.84 + rng() * 0.30;
  return {
    kind: isFir ? 1 : 0,
    h,
    w,
    rot: rng() * Math.PI * 2,
    r: shade * (isFir ? 0.92 : 0.96),
    g: shade * (isFir ? 0.99 : 1.02),
    b: shade * (isFir ? 1.02 : 0.94),
  };
}

/**
 * Ecological ground flora selector (meadow grass, golden sedge, Colorado blue columbine,
 * scarlet Indian paintbrush, purple mountain lupine, alpine tundra cushions, woodland ferns,
 * heartleaf arnica). Uses coherent fBm wildflower drifts so flowers bloom in realistic patches!
 *
 * Tile IDs (matching GROUND_FLORA_RECTS 0..7):
 *   0 = Lush green mountain fescue grass
 *   1 = Golden alpine sedge
 *   2 = Colorado Blue Columbine
 *   3 = Scarlet Indian Paintbrush
 *   4 = Mountain Lupine (purple spires)
 *   5 = Alpine Tundra Cushion + Golden Alpine Avens (>11,350 ft)
 *   6 = Woodland Fern & Grouse Whortleberry (under conifer forest canopy)
 *   7 = Heartleaf Arnica / Aspen Sunflowers
 */
export function pickGroundFlora(x, z, y, norm, surf, ww, rng) {
  if (y > 4160 || norm.y < 0.62) return null;
  if (surf.water > 0.12 || surf.snow > 0.35 || surf.rock > 0.76) return null;

  // Above treeline (~11,350 ft / 3,460 m): Ice Lake Basin & Imogene Pass alpine tundra cushions!
  if (y > 3460) {
    const tundraFactor = Math.max(0, Math.min(1, surf.grass * 1.15 - surf.rock * 0.45));
    // Even on rocky passes like Imogene (rock~0.93, grass~0.07), allow sparse sheltered cushions where grass>0.04
    const prob = y > 3850
      ? Math.max(0, (surf.grass - 0.03) * 1.8)
      : Math.max(0.10, tundraFactor * 0.95);
    if (rng() > prob) return null;

    const drift = fbm2D(x * 0.045, z * 0.045, 2, 1301);
    let kind = 5; // Alpine tundra tuft + golden avens
    if (y < 3820 && drift > 0.56 && rng() < 0.40) {
      // Sheltered alpine wildflower pockets in Ice Lake Basin (columbine & scarlet paintbrush!)
      kind = rng() < 0.54 ? 2 : 3;
    } else if (rng() < 0.42) {
      kind = 1; // Short golden alpine sedge
    }

    const isCushion = kind === 5;
    const h = isCushion ? 0.28 + rng() * 0.16 : 0.34 + rng() * 0.22;
    const w = isCushion ? 0.64 + rng() * 0.30 : 0.68 + rng() * 0.32;
    const shade = 0.88 + rng() * 0.26;
    return { kind, w, h, rot: rng() * Math.PI, r: shade, g: shade * 1.04, b: shade * 0.96 };
  }

  // Below treeline: Dense spruce/fir forest floor vs sunlit aspen/meadow wildflower carpet!
  const inDenseForest = surf.forest > 0.55 && surf.grass < 0.35;
  const vegCover = Math.max(surf.grass, surf.forest * 0.78);
  if (vegCover < 0.10 || rng() > Math.min(0.97, vegCover * 1.22)) return null;

  if (inDenseForest) {
    // Subalpine forest floor: lush woodland ferns / whortleberry undergrowth + shade sedge + occasional columbine!
    const patch = fbm2D(x * 0.055, z * 0.055, 2, 1607);
    let kind;
    if (patch > 0.40 && rng() < 0.65) {
      kind = 6; // Woodland fern & grouse whortleberry
    } else if (patch > 0.62 && rng() < 0.24) {
      kind = 2; // Shade-loving Colorado Blue Columbine!
    } else {
      kind = rng() < 0.68 ? 0 : 1;
    }
    const h = kind === 6 ? 0.44 + rng() * 0.30 : 0.40 + rng() * 0.26;
    const w = kind === 6 ? 0.96 + rng() * 0.52 : 0.86 + rng() * 0.42;
    const shade = 0.82 + rng() * 0.26;
    return { kind, w, h, rot: rng() * Math.PI, r: shade * 0.96, g: shade * 1.04, b: shade * 0.94 };
  }

  // Sunlit Mountain Meadows, Aspen Understory, Ski Runs & Valley Floor (Telluride July Wildflower Peak!)
  const flowerDriftA = fbm2D(x * 0.036, z * 0.036, 2, 2003);
  const flowerDriftB = fbm2D(x * 0.042 + 31.7, z * 0.042 - 19.3, 2, 2311);
  const nearWater = ww.found && ww.dist < ww.halfW + 10.0;

  let kind;
  if (flowerDriftA > 0.55 && rng() < 0.56) {
    // Coherent wildflower drift: Lupine, Columbine, or Paintbrush!
    if (flowerDriftB > 0.58) kind = 4;      // Purple Mountain Lupine drift
    else if (flowerDriftB > 0.42) kind = 3; // Scarlet Indian Paintbrush drift
    else kind = 2;                          // Colorado Blue Columbine drift
  } else if (flowerDriftB > 0.58 && rng() < 0.42) {
    kind = 7; // Golden Heartleaf Arnica / Aspen Sunflowers
  } else if (nearWater && rng() < 0.34) {
    kind = 6; // Lush streamside ferns
  } else {
    kind = rng() < 0.66 ? 0 : 1; // Rich green fescue & golden alpine sedge carpet
  }

  const isFlower = kind === 2 || kind === 3 || kind === 4 || kind === 7;
  const h = isFlower ? 0.50 + rng() * 0.30 : 0.46 + rng() * 0.36;
  const w = isFlower ? 0.88 + rng() * 0.42 : 1.02 + rng() * 0.52;
  const shade = 0.90 + rng() * 0.24;
  return { kind, w, h, rot: rng() * Math.PI, r: shade, g: shade * 1.03, b: shade * 0.96 };
}
