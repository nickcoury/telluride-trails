#!/usr/bin/env python3
"""Build a lightweight shaded-relief + imagery overview WebP of the playable bbox for the 2D map picker."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BBOX, DATA_DIR, ORIGIN, bbox_tile_range, tile_bounds_3857, tile_pixel_size_m
from fetch_elevation import decode_terrarium_rgb

IMAGERY_OUT = DATA_DIR / "imagery"
TERRAIN_OUT = DATA_DIR / "terrain"

EARTH_R = 6378137.0


def lonlat_to_merc(lon: float, lat: float) -> tuple[float, float]:
    mx = EARTH_R * math.radians(lon)
    my = EARTH_R * math.log(math.tan(math.pi / 4.0 + math.radians(lat) / 2.0))
    return mx, my


def lonlat_to_world(lon: float, lat: float) -> tuple[float, float]:
    """Match src/core/geo.js scaled Web Mercator world coordinates."""
    k = math.cos(math.radians(ORIGIN[0]))
    mx0, my0 = lonlat_to_merc(ORIGIN[1], ORIGIN[0])
    mx, my = lonlat_to_merc(lon, lat)
    return (mx - mx0) * k, -(my - my0) * k


def stitch_layer(root: Path, ext: str, z: int, x0: int, x1: int, y0: int, y1: int) -> np.ndarray:
    nx = x1 - x0 + 1
    ny = y1 - y0 + 1
    canvas = np.zeros((ny * 256, nx * 256, 3), dtype=np.uint8)
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            p = root / str(z) / str(tx) / f"{ty}.{ext}"
            arr = np.asarray(Image.open(p).convert("RGB"))
            ry = (ty - y0) * 256
            rx = (tx - x0) * 256
            canvas[ry : ry + 256, rx : rx + 256] = arr
    return canvas


def compute_hillshade(elev_m: np.ndarray, px_m: float, azimuth_deg: float = 315.0, altitude_deg: float = 40.0) -> np.ndarray:
    """Compute crisp multidirectional terrain hillshade in [0, 1]."""
    gy, gx = np.gradient(elev_m.astype(np.float64), px_m)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)  # 0=N, pi/2=E

    def shade(az_d: float, alt_d: float) -> np.ndarray:
        az = math.radians(az_d)
        zen = math.radians(90.0 - alt_d)
        hs = np.cos(zen) * np.cos(slope) + np.sin(zen) * np.sin(slope) * np.cos(az - aspect)
        return np.clip(hs, 0.0, 1.0)

    # Blend primary NW light with subtle WNW/NNW fill so steep east faces retain shape
    hs = 0.65 * shade(azimuth_deg, altitude_deg) + 0.20 * shade(280.0, 45.0) + 0.15 * shade(350.0, 48.0)
    return np.clip(hs, 0.0, 1.0).astype(np.float32)


def main() -> None:
    z = 12
    x0, x1, y0, y1 = bbox_tile_range(z, BBOX)
    print(f"Stitching z{z} grid x=[{x0}..{x1}] y=[{y0}..{y1}]...")

    img_grid = stitch_layer(IMAGERY_OUT, "webp", z, x0, x1, y0, y1).astype(np.float32) / 255.0
    dem_rgb = stitch_layer(TERRAIN_OUT, "webp", z, x0, x1, y0, y1)
    elev_m = decode_terrarium_rgb(dem_rgb)

    px_m = tile_pixel_size_m(z, (y0 + y1) // 2)
    hs = compute_hillshade(elev_m, px_m)

    # Subtle elevation tint & shaded relief modulation over color-balanced imagery
    # Neutral light at hs ~0.68; darken shadows gently and brighten sunlit ridges slightly
    relief = np.clip(0.55 + 0.68 * hs, 0.42, 1.15)[:, :, None]
    shaded = np.clip(img_grid * relief, 0.0, 1.0)
    # Slight cool atmospheric shadow tint on deep north/east shadow walls
    shadow_amt = np.clip((0.55 - hs) * 1.4, 0.0, 0.35)[:, :, None]
    shaded = shaded * (1.0 - shadow_amt) + np.array([0.14, 0.20, 0.30], dtype=np.float32) * shadow_amt

    # Crop accurately to exact BBOX in Web Mercator pixel space (so world bounds are exact!)
    minx_grid, _, _, maxy_grid = tile_bounds_3857(z, x0, y0)
    _, miny_grid, maxx_grid, _ = tile_bounds_3857(z, x1, y1)
    w_m, s_m = lonlat_to_merc(BBOX[0], BBOX[1])
    e_m, n_m = lonlat_to_merc(BBOX[2], BBOX[3])

    gw = img_grid.shape[1]
    gh = img_grid.shape[0]
    px_left = int(round((w_m - minx_grid) / (maxx_grid - minx_grid) * gw))
    px_right = int(round((e_m - minx_grid) / (maxx_grid - minx_grid) * gw))
    py_top = int(round((maxy_grid - n_m) / (maxy_grid - miny_grid) * gh))
    py_bottom = int(round((maxy_grid - s_m) / (maxy_grid - miny_grid) * gh))

    cropped = Image.fromarray(np.rint(np.clip(shaded[py_top:py_bottom, px_left:px_right], 0.0, 1.0) * 255.0).astype(np.uint8), mode="RGB")

    # Resize cleanly to width=2048 preserving exact Mercator aspect ratio
    out_w = 2048
    out_h = int(round(cropped.height * (out_w / cropped.width)))
    overview = cropped.resize((out_w, out_h), Image.Resampling.LANCZOS)

    out_webp = IMAGERY_OUT / "overview.webp"
    overview.save(out_webp, format="WEBP", quality=76, method=5)

    min_x, max_z = lonlat_to_world(BBOX[0], BBOX[1])
    max_x, min_z = lonlat_to_world(BBOX[2], BBOX[3])
    meta = {
        "image": "data/imagery/overview.webp",
        "width": out_w,
        "height": out_h,
        "bounds": {
            "west": BBOX[0],
            "south": BBOX[1],
            "east": BBOX[2],
            "north": BBOX[3],
        },
        "worldBounds": {
            "minX": round(min_x, 2),
            "maxX": round(max_x, 2),
            "minZ": round(min_z, 2),
            "maxZ": round(max_z, 2),
        },
        "attribution": "USGS National Map Orthoimagery + USGS 3DEP shaded relief",
    }
    out_json = IMAGERY_OUT / "overview.json"
    out_json.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_webp} ({out_w}x{out_h}, {out_webp.stat().st_size / 1024:.1f} KB) and {out_json}")


if __name__ == "__main__":
    main()
