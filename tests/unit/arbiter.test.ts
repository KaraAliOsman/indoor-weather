import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HANDS,
  type ActuationTarget,
  type EventBus,
  type FrameClock,
  type GameEvent,
  type GameEventType,
  type Handedness,
  type HandleSpec,
  type InputMode,
  type LoggedEvent,
  type Vec3,
} from '../../src/core/types.ts';
import { createActuation } from '../../src/input/actuation.ts';
import { createArbiter, CONTROLLER_RADIUS_SCALE } from '../../src/input/arbiter.ts';
import { createHandleRegistry } from '../../src/input/handles.ts';
import { createHandsState } from '../../src/input/hands-state.ts';

const HZ = 72;
const TRAVEL = 0.06;
const RADIUS = 0.035;

type TestBus = EventBus & { raw: GameEvent[]; of<T extends GameEventType>(t: T): Extract<GameEvent, { type: T }>[] };

/** Synchronous bus with FIFO delivery of nested emits (same contract as core/events.ts). */
function testBus(clock: FrameClock): TestBus {
  const log: LoggedEvent[] = [];
  const raw: GameEvent[] = [];
  const handlers = new Map<string, ((e: LoggedEvent) => void)[]>();
  const queue: LoggedEvent[] = [];
  let dispatching = false;
  return {
    raw,
    emit(e) {
      raw.push(e);
      const stamped = { ...e, t: clock.time, frame: clock.frame } as LoggedEvent;
      log.push(stamped);
      queue.push(stamped);
      if (dispatching) return;
      dispatching = true;
      while (queue.length) {
        const next = queue.shift()!;
        for (const h of handlers.get(next.type) ?? []) h(next);
      }
      dispatching = false;
    },
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler as (e: LoggedEvent) => void);
      handlers.set(type, list);
      return () => {};
    },
    onAny: () => () => {},
    get log() {
      return log;
    },
    clearLog() {
      log.length = 0;
      raw.length = 0;
    },
    of(t) {
      return raw.filter((e) => e.type === t) as never;
    },
  };
}

/** Linear tab along +Z, like C's createLinearHandle (grabPoint fixed here). */
function tab(target: ActuationTarget, p: Vec3, releaseSnapAt: number | null = null): HandleSpec & { enabled: boolean } {
  const axis = { x: 0, y: 0, z: 1 };
  return {
    target,
    releaseSnapAt,
    grabPoint: { ...p },
    grabRadius: RADIUS,
    enabled: true,
    hint: { axis, travel: TRAVEL },
    amountFor(start, now, p0) {
      return p0 + ((now.x - start.x) * axis.x + (now.y - start.y) * axis.y + (now.z - start.z) * axis.z) / TRAVEL;
    },
  };
}

const TAB = { x: 0, y: 0.8, z: -0.4 };
const FAR = { x: 0.5, y: 1.5, z: -0.4 };

/**
 * A tiny world: fake game where `unlocked` decides isUnlocked() and completion
 * locks the target (as game-state does), real actuation, real registry.
 */
