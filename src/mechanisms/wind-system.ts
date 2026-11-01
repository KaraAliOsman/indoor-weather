import { createSystem, Types, Vector3 } from '@iwsdk/core';
import type { BoxRig } from '../box/box-rig';
import type { AppContext, Handedness, HandSample, Vec3 } from '../core/types.ts';
import { createLinearHandle, type LinearHandle } from './linear-handle.ts';
import { createWindView, WIND, WIND_TAB_GRIP_Z, type WindView } from './wind';

/**
 * Wind and Dawn chapter glue (priority 0.5, after placement and IWSDK's
 * priority-0 systems; configData { ctx, rig }). Both chapters use the same
 * pull tab and the same leaves (direccion/canon.md §1).
 *
 * - Registers the pull tab as a LinearHandle and announces the chapter
 *   (`mechanism:register`). It never writes progress: it only reads
 *   actuation.progress('wind') and listens to the ratchet's events.
 * - notch{wind, i} releases leaf group i; mechanism:complete{wind} releases
 *   the last group. Each release emits `wind:gust`.
 * - The view is created once, on the first placement:commit, and reused when
 *   AR is re-entered.
 * - Dawn: once the wind is done the tab slides back into the box. When the
 *   storm is over (storm:over) the same tab becomes the 'dawn' handle; its
 *   notches blow the leaves again. Nobody pulls within DAWN_AUTO_S: the dawn
 *   comes on its own (actuate 'auto'), the story never stalls.
 */

/** Seconds of an enabled, untouched dawn tab before the dawn comes by itself (canon §1). */
export const DAWN_AUTO_S = 10;
/** The tab slides back into the box this long after the wind completes (s). */
const TAB_RETURN_DELAY_S = 2.5;

// Scratch (no allocation per frame).
const rest = new Vector3();
const axis = new Vector3();

/** Hover radius for the "pinch here" highlight, as a multiple of the grab radius. */
const HOVER_FACTOR = 1.8;
const HIGHLIGHT_GRAB = 1;
const HIGHLIGHT_HOVER = 0.55;
const HIGHLIGHT_IDLE = 0.12;

const handBit = (h: Handedness): number => (h === 'left' ? 1 : 2);

