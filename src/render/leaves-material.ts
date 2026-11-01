import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  type IUniform,
} from '@iwsdk/core';
import type { Vec3 } from '../core/types.ts';
import { LEAVES_FRAG, LEAVES_VERT } from './glsl/leaves.ts';
import { NOISE_CHUNK } from './glsl/noise.ts';
import { PAPER_CHUNK } from './glsl/paper.ts';
import { inkColors, paperShared, type Inks, type Octaves, type V3 } from './paper-material';

/**
 * Wind leaves: one InstancedMesh draw for every leaf. The whole flight runs
 * in the vertex shader (render/glsl/leaves.ts) from per-instance seeds, so
 * the CPU only writes a handful of uniforms per frame.
 *
 * Instanced attributes: aSeed (vec4, U[0,1)), aGroup (float 0..groups-1,
 * interleaved i % groups so lowering mesh.count thins every gust evenly).
 * Uniforms: uGust (release time per group, -1 = still in the box), uTime,
 * uWindDir (box local XZ), uArea (half extents), uAreaCenter, uSlot, uLeafHalf
 * plus the shared paper uniforms (uInks, uKeyDir, uGrain, uContrast).
 */

/** Leaf half extents (m): 1.8 x 3.2 cm cardstock leaves, long axis along local +Z. */
export const LEAF_HALF_WIDTH = 0.009;
export const LEAF_HALF_LENGTH = 0.016;
/** Fold height of the leaf edges (m): a shallow V gives the leaf a crease to catch the light. */
const LEAF_FOLD = 0.0018;

export interface LeavesUniforms {
  readonly uTime: IUniform<number>;
  /** Release time (s, same clock as uTime) per group; -1 = still inside the box. */
  readonly uGust: IUniform<Vector4>;
  readonly uWindDir: IUniform<Vector2>;
  readonly uArea: IUniform<Vector2>;
  readonly uAreaCenter: IUniform<Vector2>;
  readonly uSlot: IUniform<Vector3>;
  readonly uLeafHalf: IUniform<Vector2>;
}

export interface LeavesMaterialOptions {
  /** Slot centre, box local (m). */
  slot: Readonly<Vec3>;
  /** Wind direction, box local XZ (normalised in the shader). */
  windDir: readonly [number, number];
  /** Centre of the landing area, box local XZ (m). */
  areaCenter: readonly [number, number];
  /** Half extents of the landing area (m). Leaves shrink away outside it. */
  areaHalf: readonly [number, number];
  octaves?: Octaves;
  inks?: Inks;
}

export function createLeavesMaterial(o: LeavesMaterialOptions): {
  material: ShaderMaterial;
  uniforms: LeavesUniforms;
} {
  const uniforms: LeavesUniforms = {
    uTime: { value: 0 },
    uGust: { value: new Vector4(-1, -1, -1, -1) },
    uWindDir: { value: new Vector2(o.windDir[0], o.windDir[1]) },
    uArea: { value: new Vector2(o.areaHalf[0], o.areaHalf[1]) },
    uAreaCenter: { value: new Vector2(o.areaCenter[0], o.areaCenter[1]) },
    uSlot: { value: new Vector3(o.slot.x, o.slot.y, o.slot.z) },
    uLeafHalf: { value: new Vector2(LEAF_HALF_WIDTH, LEAF_HALF_LENGTH) },
  };
  const material = new ShaderMaterial({
    name: 'paper-leaves',
    uniforms: {
      ...uniforms,
      uInks: o.inks ? { value: inkColors(o.inks) } : paperShared.uInks,
      uKeyDir: paperShared.uKeyDir,
      uGrain: paperShared.uGrain,
      uContrast: paperShared.uContrast,
    },
    defines: { PAPER_OCTAVES: o.octaves ?? 2 },
    vertexShader: LEAVES_VERT,
    fragmentShader: NOISE_CHUNK + PAPER_CHUNK + LEAVES_FRAG,
    side: DoubleSide,
  });
  return { material, uniforms };
}

/** mulberry32 (T. Ettinger, public domain): seeded PRNG so every run and screenshot gets the same leaves. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One folded paper leaf (flat facets, normals facing +Y) plus the instanced
 * attributes for `count` leaves. Buffers are allocated once at full size;
 * the governor only changes InstancedMesh.count.
 */
export function createLeafGeometry(count: number, groups: number, seed = 0x1eaf): BufferGeometry {
  const W = LEAF_HALF_WIDTH;
  const L = LEAF_HALF_LENGTH;
  const F = LEAF_FOLD;
  const base: V3 = [0, 0, -L];
  const m1: V3 = [0, 0, -0.3 * L];
  const m2: V3 = [0, 0, 0.35 * L];
  const tip: V3 = [0, 0, L];
  const outline = (sx: number): [V3, V3, V3] => [
    [sx * 0.7 * W, 0.7 * F, -0.55 * L],
    [sx * W, F, -0.05 * L],
    [sx * 0.55 * W, 0.8 * F, 0.6 * L],
  ];

  const pos: number[] = [];
  const nor: number[] = [];
  const tri = (a: V3, b: V3, c: V3): void => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    // Keep the front face (and its normal) on the +Y side.
    const flip = ny < 0;
    const s = (flip ? -1 : 1) / Math.hypot(nx, ny, nz);
    for (const p of flip ? [a, c, b] : [a, b, c]) {
      pos.push(p[0], p[1], p[2]);
      nor.push(nx * s, ny * s, nz * s);
    }
  };
  for (const sx of [-1, 1]) {
    const [lb, lm, lt] = outline(sx);
    tri(base, lb, m1);
    tri(lb, lm, m1);
    tri(m1, lm, m2);
    tri(lm, lt, m2);
    tri(m2, lt, tip);
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));

  const rand = mulberry32(seed);
  const seeds = new Float32Array(count * 4);
  const group = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 4; k++) seeds[i * 4 + k] = rand();
    group[i] = i % groups;
  }
  g.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
  g.setAttribute('aGroup', new InstancedBufferAttribute(group, 1));
  return g;
}

/** Instances i < count that belong to `group` (groups interleaved as i % groups). */
export function leavesInGroup(count: number, groups: number, group: number): number {
  if (group < 0 || group >= groups || count <= group) return 0;
  return Math.floor((count - 1 - group) / groups) + 1;
}
