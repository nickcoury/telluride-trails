/**
 * Web Worker for off-main-thread fetching and decoding of terrain, imagery, and cover tiles.
 * - Terrain: decodes Terrarium RGB into a vertex-aligned (N+1)x(N+1) height grid (257x257),
 *   lossless Terrarium RGBA for vertex fetch, precomputed RGBA8 Normal+CavityAO+Slope map
 *   (replacing 16 fragment texelFetches with 1 linear texture fetch!), plus 4 raw edge strips
 *   for exact 0.000 m neighbor tile stitching on the main thread.
 * - Imagery: decodes into transferable ImageBitmap.
 * - Cover: decodes 8-bit PNG without alpha-premultiplication loss via DecompressionStream.
 */

const inflight = new Map();

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode an 8-bit non-interlaced PNG without alpha premultiplication.
 * Essential for cover masks where Alpha is tundra/grass weight (can be 0 while RGB > 0).
 */
async function decodePngLosslessRGBA(buffer) {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 33 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idatChunks = [];

  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) break;

    if (type === 'IHDR') {
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataEnd);
    } else if (type === 'tRNS') {
      trns = bytes.subarray(dataStart, dataEnd);
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0 || idatChunks.length === 0) {
    return null;
  }

  const channels =
    colorType === 6
      ? 4
      : colorType === 2
        ? 3
        : colorType === 4
          ? 2
          : colorType === 0 || colorType === 3
            ? 1
            : 0;
  if (!channels) return null;

  const ds = new DecompressionStream('deflate');
  const rawStream = new Blob(idatChunks).stream().pipeThrough(ds);
  const inflated = new Uint8Array(await new Response(rawStream).arrayBuffer());

  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prevRow = new Uint8Array(stride);
  const curRow = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const srcRowStart = y * (stride + 1);
    const filterType = inflated[srcRowStart];
    const rowIn = srcRowStart + 1;

    for (let i = 0; i < stride; i++) {
      const rawByte = inflated[rowIn + i];
      const left = i >= channels ? curRow[i - channels] : 0;
      const up = prevRow[i];
      const upLeft = i >= channels ? prevRow[i - channels] : 0;

      let recon = rawByte;
      if (filterType === 1) recon = (rawByte + left) & 0xff;
      else if (filterType === 2) recon = (rawByte + up) & 0xff;
      else if (filterType === 3) recon = (rawByte + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) recon = (rawByte + paethPredictor(left, up, upLeft)) & 0xff;
      curRow[i] = recon;
    }

    const dstBase = y * width * 4;
    if (colorType === 6) {
      rgba.set(curRow, dstBase);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const s = x * 3;
        const d = dstBase + x * 4;
        rgba[d] = curRow[s];
        rgba[d + 1] = curRow[s + 1];
        rgba[d + 2] = curRow[s + 2];
        rgba[d + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const s = x * 2;
        const d = dstBase + x * 4;
        rgba[d] = curRow[s];
        rgba[d + 1] = curRow[s];
        rgba[d + 2] = curRow[s];
        rgba[d + 3] = curRow[s + 1];
      }
    } else if (colorType === 3 && palette) {
      for (let x = 0; x < width; x++) {
        const idx = curRow[x];
        const p = idx * 3;
        const d = dstBase + x * 4;
        rgba[d] = palette[p] || 0;
        rgba[d + 1] = palette[p + 1] || 0;
        rgba[d + 2] = palette[p + 2] || 0;
        rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    } else {
      for (let x = 0; x < width; x++) {
        const v = curRow[x];
        const d = dstBase + x * 4;
        rgba[d] = v;
        rgba[d + 1] = v;
        rgba[d + 2] = v;
        rgba[d + 3] = 255;
      }
    }

    prevRow.set(curRow);
  }

  return { width, height, rgba };
}

let sharedCanvas = null;
let sharedCtx = null;

function getOffscreenPixels(bitmap) {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const w = bitmap.width;
  const h = bitmap.height;
  if (!sharedCanvas || sharedCanvas.width !== w || sharedCanvas.height !== h) {
    sharedCanvas = new OffscreenCanvas(w, h);
    sharedCtx = sharedCanvas.getContext('2d', { willReadFrequently: true });
  }
  sharedCtx.clearRect(0, 0, w, h);
  sharedCtx.drawImage(bitmap, 0, 0);
  const imgData = sharedCtx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: new Uint8Array(imgData.data.buffer) };
}

