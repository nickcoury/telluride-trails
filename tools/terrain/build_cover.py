#!/usr/bin/env python3
"""Build RGBA cover masks (R=forest, G=rock/talus, B=water, A=tundra/grass) from NLCD 2021 + DEM slope/elevation + imagery."""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    BBOX,
    CACHE_DIR,
    DATA_DIR,
    bbox_tiles,
    build_manifest,
    fetch_cached,
    run_parallel,
    tile_bounds_3857,
    tile_pixel_size_m,
)

NLCD_WMS_URL = (
    "https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms"
    "?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=NLCD_2021_Land_Cover_L48"
    "&SRS=EPSG:3857&BBOX={minx},{miny},{maxx},{maxy}&WIDTH=256&HEIGHT=256&FORMAT=image/png"
)
TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
USGS_IMAGERY_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"

COVER_OUT = DATA_DIR / "cover"
TERRAIN_OUT = DATA_DIR / "terrain"
IMAGERY_OUT = DATA_DIR / "imagery"

NLCD_CACHE = CACHE_DIR / "nlcd2021"
TERRAIN_CACHE = CACHE_DIR / "terrarium"
IMAGERY_CACHE = CACHE_DIR / "usgs_imagery"

# Exact MRLC GeoServer NLCD 2021 SLD ColorMap RGB -> (forest, rock, water, grass)
# Note: Developed town classes (21..24) keep rock <= 0.10 so world/rocks.js doesn't spawn alpine
# talus boulders in town and game/physics.js treats off-road town parks/yards as grass/dirt, not scree.
# Woody Wetlands (90) keeps forest=0.22 (<0.35) & grass=0.75 so world/vegetation.js spawns riparian willows.
NLCD_COLOR_PRIORS: dict[tuple[int, int, int], tuple[float, float, float, float]] = {
    (71, 107, 160): (0.00, 0.00, 1.00, 0.00),   # 11 Open Water
    (209, 221, 249): (0.00, 0.78, 0.05, 0.05),  # 12 Perennial Ice/Snow
    (221, 201, 201): (0.14, 0.04, 0.00, 0.72),  # 21 Developed, Open Space (parks/lawns)
    (216, 147, 130): (0.12, 0.06, 0.00, 0.52),  # 22 Developed, Low Intensity (yards)
    (237, 0, 0): (0.06, 0.08, 0.00, 0.30),      # 23 Developed, Medium Intensity (town)
    (170, 0, 0): (0.02, 0.10, 0.00, 0.18),      # 24 Developed, High Intensity (town core)
    (178, 173, 163): (0.00, 0.94, 0.00, 0.06),  # 31 Barren Land (Rock/Sand/Clay)
    (249, 249, 249): (0.00, 0.75, 0.10, 0.15),  # 32 Unconsolidated Shore
    (104, 170, 99): (0.78, 0.02, 0.00, 0.32),   # 41 Deciduous Forest (Aspen)
    (28, 99, 48): (0.94, 0.02, 0.00, 0.10),     # 42 Evergreen Forest (Spruce/Fir/Pine)
    (181, 201, 142): (0.86, 0.02, 0.00, 0.20),  # 43 Mixed Forest
    (176, 151, 61): (0.10, 0.15, 0.00, 0.70),   # 51 Dwarf Scrub
    (204, 186, 124): (0.14, 0.18, 0.00, 0.72),  # 52 Shrub/Scrub
    (226, 226, 193): (0.02, 0.08, 0.00, 0.90),  # 71 Grassland/Herbaceous (Tundra)
    (209, 209, 130): (0.02, 0.08, 0.00, 0.88),  # 72 Sedge/Herbaceous
    (153, 194, 70): (0.00, 0.15, 0.00, 0.82),   # 73 Lichens
    (130, 186, 158): (0.00, 0.10, 0.00, 0.85),  # 74 Moss
    (219, 216, 61): (0.04, 0.04, 0.00, 0.88),   # 81 Pasture/Hay
    (170, 112, 40): (0.02, 0.10, 0.00, 0.80),   # 82 Cultivated Crops
    (186, 216, 234): (0.22, 0.00, 0.08, 0.75),  # 90 Woody Wetlands (Riparian Willows)
    (112, 163, 186): (0.08, 0.00, 0.14, 0.82),  # 95 Emergent Herbaceous Wetlands
}

