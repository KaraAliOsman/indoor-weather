/**
 * Night mechanism ("Farol"): lamp cord pulled down in 4 clicks. PURE module
 * (no three, no @iwsdk/core).
 *
 * - The cord bead is a LinearHandle along world -Y (travel 5 cm). The
 *   ActuationService ratchet owns progress (notches 0.25/0.5/0.75, snap at
 *   0.98); a half pull stays where it was (the cord works as a dimmer).
 * - NightModel turns that progress into the veil state: the dark edge closes
 *   from beyond the room's periphery to the pool (30 deg) following
 *   easeInOutSine(p), rate-limited to 70 deg/s (Calm 40 deg/s), so a full
 *   close never takes less than 3 s even if the pull is instantaneous.
 * - The front is 60 deg wide (experiencia says 35): at 70 deg/s a 35 deg band
 *   swings a pixel 0.53 alpha in 333 ms and ~0.03 per frame, over the F1 limit
 *   (arte.md §10: <= 0.40 per 333 ms window). 60 deg gives ~0.35 and a
 *   10->90 % ramp of ~0.5 s per pixel. The open edge sits a full band past the
 *   farthest direction (180 deg + ink noise), so the veil starts at alpha 0
 *   everywhere instead of popping in behind the head.
 * - Mode switches (Calm / high contrast) ease the caps (<= 0.3 alpha/s)
 *   instead of stepping the whole room.
 * - Milestones are reported exactly once: start, crickets (p >= 0.6), pool
 *   (the warm pool tint starts) and closed (edge reached the pool).
 * - veilAlpha() mirrors the veil fragment shader (render/glsl/night.ts) so
 *   caps and flash safety are unit-tested on the CPU.
 *
 * Accessibility: alpha is capped (0.62, Calm/high contrast 0.45), the pool is
 * permanent (alpha <= 0.15, 0.10 soft) and every change is a continuous ramp:
 * nothing in here can flash.
 */
import type { ActuationTarget, Vec3 } from '../core/types.ts';
import type { RatchetConfig } from '../input/ratchet.ts';
import { createLinearHandle, type LinearHandle } from './linear-handle.ts';

export const NIGHT = {
  /** Full pull of the bead (m), 4 clicks. */
  travelM: 0.05,
  grabRadiusM: 0.035,
  /** Edge angle (deg from the head-to-pool direction) when open and when closed. */
  edgeOpenDeg: 180 + 5 + 60,
  edgeClosedDeg: 30,
  /** Width of the dark front (deg); mirrored by VEIL_BAND in the shader. */
  edgeBandDeg: 60,
  /** Ink-edge noise amplitude (deg); mirrored in the shader. */
  edgeNoiseDeg: 5,
  maxEdgeSpeedDegS: 70,
  calmEdgeSpeedDegS: 40,
  /** Veil alpha cap at the periphery, normal and Calm / high contrast. */
  veilMax: 0.62,
  veilMaxSoft: 0.45,
  /** Alpha inside the warm pool (hands and table stay visible). */
  poolAlpha: 0.15,
  poolAlphaSoft: 0.1,
  /** The pool ends at poolDeg; full night alpha from nightRampDeg. */
  poolDeg: 12,
  nightRampDeg: 30,
  /** Extra alpha towards the zenith (sky). */
  skyAlpha: 0.06,
  /** Max cap change on a mode switch (alpha/s). */
  capRate: 0.3,
  /** Ink lip on the moving front, at full edge speed. */
  lipAlpha: 0.05,
  cricketsAt: 0.6,
  /** The pool tint ramps in over level 0.8..1. */
  poolTintFrom: 0.8,
} as const;

/** Ratchet config for the night target (same notch layout as the 4-click cord). */
export const NIGHT_RATCHET: Readonly<RatchetConfig> = { notches: [0.25, 0.5, 0.75], completeAt: 0.98 };

/** Pull axis in world space: the bead goes down. */
export const NIGHT_PULL_AXIS: Readonly<Vec3> = { x: 0, y: -1, z: 0 };

/** Legacy night bead (canon v2 retired the chapter; the veil model is reused by the storm). */
export function createNightHandle(target: ActuationTarget = 'storm'): LinearHandle {
  return createLinearHandle({ target, travel: NIGHT.travelM, grabRadius: NIGHT.grabRadiusM });
}

export type NightMilestone = 'start' | 'crickets' | 'pool' | 'closed';
const MILESTONES: readonly NightMilestone[] = ['start', 'crickets', 'pool', 'closed'];

/** Reused by step(): read it before the next call. */
export interface NightState {
  /** Ratchet progress the model is following (0..1, never decreases). */
  target: number;
  /** Displayed darkness 0..1 = easeInOutSine of the progress, rate-limited. */
  level: number;
  /** Current edge angle (deg). */
  edgeDeg: number;
  /** Smoothed |dEdge/dt| (deg/s) for the ink lip; eases in and out, never jumps. */
  lipSpeed: number;
  /** Warm pool tint 0..1. */
  inner: number;
  /** Alpha caps for the current mode (eased towards the mode targets by step()). */
  veilMax: number;
  poolAlpha: number;
  /** Milestones reached by this step, in order. */
  milestones: readonly NightMilestone[];
}

