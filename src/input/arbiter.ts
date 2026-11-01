/**
 * Arbiter core: hands → handles → actuate(). PURE module, one step per frame.
 *
 * - One owner per handle and one handle per hand. When both hands start on
 *   the same handle in the same frame, the nearer pinch point wins (exact
 *   tie → right) and the other hand may take its next handle in range.
 * - Controllers get grabRadius × 1.5 (no finger precision).
 * - While armed or pulling, every frame calls
 *   actuate(target, handle.amountFor(grabStart, follow, progressAtStart), 'direct').
 *   The kinematics (and the per-handle deadband) live in the handle, so the
 *   arbiter stays generic. `armed` vs `pulling` only classifies the gesture
 *   (tap or pull): the deadzone is measured along the handle's hint axis.
 * - `follow` chases the (already filtered) pinch point at no more than
 *   MAX_PULL_SPEED_MPS: one bad frame can move a handle by millimetres, never
 *   by notches.
 * - When a hand comes back after a tracking loss (FSM `resumed`) the pull
 *   restarts there: grabStart = pinch point, progressAtStart = progress.
 * - End magnet: a plain release at or past handle.releaseSnapAt completes
 *   the target (one more actuate(target, 1) on the release frame).
 * - No actuate once the target is complete; a target that gets locked (or
 *   completed, or disabled) mid-grab releases with 'cancel'.
 * - M1 only acts in 'direct' mode; other modes cancel and block grabs.
 * Emits 'pinch' on every FSM transition, then 'handle:grab' / 'handle:release'.
 */
import { HANDS } from '../core/types.ts';
import type {
  ActuationService,
  ActuationTarget,
  ArbiterView,
  EventBus,
  GameStateApi,
  Handedness,
  HandleRegistry,
  HandleSpec,
  HandSample,
  HandsState,
  InputMode,
  PinchState,
  ReleaseReason,
  Vec3,
} from '../core/types.ts';
import { distance } from './handles.ts';
import { createPinchFsm, type PinchFsm, type PinchFsmConfig, type PinchFsmInput } from './pinch-fsm.ts';

export const CONTROLLER_RADIUS_SCALE = 1.5;
/** Fastest pull a handle follows (m/s): above any deliberate tab pull, below a tracking jump. */
export const MAX_PULL_SPEED_MPS = 0.5;
/** Per-step dt clamp (s), as FrameClock.dt. */
const MAX_DT_S = 0.05;

export interface ArbiterFrame {
  time: number;
  /** ctx.visible() ∧ isChapterPhase(game.phase). */
  allowed: boolean;
  mode: InputMode;
  hands: HandsState;
}

export interface ArbiterDeps {
  handles: HandleRegistry;
  actuation: ActuationService;
  bus: EventBus;
  game: GameStateApi;
  fsm?: Partial<PinchFsmConfig>;
}

export interface Arbiter extends ArbiterView {
  step(f: Readonly<ArbiterFrame>): void;
  /** Drop every grab now (session end, pause). Emits the release events. */
  cancelAll(reason: ReleaseReason): void;
}

interface Slot {
  readonly hand: Handedness;
  readonly fsm: PinchFsm;
  owner: HandleSpec | null;
  /** Pinch point when the grab (or its resume) started (world, copied). */
  readonly grabStart: Vec3;
  /** Rate-limited pinch point the handle follows (world). */
  readonly follow: Vec3;
  progressAtStart: number;
  /** Handle this hand would grab in the current step. */
  candidate: HandleSpec | null;
  candidateD: number;
  readonly input: PinchFsmInput;
  readonly view: { fsm: PinchState; owner: ActuationTarget | null };
}

function makeSlot(hand: Handedness, fsm: Partial<PinchFsmConfig> | undefined): Slot {
  return {
    hand,
    fsm: createPinchFsm(fsm),
    owner: null,
    grabStart: { x: 0, y: 0, z: 0 },
    follow: { x: 0, y: 0, z: 0 },
    progressAtStart: 0,
    candidate: null,
    candidateD: Infinity,
    input: {
      time: 0,
      tracked: false,
      selectStart: false,
      selectEnd: false,
      selecting: false,
      canGrab: false,
      moved: 0,
      allowed: false,
    },
    view: { fsm: 'idle', owner: null },
  };
}

