/**
 * Indoor Weather — shared contracts (M1, with slots for M2/M3).
 *
 * PURE module: no three, no @iwsdk/core. Input (A), placement (B) and
 * box + mechanisms (C) program against these types in parallel; the
 * integrator (I) wires the implementations in main.ts.
 *
 * Conventions
 * - World space = the session's local-floor space. The XROrigin is never
 *   moved, so world coordinates and reference-space coordinates coincide.
 * - Metres, seconds, radians (names ending in `Deg` are degrees).
 * - Yaw is a rotation about +Y. A head with yaw ψ looks along
 *   (-sin ψ, 0, -cos ψ). A box with yaw ψ has its local +Z (front face)
 *   along (sin ψ, 0, cos ψ); "facing the head" means
 *   ψ = atan2(head.x - box.x, head.z - box.z).
 * - Box local frame: origin at the bottom centre (on the table surface),
 *   +Y up, +Z front face (towards the user), +X the user's right.
 * - Vectors are plain {x,y,z}. Fields typed `readonly v: Vec3` are stable
 *   objects mutated in place by their owner every frame: copy them if you
 *   keep them past the current frame. Event payloads are always copies.
 * - Timers use the unclamped world `time`; per-frame integration uses
 *   `FrameClock.dt` (delta clamped to <= 0.05 s). Timers that must pause
 *   while not visible accumulate min(time - prevTime, 0.25) on visible
 *   frames only (Quest stops rAF while hidden, so the first frame after a
 *   pause carries the whole gap).
 */
import type { Flags } from '../boot/flags.ts';

// ---------------------------------------------------------------------------
// Primitives

export type Handedness = 'left' | 'right';
export const HANDS: readonly Handedness[] = ['left', 'right'];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** JSON-friendly vector used by the debug API (page.evaluate serialises it). */
export type Vec3Tuple = [number, number, number];

/** Written by FrameSystem (priority -10) at the start of every world update. */
export interface FrameClock {
  frame: number;
  /** World clock (s), unclamped. Use for timers. */
  time: number;
  /** min(delta, 0.05) (s). Use for integration and easing steps. */
  dt: number;
}

// ---------------------------------------------------------------------------
// Game

/**
 * The three chapters (direccion/canon.md §1): Wind (tab), Storm (cloud tag),
 * Dawn (the tab again). Dawn shares the Wind tab but is its own target.
 */
export type MechanismId = 'wind' | 'storm' | 'dawn';

/** Everything `actuate()` can drive: exactly the chapters. */
export type ActuationTarget = MechanismId;

/** Chapters unlock in this order; unregistered ones are skipped. */
export const CHAPTER_ORDER: readonly ActuationTarget[] = ['wind', 'storm', 'dawn'];

/** True for phases in which exactly one actuation target is unlocked. */
export function isChapterPhase(phase: GamePhase): phase is ActuationTarget {
  return (CHAPTER_ORDER as readonly string[]).includes(phase);
}

/**
 * boot → placing → settling → wind → storm → dawn → done (→ finale → seal →
 * free → closing, canon §1, once those systems exist). A chapter phase means
 * that target is the only one unlocked.
 */
export type GamePhase =
  | 'boot'
  | 'placing'
  | 'settling'
  | MechanismId
  | 'finale'
  | 'seal'
  | 'free'
  | 'closing'
  | 'done';

export interface GameSnapshot {
  phase: GamePhase;
  /** Chapters whose system emitted `mechanism:register`, in CHAPTER_ORDER. */
  registered: ActuationTarget[];
  completed: ActuationTarget[];
}

/** Pure reducer + bus subscription (src/core/game-state.ts, owner I). */
export interface GameStateApi {
  readonly phase: GamePhase;
  isUnlocked(target: ActuationTarget): boolean;
  snapshot(): GameSnapshot;
}

// ---------------------------------------------------------------------------
// Input (owner A)

/** Active interaction mode. M1 implements 'direct' only; the rest are M2. */
export type InputMode = 'direct' | 'ray' | 'scan' | 'dwell';

/** Who called actuate(). 'debug' = window.__indoor, 'auto' = M2 finale replay. */
export type ActuationSource = InputMode | 'debug' | 'auto';

export type InputDevice = 'hand' | 'controller' | 'none';

/**
 * Where the select edges came from this frame:
 * 'gamepad' = input.xr.gamepads[h] (IWER hands, controllers),
 * 'events'  = session selectstart/selectend queue (native Quest hands, per IWSDK 1.0.1),
 * 'distance'= thumb/index hysteresis (?pinch=distance escape hatch only).
 */
