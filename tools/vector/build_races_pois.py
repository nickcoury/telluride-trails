"""
Build curated pois.json (35+ free-run spots + OSM peaks/passes/waterfalls/lakes/towns)
and races.json (13 races: 12 real San Juan races + Spurs Austin International Half Marathon
Easter egg using official CalTopo/OSM geometries, 15m z14 Terrarium elevation resampling,
and graph.json connector injection for route()).
"""

import heapq
import json
import math
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from geo import BBOX, M_TO_FT, M_TO_MI, lon_lat_to_world, world_to_lon_lat
from elevation import TerrariumSampler

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(os.path.expanduser("~/.cache/telluride-trails"))
CALTOPO_DIR = CACHE_DIR / "caltopo"
DEFAULT_PROJ = CACHE_DIR / "projected_bundle.json"
OUT_DIR = REPO_ROOT / "public" / "data" / "vector"


def dist2d(ax: float, az: float, bx: float, bz: float) -> float:
    return math.hypot(bx - ax, bz - az)


def compute_heading(tx: float, tz: float) -> float:
    """Match src/core/camera.js forward = (-sin(heading), -cos(heading))."""
    return round(math.atan2(-tx, -tz), 4)


def smooth_gain_loss(ys: list[float], threshold_m: float = 6.0) -> tuple[float, float]:
    """Compute vertical gain and loss with 3-pt binomial smooth + hysteresis threshold."""
    if len(ys) < 2:
        return 0.0, 0.0
    if len(ys) >= 3:
        ys = [ys[0]] + [0.25 * ys[i - 1] + 0.5 * ys[i] + 0.25 * ys[i + 1] for i in range(1, len(ys) - 1)] + [ys[-1]]
    gain = 0.0
    loss = 0.0
    anchor = ys[0]
    extreme = ys[0]
    trend = 0
    for y in ys[1:]:
        if trend == 0:
            if y - anchor >= threshold_m:
                trend = 1
                extreme = y
            elif anchor - y >= threshold_m:
                trend = -1
                extreme = y
        elif trend == 1:
            if y > extreme:
                extreme = y
            elif extreme - y >= threshold_m:
                gain += extreme - anchor
                anchor = extreme
                extreme = y
                trend = -1
        else:
            if y < extreme:
                extreme = y
            elif y - extreme >= threshold_m:
                loss += anchor - extreme
                anchor = extreme
                extreme = y
                trend = 1
    if trend == 1:
        gain += max(0.0, extreme - anchor)
    elif trend == -1:
        loss += max(0.0, anchor - extreme)
    return gain, loss


def simplify_polyline(pts: list[tuple[float, float, float, float]], tol_m: float = 2.0, max_seg_m: float = 120.0) -> list[tuple[float, float, float, float]]:
    """Douglas-Peucker 2D simplification preserving cumulative distance, endpoints, and max segment length."""
    if len(pts) <= 2:
        return pts

    def dp(start: int, end: int, keep: list[bool]):
        if end - start <= 1:
            return
        ax, _, az, _ = pts[start]
        bx, _, bz, _ = pts[end]
        dx = bx - ax
        dz = bz - az
        len_sq = dx * dx + dz * dz
        best_d = -1.0
        best_i = -1
        for i in range(start + 1, end):
            px, _, pz, _ = pts[i]
            if len_sq < 1e-6:
                d = math.hypot(px - ax, pz - az)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / len_sq))
                qx = ax + dx * t
                qz = az + dz * t
                d = math.hypot(px - qx, pz - qz)
            if d > best_d:
                best_d = d
                best_i = i
        if best_d > tol_m and best_i != -1:
            keep[best_i] = True
            dp(start, best_i, keep)
            dp(best_i, end, keep)
        elif max_seg_m > 0.0 and len_sq > max_seg_m * max_seg_m:
            mid = (start + end) // 2
            keep[mid] = True
            dp(start, mid, keep)
            dp(mid, end, keep)

    keep = [False] * len(pts)
    keep[0] = True
    keep[-1] = True
    dp(0, len(pts) - 1, keep)
    return [pts[i] for i in range(len(pts)) if keep[i]]


class TrailNetwork:
    def __init__(self, proj: dict):
        self.nodes = proj["nodes"]  # [[x, y, z], ...]
        self.edges = proj["edges"]
        self.adj = defaultdict(list)
        for ei, e in enumerate(self.edges):
            self.adj[e["u"]].append((e["v"], ei, False))
            self.adj[e["v"]].append((e["u"], ei, True))

        # Largest connected component
        seen = set()
        best_comp = set()
        for nid in range(len(self.nodes)):
            if nid in seen:
                continue
            q = [nid]
            seen.add(nid)
            comp = set()
            while q:
                u = q.pop()
                comp.add(u)
                for v, _, _ in self.adj[u]:
                    if v not in seen:
                        seen.add(v)
                        q.append(v)
            if len(comp) > len(best_comp):
                best_comp = comp
        self.main_comp = best_comp

        self.cell_size = 150.0
        self.edge_grid = defaultdict(list)
        for ei, e in enumerate(self.edges):
            c = e["coords"]
            for i in range(0, len(c) - 3, 3):
                x0, z0 = c[i], c[i + 2]
                x1, z1 = c[i + 3], c[i + 5]
                cx0 = int(math.floor(min(x0, x1) / self.cell_size))
                cx1 = int(math.floor(max(x0, x1) / self.cell_size))
                cz0 = int(math.floor(min(z0, z1) / self.cell_size))
                cz1 = int(math.floor(max(z0, z1) / self.cell_size))
                for cx in range(cx0, cx1 + 1):
                    for cz in range(cz0, cz1 + 1):
                        self.edge_grid[(cx, cz)].append((ei, i))

    def snap_to_trail(self, x: float, z: float, max_dist: float = 1200.0, main_only: bool = False):
        rad = int(math.ceil(max_dist / self.cell_size))
        cx0 = int(math.floor(x / self.cell_size))
        cz0 = int(math.floor(z / self.cell_size))
        best_d2 = max_dist * max_dist
        best = None
        for cx in range(cx0 - rad, cx0 + rad + 1):
            for cz in range(cz0 - rad, cz0 + rad + 1):
                for ei, ci in self.edge_grid.get((cx, cz), ()):
                    e = self.edges[ei]
                    if main_only and e["u"] not in self.main_comp:
                        continue
                    c = e["coords"]
                    x0, y0, z0 = c[ci], c[ci + 1], c[ci + 2]
                    x1, y1, z1 = c[ci + 3], c[ci + 4], c[ci + 5]
                    dx = x1 - x0
                    dz = z1 - z0
                    l2 = dx * dx + dz * dz
                    if l2 < 1e-6:
                        continue
                    t = max(0.0, min(1.0, ((x - x0) * dx + (z - z0) * dz) / l2))
                    px = x0 + dx * t
                    pz = z0 + dz * t
                    py = y0 + (y1 - y0) * t
                    d2 = (x - px) ** 2 + (z - pz) ** 2
                    if d2 < best_d2:
                        best_d2 = d2
                        l = math.sqrt(l2)
                        best = (px, py, pz, dx / l, dz / l, ei)
        return best

    def dist_to_trail(self, x: float, z: float, max_dist: float = 200.0) -> float:
        s = self.snap_to_trail(x, z, max_dist=max_dist, main_only=True)
        if not s:
            return max_dist + 1.0
        return dist2d(x, z, s[0], s[2])

    def nearest_node(self, x: float, z: float, max_dist: float = 2500.0, main_only: bool = True) -> int | None:
        snapped = self.snap_to_trail(x, z, max_dist=max_dist, main_only=main_only)
        if snapped:
            ei = snapped[5]
            e = self.edges[ei]
            u, v = e["u"], e["v"]
            du = dist2d(x, z, self.nodes[u][0], self.nodes[u][2])
            dv = dist2d(x, z, self.nodes[v][0], self.nodes[v][2])
            return u if du <= dv else v

        best_d2 = max_dist * max_dist
        best_n = None
        pool = self.main_comp if main_only else range(len(self.nodes))
        for nid in pool:
            nx, _, nz = self.nodes[nid]
            d2 = (nx - x) ** 2 + (nz - z) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_n = nid
        return best_n

    def astar(
        self,
        start_nid: int,
        goal_nid: int,
        kind_weights: dict[str, float] | None = None,
        avoid_name_substrs: tuple[str, ...] = (),
        prefer_name_substrs: tuple[str, ...] = (),
        max_expansions: int = 80000,
    ):
        if start_nid == goal_nid:
            return []
        if kind_weights is None:
            kind_weights = {"trail": 1.0, "path": 1.05, "track": 1.12, "road": 1.55}

        gx, _, gz = self.nodes[goal_nid]
        g_score = {start_nid: 0.0}
        prev = {}
        heap = [(dist2d(self.nodes[start_nid][0], self.nodes[start_nid][2], gx, gz), 0.0, start_nid)]
        closed = set()
        expansions = 0

        while heap and expansions < max_expansions:
            _, cur_g, u = heapq.heappop(heap)
            if u in closed:
                continue
            if u == goal_nid:
                chain = []
                cur = goal_nid
                while cur in prev:
                    p, ei, rev = prev[cur]
                    chain.append((ei, rev))
                    cur = p
                chain.reverse()
                return chain
            closed.add(u)
            expansions += 1

            for v, ei, rev in self.adj[u]:
                if v in closed:
                    continue
                e = self.edges[ei]
                w = e["lengthM"] * kind_weights.get(e["kind"], 1.2)
                name_l = (e.get("name", "") + " " + " ".join(e.get("routes", []))).lower()
                if avoid_name_substrs and any(s in name_l for s in avoid_name_substrs):
                    w *= 4.0
                if prefer_name_substrs and any(s in name_l for s in prefer_name_substrs):
                    w *= 0.8
                ng = cur_g + w
                if ng < g_score.get(v, float("inf")):
                    g_score[v] = ng
                    prev[v] = (u, ei, rev)
                    vx, _, vz = self.nodes[v]
                    h = dist2d(vx, vz, gx, gz) * 0.95
                    heapq.heappush(heap, (ng + h, ng, v))
        return None


