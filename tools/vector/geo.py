"""
World-space projection and Web Mercator tile math for Telluride Trails.
Exact Python mirror of src/core/geo.js.
"""

import math

LAT0 = 37.9375
LON0 = -107.8123

BBOX = {
    "west": -108.02,
    "south": 37.68,
    "east": -107.25,
    "north": 38.10,
}

# Slightly padded bbox for routing/clipping continuity at edges
PADDED_BBOX = {
    "west": -108.05,
    "south": 37.65,
    "east": -107.22,
    "north": 38.13,
}

R = 6378137.0
K = math.cos(math.radians(LAT0))

M_TO_FT = 3.28084
FT_TO_M = 1.0 / M_TO_FT
M_TO_MI = 1.0 / 1609.344

DEG_TO_RAD = math.pi / 180.0
RAD_TO_DEG = 180.0 / math.pi
HALF_CIRCUMFERENCE = math.pi * R


def mercator_x(lon_deg: float) -> float:
    return R * lon_deg * DEG_TO_RAD


def mercator_y(lat_deg: float) -> float:
    lat_rad = lat_deg * DEG_TO_RAD
    return R * math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))


MX0 = mercator_x(LON0)
MY0 = mercator_y(LAT0)


def lon_lat_to_world(lon: float, lat: float) -> tuple[float, float]:
    """Convert WGS84 lon/lat (deg) to Three.js world XZ (meters; +X east, -Z north)."""
    return (
        (mercator_x(lon) - MX0) * K,
        -(mercator_y(lat) - MY0) * K,
    )


def world_to_lon_lat(x: float, z: float) -> tuple[float, float]:
    """Convert Three.js world XZ (meters) to WGS84 lon/lat (deg)."""
    mx = x / K + MX0
    my = -z / K + MY0
    lon = (mx / R) * RAD_TO_DEG
    lat = (2.0 * math.atan(math.exp(my / R)) - math.pi / 2.0) * RAD_TO_DEG
    return (lon, lat)


def tile_bounds_world(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return (minX, maxX, minZ, maxZ) in world meters for Web Mercator tile (z, x, y)."""
    n = 1 << z
    tile_merc_size = (2.0 * HALF_CIRCUMFERENCE) / n
    mx_left = -HALF_CIRCUMFERENCE + x * tile_merc_size
    mx_right = mx_left + tile_merc_size
    my_top = HALF_CIRCUMFERENCE - y * tile_merc_size
    my_bottom = my_top - tile_merc_size
    return (
        (mx_left - MX0) * K,
        (mx_right - MX0) * K,
        -(my_top - MY0) * K,
        -(my_bottom - MY0) * K,
    )


def world_to_tile(x: float, z: float, zoom: int) -> tuple[int, int]:
    """Return Web Mercator tile (tx, ty) containing world (x, z) at zoom."""
    n = 1 << zoom
    mx = x / K + MX0
    my = -z / K + MY0
    u = (mx / HALF_CIRCUMFERENCE + 1.0) * 0.5
    v = (1.0 - my / HALF_CIRCUMFERENCE) * 0.5
    tx = max(0, min(n - 1, int(math.floor(u * n))))
    ty = max(0, min(n - 1, int(math.floor(v * n))))
    return (tx, ty)


def lon_lat_to_tile_frac(lon: float, lat: float, zoom: int) -> tuple[float, float]:
    """Return fractional Web Mercator tile coordinates (fx, fy) at zoom."""
    n = 1 << zoom
    mx = mercator_x(lon)
    my = mercator_y(lat)
    u = (mx / HALF_CIRCUMFERENCE + 1.0) * 0.5
    v = (1.0 - my / HALF_CIRCUMFERENCE) * 0.5
    return (u * n, v * n)


def bbox_tiles(bbox: dict, zoom: int) -> tuple[int, int, int, int]:
    """Return (x_min, x_max, y_min, y_max) inclusive tile indices covering bbox."""
    wx0, wz0 = lon_lat_to_world(bbox["west"], bbox["north"])
    wx1, wz1 = lon_lat_to_world(bbox["east"], bbox["south"])
    x_min, y_min = world_to_tile(wx0, wz0, zoom)
    x_max, y_max = world_to_tile(wx1, wz1, zoom)
    return (x_min, x_max, y_min, y_max)
