"""
Project extracted OSM features to world meters, sample z14 Terrarium elevation,
build the junction-split trail routing graph, write z13 vector tile chunks,
and output a projected bundle for race/POI curation + terrain corridor tile list.
"""

import json
import math
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from geo import (
    BBOX,
    M_TO_FT,
    bbox_tiles,
    lon_lat_to_world,
    tile_bounds_world,
    world_to_tile,
)
from elevation import TerrariumSampler

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(os.path.expanduser("~/.cache/telluride-trails"))
DEFAULT_IN = CACHE_DIR / "osm_extracted.json"
DEFAULT_PROJ = CACHE_DIR / "projected_bundle.json"
OUT_DIR = REPO_ROOT / "public" / "data" / "vector"

CHUNK_ZOOM = 13


def parse_number(s: str, default: float = 0.0) -> float:
    if not s:
        return default
    m = re.search(r"[-+]?\d+(?:\.\d+)?", str(s))
    if not m:
        return default
    val = float(m.group(0))
    sl = str(s).lower()
    if "ft" in sl or "'" in sl:
        val *= 0.3048
    return val


def classify_highway(h: dict) -> tuple[str, float, str]:
    """Return (kind, widthM, difficulty) from OSM highway tags."""
    hw = h.get("highway", "path")
    sac = h.get("sac_scale", "")
    tracktype = h.get("tracktype", "")

    if hw in ("path", "bridleway", "via_ferrata") or sac:
        kind = "trail"
        width = 0.9 if sac in ("alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking") else 1.2
    elif hw in ("footway", "cycleway", "steps"):
        kind = "path"
        width = 1.8
    elif hw == "track":
        kind = "track"
        width = 3.2
    else:
        kind = "road"
        if hw in ("primary", "trunk", "secondary"):
            width = 7.5
        elif hw in ("tertiary", "unclassified"):
            width = 6.0
        else:
            width = 5.0

    if hw == "via_ferrata" or sac in ("alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking"):
        diff = "alpine_expert"
    elif sac == "demanding_mountain_hiking" or (hw == "track" and tracktype in ("grade4", "grade5")):
        diff = "demanding_hard"
    elif sac == "mountain_hiking" or hw in ("path", "bridleway", "track"):
        diff = "moderate"
    else:
        diff = "easy"

    return kind, width, diff


def classify_building(b: dict, towns: list[dict]) -> tuple[str, float, int, str]:
    raw_kind = b.get("kind", "yes")
    kind_map = {
        "house": "house",
        "detached": "house",
        "residential": "house",
        "apartments": "hotel",
        "hotel": "hotel",
        "commercial": "commercial",
        "retail": "commercial",
        "industrial": "industrial",
        "warehouse": "industrial",
        "cabin": "cabin",
        "hut": "cabin",
        "shed": "cabin",
        "garage": "cabin",
        "barn": "cabin",
        "church": "church",
        "chapel": "church",
        "school": "school",
        "public": "commercial",
        "civic": "commercial",
    }
    kind = kind_map.get(raw_kind, "yes")

    levels = int(round(parse_number(b.get("levels", ""), 0)))
    height = parse_number(b.get("height", ""), 0.0)
    if levels <= 0:
        if kind in ("hotel", "commercial"):
            levels = 3
        elif kind == "cabin":
            levels = 1
        else:
            levels = 2
    if height <= 0.0:
        height = levels * 3.3

    # Nearest town within 5 km
    coords = b["coords"]
    cx = sum(p[0] for p in coords) / len(coords)
    cz = sum(p[1] for p in coords) / len(coords)
    best_town = ""
    best_d2 = 5000.0 * 5000.0
    for t in towns:
        d2 = (cx - t["x"]) ** 2 + (cz - t["z"]) ** 2
        if d2 < best_d2:
            best_d2 = d2
            best_town = t["name"]

    return kind, round(height, 1), levels, best_town


