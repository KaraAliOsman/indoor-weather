/**
 * Game phases (docs/architecture-m1.md §4.1). PURE module.
 *
 *  boot ─session:start─► placing ─placement:commit─► settling ─box:placed─► first pending chapter
 *  chapter X ─mechanism:complete{X}─► next pending chapter, or 'done' when none is left (M1)
 *  any ─session:end─► boot (completed chapters are kept; the pose is not)
 *
 * A chapter is pending when its system registered it and it is not complete.
 * `reduceGame` returns the same object when nothing changes, so the store
 * can tell real transitions apart and emit one 'phase' event per change.
 */
import {
  CHAPTER_ORDER,
  type ActuationTarget,
  type EventBus,
  type GameEvent,
  type GamePhase,
  type GameSnapshot,
  type GameStateApi,
} from './types.ts';

export function initialGame(): GameSnapshot {
  return { phase: 'boot', registered: [], completed: [] };
}

/** `list` plus `t`, kept in CHAPTER_ORDER. */
function addOrdered(list: readonly ActuationTarget[], t: ActuationTarget): ActuationTarget[] {
  return CHAPTER_ORDER.filter((c) => c === t || list.includes(c));
}

/** First registered chapter that is not complete, else 'done'. */
export function nextChapter(s: Readonly<GameSnapshot>): GamePhase {
  for (const c of CHAPTER_ORDER) {
    if (s.registered.includes(c) && !s.completed.includes(c)) return c;
  }
  return 'done';
}

export function reduceGame(s: GameSnapshot, e: GameEvent): GameSnapshot {
  switch (e.type) {
    case 'session:start':
      return s.phase === 'boot' ? { ...s, phase: 'placing' } : s;
    case 'placement:commit':
      return s.phase === 'placing' ? { ...s, phase: 'settling' } : s;
    case 'box:placed':
      return s.phase === 'settling' ? { ...s, phase: nextChapter(s) } : s;
    case 'mechanism:register':
      return s.registered.includes(e.id) || !CHAPTER_ORDER.includes(e.id)
        ? s
        : { ...s, registered: addOrdered(s.registered, e.id) };
    case 'mechanism:complete': {
      if (s.completed.includes(e.target)) return s;
      const next: GameSnapshot = { ...s, completed: addOrdered(s.completed, e.target) };
      if (s.phase === e.target) next.phase = nextChapter(next);
      return next;
    }
    case 'session:end':
      return s.phase === 'boot' ? s : { ...s, phase: 'boot' };
    default:
      return s;
  }
}

/** Subscribes to every event on `bus` and emits 'phase' {from, to} on each change. */
export function createGameState(bus: EventBus): GameStateApi {
  let s = initialGame();
  bus.onAny((e) => {
    const next = reduceGame(s, e);
    if (next === s) return;
    const from = s.phase;
    s = next;
    // Queued by the bus: delivered after the current event's handlers.
    if (next.phase !== from) bus.emit({ type: 'phase', from, to: next.phase });
  });
  return {
    get phase() {
      return s.phase;
    },
    isUnlocked(target) {
      return s.phase === target;
    },
    snapshot() {
      return { phase: s.phase, registered: [...s.registered], completed: [...s.completed] };
    },
  };
}
