import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HeadSample, Vec3 } from '../../src/core/types.ts';
import {
  classifyHit,
  createStability,
  fallbackPose,
  PLACEMENT_DEFAULTS,
  settleEase,
  yawToHead,
} from '../../src/placement/filters.ts';

const DEG = Math.PI / 180;
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const HEAD: Vec3 = { x: 0, y: 1.2, z: 0 };

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Where a ray from the seated head (yaw 30°, pitch -40°) meets the 0.74 m table: ≈ (-0.274, 0.74, -0.475). */
const TABLE: Vec3 = (() => {
  const dir = v(-Math.sin(30 * DEG) * Math.cos(40 * DEG), -Math.sin(40 * DEG), -Math.cos(30 * DEG) * Math.cos(40 * DEG));
  const t = (0.74 - HEAD.y) / dir.y;
  return v(HEAD.x + t * dir.x, 0.74, HEAD.z + t * dir.z);
})();

function head(yawDeg: number, position: Vec3 = HEAD): HeadSample {
  const yaw = yawDeg * DEG;
  return { valid: true, position, forward: v(-Math.sin(yaw), 0, -Math.cos(yaw)), yaw, pitch: -15 * DEG };
}

function near(actual: number, expected: number, tol: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);
}

/** A point at horizontal distance `d` from the seated head, straight ahead, on the 0.74 m table. */
const ahead = (d: number): Vec3 => v(0, 0.74, -d);

test('classifyHit: the reference table hit is ok', () => {
  near(TABLE.x, -0.274, 0.001, 'x');
  near(TABLE.z, -0.475, 0.001, 'z');
  assert.equal(classifyHit(TABLE, UP, HEAD, true), 'ok');
});

test('classifyHit: one verdict per filter', () => {
  assert.equal(classifyHit(v(0, 0, -0.5), UP, HEAD, true), 'floor');
  assert.equal(classifyHit(TABLE, v(0, 0, 1), HEAD, true), 'tilted');
  const tilted30 = v(Math.sin(30 * DEG), Math.cos(30 * DEG), 0);
  assert.equal(classifyHit(TABLE, tilted30, HEAD, true), 'tilted');
  assert.equal(classifyHit(v(0, 1.1, -0.5), UP, HEAD, true), 'too-high');
  assert.equal(classifyHit(v(0, 0.4, -0.5), UP, HEAD, true), 'too-low');
  assert.equal(classifyHit(ahead(0.2), UP, HEAD, true), 'too-near');
  assert.equal(classifyHit(ahead(1.0), UP, HEAD, true), 'too-far');
});

test('classifyHit: thresholds are inclusive on the accepted side', () => {
  const tilt = Math.acos(PLACEMENT_DEFAULTS.minUpDot) * 0.99;
  assert.equal(classifyHit(TABLE, v(Math.sin(tilt), Math.cos(tilt), 0), HEAD, true), 'ok');
  assert.equal(classifyHit(ahead(0.25), UP, HEAD, true), 'ok');
  assert.equal(classifyHit(ahead(0.9), UP, HEAD, true), 'ok');
  // An un-normalised up normal still counts as up.
  assert.equal(classifyHit(TABLE, v(0, 3, 0), HEAD, true), 'ok');
});

test('classifyHit: check order (first failing filter wins)', () => {
  // Tilted wins over everything else.
  assert.equal(classifyHit(v(0, 0, -0.1), v(1, 0, 0), HEAD, true), 'tilted');
  // Floor wins over too-low and distance.
  assert.equal(classifyHit(v(0, 0, -3), UP, HEAD, true), 'floor');
  // Height wins over distance.
  assert.equal(classifyHit(v(0, 1.1, -0.1), UP, HEAD, true), 'too-high');
  assert.equal(classifyHit(v(0, 0.4, -3), UP, HEAD, true), 'too-low');
  // Distance comes last.
  assert.equal(classifyHit(v(0.1, 0.74, 0), UP, HEAD, true), 'too-near');
});

test('classifyHit: floorKnown=false skips only the floor rule', () => {
  // Local reference space: the head starts near y = 0, the table ~0.46 m below.
  const localHead = v(0, 0, 0);
  const localTable = v(TABLE.x, TABLE.y - HEAD.y, TABLE.z);
  assert.equal(classifyHit(localTable, UP, localHead, false), 'ok');
  assert.equal(classifyHit(localTable, UP, localHead, true), 'floor');
  // Head-relative rules still apply without a known floor.
  assert.equal(classifyHit(v(0, 0, -0.5), UP, HEAD, false), 'too-low');
});

test('classifyHit: non-finite input is no hit', () => {
  assert.equal(classifyHit(v(Number.NaN, 0.74, -0.5), UP, HEAD, true), 'none');
  assert.equal(classifyHit(TABLE, v(0, Number.POSITIVE_INFINITY, 0), HEAD, true), 'none');
  assert.equal(classifyHit(TABLE, v(0, 0, 0), HEAD, true), 'tilted');
});

