/**
 * Storm mechanism logic. PURE module (no three, no IWSDK): the view and the
 * system feed it hand amounts and frame times, it answers with what to draw.
 *
 * Gesture (direccion/experiencia.md B4, interaccion.md H3): the cloud tag is
 * pinched and pulled up +Y. The cloud grows from the lid slot following the
 * hand; rain starts above p 0.35. Releasing at p >= 0.6 floats the cloud to
 * its place and auto-completes (actuate 'auto', D11); releasing below springs
 * the tag back to the slot with no penalty.
 *
 * Body: 30 s of storyTime from the moment the cloud settles (T_s0). Rain ramps
 * to 100% in 2 s, the cloud empties with a cosine from +22 s and three fat
 * last drops fall before the end. storyTime only runs while the user attends;
 * otherwise rain eases down to 30%.
 *
 * Lightning is OFF by default: direccion/arte.md F5 says "no visual
 * lightning, thunder = audio + 1-2 mm shake". `lightning: true` opts into a
 * soft glow inside the cloud (raised cosine, >= 2.8 s long, peak 0.06, slope
 * <= 0.1/s, >= 3 s apart), far below WCAG 2.3.1 (<= 3 flashes/s) and the
 * experience rule "global dL <= 10%/s, no opposite pair > 0.1 within 333 ms".
 */

export const STORM = {
  /** Visual travel of the tag (m). */
  travelM: 0.08,
  /** Hand travel that maps to p 0..1 (m). */
  handM: 0.08,
  /** Rain starts above this pull. */
  rainStartP: 0.35,
  /** Releasing at or above this pull floats the cloud and auto-completes. */
  floatAtP: 0.6,
  /** Tag spring back to the slot when released early (s). */
  returnS: 0.4,
  /** Cloud float to its resting height (s, critical spring). */
  floatS: 0.6,
  /** Cloud inflate to scale 1 after release (s, easeOutCubic). */
  inflateS: 1.2,
  /** Height of the floating cloud above the table (m). */
  cloudHeightM: 0.3,
  /** Storm body length (s of storyTime from T_s0). */
  bodyS: 30,
  /** Rain ramp to 100% at the start of the body (s). */
  rampS: 2,
  /** The cloud empties between these body times (s, cosine). */
  drainStartS: 22,
  drainEndS: 28,
  /** Cloud scale at the end of the drain. */
  drainedScale: 0.55,
  /** Distant thunder (audio + 2 mm box shake), body time (s). */
  thunderS: [6, 16] as readonly number[],
  /** The last three fat drops, body time (s). */
  lastDropsS: [28.5, 29.2, 30.0] as readonly number[],
  /** Rain level while the user looks away. */
  inattentiveRain: 0.3,
  /** Attention easing rate (1/s): about 1 s to settle, never a step. */
  attentionRate: 2.5,
  /** Drops per quality level L0 / L1 / L2. */
  drops: [900, 600, 300] as readonly number[],
} as const;


/** Lightning glow envelope: a raised cosine up, a longer raised cosine down. */
export const GLOW = {
  riseS: 1.0,
  fallS: 1.8,
  /** Peak extra luminance of the cloud (fraction of its base). */
  peak: 0.06,
  /** Minimum start-to-start spacing between two glows (s). */
  minGapS: 3.0,
  /** A glow starts this long before its thunder (light before sound). */
  leadS: 0.6,
  /** Extra distant glows (no thunder) placed by the seed. */
  extra: 2,
} as const;

export type StormPhase = 'idle' | 'pulling' | 'returning' | 'floating' | 'body' | 'done';

export type StormEvent =
  | { type: 'rain-start' }
  | { type: 'auto-complete' }
  | { type: 'return' }
  | { type: 'body' }
  | { type: 'thunder'; index: number }
  | { type: 'glow'; index: number }
  | { type: 'last-drop'; index: number }
  | { type: 'done' };

export interface Glow {
  /** Body time at which the glow starts rising (s). */
  readonly at: number;
  readonly riseS: number;
  readonly fallS: number;
  readonly peak: number;
}

