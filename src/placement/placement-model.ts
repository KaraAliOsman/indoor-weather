/**
 * Placement state machine (PURE: no three, no @iwsdk/core).
 *
 *  idle ─start─► probing ─probe OK─► hit-test ─(select ∨ autoCommitFrames stable) ∧ valid─► committed
 *                   │ probe fails / 4 s       │ 4 s visible without a valid hit
 *                   ▼                         ▼
 *                fallback ◄───────────────────┘
 *                   │ 10 stable valid hits (hit-test available) ─► hit-test ('surface-found')
 *                   └─ select, or fallbackAutoS in fallback ─► committed ('fallback')
 *
 * The box lands on its own (canon §10: no pinch needed to start); a pinch
 * on a valid reticle still lands it at once.
 *  probing | hit-test | fallback ──forceCommit──► committed ('debug')
 *
 * The caller (PlacementSystem) feeds one step per frame while placing, then
 * owns everything after the commit (events, settle, box). Rules:
 * - `elapsed` and the fallback timer only advance while visible, by
 *   min(time - prevTime, 0.25) per step (never `time - startTime`).
 * - No commits while not visible.
 * - At most one mode change per step; a select on the step that changes the
 *   mode is ignored (it would act on a mode the user has not seen yet).
 * - The returned output and `status` are stable objects mutated in place:
 *   read them before the next call. `commit` and `modeChange` are fresh
 *   objects (they are rare).
 */
import type {
  BoxPose,
  HeadSample,
  HitVerdict,
  PlacementMode,
  PlacementModeReason,
  PlacementSource,
  PlacementStatus,
  Vec3,
} from '../core/types.ts';
import {
  classifyHit,
  createStability,
  fallbackPose,
  PLACEMENT_DEFAULTS,
  yawToHead,
  type PlacementConfig,
} from './filters.ts';

export type HitTestAvailability = 'unknown' | 'available' | 'unavailable';

export interface PlacementInput {
  /** World time (s), unclamped. */
  time: number;
  visible: boolean;
  /** Probe outcome; hits are only considered when 'available'. */
  hitTest: HitTestAvailability;
  /** This frame's reticle hit (world), or null. */
  hit: { position: Vec3; normal: Vec3 } | null;
  head: Readonly<HeadSample>;
  /** head.position.y > 0.6 (in a Local reference space the head starts near 0). */
  floorKnown: boolean;
  /** Select start edge of any hand this frame (after the palm veto). */
  selectStart: boolean;
  /** Pinch height of the first hand with selectStart, or null. */
  pinchY: number | null;
}

export interface PlacementOutput {
  status: Readonly<PlacementStatus>;
  commit: { pose: BoxPose; source: PlacementSource } | null;
  modeChange: { mode: PlacementMode; reason: PlacementModeReason } | null;
}

export interface PlacementModel {
  /** Live status (stable object). */
  readonly status: Readonly<PlacementStatus>;
  /** Enter 'probing'. The caller announces it (placement:mode, reason 'start'). */
  start(time: number): void;
  step(i: Readonly<PlacementInput>): PlacementOutput;
  /** Debug commit of `pose`, or of the current candidate when null. Null when not possible. */
  forceCommit(pose: Readonly<BoxPose> | null, time: number): PlacementOutput | null;
  /** Back to 'idle' (session end). */
  reset(): void;
}

/** Largest step a pausable timer accepts (s): the first frame after a pause carries the whole gap. */
export const MAX_TIMER_STEP_S = 0.25;
/** Float slack for accumulated timers (72 steps of 1/72 s may sum to 0.9999999). */
const TIMER_EPS_S = 1e-6;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function finitePose(p: Readonly<BoxPose>): boolean {
  return (
    Number.isFinite(p.position.x) &&
    Number.isFinite(p.position.y) &&
    Number.isFinite(p.position.z) &&
    Number.isFinite(p.yaw)
  );
}

function copyPose(p: Readonly<BoxPose>): BoxPose {
  return { position: { x: p.position.x, y: p.position.y, z: p.position.z }, yaw: p.yaw };
}

