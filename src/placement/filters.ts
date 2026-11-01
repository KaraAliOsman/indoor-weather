/**
 * Placement filters (PURE: no three, no @iwsdk/core).
 *
 * Decide whether a hit-test result is a usable table top, where the box goes
 * without hit-test (fallback), which way it faces, and how it settles.
 * World space = local-floor; yaw convention as in core/types.ts.
 */
import type { BoxPose, HeadSample, HitVerdict, Vec3 } from '../core/types.ts';

export interface PlacementConfig {
  /** Hit normal · (0, 1, 0) at least this (≈ 25° of tilt). */
  minUpDot: number;
  /** The surface must lie this far below the head... */
  belowHeadMinM: number;
  /** ...and no further than this. */
  belowHeadMaxM: number;
  /** Surfaces lower than this are the floor (only when floorKnown). */
  minFloorY: number;
  /** Horizontal head → hit distance range. */
  minDistM: number;
  maxDistM: number;
  /** Consecutive valid hits within stableTolM of the run's (slowly following) anchor before a select commits. */
  stableFrames: number;
  stableTolM: number;
  /**
   * Arrival without a pinch (canon §10): a hit stable this many frames lands
   * the box on its own; in fallback the box lands after `fallbackAutoS`.
   * 0 disables the automatic landing (a pinch is then required).
   */
  autoCommitFrames: number;
  fallbackAutoS: number;
  /** Visible seconds without a valid hit before switching to fallback. */
  fallbackAfterS: number;
  /** Fallback box: this far ahead of the head (horizontal)... */
  fallbackAheadM: number;
  /** ...and this far below it. */
  fallbackBelowM: number;
  /** Pinch heights below the head usable as the fallback lid height. */
  pinchBandM: readonly [number, number];
  /** The fallback pinch marks the lid: base = pinchY - pinchToBaseM. */
  pinchToBaseM: number;
  /** Settle animation after a commit. */
  settleS: number;
  settleLiftM: number;
  /** Reticle ray: Viewer space, pitched down by this much. */
  reticlePitchDeg: number;
  /** Reticle ray length (3D, head → hit). */
  reticleMaxDistM: number;
}

export const PLACEMENT_DEFAULTS: Readonly<PlacementConfig> = Object.freeze({
  minUpDot: 0.9,
  belowHeadMinM: 0.15,
  belowHeadMaxM: 0.75,
  minFloorY: 0.3,
  minDistM: 0.25,
  maxDistM: 0.9,
  stableFrames: 10,
  stableTolM: 0.01,
  autoCommitFrames: 30,
  fallbackAutoS: 1.2,
  fallbackAfterS: 4,
  fallbackAheadM: 0.45,
  fallbackBelowM: 0.45,
  pinchBandM: [0.25, 0.75] as const,
  pinchToBaseM: 0.07,
  settleS: 0.5,
  settleLiftM: 0.04,
  reticlePitchDeg: 25,
  reticleMaxDistM: 1.5,
});

function finite3(v: Readonly<Vec3>): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Verdict for one hit at `p` with surface normal `normal`, seen from `head`.
 * Checks run in this order and the first failure wins: tilted, floor,
 * too-high, too-low, too-near, too-far. Non-finite input → 'none'.
 */
export function classifyHit(
  p: Readonly<Vec3>,
  normal: Readonly<Vec3>,
  head: Readonly<Vec3>,
  floorKnown: boolean,
  cfg: Readonly<PlacementConfig> = PLACEMENT_DEFAULTS,
): HitVerdict {
  if (!finite3(p) || !finite3(normal) || !finite3(head)) return 'none';
  const len = Math.hypot(normal.x, normal.y, normal.z);
  if (!(len > 0) || normal.y / len < cfg.minUpDot) return 'tilted';
  if (floorKnown && p.y < cfg.minFloorY) return 'floor';
  const below = head.y - p.y;
  if (below < cfg.belowHeadMinM) return 'too-high';
  if (below > cfg.belowHeadMaxM) return 'too-low';
  const dist = Math.hypot(p.x - head.x, p.z - head.z);
  if (dist < cfg.minDistM) return 'too-near';
  if (dist > cfg.maxDistM) return 'too-far';
  return 'ok';
}

