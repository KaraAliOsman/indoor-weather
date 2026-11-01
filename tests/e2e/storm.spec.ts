import type { ActuationTarget, Vec3Tuple } from '../../src/core/types.ts';
import { calibratePinchOffset, dragPinch, pinch, pinchAt, setHand } from './fixtures/hands';
import { expect, test, type XrHarness } from './fixtures/iwer';

interface HandleInfo {
  point: Vec3Tuple;
  enabled: boolean;
  axis: Vec3Tuple | null;
}
interface PageWindow {
  __indoor: {
    place(pose?: { x: number; y: number; z: number; yawDeg: number }): boolean;
    actuate(target: ActuationTarget, amount: number): number;
    handles(): Partial<Record<string, HandleInfo>>;
  };
}

/**
 * E2E-06 storm (direccion/canon.md §1, §6): the tag rises after the wind, a
 * real IWER pinch pulls the cloud out (the room darkens with it), the rain
 * falls on the kite, a palm held over the kite shelters it, and lifting the
 * hand leaves a dry print. The box sits at (0, 0.74, −0.45), yaw 0, so the
 * box frame is the world frame shifted by that position.
 */

const BOX: Vec3Tuple = [0, 0.74, -0.45];
/** Kite rest, box frame (BOX_ANCHORS.kite). */
const KITE: Vec3Tuple = [0.1, 0, 0.16];

type Probe = {
  stage: string;
  density: number;
  cover: number;
  kiteWet: number;
  sheltered: number;
  dryAtPrint: number;
  veil: number;
  palmU: number;
  palmW: number;
  kiteY: number;
  veilMax: number;
  veilShown: boolean;
};

async function storm(xr: XrHarness): Promise<Probe> {
  return (await xr.state()).probes.storm as unknown as Probe;
}

async function names(xr: XrHarness, type: Parameters<XrHarness['events']>[0]): Promise<number> {
  return (await xr.events(type)).length;
}

