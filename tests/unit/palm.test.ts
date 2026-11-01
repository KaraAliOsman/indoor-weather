import assert from 'node:assert/strict';
import { test } from 'node:test';
// IWER 2.5.0 data only (the pose the emulator uses on the pinch frame).
import { pinchHandPose } from 'iwer/lib/device/configs/hand/pinch.js';
import type { Vec3 } from '../../src/core/types.ts';
import { PALM_VETO_COS, PALM_VETO_MAX_DROP_M, palmToHead, vetoStart } from '../../src/input/palm.ts';

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const neg = (a: Vec3): Vec3 => v(-a.x, -a.y, -a.z);

/**
 * −Y of IWER's RIGHT wrist in the pinch pose, as hand-frame.ts computes it
 * (palmNormal = −Y of joint 0) with an identity hand rotation. IWER stores the
 * left hand and mirrors it with this element-wise multiplier
 * (nm/iwer/lib/device/XRHandInput.js, mirrorMultiplierMatrix).
 */
function iwerRightWristMinusY(): Vec3 {
  const MIRROR = [1, -1, -1, 0, -1, 1, 1, 0, -1, 1, 1, 0, -1, 1, 1, 1];
  const m = Array.from(pinchHandPose.jointTransforms.wrist.offsetMatrix as ArrayLike<number>, (x, i) => x * MIRROR[i]);
  return v(-m[4], -m[5], -m[6]);
}

test('palm facing the head: cos ≈ 1 → veto (only when enabled)', () => {
  const wrist = v(0.1, 1.4, -0.3);
  const head = v(0, 1.6, 0);
  const n = v(head.x - wrist.x, head.y - wrist.y, head.z - wrist.z);
  const c = palmToHead(n, wrist, head);
  const drop = head.y - wrist.y;
  assert.ok(Math.abs(c - 1) < 1e-9);
  assert.equal(vetoStart(c, drop, true), true);
  assert.equal(vetoStart(c, drop, false), false);
  // Not unit length: still a cosine.
  assert.ok(Math.abs(palmToHead(v(n.x * 7, n.y * 7, n.z * 7), wrist, head) - 1) < 1e-9);
});

test('threshold is strict: cos = 0.7 does not veto', () => {
  assert.equal(vetoStart(PALM_VETO_COS, 0.1, true), false);
  assert.equal(vetoStart(PALM_VETO_COS + 1e-6, 0.1, true), true);
  // Height is strict too: exactly PALM_VETO_MAX_DROP_M below the eyes is not raised.
  assert.equal(vetoStart(0.99, PALM_VETO_MAX_DROP_M, true), false);
});

test('IWER right wrist in the pinch pose: −Y ≈ (−0.08, −0.81, −0.58)', () => {
  const n = iwerRightWristMinusY();
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  assert.ok(near(n.x, -0.08) && near(n.y, -0.81) && near(n.z, -0.58), JSON.stringify(n));
});

test('regression: IWER default hand (0.25, 1.5, −0.4), standing head → cos ≈ −0.6, no veto', () => {
  const n = iwerRightWristMinusY();
  const c = palmToHead(n, v(0.25, 1.5, -0.4), v(0, 1.6, 0));
  assert.ok(Math.abs(c - -0.6) < 0.05, `cos = ${c}`);
  assert.equal(vetoStart(c, 0.1, true), false);
  // This pose cannot catch a flipped sign on its own: +0.6 is below the threshold too.
  assert.equal(vetoStart(palmToHead(neg(n), v(0.25, 1.5, -0.4), v(0, 1.6, 0)), 0.1, true), false);
});

test('sign check: E2E-05 pose (wrist over the tab, seated head) → cos ≈ −1; a flipped normal would veto', () => {
  const n = iwerRightWristMinusY();
  const wrist = v(-0.02, 0.79, -0.27);
  const head = v(0, 1.2, 0);
  const c = palmToHead(n, wrist, head);
  assert.ok(c < -0.95, `cos = ${c}`);
  assert.equal(vetoStart(c, head.y - wrist.y, true), false);
  const flipped = palmToHead(neg(n), wrist, head);
  assert.ok(flipped > 0.95, `flipped cos = ${flipped}`);
  // A flipped normal would veto as soon as the hand is raised.
  assert.equal(vetoStart(flipped, 0.2, true), true);
});

test('degenerate input → NaN → never vetoes', () => {
  assert.ok(Number.isNaN(palmToHead(v(0, 0, 0), v(0, 1, 0), v(0, 1.6, 0))));
  assert.ok(Number.isNaN(palmToHead(v(0, 1, 0), v(0, 1.6, 0), v(0, 1.6, 0))));
  assert.equal(vetoStart(NaN, 0.1, true), false);
  assert.equal(vetoStart(0.99, NaN, true), false);
});

test('seated palm-up pinch on the tab (wrist ~0.4 m below the eyes) is not vetoed; the raised menu gesture is', () => {
  const wrist = v(-0.02, 0.79, -0.27);
  const head = v(0, 1.2, 0);
  const c = palmToHead(v(0, 1, 0), wrist, head);
  assert.ok(c > PALM_VETO_COS, `cos = ${c}`);
  assert.equal(vetoStart(c, head.y - wrist.y, true), false);
  const raised = v(0.05, 1.05, -0.25);
  const cr = palmToHead(v(head.x - raised.x, head.y - raised.y, head.z - raised.z), raised, head);
  assert.equal(vetoStart(cr, head.y - raised.y, true), true);
});
