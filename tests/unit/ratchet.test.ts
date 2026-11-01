import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRatchet } from '../../src/input/ratchet.ts';
import { mulberry32 } from './helpers/noise.ts';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

test('10 000 random amounts: value = running max of clamp(a, 0, 1), never decreases', () => {
  const r = createRatchet();
  const rand = mulberry32(7);
  let max = 0;
  const notches: number[] = [];
  let completions = 0;
  for (let i = 0; i < 10_000; i++) {
    const a = -0.5 + rand() * 2; // includes < 0 and > 1
    const before = r.value;
    const step = r.push(a);
    const c = clamp01(a);
    max = Math.max(max, c >= 0.98 ? 1 : c);
    assert.equal(step.value, max);
    assert.ok(step.value >= before);
    assert.equal(step.changed, step.value > before);
    notches.push(...step.notches);
    if (step.completed) completions++;
  }
  assert.deepEqual(notches, [0, 1, 2]);
  assert.equal(completions, 1);
  assert.equal(r.value, 1);
});

test('the same amount twice changes nothing', () => {
  const r = createRatchet();
  const a = r.push(0.4);
  assert.equal(a.changed, true);
  assert.deepEqual([...a.notches], [0]);
  const b = r.push(0.4);
  assert.equal(b.changed, false);
  assert.deepEqual([...b.notches], []);
  assert.equal(r.push(0.3).value, 0.4);
});

test('NaN and ±Infinity are ignored', () => {
  const r = createRatchet();
  r.push(0.3);
  for (const a of [NaN, Infinity, -Infinity]) {
    const s = r.push(a);
    assert.equal(s.value, 0.3);
    assert.equal(s.changed, false);
    assert.equal(s.completed, false);
  }
});

test('jump 0 → 0.8 crosses notches [0, 1, 2] in order, once', () => {
  const r = createRatchet();
  const s = r.push(0.8);
  assert.deepEqual([...s.notches], [0, 1, 2]);
  assert.equal(s.completed, false);
  assert.deepEqual([...r.push(0.9).notches], []);
});

test('reaching 0.98 snaps to 1 and completes exactly once', () => {
  const r = createRatchet();
  r.push(0.97);
  assert.equal(r.value, 0.97);
  const s = r.push(0.98);
  assert.equal(s.value, 1);
  assert.equal(s.completed, true);
  assert.equal(r.push(1).completed, false);
  assert.equal(r.push(5).completed, false);
  assert.equal(r.value, 1);
});

test('notches on the exact threshold count; reset(value) marks earlier notches as passed', () => {
  const r = createRatchet();
  assert.deepEqual([...r.push(0.25).notches], [0]);
  r.reset(0.5);
  assert.equal(r.value, 0.5);
  assert.deepEqual([...r.push(0.6).notches], []);
  assert.deepEqual([...r.push(0.75).notches], [2]);
  r.reset();
  assert.equal(r.value, 0);
  assert.deepEqual([...r.push(1).notches], [0, 1, 2]);
});

test('custom notches and completion threshold', () => {
  const r = createRatchet({ notches: [0.5], completeAt: 0.9 });
  assert.deepEqual([...r.push(0.6).notches], [0]);
  assert.equal(r.push(0.9).value, 1);
});
