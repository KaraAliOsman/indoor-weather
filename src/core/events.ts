/**
 * Synchronous typed event bus. PURE module (no three, no @iwsdk/core).
 *
 * - Every event is stamped with the frame clock ({t: clock.time, frame}).
 * - Handlers run in subscription order (typed and onAny alike), so the game
 *   state, subscribed first in main.ts, has already reduced an event when
 *   later handlers of that same event run.
 * - An emit during dispatch is queued and delivered after the current
 *   event's handlers (FIFO): every handler sees events in emission order.
 * - A throwing handler is reported with console.error and does not stop the
 *   others (a throw inside the render loop would otherwise stop it for good).
 * - `log` is a ring of the latest `capacity` events, oldest first.
 */
import type { EventBus, EventStamp, FrameClock, GameEvent, GameEventOf, GameEventType, LoggedEvent } from './types.ts';

export const EVENT_LOG_CAPACITY = 256;

interface Subscription {
  /** null = every event (onAny). */
  readonly type: GameEventType | null;
  readonly handler: (event: LoggedEvent) => void;
}

export function createEventBus(clock: Readonly<FrameClock>, capacity: number = EVENT_LOG_CAPACITY): EventBus {
  if (!(Number.isInteger(capacity) && capacity > 0)) throw new Error(`[events] invalid capacity ${capacity}`);
  // Copy-on-write: (un)subscribing during dispatch takes effect from the next event.
  let subs: readonly Subscription[] = [];
  const log: LoggedEvent[] = [];
  const queue: LoggedEvent[] = [];
  let dispatching = false;

  const deliver = (e: LoggedEvent): void => {
    const list = subs;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.type !== null && s.type !== e.type) continue;
      try {
        s.handler(e);
      } catch (err) {
        console.error(`[events] handler for '${e.type}' failed:`, err);
      }
    }
  };

  const subscribe = (sub: Subscription): (() => void) => {
    subs = [...subs, sub];
    return () => {
      subs = subs.filter((x) => x !== sub);
    };
  };

  return {
    emit(event: GameEvent) {
      const logged = { ...event, t: clock.time, frame: clock.frame } as LoggedEvent;
      log.push(logged);
      if (log.length > capacity) log.splice(0, log.length - capacity);
      queue.push(logged);
      if (dispatching) return;
      dispatching = true;
      try {
        for (let e = queue.shift(); e !== undefined; e = queue.shift()) deliver(e);
      } finally {
        dispatching = false;
        queue.length = 0;
      }
    },

    on<T extends GameEventType>(type: T, handler: (event: GameEventOf<T> & EventStamp) => void) {
      return subscribe({ type, handler: handler as unknown as (event: LoggedEvent) => void });
    },

    onAny(handler: (event: LoggedEvent) => void) {
      return subscribe({ type: null, handler });
    },

    get log() {
      return log;
    },

    clearLog() {
      log.length = 0;
    },
  };
}
