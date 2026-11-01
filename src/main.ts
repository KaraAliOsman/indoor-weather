import { AudioContext as ThreeAudioContext, World } from '@iwsdk/core';
import { createFoley } from './audio/foley';
import { installCdnGuard } from './boot/cdn-guard';
import { createWorldOptions } from './boot/config';
import { parseFlags } from './boot/flags';
import { resetProgress } from './boot/reset';
import { createBoxRig } from './box/box-rig';
import {
  createAlmanacStore,
  earnSeal,
  recordPrint,
  shiftDateKey,
  todayKey,
  type AlmanacState,
  type DateKey,
} from './core/almanac.ts';
import { createEventBus } from './core/events.ts';
import { emitVisibility, FrameSystem } from './core/frame-system';
import { createGameState } from './core/game-state.ts';
import { DEFAULT_SETTINGS, type AppContext, type FrameClock, type XRVisibility } from './core/types.ts';
import { installDebugApi } from './debug/debug-api';
import { createActuation } from './input/actuation.ts';
import { ArbiterSystem } from './input/arbiter-system';
import { createHandleRegistry } from './input/handles.ts';
import { createHandsState } from './input/hands-state.ts';
import { HandsSystem } from './input/hands-system';
import { WindSystem } from './mechanisms/wind-system';
import { PlacementSystem } from './placement/placement-system';
import { StormSystem } from './storm/storm-system';
import { OccluderHand } from './render/occluder-hand';
import { ProxyController } from './render/proxy-controller';
import { createLanding } from './ui/landing';

const BASE = import.meta.env.BASE_URL;
const flags = parseFlags(location.search);

if (flags.reset) {
  resetProgress();
  const url = new URL(location.href);
  url.searchParams.delete('reset');
  location.replace(url);
}

const landing = createLanding(document);

OccluderHand.assetPath = `${BASE}proxy/hand.gltf`;
OccluderHand.showHands = flags.showHands;
ProxyController.assetPath = `${BASE}proxy/controller.gltf`;
installCdnGuard(BASE);

const world = await World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  createWorldOptions(flags),
);
world.renderer.debug.checkShaderErrors = import.meta.env.DEV || flags.debug;

// Our visuals replace the default hand/controller GLBs before any input connects.
const { hand, controller } = world.input.xr.visualAdapters;
hand.left.updateVisualImplementation(OccluderHand);
hand.right.updateVisualImplementation(OccluderHand);
controller.left.updateVisualImplementation(ProxyController);
controller.right.updateVisualImplementation(ProxyController);

// Fixed per session: three ignores (and warns about) changes while presenting.
world.renderer.xr.setFramebufferScaleFactor(1.0);

// --- Shared services (docs/architecture-m1.md §6) ---------------------------

const clock: FrameClock = { frame: 0, time: 0, dt: 0 };
// Read the session directly: world.visibilityState is only refreshed once per
// rendered frame, and world.session is assigned after three's 'sessionstart'.
const visible = (): boolean => world.renderer.xr.getSession()?.visibilityState === 'visible';
const bus = createEventBus(clock);
// Subscribed first: every later handler of an event already sees its phase change.
const game = createGameState(bus);
// Hidden until placement commits (the Visibility component copies it on creation).
const rig = createBoxRig();
world.createTransformEntity(rig.root);

const ctx: AppContext = {
  flags,
  settings: { ...DEFAULT_SETTINGS },
  clock,
  bus,
  game,
  hands: createHandsState(),
  handles: createHandleRegistry(),
  actuation: createActuation({ bus, game, clock, visible }),
  arbiter: null,
  placement: null,
  box: rig,
  visible,
  probes: {},
};

// Unique priorities = data flow (docs/architecture-m1.md §3). IWSDK's own
// systems sit at -5, -4 (input), -3.8, -3.75, -3.5, -1 (raycast) and 0.
world.registerSystem(FrameSystem, { priority: -10, configData: { ctx } });
world.registerSystem(HandsSystem, { priority: -3.6, configData: { ctx } });
world.registerSystem(ArbiterSystem, { priority: -3.4, configData: { ctx } });
world.registerSystem(PlacementSystem, { priority: -0.5, configData: { ctx } });
world.registerSystem(WindSystem, { priority: 0.5, configData: { ctx, rig } });
world.registerSystem(StormSystem, { priority: 0.6, configData: { ctx, rig } });
createFoley(bus, ctx.handles);

// --- The almanac: today's seals and dry handprint, kept on this device only ---

const store = createAlmanacStore(safeStorage());
const today = todayKey(new Date());
let almanac: AlmanacState = store.load(today).state;
const keep = (next: AlmanacState): void => {
  if (next === almanac) return;
  almanac = next;
  store.save(almanac, Date.now(), true);
};
bus.on('mechanism:complete', (e) => keep(earnSeal(almanac, today, e.target)));
bus.on('storm:print', (e) => {
  if (e.print) keep(earnSeal(recordPrint(almanac, today, e.print), today, 'shelter'));
});

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const keyDate = (key: DateKey): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

function showToday(): void {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  landing.showToday({
    dateLabel: keyDate(today).toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' }),
    print: almanac.days[today]?.print,
    week: Array.from({ length: 7 }, (_, i) => {
      const key = shiftDateKey(today, i - 6);
      return {
        label: keyDate(key).toLocaleDateString('en', { weekday: 'narrow' }),
        print: Boolean(almanac.days[key]?.print),
        today: key === today,
      };
    }),
    msToNextPage: midnight.getTime() - now.getTime(),
  });
}
showToday();

world.renderer.xr.addEventListener('sessionstart', () => {
  world.renderer.xr.setFoveation(0.75);
  const session = world.renderer.xr.getSession() as
    | (XRSession & { updateTargetFrameRate?(rate: number): Promise<void> })
    | null;
  session?.updateTargetFrameRate?.(72).catch(() => {});
  landing.setInSession(true);
  if (session) {
    // IWSDK suspends the context on sessionend (audio-system.js:58-67): resume on the first in-XR select too.
    session.addEventListener('selectstart', () => {
      const audio = ThreeAudioContext.getContext();
      if (audio.state === 'suspended') void audio.resume();
    });
    // rAF does not run while 'hidden' on Quest: FrameSystem alone would never see it.
    session.addEventListener('visibilitychange', () => emitVisibility(bus, session.visibilityState as XRVisibility));
  }
  bus.emit({ type: 'session:start' });
});
world.renderer.xr.addEventListener('sessionend', () => {
  landing.setInSession(false);
  bus.emit({ type: 'session:end' });
  showToday();
});

// Both BEFORE landing.setReady(): Enter AR must not be clickable before the SEM
// is installed (IWER checks it inside requestHitTestSource) or before __indoor exists.
if (import.meta.env.DEV && flags.sem === 'mesa') {
  // Dev-only: tree-shaken out of dist (check-dist fails on "IWER_DEVICE").
  const { installMesaSem, MESA_DEFAULT } = await import('./debug/mesa-sem.ts');
  installMesaSem(MESA_DEFAULT);
}
if (import.meta.env.DEV || flags.debug) installDebugApi(world, flags, ctx);

// offer:'none' → everything synchronous inside the click (Quest requires the
// user activation to reach requestSession; the emulator does not check it).
landing.onEnter(() => {
  // Both calls stay synchronous inside the user activation; XR first, so a
  // broken audio stack can never keep the user out of the session.
  world.launchXR();
  try {
    ThreeAudioContext.getContext()
      .resume()
      .catch(() => {});
  } catch {
    // No WebAudio: the experience stays silent.
  }
});

const arSupported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
landing.setReady(Boolean(arSupported));
