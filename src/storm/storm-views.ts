import {
  BoxGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Mesh,
  Vector3,
  type BufferGeometry,
  type Object3D,
  type ShaderMaterial,
} from '@iwsdk/core';
import { createPaperBuilder, createPaperMaterial, INK, type Inks, type V3 } from '../render/paper-material';

/**
 * Storm views (direccion/canon.md §2, §7): the folded-paper cloud with its
 * pink tag on a thread, and the paper kite resting on the table. Paper
 * material (riso inks, fixed key light, band-limited grain); 4 draw calls.
 * They only draw; StormSystem moves them.
 */

/** Cloud inks: paper on top, a blue-washed paper underneath (vertex ink blends between them). */
const CLOUD_INKS: Inks = [0xf2ebdd, 0x85b7cf, 0x0078bf, 0xff48b0, 0xffe800, 0x1a1a1a];
/** Cloud size (m, x × y × z) at scale 1. */
export const CLOUD_SIZE = [0.32, 0.1, 0.12] as const;
/** Flat underside, cloud local (m). */
const CLOUD_BASE_Y = -0.03;

/** Puffs: centre (x, y, z) and radii (x, y, z), cloud local (m). */
const PUFFS: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-0.115, -0.004, 0.0, 0.048, 0.034, 0.046],
  [-0.055, 0.014, 0.008, 0.064, 0.05, 0.058],
  [0.018, 0.022, -0.004, 0.074, 0.056, 0.062],
  [0.088, 0.01, 0.01, 0.06, 0.046, 0.054],
  [0.132, -0.006, 0.0, 0.038, 0.03, 0.042],
  [-0.012, -0.002, 0.034, 0.058, 0.036, 0.032],
  [0.046, -0.002, -0.034, 0.058, 0.036, 0.032],
];

/** Faceted (flat-normal) puff: folded paper, not a smooth blob. */
function puffGeometry(p: (typeof PUFFS)[number]): BufferGeometry {
  const g = new IcosahedronGeometry(1, 1).toNonIndexed();
  g.scale(p[3], p[4], p[5]);
  g.translate(p[0], p[1], p[2]);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < CLOUD_BASE_Y) pos.setY(i, CLOUD_BASE_Y);
  g.computeVertexNormals();
  return g;
}

function buildCloudGeometry(): BufferGeometry {
  const b = createPaperBuilder();
  for (const p of PUFFS) {
    const g = puffGeometry(p);
    // Underside and lower flanks in the washed blue: the cloud reads as heavy with rain.
    b.mesh(g, (_nx, ny, _nz, y) => (ny < -0.35 || y < CLOUD_BASE_Y + 0.012 ? 1 : 0));
    g.dispose();
  }
  return b.build();
}

/** Tag: 24 × 16 mm pink card (both sides), ink key line, a blue cloud glyph; origin at its top centre. */
function buildTagGeometry(): BufferGeometry {
  const b = createPaperBuilder();
  const w = 0.012;
  const h = 0.016;
  const t = 0.0006;
  b.box([-w, -h, -t], [w, 0, t], { px: INK.board, nx: INK.board, py: INK.board, ny: INK.board, pz: INK.pink, nz: INK.pink });
  for (const side of [1, -1] as const) {
    const z = side * (t + 0.0003);
    const u: V3 = [side, 0, 0];
    const v: V3 = [0, 1, 0];
    const k = 0.0007;
    b.rect([0, -k, z], u, v, w, k, INK.ink);
    b.rect([0, -h + k, z], u, v, w, k, INK.ink);
    b.rect([w - k, -h / 2, z], u, v, k, h / 2, INK.ink);
    b.rect([-w + k, -h / 2, z], u, v, k, h / 2, INK.ink);
    for (const [dx, dy, r] of [[-0.004, -0.009, 0.0028], [0, -0.008, 0.0036], [0.004, -0.009, 0.0028]] as const) {
      b.disc([dx, dy, z + side * 0.0002], u, v, r, INK.blue, 16);
    }
  }
  return b.build();
}

export interface CloudView {
  /** Cloud body (scale and position set by the system; box frame). */
  readonly cloud: Group;
  /** Tag, top centre at its origin (box frame). */
  readonly tag: Mesh;
  /** Thread: unit-height ink strip, scaled between two points by setThread. */
  readonly thread: Mesh;
  setThread(x: number, y0: number, y1: number, z: number): void;
  setHighlight(v: number): void;
  setWet(v: number): void;
  readonly materials: readonly ShaderMaterial[];
  dispose(): void;
}

