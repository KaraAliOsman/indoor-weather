/**
 * Wet map of the table under the storm (direccion/canon.md §6). PURE module.
 *
 * 200 × 120 texels over 0.50 × 0.30 m (2.5 mm/texel), box frame, centred on
 * the kite. Two channels, stored as bytes so the view can upload them as an
 * RG8 DataTexture without conversion:
 *   R = shine of the rain falling right now. It fills drop by drop: each
 *       step a texel in the rain is hit with probability ≈ 0.45·Δt·w, so a
 *       lifted hand's print fills in speckles over 5–6 s (canon §6). Under a
 *       hand it fades in ~0.5 s; with no rain it fades with τ 2.5 s.
 *   G = soaked (+0.08/s × density while it rains on the texel, dries −0.02/s,
 *       ×3 at dawn).
 * Wherever the HandField blocks the rain (blockY > table) neither channel can
 * rise, so a hand held over the table leaves a dry silhouette on the
 * glistening wood.
 *
 * The CPU updates at 15 Hz (the view uploads after each step). Only the
 * texels that can change are visited: everything when it rains, nothing
 * when it is dry and settled.
 */
import { rasterizeCover, type HandField } from './hand-field.ts';

export const WET = {
  cols: 200,
  rows: 120,
  /** Map extent (m) and centre (box frame XZ). */
  sizeM: [0.5, 0.3] as readonly [number, number],
  /** Rain shine fade with no rain (s), and under a sheltering hand (s). */
  tauShineS: 2.5,
  tauCoveredS: 0.5,
  /** Drop hits per texel per second at full rain (speckled fill). */
  fillPerS: 0.45,
  /** Soak rate per second of full rain, dry rate per second. */
  soakPerS: 0.08,
  dryPerS: 0.02,
  /** Drying multiplier at dawn. */
  dawnDry: 3,
  /** Step period (s): 15 Hz. */
  stepS: 1 / 15,
} as const;

export interface WetMap {
  /** RG bytes, row-major (row = +Z, col = +X), 2 bytes per texel. */
  readonly data: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** Box-frame centre of the map. */
  readonly centerX: number;
  readonly centerZ: number;
  /** Bumped on every step that changed data (the view uploads when it moves). */
  readonly version: number;
  /**
   * Advances by `dt` (accumulated into 15 Hz steps). `density` is the rain
   * level 0..1 inside `rainEllipse`; `field` blocks it; `tableY` is the table
   * in rain space (= box frame floor).
   */
  update(dt: number, density: number, field: Readonly<HandField>, tableY: number, dawn: boolean): void;
  /** Mean R and G inside an axis-aligned box-frame rectangle (for the kite). */
  sample(x0: number, z0: number, x1: number, z1: number, out: { r: number; g: number }): void;
  /** Fraction of the texels inside the rain ellipse that the field covers right now. */
  readonly sheltered: number;
  /** Seconds each texel spent under a hand while it rained (storm/print.ts reads it). */
  readonly shelter: Float32Array;
  /** Texel size (m). */
  readonly texel: number;
  reset(): void;
}