function setup(opts: { unlocked?: ActuationTarget[]; lockOnComplete?: boolean } = {}) {
  const clock: FrameClock = { frame: 0, time: 0, dt: 1 / HZ };
  const bus = testBus(clock);
  const unlocked = new Set<ActuationTarget>(opts.unlocked ?? ['wind']);
  const game = {
    get phase() {
      return 'wind' as const;
    },
    isUnlocked: (t: ActuationTarget) => unlocked.has(t),
    snapshot: () => ({ phase: 'wind' as const, registered: [], completed: [] }),
  };
  if (opts.lockOnComplete ?? true) bus.on('mechanism:complete', (e) => unlocked.delete(e.target));
  const actuation = createActuation({ bus, game, clock, visible: () => true });
  const handles = createHandleRegistry();
  const arbiter = createArbiter({ handles, actuation, bus, game });
  const hands = createHandsState();
  for (const h of HANDS) {
    hands[h].device = 'hand';
    hands[h].tracked = true;
    Object.assign(hands[h].pinchPoint, FAR, { x: h === 'left' ? -FAR.x : FAR.x });
  }
  const frame = { allowed: true, mode: 'direct' as InputMode };

  const api = {
    clock,
    bus,
    unlocked,
    actuation,
    handles,
    arbiter,
    hands,
    frame,
    at(h: Handedness, p: Vec3, dx = 0, dy = 0, dz = 0) {
      const q = hands[h].pinchPoint;
      q.x = p.x + dx;
      q.y = p.y + dy;
      q.z = p.z + dz;
      return api;
    },
    /** One frame with optional edges per hand. */
    step(edges: Partial<Record<Handedness, 'start' | 'end'>> = {}) {
      for (const h of HANDS) {
        const s = hands[h];
        const e = edges[h];
        s.selectStart = s.rawSelectStart = e === 'start';
        s.selectEnd = e === 'end';
        if (e === 'start') s.selecting = true;
        if (e === 'end') s.selecting = false;
      }
      clock.frame++;
      clock.time += 1 / HZ;
      arbiter.step({ time: clock.time, allowed: frame.allowed, mode: frame.mode, hands });
      return api;
    },
    /** Moves `h` from its current point by (0, 0, dz) over `frames`, returns progress samples. */
    drag(h: Handedness, dz: number, frames: number, target: ActuationTarget = 'wind') {
      const p = hands[h].pinchPoint;
      const z0 = p.z;
      const out: number[] = [];
      for (let i = 1; i <= frames; i++) {
        p.z = z0 + (dz * i) / frames;
        api.step();
        out.push(actuation.progress(target));
      }
      return out;
    },
    fsm: (h: Handedness) => arbiter.stateOf(h).fsm,
    owner: (h: Handedness) => arbiter.stateOf(h).owner,
  };
  return api;
}

const monotonic = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

test('clean grab, pull and release: events and progress', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB, 0.005).step({ right: 'start' });
  assert.equal(w.fsm('right'), 'armed');
  assert.equal(w.owner('right'), 'wind');
  assert.deepEqual(w.bus.of('handle:grab'), [{ type: 'handle:grab', hand: 'right', target: 'wind' }]);
  const samples = w.drag('right', 0.03, 20);
  assert.ok(monotonic(samples));
  assert.ok(Math.abs(samples.at(-1)! - 0.5) < 1e-9);
  assert.deepEqual(
    w.bus.of('notch').map((e) => e.index),
    [0, 1],
  );
  w.step({ right: 'end' });
  w.step();
  assert.deepEqual(w.bus.of('handle:release'), [
    { type: 'handle:release', hand: 'right', target: 'wind', reason: 'release' },
  ]);
  assert.deepEqual(
    w.bus.of('pinch').map((e) => `${e.from}>${e.to}`),
    ['idle>armed', 'armed>pulling', 'pulling>released', 'released>idle'],
  );
  assert.equal(w.owner('right'), null);
  assert.equal(w.actuation.rejected, 0);
});

test('ratchet through the arbiter: pulling back never lowers progress; a re-grab continues', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.02, 10);
  const back = w.drag('right', -0.015, 8);
  assert.ok(back.every((x) => Math.abs(x - 1 / 3) < 1e-9), JSON.stringify(back));
  w.step({ right: 'end' });
  w.at('right', TAB).step({ right: 'start' });
  const more = w.drag('right', 0.02, 10);
  assert.ok(Math.abs(more.at(-1)! - 2 / 3) < 1e-9, 'progressAtStart = current progress');
  assert.equal(w.bus.of('actuate:reject').length, 0);
});

test('two hands on the tab in the same frame: nearer wins, exact tie → right', () => {
  for (const [dl, dr, winner] of [
    [0.02, 0.01, 'right'],
    [0.01, 0.02, 'left'],
    [0.015, 0.015, 'right'],
  ] as const) {
    const w = setup();
    w.handles.register(tab('wind', TAB));
    w.at('left', TAB, -dl).at('right', TAB, dr).step({ left: 'start', right: 'start' });
    const loser: Handedness = winner === 'right' ? 'left' : 'right';
    assert.equal(w.owner(winner), 'wind');
    assert.equal(w.owner(loser), null);
    assert.equal(w.fsm(loser), 'idle');
    assert.equal(w.bus.of('handle:grab').length, 1);
    // The loser cannot take it later either while it is held.
    w.step({ [loser]: 'end' }).step({ [loser]: 'start' });
    assert.equal(w.owner(loser), null);
  }
});

