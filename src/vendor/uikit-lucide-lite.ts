/**
 * Stand-in for @pmndrs/uikit-lucide (aliased in vite.config.ts). UIKitML
 * registers every export of that package as a markup component, which pulls
 * all ~1,600 Lucide icons into the bundle even though Indoor Weather uses no
 * spatial UI. uikit-horizon's dropdown and checkbox only need these two.
 *
 * Adapted from felixtrz/roadster (src/vendor/uikit-lucide-lite.ts),
 * MIT License, Copyright (c) 2026 Felix Zhang.
 */
export * from '@pmndrs/uikit-lucide/dist/Check.js';
export * from '@pmndrs/uikit-lucide/dist/ChevronDown.js';