def build_curated_pois(proj: dict, net: TrailNetwork, sampler: TerrariumSampler) -> list[dict]:
    osm_pois = proj["pois"]
    osm_waterfalls = proj["waterfalls"]
    osm_lakes = proj["lakes"]

    def match_osm(name_sub: str, near_ll: tuple[float, float], kind_filter=None, max_m: float = 2500.0):
        tx, tz = lon_lat_to_world(*near_ll)
        best = None
        best_d = max_m
        nl = name_sub.lower()
        for p in osm_pois:
            if kind_filter and p["kind"] not in kind_filter:
                continue
            if nl not in (p.get("name") or "").lower():
                continue
            d = dist2d(tx, tz, p["x"], p["z"])
            if d < best_d:
                best_d = d
                best = p
        return best

    def match_waterfall(name_sub: str, near_ll: tuple[float, float], max_m: float = 2500.0):
        tx, tz = lon_lat_to_world(*near_ll)
        best = None
        best_d = max_m
        nl = name_sub.lower()
        for wf in osm_waterfalls:
            if nl not in (wf.get("name") or "").lower():
                continue
            d = dist2d(tx, tz, wf["x"], wf["z"])
            if d < best_d:
                best_d = d
                best = wf
        return best

    def match_lake(name_sub: str, near_ll: tuple[float, float], max_m: float = 3500.0):
        tx, tz = lon_lat_to_world(*near_ll)
        best = None
        best_d = max_m
        nl = name_sub.lower()
        for lk in osm_lakes:
            if nl not in (lk.get("name") or "").lower():
                continue
            cx = (lk["bbox"][0] + lk["bbox"][2]) * 0.5
            cz = (lk["bbox"][1] + lk["bbox"][3]) * 0.5
            d = dist2d(tx, tz, cx, cz)
            if d < best_d:
                best_d = d
                best = {"x": round(cx, 1), "z": round(cz, 1), "y": lk["y"]}
        return best

    CURATED = [
        # Telluride
        ("telluride-town", "Telluride Gondola Plaza (Oak St Base)", "town", "Telluride", (-107.813644, 37.936045), (-107.7850, 37.9355), False, "Historic box-canyon hub at 8,755 ft right outside Telluride Gondola Plaza — head east toward Ajax Peak & Bridal Veil or west up the gondola corridor."),
        ("telluride-town-park", "Telluride Town Park", "trailhead", "Telluride", (-107.8058, 37.9356), (-107.7950, 37.9260), True, "East end of town where Bear Creek, Bridal Veil, and TMR kick off."),
        ("bear-creek-th", "Bear Creek Trailhead", "trailhead", "Telluride", (-107.8085, 37.9325), (-107.8020, 37.9100), True, "Iconic box-canyon singletrack climbing toward Bear Creek Falls & Wasatch."),
        ("jud-wiebe-th", "Jud Wiebe Trailhead", "trailhead", "Telluride", (-107.8152, 37.9403), (-107.8180, 37.9450), True, "Beloved 3-mile sunny aspen loop perched directly above downtown Telluride."),
        ("bridal-veil-falls", "Bridal Veil Falls", "waterfall", "Telluride", (-107.7689, 37.9182), (-107.7685, 37.9165), True, "Colorado's tallest free-falling waterfall (365 ft) at the east headwall of Telluride."),
        ("bridal-veil-basin", "Bridal Veil Basin", "viewpoint", "Telluride", (-107.7650, 37.9110), (-107.7550, 37.9050), True, "High alpine basin above the historic 1907 hydroelectric powerhouse."),
        ("ingram-falls", "Ingram Falls", "waterfall", "Telluride", (-107.7722, 37.9262), (-107.7550, 37.9330), True, "Roaring cascade along the Black Bear / Tomboy switchbacks above Pandora."),
        ("cornet-creek-falls", "Cornet Creek Falls", "waterfall", "Telluride", (-107.8108, 37.9422), (-107.8105, 37.9400), True, "Dramatic red-sandstone waterfall tucked right behind town off Jud Wiebe."),
        ("bear-creek-falls", "Bear Creek Falls", "waterfall", "Telluride", (-107.8125, 37.9060), (-107.8050, 37.8960), True, "2.5 miles up Bear Creek Preserve at 9,980 ft — turn around or push for Wasatch Pass."),
        ("san-sophia-gondola", "Telluride Gondola — San Sophia Station", "viewpoint", "Telluride", (-107.832597, 37.931418), (-107.813644, 37.936045), False, "10,540 ft ridge crest station directly atop Gondola Line 1 (finish of both Rundola courses)."),
        ("mountain-village", "Mountain Village Heritage Plaza", "town", "Telluride", (-107.8473, 37.9319), (-107.8350, 37.9280), True, "9,545 ft ski village linked by free gondola and singletrack loops."),
        ("deep-creek-th", "Deep Creek Trailhead", "trailhead", "Telluride", (-107.8825, 37.9688), (-107.8550, 37.9720), True, "Aspen-lined singletrack bench linking Last Dollar Rd to Mill Creek and town."),
        ("mill-creek-th", "Mill Creek / Waterline Trailhead", "trailhead", "Telluride", (-107.8350, 37.9510), (-107.8250, 37.9470), True, "Shaded north-side singletrack traversing Eider Creek and Waterline."),
        ("ajax-peak", "Ajax Peak", "peak", "Telluride", (-107.7592, 37.9308), (-107.7490, 37.9312), False, "12,785 ft rocky prow anchoring the Mile and a Half of Sky ridge."),
        ("telluride-peak", "Telluride Peak", "peak", "Telluride", (-107.7490, 37.9312), (-107.7372, 37.9325), False, "13,509 ft high-wire ridge summit between Ajax Peak and Imogene Pass."),
        ("imogene-pass", "Imogene Pass", "pass", "Telluride", (-107.7372, 37.9325), (-107.7535, 37.9332), True, "13,114 ft crest connecting Ouray and Telluride — highest point of the Imogene Run."),
        ("black-bear-pass", "Black Bear Pass", "pass", "Telluride", (-107.7435, 37.8995), (-107.7680, 37.9160), True, "12,840 ft white-knuckle shelf road dropping above Bridal Veil Falls."),
        ("alta-lakes", "Alta Lakes", "lake", "Telluride", (-107.8404, 37.8866), (-107.8464, 37.8859), True, "High alpine lakes at 11,300 ft beneath Bald Mountain and Palmyra."),

        # Ophir & Lizard Head
        ("ophir-town", "Ophir Town", "town", "Ophir & Lizard Head", (-107.8328, 37.8569), (-107.8100, 37.8540), True, "Tiny 9,695 ft valley hamlet guarding the western approach to Ophir Pass."),
        ("ophir-pass", "Ophir Pass", "pass", "Ophir & Lizard Head", (-107.7810, 37.8531), (-107.8050, 37.8540), True, "11,789 ft rocky divide linking Ophir and Red Mountain Highway."),
        ("lizard-head-pass", "Lizard Head Pass", "pass", "Ophir & Lizard Head", (-107.9084, 37.8096), (-107.9350, 37.8250), True, "10,222 ft pass staring straight at the Lizard Head spire."),
        ("trout-lake", "Trout Lake", "lake", "Ophir & Lizard Head", (-107.8842, 37.8235), (-107.8650, 37.8150), True, "High mountain reservoir below Sheep Mountain and Yellow Mountain."),
        ("hope-lake-th", "Hope Lake Trailhead", "trailhead", "Ophir & Lizard Head", (-107.8490, 37.8015), (-107.8320, 37.7950), True, "Steep subalpine climb to 11,880 ft Hope Lake in the Lizard Head Wilderness."),
        ("grant-swamp-pass", "Grant Swamp Pass", "pass", "Ophir & Lizard Head", (-107.7995, 37.8230), (-107.8078, 37.8448), True, "Infamous 12,920 ft Hardrock scree couloir between KT and Chapman Gulch."),

        # Sneffels & Blue Lakes
        ("blue-lakes-th", "Blue Lakes Trailhead", "trailhead", "Sneffels & Blue Lakes", (-107.8077, 38.0340), (-107.8168, 38.0027), True, "Gateway to the glowing turquoise glacial tarns beneath Mt. Sneffels."),
        ("lower-blue-lake", "Lower Blue Lake", "lake", "Sneffels & Blue Lakes", (-107.8151, 38.0008), (-107.8085, 38.0013), True, "Turquoise alpine jewel at 10,910 ft below Dallas Peak and Sneffels."),
        ("blue-lakes-pass", "Blue Lakes Pass", "pass", "Sneffels & Blue Lakes", (-107.7847, 37.9948), (-107.7653, 37.9883), True, "13,000 ft divide linking Blue Lakes basin and Yankee Boy Basin."),
        ("yankee-boy-basin", "Yankee Boy Basin / Mt. Sneffels TH", "trailhead", "Sneffels & Blue Lakes", (-107.7830, 37.9890), (-107.7920, 38.0030), True, "Wildflower-choked high cirque under 14,150 ft Mt. Sneffels."),
        ("virginius-pass", "Virginius Pass (Kroger's Canteen)", "pass", "Sneffels & Blue Lakes", (-107.7786, 37.9555), (-107.7590, 37.9710), True, "13,100 ft knife-edge notch hosting Hardrock's highest aid station."),
        ("governor-basin", "Governor Basin", "viewpoint", "Sneffels & Blue Lakes", (-107.7590, 37.9710), (-107.7300, 37.9750), True, "High mining cirque on the Camp Bird / Virginius approach."),

        # Ouray
        ("ouray-perimeter", "Ouray Perimeter Trail / Fellin Park", "trailhead", "Ouray", (-107.6714, 38.0228), (-107.6650, 38.0190), True, "7,792 ft 'Switzerland of America' — start of Imogene Pass Run & Perimeter loop."),
        ("box-canyon-ouray", "Box Canyon Falls (Ouray)", "waterfall", "Ouray", (-107.6778, 38.0195), (-107.6850, 38.0100), True, "Thundering quartzite gorge and Perimeter Trail footbridge above Ouray."),
        ("engineer-pass", "Engineer Pass", "pass", "Ouray", (-107.5844, 37.9752), (-107.5710, 37.9400), True, "12,800 ft Alpine Loop saddle overlooking the Uncompahgre and Animas watersheds."),
        ("red-mountain-pass", "Red Mountain Pass", "pass", "Ouray", (-107.7118, 37.8992), (-107.7050, 37.9150), True, "11,018 ft iron-oxide pass on the Million Dollar Highway."),

        # Silverton
        ("silverton-town", "Silverton (Hardrock Start / Finish)", "town", "Silverton", (-107.6657, 37.8124), (-107.6500, 37.8150), True, "9,318 ft mining town — home of the painted ram rock and Hardrock 100."),
        ("kendall-mountain-th", "Kendall Mountain Trailhead", "trailhead", "Silverton", (-107.6636, 37.8125), (-107.6419, 37.7938), True, "Memorial Park start for the 12.3-mile climb up Kendall Mountain."),
        ("kendall-summit", "Kendall Mountain Summit", "peak", "Silverton", (-107.6419, 37.7938), (-107.6606, 37.8165), True, "13,066 ft summit overlooking Silverton and the Animas River canyon."),
        ("ice-lake-th", "Ice Lake Trailhead (South Mineral)", "trailhead", "Silverton", (-107.7755, 37.8130), (-107.7950, 37.8140), True, "Steep switchbacks climbing into the legendary Ice Lakes Basin."),
        ("ice-lake-basin", "Ice Lake Basin", "lake", "Silverton", (-107.8095, 37.8138), (-107.8058, 37.8220), True, "Surreal electric-blue alpine basin at 12,270 ft below Fuller Peak."),
        ("molas-pass", "Molas Pass (Colorado Trail)", "pass", "Silverton", (-107.6975, 37.7365), (-107.6850, 37.7550), True, "10,910 ft Colorado Trail crossing with panoramic Grenadier Range views."),
        ("animas-forks", "Animas Forks Ghost Town", "viewpoint", "Silverton", (-107.5714, 37.9311), (-107.5550, 37.9220), True, "11,200 ft preserved silver-mining ghost town on the Alpine Loop."),

        # Lake City & Handies
        ("handies-peak", "Handies Peak", "peak", "Lake City & Handies", (-107.5045, 37.9130), (-107.4850, 37.9250), True, "14,048 ft highest point of the Hardrock 100 — 360° San Juan crown."),
        ("american-basin", "American Basin Trailhead", "trailhead", "Lake City & Handies", (-107.5230, 37.9080), (-107.5045, 37.9130), True, "Lush 11,500 ft wildflower bowl on the west flank of Handies Peak."),
        ("cinnamon-pass", "Cinnamon Pass", "pass", "Lake City & Handies", (-107.5390, 37.9365), (-107.5050, 37.9350), True, "12,640 ft divide linking Animas Forks to Lake City's Burrows Park."),
        ("sherman-th", "Sherman / Cataract Gulch Trailhead", "trailhead", "Lake City & Handies", (-107.4345, 37.9025), (-107.4450, 37.8750), True, "Hardrock aid station at the mouth of Cataract Gulch."),
        ("lake-city-town", "Lake City Town Park", "town", "Lake City & Handies", (-107.3173, 38.0287), (-107.3350, 38.0150), True, "8,671 ft start/finish hub for the San Juan Solstice 50."),
    ]

    result = []
    used_keys = set()

    def is_duplicate_poi(name: str, x: float, z: float) -> bool:
        nl = name.lower().strip()
        for existing in result:
            enl = existing["name"].lower().strip()
            d = dist2d(x, z, existing["x"], existing["z"])
            if d < 320.0:
                return True
            if enl == nl and d < 7500.0:
                return True
        return False

    for pid, name, kind, area, ll, look_ll, snap_flag, desc in CURATED:
        matched = None
        if kind in ("peak", "pass", "town"):
            matched = match_osm(name.split("(")[0].strip(), ll, kind_filter={kind}, max_m=1500.0)
        elif kind == "waterfall":
            matched = match_waterfall(name.split("(")[0].strip().replace("Falls", "").strip(), ll, max_m=2200.0)
        elif kind == "lake":
            matched = match_lake(name.split("(")[0].replace("Basin", "").strip(), ll, max_m=3000.0)

        if matched:
            wx, wz, wy = matched["x"], matched["z"], matched["y"]
        else:
            wx, wz = lon_lat_to_world(*ll)
            wy = sampler.sample_lon_lat(*ll)

        look_x, look_z = lon_lat_to_world(*look_ll)
        heading = compute_heading(look_x - wx, look_z - wz)

        if snap_flag:
            snapped = net.snap_to_trail(wx, wz, max_dist=350.0)
            if snapped:
                sx, sy, sz, tx, tz, _ = snapped
                wx, wz = sx, sz
                # Preserve exact matched elevation for peaks, passes, waterfalls, and lakes!
                if not (matched and kind in ("peak", "pass", "waterfall", "lake")):
                    wy = sy
                if tx * (look_x - wx) + tz * (look_z - wz) < 0:
                    tx, tz = -tx, -tz
                heading = compute_heading(tx, tz)

        used_keys.add((round(wx / 300), round(wz / 300)))
        result.append({
            "id": pid,
            "name": name,
            "kind": kind,
            "area": area,
            "x": round(wx, 1),
            "z": round(wz, 1),
            "y": round(wy, 1),
            "heading": heading,
            "freeRun": True,
            "description": desc,
        })

    def area_from_xz(x: float, z: float) -> str:
        hubs = [
            ("Telluride", 0.0, 0.0),
            ("Ouray", 12300.0, -9500.0),
            ("Silverton", 13000.0, 14000.0),
            ("Lake City & Handies", 43500.0, -10000.0),
        ]
        return min(hubs, key=lambda h: (x - h[1]) ** 2 + (z - h[2]) ** 2)[0]

    wx_min, wz_max = lon_lat_to_world(BBOX["west"], BBOX["south"])
    wx_max, wz_min = lon_lat_to_world(BBOX["east"], BBOX["north"])

    for p in osm_pois:
        if not p.get("name"):
            continue
        if not (wx_min <= p["x"] <= wx_max and wz_min <= p["z"] <= wz_max):
            continue
        if p["kind"] not in ("peak", "pass", "trailhead", "viewpoint", "town"):
            continue
        if p["kind"] == "peak" and p["y"] < 3800:
            continue
        if is_duplicate_poi(p["name"], p["x"], p["z"]):
            continue
        heading = 0.0
        snapped = net.snap_to_trail(p["x"], p["z"], max_dist=150.0)
        if snapped:
            heading = compute_heading(snapped[3], snapped[4])
        result.append({
            "id": p["id"],
            "name": p["name"],
            "kind": p["kind"],
            "area": area_from_xz(p["x"], p["z"]),
            "x": p["x"],
            "z": p["z"],
            "y": p["y"],
            "heading": heading,
            "freeRun": p["kind"] in ("trailhead", "viewpoint", "town"),
        })

    for wf in osm_waterfalls:
        if not wf.get("name") or wf["name"] == "Waterfall":
            continue
        if not (wx_min <= wf["x"] <= wx_max and wz_min <= wf["z"] <= wz_max):
            continue
        wf_area = area_from_xz(wf["x"], wf["z"])
        wf_name = wf["name"]
        if wf_name == "Bear Creek Falls" and wf_area == "Ouray":
            wf_name = "Bear Creek Falls (Ouray)"
        if is_duplicate_poi(wf_name, wf["x"], wf["z"]):
            continue
        result.append({
            "id": wf["id"],
            "name": wf_name,
            "kind": "waterfall",
            "area": wf_area,
            "x": wf["x"],
            "z": wf["z"],
            "y": wf["y"],
            "heading": 0.0,
            "freeRun": False,
        })

    for lk in osm_lakes:
        if not lk.get("name") or lk["areaM2"] < 12000:
            continue
        cx = (lk["bbox"][0] + lk["bbox"][2]) * 0.5
        cz = (lk["bbox"][1] + lk["bbox"][3]) * 0.5
        if not (wx_min <= cx <= wx_max and wz_min <= cz <= wz_max):
            continue
        if is_duplicate_poi(lk["name"], cx, cz):
            continue
        result.append({
            "id": lk["id"],
            "name": lk["name"],
            "kind": "lake",
            "area": area_from_xz(cx, cz),
            "x": round(cx, 1),
            "z": round(cz, 1),
            "y": lk["y"],
            "heading": 0.0,
            "freeRun": False,
        })

    print(f"Curated POIs: {len(result)} total ({sum(1 for p in result if p.get('freeRun'))} freeRun spots)")
    return result


