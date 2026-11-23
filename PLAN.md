# Telluride Trails — swarm build plan (the contract)

A **real-time** 3D trail running game set in Telluride, Colorado and the surrounding San Juan
Mountains (Hardrock 100 loop: Silverton → Telluride → Ouray → Lake City → Silverton).
Published at **https://nickcoury.github.io/telluride-trails/** (repo `nickcoury/telluride-trails`).
Sibling of `nickcoury/track24` ("A 24 hour track ultramarathon, in real time").

## Product pillars
1. **Real place.** Real elevation (USGS 3DEP via AWS Terrarium tiles), real public-domain
   orthoimagery (USGS National Map `USGSImageryOnly`, NAIP-derived), real trails/roads/rivers/
   lakes/waterfalls/peaks/buildings from OpenStreetMap (ODbL — attribute it), real land cover
   (NLCD, public domain). A Telluride local should say "yep, that's Bear Creek / Bridal Veil /
   the gondola / Imogene / Grant Swamp Pass".
2. **Real time, tongue-in-cheek.** 1 second of game = 1 second of life. Hardrock takes ~30-48 h.
   The game knows this is absurd and leans in: dry humor, "Estimated finish: Thursday",
   save & resume (localStorage), autopilot/cruise along a trail, an optional "Time Dilation"
   cheat that permanently stamps the result with an asterisk.
3. **Feels like a first-class mobile 3D game.** Polished menus, touch controls, haptics where
   available, smooth 60 fps on mid phones / stable 30+ on low-end with adaptive quality, no
   jank while streaming. Near-photoreal on desktop/high tier.
4. **Progressive loading.** Nothing big up front. Title screen < 1.5 MB total. Terrain,
   imagery, vectors stream by location in a quadtree, coarse-first.

## Region
- World origin: **Telluride, lat0 = 37.9375, lon0 = -107.8123**.
- Playable bbox (lon/lat): **W -108.02, S 37.68, E -107.25, N 38.10** (Telluride, Ophir,
  Lizard Head, Sneffels, Ouray, Silverton, Lake City, Handies, Engineer Pass).
- Highest detail around Telluride and along the Hardrock corridor + race routes.

## Coordinates (everyone uses `src/core/geo.js`)
Scaled Web Mercator so map tiles are exact squares in world space.
```
R = 6378137, k = cos(lat0)
mx(lon) = R * lon_rad ; my(lat) = R * ln(tan(pi/4 + lat_rad/2))
world.x =  (mx(lon) - mx(lon0)) * k        // east, meters
world.z = -(my(lat) - my(lat0)) * k        // three.js: -Z is north
world.y = elevation in meters above sea level (real, unscaled)
```
geo.js exports `lonLatToWorld(lon, lat) -> {x, z}`, `worldToLonLat(x, z) -> {lon, lat}`,
`tileBoundsWorld(z, x, y) -> {minX, maxX, minZ, maxZ}`, `worldToTile(x, z, zoom)`,
`M_TO_FT = 3.28084`. Display units: imperial default (ft / mi), metric toggle.

## Stack
- Vite + three.js (latest, `WebGLRenderer`, WebGL2; no WebGPU dependency), plain ES modules
  (JS + JSDoc), no heavy frameworks. UI is DOM/CSS overlay (no React).
- Vite `base: '/telluride-trails/'`. Static assets in `public/` (data in `public/data/`).
- Deployed via GitHub Actions (build → Pages). Repo size budget: `public/data` ≤ 600 MB total,
  no file > 50 MB.
- Licenses: only CC0 / public domain / MIT / CC-BY (with credits) assets. Credits screen lists
  USGS, OSM contributors (ODbL), MRLC/NLCD, three.js, any CC0 texture/model sources.