export interface WetMapOptions {
  centerX: number;
  centerZ: number;
  /** Rain impact ellipse (box frame): centre and half extents (canon: 0.30 × 0.20 on the kite). */
  rainCenter: readonly [number, number];
  rainHalf: readonly [number, number];
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

export function createWetMap(o: Readonly<WetMapOptions>): WetMap {
  const { cols, rows } = WET;
  const [sx, sz] = WET.sizeM;
  const texel = sx / cols;
  const x0 = o.centerX - sx / 2;
  const z0 = o.centerZ - sz / 2;
  // Float state (bytes are only the upload format).
  const R = new Float32Array(cols * rows);
  const G = new Float32Array(cols * rows);
  const S = new Float32Array(cols * rows);
  const data = new Uint8Array(cols * rows * 2);
  // Precomputed rain weight per texel: 1 inside the impact ellipse, soft 2 cm edge.
  const rainW = new Float32Array(cols * rows);
  const [rcx, rcz] = o.rainCenter;
  const [rhx, rhz] = o.rainHalf;
  // Only texels the rain can reach ever change: visit those and nothing else.
  const reach: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = x0 + (i + 0.5) * texel;
      const z = z0 + (j + 0.5) * texel;
      const e = Math.hypot((x - rcx) / rhx, (z - rcz) / rhz);
      const w = clamp01((1.08 - e) / 0.16);
      rainW[j * cols + i] = w;
      if (w > 0) reach.push(j * cols + i);
    }
  }
  const cells = Uint32Array.from(reach);
  const cover = new Uint8Array(cols * rows);
  let acc = 0;
  let version = 0;
  // xorshift32: deterministic drop hits.
  let seed = 0x2545f491;
  let sheltered = 0;
  let any = false;

  const step = (h: number, density: number, field: Readonly<HandField>, tableY: number, dawn: boolean): void => {
    const raining = density > 0.001;
    if (!raining && !any) return;
    const shineK = 1 - Math.exp(-h / WET.tauShineS);
    const coveredK = Math.exp(-h / WET.tauCoveredS);
    const hitRate = WET.fillPerS * h;
    const dry = WET.dryPerS * (dawn ? WET.dawnDry : 1) * h;
    const soak = WET.soakPerS * density * h;
    // Texels the hands shelter this step (each primitive visits only its own box).
    cover.fill(0);
    if (raining) rasterizeCover(field, tableY, cover, cols, rows, x0, z0, texel);
    let inRain = 0;
    let covered = 0;
    let still = false;
    for (let n = 0; n < cells.length; n++) {
      const k = cells[n];
      const rw = rainW[k];
      let r = R[k];
      let wetting = false;
      if (raining) {
        const blocked = cover[k] === 1;
        if (rw >= 0.999) {
          inRain++;
          if (blocked) covered++;
        }
        if (blocked) {
          r *= coveredK;
          S[k] += h;
        }
        else {
          wetting = true;
          const target = rw * density;
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          // A drop lands here this step: the texel shines at once.
          if (r < target && (seed >>> 0) / 4294967296 < hitRate * target) r = target;
          else if (r > target) r += (target - r) * shineK;
          const g = G[k] + soak * rw;
          G[k] = g < 1 ? g : 1;
        }
      } else r -= r * shineK;
      if (!wetting) {
        const g = G[k] - dry;
        G[k] = g > 0 ? g : 0;
      }
      if (r < 1 / 512) r = 0;
      R[k] = r;
      if (r > 0 || G[k] > 0) still = true;
      data[k * 2] = (clamp01(r) * 255 + 0.5) | 0;
      data[k * 2 + 1] = (clamp01(G[k]) * 255 + 0.5) | 0;
    }
    any = still;
    sheltered = inRain > 0 ? covered / inRain : 0;
    version++;
  };

  return {
    data,
    cols,
    rows,
    centerX: o.centerX,
    centerZ: o.centerZ,
    shelter: S,
    texel,
    get version() {
      return version;
    },
    get sheltered() {
      return sheltered;
    },
    update(dt, density, field, tableY, dawn) {
      if (!(dt > 0) || !Number.isFinite(dt)) return;
      acc = Math.min(acc + dt, 0.25);
      const d = clamp01(Number.isFinite(density) ? density : 0);
      while (acc >= WET.stepS) {
        acc -= WET.stepS;
        step(WET.stepS, d, field, tableY, dawn);
      }
    },
    sample(ax, az, bx, bz, out) {
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - x0) / texel));
      const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) - x0) / texel));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - z0) / texel));
      const j1 = Math.min(rows - 1, Math.floor((Math.max(az, bz) - z0) / texel));
      let r = 0;
      let g = 0;
      let n = 0;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          r += R[j * cols + i];
          g += G[j * cols + i];
          n++;
        }
      }
      out.r = n ? r / n : 0;
      out.g = n ? g / n : 0;
    },
    reset() {
      seed = 0x2545f491;
      R.fill(0);
      G.fill(0);
      S.fill(0);
      data.fill(0);
      acc = 0;
      sheltered = 0;
      any = false;
      version++;
    },
  };
}
