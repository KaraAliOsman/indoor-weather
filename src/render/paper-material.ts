import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  ShaderMaterial,
  Vector3,
  type IUniform,
} from '@iwsdk/core';
import type { QualityLevel } from '../core/types.ts';
import { NOISE_CHUNK } from './glsl/noise.ts';
import { PAPER_CHUNK, PAPER_FRAG, PAPER_VERT } from './glsl/paper.ts';

/**
 * Paper material v1 (box, tab, seals) and the geometry builder that feeds it.
 *
 * A plain ShaderMaterial (three injects the matrices, so it works with
 * multiview), no textures and no scene lights: one key light fixed to the
 * box (setPaperKeyYaw), procedural fibres/grain (fbm octaves = PAPER_OCTAVES define) and
 * 6 riso inks selected per vertex by the `aInk` attribute.
 *
 * Programs compiled outside XR are not reused in XR (multiview is part of
 * the program key): WindSystem precompiles them with compileAsync inside the
 * first XR frame, while the box is still hidden.
 */

export type Inks = readonly [number, number, number, number, number, number];

/**
 * Riso inks (direccion/arte.md §2, sRGB hex): paper, board (cut edges), blue,
 * fluorescent pink (ONLY what you pinch), yellow, ink (key lines, never pure black).
 */
export const ALMANAC_INKS: Inks = [0xf2ebdd, 0xc9a46a, 0x0078bf, 0xff48b0, 0xffe800, 0x1a1a1a];

/** Index of each ink in uInks / the aInk attribute. */
export const INK = { paper: 0, board: 1, blue: 2, pink: 3, yellow: 4, ink: 5 } as const;

export type Octaves = 1 | 2 | 3;

export function inkColors(inks: Inks): Color[] {
  // Color(hex) converts sRGB to the linear working space; the shader ends with colorspace_fragment.
  return inks.map((hex) => new Color(hex));
}

/**
 * Uniforms shared by every paper material (same objects, so one write
 * affects the box, the tab and the leaves): inks, key light, grain amount and
 * the M2 high-contrast switch.
 */
/** Key light in box space (+Z towards the user): high, from the user's left and front. */
const KEY_LOCAL = new Vector3(-0.35, 0.85, 0.4).normalize();

/**
 * Turns the key light with the box (yaw about +Y), so the front panel is lit
 * the same whatever way the user faced when the session started.
 */
export function setPaperKeyYaw(yaw: number): void {
  if (!Number.isFinite(yaw)) return;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  paperShared.uKeyDir.value.set(KEY_LOCAL.x * c + KEY_LOCAL.z * s, KEY_LOCAL.y, -KEY_LOCAL.x * s + KEY_LOCAL.z * c);
}

export const paperShared: {
  readonly uInks: IUniform<Color[]>;
  readonly uKeyDir: IUniform<Vector3>;
  readonly uGrain: IUniform<number>;
  readonly uContrast: IUniform<number>;
} = {
  uInks: { value: inkColors(ALMANAC_INKS) },
  // World space, towards the light. Set from KEY_LOCAL by setPaperKeyYaw at placement.
  uKeyDir: { value: KEY_LOCAL.clone() },
  uGrain: { value: 1 },
  uContrast: { value: 0 },
};

export interface PaperMaterialOptions {
  /** Own inks for this material; omitted = the shared almanac inks. */
  inks?: Inks;
  /** fbm octaves (PAPER_OCTAVES define), default 2. */
  octaves?: Octaves;
  /** Apply instanceMatrix (InstancedMesh with per-instance transforms). */
  instanced?: boolean;
}

/**
 * Uniforms: uInks (Color[6]), uTime, uGrain, uKeyDir (vec3 world),
 * uContrast, uHighlight (grab affordance, 0..1), uWet (soaked paper, 0..1).
 * Attribute: aInk (0..5).
 */
export function createPaperMaterial(o: PaperMaterialOptions = {}): ShaderMaterial {
  const defines: Record<string, number | string> = { PAPER_OCTAVES: o.octaves ?? 2 };
  if (o.instanced) defines.PAPER_INSTANCED = '';
  return new ShaderMaterial({
    name: 'paper',
    uniforms: {
      uInks: o.inks ? { value: inkColors(o.inks) } : paperShared.uInks,
      uKeyDir: paperShared.uKeyDir,
      uGrain: paperShared.uGrain,
      uContrast: paperShared.uContrast,
      uTime: { value: 0 },
      uHighlight: { value: 0 },
      uWet: { value: 0 },
    },
    defines,
    vertexShader: PAPER_VERT,
    fragmentShader: NOISE_CHUNK + PAPER_CHUNK + PAPER_FRAG,
  });
}

/** Governor lever (M3): L0 = 3 octaves, L1 = 2, L2 = 1. */
export function octavesForQuality(level: QualityLevel): Octaves {
  return level === 0 ? 3 : level === 1 ? 2 : 1;
}

