/**
 * Monotonic progress with notches. PURE module.
 *
 * The value is the running maximum of clamp(amount, 0, 1): it never goes
 * back, pushing the same amount twice changes nothing, and non-finite amounts
 * are ignored. Reaching `completeAt` snaps to 1 (a hand never quite reaches
 * the end stop). Each notch and the completion are reported exactly once.
 */

export interface RatchetConfig {
  /** Ascending thresholds in (0, 1); their indices are reported when crossed. */
  notches: readonly number[];
  /** At or above this, the value snaps to 1 and completes. */
  completeAt: number;
}

export const RATCHET_DEFAULTS: Readonly<RatchetConfig> = { notches: [0.25, 0.5, 0.75], completeAt: 0.98 };

/** Reused by push(): read it before the next call. */
export interface RatchetStep {
  value: number;
  changed: boolean;
  /** Notch indices crossed by this push, ascending. */
  notches: readonly number[];
  /** True only on the push that reached 1. */
  completed: boolean;
}

export interface Ratchet {
  readonly value: number;
  push(amount: number): RatchetStep;
  /** M2: ?reset=1 / persistence restore. Notches at or below `value` count as passed. */
  reset(value?: number): void;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createRatchet(cfg?: Partial<RatchetConfig>): Ratchet {
  const c: RatchetConfig = { ...RATCHET_DEFAULTS, ...cfg };
  const notches = [...c.notches].sort((a, b) => a - b);
  let value = 0;
  const crossed: number[] = [];
  const out: RatchetStep = { value: 0, changed: false, notches: crossed, completed: false };

  return {
    get value() {
      return value;
    },
    push(amount) {
      crossed.length = 0;
      out.changed = false;
      out.completed = false;
      if (Number.isFinite(amount)) {
        let next = clamp01(amount);
        if (next >= c.completeAt) next = 1;
        if (next > value) {
          const prev = value;
          value = next;
          out.changed = true;
          for (let i = 0; i < notches.length; i++) {
            if (prev < notches[i] && notches[i] <= value) crossed.push(i);
          }
          out.completed = value === 1;
        }
      }
      out.value = value;
      return out;
    },
    reset(v = 0) {
      value = Number.isFinite(v) ? clamp01(v) : 0;
      if (value >= c.completeAt) value = 1;
      crossed.length = 0;
      out.value = value;
      out.changed = false;
      out.completed = false;
    },
  };
}
