/**
 * HandField v2 (direccion/canon.md §3). PURE module (no three, no IWSDK).
 *
 * What the rain sees of a hand: one palm slab (an ellipse in the plane fitted
 * to the palm, pushed 1.2 cm·k towards the back of the hand) plus five finger
 * capsules (MCP → tip) and one forearm capsule. The same numbers feed the
 * rain vertex shader (uPalm / uCap, render/glsl/rain.ts) and the CPU (wet
 * map, shelter, kite wetness), so a dry handprint is exactly where the drops
 * stopped.
 *
 * Everything here lives in RAIN SPACE: box-local coordinates sheared so the
 * slanted rain falls straight down. A point (x, y, z) maps to
 *   u = x + k.x·(y − floorY),  w = z + k.z·(y − floorY),  y unchanged,
 * where the fall direction is (k.x, −1, k.z) per metre of drop (towards +Z, the user). At table
 * height rain space and box space coincide, so the wet map needs no transform.
 */
import type { Handedness, HandSample, Vec3 } from '../core/types.ts';

/** Box pose needed to bring world joints into the box frame. */
export interface BoxFrame {
  position: Readonly<Vec3>;
  yaw: number;
  scale: number;
}

/** Rain slant: horizontal travel per metre of fall (canon §2: normalize(0.14·m, −1, 0.45)). */
export interface RainSlant {
  kx: number;
  kz: number;
  /** Table height in the box frame (m). */
  floorY: number;
}

export const HAND_FIELD = {
  /** Palm slab semi-axes (m, × k): along the hand (wrist → middle MCP) and across. */
  palmAlongM: 0.046,
  palmAcrossM: 0.044,
  /** Slab offset towards the back of the hand (m, × k). */
  palmDorsalM: 0.012,
  /** Finger capsule radius (m, × k). */
  fingerR: 0.008,
  /** Forearm capsule: length from the wrist away from the fingers, radius (m). */
  forearmLenM: 0.14,
  forearmR: 0.03,
  /** k = |j11 − j0| / 0.09, clamped. */
  kMin: 0.85,
  kMax: 1.15,
  /** A slab steeper than this (|n'.y| below) is ignored: fingers and forearm cover it. */
  minSlabNy: 0.2,
} as const;

/** Capsules per hand: 5 fingers + forearm. */
export const CAPS_PER_HAND = 6;
/** GPU layout: uPalm[3 per hand], uCap[2 per capsule]. */
export const PALM_VEC4 = 3;
export const CAP_VEC4 = 2;
export const PALM_FLOATS = 2 * PALM_VEC4 * 4;
export const CAP_FLOATS = 2 * CAPS_PER_HAND * CAP_VEC4 * 4;
/** uPalm[] / uCap[] lengths in render/glsl/rain.ts. */
export const RAIN_PALM_VEC4 = PALM_FLOATS / 4;
export const RAIN_CAP_VEC4 = CAP_FLOATS / 4;

/** XRHand joint indices: [base, tip] of each finger capsule (thumb, index, middle, ring, little). */
const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [2, 4],
  [6, 9],
  [11, 14],
  [16, 19],
  [21, 24],
];
const WRIST = 0;
const MIDDLE_MCP = 11;
const INDEX_MCP = 6;
const LITTLE_MCP = 21;

/**
 * Packed field, rain space. Inactive palms have w = 0 in their first vec4,
 * inactive capsules r = 0.
 *   palm[h*12 + 0..3]  = centre.xyz, active (0/1)
 *   palm[h*12 + 4..7]  = normal.xyz (unit, n.y ≥ 0), along semi-axis
 *   palm[h*12 + 8..11] = along axis.xyz (unit), across semi-axis
 *   cap[(h*6 + c)*8 + 0..3] = a.xyz, r
 *   cap[(h*6 + c)*8 + 4..7] = b.xyz, 0
 */
export interface HandField {
  readonly palm: Float32Array;
  readonly cap: Float32Array;
  /** Per hand: anything active this frame. */
  readonly active: [boolean, boolean];
}

export function createHandField(): HandField {
  return { palm: new Float32Array(PALM_FLOATS), cap: new Float32Array(CAP_FLOATS), active: [false, false] };
}

// Scratch (module-level: no per-frame garbage).
const J = new Float32Array(25 * 3);
const tmp = { x: 0, y: 0, z: 0 };