/** Changes the fbm octave count. Recompiles the program, so call it rarely. */
export function setPaperOctaves(material: ShaderMaterial, octaves: Octaves): void {
  if (material.defines.PAPER_OCTAVES === octaves) return;
  material.defines.PAPER_OCTAVES = octaves;
  material.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Geometry builder (position, normal, aInk). Build-time only: allocates freely.

export type V3 = readonly [number, number, number];

/** Inks per box face; null skips the face. */
export interface BoxInks {
  px: number | null;
  nx: number | null;
  py: number | null;
  ny: number | null;
  pz: number | null;
  nz: number | null;
}

export interface PaperBuilder {
  /** Parallelogram o, o+u, o+u+v, o+v; front side and normal = unit(u × v). */
  face(o: V3, u: V3, v: V3, ink: number): void;
  /** Triangle a, b, c (counter-clockwise seen from the front); normal = unit((b − a) × (c − a)). */
  tri(a: V3, b: V3, c: V3, ink: number): void;
  /** Adds a finished geometry (position + normal, indexed or not) in one ink. */
  mesh(g: BufferGeometry, ink: number | ((nx: number, ny: number, nz: number, y: number) => number)): void;
  /** Rectangle centred at c in the plane of unit axes u, v (normal u × v), half sizes hu, hv. */
  rect(c: V3, u: V3, v: V3, hu: number, hv: number, ink: number): void;
  /** Filled disc in the plane of unit axes u, v; `wobble` scallops the edge (wax seal). */
  disc(c: V3, u: V3, v: V3, r: number, ink: number, segments?: number, wobble?: number): void;
  /** Annulus r0..r1 in the plane of unit axes u, v. */
  ring(c: V3, u: V3, v: V3, r0: number, r1: number, ink: number, segments?: number): void;
  /** Straight printed line a→b lying in the plane with unit normal n. */
  stroke(a: V3, b: V3, n: V3, halfWidth: number, ink: number): void;
  /** Axis-aligned box with outward normals. */
  box(min: V3, max: V3, inks: BoxInks): void;
  readonly vertexCount: number;
  build(): BufferGeometry;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  if (l < 1e-12) throw new Error('[paper] degenerate vector');
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function createPaperBuilder(): PaperBuilder {
  const pos: number[] = [];
  const nor: number[] = [];
  const ink: number[] = [];
  const idx: number[] = [];

  const vert = (p: V3, n: V3, k: number): number => {
    pos.push(p[0], p[1], p[2]);
    nor.push(n[0], n[1], n[2]);
    ink.push(k);
    return ink.length - 1;
  };

  const builder: PaperBuilder = {
    face(o, u, v, k) {
      const n = unit(cross(u, v));
      const i = vert(o, n, k);
      vert(add(o, u), n, k);
      vert(add(add(o, u), v), n, k);
      vert(add(o, v), n, k);
      idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    },

    tri(a, b, c, k) {
      const n = unit(cross(sub(b, a), sub(c, a)));
      const i = vert(a, n, k);
      vert(b, n, k);
      vert(c, n, k);
      idx.push(i, i + 1, i + 2);
    },

    mesh(g, k) {
      const p = g.getAttribute('position');
      const nr = g.getAttribute('normal');
      const base = ink.length;
      for (let i = 0; i < p.count; i++) {
        const nx = nr.getX(i);
        const ny = nr.getY(i);
        const nz = nr.getZ(i);
        vert([p.getX(i), p.getY(i), p.getZ(i)], [nx, ny, nz], typeof k === 'number' ? k : k(nx, ny, nz, p.getY(i)));
      }
      const index = g.getIndex();
      if (index) for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
      else for (let i = 0; i < p.count; i++) idx.push(base + i);
    },

    rect(c, u, v, hu, hv, k) {
      const o = sub(sub(c, mul(u, hu)), mul(v, hv));
      builder.face(o, mul(u, 2 * hu), mul(v, 2 * hv), k);
    },

    disc(c, u, v, r, k, segments = 24, wobble = 0) {
      const n = unit(cross(u, v));
      const ic = vert(c, n, k);
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const rr = r * (1 + wobble * Math.sin(a * 7));
        vert(add(c, add(mul(u, Math.cos(a) * rr), mul(v, Math.sin(a) * rr))), n, k);
      }
      for (let s = 0; s < segments; s++) idx.push(ic, ic + 1 + s, ic + 1 + ((s + 1) % segments));
    },

    ring(c, u, v, r0, r1, k, segments = 24) {
      const n = unit(cross(u, v));
      const first = ink.length;
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        const d = add(mul(u, Math.cos(a)), mul(v, Math.sin(a)));
        vert(add(c, mul(d, r0)), n, k);
        vert(add(c, mul(d, r1)), n, k);
      }
      for (let s = 0; s < segments; s++) {
        const i0 = first + 2 * s;
        const i1 = first + 2 * ((s + 1) % segments);
        // inner_s, outer_s, outer_s+1, inner_s+1: counter-clockwise around n.
        idx.push(i0, i0 + 1, i1 + 1, i0, i1 + 1, i1);
      }
    },

    stroke(a, b, n, halfWidth, k) {
      const along = sub(b, a);
      const perp = unit(cross(n, unit(along)));
      builder.face(sub(a, mul(perp, halfWidth)), along, mul(perp, 2 * halfWidth), k);
    },

    box(min, max, inks) {
      const [x0, y0, z0] = min;
      const [x1, y1, z1] = max;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const dz = z1 - z0;
      // Each (o, u, v) is chosen so that u × v is the outward normal.
      if (inks.px !== null) builder.face([x1, y0, z1], [0, 0, -dz], [0, dy, 0], inks.px);
      if (inks.nx !== null) builder.face([x0, y0, z0], [0, 0, dz], [0, dy, 0], inks.nx);
      if (inks.py !== null) builder.face([x0, y1, z1], [dx, 0, 0], [0, 0, -dz], inks.py);
      if (inks.ny !== null) builder.face([x0, y0, z0], [dx, 0, 0], [0, 0, dz], inks.ny);
      if (inks.pz !== null) builder.face([x0, y0, z1], [dx, 0, 0], [0, dy, 0], inks.pz);
      if (inks.nz !== null) builder.face([x1, y0, z0], [-dx, 0, 0], [0, dy, 0], inks.nz);
    },

    get vertexCount() {
      return ink.length;
    },

    build() {
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
      g.setAttribute('aInk', new Float32BufferAttribute(ink, 1));
      g.setIndex(idx);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      return g;
    },
  };
  return builder;
}
