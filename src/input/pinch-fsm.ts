/**
 * Per-hand pinch state machine. PURE module.
 *
 *  idle ──start ∧ canGrab ∧ allowed ∧ tracked──► armed ──moved > deadzone──► pulling
 *  armed | pulling ──end (or level off)──► released(release)
 *  armed | pulling ──¬tracked──► holding
 *  holding ──tracked ∧ (selecting ∨ start)──► pulling (resumed: the caller rebases the pull)
 *  holding ──tracked ∧ ¬selecting──► released(release)
 *  holding ──¬tracked for retentionS──► released(tracking-lost)
 *  armed | pulling | holding ──¬allowed──► released(cancel)
 *  released ──next step──► idle (and that same step may grab again)
 *
 * While untracked, select edges are ignored: runtimes may fire selectend when
 * a hand drops out, and the 300 ms retention exists precisely to survive
 * that. A false release costs nothing (the ratchet never goes back).
 */
import type { PinchState, ReleaseReason } from '../core/types.ts';

export interface PinchFsmConfig {
  /** Tracking-loss retention before giving up a grab (s). */
  retentionS: number;
  /**
   * Pull that turns `armed` into `pulling` (m). The arbiter measures it along
   * the handle's hint axis, so jitter across the axis never counts; it sits
   * well above the filtered tracking noise (a tap stays a tap).
   */
  deadzoneM: number;
}

export const PINCH_FSM_DEFAULTS: Readonly<PinchFsmConfig> = { retentionS: 0.3, deadzoneM: 0.008 };

export interface PinchFsmInput {
  time: number;
  tracked: boolean;
  selectStart: boolean;
  selectEnd: boolean;
  selecting: boolean;
  /** A handle accepted this start (in range, enabled, unlocked, free). */
  canGrab: boolean;
  /** Pull since the grab (m): along the handle axis, or |pinchPoint − grabStart| without one. */
  moved: number;
  /** visible ∧ chapter phase ∧ owned target still unlocked. */
  allowed: boolean;
}

/** Reused by step(): read it before the next call. */
export interface PinchFsmStep {
  state: PinchState;
  prev: PinchState;
  /** idle → armed happened in this step. */
  grabbed: boolean;
  /**
   * holding → pulling happened in this step. Where the hand reappears says
   * nothing about the pull: the caller restarts it from here (new start point,
   * current progress) so a tracking jump is never turned into progress.
   */
  resumed: boolean;
  released: ReleaseReason | null;
}

export interface PinchFsm {
  readonly state: PinchState;
  step(i: Readonly<PinchFsmInput>): PinchFsmStep;
  reset(): void;
}

// Frame times are sums of float deltas: do not lose a frame to rounding.
const TIME_EPS = 1e-6;

export function createPinchFsm(cfg?: Partial<PinchFsmConfig>): PinchFsm {
  const c: PinchFsmConfig = { ...PINCH_FSM_DEFAULTS, ...cfg };
  let state: PinchState = 'idle';
  let lostAt = 0;
  const out: PinchFsmStep = { state: 'idle', prev: 'idle', grabbed: false, resumed: false, released: null };

  const release = (reason: ReleaseReason): void => {
    state = 'released';
    out.released = reason;
  };

  return {
    get state() {
      return state;
    },
    step(i) {
      out.prev = state;
      out.grabbed = false;
      out.resumed = false;
      out.released = null;
      // `released` is shown for exactly one step; a start in the next step is not lost.
      if (state === 'released') state = 'idle';

      switch (state) {
        case 'idle':
          if (i.selectStart && i.canGrab && i.allowed && i.tracked) {
            state = 'armed';
            out.grabbed = true;
          }
          break;
        case 'armed':
        case 'pulling':
          if (!i.allowed) release('cancel');
          else if (!i.tracked) {
            state = 'holding';
            lostAt = i.time;
          } else if (i.selectEnd || !i.selecting) release('release');
          else if (state === 'armed' && i.moved > c.deadzoneM) state = 'pulling';
          break;
        case 'holding':
          if (!i.allowed) release('cancel');
          else if (i.tracked) {
            if (i.selecting || i.selectStart) {
              state = 'pulling';
              out.resumed = true;
            } else release('release');
          } else if (i.time - lostAt >= c.retentionS - TIME_EPS) release('tracking-lost');
          break;
      }

      out.state = state;
      return out;
    },
    reset() {
      state = 'idle';
      out.state = out.prev = 'idle';
      out.grabbed = false;
      out.resumed = false;
      out.released = null;
    },
  };
}
