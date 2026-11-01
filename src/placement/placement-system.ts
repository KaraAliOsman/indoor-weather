import {
  createSystem,
  EnvironmentRaycastTarget,
  Quaternion,
  RaycastSpace,
  Types,
  Vector3,
  type Entity,
} from '@iwsdk/core';
import type { AppContext, BoxPose, PlacementSource } from '../core/types.ts';
import { PLACEMENT_DEFAULTS, settleEase } from './filters.ts';
import {
  createPlacementModel,
  type HitTestAvailability,
  type PlacementInput,
  type PlacementOutput,
} from './placement-model.ts';
import { createReticle, type Reticle } from './reticle';

/**
 * Places the box on a real table (priority -0.5, after EnvironmentRaycastSystem at -1).
 *
 * - Hit-test is probed once per session with our own requestHitTestSource:
 *   only when it succeeds does the reticle get an EnvironmentRaycastTarget
 *   (Viewer space, pitched 25° down). If the request were rejected,
 *   EnvironmentRaycastSystem would retry and console.error every frame.
 * - Every frame while placing: read this frame's xrHitTestResult (getPose is
 *   only valid inside the frame that produced it), feed the pure model, then
 *   overwrite the reticle (IWSDK shows it on any hit, valid or not).
 * - Commit (select, fallback select or debug place()): drop the target, show
 *   the box and settle it for 0.5 s (lift 4 cm → 0, scale 0.85 → 1, fixed
 *   ease), then emit box:placed.
 * - session:end: everything back to idle, no box:placed for that session.
 *
 * Sets ctx.placement and ctx.probes.placement in init.
 */

const cfg = PLACEMENT_DEFAULTS;
const DEG = Math.PI / 180;
/** Below this head height the reference space is Local (head ≈ 0): the floor rule is skipped. */
const FLOOR_KNOWN_HEAD_Y = 0.6;
/** Box scale at the start of the settle. */
const SETTLE_SCALE0 = 0.85;
const UP = new Vector3(0, 1, 0);

function copyPose(p: Readonly<BoxPose>): BoxPose {
  return { position: { x: p.position.x, y: p.position.y, z: p.position.z }, yaw: p.yaw };
}

