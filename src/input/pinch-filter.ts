/**
 * Pinch-point conditioning per hand. PURE module.
 *
 * The raw thumb/index midpoint jitters by several millimetres and the ratchet
 * keeps the running maximum, so every positive spike along a handle axis
 * would become permanent progress. Before anything uses the point:
 *
 * - One-Euro filter (Casiez, Roussel, Vogel, CHI 2012): a low-pass whose
 *   cutoff rises with speed, so a still hand is smoothed hard and a pulling
 *   hand barely lags (steady lag tends to 1 / (2π·beta) m at high speed).
 * - Re-seeded on every select start: the grab reference is the raw point of
 *   the grab frame, not a value still catching up with the closing fingers
 *   (IWER switches to the pinch pose in one frame, ~8 cm of midpoint travel).
 * - Glitch frames: while a pinch is held (selecting, no edge this frame) a
 *   raw jump faster than `glitchSpeedMps` is impossible for a hand that is
 *   pulling a tab. That frame counts as untracked (the FSM retention takes
 *   over) and re-seeds the filter, so the spike never reaches the output.
 */
import type { Vec3 } from '../core/types.ts';

export interface PinchFilterConfig {
  /** Cutoff with the hand still (Hz). */
  minCutoffHz: number;
  /** Cutoff increase per m/s of filtered speed (Hz·s/m). */
  beta: number;
  /** Cutoff of the speed estimate (Hz). */
  dCutoffHz: number;
  /** Raw speed above which a held-pinch frame is a tracking glitch (m/s). */
  glitchSpeedMps: number;
  /** Never call a jump below this a glitch, whatever dt (m). */
  glitchMinM: number;
}

export const PINCH_FILTER_DEFAULTS: Readonly<PinchFilterConfig> = {
  minCutoffHz: 1.2,
  beta: 20,
  dCutoffHz: 1,
  glitchSpeedMps: 2.16,
  glitchMinM: 0.03,
};

export interface PinchFilterInput {
  /** Geometry valid this frame (before the glitch check). */
  tracked: boolean;
  /** Raw world pinch point. */
  raw: Readonly<Vec3>;
  /** Seconds since the previous frame (clamped by the caller). */
  dt: number;
  /** Select level after this frame's edges. */
  selecting: boolean;
  /** A select start edge this frame (before the palm veto). */
  start: boolean;
  /** A select end edge this frame. */
  end: boolean;
}

export interface PinchFilter {
  /**
   * Writes the conditioned point into `out` (left untouched when the result
   * is false). Returns the frame's `tracked`: false when the input was not
   * tracked or the frame is a glitch.
   */
  update(i: Readonly<PinchFilterInput>, out: Vec3): boolean;
  reset(): void;
  /** Glitch frames since creation (diagnostics). */
  readonly glitches: number;
}

const alpha = (cutoffHz: number, dt: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
};

export function createPinchFilter(cfg?: Partial<PinchFilterConfig>): PinchFilter {
  const c: PinchFilterConfig = { ...PINCH_FILTER_DEFAULTS, ...cfg };
  /** Filter state: value and speed estimate. */
  const x: Vec3 = { x: 0, y: 0, z: 0 };
  const dx: Vec3 = { x: 0, y: 0, z: 0 };
  let primed = false;
  /** Last tracked raw point, for the glitch check. */
  const last: Vec3 = { x: 0, y: 0, z: 0 };
  let hasLast = false;
  let glitches = 0;

  const seed = (p: Readonly<Vec3>): void => {
    x.x = p.x;
    x.y = p.y;
    x.z = p.z;
    dx.x = dx.y = dx.z = 0;
    primed = true;
  };

  return {
    get glitches() {
      return glitches;
    },

    update(i, out) {
      const p = i.raw;
      if (!i.tracked || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
        primed = false;
        hasLast = false;
        return false;
      }
      const dt = i.dt > 1e-4 ? i.dt : 1e-4;

      if (hasLast && i.selecting && !i.start && !i.end) {
        const jump = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
        if (jump > Math.max(c.glitchMinM, c.glitchSpeedMps * dt)) {
          glitches++;
          // Accept the new place from the next frame on: a single spike costs
          // two untracked frames, a real relocalisation one.
          last.x = p.x;
          last.y = p.y;
          last.z = p.z;
          primed = false;
          return false;
        }
      }
      last.x = p.x;
      last.y = p.y;
      last.z = p.z;
      hasLast = true;

      if (!primed || i.start) {
        seed(p);
      } else {
        const ad = alpha(c.dCutoffHz, dt);
        dx.x += ad * ((p.x - x.x) / dt - dx.x);
        dx.y += ad * ((p.y - x.y) / dt - dx.y);
        dx.z += ad * ((p.z - x.z) / dt - dx.z);
        const a = alpha(c.minCutoffHz + c.beta * Math.hypot(dx.x, dx.y, dx.z), dt);
        x.x += a * (p.x - x.x);
        x.y += a * (p.y - x.y);
        x.z += a * (p.z - x.z);
      }
      out.x = x.x;
      out.y = x.y;
      out.z = x.z;
      return true;
    },

    reset() {
      primed = false;
      hasLast = false;
    },
  };
}
