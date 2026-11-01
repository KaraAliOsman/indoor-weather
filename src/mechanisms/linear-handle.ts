/**
 * Linear handle: a tab that slides along one axis (the Wind pull tab).
 * PURE module (no three, no @iwsdk/core).
 *
 * The mechanism (C) calls setFrame() once per frame with the world rest point
 * and axis; the arbiter (A) reads grabPoint/enabled and calls amountFor().
 * All returned objects are stable and mutated in place (no per-frame garbage).
 */
import type { ActuationTarget, HandleHint, HandleSpec, Vec3 } from '../core/types.ts';

/**
 * Proposed absolute amount for a pull that started at `start` (ratchet at
 * `progressAtStart`) and is now at `now`:
 *   progressAtStart + (along - clamp(along, 0, deadband)) / travel,  along = dot(now - start, axis)
 * The first `deadband` metres of every pull count for nothing: tracking noise
 * on a still pinch never reaches the ratchet (which keeps the maximum).
 * Pulling back is not affected. No clamping: the ratchet clamps.
 */
export function linearAmount(
  start: Readonly<Vec3>,
  now: Readonly<Vec3>,
  axis: Readonly<Vec3>,
  travel: number,
  progressAtStart: number,
  deadband = 0,
): number {
  const along = (now.x - start.x) * axis.x + (now.y - start.y) * axis.y + (now.z - start.z) * axis.z;
  const dead = along > deadband ? deadband : along > 0 ? along : 0;
  return progressAtStart + (along - dead) / travel;
}

export interface LinearHandle extends HandleSpec {
  /**
   * grabPoint = rest + axis * progress * travel; hint = { axis, travel }.
   * `axis` is normalised (a zero axis keeps the previous one); `progress` is clamped to [0, 1].
   */
  setFrame(rest: Readonly<Vec3>, axis: Readonly<Vec3>, progress: number, enabled: boolean): void;
}

export interface LinearHandleOptions {
  target: ActuationTarget;
  /** Full pull length (m) from progress 0 to 1. */
  travel: number;
  /** Pinch must start within this distance of grabPoint (m). */
  grabRadius: number;
  /** Pull that counts for nothing at the start of every grab (m), default 0. */
  deadbandM?: number;
  /** End magnet (HandleSpec.releaseSnapAt), default none. */
  releaseSnapAt?: number;
}

export function createLinearHandle(o: LinearHandleOptions): LinearHandle {
  if (!(o.travel > 0) || !Number.isFinite(o.travel)) throw new Error('[linear-handle] travel must be > 0');
  if (!(o.grabRadius > 0) || !Number.isFinite(o.grabRadius)) throw new Error('[linear-handle] grabRadius must be > 0');
  const deadband = o.deadbandM ?? 0;
  if (!(deadband >= 0) || !(deadband < o.travel)) throw new Error('[linear-handle] deadbandM must be in [0, travel)');

  const travel = o.travel;
  const grabPoint: Vec3 = { x: 0, y: 0, z: 0 };
  const axis: Vec3 = { x: 0, y: 0, z: 1 };
  const hint: HandleHint = { axis, travel };
  let enabled = false;

  return {
    target: o.target,
    grabPoint,
    grabRadius: o.grabRadius,
    hint,
    releaseSnapAt: o.releaseSnapAt ?? null,
    get enabled() {
      return enabled;
    },
    amountFor(start, now, progressAtStart) {
      return linearAmount(start, now, axis, travel, progressAtStart, deadband);
    },
    setFrame(rest, ax, progress, on) {
      const len = Math.hypot(ax.x, ax.y, ax.z);
      if (len > 1e-9 && Number.isFinite(len)) {
        axis.x = ax.x / len;
        axis.y = ax.y / len;
        axis.z = ax.z / len;
      }
      const p = progress > 0 ? (progress < 1 ? progress : 1) : 0; // NaN → 0
      const d = p * travel;
      grabPoint.x = rest.x + axis.x * d;
      grabPoint.y = rest.y + axis.y * d;
      grabPoint.z = rest.z + axis.z * d;
      enabled = on;
    },
  };
}