export type SelectPath = 'gamepad' | 'events' | 'distance' | 'none';

export type PinchState = 'idle' | 'armed' | 'pulling' | 'holding' | 'released';

export type ReleaseReason = 'release' | 'tracking-lost' | 'cancel';

/** One hand (or controller) per frame. Written by HandsSystem (-3.6). */
export interface HandSample {
  readonly handedness: Handedness;
  device: InputDevice;
  /** Primary source present and joints (hands) or grip (controllers) valid this frame. */
  tracked: boolean;
  /** Seconds since `tracked` was last true (0 while tracked). */
  lostFor: number;
  /** Start edge this frame after the palm-to-face veto. At most one edge per frame. */
  selectStart: boolean;
  selectEnd: boolean;
  /** Level state between start and end. */
  selecting: boolean;
  /** Start edge before the veto (diagnostics / HUD). */
  rawSelectStart: boolean;
  selectPath: SelectPath;
  /**
   * World pinch point: thumb-tip/index-tip midpoint (hands, One-Euro filtered
   * and re-seeded on every select start: input/pinch-filter.ts) or grip
   * origin (controllers). Use this one for everything.
   */
  readonly pinchPoint: Vec3;
  /** Unfiltered pinch point of the last tracked frame (diagnostics, test calibration). */
  readonly rawPinchPoint: Vec3;
  /** Thumb-tip to index-tip distance (m); NaN for controllers or when unknown. */
  tipDistance: number;
  /** Wrist (joint 0) to middle-finger-phalanx-proximal (joint 11) (m); 0.09 when unknown. */
  handScale: number;
  /** Unit vector out of the palm (world); zero vector when unknown. */
  readonly palmNormal: Vec3;
  /** palmNormal · unit(head - wrist). The veto fires above 0.7 with the hand raised. NaN when unknown. */
  palmToHead: number;
  /** head.y - wrist.y (m): how far below the eyes the hand is. NaN when unknown. */
  wristDrop: number;
  /** IWSDK getPinchStrength() 0..1, for affordances only (never for commits). */
  pinchStrength: number;
  /** 25 joint positions (world, XRHand order, x y z interleaved); valid only when `jointsValid`. */
  readonly joints: Float32Array;
  /** True when `joints` holds this frame's tracked hand (false for controllers). */
  jointsValid: boolean;
}

export interface HeadSample {
  valid: boolean;
  readonly position: Vec3;
  /** Horizontal forward, unit length, y = 0. */
  readonly forward: Vec3;
  yaw: number;
  /** Negative when looking down. */
  pitch: number;
}

export interface HandsState {
  readonly left: HandSample;
  readonly right: HandSample;
  readonly head: HeadSample;
}

/** Suggested pull for tests and the M2 ghost hand (world space). */
export interface HandleHint {
  readonly axis: Vec3;
  readonly travel: number;
}

/**
 * A grabbable control. Owned and updated every frame by its mechanism (C);
 * read by the arbiter (A). Kinematics live in `amountFor`, so the arbiter
 * stays generic: linear tab (M1), crank via atan2 (M2), flap hinge angle and
 * kite string (M3).
 */
export interface HandleSpec {
  readonly target: ActuationTarget;
  /** World point to pinch; follows the handle as it moves with progress. */
  readonly grabPoint: Vec3;
  /** A pinch must start within this distance of grabPoint (tab 0.035, kite string 0.08). */
  readonly grabRadius: number;
  /** False while sealed, settling or hidden. The arbiter also checks game.isUnlocked(). */
  readonly enabled: boolean;
  /**
   * Proposed absolute amount (before the ratchet, may exceed 0..1) for a pinch
   * that started at `start` when the ratchet was at `progressAtStart` and is
   * now at `now`. Pure, no allocation.
   */
  amountFor(start: Readonly<Vec3>, now: Readonly<Vec3>, progressAtStart: number): number;
  readonly hint: HandleHint | null;
  /**
   * End magnet: letting go (reason 'release') at or past this progress
   * completes the target, so nobody is left "almost there". Null = none.
   */
  readonly releaseSnapAt: number | null;
}

export interface HandleRegistry {
  /** Returns the unregister function. */
  register(handle: HandleSpec): () => void;
  /** Nearest enabled handle whose grabRadius contains `p`, or null. */
  nearest(p: Readonly<Vec3>, accept?: (h: HandleSpec) => boolean): HandleSpec | null;
  get(target: ActuationTarget): HandleSpec | null;
  all(): readonly HandleSpec[];
}