def polyline_bbox_tiles(xz_pts: list[tuple[float, float]], zoom: int = CHUNK_ZOOM) -> set[tuple[int, int]]:
    min_x = min(p[0] for p in xz_pts)
    max_x = max(p[0] for p in xz_pts)
    min_z = min(p[1] for p in xz_pts)
    max_z = max(p[1] for p in xz_pts)
    tx0, ty0 = world_to_tile(min_x, min_z, zoom)
    tx1, ty1 = world_to_tile(max_x, max_z, zoom)
    tiles = set()
    for tx in range(min(tx0, tx1), max(tx0, tx1) + 1):
        for ty in range(min(ty0, ty1), max(ty0, ty1) + 1):
            tiles.add((tx, ty))
    return tiles


def in_world_bbox(x: float, z: float, wb: tuple[float, float, float, float]) -> bool:
    return wb[0] <= x <= wb[1] and wb[2] <= z <= wb[3]


def main():
    t0 = time.time()
    in_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_IN
    raw = json.loads(in_path.read_text())
    print(f"Loaded {in_path} in {time.time()-t0:.1f}s")

    # Compute world bounds of BBOX
    wx_w, wz_n = lon_lat_to_world(BBOX["west"], BBOX["north"])
    wx_e, wz_s = lon_lat_to_world(BBOX["east"], BBOX["south"])
    world_bbox = (min(wx_w, wx_e), max(wx_w, wx_e), min(wz_n, wz_s), max(wz_n, wz_s))

    # 1. Collect all unique lon/lat points for Terrarium z14 prefetch
    sampler = TerrariumSampler(zoom=14, max_workers=12)
    sample_pts = []
    for hw in raw["highways"]:
        for lon, lat in hw["coords"]:
            sample_pts.append((lon, lat))
    for ww in raw["waterways"]:
        for lon, lat in ww["coords"]:
            sample_pts.append((lon, lat))
    for lk in raw["lakes"]:
        c = lk["coords"]
        sample_pts.append((sum(p[0] for p in c) / len(c), sum(p[1] for p in c) / len(c)))
    for wf in raw["waterfalls"]:
        sample_pts.append((wf["lon"], wf["lat"]))
    for p in raw["pois"]:
        sample_pts.append((p["lon"], p["lat"]))
    for b in raw["buildings"]:
        c = b["coords"]
        sample_pts.append((sum(p[0] for p in c) / len(c), sum(p[1] for p in c) / len(c)))
    for aw in raw["aerialways"]:
        for lon, lat in aw["coords"]:
            sample_pts.append((lon, lat))
    for sr in raw["ski_runs"]:
        for lon, lat in sr["coords"]:
            sample_pts.append((lon, lat))

    sampler.prefetch_lon_lats(sample_pts)

    elev_cache: dict[tuple[float, float], float] = {}

    def get_elev(lon: float, lat: float) -> float:
        key = (round(lon, 6), round(lat, 6))
        val = elev_cache.get(key)
        if val is None:
            val = sampler.sample_lon_lat(lon, lat)
            elev_cache[key] = val
        return val

    # 2. Project POIs & identify towns
    pois = []
    towns = []
    for p in raw["pois"]:
        x, z = lon_lat_to_world(p["lon"], p["lat"])
        dem_y = get_elev(p["lon"], p["lat"])
        osm_ele = parse_number(p.get("ele", ""), 0.0)
        y = osm_ele if (p["kind"] == "peak" and osm_ele > 500) else dem_y
        item = {
            "id": p["id"],
            "name": p["name"],
            "kind": p["kind"],
            "x": round(x, 1),
            "z": round(z, 1),
            "y": round(y, 1),
            "demY": round(dem_y, 1),
            "lon": p["lon"],
            "lat": p["lat"],
        }
        pois.append(item)
        if p["kind"] == "town":
            towns.append(item)

    # 3. Build junction-split trail graph from highways
    node_use_count: dict[int, int] = defaultdict(int)
    for hw in raw["highways"]:
        nids = hw["node_ids"]
        if len(nids) < 2:
            continue
        node_use_count[nids[0]] += 2
        node_use_count[nids[-1]] += 2
        for nid in nids[1:-1]:
            node_use_count[nid] += 1

    graph_nodes: dict[int, int] = {}  # osm_nid -> dense idx
    graph_node_list: list[list[float]] = []  # [x, y, z]

    def get_graph_node(nid: int, lon: float, lat: float) -> int:
        idx = graph_nodes.get(nid)
        if idx is None:
            x, z = lon_lat_to_world(lon, lat)
            y = get_elev(lon, lat)
            idx = len(graph_node_list)
            graph_nodes[nid] = idx
            graph_node_list.append([round(x, 1), round(y, 1), round(z, 1)])
        return idx

    trail_edges = []
    graph_edges = []
    edge_id_counter = 0

    for hw in raw["highways"]:
        nids = hw["node_ids"]
        ll_coords = hw["coords"]
        if len(nids) < 2 or len(ll_coords) != len(nids):
            continue

        kind, width_m, diff = classify_highway(hw)
        name = hw.get("name") or (hw["routes"][0] if hw.get("routes") else "") or hw.get("ref") or ""
        surface = hw.get("surface", "")
        sac_scale = hw.get("sac_scale", "")

        # Split at junction nodes
        seg_start = 0
        for i in range(1, len(nids)):
            is_end = (i == len(nids) - 1)
            is_junction = node_use_count[nids[i]] >= 2
            if is_end or is_junction:
                sub_ll = ll_coords[seg_start : i + 1]
                u = get_graph_node(nids[seg_start], sub_ll[0][0], sub_ll[0][1])
                v = get_graph_node(nids[i], sub_ll[-1][0], sub_ll[-1][1])

                coords_flat = []
                xz_pts = []
                length_m = 0.0
                gain_m = 0.0
                loss_m = 0.0
                prev_xyz = None
                for lon, lat in sub_ll:
                    wx, wz = lon_lat_to_world(lon, lat)
                    wy = get_elev(lon, lat)
                    rx, ry, rz = round(wx, 1), round(wy, 1), round(wz, 1)
                    coords_flat.extend([rx, ry, rz])
                    xz_pts.append((rx, rz))
                    if prev_xyz is not None:
                        dx = rx - prev_xyz[0]
                        dz = rz - prev_xyz[2]
                        dy = ry - prev_xyz[1]
                        length_m += math.hypot(dx, dz)
                        if dy > 0:
                            gain_m += dy
                        else:
                            loss_m += -dy
                    prev_xyz = (rx, ry, rz)

                eid = f"e{edge_id_counter}"
                edge_id_counter += 1
                trail_edges.append({
                    "id": eid,
                    "u": u,
                    "v": v,
                    "name": name,
                    "routes": hw.get("routes", []),
                    "kind": kind,
                    "highway": hw["highway"],
                    "surface": surface,
                    "sacScale": sac_scale,
                    "widthM": width_m,
                    "difficulty": diff,
                    "lengthM": round(length_m, 1),
                    "gainM": round(gain_m, 1),
                    "lossM": round(loss_m, 1),
                    "coords": coords_flat,
                    "_xz": xz_pts,
                })
                graph_edges.append({
                    "id": eid,
                    "u": u,
                    "v": v,
                    "len": round(length_m, 1),
                    "gain": round(gain_m, 1),
                    "loss": round(loss_m, 1),
                    "kind": kind,
                    "name": name,
                    "coords": coords_flat,
                })
                seg_start = i

    # 3b. Inject traversable Gondola Base Plaza + Footbridge + Original Rundola (Gondola Cut) + San Sophia connectors
    # All vertices verified clear of OSM building footprints (b223628430..b223628435 at base, b231107849/b231107919 at San Sophia).
    def find_or_create_world_node(wx: float, wz: float, snap_m: float = 1.5) -> int:
        best_nid = None
        best_d2 = snap_m * snap_m
        for nid, (nx, _, nz) in enumerate(graph_node_list):
            d2 = (nx - wx) ** 2 + (nz - wz) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_nid = nid
        if best_nid is not None:
            return best_nid
        wy = sampler.sample_world(wx, wz)
        nid = len(graph_node_list)
        graph_node_list.append([round(wx, 1), round(wy, 1), round(wz, 1)])
        return nid

    def densify_xz(pts: list[tuple[float, float]], max_step_m: float = 30.0) -> list[tuple[float, float]]:
        out = [pts[0]]
        for i in range(1, len(pts)):
            ax, az = pts[i - 1]
            bx, bz = pts[i]
            seg = math.hypot(bx - ax, bz - az)
            if seg > max_step_m:
                n = int(seg // max_step_m)
                for k in range(1, n + 1):
                    f = k / (n + 1)
                    out.append((ax + (bx - ax) * f, az + (bz - az) * f))
            out.append((bx, bz))
        return out

    def add_synthetic_edge(
        pts_xz: list[tuple[float, float]],
        name: str,
        kind: str = "path",
        width_m: float = 1.8,
        diff: str = "easy",
        sac_scale: str = "",
        surface: str = "dirt",
        highway: str = "path",
        max_step_m: float = 0.0,
    ):
        nonlocal edge_id_counter
        u = find_or_create_world_node(pts_xz[0][0], pts_xz[0][1])
        v = find_or_create_world_node(pts_xz[-1][0], pts_xz[-1][1])
        pts = [(graph_node_list[u][0], graph_node_list[u][2])] + list(pts_xz[1:-1]) + [(graph_node_list[v][0], graph_node_list[v][2])]
        if max_step_m > 0.0:
            pts = densify_xz(pts, max_step_m=max_step_m)
        coords_flat = []
        xz_pts = []
        length_m = 0.0
        gain_m = 0.0
        loss_m = 0.0
        prev_xyz = None
        for idx_p, (px, pz) in enumerate(pts):
            if idx_p == 0:
                rx, ry, rz = graph_node_list[u]
            elif idx_p == len(pts) - 1:
                rx, ry, rz = graph_node_list[v]
            else:
                rx, rz = round(px, 1), round(pz, 1)
                ry = round(sampler.sample_world(rx, rz), 1)
            coords_flat.extend([rx, ry, rz])
            xz_pts.append((rx, rz))
            if prev_xyz is not None:
                length_m += math.hypot(rx - prev_xyz[0], rz - prev_xyz[2])
                dy = ry - prev_xyz[1]
                if dy > 0:
                    gain_m += dy
                else:
                    loss_m += -dy
            prev_xyz = (rx, ry, rz)
        eid = f"e{edge_id_counter}"
        edge_id_counter += 1
        trail_edges.append({
            "id": eid,
            "u": u,
            "v": v,
            "name": name,
            "routes": [],
            "kind": kind,
            "highway": highway,
            "surface": surface,
            "sacScale": sac_scale,
            "widthM": width_m,
            "difficulty": diff,
            "lengthM": round(length_m, 1),
            "gainM": round(gain_m, 1),
            "lossM": round(loss_m, 1),
            "coords": coords_flat,
            "_xz": xz_pts,
        })
        graph_edges.append({
            "id": eid,
            "u": u,
            "v": v,
            "len": round(length_m, 1),
            "gain": round(gain_m, 1),
            "loss": round(loss_m, 1),
            "kind": kind,
            "name": name,
            "coords": coords_flat,
        })

    # Gondola Base Plaza (S Oak St -> Oak St Gondola Plaza -> South Apron -> Gondola Base West Apron)
    # and Gondola Base Footbridge (West Apron -> San Miguel Footbridge -> Telluride Trail Base).
    # West Apron (-165.4, 176.1) is offset 6.5m SSE of Gondola Tower #1 (-167.3, 169.9) so spawns & cut clear all pylons >= 5m and buildings >= 9m.
    gondola_west_apron = (-165.4, 176.1)
    san_sophia_apron = (-1782.0, 677.0)
    add_synthetic_edge(
        [(-98.5, 162.0), (-118.0, 162.0), (-126.0, 183.0), (-162.0, 183.0), gondola_west_apron],
        name="Gondola Base Plaza",
        kind="path",
        width_m=2.6,
        diff="easy",
        surface="paved",
        highway="footway",
    )
    add_synthetic_edge(
        [gondola_west_apron, (-174.7, 194.8)],
        name="Gondola Base Footbridge",
        kind="path",
        width_m=2.2,
        diff="easy",
        surface="dirt",
        highway="footway",
    )

    # Original Rundola (Gondola Cut): direct bootpack running 6.5m SSE parallel to Gondola Line 1 (aw17145067 pts 1..21)
    # so the runner climbs directly beneath the gondola corridor while clearing every pylon mast by >= 5.0m.
    gondola_aw = next((a for a in raw["aerialways"] if a["id"] == 17145067), None)
    if gondola_aw and len(gondola_aw["coords"]) >= 22:
        raw_line_pts = [lon_lat_to_world(lon, lat) for lon, lat in gondola_aw["coords"][1:22]]
        g_dx = raw_line_pts[-1][0] - raw_line_pts[0][0]
        g_dz = raw_line_pts[-1][1] - raw_line_pts[0][1]
        g_len = math.hypot(g_dx, g_dz)
        # Right-hand perpendicular pointing SSE (+X, +Z) off the pylon centerline
        off_x = (g_dz / g_len) * 6.5
        off_z = (-g_dx / g_len) * 6.5
        gondola_line_pts = [(round(px + off_x, 1), round(pz + off_z, 1)) for px, pz in raw_line_pts]
        gondola_cut_pts = [gondola_west_apron] + gondola_line_pts[1:] + [san_sophia_apron]
        add_synthetic_edge(
            gondola_cut_pts,
            name="Original Rundola (Gondola Cut)",
            kind="path",
            width_m=1.4,
            diff="demanding_hard",
            sac_scale="demanding_mountain_hiking",
            surface="dirt",
            highway="path",
            max_step_m=30.0,
        )

    # San Sophia Station East Apron tie-ins to Telluride Trail top, Ridge Trail, and Village trail junction
    add_synthetic_edge(
        [san_sophia_apron, (-1776.0, 725.0), (-1789.6, 777.1)],
        name="San Sophia Station Connector",
        kind="path",
        width_m=2.2,
        diff="easy",
        surface="dirt",
        highway="footway",
    )
    add_synthetic_edge(
        [san_sophia_apron, (-1781.8, 658.8)],
        name="San Sophia Station Connector",
        kind="path",
        width_m=2.2,
        diff="easy",
        surface="dirt",
        highway="footway",
    )
    add_synthetic_edge(
        [san_sophia_apron, (-1779.4, 682.3)],
        name="San Sophia Station Connector",
        kind="path",
        width_m=2.2,
        diff="easy",
        surface="dirt",
        highway="footway",
    )

    print(f"Trail graph: {len(graph_node_list)} nodes, {len(trail_edges)} edges")

    # 4. Project waterways, lakes, waterfalls, buildings, aerialways, ski runs
    waterways = []
    for ww in raw["waterways"]:
        # Skip unnamed seasonal/intermittent dry gullies (keeps all named creeks/rivers + all perennial streams)
        if ww.get("intermittent") == "yes" and not ww.get("name"):
            continue
        coords_flat = []
        xz_pts = []
        for lon, lat in ww["coords"]:
            wx, wz = lon_lat_to_world(lon, lat)
            wy = get_elev(lon, lat)
            rx, ry, rz = round(wx, 1), round(wy, 1), round(wz, 1)
            coords_flat.extend([rx, ry, rz])
            xz_pts.append((rx, rz))
        w_m = parse_number(ww.get("width", ""), 0.0)
        if w_m <= 0:
            if ww["kind"] == "river":
                w_m = 7.5
            elif ww["kind"] in ("stream", "creek"):
                w_m = 2.4 if ww.get("name") else 1.6
            else:
                w_m = 1.5
        waterways.append({
            "id": f"w{ww['id']}",
            "name": ww["name"],
            "kind": ww["kind"],
            "widthM": round(w_m, 1),
            "coords": coords_flat,
            "_xz": xz_pts,
        })

    lakes = []
    for lk in raw["lakes"]:
        c_ll = lk["coords"]
        # Strip duplicate closing vertex so earcut / ShapeUtils.triangulateShape gets a clean open ring
        ring_ll = c_ll[:-1] if (len(c_ll) > 3 and c_ll[0] == c_ll[-1]) else c_ll
        if len(ring_ll) < 3:
            continue
        cx_ll = sum(p[0] for p in ring_ll) / len(ring_ll)
        cy_ll = sum(p[1] for p in ring_ll) / len(ring_ll)
        y_lake = round(get_elev(cx_ll, cy_ll), 1)
        coords_flat = []
        xz_pts = []
        for lon, lat in ring_ll:
            wx, wz = lon_lat_to_world(lon, lat)
            rx, rz = round(wx, 1), round(wz, 1)
            coords_flat.extend([rx, y_lake, rz])
            xz_pts.append((rx, rz))
        # Shoelace area on closed ring
        area = 0.0
        n_ring = len(xz_pts)
        for i in range(n_ring):
            j = (i + 1) % n_ring
            area += xz_pts[i][0] * xz_pts[j][1] - xz_pts[j][0] * xz_pts[i][1]
        area = abs(area) * 0.5
        if area < 40.0:
            continue
        min_x = min(p[0] for p in xz_pts)
        max_x = max(p[0] for p in xz_pts)
        min_z = min(p[1] for p in xz_pts)
        max_z = max(p[1] for p in xz_pts)
        lakes.append({
            "id": f"l{lk['id']}",
            "name": lk["name"],
            "kind": lk["kind"] or "lake",
            "y": y_lake,
            "areaM2": round(area, 1),
            "bbox": [min_x, min_z, max_x, max_z],
            "coords": coords_flat,
            "_xz": xz_pts,
        })

    waterfalls = []
    for wf in raw["waterfalls"]:
        wx, wz = lon_lat_to_world(wf["lon"], wf["lat"])
        wy = get_elev(wf["lon"], wf["lat"])
        hm = parse_number(wf.get("height", ""), 0.0)
        if hm <= 0:
            nm_l = (wf["name"] or "").lower()
            if "bridal veil" in nm_l:
                hm = 111.0
            elif "ingram" in nm_l:
                hm = 55.0
            elif "bear creek" in nm_l:
                hm = 24.0
            elif "cornet" in nm_l:
                hm = 25.0
            elif "mystic" in nm_l:
                hm = 20.0
            else:
                hm = 18.0
        waterfalls.append({
            "id": f"wf_{wf['id']}",
            "name": wf["name"],
            "x": round(wx, 1),
            "y": round(wy, 1),
            "z": round(wz, 1),
            "heightM": round(hm, 1),
        })

    buildings = []
    for b in raw["buildings"]:
        c_ll = b["coords"]
        ring_ll = c_ll[:-1] if (len(c_ll) > 3 and c_ll[0] == c_ll[-1]) else c_ll
        if len(ring_ll) < 3:
            continue
        cx_ll = sum(p[0] for p in ring_ll) / len(ring_ll)
        cy_ll = sum(p[1] for p in ring_ll) / len(ring_ll)
        base_y = round(get_elev(cx_ll, cy_ll), 1)
        coords_flat = []
        xz_pts = []
        for lon, lat in ring_ll:
            wx, wz = lon_lat_to_world(lon, lat)
            rx, rz = round(wx, 1), round(wz, 1)
            coords_flat.extend([rx, base_y, rz])
            xz_pts.append((rx, rz))
        kind, height_m, levels, town_name = classify_building(
            {**b, "coords": xz_pts}, towns
        )
        min_x = min(p[0] for p in xz_pts)
        max_x = max(p[0] for p in xz_pts)
        min_z = min(p[1] for p in xz_pts)
        max_z = max(p[1] for p in xz_pts)
        buildings.append({
            "id": f"b{b['id']}",
            "name": b["name"],
            "kind": kind,
            "town": town_name,
            "heightM": height_m,
            "levels": levels,
            "baseY": base_y,
            "bbox": [min_x, min_z, max_x, max_z],
            "coords": coords_flat,
            "_xz": xz_pts,
        })

    aw_nodes = raw.get("aerialway_nodes", {})
    aerialways = []
    for aw in raw["aerialways"]:
        coords_flat = []
        xz_pts = []
        pylons = []
        for idx, (lon, lat) in enumerate(aw["coords"]):
            wx, wz = lon_lat_to_world(lon, lat)
            wy = get_elev(lon, lat)
            rx, ry, rz = round(wx, 1), round(wy, 1), round(wz, 1)
            coords_flat.extend([rx, ry, rz])
            xz_pts.append((rx, rz))
            nid_str = str(aw["node_ids"][idx])
            if nid_str in aw_nodes:
                pylons.append({"x": rx, "y": ry, "z": rz})
        if not pylons:
            # Synthesize pylons every ~120m along lift if OSM didn't tag nodes
            pylons.append({"x": coords_flat[0], "y": coords_flat[1], "z": coords_flat[2]})
            for idx in range(1, len(xz_pts) - 1):
                pylons.append({"x": coords_flat[idx * 3], "y": coords_flat[idx * 3 + 1], "z": coords_flat[idx * 3 + 2]})
            pylons.append({"x": coords_flat[-3], "y": coords_flat[-2], "z": coords_flat[-1]})
        aerialways.append({
            "id": f"aw{aw['id']}",
            "name": aw["name"],
            "kind": aw["kind"],
            "pylons": pylons,
            "coords": coords_flat,
            "_xz": xz_pts,
        })

    ski_runs = []
    for sr in raw["ski_runs"]:
        coords_flat = []
        xz_pts = []
        for lon, lat in sr["coords"]:
            wx, wz = lon_lat_to_world(lon, lat)
            wy = get_elev(lon, lat)
            rx, ry, rz = round(wx, 1), round(wy, 1), round(wz, 1)
            coords_flat.extend([rx, ry, rz])
            xz_pts.append((rx, rz))
        ski_runs.append({
            "id": f"sr{sr['id']}",
            "name": sr["name"],
            "difficulty": sr["difficulty"] or "intermediate",
            "coords": coords_flat,
            "_xz": xz_pts,
        })

    # 5. Chunk into z13 tiles
    chunks: dict[tuple[int, int], dict] = {}

    def get_chunk(tx: int, ty: int) -> dict:
        c = chunks.get((tx, ty))
        if c is None:
            c = {
                "trails": [],
                "waterways": [],
                "lakes": [],
                "waterfalls": [],
                "buildings": [],
                "aerialways": [],
                "skiRuns": [],
            }
            chunks[(tx, ty)] = c
        return c

    def strip_internal(obj: dict) -> dict:
        return {k: v for k, v in obj.items() if not k.startswith("_") and k not in ("u", "v", "routes", "highway")}

    for e in trail_edges:
        for tx, ty in polyline_bbox_tiles(e["_xz"], CHUNK_ZOOM):
            get_chunk(tx, ty)["trails"].append(strip_internal(e))

    for w in waterways:
        for tx, ty in polyline_bbox_tiles(w["_xz"], CHUNK_ZOOM):
            get_chunk(tx, ty)["waterways"].append(strip_internal(w))

    for l in lakes:
        for tx, ty in polyline_bbox_tiles(l["_xz"], CHUNK_ZOOM):
            get_chunk(tx, ty)["lakes"].append(strip_internal(l))

    for wf in waterfalls:
        tx, ty = world_to_tile(wf["x"], wf["z"], CHUNK_ZOOM)
        get_chunk(tx, ty)["waterfalls"].append(wf)

    for b in buildings:
        for tx, ty in polyline_bbox_tiles(b["_xz"], CHUNK_ZOOM):
            get_chunk(tx, ty)["buildings"].append(strip_internal(b))

    for aw in aerialways:
        for tx, ty in polyline_bbox_tiles(aw["_xz"], CHUNK_ZOOM):
            get_chunk(tx, ty)["aerialways"].append(strip_internal(aw))

    for sr in ski_runs:
        for tx, ty in polyline_bbox_tiles(sr["_xz"], CHUNK_ZOOM):
            get_chunk(tx, ty)["skiRuns"].append(strip_internal(sr))

    # Write chunks
    chunks_dir = OUT_DIR / "chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    for old_f in chunks_dir.glob("*.json"):
        old_f.unlink()

    chunk_index = []
    total_chunk_bytes = 0
    tx_min, tx_max, ty_min, ty_max = bbox_tiles(BBOX, CHUNK_ZOOM)
    for (tx, ty), data in sorted(chunks.items()):
        if not (tx_min <= tx <= tx_max and ty_min <= ty <= ty_max):
            continue
        fname = f"{tx}_{ty}.json"
        fpath = chunks_dir / fname
        payload = json.dumps(data, separators=(",", ":"))
        fpath.write_text(payload)
        total_chunk_bytes += len(payload)
        min_x, max_x, min_z, max_z = tile_bounds_world(CHUNK_ZOOM, tx, ty)
        chunk_index.append({
            "tx": tx,
            "ty": ty,
            "file": f"chunks/{fname}",
            "bounds": [round(min_x, 1), round(min_z, 1), round(max_x, 1), round(max_z, 1)],
            "counts": {k: len(v) for k, v in data.items()},
        })

    # Write compact routing graph for runtime A*
    names_table = []
    name_to_idx = {}

    def get_name_idx(s: str) -> int:
        if not s:
            return -1
        idx = name_to_idx.get(s)
        if idx is None:
            idx = len(names_table)
            name_to_idx[s] = idx
            names_table.append(s)
        return idx

    kinds_list = ["trail", "path", "track", "road"]
    kind_to_idx = {k: i for i, k in enumerate(kinds_list)}
    flat_nodes = []
    for x, y, z in graph_node_list:
        flat_nodes.extend([int(round(x)), int(round(z))])  # integer meters XZ for compact A*

    compact_edges = []
    for e in trail_edges:
        # Subsample intermediate vertices >= 12m apart & integer-round so graph.json stays small
        c = e["coords"]
        n_pts = len(c) // 3
        xz_flat = [int(round(c[0])), int(round(c[2]))]
        last_x, last_z = c[0], c[2]
        for pt_i in range(1, n_pts - 1):
            px, pz = c[pt_i * 3], c[pt_i * 3 + 2]
            if math.hypot(px - last_x, pz - last_z) >= 12.0:
                xz_flat.extend([int(round(px)), int(round(pz))])
                last_x, last_z = px, pz
        if n_pts > 1:
            xz_flat.extend([int(round(c[-3])), int(round(c[-1]))])
        compact_edges.append([
            e["u"],
            e["v"],
            int(round(e["lengthM"])),
            kind_to_idx.get(e["kind"], 0),
            get_name_idx(e["name"]),
            xz_flat,
        ])

    graph_payload = json.dumps({
        "nodes": flat_nodes,
        "kinds": kinds_list,
        "names": names_table,
        "edges": compact_edges,
    }, separators=(",", ":"))
    graph_path = OUT_DIR / "graph.json"
    graph_path.write_text(graph_payload)

    # Corridor tile list for @terraindata (z14 + z15 tiles containing trails/buildings/waterways)
    z14_corridor = set()
    z15_corridor = set()
    for e in trail_edges:
        for rx, rz in e["_xz"]:
            z14_corridor.add(world_to_tile(rx, rz, 14))
            z15_corridor.add(world_to_tile(rx, rz, 15))
    # Dilate z14 by 1 tile for ridges/valleys around trails
    z14_dilated = set()
    for tx, ty in z14_corridor:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                z14_dilated.add((tx + dx, ty + dy))

    corridor_path = OUT_DIR / "corridor_tiles.json"
    corridor_path.write_text(json.dumps({
        "bbox": BBOX,
        "z14": sorted([list(t) for t in z14_dilated]),
        "z15_trails": sorted([list(t) for t in z15_corridor]),
    }, separators=(",", ":")))

    manifest = {
        "version": 1,
        "chunkZoom": CHUNK_ZOOM,
        "bbox": BBOX,
        "worldBbox": [round(v, 1) for v in world_bbox],
        "attribution": "Map data © OpenStreetMap contributors (ODbL); Elevation USGS 3DEP / Mapzen Terrarium",
        "stats": {
            "chunks": len(chunk_index),
            "chunksBytes": total_chunk_bytes,
            "graphBytes": len(graph_payload),
            "trailEdges": len(trail_edges),
            "waterways": len(waterways),
            "lakes": len(lakes),
            "waterfalls": len(waterfalls),
            "buildings": len(buildings),
            "aerialways": len(aerialways),
            "skiRuns": len(ski_runs),
            "pois": len(pois),
        },
        "chunks": chunk_index,
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))

    # Write projected bundle for race/POI builder
    proj_bundle = {
        "nodes": graph_node_list,
        "edges": [
            {k: v for k, v in e.items() if k != "_xz"}
            for e in trail_edges
        ],
        "pois": pois,
        "waterfalls": waterfalls,
        "lakes": [{k: v for k, v in l.items() if k != "_xz"} for l in lakes],
    }
    DEFAULT_PROJ.write_text(json.dumps(proj_bundle))

    print(
        f"Built {len(chunk_index)} z13 chunks ({total_chunk_bytes / 1e6:.2f} MB), "
        f"graph.json ({len(graph_payload) / 1e6:.2f} MB) in {time.time()-t0:.1f}s"
    )
    print("Stats:", json.dumps(manifest["stats"]))


if __name__ == "__main__":
    main()
