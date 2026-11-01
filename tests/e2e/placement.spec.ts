import type { EventStamp, GameEventOf, GameEventType, Vec3Tuple } from '../../src/core/types.ts';
import { pinch } from './fixtures/hands';
import { expect, test, type XrHarness } from './fixtures/iwer';
import { countPixels, isDarkInk } from './fixtures/pixels';

/**
 * E2E-03 (hit-test on MesaSEM) and E2E-04 (fallback without SEM / without
 * surfaces). docs/architecture-m1.md §8.3-8.4. Every test starts seated:
 * head at (0, 1.2, 0), set before entering AR.
 */

type Logged<T extends GameEventType> = GameEventOf<T> & EventStamp;

async function eventsOf<T extends GameEventType>(xr: XrHarness, type: T): Promise<Logged<T>[]> {
  return (await xr.events(type)) as Logged<T>[];
}

async function sessionStartT(xr: XrHarness): Promise<number> {
  const starts = await eventsOf(xr, 'session:start');
  expect(starts).toHaveLength(1);
  return starts[0]!.t;
}

/** Pinch and release with the default right hand (1.475 m high, never near a handle). */
async function tap(xr: XrHarness): Promise<void> {
  await pinch(xr.page, 'right', 1);
  await pinch(xr.page, 'right', 0);
}

