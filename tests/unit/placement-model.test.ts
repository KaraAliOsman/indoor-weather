import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HeadSample, PlacementMode, PlacementModeReason, Vec3 } from '../../src/core/types.ts';
import { yawToHead } from '../../src/placement/filters.ts';
import {
  createPlacementModel,
  type HitTestAvailability,
  type PlacementInput,
  type PlacementModel,
  type PlacementOutput,
} from '../../src/placement/placement-model.ts';

const DEG = Math.PI / 180;
/** The M1 behaviour these tests pin down: pinch to land, 6 s to fallback. Auto landing has its own tests below. */
const MANUAL = { autoCommitFrames: 0, fallbackAfterS: 6 } as const;
const FRAME = 1 / 72;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const HEAD: HeadSample = {
  valid: true,
  position: v(0, 1.2, 0),
  forward: v(0, 0, -1),
  yaw: 0,
  pitch: -15 * DEG,
};
const TABLE_HIT = { position: v(-0.2, 0.74, -0.45), normal: v(0, 1, 0) };
const FLOOR_HIT = { position: v(0, 0, 0.44), normal: v(0, 1, 0) };

function near(actual: number, expected: number, tol: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);
}

/** Frame driver: one step per call at 72 Hz unless `time` is given. */
function driver(model: PlacementModel, base: Partial<PlacementInput> = {}) {
  let time = 0;
  const changes: Array<{ mode: PlacementMode; reason: PlacementModeReason; time: number }> = [];
  model.start(time);
  const input: PlacementInput = {
    time,
    visible: true,
    hitTest: 'unknown',
    hit: null,
    head: HEAD,
    floorKnown: true,
    selectStart: false,
    pinchY: null,
    ...base,
  };
  return {
    changes,
    get time() {
      return time;
    },
    step(over: Partial<PlacementInput> = {}): PlacementOutput {
      time = over.time ?? time + FRAME;
      const out = model.step({ ...input, ...over, time });
      if (out.modeChange) changes.push({ ...out.modeChange, time });
      return out;
    },
    /** Step until `time` (inclusive), returning the last output. */
    runUntil(t: number, over: Partial<PlacementInput> = {}): PlacementOutput {
      let out = this.step(over);
      while (time + FRAME <= t + 1e-9) out = this.step(over);
      return out;
    },
  };
}

test("model: 'unavailable' probe → fallback/'no-hit-test' on the first step", () => {
  const model = createPlacementModel(MANUAL);
  assert.equal(model.status.mode, 'idle');
  const d = driver(model);
  assert.equal(model.status.mode, 'probing');
  const out = d.step({ hitTest: 'unavailable' });
  assert.deepEqual(out.modeChange, { mode: 'fallback', reason: 'no-hit-test' });
  // Candidate 45 cm ahead and below the head, facing it; the reticle marks it.
  const c = out.status.candidate;
  assert.ok(c);
  near(c.position.x, 0, 1e-9, 'x');
  near(c.position.y, 0.75, 1e-9, 'y');
  near(c.position.z, -0.45, 1e-9, 'z');
  near(c.yaw, 0, 1e-9, 'yaw');
  assert.equal(out.status.valid, true);
  assert.equal(out.status.reticleVisible, true);
});

test("model: 'available' without hits stays in hit-test until 6 s, then one timeout", () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available' });
  const first = d.step();
  assert.deepEqual(first.modeChange, { mode: 'hit-test', reason: 'start' });
  let out = d.runUntil(5.9);
  assert.equal(out.status.mode, 'hit-test');
  assert.equal(out.status.reticleVisible, false);
  assert.equal(out.status.valid, false);
  out = d.runUntil(6.0);
  assert.equal(out.status.mode, 'fallback');
  d.runUntil(9);
  const timeouts = d.changes.filter((ch) => ch.reason === 'timeout');
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0]!.mode, 'fallback');
  near(timeouts[0]!.time, 6.0, FRAME + 1e-9, 'timeout time');
  near(model.status.elapsed, 9, FRAME + 1e-9, 'elapsed');
});

test('model: rejected hits (floor) do not reset the fallback timer and show a grey reticle', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available', hit: FLOOR_HIT });
  d.step();
  const out = d.step();
  assert.equal(out.status.verdict, 'floor');
  assert.equal(out.status.reticleVisible, true);
  assert.equal(out.status.valid, false);
  d.runUntil(6.1);
  assert.equal(model.status.mode, 'fallback');
});

