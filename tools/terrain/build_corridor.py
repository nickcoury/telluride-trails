#!/usr/bin/env python3
"""Build a trail/road/town/race corridor tile mask (JSON) from OSM Overpass + San Juan race anchors."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BBOX, CACHE_DIR, USER_AGENT, bbox_tile_range, bbox_tiles, deg2num, dilate_tiles

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OSM_CACHE = CACHE_DIR / "osm_corridor_ways.json"
CORRIDOR_OUT = Path(__file__).resolve().parent / "corridor_tiles.json"

# Core San Juan towns, trailheads, passes, and Hardrock / classic race landmarks (lat, lon, z17_radius)
ANCHORS = [
    ("Telluride", 37.9375, -107.8123, 3),
    ("Mountain Village", 37.9328, -107.8485, 2),
    ("Bridal Veil Falls", 37.9186, -107.7689, 2),
    ("Ouray", 38.0228, -107.6714, 2),
    ("Silverton", 37.8119, -107.6645, 2),
    ("Lake City", 38.0299, -107.3153, 1),
    ("Ophir", 37.8569, -107.8325, 1),
    ("Imogene Pass", 37.9325, -107.7358, 1),
    ("Mt Sneffels / Blue Lakes", 38.0036, -107.7923, 1),
    ("Handies Peak", 37.9130, -107.5044, 1),
    ("Ice Lake Basin", 37.8130, -107.8080, 1),
    ("Engineer Pass", 37.9752, -107.5844, 1),
    ("Lizard Head / Trout Lake", 37.8260, -107.8930, 1),
    ("Kendall Mountain", 37.7880, -107.6190, 1),
]


def fetch_osm_corridor_ways(force: bool = False) -> dict:
    """Query Overpass API for trails, paths, tracks, roads, and towns in the playable bbox."""
    if OSM_CACHE.exists() and not force and OSM_CACHE.stat().st_size > 1000:
        return json.loads(OSM_CACHE.read_text(encoding="utf-8"))

    w, s, e, n = BBOX
    # Fetch highway ways (trails, paths, tracks, roads) + place nodes (towns/villages)
    query = (
        "[out:json][timeout:120];"
        "("
        f'way["highway"~"^(footway|path|bridleway|track|cycleway|unclassified|tertiary|secondary|primary|residential|service)$"]({s},{w},{n},{e});'
        f'way["aerialway"]({s},{w},{n},{e});'
        f'node["place"~"^(town|village|hamlet)$"]({s},{w},{n},{e});'
        ");"
        "out geom qt;"
    )
    print("Querying Overpass API for San Juan trails/roads/towns corridor...")
    resp = requests.post(
        OVERPASS_URL,
        data={"data": query},
        headers={"User-Agent": USER_AGENT},
        timeout=150,
    )
    resp.raise_for_status()
    data = resp.json()
    OSM_CACHE.parent.mkdir(parents=True, exist_ok=True)
    OSM_CACHE.write_text(json.dumps(data), encoding="utf-8")
    print(f"Cached {len(data.get('elements', []))} OSM elements to {OSM_CACHE}")
    return data


def rasterize_polyline_tiles(coords: list[tuple[float, float]], zoom: int, out: set[tuple[int, int]]) -> None:
    """Add all tiles touched by a (lat, lon) polyline at `zoom` using dense segment sampling."""
    if not coords:
        return
    # Step size roughly <= 0.4 tile width in degrees (~0.004 deg at z14, ~0.001 deg at z16)
    step_deg = 0.25 * (360.0 / (2.0 ** zoom))
    for i in range(len(coords) - 1):
        lat0, lon0 = coords[i]
        lat1, lon1 = coords[i + 1]
        dist = math.hypot(lat1 - lat0, lon1 - lon0)
        steps = max(1, int(math.ceil(dist / step_deg)))
        for k in range(steps + 1):
            t = k / steps
            lat = lat0 + (lat1 - lat0) * t
            lon = lon0 + (lon1 - lon0) * t
            out.add(deg2num(lat, lon, zoom))
    if len(coords) == 1:
        out.add(deg2num(coords[0][0], coords[0][1], zoom))


def clip_set(tiles: set[tuple[int, int]], zoom: int) -> set[tuple[int, int]]:
    x0, x1, y0, y1 = bbox_tile_range(zoom, BBOX)
    return {(x, y) for (x, y) in tiles if x0 <= x <= x1 and y0 <= y <= y1}


def main() -> None:
    parser = argparse.ArgumentParser(description="Build trail/road/town corridor tile masks.")
    parser.add_argument("--force-osm", action="store_true", help="Re-query Overpass API")
    parser.add_argument("--out", type=Path, default=CORRIDOR_OUT, help="Output JSON path")
    args = parser.parse_args()

    osm = fetch_osm_corridor_ways(force=args.force_osm)
    elements = osm.get("elements", [])

    # Partition ways: trails/paths/aerialways get higher-zoom priority than minor service roads
    trail_ways: list[list[tuple[float, float]]] = []
    road_ways: list[list[tuple[float, float]]] = []
    places: list[tuple[float, float]] = []

    for el in elements:
        etype = el.get("type")
        tags = el.get("tags", {})
        if etype == "node" and "lat" in el and "lon" in el:
            places.append((el["lat"], el["lon"]))
        elif etype == "way" and "geometry" in el:
            pts = [(pt["lat"], pt["lon"]) for pt in el["geometry"]]
            hw = tags.get("highway", "")
            if hw in ("footway", "path", "bridleway", "track", "cycleway") or "aerialway" in tags:
                trail_ways.append(pts)
            else:
                road_ways.append(pts)

    print(f"Parsed {len(trail_ways)} trail/track/aerial ways, {len(road_ways)} road ways, {len(places)} places")

    # Build z14 terrain corridor: trails (radius=1) + roads (radius=0) + anchors (radius=1)
    z14_trails: set[tuple[int, int]] = set()
    for pts in trail_ways:
        rasterize_polyline_tiles(pts, 14, z14_trails)
    z14_roads: set[tuple[int, int]] = set()
    for pts in road_ways:
        rasterize_polyline_tiles(pts, 14, z14_roads)
    z14_anchors: set[tuple[int, int]] = set()
    for lat, lon in places:
        z14_anchors.add(deg2num(lat, lon, 14))
    for _, lat, lon, _ in ANCHORS:
        z14_anchors.add(deg2num(lat, lon, 14))
    z14_terrain = clip_set(
        dilate_tiles(z14_trails | z14_anchors, radius=1, clip_bbox=BBOX, zoom=14) | z14_roads,
        14,
    )
    z14_cover = clip_set(
        z14_trails | dilate_tiles(z14_anchors, radius=1, clip_bbox=BBOX, zoom=14),
        14,
    )

    # Build z15 corridor:
    # - For imagery: all trails + main roads + places
    # - For terrain: trails + anchors in core San Juan race corridor
    z15_trails: set[tuple[int, int]] = set()
    for pts in trail_ways:
        rasterize_polyline_tiles(pts, 15, z15_trails)
    z15_roads: set[tuple[int, int]] = set()
    for pts in road_ways:
        rasterize_polyline_tiles(pts, 15, z15_roads)
    z15_anchors: set[tuple[int, int]] = set()
    for _, lat, lon, rad in ANCHORS:
        xt, yt = deg2num(lat, lon, 15)
        z15_anchors.update(dilate_tiles([(xt, yt)], radius=max(1, rad), clip_bbox=BBOX, zoom=15))

    z15_corridor = clip_set(z15_trails | z15_roads | z15_anchors, 15)

    # Telluride-Ouray-Silverton core z15 terrain subset (trails + anchors inside core race zones)
    z15_terrain_boxes = [
        (-107.90, 37.86, -107.62, 38.04),  # Telluride / Sneffels / Imogene / Ouray / Ophir
        (-107.72, 37.76, -107.47, 37.94),  # Silverton / Kendall / Handies / Cunningham
    ]
    z15_terrain_allow: set[tuple[int, int]] = set()
    for box in z15_terrain_boxes:
        z15_terrain_allow.update(bbox_tiles(15, box))
    z15_terrain = sorted((clip_set(z15_trails | z15_anchors, 15)) & z15_terrain_allow)

    # z16 imagery corridor: direct trail tiles + Telluride/Ouray/Silverton town cores
    z16_trails: set[tuple[int, int]] = set()
    for pts in trail_ways:
        rasterize_polyline_tiles(pts, 16, z16_trails)
    z16_anchors: set[tuple[int, int]] = set()
    for _, lat, lon, rad in ANCHORS:
        xt, yt = deg2num(lat, lon, 16)
        z16_anchors.update(dilate_tiles([(xt, yt)], radius=rad + 1, clip_bbox=BBOX, zoom=16))
    z16_imagery = clip_set(z16_trails | z16_anchors, 16)

    # z17 imagery: tight Telluride town + Mountain Village + Gondola + Bridal Veil
    z17_imagery = set(bbox_tiles(17, (-107.845, 37.924, -107.785, 37.945)))

    # Merge traildata's OSM corridor if present so every vector trail tile has matching raster coverage
    vector_corridor = Path(__file__).resolve().parents[2] / "public" / "data" / "vector" / "corridor_tiles.json"
    if vector_corridor.exists():
        vc = json.loads(vector_corridor.read_text(encoding="utf-8"))
        z15_corridor.update(clip_set({(int(x), int(y)) for x, y in vc.get("z15_trails", [])}, 15))

    out_payload = {
        "terrain": {
            "14": sorted(list(p) for p in z14_terrain),
            "15": [list(p) for p in z15_terrain],
        },
        "imagery": {
            "15": sorted(list(p) for p in z15_corridor),
            "16": sorted(list(p) for p in z16_imagery),
            "17": sorted(list(p) for p in z17_imagery),
        },
        "cover": {
            "14": sorted(list(p) for p in z14_cover),
        },
    }

    args.out.write_text(json.dumps(out_payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {args.out}:")
    for layer, zooms in out_payload.items():
        for z, coords in zooms.items():
            print(f"  {layer} z{z}: {len(coords)} tiles")


if __name__ == "__main__":
    main()
