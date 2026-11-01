import { createSystem, Types } from '@iwsdk/core';
import type { AppContext, EventBus, XRVisibility } from './types.ts';

/** Max per-frame step for integration (s); timers use the unclamped `time`. */
export const MAX_DT_S = 0.05;

const lastVisibility = new WeakMap<EventBus, XRVisibility>();

/**
 * Emits 'visibility' only when the state actually changed. Shared by
 * FrameSystem (once per frame) and main.ts (the session's visibilitychange:
 * Quest does not run rAF while 'hidden', so no system would ever see it).
 */
export function emitVisibility(bus: EventBus, state: XRVisibility): void {
  if ((lastVisibility.get(bus) ?? 'non-immersive') === state) return;
  lastVisibility.set(bus, state);
  bus.emit({ type: 'visibility', state });
}

interface FrameWaiter {
  remaining: number;
  resolve(frame: number): void;
}
let waiters: FrameWaiter[] = [];

/**
 * Resolves inside FrameSystem.update of the n-th next frame (n >= 1) with
 * that frame's number. The awaiting code resumes after that whole rAF
 * callback (all systems + render). IWER input set before the call is
 * applied at the start of frame 1.
 */
export function waitFrames(n: number): Promise<number> {
  const remaining = Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
  return new Promise((resolve) => {
    waiters.push({ remaining, resolve });
  });
}

/**
 * First system of every frame (priority -10): writes ctx.clock, emits
 * 'visibility' on change and releases waitFrames() promises.
 */
export class FrameSystem extends createSystem({}, { ctx: { type: Types.Object, default: undefined } }) {
  private ctx!: AppContext;

  init(): void {
    this.ctx = this.config.ctx.value as AppContext;
  }

  update(delta: number, time: number): void {
    const { clock, bus } = this.ctx;
    clock.frame++;
    clock.time = time;
    clock.dt = Math.min(Math.max(delta, 0), MAX_DT_S);
    emitVisibility(bus, this.visibilityState.value as XRVisibility);

    if (waiters.length === 0) return;
    const due: FrameWaiter[] = [];
    const pending: FrameWaiter[] = [];
    for (const w of waiters) (--w.remaining <= 0 ? due : pending).push(w);
    waiters = pending;
    for (const w of due) w.resolve(clock.frame);
  }
}
