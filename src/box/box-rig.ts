import { Group, Mesh, SphereGeometry, Vector3, type BufferGeometry, type ShaderMaterial } from '@iwsdk/core';
import type { BoxPose, BoxRootPort, QualityLevel, Qualityable, Vec3 } from '../core/types.ts';
import {
  createPaperBuilder,
  createPaperMaterial,
  INK,
  octavesForQuality,
  setPaperKeyYaw,
  setPaperOctaves,
  type PaperBuilder,
  type V3,
} from '../render/paper-material';

/**
 * The almanac box: one merged paper mesh (1 draw call) plus empty anchor
 * groups where each mechanism mounts its moving parts.
 *
 * Box local frame (docs/architecture-m1.md §2): origin at the bottom centre
 * (on the table), +Y up, +Z front face (towards the user), +X the user's right.
 * Body 0.26 x 0.056 x 0.18 m of board wrapped in riso paper; a lid with a
 * blue band, a board cut edge and a printed double rule closes it at 0.07 m.
 * Layout (direccion/canon.md §2): the Wind/Dawn tab slot on the front-left,
 * the cloud slot in the lid (the Storm tag rises out of it), the mini bulb
 * at the back-right corner of the lid. The kite rests on the table in front
 * of the box (its own view, anchored here).
 *
 * The root keeps matrixAutoUpdate = true: placement (B) moves it during the
 * settle, and anchors read their world pose through it. Everything below the
 * root is static and has matrixAutoUpdate = false.
 */

export interface BoxRig extends BoxRootPort, Qualityable {
  /** Hidden until placement commits. Add it with world.createTransformEntity(root). */
  readonly root: Group;
  readonly anchors: {
    readonly wind: Group;
    readonly storm: Group;
    readonly bulb: Group;
    readonly kite: Group;
  };
}

export const BOX_SIZE: Readonly<Vec3> = Object.freeze({ x: 0.26, y: 0.07, z: 0.18 });

/** Anchor positions, box local (m). Anchor axes are the box axes. */
export const BOX_ANCHORS = {
  /** Front face, left third: centre of the Wind slot. */
  wind: [-0.07, 0.035, 0.09],
  /** Lid: centre of the cloud slot (the Storm tag rises out of it). */
  storm: [0, 0.07, -0.01],
  /** Lid, back right: the mini bulb (top of its base). */
  bulb: [0.09, 0.078, -0.06],
  /** Table, in front of the box: the paper kite at rest. */
  kite: [0.1, 0.0, 0.16],
} as const satisfies Record<string, V3>;

const HX = BOX_SIZE.x / 2;
const HZ = BOX_SIZE.z / 2;
const H = BOX_SIZE.y;
/** Bottom of the lid band (top of the visible body walls). */
const LID_Y = 0.056;
/** Lid overhang on every side. */
const LID_O = 0.003;
/** Decal layers: printed ink sits slightly proud of its face (no z-fighting at arm's length). */
const D1 = 0.0004;
const D2 = 0.0008;
const D3 = 0.0012;

// Face frames: u = right, v = up as seen from outside; u × v = outward normal.
const X: V3 = [1, 0, 0];
const Y: V3 = [0, 1, 0];
const NX: V3 = [-1, 0, 0];
const Z: V3 = [0, 0, 1];
const NZ: V3 = [0, 0, -1];
const FRONT = { u: X, v: Y };
const BACK = { u: NX, v: Y };
const RIGHT = { u: NZ, v: Y };
const LEFT = { u: Z, v: Y };
const TOP = { u: X, v: NZ };

const Y_AXIS = new Vector3(0, 1, 0);

/** Rectangular frame of line width w just inside a hu x hv rectangle (no overlapping quads). */
function frame(b: PaperBuilder, c: V3, f: { u: V3; v: V3 }, hu: number, hv: number, w: number, ink: number): void {
  const at = (du: number, dv: number): V3 => [
    c[0] + f.u[0] * du + f.v[0] * dv,
    c[1] + f.u[1] * du + f.v[1] * dv,
    c[2] + f.u[2] * du + f.v[2] * dv,
  ];
  const h = w / 2;
  b.rect(at(0, hv - h), f.u, f.v, hu, h, ink);
  b.rect(at(0, -(hv - h)), f.u, f.v, hu, h, ink);
  b.rect(at(hu - h, 0), f.u, f.v, h, hv - w, ink);
  b.rect(at(-(hu - h), 0), f.u, f.v, h, hv - w, ink);
}

