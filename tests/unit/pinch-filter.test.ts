import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3 } from '../../src/core/types.ts';
import { MAX_PULL_SPEED_MPS } from '../../src/input/arbiter.ts';
import { createPinchFilter, type PinchFilterInput } from '../../src/input/pinch-filter.ts';
import { linearAmount } from '../../src/mechanisms/linear-handle.ts';
import { noisyPull, PULL_SCRIPT } from './helpers/noise.ts';

const HZ = 72;
// WIND.travelM / WIND.deadbandM (mechanisms/wind.ts imports three, so it cannot load under node --test).
const WIND_TRAVEL_M = 0.06;
const WIND_DEADBAND_M = 0.005;
const WIND_SNAP_AT = 0.9;
const AXIS: Vec3 = { x: 0, y: 0, z: 1 };

const input = (raw: Vec3, patch: Partial<PinchFilterInput> = {}): PinchFilterInput => ({
  tracked: true,
  raw,
  dt: 1 / HZ,
  selecting: true,
  start: false,
  end: false,
  ...patch,
});

/**
 * The whole conditioning chain of a Wind pull, as the app runs it:
 * pinch filter (HandsSystem) → rate-limited follow point (arbiter) →
 * linearAmount with the Wind deadband → ratchet (running maximum, clamped).
 * The select level comes from the true script shifted by the latency.
 */
function windPull(seed: number, jitterM: number, travelM: number): { progress: number; notches: number } {
  const latencyS = 0.07;
  const { frames, timeline } = noisyPull({
    seed,
    jitterM,
    latencyS,
    sampleHz: 30,
    frameHz: HZ,
    script: { ...PULL_SCRIPT, travelM },
  });
  const filter = createPinchFilter();
  const filtered: Vec3 = { x: 0, y: 0, z: 0 };
  const start: Vec3 = { x: 0, y: 0, z: 0 };
  const follow: Vec3 = { x: 0, y: 0, z: 0 };
  let selecting = false;
  let held = false;
  let ratchet = 0;
  for (const f of frames) {
    const now = f.time >= timeline.closeEnd + latencyS && f.time < timeline.openStart + latencyS;
    const startEdge = now && !selecting;
    const endEdge = !now && selecting;
    selecting = now;
    const tracked = filter.update(input(f.pinchPoint, { selecting, start: startEdge, end: endEdge }), filtered);
    if (startEdge && tracked) {
      Object.assign(start, filtered);
      Object.assign(follow, filtered);
      held = true;
    }
    if (endEdge) held = false;
    if (!held || !tracked) continue;
    const dx = filtered.x - follow.x;
    const dy = filtered.y - follow.y;
    const dz = filtered.z - follow.z;
    const d = Math.hypot(dx, dy, dz);
    const max = MAX_PULL_SPEED_MPS / HZ;
    const k = d <= max ? 1 : max / d;
    follow.x += dx * k;
    follow.y += dy * k;
    follow.z += dz * k;
    const a = linearAmount(start, follow, AXIS, WIND_TRAVEL_M, 0, WIND_DEADBAND_M);
    ratchet = Math.min(1, Math.max(ratchet, a));
  }
  const notches = [0.25, 0.5, 0.75].filter((n) => ratchet >= n).length;
  return { progress: ratchet, notches };
}

test('a still pinch with 1 cm RMS tip noise (the plan figure) never ratchets the tab', () => {
  let sum = 0;
  let worst = 0;
  let notched = 0;
  const RUNS = 300;
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = windPull(seed, 0.01, 0);
    sum += r.progress;
    worst = Math.max(worst, r.progress);
    if (r.notches > 0) notched++;
  }
  // Before the filter + deadband: mean 0.16 and 1 run in 10 fired a gust with the hand still.
  assert.ok(sum / RUNS < 0.05, `mean progress ${sum / RUNS}`);
  assert.equal(notched, 0, `worst progress ${worst}`);
});

test('a still pinch with typical 3 mm noise stays at zero', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = windPull(seed, 0.003, 0);
    assert.ok(r.progress < 0.01, `seed ${seed}: ${r.progress}`);
  }
});

test('a real pull through the same noise completes the tab (with the 0.90 end magnet)', () => {
  // The tab trails the fingers by the 5 mm deadband plus the filter lag, so a
  // full stroke is a little longer than the 6 cm of paper; the magnet closes the rest.
  const done = (r: { progress: number }) => (r.progress >= WIND_SNAP_AT ? 1 : r.progress);
  for (let seed = 1; seed <= 100; seed++) {
    assert.equal(done(windPull(seed, 0.003, 0.07)), 1, `3 mm, 7 cm, seed ${seed}`);
    assert.equal(done(windPull(seed, 0.01, 0.075)), 1, `1 cm, 7.5 cm, seed ${seed}`);
  }
});

test('re-seeded on the start edge: the grab reference is the raw point of that frame', () => {
  const f = createPinchFilter();
  const out: Vec3 = { x: 0, y: 0, z: 0 };
  f.update(input({ x: 0, y: 0, z: 0 }, { selecting: false }), out);
  // IWER snaps to the pinch pose: the midpoint jumps 8 cm on the start frame.
  assert.equal(f.update(input({ x: 0.08, y: 0, z: 0 }, { start: true }), out), true);
  assert.deepEqual(out, { x: 0.08, y: 0, z: 0 });
});

test('an impossible jump while held is a glitch: untracked for that frame, then accepted', () => {
  const f = createPinchFilter();
  const out: Vec3 = { x: 0, y: 0, z: 0 };
  f.update(input({ x: 0, y: 0, z: 0 }, { start: true }), out);
  f.update(input({ x: 0, y: 0, z: 0.001 }), out);
  const before = { ...out };
  assert.equal(f.update(input({ x: 0, y: 0, z: 0.05 }), out), false);
  assert.deepEqual(out, before, 'the spike never reaches the output');
  assert.equal(f.glitches, 1);
  // The hand really is there: next frame it is tracked again (re-seeded).
  assert.equal(f.update(input({ x: 0, y: 0, z: 0.0505 }), out), true);
  assert.ok(Math.abs(out.z - 0.0505) < 1e-12);
});

test('a fast but possible move is not a glitch', () => {
  const f = createPinchFilter();
  const out: Vec3 = { x: 0, y: 0, z: 0 };
  f.update(input({ x: 0, y: 0, z: 0 }, { start: true }), out);
  // 2.5 cm in one 72 Hz frame (1.8 m/s) is below glitchMinM.
  assert.equal(f.update(input({ x: 0, y: 0, z: 0.025 }), out), true);
  assert.equal(f.glitches, 0);
});

test('untracked or non-finite input → false, output untouched, then re-seeds', () => {
  const f = createPinchFilter();
  const out: Vec3 = { x: 1, y: 2, z: 3 };
  assert.equal(f.update(input({ x: 0, y: 0, z: 0 }, { tracked: false }), out), false);
  assert.equal(f.update(input({ x: Number.NaN, y: 0, z: 0 }), out), false);
  assert.deepEqual(out, { x: 1, y: 2, z: 3 });
  assert.equal(f.update(input({ x: 0.2, y: 0, z: 0 }), out), true);
  assert.deepEqual(out, { x: 0.2, y: 0, z: 0 });
});