_NLCD_RGB_KEYS = np.array(list(NLCD_COLOR_PRIORS.keys()), dtype=np.int32)
_NLCD_PRIOR_VALS = np.array(list(NLCD_COLOR_PRIORS.values()), dtype=np.float32)


def smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    """Hermite smoothstep supporting both increasing and decreasing edges."""
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def load_dem_tile(z: int, x: int, y: int) -> np.ndarray:
    """Load 256x256 elevation (meters) from local terrain output or cache."""
    webp_path = TERRAIN_OUT / str(z) / str(x) / f"{y}.webp"
    if webp_path.exists():
        im = Image.open(webp_path).convert("RGB")
    else:
        cache_path = TERRAIN_CACHE / str(z) / str(x) / f"{y}.png"
        raw = fetch_cached(TERRARIUM_URL.format(z=z, x=x, y=y), cache_path)
        im = Image.open(io.BytesIO(raw)).convert("RGB")
    arr = np.asarray(im, dtype=np.float32)
    return arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0 - 32768.0


def load_dem_with_border(z: int, x: int, y: int, pad: int = 2) -> np.ndarray:
    """Load DEM tile padded by `pad` pixels from neighboring tiles for seamless edge slopes."""
    center = load_dem_tile(z, x, y)
    out = np.pad(center, pad, mode="edge")
    n_tiles = 1 << z
    # Fill immediate edge neighbors if within valid range
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx, ny = x + dx, y + dy
            if not (0 <= nx < n_tiles and 0 <= ny < n_tiles):
                continue
            try:
                nb = load_dem_tile(z, nx, ny)
            except Exception:
                continue
            y_src = slice(256 - pad, 256) if dy == -1 else (slice(0, pad) if dy == 1 else slice(0, 256))
            x_src = slice(256 - pad, 256) if dx == -1 else (slice(0, pad) if dx == 1 else slice(0, 256))
            y_dst = slice(0, pad) if dy == -1 else (slice(256 + pad, 256 + 2 * pad) if dy == 1 else slice(pad, 256 + pad))
            x_dst = slice(0, pad) if dx == -1 else (slice(256 + pad, 256 + 2 * pad) if dx == 1 else slice(pad, 256 + pad))
            out[y_dst, x_dst] = nb[y_src, x_src]
    return out


def load_imagery_rgb(z: int, x: int, y: int) -> np.ndarray:
    """Load 256x256 RGB imagery normalized to [0, 1]."""
    webp_path = IMAGERY_OUT / str(z) / str(x) / f"{y}.webp"
    if webp_path.exists():
        im = Image.open(webp_path).convert("RGB")
    else:
        cache_path = IMAGERY_CACHE / str(z) / str(x) / f"{y}.jpg"
        raw = fetch_cached(USGS_IMAGERY_URL.format(z=z, y=y, x=x), cache_path, min_bytes=500)
        im = Image.open(io.BytesIO(raw)).convert("RGB")
    if im.size != (256, 256):
        im = im.resize((256, 256), Image.Resampling.BILINEAR)
    return np.asarray(im, dtype=np.float32) * (1.0 / 255.0)


