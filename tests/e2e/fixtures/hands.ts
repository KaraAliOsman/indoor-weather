import type { Page } from '@playwright/test';
import type { ActuationTarget, Handedness, Vec3Tuple } from '../../../src/core/types.ts';

/**
 * Hand helpers for the E2E specs (IWER 2.5.0 hands, owner A).
 *
 * - Pinches always go through `updatePinchValue`: IWER applies the value at
 *   the start of the next frame, fires select + selectstart (or selectend)
 *   and blends the joints towards the "pinch" pose in that same frame. Never
 *   `setPinchValueImmediate` (it skips the events the app listens to).
 * - The pinch point (thumb/index midpoint) sits ~2.5 cm below and ~1.2 cm
 *   ahead of the target ray in the pinch pose, so specs calibrate the offset
 *   at runtime instead of hard-coding it, and keep the hand rotation fixed
 *   between calibratePinchOffset() and pinchAt()/dragPinch().
 * - Everything that must happen on consecutive frames runs inside ONE
 *   page.evaluate (dragPinch), so test-runner latency cannot skip frames.
 */

export type Quat = [number, number, number, number];

/** Page-side shapes these helpers touch (IWER device and window.__indoor). */
interface PageHand {
  position: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  quaternion: { set(x: number, y: number, z: number, w: number): unknown };
  updatePinchValue(value: number): void;
}
interface PageWindow {
  IWER_DEVICE: { hands: Record<Handedness, PageHand> };
  __indoor: {
    waitFrames(n: number): Promise<number>;
    state(): { hands: Record<Handedness, { tracked: boolean; pinchPoint: Vec3Tuple }> };
    ctx: { actuation: { progress(target: ActuationTarget): number } };
  };
}

/** `p + axis · d` (e.g. a point `d` metres along a handle's hint axis). */
export function along(p: Vec3Tuple, axis: Vec3Tuple, d: number): Vec3Tuple {
  return [p[0] + axis[0] * d, p[1] + axis[1] * d, p[2] + axis[2] * d];
}

/** Target-ray pose of hand `h` (world = local-floor). Takes effect on the next frame. */
export async function setHand(page: Page, h: Handedness, pos: Vec3Tuple, quat: Quat = [0, 0, 0, 1]): Promise<void> {
  await page.evaluate(
    ({ h, pos, quat }) => {
      const hand = (window as unknown as PageWindow).IWER_DEVICE.hands[h];
      hand.position.set(pos[0], pos[1], pos[2]);
      hand.quaternion.set(quat[0], quat[1], quat[2], quat[3]);
    },
    { h, pos, quat },
  );
}

/** Press (1) or release (0) the pinch, then wait `settleFrames` whole frames. */
export async function pinch(page: Page, h: Handedness, v: 0 | 1, settleFrames = 2): Promise<void> {
  await page.evaluate(
    async ({ h, v, n }) => {
      const w = window as unknown as PageWindow;
      w.IWER_DEVICE.hands[h].updatePinchValue(v);
      await w.__indoor.waitFrames(n);
    },
    { h, v, n: settleFrames },
  );
}

/**
 * Pinch once where the hand is (away from every handle), measure
 * offset = state().hands[h].pinchPoint − hand.position, release.
 * The offset is only valid for the current hand rotation.
 */
export async function calibratePinchOffset(page: Page, h: Handedness): Promise<Vec3Tuple> {
  await pinch(page, h, 1);
  const r = await page.evaluate((h) => {
    const w = window as unknown as PageWindow;
    const s = w.__indoor.state().hands[h];
    const q = w.IWER_DEVICE.hands[h].position;
    return { tracked: s.tracked, offset: [s.pinchPoint[0] - q.x, s.pinchPoint[1] - q.y, s.pinchPoint[2] - q.z] };
  }, h);
  await pinch(page, h, 0);
  if (!r.tracked) throw new Error(`calibratePinchOffset: the ${h} hand is not tracked`);
  return r.offset as Vec3Tuple;
}

/** Move the hand so that its pinch point lands on `point`, let it settle, then pinch. */
export async function pinchAt(page: Page, h: Handedness, point: Vec3Tuple, offset: Vec3Tuple): Promise<void> {
  await page.evaluate(
    async ({ h, point, offset }) => {
      const w = window as unknown as PageWindow;
      // Position only: the rotation must stay the one the offset was calibrated with.
      w.IWER_DEVICE.hands[h].position.set(point[0] - offset[0], point[1] - offset[1], point[2] - offset[2]);
      await w.__indoor.waitFrames(2);
    },
    { h, point, offset },
  );
  await pinch(page, h, 1);
}

/**
 * Drag the (already pinching) hand's pinch point from `from` to `to` over
 * `frames` frames, one step per frame, in ONE page.evaluate. Returns the
 * progress of `target` after each frame (ctx.actuation.progress: the same
 * number state().mechanisms[target].progress reports, and it also covers 'kite').
 */
export async function dragPinch(
  page: Page,
  h: Handedness,
  from: Vec3Tuple,
  to: Vec3Tuple,
  offset: Vec3Tuple,
  frames: number,
  target: ActuationTarget,
): Promise<number[]> {
  return page.evaluate(
    async ({ h, from, to, offset, frames, target }) => {
      const w = window as unknown as PageWindow;
      const hand = w.IWER_DEVICE.hands[h];
      const out: number[] = [];
      for (let i = 1; i <= frames; i++) {
        const t = i / frames;
        hand.position.set(
          from[0] + (to[0] - from[0]) * t - offset[0],
          from[1] + (to[1] - from[1]) * t - offset[1],
          from[2] + (to[2] - from[2]) * t - offset[2],
        );
        await w.__indoor.waitFrames(1);
        out.push(w.__indoor.ctx.actuation.progress(target));
      }
      return out;
    },
    { h, from, to, offset, frames, target },
  );
}
