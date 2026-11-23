"""
Terrarium elevation sampler for Telluride Trails vector pipeline.
Checks repo public/data/terrain first, then ~/.cache/telluride-trails/terrarium,
fetching missing tiles from AWS elevation-tiles-prod.
"""

import io
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
import requests
from PIL import Image

from geo import lon_lat_to_tile_frac, world_to_lon_lat

REPO_ROOT = Path(__file__).resolve().parents[2]
REPO_TERRAIN_DIR = REPO_ROOT / "public" / "data" / "terrain"
CACHE_TERRAIN_DIR = Path(os.path.expanduser("~/.cache/telluride-trails/terrarium"))
AWS_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
USER_AGENT = "TellurideTrailsDataBuilder/1.0 (https://github.com/nickcoury/telluride-trails)"


def decode_terrarium(r: int, g: int, b: int) -> float:
    return r * 256.0 + g + b / 256.0 - 32768.0


class TerrariumSampler:
    def __init__(self, zoom: int = 14, max_workers: int = 8):
        self.zoom = zoom
        self.max_workers = max_workers
        self._tiles: dict[tuple[int, int, int], bytes | None] = {}
        self._images: dict[tuple[int, int, int], tuple[int, int, bytes] | None] = {}
        self._lock = threading.Lock()
        self._session = requests.Session()
        self._session.headers.update({"User-Agent": USER_AGENT})
        CACHE_TERRAIN_DIR.mkdir(parents=True, exist_ok=True)

    def _load_tile_pixels(self, z: int, tx: int, ty: int):
        key = (z, tx, ty)
        with self._lock:
            if key in self._images:
                return self._images[key]

        # Check repo public/data/terrain first (.webp or .png), then local cache
        img = None
        for base_dir in (REPO_TERRAIN_DIR, CACHE_TERRAIN_DIR):
            for ext in ("webp", "png"):
                p = base_dir / str(z) / str(tx) / f"{ty}.{ext}"
                if p.exists() and p.stat().st_size > 100:
                    try:
                        img = Image.open(p).convert("RGB")
                        break
                    except Exception:
                        img = None
            if img is not None:
                break

        if img is None:
            cache_p = CACHE_TERRAIN_DIR / str(z) / str(tx) / f"{ty}.png"
            cache_p.parent.mkdir(parents=True, exist_ok=True)
            url = AWS_URL.format(z=z, x=tx, y=ty)
            for attempt in range(3):
                try:
                    resp = self._session.get(url, timeout=20)
                    if resp.status_code == 200 and len(resp.content) > 100:
                        cache_p.write_bytes(resp.content)
                        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
                        break
                except Exception:
                    pass

        val = (img.width, img.height, img.tobytes()) if img is not None else None
        with self._lock:
            self._images[key] = val
        return val

    def prefetch_tiles(self, tiles: set[tuple[int, int, int]]):
        missing = []
        for key in tiles:
            z, tx, ty = key
            if key in self._images:
                continue
            found = False
            for base_dir in (REPO_TERRAIN_DIR, CACHE_TERRAIN_DIR):
                for ext in ("webp", "png"):
                    p = base_dir / str(z) / str(tx) / f"{ty}.{ext}"
                    if p.exists() and p.stat().st_size > 100:
                        found = True
                        break
                if found:
                    break
            if not found:
                missing.append(key)

        if not missing:
            return

        print(f"Prefetching {len(missing)} Terrarium tiles (z={self.zoom})...")
        with ThreadPoolExecutor(max_workers=self.max_workers) as ex:
            list(ex.map(lambda k: self._load_tile_pixels(*k), missing))

    def prefetch_lon_lats(self, pts: list[tuple[float, float]]):
        tiles = set()
        z = self.zoom
        n = 1 << z
        for lon, lat in pts:
            fx, fy = lon_lat_to_tile_frac(lon, lat, z)
            tx = max(0, min(n - 1, int(fx)))
            ty = max(0, min(n - 1, int(fy)))
            tiles.add((z, tx, ty))
        self.prefetch_tiles(tiles)

    def sample_lon_lat(self, lon: float, lat: float) -> float:
        z = self.zoom
        n = 1 << z
        fx, fy = lon_lat_to_tile_frac(lon, lat, z)
        tx = max(0, min(n - 1, int(fx)))
        ty = max(0, min(n - 1, int(fy)))

        tile = self._load_tile_pixels(z, tx, ty)
        if tile is None and z > 13:
            # Fallback to z13
            fx13, fy13 = lon_lat_to_tile_frac(lon, lat, 13)
            tx13 = max(0, min((1 << 13) - 1, int(fx13)))
            ty13 = max(0, min((1 << 13) - 1, int(fy13)))
            tile = self._load_tile_pixels(13, tx13, ty13)
            if tile is None:
                return 2667.0
            fx, fy = fx13, fy13
            tx, ty = tx13, ty13
        elif tile is None:
            return 2667.0

        w, h, buf = tile
        px = (fx - tx) * w - 0.5
        py = (fy - ty) * h - 0.5
        x0 = max(0, min(w - 1, int(px)))
        y0 = max(0, min(h - 1, int(py)))
        x1 = min(w - 1, x0 + 1)
        y1 = min(h - 1, y0 + 1)
        dx = max(0.0, min(1.0, px - x0))
        dy = max(0.0, min(1.0, py - y0))

        def elev(ix: int, iy: int) -> float:
            idx = (iy * w + ix) * 3
            return decode_terrarium(buf[idx], buf[idx + 1], buf[idx + 2])

        e00 = elev(x0, y0)
        e10 = elev(x1, y0)
        e01 = elev(x0, y1)
        e11 = elev(x1, y1)
        e0 = e00 * (1.0 - dx) + e10 * dx
        e1 = e01 * (1.0 - dx) + e11 * dx
        return round(e0 * (1.0 - dy) + e1 * dy, 2)

    def sample_world(self, x: float, z: float) -> float:
        lon, lat = world_to_lon_lat(x, z)
        return self.sample_lon_lat(lon, lat)
