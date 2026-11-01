/**
 * Source B pinch detector: thumb-tip ↔ index-tip distance with hysteresis.
 * PURE module.
 *
 * Only drives grabs with ?pinch=distance (escape hatch); otherwise it is a
 * diagnostic next to the system select. Thresholds scale with the measured
 * hand (handScale / refHandScaleM), and confirmation counts only NEW samples:
 * hand tracking runs at ~30 Hz under 72 Hz frames, so three frames that
 * repeat one noisy sample must not confirm anything.
 */

export interface DistancePinchConfig {
  /** Enter below this distance (m) at the reference hand size. */
  enterM: number;
  /** Exit above this distance (m) at the reference hand size. */
  exitM: number;
  /** Consecutive new samples beyond a threshold needed to switch. */
  confirmSamples: number;
  /** Hand size the thresholds were tuned for (wrist → middle proximal, m). */
  refHandScaleM: number;
}

export const DISTANCE_PINCH_DEFAULTS: Readonly<DistancePinchConfig> = {
  enterM: 0.015,
  exitM: 0.03,
  confirmSamples: 3,
  refHandScaleM: 0.09,
};

/** Reused by update(): read it before the next call. */
export interface DistancePinchStep {
  start: boolean;
  end: boolean;
  selecting: boolean;
}

export interface DistancePinch {
  /** Non-finite distances (untracked) are not samples: level kept, no edges. */
  update(tipDistance: number, handScale: number): DistancePinchStep;
  reset(): void;
}

export function createDistancePinch(cfg?: Partial<DistancePinchConfig>): DistancePinch {
  const c: DistancePinchConfig = { ...DISTANCE_PINCH_DEFAULTS, ...cfg };
  const confirm = Math.max(1, Math.floor(c.confirmSamples));
  let selecting = false;
  let streak = 0;
  let last = NaN;
  const out: DistancePinchStep = { start: false, end: false, selecting: false };

  return {
    update(tipDistance, handScale) {
      out.start = false;
      out.end = false;
      if (Number.isFinite(tipDistance) && tipDistance !== last) {
        last = tipDistance;
        const k = Number.isFinite(handScale) && handScale > 0 ? handScale / c.refHandScaleM : 1;
        const beyond = selecting ? tipDistance > c.exitM * k : tipDistance < c.enterM * k;
        streak = beyond ? streak + 1 : 0;
        if (streak >= confirm) {
          streak = 0;
          selecting = !selecting;
          out.start = selecting;
          out.end = !selecting;
        }
      }
      out.selecting = selecting;
      return out;
    },
    reset() {
      selecting = false;
      streak = 0;
      last = NaN;
      out.start = out.end = out.selecting = false;
    },
  };
}
