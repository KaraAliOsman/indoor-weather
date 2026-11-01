import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { PinchState, ReleaseReason } from '../../src/core/types.ts';
import { createDistancePinch, DISTANCE_PINCH_DEFAULTS } from '../../src/input/distance-pinch.ts';
import { createPinchFsm, type PinchFsmInput } from '../../src/input/pinch-fsm.ts';
import { noisyPull } from './helpers/noise.ts';

const HZ = 72;
const FRAME = 1 / HZ;

/** One FSM driver per test: frame clock plus a mutable input with sane defaults. */
function driver() {
  const fsm = createPinchFsm();
  let frame = 0;
  const base: PinchFsmInput = {
    time: 0,
    tracked: true,
    selectStart: false,
    selectEnd: false,
    selecting: false,
    canGrab: true,
    moved: 0,
    allowed: true,
  };
  return {
    fsm,
    get time() {
      return frame / HZ;
    },
    step(patch: Partial<PinchFsmInput> = {}) {
      const r = fsm.step({ ...base, ...patch, time: frame / HZ });
      frame++;
      return { ...r };
    },
  };
}

/** start → armed → pulling, returns the driver in 'pulling'. */
function pulling() {
  const d = driver();
  assert.equal(d.step({ selectStart: true, selecting: true }).state, 'armed');
  assert.equal(d.step({ selecting: true, moved: 0.01 }).state, 'pulling');
  return d;
}

describe('pinch FSM', () => {
  test('clean pull: idle → armed → pulling → released(release) → idle', () => {
    const d = driver();
    const g = d.step({ selectStart: true, selecting: true });
    assert.deepEqual(g, { state: 'armed', prev: 'idle', grabbed: true, resumed: false, released: null });
    // Inside the 8 mm deadzone (filtered noise stays below it): still armed.
    assert.equal(d.step({ selecting: true, moved: 0.006 }).state, 'armed');
    const p = d.step({ selecting: true, moved: 0.009 });
    assert.equal(p.state, 'pulling');
    assert.equal(p.grabbed, false);
    assert.equal(d.step({ selecting: true, moved: 0.03 }).state, 'pulling');
    const r = d.step({ selectEnd: true, selecting: false, moved: 0.03 });
    assert.deepEqual(r, { state: 'released', prev: 'pulling', grabbed: false, resumed: false, released: 'release' });
    assert.deepEqual(d.step(), { state: 'idle', prev: 'released', grabbed: false, resumed: false, released: null });
  });

  test('holding → pulling flags resumed exactly once', () => {
    const d = driver();
    d.step({ selectStart: true, selecting: true });
    d.step({ selecting: true, moved: 0.01 });
    assert.equal(d.step({ tracked: false, selecting: true, moved: 0.01 }).state, 'holding');
    const back = d.step({ selecting: true, moved: 0.01 });
    assert.equal(back.state, 'pulling');
    assert.equal(back.resumed, true);
    assert.equal(d.step({ selecting: true, moved: 0.012 }).resumed, false);
  });

  test('tap without moving: armed → released(release), never pulling', () => {
    const d = driver();
    assert.equal(d.step({ selectStart: true, selecting: true }).state, 'armed');
    const r = d.step({ selectEnd: true });
    assert.equal(r.prev, 'armed');
    assert.equal(r.released, 'release');
  });

  test('a falling level without an end edge also releases', () => {
    const d = pulling();
    assert.equal(d.step({ selecting: false }).released, 'release');
  });

  test('start out of range (canGrab=false), not allowed or untracked does nothing', () => {
    const d = driver();
    for (const patch of [{ canGrab: false }, { allowed: false }, { tracked: false }]) {
      const r = d.step({ selectStart: true, selecting: true, ...patch });
      assert.equal(r.state, 'idle');
      assert.equal(r.grabbed, false);
      d.step({ selectEnd: true });
    }
  });

  test('a start right after a release is not lost (released lasts one step)', () => {
    const d = pulling();
    assert.equal(d.step({ selectEnd: true }).state, 'released');
    const g = d.step({ selectStart: true, selecting: true });
    assert.equal(g.prev, 'released');
    assert.equal(g.state, 'armed');
    assert.equal(g.grabbed, true);
  });

  test('250 ms tracking loss while pulling: holding → pulling, no release', () => {
    const d = pulling();
    const lostFrames = Math.round(0.25 * HZ);
    const states: PinchState[] = [];
    for (let i = 0; i < lostFrames; i++) {
      // Runtimes may fire selectend when the hand drops out: ignored while untracked.
      const r = d.step({ tracked: false, selecting: false, selectEnd: i === 0 });
      assert.equal(r.released, null);
      states.push(r.state);
    }
    assert.ok(states.every((s) => s === 'holding'));
    const back = d.step({ tracked: true, selecting: true, moved: 0.02 });
    assert.equal(back.state, 'pulling');
    assert.equal(back.released, null);
  });

  test('tracking returns with a fresh start edge: holding → pulling', () => {
    const d = pulling();
    d.step({ tracked: false });
    assert.equal(d.step({ tracked: true, selectStart: true, selecting: true }).state, 'pulling');
  });

  test('350 ms tracking loss: released(tracking-lost) at 0.30 s ± 1 frame', () => {
    const d = pulling();
    const lostAt = d.time;
    let releasedAt = NaN;
    let reason: ReleaseReason | null = null;
    for (let i = 0; i < Math.round(0.35 * HZ); i++) {
      const t = d.time;
      const r = d.step({ tracked: false });
      if (r.released) {
        releasedAt = t;
        reason = r.released;
        break;
      }
    }
    assert.equal(reason, 'tracking-lost');
    assert.ok(Math.abs(releasedAt - lostAt - 0.3) <= FRAME + 1e-9, `released after ${releasedAt - lostAt} s`);
  });

  test('tracking returns without selecting: released(release)', () => {
    const d = pulling();
    d.step({ tracked: false });
    d.step({ tracked: false });
    const r = d.step({ tracked: true, selecting: false });
    assert.equal(r.prev, 'holding');
    assert.equal(r.released, 'release');
  });

  test('allowed=false cancels from armed, pulling and holding', () => {
    const fromArmed = driver();
    fromArmed.step({ selectStart: true, selecting: true });
    assert.equal(fromArmed.step({ selecting: true, allowed: false }).released, 'cancel');

    const fromPulling = pulling();
    assert.equal(fromPulling.step({ selecting: true, allowed: false }).released, 'cancel');

    const fromHolding = pulling();
    fromHolding.step({ tracked: false });
    assert.equal(fromHolding.step({ tracked: false, allowed: false }).released, 'cancel');
  });

  test('reset() returns to idle', () => {
    const d = pulling();
    d.fsm.reset();
    assert.equal(d.fsm.state, 'idle');
  });
});

