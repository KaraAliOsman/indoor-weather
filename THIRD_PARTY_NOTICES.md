# Third-party notices

Indoor Weather is built on the open-source projects below. Full license texts
ship with each package in `node_modules/<package>/LICENSE`; the notices for
code adapted into this repository are reproduced here.

## Runtime dependencies (in the published bundle)

| Package | License |
|---|---|
| @iwsdk/core, @iwsdk/xr-input, @iwsdk/locomotor (Meta Platforms, Inc.) | MIT |
| three (as `super-three@0.181.0`, three.js authors) | MIT |
| @pmndrs/uikit and related packages | MIT |

## Development and test only (not in the published bundle)

| Package | License |
|---|---|
| @iwsdk/vite-plugin-dev (Meta Platforms, Inc.) | MIT |
| iwer — Immersive Web Emulation Runtime (Meta Platforms, Inc.) | MIT |
| vite, typescript, @playwright/test | MIT / Apache-2.0 |

## Code adapted into this repository

### meta-quest/iwsdk-v0-template — Apache License 2.0
Copyright (c) Meta Platforms, Inc. and affiliates.
Used in: `vite.config.ts` (modified). Licensed under the Apache License,
Version 2.0: http://www.apache.org/licenses/LICENSE-2.0

### felixtrz/roadster — MIT License
Copyright (c) 2026 Felix Zhang.
Used in: `src/vendor/uikit-lucide-lite.ts`, the Lucide alias in `vite.config.ts`.

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

### meta/immersive-web-sdk — MIT License
Copyright (c) Meta Platforms, Inc. and affiliates.
Used in: `.github/workflows/deploy.yml` (adapted from the build & deploy guide);
`tests/unit/glsl-multiview.test.ts` (the declared-identifier regex, adapted from
`packages/core/tests/environment/gradient-environment.test.ts`; tests only, not
in the published bundle).

### Public-domain snippets
- `lowbias32` integer hash (Chris Wellons), in `src/render/glsl/noise.ts`.
- `mulberry32` PRNG (Tommy Ettinger), in `src/render/leaves-material.ts` and
  `tests/unit/helpers/noise.ts`.
