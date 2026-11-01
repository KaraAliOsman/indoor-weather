import { createSystem, Types } from '@iwsdk/core';
import { HANDS, type AppContext, type Handedness, type HandSample, type HeadSample } from '../core/types.ts';
import { createDistancePinch, type DistancePinch } from './distance-pinch.ts';
import { readControllerFrame, readHandFrame } from './hand-frame';
import { clearHandGeometry, resetHandsState } from './hands-state.ts';
import { vetoStart } from './palm.ts';
import { createPinchFilter, type PinchFilter, type PinchFilterInput } from './pinch-filter.ts';
import { createSelectSource, type SelectSource } from './select-source';
import { OccluderHand } from '../render/occluder-hand';

// Below this horizontal length of the view direction (looking straight down) yaw is undefined.
const MIN_FORWARD_XZ = 1e-3;
/** Filter dt clamp (s): a long hitch must not read as a slow, smooth move. */
const MAX_FILTER_DT_S = 0.05;

/**
 * Writes ctx.hands every frame (priority −3.6, right after IWSDK's
 * InputSystem at −4 has refreshed gamepads, joints and the rig matrices).
 *
 * Per hand: device (primary hand adapter, else primary controller), geometry,
 * select edges (system select; ?pinch=distance swaps in the thumb/index
 * detector for hands), the conditioned pinchPoint (input/pinch-filter.ts: a
 * glitch frame counts as untracked), tracked and lostFor, and the
 * palm-to-face veto on the start edge (?veto=0 disables it).
 * Head pose from player.head.matrixWorld.
 */
export class HandsSystem extends createSystem({}, { ctx: { type: Types.Object, default: undefined } }) {
  private ctx!: AppContext;
  private selectSource!: SelectSource;
  private readonly distance: Record<Handedness, DistancePinch> = {
    left: createDistancePinch(),
    right: createDistancePinch(),
  };
  private readonly filters: Record<Handedness, PinchFilter> = {
    left: createPinchFilter(),
    right: createPinchFilter(),
  };
  private readonly lastTracked: Record<Handedness, number> = { left: -Infinity, right: -Infinity };
  private filterDt = 0;
  private readonly filterInput: PinchFilterInput = {
    tracked: false,
    raw: { x: 0, y: 0, z: 0 },
    dt: 0,
    selecting: false,
    start: false,
    end: false,
  };
  private vetoes = 0;

  init(): void {
    const ctx = (this.ctx = this.config.ctx.value as AppContext);
    this.selectSource = createSelectSource(this.input);
    ctx.probes.hands = () => ({ vetoes: this.vetoes });
    this.cleanupFuncs.push(
      ctx.bus.on('session:start', () => {
        this.resetSamples();
        const session = this.renderer.xr.getSession();
        if (session) this.selectSource.attach(session);
      }),
      ctx.bus.on('session:end', () => {
        this.selectSource.detach();
        this.resetSamples();
      }),
    );
  }

  update(delta: number, time: number): void {
    // Outside XR there is nothing to read (InputSystem does not update the rig).
    if (!this.renderer.xr.getSession() || !this.xrFrame) return;
    this.filterDt = delta > 0 ? (delta < MAX_FILTER_DT_S ? delta : MAX_FILTER_DT_S) : 0;
    const hands = this.ctx.hands;
    this.readHead(hands.head);
    for (let k = 0; k < HANDS.length; k++) {
      const h = HANDS[k];
      this.readHand(h, hands[h], hands.head, time);
    }
  }

  private readHead(head: HeadSample): void {
    const e = this.player.head.matrixWorld.elements;
    head.position.x = e[12];
    head.position.y = e[13];
    head.position.z = e[14];
    // View direction = −Z column.
    const fx = -e[8];
    const fy = -e[9];
    const fz = -e[10];
    const len = Math.hypot(fx, fy, fz) || 1;
    head.pitch = Math.asin(Math.max(-1, Math.min(1, fy / len)));
    const xz = Math.hypot(fx, fz);
    if (xz / len >= MIN_FORWARD_XZ) {
      head.forward.x = fx / xz;
      head.forward.y = 0;
      head.forward.z = fz / xz;
    }
    // Looking along (−sin ψ, 0, −cos ψ).
    head.yaw = Math.atan2(-head.forward.x, -head.forward.z);
    head.valid = true;
  }

  private readHand(h: Handedness, s: HandSample, head: Readonly<HeadSample>, time: number): void {
    const { hand, controller } = this.input.xr.visualAdapters;
    const handAdapter = hand[h];
    const controllerAdapter = controller[h];

    // Hide a depth-only hand whose poses stopped arriving (tracking lost, source still connected).
    const visual = handAdapter.visual;
    if (visual instanceof OccluderHand) visual.tick();

    let tracked = false;
    if (handAdapter.connected && handAdapter.isPrimary) {
      s.device = 'hand';
      tracked = readHandFrame(handAdapter, head, s);
    } else if (controllerAdapter.connected && controllerAdapter.isPrimary) {
      s.device = 'controller';
      tracked = readControllerFrame(controllerAdapter, s);
    } else {
      s.device = 'none';
      clearHandGeometry(s);
    }
    const flags = this.ctx.flags;
    if (flags.pinch === 'distance' && s.device === 'hand') {
      // Untracked → NaN distance → no new sample: the level holds, the FSM retention decides.
      const e = this.distance[h].update(s.tipDistance, s.handScale);
      s.selectStart = e.start;
      s.rawSelectStart = e.start;
      s.selectEnd = e.end;
      s.selecting = e.selecting;
      s.selectPath = 'distance';
    } else {
      this.distance[h].reset();
      this.selectSource.read(h, s);
    }

    // Filtered pinch point; an impossible jump while a pinch is held is a glitch → untracked.
    const f = this.filterInput;
    f.tracked = tracked;
    f.raw = s.rawPinchPoint;
    f.dt = this.filterDt;
    f.selecting = s.selecting;
    f.start = s.rawSelectStart;
    f.end = s.selectEnd;
    tracked = this.filters[h].update(f, s.pinchPoint);

    s.tracked = tracked;
    if (tracked) this.lastTracked[h] = time;
    s.lostFor = tracked ? 0 : time - this.lastTracked[h];

    // Only the start edge is vetoed: a running pull never drops because the palm turned.
    if (s.rawSelectStart && vetoStart(s.palmToHead, s.wristDrop, flags.veto)) {
      s.selectStart = false;
      this.vetoes++;
      this.ctx.bus.emit({ type: 'veto', hand: h, reason: 'palm-to-face' });
    }
  }

  private resetSamples(): void {
    resetHandsState(this.ctx.hands);
    for (let k = 0; k < HANDS.length; k++) {
      const h = HANDS[k];
      this.distance[h].reset();
      this.filters[h].reset();
      this.lastTracked[h] = -Infinity;
    }
  }
}
