/**
 * Storm chapter timeline (direccion/canon.md §1, §6). PURE module.
 *
 *  hidden ──reveal()──► revealed ──complete()──► floating (0.6 s) ──► body ──► drain (6 s) ──► over
 *
 * - reveal: the tag rises out of the lid slot (the wind's leaves had their time).
 * - The pull itself is the actuation ratchet: while revealed the director
 *   only reports the pull as the room-darkening target.
 * - body: rain ramps to full in 2 s. It ends at `print + 6 s` once the user
 *   has sheltered the kite for ≥ 4 s in total, or after 20 s of full rain,
 *   whichever comes first (a slow user never waits, a curious one gets time).
 *   One distant thunder at body + 5 s (sound and a 2 mm shake, never light).
 * - Shelter: the kite counts as sheltered while ≥ 40 % of it is covered.
 *   Lifting the hand after ≥ 2 s of continuous shelter is a `print`: the dry
 *   handprint is kept (once per storm).
 * - drain: density eases to 0 in 6 s; `over` hands the table to the dawn.
 */

export const STORM_TIMING = {
  /** Cloud float from the release to its place (s). */
  floatS: 0.6,
  rampS: 2,
  /** Full rain before the storm ends on its own (s). */
  maxFullS: 20,
  /** Accumulated shelter that ends the storm early (s), and the delay after the print (s). */
  shelterGoalS: 4,
  afterPrintS: 6,
  drainS: 6,
  thunderS: 5,
  /** Kite coverage that counts as shelter, and the continuous shelter a print needs. */
  shelterCover: 0.4,
  printMinS: 2,
} as const;

export type StormStage = 'hidden' | 'revealed' | 'floating' | 'body' | 'drain' | 'over';

export type StormCue = 'rain' | 'thunder' | 'shelter-on' | 'shelter-off' | 'print' | 'drain' | 'over';

export interface StormStep {
  stage: StormStage;
  /** Rain density 0..1. */
  density: number;
  /** Seconds since the body started (0 before). */
  bodyT: number;
  /** Sheltered right now. */
  sheltered: boolean;
  /** Total shelter this storm (s). */
  shelterS: number;
  /** Cues raised by this step, in order (reused array). */
  readonly cues: StormCue[];
}

export interface StormDirector {
  readonly stage: StormStage;
  reveal(): void;
  /** The cloud tag completed (release at ≥ 0.6, or the ratchet reached 1). */
  complete(): void;
  /** `cover` = kite fraction covered by a hand now (0..1). */
  step(dt: number, cover: number): StormStep;
  reset(): void;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export function createStormDirector(): StormDirector {
  let stage: StormStage = 'hidden';
  let t = 0;
  let bodyT = 0;
  let fullT = 0;
  let endAt = Infinity;
  let drainT = 0;
  let drainFrom = 1;
  let shelterS = 0;
  let run = 0;
  let sheltered = false;
  let printed = false;
  let thunder = false;
  const out: StormStep = { stage, density: 0, bodyT: 0, sheltered: false, shelterS: 0, cues: [] };

  const startDrain = (density: number): void => {
    // Still holding the shelter when the rain stops: that hand is the print.
    if (sheltered && !printed && run >= STORM_TIMING.printMinS) {
      printed = true;
      out.cues.push('print');
    }
    stage = 'drain';
    drainT = 0;
    drainFrom = density;
    out.cues.push('drain');
  };

  return {
    get stage() {
      return stage;
    },
    reveal() {
      if (stage === 'hidden') stage = 'revealed';
    },
    complete() {
      if (stage === 'hidden' || stage === 'revealed') {
        stage = 'floating';
        t = 0;
      }
    },
    step(dt, cover) {
      out.cues.length = 0;
      const h = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      let density = 0;
      if (stage === 'floating') {
        t += h;
        if (t >= STORM_TIMING.floatS) {
          stage = 'body';
          bodyT = 0;
          out.cues.push('rain');
        }
      }
      if (stage === 'body') {
        bodyT += h;
        density = smooth(bodyT / STORM_TIMING.rampS);
        if (density >= 1) fullT += h;
        if (!thunder && bodyT >= STORM_TIMING.thunderS) {
          thunder = true;
          out.cues.push('thunder');
        }
        const now = clamp01(Number.isFinite(cover) ? cover : 0) >= STORM_TIMING.shelterCover;
        if (now) {
          shelterS += h;
          run += h;
        }
        if (now !== sheltered) {
          sheltered = now;
          out.cues.push(now ? 'shelter-on' : 'shelter-off');
          if (!now) {
            if (!printed && run >= STORM_TIMING.printMinS) {
              printed = true;
              out.cues.push('print');
            }
            run = 0;
          }
        }
        if (printed && shelterS >= STORM_TIMING.shelterGoalS && endAt === Infinity) {
          endAt = bodyT + STORM_TIMING.afterPrintS;
        }
        if (bodyT >= endAt || fullT >= STORM_TIMING.maxFullS) startDrain(density);
      } else if (stage === 'drain') {
        drainT += h;
        density = drainFrom * (1 - smooth(drainT / STORM_TIMING.drainS));
        if (drainT >= STORM_TIMING.drainS) {
          stage = 'over';
          density = 0;
          out.cues.push('over');
        }
      }
      if (stage !== 'body' && sheltered) {
        sheltered = false;
        out.cues.push('shelter-off');
      }
      out.stage = stage;
      out.density = density;
      out.bodyT = bodyT;
      out.sheltered = sheltered;
      out.shelterS = shelterS;
      return out;
    },
    reset() {
      stage = 'hidden';
      t = bodyT = fullT = drainT = shelterS = run = 0;
      endAt = Infinity;
      sheltered = printed = thunder = false;
      out.cues.length = 0;
    },
  };
}
