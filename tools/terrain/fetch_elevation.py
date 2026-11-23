#!/usr/bin/env python3
"""Fetch AWS Terrarium elevation tiles, repack as lossless WebP, validate peaks, and write manifest."""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (
    BBOX,
    CACHE_DIR,
    DATA_DIR,
    HORIZON_BBOX,
    bbox_tiles,
    build_manifest,
    fetch_cached,
    latlon_to_tile_px,
    run_parallel,
)

TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRAIN_OUT = DATA_DIR / "terrain"
TERRAIN_CACHE = CACHE_DIR / "terrarium"

VALIDATION_POINTS = [
    ("Telluride Town", 37.9375, -107.8123, 8750, 150, "exact"),
    ("Mt Sneffels", 38.0036, -107.7923, 14150, 120, "max300m"),
    ("Handies Peak", 37.9130, -107.5044, 14048, 120, "max300m"),
    ("Imogene Pass", 37.9325, -107.7358, 13114, 150, "exact"),
    ("Ouray Town", 38.0228, -107.6714, 7792, 150, "exact"),
    ("Silverton Town", 37.8119, -107.6645, 9305, 150, "exact"),
]


def decode_terrarium_rgb(arr: np.ndarray) -> np.ndarray:
    """Convert uint8 RGB Terrarium array to elevation in meters (float64)."""
    a = arr.astype(np.float64)
    return a[:, :, 0] * 256.0 + a[:, :, 1] + a[:, :, 2] / 256.0 - 32768.0


def process_tile(task: tuple[int, int, int, bool]) -> tuple[int, int, int, int]:
    """Download one Terrarium PNG, convert to lossless WebP, and optionally verify pixel exactness."""
    z, x, y, verify = task
    out_path = TERRAIN_OUT / str(z) / str(x) / f"{y}.webp"
    if out_path.exists() and out_path.stat().st_size > 100:
        return (z, x, y, out_path.stat().st_size)

    cache_path = TERRAIN_CACHE / str(z) / str(x) / f"{y}.png"
    raw_bytes = fetch_cached(TERRARIUM_URL.format(z=z, x=x, y=y), cache_path)
    im = Image.open(io.BytesIO(raw_bytes)).convert("RGB")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    im.save(buf, format="WEBP", lossless=True, method=4)
    webp_bytes = buf.getvalue()

    if verify:
        im_dec = Image.open(io.BytesIO(webp_bytes)).convert("RGB")
        if not np.array_equal(np.asarray(im), np.asarray(im_dec)):
            raise ValueError(f"Lossless WebP round-trip mismatch at {z}/{x}/{y}")

    tmp = out_path.with_suffix(".webp.tmp")
    tmp.write_bytes(webp_bytes)
    tmp.replace(out_path)
    return (z, x, y, len(webp_bytes))


def validate_elevations(max_zoom_to_check: int = 14) -> None:
    """Check known San Juan elevations against generated terrain tiles."""
    print("\n--- Elevation Validation ---")
    for name, lat, lon, expected_ft, tol_ft, mode in VALIDATION_POINTS:
        chosen_z = None
        chosen_path = None
        for z in range(max_zoom_to_check, 7, -1):
            xt, yt, px, py = latlon_to_tile_px(lat, lon, z)
            p = TERRAIN_OUT / str(z) / str(xt) / f"{yt}.webp"
            if p.exists():
                chosen_z, chosen_path = z, p
                break
        if chosen_path is None:
            print(f"  {name:16s}: MISSING tile")
            continue
        xt, yt, px, py = latlon_to_tile_px(lat, lon, chosen_z)
        elev_m = decode_terrarium_rgb(np.asarray(Image.open(chosen_path).convert("RGB")))
        if mode == "max300m":
            # Sample local neighborhood (~+/- 12 pixels at z13, ~+/- 24 at z14) around summit
            r = 12 if chosen_z <= 13 else 24
            y0, y1 = max(0, py - r), min(256, py + r + 1)
            x0, x1 = max(0, px - r), min(256, px + r + 1)
            val_m = float(elev_m[y0:y1, x0:x1].max())
        else:
            val_m = float(elev_m[py, px])
        val_ft = val_m * 3.28084
        diff_ft = val_ft - expected_ft
        status = "OK" if abs(diff_ft) <= tol_ft else "WARN"
        print(
            f"  {name:16s} (z{chosen_z}): {val_m:7.1f} m / {val_ft:7.0f} ft "
            f"(expected ~{expected_ft} ft, diff {diff_ft:+.0f} ft) [{status}]"
        )


def load_tile_list(path: Path) -> dict[int, list[tuple[int, int]]]:
    """Load JSON corridor tile list { '14': [[x,y], ...], ... } or { 'terrain': { '14': ... } }."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if "terrain" in data and isinstance(data["terrain"], dict):
        data = data["terrain"]
    out: dict[int, list[tuple[int, int]]] = {}
    for k, v in data.items():
        z = int(k)
        out[z] = [(int(x), int(y)) for x, y in v]
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch & repack AWS Terrarium elevation tiles.")
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
        "--corridor-json",
        type=Path,
        default=None,
        help="Optional JSON mapping zoom -> [[x,y],...] for partial corridor zooms (e.g. z14, z15)",
    )
    parser.add_argument("--workers", type=int, default=10, help="Concurrent download/encode workers")
    parser.add_argument("--verify", action="store_true", help="Verify lossless WebP round-trip on every new tile")
    args = parser.parse_args()

    TERRAIN_OUT.mkdir(parents=True, exist_ok=True)
    task_set: set[tuple[int, int, int]] = set()

    if args.full_zooms.strip():
        for z_str in args.full_zooms.split(","):
            z = int(z_str.strip())
            for x, y in bbox_tiles(z, BBOX):
                task_set.add((z, x, y))

    horizon_zooms: list[int] = []
    if args.horizon_zooms.strip():
        for z_str in args.horizon_zooms.split(","):
            z = int(z_str.strip())
            horizon_zooms.append(z)
            for x, y in bbox_tiles(z, HORIZON_BBOX):
                task_set.add((z, x, y))

    if args.corridor_json is not None:
        corridor = load_tile_list(args.corridor_json)
        for z, coords in sorted(corridor.items()):
            for x, y in coords:
                task_set.add((z, x, y))

    tasks = [(z, x, y, args.verify) for (z, x, y) in sorted(task_set)]
    print(f"Processing {len(tasks)} terrain tiles...")
    run_parallel(tasks, process_tile, max_workers=args.workers, desc="terrain")

    extra_meta = {
        "encodingFormula": "elevationMeters = R * 256 + G + B / 256 - 32768",
        "elevationRangeM": {"min": 1800, "max": 4400},
    }
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
        TERRAIN_OUT,
        ext="webp",
        fmt="webp-lossless",
        encoding="terrarium",
        attribution="USGS 3DEP via AWS Terrain Tiles (Mapzen Terrarium)",
        extra=extra_meta,
    )
    mb = manifest["totalBytes"] / (1024 * 1024)
    print(f"Wrote {TERRAIN_OUT / 'manifest.json'}: {manifest['tileCount']} tiles, {mb:.2f} MB")
    validate_elevations(max_zoom_to_check=manifest["maxZoom"] or 14)


if __name__ == "__main__":
    main()
