#!/usr/bin/env python3
"""Reproducible end-to-end raster data pipeline for Telluride Trails."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORRIDOR = HERE / "corridor_tiles.json"


def run_step(args: list[str]) -> None:
    print(f"\n=== Running: {' '.join(args)} ===", flush=True)
    subprocess.run([sys.executable, *args], check=True)


def main() -> None:
    run_step([str(HERE / "build_corridor.py"), "--out", str(CORRIDOR)])
    run_step([
        str(HERE / "fetch_elevation.py"),
        "--full-zooms", "8,9,10,11,12,13,14",
        "--horizon-zooms", "8,9,10",
        "--corridor-json", str(CORRIDOR),
        "--workers", "12",
    ])
    run_step([
        str(HERE / "fetch_imagery.py"),
        "--full-zooms", "8,9,10,11,12,13,14",
        "--horizon-zooms", "8,9,10",
        "--corridor-json", str(CORRIDOR),
        "--quality", "79",
        "--workers", "10",
    ])
    run_step([
        str(HERE / "build_cover.py"),
        "--full-zooms", "13",
        "--corridor-json", str(CORRIDOR),
        "--workers", "6",
    ])
    run_step([str(HERE / "build_overview.py")])
    run_step([str(HERE / "verify_data.py")])


if __name__ == "__main__":
    main()
