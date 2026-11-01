/**
 * Seeded hand-tracking noise for the pinch tests. PURE, deterministic.
 *
 * noisyPull() renders one scripted pinch-and-pull as 72 Hz app frames the way
 * a headset delivers it: thumb and index tips with isotropic gaussian noise
 * (3D RMS = jitterM per tip), seen through a latency line, sampled and held
 * at the tracking rate (each new sample draws fresh noise; frames in between
 * repeat the last sample exactly).
 *
 * Script (true hand): open 0.5 s (tips 6 cm apart) → close in 70 ms to 0.4 cm
 * → hold 2 s while the hand moves 6 cm along +Z → open in 70 ms → open 0.5 s.
 */
import type { Vec3 } from '../../../src/core/types.ts';

/** mulberry32: tiny, fast, good enough for test noise. Returns [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal samples (Box–Muller) from a uniform source. */
export function gaussian(rand: () => number): () => number {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u <= Number.EPSILON) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

export interface PullScript {
  openS: number;
  closeS: number;
  holdS: number;
  openingS: number;
  tailS: number;
  /** Tip distance with the hand open / closed (m). */
  openM: number;
  closedM: number;
  /** Hand travel along +Z during the hold (m). */
  travelM: number;
}

export const PULL_SCRIPT: Readonly<PullScript> = {
  openS: 0.5,
  closeS: 0.07,
  holdS: 2,
  openingS: 0.07,
  tailS: 0.5,
  openM: 0.06,
  closedM: 0.004,
  travelM: 0.06,
};

/** Key instants of the true (undelayed) script, seconds from t = 0. */
export interface PullTimeline {
  closeStart: number;
  closeEnd: number;
  openStart: number;
  openEnd: number;
  end: number;
}

export function pullTimeline(s: Readonly<PullScript> = PULL_SCRIPT): PullTimeline {
  const closeStart = s.openS;
  const closeEnd = closeStart + s.closeS;
  const openStart = closeEnd + s.holdS;
  const openEnd = openStart + s.openingS;
  return { closeStart, closeEnd, openStart, openEnd, end: openEnd + s.tailS };
}

export interface NoisyPullOptions {
  seed: number;
  /** Per-tip 3D RMS of the noise (m). */
  jitterM: number;
  latencyS: number;
  sampleHz: number;
  frameHz: number;
  script?: Readonly<PullScript>;
}

export interface NoisyFrame {
  time: number;
  /** Measured thumb-tip ↔ index-tip distance (repeats exactly between samples). */
  tipDistance: number;
  /** Measured tip midpoint. */
  readonly pinchPoint: Vec3;
  /** Noise-free, undelayed tip distance at `time` (for reference only). */
  trueDistance: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.min(1, Math.max(0, t));

/** True tip distance and hand Z at time t. */
function truth(t: number, s: Readonly<PullScript>, tl: PullTimeline): { d: number; z: number } {
  let d: number;
  if (t < tl.closeStart) d = s.openM;
  else if (t < tl.closeEnd) d = lerp(s.openM, s.closedM, (t - tl.closeStart) / s.closeS);
  else if (t < tl.openStart) d = s.closedM;
  else if (t < tl.openEnd) d = lerp(s.closedM, s.openM, (t - tl.openStart) / s.openingS);
  else d = s.openM;
  const z = lerp(0, s.travelM, (t - tl.closeEnd) / s.holdS);
  return { d, z };
}

export function noisyPull(o: NoisyPullOptions): { frames: NoisyFrame[]; timeline: PullTimeline } {
  const s = o.script ?? PULL_SCRIPT;
  const tl = pullTimeline(s);
  const rand = mulberry32(o.seed);
  const normal = gaussian(rand);
  const sigma = o.jitterM / Math.sqrt(3); // per axis, so the 3D RMS is jitterM
  const samplePeriod = 1 / o.sampleHz;
  // Tracking and rendering clocks are not aligned: random sample phase per run.
  let nextSample = rand() * samplePeriod;
  // Held measured tips: the hand moves along +Z, the tips open along X.
  const thumb: Vec3 = { x: 0, y: 0, z: 0 };
  const index: Vec3 = { x: 0, y: 0, z: 0 };

  const takeSample = (sampleTime: number): void => {
    const { d, z } = truth(sampleTime - o.latencyS, s, tl);
    thumb.x = -d / 2 + sigma * normal();
    thumb.y = sigma * normal();
    thumb.z = z + sigma * normal();
    index.x = d / 2 + sigma * normal();
    index.y = sigma * normal();
    index.z = z + sigma * normal();
  };
  // The sample in flight when the first frame starts.
  takeSample(nextSample - samplePeriod);

  const frames: NoisyFrame[] = [];
  const count = Math.ceil(tl.end * o.frameHz);
  for (let f = 0; f <= count; f++) {
    const time = f / o.frameHz;
    while (nextSample <= time) {
      takeSample(nextSample);
      nextSample += samplePeriod;
    }
    frames.push({
      time,
      tipDistance: Math.hypot(thumb.x - index.x, thumb.y - index.y, thumb.z - index.z),
      pinchPoint: { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2, z: (thumb.z + index.z) / 2 },
      trueDistance: truth(time, s, tl).d,
    });
  }
  return { frames, timeline: tl };
}