test('two handles in range: the nearest wins; the other hand may take the other one', () => {
  const w = setup({ unlocked: ['wind', 'storm'] });
  w.handles.register(tab('wind', TAB));
  w.handles.register(tab('storm', { ...TAB, x: TAB.x + 0.03 }));
  w.at('right', TAB, 0.02).step({ right: 'start' }); // 2 cm from wind, 1 cm from night
  assert.equal(w.owner('right'), 'storm');
  // Same frame tie on 'storm' resolved by distance: the loser falls back to 'wind'.
  const t = setup({ unlocked: ['wind', 'storm'] });
  t.handles.register(tab('wind', TAB));
  t.handles.register(tab('storm', { ...TAB, x: TAB.x + 0.03 }));
  t.at('right', TAB, 0.03).at('left', TAB, 0.025).step({ left: 'start', right: 'start' });
  assert.equal(t.owner('right'), 'storm');
  assert.equal(t.owner('left'), 'wind');
});

test('locked target, disabled handle, not allowed or another mode: no grab and no actuate', () => {
  const locked = setup({ unlocked: [] });
  locked.handles.register(tab('wind', TAB));
  locked.at('right', TAB).step({ right: 'start' });
  locked.drag('right', 0.03, 10);
  assert.equal(locked.fsm('right'), 'idle');
  assert.equal(locked.actuation.rejected, 0);
  assert.equal(locked.bus.of('handle:grab').length, 0);

  const disabled = setup();
  const h = tab('wind', TAB);
  h.enabled = false;
  disabled.handles.register(h);
  disabled.at('right', TAB).step({ right: 'start' });
  assert.equal(disabled.owner('right'), null);

  for (const patch of [{ allowed: false }, { mode: 'scan' as InputMode }]) {
    const w = setup();
    w.handles.register(tab('wind', TAB));
    Object.assign(w.frame, patch);
    w.at('right', TAB).step({ right: 'start' });
    assert.equal(w.owner('right'), null);
    assert.equal(w.bus.of('pinch').length, 0);
  }
});

test('allowed=false mid-pull → release(cancel)', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.01, 4);
  w.frame.allowed = false;
  w.step();
  const cancel = { type: 'handle:release', hand: 'right', target: 'wind', reason: 'cancel' };
  assert.deepEqual(w.bus.of('handle:release').at(-1), cancel);
  // Coming back while still pinching does not re-grab without a new start edge.
  w.frame.allowed = true;
  w.drag('right', 0.02, 4);
  assert.equal(w.owner('right'), null);
});

test('target locked mid-pull → release(cancel), no actuate, no reject', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  const before = w.drag('right', 0.01, 4).at(-1)!;
  w.unlocked.delete('wind');
  w.step();
  assert.equal(w.bus.of('handle:release').at(-1)?.reason, 'cancel');
  w.drag('right', 0.02, 4);
  assert.equal(w.actuation.progress('wind'), before);
  assert.equal(w.actuation.rejected, 0);
});

test('after completing: release(cancel) and no further actuate', () => {
  for (const lockOnComplete of [true, false]) {
    const w = setup({ lockOnComplete });
    w.handles.register(tab('wind', TAB));
    w.at('right', TAB).step({ right: 'start' });
    w.drag('right', 0.07, 20);
    assert.equal(w.actuation.isComplete('wind'), true);
    assert.equal(w.bus.of('mechanism:complete').length, 1);
    assert.equal(w.bus.of('handle:release').at(-1)?.reason, 'cancel');
    const after = w.drag('right', -0.03, 10);
    assert.ok(after.every((x) => x === 1));
    assert.equal(w.actuation.rejected, 0, `lockOnComplete=${lockOnComplete}`);
    // A new pinch on the completed tab is not a grab.
    w.step({ right: 'end' }).step({ right: 'start' });
    assert.equal(w.bus.of('handle:grab').length, 1);
  }
});

test("actuate(…, 'ray') in direct mode: rejected with a single actuate:reject{mode}; doubleActuations === 0", () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  const p = w.hands.right.pinchPoint;
  for (let i = 1; i <= 10; i++) {
    p.z = TAB.z + 0.002 * i;
    w.step();
    w.actuation.actuate('wind', 0.9, 'ray');
  }
  const rejects = w.bus.of('actuate:reject');
  assert.deepEqual(rejects, [{ type: 'actuate:reject', target: 'wind', source: 'ray', reason: 'mode' }]);
  assert.ok(Math.abs(w.actuation.progress('wind') - 0.02 / TRAVEL) < 1e-9);
  assert.equal(w.actuation.doubleActuations, 0);
});