test('model: a select commits only after 10 stable valid hits, with the hit pose and yaw to the head', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available' });
  // The system reuses one scratch hit object every frame.
  const hit = { position: { ...TABLE_HIT.position }, normal: { ...TABLE_HIT.normal } };
  d.step(); // probing → hit-test
  for (let i = 1; i <= 8; i++) {
    const out = d.step({ hit });
    assert.equal(out.status.stableFrames, i);
    assert.equal(out.status.valid, false);
  }
  const ninth = d.step({ hit, selectStart: true });
  assert.equal(ninth.status.stableFrames, 9);
  assert.equal(ninth.commit, null);
  assert.equal(ninth.status.mode, 'hit-test');
  const tenth = d.step({ hit, selectStart: true });
  assert.ok(tenth.commit);
  const commit = tenth.commit;
  assert.equal(commit.source, 'hit-test');
  assert.deepEqual(commit.pose.position, TABLE_HIT.position);
  near(commit.pose.yaw, yawToHead(TABLE_HIT.position, HEAD.position), 1e-12, 'yaw');
  assert.deepEqual(tenth.modeChange, { mode: 'committed', reason: 'commit' });
  assert.equal(tenth.status.reticleVisible, false);
  assert.equal(tenth.status.candidate, null);
  // The commit pose is a copy: mutating the scratch hit does not leak into it.
  hit.position.x = 5;
  assert.equal(commit.pose.position.x, TABLE_HIT.position.x);
  // Committed: further steps are inert.
  const after = d.step({ hit, selectStart: true });
  assert.equal(after.commit, null);
  assert.equal(after.modeChange, null);
});

test('model: valid hits before the select show the candidate; one invalid frame resets stability', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available' });
  d.step();
  for (let i = 0; i < 10; i++) d.step({ hit: TABLE_HIT });
  assert.equal(model.status.valid, true);
  assert.ok(model.status.candidate);
  d.step({ hit: FLOOR_HIT });
  assert.equal(model.status.stableFrames, 0);
  assert.equal(model.status.valid, false);
  assert.equal(model.status.candidate, null);
  const out = d.step({ hit: TABLE_HIT, selectStart: true });
  assert.equal(out.status.stableFrames, 1);
  assert.equal(out.commit, null);
});

test("model: fallback followed by stable valid hits → hit-test/'surface-found'", () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available' });
  d.step();
  d.runUntil(6.05);
  assert.equal(model.status.mode, 'fallback');
  for (let i = 1; i <= 9; i++) {
    const out = d.step({ hit: TABLE_HIT });
    assert.equal(out.status.mode, 'fallback', `frame ${i}`);
    // The reticle stays on the fallback candidate meanwhile.
    assert.ok(out.status.candidate);
    near(out.status.candidate.position.z, -0.45, 1e-9, 'fallback z');
  }
  const found = d.step({ hit: TABLE_HIT });
  assert.deepEqual(found.modeChange, { mode: 'hit-test', reason: 'surface-found' });
  assert.equal(found.status.valid, true);
  assert.deepEqual(found.status.candidate?.position, TABLE_HIT.position);
  // The fallback timer restarted with the valid hits: no immediate timeout.
  d.runUntil(d.time + 3, { hit: null });
  assert.equal(model.status.mode, 'hit-test');
});

test('model: a fallback select commits at the default height or at the pinch', () => {
  const pinchIn = createPlacementModel(MANUAL);
  const a = driver(pinchIn, { hitTest: 'unavailable' });
  a.step();
  const outA = a.step({ selectStart: true, pinchY: 0.85 });
  assert.ok(outA.commit);
  assert.equal(outA.commit.source, 'fallback');
  near(outA.commit.pose.position.y, 0.78, 1e-9, 'pinch height');

  const pinchOut = createPlacementModel(MANUAL);
  const b = driver(pinchOut, { hitTest: 'unavailable' });
  b.step();
  const outB = b.step({ selectStart: true, pinchY: 1.475 });
  assert.ok(outB.commit);
  near(outB.commit.pose.position.y, 0.75, 1e-9, 'default height');
  near(outB.commit.pose.position.z, -0.45, 1e-9, 'z');
});

test('model: a select on the step that changes the mode is ignored', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model);
  const out = d.step({ hitTest: 'unavailable', selectStart: true });
  assert.equal(out.modeChange?.mode, 'fallback');
  assert.equal(out.commit, null);
  assert.ok(d.step({ hitTest: 'unavailable', selectStart: true }).commit);
});

test('model: while not visible nothing commits and the timer does not advance', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available' });
  d.step();
  // 20 hidden seconds with no hits: no timeout.
  d.runUntil(20, { visible: false });
  assert.equal(model.status.mode, 'hit-test');
  assert.equal(model.status.elapsed, FRAME);
  // Stable valid hits while hidden: still no commit.
  for (let i = 0; i < 12; i++) d.step({ visible: false, hit: TABLE_HIT, selectStart: true });
  assert.equal(model.status.mode, 'hit-test');
  // Visible again: the select goes through.
  assert.ok(d.step({ hit: TABLE_HIT, selectStart: true }).commit);
});

test('model: the first step after a long gap only adds 0.25 s', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'available' });
  d.step();
  const before = model.status.elapsed;
  d.step({ time: d.time + 30 }); // Quest stops rAF while hidden
  near(model.status.elapsed - before, 0.25, 1e-12, 'clamped gap');
  assert.equal(model.status.mode, 'hit-test');
});

test('model: a probe that never resolves falls back after 6 s', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model);
  d.runUntil(6.05);
  assert.equal(model.status.mode, 'fallback');
  assert.deepEqual(
    d.changes.map((ch) => [ch.mode, ch.reason]),
    [['fallback', 'timeout']],
  );
  // A late successful probe still lets a real surface take over.
  d.step({ hitTest: 'available' });
  for (let i = 0; i < 10; i++) d.step({ hitTest: 'available', hit: TABLE_HIT });
  assert.equal(model.status.mode, 'hit-test');
});

