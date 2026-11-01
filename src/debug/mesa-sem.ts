/**
 * MesaSEM: a minimal IWER Synthetic Environment Module with one table.
 *
 * IWER 2.5.0 only emulates hit-test through a SEM (without one,
 * requestHitTestSource rejects with OperationError). This one answers every
 * hit-test ray with a horizontal table rectangle at `tableY` and, optionally,
 * the floor (y = 0). No environment rendering, planes or meshes.
 *
 * Used by the E2E fixture (`page.addInitScript(installMesaSem, cfg)`) and, in
 * dev builds only, by `?sem=mesa`. Never part of dist.
 *
 * Ray format (IWER XRSession.computeHitTestResults): a column-major mat4 in
 * global space (= local-floor). Origin = m[12..14]; direction =
 * -(m[8], m[9], m[10]) (the matrix rotates -Z onto the ray direction).
 * Results are mat4 poses with identity rotation, so the hit normal (pose +Y)
 * is up.
 *
 * Playwright serialises `installMesaSem` with Function.toString(): everything
 * must live inside it (no module-scope helpers, no classes, no class fields).
 * The SEM is a plain constructor function returning an object literal, which
 * `new semConstructor(device)` accepts.
 */

export interface MesaSemConfig {
  /** 'empty' answers every ray with no hit (hit-test granted, nothing found). */
  kind: 'mesa' | 'empty';
  /** Table surface height (m, local-floor). */
  tableY: number;
  /** Table extent on the XZ plane (m). */
  rect: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Also hit the floor (y = 0) outside the table. */
  floor: boolean;
}

/** A seated desk in front of the default IWER pose (head at the origin, looking at -Z). */
export const MESA_DEFAULT: MesaSemConfig = {
  kind: 'mesa',
  tableY: 0.74,
  rect: { minX: -0.6, maxX: 0.6, minZ: -1.0, maxZ: -0.2 },
  floor: true,
};

/** Self-contained: Playwright serialises it with addInitScript(installMesaSem, cfg). */
export function installMesaSem(cfg: MesaSemConfig): void {
  const w = window as unknown as { IWER_DEVICE?: { installSEM(ctor: unknown): void } };
  if (!w.IWER_DEVICE) {
    console.warn('[mesa-sem] IWER_DEVICE missing: hit-test stays unavailable');
    return;
  }

  // Column-major pose with identity rotation at (x, y, z).
  const at = (x: number, y: number, z: number): Float32Array =>
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);

  function MesaSEM() {
    let canvas: HTMLCanvasElement | null = null;
    const planes = new Set<unknown>();
    const meshes = new Set<unknown>();
    return {
      version: 'mesa-1',
      planesVisible: false,
      boundingBoxesVisible: false,
      meshesVisible: false,
      render() {},
      loadEnvironment() {},
      loadDefaultEnvironment() {},
      deleteAll() {},
      // IWER appends this to its fixed flex container on session start; keep it
      // out of the layout (it never draws anything). Lazy: unit tests have no DOM.
      get environmentCanvas(): HTMLCanvasElement {
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.dataset.mesaSem = cfg.kind;
          canvas.style.display = 'none';
        }
        return canvas;
      },
      get trackedPlanes() {
        return planes;
      },
      get trackedMeshes() {
        return meshes;
      },
      computeDepthBuffer() {
        return null;
      },
      computeHitTestResults(m: ArrayLike<number>): Float32Array[] {
        if (cfg.kind === 'empty') return [];
        const ox = m[12], oy = m[13], oz = m[14];
        const dx = -m[8], dy = -m[9], dz = -m[10];
        // Only rays going down can meet a horizontal surface.
        if (!(dy < -1e-6)) return [];
        // The table first: it occludes the floor below it.
        const t = (cfg.tableY - oy) / dy;
        if (t > 0) {
          const x = ox + t * dx;
          const z = oz + t * dz;
          const r = cfg.rect;
          if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return [at(x, cfg.tableY, z)];
        }
        if (!cfg.floor) return [];
        const tf = -oy / dy;
        return tf > 0 ? [at(ox + tf * dx, 0, oz + tf * dz)] : [];
      },
    };
  }

  w.IWER_DEVICE.installSEM(MesaSEM);
}