export function createArbiter(deps: ArbiterDeps): Arbiter {
  const { handles, actuation, bus, game } = deps;
  const slots: Record<Handedness, Slot> = { left: makeSlot('left', deps.fsm), right: makeSlot('right', deps.fsm) };
  let lastTime = Number.NaN;
  let dt = 0;

  const grabbable = (h: HandleSpec): boolean =>
    h.enabled && game.isUnlocked(h.target) && !actuation.isComplete(h.target);

  /** Nearest grabbable handle in (scaled) range that nobody else holds or claimed. */
  const findCandidate = (slot: Slot, sample: HandSample, exclude: HandleSpec | null): void => {
    const other = slot.hand === 'left' ? slots.right : slots.left;
    const scale = sample.device === 'controller' ? CONTROLLER_RADIUS_SCALE : 1;
    const list = handles.all();
    slot.candidate = null;
    slot.candidateD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (h === exclude || h === other.owner || !grabbable(h)) continue;
      const d = distance(sample.pinchPoint, h.grabPoint);
      if (d <= h.grabRadius * scale && d < slot.candidateD) {
        slot.candidate = h;
        slot.candidateD = d;
      }
    }
  };

  const emitTransition = (hand: Handedness, from: PinchState, to: PinchState): void => {
    if (from !== to) bus.emit({ type: 'pinch', hand, from, to });
  };

  const copy = (to: Vec3, from: Readonly<Vec3>): void => {
    to.x = from.x;
    to.y = from.y;
    to.z = from.z;
  };

  /** Moves slot.follow towards `p` by at most MAX_PULL_SPEED_MPS · dt. */
  const chase = (slot: Slot, p: Readonly<Vec3>): void => {
    const f = slot.follow;
    const dx = p.x - f.x;
    const dy = p.y - f.y;
    const dz = p.z - f.z;
    const d = Math.hypot(dx, dy, dz);
    const max = MAX_PULL_SPEED_MPS * dt;
    if (d <= max) copy(f, p);
    else {
      const k = max / d;
      f.x += dx * k;
      f.y += dy * k;
      f.z += dz * k;
    }
  };

  /** Pull since grabStart: along the hint axis when the handle has one. */
  const pulled = (slot: Slot, h: HandleSpec): number => {
    const a = h.hint?.axis;
    const s0 = slot.grabStart;
    const f = slot.follow;
    if (!a) return distance(f, s0);
    return (f.x - s0.x) * a.x + (f.y - s0.y) * a.y + (f.z - s0.z) * a.z;
  };

  const stepSlot = (slot: Slot, sample: HandSample, f: Readonly<ArbiterFrame>, active: boolean): void => {
    const owner = slot.owner;
    const i = slot.input;
    if (owner && sample.tracked) chase(slot, sample.pinchPoint);
    i.time = f.time;
    i.tracked = sample.tracked;
    i.selectStart = sample.selectStart;
    i.selectEnd = sample.selectEnd;
    i.selecting = sample.selecting;
    i.canGrab = slot.candidate !== null;
    i.moved = owner ? pulled(slot, owner) : 0;
    i.allowed = active && (owner === null || grabbable(owner));

    const st = slot.fsm.step(i);
    // Copy before emitting: handlers run synchronously.
    const { state, prev, grabbed, resumed, released } = st;

    if (grabbed && slot.candidate) {
      const h = slot.candidate;
      slot.owner = h;
      copy(slot.grabStart, sample.pinchPoint);
      copy(slot.follow, sample.pinchPoint);
      slot.progressAtStart = actuation.progress(h.target);
    } else if (resumed && slot.owner) {
      copy(slot.grabStart, sample.pinchPoint);
      copy(slot.follow, sample.pinchPoint);
      slot.progressAtStart = actuation.progress(slot.owner.target);
    }

    emitTransition(slot.hand, prev, state);

    const held = slot.owner;
    if (grabbed && held) bus.emit({ type: 'handle:grab', hand: slot.hand, target: held.target });

    if ((state === 'armed' || state === 'pulling') && held && !actuation.isComplete(held.target)) {
      const amount = held.amountFor(slot.grabStart, slot.follow, slot.progressAtStart);
      actuation.actuate(held.target, amount, 'direct');
    }

    if (released === 'release' && held && held.releaseSnapAt !== null && !actuation.isComplete(held.target)) {
      if (actuation.progress(held.target) >= held.releaseSnapAt - 1e-9) actuation.actuate(held.target, 1, 'direct');
    }

    if (released !== null && held) {
      slot.owner = null;
      bus.emit({ type: 'handle:release', hand: slot.hand, target: held.target, reason: released });
    }
  };

  return {
    step(f) {
      const raw = f.time - lastTime;
      dt = raw > 0 ? (raw < MAX_DT_S ? raw : MAX_DT_S) : 0; // NaN (first step) → 0
      lastTime = f.time;
      const active = f.allowed && f.mode === 'direct';
      const left = slots.left;
      const right = slots.right;

      // 1. Who could grab what this frame.
      for (let k = 0; k < HANDS.length; k++) {
        const slot = slots[HANDS[k]];
        const sample = f.hands[slot.hand];
        const idle = slot.fsm.state === 'idle' || slot.fsm.state === 'released';
        if (active && idle && sample.selectStart && sample.tracked) findCandidate(slot, sample, null);
        else {
          slot.candidate = null;
          slot.candidateD = Infinity;
        }
      }

      // 2. Same-frame tie on one handle: nearer wins, exact tie → right.
      if (left.candidate !== null && left.candidate === right.candidate) {
        if (left.candidateD < right.candidateD) findCandidate(right, f.hands.right, left.candidate);
        else findCandidate(left, f.hands.left, right.candidate);
      }

      // 3. Advance both FSMs.
      for (let k = 0; k < HANDS.length; k++) {
        const slot = slots[HANDS[k]];
        stepSlot(slot, f.hands[slot.hand], f, active);
      }
    },

    cancelAll(reason) {
      for (let k = 0; k < HANDS.length; k++) {
        const slot = slots[HANDS[k]];
        const from = slot.fsm.state;
        const held = slot.owner;
        slot.owner = null;
        slot.candidate = null;
        slot.fsm.reset();
        emitTransition(slot.hand, from, 'idle');
        if (held) bus.emit({ type: 'handle:release', hand: slot.hand, target: held.target, reason });
      }
    },

    stateOf(hand) {
      const slot = slots[hand];
      slot.view.fsm = slot.fsm.state;
      slot.view.owner = slot.owner?.target ?? null;
      return slot.view;
    },
  };
}