function within(s: HandSample, p: Readonly<Vec3>, r: number): boolean {
  if (!s.tracked) return false;
  const dx = s.pinchPoint.x - p.x;
  const dy = s.pinchPoint.y - p.y;
  const dz = s.pinchPoint.z - p.z;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

export class WindSystem extends createSystem(
  {},
  {
    ctx: { type: Types.Object, default: undefined },
    rig: { type: Types.Object, default: undefined },
  },
) {
  private ctx!: AppContext;
  private rig!: BoxRig;
  private handle!: LinearHandle;
  private dawn!: LinearHandle;
  private windDoneAt = Infinity;
  private stormOver = false;
  private dawnReadyAt = Infinity;
  /** Tab position shown (eased), 0..1 of the travel. */
  private tabShown = 0;
  private view: WindView | null = null;
  /** Groups requested by the ratchet (bitmask); released ones are in the view. */
  private requested = 0;
  private gusts = 0;
  /** Hands currently holding the tab (bitmask), from handle:grab/release. */
  private holders = 0;
  private precompiled = false;

  init(): void {
    const ctx = this.config.ctx.value as AppContext | undefined;
    const rig = this.config.rig.value as BoxRig | undefined;
    if (!ctx || !rig) throw new Error('[wind] WindSystem needs configData { ctx, rig }');
    this.ctx = ctx;
    this.rig = rig;
    this.handle = createLinearHandle({
      target: 'wind',
      travel: WIND.travelM,
      grabRadius: WIND.grabRadiusM,
      deadbandM: WIND.deadbandM,
      releaseSnapAt: WIND.releaseSnapAt,
    });

    this.dawn = createLinearHandle({
      target: 'dawn',
      travel: WIND.travelM,
      grabRadius: WIND.grabRadiusM,
      deadbandM: WIND.deadbandM,
      releaseSnapAt: WIND.releaseSnapAt,
    });

    const { bus } = ctx;
    this.cleanupFuncs.push(
      ctx.handles.register(this.handle),
      ctx.handles.register(this.dawn),
      bus.on('storm:over', () => {
        this.stormOver = true;
      }),
      bus.on('placement:commit', () => this.ensureView()),
      bus.on('notch', (e) => {
        if (e.target === 'wind') this.requestGust(e.index);
        if (e.target === 'dawn') this.view?.replay(e.index, ctx.clock.time);
      }),
      bus.on('mechanism:complete', (e) => {
        if (e.target === 'wind') {
          this.requestGust(WIND.groups - 1);
          this.windDoneAt = ctx.clock.time;
        }
        if (e.target === 'dawn') this.view?.replay(WIND.groups - 1, ctx.clock.time);
      }),
      bus.on('handle:grab', (e) => {
        if (e.target === 'wind' || e.target === 'dawn') this.holders |= handBit(e.hand);
      }),
      bus.on('handle:release', (e) => {
        if (e.target === 'wind' || e.target === 'dawn') this.holders &= ~handBit(e.hand);
      }),
      bus.on('session:end', () => {
        this.holders = 0;
      }),
      () => {
        this.view?.dispose();
        this.view = null;
        delete ctx.probes.wind;
      },
    );

    ctx.probes.wind = () => ({
      gusts: this.gusts,
      leavesReleased: this.view?.leavesReleased ?? 0,
      leafCount: this.view?.leaves.count ?? WIND.leafCount,
    });

    bus.emit({ type: 'mechanism:register', id: 'wind' });
    bus.emit({ type: 'mechanism:register', id: 'dawn' });
  }

  update(_delta: number, time: number): void {
    // Programs are keyed on multiview, so they can only be built inside an XR
    // frame. Build the view while the box is still hidden and compile it in the
    // background: the box and the leaves then appear without a hitch.
    if (!this.precompiled && this.renderer.xr.isPresenting) {
      this.precompiled = true;
      this.ensureView();
      this.renderer.compileAsync(this.rig.root, this.camera, this.scene).catch(() => {
        // Not fatal: the programs then link synchronously on first draw.
      });
    }
    const { ctx, rig, handle, view } = this;
    const anchor = rig.anchors.wind;

    // World frame of the tab: rest grip point and pull axis (anchor +Z = box front).
    anchor.updateWorldMatrix(true, false);
    rest.set(0, 0, WIND_TAB_GRIP_Z).applyMatrix4(anchor.matrixWorld);
    axis.setFromMatrixColumn(anchor.matrixWorld, 2).normalize();

    const phase = ctx.game.phase;
    const windP = ctx.actuation.progress('wind');
    const dawnP = ctx.actuation.progress('dawn');
    const windOn = view !== null && rig.visible && phase === 'wind';
    const dawnOn = view !== null && rig.visible && phase === 'dawn' && this.stormOver;
    handle.setFrame(rest, axis, windP, windOn);
    this.dawn.setFrame(rest, axis, dawnP, dawnOn);

    // The dawn never stalls: an untouched tab pulls itself after DAWN_AUTO_S.
    if (dawnOn && this.dawnReadyAt === Infinity) this.dawnReadyAt = time;
    if (dawnOn && this.holders === 0 && dawnP === 0 && time - this.dawnReadyAt >= DAWN_AUTO_S) {
      ctx.actuation.actuate('dawn', 1, 'auto');
    }
    if (!view) return;

    // Tab: follows the wind pull, slides home after it, then follows the dawn pull.
    let target = windP;
    if (phase === 'dawn' || ctx.actuation.isComplete('dawn')) target = dawnP;
    else if (time - this.windDoneAt >= TAB_RETURN_DELAY_S) target = 0;
    // 1:1 while a hand holds it (canon §4); eased only when it moves on its own.
    if (this.holders !== 0) this.tabShown = target;
    else this.tabShown += (target - this.tabShown) * (1 - Math.exp(-ctx.clock.dt * 9));
    view.setProgress(this.tabShown);
    view.setHighlight(this.highlight(windOn || dawnOn));
    view.update(time, ctx.clock.dt);
  }

  private highlight(enabled: boolean): number {
    if (this.holders !== 0) return HIGHLIGHT_GRAB;
    if (!enabled) return 0;
    const { hands } = this.ctx;
    const r = this.handle.grabRadius * HOVER_FACTOR;
    const p = this.handle.grabPoint;
    return within(hands.left, p, r) || within(hands.right, p, r) ? HIGHLIGHT_HOVER : HIGHLIGHT_IDLE;
  }

  private ensureView(): void {
    if (this.view) return;
    this.view = createWindView(this.rig.anchors.wind);
    // Defensive: gusts requested before the view existed are released now.
    for (let g = 0; g < WIND.groups; g++) if (this.requested & (1 << g)) this.release(g);
  }

  private requestGust(group: number): void {
    if (!Number.isInteger(group) || group < 0 || group >= WIND.groups) return;
    const bit = 1 << group;
    if (this.requested & bit) return;
    this.requested |= bit;
    if (this.view) this.release(group);
  }

  private release(group: number): void {
    const view = this.view;
    if (!view) return;
    const before = view.leavesReleased;
    view.gust(group, this.ctx.clock.time);
    this.gusts++;
    this.ctx.bus.emit({ type: 'wind:gust', group, leaves: view.leavesReleased - before });
  }
}
