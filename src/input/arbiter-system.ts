import { createSystem, Types } from '@iwsdk/core';
import { HANDS, isChapterPhase, type AppContext, type InputMode } from '../core/types.ts';
import { createArbiter, type Arbiter, type ArbiterFrame } from './arbiter.ts';

/**
 * Runs the arbiter every frame (priority −3.4, after HandsSystem at −3.6):
 * pinches on handles become actuate() calls. Sets ctx.arbiter in init.
 *
 * The IWSDK ray sub-pointer is on only in 'ray' mode (M2), so a pinch can
 * never act both directly and through a ray (IWSDK itself only toggles
 * 'touch', input-system.js:96-109). Grabs are dropped on session end and
 * as soon as the session stops being visible: Quest does not run rAF while
 * hidden, so waiting for the next step would leave a grab dangling.
 */
export class ArbiterSystem extends createSystem({}, { ctx: { type: Types.Object, default: undefined } }) {
  private ctx!: AppContext;
  private arbiter!: Arbiter;
  private frame!: ArbiterFrame;
  private syncedMode: InputMode | null = null;

  init(): void {
    const ctx = (this.ctx = this.config.ctx.value as AppContext);
    this.arbiter = createArbiter({ handles: ctx.handles, actuation: ctx.actuation, bus: ctx.bus, game: ctx.game });
    ctx.arbiter = this.arbiter;
    this.frame = { time: 0, allowed: false, mode: ctx.actuation.mode, hands: ctx.hands };
    this.syncRayPointers(ctx.actuation.mode);
    this.cleanupFuncs.push(
      ctx.bus.on('session:end', () => this.arbiter.cancelAll('cancel')),
      ctx.bus.on('visibility', (e) => {
        if (e.state !== 'visible') this.arbiter.cancelAll('cancel');
      }),
    );
  }

  update(_delta: number, time: number): void {
    const ctx = this.ctx;
    const mode = ctx.actuation.mode;
    if (mode !== this.syncedMode) this.syncRayPointers(mode);
    const f = this.frame;
    f.time = time;
    f.allowed = ctx.visible() && isChapterPhase(ctx.game.phase);
    f.mode = mode;
    this.arbiter.step(f);
  }

  private syncRayPointers(mode: InputMode): void {
    this.syncedMode = mode;
    for (let k = 0; k < HANDS.length; k++) {
      this.input.xr.multiPointers[HANDS[k]].toggleSubPointer('ray', mode === 'ray');
    }
  }
}
