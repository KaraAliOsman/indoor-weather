/**
 * Indoor Weather — Vite config.
 *
 * Portions adapted from meta-quest/iwsdk-v0-template (vite.config.ts),
 * Copyright (c) Meta Platforms, Inc. and affiliates, Apache License 2.0 — modified.
 *
 * Code-only IWSDK project: there is deliberately no iwsdk.config.json, so the
 * dev plugin does not start its MCP workspace / managed browser / telemetry.
 * The plugin is used only to inject the IWER emulator on localhost during dev.
 */
import { fileURLToPath } from 'node:url';
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';

const port = Number.parseInt(process.env.PORT ?? '', 10) || 47191;

export default defineConfig(({ command }) => ({
  plugins:
    command === 'serve' && process.env.IW_NO_EMULATOR !== '1'
      ? [
          iwsdkDev({
            emulator: {
              device: 'metaQuest3',
              activation: 'localhost',
              injectOnBuild: false,
            },
            https: false,
          }),
        ]
      : [],
  server: {
    host: 'localhost',
    port,
    strictPort: true,
    open: false,
  },
  preview: {
    host: 'localhost',
    port: 47173,
    strictPort: true,
  },
  resolve: {
    // Lucide lite alias adapted from felixtrz/roadster (MIT, (c) 2026 Felix Zhang).
    alias: [
      {
        find: /^@pmndrs\/uikit-lucide$/,
        replacement: fileURLToPath(new URL('./src/vendor/uikit-lucide-lite.ts', import.meta.url)),
      },
    ],
    // One three / uikit graph only (uikitml can otherwise pull a second copy).
    dedupe: ['three', '@pmndrs/uikit', '@pmndrs/uikit-horizon', '@pmndrs/uikit-lucide'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'esnext',
    chunkSizeWarningLimit: 4096,
  },
  esbuild: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  // GitHub Pages serves the app under /<repo>/; the deploy workflow sets this.
  base: process.env.VITE_BASE_PATH || '/',
}));