describe('distance pinch (source B)', () => {
  const { enterM, exitM, refHandScaleM } = DISTANCE_PINCH_DEFAULTS;

  test('hysteresis with 3 new samples to confirm each way', () => {
    const p = createDistancePinch();
    const edges: string[] = [];
    const feed = (d: number) => {
      const r = p.update(d, refHandScaleM);
      if (r.start) edges.push('start');
      if (r.end) edges.push('end');
      return r.selecting;
    };
    feed(0.06);
    feed(0.01);
    feed(0.011);
    assert.equal(feed(0.02), false, 'a sample inside the band breaks the streak');
    feed(0.01);
    feed(0.011);
    assert.equal(feed(0.012), true);
    assert.deepEqual(edges, ['start']);
    // Between the thresholds nothing changes.
    feed(0.025);
    feed(0.026);
    assert.equal(feed(0.027), true);
    feed(0.04);
    feed(0.041);
    assert.equal(feed(0.042), false);
    assert.deepEqual(edges, ['start', 'end']);
  });

  test('repeated (held) samples do not count toward confirmation', () => {
    const p = createDistancePinch();
    for (let i = 0; i < 10; i++) assert.equal(p.update(0.005, refHandScaleM).selecting, false);
    p.update(0.006, refHandScaleM);
    assert.equal(p.update(0.007, refHandScaleM).start, true);
  });

  test('non-finite distances are not samples', () => {
    const p = createDistancePinch();
    p.update(0.005, refHandScaleM);
    p.update(NaN, refHandScaleM);
    p.update(0.006, refHandScaleM);
    assert.equal(p.update(0.007, refHandScaleM).start, true);
  });

  test('thresholds scale with the hand', () => {
    const big = createDistancePinch();
    const d = enterM * 1.2; // above the reference threshold, below the scaled one
    big.update(d, refHandScaleM * 1.5);
    big.update(d + 1e-4, refHandScaleM * 1.5);
    assert.equal(big.update(d + 2e-4, refHandScaleM * 1.5).start, true);
    const ref = createDistancePinch();
    ref.update(d, refHandScaleM);
    ref.update(d + 1e-4, refHandScaleM);
    assert.equal(ref.update(d + 2e-4, refHandScaleM).selecting, false);
    assert.ok(exitM > enterM);
  });
});