test('E2E-06 storm → dawn: pull the cloud, shelter the kite, leave a dry print, blow the dawn', async ({ xr }) => {
  test.setTimeout(150_000);
  const { page } = xr;

  await xr.open();
  await xr.setHeadPose({ position: [0, 1.2, 0], pitchDeg: -30 });
  await xr.enterAR();
  await expect.poll(async () => (await xr.state()).phase).toBe('placing');
  const placed = await page.evaluate(
    ([x, y, z]) => (window as unknown as PageWindow).__indoor.place({ x, y, z, yawDeg: 0 }),
    BOX,
  );
  expect(placed).toBe(true);
  await expect.poll(async () => (await xr.state()).phase).toBe('wind');

  // Wind is covered by E2E-05: finish it from the debug API.
  await page.evaluate(() => (window as unknown as PageWindow).__indoor.actuate('wind', 1));
  await expect.poll(async () => (await xr.state()).phase).toBe('storm');
  await xr.clearEvents();

  // 1. The tag rises on its own a few seconds after the wind.
  await expect.poll(async () => names(xr, 'storm:reveal'), { timeout: 12_000 }).toBe(1);
  const tag = await page.evaluate(() => (window as unknown as PageWindow).__indoor.handles().storm ?? null);
  expect(tag, 'storm tag registered').not.toBeNull();
  expect(tag!.enabled).toBe(true);
  expect(tag!.axis).toEqual([0, 1, 0]);

  // 2. Pinch the tag and pull it up 7.5 cm: the room darkens with the hand.
  const off = await calibratePinchOffset(page, 'right');
  await pinchAt(page, 'right', tag!.point, off);
  expect((await xr.state()).hands.right.owner).toBe('storm');
  const top: Vec3Tuple = [tag!.point[0], tag!.point[1] + 0.075, tag!.point[2]];
  const pull = await dragPinch(page, 'right', tag!.point, top, off, 40, 'storm');
  expect(pull[pull.length - 1]!).toBeGreaterThan(0.6);
  // The veil edge is speed-limited (luminance safety): it closes over a few seconds.
  await expect.poll(async () => (await storm(xr)).veil, { message: 'the room darkens with the pull' }).toBeGreaterThan(0.3);
  await pinch(page, 'right', 0);
  await expect.poll(async () => (await xr.events('mechanism:complete')).map((e) => (e as { target: string }).target)).toContain('storm');

  // 3. The cloud floats to its place and it rains on the kite.
  await expect.poll(async () => names(xr, 'storm:rain'), { timeout: 5_000 }).toBe(1);
  await expect.poll(async () => (await storm(xr)).density, { timeout: 5_000 }).toBeGreaterThan(0.95);
  await xr.waitFrames(60);
  await xr.shot('e2e-06-rain');
  // canon §11: peak ≤ 32 draw calls (box, tab, leaves, cloud, tag, kite, rain, decal, veil, hands…).
  const peak = await xr.state();
  console.log(`storm peak: ${peak.drawCalls} draw calls, ${peak.triangles} triangles`);
  expect(peak.drawCalls).toBeLessThanOrEqual(32);
  expect(peak.triangles).toBeLessThanOrEqual(30_000);

  // 4. A palm 10 cm above the kite, aimed with the probe (the rain is slanted).
  const above = (dx: number, dz: number): Vec3Tuple => [BOX[0] + KITE[0] + dx, BOX[1] + 0.1, BOX[2] + KITE[2] + dz];
  let aim = above(0, 0);
  await setHand(page, 'right', aim);
  await xr.waitFrames(5);
  for (let i = 0; i < 3; i++) {
    const p = await storm(xr);
    expect(p.palmU, 'palm slab active (palm down)').toBeGreaterThan(-50);
    aim = [aim[0] + (KITE[0] - p.palmU), aim[1], aim[2] + (KITE[2] - p.palmW)];
    await setHand(page, 'right', aim);
    await xr.waitFrames(5);
  }
  await expect.poll(async () => (await storm(xr)).cover).toBeGreaterThanOrEqual(0.4);
  await expect.poll(async () => names(xr, 'storm:shelter')).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(3_000);
  const sheltered = await storm(xr);
  expect(sheltered.kiteWet, 'the sheltered kite stays almost dry').toBeLessThan(0.3);
  expect(sheltered.sheltered, 'part of the rain ellipse is under the hand').toBeGreaterThan(0.05);
  await xr.shot('e2e-06-shelter');

  // 5. Lift the hand away: the dry print stays.
  await setHand(page, 'right', [0.5, 1.4, -0.3]);
  await expect.poll(async () => names(xr, 'storm:print')).toBe(1);
  const printed = await storm(xr);
  expect(printed.dryAtPrint).toBeGreaterThan(0.05);
  await xr.waitFrames(10);
  await xr.shot('e2e-06-print');

  // 6. The storm ends on its own (print + 6 s, then a 6 s drain).
  await expect.poll(async () => names(xr, 'storm:over'), { timeout: 30_000 }).toBe(1);
  expect((await storm(xr)).density).toBe(0);
  expect((await xr.state()).phase).toBe('dawn');

  // 7. Dawn: the same tab, pulled again with a real pinch.
  const tab = await page.evaluate(() => (window as unknown as PageWindow).__indoor.handles().dawn ?? null);
  expect(tab, 'dawn tab registered').not.toBeNull();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as PageWindow).__indoor.handles().dawn!.enabled))).toBe(true);
  const off2 = await calibratePinchOffset(page, 'right');
  await pinchAt(page, 'right', tab!.point, off2);
  const out: Vec3Tuple = [tab!.point[0], tab!.point[1], tab!.point[2] + 0.075];
  await dragPinch(page, 'right', tab!.point, out, off2, 30, 'dawn');
  await pinch(page, 'right', 0);
  await expect.poll(async () => (await xr.state()).phase).toBe('done');
  await setHand(page, 'right', [0.5, 1.4, -0.3]);

  // 8. The kite takes off on its string and the room turns gold, then clears.
  await expect.poll(async () => (await storm(xr)).kiteY, { timeout: 4_000 }).toBeGreaterThan(0.12);
  await page.waitForTimeout(1_500);
  await xr.shot('e2e-06-dawn');
  const gold = await storm(xr);
  expect(gold.veilMax, 'gold wash, not the storm dark').toBeLessThan(0.45);
  await expect.poll(async () => (await storm(xr)).veilShown, { timeout: 14_000 }).toBe(false);
  await expect.poll(async () => (await storm(xr)).kiteY, { timeout: 4_000 }).toBeLessThan(0.01);

  // 9. Leave AR: today's page shows the dry handprint (kept on this device only).
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('indoorweather.v1') ?? '{}'));
  const day = Object.values(saved.days ?? {})[0] as { seal: number; print?: string } | undefined;
  expect(day?.print, 'the print is saved').toBeTruthy();
  expect((day!.seal & 29) === 29, `seals wind+storm+dawn+shelter, got ${day!.seal}`).toBe(true);
  await page.evaluate(() => (window as unknown as { __indoor: { world: { renderer: { xr: { getSession(): XRSession | null } } } } }).__indoor.world.renderer.xr.getSession()?.end());
  await expect(page.locator('#today')).toBeVisible();
  const d = await page.locator('#today-print path.blue').getAttribute('d');
  expect((d ?? '').length).toBeGreaterThan(100);
  await expect(page.locator('#week li')).toHaveCount(7);
  await page.screenshot({ path: test.info().outputPath('e2e-06-landing.png'), fullPage: true });
  expect(xr.crossOrigin).toEqual([]);
  expect(xr.errors).toEqual([]);
});
