import {
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type InputLayout,
  type PerspectiveCamera,
  type Scene,
  type XRHandVisualAdapter,
} from '@iwsdk/core';

/**
 * Hand visual that hides virtual content behind the user's real hand.
 *
 * In passthrough the real hand is already visible, so the default visual is
 * depth-only (colorWrite off, drawn first): the box, leaves and rain are cut
 * out where the hand is. With `OccluderHand.showHands = true` (emulator and
 * trailer captures, where there is no real hand) the same geometry is drawn
 * as a soft paper-coloured hand instead.
 *
 * Joint transforms come from the IWSDK hand adapter (`jointTransforms`,
 * 25 × 4x4, relative to the grip space where the adapter places `model`), so
 * no extra fillPoses call is needed. Cost: 2 draw calls per hand.
 */

// WebXR hand joint indices (XRHand iteration order).
const BONES: ReadonlyArray<readonly [number, number]> = [
  // thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // index, middle, ring, pinky
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24],
  // palm fill: metacarpal and knuckle lines
  [5, 10], [10, 15], [15, 20], [6, 11], [11, 16], [16, 21], [1, 5],
];

const JOINT_COUNT = 25;
const INFLATE = 1.2;

function jointRadius(i: number): number {
  if (i === 0) return 0.022;
  if (i === 1 || i === 5 || i === 10 || i === 15 || i === 20) return 0.014;
  const isTip = i === 4 || i === 9 || i === 14 || i === 19 || i === 24;
  const pinky = i >= 20;
  return (isTip ? 0.0075 : 0.0095) * (pinky ? 0.85 : 1);
}

const UP = new Vector3(0, 1, 0);

export class OccluderHand {
  static assetKeyPrefix = 'iw-occ';
  static assetProfileId = 'occluder';
  /** Set before the first hand connects. Set by main.ts from the base URL. */
  static assetPath = '/proxy/hand.gltf';
  /** Draw the hand instead of only writing depth (emulator / captures). */
  static showHands = false;

  model = new Group();
  xrInput?: XRHandVisualAdapter;
  /** Visuals on (connect/toggle); the model is shown only while poses are fresh too. */
  private enabled = false;
  /** Frames since the adapter last delivered joint poses (it skips update() when fillPoses fails). */
  private staleFrames = Infinity;

  private readonly joints: InstancedMesh;
  private readonly bones: InstancedMesh;
  private readonly positions = Array.from({ length: JOINT_COUNT }, () => new Vector3());
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly mid = new Vector3();
  private readonly dir = new Vector3();

  constructor(_scene: Scene, _camera: PerspectiveCamera, _gltfScene: Group, _layout: InputLayout) {
    const visible = OccluderHand.showHands;
    const material = new MeshBasicMaterial({
      color: 0xefe6d6,
      colorWrite: visible,
      depthWrite: true,
      transparent: false,
    });
    this.joints = new InstancedMesh(new SphereGeometry(1, 8, 6), material, JOINT_COUNT);
    this.bones = new InstancedMesh(new CylinderGeometry(1, 1, 1, 8, 1, true), material, BONES.length);
    for (const mesh of [this.joints, this.bones]) {
      // Rewritten every tracked frame.
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      // Depth-only pass must run before any other geometry.
      mesh.renderOrder = visible ? 0 : -100;
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.model.add(mesh);
    }
    this.model.name = 'occluder-hand';
  }

  init(): void {}

  connect(_inputSource: XRInputSource, enabled: boolean): void {
    this.enabled = enabled;
    this.staleFrames = Infinity;
    this.model.visible = false;
  }

  disconnect(): void {
    this.enabled = false;
    this.model.visible = false;
  }

  toggle(enabled: boolean): void {
    this.enabled = enabled;
    this.model.visible = enabled && this.staleFrames <= OccluderHand.maxStaleFrames;
  }

  /**
   * Once per frame after IWSDK's input update (HandsSystem). When tracking is
   * lost the source stays connected but update() stops being called: a frozen
   * depth-only hand would punch a hand-shaped hole through the box. Hide it
   * after `maxStaleFrames` frames without poses.
   */
  tick(): void {
    this.model.visible = this.enabled && this.staleFrames <= OccluderHand.maxStaleFrames;
    if (this.staleFrames !== Infinity) this.staleFrames++;
  }

  /** Tolerated frames without poses before hiding (one dropped frame is not a loss). */
  static maxStaleFrames = 1;

  update(_delta: number): void {
    const t = this.xrInput?.jointTransforms;
    if (!t || t.length < JOINT_COUNT * 16) return;
    this.staleFrames = 0;

    for (let i = 0; i < JOINT_COUNT; i++) {
      const p = this.positions[i];
      p.set(t[i * 16 + 12], t[i * 16 + 13], t[i * 16 + 14]);
      const r = jointRadius(i) * INFLATE;
      this.m.makeScale(r, r, r).setPosition(p);
      this.joints.setMatrixAt(i, this.m);
    }

    for (let b = 0; b < BONES.length; b++) {
      const a = this.positions[BONES[b][0]];
      const c = this.positions[BONES[b][1]];
      this.dir.subVectors(c, a);
      const len = this.dir.length();
      if (len < 1e-5) {
        this.m.makeScale(0, 0, 0);
      } else {
        this.dir.divideScalar(len);
        this.q.setFromUnitVectors(UP, this.dir);
        const r = Math.min(jointRadius(BONES[b][0]), jointRadius(BONES[b][1])) * INFLATE;
        this.mid.addVectors(a, c).multiplyScalar(0.5);
        this.s.set(r, len, r);
        this.m.compose(this.mid, this.q, this.s);
      }
      this.bones.setMatrixAt(b, this.m);
    }

    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
  }
}
