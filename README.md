# Indoor Weather

> **It rains on your real table. Your hand keeps the paper kite dry.**

**Try it:** open **https://karaaliosman.github.io/indoor-weather/** in the Meta Quest Browser on a Quest 3 or 3S, sit at a table and press **Enter AR**. Hands only, about three minutes, nothing to install.

Indoor Weather is a small mixed reality piece for one gesture: **pinch and pull**. A paper almanac box lands on your real table. Its tabs let the weather out:

| | Chapter | You do | What happens |
|---|---|---|---|
| I | **Wind** | Pinch the pink tab and pull it toward you | Paper leaves skate across your table in gusts |
| II | **Storm** | Pull the pink tag up out of the lid | A paper cloud follows your fingers and the room dims with your hand. It rains, slanted, on the wood and on a paper kite. Hold your palm over the kite: drops burst on your knuckles and the paper stays dry. Lift your hand and a **dry handprint** is left on the wet table |
| III | **Dawn** | Pull the tab once more (or wait: dawn comes on its own) | Your wind tears the cloud away, the light turns gold, and the dry kite flies on its string |

When you take the headset off, the landing page shows **today's page**: the shape of your dry handprint, the week, and when tomorrow's page arrives. It is kept only on your device.

Built with Meta's [Immersive Web SDK](https://github.com/meta/immersive-web-sdk) (IWSDK 1.0.1, WebXR, `immersive-ar`) for the **Meta VR Start Developer Competition 2026**.

| | |
|---|---|
| **Device** | Meta Quest 3 / 3S, Meta Quest Browser |
| **Input** | Hands. No controller is needed at any point (controllers work as a fallback) |
| **Posture** | Seated, at a table, everything within arm's reach |
| **Comfort** | No flashing lights, no locomotion, no text to read in the headset |
| **Network** | Zero cross-origin requests, no telemetry, no accounts |
| **Tested** | Typecheck, 223 unit tests and 7 end-to-end tests in Meta's IWER emulator (Quest 3 profile) on every build. Not yet measured on a physical headset (see [Honest notes](#honest-notes)) |

---

## How the hand keeps the kite dry

The signature moment is a real computation, not an animation:

- **HandField.** Every tracked hand becomes a **palm plate** (an ellipse fitted to the wrist and knuckle joints) plus **five finger capsules** and a forearm capsule, scaled to the measured hand.
- **The same geometry on the GPU and the CPU.** All rain (one instanced draw call) is sheared into "rain space" so the slanted fall becomes vertical. In the vertex shader each drop finds the highest surface under it (lid, palm, finger) and splashes there. On the CPU the exact same `blockY` function rasterises the hand's shelter.
- **A wet map on the table.** A 200 × 120 RG map (15 Hz) darkens the wood drop by drop, dries under the hand (τ 0.5 s) and accumulates how long each texel was sheltered. Lifting the hand after two seconds of shelter extracts that accumulator into a 64 × 48 bitmap, run-length encoded in under 400 bytes: **today's print**.
- **The room dims with your hand.** A stencil-masked veil darkens passthrough while the box, cloud and kite stay lit, 1:1 with the pull, speed-limited for comfort.

## Input that forgives

