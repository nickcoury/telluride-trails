"""
Extract OSM vector features for the Telluride Trails bbox from Geofabrik Colorado PBF
using pyosmium C++ FileProcessor + KeyFilter, outputting ~/.cache/telluride-trails/osm_extracted.json.
"""

import json
import os
import sys
import time
from pathlib import Path

PYLIBS = os.path.expanduser("~/.cache/telluride-trails/pylibs")
if os.path.isdir(PYLIBS) and PYLIBS not in sys.path:
    sys.path.insert(0, PYLIBS)

import osmium  # noqa: E402

from geo import PADDED_BBOX  # noqa: E402

CACHE_DIR = Path(os.path.expanduser("~/.cache/telluride-trails"))
DEFAULT_PBF = CACHE_DIR / "colorado-latest.osm.pbf"
DEFAULT_OUT = CACHE_DIR / "osm_extracted.json"

HIGHWAY_TYPES = {
    "path", "footway", "bridleway", "track", "cycleway", "steps", "via_ferrata",
    "residential", "unclassified", "tertiary", "secondary", "primary", "trunk",
    "service", "living_street", "road",
}
WATERWAY_TYPES = {"river", "stream", "creek", "canal", "drain", "ditch"}
AERIALWAY_LINE_TYPES = {
    "gondola", "chair_lift", "drag_lift", "cable_car", "mixed_lift",
    "platter", "rope_tow", "j-bar", "t-bar", "magic_carpet",
}
PLACE_TYPES = {"town", "village", "hamlet", "locality", "suburb"}

FILTER_KEYS = (
    "highway", "waterway", "natural", "building", "aerialway",
    "piste:type", "place", "tourism", "water", "landuse",
    "mountain_pass", "information",
)


def in_bbox(lon: float, lat: float, bbox: dict = PADDED_BBOX) -> bool:
    return (
        bbox["west"] <= lon <= bbox["east"]
        and bbox["south"] <= lat <= bbox["north"]
    )