## Ownership (one owner per path — never edit a path you do not own; ask the owner on the board)
| Path | Owner |
|---|---|
| `package.json`, `vite.config.js`, `index.html`, `src/main.js`, `src/core/**`, `.github/**`, `README.md`, git commits/pushes/deploys | **architect** |
| `tools/terrain/**`, `public/data/terrain/**`, `public/data/imagery/**`, `public/data/cover/**` | **terraindata** |
| `tools/vector/**`, `public/data/vector/**`, `src/data/**` (runtime trail graph/race/POI API) | **traildata** |
| `src/terrain/**` (streaming LOD terrain renderer + height queries) | **terrain** |
| `src/world/**` (trees, rocks, grass, water, waterfalls, sky/atmosphere, weather, buildings, gondola), `public/assets/world/**` | **world** |
| `src/game/**` (runner, controller, mechanics, races, save), `public/assets/game/**` | **gameplay** |
| `src/ui/**`, `src/styles/**`, `public/assets/ui/**`, PWA manifest/icons/service worker | **ui** |
| verification only (no source edits) | **perfqa**, **playtest** |

**Git:** only **architect** runs `git add/commit/push`. Everyone else: `git status`/`git diff`
read-only. **Builds:** only architect builds to `dist/`. Verifiers build to their own
`/tmp/<name>-dist` and serve on their own ports. **Dev server:** architect keeps one
`vite` dev server on **http://localhost:5173/telluride-trails/**; others use it (HMR) and must
not start another on 5173. Need a server of your own? use port 5200+ unique to you.
Use node via `source ~/.nvm/nvm.sh`. Headless Chrome is at `/usr/bin/google-chrome`.

## Runtime interfaces (architect stubs these first; owners fill them in)
```js
// src/core/engine.js  (architect)
engine = { renderer, scene, camera, clock, events /* on/off/emit */, quality, input,
           onUpdate(fn(dt, t)), onLateUpdate(fn(dt, t)), assetsBase /* import.meta.env.BASE_URL */ }
// quality: { tier:'low'|'medium'|'high'|'ultra', pixelRatio, renderScale, shadows, shadowMapSize,
//   drawDistance, terrainLodBias, treeDensity, grass, water:'simple'|'reflective', postFX,
//   maxAnisotropy } ; emits events 'quality:changed'. Auto-detect tier + dynamic render scale
//   from a rolling frame-time budget; user override in settings.
// input: unified { move:{x,y}, look:{x,y}, sprint, hike, jump, autopilot, pause } from
//   keyboard/mouse, gamepad, and touch (touch controls DOM provided by ui via events).

// src/terrain/index.js  (terrain)
createTerrain(engine) -> {
  update(cameraPos), getHeight(x, z) /* sync, best loaded LOD, never throws */,
  getNormal(x, z), getSurface(x, z) -> {forest, rock, water, snow, grass} /* from cover tiles */,
  preload(x, z, radiusM) -> Promise /* resolves when playable detail around point is resident */,
  ready: Promise, dispose()
}

// src/data/index.js  (traildata)
loadTrailData(engine) -> Promise<{
  nearest(x, z, maxDist) -> {dist, x, z, tx, tz /*tangent*/, edgeId, kind /*trail|road|track|path*/,
                              name, difficulty} | null,
  route(fromNodeOrXZ, toNodeOrXZ) -> polyline   // optional, for autopilot
  pois /* trailheads, viewpoints, peaks, passes, towns, waterfalls, lakes with x,z,y,name,kind */,
  races /* [{id, name, blurb, distanceMi, gainFt, cutoffH, start:{x,z}, finish, line: Float32Array
             (x,z,cumDist), checkpoints/aid:[{name, d, x, z, cutoffH?}], startTimeLocal}] */,
  waterways, lakes, waterfalls, buildings, aerialways /* world-space polylines for world module */,
  loadArea(x, z, radius) -> Promise  // vector data is chunked by tile, streams like terrain
}>

// src/world/index.js  (world)
createWorld(engine, terrain, trailData) -> { update(dt, playerPos), setTimeOfDay(date), dispose() }

// src/game/index.js  (gameplay)
createGame(engine, terrain, trailData, world) -> { startFreeRun({x,z,heading}), startRace(raceId),
  resume(), pause(), update(dt), state }   // emits 'hud' (pace, dist, vert, elev, stamina, ...)

// src/ui/index.js  (ui)
createUI(engine, {trailData, game}) -> drives the app state machine via events:
  'ui:freerun' {x,z,heading} , 'ui:race' {id}, 'ui:resume', 'ui:quality' ...
```
Event names are namespaced (`game:*`, `ui:*`, `terrain:*`, `quality:*`, `hud`). If you need a
new interface, post it on the board tagged to the owner — do not reach into another module.

