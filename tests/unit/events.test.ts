import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus, EVENT_LOG_CAPACITY } from '../../src/core/events.ts';
import type { FrameClock, LoggedEvent } from '../../src/core/types.ts';

const clockAt = (frame = 0, time = 0): FrameClock => ({ frame, time, dt: 0 });

test('events: stamps every event with the clock at emit time', () => {
  const clock = clockAt(7, 1.25);
  const bus = createEventBus(clock);
  const seen: LoggedEvent[] = [];
  bus.onAny((e) => seen.push(e));
  bus.emit({ type: 'session:start' });
  clock.frame = 8;
  clock.time = 1.5;
  bus.emit({ type: 'wind:gust', group: 0, leaves: 10 });
  assert.deepEqual(seen, [
    { type: 'session:start', t: 1.25, frame: 7 },
    { type: 'wind:gust', group: 0, leaves: 10, t: 1.5, frame: 8 },
  ]);
  assert.deepEqual(bus.log, seen);
});

test('events: payloads are copies (mutating the emitted object changes nothing)', () => {
  const bus = createEventBus(clockAt());
  const e = { type: 'notch' as const, target: 'wind' as const, index: 0, progress: 0.3 };
  bus.emit(e);
  e.index = 5;
  assert.equal((bus.log[0] as { index: number }).index, 0);
});

test('events: on() filters by type; unsubscribe stops delivery', () => {
  const bus = createEventBus(clockAt());
  const got: string[] = [];
  const off = bus.on('notch', (e) => got.push(`notch:${e.index}`));
  bus.emit({ type: 'notch', target: 'wind', index: 0, progress: 0.25 });
  bus.emit({ type: 'session:end' });
  off();
  bus.emit({ type: 'notch', target: 'wind', index: 1, progress: 0.5 });
  assert.deepEqual(got, ['notch:0']);
});

test('events: nested emits are queued FIFO after the current handlers', () => {
  const bus = createEventBus(clockAt());
  const order: string[] = [];
  bus.onAny((e) => {
    order.push(`A:${e.type}`);
    if (e.type === 'session:start') {
      bus.emit({ type: 'phase', from: 'boot', to: 'placing' });
      bus.emit({ type: 'placement:mode', mode: 'probing', reason: 'start' });
    }
  });
  bus.on('session:start', () => order.push('B:session:start'));
  bus.on('phase', () => order.push('B:phase'));
  bus.emit({ type: 'session:start' });
  assert.deepEqual(order, [
    'A:session:start',
    'B:session:start',
    'A:phase',
    'B:phase',
    'A:placement:mode',
  ]);
  // The log is in emission order too.
  assert.deepEqual(
    bus.log.map((e) => e.type),
    ['session:start', 'phase', 'placement:mode'],
  );
});

test('events: handlers run in subscription order, typed and onAny alike', () => {
  const bus = createEventBus(clockAt());
  const order: string[] = [];
  bus.onAny(() => order.push('any1'));
  bus.on('session:end', () => order.push('typed'));
  bus.onAny(() => order.push('any2'));
  bus.emit({ type: 'session:end' });
  assert.deepEqual(order, ['any1', 'typed', 'any2']);
});

test('events: a throwing handler is reported and does not stop the others', () => {
  const bus = createEventBus(clockAt());
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    let reached = 0;
    bus.on('session:end', () => {
      throw new Error('boom');
    });
    bus.on('session:end', () => reached++);
    bus.emit({ type: 'session:end' });
    bus.emit({ type: 'session:end' });
    assert.equal(reached, 2);
    assert.equal(errors.length, 2);
  } finally {
    console.error = original;
  }
});

test('events: subscribing during dispatch takes effect from the next event', () => {
  const bus = createEventBus(clockAt());
  let late = 0;
  bus.on('session:start', () => {
    bus.on('session:start', () => late++);
  });
  bus.emit({ type: 'session:start' });
  assert.equal(late, 0);
  bus.emit({ type: 'session:start' });
  assert.equal(late, 1);
});

test('events: the log is a ring of the latest 256 (oldest first) and clearLog empties it', () => {
  const clock = clockAt();
  const bus = createEventBus(clock);
  assert.equal(EVENT_LOG_CAPACITY, 256);
  for (let i = 0; i < 300; i++) {
    clock.frame = i;
    bus.emit({ type: 'wind:gust', group: 0, leaves: i });
  }
  assert.equal(bus.log.length, 256);
  assert.equal(bus.log[0]!.frame, 44);
  assert.equal(bus.log[255]!.frame, 299);
  bus.clearLog();
  assert.equal(bus.log.length, 0);

  const small = createEventBus(clock, 3);
  for (let i = 0; i < 5; i++) small.emit({ type: 'wind:gust', group: i, leaves: 0 });
  assert.deepEqual(
    small.log.map((e) => (e as { group: number }).group),
    [2, 3, 4],
  );
  assert.throws(() => createEventBus(clock, 0));
});