function buildBoxGeometry(): BufferGeometry {
  const b = createPaperBuilder();

  // Body: cream card over kraft board; the base board shows as a kraft strip.
  b.box([-HX, 0, -HZ], [HX, LID_Y, HZ], {
    px: INK.paper, nx: INK.paper, py: null, ny: INK.board, pz: INK.paper, nz: INK.paper,
  });
  const strip = 0.0035;
  b.rect([0, strip / 2, HZ + D1], FRONT.u, FRONT.v, HX, strip / 2, INK.board);
  b.rect([0, strip / 2, -HZ - D1], BACK.u, BACK.v, HX, strip / 2, INK.board);
  b.rect([HX + D1, strip / 2, 0], RIGHT.u, RIGHT.v, HZ, strip / 2, INK.board);
  b.rect([-HX - D1, strip / 2, 0], LEFT.u, LEFT.v, HZ, strip / 2, INK.board);

  // Lid: blue band, paper top, board underside and cut edge.
  const lx = HX + LID_O;
  const lz = HZ + LID_O;
  b.box([-lx, LID_Y, -lz], [lx, H, lz], {
    px: INK.blue, nx: INK.blue, py: INK.paper, ny: INK.board, pz: INK.blue, nz: INK.blue,
  });
  const edge = 0.002;
  const ey = LID_Y + edge / 2;
  b.rect([0, ey, lz + D1], FRONT.u, FRONT.v, lx, edge / 2, INK.board);
  b.rect([0, ey, -lz - D1], BACK.u, BACK.v, lx, edge / 2, INK.board);
  b.rect([lx + D1, ey, 0], RIGHT.u, RIGHT.v, lz, edge / 2, INK.board);
  b.rect([-lx - D1, ey, 0], LEFT.u, LEFT.v, lz, edge / 2, INK.board);

  // Lid top: printed double rule.
  frame(b, [0, H + D1, 0], TOP, lx - 0.01, lz - 0.01, 0.0016, INK.blue);
  frame(b, [0, H + D1, 0], TOP, lx - 0.0145, lz - 0.0145, 0.0008, INK.blue);

  // Cloud slot (lid): 40 x 8 mm, dark inside, with a die-cut key line 3 mm around it.
  const [sx, , sz] = BOX_ANCHORS.storm;
  b.rect([sx, H + D2, sz], TOP.u, TOP.v, 0.02, 0.004, INK.ink);
  frame(b, [sx, H + D1, sz], TOP, 0.023, 0.007, 0.0008, INK.board);
  // A small printed cloud glyph above the slot (−Z): three blue bumps.
  for (const [du, dz, r] of [[-0.009, -0.016, 0.005], [0, -0.018, 0.0065], [0.009, -0.016, 0.005]] as const) {
    b.disc([sx + du, H + D2, sz + dz], TOP.u, TOP.v, r, INK.blue, 20);
  }

  // Mini bulb: a board base (8 mm) and a yellow half dome (Ø16 mm), lit by the storm view.
  const [bx, by, bz] = BOX_ANCHORS.bulb;
  b.box([bx - 0.006, H, bz - 0.006], [bx + 0.006, by, bz + 0.006], {
    px: INK.board, nx: INK.board, py: INK.board, ny: null, pz: INK.board, nz: INK.board,
  });
  const dome = new SphereGeometry(0.008, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(bx, by, bz);
  b.mesh(dome, INK.yellow);
  dome.dispose();

  // Wind panel (front, left third): yellow label, blue frame, the slot the tab slides through.
  const [wx, wy] = BOX_ANCHORS.wind;
  b.rect([wx, wy, HZ + D1], FRONT.u, FRONT.v, 0.036, 0.016, INK.yellow);
  frame(b, [wx, wy, HZ + D2], FRONT, 0.034, 0.014, 0.0012, INK.blue);
  b.rect([wx, wy, HZ + D3], FRONT.u, FRONT.v, 0.025, 0.0035, INK.ink);

  // Front, right: chapter legend (wind, storm, dawn) and a printed rule.
  const legend = [INK.yellow, INK.blue, INK.board];
  for (let i = 0; i < legend.length; i++) {
    b.disc([0.03 + 0.03 * i, wy, HZ + D1], FRONT.u, FRONT.v, 0.006, legend[i], 20);
    b.ring([0.03 + 0.03 * i, wy, HZ + D2], FRONT.u, FRONT.v, 0.006, 0.0068, INK.ink, 20);
  }
  b.rect([0, 0.009, HZ + D1], FRONT.u, FRONT.v, HX - 0.01, 0.0005, INK.blue);

  return b.build();
}

export function createBoxRig(): BoxRig {
  const root = new Group();
  root.name = 'almanac-box';
  // Hidden until placement commits. Must be false before createTransformEntity
  // (IWSDK copies it into the Visibility component).
  root.visible = false;

  const material: ShaderMaterial = createPaperMaterial({ octaves: 2 });
  const mesh = new Mesh(buildBoxGeometry(), material);
  mesh.name = 'almanac-box-paper';
  mesh.matrixAutoUpdate = false;
  root.add(mesh);

  const anchor = (name: keyof typeof BOX_ANCHORS): Group => {
    const g = new Group();
    g.name = `anchor-${name}`;
    const [x, y, z] = BOX_ANCHORS[name];
    g.position.set(x, y, z);
    g.updateMatrix();
    g.matrixAutoUpdate = false;
    root.add(g);
    return g;
  };
  const anchors = { wind: anchor('wind'), storm: anchor('storm'), bulb: anchor('bulb'), kite: anchor('kite') };

  const pose: BoxPose = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  let scale = 1;
  let visible = false;

  return {
    root,
    anchors,
    size: BOX_SIZE,
    get pose() {
      return pose;
    },
    get scale() {
      return scale;
    },
    get visible() {
      return visible;
    },
    setPose(p: Readonly<BoxPose>, s: number) {
      const { x, y, z } = p.position;
      // Keep the last good pose on NaN/Infinity (no array: this runs every frame of the settle).
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && Number.isFinite(p.yaw) && Number.isFinite(s))) return;
      pose.position.x = x;
      pose.position.y = y;
      pose.position.z = z;
      pose.yaw = p.yaw;
      scale = s;
      // Read root.position/quaternion/scale at call time: IWSDK swaps them for
      // ECS-backed objects when the root becomes a transform entity.
      root.position.set(x, y, z);
      root.quaternion.setFromAxisAngle(Y_AXIS, p.yaw);
      root.scale.setScalar(s);
      setPaperKeyYaw(p.yaw);
    },
    setVisible(v: boolean) {
      visible = v;
      root.visible = v;
    },
    setQuality(level: QualityLevel) {
      setPaperOctaves(material, octavesForQuality(level));
    },
  };
}
