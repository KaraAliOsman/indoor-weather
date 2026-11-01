import { BufferAttribute, BufferGeometry, Color, Mesh, MeshBasicMaterial, type Object3D } from '@iwsdk/core';

/**
 * Placement reticle: a flat ink ring with a centre dot, one draw call.
 *
 * Built in its local XZ plane facing +Y, so EnvironmentRaycastSystem can
 * orient it straight from the hit normal (pose +Y). States:
 * - 'valid'   full ink: a pinch places the box here;
 * - 'invalid' grey: a surface was hit but rejected (floor, wall, too far...);
 * - 'hidden'.
 * Colours change through one material colour (no recompiles).
 */
export type ReticleState = 'hidden' | 'invalid' | 'valid';

export interface Reticle {
  readonly object: Object3D;
  readonly state: ReticleState;
  /**
   * Also re-applies `object.visible` when the state is unchanged:
   * EnvironmentRaycastSystem (priority -1) shows the object on every hit.
   */
  setState(s: ReticleState): void;
  dispose(): void;
}

const OUTER_R = 0.06;
const INNER_R = 0.048;
const DOT_R = 0.008;
const SEGMENTS = 48;
/** Clearance above the surface (m). */
const LIFT = 0.002;

const INK = new Color(0x2a2219);
const GREY = new Color(0x9b968d);

/** Ring (inner→outer band) plus a centre disc, both facing +Y. */
function buildGeometry(): BufferGeometry {
  const ringVerts = SEGMENTS * 2;
  const dotVerts = SEGMENTS + 1;
  const pos = new Float32Array((ringVerts + dotVerts) * 3);
  const idx = new Uint16Array(SEGMENTS * 6 + SEGMENTS * 3);
  const dot0 = ringVerts; // centre vertex of the disc
  pos.set([0, LIFT, 0], dot0 * 3);
  for (let i = 0; i < SEGMENTS; i++) {
    const a = (i / SEGMENTS) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pos.set([INNER_R * c, LIFT, INNER_R * s, OUTER_R * c, LIFT, OUTER_R * s], i * 6);
    pos.set([DOT_R * c, LIFT, DOT_R * s], (dot0 + 1 + i) * 3);
  }
  let k = 0;
  for (let i = 0; i < SEGMENTS; i++) {
    const j = (i + 1) % SEGMENTS;
    const in0 = i * 2, out0 = i * 2 + 1, in1 = j * 2, out1 = j * 2 + 1;
    // Counter-clockwise seen from +Y.
    idx[k++] = in0; idx[k++] = out1; idx[k++] = out0;
    idx[k++] = in0; idx[k++] = in1; idx[k++] = out1;
    idx[k++] = dot0; idx[k++] = dot0 + 1 + j; idx[k++] = dot0 + 1 + i;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(pos, 3));
  geometry.setIndex(new BufferAttribute(idx, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

export function createReticle(): Reticle {
  const material = new MeshBasicMaterial({ color: GREY });
  const mesh = new Mesh(buildGeometry(), material);
  mesh.name = 'placement-reticle';
  mesh.visible = false;
  let state: ReticleState = 'hidden';

  return {
    object: mesh,
    get state() {
      return state;
    },
    setState(s) {
      const show = s !== 'hidden';
      if (mesh.visible !== show) mesh.visible = show;
      if (s === state) return;
      state = s;
      if (s === 'valid') material.color.copy(INK);
      else if (s === 'invalid') material.color.copy(GREY);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