- **One verb.** Every interaction is pinch-and-pull on a paper handle, 1:1 (6 cm of hand = 6 cm of paper). A pull past 90 % completes itself on release.
- **Hybrid pinch.** The system select is the default source; thumb–index distance is the fallback. A One-Euro filter (1.2 Hz, β 20) removes tracking jitter and an 8 mm dead band keeps a resting hand from moving paper.
- **Palm-to-face veto.** A pinch that *starts* with the palm toward your face (Quest's system menu gesture) is ignored, only when the hand is held high.
- **Ratchet.** Progress never goes backward; release and resume anywhere. Short tracking loss holds the grab.
- **Automatic arrival.** Hit-test finds the table and the box lands on its own after 30 stable frames. Without a detected surface it lands about 45 cm in front of you after roughly 5 s.

## Rendering and budgets

- Own `ShaderMaterial`s only, multiview-safe (a GLSL lint test guards it): procedural riso paper (six inks, fibre and grain, filtered with `fwidth`), instanced leaves and rain whose motion lives in the vertex shader.
- **Storm peak: 24 draw calls, 21,072 triangles** (budget ≤ 32 and ≤ 30k), asserted by E2E-06 in the emulator.
- Startup download ≤ 2.6 MB, checked by `tools/check-dist.mjs` on every build, which also fails if any emulator code or cross-origin entry reaches `dist/`.
- Sound is synthesised on the fly (no audio files): rain bed from the cloud, patter on the wood from the kite, drops on your skin at the sheltering hand, one distant thunder at −24 dB, all HRTF-panned.

---

## Run it locally

Requirements: **Node 24+**. The emulator does the rest; no headset needed.

```bash
npm ci --ignore-scripts
npm run dev                         # http://localhost:47191 with Meta's IWER emulator injected
npx playwright install chromium     # once
npm test                            # typecheck → unit → build + check-dist → E2E
```

| URL | What you get |
|---|---|
| `http://localhost:47191/?sem=mesa&hands=show` | A synthetic table for hit-test, with visible hands |
| `http://localhost:47191/?hands=show` | No synthetic environment: the box uses the fallback landing |

| Flag | Effect |
|---|---|
| `?debug=1` | `window.__indoor` debug API in a production build |
| `?reset=1` | Removes only this app's saved keys (`indoorweather.*`) |
| `?hands=show` | Draws the hands as soft paper (emulator captures have no real hands) |
| `?planes=0` | Does not request plane detection |
| `?pinch=distance` | Uses thumb–index distance instead of the system select |
| `?veto=0` | Disables the palm-to-face veto |

### Tests

- **Unit (223, `node --test`, no browser):** pinch FSM, One-Euro filter, arbiter, ratchet, palm veto, placement filters and model, storm director, HandField geometry, wet map, print encoding, almanac save, GLSL multiview lint.
- **End to end (7, Playwright + IWER 2.5.0 against the production build):** boot and Enter AR with hands and controllers (E2E-01/02), hit-test placement (E2E-03), both fallbacks (E2E-04a/b), the full Wind pull with real emulated pinches (E2E-05), and the whole Storm → Dawn → today's page arc (E2E-06: real pinches, palm shelter, dry print, draw-call budget, saved print). Every test also asserts no page errors, no `console.error` and zero cross-origin requests.

### Deploy

`.github/workflows/deploy.yml` deploys to GitHub Pages on manual dispatch only (typecheck, unit tests and build with `VITE_BASE_PATH=/<repo>/`).

---

## Privacy

- No camera access: the app only uses what WebXR gives it (hand joints, head pose, hit-test, optional planes). Nothing leaves the device.
- No telemetry, analytics, accounts or cookies. Hand and controller models are self-hosted (`src/boot/cdn-guard.ts` rewrites the input-profiles CDN).
- Today's print and the week's seals are stored in `localStorage` under `indoorweather.v1`, on your device only.

## Honest notes

- The footage and all tests run in **Meta's IWER emulator** (Quest 3 profile). The emulator does not reproduce multiview, foveation or real frame pacing; the 72 Hz target has **not been measured on a physical Quest yet**.
- The demo video uses `@iwer/sem` scanned rooms as the emulated passthrough, and is labelled as emulator footage.

## Project layout

```
index.html              landing page and today's page (2D, Quest Browser)
src/
  main.ts               world, systems, session hooks, almanac save
  boot/                 flags, world options, CDN guard
  core/                 types, event bus, game state, frame clock, almanac
  input/                hands, pinch filter and FSM, palm veto, arbiter, ratchet
  placement/            hit-test probe, filters, placement model, reticle
  box/ mechanisms/      the paper box, Wind and Dawn tabs
  storm/                HandField, wet map, storm director, views, dry print
  render/               paper, leaves, rain, wet decal, veil, hand occluder
  audio/                synthesised foley and storm sound
  ui/                   landing logic
  debug/                window.__indoor, MesaSEM synthetic table
tests/unit/ tests/e2e/  node --test and Playwright + IWER
tools/check-dist.mjs    post-build guard
```

## License

MIT, see [LICENSE](./LICENSE). Built on IWSDK and IWER (Meta Platforms, MIT) and three.js (`super-three`, MIT), with code adapted from `meta-quest/iwsdk-v0-template` (Apache-2.0), `felixtrz/roadster` (MIT) and `meta/immersive-web-sdk` (MIT). Full attributions in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
