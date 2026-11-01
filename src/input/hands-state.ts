/**
 * Stable per-frame input samples (ctx.hands). PURE module.
 *
 * The objects created here live for the whole app: HandsSystem mutates them
 * in place every frame and on session boundaries resets them, so readers may
 * keep references to `ctx.hands.right.pinchPoint` etc. (but must copy values
 * they keep past the current frame).
 */
import type { Handedness, HandSample, HandsState, HeadSample } from '../core/types.ts';

/** XRHand joint count. */
export const JOINT_COUNT = 25;

/** Wrist → middle-finger-phalanx-proximal span (m) assumed until a hand is measured. */
export const DEFAULT_HAND_SCALE = 0.09;

export function createHandSample(handedness: Handedness): HandSample {
  const s: HandSample = {
    handedness,
    device: 'none',
    tracked: false,
    lostFor: Infinity,
    selectStart: false,
    selectEnd: false,
    selecting: false,
    rawSelectStart: false,
    selectPath: 'none',
    pinchPoint: { x: 0, y: 0, z: 0 },
    rawPinchPoint: { x: 0, y: 0, z: 0 },
    tipDistance: NaN,
    handScale: DEFAULT_HAND_SCALE,
    palmNormal: { x: 0, y: 0, z: 0 },
    palmToHead: NaN,
    wristDrop: NaN,
    joints: new Float32Array(JOINT_COUNT * 3),
    jointsValid: false,
    pinchStrength: 0,
  };
  return s;
}

/** Back to "no source" without replacing any object. */
export function resetHandSample(s: HandSample): void {
  s.device = 'none';
  s.tracked = false;
  s.lostFor = Infinity;
  clearSelect(s);
  s.selectPath = 'none';
  s.pinchPoint.x = s.pinchPoint.y = s.pinchPoint.z = 0;
  s.rawPinchPoint.x = s.rawPinchPoint.y = s.rawPinchPoint.z = 0;
  s.handScale = DEFAULT_HAND_SCALE;
  clearHandGeometry(s);
}

/** Select edges and level off (no edge this frame). */
export function clearSelect(s: HandSample): void {
  s.selectStart = false;
  s.selectEnd = false;
  s.selecting = false;
  s.rawSelectStart = false;
}

/** Per-frame geometry unknown. Keeps the last pinch points and handScale. */
export function clearHandGeometry(s: HandSample): void {
  s.tipDistance = NaN;
  s.palmNormal.x = s.palmNormal.y = s.palmNormal.z = 0;
  s.palmToHead = NaN;
  s.wristDrop = NaN;
  s.pinchStrength = 0;
  s.jointsValid = false;
}

export function createHeadSample(): HeadSample {
  return {
    valid: false,
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    yaw: 0,
    pitch: 0,
  };
}

export function resetHeadSample(h: HeadSample): void {
  h.valid = false;
  h.position.x = h.position.y = h.position.z = 0;
  h.forward.x = 0;
  h.forward.y = 0;
  h.forward.z = -1;
  h.yaw = 0;
  h.pitch = 0;
}

export function createHandsState(): HandsState {
  return {
    left: createHandSample('left'),
    right: createHandSample('right'),
    head: createHeadSample(),
  };
}

export function resetHandsState(s: HandsState): void {
  resetHandSample(s.left);
  resetHandSample(s.right);
  resetHeadSample(s.head);
}