def main():
    pbf_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PBF
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT
    out_path.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    print(f"Pass 1 (relations): {pbf_path}")
    way_routes: dict[int, list[str]] = {}
    lake_mp_ways: dict[int, dict] = {}
    building_mp_ways: dict[int, dict] = {}

    for r in osmium.FileProcessor(str(pbf_path), osmium.osm.RELATION):
        tags = r.tags
        rtype = tags.get("type")
        if rtype == "route" and tags.get("route") in ("hiking", "foot", "mtb", "bicycle", "ski", "piste"):
            rname = tags.get("name") or tags.get("ref")
            if rname:
                for m in r.members:
                    if m.type == "w":
                        way_routes.setdefault(m.ref, []).append(rname)
        elif rtype == "multipolygon":
            is_water = (
                tags.get("natural") == "water"
                or tags.get("landuse") == "reservoir"
                or tags.get("water") in ("lake", "reservoir", "pond", "basin", "oxbow")
            )
            is_bldg = bool(tags.get("building") and tags.get("building") != "no")
            if is_water or is_bldg:
                info = {"id": r.id, "tags": {k: v for k, v in tags}}
                for m in r.members:
                    if m.type == "w" and m.role in ("outer", ""):
                        if is_water:
                            lake_mp_ways[m.ref] = info
                        if is_bldg:
                            building_mp_ways[m.ref] = info

    print(
        f"  {len(way_routes)} route-ways, {len(lake_mp_ways)} mp lakes, "
        f"{len(building_mp_ways)} mp bldgs in {time.time()-t0:.1f}s"
    )

    t1 = time.time()
    print("Pass 2 (filtered nodes + ways with locations)...")
    pois = []
    waterfalls = []
    aerialway_nodes = {}
    highways = []
    waterways = []
    lakes = []
    buildings = []
    aerialways = []
    ski_runs = []

    proc = (
        osmium.FileProcessor(str(pbf_path))
        .with_locations()
        .with_filter(osmium.filter.KeyFilter(*FILTER_KEYS))
    )

    for obj in proc:
        if obj.is_node():
            if not obj.location.valid():
                continue
            lon, lat = obj.location.lon, obj.location.lat
            if not in_bbox(lon, lat):
                continue
            tags = obj.tags
            nat = tags.get("natural")
            ww = tags.get("waterway")
            tour = tags.get("tourism")
            hw = tags.get("highway")
            place = tags.get("place")
            aw = tags.get("aerialway")

            if aw in ("pylon", "station"):
                aerialway_nodes[obj.id] = {
                    "id": obj.id,
                    "kind": aw,
                    "name": tags.get("name", ""),
                    "lon": round(lon, 7),
                    "lat": round(lat, 7),
                }

            if ww == "waterfall" or nat == "waterfall":
                waterfalls.append({
                    "id": f"n{obj.id}",
                    "name": tags.get("name", "Waterfall"),
                    "lon": round(lon, 7),
                    "lat": round(lat, 7),
                    "height": tags.get("height", ""),
                })
                continue

            kind = None
            if nat == "peak":
                kind = "peak"
            elif nat == "saddle" or tags.get("mountain_pass") == "yes":
                kind = "pass"
            elif hw == "trailhead" or tags.get("information") == "trailhead":
                kind = "trailhead"
            elif tour == "viewpoint":
                kind = "viewpoint"
            elif place in PLACE_TYPES and tags.get("name"):
                kind = "town" if place in ("town", "village") else "locality"
            elif tour in ("alpine_hut", "wilderness_hut", "camp_site") and tags.get("name"):
                kind = tour
            elif tour == "information" and tags.get("name") and "trailhead" in tags.get("name", "").lower():
                kind = "trailhead"

            if kind:
                pois.append({
                    "id": f"n{obj.id}",
                    "name": tags.get("name", ""),
                    "kind": kind,
                    "lon": round(lon, 7),
                    "lat": round(lat, 7),
                    "ele": tags.get("ele", ""),
                    "place": place or "",
                    "prominence": tags.get("prominence", ""),
                })

        elif obj.is_way():
            nodes = obj.nodes
            n_count = len(nodes)
            if n_count < 2:
                continue
            # Fast reject: if first node is >0.25 deg outside bbox, check others only if long
            n0 = nodes[0]
            if n0.location.valid():
                lon0, lat0 = n0.location.lon, n0.location.lat
                if not (
                    -108.30 <= lon0 <= -106.97
                    and 37.40 <= lat0 <= 38.38
                ):
                    continue

            valid_any = False
            for n in nodes:
                if n.location.valid() and in_bbox(n.location.lon, n.location.lat):
                    valid_any = True
                    break
            if not valid_any:
                continue

            pts = []
            node_ids = []
            for n in nodes:
                if not n.location.valid():
                    continue
                pts.append((round(n.location.lon, 7), round(n.location.lat, 7)))
                node_ids.append(n.ref)

            if len(pts) < 2:
                continue

            tags = obj.tags
            hw = tags.get("highway")
            ww = tags.get("waterway")
            nat = tags.get("natural")
            aw = tags.get("aerialway")
            piste = tags.get("piste:type")
            bldg = tags.get("building")

            if ww == "waterfall" or nat == "waterfall":
                mid = pts[len(pts) // 2]
                waterfalls.append({
                    "id": f"w{obj.id}",
                    "name": tags.get("name", "Waterfall"),
                    "lon": mid[0],
                    "lat": mid[1],
                    "height": tags.get("height", ""),
                })

            if hw in HIGHWAY_TYPES:
                highways.append({
                    "id": obj.id,
                    "name": tags.get("name", ""),
                    "ref": tags.get("ref", ""),
                    "routes": way_routes.get(obj.id, []),
                    "highway": hw,
                    "sac_scale": tags.get("sac_scale", ""),
                    "surface": tags.get("surface", ""),
                    "tracktype": tags.get("tracktype", ""),
                    "trail_visibility": tags.get("trail_visibility", ""),
                    "access": tags.get("access", ""),
                    "motor_vehicle": tags.get("motor_vehicle", ""),
                    "4wd_only": tags.get("4wd_only", ""),
                    "width": tags.get("width", ""),
                    "bridge": tags.get("bridge", ""),
                    "ford": tags.get("ford", ""),
                    "node_ids": node_ids,
                    "coords": pts,
                })

            if ww in WATERWAY_TYPES:
                waterways.append({
                    "id": obj.id,
                    "name": tags.get("name", ""),
                    "kind": ww,
                    "width": tags.get("width", ""),
                    "intermittent": tags.get("intermittent", ""),
                    "coords": pts,
                })

            is_lake_way = (
                len(pts) >= 4
                and pts[0] == pts[-1]
                and (
                    nat == "water"
                    or tags.get("landuse") == "reservoir"
                    or tags.get("water") in ("lake", "reservoir", "pond", "basin", "oxbow")
                )
            )
            mp_lake = lake_mp_ways.get(obj.id)
            if is_lake_way or (mp_lake and len(pts) >= 4 and pts[0] == pts[-1]):
                src_tags = tags if is_lake_way else mp_lake["tags"]
                lakes.append({
                    "id": obj.id if is_lake_way else f"r{mp_lake['id']}_{obj.id}",
                    "name": src_tags.get("name", ""),
                    "kind": src_tags.get("water", "lake" if src_tags.get("natural") == "water" else "reservoir"),
                    "coords": pts,
                })

            is_bldg = bldg and bldg != "no" and len(pts) >= 4 and pts[0] == pts[-1]
            mp_bldg = building_mp_ways.get(obj.id)
            if is_bldg or (mp_bldg and len(pts) >= 4 and pts[0] == pts[-1]):
                src_tags = tags if is_bldg else mp_bldg["tags"]
                buildings.append({
                    "id": obj.id if is_bldg else f"r{mp_bldg['id']}_{obj.id}",
                    "name": src_tags.get("name", ""),
                    "kind": src_tags.get("building", "yes"),
                    "levels": src_tags.get("building:levels", ""),
                    "height": src_tags.get("height", ""),
                    "coords": pts,
                })

            if aw in AERIALWAY_LINE_TYPES:
                aerialways.append({
                    "id": obj.id,
                    "name": tags.get("name", ""),
                    "kind": aw,
                    "node_ids": node_ids,
                    "coords": pts,
                })

            if piste in ("downhill", "nordic", "skitour"):
                ski_runs.append({
                    "id": obj.id,
                    "name": tags.get("name", ""),
                    "piste_type": piste,
                    "difficulty": tags.get("piste:difficulty", ""),
                    "coords": pts,
                })

    print(f"  extracted in {time.time()-t1:.1f}s:")
    print(f"    highways:   {len(highways)}")
    print(f"    waterways:  {len(waterways)}")
    print(f"    lakes:      {len(lakes)}")
    print(f"    waterfalls: {len(waterfalls)}")
    print(f"    pois:       {len(pois)}")
    print(f"    buildings:  {len(buildings)}")
    print(f"    aerialways: {len(aerialways)} (nodes: {len(aerialway_nodes)})")
    print(f"    ski_runs:   {len(ski_runs)}")

    bundle = {
        "bbox": PADDED_BBOX,
        "highways": highways,
        "waterways": waterways,
        "lakes": lakes,
        "waterfalls": waterfalls,
        "pois": pois,
        "buildings": buildings,
        "aerialways": aerialways,
        "aerialway_nodes": {str(k): v for k, v in aerialway_nodes.items()},
        "ski_runs": ski_runs,
    }
    out_path.write_text(json.dumps(bundle))
    print(f"Wrote {out_path} ({out_path.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
