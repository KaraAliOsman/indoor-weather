import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import type {
  ActuationService,
  ActuationTarget,
  EventBus,
  FrameClock,
  GameEvent,
  GamePhase,
  GameStateApi,
  LoggedEvent,
} from '../../src/core/types.ts';
import { createActuation } from '../../src/input/actuation.ts';

/** Minimal bus: records every event (nothing subscribes in these tests). `of()` returns unstamped payloads. */
type FakeBus = EventBus & { of<T extends GameEvent['type']>(t: T): Extract<GameEvent, { type: T }>[] };

function fakeBus(clock: FrameClock): FakeBus {
  const log: LoggedEvent[] = [];
  const raw: GameEvent[] = [];
  return {
    emit(e) {
      raw.push(e);
      log.push({ ...e, t: clock.time, frame: clock.frame });
    },
    on: () => () => {},
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

function fakeGame(phase: GamePhase): GameStateApi & { phase: GamePhase } {
  return {
    phase,
    isUnlocked(t: ActuationTarget) {
      return this.phase === t;
    },
    snapshot() {
      return { phase: this.phase, registered: [], completed: [] };
    },
  };
}

describe('actuation', () => {
  let clock: FrameClock;
  let bus: ReturnType<typeof fakeBus>;
  let game: ReturnType<typeof fakeGame>;
  let visible: boolean;
  let svc: ActuationService;

  beforeEach(() => {
    clock = { frame: 1, time: 0, dt: 0 };
    bus = fakeBus(clock);
    game = fakeGame('wind');
    visible = true;
    svc = createActuation({ bus, game, clock, visible: () => visible });
  });

  test('gate order: invalid → locked → hidden → mode (first failure wins)', () => {
    game.phase = 'placing';
    visible = false;
    svc.actuate('wind', NaN, 'ray');
    svc.actuate('wind', 0.5, 'ray');
    game.phase = 'wind';
    svc.actuate('wind', 0.5, 'ray');
    visible = true;
    svc.actuate('wind', 0.5, 'ray');
    assert.deepEqual(
      bus.of('actuate:reject').map((e) => e.reason),
      ['invalid', 'locked', 'hidden', 'mode'],
    );
    assert.equal(svc.progress('wind'), 0);
    assert.equal(svc.actuate('wind', 0.1, 'direct'), 0.1);
    assert.equal(svc.rejected, 4);
  });

  test('±Infinity is invalid; debug and auto skip only the mode gate', () => {
    svc.actuate('wind', Infinity, 'debug');
    svc.actuate('wind', -Infinity, 'debug');
    assert.equal(bus.of('actuate:reject').length, 1);
    assert.equal(svc.rejected, 2);
    svc.mode = 'scan';
    assert.equal(svc.actuate('wind', 0.2, 'debug'), 0.2);
    assert.equal(svc.actuate('wind', 0.3, 'auto'), 0.3);
    game.phase = 'storm';
    svc.actuate('wind', 0.6, 'debug');
    assert.equal(bus.of('actuate:reject').at(-1)?.reason, 'locked');
    assert.equal(svc.progress('wind'), 0.3);
  });

  test('repeated rejection: one event per (target, source, reason) until the next accepted call', () => {
    game.phase = 'placing';
    for (let i = 0; i < 5; i++) svc.actuate('wind', 0.2, 'direct');
    svc.actuate('storm', 0.2, 'direct');
    assert.equal(bus.of('actuate:reject').length, 2);
    visible = false;
    svc.actuate('wind', 0.2, 'direct'); // still 'locked' first
    assert.equal(bus.of('actuate:reject').length, 2);
    game.phase = 'wind';
    svc.actuate('wind', 0.2, 'direct'); // new reason: 'hidden'
    assert.equal(bus.of('actuate:reject').length, 3);
    visible = true;
    assert.equal(svc.actuate('wind', 0.2, 'direct'), 0.2); // accepted: clears
    game.phase = 'placing';
    svc.actuate('wind', 0.3, 'direct');
    svc.actuate('wind', 0.3, 'direct');
    const rejects = bus.of('actuate:reject');
    assert.equal(rejects.length, 4);
    assert.deepEqual(rejects.at(-1), { type: 'actuate:reject', target: 'wind', source: 'direct', reason: 'locked' });
    assert.equal(svc.rejected, 10);
  });

  test('dedupe is per source: accepted calls from another source do not re-arm it', () => {
    for (let i = 0; i < 5; i++) {
      clock.frame++;
      svc.actuate('wind', 0.1 + i * 0.01, 'direct');
      svc.actuate('wind', 0.9, 'ray');
    }
    const reject = { type: 'actuate:reject', target: 'wind', source: 'ray', reason: 'mode' };
    assert.deepEqual(bus.of('actuate:reject'), [reject]);
    assert.equal(svc.rejected, 5);
    // 'ray' gets accepted once (mode switch): its next rejection is reported again.
    clock.frame++;
    svc.mode = 'ray';
    svc.actuate('wind', 0.2, 'ray');
    svc.mode = 'direct';
    svc.actuate('wind', 0.9, 'ray');
    assert.equal(bus.of('actuate:reject').length, 2);
  });

  test('a rejected call returns the current progress and changes nothing', () => {
    svc.actuate('wind', 0.4, 'direct');
    game.phase = 'done';
    assert.equal(svc.actuate('wind', 0.9, 'direct'), 0.4);
    assert.equal(svc.progress('wind'), 0.4);
    assert.equal(bus.of('notch').length, 1);
  });

  test('notches in order, mechanism:complete exactly once', () => {
    svc.actuate('wind', 0.3, 'direct');
    svc.actuate('wind', 0.3, 'direct');
    svc.actuate('wind', 0.1, 'direct');
    svc.actuate('wind', 0.9, 'direct');
    assert.equal(svc.isComplete('wind'), false);
    assert.equal(svc.actuate('wind', 0.985, 'direct'), 1);
    svc.actuate('wind', 1, 'direct');
    svc.actuate('wind', 2, 'direct');
    assert.deepEqual(
      bus.of('notch').map((e) => [e.index, e.progress]),
      [
        [0, 0.3],
        [1, 0.9],
        [2, 0.9],
      ],
    );
    assert.deepEqual(bus.of('mechanism:complete'), [{ type: 'mechanism:complete', target: 'wind' }]);
    assert.equal(svc.isComplete('wind'), true);
    // complete comes after the last notch of the same call
    const fresh = fakeBus(clock);
    const s2 = createActuation({ bus: fresh, game, clock, visible: () => true });
    s2.actuate('wind', 1, 'direct');
    assert.deepEqual(
      fresh.log.map((e) => e.type),
      ['notch', 'notch', 'notch', 'mechanism:complete'],
    );
  });

  test('targets are independent', () => {
    svc.actuate('wind', 0.6, 'direct');
    game.phase = 'dawn';
    svc.actuate('dawn', 0.2, 'direct');
    assert.equal(svc.progress('wind'), 0.6);
    assert.equal(svc.progress('dawn'), 0.2);
    assert.equal(svc.progress('storm'), 0);
    assert.equal(svc.isComplete('storm'), false);
  });

  test('doubleActuations: two different InputModes on one target in one frame', () => {
    svc.actuate('wind', 0.1, 'direct');
    svc.actuate('wind', 0.11, 'direct'); // same mode twice: fine
    svc.actuate('wind', 0.12, 'debug'); // not a mode
    svc.actuate('wind', 0.13, 'auto');
    assert.equal(svc.doubleActuations, 0);
    // 'ray' while in direct mode is rejected: no double actuation happened.
    svc.actuate('wind', 0.5, 'ray');
    assert.equal(svc.doubleActuations, 0);
    // Mode switched mid-frame and both got through: that is the bug we count.
    svc.mode = 'ray';
    svc.actuate('wind', 0.2, 'ray');
    assert.equal(svc.doubleActuations, 1);
    clock.frame++;
    svc.actuate('wind', 0.3, 'ray');
    svc.mode = 'direct';
    clock.frame++;
    svc.actuate('wind', 0.4, 'direct');
    assert.equal(svc.doubleActuations, 1);
  });

  test('reset(target) and reset()', () => {
    svc.actuate('wind', 1, 'direct');
    game.phase = 'storm';
    svc.actuate('storm', 0.5, 'direct');
    svc.reset('wind');
    assert.equal(svc.progress('wind'), 0);
    assert.equal(svc.isComplete('wind'), false);
    assert.equal(svc.progress('storm'), 0.5);
    game.phase = 'wind';
    svc.actuate('wind', 1, 'direct');
    assert.equal(bus.of('mechanism:complete').length, 2, 'can complete again after a reset');
    svc.reset();
    assert.equal(svc.progress('wind'), 0);
    assert.equal(svc.progress('storm'), 0);
  });
});
