# Telluride Trails — Vector Data Format & Attribution

All coordinates are pre-projected from WGS84 to scaled Web Mercator world meters matching `src/core/geo.js`:
- Origin: Telluride (`lat0 = 37.9375`, `lon0 = -107.8123`), `k = cos(lat0)`
- Axes (Three.js): `+X` = East (m), `+Y` = elevation above sea level (m, sampled from AWS Terrarium z14/z13), `-Z` = North (m)
- Region bbox: `W -108.02, S 37.68, E -107.25, N 38.10`

## Files

### `pois.json`
Startup-loaded array of curated free-run starts, trailheads, viewpoints, peaks, passes, towns, waterfalls, and lakes:
```json
{
  "id": "bear-creek-th",
  "name": "Bear Creek Trailhead",
  "kind": "trailhead | viewpoint | peak | pass | town | waterfall | lake",
  "area": "Telluride",
  "x": 240.5,
  "z": 420.2,
  "y": 2705.4,
  "heading": 3.1416,
  "freeRun": true,
  "description": "Classic 2.5-mile canyon climb to Bear Creek Falls."
}
```
`heading` follows `src/core/camera.js` convention where forward is `(-sin(heading), -cos(heading))` (`heading = atan2(-tx, -tz)`).

### `races.json`
Startup-loaded array of 13 trail/road races (12 real San Juan mountain races including both `rundola` on Telluride Trail and `rundola-original` straight up under Gondola Line 1, plus the `spurs-half-marathon` Austin road Easter egg at index 12) reconstructed from official CalTopo/OSM geometries and resampled at 15 m over z14 Terrarium elevation:
```json
{
  "id": "hardrock-100-cw",
  "name": "Hardrock 100 (Clockwise)",
  "blurb": "...",
  "distanceMi": 99.0,
  "officialDistanceMi": 102.0,
  "gainFt": 34359,
  "officialGainFt": 33441,
  "cutoffH": 48,
  "startTimeLocal": "06:00",
  "start": { "x": ..., "z": ..., "heading": ... },
  "finish": { "x": ..., "z": ..., "heading": ... },
  "checkpoints": [
    { "name": "KT Aid Station", "d": 18118.5, "x": ..., "z": ..., "y": 3263.8, "cutoffH": 7.5 }
  ],
  "elevations": [2839.5, ...],
  "line": [x0, z0, cumDist0, x1, z1, cumDist1, ...]
}
```
At runtime `src/data/index.js` wraps `race.line` in a `Float32Array` (stride 3). `elevations` provides a 128-sample USGS 3DEP profile (with pinned global extrema) for instant title-screen SVG rendering.

### `manifest.json` & `chunks/{tx}_{ty}.json`
Vector features are chunked by Web Mercator zoom `13` tile (`~3.76 km × 3.76 km`). Features whose bounding box overlaps multiple tiles appear in each overlapping tile and are deduplicated by `id` on load in `src/data/index.js`.
Each chunk contains:
- `trails`: `{ id, name, kind: 'trail'|'path'|'track'|'road', surface, sacScale, widthM, difficulty, lengthM, gainM, lossM, coords: [x0,y0,z0,...] }`
- `waterways`: `{ id, name, kind: 'river'|'stream'|'canal', widthM, coords: [x0,y0,z0,...] }`
- `lakes`: `{ id, name, kind: 'lake'|'reservoir'|'pond', y, areaM2, bbox: [minX,minZ,maxX,maxZ], coords: [x0,y0,z0,...] }`
- `waterfalls`: `{ id, name, x, y, z, heightM }`
- `buildings`: `{ id, name, kind, town, heightM, levels, baseY, bbox: [minX,minZ,maxX,maxZ], coords: [x0,y0,z0,...] }`
- `aerialways`: `{ id, name, kind: 'gondola'|'chair_lift'|'drag_lift'|'cable_car', pylons: [{x,y,z}], coords: [x0,y0,z0,...] }`
- `skiRuns`: `{ id, name, difficulty, coords: [x0,y0,z0,...] }`

### `graph.json`
Compact trail/road routing graph lazy-loaded for `trailData.route(from, to)` A* pathfinding.

## Reproducing
```bash
python3 tools/vector/extract_osm.py
python3 tools/vector/build_vectors.py
python3 tools/vector/build_races_pois.py
```

## Attribution & Licensing
- **Vector Features**: Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, licensed under the Open Database License ([ODbL](https://opendatacommons.org/licenses/odbl/)). Extracted via Geofabrik Colorado PBF.
- **Elevation**: Sampled from USGS 3DEP / Mapzen Terrarium elevation tiles (public domain).