/**
 * U-pinch: distance pinch + FSM under 1 cm / 70 ms / 30 Hz tracking noise.
 * Definitions (times of the true script, see helpers/noise.ts):
 * - false release: any release before openStart + latency, i.e. while the
 *   measured hand is still fully closed;
 * - false grab: a grab before closeStart + latency, or any grab after the
 *   real release;
 * - real release latency: from openEnd (hand fully open) to the release; the
 *   bound is latency + 3 sample periods + 1 frame = 0.184 s.
 */
describe('U-pinch: noise injector (500 seeds, 1 cm RMS, 70 ms, 30 Hz)', () => {
  const RUNS = 500;
  const LATENCY = 0.07;
  const SAMPLE_HZ = 30;
  const BOUND = LATENCY + 3 / SAMPLE_HZ + 1 / HZ;

  interface Run {
    grabs: number[];
    releases: { t: number; reason: ReleaseReason }[];
  }

  function run(seed: number): Run & { timeline: ReturnType<typeof noisyPull>['timeline'] } {
    const opts = { seed, jitterM: 0.01, latencyS: LATENCY, sampleHz: SAMPLE_HZ, frameHz: HZ };
    const { frames, timeline } = noisyPull(opts);
    const pinch = createDistancePinch();
    const fsm = createPinchFsm();
    const grabStart = { x: 0, y: 0, z: 0 };
    const out: Run = { grabs: [], releases: [] };
    for (const f of frames) {
      const e = pinch.update(f.tipDistance, DISTANCE_PINCH_DEFAULTS.refHandScaleM);
      const holding = fsm.state !== 'idle' && fsm.state !== 'released';
      const p = f.pinchPoint;
      const moved = holding ? Math.hypot(p.x - grabStart.x, p.y - grabStart.y, p.z - grabStart.z) : 0;
      const r = fsm.step({
        time: f.time,
        tracked: true,
        selectStart: e.start,
        selectEnd: e.end,
        selecting: e.selecting,
        canGrab: true,
        moved,
        allowed: true,
      });
      if (r.grabbed) {
        out.grabs.push(f.time);
        grabStart.x = p.x;
        grabStart.y = p.y;
        grabStart.z = p.z;
      }
      if (r.released) out.releases.push({ t: f.time, reason: r.released });
    }
    return { ...out, timeline };
  }

  const runs = Array.from({ length: RUNS }, (_, seed) => run(seed + 1));

  test('false releases < 2 % of runs', () => {
    const bad = runs.filter((r) => r.releases.some((x) => x.t < r.timeline.openStart + LATENCY)).length;
    assert.ok(bad / RUNS < 0.02, `${bad}/${RUNS} runs released early`);
  });

  test('false grabs with the hand open < 1 % of runs', () => {
    const bad = runs.filter((r) => {
      const real = r.releases.find((x) => x.t >= r.timeline.openStart + LATENCY);
      return r.grabs.some((t) => t < r.timeline.closeStart + LATENCY || (real !== undefined && t > real.t));
    }).length;
    assert.ok(bad / RUNS < 0.01, `${bad}/${RUNS} runs grabbed with the hand open`);
  });

  test(`real release within ${BOUND.toFixed(3)} s of opening in >= 98 % of runs`, () => {
    const good = runs.filter((r) => {
      if (r.grabs.length === 0) return false;
      const real = r.releases.find((x) => x.t >= r.timeline.openStart + LATENCY);
      return real !== undefined && real.reason === 'release' && real.t - r.timeline.openEnd <= BOUND + 1e-9;
    }).length;
    assert.ok(good / RUNS >= 0.98, `${good}/${RUNS} runs released in time`);
  });

  test('deterministic for a given seed', () => {
    const a = run(42);
    const b = run(42);
    assert.deepEqual(a, b);
    assert.notDeepEqual(run(43).grabs, a.grabs);
  });
});
