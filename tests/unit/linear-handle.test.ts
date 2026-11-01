import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3 } from '../../src/core/types.ts';
import { createLinearHandle, linearAmount } from '../../src/mechanisms/linear-handle.ts';

const EPS = 1e-9;
const Z: Vec3 = { x: 0, y: 0, z: 1 };
const start: Vec3 = { x: -0.07, y: 0.775, z: -0.342 };
const offset = (p: Vec3, dx: number, dy: number, dz: number): Vec3 => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < EPS, msg ?? `${a} != ${b}`);

test('linearAmount: 3 cm along the axis, travel 6 cm, from 0.2 → 0.7', () => {
  close(linearAmount(start, offset(start, 0, 0, 0.03), Z, 0.06, 0.2), 0.7);
});

test('linearAmount: perpendicular motion keeps progressAtStart', () => {
  close(linearAmount(start, offset(start, 0.05, -0.04, 0), Z, 0.06, 0.2), 0.2);
});

test('linearAmount: pulling back goes below progressAtStart (no clamp: the ratchet clamps)', () => {
  close(linearAmount(start, offset(start, 0, 0, -0.03), Z, 0.06, 0.2), -0.3);
  close(linearAmount(start, offset(start, 0, 0, 0.12), Z, 0.06, 0.2), 2.2);
});

test('linearAmount: only the component along a tilted axis counts', () => {
  const yaw = Math.PI / 6;
  const axis: Vec3 = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  // 3 cm along the axis + 2 cm perpendicular to it.
  const now = offset(start, axis.x * 0.03 + axis.z * 0.02, 0, axis.z * 0.03 - axis.x * 0.02);
  close(linearAmount(start, now, axis, 0.06, 0), 0.5);
});

test('createLinearHandle: initial state', () => {
  const h = createLinearHandle({ target: 'wind', travel: 0.06, grabRadius: 0.035 });
  assert.equal(h.target, 'wind');
  assert.equal(h.grabRadius, 0.035);
  assert.equal(h.enabled, false);
  assert.deepEqual(h.hint, { axis: { x: 0, y: 0, z: 1 }, travel: 0.06 });
});

test('setFrame: grabPoint = rest + axis·progress·travel, hint = {axis, travel}', () => {
  const h = createLinearHandle({ target: 'wind', travel: 0.06, grabRadius: 0.035 });
  const point = h.grabPoint;
  const hint = h.hint;
  const rest: Vec3 = { x: 0.1, y: 0.8, z: -0.3 };
  const yaw = -0.4;
  const axis: Vec3 = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) };

  h.setFrame(rest, axis, 0.5, true);
  close(h.grabPoint.x, rest.x + axis.x * 0.5 * 0.06);
  close(h.grabPoint.y, rest.y);
  close(h.grabPoint.z, rest.z + axis.z * 0.5 * 0.06);
  assert.equal(h.enabled, true);
  assert.ok(h.hint);
  close(h.hint.axis.x, axis.x);
  close(h.hint.axis.z, axis.z);
  assert.equal(h.hint.travel, 0.06);

  // Stable objects: the arbiter may keep references across frames.
  assert.equal(h.grabPoint, point);
  assert.equal(h.hint, hint);

  h.setFrame(rest, axis, 0, false);
  assert.deepEqual({ ...h.grabPoint }, rest);
  assert.equal(h.enabled, false);
});

test('setFrame: normalises the axis, keeps the last one when it is zero, clamps progress', () => {
  const h = createLinearHandle({ target: 'wind', travel: 0.06, grabRadius: 0.035 });
  const rest: Vec3 = { x: 0, y: 0, z: 0 };
  h.setFrame(rest, { x: 0, y: 0, z: 2 }, 1, true);
  close(h.grabPoint.z, 0.06);
  h.setFrame(rest, { x: 0, y: 0, z: 0 }, 1, true);
  close(h.grabPoint.z, 0.06, 'zero axis keeps +Z');
  h.setFrame(rest, Z, 1.7, true);
  close(h.grabPoint.z, 0.06, 'progress > 1 clamps to 1');
  h.setFrame(rest, Z, Number.NaN, true);
  close(h.grabPoint.z, 0, 'NaN progress → 0');
});

test('amountFor uses the axis from the last setFrame', () => {
  const h = createLinearHandle({ target: 'wind', travel: 0.06, grabRadius: 0.035 });
  h.setFrame(start, { x: 1, y: 0, z: 0 }, 0, true);
  close(h.amountFor(start, offset(start, 0.03, 0, 0), 0.1), 0.6);
  close(h.amountFor(start, offset(start, 0, 0, 0.03), 0.1), 0.1);
  close(h.amountFor(start, start, 0.35), 0.35, 'no motion = progressAtStart');
});

test('createLinearHandle rejects non-positive travel or radius', () => {
  assert.throws(() => createLinearHandle({ target: 'wind', travel: 0, grabRadius: 0.035 }));
  assert.throws(() => createLinearHandle({ target: 'wind', travel: 0.06, grabRadius: -1 }));
  assert.throws(() => createLinearHandle({ target: 'wind', travel: Number.NaN, grabRadius: 0.035 }));
});
