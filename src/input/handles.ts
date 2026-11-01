/**
 * Registry of grabbable controls (one per actuation target). PURE module.
 *
 * Mechanisms (C) register their HandleSpec once and keep it updated every
 * frame; the arbiter (A) only reads. Registration is rare, so the list is
 * copy-on-write: arrays returned by all() stay valid while iterating.
 */
import type { ActuationTarget, HandleRegistry, HandleSpec, Vec3 } from '../core/types.ts';

export function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function createHandleRegistry(): HandleRegistry {
  let list: readonly HandleSpec[] = [];

  return {
    register(handle) {
      if (list.some((h) => h.target === handle.target)) {
        throw new Error(`[handles] a handle for '${handle.target}' is already registered`);
      }
      list = [...list, handle];
      return () => {
        list = list.filter((h) => h !== handle);
      };
    },

    nearest(p, accept) {
      let best: HandleSpec | null = null;
      let bestD = Infinity;
      for (let i = 0; i < list.length; i++) {
        const h = list[i];
        if (!h.enabled) continue;
        const d = distance(p, h.grabPoint);
        if (d <= h.grabRadius && d < bestD && (!accept || accept(h))) {
          best = h;
          bestD = d;
        }
      }
      return best;
    },

    get(target: ActuationTarget) {
      for (let i = 0; i < list.length; i++) if (list[i].target === target) return list[i];
      return null;
    },

    all() {
      return list;
    },
  };
}