test('yawToHead: the reference table faces the head at 30°', () => {
  near(yawToHead(TABLE, HEAD) / DEG, 30, 0.01, 'yaw');
  near(yawToHead(v(0, 0.74, -0.45), HEAD), 0, 1e-12, 'straight ahead');
  near(yawToHead(v(0, 0.74, 0.45), HEAD) / DEG, 180, 1e-9, 'behind');
  near(yawToHead(v(0.45, 0.74, 0), HEAD) / DEG, -90, 1e-9, 'right');
  assert.equal(yawToHead(v(0, 0.74, 0), HEAD), 0);
});

test('fallbackPose: 45 cm ahead and below a head turned 30° left', () => {
  const pose = fallbackPose(head(30), null);
  near(pose.position.x, -0.225, 0.001, 'x');
  near(pose.position.y, 0.75, 1e-9, 'y');
  near(pose.position.z, -0.39, 0.001, 'z');
  near(pose.yaw / DEG, 30, 1e-6, 'yaw');
});

test('fallbackPose: a pinch inside the band marks the lid height', () => {
  near(fallbackPose(head(30), 0.85).position.y, 0.78, 1e-9, 'in band');
  // The default IWER hand (1.47 m) is above the head-relative band: default height.
  near(fallbackPose(head(30), 1.47).position.y, 0.75, 1e-9, 'above band');
  near(fallbackPose(head(30), 0.2).position.y, 0.75, 1e-9, 'below band');
  // Band = [0.25, 0.75] m below the head.
  near(fallbackPose(head(30), 1.2 - 0.26).position.y, 1.2 - 0.26 - 0.07, 1e-9, 'inside top');
  near(fallbackPose(head(30), 1.2 - 0.74).position.y, 1.2 - 0.74 - 0.07, 1e-9, 'inside bottom');
  near(fallbackPose(head(30), 1.2 - 0.24).position.y, 0.75, 1e-9, 'outside top');
  near(fallbackPose(head(30), 1.2 - 0.76).position.y, 0.75, 1e-9, 'outside bottom');
  near(fallbackPose(head(30), Number.NaN).position.y, 0.75, 1e-9, 'NaN');
});

test('fallbackPose: writes into `out` and survives a degenerate forward', () => {
  const out = { position: v(9, 9, 9), yaw: 9 };
  const h = head(0);
  const res = fallbackPose({ ...h, forward: v(0, 0, 0), yaw: 90 * DEG }, null, PLACEMENT_DEFAULTS, out);
  assert.equal(res, out);
  // Yaw 90° looks along -X.
  near(out.position.x, -0.45, 1e-9, 'x');
  near(out.position.z, 0, 1e-9, 'z');
  near(out.yaw / DEG, 90, 1e-6, 'yaw');
  // Non-unit forward is normalised.
  const scaled = fallbackPose({ ...h, forward: v(0, 0, -2) }, null);
  near(scaled.position.z, -0.45, 1e-9, 'z');
});

test('createStability: runs, jitter, jumps and resets', () => {
  const s = createStability();
  const p = v(-0.274, 0.74, -0.475);
  let n = 0;
  for (let i = 0; i < 10; i++) n = s.push(p);
  assert.equal(n, 10);
  // ±5 mm jitter around the first hit keeps the run going.
  assert.equal(s.push(v(p.x + 0.005, p.y, p.z)), 11);
  assert.equal(s.push(v(p.x, p.y, p.z - 0.005)), 12);
  assert.equal(s.push(v(p.x - 0.005, p.y, p.z + 0.005)), 13);
  // A 2 cm jump starts a new run anchored at the new point.
  const q = v(p.x + 0.02, p.y, p.z);
  assert.equal(s.push(q), 1);
  assert.equal(s.push(q), 2);
  // No valid hit: back to 0.
  assert.equal(s.push(null), 0);
  assert.equal(s.push(q), 1);
  s.reset();
  assert.equal(s.push(q), 1);
  assert.equal(s.push(v(Number.NaN, 0, 0)), 0);
});

test('createStability: the anchor follows a slow drift; a jump starts a new run', () => {
  const s = createStability();
  const counts: number[] = [];
  // 1.5 mm per frame (a fast head drift): the run keeps growing.
  for (let i = 0; i < 40; i++) counts.push(s.push(v(i * 0.0015, 0.74, -0.5)));
  assert.equal(counts.at(-1), 40);
  // A 2 cm jump (another surface) breaks it.
  assert.equal(s.push(v(0.06 + 0.02, 0.74, -0.5)), 1);
});

test('settleEase: easeOutCubic, clamped and monotonic', () => {
  assert.equal(settleEase(0), 0);
  near(settleEase(0.5), 0.875, 1e-12, 'mid');
  assert.equal(settleEase(1), 1);
  assert.equal(settleEase(-1), 0);
  assert.equal(settleEase(2), 1);
  assert.equal(settleEase(Number.NaN), 0);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const e = settleEase(i / 100);
    assert.ok(e >= prev, `monotonic at ${i}`);
    prev = e;
  }
});
