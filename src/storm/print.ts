/**
 * The dry handprint as a keepsake (direccion/canon.md §6, §9). PURE module.
 *
 * During the storm the wet map counts, per texel, how long a hand kept the
 * rain off. The print is every texel sheltered for at least half of the
 * longest shelter (min 0.8 s): exactly where your hand stood, not where the
 * rain happened to miss. It is cropped to its bounding box (≤ 0.22 × 0.22 m),
 * fitted into PRINT_W × PRINT_H bits keeping the aspect, and saved as a
 * run-length string (≤ 400 B) for today's page.
 */

export const PRINT_W = 64;
export const PRINT_H = 48;
/** Largest print kept (m): a hand plus a little forearm. */
const MAX_EXTENT_M = 0.22;

export interface Print {
  readonly bits: Uint8Array;
  /** Covered texels in the source map (0 = no print). */
  readonly area: number;
}

/**
 * `shelter`: seconds covered per texel (cols × rows, `texel` m each).
 * Returns null when nothing was sheltered long enough to read as a hand.
 */
export function extractPrint(shelter: Float32Array, cols: number, rows: number, texel: number): Print | null {
  let max = 0;
  for (let k = 0; k < shelter.length; k++) if (shelter[k] > max) max = shelter[k];
  const threshold = Math.max(0.8, max * 0.5);
  if (max < threshold) return null;
  let i0 = cols;
  let j0 = rows;
  let i1 = -1;
  let j1 = -1;
  let area = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (shelter[j * cols + i] < threshold) continue;
      area++;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  // Fewer than ~20 cm² is a fingertip, not a print.
  if (area * texel * texel < 0.002) return null;
  // Clamp the box around its centre to the largest print kept.
  const maxT = Math.round(MAX_EXTENT_M / texel);
  const clampSpan = (a: number, b: number): [number, number] => {
    if (b - a + 1 <= maxT) return [a, b];
    const c = (a + b) >> 1;
    return [c - (maxT >> 1), c - (maxT >> 1) + maxT - 1];
  };
  [i0, i1] = clampSpan(i0, i1);
  [j0, j1] = clampSpan(j0, j1);
  const bw = i1 - i0 + 1;
  const bh = j1 - j0 + 1;
  // Fit, keep the aspect, centre.
  const s = Math.max(bw / PRINT_W, bh / PRINT_H);
  const ox = (PRINT_W - bw / s) / 2;
  const oy = (PRINT_H - bh / s) / 2;
  const bits = new Uint8Array(PRINT_W * PRINT_H);
  for (let y = 0; y < PRINT_H; y++) {
    for (let x = 0; x < PRINT_W; x++) {
      const si = Math.floor(i0 + (x + 0.5 - ox) * s);
      const sj = Math.floor(j0 + (y + 0.5 - oy) * s);
      if (si < i0 || si > i1 || sj < j0 || sj > j1) continue;
      if (shelter[sj * cols + si] >= threshold) bits[y * PRINT_W + x] = 1;
    }
  }
  return { bits, area };
}

/** Run lengths (starting with a run of 0s), each as a base-64 varint digit group. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodePrint(bits: Uint8Array): string {
  let out = '';
  let value = 0;
  let run = 0;
  const flush = (n: number): void => {
    // Little-endian 5-bit groups; bit 5 set = more groups follow.
    do {
      const g = n & 31;
      n >>>= 5;
      out += B64[g | (n > 0 ? 32 : 0)];
    } while (n > 0);
  };
  for (let k = 0; k < bits.length; k++) {
    const b = bits[k] ? 1 : 0;
    if (b === value) run++;
    else {
      flush(run);
      value = b;
      run = 1;
    }
  }
  flush(run);
  return out;
}

export function decodePrint(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2000) return null;
  const bits = new Uint8Array(PRINT_W * PRINT_H);
  let k = 0;
  let value = 0;
  let n = 0;
  let shift = 0;
  for (let c = 0; c < s.length; c++) {
    const d = B64.indexOf(s[c]!);
    if (d < 0) return null;
    n |= (d & 31) << shift;
    if (d & 32) {
      shift += 5;
      if (shift > 25) return null;
      continue;
    }
    if (k + n > bits.length) return null;
    if (value) bits.fill(1, k, k + n);
    k += n;
    value ^= 1;
    n = 0;
    shift = 0;
  }
  return k === bits.length ? bits : null;
}

/** SVG path data, one `h` run per row segment, in bit units (viewBox 0 0 PRINT_W PRINT_H). */
export function printPath(bits: Uint8Array): string {
  let d = '';
  for (let y = 0; y < PRINT_H; y++) {
    let x = 0;
    while (x < PRINT_W) {
      if (!bits[y * PRINT_W + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < PRINT_W && bits[y * PRINT_W + x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  return d;
}
