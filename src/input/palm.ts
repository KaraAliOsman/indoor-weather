/**
 * Palm-to-face veto. PURE module.
 *
 * Quest opens the system menu with "palm towards the face + pinch", made
 * with the hand raised in front of the face. That pinch also reaches the page
 * as a select, so a start edge made with the palm facing the head AND the
 * wrist less than PALM_VETO_MAX_DROP_M below the eyes is ignored. The height
 * matters: seated at a table, a palm-up pinch on the box (wrist ~0.4 m below
 * the eyes) also "faces" the head (cos ≈ 0.84) and must not be vetoed.
 * Only the start is vetoed: once a pull is running the palm may turn freely.
 * Nothing else is vetoed (palm up and extended fingers are normal pulling
 * poses in the IWER study).
 */
import type { Vec3 } from '../core/types.ts';

/** cos of ~45°: the palm must clearly face the head. */
export const PALM_VETO_COS = 0.7;
/** The menu gesture is made in front of the face: wrist at most this far below the eyes (m). */
export const PALM_VETO_MAX_DROP_M = 0.3;

/**
 * Cosine between the palm normal and the wrist → head direction.
 * NaN when either vector is degenerate (unknown palm, head on the wrist).
 */
export function palmToHead(palmNormal: Readonly<Vec3>, wrist: Readonly<Vec3>, head: Readonly<Vec3>): number {
  const dx = head.x - wrist.x;
  const dy = head.y - wrist.y;
  const dz = head.z - wrist.z;
  const dLen = Math.hypot(dx, dy, dz);
  const nLen = Math.hypot(palmNormal.x, palmNormal.y, palmNormal.z);
  if (!(dLen > 1e-6) || !(nLen > 1e-6)) return NaN;
  return (palmNormal.x * dx + palmNormal.y * dy + palmNormal.z * dz) / (dLen * nLen);
}

/**
 * True when a start edge must be dropped: palm facing the head with the hand
 * raised (wristDrop = head.y - wrist.y). NaN (unknown) never vetoes.
 */
export function vetoStart(palmToHeadCos: number, wristDrop: number, enabled: boolean): boolean {
  return enabled && palmToHeadCos > PALM_VETO_COS && wristDrop < PALM_VETO_MAX_DROP_M;
}
