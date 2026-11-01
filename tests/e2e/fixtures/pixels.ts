import { inflateSync } from 'node:zlib';

/**
 * Pixel checks on Playwright screenshots (what the emulator actually drew),
 * so the E2E specs prove visibility instead of trusting debug counters.
 * Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced (Chromium screenshots).
 */

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

export interface PixelStats {
  count: number;
  /** Bounding box of the matching pixels (null when count = 0). */
  box: { minX: number; minY: number; maxX: number; maxY: number; cx: number; cy: number } | null;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Buffer): Image {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('decodePng: not a PNG');
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const chunk = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      depth = chunk[8]!;
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`decodePng: unsupported PNG (depth ${depth}, color type ${colorType}, interlace ${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0, p = 0; y < height; y++) {
    const filter = raw[p++]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      const v = raw[p + x]!;
      cur[x] =
        (filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c)) & 0xff;
    }
    p += stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = cur[x * bpp]!;
      data[o + 1] = cur[x * bpp + 1]!;
      data[o + 2] = cur[x * bpp + 2]!;
      data[o + 3] = bpp === 4 ? cur[x * bpp + 3]! : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data };
}

export function countPixels(img: Image, match: (r: number, g: number, b: number) => boolean): PixelStats {
  let count = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (!match(data[o]!, data[o + 1]!, data[o + 2]!)) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    count,
    box: count ? { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 } : null,
  };
}

/** Saturated warm inks (ochre, vermilion, kraft): leaves, seals, the tab end. Not cream paper, hands or indigo. */
export const isWarmInk = (r: number, g: number, b: number): boolean => r - b > 50 && r - b > 0.3 * r && r >= g;

/** Dark ink (indigo band and rules of the box lid, the reticle). */
export const isDarkInk = (r: number, g: number, b: number): boolean => 0.299 * r + 0.587 * g + 0.114 * b < 110;