def map_nlcd_colors(rgb: np.ndarray) -> np.ndarray:
    """Map 256x256 NLCD WMS RGB image to (256, 256, 4) float32 priors."""
    flat = rgb.reshape(-1, 3).astype(np.int32)
    # Fast exact lookup via packed 24-bit int; fallback to nearest color for anti-aliased edge pixels
    packed_keys = (_NLCD_RGB_KEYS[:, 0] << 16) | (_NLCD_RGB_KEYS[:, 1] << 8) | _NLCD_RGB_KEYS[:, 2]
    packed_img = (flat[:, 0] << 16) | (flat[:, 1] << 8) | flat[:, 2]

    key_to_idx = {int(k): i for i, k in enumerate(packed_keys)}
    out = np.zeros((flat.shape[0], 4), dtype=np.float32)

    uniq_codes, inverse = np.unique(packed_img, return_inverse=True)
    uniq_priors = np.zeros((len(uniq_codes), 4), dtype=np.float32)
    for ui, code in enumerate(uniq_codes):
        idx = key_to_idx.get(int(code))
        if idx is not None:
            uniq_priors[ui] = _NLCD_PRIOR_VALS[idx]
        else:
            r = (code >> 16) & 255
            g = (code >> 8) & 255
            b = code & 255
            if r == 0 and g == 0 and b == 0:
                uniq_priors[ui] = (0.0, 0.2, 0.0, 0.8)
            else:
                dists = np.sum((_NLCD_RGB_KEYS - np.array([r, g, b])) ** 2, axis=1)
                uniq_priors[ui] = _NLCD_PRIOR_VALS[int(np.argmin(dists))]
    out[:] = uniq_priors[inverse]
    return out.reshape(256, 256, 4)


def quantize_4bit(arr01: np.ndarray) -> np.ndarray:
    """Quantize [0,1] float array to 16 evenly-spaced uint8 levels (0, 17, ..., 255) for compact PNG compression."""
    levels = np.rint(np.clip(arr01, 0.0, 1.0) * 15.0).astype(np.uint8)
    return levels * np.uint8(17)