function encodeTerrariumPixel(out, p, elevM) {
  const v = Math.max(0, Math.min(65535.996, elevM + 32768.0));
  const r = Math.floor(v / 256.0);
  const rem = v - r * 256.0;
  const g = Math.floor(rem);
  const b = Math.max(0, Math.min(255, Math.round((rem - g) * 256.0)));
  out[p] = r;
  out[p + 1] = g;
  out[p + 2] = b;
  out[p + 3] = 255;
}

/**
 * Convert an area-registered (w x h) Terrarium RGBA buffer into:
 * - Vertex-aligned (w+1) x (h+1) Float32 heights & Terrarium RGBA (0.000m interior shift,
 *   exact shared corners/edges ready for neighbor stitching!)
 * - Precomputed (w+1) x (h+1) RGBA8 world normal + cavity AO + slope map
 * - Raw border strips (edgeW, edgeE, edgeN, edgeS) for exact neighbor midpoint stitching
 */
function buildTerrainPayload(data, w, h, tileWorldSize) {
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    raw[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
  }

  const gw = w + 1;
  const gh = h + 1;
  const heights = new Float32Array(gw * gh);
  const rgba = new Uint8Array(gw * gh * 4);
  let minH = Infinity;
  let maxH = -Infinity;

  // Vertex (gx, gy) sits at exact UV (gx / w, gy / h).
  // Source pixel (ix, iy) sits at ((ix + 0.5) / w, (iy + 0.5) / h).
  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy > 0 ? gy - 1 : 0;
    const y1 = gy < h ? gy : h - 1;
    const row0 = y0 * w;
    const row1 = y1 * w;
    const dstRow = gy * gw;
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx > 0 ? gx - 1 : 0;
      const x1 = gx < w ? gx : w - 1;
      const elev = 0.25 * (raw[row0 + x0] + raw[row0 + x1] + raw[row1 + x0] + raw[row1 + x1]);
      const idx = dstRow + gx;
      heights[idx] = elev;
      if (elev < minH) minH = elev;
      if (elev > maxH) maxH = elev;
      encodeTerrariumPixel(rgba, idx * 4, elev);
    }
  }

  // Raw outer pixel strips (length h or w) for exact cross-tile boundary midpoint stitching
  const edgeW = new Float32Array(h);
  const edgeE = new Float32Array(h);
  const edgeN = new Float32Array(w);
  const edgeS = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    edgeW[y] = raw[y * w];
    edgeE[y] = raw[y * w + (w - 1)];
  }
  for (let x = 0; x < w; x++) {
    edgeN[x] = raw[x];
    edgeS[x] = raw[(h - 1) * w + x];
  }

  // Precompute world-space normal (nx, nz), cavity/ridge AO, and slope into RGBA8
  const normalAoRgba = new Uint8Array(gw * gh * 4);
  const cellM = Math.max(0.25, (tileWorldSize || 1000) / w);
  const inv2Cell = 0.5 / cellM;
  const invCell = 1.0 / cellM;

  for (let gy = 0; gy < gh; gy++) {
    const ym = gy > 0 ? gy - 1 : 0;
    const yp = gy < gh - 1 ? gy + 1 : gh - 1;
    const invDz = gy > 0 && gy < gh - 1 ? inv2Cell : invCell;
    const rowC = gy * gw;
    const rowN = ym * gw;
    const rowS = yp * gw;

    for (let gx = 0; gx < gw; gx++) {
      const xm = gx > 0 ? gx - 1 : 0;
      const xp = gx < gw - 1 ? gx + 1 : gw - 1;
      const invDx = gx > 0 && gx < gw - 1 ? inv2Cell : invCell;

      const hC = heights[rowC + gx];
      const hL = heights[rowC + xm];
      const hR = heights[rowC + xp];
      const hN = heights[rowN + gx];
      const hS = heights[rowS + gx];

      const dX = (hL - hR) * invDx;
      const dZ = (hN - hS) * invDz;
      const invLen = 1.0 / Math.hypot(dX, 1.0, dZ);
      const nx = dX * invLen;
      const ny = invLen;
      const nz = dZ * invLen;

      // Multi-tap cavity / ridge curvature AO: ravines/gullies darken gently, ridges brighten
      const avgNbr = 0.25 * (hL + hR + hN + hS);
      const curvature = (hC - avgNbr) * invCell;
      const ao = Math.max(0.45, Math.min(1.0, 0.80 + curvature * 0.55));
      const slope = Math.max(0, Math.min(1, 1.0 - ny));

      const p = (rowC + gx) * 4;
      normalAoRgba[p] = Math.max(0, Math.min(255, Math.round((nx * 0.5 + 0.5) * 255)));
      normalAoRgba[p + 1] = Math.max(0, Math.min(255, Math.round((nz * 0.5 + 0.5) * 255)));
      normalAoRgba[p + 2] = Math.round(ao * 255);
      normalAoRgba[p + 3] = Math.round(slope * 255);
    }
  }

  return {
    width: gw,
    height: gh,
    srcSize: w,
    heights,
    rgba,
    normalAoRgba,
    edgeW,
    edgeE,
    edgeN,
    edgeS,
    minH,
    maxH,
  };
}