## Data formats (terraindata / traildata define exact schemas in `public/data/*/README.md`)
- Terrain: Web Mercator `{z}/{x}/{y}` tiles, Terrarium RGB encoding (`h = R*256 + G + B/256 - 32768`),
  `public/data/terrain/manifest.json` lists zoom range, bbox, which tiles exist per zoom.
  Coarse levels cover full bbox; deepest level only near trails/towns.
- Imagery: `public/data/imagery/{z}/{x}/{y}.webp|jpg` + manifest; color-balanced to look natural.
- Cover: `public/data/cover/{z}/{x}/{y}.png` RGBA masks (R forest density, G bare rock/scree,
  B water, A alpine tundra/grass) + manifest. Used for tree/rock placement and shading.
- Vectors: `public/data/vector/` chunked by tile, coordinates pre-projected to world meters
  with elevation sampled; `races.json`, `pois.json` small and loaded at start.

## Game design (gameplay + ui)
- Modes: **Free Run** (pick a trailhead / viewpoint / town from a list or a 2D map, or tap any
  point on the map), **Races** (Hardrock 100 (clockwise and counter-clockwise), Imogene Pass Run,
  Telluride Mountain Run, Rundola, Deep Creek, Kendall Mountain, Ouray 100 / Silverton races,
  Sneffels-area classics — real routes as accurate as data allows), **Resume** saved run.
- Movement: walk / hike / power-hike (hands-on-knees on steep) / run / sprint; speed depends on
  grade (Tobler-like), surface (road, trail, scree, talus, snow, water crossing), altitude, fatigue.
- Trail keeping: gentle steering assist toward the trail when on it; off-trail is slower
  (bushwhacking, talus), costs stamina, triggers "Leave No Trace" warnings and a race penalty;
  very steep cliffs are not climbable (slide back). Autopilot follows the current trail.
- Mild systems: stamina/energy (eat at aid stations), hydration (streams/aid), altitude
  (> 11,000 ft slows), afternoon monsoon thunderstorm risk on ridges (real local clock),
  trip/fall on technical terrain when tired, real sun position from real time of day.
- Real-time: race clock is real and never stops; save/resume; HUD shows ETA with jokes.
- Camera: third-person chase, orbit with drag, first-person toggle, photo mode.

## Quality tiers (targets)
- low: low-end Android (Mali-G52 class): renderScale ~0.6-0.75, no shadows, sparse trees as
  impostors, short draw distance with fog, no grass, simple water. Steady 30+ fps.
- medium: mid phones: 60 fps, blob shadows / small shadow map, more trees, short grass radius.
- high: flagship phones / laptops: shadows, mesh trees near + impostors far, grass, reflective water.
- ultra: desktop GPUs: everything, longer draw distance, SSAO/bloom-ish postFX.
Adaptive: render-scale controller holds frame time under budget; tier steps down after
sustained misses. Streaming work time-sliced (workers / `requestIdleCallback`), no >8 ms tasks
on the main thread during play.

## Done means
Live at the Pages URL; loads fast on a phone; Free Run and every race playable start → finish;
looks convincingly like the San Juans; perfqa signs off on low/medium/high perf; playtest signs
off on UX polish and local accuracy; credits/licensing correct.