def load_caltopo_line(fname: str, ordered_titles: list[str] | None = None) -> list[tuple[float, float]]:
    d = json.loads((CALTOPO_DIR / fname).read_text()).get("result", {}).get("state", {}).get("features", [])
    lines = {}
    for feat in d:
        g = feat.get("geometry", {})
        if g.get("type") == "LineString":
            t = feat.get("properties", {}).get("title", "")
            lines[t] = [(c[0], c[1]) for c in g["coordinates"]]
    if ordered_titles:
        pts = []
        for t in ordered_titles:
            pts.extend(lines[t])
        return pts
    return max(lines.values(), key=len)


def resample_and_eval(
    xz_pts: list[tuple[float, float]],
    sampler: TerrariumSampler,
    step_m: float = 15.0,
    gain_threshold_m: float = 6.0,
) -> tuple[list[tuple[float, float, float, float]], float, float]:
    """Resample XZ polyline every step_m, sample z14 Terrarium elevation, compute cumDist & gain."""
    dense_xz = [xz_pts[0]]
    for i in range(1, len(xz_pts)):
        ax, az = xz_pts[i - 1]
        bx, bz = xz_pts[i]
        seg = math.hypot(bx - ax, bz - az)
        if seg < 0.2:
            continue
        if seg > step_m:
            n = int(seg // step_m)
            for k in range(1, n + 1):
                f = k / (n + 1)
                dense_xz.append((ax + (bx - ax) * f, az + (bz - az) * f))
        dense_xz.append((bx, bz))

    ys = [sampler.sample_world(x, z) for x, z in dense_xz]
    gain_m, loss_m = smooth_gain_loss(ys, threshold_m=gain_threshold_m)

    dense_full = []
    cum = 0.0
    for i, (x, z) in enumerate(dense_xz):
        if i > 0:
            cum += dist2d(dense_xz[i - 1][0], dense_xz[i - 1][1], x, z)
        dense_full.append((x, ys[i], z, cum))
    return dense_full, cum, gain_m


def route_osm_xz(net: TrailNetwork, waypoints_ll: list[tuple[float, float]], kind_weights=None, avoid_names=(), prefer_names=(), max_detour_ratio=4.0) -> list[tuple[float, float]]:
    pts = []
    prev_nid = None
    prev_xz = None
    for idx, (lon, lat) in enumerate(waypoints_ll):
        wx, wz = lon_lat_to_world(lon, lat)
        nid = net.nearest_node(wx, wz, max_dist=2500.0, main_only=True)
        if idx == 0:
            nx, _, nz = net.nodes[nid]
            pts.append((nx, nz))
            prev_nid = nid
            prev_xz = (nx, nz)
            continue
        chain = net.astar(prev_nid, nid, kind_weights=kind_weights, avoid_name_substrs=avoid_names, prefer_name_substrs=prefer_names)
        if chain is not None:
            straight = dist2d(prev_xz[0], prev_xz[1], net.nodes[nid][0], net.nodes[nid][2])
            path_len = sum(net.edges[ei]["lengthM"] for ei, _ in chain)
            if path_len <= max(5000.0, straight * max_detour_ratio):
                for ei, rev in chain:
                    c = net.edges[ei]["coords"]
                    n_pts = len(c) // 3
                    rng = range(n_pts - 1, -1, -1) if rev else range(n_pts)
                    for j in rng:
                        px, pz = c[j * 3], c[j * 3 + 2]
                        if dist2d(pts[-1][0], pts[-1][1], px, pz) > 0.5:
                            pts.append((px, pz))
                prev_nid = nid
                prev_xz = (net.nodes[nid][0], net.nodes[nid][2])
                continue
        tx, _, tz = net.nodes[nid]
        pts.append((tx, tz))
        prev_nid = nid
        prev_xz = (tx, tz)
    return pts


def project_checkpoints(dense_full: list[tuple[float, float, float, float]], cp_defs: list[dict]) -> list[dict]:
    """Project checkpoints onto the race polyline in strictly monotonic progression order, honoring targetMi/byDistM."""
    n = len(dense_full)
    min_idx = 0
    out = []
    for cp in cp_defs:
        if cp.get("isFinish"):
            bi = n - 1
        elif cp.get("byDistM") is not None:
            target_d = cp["byDistM"]
            bi = min(range(min_idx, n), key=lambda i: abs(dense_full[i][3] - target_d))
            min_idx = min(n - 1, bi + 1)
        elif cp.get("targetMi") is not None:
            cx, cz = lon_lat_to_world(cp["lon"], cp["lat"])
            target_d = cp["targetMi"] * 1609.344
            window_d = cp.get("windowMi", 2.5) * 1609.344
            bi = min_idx
            best_score = float("inf")
            for i in range(min_idx, n):
                pd_i = dense_full[i][3]
                if abs(pd_i - target_d) > window_d:
                    continue
                d2 = (dense_full[i][0] - cx) ** 2 + (dense_full[i][2] - cz) ** 2
                score = d2 + ((pd_i - target_d) * 0.25) ** 2
                if score < best_score:
                    best_score = score
                    bi = i
            if best_score == float("inf"):
                bi = min(range(min_idx, n), key=lambda i: abs(dense_full[i][3] - target_d))
            min_idx = min(n - 1, bi + 1)
        else:
            cx, cz = lon_lat_to_world(cp["lon"], cp["lat"])
            bi = min_idx
            best_d2 = float("inf")
            for i in range(min_idx, n):
                d2 = (dense_full[i][0] - cx) ** 2 + (dense_full[i][2] - cz) ** 2
                if d2 < best_d2:
                    best_d2 = d2
                    bi = i
                elif best_d2 < 80 * 80 and d2 > 2000 * 2000:
                    break
            min_idx = min(n - 1, bi + 1)
        px, py, pz, pd = dense_full[bi]
        obj = {"name": cp["name"], "d": round(pd, 1), "x": round(px, 1), "z": round(pz, 1), "y": round(py, 1)}
        if cp.get("cutoffH") is not None:
            obj["cutoffH"] = cp["cutoffH"]
        out.append(obj)
    return out


def inject_graph_connectors(net: TrailNetwork, race_tracks_xz: list[list[tuple[float, float]]], graph_path: Path):
    """
    Find off-trail / pass stretches along race tracks >120m from any OSM trail edge
    and add them as traversable trail edges to graph.json so route() / autopilot works everywhere.
    """
    graph = json.loads(graph_path.read_text())
    nodes_flat = graph["nodes"]  # [x0, z0, x1, z1, ...]
    edges = graph["edges"]       # [u, v, len, kindIdx, nameIdx, xzFlat]
    names = graph["names"]

    route_name = "Alpine Race Route Connector"
    if route_name not in names:
        name_idx = len(names)
        names.append(route_name)
    else:
        name_idx = names.index(route_name)
        edges[:] = [e for e in edges if e[4] != name_idx]

    added_edges = 0
    for track_xz in race_tracks_xz:
        # Subsample every ~100m to detect gaps > 140m from OSM graph
        samples = [track_xz[0]]
        acc = 0.0
        for i in range(1, len(track_xz)):
            d = dist2d(track_xz[i - 1][0], track_xz[i - 1][1], track_xz[i][0], track_xz[i][1])
            acc += d
            if acc >= 80.0:
                samples.append(track_xz[i])
                acc = 0.0
        samples.append(track_xz[-1])

        in_gap = False
        gap_pts = []
        gap_start_nid = None

        for i, (px, pz) in enumerate(samples):
            d_osm = net.dist_to_trail(px, pz, max_dist=140.0)
            if d_osm > 120.0:
                if not in_gap:
                    in_gap = True
                    prev_pt = samples[max(0, i - 1)]
                    gap_start_nid = net.nearest_node(prev_pt[0], prev_pt[1], max_dist=1500.0, main_only=True)
                    gap_pts = [prev_pt, (px, pz)]
                else:
                    gap_pts.append((px, pz))
            else:
                if in_gap:
                    gap_pts.append((px, pz))
                    gap_end_nid = net.nearest_node(px, pz, max_dist=1500.0, main_only=True)
                    if gap_start_nid is not None and gap_end_nid is not None and gap_start_nid != gap_end_nid:
                        # Build traversable edge connecting gap_start_nid -> gap_pts -> gap_end_nid
                        su = (nodes_flat[gap_start_nid * 2], nodes_flat[gap_start_nid * 2 + 1])
                        ev = (nodes_flat[gap_end_nid * 2], nodes_flat[gap_end_nid * 2 + 1])
                        full_pts = [su] + gap_pts + [ev]
                        xz_flat = []
                        elen = 0.0
                        for k, (gx, gz) in enumerate(full_pts):
                            xz_flat.extend([round(gx, 1), round(gz, 1)])
                            if k > 0:
                                elen += dist2d(full_pts[k - 1][0], full_pts[k - 1][1], gx, gz)
                        edges.append([gap_start_nid, gap_end_nid, round(elen, 1), 0, name_idx, xz_flat])
                        added_edges += 1
                    in_gap = False
                    gap_pts = []

    graph_path.write_text(json.dumps(graph, separators=(",", ":")))
    print(f"Injected {added_edges} traversable alpine connector edges into graph.json (total edges: {len(edges)})")


def build_races(net: TrailNetwork, sampler: TerrariumSampler) -> tuple[list[dict], list[list[tuple[float, float]]]]:
    # Prefetch all z14 tiles for CalTopo tracks
    caltopo_files = [
        "hr2_1VNEK.json", "hr1_V6D04DL.json", "tmr_BQN0.json", "sjs50_6R6DT.json",
        "kendall_VLGH.json", "silverton50k_70HS.json", "deepcreek_2GVNS.json",
        "ouray50_5SLT69H.json", "imogene_U4NNM.json",
    ]
    prefetch_ll = []
    for cf in caltopo_files:
        d = json.loads((CALTOPO_DIR / cf).read_text()).get("result", {}).get("state", {}).get("features", [])
        for feat in d:
            g = feat.get("geometry", {})
            if g.get("type") == "LineString":
                for c in g["coordinates"]:
                    prefetch_ll.append((c[0], c[1]))
    sampler.prefetch_lon_lats(prefetch_ll)

    # 1. Hardrock CW & CCW
    hr_cw_ll = load_caltopo_line("hr2_1VNEK.json")
    hr_ccw_ll = load_caltopo_line("hr1_V6D04DL.json")

    hr_cw_cps = [
        {"name": "KT Aid Station", "lon": -107.7975, "lat": 37.7888, "cutoffH": 7.5},
        {"name": "Chapman Gulch", "lon": -107.8101, "lat": 37.8587, "cutoffH": 11.5},
        {"name": "Telluride", "lon": -107.8077, "lat": 37.9351, "cutoffH": 16.5},
        {"name": "Kroger's Canteen (Virginius Pass)", "lon": -107.7786, "lat": 37.9555, "cutoffH": 20.5},
        {"name": "Governor Basin", "lon": -107.7590, "lat": 37.9710, "cutoffH": 22.5},
        {"name": "Ouray", "lon": -107.6730, "lat": 38.0220, "cutoffH": 26.0},
        {"name": "Engineer Pass", "lon": -107.5903, "lat": 37.9698, "cutoffH": 30.5},
        {"name": "Grouse Gulch", "lon": -107.5583, "lat": 37.9177, "cutoffH": 33.0},
        {"name": "Handies Peak (14,048 ft)", "lon": -107.5045, "lat": 37.9137},
        {"name": "Burrows Park", "lon": -107.4609, "lat": 37.9371, "cutoffH": 36.5},
        {"name": "Sherman", "lon": -107.4345, "lat": 37.9025, "cutoffH": 38.0},
        {"name": "Pole Creek", "lon": -107.4650, "lat": 37.8090, "cutoffH": 41.5},
        {"name": "Maggie Gulch", "lon": -107.5359, "lat": 37.8133, "cutoffH": 43.0},
        {"name": "Cunningham Gulch", "lon": -107.5775, "lat": 37.7928, "cutoffH": 45.0},
        {"name": "Silverton (Kiss the Rock)", "lon": -107.6657, "lat": 37.8124, "cutoffH": 48.0, "isFinish": True},
    ]

    hr_ccw_cps = [
        {"name": "Cunningham Gulch", "lon": -107.5775, "lat": 37.7928, "cutoffH": 5.5},
        {"name": "Maggie Gulch", "lon": -107.5359, "lat": 37.8133, "cutoffH": 8.5},
        {"name": "Pole Creek", "lon": -107.4650, "lat": 37.8090, "cutoffH": 11.5},
        {"name": "Sherman", "lon": -107.4345, "lat": 37.9025, "cutoffH": 15.5},
        {"name": "Burrows Park", "lon": -107.4609, "lat": 37.9371, "cutoffH": 17.5},
        {"name": "Handies Peak (14,048 ft)", "lon": -107.5045, "lat": 37.9137},
        {"name": "Grouse Gulch", "lon": -107.5583, "lat": 37.9177, "cutoffH": 22.0},
        {"name": "Engineer Pass", "lon": -107.5903, "lat": 37.9698, "cutoffH": 25.0},
        {"name": "Ouray", "lon": -107.6730, "lat": 38.0220, "cutoffH": 29.0},
        {"name": "Governor Basin", "lon": -107.7590, "lat": 37.9710, "cutoffH": 32.5},
        {"name": "Kroger's Canteen (Virginius Pass)", "lon": -107.7786, "lat": 37.9555, "cutoffH": 34.5},
        {"name": "Telluride", "lon": -107.8077, "lat": 37.9351, "cutoffH": 37.0},
        {"name": "Chapman Gulch", "lon": -107.8101, "lat": 37.8587, "cutoffH": 41.0},
        {"name": "KT Aid Station", "lon": -107.7975, "lat": 37.7888, "cutoffH": 44.0},
        {"name": "Silverton (Kiss the Rock)", "lon": -107.6657, "lat": 37.8124, "cutoffH": 48.0, "isFinish": True},
    ]

    # 2. Imogene Pass Run: Ouray Main St -> Canyon Creek (CalTopo U4NNM) -> Telluride Oak St
    imo_core = load_caltopo_line("imogene_U4NNM.json")
    imo_start_ll = route_osm_xz(net, [(-107.6714, 38.0228), imo_core[0]])
    imo_end_ll = route_osm_xz(net, [imo_core[-1], (-107.8120, 37.9368)])
    imo_xz = imo_start_ll + [lon_lat_to_world(lon, lat) for lon, lat in imo_core] + imo_end_ll
    imo_cps = [
        {"name": "Canyon Creek Bridge", "lon": -107.6920, "lat": 38.0050},
        {"name": "Lower Camp Bird", "lon": -107.7235, "lat": 37.9750},
        {"name": "Upper Camp Bird", "lon": -107.7375, "lat": 37.9560, "cutoffH": 2.5},
        {"name": "Imogene Pass (13,114 ft)", "lon": -107.7372, "lat": 37.9325},
        {"name": "Tomboy Townsite", "lon": -107.7535, "lat": 37.9332},
        {"name": "Social Tunnel", "lon": -107.7810, "lat": 37.9355},
        {"name": "Telluride Oak St (Finish)", "lon": -107.8120, "lat": 37.9368, "cutoffH": 7.0, "isFinish": True},
    ]

    # 3. Telluride Mountain Run 40M
    tmr_ll = load_caltopo_line("tmr_BQN0.json", [
        "1 Start to Bridal Veil", "2 Bridal Veil to Imogene", "3 Imogene to Liberty Bell",
        "4 Liberty Bell to Carhenge", "5 Carhenge to Gold Hill", "6 Gold Hill to finish",
    ])
    tmr_cps = [
        {"name": "Bridal Veil Aid", "lon": -107.7677, "lat": 37.9194, "cutoffH": 5.5},
        {"name": "Imogene Pass Aid", "lon": -107.7327, "lat": 37.9299, "cutoffH": 8.0},
        {"name": "Liberty Bell Aid", "lon": -107.8065, "lat": 37.9451, "cutoffH": 11.5},
        {"name": "Carhenge / Oak St Aid", "lon": -107.8169, "lat": 37.9361, "cutoffH": 13.5},
        {"name": "Gold Hill Aid", "lon": -107.8225, "lat": 37.9038, "cutoffH": 15.5},
        {"name": "Telluride Town Park (Finish)", "lon": -107.8078, "lat": 37.9349, "cutoffH": 17.0, "isFinish": True},
    ]

    # 4a. Rundola (Telluride Trail) — modern USFS-permitted 4th of July course:
    # Starts at Gondola Base West Apron (-165.4, 176.1) (6.5m SSE of Tower #1, 9.6m clear of terminal),
    # crosses San Miguel Footbridge onto Telluride Trail, climbs all Telluride Trail switchbacks, finishes at San Sophia Apron (-1782.0, 677.0).
    gondola_base_xz = (-165.4, 176.1)
    san_sophia_xz = (-1782.0, 677.0)
    san_sophia_ll = world_to_lon_lat(*san_sophia_xz)
    tt_waypoints_xz = [
        gondola_base_xz,
        (-174.7, 194.8),
        (-189.4, 197.9),
        (-823.7, 371.1),
        (-1308.6, 673.1),
        (-1405.0, 950.7),
        (-1036.0, 946.1),
        (-1789.6, 777.1),
        san_sophia_xz,
    ]
    rundola_xz = route_osm_xz(
        net,
        [world_to_lon_lat(wx, wz) for wx, wz in tt_waypoints_xz],
        avoid_names=("rundola", "gondola cut"),
        prefer_names=("telluride trail", "gondola base footbridge", "san sophia station"),
        max_detour_ratio=6.0,
    )
    rundola_mid_ll = world_to_lon_lat(-1308.6, 673.1)
    rundola_cps = [
        {"name": "Telluride Trail Mid-Climb", "lon": rundola_mid_ll[0], "lat": rundola_mid_ll[1], "targetMi": 1.3, "windowMi": 0.6},
        {"name": "San Sophia Station (10,540 ft)", "lon": san_sophia_ll[0], "lat": san_sophia_ll[1], "cutoffH": 3.0, "isFinish": True},
    ]

    # 4b. Rundola — Original (Straight Up Gondola) — classic direct vertical-K climb right under Gondola Line 1:
    # Starts at the exact same Gondola Base West Apron (-167.3, 169.9), climbs straight up Original Rundola (Gondola Cut)
    # directly beneath aw17145067 cables to San Sophia Station East Apron (-1782.0, 677.0).
    gondola_cut_edge = next((e for e in net.edges if e.get("name") == "Original Rundola (Gondola Cut)"), None)
    if gondola_cut_edge:
        gc = gondola_cut_edge["coords"]
        rundola_orig_xz = [(gc[i], gc[i + 2]) for i in range(0, len(gc), 3)]
        if dist2d(rundola_orig_xz[0][0], rundola_orig_xz[0][1], gondola_base_xz[0], gondola_base_xz[1]) > dist2d(rundola_orig_xz[-1][0], rundola_orig_xz[-1][1], gondola_base_xz[0], gondola_base_xz[1]):
            rundola_orig_xz.reverse()
    else:
        rundola_orig_xz = route_osm_xz(
            net,
            [world_to_lon_lat(*gondola_base_xz), san_sophia_ll],
            prefer_names=("original rundola", "gondola cut"),
            max_detour_ratio=2.0,
        )
    mid_cut_ll = world_to_lon_lat(-975.0, 423.0)
    rundola_orig_cps = [
        {"name": "Mid-Gondola Cut (Coonskin)", "lon": mid_cut_ll[0], "lat": mid_cut_ll[1], "targetMi": 0.55, "windowMi": 0.3},
        {"name": "San Sophia Station (10,540 ft)", "lon": san_sophia_ll[0], "lat": san_sophia_ll[1], "cutoffH": 2.5, "isFinish": True},
    ]

    # 5. Deep Creek Half Marathon
    dc_ll = load_caltopo_line("deepcreek_2GVNS.json")
    dc_cps = [
        {"name": "Deep Creek Aid 1", "lon": -107.8790, "lat": 37.9733},
        {"name": "Mill Creek Aid 2", "lon": -107.8252, "lat": 37.9618},
        {"name": "Courthouse / Oak St (Finish)", "lon": -107.8126, "lat": 37.9381, "cutoffH": 5.5, "isFinish": True},
    ]

    # 6. Kendall Mountain Run (out-and-back: targetMi prevents outbound checkpoints from snapping to inbound leg)
    kendall_ll = load_caltopo_line("kendall_VLGH.json")
    kendall_cps = [
        {"name": "Deer Park Aid", "lon": -107.6492, "lat": 37.7844, "targetMi": 3.4, "windowMi": 1.2},
        {"name": "The Notch Aid", "lon": -107.6335, "lat": 37.7897, "targetMi": 5.0, "windowMi": 0.9},
        {"name": "Kendall Mountain Summit (13,066 ft)", "lon": -107.6439, "lat": 37.7926, "targetMi": 6.1, "windowMi": 0.7},
        {"name": "The Notch (Return)", "lon": -107.6335, "lat": 37.7897, "targetMi": 7.2, "windowMi": 1.0},
        {"name": "Silverton Memorial Park (Finish)", "lon": -107.6606, "lat": 37.8165, "cutoffH": 5.0, "isFinish": True},
    ]

    # 7. San Juan Solstice 50
    sjs_ll = load_caltopo_line("sjs50_6R6DT.json")
    sjs_cps = [
        {"name": "Alpine Gulch", "lon": -107.3484, "lat": 37.9686, "targetMi": 7.0, "windowMi": 2.0},
        {"name": "Williams Creek", "lon": -107.3372, "lat": 37.9216, "targetMi": 15.7, "windowMi": 2.5},
        {"name": "Carson", "lon": -107.3635, "lat": 37.8804, "targetMi": 21.0, "windowMi": 2.5},
        {"name": "Continental Divide", "lon": -107.2883, "lat": 37.9059, "targetMi": 30.5, "windowMi": 3.0},
        {"name": "Slumgullion", "lon": -107.2742, "lat": 37.9827, "targetMi": 39.4, "windowMi": 2.5},
        {"name": "Vickers", "lon": -107.2820, "lat": 38.0344, "targetMi": 45.3, "windowMi": 2.5},
        {"name": "Lake City Town Park (Finish)", "lon": -107.3171, "lat": 38.0285, "cutoffH": 16.0, "isFinish": True},
    ]

    # 8. Silverton Alpine 50K
    sil_ll = load_caltopo_line("silverton50k_70HS.json")
    sil_cps = [
        {"name": "Howardsville", "lon": -107.5943, "lat": 37.8362},
        {"name": "Eureka Aid", "lon": -107.5647, "lat": 37.8794},
        {"name": "Animas Forks Aid", "lon": -107.5722, "lat": 37.9325},
        {"name": "California Pass Aid (12,930 ft)", "lon": -107.6177, "lat": 37.9175},
        {"name": "Gladstone Aid", "lon": -107.6500, "lat": 37.8909},
        {"name": "Silverton Memorial Park (Finish)", "lon": -107.6609, "lat": 37.8165, "cutoffH": 11.0, "isFinish": True},
    ]

    # 9. Ouray 50 (multi-loop out of Fellin Park: targetMi locks each aid visit to its real lap)
    o50_ll = load_caltopo_line("ouray50_5SLT69H.json", [
        "01. Fellin Park -> Weehawken AS",
        "02. Weehawken AS -> Alpine Mine Overlook -> Weehawken AS",
        "03. Weehawken AS -> Hayden Pass -> Crystal Lake AS",
        "04. Crystal Lake AS -> Hayden Pass -> Fellin Park",
        "05. Fellin Park AS -> Twin Peaks -> Silvershield AS",
        "06. Silvershield AS -> Fellin Park AS",
        "07. Fellin Park AS -> Chief Ouray Mine -> Fellin Park AS",
        "08. Fellin Park AS -> Bridge of Heaven -> Fellin Park (Finish)",
    ])
    o50_cps = [
        {"name": "Weehawken Aid", "lon": -107.7002, "lat": 37.9943, "targetMi": 3.5, "windowMi": 2.0},
        {"name": "Crystal Lake Aid", "lon": -107.6637, "lat": 37.9601, "targetMi": 15.7, "windowMi": 2.5},
        {"name": "Fellin Park (Lap 1)", "lon": -107.6738, "lat": 38.0282, "targetMi": 24.3, "windowMi": 2.0},
        {"name": "Silvershield Aid", "lon": -107.6828, "lat": 38.0391, "targetMi": 30.6, "windowMi": 2.5},
        {"name": "Fellin Park (Lap 2)", "lon": -107.6731, "lat": 38.0285, "targetMi": 41.4, "windowMi": 2.0},
        {"name": "Bridge of Heaven (12,264 ft)", "lon": -107.6381, "lat": 38.0386, "targetMi": 46.5, "windowMi": 2.5},
        {"name": "Fellin Park (Finish)", "lon": -107.6714, "lat": 38.0228, "cutoffH": 24.0, "isFinish": True},
    ]

    # 10. Blue Lakes & Yankee Boy Traverse (Blue Lakes TH -> Lower/Upper Blue Lakes -> Blue Lakes Pass -> Yankee Boy -> Camp Bird)
    bl_part1_xz = route_osm_xz(net, [(-107.8077, 38.0340), (-107.8218, 38.0127), (-107.7989, 37.9978), (-107.7847, 37.9948)], prefer_names=("blue lakes",), max_detour_ratio=5.0)
    bl_part2_xz = route_osm_xz(net, [(-107.7847, 37.9948), (-107.7653, 37.9883), (-107.7240, 37.9740)], prefer_names=("yankee boy", "camp bird"), max_detour_ratio=5.0)
    bl_xz = bl_part1_xz + bl_part2_xz
    bl_cps = [
        {"name": "Lower Blue Lake", "lon": -107.8151, "lat": 38.0008, "targetMi": 3.4, "windowMi": 1.2},
        {"name": "Upper Blue Lake", "lon": -107.7989, "lat": 37.9978, "targetMi": 4.8, "windowMi": 1.0},
        {"name": "Blue Lakes Pass (13,000 ft)", "lon": -107.7847, "lat": 37.9948, "targetMi": 6.2, "windowMi": 1.0},
        {"name": "Yankee Boy Basin", "lon": -107.7653, "lat": 37.9883, "targetMi": 7.9, "windowMi": 1.2},
        {"name": "Camp Bird Finish", "lon": -107.7240, "lat": 37.9740, "cutoffH": 9.0, "isFinish": True},
    ]

    # 11. Spurs Austin International Half Marathon (Easter Egg — 13th race, always last):
    # 100% paved continuous road (East Colorado Ave -> West Colorado Ave -> CO 145 down San Miguel canyon past Sawpit),
    # trimmed to exact half-marathon length (21,097.5 m / 13.11 mi) staying strictly inside x >= -17500.
    spurs_road_weights = {"road": 1.0, "track": 50.0, "path": 100.0, "trail": 100.0}
    spurs_raw_xz = route_osm_xz(
        net,
        [world_to_lon_lat(1046.7, 265.5), world_to_lon_lat(-17956.3, -6165.7)],
        kind_weights=spurs_road_weights,
        prefer_names=("colorado avenue", "co 145"),
        max_detour_ratio=3.0,
    )
    spurs_target_m = 21097.5
    spurs_xz = [spurs_raw_xz[0]]
    spurs_cum = 0.0
    for i in range(1, len(spurs_raw_xz)):
        ax, az = spurs_raw_xz[i - 1]
        bx, bz = spurs_raw_xz[i]
        seg = dist2d(ax, az, bx, bz)
        if seg < 0.05:
            continue
        if spurs_cum + seg >= spurs_target_m:
            f = (spurs_target_m - spurs_cum) / seg
            spurs_xz.append((round(ax + (bx - ax) * f, 1), round(az + (bz - az) * f, 1)))
            break
        spurs_xz.append((bx, bz))
        spurs_cum += seg

    # Smooth 128-sample virtual Austin net-downhill elevation profile (meters):
    # Starts at 268.0 m (879 ft, Research Blvd) -> gentle Austin rollers (+60 m / +197 ft gain) -> 149.0 m (489 ft, 11th & Congress Capitol).
    austin_knots = [
        (0.00, 268.0),
        (0.16, 225.0),
        (0.26, 243.0),
        (0.44, 196.0),
        (0.53, 212.0),
        (0.69, 174.0),
        (0.78, 190.0),
        (0.89, 162.0),
        (0.94, 172.0),
        (1.00, 149.0),
    ]
    austin_elevs = []
    for s_i in range(128):
        u = s_i / 127.0
        for k in range(len(austin_knots) - 1):
            u0, e0 = austin_knots[k]
            u1, e1 = austin_knots[k + 1]
            if u0 <= u <= u1 + 1e-9:
                t = max(0.0, min(1.0, (u - u0) / max(1e-9, u1 - u0)))
                # Cosine easing for smooth road rollers with exact extrema at knots
                et = 0.5 - 0.5 * math.cos(math.pi * t)
                austin_elevs.append(round(e0 + (e1 - e0) * et, 1))
                break
    austin_elevs[0] = 268.0
    austin_elevs[-1] = 149.0

    spurs_cps = [
        {"name": "Shoal Creek Blvd — 3M Tape & Flat Gatorade", "byDistM": 5150.0},
        {"name": "Allandale — Unsolicited Indie Garage Band #4", "byDistM": 10620.0},
        {"name": "Hyde Park / UT Tower — Breakfast Taco Handoff", "byDistM": 15770.0},
        {"name": "11th & Congress — Texas State Capitol Finish", "cutoffH": 4, "isFinish": True},
    ]

    specs = [
        ("hardrock-100-cw", "Hardrock 100 (Clockwise)", "100+ miles, 33,000+ ft of vert, 13 passes above 12,000 ft, and a painted rock waiting in Silverton. Estimated finish: Thursday.", 102.0, 33441, 48.0, "06:00", [lon_lat_to_world(a, b) for a, b in hr_cw_ll], hr_cw_cps, 2.5, None),
        ("hardrock-100-ccw", "Hardrock 100 (Counter-Clockwise)", "The exact same 33,000+ ft of San Juan suffering, starting with Cunningham Gulch instead of KT so your quads are surprised differently.", 102.5, 33441, 48.0, "06:00", [lon_lat_to_world(a, b) for a, b in hr_ccw_ll], hr_ccw_cps, 2.5, None),
        ("imogene-pass-run", "Imogene Pass Run", "17.1 miles from Ouray (7,811 ft) up and over 13,114 ft Imogene Pass to Telluride. At least the second half is downhill — until your quads explode.", 17.1, 5300, 7.0, "07:30", imo_xz, imo_cps, 2.0, None),
        ("telluride-mountain-run", "Telluride Mountain Run (40M)", "40 rugged miles circling the box canyon, highlighted by the 'Mile and a Half of Sky' ridge above 13,000 ft where gravity becomes optional.", 40.0, 15000, 17.0, "05:00", [lon_lat_to_world(a, b) for a, b in tmr_ll], tmr_cps, 2.0, None),
        ("rundola", "Rundola (Telluride Trail)", "Modern USFS-permitted 4th of July course from the Telluride Gondola base up the full Telluride Trail switchbacks to San Sophia Station (10,540 ft). Forest Service switchbacks save the tundra — and you still get to ride the free gondola back down.", 2.6, 1810, 3.0, "08:00", rundola_xz, rundola_cps, 1.5, None),
        ("rundola-original", "Rundola — Original (Straight Up Gondola)", "The legendary pre-permit straight-up lung-buster: 1.1 miles and ~1,800 ft of ~31% vertical directly under Gondola Line 1 from Oak St Base to San Sophia Station. Tourists wave from the cabins overhead while your calves negotiate their resignation.", 1.1, 1800, 2.5, "08:00", rundola_orig_xz, rundola_orig_cps, 1.0, None),
        ("deep-creek-half", "Deep Creek Trail Half Marathon", "13.1 miles of golden-aspen singletrack from Last Dollar Road across Deep Creek, Mill Creek, Waterline, and Jud Wiebe down to Oak Street.", 13.1, 3100, 5.5, "08:00", [lon_lat_to_world(a, b) for a, b in dc_ll], dc_cps, 2.0, None),
        ("kendall-mountain-run", "Kendall Mountain Run", "Born from a 1908 Silverton bar bet: climb nearly 4,000 ft up Kendall Mountain to 13,066 ft and sprint back to Memorial Park.", 12.3, 3960, 5.0, "08:00", [lon_lat_to_world(a, b) for a, b in kendall_ll], kendall_cps, 2.0, None),
        ("san-juan-solstice-50", "San Juan Solstice 50", "50-mile counter-clockwise high-alpine tour out of Lake City touching the Continental Divide above 13,300 ft. Bring a rain shell.", 50.0, 12500, 16.0, "05:00", [lon_lat_to_world(a, b) for a, b in sjs_ll], sjs_cps, 2.0, None),
        ("silverton-alpine-50k", "Silverton Alpine 50K", "High-altitude Alpine Loop tour linking Howardsville, Eureka, Animas Forks, and 12,930 ft California Pass.", 31.1, 4569, 11.0, "06:30", [lon_lat_to_world(a, b) for a, b in sil_ll], sil_cps, 2.0, None),
        ("ouray-50", "Ouray 50", "52 miles and ~24,000 ft of vertical around the Ouray amphitheater, featuring Chief Ouray Mine and the Bridge of Heaven.", 52.0, 23600, 24.0, "06:00", [lon_lat_to_world(a, b) for a, b in o50_ll], o50_cps, 2.5, None),
        ("blue-lakes-alpine-classic", "Blue Lakes & Yankee Boy Classic", "Sneffels Wilderness showcase: climb past turquoise Blue Lakes over 13,000 ft Blue Lakes Pass into Yankee Boy Basin.", 11.0, 3800, 9.0, "07:00", bl_xz, bl_cps, 2.0, None),
        ("spurs-half-marathon", "Spurs Austin International Half Marathon", "Formerly the 3M Half Marathon in Austin, TX — a blazing-fast, net-downhill road 13.1-miler inexplicably dropped at the bottom of a San Juan mountain ultra game because 40 GB of I-35 overpasses and breakfast taco stands exceeded the WebGL budget. Routed along 13.1 miles of real San Miguel County asphalt with full 680-ft Texas sea-level oxygen simulated free of charge. Leave the trekking poles in the Subaru; lace up the pink carbon super-shoes.", 13.1, 197, 4, "07:00", spurs_xz, spurs_cps, 2.0, {
            "easterEgg": True,
            "seaLevel": True,
            "lossFt": 561,
            "gainFtOverride": 197,
            "elevationsOverride": austin_elevs,
        }),
    ]

    races = []
    raw_tracks_xz = []
    print("Evaluating resampled race courses (15m z14 Terrarium):")
    for rid, name, blurb, off_d, off_g, cutoff_h, start_time, xz_pts, cp_defs, tol_m, extra in specs:
        dense_full, total_m, gain_m = resample_and_eval(xz_pts, sampler, step_m=15.0, gain_threshold_m=6.0)
        checkpoints = project_checkpoints(dense_full, cp_defs)
        max_seg_m = 45.0 if rid == "rundola-original" else 120.0
        simplified = simplify_polyline(dense_full, tol_m=tol_m, max_seg_m=max_seg_m)
        line_flat = []
        for x, _, z, d in simplified:
            line_flat.extend([round(x, 1), round(z, 1), round(d, 1)])

        if extra and extra.get("elevationsOverride"):
            elevations = extra["elevationsOverride"]
        else:
            # 128-sample real DEM elevation profile (meters) preserving true high/low extrema per bin
            n_prof = 128
            elevations = []
            dn = len(dense_full)
            d_idx = 0
            for s_i in range(n_prof):
                target_d = (s_i / (n_prof - 1)) * total_m
                while d_idx + 1 < dn and dense_full[d_idx + 1][3] < target_d:
                    d_idx += 1
                if d_idx + 1 < dn:
                    d0 = dense_full[d_idx][3]
                    d1 = dense_full[d_idx + 1][3]
                    t = (target_d - d0) / max(1e-6, d1 - d0)
                    ey = dense_full[d_idx][1] * (1.0 - t) + dense_full[d_idx + 1][1] * t
                else:
                    ey = dense_full[-1][1]
                elevations.append(round(ey, 1))
            # Pin true global max & min elevation into their exact profile bins so 14er summits never alias between bins
            max_pt = max(dense_full, key=lambda p: p[1])
            min_pt = min(dense_full, key=lambda p: p[1])
            max_bin = min(n_prof - 1, max(0, int(round((max_pt[3] / max(1.0, total_m)) * (n_prof - 1)))))
            min_bin = min(n_prof - 1, max(0, int(round((min_pt[3] / max(1.0, total_m)) * (n_prof - 1)))))
            elevations[max_bin] = round(max_pt[1], 1)
            elevations[min_bin] = round(min_pt[1], 1)

        s0 = simplified[0]
        s1 = simplified[min(1, len(simplified) - 1)]
        start_h = compute_heading(s1[0] - s0[0], s1[2] - s0[2])
        e0 = simplified[max(0, len(simplified) - 2)]
        e1 = simplified[-1]
        fin_h = compute_heading(e1[0] - e0[0], e1[2] - e0[2])

        dist_mi = round(total_m * M_TO_MI, 1)
        gain_ft = extra["gainFtOverride"] if (extra and extra.get("gainFtOverride") is not None) else int(round(gain_m * M_TO_FT))
        d_pct = (dist_mi - off_d) / off_d * 100.0
        g_pct = (gain_ft - off_g) / off_g * 100.0
        print(
            f"  {rid:26s}: {dist_mi:5.1f} mi (off {off_d:5.1f}, {d_pct:+5.1f}%), "
            f"{gain_ft:6d} ft (off {off_g:6d}, {g_pct:+5.1f}%), pts={len(simplified):4d}"
        )

        raw_tracks_xz.append([(p[0], p[2]) for p in simplified])
        race_obj = {
            "id": rid,
            "name": name,
            "blurb": blurb,
            "distanceMi": dist_mi,
            "officialDistanceMi": off_d,
            "gainFt": gain_ft,
            "officialGainFt": off_g,
            "cutoffH": cutoff_h,
            "startTimeLocal": start_time,
            "start": {"x": round(s0[0], 1), "z": round(s0[2], 1), "heading": start_h},
            "finish": {"x": round(e1[0], 1), "z": round(e1[2], 1), "heading": fin_h},
            "checkpoints": checkpoints,
            "elevations": elevations,
            "line": line_flat,
        }
        if extra:
            if extra.get("easterEgg"):
                race_obj["easterEgg"] = True
            if extra.get("seaLevel"):
                race_obj["seaLevel"] = True
            if extra.get("lossFt") is not None:
                race_obj["lossFt"] = extra["lossFt"]
        races.append(race_obj)

    return races, raw_tracks_xz


def main():
    t0 = time.time()
    proj_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PROJ
    proj = json.loads(proj_path.read_text())
    net = TrailNetwork(proj)
    sampler = TerrariumSampler(zoom=14, max_workers=12)

    pois = build_curated_pois(proj, net, sampler)
    races, raw_tracks_xz = build_races(net, sampler)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pois_path = OUT_DIR / "pois.json"
    races_path = OUT_DIR / "races.json"
    pois_path.write_text(json.dumps(pois, separators=(",", ":")))
    races_path.write_text(json.dumps(races, separators=(",", ":")))

    graph_path = OUT_DIR / "graph.json"
    if graph_path.exists():
        inject_graph_connectors(net, raw_tracks_xz, graph_path)

    print(
        f"Wrote pois.json ({pois_path.stat().st_size / 1024:.1f} KB) and "
        f"races.json ({races_path.stat().st_size / 1024:.1f} KB) in {time.time()-t0:.1f}s"
    )


if __name__ == "__main__":
    main()