/** Reused by update(): read it before the next call. */
export interface StormFrame {
  phase: StormPhase;
  /** Tag pull 0..1 (follows the hand while pulling, springs back otherwise). */
  pull: number;
  /** Cloud scale (0.3 at the slot .. 1 .. 0.55 drained). */
  cloudScale: number;
  /** Cloud float progress 0 (slot) .. 1 (resting height). */
  cloudLift: number;
  /** Rain density 0..1 after attention (drives drop count and audio). */
  density: number;
  /** Soft lightning glow 0..GLOW.peak (cloud and rain tint); always 0 unless `lightning`. */
  glow: number;
  /** Body storyTime (s); 0 before the body. */
  bodyTime: number;
  events: StormEvent[];
}

export interface Storm {
  readonly phase: StormPhase;
  readonly schedule: readonly Glow[];
  /** Pinch on the tag. Ignored outside idle/returning. */
  grab(): void;
  /** Hand amount 0..1 (stormAmount). Ignored unless pulling. */
  drag(amount: number): void;
  /** Pinch end. Returns true when it auto-completes. */
  release(): boolean;
  update(dt: number, attending: boolean): StormFrame;
  /** M2: ?reset=1 / persistence. `completed` jumps straight to done. */
  reset(completed?: boolean): void;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Critical-spring value at floatS (w = 6), used to land the float on 1. */
const FLOAT_END = 1 - 7 * Math.exp(-6);

const easeOutCubic = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
/** Raised cosine 0..1 over t 0..1: zero slope at both ends. */
const cosEase = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

/** Hand delta along +Y to pull amount. Non-finite input reads as 0. */
export function stormAmount(startY: number, nowY: number, handM: number = STORM.handM): number {
  const p = (nowY - startY) / handM;
  return Number.isFinite(p) ? clamp01(p) : 0;
}

/** Cloud scale while pulling: grows from the slot following the hand. */
export const cloudScaleForPull = (p: number): number => 0.3 + 0.7 * easeOutCubic(p);

/** Rain density while pulling. */
export const pullDensity = (p: number): number => smoothstep(STORM.rainStartP, 1, p);

/** Rain density over the body, starting from `from` (density at release) so it never jumps. */
export function bodyDensity(t: number, from = 0): number {
  if (t <= 0) return from;
  if (t < STORM.rampS) return from + (1 - from) * cosEase(t / STORM.rampS);
  if (t < STORM.drainStartS) return 1;
  return 1 - cosEase((t - STORM.drainStartS) / (STORM.drainEndS - STORM.drainStartS));
}

/** Cloud scale over the body (the cloud is the clock). */
export function bodyCloudScale(t: number): number {
  const k = cosEase((t - STORM.drainStartS) / (STORM.drainEndS - STORM.drainStartS));
  return 1 + (STORM.drainedScale - 1) * k;
}

/** Drops drawn at a quality level (0..2). */
export const rainCountForQuality = (level: number): number =>
  STORM.drops[Math.min(STORM.drops.length - 1, Math.max(0, Math.trunc(level) || 0))];

/**
 * Rank scale for the shader thinning (uRankScale): the governor draws only the
 * first instanceCount drops, whose ranks span [0, count / max), so the rank is
 * stretched back to [0, 1) and density keeps meaning "fraction drawn".
 */
export const rainRankScale = (level: number): number => STORM.drops[0] / rainCountForQuality(level);

/**
 * Per-drop seeds (aSeed, vec4 U[0,1)): x/y place the drop in the column
 * ellipse, z its phase and speed, w its stratified density rank.
 */
export function rainSeeds(count: number, seed = 0x9a1a): Float32Array {
  const rand = mulberry32(seed);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = rand();
    seeds[i * 4 + 1] = rand();
    seeds[i * 4 + 2] = rand();
    // Stratified rank: any density keeps an even share of the column.
    seeds[i * 4 + 3] = (i + rand()) / count;
  }
  return seeds;
}