export function createPlacementModel(cfg?: Partial<PlacementConfig>): PlacementModel {
  const c: Readonly<PlacementConfig> = { ...PLACEMENT_DEFAULTS, ...cfg };
  const stability = createStability(c);
  const candidate: BoxPose = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  const status: Mutable<PlacementStatus> = {
    mode: 'idle',
    verdict: 'none',
    valid: false,
    stableFrames: 0,
    elapsed: 0,
    reticleVisible: false,
    candidate: null,
  };
  const out: PlacementOutput = { status, commit: null, modeChange: null };
  let prevTime = 0;
  /** Visible seconds since the last valid hit (or since start). */
  let noValidS = 0;
  /** Visible seconds in fallback mode (automatic landing). */
  let fallbackS = 0;

  function clear(mode: PlacementMode, time: number): void {
    status.mode = mode;
    status.verdict = 'none';
    status.valid = false;
    status.stableFrames = 0;
    status.elapsed = 0;
    status.reticleVisible = false;
    status.candidate = null;
    stability.reset();
    prevTime = time;
    noValidS = 0;
    fallbackS = 0;
  }

  function setMode(mode: PlacementMode, reason: PlacementModeReason): true {
    status.mode = mode;
    out.modeChange = { mode, reason };
    return true;
  }

  function commit(pose: BoxPose, source: PlacementSource): void {
    setMode('committed', 'commit');
    out.commit = { pose, source };
    status.verdict = 'none';
    status.valid = false;
    status.stableFrames = 0;
    status.reticleVisible = false;
    status.candidate = null;
    stability.reset();
  }

  /** Candidate, validity and reticle for the current mode. */
  function preview(hit: PlacementInput['hit'], verdict: HitVerdict, stable: number, head: Readonly<HeadSample>): void {
    switch (status.mode) {
      case 'hit-test': {
        status.reticleVisible = verdict !== 'none';
        status.valid = hit !== null && verdict === 'ok' && stable >= c.stableFrames;
        if (status.valid && hit) {
          const p = hit.position;
          candidate.position.x = p.x;
          candidate.position.y = p.y;
          candidate.position.z = p.z;
          candidate.yaw = yawToHead(p, head.position);
          status.candidate = candidate;
        } else {
          status.candidate = null;
        }
        break;
      }
      case 'fallback':
        // The reticle sits on the candidate as the "pinch to place" affordance.
        status.valid = head.valid;
        status.reticleVisible = head.valid;
        status.candidate = head.valid ? fallbackPose(head, null, c, candidate) : null;
        break;
      default:
        status.valid = false;
        status.reticleVisible = false;
        status.candidate = null;
    }
  }

  return {
    status,

    start(time) {
      clear('probing', time);
    },

    step(i) {
      out.commit = null;
      out.modeChange = null;
      const dtRaw = i.time - prevTime;
      prevTime = i.time;
      if (status.mode === 'idle' || status.mode === 'committed') return out;

      const dt = i.visible && dtRaw > 0 ? Math.min(dtRaw, MAX_TIMER_STEP_S) : 0;
      status.elapsed += dt;

      const head = i.head;
      const hit = i.hitTest === 'available' ? i.hit : null;
      const verdict: HitVerdict =
        hit && head.valid ? classifyHit(hit.position, hit.normal, head.position, i.floorKnown, c) : 'none';
      const stable = stability.push(verdict === 'ok' && hit ? hit.position : null);
      status.verdict = verdict;
      status.stableFrames = stable;
      noValidS = verdict === 'ok' ? 0 : noValidS + dt;
      const timedOut = noValidS >= c.fallbackAfterS - TIMER_EPS_S;

      let changed = false;
      switch (status.mode) {
        case 'probing':
          if (i.hitTest === 'available') changed = setMode('hit-test', 'start');
          else if (i.hitTest === 'unavailable') changed = setMode('fallback', 'no-hit-test');
          else if (timedOut) changed = setMode('fallback', 'timeout');
          break;
        case 'hit-test':
          if (i.hitTest === 'unavailable') changed = setMode('fallback', 'no-hit-test');
          else if (timedOut) changed = setMode('fallback', 'timeout');
          break;
        case 'fallback':
          if (hit && stable >= c.stableFrames) changed = setMode('hit-test', 'surface-found');
          break;
      }

      preview(hit, verdict, stable, head);

      if (changed) fallbackS = 0;
      else if (status.mode === 'fallback') fallbackS += dt;
      const auto =
        c.autoCommitFrames > 0 &&
        ((status.mode === 'hit-test' && stable >= c.autoCommitFrames) ||
          (status.mode === 'fallback' && fallbackS >= c.fallbackAutoS - TIMER_EPS_S));
      if (!changed && (i.selectStart || auto) && i.visible && status.valid && status.candidate) {
        if (status.mode === 'hit-test') commit(copyPose(status.candidate), 'hit-test');
        else commit(fallbackPose(head, i.selectStart ? i.pinchY : null, c), 'fallback');
      }
      return out;
    },

    forceCommit(pose, time) {
      out.commit = null;
      out.modeChange = null;
      if (status.mode !== 'probing' && status.mode !== 'hit-test' && status.mode !== 'fallback') return null;
      const src = pose ?? status.candidate;
      if (!src || !finitePose(src)) return null;
      prevTime = time;
      commit(copyPose(src), 'debug');
      return out;
    },

    reset() {
      clear('idle', prevTime);
    },
  };
}