test('model: invalid head → no fallback candidate', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'unavailable', head: { ...HEAD, valid: false } });
  d.step();
  const out = d.step({ selectStart: true });
  assert.equal(out.status.candidate, null);
  assert.equal(out.status.valid, false);
  assert.equal(out.status.reticleVisible, false);
  assert.equal(out.commit, null);
});

test("model: forceCommit gives 'debug' and a second commit is ignored", () => {
  const model = createPlacementModel(MANUAL);
  // Not started: nothing to commit.
  assert.equal(model.forceCommit({ position: v(0, 0.74, -0.45), yaw: 0 }, 0), null);
  const d = driver(model);
  d.step();
  // Probing has no candidate: an explicit pose is required.
  assert.equal(model.forceCommit(null, d.time), null);
  const pose = { position: v(0, 0.74, -0.45), yaw: 0.1 };
  const out = model.forceCommit(pose, d.time);
  assert.ok(out?.commit);
  assert.equal(out.commit.source, 'debug');
  assert.deepEqual(out.commit.pose, pose);
  assert.notEqual(out.commit.pose, pose);
  assert.deepEqual(out.modeChange, { mode: 'committed', reason: 'commit' });
  assert.equal(model.forceCommit(pose, d.time), null);
  assert.equal(d.step({ hitTest: 'unavailable', selectStart: true }).commit, null);
});

test('model: forceCommit(null) uses the current candidate; non-finite poses are rejected', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'unavailable' });
  d.step();
  assert.equal(model.forceCommit({ position: v(Number.NaN, 0, 0), yaw: 0 }, d.time), null);
  const out = model.forceCommit(null, d.time);
  assert.ok(out?.commit);
  near(out.commit.pose.position.z, -0.45, 1e-9, 'candidate z');
});

test('model: reset returns to idle and start begins a fresh session', () => {
  const model = createPlacementModel(MANUAL);
  const d = driver(model, { hitTest: 'unavailable' });
  d.runUntil(1);
  model.reset();
  assert.equal(model.status.mode, 'idle');
  assert.equal(model.status.candidate, null);
  const idle = d.step({ selectStart: true });
  assert.equal(idle.commit, null);
  assert.equal(idle.modeChange, null);
  model.start(d.time);
  assert.equal(model.status.mode, 'probing');
  assert.equal(model.status.elapsed, 0);
});

test('model: custom config is honoured', () => {
  const model = createPlacementModel({ ...MANUAL, stableFrames: 3, fallbackAfterS: 1 });
  const d = driver(model, { hitTest: 'available' as HitTestAvailability });
  d.step();
  d.step({ hit: TABLE_HIT });
  d.step({ hit: TABLE_HIT });
  assert.ok(d.step({ hit: TABLE_HIT, selectStart: true }).commit);
  const model2 = createPlacementModel({ ...MANUAL, fallbackAfterS: 1 });
  const d2 = driver(model2, { hitTest: 'available' });
  d2.runUntil(1.01);
  assert.equal(model2.status.mode, 'fallback');
});

test('auto landing: 30 stable valid hits land the box without a pinch', () => {
  const model = createPlacementModel();
  const d = driver(model, { hitTest: 'available' });
  d.step();
  let landed: PlacementOutput['commit'] = null;
  let frames = 0;
  while (!landed && frames < 100) {
    landed = d.step({ hit: TABLE_HIT }).commit;
    frames++;
  }
  assert.ok(landed, 'landed');
  assert.equal(landed.source, 'hit-test');
  assert.equal(frames, 30);
  assert.deepEqual(landed.pose.position, TABLE_HIT.position);
});

test('auto landing: a seated head drifting 1.5 cm/s still lands (stability follows the drift)', () => {
  const model = createPlacementModel();
  const d = driver(model, { hitTest: 'available' });
  d.step();
  let landed = null;
  for (let i = 0; i < 72 && !landed; i++) {
    const hit = { position: v(TABLE_HIT.position.x + i * (0.015 / 72), 0.74, -0.45), normal: v(0, 1, 0) };
    landed = d.step({ hit }).commit;
  }
  assert.ok(landed, 'a slow drift must not keep resetting the stability run');
});

test('auto landing: no table → fallback after 4 s, then the box lands on its own 1.2 s later', () => {
  const model = createPlacementModel();
  const d = driver(model, { hitTest: 'available' });
  let commit: PlacementOutput['commit'] = null;
  let at = 0;
  while (!commit && d.time < 10) {
    commit = d.step().commit;
    at = d.time;
  }
  assert.ok(commit);
  assert.equal(commit.source, 'fallback');
  near(at, 4 + 1.2, 2 * FRAME, 'landing time');
  assert.deepEqual(
    d.changes.map((c) => [c.mode, c.reason]),
    [
      ['hit-test', 'start'],
      ['fallback', 'timeout'],
      ['committed', 'commit'],
    ],
  );
});
