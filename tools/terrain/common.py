"""Shared geo, caching, HTTP download, and manifest utilities for Telluride Trails."""

from __future__ import annotations

import json
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Iterable

import requests

# Playable bbox from PLAN.md (lon/lat)
BBOX = (-108.02, 37.68, -107.25, 38.10)  # (west, south, east, north)
# Far-horizon ring (~105-115 km radius around Telluride: Uncompahgre/Wetterhorn, La Platas, Grand Mesa dir, Dolores valley)
HORIZON_BBOX = (-109.05, 36.95, -106.55, 38.90)
ORIGIN = (37.9375, -107.8123)  # (lat0, lon0) Telluride

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "public" / "data"
CACHE_DIR = Path(os.path.expanduser("~/.cache/telluride-trails"))

EARTH_HALF_CIRC_M = 20037508.342789244
USER_AGENT = "TellurideTrailsPipeline/1.0 (https://github.com/nickcoury/telluride-trails)"


def deg2num(lat_deg: float, lon_deg: float, zoom: int) -> tuple[int, int]:
    """Convert WGS84 lat/lon to Web Mercator slippy-map tile (x, y)."""
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return xtile, ytile


def latlon_to_tile_px(lat_deg: float, lon_deg: float, zoom: int, tile_size: int = 256) -> tuple[int, int, int, int]:
    """Convert WGS84 lat/lon to (xt, yt, px, py) within a Web Mercator tile."""
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    x_exact = (lon_deg + 180.0) / 360.0 * n
    y_exact = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    xt = int(math.floor(x_exact))
    yt = int(math.floor(y_exact))
    px = min(tile_size - 1, max(0, int((x_exact - xt) * tile_size)))
    py = min(tile_size - 1, max(0, int((y_exact - yt) * tile_size)))
    return xt, yt, px, py


def tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return EPSG:3857 (minx, miny, maxx, maxy) meters for Web Mercator tile (z, x, y)."""
    n = 2.0 ** z
    tile_span = (2.0 * EARTH_HALF_CIRC_M) / n
    minx = -EARTH_HALF_CIRC_M + x * tile_span
    maxx = minx + tile_span
    maxy = EARTH_HALF_CIRC_M - y * tile_span
    miny = maxy - tile_span
    return minx, miny, maxx, maxy


def tile_bounds_lonlat(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return WGS84 (west, south, east, north) for Web Mercator tile (z, x, y)."""
    n = 2.0 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    return west, south, east, north


def tile_pixel_size_m(z: int, y: int, tile_size: int = 256) -> float:
    """Approximate ground meters per pixel at the tile center latitude."""
    west, south, east, north = tile_bounds_lonlat(z, 0, y)
    lat_mid = 0.5 * (south + north)
    return (2.0 * EARTH_HALF_CIRC_M / (2.0 ** z) / tile_size) * math.cos(math.radians(lat_mid))


def bbox_tile_range(z: int, bbox: tuple[float, float, float, float] = BBOX) -> tuple[int, int, int, int]:
    """Return inclusive (x_min, x_max, y_min, y_max) covering bbox at zoom z."""
    w, s, e, n = bbox
    x_min, y_min = deg2num(n, w, z)
    x_max, y_max = deg2num(s, e, z)
    return x_min, x_max, y_min, y_max


def bbox_tiles(z: int, bbox: tuple[float, float, float, float] = BBOX) -> list[tuple[int, int]]:
    """Return all (x, y) tiles covering bbox at zoom z."""
    x0, x1, y0, y1 = bbox_tile_range(z, bbox)
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


def dilate_tiles(tiles: Iterable[tuple[int, int]], radius: int = 1, clip_bbox: tuple[float, float, float, float] | None = None, zoom: int | None = None) -> set[tuple[int, int]]:
    """Expand a tile set by Chebyshev radius, optionally clipped to bbox at zoom."""
    out: set[tuple[int, int]] = set()
    bounds = bbox_tile_range(zoom, clip_bbox) if (clip_bbox is not None and zoom is not None) else None
    for x, y in tiles:
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                nx, ny = x + dx, y + dy
                if bounds is not None:
                    x0, x1, y0, y1 = bounds
                    if not (x0 <= nx <= x1 and y0 <= ny <= y1):
                        continue
                out.add((nx, ny))
    return out


def fetch_cached(
    url: str,
    cache_path: Path,
    session: requests.Session | None = None,
    timeout: float = 20.0,
    retries: int = 4,
    min_bytes: int = 100,
) -> bytes:
    """Download URL with disk caching and exponential backoff retries."""
    if cache_path.exists() and cache_path.stat().st_size >= min_bytes:
        return cache_path.read_bytes()

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    sess = session or requests.Session()
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            resp = sess.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
            if resp.status_code == 200 and len(resp.content) >= min_bytes:
                tmp = cache_path.with_suffix(cache_path.suffix + ".tmp")
                tmp.write_bytes(resp.content)
                tmp.replace(cache_path)
                return resp.content
            last_err = RuntimeError(f"HTTP {resp.status_code} ({len(resp.content)}B) for {url}")
            if resp.status_code in (404, 400):
                break
        except Exception as exc:
            last_err = exc
        time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError(f"Failed fetching {url}: {last_err}")


