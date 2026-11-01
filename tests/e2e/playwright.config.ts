import { defineConfig } from '@playwright/test';

/**
 * E2E against the production build (`vite preview`), with our own pinned IWER
 * 2.5.0 injected by the fixture (the build never contains the emulator).
 * Run `npm run build` first (or `npm test`, which does build + e2e).
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './.artifacts/results',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:47173',
    viewport: { width: 1280, height: 720 },
    // Bundled Chromium; set PW_CHANNEL=chrome to use the system Chrome instead.
    channel: process.env.PW_CHANNEL || undefined,
    launchOptions: { args: ['--use-angle=d3d11', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:47173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