/** World → box local → rain space, in place on J (25 joints). */
function jointsToRain(src: Float32Array, box: Readonly<BoxFrame>, slant: Readonly<RainSlant>): void {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  const inv = box.scale > 1e-6 ? 1 / box.scale : 1;
  for (let j = 0; j < 25; j++) {
    const dx = src[j * 3] - box.position.x;
    const dy = src[j * 3 + 1] - box.position.y;
    const dz = src[j * 3 + 2] - box.position.z;
    // Inverse yaw about +Y.
    const x = (c * dx - s * dz) * inv;
    const y = dy * inv;
    const z = (s * dx + c * dz) * inv;
    J[j * 3] = x + slant.kx * (y - slant.floorY);
    J[j * 3 + 1] = y;
    J[j * 3 + 2] = z + slant.kz * (y - slant.floorY);
  }
}

const jx = (j: number) => J[j * 3];
const jy = (j: number) => J[j * 3 + 1];
const jz = (j: number) => J[j * 3 + 2];

function clearHand(f: HandField, h: number): void {
  f.palm.fill(0, h * 12, h * 12 + 12);
  f.cap.fill(0, h * CAPS_PER_HAND * 8, (h + 1) * CAPS_PER_HAND * 8);
  f.active[h] = false;
}

function writeCap(f: HandField, h: number, c: number, a: Vec3, b: Vec3, r: number): void {
  const o = (h * CAPS_PER_HAND + c) * 8;
  f.cap[o] = a.x;
  f.cap[o + 1] = a.y;
  f.cap[o + 2] = a.z;
  f.cap[o + 3] = r;
  f.cap[o + 4] = b.x;
  f.cap[o + 5] = b.y;
  f.cap[o + 6] = b.z;
  f.cap[o + 7] = 0;
}

const A: Vec3 = { x: 0, y: 0, z: 0 };
const B: Vec3 = { x: 0, y: 0, z: 0 };

/** Fills hand `h` (0 left, 1 right) of the field from a HandSample. */
export function updateHandField(
  f: HandField,
  h: 0 | 1,
  s: Readonly<HandSample>,
  box: Readonly<BoxFrame>,
  slant: Readonly<RainSlant>,
): void {
  if (!s.tracked || !s.jointsValid || s.device !== 'hand') {
    clearHand(f, h);
    return;
  }
  jointsToRain(s.joints, box, slant);
  const span = Math.hypot(jx(MIDDLE_MCP) - jx(WRIST), jy(MIDDLE_MCP) - jy(WRIST), jz(MIDDLE_MCP) - jz(WRIST));
  const k = Math.min(HAND_FIELD.kMax, Math.max(HAND_FIELD.kMin, span / 0.09));

  // Palm: along = wrist → middle MCP; across = little MCP → index MCP; n = along × across, flipped up.
  let ax = jx(MIDDLE_MCP) - jx(WRIST);
  let ay = jy(MIDDLE_MCP) - jy(WRIST);
  let az = jz(MIDDLE_MCP) - jz(WRIST);
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al;
  ay /= al;
  az /= al;
  const cx0 = jx(INDEX_MCP) - jx(LITTLE_MCP);
  const cy0 = jy(INDEX_MCP) - jy(LITTLE_MCP);
  const cz0 = jz(INDEX_MCP) - jz(LITTLE_MCP);
  let nx = ay * cz0 - az * cy0;
  let ny = az * cx0 - ax * cz0;
  let nz = ax * cy0 - ay * cx0;
  const nl = Math.hypot(nx, ny, nz);
  const o = h * 12;
  if (nl > 1e-6) {
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // Palm centre: halfway along the metacarpals, between the four MCPs and the wrist.
    const cx = (jx(WRIST) + jx(INDEX_MCP) + jx(MIDDLE_MCP) + jx(16) + jx(LITTLE_MCP)) / 5;
    const cy = (jy(WRIST) + jy(INDEX_MCP) + jy(MIDDLE_MCP) + jy(16) + jy(LITTLE_MCP)) / 5;
    const cz = (jz(WRIST) + jz(INDEX_MCP) + jz(MIDDLE_MCP) + jz(16) + jz(LITTLE_MCP)) / 5;
    // The dorsal side is whichever side faces up for a palm-down hand; the rain only
    // needs the slab, so push it towards +n·sign(n.y) (up) and keep n.y ≥ 0.
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const d = HAND_FIELD.palmDorsalM * k;
    f.palm[o] = cx + nx * d;
    f.palm[o + 1] = cy + ny * d;
    f.palm[o + 2] = cz + nz * d;
    f.palm[o + 3] = ny >= HAND_FIELD.minSlabNy ? 1 : 0;
    f.palm[o + 4] = nx;
    f.palm[o + 5] = ny;
    f.palm[o + 6] = nz;
    f.palm[o + 7] = HAND_FIELD.palmAlongM * k;
    f.palm[o + 8] = ax;
    f.palm[o + 9] = ay;
    f.palm[o + 10] = az;
    f.palm[o + 11] = HAND_FIELD.palmAcrossM * k;
  } else f.palm.fill(0, o, o + 12);

  const r = HAND_FIELD.fingerR * k;
  for (let c = 0; c < FINGERS.length; c++) {
    const [a, b] = FINGERS[c];
    A.x = jx(a);
    A.y = jy(a);
    A.z = jz(a);
    B.x = jx(b);
    B.y = jy(b);
    B.z = jz(b);
    writeCap(f, h, c, A, B, r);
  }
  // Forearm: from the wrist, away from the fingers.
  A.x = jx(WRIST);
  A.y = jy(WRIST);
  A.z = jz(WRIST);
  B.x = A.x - ax * HAND_FIELD.forearmLenM;
  B.y = A.y - ay * HAND_FIELD.forearmLenM;
  B.z = A.z - az * HAND_FIELD.forearmLenM;
  writeCap(f, h, FINGERS.length, A, B, HAND_FIELD.forearmR);
  f.active[h] = true;
}