function expectNear(actual: Vec3Tuple, expected: Vec3Tuple, tol: number, label: string): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(actual[i]! - expected[i]!), `${label}[${i}] = ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tol);
  }
}

/** No pageerror / console.error and no cross-origin request (as in M0). */
function expectClean(xr: XrHarness): void {
  expect(xr.errors).toEqual([]);
  expect(xr.crossOrigin).toEqual([]);
}

test.describe('MesaSEM', () => {
  test.use({ sem: 'mesa' });

  test('E2E-03 places the box on the table with hit-test, facing the head', async ({ xr }) => {
    await xr.open();
    // Look at the floor behind the table: reticle ray at -70°, floor hit at (0, 0, 0.437), 1.28 m away.
    await xr.setHeadPose({ position: [0, 1.2, 0], yawDeg: 180, pitchDeg: -45 });
    await xr.enterAR();

    await expect.poll(async () => (await xr.state()).placement.mode).toBe('hit-test');
    await expect.poll(async () => (await xr.state()).placement.verdict).toBe('floor');
    for (let i = 0; i < 20; i++) {
      const p = (await xr.state()).placement;
      expect(p.verdict, `frame ${i}`).toBe('floor');
      expect(p.valid, `frame ${i}`).toBe(false);
      expect(p.reticleVisible, `frame ${i}: rejected hits show the grey reticle`).toBe(true);
      await xr.waitFrames(1);
    }

    // A pinch on a rejected surface does nothing.
    await tap(xr);
    await xr.waitFrames(2);
    expect((await xr.state()).phase).toBe('placing');
    expect(await eventsOf(xr, 'placement:commit')).toEqual([]);

    // Turn 30° left and look 15° down: the reticle ray (-40°) meets the table at (-0.274, 0.74, -0.475).
    await xr.setHeadPose({ position: [0, 1.2, 0], yawDeg: 30, pitchDeg: -15 });
    await xr.waitFrames(14);
    const ready = (await xr.state()).placement;
    expect(ready.verdict).toBe('ok');
    expect(ready.stableFrames).toBeGreaterThanOrEqual(10);
    expect(ready.valid).toBe(true);
    expect(ready.reticleVisible).toBe(true);
    expect(ready.candidate).not.toBeNull();
    expectNear(ready.candidate!.position, [-0.274, 0.74, -0.475], 0.01, 'candidate');

    await tap(xr);
    await expect.poll(async () => (await xr.state()).phase).toBe('wind');

    // Order from the commit on: commit → settling → box:placed → wind.
    const log = await xr.events();
    const from = log.findIndex((e) => e.type === 'placement:commit');
    expect(from).toBeGreaterThanOrEqual(0);
    const timeline = log.slice(from).flatMap((e) => {
      if (e.type === 'placement:commit') return [`commit:${e.source}`];
      if (e.type === 'phase') return [`phase:${e.from}>${e.to}`];
      if (e.type === 'box:placed') return ['box:placed'];
      return [];
    });
    expect(timeline).toEqual(['commit:hit-test', 'phase:placing>settling', 'box:placed', 'phase:settling>wind']);

    const [commit] = await eventsOf(xr, 'placement:commit');
    const [placed] = await eventsOf(xr, 'box:placed');
    const settleS = placed!.t - commit!.t;
    expect(settleS).toBeGreaterThanOrEqual(0.45);
    expect(settleS).toBeLessThanOrEqual(0.65);

    const s = await xr.state();
    expect(s.box).not.toBeNull();
    const box = s.box!;
    expect(Math.abs(box.position[1] - 0.74)).toBeLessThanOrEqual(0.01);
    expect(Math.hypot(box.position[0] - -0.274, box.position[2] - -0.475)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(box.yawDeg - 30)).toBeLessThanOrEqual(5);
    expect(box.scale).toBe(1);
    expect(box.visible).toBe(true);
    expect(s.placement.reticleVisible).toBe(false);

    // All of it before the 6 s fallback could fire.
    expect((await eventsOf(xr, 'placement:mode')).filter((e) => e.mode === 'fallback')).toEqual([]);

    // What the emulator drew: the lid's indigo ink sits on the centre column (the head
    // looks straight at the box, yaw 30°) and below the middle (pitch -15°).
    const img = await xr.shot('e2e-03-placed');
    const ink = countPixels(img, isDarkInk);
    console.log(`[E2E-03] dark-ink pixels: ${ink.count} ${JSON.stringify(ink.box)}`);
    expect(ink.count, 'box drawn').toBeGreaterThan(300);
    expect(Math.abs(ink.box!.cx - img.width / 2), 'box on the centre column').toBeLessThanOrEqual(img.width * 0.08);
    expect(ink.box!.cy, 'box below the horizon').toBeGreaterThan(img.height / 2);
    expectClean(xr);
  });
});

test('E2E-04a without a SEM the probe fails and the box goes to the fallback pose', async ({ xr }) => {
  await xr.open();
  await xr.setHeadPose({ position: [0, 1.2, 0], pitchDeg: -15 });
  await xr.enterAR();

  await expect
    .poll(async () => (await eventsOf(xr, 'placement:mode')).some((e) => e.mode === 'fallback'))
    .toBe(true);
  const t0 = await sessionStartT(xr);
  const fallbacks = (await eventsOf(xr, 'placement:mode')).filter((e) => e.mode === 'fallback');
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks[0]!.reason).toBe('no-hit-test');
  expect(fallbacks[0]!.t - t0).toBeLessThanOrEqual(1.0);
  // Probe only: the raycast target was never added, so IWSDK never retried a rejected request.
  const probe = (await xr.state()).probes.placement;
  expect(probe?.hitTest).toBe('unavailable');
  expect(probe?.target).toBe(false);

  const p = (await xr.state()).placement;
  expect(p.candidate).not.toBeNull();
  expectNear(p.candidate!.position, [0, 0.75, -0.45], 0.02, 'candidate');
  expect(Math.abs(p.candidate!.yawDeg)).toBeLessThanOrEqual(5);
  expect(p.valid).toBe(true);
  expect(p.reticleVisible, 'the reticle marks the fallback candidate').toBe(true);

  // The default hand (y ≈ 1.475) is outside the pinch band: default height.
  await tap(xr);
  await expect.poll(async () => (await xr.state()).phase).toBe('wind');
  const commits = await eventsOf(xr, 'placement:commit');
  expect(commits).toHaveLength(1);
  expect(commits[0]!.source).toBe('fallback');

  const s = await xr.state();
  expectNear(s.box!.position, p.candidate!.position, 0.02, 'box');
  expect(s.box!.scale).toBe(1);
  expect(s.placement.reticleVisible).toBe(false);
  expectClean(xr);
});

test.describe('SEM without surfaces', () => {
  test.use({ sem: 'empty' });

  test('E2E-04b hit-test granted but nothing found: fallback after 4 visible seconds, then it lands on its own', async ({ xr }) => {
    await xr.open();
    await xr.setHeadPose({ position: [0, 1.2, 0], pitchDeg: -15 });
    await xr.enterAR();

    await expect.poll(async () => (await xr.state()).placement.mode).toBe('hit-test');
    const t0 = await sessionStartT(xr);

    // Follow the world clock until the fallback (or 7 s).
    const samples: Array<{ dt: number; mode: string; reticle: boolean }> = [];
    for (;;) {
      const s = await xr.state();
      samples.push({ dt: s.time - t0, mode: s.placement.mode, reticle: s.placement.reticleVisible });
      if (s.placement.mode !== 'hit-test' || s.time - t0 > 7) break;
      await xr.waitFrames(1);
    }
    const searching = samples.filter((x) => x.mode === 'hit-test');
    expect(searching.length).toBeGreaterThan(0);
    expect(searching.filter((x) => x.reticle), 'no reticle without a hit').toEqual([]);
    const at3 = samples.find((x) => x.dt >= 3.0);
    expect(at3?.mode).toBe('hit-test');

    const fallbacks = (await eventsOf(xr, 'placement:mode')).filter((e) => e.mode === 'fallback');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.reason).toBe('timeout');
    const dt = fallbacks[0]!.t - t0;
    expect(dt).toBeGreaterThanOrEqual(3.9);
    expect(dt).toBeLessThanOrEqual(4.6);

    // No pinch needed: the box lands on the fallback pose by itself (canon §10).
    await expect.poll(async () => (await xr.state()).phase, { timeout: 5_000 }).toBe('wind');
    const commits = await eventsOf(xr, 'placement:commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]!.source).toBe('fallback');
    const landed = commits[0]!.pose.position;
    expectNear([landed.x, landed.y, landed.z], [0, 0.75, -0.45], 0.02, 'landing');
    expect(commits[0]!.t - fallbacks[0]!.t).toBeGreaterThanOrEqual(1.1);
    expectClean(xr);
  });
});