async function handleDecode({ id, kind, url, tileWorldSize }) {
  const ctrl = new AbortController();
  inflight.set(id, ctrl);

  try {
    const res = await fetch(url, { signal: ctrl.signal, mode: 'cors' });
    if (!res.ok) {
      self.postMessage({ id, ok: false, status: res.status });
      return;
    }

    if (kind === 'imagery') {
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      self.postMessage(
        { id, ok: true, kind, width: bitmap.width, height: bitmap.height, bitmap },
        [bitmap],
      );
      return;
    }

    if (kind === 'cover') {
      const buf = await res.arrayBuffer();
      const decoded = await decodePngLosslessRGBA(buf);
      if (decoded) {
        self.postMessage(
          { id, ok: true, kind, width: decoded.width, height: decoded.height, rgba: decoded.rgba },
          [decoded.rgba.buffer],
        );
        return;
      }
      const bitmap = await createImageBitmap(new Blob([buf]), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const px = getOffscreenPixels(bitmap);
      if (!px) {
        self.postMessage(
          {
            id,
            ok: true,
            kind,
            needsMainDecode: true,
            width: bitmap.width,
            height: bitmap.height,
            bitmap,
          },
          [bitmap],
        );
        return;
      }
      const { width, height, data } = px;
      bitmap.close();
      self.postMessage({ id, ok: true, kind, width, height, rgba: data }, [data.buffer]);
      return;
    }

    // kind === 'terrain'
    const buf = await res.arrayBuffer();
    const decodedPng = await decodePngLosslessRGBA(buf);
    let width, height, data;
    if (decodedPng) {
      width = decodedPng.width;
      height = decodedPng.height;
      data = decodedPng.rgba;
    } else {
      const bitmap = await createImageBitmap(new Blob([buf]), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const px = getOffscreenPixels(bitmap);
      if (!px) {
        self.postMessage(
          {
            id,
            ok: true,
            kind,
            needsMainDecode: true,
            width: bitmap.width,
            height: bitmap.height,
            tileWorldSize,
            bitmap,
          },
          [bitmap],
        );
        return;
      }
      width = px.width;
      height = px.height;
      data = px.data;
      bitmap.close();
    }

    const payload = buildTerrainPayload(data, width, height, tileWorldSize);
    self.postMessage(
      { id, ok: true, kind, ...payload },
      [
        payload.heights.buffer,
        payload.rgba.buffer,
        payload.normalAoRgba.buffer,
        payload.edgeW.buffer,
        payload.edgeE.buffer,
        payload.edgeN.buffer,
        payload.edgeS.buffer,
      ],
    );
  } catch (err) {
    if (err && err.name === 'AbortError') {
      self.postMessage({ id, ok: false, aborted: true });
    } else {
      self.postMessage({ id, ok: false, error: String(err) });
    }
  } finally {
    inflight.delete(id);
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.cmd === 'abort') {
    const ctrl = inflight.get(msg.id);
    if (ctrl) ctrl.abort();
    return;
  }
  if (msg.cmd === 'decode') {
    handleDecode(msg);
  }
};