export class PlacementSystem extends createSystem({}, { ctx: { type: Types.Object, default: undefined } }) {
  private ctx!: AppContext;
  private reticle!: Reticle;
  private reticleEntity!: Entity;
  private readonly model = createPlacementModel(cfg);
  /** Ray offset of the reticle target: -Z pitched down. */
  private readonly rayOffset = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -cfg.reticlePitchDeg * DEG);

  private hitTest: HitTestAvailability = 'unknown';
  /** Invalidates in-flight probes (bumped on every session start and end). */
  private probeToken = 0;
  private targetAttached = false;
  private wantTarget = false;

  private hasPose = false;
  private readonly finalPose: BoxPose = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  private readonly settlePose: BoxPose = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  private settling = false;
  private settleStart = 0;

  // Per-frame scratch (no allocation in update).
  private readonly hit = { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } };
  private stepInput!: PlacementInput;

  init(): void {
    const ctx = (this.ctx = this.config.ctx.value as AppContext);
    this.stepInput = {
      time: 0,
      visible: false,
      hitTest: 'unknown',
      hit: null,
      head: ctx.hands.head,
      floorKnown: false,
      selectStart: false,
      pinchY: null,
    };

    this.reticle = createReticle();
    this.reticleEntity = this.world.createTransformEntity(this.reticle.object);
    ctx.box.setVisible(false);

    this.cleanupFuncs.push(
      ctx.bus.on('session:start', () => this.onSessionStart()),
      ctx.bus.on('session:end', () => this.onSessionEnd()),
      () => this.reticle.dispose(),
    );

    const sys = this;
    ctx.placement = {
      get status() {
        return sys.model.status;
      },
      get pose() {
        return sys.hasPose ? sys.finalPose : null;
      },
      commit(pose?: BoxPose) {
        return sys.debugCommit(pose);
      },
    };
    ctx.probes.placement = () => ({
      hitTest: this.hitTest,
      target: this.targetAttached,
      settling: this.settling,
    });
  }

  update(_delta: number, time: number): void {
    const ctx = this.ctx;
    this.syncTarget(false);
    if (this.settling) this.stepSettle(time);

    const mode = this.model.status.mode;
    if (ctx.game.phase === 'placing' && (mode === 'probing' || mode === 'hit-test' || mode === 'fallback')) {
      const input = this.stepInput;
      const head = ctx.hands.head;
      input.time = time;
      input.visible = ctx.visible();
      input.hitTest = this.hitTest;
      input.hit = this.readHit();
      input.head = head;
      input.floorKnown = head.valid && head.position.y > FLOOR_KNOWN_HEAD_Y;
      this.readSelect(input);
      this.apply(this.model.step(input), time);
    }
    this.syncReticle();
  }

  // -------------------------------------------------------------------------
  // Session lifecycle

  private onSessionStart(): void {
    this.onSessionEnd(); // drop leftovers from a previous session
    this.model.start(this.ctx.clock.time);
    this.ctx.bus.emit({ type: 'placement:mode', mode: 'probing', reason: 'start' });
    const session = this.xrManager.getSession();
    if (session) void this.probe(session, this.probeToken);
    else this.hitTest = 'unavailable';
  }

  private onSessionEnd(): void {
    this.probeToken++;
    this.model.reset();
    this.hitTest = 'unknown';
    this.settling = false;
    this.hasPose = false;
    this.wantTarget = false;
    this.syncTarget(true);
    this.reticle.setState('hidden');
    this.ctx.box.setVisible(false);
  }

  /**
   * Same condition IWSDK uses to enable its raycast system (enabledFeatures),
   * then one viewer-space source that is cancelled at once: IWSDK requests
   * its own when the target is added.
   */
  private async probe(session: XRSession, token: number): Promise<void> {
    let source: XRHitTestSource | undefined;
    try {
      if (session.enabledFeatures?.includes('hit-test') && session.requestHitTestSource) {
        const space = await session.requestReferenceSpace('viewer');
        source = await session.requestHitTestSource({ space });
      }
    } catch {
      source = undefined; // IWER without a SEM: OperationError; no hit-test on device: NotSupportedError
    }
    try {
      source?.cancel();
    } catch {
      /* already gone with its session */
    }
    // Stale: the session ended or restarted, or a debug place() committed meanwhile.
    if (token !== this.probeToken || session !== this.xrManager.getSession()) return;
    const mode = this.model.status.mode;
    if (mode !== 'probing' && mode !== 'fallback') return;
    // A late success after the probing timeout still lets a real surface take over.
    this.hitTest = source ? 'available' : 'unavailable';
    if (source) {
      this.wantTarget = true;
      this.syncTarget(false);
    }
  }

  /**
   * Adds or removes the raycast target to match `wantTarget`. Removal waits
   * while IWSDK still has a source request in flight (otherwise the source
   * would resolve into a removed component and never be cancelled), unless
   * `force` (session end: its sources die with it).
   */
  private syncTarget(force: boolean): void {
    const e = this.reticleEntity;
    if (this.wantTarget && !this.targetAttached) {
      e.addComponent(EnvironmentRaycastTarget, {
        space: RaycastSpace.Viewer,
        maxDistance: cfg.reticleMaxDistM,
        offsetQuaternion: this.rayOffset,
      });
      this.targetAttached = true;
    } else if (!this.wantTarget && this.targetAttached) {
      if (!force && e.getValue(EnvironmentRaycastTarget, '_sourceRequested')) return;
      e.removeComponent(EnvironmentRaycastTarget); // IWSDK cancels the source on disqualify
      this.targetAttached = false;
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame input

  /** This frame's hit in world space (pose +Y = normal), or null. */
  private readHit(): PlacementInput['hit'] {
    if (!this.targetAttached) return null;
    const result = this.reticleEntity.getValue(EnvironmentRaycastTarget, 'xrHitTestResult') as
      | XRHitTestResult
      | undefined;
    const space = this.world.xrReferenceSpace;
    if (!result || !space) return null;
    let pose: XRPose | undefined;
    try {
      pose = result.getPose(space);
    } catch {
      return null; // stale result from an earlier frame
    }
    if (!pose) return null;
    const { position: p, orientation: q } = pose.transform;
    const hit = this.hit;
    hit.position.x = p.x;
    hit.position.y = p.y;
    hit.position.z = p.z;
    // Second column of the rotation matrix.
    hit.normal.x = 2 * (q.x * q.y - q.w * q.z);
    hit.normal.y = 1 - 2 * (q.x * q.x + q.z * q.z);
    hit.normal.z = 2 * (q.y * q.z + q.w * q.x);
    return hit;
  }

  /** Any hand's select start (already palm-vetoed by HandsSystem); pinch height of that hand. */
  private readSelect(input: PlacementInput): void {
    const { left, right } = this.ctx.hands;
    const h = left.selectStart ? left : right.selectStart ? right : null;
    input.selectStart = h !== null;
    input.pinchY = h && h.tracked && Number.isFinite(h.pinchPoint.y) ? h.pinchPoint.y : null;
  }

  // -------------------------------------------------------------------------
  // Commit and settle

  private apply(out: PlacementOutput, time: number): void {
    if (out.modeChange) {
      this.ctx.bus.emit({ type: 'placement:mode', mode: out.modeChange.mode, reason: out.modeChange.reason });
    }
    if (out.commit) this.beginSettle(out.commit.pose, out.commit.source, time);
  }

  private debugCommit(pose?: BoxPose): boolean {
    if (this.ctx.game.phase !== 'placing') return false;
    const time = this.ctx.clock.time;
    const out = this.model.forceCommit(pose ?? null, time);
    if (!out) return false;
    this.apply(out, time);
    return true;
  }

  private beginSettle(pose: Readonly<BoxPose>, source: PlacementSource, time: number): void {
    const f = this.finalPose;
    f.position.x = pose.position.x;
    f.position.y = pose.position.y;
    f.position.z = pose.position.z;
    f.yaw = pose.yaw;
    this.hasPose = true;
    this.wantTarget = false;
    this.syncTarget(false);
    this.reticle.setState('hidden');
    this.settling = true;
    this.settleStart = time;
    this.applySettle(0);
    this.ctx.box.setVisible(true);
    this.ctx.bus.emit({ type: 'placement:commit', source, pose: copyPose(f) });
  }

  private stepSettle(time: number): void {
    const t = (time - this.settleStart) / cfg.settleS;
    if (t < 1) {
      this.applySettle(settleEase(t));
      return;
    }
    this.applySettle(1);
    this.settling = false;
    this.ctx.bus.emit({ type: 'box:placed', pose: copyPose(this.finalPose) });
  }

  private applySettle(e: number): void {
    const f = this.finalPose;
    const s = this.settlePose;
    s.position.x = f.position.x;
    s.position.y = f.position.y + (1 - e) * cfg.settleLiftM;
    s.position.z = f.position.z;
    s.yaw = f.yaw;
    this.ctx.box.setPose(s, SETTLE_SCALE0 + (1 - SETTLE_SCALE0) * e);
  }

  // -------------------------------------------------------------------------
  // Reticle

  /** Runs every frame after EnvironmentRaycastSystem (-1), which shows the reticle on any hit. */
  private syncReticle(): void {
    const st = this.model.status;
    if (this.ctx.game.phase !== 'placing' || !st.reticleVisible) {
      this.reticle.setState('hidden');
      return;
    }
    const c = st.candidate;
    if (st.mode === 'fallback' && c) {
      // No surface: the reticle marks the floating candidate. In hit-test mode IWSDK already put it on the hit.
      const o = this.reticle.object;
      o.position.set(c.position.x, c.position.y, c.position.z);
      o.quaternion.setFromAxisAngle(UP, c.yaw);
    }
    this.reticle.setState(st.valid ? 'valid' : 'invalid');
  }
}