def process_tile(task: tuple[int, int, int, bool]) -> tuple[int, int, int, int]:
    """Generate one 256x256 RGBA cover mask tile."""
    z, x, y, overwrite = task
    out_path = COVER_OUT / str(z) / str(x) / f"{y}.png"
    if not overwrite and out_path.exists() and out_path.stat().st_size > 100:
        return (z, x, y, out_path.stat().st_size)

    # 1. Fetch NLCD 2021 tile
    minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
    nlcd_cache = NLCD_CACHE / str(z) / str(x) / f"{y}.png"
    nlcd_url = NLCD_WMS_URL.format(minx=minx, miny=miny, maxx=maxx, maxy=maxy)
    nlcd_bytes = fetch_cached(nlcd_url, nlcd_cache, timeout=30.0, min_bytes=200)
    nlcd_rgb = np.asarray(Image.open(io.BytesIO(nlcd_bytes)).convert("RGB"))
    priors = map_nlcd_colors(nlcd_rgb)

    # Softly de-block 30m NLCD boundaries for vegetation/rock while keeping water sharp
    sigma = 0.65 if z == 13 else 1.15
    forest = gaussian_filter(priors[:, :, 0], sigma=sigma, mode="nearest")
    rock = gaussian_filter(priors[:, :, 1], sigma=sigma, mode="nearest")
    water = priors[:, :, 2]
    grass = gaussian_filter(priors[:, :, 3], sigma=sigma, mode="nearest")

    # 2. DEM elevation & seamless slope
    pad = 2
    dem_pad = load_dem_with_border(z, x, y, pad=pad)
    elev = dem_pad[pad:-pad, pad:-pad]
    px_m = tile_pixel_size_m(z, y)
    gy, gx = np.gradient(dem_pad, px_m)
    slope_rad = np.arctan(np.hypot(gx[pad:-pad, pad:-pad], gy[pad:-pad, pad:-pad]))
    slope_deg = np.degrees(slope_rad)

    # 3. Imagery texture/color refinement (high-res conifer/talus/snow cues)
    img = load_imagery_rgb(z, x, y)
    r_c, g_c, b_c = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    mx = np.maximum(np.maximum(r_c, g_c), b_c)
    mn = np.minimum(np.minimum(r_c, g_c), b_c)
    lum = 0.2126 * r_c + 0.7152 * g_c + 0.0722 * b_c
    sat = (mx - mn) / np.maximum(mx, 1e-4)

    # Dark green forest canopy signal vs neutral bright rock/talus signal
    is_green_veg = np.clip((g_c - np.maximum(r_c * 0.96, b_c * 0.98)) * 8.0, 0.0, 1.0)
    is_dark_canopy = smoothstep(0.42, 0.16, lum) * smoothstep(0.03, 0.14, g_c - b_c + 0.04)
    is_grey_talus = smoothstep(0.22, 0.08, sat) * smoothstep(0.28, 0.52, lum)

    # 4. Physical San Juan rules:
    # Treeline: ~11,400 ft (3475 m) starts tapering; ~12,150 ft (3703 m) zero tall forest
    treeline = smoothstep(3710.0, 3440.0, elev)
    excess_forest = forest * (1.0 - treeline)
    forest = forest * treeline
    # Above treeline, former forest pixels become tundra on gentler slopes or talus on steeper ones
    alpine_rock_split = smoothstep(28.0, 40.0, slope_deg)
    grass = np.clip(grass + excess_forest * (1.0 - alpine_rock_split), 0.0, 1.0)
    rock = np.clip(rock + excess_forest * alpine_rock_split, 0.0, 1.0)

    # Steep cliffs (> 40° ramping to > 50°; cliffs > 45° are predominantly rock), suppressing forest & tundra
    cliff = smoothstep(40.0, 50.0, slope_deg)
    # High-alpine talus chutes (> 3450 m & slope > 27°)
    alpine_talus = smoothstep(3450.0, 3780.0, elev) * smoothstep(27.0, 40.0, slope_deg)
    rock_rule = np.maximum(cliff, alpine_talus * 0.85)

    forest = forest * (1.0 - cliff)
    grass = grass * (1.0 - 0.85 * cliff)
    rock = np.maximum(rock, rock_rule)

    # Identify Developed (21..24) and Wetland (90,95) masks so imagery cues don't turn grey roofs into talus
    # or wetland shadows into tall spruce forest
    is_developed = (
        ((nlcd_rgb[:, :, 0] == 221) & (nlcd_rgb[:, :, 1] == 201) & (nlcd_rgb[:, :, 2] == 201))
        | ((nlcd_rgb[:, :, 0] == 216) & (nlcd_rgb[:, :, 1] == 147) & (nlcd_rgb[:, :, 2] == 130))
        | ((nlcd_rgb[:, :, 0] == 237) & (nlcd_rgb[:, :, 1] == 0) & (nlcd_rgb[:, :, 2] == 0))
        | ((nlcd_rgb[:, :, 0] == 170) & (nlcd_rgb[:, :, 1] == 0) & (nlcd_rgb[:, :, 2] == 0))
    ).astype(np.float32)
    is_wetland = (
        ((nlcd_rgb[:, :, 0] == 186) & (nlcd_rgb[:, :, 1] == 216) & (nlcd_rgb[:, :, 2] == 234))
        | ((nlcd_rgb[:, :, 0] == 112) & (nlcd_rgb[:, :, 1] == 163) & (nlcd_rgb[:, :, 2] == 186))
    ).astype(np.float32)

    # Subtle imagery refinement: break up 30m NLCD blocks with real NAIP rock chutes & conifer pockets
    below_treeline = smoothstep(3620.0, 3350.0, elev)
    canopy_allow = (1.0 - cliff) * (1.0 - water) * (1.0 - is_wetland) * (1.0 - is_developed)
    forest = np.clip(forest + 0.18 * is_dark_canopy * below_treeline * canopy_allow, 0.0, 1.0)
    # Neutral bright rock chutes/scree in imagery reduce forest & boost rock (never on town roofs/roads)
    chute_mask = is_grey_talus * smoothstep(24.0, 36.0, slope_deg) * (1.0 - water) * (1.0 - is_developed)
    forest = forest * (1.0 - 0.65 * chute_mask)
    grass = grass * (1.0 - 0.45 * chute_mask)
    rock = np.clip(np.maximum(rock, chute_mask * 0.90), 0.0, 1.0)

    # Water stays clean (suppress forest/rock/grass in open water)
    water = np.clip(water, 0.0, 1.0)
    not_water = 1.0 - water
    forest *= not_water
    rock *= not_water
    grass *= not_water

    # Ensure dark green meadows/aspen aren't zeroed on gentle slopes
    grass = np.clip(grass + 0.08 * is_green_veg * (1.0 - cliff) * not_water * (1.0 - forest * 0.7), 0.0, 1.0)

    rgba = np.stack(
        [
            quantize_4bit(forest),
            quantize_4bit(rock),
            quantize_4bit(water),
            quantize_4bit(grass),
        ],
        axis=-1,
    )
    out_im = Image.fromarray(rgba, mode="RGBA")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    out_im.save(buf, format="PNG", optimize=True)
    png_bytes = buf.getvalue()
    tmp = out_path.with_suffix(".png.tmp")
    tmp.write_bytes(png_bytes)
    tmp.replace(out_path)
    return (z, x, y, len(png_bytes))