export function createCloudView(parent: Object3D): CloudView {
  const cloudMaterial = createPaperMaterial({ inks: CLOUD_INKS, octaves: 2 });
  const tagMaterial = createPaperMaterial({ octaves: 2 });
  const cloud = new Group();
  cloud.name = 'storm-cloud';
  const body = new Mesh(buildCloudGeometry(), cloudMaterial);
  body.name = 'storm-cloud-paper';
  cloud.add(body);
  cloud.visible = false;
  parent.add(cloud);

  const tag = new Mesh(buildTagGeometry(), tagMaterial);
  tag.name = 'storm-tag';
  parent.add(tag);

  const threadGeometry = new BoxGeometry(0.0008, 1, 0.0008);
  threadGeometry.translate(0, 0.5, 0);
  const inks = new Float32Array(threadGeometry.getAttribute('position').count).fill(INK.ink);
  threadGeometry.setAttribute('aInk', new Float32BufferAttribute(inks, 1));
  const thread = new Mesh(threadGeometry, tagMaterial);
  thread.name = 'storm-thread';
  parent.add(thread);

  return {
    cloud,
    tag,
    thread,
    setThread(x, y0, y1, z) {
      const lo = Math.min(y0, y1);
      const len = Math.max(Math.abs(y1 - y0), 1e-4);
      thread.position.set(x, lo, z);
      thread.scale.set(1, len, 1);
    },
    setHighlight(v) {
      tagMaterial.uniforms.uHighlight.value = v;
    },
    setWet(v) {
      cloudMaterial.uniforms.uWet.value = v;
    },
    materials: [cloudMaterial, tagMaterial],
    dispose() {
      cloud.removeFromParent();
      tag.removeFromParent();
      thread.removeFromParent();
      body.geometry.dispose();
      tag.geometry.dispose();
      threadGeometry.dispose();
      cloudMaterial.dispose();
      tagMaterial.dispose();
    },
  };
}

/**
 * Kite (canon §7): 9 × 12 cm, nose towards −Z, yellow with blue panels and an
 * ink key line, flat on the table (origin at its centre, 2 mm above the wood).
 * Never pink: pink means "pinch me".
 */
function buildKiteGeometry(): BufferGeometry {
  const b = createPaperBuilder();
  const y = 0.0;
  const nose: V3 = [0, y, -0.065];
  const tail: V3 = [0, y, 0.055];
  const left: V3 = [-0.045, y, -0.025];
  const right: V3 = [0.045, y, -0.025];
  const c: V3 = [0, y, -0.025];
  // Four panels, alternating (seen from above: counter-clockwise for +Y normals).
  b.tri(c, nose, left, INK.yellow);
  b.tri(c, right, nose, INK.blue);
  b.tri(c, left, tail, INK.blue);
  b.tri(c, tail, right, INK.yellow);
  // Underside (paper) so a lifting edge never shows a hole.
  b.tri(nose, c, left, INK.paper);
  b.tri(right, c, nose, INK.paper);
  b.tri(left, c, tail, INK.paper);
  b.tri(tail, c, right, INK.paper);
  // Key lines: outline and spars (1.5 mm).
  const up: V3 = [0, 1, 0];
  const ly = y + 0.0004;
  const lift = (p: V3): V3 => [p[0], ly, p[2]];
  const hw = 0.00075;
  b.stroke(lift(nose), lift(left), up, hw, INK.ink);
  b.stroke(lift(left), lift(tail), up, hw, INK.ink);
  b.stroke(lift(tail), lift(right), up, hw, INK.ink);
  b.stroke(lift(right), lift(nose), up, hw, INK.ink);
  b.stroke(lift(nose), lift(tail), up, hw * 0.7, INK.ink);
  b.stroke(lift(left), lift(right), up, hw * 0.7, INK.ink);
  // Paper tail bows.
  for (let i = 0; i < 3; i++) {
    const z = 0.07 + i * 0.022;
    const x = (i % 2 ? 1 : -1) * 0.004;
    b.tri([x - 0.006, ly, z - 0.004], [x, ly, z], [x - 0.006, ly, z + 0.004], INK.blue);
    b.tri([x + 0.006, ly, z + 0.004], [x, ly, z], [x + 0.006, ly, z - 0.004], INK.blue);
    b.stroke([0, ly, z - 0.022], [x, ly, z], up, 0.0004, INK.ink);
  }
  return b.build();
}

export interface KiteView {
  readonly mesh: Mesh;
  readonly materials: readonly ShaderMaterial[];
  setWet(v: number): void;
  /** String from `ring` to the kite's tail end (parent frame); hidden when `on` is false. */
  setString(ring: Readonly<Vector3>, on: boolean): void;
  dispose(): void;
}

const UP = new Vector3(0, 1, 0);
const tail = new Vector3();
const dir = new Vector3();

/** The kite mesh moves under `parent` (the kite anchor); its string is an ink thread. */
export function createKiteView(parent: Object3D): KiteView {
  const material = createPaperMaterial({ octaves: 2 });
  const mesh = new Mesh(buildKiteGeometry(), material);
  mesh.name = 'kite';
  mesh.position.y = 0.002;
  parent.add(mesh);

  const stringGeometry = new BoxGeometry(0.0006, 1, 0.0006);
  stringGeometry.translate(0, 0.5, 0);
  const inks = new Float32Array(stringGeometry.getAttribute('position').count).fill(INK.ink);
  stringGeometry.setAttribute('aInk', new Float32BufferAttribute(inks, 1));
  const string = new Mesh(stringGeometry, material);
  string.name = 'kite-string';
  string.visible = false;
  parent.add(string);

  return {
    mesh,
    materials: [material],
    setWet(v) {
      material.uniforms.uWet.value = v;
    },
    setString(ring, on) {
      string.visible = on;
      if (!on) return;
      // Tail end of the kite (+Z in its own frame) in the parent frame.
      mesh.updateMatrix();
      tail.set(0, 0, 0.055).applyMatrix4(mesh.matrix);
      dir.subVectors(tail, ring);
      const len = Math.max(dir.length(), 1e-4);
      string.position.copy(ring);
      string.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
      string.scale.set(1, len, 1);
    },
    dispose() {
      mesh.removeFromParent();
      string.removeFromParent();
      mesh.geometry.dispose();
      stringGeometry.dispose();
      material.dispose();
    },
  };
}
