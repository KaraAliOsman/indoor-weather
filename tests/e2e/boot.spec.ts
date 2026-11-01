import { expect, test } from './fixtures/iwer';

test('E2E-01 boots without errors and without cross-origin requests', async ({ xr }) => {
  await xr.open();
  await expect(xr.page.locator('#enter-ar')).toHaveText('Enter AR');
  await xr.page.waitForTimeout(1500);
  expect(xr.errors).toEqual([]);
  expect(xr.crossOrigin).toEqual([]);
});

test('E2E-02 enters AR with hands and controllers, audio running, still 0 cross-origin', async ({ xr }) => {
  await xr.open();
  await xr.enterAR();

  await expect(xr.page.locator('#landing')).toBeHidden();
  await expect.poll(async () => (await xr.state()).audio).toBe('running');
  await expect.poll(async () => (await xr.state()).drawCalls).toBeGreaterThan(0);

  // Hands connected: occluder visuals load from our own proxy glTF.
  await xr.page.waitForTimeout(1500);
  await xr.shot('e2e-02-hands');

  // Controllers: the profile path points at the input-profiles CDN; the guard
  // must redirect it to our proxy.
  await xr.setInputMode('controller');
  await xr.page.waitForTimeout(1500);
  await xr.shot('e2e-02-controllers');

  expect(xr.errors).toEqual([]);
  expect(xr.crossOrigin).toEqual([]);
});
