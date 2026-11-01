/**
 * Per-hand queue of session selectstart/selectend edges. PURE module.
 *
 * Mirrors the private hand-select bridge of IWSDK 1.0.1
 * (nm/@iwsdk/xr-input/dist/xr-input-manager.js:283-306, 346-379): native
 * hand sources fire select events with no Gamepad, and a short pinch can
 * deliver selectstart AND selectend between two app frames. The queue keeps
 * their order and hands out at most one edge per frame, so every pinch is
 * seen as a "down" frame followed by an "up" frame.
 */

export type SelectEdge = 'start' | 'end';

/** Reused by take(): read it before the next call. */
export interface SelectFrame {
  start: boolean;
  end: boolean;
  /** Level as reported so far (follows the delivered edges, not the raw events). */
  selecting: boolean;
}

export interface SelectQueue {
  /** Repeated edge (same as the physical state) = ignored; at max, drops the oldest pair first. */
  push(edge: SelectEdge): void;
  /** At most ONE edge per call (one call per frame). */
  take(): SelectFrame;
  reset(): void;
}

/** nm/@iwsdk/xr-input/dist/xr-input-manager.js:20 */
export const MAX_HAND_SELECT_TRANSITIONS = 4;

export function createSelectQueue(maxTransitions: number = MAX_HAND_SELECT_TRANSITIONS): SelectQueue {
  // At least one full start/end pair must fit, or dropping "the oldest pair" is meaningless.
  const cap = Math.max(2, Math.floor(maxTransitions));
  // Ring buffer of edges (true = start). Fixed size: no allocation per event.
  const ring: boolean[] = new Array<boolean>(cap).fill(false);
  let head = 0;
  let count = 0;
  /** Physical state according to the raw events. */
  let actual = false;
  /** State delivered to the consumer through take(). */
  let reported = false;
  const out: SelectFrame = { start: false, end: false, selecting: false };

  return {
    push(edge) {
      const active = edge === 'start';
      if (active === actual) return;
      actual = active;
      // Edges alternate, so dropping two keeps both the reported state and the
      // final physical state consistent (same policy as IWSDK).
      if (count >= cap) {
        head = (head + 2) % cap;
        count -= 2;
      }
      ring[(head + count) % cap] = active;
      count++;
    },
    take() {
      if (count > 0) {
        const isStart = ring[head];
        head = (head + 1) % cap;
        count--;
        reported = isStart;
        out.start = isStart;
        out.end = !isStart;
      } else {
        out.start = false;
        out.end = false;
      }
      out.selecting = reported;
      return out;
    },
    reset() {
      head = 0;
      count = 0;
      actual = false;
      reported = false;
      out.start = out.end = out.selecting = false;
    },
  };
}