def run_parallel(items: list, fn: Callable, max_workers: int = 8, desc: str = "task") -> list:
    """Execute fn(item) in a thread pool and return results, raising on unhandled errors."""
    results = []
    total = len(items)
    if total == 0:
        return results
    done = 0
    errors = 0
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(fn, item): item for item in items}
        for fut in as_completed(futures):
            done += 1
            try:
                res = fut.result()
                results.append(res)
            except Exception as exc:
                errors += 1
                print(f"[{desc}] ERROR on {futures[fut]}: {exc}", flush=True)
            if done % 100 == 0 or done == total:
                print(f"[{desc}] {done}/{total} (errors={errors})", flush=True)
    if errors > 0:
        raise RuntimeError(f"[{desc}] finished with {errors} errors out of {total}")
    return results


def compress_rows_rle(coords: Iterable[tuple[int, int]]) -> tuple[int, int, int, int, dict[str, list[int]]]:
    """Encode (x, y) tiles as inclusive [xStart, xEnd] span pairs per y row."""
    by_y: dict[int, list[int]] = {}
    x_min = 1 << 30
    x_max = -1
    y_min = 1 << 30
    y_max = -1
    for x, y in coords:
        by_y.setdefault(y, []).append(x)
        if x < x_min:
            x_min = x
        if x > x_max:
            x_max = x
        if y < y_min:
            y_min = y
        if y > y_max:
            y_max = y

    rows: dict[str, list[int]] = {}
    for y in sorted(by_y):
        xs = sorted(set(by_y[y]))
        spans: list[int] = []
        s = e = xs[0]
        for x in xs[1:]:
            if x == e + 1:
                e = x
            else:
                spans.extend([s, e])
                s = e = x
        spans.extend([s, e])
        rows[str(y)] = spans
    return x_min, x_max, y_min, y_max, rows


def build_manifest(
    root_dir: Path,
    ext: str,
    fmt: str,
    encoding: str,
    attribution: str,
    extra: dict | None = None,
) -> dict:
    """Scan root_dir/{z}/{x}/{y}.{ext} and write root_dir/manifest.json."""
    by_zoom: dict[int, list[tuple[int, int]]] = {}
    total_bytes = 0
    tile_count = 0
    suffix = f".{ext}"

    for z_dir in sorted(root_dir.iterdir()):
        if not z_dir.is_dir() or not z_dir.name.isdigit():
            continue
        z = int(z_dir.name)
        coords: list[tuple[int, int]] = []
        for x_dir in z_dir.iterdir():
            if not x_dir.is_dir() or not x_dir.name.isdigit():
                continue
            x = int(x_dir.name)
            for f in x_dir.iterdir():
                if f.is_file() and f.name.endswith(suffix):
                    stem = f.name[: -len(suffix)]
                    if stem.isdigit():
                        y = int(stem)
                        coords.append((x, y))
                        total_bytes += f.stat().st_size
                        tile_count += 1
        if coords:
            by_zoom[z] = coords

    zooms = sorted(by_zoom)
    tiles_obj: dict[str, dict] = {}
    for z in zooms:
        coords = by_zoom[z]
        coord_set = set(coords)
        x_min, x_max, y_min, y_max, rows = compress_rows_rle(coords)
        expected_rect = (x_max - x_min + 1) * (y_max - y_min + 1)
        if len(coord_set) == expected_rect:
            tiles_obj[str(z)] = {
                "full": True,
                "count": len(coord_set),
                "xMin": x_min,
                "xMax": x_max,
                "yMin": y_min,
                "yMax": y_max,
            }
        else:
            tiles_obj[str(z)] = {
                "full": False,
                "count": len(coord_set),
                "xMin": x_min,
                "xMax": x_max,
                "yMin": y_min,
                "yMax": y_max,
                "rows": rows,
            }

    manifest = {
        "version": 1,
        "format": fmt,
        "ext": ext,
        "tileSize": 256,
        "padding": 0,
        "encoding": encoding,
        "bounds": {
            "west": BBOX[0],
            "south": BBOX[1],
            "east": BBOX[2],
            "north": BBOX[3],
        },
        "origin": {"lat": ORIGIN[0], "lon": ORIGIN[1]},
        "minZoom": zooms[0] if zooms else 0,
        "maxZoom": zooms[-1] if zooms else 0,
        "tileCount": tile_count,
        "totalBytes": total_bytes,
        "attribution": attribution,
        "tiles": tiles_obj,
    }
    if extra:
        manifest.update(extra)

    out_path = root_dir / "manifest.json"
    out_path.write_text(json.dumps(manifest, separators=(",", ":")) + "\n", encoding="utf-8")
    return manifest
