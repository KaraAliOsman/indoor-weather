import {
  createSystem,
  NotEqualStencilFunc,
  ReplaceStencilOp,
  AlwaysStencilFunc,
  Types,
  Vector3,
  Color as ColorClass,
  type Color,
  type Material,
  type ShaderMaterial,
} from '@iwsdk/core';
import { createStormAudio, type StormAudio } from '../audio/storm-audio';
import { BOX_ANCHORS, BOX_SIZE, type BoxRig } from '../box/box-rig';
import type { AppContext, Handedness, HandSample, Vec3 } from '../core/types.ts';
import { createLinearHandle, type LinearHandle } from '../mechanisms/linear-handle.ts';
import { createNightModel, type NightModel } from '../mechanisms/night.ts';
import { createNightVeil, type NightVeil } from '../render/night-veil-material';
import { createRainView, type RainView } from '../render/rain-material';
import { createWetDecal, type WetDecal } from '../render/wet-decal';
import { blockY, createHandField, updateHandField, type RainSlant } from './hand-field.ts';
import { encodePrint, extractPrint } from './print.ts';
import { createStormDirector, type StormDirector } from './storm-director.ts';
import { CLOUD_SIZE, createCloudView, createKiteView, type CloudView, type KiteView } from './storm-views';
import { createWetMap, type WetMap } from './wet-map.ts';

/**
 * Storm chapter glue (direccion/canon.md §1–§7; priority 0.6, configData { ctx, rig }).
 *
 * Gesture: a pink tag rises out of the lid slot a few seconds after the wind;
 * pinch it and pull up 8 cm. The cloud grows out of the box with it and the
 * room darkens with your hand (WOW 2). Letting go at ≥ 60 % completes it: the
 * cloud floats to its place and it rains, slanted, on the paper kite resting
 * on the table. Hold your hand over the kite: the drops hit your knuckles
 * and splash there, the wood around darkens, and a dry print of your hand
 * stays when you lift it (WOW 3, the signature moment).
 *
 * Dawn (the wind tab again, see WindSystem): your gust breaks the cloud
 * apart, the dark veil turns to a gold wash and clears, the wet wood dries
 * three times faster and the dry kite takes off on its string for a
 * figure-eight before it settles back on the table.
 *
 * The rain, the wet map and the shelter all read the same HandField
 * (storm/hand-field.ts), so what you see stop on your hand is what keeps the
 * wood dry. Pure logic lives in storm-director.ts, wet-map.ts, hand-field.ts.
 */

export const STORM_LAYOUT = {
  /** Tag: grab point above the slot at rest (box frame offset from the slot anchor, m). */
  tagRestY: 0.022,
  tagTopY: 0.03,
  travelM: 0.08,
  grabRadiusM: 0.065,
  deadbandM: 0.004,
  /** Releasing at or past this completes (canon §4: autocomplete ≥ 0.60). */
  releaseSnapAt: 0.6,
  /** Delay after the wind completes before the tag rises (s): the leaves get their moment. */
  revealDelayS: 6,
  /** Cloud at rest: centre (box frame, m). */
  cloudCenter: [0.06, 0.34, 0.03] as const,
  /** Kite rest (box frame) and its half extents on the table (m). */
  kiteHalf: [0.045, 0.06] as const,
  /** Rain slant (canon §2: normalize(0.14, −1, 0.45)). */
  slant: [0.14, 0.45] as const,
  /** Impact ellipse half extents, centred on the kite (canon: 0.30 × 0.20). */
  impactHalf: [0.15, 0.1] as const,
  /** Room veil while it rains. */
  veilColor: 0x121a2b,
  veilSky: 0x1a2440,
  /** Dawn wash (canon §5): gold at α 0.12, i.e. 0.2 of the 0.6 veil. */
  dawnColor: 0xffb36b,
  dawnWash: 0.2,
  /** Dawn timeline (s): dark → gold, hold, clear (veil at 0 by 13 s, ΔL ≤ 10 %/s). */
  dawnToGoldS: 4.5,
  dawnHoldS: 4.5,
  dawnClearS: 4,
  /** Kite flight (canon §7): figure-eight 0.12 × 0.06 m around this centre, 6 s. */
  flightCenter: [0.1, 0.2, 0.1] as const,
  flightS: 6,
  /** String ring on the box front (box frame). */
  kiteRing: [0.1, 0.02, 0.09] as const,
} as const;

