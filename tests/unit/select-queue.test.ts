import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSelectQueue, MAX_HAND_SELECT_TRANSITIONS, type SelectEdge } from '../../src/input/select-queue.ts';

const take = (q: ReturnType<typeof createSelectQueue>) => ({ ...q.take() });
const drain = (q: ReturnType<typeof createSelectQueue>, n: number) => Array.from({ length: n }, () => take(q));

test('start + end between two frames: a down frame, then an up frame', () => {
  const q = createSelectQueue();
  q.push('start');
  q.push('end');
  assert.deepEqual(take(q), { start: true, end: false, selecting: true });
  assert.deepEqual(take(q), { start: false, end: true, selecting: false });
  assert.deepEqual(take(q), { start: false, end: false, selecting: false });
});

test('level holds between edges', () => {
  const q = createSelectQueue();
  q.push('start');
  take(q);
  assert.deepEqual(drain(q, 3), Array(3).fill({ start: false, end: false, selecting: true }));
  q.push('end');
  assert.deepEqual(take(q), { start: false, end: true, selecting: false });
});

test('a repeated edge is ignored', () => {
  const q = createSelectQueue();
  q.push('start');
  q.push('start');
  q.push('end');
  q.push('end');
  assert.deepEqual(drain(q, 3), [
    { start: true, end: false, selecting: true },
    { start: false, end: true, selecting: false },
    { start: false, end: false, selecting: false },
  ]);
  // An end with nothing pressed is ignored too.
  const idle = createSelectQueue();
  idle.push('end');
  assert.deepEqual(take(idle), { start: false, end: false, selecting: false });
});

test('one edge per take(), in order', () => {
  const q = createSelectQueue();
  const edges: SelectEdge[] = ['start', 'end', 'start', 'end'];
  edges.forEach((e) => q.push(e));
  const frames = drain(q, 5);
  for (const f of frames) assert.ok(!(f.start && f.end));
  assert.deepEqual(
    frames.map((f) => (f.start ? 'start' : f.end ? 'end' : '-')),
    ['start', 'end', 'start', 'end', '-'],
  );
});

test(`more than ${MAX_HAND_SELECT_TRANSITIONS} transitions: oldest pair dropped, final level = physical state`, () => {
  const odd = createSelectQueue();
  for (const e of ['start', 'end', 'start', 'end', 'start'] as SelectEdge[]) odd.push(e);
  const a = drain(odd, 4);
  assert.deepEqual(
    a.map((f) => (f.start ? 'start' : f.end ? 'end' : '-')),
    ['start', 'end', 'start', '-'],
  );
  assert.equal(a[3].selecting, true, 'physically pressed');

  const pressed = createSelectQueue();
  for (let i = 0; i < 9; i++) pressed.push(i % 2 === 0 ? 'start' : 'end');
  pressed.push('start'); // repeated (already pressed): ignored
  const b = drain(pressed, MAX_HAND_SELECT_TRANSITIONS + 1);
  assert.equal(b.filter((f) => f.start || f.end).length, 3);
  assert.equal(b[b.length - 1].selecting, true);

  const released = createSelectQueue();
  for (let i = 0; i < 10; i++) released.push(i % 2 === 0 ? 'start' : 'end');
  const c = drain(released, MAX_HAND_SELECT_TRANSITIONS + 1);
  assert.equal(c.filter((f) => f.start || f.end).length, MAX_HAND_SELECT_TRANSITIONS);
  assert.equal(c[c.length - 1].selecting, false, 'physically released');
});

test('overflow while an edge is already reported keeps start/end alternating', () => {
  const q = createSelectQueue();
  q.push('start');
  take(q); // reported: pressed
  for (const e of ['end', 'start', 'end', 'start', 'end'] as SelectEdge[]) q.push(e);
  const frames = drain(q, 4).map((f) => (f.start ? 'start' : f.end ? 'end' : '-'));
  assert.deepEqual(frames, ['end', 'start', 'end', '-']);
});

test('reset() clears queued edges and both states', () => {
  const q = createSelectQueue();
  q.push('start');
  q.push('end');
  q.push('start');
  take(q);
  q.reset();
  assert.deepEqual(take(q), { start: false, end: false, selecting: false });
  q.push('end'); // physical state is "released" again: ignored
  assert.deepEqual(take(q), { start: false, end: false, selecting: false });
  q.push('start');
  assert.deepEqual(take(q), { start: true, end: false, selecting: true });
});