/**
 * The single entry point for every input mode: a ratchet per target that
 * never goes back. `actuate` is idempotent (same amount twice = no change)
 * and returns the progress after the call, also when the call is rejected.
 */
export interface ActuationService {
  actuate(target: ActuationTarget, amount: number, source: ActuationSource): number;
  progress(target: ActuationTarget): number;
  isComplete(target: ActuationTarget): boolean;
  /** Active mode. Calls from another InputMode are rejected ('debug'/'auto' always pass the mode check). */
  mode: InputMode;
  /** Rejected calls since boot (diagnostics). */
  readonly rejected: number;
  /** Calls from two different InputModes on the same target in one frame. Must stay 0. */
  readonly doubleActuations: number;
  /** M2: ?reset=1 and persistence restore. */
  reset(target?: ActuationTarget): void;
}

// ---------------------------------------------------------------------------
// Placement (owner B) and the box root (owner C)

export interface BoxPose {
  /** Bottom centre of the box, on the surface. */
  position: Vec3;
  yaw: number;
}

export type PlacementMode = 'idle' | 'probing' | 'hit-test' | 'fallback' | 'committed';

export type PlacementSource = 'hit-test' | 'fallback' | 'debug';

/** Why the latest hit was accepted or rejected (HUD and tests). */
export type HitVerdict =
  | 'ok'
  | 'none'
  | 'tilted'
  | 'floor'
  | 'too-high'
  | 'too-low'
  | 'too-near'
  | 'too-far';

export interface PlacementStatus {
  mode: PlacementMode;
  verdict: HitVerdict;
  /** A commit right now would succeed (stable valid hit, or fallback preview ready). */
  valid: boolean;
  stableFrames: number;
  /** Seconds since placing started. */
  elapsed: number;
  reticleVisible: boolean;
  /** Pose a select would commit now, or null. */
  readonly candidate: BoxPose | null;
}

export interface PlacementService {
  readonly status: Readonly<PlacementStatus>;
  /** Committed pose for this session, or null. */
  readonly pose: Readonly<BoxPose> | null;
  /**
   * Debug/tests: commit `pose`, or the current candidate when omitted.
   * Runs the same settle path as a real select. False if not in 'placing'.
   */
  commit(pose?: BoxPose): boolean;
}

/** What placement needs from the box (C implements it on its root Group). */
export interface BoxRootPort {
  /** World pose of the box root (bottom centre) and uniform scale. Copies the values. */
  setPose(pose: Readonly<BoxPose>, scale: number): void;
  setVisible(visible: boolean): void;
  /** Footprint in metres (box local axes). */
  readonly size: Readonly<Vec3>;
  /** Last values applied (debug API). */
  readonly pose: Readonly<BoxPose>;
  readonly scale: number;
  readonly visible: boolean;
}

// ---------------------------------------------------------------------------
// Events

export type XRVisibility = 'visible' | 'visible-blurred' | 'hidden' | 'non-immersive';

export type PlacementModeReason =
  | 'start'
  | 'no-hit-test'
  | 'timeout'
  | 'surface-found'
  | 'commit';

export type ActuationRejectReason = 'locked' | 'mode' | 'hidden' | 'invalid';

export type GameEvent =
  // lifecycle (I)
  | { type: 'session:start' }
  | { type: 'session:end' }
  | { type: 'visibility'; state: XRVisibility }
  | { type: 'phase'; from: GamePhase; to: GamePhase }
  // placement (B)
  | { type: 'placement:mode'; mode: PlacementMode; reason: PlacementModeReason }
  | { type: 'placement:commit'; source: PlacementSource; pose: BoxPose }
  | { type: 'box:placed'; pose: BoxPose }
  // input and actuation (A)
  | { type: 'pinch'; hand: Handedness; from: PinchState; to: PinchState }
  | { type: 'veto'; hand: Handedness; reason: 'palm-to-face' }
  | { type: 'handle:grab'; hand: Handedness; target: ActuationTarget }
  | { type: 'handle:release'; hand: Handedness; target: ActuationTarget; reason: ReleaseReason }
  | { type: 'actuate:reject'; target: ActuationTarget; source: ActuationSource; reason: ActuationRejectReason }
  | { type: 'notch'; target: ActuationTarget; index: number; progress: number }
  | { type: 'mechanism:complete'; target: ActuationTarget }
  // mechanisms (C)
  | { type: 'mechanism:register'; id: ActuationTarget }
  | { type: 'wind:gust'; group: number; leaves: number }
  // storm (storm/storm-system.ts)
  | { type: 'storm:reveal' }
  | { type: 'storm:rain' }
  | { type: 'storm:thunder' }
  | { type: 'storm:shelter'; on: boolean }
  /** `print`: storm/print.ts run-length bits (empty when no shape was kept). */
  | { type: 'storm:print'; dry: number; print: string }
  | { type: 'storm:over' };

