#!/usr/bin/env python3
"""Fetch USGS National Map orthoimagery tiles, apply global color-balance/dehaze, encode WebP, and write manifest."""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import threading
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    BBOX,
    CACHE_DIR,
    DATA_DIR,
    HORIZON_BBOX,
    bbox_tiles,
    build_manifest,
    deg2num,
    dilate_tiles,
    fetch_cached,
    run_parallel,
    tile_bounds_3857,
)

USGS_IMAGERY_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
USGS_NAIP_EXPORT_URL = (
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"
    "?bbox={minx},{miny},{maxx},{maxy}&bboxSR=3857&imageSR=3857&size={w},{h}&format=jpg&f=image"
)
_NAIP_SEM = threading.Semaphore(2)


def prefetch_naip_blocks(z: int, coords: set[tuple[int, int]], block: int = 4) -> None:
    """Fetch z>=17 NAIP tiles in 4x4 (1024x1024) ImageServer blocks to minimize server requests."""
    missing = [
        (x, y)
        for (x, y) in coords
        if not (IMAGERY_OUT / str(z) / str(x) / f"{y}.webp").exists()
        and not (IMAGERY_CACHE / str(z) / str(x) / f"{y}.jpg").exists()
    ]
    if not missing:
        return
    blocks: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for x, y in missing:
        bx, by = (x // block) * block, (y // block) * block
        blocks.setdefault((bx, by), []).append((x, y))

    print(f"Prefetching {len(missing)} z{z} NAIP tiles in {len(blocks)} {block}x{block} blocks...")
    for idx, ((bx, by), tiles) in enumerate(sorted(blocks.items()), 1):
        minx, _, _, maxy = tile_bounds_3857(z, bx, by)
        _, miny, maxx, _ = tile_bounds_3857(z, bx + block - 1, by + block - 1)
        size = block * 256
        url = USGS_NAIP_EXPORT_URL.format(minx=minx, miny=miny, maxx=maxx, maxy=maxy, w=size, h=size)
        block_cache = IMAGERY_CACHE / f"block_z{z}_{bx}_{by}_{block}.jpg"
        try:
            raw = fetch_cached(url, block_cache, timeout=45.0, retries=6, min_bytes=1000)
        except Exception as exc:
            print(f"[naip-z{z}] WARN block ({bx},{by}) failed ({exc}); skipping z{z} fallback for this block", flush=True)
            continue
        import time
        time.sleep(0.25)
        sheet = Image.open(io.BytesIO(raw)).convert("RGB")
        if sheet.size != (size, size):
            sheet = sheet.resize((size, size), Image.Resampling.LANCZOS)
        for tx, ty in tiles:
            dx, dy = tx - bx, ty - by
            crop = sheet.crop((dx * 256, dy * 256, (dx + 1) * 256, (dy + 1) * 256))
            tp = IMAGERY_CACHE / str(z) / str(tx) / f"{ty}.jpg"
            tp.parent.mkdir(parents=True, exist_ok=True)
            crop.save(tp, format="JPEG", quality=94)
        if idx % 5 == 0 or idx == len(blocks):
            print(f"[naip-z{z}] block {idx}/{len(blocks)}", flush=True)
IMAGERY_OUT = DATA_DIR / "imagery"
IMAGERY_CACHE = CACHE_DIR / "usgs_imagery"

# Global dehaze & white-balance parameters tuned across San Juan NAIP/USGS tiles.
# Applied uniformly per pixel so adjacent tiles never show seams.
BLACK_POINT = np.array([13.0 / 255.0, 16.0 / 255.0, 15.0 / 255.0], dtype=np.float32)
WHITE_POINT = np.array([245.0 / 255.0, 244.0 / 255.0, 239.0 / 255.0], dtype=np.float32)


def color_balance_and_dehaze(im: Image.Image) -> Image.Image:
    """Apply consistent global atmospheric dehaze, white balance, gentle S-curve, and midtone vibrancy."""
    arr = np.asarray(im.convert("RGB"), dtype=np.float32) * (1.0 / 255.0)
    # 1. Global haze floor & white point normalization
    arr = np.clip((arr - BLACK_POINT) / (WHITE_POINT - BLACK_POINT), 0.0, 1.0)
    # 2. Gentle gamma lift for shadowed north-facing timber + subtle S-curve for crispness
    arr = np.power(arr, 0.96, dtype=np.float32)
    smooth = arr * arr * (3.0 - 2.0 * arr)
    arr = arr * 0.88 + smooth * 0.12
    # 3. Subtle midtone-weighted vibrancy (+10% peak at mid luminance; 0 at snow/black)
    lum = (
        arr[:, :, 0:1] * 0.2126
        + arr[:, :, 1:2] * 0.7152
        + arr[:, :, 2:3] * 0.0722
    )
    mid_weight = 1.0 - np.abs(2.0 * lum - 1.0)
    sat_boost = 1.0 + 0.10 * mid_weight
    arr = np.clip(lum + (arr - lum) * sat_boost, 0.0, 1.0)
    out = np.rint(arr * 255.0).astype(np.uint8)
    return Image.fromarray(out, mode="RGB")


def process_tile(task: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    """Download one USGS imagery tile (note z/y/x URL order), balance, and save WebP."""
    z, x, y, quality = task
    out_path = IMAGERY_OUT / str(z) / str(x) / f"{y}.webp"
    if out_path.exists() and out_path.stat().st_size > 200:
        return (z, x, y, out_path.stat().st_size)

    cache_path = IMAGERY_CACHE / str(z) / str(x) / f"{y}.jpg"
    if z <= 16:
        url = USGS_IMAGERY_URL.format(z=z, y=y, x=x)
        raw_bytes = fetch_cached(url, cache_path, min_bytes=500)
    else:
        minx, miny, maxx, maxy = tile_bounds_3857(z, x, y)
        url = USGS_NAIP_EXPORT_URL.format(minx=minx, miny=miny, maxx=maxx, maxy=maxy, w=256, h=256)
        with _NAIP_SEM:
            raw_bytes = fetch_cached(url, cache_path, timeout=30.0, min_bytes=500)
    im = Image.open(io.BytesIO(raw_bytes))
    if im.size != (256, 256):
        im = im.resize((256, 256), Image.Resampling.LANCZOS)
    balanced = color_balance_and_dehaze(im)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    balanced.save(buf, format="WEBP", quality=quality, method=4)
    webp_bytes = buf.getvalue()

    tmp = out_path.with_suffix(".webp.tmp")
    tmp.write_bytes(webp_bytes)
    tmp.replace(out_path)
    return (z, x, y, len(webp_bytes))


def telluride_seed_tiles(include_z17: bool = False) -> dict[int, set[tuple[int, int]]]:
    """Seed high-zoom imagery around Telluride box canyon, gondola, Bridal Veil, and Sneffels."""
    seed_boxes = {
        15: [(-107.88, 37.89, -107.72, 37.98)],
        16: [(-107.86, 37.90, -107.74, 37.96)],
    }
    if include_z17:
        seed_boxes[17] = [(-107.835, 37.926, -107.790, 37.944)]
    out: dict[int, set[tuple[int, int]]] = {}
    for z, boxes in seed_boxes.items():
        s: set[tuple[int, int]] = set()
        for w, so, e, n in boxes:
            s.update(bbox_tiles(z, (w, so, e, n)))
        out[z] = s
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch & color-balance USGS National Map orthoimagery.")
    parser.add_argument(
        "--full-zooms",
        default="8,9,10,11,12,13",
        help="Comma-separated zoom levels to fetch for full bbox (default: 8,9,10,11,12,13)",
    )
    parser.add_argument(
        "--horizon-zooms",
        default="",
        help="Comma-separated coarse zooms for ~100km non-playable horizon ring (e.g. 8,9,10)",
    )
    parser.add_argument(
        "--telluride-seed",
        action="store_true",
        help="Include Telluride/gondola/Bridal Veil seed tiles at z15-z16",
    )
    parser.add_argument(
        "--include-z17",
        action="store_true",
        help="Also fetch z17 NAIP tiles around Telluride town/gondola",
    )
    parser.add_argument(
        "--corridor-json",
        type=Path,
        default=None,
        help="Optional JSON mapping zoom -> [[x,y],...] for corridor zooms (e.g. z15, z16, z17)",
    )
    parser.add_argument("--quality", type=int, default=81, help="WebP quality (default: 81)")
    parser.add_argument("--max-zoom", type=int, default=17, help="Maximum zoom level to process (default: 17)")
    parser.add_argument("--workers", type=int, default=8, help="Concurrent download/encode workers")
    args = parser.parse_args()

    IMAGERY_OUT.mkdir(parents=True, exist_ok=True)
    by_zoom: dict[int, set[tuple[int, int]]] = {}

    if args.full_zooms.strip():
        for z_str in args.full_zooms.split(","):
            z = int(z_str.strip())
            by_zoom.setdefault(z, set()).update(bbox_tiles(z, BBOX))

    horizon_zooms: list[int] = []
    if args.horizon_zooms.strip():
        for z_str in args.horizon_zooms.split(","):
            z = int(z_str.strip())
            horizon_zooms.append(z)
            by_zoom.setdefault(z, set()).update(bbox_tiles(z, HORIZON_BBOX))

    if args.telluride_seed:
        for z, coords in telluride_seed_tiles(include_z17=args.include_z17).items():
            by_zoom.setdefault(z, set()).update(coords)

    if args.corridor_json is not None:
        data = json.loads(args.corridor_json.read_text(encoding="utf-8"))
        if "imagery" in data and isinstance(data["imagery"], dict):
            data = data["imagery"]
        for k, v in data.items():
            z = int(k)
            by_zoom.setdefault(z, set()).update((int(x), int(y)) for x, y in v)

    by_zoom = {z: coords for z, coords in by_zoom.items() if z <= args.max_zoom}
    for z, coords in sorted(by_zoom.items()):
        if z >= 17:
            prefetch_naip_blocks(z, coords, block=2)
            # Only keep z>=17 tiles that were successfully cached (avoid single-tile ImageServer spam)
            by_zoom[z] = {
                (x, y)
                for (x, y) in coords
                if (IMAGERY_OUT / str(z) / str(x) / f"{y}.webp").exists()
                or (IMAGERY_CACHE / str(z) / str(x) / f"{y}.jpg").exists()
            }

    tasks = [(z, x, y, args.quality) for z in sorted(by_zoom) for (x, y) in sorted(by_zoom[z])]
    print(f"Processing {len(tasks)} imagery tiles...")
    run_parallel(tasks, process_tile, max_workers=args.workers, desc="imagery")

    extra_meta = {"quality": args.quality, "colorBalanced": True}
    if horizon_zooms:
        extra_meta["horizon"] = {
            "bounds": {
                "west": HORIZON_BBOX[0],
                "south": HORIZON_BBOX[1],
                "east": HORIZON_BBOX[2],
                "north": HORIZON_BBOX[3],
            },
            "minZoom": min(horizon_zooms),
            "maxZoom": max(horizon_zooms),
            "playable": False,
            "radiusKm": 110,
        }

    manifest = build_manifest(
        IMAGERY_OUT,
        ext="webp",
        fmt="webp",
        encoding="srgb",
        attribution="USGS National Map Orthoimagery (USGSImageryOnly / NAIP, public domain)",
        extra=extra_meta,
    )
    mb = manifest["totalBytes"] / (1024 * 1024)
    print(f"Wrote {IMAGERY_OUT / 'manifest.json'}: {manifest['tileCount']} tiles, {mb:.2f} MB")


if __name__ == "__main__":
    main()
