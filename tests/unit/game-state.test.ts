import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus } from '../../src/core/events.ts';
import { createGameState, initialGame, nextChapter, reduceGame } from '../../src/core/game-state.ts';
import type { GameEvent, GameSnapshot } from '../../src/core/types.ts';

const pose = { position: { x: 0, y: 0.74, z: -0.45 }, yaw: 0 };

function run(events: GameEvent[], from: GameSnapshot = initialGame()): GameSnapshot {
  return events.reduce(reduceGame, from);
}

test('game: initial snapshot', () => {
  assert.deepEqual(initialGame(), { phase: 'boot', registered: [], completed: [] });
});

test('game: the §4.1 table, M1 path boot → placing → settling → wind → done', () => {
  let s = run([{ type: 'mechanism:register', id: 'wind' }]);
  assert.equal(s.phase, 'boot');
  s = reduceGame(s, { type: 'session:start' });
  assert.equal(s.phase, 'placing');
  s = reduceGame(s, { type: 'placement:commit', source: 'hit-test', pose });
  assert.equal(s.phase, 'settling');
  s = reduceGame(s, { type: 'box:placed', pose });
  assert.equal(s.phase, 'wind');
  s = reduceGame(s, { type: 'mechanism:complete', target: 'wind' });
  assert.equal(s.phase, 'done');
  assert.deepEqual(s.completed, ['wind']);
});

test('game: events that do not apply return the same object', () => {
  const s = initialGame();
  assert.equal(reduceGame(s, { type: 'placement:commit', source: 'debug', pose }), s);
  assert.equal(reduceGame(s, { type: 'box:placed', pose }), s);
  assert.equal(reduceGame(s, { type: 'session:end' }), s);
  assert.equal(reduceGame(s, { type: 'wind:gust', group: 0, leaves: 10 }), s);
  const placing = reduceGame(s, { type: 'session:start' });
  assert.equal(reduceGame(placing, { type: 'session:start' }), placing);
  assert.equal(reduceGame(placing, { type: 'box:placed', pose }), placing);
  const reg = reduceGame(s, { type: 'mechanism:register', id: 'wind' });
  assert.equal(reduceGame(reg, { type: 'mechanism:register', id: 'wind' }), reg);
});

test('game: no registered chapter → settling goes straight to done', () => {
  const s = run([
    { type: 'session:start' },
    { type: 'placement:commit', source: 'fallback', pose },
    { type: 'box:placed', pose },
  ]);
  assert.equal(s.phase, 'done');
});

test('game: chapters chain in CHAPTER_ORDER whatever the registration order', () => {
  let s = run([
    { type: 'mechanism:register', id: 'dawn' },
    { type: 'mechanism:register', id: 'wind' },
    { type: 'mechanism:register', id: 'storm' },
  ]);
  assert.deepEqual(s.registered, ['wind', 'storm', 'dawn']);
  s = run([{ type: 'session:start' }, { type: 'placement:commit', source: 'debug', pose }, { type: 'box:placed', pose }], s);
  assert.equal(s.phase, 'wind');
  s = reduceGame(s, { type: 'mechanism:complete', target: 'wind' });
  assert.equal(s.phase, 'storm');
  s = reduceGame(s, { type: 'mechanism:complete', target: 'storm' });
  assert.equal(s.phase, 'dawn');
  assert.equal(nextChapter({ ...s, completed: ['wind', 'storm', 'dawn'] }), 'done');
});

test('game: a completion for another target is recorded without changing the phase', () => {
  let s = run([
    { type: 'mechanism:register', id: 'wind' },
    { type: 'mechanism:register', id: 'storm' },
    { type: 'session:start' },
    { type: 'placement:commit', source: 'debug', pose },
    { type: 'box:placed', pose },
  ]);
  s = reduceGame(s, { type: 'mechanism:complete', target: 'storm' });
  assert.equal(s.phase, 'wind');
  assert.deepEqual(s.completed, ['storm']);
  const again = reduceGame(s, { type: 'mechanism:complete', target: 'storm' });
  assert.equal(again, s);
  // Wind completes: night is already done, nothing else is registered.
  assert.equal(reduceGame(s, { type: 'mechanism:complete', target: 'wind' }).phase, 'done');
});

test('game: session:end from wind → boot keeping completed; re-entering resumes the first pending chapter', () => {
  let s = run([
    { type: 'mechanism:register', id: 'wind' },
    { type: 'mechanism:register', id: 'storm' },
    { type: 'session:start' },
    { type: 'placement:commit', source: 'debug', pose },
    { type: 'box:placed', pose },
    { type: 'mechanism:complete', target: 'wind' },
  ]);
  assert.equal(s.phase, 'storm');
  s = reduceGame(s, { type: 'session:end' });
  assert.equal(s.phase, 'boot');
  assert.deepEqual(s.completed, ['wind']);
  s = run([{ type: 'session:start' }, { type: 'placement:commit', source: 'debug', pose }, { type: 'box:placed', pose }], s);
  assert.equal(s.phase, 'storm');
});

test('game: session:end during settling cancels it (a late box:placed does nothing)', () => {
  let s = run([
    { type: 'mechanism:register', id: 'wind' },
    { type: 'session:start' },
    { type: 'placement:commit', source: 'hit-test', pose },
    { type: 'session:end' },
  ]);
  assert.equal(s.phase, 'boot');
  s = reduceGame(s, { type: 'box:placed', pose });
  assert.equal(s.phase, 'boot');
});

test('game store: emits phase {from, to} once per change, isUnlocked ⇔ phase === target', () => {
  const clock = { frame: 0, time: 0, dt: 0 };
  const bus = createEventBus(clock);
  const game = createGameState(bus);
  bus.emit({ type: 'mechanism:register', id: 'wind' });
  bus.emit({ type: 'session:start' });
  bus.emit({ type: 'session:start' });
  bus.emit({ type: 'placement:commit', source: 'hit-test', pose });
  assert.equal(game.isUnlocked('wind'), false);
  bus.emit({ type: 'box:placed', pose });
  assert.equal(game.phase, 'wind');
  assert.equal(game.isUnlocked('wind'), true);
  assert.equal(game.isUnlocked('storm'), false);
  bus.emit({ type: 'mechanism:complete', target: 'wind' });
  assert.equal(game.isUnlocked('wind'), false);
  const phases = bus.log.filter((e) => e.type === 'phase').map((e) => `${(e as { from: string }).from}>${(e as { to: string }).to}`);
  assert.deepEqual(phases, ['boot>placing', 'placing>settling', 'settling>wind', 'wind>done']);
  // The phase event follows the event that caused it.
  const types = bus.log.map((e) => e.type);
  assert.equal(types[types.indexOf('box:placed') + 1], 'phase');
  // snapshot() is a copy.
  const snap = game.snapshot();
  snap.completed.push('storm');
  assert.deepEqual(game.snapshot().completed, ['wind']);
  assert.deepEqual(game.snapshot().registered, ['wind']);
});

test('game store: a later handler of the same event already sees the new phase', () => {
  const bus = createEventBus({ frame: 0, time: 0, dt: 0 });
  const game = createGameState(bus);
  let seen = '';
  bus.on('session:start', () => (seen = game.phase));
  bus.emit({ type: 'session:start' });
  assert.equal(seen, 'placing');
});