const UP = new Vector3(0, 1, 0);
const tmp = new Vector3();
const head: Vec3 = { x: 0, y: 0, z: 0 };
const pool: Vec3 = { x: 0, y: 0, z: 0 };
const cloudW: Vec3 = { x: 0, y: 0, z: 0 };
const kiteW: Vec3 = { x: 0, y: 0, z: 0 };
const handW: Vec3 = { x: 0, y: 0, z: 0 };

const HOVER_FACTOR = 1.6;
const handBit = (h: Handedness): number => (h === 'left' ? 1 : 2);
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const smooth01 = (t: number): number => {
  const x = t > 0 ? (t < 1 ? t : 1) : 0;
  return x * x * (3 - 2 * x);
};
const ring = new Vector3();

function within(s: HandSample, p: Readonly<Vec3>, r: number): boolean {
  if (!s.tracked) return false;
  const dx = s.pinchPoint.x - p.x;
  const dy = s.pinchPoint.y - p.y;
  const dz = s.pinchPoint.z - p.z;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** Marks a material as "lit inside the storm": it writes stencil 1, which the veil skips. */
export function keepLit(m: Material): void {
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = AlwaysStencilFunc;
  m.stencilZPass = ReplaceStencilOp;
}

export class StormSystem extends createSystem(
  {},
  {
    ctx: { type: Types.Object, default: undefined },
    rig: { type: Types.Object, default: undefined },
  },
) {
  private ctx!: AppContext;
  private rig!: BoxRig;
  private handle!: LinearHandle;
  private readonly director: StormDirector = createStormDirector();
  private readonly night: NightModel = createNightModel();
  private readonly field = createHandField();
  private readonly slant: RainSlant = { kx: STORM_LAYOUT.slant[0], kz: STORM_LAYOUT.slant[1], floorY: 0 };
  private wet!: WetMap;
  private cloud: CloudView | null = null;
  private kite: KiteView | null = null;
  private rain: RainView | null = null;
  private decal: WetDecal | null = null;
  private veil: NightVeil | null = null;
  private windDoneAt = Infinity;
  private holders = 0;
  /** Smoothed pull (what the tag and the cloud show). */
  private shown = 0;
  private shownV = 0;
  /** Tag peek 0..1 after the reveal. */
  private peek = 0;
  /** Cloud float 0..1 after completion. */
  private float = 0;
  private rainTime = 0;
  private kiteWet = 0;
  private cover = 0;
  private precompiled = false;
  private dryAtPrint = 0;
  private dawnAt = Infinity;
  private audio: StormAudio | null = null;
  private readonly colNight = new ColorClass(STORM_LAYOUT.veilColor);
  private readonly colSky = new ColorClass(STORM_LAYOUT.veilSky);
  private readonly colDawn = new ColorClass(STORM_LAYOUT.dawnColor);

  init(): void {
    const ctx = this.config.ctx.value as AppContext | undefined;
    const rig = this.config.rig.value as BoxRig | undefined;
    if (!ctx || !rig) throw new Error('[storm] StormSystem needs configData { ctx, rig }');
    this.ctx = ctx;
    this.rig = rig;
    this.handle = createLinearHandle({
      target: 'storm',
      travel: STORM_LAYOUT.travelM,
      grabRadius: STORM_LAYOUT.grabRadiusM,
      deadbandM: STORM_LAYOUT.deadbandM,
      releaseSnapAt: STORM_LAYOUT.releaseSnapAt,
    });
    const [kx, , kz] = BOX_ANCHORS.kite;
    this.wet = createWetMap({
      centerX: kx,
      centerZ: kz - 0.01,
      rainCenter: [kx, kz],
      rainHalf: STORM_LAYOUT.impactHalf,
    });

    const { bus } = ctx;
    this.cleanupFuncs.push(
      ctx.handles.register(this.handle),
      bus.on('mechanism:complete', (e) => {
        if (e.target === 'wind') this.windDoneAt = ctx.clock.time;
        if (e.target === 'storm') this.director.complete();
        if (e.target === 'dawn') this.dawnAt = ctx.clock.time;
      }),
      bus.on('handle:grab', (e) => {
        if (e.target === 'storm') this.holders |= handBit(e.hand);
      }),
      bus.on('handle:release', (e) => {
        if (e.target === 'storm') this.holders &= ~handBit(e.hand);
      }),
      bus.on('session:end', () => {
        this.holders = 0;
      }),
      () => {
        this.audio?.dispose();
        this.cloud?.dispose();
        this.kite?.dispose();
        this.rain?.dispose();
        this.decal?.dispose();
        this.veil?.dispose();
        delete ctx.probes.storm;
      },
    );

    ctx.probes.storm = () => ({
        stage: this.director.stage,
        shown: this.shown,
        density: this.rain?.uniforms.uDensity.value ?? 0,
        cover: this.cover,
        kiteWet: this.kiteWet,
        sheltered: this.wet.sheltered,
        dryAtPrint: this.dryAtPrint,
        veil: this.night.state.level,
        // Right palm slab centre in rain space (tests aim the shelter with it; −99 = none).
        palmU: this.field.palm[15] > 0.5 ? this.field.palm[12] : -99,
        palmW: this.field.palm[15] > 0.5 ? this.field.palm[14] : -99,
        kiteY: this.kite?.mesh.position.y ?? 0,
        veilMax: ((this.veil?.mesh.material as ShaderMaterial | undefined)?.uniforms.uVeilMax.value as number) ?? 0,
        veilShown: this.veil?.mesh.visible ?? false,
      });

    this.audio = createStormAudio();
    bus.emit({ type: 'mechanism:register', id: 'storm' });
  }

  private ensureViews(): void {
    if (this.cloud) return;
    const { rig } = this;
    this.cloud = createCloudView(rig.root);
    this.kite = createKiteView(rig.anchors.kite);
    const cloudBottom = STORM_LAYOUT.cloudCenter[1] - (CLOUD_SIZE[1] / 2) * 0.6;
    this.rain = createRainView({
      impactCenter: [BOX_ANCHORS.kite[0], BOX_ANCHORS.kite[2]],
      impactHalf: STORM_LAYOUT.impactHalf,
      slant: STORM_LAYOUT.slant,
      cloudY: cloudBottom,
      lid: [BOX_SIZE.x / 2 + 0.003, BOX_SIZE.z / 2 + 0.003, BOX_SIZE.y],
    });
    this.rain.mesh.visible = false;
    rig.root.add(this.rain.mesh);
    this.decal = createWetDecal(rig.root, this.wet);
    this.veil = createNightVeil(this.scene);
    const veilMat = this.veil.mesh.material as ShaderMaterial;
    (veilMat.uniforms.uVeilColNight.value as Color).setHex(STORM_LAYOUT.veilColor);
    (veilMat.uniforms.uVeilColSky.value as Color).setHex(STORM_LAYOUT.veilSky);
    // The veil darkens the room and the hands, never what the storm is about.
    veilMat.stencilWrite = true;
    veilMat.stencilRef = 1;
    veilMat.stencilFunc = NotEqualStencilFunc;
    for (const m of this.cloud.materials) keepLit(m);
    keepLit(this.kite.mesh.material as Material);
    rig.root.traverse((o) => {
      const m = (o as { material?: Material }).material;
      if (m && o.name === 'almanac-box-paper') keepLit(m);
    });
  }

  update(_delta: number, time: number): void {
    const { ctx, rig } = this;
    if (!this.precompiled && this.renderer.xr.isPresenting) {
      this.precompiled = true;
      this.ensureViews();
      this.renderer.compileAsync(this.scene, this.camera).catch(() => {
        // Not fatal: the programs then link on first draw.
      });
    }
    const dt = ctx.clock.dt;
    const L = STORM_LAYOUT;

    // Reveal the tag once the wind has had its moment.
    if (this.director.stage === 'hidden' && ctx.game.phase === 'storm' && time - this.windDoneAt >= L.revealDelayS) {
      this.director.reveal();
      ctx.bus.emit({ type: 'storm:reveal' });
    }
    // Wind skipped (debug / replays): the storm phase alone reveals it after the delay.
    if (this.windDoneAt === Infinity && ctx.game.phase === 'storm') this.windDoneAt = time;

    const revealed = this.director.stage !== 'hidden';
    const progress = ctx.actuation.progress('storm');
    const done = ctx.actuation.isComplete('storm');

    // Handle frame: grab point on the tag, pull axis = up.
    const anchor = rig.anchors.storm;
    anchor.updateWorldMatrix(true, false);
    tmp.set(0, L.tagRestY, 0).applyMatrix4(anchor.matrixWorld);
    const enabled = this.cloud !== null && revealed && !done && rig.visible && ctx.game.phase === 'storm';
    this.handle.setFrame(tmp, UP, progress, enabled);

    if (!this.cloud || !this.kite || !this.rain || !this.decal || !this.veil) return;

    // Smoothed pull (critical spring, ω 14): the paper follows the hand without jitter.
    const target = done ? 1 : progress;
    const w = 14;
    const a = this.shownV + w * w * (target - this.shown) * dt - 2 * w * this.shownV * dt;
    this.shownV = a;
    this.shown = Math.min(1, Math.max(0, this.shown + this.shownV * dt));
    this.peek = revealed ? Math.min(1, this.peek + dt / 0.45) : 0;
    this.float = done ? Math.min(1, this.float + dt / 0.6) : 0;

    this.placeCloudAndTag(enabled);

    // Room veil follows the pull, fully closed once the cloud is out.
    this.night.setTarget(done ? 1 : progress);
    const vs = this.night.step(dt);
    const headM = this.player.head.matrixWorld.elements;
    head.x = headM[12];
    head.y = headM[13];
    head.z = headM[14];
    rig.anchors.bulb.updateWorldMatrix(true, false);
    tmp.setFromMatrixPosition(rig.anchors.bulb.matrixWorld);
    pool.x = tmp.x;
    pool.y = tmp.y;
    pool.z = tmp.z;
    this.veil.setFrame(head, pool, rig.pose.position.y, rig.pose.yaw);
    const dawnT = time - this.dawnAt;
    this.applyDawnVeil(dawnT);
    this.veil.setState(vs);

    // Hands in the rain's frame, then the timeline.
    const box = { position: rig.pose.position, yaw: rig.pose.yaw, scale: rig.scale };
    updateHandField(this.field, 0, ctx.hands.left, box, this.slant);
    updateHandField(this.field, 1, ctx.hands.right, box, this.slant);
    this.cover = this.kiteCover();
    const st = this.director.step(dt, this.cover);
    for (const c of st.cues) this.cue(c);

    // Rain and wet map.
    const raining = st.density > 0;
    if (raining) this.rainTime += dt;
    this.rain.mesh.visible = raining;
    this.rain.uniforms.uDensity.value = st.density;
    this.rain.uniforms.uTime.value = this.rainTime;
    this.rain.setField(this.field);
    this.wet.update(dt, st.density, this.field, 0, dawnT >= 0);
    this.decal.sync();
    const [kx, , kz] = BOX_ANCHORS.kite;
    this.decal.setShadow(kx - 0.02, kz - 0.06, this.float * (0.35 + 0.65 * st.density));

    // Kite: soaks while exposed, dries under the hand (canon §7).
    const exposed = 1 - Math.min(1, this.cover / 0.6);
    this.kiteWet = Math.min(
      1,
      Math.max(0, this.kiteWet + exposed * (1 / 6) * st.density * dt - (1 - exposed) * 0.15 * dt - (dawnT >= 0 ? 0.3 * dt : 0)),
    );
    this.kite.setWet(this.kiteWet * 0.85);
    this.cloud.setWet(0.25 * st.density);
    this.flyKite(dawnT);
    this.sound(dt, st.density);
  }

  /** Rain bed at the cloud, patter at the kite, drops on the sheltering hand. */
  private sound(dt: number, density: number): void {
    if (!this.audio) return;
    this.cloud!.cloud.getWorldPosition(tmp);
    cloudW.x = tmp.x;
    cloudW.y = tmp.y;
    cloudW.z = tmp.z;
    this.rig.anchors.kite.getWorldPosition(tmp);
    kiteW.x = tmp.x;
    kiteW.y = tmp.y;
    kiteW.z = tmp.z;
    const { hands } = this.ctx;
    const h = this.field.active[1] ? hands.right : this.field.active[0] ? hands.left : null;
    let hand: Vec3 | null = null;
    if (h && h.jointsValid && this.cover > 0) {
      handW.x = h.joints[0];
      handW.y = h.joints[1];
      handW.z = h.joints[2];
      hand = handW;
    }
    this.audio.update(dt, density, cloudW, kiteW, hand, Math.min(1, this.cover * 1.5));
  }

  /** Veil colour and opacity through the dawn (dawnT < 0: still the storm's dark). */
  private applyDawnVeil(dawnT: number): void {
    const L = STORM_LAYOUT;
    const u = (this.veil!.mesh.material as ShaderMaterial).uniforms;
    const night = u.uVeilColNight.value as Color;
    const sky = u.uVeilColSky.value as Color;
    if (!(dawnT >= 0)) {
      night.copy(this.colNight);
      sky.copy(this.colSky);
      this.veil!.setFade(1);
      return;
    }
    const g = smooth01(dawnT / L.dawnToGoldS);
    night.copy(this.colNight).lerp(this.colDawn, g);
    sky.copy(this.colSky).lerp(this.colDawn, g);
    const clearT = dawnT - L.dawnToGoldS - L.dawnHoldS;
    const fade = clearT < 0 ? 1 + (L.dawnWash - 1) * g : L.dawnWash * (1 - smooth01(clearT / L.dawnClearS));
    this.veil!.setFade(fade);
  }

  /** Kite at rest, or flying its figure-eight on the string after the dawn gust. */
  private flyKite(dawnT: number): void {
    const kite = this.kite!;
    const m = kite.mesh;
    const L = STORM_LAYOUT;
    const [kx, , kz] = BOX_ANCHORS.kite;
    const t = dawnT - 0.4;
    if (!(t > 0) || t > L.flightS + 1.6) {
      m.position.set(0, 0.002, 0);
      m.rotation.set(0, 0, 0);
      kite.setString(ring, false);
      return;
    }
    // Flight pose in the kite anchor's frame (anchor = kite rest on the table).
    const [fx, fy, fz] = L.flightCenter;
    const w = (2 * Math.PI) / 3;
    const k = t < L.flightS ? t : L.flightS;
    const px = fx - kx + 0.06 * Math.sin(w * k);
    const py = fy + 0.03 * Math.sin(2 * w * k);
    const pz = fz - kz;
    // Rise in 1 s, fly, settle back in 1.6 s.
    const up = smooth01(t / 1);
    const down = t > L.flightS ? smooth01((t - L.flightS) / 1.6) : 0;
    const a = up * (1 - down);
    m.position.set(px * a, 0.002 + (py - 0.002) * a, pz * a);
    // Upright and facing the user in the air (nose up), banking with the turn.
    m.rotation.set(1.35 * a, 0, 0.45 * Math.cos(w * k) * a);
    ring.set(L.kiteRing[0] - kx, L.kiteRing[1], L.kiteRing[2] - kz);
    kite.setString(ring, a > 0.02);
  }

  /** Tag, thread and cloud for the current pull / float. */
  private placeCloudAndTag(enabled: boolean): void {
    const cloud = this.cloud!;
    const L = STORM_LAYOUT;
    const [sx, sy, sz] = BOX_ANCHORS.storm;
    const pull = this.shown;
    const peekY = (1 - (1 - this.peek) ** 3) * L.tagTopY - (1 - this.peek) * 0.02;
    const tagTop = sy + peekY + pull * L.travelM;

    // Growing out of the slot: scale 0.3 → 1 with the pull; then it floats to its place.
    const s0 = 0.3 + 0.7 * easeOutCubic(pull);
    const growY = sy + 0.004 + (CLOUD_SIZE[1] / 2) * s0 * 0.6;
    const growing = { x: sx, y: Math.min(growY, tagTop - 0.004 - (CLOUD_SIZE[1] / 2) * s0), z: sz };
    const f = easeOutCubic(this.float);
    const [cx, cy, cz] = L.cloudCenter;
    const scale = s0 + (1 - s0) * f;
    cloud.cloud.position.set(
      growing.x + (cx - growing.x) * f,
      growing.y + (cy - growing.y) * f,
      growing.z + (cz - growing.z) * f,
    );
    cloud.cloud.scale.setScalar(scale);
    cloud.cloud.visible = pull > 0.02 || this.float > 0;
    // Dawn: your gust tears the cloud off the box and it blows away, tumbling.
    const dawnT = this.ctx.clock.time - this.dawnAt;
    if (dawnT >= 0) {
      const e = smooth01(dawnT / 2.5);
      cloud.cloud.position.x += 0.35 * e;
      cloud.cloud.position.y += 0.1 * e;
      cloud.cloud.position.z -= 0.12 * e;
      cloud.cloud.scale.setScalar(Math.max(0.001, scale * (1 - e)));
      cloud.cloud.rotation.z = -0.6 * e;
      cloud.cloud.visible = e < 0.999;
    }

    // The tag rides on top of the cloud once it floats, shrinking away into it.
    const cloudTop = cloud.cloud.position.y + (CLOUD_SIZE[1] / 2) * scale;
    const tagY = this.float > 0 ? cloudTop + 0.02 * (1 - f) : tagTop;
    cloud.tag.position.set(cloud.cloud.position.x * f + sx * (1 - f), tagY, cloud.cloud.position.z * f + sz * (1 - f));
    cloud.tag.scale.setScalar(Math.max(0.001, 1 - f));
    cloud.tag.visible = this.peek > 0 && f < 0.999;
    const threadFrom = this.float > 0 ? cloudTop : sy;
    cloud.setThread(cloud.tag.position.x, threadFrom, tagY - 0.016 * cloud.tag.scale.y, cloud.tag.position.z);
    cloud.thread.visible = cloud.tag.visible && pull > 0.01;

    // Highlight: idle glow while waiting, stronger near a hand, full while held.
    if (this.holders !== 0) cloud.setHighlight(1);
    else if (!enabled) cloud.setHighlight(0);
    else {
      const { hands } = this.ctx;
      const r = this.handle.grabRadius * HOVER_FACTOR;
      const p = this.handle.grabPoint;
      cloud.setHighlight(within(hands.left, p, r) || within(hands.right, p, r) ? 0.55 : 0.15);
    }
  }

  /** Fraction of the kite (5 × 5 samples on the table) a hand keeps the rain off right now. */
  private kiteCover(): number {
    if (!this.field.active[0] && !this.field.active[1]) return 0;
    const [kx, , kz] = BOX_ANCHORS.kite;
    const [hx, hz] = STORM_LAYOUT.kiteHalf;
    let n = 0;
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i < 5; i++) {
        const u = kx + hx * (i / 2 - 1) * 0.8;
        const w = kz + hz * (j / 2 - 1) * 0.8;
        if (blockY(this.field, u, w) > 0.004) n++;
      }
    }
    return n / 25;
  }

  private cue(c: string): void {
    const { bus } = this.ctx;
    switch (c) {
      case 'rain':
        bus.emit({ type: 'storm:rain' });
        break;
      case 'thunder': {
        // Far behind the cloud: heard, never seen.
        this.cloud?.cloud.getWorldPosition(tmp);
        cloudW.x = tmp.x + 0.6;
        cloudW.y = tmp.y + 0.5;
        cloudW.z = tmp.z - 2;
        this.audio?.thunder(cloudW);
        bus.emit({ type: 'storm:thunder' });
        break;
      }
      case 'shelter-on':
        bus.emit({ type: 'storm:shelter', on: true });
        break;
      case 'shelter-off':
        bus.emit({ type: 'storm:shelter', on: false });
        break;
      case 'print': {
        this.dryAtPrint = this.wet.sheltered;
        const p = extractPrint(this.wet.shelter, this.wet.cols, this.wet.rows, this.wet.texel);
        bus.emit({ type: 'storm:print', dry: this.wet.sheltered, print: p ? encodePrint(p.bits) : '' });
        break;
      }
      case 'over':
        bus.emit({ type: 'storm:over' });
        break;
    }
  }
}