def main() -> None:
    parser = argparse.ArgumentParser(description="Build RGBA land cover tiles from NLCD 2021 + DEM + imagery.")
    parser.add_argument("--full-zooms", default="13", help="Comma-separated full-bbox zooms (default: 13)")
    parser.add_argument(
        "--corridor-json",
        type=Path,
        default=None,
        help="Optional JSON mapping zoom -> [[x,y],...] for higher-zoom cover tiles (e.g. z14)",
    )
    parser.add_argument("--workers", type=int, default=4, help="Concurrent workers (be polite to MRLC WMS)")
    parser.add_argument("--overwrite", action="store_true", help="Re-encode existing cover PNGs")
    args = parser.parse_args()

    COVER_OUT.mkdir(parents=True, exist_ok=True)
    by_zoom: dict[int, set[tuple[int, int]]] = {}

    if args.full_zooms.strip():
        for z_str in args.full_zooms.split(","):
            z = int(z_str.strip())
            by_zoom.setdefault(z, set()).update(bbox_tiles(z, BBOX))

    if args.corridor_json is not None:
        data = json.loads(args.corridor_json.read_text(encoding="utf-8"))
        if "cover" in data and isinstance(data["cover"], dict):
            data = data["cover"]
        for k, v in data.items():
            z = int(k)
            by_zoom.setdefault(z, set()).update((int(x), int(y)) for x, y in v)

    tasks = [(z, x, y, args.overwrite) for z in sorted(by_zoom) for (x, y) in sorted(by_zoom[z])]
    print(f"Building {len(tasks)} cover tiles...")
    run_parallel(tasks, process_tile, max_workers=args.workers, desc="cover")

    manifest = build_manifest(
        COVER_OUT,
        ext="png",
        fmt="png-rgba",
        encoding="rgba-cover",
        attribution="MRLC NLCD 2021 Land Cover (public domain) + USGS 3DEP slope/treeline + USGS NAIP cues",
        extra={
            "channels": {
                "R": "forest density (0..255)",
                "G": "bare rock / scree / talus (0..255)",
                "B": "open water (0..255)",
                "A": "alpine tundra / grass / shrub (0..255)",
            },
            "decodeNote": "Decode with premultiplyAlpha: 'none' (A is tundra/grass, not transparency).",
        },
    )
    mb = manifest["totalBytes"] / (1024 * 1024)
    print(f"Wrote {COVER_OUT / 'manifest.json'}: {manifest['tileCount']} tiles, {mb:.2f} MB")


if __name__ == "__main__":
    main()