/** Handedness → field slot. */
export const handSlot = (h: Handedness): 0 | 1 => (h === 'left' ? 0 : 1);

/**
 * Highest point where a vertical (rain space) line at (u, w) meets the field,
 * or −Infinity. Mirrors rainBlockY() in render/glsl/rain.ts exactly.
 */
export function blockY(f: Readonly<HandField>, u: number, w: number): number {
  let top = -Infinity;
  for (let h = 0; h < 2; h++) {
    if (!f.active[h]) continue;
    const yp = palmTopY(f, h, u, w);
    if (yp > top) top = yp;
    for (let c = 0; c < CAPS_PER_HAND; c++) {
      const q = (h * CAPS_PER_HAND + c) * 8;
      const r = f.cap[q + 3];
      if (!(r > 0)) continue;
      const y = capsuleTopY(f.cap, q, u, w);
      if (y > top) top = y;
    }
  }
  return top;
}

/** Top of the capsule at cap[q..q+7] above (u, w), or −Infinity. Mirrors the GLSL. */
export function capsuleTopY(cap: Float32Array, q: number, u: number, w: number): number {
  const ax = cap[q];
  const ay = cap[q + 1];
  const az = cap[q + 2];
  const r = cap[q + 3];
  const ex = cap[q + 4] - ax;
  const ey = cap[q + 5] - ay;
  const ez = cap[q + 6] - az;
  const l2 = ex * ex + ez * ez;
  const t = l2 > 1e-10 ? Math.min(1, Math.max(0, ((u - ax) * ex + (w - az) * ez) / l2)) : 0;
  const px = ax + ex * t;
  const pz = az + ez * t;
  const d2 = (u - px) * (u - px) + (w - pz) * (w - pz);
  if (d2 >= r * r) return -Infinity;
  return ay + ey * t + Math.sqrt(r * r - d2);
}

/** Top of hand h's palm slab above (u, w), or −Infinity. Mirrors the GLSL. */
export function palmTopY(f: Readonly<HandField>, h: number, u: number, w: number): number {
  const o = h * 12;
  if (!(f.palm[o + 3] > 0.5)) return -Infinity;
  const cx = f.palm[o];
  const cy = f.palm[o + 1];
  const cz = f.palm[o + 2];
  const nx = f.palm[o + 4];
  const ny = f.palm[o + 5];
  const nz = f.palm[o + 6];
  const y = cy - (nx * (u - cx) + nz * (w - cz)) / ny;
  const dx = u - cx;
  const dy = y - cy;
  const dz = w - cz;
  const along = dx * f.palm[o + 8] + dy * f.palm[o + 9] + dz * f.palm[o + 10];
  // across axis = n × along
  const bx = ny * f.palm[o + 10] - nz * f.palm[o + 9];
  const by = nz * f.palm[o + 8] - nx * f.palm[o + 10];
  const bz = nx * f.palm[o + 9] - ny * f.palm[o + 8];
  const across = dx * bx + dy * by + dz * bz;
  const ea = along / f.palm[o + 7];
  const eb = across / f.palm[o + 11];
  return ea * ea + eb * eb <= 1 ? y : -Infinity;
}

/**
 * Marks in `mask` (1 byte per texel of a cols × rows grid starting at
 * (u0, w0), `texel` m) every texel whose vertical line the field blocks above
 * `tableY`. Each primitive only visits its own bounding box, so a whole hand
 * costs a few thousand tests. Returns the number of marked texels.
 */