export type GameEventType = GameEvent['type'];
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

export interface EventStamp {
  /** FrameClock.time when emitted. */
  t: number;
  frame: number;
}

export type LoggedEvent = GameEvent & EventStamp;

/**
 * Synchronous typed bus (src/core/events.ts, owner I). An emit during
 * dispatch is queued and delivered after the current handlers (FIFO).
 */
export interface EventBus {
  emit(event: GameEvent): void;
  on<T extends GameEventType>(type: T, handler: (event: GameEventOf<T> & EventStamp) => void): () => void;
  onAny(handler: (event: LoggedEvent) => void): () => void;
  /** Ring buffer of the latest 256 events, oldest first (debug API). */
  readonly log: readonly LoggedEvent[];
  clearLog(): void;
}

// ---------------------------------------------------------------------------
// Settings (M2) and quality (M3): reserved so M1 interfaces need no changes.

export interface Settings {
  mode: InputMode;
  highContrast: boolean;
  /** Scanning ring step (s), 1..3. */
  scanIntervalS: number;
  /** Scanning: hold the pinch instead of a short tap. */
  holdToScan: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  mode: 'direct',
  highContrast: false,
  scanIntervalS: 1.5,
  holdToScan: false,
};

/** 0 = high, 1 = medium (boot default), 2 = low. */
export type QualityLevel = 0 | 1 | 2;

/** Anything the M3 governor can scale (leaf count, fbm octaves, rain density). */
export interface Qualityable {
  setQuality(level: QualityLevel): void;
}

// ---------------------------------------------------------------------------
// Debug

export type DebugValue = number | string | boolean;

/** Module-specific numbers for state().probes (e.g. probes.wind = { gusts, leavesReleased }). */
export type DebugProbe = () => Record<string, DebugValue>;

/** Return type of window.__indoor.state(). JSON-serialisable only. */
export interface DebugSnapshot {
  // M0
  inSession: boolean;
  visibility: string;
  audio: string;
  drawCalls: number;
  triangles: number;
  // M1
  frame: number;
  time: number;
  phase: GamePhase;
  head: { valid: boolean; position: Vec3Tuple; yawDeg: number; pitchDeg: number };
  placement: {
    mode: PlacementMode;
    verdict: HitVerdict;
    valid: boolean;
    stableFrames: number;
    elapsed: number;
    reticleVisible: boolean;
    candidate: { position: Vec3Tuple; yawDeg: number } | null;
  };
  box: { placed: boolean; settling: boolean; visible: boolean; position: Vec3Tuple; yawDeg: number; scale: number } | null;
  mechanisms: Record<MechanismId, { registered: boolean; unlocked: boolean; progress: number; complete: boolean }>;
  hands: Record<
    Handedness,
    {
      device: InputDevice;
      tracked: boolean;
      fsm: PinchState;
      owner: ActuationTarget | null;
      selectPath: SelectPath;
      selecting: boolean;
      pinchPoint: Vec3Tuple;
      tipDistance: number;
      palmToHead: number;
    }
  >;
  input: { mode: InputMode; rejected: number; doubleActuations: number };
  probes: Record<string, Record<string, DebugValue>>;
}

// ---------------------------------------------------------------------------
// Context injected into every system: registerSystem(Sys, { priority, configData: { ctx } })

/** Per-hand arbitration state exposed by the arbiter (A) for debug and M2 UI. */
export interface ArbiterView {
  stateOf(hand: Handedness): { fsm: PinchState; owner: ActuationTarget | null };
}

export interface AppContext {
  readonly flags: Flags;
  readonly settings: Settings;
  readonly clock: FrameClock;
  readonly bus: EventBus;
  readonly game: GameStateApi;
  /** Written by HandsSystem (A); read-only for everyone else. */
  readonly hands: HandsState;
  readonly handles: HandleRegistry;
  readonly actuation: ActuationService;
  /** Set by ArbiterSystem.init() (A). */
  arbiter: ArbiterView | null;
  /** Set by PlacementSystem.init() (B). */
  placement: PlacementService | null;
  /** Box root created by C, posed by B. */
  readonly box: BoxRootPort;
  /** Session visibilityState === 'visible'. Input and actuation are ignored otherwise. */
  visible(): boolean;
  /** Filled by each module in init(); read by the debug API. */
  readonly probes: Record<string, DebugProbe>;
}
