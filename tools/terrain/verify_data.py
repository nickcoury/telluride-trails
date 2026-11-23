#!/usr/bin/env python3
"""Verify manifests, tile integrity, size budgets, elevations, and cover classification."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA_DIR, latlon_to_tile_px

MAX_FILE_BYTES = 50 * 1024 * 1024
BUDGET_MB = 450.0


def expand_manifest_tiles(z_info: dict) -> set[tuple[int, int]]:
    out: set[tuple[int, int]] = set()
    if z_info["full"]:
        for y in range(z_info["yMin"], z_info["yMax"] + 1):
            for x in range(z_info["xMin"], z_info["xMax"] + 1):
                out.add((x, y))
    else:
        for y_str, spans in z_info["rows"].items():
            y = int(y_str)
            for i in range(0, len(spans), 2):
                for x in range(spans[i], spans[i + 1] + 1):
                    out.add((x, y))
    return out


def verify_layer(name: str) -> tuple[int, int]:
    root = DATA_DIR / name
    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing {manifest_path}")
    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    ext = m["ext"]

    total_bytes = 0
    total_count = 0
    print(f"\n=== Layer: {name} ({m['format']}, ext=.{ext}) ===")
    for z_str, z_info in sorted(m["tiles"].items(), key=lambda kv: int(kv[0])):
        z = int(z_str)
        expected = expand_manifest_tiles(z_info)
        if len(expected) != z_info["count"]:
            raise AssertionError(f"{name} z{z}: count mismatch {len(expected)} != {z_info['count']}")
        sizes = []
        for x, y in expected:
            p = root / z_str / str(x) / f"{y}.{ext}"
            if not p.exists():
                raise FileNotFoundError(f"Missing tile listed in manifest: {p}")
            sz = p.stat().st_size
            if sz <= 0 or sz > MAX_FILE_BYTES:
                raise AssertionError(f"Invalid size {sz} on {p}")
            sizes.append(sz)
        arr_sz = np.array(sizes, dtype=np.int64)
        z_mb = arr_sz.sum() / (1024 * 1024)
        print(
            f"  z{z:2d}: {len(sizes):4d} tiles | {z_mb:6.2f} MB | "
            f"p50={np.median(arr_sz)/1024:5.1f}KB p95={np.percentile(arr_sz,95)/1024:5.1f}KB max={arr_sz.max()/1024:5.1f}KB"
        )
        total_bytes += int(arr_sz.sum())
        total_count += len(sizes)

    if total_count != m["tileCount"]:
        raise AssertionError(f"{name}: tileCount {total_count} != {m['tileCount']}")
    if total_bytes != m["totalBytes"]:
        raise AssertionError(f"{name}: totalBytes {total_bytes} != {m['totalBytes']}")
    print(f"  TOTAL: {total_count} tiles, {total_bytes / (1024 * 1024):.2f} MB")
    return total_count, total_bytes


def verify_cover_biomes() -> None:
    print("\n=== Cover Biome Sanity Checks ===")
    checks = [
        ("Telluride Town", 37.9375, -107.8123),
        ("Bear Creek Forest", 37.9180, -107.8000),
        ("Mt Sneffels Alpine", 38.0036, -107.7923),
        ("Imogene Pass Tundra/Rock", 37.9325, -107.7358),
        ("Blue Lake Water", 38.0005, -107.8077),
    ]
    for label, lat, lon in checks:
        p = None
        chosen_z = None
        for z in (14, 13):
            xt, yt, px, py = latlon_to_tile_px(lat, lon, z)
            cand = DATA_DIR / "cover" / str(z) / str(xt) / f"{yt}.png"
            if cand.exists():
                p, chosen_z = cand, z
                break
        if p is None:
            print(f"  {label:26s}: no cover tile")
            continue
        xt, yt, px, py = latlon_to_tile_px(lat, lon, chosen_z)
        arr = np.asarray(Image.open(p).convert("RGBA"))
        y0, y1 = max(0, py - 3), min(256, py + 4)
        x0, x1 = max(0, px - 3), min(256, px + 4)
        patch = arr[y0:y1, x0:x1].mean(axis=(0, 1)) / 255.0
        mx = arr[y0:y1, x0:x1].max(axis=(0, 1)) / 255.0
        print(
            f"  {label:26s} (z{chosen_z}): mean R(for)={patch[0]:.2f} G(rock)={patch[1]:.2f} "
            f"B(wat)={patch[2]:.2f} A(grass)={patch[3]:.2f} | maxwat={mx[2]:.2f}"
        )


def main() -> None:
    grand_bytes = 0
    grand_tiles = 0
    for layer in ("terrain", "imagery", "cover"):
        cnt, b = verify_layer(layer)
        grand_tiles += cnt
        grand_bytes += b

    grand_mb = grand_bytes / (1024 * 1024)
    print(f"\n=== RASTER TOTAL: {grand_tiles} tiles, {grand_mb:.2f} MB (budget <= {BUDGET_MB:.0f} MB) ===")
    if grand_mb > BUDGET_MB:
        raise AssertionError(f"Exceeded raster size budget: {grand_mb:.2f} MB > {BUDGET_MB:.0f} MB")

    # Import elevation validation
    from fetch_elevation import validate_elevations
    validate_elevations(15)
    verify_cover_biomes()


if __name__ == "__main__":
    main()