/** CPU twin of the shader thinning: drops visible among the first `drawn`. */
export function rainVisibleCount(seeds: Float32Array, drawn: number, density: number, rankScale: number): number {
  let n = 0;
  for (let i = 0; i < drawn; i++) if (seeds[i * 4 + 3] * rankScale < density) n++;
  return n;
}

/** mulberry32: small deterministic PRNG, U[0,1). */
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

/**
 * Deterministic glow schedule (body time). One glow leads each thunder; the
 * seed jitters up to GLOW.extra distant ones in the gaps after them. Every pair keeps
 * GLOW.minGapS start-to-start, which is longer than one envelope, so glows
 * never overlap. Everything ends before the drain.
 */
export function createGlowSchedule(seed = 0x5707): Glow[] {
  const mk = (at: number): Glow => ({ at, riseS: GLOW.riseS, fallS: GLOW.fallS, peak: GLOW.peak });
  const lead = STORM.thunderS.map((t) => t - GLOW.leadS);
  const starts = [...lead];
  const rand = mulberry32(seed);
  const end = STORM.drainStartS - GLOW.riseS - GLOW.fallS;
  // One distant glow may follow each thunder glow, in a window that always
  // keeps minGapS from both neighbours: the seed only jitters inside it.
  for (let i = 0; i < lead.length && starts.length < lead.length + GLOW.extra; i++) {
    const lo = lead[i] + GLOW.minGapS;
    const hi = Math.min(i + 1 < lead.length ? lead[i + 1] - GLOW.minGapS : end, lo + 1);
    if (hi < lo) continue;
    starts.push(Math.round((lo + rand() * (hi - lo)) * 100) / 100);
  }
  return starts.sort((a, b) => a - b).map(mk);
}

/** Glow luminance at body time t (0 outside every envelope). */
export function glowAt(schedule: readonly Glow[], t: number): number {
  let g = 0;
  for (const s of schedule) {
    const u = t - s.at;
    if (u <= 0 || u >= s.riseS + s.fallS) continue;
    const v = u < s.riseS ? cosEase(u / s.riseS) : 1 - cosEase((u - s.riseS) / s.fallS);
    g = Math.max(g, s.peak * v);
  }
  return g;
}

export interface StormOptions {
  seed?: number;
  /** Soft lightning glow (default false: arte.md F5, no visual lightning). */
  lightning?: boolean;
}