export interface NightModelOptions {
  /** Calm mode: slower close and lower cap. */
  calm?: boolean;
  /** High contrast: lower cap (same close speed). */
  highContrast?: boolean;
}

export interface NightModel {
  readonly state: Readonly<NightState>;
  /** Follows actuation.progress('night'): running max of clamp01, non-finite ignored. */
  setTarget(progress: number): void;
  /** Advances the edge (dt in s, clamped to [0, 0.1]). */
  step(dt: number): NightState;
  setMode(o: NightModelOptions): void;
  /** Persistence / ?reset=1: jumps without a ramp (milestones at or below `progress` count as passed). */
  reset(progress?: number): void;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const LIP_RATE = 4;

export function easeInOutSine(p: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(p));
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Edge angle for a darkness level (0 = open, 1 = closed). */
export function edgeForLevel(level: number): number {
  return NIGHT.edgeOpenDeg + (NIGHT.edgeClosedDeg - NIGHT.edgeOpenDeg) * clamp01(level);
}

export function createNightModel(o: NightModelOptions = {}): NightModel {
  let calm = !!o.calm;
  let soft = calm || !!o.highContrast;
  let passed = 0;
  const reached: NightMilestone[] = [];
  const s: NightState = {
    target: 0,
    level: 0,
    edgeDeg: NIGHT.edgeOpenDeg,
    lipSpeed: 0,
    inner: 0,
    veilMax: NIGHT.veilMax,
    poolAlpha: NIGHT.poolAlpha,
    milestones: reached,
  };

  const capTarget = (): number => (soft ? NIGHT.veilMaxSoft : NIGHT.veilMax);
  const poolTarget = (): number => (soft ? NIGHT.poolAlphaSoft : NIGHT.poolAlpha);
  const applyMode = (): void => {
    s.veilMax = capTarget();
    s.poolAlpha = poolTarget();
  };
  const approach = (v: number, goal: number, maxStep: number): number =>
    v < goal ? Math.min(goal, v + maxStep) : Math.max(goal, v - maxStep);
  const hit = (m: NightMilestone, record: boolean): void => {
    const bit = 1 << MILESTONES.indexOf(m);
    if (passed & bit) return;
    passed |= bit;
    if (record) reached.push(m);
  };
  const checkMilestones = (record: boolean): void => {
    if (s.level > 0) hit('start', record);
    if (s.target >= NIGHT.cricketsAt) hit('crickets', record);
    if (s.inner > 0) hit('pool', record);
    if (s.level >= 1) hit('closed', record);
  };
  applyMode();

  return {
    state: s,
    setTarget(progress) {
      if (!Number.isFinite(progress)) return;
      const p = clamp01(progress);
      if (p > s.target) s.target = p;
    },
    step(dt) {
      reached.length = 0;
      const h = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      const goal = edgeForLevel(easeInOutSine(s.target));
      const maxStep = (calm ? NIGHT.calmEdgeSpeedDegS : NIGHT.maxEdgeSpeedDegS) * h;
      const prev = s.edgeDeg;
      // The edge only closes (the ratchet never goes back).
      s.edgeDeg = goal < prev ? Math.max(goal, prev - maxStep) : prev;
      if (s.edgeDeg - NIGHT.edgeClosedDeg < 1e-9) s.edgeDeg = NIGHT.edgeClosedDeg;
      const speed = h > 0 ? (prev - s.edgeDeg) / h : 0;
      s.lipSpeed += (speed - s.lipSpeed) * (1 - Math.exp(-h * LIP_RATE));
      s.level = clamp01((NIGHT.edgeOpenDeg - s.edgeDeg) / (NIGHT.edgeOpenDeg - NIGHT.edgeClosedDeg));
      s.inner = smoothstep(NIGHT.poolTintFrom, 1, s.level);
      // A mode switch mid-night eases the caps: a step would swing the whole room at once.
      s.veilMax = approach(s.veilMax, capTarget(), NIGHT.capRate * h);
      s.poolAlpha = approach(s.poolAlpha, poolTarget(), NIGHT.capRate * h);
      checkMilestones(true);
      return s;
    },
    setMode(m) {
      calm = !!m.calm;
      soft = calm || !!m.highContrast;
      // Daytime (veil hidden): nothing to ease, take the caps at once.
      if (s.level <= 0) applyMode();
    },
    reset(progress = 0) {
      s.target = Number.isFinite(progress) ? clamp01(progress) : 0;
      s.level = easeInOutSine(s.target);
      s.edgeDeg = edgeForLevel(s.level);
      s.lipSpeed = 0;
      s.inner = smoothstep(NIGHT.poolTintFrom, 1, s.level);
      applyMode();
      passed = 0;
      reached.length = 0;
      checkMilestones(false);
    },
  };
}

/**
 * CPU mirror of the veil alpha (NIGHT_VEIL_FRAG before dithering and spark
 * holes). thetaDeg: angle between the view direction and the head-to-pool
 * direction; noiseDeg: ink-edge offset (+-5 deg in the shader); dirY: view
 * direction's world Y.
 */
export function veilAlpha(
  thetaDeg: number,
  noiseDeg: number,
  dirY: number,
  st: Readonly<Pick<NightState, 'edgeDeg' | 'lipSpeed' | 'inner' | 'veilMax' | 'poolAlpha'>>,
): number {
  const t = thetaDeg + noiseDeg;
  const outer = smoothstep(st.edgeDeg - NIGHT.edgeBandDeg, st.edgeDeg, t);
  const night = st.poolAlpha + (st.veilMax - st.poolAlpha) * smoothstep(NIGHT.poolDeg, NIGHT.nightRampDeg, thetaDeg);
  const sky = NIGHT.skyAlpha * smoothstep(0, 0.5, dirY);
  const g = (t - st.edgeDeg + 12) / 6;
  const lip = NIGHT.lipAlpha * Math.exp(-g * g) * Math.min(Math.abs(st.lipSpeed) / NIGHT.maxEdgeSpeedDegS, 1);
  const a = Math.max(outer * (night + sky), st.inner * st.poolAlpha) + lip * outer;
  // Inside the pool the cap is the pool alpha: hands are always visible.
  const cap = thetaDeg < NIGHT.poolDeg ? st.poolAlpha : st.veilMax;
  return Math.min(a, cap);
}

/** Stars fade in over level 0.6..1 (eased, never popped). */
export const NIGHT_STAR_FROM = 0.6;
const STAR_RATE = 2;

/**
 * Eased star visibility for the veil view. dt is sanitised like step()
 * (non-finite -> 0, clamped to [0, 0.1]) so a hitch or a NaN never pops the
 * sky or poisons the uniform.
 */
export function nightStarVisibility(prev: number, level: number, dt: number): number {
  const p = Number.isFinite(prev) ? clamp01(prev) : 0;
  const l = Number.isFinite(level) ? clamp01(level) : 0;
  const h = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
  const target = l <= NIGHT_STAR_FROM ? 0 : (l - NIGHT_STAR_FROM) / (1 - NIGHT_STAR_FROM);
  return p + (target - p) * (1 - Math.exp(-h * STAR_RATE));
}

/** True when x, y, z are all finite (tracking loss can hand us NaN poses). */
export function finiteVec3(v: Readonly<Vec3>): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/** Spark intensity for the veil holes: non-finite -> 0, clamped to [0, 1]. */
export function sparkIntensity(w: number): number {
  return Number.isFinite(w) ? clamp01(w) : 0;
}

/** One paper star: unit direction in the sky frame (-Z = towards the box) and angular radius (rad). */
export interface NightStar {
  readonly dir: Vec3;
  readonly size: number;
}

/**
 * Six-star "kite" constellation (diamond + tail), sky frame, low over the
 * box: a quiet nod to the chapter that follows. Links: 0-1-2-3-0, 0-2, 2-4-5.
 */
const KITE: ReadonlyArray<readonly [number, number, number]> = [
  // [azimuth deg (0 = towards the box, + = right), elevation deg, size mrad]
  [-4, 34, 9],
  [4, 29, 7],
  [-1, 21, 8],
  [-11, 27, 7],
  [3, 15, 5],
  [-2, 10, 5],
];
export const NIGHT_STAR_COUNT = 24;
export const NIGHT_KITE_STARS = KITE.length;

function dirFrom(azDeg: number, elDeg: number): Vec3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) };
}

/** mulberry32 (T. Ettinger, public domain): seeded so every session sees the same sky. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The night sky: the kite constellation first, then sparse scattered stars in
 * the upper hemisphere (elevation 12..70 deg), kept 6 deg away from each other.
 */
export function nightStars(seed = 0x5ba2, count = NIGHT_STAR_COUNT): NightStar[] {
  const out: NightStar[] = KITE.map(([az, el, mrad]) => ({ dir: dirFrom(az, el), size: mrad / 1000 }));
  const rand = mulberry32(seed);
  const minDot = Math.cos((6 * Math.PI) / 180);
  for (let tries = 0; out.length < count && tries < 2000; tries++) {
    const d = dirFrom(-180 + rand() * 360, 12 + rand() * 58);
    if (out.some((s) => s.dir.x * d.x + s.dir.y * d.y + s.dir.z * d.z > minDot)) continue;
    out.push({ dir: d, size: (3 + rand() * 3) / 1000 });
  }
  return out;
}
