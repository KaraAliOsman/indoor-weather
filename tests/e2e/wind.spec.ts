import type { EventStamp, GameEventOf, GameEventType, Vec3Tuple } from '../../src/core/types.ts';
import { along, calibratePinchOffset, dragPinch, pinch, pinchAt, setHand } from './fixtures/hands';
import { expect, test, type XrHarness } from './fixtures/iwer';
import { countPixels, isWarmInk } from './fixtures/pixels';

/**
 * E2E-05: the Wind chapter with IWER's real pinch (docs/architecture-m1.md §8.5).
 *
 * sem 'none' (the fixture default): the box is placed with __indoor.place()
 * so this spec isolates Wind; E2E-03/04 cover placement. Seated head at
 * (0, 1.2, 0) looking 20° down; the box 45 cm ahead at table height, facing
 * the head, so the tab pulls along world +Z.
 */

type Logged<T extends GameEventType> = GameEventOf<T> & EventStamp;

/** window.__indoor.handles() entry (docs/architecture-m1.md §7). */
interface HandleInfo {
  point: Vec3Tuple;
  radius: number;
  enabled: boolean;
  axis: Vec3Tuple | null;
  travel: number | null;
}
/** Page-side debug API this spec touches beyond the fixture helpers. */
interface PageWindow {
  __indoor: {
    place(pose?: { x: number; y: number; z: number; yawDeg: number }): boolean;
    handles(): Partial<Record<string, HandleInfo>>;
  };
}

const TRAVEL = 0.06;
/** IWER's default right hand: above a seated head looking 20° down, i.e. out of view. */
const HAND_AWAY: Vec3Tuple = [0.25, 1.5, -0.4];
/** Warm-ink pixels the 40 leaves must add on screen (measured ~7900 with the seated head and 1280x720). */
const MIN_LEAF_PIXELS = 3000;

async function eventsOf<T extends GameEventType>(xr: XrHarness, type: T): Promise<Logged<T>[]> {
  return (await xr.events(type)) as Logged<T>[];
}

async function windHandle(xr: XrHarness): Promise<HandleInfo> {
  const h = await xr.page.evaluate(() => (window as unknown as PageWindow).__indoor.handles().wind ?? null);
  expect(h, 'wind handle registered').not.toBeNull();
  return h!;
}

function expectMonotone(samples: number[], label: string): void {
  expect(samples.length, `${label}: samples`).toBeGreaterThan(0);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]!, `${label}: sample ${i} (${samples.join(', ')})`).toBeGreaterThanOrEqual(samples[i - 1]!);
  }
}

