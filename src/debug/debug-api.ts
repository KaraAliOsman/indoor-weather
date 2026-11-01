import { AudioContext as ThreeAudioContext, type World } from '@iwsdk/core';
import type { Flags } from '../boot/flags';
import { waitFrames } from '../core/frame-system';
import {
  HANDS,
  type ActuationTarget,
  type AppContext,
  type DebugSnapshot,
  type DebugValue,
  type Handedness,
  type LoggedEvent,
  type MechanismId,
  type Vec3,
  type Vec3Tuple,
} from '../core/types.ts';

export interface DebugHandleInfo {
  point: Vec3Tuple;
  radius: number;
  enabled: boolean;
  axis: Vec3Tuple | null;
  travel: number | null;
}

/** window.__indoor (docs/architecture-m1.md §7). */
export interface IndoorDebugApi {
  flags: Flags;
  world: World;
  /** Not serialisable: use it only inside page.evaluate. */
  ctx: AppContext;
  /** JSON only (tuples, degrees). Keeps the M0 fields E2E-02 depends on. */
  state(): DebugSnapshot;
  /** = ctx.bus.log (ring of the latest 256 events, oldest first). */
  readonly events: readonly LoggedEvent[];
  clearEvents(): void;
  waitFrames(n: number): Promise<number>;
  /** ctx.placement.commit(): the pose, or the current candidate. False outside 'placing'. */
  place(pose?: { x: number; y: number; z: number; yawDeg: number }): boolean;
  /** Source 'debug': skips only the input-mode check. */
  actuate(target: ActuationTarget, amount: number): number;
  handles(): Partial<Record<ActuationTarget, DebugHandleInfo>>;
}

declare global {
  interface Window {
    __indoor?: IndoorDebugApi;
  }
}

const DEG = 180 / Math.PI;
const MECHANISMS: readonly MechanismId[] = ['wind', 'storm', 'dawn'];

const tuple = (v: Readonly<Vec3>): Vec3Tuple => [v.x, v.y, v.z];

function readProbes(ctx: AppContext): Record<string, Record<string, DebugValue>> {
  const out: Record<string, Record<string, DebugValue>> = {};
  for (const [name, probe] of Object.entries(ctx.probes)) {
    try {
      out[name] = probe();
    } catch (err) {
      out[name] = { error: String(err) };
    }
  }
  return out;
}

function snapshot(world: World, ctx: AppContext): DebugSnapshot {
  const info = world.renderer.info.render;
  const { clock, game, hands, actuation, placement, box } = ctx;
  const head = hands.head;
  const status = placement?.status;
  const candidate = status?.candidate ?? null;

  const handsOut = {} as DebugSnapshot['hands'];
  for (const h of HANDS as readonly Handedness[]) {
    const s = hands[h];
    const arb = ctx.arbiter?.stateOf(h);
    handsOut[h] = {
      device: s.device,
      tracked: s.tracked,
      fsm: arb?.fsm ?? 'idle',
      owner: arb?.owner ?? null,
      selectPath: s.selectPath,
      selecting: s.selecting,
      pinchPoint: tuple(s.pinchPoint),
      tipDistance: s.tipDistance,
      palmToHead: s.palmToHead,
    };
  }

  const registered = game.snapshot().registered;
  const mechanisms = {} as DebugSnapshot['mechanisms'];
  for (const id of MECHANISMS) {
    mechanisms[id] = {
      registered: registered.includes(id),
      unlocked: game.isUnlocked(id),
      progress: actuation.progress(id),
      complete: actuation.isComplete(id),
    };
  }

  return {
    // M0
    inSession: Boolean(world.session),
    visibility: world.visibilityState.value,
    audio: ThreeAudioContext.getContext().state,
    drawCalls: info.calls,
    triangles: info.triangles,
    // M1
    frame: clock.frame,
    time: clock.time,
    phase: game.phase,
    head: {
      valid: head.valid,
      position: tuple(head.position),
      yawDeg: head.yaw * DEG,
      pitchDeg: head.pitch * DEG,
    },
    placement: {
      mode: status?.mode ?? 'idle',
      verdict: status?.verdict ?? 'none',
      valid: status?.valid ?? false,
      stableFrames: status?.stableFrames ?? 0,
      elapsed: status?.elapsed ?? 0,
      reticleVisible: status?.reticleVisible ?? false,
      candidate: candidate ? { position: tuple(candidate.position), yawDeg: candidate.yaw * DEG } : null,
    },
    box: {
      placed: Boolean(placement?.pose),
      settling: game.phase === 'settling',
      visible: box.visible,
      position: tuple(box.pose.position),
      yawDeg: box.pose.yaw * DEG,
      scale: box.scale,
    },
    mechanisms,
    hands: handsOut,
    input: { mode: actuation.mode, rejected: actuation.rejected, doubleActuations: actuation.doubleActuations },
    probes: readProbes(ctx),
  };
}

/** Only installed in dev builds or with ?debug=1. */
export function installDebugApi(world: World, flags: Flags, ctx: AppContext): void {
  window.__indoor = {
    flags,
    world,
    ctx,
    state: () => snapshot(world, ctx),
    get events() {
      return ctx.bus.log;
    },
    clearEvents: () => ctx.bus.clearLog(),
    waitFrames,
    place(pose) {
      const placement = ctx.placement;
      if (!placement) return false;
      if (!pose) return placement.commit();
      const { x, y, z, yawDeg } = pose;
      if (![x, y, z, yawDeg].every(Number.isFinite)) return false;
      return placement.commit({ position: { x, y, z }, yaw: yawDeg / DEG });
    },
    actuate: (target, amount) => ctx.actuation.actuate(target, amount, 'debug'),
    handles() {
      const out: Partial<Record<ActuationTarget, DebugHandleInfo>> = {};
      for (const h of ctx.handles.all()) {
        out[h.target] = {
          point: tuple(h.grabPoint),
          radius: h.grabRadius,
          enabled: h.enabled,
          axis: h.hint ? tuple(h.hint.axis) : null,
          travel: h.hint ? h.hint.travel : null,
        };
      }
      return out;
    },
  };
}