export function createStorm(opts: StormOptions = {}): Storm {
  const schedule = createGlowSchedule(opts.seed);
  const lightning = opts.lightning === true;
  let phase: StormPhase = 'idle';
  let pull = 0;
  let releasePull = 0;
  let releaseDensity = 0;
  let phaseTime = 0;
  let sinceRelease = 0;
  let bodyTime = 0;
  let attention = 1;
  let rainStarted = false;
  const events: StormEvent[] = [];
  /** Events raised by release() between two updates. */
  const pending: StormEvent[] = [];
  const out: StormFrame = {
    phase, pull: 0, cloudScale: 0.3, cloudLift: 0, density: 0, glow: 0, bodyTime: 0, events,
  };

  const enter = (p: StormPhase): void => {
    phase = p;
    phaseTime = 0;
  };

  /** Fires every scheduled event in (prev, now]. Plain loops: no closures per frame. */
  const fire = (prev: number, now: number): void => {
    const thunder = STORM.thunderS;
    for (let index = 0; index < thunder.length; index++) {
      if (prev < thunder[index] && thunder[index] <= now) events.push({ type: 'thunder', index });
    }
    if (lightning) {
      for (let index = 0; index < schedule.length; index++) {
        if (prev < schedule[index].at && schedule[index].at <= now) events.push({ type: 'glow', index });
      }
    }
    const drops = STORM.lastDropsS;
    for (let index = 0; index < drops.length; index++) {
      if (prev < drops[index] && drops[index] <= now) events.push({ type: 'last-drop', index });
    }
  };

  return {
    get phase() {
      return phase;
    },
    schedule,
    grab() {
      if (phase === 'idle' || phase === 'returning') enter('pulling');
    },
    drag(amount) {
      if (phase !== 'pulling' || !Number.isFinite(amount)) return;
      pull = clamp01(amount);
    },
    release() {
      if (phase !== 'pulling') return false;
      releasePull = pull;
      if (pull >= STORM.floatAtP) {
        releaseDensity = pullDensity(pull);
        sinceRelease = 0;
        enter('floating');
        pending.push({ type: 'auto-complete' });
        return true;
      }
      enter('returning');
      pending.push({ type: 'return' });
      return false;
    },
    update(dt, attending) {
      events.length = 0;
      for (let i = 0; i < pending.length; i++) events.push(pending[i]);
      pending.length = 0;
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.1) : 0;
      attention += ((attending ? 1 : STORM.inattentiveRain) - attention) * (1 - Math.exp(-step * STORM.attentionRate));
      phaseTime += step;
      let density = 0;
      let scale = 0.3;
      let lift = 0;
      let glow = 0;

      switch (phase) {
        case 'idle':
          pull = 0;
          break;
        case 'pulling':
          density = pullDensity(pull);
          scale = cloudScaleForPull(pull);
          break;
        case 'returning': {
          pull = releasePull * (1 - easeOutCubic(phaseTime / STORM.returnS));
          density = pullDensity(pull);
          scale = cloudScaleForPull(pull);
          if (phaseTime >= STORM.returnS) {
            pull = 0;
            enter('idle');
          }
          break;
        }
        case 'floating':
        case 'body': {
          // Story time freezes while the user looks away (float included).
          const story = attending ? step : 0;
          sinceRelease += story;
          // Critical spring normalised so it lands exactly on 1 at floatS
          // (unnormalised it is 0.983 there and would snap ~4 mm in a frame).
          const w = (6 / STORM.floatS) * sinceRelease;
          lift = clamp01((1 - (1 + w) * Math.exp(-w)) / FLOAT_END);
          if (sinceRelease >= STORM.floatS) lift = 1;
          const inflate = cloudScaleForPull(releasePull) +
            (1 - cloudScaleForPull(releasePull)) * easeOutCubic(sinceRelease / STORM.inflateS);
          if (phase === 'floating') {
            density = releaseDensity;
            scale = inflate;
            if (sinceRelease >= STORM.floatS) {
              enter('body');
              bodyTime = 0;
              events.push({ type: 'body' });
            }
            break;
          }
          const prev = bodyTime;
          bodyTime = Math.min(STORM.bodyS, bodyTime + story);
          fire(prev, bodyTime);
          density = bodyDensity(bodyTime, releaseDensity);
          // The inflate has long reached 1 when the drain starts.
          scale = bodyTime < STORM.drainStartS ? inflate : bodyCloudScale(bodyTime);
          glow = lightning ? glowAt(schedule, bodyTime) : 0;
          if (bodyTime >= STORM.bodyS) {
            enter('done');
            events.push({ type: 'done' });
          }
          break;
        }
        case 'done':
          scale = STORM.drainedScale;
          lift = 1;
          break;
      }

      if (density > 0 && !rainStarted) {
        rainStarted = true;
        events.push({ type: 'rain-start' });
      }
      // Re-arm only once the tag is back in the slot: hand jitter around
      // p 0.35 while pulling must not retrigger the first-ticks cue every frame.
      if (phase === 'idle') rainStarted = false;

      out.phase = phase;
      // The tag rides the float from the release pull to 1: no one-frame jump.
      out.pull = phase === 'floating' ? releasePull + (1 - releasePull) * lift
        : phase === 'body' || phase === 'done' ? 1 : pull;
      out.cloudScale = scale;
      out.cloudLift = lift;
      out.density = density * attention;
      out.glow = glow;
      out.bodyTime = bodyTime;
      return out;
    },
    reset(completed = false) {
      events.length = 0;
      pending.length = 0;
      pull = 0;
      releasePull = 0;
      releaseDensity = 0;
      sinceRelease = 0;
      bodyTime = completed ? STORM.bodyS : 0;
      attention = 1;
      rainStarted = false;
      enter(completed ? 'done' : 'idle');
    },
  };
}
