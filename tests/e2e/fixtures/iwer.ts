import { createRequire } from 'node:module';
import { test as base, expect, type Page } from '@playwright/test';
import type { DebugSnapshot, GameEventType, LoggedEvent, Vec3Tuple } from '../../../src/core/types.ts';
import { installMesaSem, MESA_DEFAULT } from '../../../src/debug/mesa-sem.ts';
import { decodePng, type Image } from './pixels';

const require = createRequire(import.meta.url);
const IWER_BUNDLE = require.resolve('iwer/build/iwer.min.js');

export type InputMode = 'hand' | 'controller';

/** Synthetic environment for hit-test: none (probe rejected), a table, or granted but empty. */
export type SemKind = 'none' | 'mesa' | 'empty';

export interface HeadPose {
  position: Vec3Tuple;
  /** Rotation about +Y; 0 looks along -Z. */
  yawDeg?: number;
  /** Negative looks down. */
  pitchDeg?: number;
}

export interface XrHarness {
  page: Page;
  /** Requests to any origin other than the app's own. Must stay empty. */
  crossOrigin: string[];
  /** Uncaught errors and console.error lines. */
  errors: string[];
  open(path?: string): Promise<void>;
  enterAR(): Promise<void>;
  setInputMode(mode: InputMode): Promise<void>;
  state(): Promise<DebugSnapshot>;
  /** Wait for `n` whole app frames (all systems + render). */
  waitFrames(n: number): Promise<number>;
  /** window.__indoor.events (the bus ring), optionally filtered by type. */
  events(type?: GameEventType): Promise<LoggedEvent[]>;
  clearEvents(): Promise<void>;
  /** Emulated headset pose (world = local-floor). Takes effect on the next frame. */
  setHeadPose(pose: HeadPose): Promise<void>;
  /** Screenshot saved as <test output>/<name>.png; returns the decoded pixels. */
  shot(name: string): Promise<Image>;
  /** Screenshot pixels without saving a file. */
  pixels(): Promise<Image>;
}

/** Page-side shapes the harness touches. */
interface PageWindow {
  IWER_DEVICE: {
    primaryInputMode: string;
    position: { set(x: number, y: number, z: number): unknown };
    quaternion: { set(x: number, y: number, z: number, w: number): unknown };
  };
  __indoor: {
    state(): DebugSnapshot;
    readonly events: readonly LoggedEvent[];
    clearEvents(): void;
    waitFrames(n: number): Promise<number>;
  };
}

// Console noise from the emulator / GPU stack that is not an app failure.
const BENIGN = [/GPU stall due to ReadPixels/i, /WebGL: INVALID_OPERATION/i, /X4122/];

/**
 * Yaw (about +Y) then pitch (about the rotated +X), from half-angle c/s:
 * q = qYaw · qPitch = (cy·sx, sy·cx, −sy·sx, cy·cx).
 */
export function headQuaternion(yawDeg: number, pitchDeg: number): [number, number, number, number] {
  const y = (yawDeg * Math.PI) / 360;
  const x = (pitchDeg * Math.PI) / 360;
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  return [cy * sx, sy * cx, -sy * sx, cy * cx];
}

export const test = base.extend<{ sem: SemKind; xr: XrHarness }>({
  sem: ['none', { option: true }],

  xr: async ({ page, sem }, use, testInfo) => {
    const crossOrigin: string[] = [];
    const errors: string[] = [];
    // Known before navigation, so requests made while the page loads are checked too.
    const appOrigin = new URL(String(testInfo.project.use.baseURL)).origin;

    page.on('request', (req) => {
      const url = new URL(req.url());
      if (!url.protocol.startsWith('http')) return;
      if (url.origin !== appOrigin) crossOrigin.push(req.url());
    });
    page.on('websocket', (ws) => crossOrigin.push(ws.url()));
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !BENIGN.some((re) => re.test(msg.text()))) {
        errors.push(`console.error: ${msg.text()}`);
      }
    });

    // 1. Pinned IWER 2.5.0 (UMD global `IWER`), installed before any app code.
    await page.addInitScript({ path: IWER_BUNDLE });
    // 2. The M0 device. window.XRRay is deliberately NOT replaced with IWER.XRRay
    //    (its rotation is inverted, docs/architecture-m1.md §8.2, R13).
    await page.addInitScript(() => {
      const IWER = (window as unknown as { IWER: any }).IWER;
      const device = new IWER.XRDevice(IWER.metaQuest3);
      device.installRuntime({ forceInstall: true });
      device.primaryInputMode = 'hand';
      device.stereoEnabled = false;
      (window as unknown as { IWER_DEVICE: unknown }).IWER_DEVICE = device;
    });
    // 3. The SEM must exist before requestHitTestSource (IWER checks it there).
    if (sem !== 'none') await page.addInitScript(installMesaSem, { ...MESA_DEFAULT, kind: sem });

    const harness: XrHarness = {
      page,
      crossOrigin,
      errors,
      async open(path = '/?debug=1&hands=show') {
        await page.goto(path);
        const hasXRRay = await page.evaluate(() => typeof (globalThis as { XRRay?: unknown }).XRRay === 'function');
        if (!hasXRRay) {
          throw new Error(
            'This browser has no native XRRay: IWSDK hit-test would console.error every frame. ' +
              'Use a Chromium build with WebXR hit-test (never assign IWER.XRRay: its rotation is inverted).',
          );
        }
        await expect(page.locator('#enter-ar')).toBeEnabled();
        await expect.poll(() => page.evaluate(() => Boolean(window.__indoor))).toBe(true);
      },
      async enterAR() {
        await page.locator('#enter-ar').click();
        await expect.poll(async () => (await harness.state()).inSession).toBe(true);
      },
      async setInputMode(mode) {
        await page.evaluate((m) => {
          (window as unknown as PageWindow).IWER_DEVICE.primaryInputMode = m;
        }, mode);
      },
      state: () => page.evaluate(() => (window as unknown as PageWindow).__indoor.state()),
      waitFrames: (n) => page.evaluate((k) => (window as unknown as PageWindow).__indoor.waitFrames(k), n),
      events: (type) =>
        page.evaluate(
          (t) => (window as unknown as PageWindow).__indoor.events.filter((e) => t === null || e.type === t),
          type ?? null,
        ),
      clearEvents: () => page.evaluate(() => (window as unknown as PageWindow).__indoor.clearEvents()),
      async setHeadPose({ position, yawDeg = 0, pitchDeg = 0 }) {
        const q = headQuaternion(yawDeg, pitchDeg);
        await page.evaluate(
          ({ p, q }) => {
            const d = (window as unknown as PageWindow).IWER_DEVICE;
            d.position.set(p[0], p[1], p[2]);
            d.quaternion.set(q[0], q[1], q[2], q[3]);
          },
          { p: position, q },
        );
      },
      async shot(name) {
        return decodePng(await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }));
      },
      async pixels() {
        return decodePng(await page.screenshot());
      },
    };
    await use(harness);
  },
});

export { expect };
