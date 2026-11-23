"""
Build curated pois.json (35+ free-run spots + OSM peaks/passes/waterfalls/lakes/towns)
and races.json (10 real San Juan races reconstructed via A* over the OSM trail graph).
"""

import heapq
import json
import math
import os
import sys
import time
from collections import defaultdict
from pathlib import Path

from geo import BBOX, M_TO_FT, M_TO_MI, lon_lat_to_world
from elevation import TerrariumSampler

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(os.path.expanduser("~/.cache/telluride-trails"))
DEFAULT_PROJ = CACHE_DIR / "projected_bundle.json"
OUT_DIR = REPO_ROOT / "public" / "data" / "vector"


def dist2d(ax: float, az: float, bx: float, bz: float) -> float:
    return math.hypot(bx - ax, bz - az)


def compute_heading(tx: float, tz: float) -> float:
    """Match src/core/camera.js forward = (-sin(heading), -cos(heading))."""
    return round(math.atan2(-tx, -tz), 4)


def smooth_gain_loss(ys: list[float], threshold_m: float = 6.0) -> tuple[float, float]:
    """Compute vertical gain and loss with moving-average smoothing + hysteresis threshold."""
    if len(ys) < 2:
        return 0.0, 0.0
    # 5-point moving average to suppress DEM staircase jitter
    smoothed = []
    n = len(ys)
    for i in range(n):
        lo = max(0, i - 2)
        hi = min(n, i + 3)
        smoothed.append(sum(ys[lo:hi]) / (hi - lo))
    ys = smoothed
    gain = 0.0
    loss = 0.0
    anchor = ys[0]
    extreme = ys[0]
    trend = 0  # 1 up, -1 down, 0 init
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


