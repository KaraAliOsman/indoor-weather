import type { XRControllerVisualAdapter, XRHandVisualAdapter } from '@iwsdk/core';
import type { HandSample, HeadSample, Vec3 } from '../core/types.ts';
import { clearHandGeometry } from './hands-state.ts';
import { palmToHead } from './palm.ts';

/**
 * Hand geometry for one frame, from what IWSDK already computed at −4.
 *
 * `adapter.jointTransforms` holds 25 column-major 4×4 matrices relative to
 * the grip space (fillPoses inside XRHandVisualAdapter.update, no second
 * call needed); `adapter.gripSpace.matrixWorld` is fresh because
 * XRInputManager runs xrOrigin.updateMatrixWorld(true) before we read it.
 * Only four joints are read (XRHand order, nm/iwer/lib/input/XRHand.js).
 */
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 9;
const MIDDLE_PROXIMAL = 11;
const MIN_JOINTS = MIDDLE_PROXIMAL + 1;
const ALL_JOINTS = 25;

// Plausible wrist → middle-proximal span (m): outside it the joints are garbage.
const MIN_HAND_SCALE = 0.05;
const MAX_HAND_SCALE = 0.15;

const thumb: Vec3 = { x: 0, y: 0, z: 0 };
const index: Vec3 = { x: 0, y: 0, z: 0 };
const wrist: Vec3 = { x: 0, y: 0, z: 0 };
const middle: Vec3 = { x: 0, y: 0, z: 0 };

/** World position of joint `j`: grip.matrixWorld × translation of jointTransforms[j]. */
function jointToWorld(m: ArrayLike<number>, t: ArrayLike<number>, j: number, out: Vec3): void {
  const o = j * 16;
  const x = t[o + 12];
  const y = t[o + 13];
  const z = t[o + 14];
  out.x = m[0] * x + m[4] * y + m[8] * z + m[12];
  out.y = m[1] * x + m[5] * y + m[9] * z + m[13];
  out.z = m[2] * x + m[6] * y + m[10] * z + m[14];
}

const finite3 = (v: Vec3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

function untracked(out: HandSample): false {
  clearHandGeometry(out);
  return false;
}

/**
 * Fills rawPinchPoint (thumb-tip/index-tip midpoint, unfiltered: HandsSystem
 * derives pinchPoint from it), tipDistance, handScale, palmNormal (−Y of the
 * wrist joint, i.e. out of the palm per WebXR Hand Input), palmToHead,
 * wristDrop and pinchStrength. Returns `tracked`; when false the per-frame
 * geometry is cleared and the pinch points keep their last value.
 */
export function readHandFrame(adapter: XRHandVisualAdapter, head: Readonly<HeadSample>, out: HandSample): boolean {
  const t = adapter.jointTransforms;
  const grip = adapter.gripSpace;
  // The array is zero-filled until the first successful fillPoses, and per
  // spec a failed fillPoses writes NaN: w of the wrist matrix must be 1.
  if (!adapter.connected || !adapter.isPrimary || !t || !grip || t.length < MIN_JOINTS * 16) return untracked(out);
  if (!(Math.abs(t[WRIST * 16 + 15] - 1) < 1e-3)) return untracked(out);

  const m = grip.matrixWorld.elements;
  jointToWorld(m, t, WRIST, wrist);
  jointToWorld(m, t, THUMB_TIP, thumb);
  jointToWorld(m, t, INDEX_TIP, index);
  jointToWorld(m, t, MIDDLE_PROXIMAL, middle);
  if (!finite3(wrist) || !finite3(thumb) || !finite3(index) || !finite3(middle)) return untracked(out);

  const p = out.rawPinchPoint;
  p.x = (thumb.x + index.x) * 0.5;
  p.y = (thumb.y + index.y) * 0.5;
  p.z = (thumb.z + index.z) * 0.5;
  out.tipDistance = Math.hypot(thumb.x - index.x, thumb.y - index.y, thumb.z - index.z);

  const scale = Math.hypot(middle.x - wrist.x, middle.y - wrist.y, middle.z - wrist.z);
  if (scale >= MIN_HAND_SCALE && scale <= MAX_HAND_SCALE) out.handScale = scale;

  // −Y column of the wrist (grip-relative), rotated to world by the grip's 3×3.
  const ax = -t[WRIST * 16 + 4];
  const ay = -t[WRIST * 16 + 5];
  const az = -t[WRIST * 16 + 6];
  const nx = m[0] * ax + m[4] * ay + m[8] * az;
  const ny = m[1] * ax + m[5] * ay + m[9] * az;
  const nz = m[2] * ax + m[6] * ay + m[10] * az;
  const len = Math.hypot(nx, ny, nz);
  const n = out.palmNormal;
  if (len > 1e-6) {
    n.x = nx / len;
    n.y = ny / len;
    n.z = nz / len;
    out.palmToHead = head.valid ? palmToHead(n, wrist, head.position) : NaN;
  } else {
    n.x = n.y = n.z = 0;
    out.palmToHead = NaN;
  }
  out.wristDrop = head.valid ? head.position.y - wrist.y : NaN;

  out.pinchStrength = adapter.getPinchStrength();

  // Every joint in world space (HandField: rain, wet map, shelter).
  if (t.length >= ALL_JOINTS * 16) {
    const J = out.joints;
    let ok = true;
    for (let j = 0; j < ALL_JOINTS; j++) {
      jointToWorld(m, t, j, middle);
      if (!finite3(middle)) ok = false;
      J[j * 3] = middle.x;
      J[j * 3 + 1] = middle.y;
      J[j * 3 + 2] = middle.z;
    }
    out.jointsValid = ok;
  } else out.jointsValid = false;
  return true;
}

/** Controllers: rawPinchPoint = grip origin; no finger geometry. Returns `tracked`. */
export function readControllerFrame(adapter: XRControllerVisualAdapter, out: HandSample): boolean {
  const grip = adapter.gripSpace;
  clearHandGeometry(out);
  if (!adapter.connected || !adapter.isPrimary || !grip) return false;
  const m = grip.matrixWorld.elements;
  out.rawPinchPoint.x = m[12];
  out.rawPinchPoint.y = m[13];
  out.rawPinchPoint.z = m[14];
  return true;
}