test(`controllers get grabRadius × ${CONTROLLER_RADIUS_SCALE}`, () => {
  const off = RADIUS * 1.4;
  const hand = setup();
  hand.handles.register(tab('wind', TAB));
  hand.at('right', TAB, off).step({ right: 'start' });
  assert.equal(hand.owner('right'), null);

  const ctrl = setup();
  ctrl.handles.register(tab('wind', TAB));
  ctrl.hands.right.device = 'controller';
  ctrl.at('right', TAB, off).step({ right: 'start' });
  assert.equal(ctrl.owner('right'), 'wind');
});

test('short tracking loss keeps the grab; the pull resumes from where the hand reappears', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.012, 6);
  const mid = w.actuation.progress('wind');
  w.hands.right.tracked = false;
  for (let i = 0; i < 14; i++) w.step();
  assert.equal(w.fsm('right'), 'holding');
  assert.equal(w.actuation.progress('wind'), mid);
  w.hands.right.tracked = true;
  // The reappear frame is the new reference (its 2 mm step is not counted): 5 of 6 steps.
  w.drag('right', 0.012, 6);
  assert.ok(Math.abs(w.actuation.progress('wind') - (0.012 + 0.010) / TRAVEL) < 1e-9);
  assert.equal(w.bus.of('handle:release').length, 0);
});

test('a hand that reappears 4 cm further along does not turn the jump into progress', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.012, 6);
  const mid = w.actuation.progress('wind');
  w.hands.right.tracked = false;
  for (let i = 0; i < 10; i++) w.step();
  w.hands.right.pinchPoint.z += 0.04;
  w.hands.right.tracked = true;
  w.step();
  assert.equal(w.fsm('right'), 'pulling');
  assert.ok(Math.abs(w.actuation.progress('wind') - mid) < 1e-9);
  assert.equal(w.bus.of('notch').length, 0);
});

test('a one-frame 5 cm spike moves the handle by at most MAX_PULL_SPEED_MPS · dt', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.012, 6);
  const before = w.actuation.progress('wind');
  w.hands.right.pinchPoint.z += 0.05;
  w.step();
  const jump = w.actuation.progress('wind') - before;
  assert.ok(jump <= (0.5 / HZ) / TRAVEL + 1e-9, `jump = ${jump}`);
  assert.equal(w.actuation.isComplete('wind'), false);
});

test('cancelAll releases every grab and resets the FSMs', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.01, 3);
  w.arbiter.cancelAll('cancel');
  assert.deepEqual(w.arbiter.stateOf('right'), { fsm: 'idle', owner: null });
  const cancel = { type: 'handle:release', hand: 'right', target: 'wind', reason: 'cancel' };
  assert.deepEqual(w.bus.of('handle:release').at(-1), cancel);
  assert.deepEqual(w.bus.of('pinch').at(-1), { type: 'pinch', hand: 'right', from: 'pulling', to: 'idle' });
  w.arbiter.cancelAll('cancel'); // idempotent
  assert.equal(w.bus.of('handle:release').length, 1);
  assert.equal(w.owner('left'), null);
});

test('end magnet: letting go at ≥ releaseSnapAt completes; below it the progress just stays', () => {
  const w = setup();
  w.handles.register(tab('wind', TAB, 0.9));
  w.at('right', TAB).step({ right: 'start' });
  w.drag('right', 0.054, 30); // 0.9
  assert.ok(w.actuation.progress('wind') >= 0.9 - 1e-9);
  assert.equal(w.actuation.isComplete('wind'), false);
  w.step({ right: 'end' });
  assert.equal(w.actuation.isComplete('wind'), true);
  assert.equal(w.actuation.progress('wind'), 1);

  const v = setup();
  v.handles.register(tab('wind', TAB, 0.9));
  v.at('right', TAB).step({ right: 'start' });
  v.drag('right', 0.05, 30); // 0.83
  v.step({ right: 'end' });
  assert.equal(v.actuation.isComplete('wind'), false);
  assert.ok(Math.abs(v.actuation.progress('wind') - 0.05 / TRAVEL) < 1e-9);
});
