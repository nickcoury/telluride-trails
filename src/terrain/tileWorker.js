/**
 * Web Worker for off-main-thread fetching and decoding of terrain, imagery, and cover tiles.
 * Decodes Terrarium elevation into Float32Array + raw RGBA bytes, imagery into ImageBitmap,
 * and cover RGBA PNGs without alpha-premultiplication loss via DecompressionStream.
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
  // PNG signature check: 137 80 78 71 13 10 26 10
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
    const type =
      String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
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

  // Channels per pixel in PNG stream
  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 || colorType === 3 ? 1 : 0;
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

async function handleDecode({ id, kind, url }) {
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
      self.postMessage({ id, ok: true, kind, width: bitmap.width, height: bitmap.height, bitmap }, [bitmap]);
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
      // Fallback if cover tile is non-PNG
      const bitmap = await createImageBitmap(new Blob([buf]), {
        colorSpaceConversion: 'none',
        premultiplyAlpha: 'none',
      });
      const { width, height, data } = getOffscreenPixels(bitmap);
      bitmap.close();
      self.postMessage({ id, ok: true, kind, width, height, rgba: data }, [data.buffer]);
      return;
    }

    // kind === 'terrain' (Terrarium RGB: h = R*256 + G + B/256 - 32768, A=255)
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const { width, height, data } = getOffscreenPixels(bitmap);
    bitmap.close();

    const count = width * height;
    const heights = new Float32Array(count);
    let minH = Infinity;
    let maxH = -Infinity;

    for (let i = 0; i < count; i++) {
      const p = i * 4;
      const h = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
      heights[i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }

    self.postMessage(
      { id, ok: true, kind, width, height, heights, rgba: data, minH, maxH },
      [heights.buffer, data.buffer],
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
