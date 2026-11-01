/**
 * actuate(target, amount, source): the single entry point of every input
 * mode. PURE module.
 *
 * One ratchet per target. Gates, first failure wins:
 *   invalid (NaN/±Inf) → locked (!game.isUnlocked) → hidden (!visible) → mode
 *   (source ∉ {mode, 'debug', 'auto'}).
 * Every rejection counts in `rejected`, but only the first one per
 * (target, source, reason) emits 'actuate:reject', until that source gets a
 * call accepted on that target again: a pull held against a locked
 * mechanism must not spam the bus, and neither must a stray 'ray' caller
 * while 'direct' keeps being accepted on the same target.
 * Accepted calls push the ratchet, emit 'notch' per crossed index (in order)
 * and 'mechanism:complete' once per target.
 * `doubleActuations` counts accepted calls from two different InputModes on
 * one target within a single clock.frame (must stay 0; 'debug' and 'auto'
 * are not modes and never count).
 */
import type {
  ActuationRejectReason,
  ActuationService,
  ActuationSource,
  ActuationTarget,
  EventBus,
  FrameClock,
  GameStateApi,
  InputMode,
} from '../core/types.ts';
import { createRatchet, type Ratchet, type RatchetConfig } from './ratchet.ts';

export interface ActuationDeps {
  bus: EventBus;
  game: GameStateApi;
  clock: Readonly<FrameClock>;
  visible: () => boolean;
  mode?: InputMode;
  /** Same notches for every target in M1. */
  ratchet?: Partial<RatchetConfig>;
}

const REASON_BIT: Record<ActuationRejectReason, number> = { invalid: 1, locked: 2, hidden: 4, mode: 8 };
/** 4 reason bits per source in `TargetSlot.reported`. */
const SOURCE_SHIFT: Record<ActuationSource, number> = { direct: 0, ray: 4, scan: 8, dwell: 12, debug: 16, auto: 20 };
const MODE_BIT: Record<InputMode, number> = { direct: 1, ray: 2, scan: 4, dwell: 8 };

interface TargetSlot {
  readonly ratchet: Ratchet;
  complete: boolean;
  /** (source, reason) pairs already reported since that source's last accepted call. */
  reported: number;
  /** clock.frame of `modes`. */
  frame: number;
  /** InputModes accepted on this target during `frame`. */
  modes: number;
}

function isInputMode(source: ActuationSource): source is InputMode {
  return source !== 'debug' && source !== 'auto';
}

export function createActuation(deps: ActuationDeps): ActuationService {
  const { bus, game, clock, visible } = deps;
  const slots = new Map<ActuationTarget, TargetSlot>();
  let rejected = 0;
  let doubles = 0;

  // Created on first use: any ActuationTarget works without a registry.
  const slot = (target: ActuationTarget): TargetSlot => {
    let s = slots.get(target);
    if (!s) {
      s = { ratchet: createRatchet(deps.ratchet), complete: false, reported: 0, frame: -1, modes: 0 };
      slots.set(target, s);
    }
    return s;
  };

  const clearSlot = (s: TargetSlot): void => {
    s.ratchet.reset(0);
    s.complete = false;
    s.reported = 0;
    s.frame = -1;
    s.modes = 0;
  };

  const svc: ActuationService = {
    mode: deps.mode ?? 'direct',

    get rejected() {
      return rejected;
    },
    get doubleActuations() {
      return doubles;
    },

    actuate(target, amount, source) {
      const s = slot(target);
      const reason: ActuationRejectReason | null = !Number.isFinite(amount)
        ? 'invalid'
        : !game.isUnlocked(target)
          ? 'locked'
          : !visible()
            ? 'hidden'
            : isInputMode(source) && source !== svc.mode
              ? 'mode'
              : null;

      if (reason !== null) {
        rejected++;
        const bit = REASON_BIT[reason] << SOURCE_SHIFT[source];
        if ((s.reported & bit) === 0) {
          s.reported |= bit;
          bus.emit({ type: 'actuate:reject', target, source, reason });
        }
        return s.ratchet.value;
      }

      s.reported &= ~(0xf << SOURCE_SHIFT[source]);
      if (isInputMode(source)) {
        if (s.frame !== clock.frame) {
          s.frame = clock.frame;
          s.modes = 0;
        }
        const bit = MODE_BIT[source];
        if (s.modes !== 0 && (s.modes & bit) === 0) doubles++;
        s.modes |= bit;
      }

      const step = s.ratchet.push(amount);
      const value = step.value;
      const completed = step.completed && !s.complete;
      if (completed) s.complete = true;
      if (step.notches.length > 0) {
        // Copy first: a handler may actuate again and reuse the step object.
        const crossed = step.notches.slice();
        // `progress` = value after this call (>= the notch itself).
        for (let i = 0; i < crossed.length; i++) {
          bus.emit({ type: 'notch', target, index: crossed[i], progress: value });
        }
      }
      if (completed) bus.emit({ type: 'mechanism:complete', target });
      return value;
    },

    progress(target) {
      return slots.get(target)?.ratchet.value ?? 0;
    },

    isComplete(target) {
      return slots.get(target)?.complete ?? false;
    },

    reset(target) {
      if (target === undefined) slots.forEach(clearSlot);
      else {
        const s = slots.get(target);
        if (s) clearSlot(s);
      }
    },
  };
  return svc;
}