function expectNear(actual: Vec3Tuple, expected: Vec3Tuple, tol: number, label: string): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `${label}[${i}] = ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tol);
  }
}

test('E2E-05 wind: pinch the tab, pull, ratchet, release, pull again to complete', async ({ xr }) => {
  const { page } = xr;
  const expectLeftFree = async (step: string): Promise<void> => {
    expect((await xr.state()).hands.left.owner, `${step}: the left hand never owns a handle`).toBeNull();
  };

  // 1. Seated, enter AR.
  await xr.open();
  await xr.setHeadPose({ position: [0, 1.2, 0], pitchDeg: -20 });
  await xr.enterAR();
  await expect.poll(async () => (await xr.state()).phase).toBe('placing');

  // 2. Force the placement and wait for the Wind chapter.
  const placed = await page.evaluate(() =>
    (window as unknown as PageWindow).__indoor.place({ x: 0, y: 0.74, z: -0.45, yawDeg: 0 }),
  );
  expect(placed).toBe(true);
  await expect.poll(async () => (await xr.state()).phase).toBe('wind');
  await xr.clearEvents();
  // Pixel baseline for the leaves: box and tab at rest, no leaf out, the hand out of view.
  const inkBefore = countPixels(await xr.pixels(), isWarmInk);
  expect(inkBefore.count, 'the box seals and the tab end are drawn').toBeGreaterThan(0);

  // 3. Calibrate the pinch offset at the default hand pose (~0.8 m from the tab): no grab.
  const off = await calibratePinchOffset(page, 'right');
  expect(await eventsOf(xr, 'handle:grab')).toEqual([]);
  expect((await xr.state()).hands.right.fsm).toBe('idle');
  await expectLeftFree('calibration');

  // 4. First partial pull.
  const h0 = await windHandle(xr);
  expect(h0.enabled).toBe(true);
  expect(h0.radius).toBeCloseTo(0.035, 6);
  expect(h0.travel).toBeCloseTo(TRAVEL, 6);
  expect(h0.axis).not.toBeNull();
  const axis = h0.axis!;
  expectNear(axis, [0, 0, 1], 1e-3, 'axis');

  await pinchAt(page, 'right', h0.point, off);
  const grabbed = await xr.state();
  expect(grabbed.hands.right.fsm).toBe('armed');
  expect(grabbed.hands.right.owner).toBe('wind');
  // The real path: an IWER hand whose system select arrives through its gamepad (no debug actuate).
  expect(grabbed.hands.right.device).toBe('hand');
  expect(grabbed.hands.right.selectPath).toBe('gamepad');
  expect(grabbed.hands.right.selecting).toBe(true);
  expect((await eventsOf(xr, 'handle:grab')).map((e) => [e.hand, e.target])).toEqual([['right', 'wind']]);

  // 3.8 cm of hand = 3.3 cm of tab: the first 5 mm of every pull are a deadband.
  const mid = along(h0.point, axis, 0.038);
  const pull1 = await dragPinch(page, 'right', h0.point, mid, off, 20, 'wind');
  expectMonotone(pull1, 'pull 1');
  // The pinch point is One-Euro filtered: let the tab catch up with the still hand.
  await xr.waitFrames(30);
  const p1 = (await xr.state()).mechanisms.wind.progress;
  expect(p1).toBeGreaterThanOrEqual(pull1[pull1.length - 1]!);
  expect(p1).toBeGreaterThanOrEqual(0.5);
  expect(p1).toBeLessThanOrEqual(0.6);
  expect((await eventsOf(xr, 'notch')).filter((e) => e.target === 'wind').map((e) => e.index)).toEqual([0, 1]);
  expect((await eventsOf(xr, 'wind:gust')).map((e) => [e.group, e.leaves])).toEqual([[0, 10], [1, 10]]);
  expect((await xr.state()).probes.wind?.leavesReleased).toBe(20);

  // 4.5 Real ratchet: pull back 1.5 cm while still pinching an unlocked target.
  const back = await dragPinch(page, 'right', mid, along(mid, axis, -0.015), off, 8, 'wind');
  // Ratchet: pulling back never lowers it (the filter tail may still add a few µm).
  expectMonotone(back, 'pull back');
  for (const v of back) expect(v).toBeCloseTo(p1, 4);
  expect(await eventsOf(xr, 'actuate:reject')).toEqual([]);
  expect((await xr.state()).hands.right.fsm).toBe('pulling');
  await expectLeftFree('pull 1');
  await xr.shot('e2e-05-mid');

  // 5. Release: the progress stays.
  await pinch(page, 'right', 0);
  expect((await eventsOf(xr, 'handle:release')).map((e) => [e.hand, e.target, e.reason])).toEqual([
    ['right', 'wind', 'release'],
  ]);
  expect((await xr.state()).hands.right.fsm).toBe('idle');
  await xr.waitFrames(10);
  expect((await xr.state()).mechanisms.wind.progress).toBeCloseTo(p1, 4);

  // 6. Second pull from where the tab is now (it moved axis · progress · travel).
  const h1 = await windHandle(xr);
  expectNear(h1.point, along(h0.point, axis, p1 * TRAVEL), 0.001, 'tab after pull 1');
  await pinchAt(page, 'right', h1.point, off);
  expect(await eventsOf(xr, 'handle:grab')).toHaveLength(2);
  const pull2 = await dragPinch(page, 'right', h1.point, along(h1.point, axis, 0.04), off, 25, 'wind');
  expectMonotone(pull2, 'pull 2');
  expect(pull2[pull2.length - 1]).toBe(1);
  expect((await eventsOf(xr, 'notch')).filter((e) => e.target === 'wind').map((e) => e.index)).toEqual([0, 1, 2]);
  expect((await eventsOf(xr, 'mechanism:complete')).map((e) => e.target)).toEqual(['wind']);
  expect((await eventsOf(xr, 'wind:gust')).map((e) => e.group)).toEqual([0, 1, 2, 3]);
  expect((await eventsOf(xr, 'phase')).map((e) => [e.from, e.to])).toContainEqual(['wind', 'storm']);
  expect((await xr.state()).phase).toBe('storm');
  expect((await eventsOf(xr, 'handle:release')).map((e) => e.reason)).toEqual(['release', 'cancel']);

  // 7. Locked after completion: pulling back with the pinch still held changes nothing.
  const after = await dragPinch(page, 'right', along(h1.point, axis, 0.04), along(h1.point, axis, 0.01), off, 10, 'wind');
  expect(after).toEqual(new Array(10).fill(1));
  expect(await eventsOf(xr, 'handle:grab')).toHaveLength(2);
  await pinch(page, 'right', 0);
  await expectLeftFree('pull 2');

  // 8. Let the last gust fly.
  await xr.waitFrames(30);
  await xr.shot('e2e-05-done');
  const end = await xr.state();
  expect(end.probes.wind?.leavesReleased).toBe(40);
  expect(end.probes.wind?.gusts).toBe(4);
  expect(end.mechanisms.wind.complete).toBe(true);
  expect(end.drawCalls).toBeLessThanOrEqual(40);
  expect(end.input.doubleActuations).toBe(0);
  expect(end.input.rejected).toBe(0);
  expect(end.probes.hands?.vetoes, 'no pinch start vetoed by the palm-to-face check').toBe(0);
  expect(await eventsOf(xr, 'actuate:reject')).toEqual([]);
  expect(await eventsOf(xr, 'handle:release')).toHaveLength(2);
  expect(end.hands.left.owner).toBeNull();

  // The leaves are really on screen: hand out of view, then count warm ink against the baseline.
  await setHand(page, 'right', HAND_AWAY);
  await xr.waitFrames(3);
  const inkAfter = countPixels(await xr.shot('e2e-05-leaves'), isWarmInk);
  console.log(`[E2E-05] warm-ink pixels: before ${inkBefore.count} ${JSON.stringify(inkBefore.box)}, after ${inkAfter.count} ${JSON.stringify(inkAfter.box)}`);
  expect(inkAfter.count - inkBefore.count, 'leaves visible on screen').toBeGreaterThanOrEqual(MIN_LEAF_PIXELS);
  // They blow out of the slot towards the user's right: the ink spreads beyond the box.
  expect(inkAfter.box!.maxX - inkAfter.box!.minX).toBeGreaterThan(inkBefore.box!.maxX - inkBefore.box!.minX);

  expect(xr.errors).toEqual([]);
  expect(xr.crossOrigin).toEqual([]);
});