export function rasterizeCover(
  f: Readonly<HandField>,
  tableY: number,
  mask: Uint8Array,
  cols: number,
  rows: number,
  u0: number,
  w0: number,
  texel: number,
): number {
  let marked = 0;
  for (let h = 0; h < 2; h++) {
    if (!f.active[h]) continue;
    // Primitive p = −1 is the palm slab, 0..CAPS_PER_HAND−1 the capsules (no closures: 15 Hz).
    for (let p = -1; p < CAPS_PER_HAND; p++) {
      let a0: number;
      let b0: number;
      let a1: number;
      let b1: number;
      const q = (h * CAPS_PER_HAND + p) * 8;
      if (p < 0) {
        const o = h * 12;
        if (!(f.palm[o + 3] > 0.5)) continue;
        const e = Math.max(f.palm[o + 7], f.palm[o + 11]) / Math.max(f.palm[o + 5], HAND_FIELD.minSlabNy);
        a0 = f.palm[o] - e;
        a1 = f.palm[o] + e;
        b0 = f.palm[o + 2] - e;
        b1 = f.palm[o + 2] + e;
      } else {
        const r = f.cap[q + 3];
        if (!(r > 0)) continue;
        a0 = Math.min(f.cap[q], f.cap[q + 4]) - r;
        a1 = Math.max(f.cap[q], f.cap[q + 4]) + r;
        b0 = Math.min(f.cap[q + 2], f.cap[q + 6]) - r;
        b1 = Math.max(f.cap[q + 2], f.cap[q + 6]) + r;
      }
      const i0 = Math.max(0, Math.floor((a0 - u0) / texel));
      const i1 = Math.min(cols - 1, Math.floor((a1 - u0) / texel));
      const j0 = Math.max(0, Math.floor((b0 - w0) / texel));
      const j1 = Math.min(rows - 1, Math.floor((b1 - w0) / texel));
      for (let j = j0; j <= j1; j++) {
        const w = w0 + (j + 0.5) * texel;
        for (let i = i0; i <= i1; i++) {
          const k = j * cols + i;
          if (mask[k]) continue;
          const u = u0 + (i + 0.5) * texel;
          const y = p < 0 ? palmTopY(f, h, u, w) : capsuleTopY(f.cap, q, u, w);
          if (y > tableY) {
            mask[k] = 1;
            marked++;
          }
        }
      }
    }
  }
  return marked;
}

/** Rain-space (u, w) bounds of the whole field: [uMin, wMin, uMax, wMax]; empty → uMin > uMax. */
export function fieldBounds(f: Readonly<HandField>, out: Float32Array | number[]): void {
  let u0 = Infinity;
  let w0 = Infinity;
  let u1 = -Infinity;
  let w1 = -Infinity;
  for (let h = 0; h < 2; h++) {
    if (!f.active[h]) continue;
    const o = h * 12;
    if (f.palm[o + 3] > 0.5) {
      // The slab's projection never leaves a circle of its larger semi-axis.
      const e = Math.max(f.palm[o + 7], f.palm[o + 11]) / Math.max(f.palm[o + 5], HAND_FIELD.minSlabNy);
      u0 = Math.min(u0, f.palm[o] - e);
      u1 = Math.max(u1, f.palm[o] + e);
      w0 = Math.min(w0, f.palm[o + 2] - e);
      w1 = Math.max(w1, f.palm[o + 2] + e);
    }
    for (let c = 0; c < CAPS_PER_HAND; c++) {
      const q = (h * CAPS_PER_HAND + c) * 8;
      const r = f.cap[q + 3];
      if (!(r > 0)) continue;
      u0 = Math.min(u0, f.cap[q] - r, f.cap[q + 4] - r);
      u1 = Math.max(u1, f.cap[q] + r, f.cap[q + 4] + r);
      w0 = Math.min(w0, f.cap[q + 2] - r, f.cap[q + 6] - r);
      w1 = Math.max(w1, f.cap[q + 2] + r, f.cap[q + 6] + r);
    }
  }
  out[0] = u0;
  out[1] = w0;
  out[2] = u1;
  out[3] = w1;
}

/** Rain-space point for a box-local point (helpers for tests and the kite). */
export function toRain(p: Readonly<Vec3>, slant: Readonly<RainSlant>, out: Vec3 = tmp): Vec3 {
  out.x = p.x + slant.kx * (p.y - slant.floorY);
  out.y = p.y;
  out.z = p.z + slant.kz * (p.y - slant.floorY);
  return out;
}