/** Yaw that turns the box front (+Z) towards the head. 0 when the head is straight above. */
export function yawToHead(box: Readonly<Vec3>, head: Readonly<Vec3>): number {
  return Math.atan2(head.x - box.x, head.z - box.z);
}

/**
 * Fallback pose: `fallbackAheadM` ahead of the head along its horizontal
 * forward and `fallbackBelowM` below it, facing the head. When `pinchY` lies
 * within `pinchBandM` below the head, the pinch marks the lid height instead
 * (y = pinchY - pinchToBaseM). Writes into `out` (no allocation when given).
 */
export function fallbackPose(
  head: Readonly<HeadSample>,
  pinchY: number | null,
  cfg: Readonly<PlacementConfig> = PLACEMENT_DEFAULTS,
  out: BoxPose = { position: { x: 0, y: 0, z: 0 }, yaw: 0 },
): BoxPose {
  const h = head.position;
  let fx = head.forward.x;
  let fz = head.forward.z;
  const fl = Math.hypot(fx, fz);
  if (fl > 1e-6) {
    fx /= fl;
    fz /= fl;
  } else {
    fx = -Math.sin(head.yaw);
    fz = -Math.cos(head.yaw);
  }
  const p = out.position;
  p.x = h.x + cfg.fallbackAheadM * fx;
  p.y = h.y - cfg.fallbackBelowM;
  p.z = h.z + cfg.fallbackAheadM * fz;
  if (pinchY !== null && Number.isFinite(pinchY)) {
    const below = h.y - pinchY;
    if (below >= cfg.pinchBandM[0] && below <= cfg.pinchBandM[1]) p.y = pinchY - cfg.pinchToBaseM;
  }
  out.yaw = yawToHead(p, h);
  return out;
}

/** easeOutCubic over a fixed duration, clamped to [0, 1] (NaN → 0). */
export function settleEase(t01: number): number {
  if (!(t01 > 0)) return 0;
  if (t01 >= 1) return 1;
  const u = 1 - t01;
  return 1 - u * u * u;
}

export interface Stability {
  /**
   * Feed this frame's valid hit (or null). Returns how many consecutive
   * frames stayed within stableTolM of the run's anchor; a hit outside the
   * tolerance starts a new run (1), null resets to 0. The anchor follows the
   * hits slowly (EMA 0.15), so a seated head drifting ~1°/s keeps the run
   * while a jump to another surface still breaks it.
   */
  push(p: Readonly<Vec3> | null): number;
  reset(): void;
}

/** How fast the stability anchor follows a drifting hit (per frame). */
const ANCHOR_FOLLOW = 0.15;

export function createStability(cfg: Readonly<PlacementConfig> = PLACEMENT_DEFAULTS): Stability {
  const anchor: Vec3 = { x: 0, y: 0, z: 0 };
  const tol2 = cfg.stableTolM * cfg.stableTolM;
  let count = 0;
  return {
    push(p) {
      if (!p || !finite3(p)) {
        count = 0;
        return 0;
      }
      if (count > 0) {
        const dx = p.x - anchor.x;
        const dy = p.y - anchor.y;
        const dz = p.z - anchor.z;
        if (dx * dx + dy * dy + dz * dz <= tol2) {
          anchor.x += dx * ANCHOR_FOLLOW;
          anchor.y += dy * ANCHOR_FOLLOW;
          anchor.z += dz * ANCHOR_FOLLOW;
          return ++count;
        }
      }
      anchor.x = p.x;
      anchor.y = p.y;
      anchor.z = p.z;
      count = 1;
      return 1;
    },
    reset() {
      count = 0;
    },
  };
}