def simplify_polyline(pts: list[tuple[float, float, float, float]], tol_m: float = 1.8) -> list[tuple[float, float, float, float]]:
    """Douglas-Peucker 2D simplification preserving cumulative distance & endpoints."""
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

        # Identify largest connected component so waypoints never snap to isolated stubs
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

        # Spatial hash for edges (150m cells) for snapping
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

    def nearest_node(self, x: float, z: float, max_dist: float = 2500.0, main_only: bool = True) -> int | None:
        # First snap to nearest edge in main_comp, then choose closer endpoint of that edge
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
                    w *= 3.0
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

    # 40 curated free-run spots & iconic San Juan destinations
    # Format: (id, name, kind, area, (lon, lat), look_toward_ll, snap_to_trail, description)
    CURATED = [
        # Telluride
        ("telluride-town", "Telluride Gondola Plaza", "town", "Telluride", (-107.8123, 37.9362), (-107.8080, 37.9340), True, "Historic box-canyon base at 8,750 ft — step off Oak St right onto San Juan singletrack."),
        ("telluride-town-park", "Telluride Town Park", "trailhead", "Telluride", (-107.8058, 37.9356), (-107.7950, 37.9260), True, "East end of town where Bear Creek, Bridal Veil, and TMR kick off."),
        ("bear-creek-th", "Bear Creek Trailhead", "trailhead", "Telluride", (-107.8085, 37.9325), (-107.8020, 37.9100), True, "Iconic box-canyon singletrack climbing toward Bear Creek Falls & Wasatch."),
        ("jud-wiebe-th", "Jud Wiebe Trailhead", "trailhead", "Telluride", (-107.8152, 37.9403), (-107.8180, 37.9450), True, "Beloved 3-mile sunny aspen loop perched directly above downtown Telluride."),
        ("bridal-veil-falls", "Bridal Veil Falls", "waterfall", "Telluride", (-107.7689, 37.9182), (-107.7685, 37.9165), True, "Colorado's tallest free-falling waterfall (365 ft) at the east headwall of Telluride."),
        ("bridal-veil-basin", "Bridal Veil Basin", "viewpoint", "Telluride", (-107.7650, 37.9110), (-107.7550, 37.9050), True, "High alpine basin above the historic 1907 hydroelectric powerhouse."),
        ("ingram-falls", "Ingram Falls", "waterfall", "Telluride", (-107.7722, 37.9262), (-107.7550, 37.9330), True, "Roaring cascade along the Black Bear / Tomboy switchbacks above Pandora."),
        ("cornet-creek-falls", "Cornet Creek Falls", "waterfall", "Telluride", (-107.8108, 37.9422), (-107.8105, 37.9400), True, "Dramatic red-sandstone waterfall tucked right behind town off Jud Wiebe."),
        ("bear-creek-falls", "Bear Creek Falls", "waterfall", "Telluride", (-107.8018, 37.9068), (-107.7980, 37.8960), True, "2.5 miles up Bear Creek Preserve — turn around or push for Wasatch Pass."),
        ("san-sophia-gondola", "Telluride Gondola — St. Sophia Station", "viewpoint", "Telluride", (-107.8260, 37.9277), (-107.8200, 37.9320), True, "10,540 ft ridge crest between Telluride and Mountain Village (finish of Rundola)."),
        ("mountain-village", "Mountain Village Heritage Plaza", "town", "Telluride", (-107.8473, 37.9319), (-107.8350, 37.9280), True, "9,545 ft ski village linked by free gondola and singletrack loops."),
        ("deep-creek-th", "Deep Creek Trailhead", "trailhead", "Telluride", (-107.8825, 37.9688), (-107.8550, 37.9720), True, "Aspen-lined singletrack bench linking Last Dollar Rd to Mill Creek and town."),
        ("mill-creek-th", "Mill Creek / Waterline Trailhead", "trailhead", "Telluride", (-107.8350, 37.9510), (-107.8250, 37.9470), True, "Shaded north-side singletrack traversing Eider Creek and Waterline."),
        ("ajax-peak", "Ajax Peak", "peak", "Telluride", (-107.7592, 37.9308), (-107.7490, 37.9312), False, "12,785 ft rocky prow anchoring the Mile and a Half of Sky ridge."),
        ("telluride-peak", "Telluride Peak", "peak", "Telluride", (-107.7490, 37.9312), (-107.7372, 37.9325), False, "13,509 ft high-wire ridge summit between Ajax Peak and Imogene Pass."),
        ("imogene-pass", "Imogene Pass", "pass", "Telluride", (-107.7372, 37.9325), (-107.7535, 37.9332), True, "13,114 ft crest connecting Ouray and Telluride — highest point of the Imogene Run."),
        ("black-bear-pass", "Black Bear Pass", "pass", "Telluride", (-107.7435, 37.8995), (-107.7680, 37.9160), True, "12,840 ft white-knuckle shelf road dropping above Bridal Veil Falls."),
        ("alta-lakes", "Alta Lakes", "lake", "Telluride", (-107.8780, 37.8860), (-107.8700, 37.8830), True, "High alpine lakes at 11,300 ft beneath Bald Mountain and Wilson."),

        # Ophir & Lizard Head
        ("ophir-town", "Ophir Town", "town", "Ophir & Lizard Head", (-107.8328, 37.8569), (-107.8100, 37.8540), True, "Tiny 9,695 ft valley hamlet guarding the western approach to Ophir Pass."),
        ("ophir-pass", "Ophir Pass", "pass", "Ophir & Lizard Head", (-107.7810, 37.8531), (-107.8050, 37.8540), True, "11,789 ft rocky divide linking Ophir and Red Mountain Highway."),
        ("lizard-head-pass", "Lizard Head Pass", "pass", "Ophir & Lizard Head", (-107.9084, 37.8096), (-107.9350, 37.8250), True, "10,222 ft Continental-style pass staring straight at Lizard Head spire."),
        ("trout-lake", "Trout Lake", "lake", "Ophir & Lizard Head", (-107.8842, 37.8235), (-107.8650, 37.8150), True, "High mountain reservoir below Sheep Mountain and Yellow Mountain."),
        ("hope-lake-th", "Hope Lake Trailhead", "trailhead", "Ophir & Lizard Head", (-107.8490, 37.8015), (-107.8320, 37.7950), True, "Steep subalpine climb to 11,880 ft Hope Lake in the Lizard Head Wilderness."),
        ("grant-swamp-pass", "Grant Swamp Pass", "pass", "Ophir & Lizard Head", (-107.7755, 37.8070), (-107.7950, 37.8250), True, "Infamous 12,920 ft Hardrock scree couloir between KT and Chapman Gulch."),

        # Sneffels & Blue Lakes
        ("blue-lakes-th", "Blue Lakes Trailhead", "trailhead", "Sneffels & Blue Lakes", (-107.7945, 38.0170), (-107.8100, 37.9960), True, "Gateway to the glowing turquoise glacial tarns beneath Mt. Sneffels."),
        ("lower-blue-lake", "Lower Blue Lake", "lake", "Sneffels & Blue Lakes", (-107.8130, 37.9940), (-107.8050, 37.9830), True, "Turquoise alpine jewel at 10,970 ft below Dallas Peak and Sneffels."),
        ("yankee-boy-basin", "Yankee Boy Basin / Mt. Sneffels TH", "trailhead", "Sneffels & Blue Lakes", (-107.7830, 37.9890), (-107.7920, 38.0030), True, "Wildflower-choked high cirque under 14,150 ft Mt. Sneffels."),
        ("virginius-pass", "Virginius Pass (Kroger's Canteen)", "pass", "Sneffels & Blue Lakes", (-107.7685, 37.9585), (-107.7520, 37.9630), True, "13,100 ft knife-edge notch hosting Hardrock's highest aid station."),
        ("governor-basin", "Governor Basin", "viewpoint", "Sneffels & Blue Lakes", (-107.7495, 37.9640), (-107.7300, 37.9750), True, "High mining cirque on the Camp Bird / Virginius approach."),

        # Ouray
        ("ouray-perimeter", "Ouray Perimeter Trail / Fellin Park", "trailhead", "Ouray", (-107.6714, 38.0228), (-107.6650, 38.0190), True, "7,792 ft 'Switzerland of America' — start of Imogene Pass Run & Perimeter loop."),
        ("box-canyon-ouray", "Box Canyon Falls (Ouray)", "waterfall", "Ouray", (-107.6778, 38.0195), (-107.6850, 38.0100), True, "Thundering quartzite gorge and Perimeter Trail footbridge above Ouray."),
        ("engineer-pass", "Engineer Pass", "pass", "Ouray", (-107.5844, 37.9752), (-107.5710, 37.9400), True, "12,800 ft Alpine Loop saddle overlooking the Uncompahgre and Animas watersheds."),
        ("red-mountain-pass", "Red Mountain Pass", "pass", "Ouray", (-107.7118, 37.8992), (-107.7050, 37.9150), True, "11,018 ft iron-oxide pass on the Million Dollar Highway."),

        # Silverton
        ("silverton-town", "Silverton (Hardrock Start / Finish)", "town", "Silverton", (-107.6645, 37.8119), (-107.6500, 37.8150), True, "9,318 ft mining town — home of the painted ram rock and Hardrock 100."),
        ("kendall-mountain-th", "Kendall Mountain Trailhead", "trailhead", "Silverton", (-107.6590, 37.8095), (-107.6350, 37.7980), True, "Memorial Park start for the 12.3-mile climb up Kendall Mountain."),
        ("kendall-summit", "Kendall Mountain Summit", "peak", "Silverton", (-107.6195, 37.7885), (-107.6400, 37.8000), True, "13,066 ft summit overlooking Silverton and the Animas River canyon."),
        ("ice-lake-th", "Ice Lake Trailhead (South Mineral)", "trailhead", "Silverton", (-107.7755, 37.8130), (-107.7950, 37.8140), True, "Steep switchbacks climbing into the legendary Ice Lakes Basin."),
        ("ice-lake-basin", "Ice Lake Basin", "lake", "Silverton", (-107.8095, 37.8138), (-107.8058, 37.8220), True, "Surreal electric-blue alpine basin at 12,270 ft below Fuller Peak."),
        ("molas-pass", "Molas Pass (Colorado Trail)", "pass", "Silverton", (-107.6975, 37.7365), (-107.6850, 37.7550), True, "10,910 ft Colorado Trail crossing with panoramic Grenadier Range views."),
        ("animas-forks", "Animas Forks Ghost Town", "viewpoint", "Silverton", (-107.5714, 37.9311), (-107.5550, 37.9220), True, "11,200 ft preserved silver-mining ghost town on the Alpine Loop."),

        # Lake City & Handies
        ("handies-peak", "Handies Peak", "peak", "Lake City & Handies", (-107.5045, 37.9130), (-107.4850, 37.9250), True, "14,048 ft highest point of the Hardrock 100 — 360° San Juan crown."),
        ("american-basin", "American Basin Trailhead", "trailhead", "Lake City & Handies", (-107.5230, 37.9080), (-107.5045, 37.9130), True, "Lush 11,500 ft wildflower bowl on the west flank of Handies Peak."),
        ("cinnamon-pass", "Cinnamon Pass", "pass", "Lake City & Handies", (-107.5390, 37.9365), (-107.5050, 37.9350), True, "12,640 ft divide linking Animas Forks to Lake City's Burrows Park."),
        ("sherman-th", "Sherman / Cataract Gulch Trailhead", "trailhead", "Lake City & Handies", (-107.3920, 37.9410), (-107.4150, 37.9100), True, "9,638 ft Hardrock aid station at the mouth of Cataract Gulch."),
        ("lake-city-town", "Lake City Town Park", "town", "Lake City & Handies", (-107.3153, 38.0297), (-107.3350, 38.0150), True, "8,671 ft start/finish hub for the San Juan Solstice 50."),
    ]

    result = []
    used_keys = set()

    for pid, name, kind, area, ll, look_ll, snap_flag, desc in CURATED:
        # Check if OSM has an exact peak/pass/town/waterfall match near ll
        matched = None
        if kind in ("peak", "pass", "town"):
            matched = match_osm(name.split("(")[0].strip(), ll, kind_filter={kind}, max_m=1500.0)
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
                if kind not in ("peak", "pass"):
                    wy = sy
                # Orient tangent toward look_ll
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

    # Add notable OSM peaks (> 12,500 ft / 3810 m), passes, waterfalls, named lakes not already represented
    def area_from_xz(x: float, z: float) -> str:
        # Simple regional buckets by nearest hub
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
        cell = (round(p["x"] / 300), round(p["z"] / 300))
        if cell in used_keys:
            continue
        used_keys.add(cell)
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
        cell = (round(wf["x"] / 300), round(wf["z"] / 300))
        if cell in used_keys:
            continue
        used_keys.add(cell)
        result.append({
            "id": wf["id"],
            "name": wf["name"],
            "kind": "waterfall",
            "area": area_from_xz(wf["x"], wf["z"]),
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
        cell = (round(cx / 300), round(cz / 300))
        if cell in used_keys:
            continue
        used_keys.add(cell)
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


def build_races(net: TrailNetwork, sampler: TerrariumSampler) -> list[dict]:
    """Reconstruct real San Juan races by routing ordered waypoints over the OSM graph."""

    def make_race(
        rid: str,
        name: str,
        blurb: str,
        official_dist_mi: float,
        official_gain_ft: int,
        cutoff_h: float,
        start_time_local: str,
        waypoints: list[dict],
        kind_weights: dict[str, float] | None = None,
        prefer_names: tuple[str, ...] = (),
        avoid_names: tuple[str, ...] = (),
        tol_m: float = 2.0,
        max_detour_ratio: float = 3.1,
    ) -> dict:
        # Snap each waypoint to nearest graph node (or interpolated off-trail fallback)
        pts_xyz = []  # [(x, y, z)]
        wp_cum_indices = []  # index into pts_xyz for each waypoint
        fallback_count = 0
        fallback_dist_m = 0.0

        def append_pt(x: float, y: float, z: float):
            if not pts_xyz or dist2d(pts_xyz[-1][0], pts_xyz[-1][2], x, z) > 0.5:
                pts_xyz.append((x, y, z))

        prev_nid = None
        prev_xyz = None

        for idx, wp in enumerate(waypoints):
            wx, wz = lon_lat_to_world(wp["lon"], wp["lat"])
            wy = sampler.sample_lon_lat(wp["lon"], wp["lat"])
            nid = net.nearest_node(wx, wz, max_dist=wp.get("snapMaxM", 2500.0), main_only=True)

            if idx == 0:
                if nid is not None:
                    nx, ny, nz = net.nodes[nid]
                    append_pt(nx, ny, nz)
                    prev_nid = nid
                    prev_xyz = (nx, ny, nz)
                else:
                    append_pt(wx, wy, wz)
                    prev_xyz = (wx, wy, wz)
                wp_cum_indices.append(0)
                continue

            routed_ok = False
            if prev_nid is not None and nid is not None:
                chain = net.astar(
                    prev_nid,
                    nid,
                    kind_weights=kind_weights,
                    prefer_name_substrs=prefer_names,
                    avoid_name_substrs=avoid_names,
                )
                if chain is not None:
                    straight = dist2d(prev_xyz[0], prev_xyz[2], net.nodes[nid][0], net.nodes[nid][2])
                    path_len = sum(net.edges[ei]["lengthM"] for ei, _ in chain)
                    # Allow trail switchbacks up to max_detour_ratio * straight-line
                    if path_len <= max(5500.0, straight * max_detour_ratio):
                        for ei, rev in chain:
                            c = net.edges[ei]["coords"]
                            n_pts = len(c) // 3
                            rng = range(n_pts - 1, -1, -1) if rev else range(n_pts)
                            for j in rng:
                                append_pt(c[j * 3], c[j * 3 + 1], c[j * 3 + 2])
                        routed_ok = True
                        prev_nid = nid
                        prev_xyz = tuple(net.nodes[nid])

            if not routed_ok:
                # Off-trail alpine scramble / connector sampled from Terrarium DEM
                tx, ty, tz = (tuple(net.nodes[nid]) if nid is not None else (wx, wy, wz))
                seg_d = dist2d(prev_xyz[0], prev_xyz[2], tx, tz)
                fallback_count += 1
                fallback_dist_m += seg_d
                steps = max(2, int(math.ceil(seg_d / 60.0)))
                for s in range(1, steps + 1):
                    f = s / steps
                    ix = prev_xyz[0] + (tx - prev_xyz[0]) * f
                    iz = prev_xyz[2] + (tz - prev_xyz[2]) * f
                    iy = sampler.sample_world(ix, iz)
                    append_pt(ix, iy, iz)
                prev_nid = nid
                prev_xyz = (tx, ty, tz)

            wp_cum_indices.append(len(pts_xyz) - 1)

        # Compute cumulative distance along dense polyline
        dense = []
        cum = 0.0
        for i, (x, y, z) in enumerate(pts_xyz):
            if i > 0:
                cum += dist2d(pts_xyz[i - 1][0], pts_xyz[i - 1][2], x, z)
            dense.append((x, y, z, cum))

        ys = [p[1] for p in dense]
        gain_m, loss_m = smooth_gain_loss(ys, threshold_m=2.0)

        # Extract checkpoints strictly from waypoint indices
        checkpoints = []
        for idx, wp in enumerate(waypoints):
            if not wp.get("cp"):
                continue
            pi = wp_cum_indices[idx]
            px, _, pz, pd = dense[pi]
            cp_obj = {
                "name": wp["name"],
                "d": round(pd, 1),
                "x": round(px, 1),
                "z": round(pz, 1),
            }
            if wp.get("cutoffH") is not None:
                cp_obj["cutoffH"] = wp["cutoffH"]
            checkpoints.append(cp_obj)

        simplified = simplify_polyline(dense, tol_m=tol_m)
        line_flat = []
        for x, _, z, d in simplified:
            line_flat.extend([round(x, 1), round(z, 1), round(d, 1)])

        # Start & finish headings
        s0 = simplified[0]
        s1 = simplified[min(1, len(simplified) - 1)]
        start_h = compute_heading(s1[0] - s0[0], s1[2] - s0[2])
        e0 = simplified[max(0, len(simplified) - 2)]
        e1 = simplified[-1]
        fin_h = compute_heading(e1[0] - e0[0], e1[2] - e0[2])

        dist_mi = round(cum * M_TO_MI, 1)
        gain_ft = int(round(gain_m * M_TO_FT))
        print(
            f"  {rid:24s}: {dist_mi:5.1f} mi (official {official_dist_mi:5.1f}), "
            f"{gain_ft:6d} ft (official {official_gain_ft:6d}), "
            f"pts={len(simplified):4d}, fb={fallback_count} ({fallback_dist_m/1000:.2f} km)"
        )

        return {
            "id": rid,
            "name": name,
            "blurb": blurb,
            "distanceMi": dist_mi,
            "officialDistanceMi": official_dist_mi,
            "gainFt": gain_ft,
            "officialGainFt": official_gain_ft,
            "cutoffH": cutoff_h,
            "startTimeLocal": start_time_local,
            "start": {"x": round(s0[0], 1), "z": round(s0[2], 1), "heading": start_h},
            "finish": {"x": round(e1[0], 1), "z": round(e1[2], 1), "heading": fin_h},
            "checkpoints": checkpoints,
            "line": line_flat,
        }

    print("Reconstructing races over OSM trail graph:")

    # 1. Hardrock 100 CW waypoints (Silverton -> KT -> Chapman -> Telluride -> Krogers -> Gov -> Ouray -> Engineer -> Grouse -> Handies -> Burrows -> Sherman -> Pole -> Maggie -> Cunningham -> Silverton)
    hr_cw_wps = [
        {"name": "Silverton (Start)", "lon": -107.6645, "lat": 37.8119, "cp": False},
        {"name": "Mineral Creek", "lon": -107.6940, "lat": 37.8160},
        {"name": "South Mineral / Swamp Canyon", "lon": -107.7280, "lat": 37.8260},
        {"name": "KT Aid Station", "lon": -107.7544, "lat": 37.8076, "cp": True, "cutoffH": 7.5},
        {"name": "Clear Lake", "lon": -107.7823, "lat": 37.8261},
        {"name": "Grant Swamp Pass", "lon": -107.7945, "lat": 37.8295},
        {"name": "Island Lake / Swamp Canyon", "lon": -107.7992, "lat": 37.8247},
        {"name": "Chapman Gulch", "lon": -107.8078, "lat": 37.8448, "cp": True, "cutoffH": 11.5},
        {"name": "Ophir / Blixt Trail", "lon": -107.8051, "lat": 37.8605},
        {"name": "Oscar's Pass", "lon": -107.7912, "lat": 37.8772},
        {"name": "Wasatch / Bear Creek", "lon": -107.8093, "lat": 37.9110},
        {"name": "Telluride", "lon": -107.8075, "lat": 37.9355, "cp": True, "cutoffH": 16.5},
        {"name": "Tomboy Road", "lon": -107.7672, "lat": 37.9434},
        {"name": "Kroger's Canteen (Virginius Pass)", "lon": -107.7864, "lat": 37.9580, "cp": True, "cutoffH": 20.5},
        {"name": "Governor Basin", "lon": -107.7672, "lat": 37.9787, "cp": True, "cutoffH": 22.5},
        {"name": "Camp Bird", "lon": -107.7240, "lat": 37.9740},
        {"name": "Ouray", "lon": -107.6714, "lat": 38.0228, "cp": True, "cutoffH": 26.0},
        {"name": "Bear Creek Trail (Ouray)", "lon": -107.6480, "lat": 38.0010},
        {"name": "Engineer Pass", "lon": -107.5844, "lat": 37.9752, "cp": True, "cutoffH": 30.5},
        {"name": "Animas Forks", "lon": -107.5714, "lat": 37.9311},
        {"name": "Grouse Gulch", "lon": -107.5515, "lat": 37.9210, "cp": True, "cutoffH": 33.0},
        {"name": "American Basin", "lon": -107.5170, "lat": 37.9076},
        {"name": "Handies Peak (14,048 ft)", "lon": -107.5044, "lat": 37.9130, "cp": True},
        {"name": "Grizzly Gulch", "lon": -107.4840, "lat": 37.9340},
        {"name": "Burrows Park", "lon": -107.4750, "lat": 37.9430, "cp": True, "cutoffH": 36.5},
        {"name": "Cinnamon Pass Rd / Henson", "lon": -107.4200, "lat": 37.9470},
        {"name": "Sherman", "lon": -107.3740, "lat": 37.9392, "cp": True, "cutoffH": 38.0},
        {"name": "Cataract Gulch Trail", "lon": -107.4150, "lat": 37.9120},
        {"name": "Cataract Lake", "lon": -107.4402, "lat": 37.8729},
        {"name": "Pole Creek", "lon": -107.4678, "lat": 37.8090, "cp": True, "cutoffH": 41.5},
        {"name": "Maggie Gulch", "lon": -107.5365, "lat": 37.8126, "cp": True, "cutoffH": 43.0},
        {"name": "Buffalo Boy Ridge", "lon": -107.5505, "lat": 37.8076},
        {"name": "Cunningham Gulch", "lon": -107.5793, "lat": 37.7823, "cp": True, "cutoffH": 45.0},
        {"name": "Dives-Little Giant Pass", "lon": -107.6120, "lat": 37.7960},
        {"name": "Silverton (Kiss the Rock)", "lon": -107.6645, "lat": 37.8119, "cp": True, "cutoffH": 48.0},
    ]

    # CCW is the reverse loop plus Putnam Basin
    hr_ccw_wps = list(reversed(hr_cw_wps))
    hr_ccw_wps[0] = {"name": "Silverton (Start)", "lon": -107.6645, "lat": 37.8119, "cp": False}
    hr_ccw_wps[-1] = {"name": "Silverton (Kiss the Rock)", "lon": -107.6645, "lat": 37.8119, "cp": True, "cutoffH": 48.0}
    # Update CCW cutoffs roughly proportional to CCW miles
    ccw_cutoffs = {
        "Cunningham Gulch": 5.5,
        "Maggie Gulch": 8.5,
        "Pole Creek": 11.5,
        "Sherman": 15.5,
        "Burrows Park": 17.5,
        "Grouse Gulch": 22.0,
        "Engineer Pass": 25.0,
        "Ouray": 29.0,
        "Governor Basin": 32.5,
        "Kroger's Canteen (Virginius Pass)": 34.5,
        "Telluride": 37.0,
        "Chapman Gulch": 41.0,
        "KT Aid Station": 44.0,
        "Silverton (Kiss the Rock)": 48.0,
    }
    for wp in hr_ccw_wps:
        if wp["name"] in ccw_cutoffs:
            wp["cutoffH"] = ccw_cutoffs[wp["name"]]

    # 3. Imogene Pass Run (Ouray -> Telluride, 17.1 mi)
    imogene_wps = [
        {"name": "Ouray Main St (Start)", "lon": -107.6714, "lat": 38.0228, "cp": False},
        {"name": "Canyon Creek Bridge", "lon": -107.6920, "lat": 38.0050, "cp": True},
        {"name": "Lower Camp Bird", "lon": -107.7235, "lat": 37.9750, "cp": True},
        {"name": "Upper Camp Bird", "lon": -107.7375, "lat": 37.9560, "cp": True, "cutoffH": 2.5},
        {"name": "Imogene Pass (13,114 ft)", "lon": -107.7372, "lat": 37.9325, "cp": True},
        {"name": "Tomboy Townsite", "lon": -107.7535, "lat": 37.9332, "cp": True},
        {"name": "Social Tunnel", "lon": -107.7810, "lat": 37.9355, "cp": True},
        {"name": "Telluride Oak St (Finish)", "lon": -107.8120, "lat": 37.9368, "cp": True, "cutoffH": 7.0},
    ]

    # 4. Telluride Mountain Run 40M
    tmr_wps = [
        {"name": "Telluride Town Park", "lon": -107.8058, "lat": 37.9356, "cp": False},
        {"name": "Bear Creek Falls", "lon": -107.8018, "lat": 37.9068},
        {"name": "Wasatch Pass", "lon": -107.7830, "lat": 37.8935, "cp": True},
        {"name": "Bridal Veil Aid", "lon": -107.7680, "lat": 37.9165, "cp": True, "cutoffH": 5.5},
        {"name": "Ajax Peak", "lon": -107.7592, "lat": 37.9308},
        {"name": "Telluride Peak (Mile & a Half of Sky)", "lon": -107.7490, "lat": 37.9312, "cp": True},
        {"name": "Imogene Pass", "lon": -107.7372, "lat": 37.9325},
        {"name": "Tomboy", "lon": -107.7535, "lat": 37.9332},
        {"name": "Oak Street Aid", "lon": -107.8120, "lat": 37.9368, "cp": True, "cutoffH": 10.5},
        {"name": "Jud Wiebe Trail", "lon": -107.8152, "lat": 37.9435},
        {"name": "Mill Creek / Waterline", "lon": -107.8350, "lat": 37.9510, "cp": True},
        {"name": "Deep Creek High Point", "lon": -107.8650, "lat": 37.9720, "cp": True},
        {"name": "Deep Creek Corral", "lon": -107.8825, "lat": 37.9688},
        {"name": "Telluride Town Park (Finish)", "lon": -107.8058, "lat": 37.9356, "cp": True, "cutoffH": 17.0},
    ]

    # 5. Rundola (Telluride Base -> St. Sophia Station)
    rundola_wps = [
        {"name": "Telluride Gondola Plaza", "lon": -107.8123, "lat": 37.9362, "cp": False},
        {"name": "Telluride Trail Mid-Station", "lon": -107.8244, "lat": 37.9328, "cp": True},
        {"name": "Coonskin Ridge Turn", "lon": -107.8322, "lat": 37.9301},
        {"name": "St. Sophia Station (10,540 ft)", "lon": -107.8260, "lat": 37.9277, "cp": True, "cutoffH": 3.0},
    ]

    # 6. Deep Creek Trail Half Marathon
    deep_creek_wps = [
        {"name": "Telluride Airport / Last Dollar Rd", "lon": -107.9016, "lat": 37.9543, "cp": False},
        {"name": "Deep Creek Trailhead", "lon": -107.9025, "lat": 37.9640},
        {"name": "Deep Creek Aid 1", "lon": -107.8406, "lat": 37.9677, "cp": True},
        {"name": "Deep Creek / Mill Creek", "lon": -107.8253, "lat": 37.9619, "cp": True},
        {"name": "Waterline / Jud Wiebe", "lon": -107.8183, "lat": 37.9474, "cp": True},
        {"name": "Liberty Bell / Tomboy Rd", "lon": -107.8064, "lat": 37.9451},
        {"name": "Oak St / Courthouse (Finish)", "lon": -107.8123, "lat": 37.9368, "cp": True, "cutoffH": 5.5},
    ]

    # 7. Kendall Mountain Run (Silverton -> Kendall Summit -> Silverton)
    kendall_wps = [
        {"name": "Silverton Memorial Park", "lon": -107.6610, "lat": 37.8105, "cp": False},
        {"name": "Deer Park Aid", "lon": -107.6380, "lat": 37.7980, "cp": True},
        {"name": "Kendall Mountain Road (The Notch)", "lon": -107.6214, "lat": 37.7863, "cp": True},
        {"name": "Kendall Mountain Summit (13,066 ft)", "lon": -107.6195, "lat": 37.7885, "cp": True},
        {"name": "The Notch (Return)", "lon": -107.6214, "lat": 37.7863},
        {"name": "Silverton Memorial Park (Finish)", "lon": -107.6610, "lat": 37.8105, "cp": True, "cutoffH": 5.0},
    ]

    # 8. San Juan Solstice 50 (Lake City)
    sjs_wps = [
        {"name": "Lake City Town Park", "lon": -107.3153, "lat": 38.0297, "cp": False},
        {"name": "Alpine Gulch / CR 14", "lon": -107.3222, "lat": 37.9952, "cp": True},
        {"name": "Williams Creek", "lon": -107.3328, "lat": 37.9216, "cp": True},
        {"name": "Carson", "lon": -107.3630, "lat": 37.8708, "cp": True},
        {"name": "Cascade / Bent Creek", "lon": -107.3436, "lat": 37.9089, "cp": True},
        {"name": "Slumgullion / Sawmill Park", "lon": -107.2743, "lat": 37.9827, "cp": True},
        {"name": "Vickers", "lon": -107.2989, "lat": 38.0030, "cp": True},
        {"name": "Lake City Town Park (Finish)", "lon": -107.3153, "lat": 38.0297, "cp": True, "cutoffH": 16.0},
    ]

    # 9. Silverton Alpine 50K
    sil_alpine_wps = [
        {"name": "Silverton Memorial Park", "lon": -107.6610, "lat": 37.8105, "cp": False},
        {"name": "Howardsville", "lon": -107.5950, "lat": 37.8350, "cp": True},
        {"name": "Eureka", "lon": -107.5650, "lat": 37.8780, "cp": True},
        {"name": "Animas Forks", "lon": -107.5714, "lat": 37.9311, "cp": True},
        {"name": "California Pass (12,930 ft)", "lon": -107.6000, "lat": 37.9260, "cp": True},
        {"name": "Gladstone", "lon": -107.6510, "lat": 37.8910, "cp": True},
        {"name": "Silverton (Finish)", "lon": -107.6610, "lat": 37.8105, "cp": True, "cutoffH": 11.0},
    ]

    # 10. Blue Lakes & Sneffels Highline Classic (Ouray/Ridgway side -> Blue Lakes Pass -> Yankee Boy -> Camp Bird)
    blue_lakes_wps = [
        {"name": "Blue Lakes Trailhead", "lon": -107.7847, "lat": 37.9948, "cp": False},
        {"name": "Lower Blue Lake", "lon": -107.8075, "lat": 37.9915, "cp": True},
        {"name": "Blue Lakes Pass (13,000 ft)", "lon": -107.8008, "lat": 37.9787, "cp": True},
        {"name": "Yankee Boy Basin", "lon": -107.7830, "lat": 37.9890, "cp": True},
        {"name": "Camp Bird Road", "lon": -107.7240, "lat": 37.9740, "cp": True, "cutoffH": 9.0},
    ]

    races = [
        make_race(
            "hardrock-100-cw",
            "Hardrock 100 (Clockwise)",
            "102 miles, 33,000+ ft of vert, 13 passes above 12,000 ft, and a painted rock waiting in Silverton. Estimated finish: sometime next week.",
            102.0, 33441, 48.0, "06:00", hr_cw_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.15, "road": 2.2},
            prefer_names=("hardrock", "bear creek", "wasatch", "colorado trail", "continental divide"),
        ),
        make_race(
            "hardrock-100-ccw",
            "Hardrock 100 (Counter-Clockwise)",
            "The exact same 33,000 ft of suffering, just starting with Cunningham Gulch instead of KT so your quads are surprised differently.",
            102.5, 33441, 48.0, "06:00", hr_ccw_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.15, "road": 2.2},
            prefer_names=("hardrock", "bear creek", "wasatch", "colorado trail", "continental divide"),
        ),
        make_race(
            "imogene-pass-run",
            "Imogene Pass Run",
            "17.1 miles from Ouray (7,811 ft) up and over 13,114 ft Imogene Pass to Telluride. At least the second half is mostly downhill — until your quads explode.",
            17.1, 5300, 7.0, "07:30", imogene_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.0, "road": 1.6},
            prefer_names=("imogene", "camp bird", "tomboy"),
        ),
        make_race(
            "telluride-mountain-run",
            "Telluride Mountain Run (40M)",
            "40 rugged miles circling the box canyon, highlighted by the 'Mile and a Half of Sky' ridge above 13,000 ft where gravity becomes optional.",
            40.0, 15000, 17.0, "05:00", tmr_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.25, "road": 2.2},
            prefer_names=("bear creek", "wasatch", "jud wiebe", "deep creek", "waterline"),
        ),
        make_race(
            "rundola",
            "Rundola",
            "2.4 miles straight up the Telluride gondola corridor to St. Sophia Station. You get to ride the gondola back down, which is the only civilized part.",
            2.4, 1810, 3.0, "08:00", rundola_wps,
            kind_weights={"trail": 1.0, "path": 1.0, "track": 1.2, "road": 2.0},
            prefer_names=("telluride trail", "gondola", "st. sophia"),
        ),
        make_race(
            "deep-creek-half",
            "Deep Creek Trail Half Marathon",
            "13.1 miles of golden-aspen singletrack from Last Dollar Road across Deep Creek, Mill Creek, Waterline, and Jud Wiebe down to Oak Street.",
            13.1, 3100, 5.5, "08:00", deep_creek_wps,
            kind_weights={"trail": 1.0, "path": 1.0, "track": 1.25, "road": 2.2},
            prefer_names=("deep creek", "mill creek", "waterline", "jud wiebe", "liberty bell"),
        ),
        make_race(
            "kendall-mountain-run",
            "Kendall Mountain Run",
            "Born from a 1908 Silverton bar bet: climb 3,960 ft straight up Kendall Mountain to 13,066 ft and sprint back to Memorial Park.",
            12.3, 3960, 5.0, "08:00", kendall_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.05, "road": 1.6},
            prefer_names=("kendall",),
            max_detour_ratio=6.0,
        ),
        make_race(
            "san-juan-solstice-50",
            "San Juan Solstice 50",
            "50-mile counter-clockwise high-alpine tour out of Lake City touching the Continental Divide above 13,300 ft. Bring a rain shell.",
            50.0, 12500, 16.0, "05:00", sjs_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.1, "road": 1.7},
        ),
        make_race(
            "silverton-alpine-50k",
            "Silverton Alpine 50K",
            "High-altitude Alpine Loop tour linking Howardsville, Eureka, Animas Forks, and 12,930 ft California Pass.",
            31.1, 7800, 11.0, "06:30", sil_alpine_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.05, "road": 1.5},
        ),
        make_race(
            "blue-lakes-alpine-classic",
            "Blue Lakes & Yankee Boy Classic",
            "Point-to-point Sneffels Wilderness showcase: climb past turquoise Lower and Upper Blue Lakes over 13,000 ft Blue Lakes Pass into Yankee Boy Basin.",
            12.5, 4200, 9.0, "07:00", blue_lakes_wps,
            kind_weights={"trail": 1.0, "path": 1.05, "track": 1.15, "road": 1.8},
            prefer_names=("blue lakes", "yankee boy"),
        ),
    ]
    return races


def main():
    t0 = time.time()
    proj_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PROJ
    proj = json.loads(proj_path.read_text())
    net = TrailNetwork(proj)
    sampler = TerrariumSampler(zoom=14, max_workers=8)

    pois = build_curated_pois(proj, net, sampler)
    races = build_races(net, sampler)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    pois_path = OUT_DIR / "pois.json"
    races_path = OUT_DIR / "races.json"
    pois_path.write_text(json.dumps(pois, separators=(",", ":")))
    races_path.write_text(json.dumps(races, separators=(",", ":")))
    print(
        f"Wrote pois.json ({pois_path.stat().st_size / 1024:.1f} KB) and "
        f"races.json ({races_path.stat().st_size / 1024:.1f} KB) in {time.time()-t0:.1f}s"
    )


if __name__ == "__main__":
    main()
