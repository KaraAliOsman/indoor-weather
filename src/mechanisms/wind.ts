import { InstancedMesh, Mesh, type BufferGeometry, type Group, type Object3D } from '@iwsdk/core';
import type { QualityLevel, Qualityable } from '../core/types.ts';
import { createLeafGeometry, createLeavesMaterial, leavesInGroup } from '../render/leaves-material';
import {
  createPaperBuilder,
  createPaperMaterial,
  INK,
  octavesForQuality,
  setPaperOctaves,
  type Inks,
  type V3,
} from '../render/paper-material';

/**
 * Wind mechanism view: the pull tab that slides out of the front slot and the
 * 40 paper leaves that blow across the table (2 draw calls).
 *
 * Mounted on the box's wind anchor (anchor axes = box axes). The view never
 * decides progress: WindSystem feeds it the ratchet value and the gusts.
 */

/**
 * Leaf inks: the riso set with a green in the pink slot (slot 3 is drawn for
 * 35 % of the leaves; pink is reserved for what you pinch). Leaves pick
 * yellow 45 %, green 35 %, board 20 %; the rib is blue.
 */
const LEAF_INKS: Inks = [0xf2ebdd, 0xc9a46a, 0x0078bf, 0x6fae3f, 0xffe800, 0x1a1a1a];

export const WIND = {
  /** Full pull length of the tab (m). */
  travelM: 0.06,
  /** A pinch must start within this distance of the tab's grab point (m). */
  grabRadiusM: 0.035,
  /** First millimetres of every pull that count for nothing (still-hand jitter never ratchets). */
  deadbandM: 0.005,
  /** Letting go at or past this progress completes the tab (canon §4: end magnet ≥ 0.90). */
  releaseSnapAt: 0.9,
  leafCount: 40,
  /** One gust per notch (0.25, 0.5, 0.75) plus the completion gust. */
  groups: 4,
  /** Landing area on the table (m, x × z); leaves shrink away outside it. */
  areaM: [0.4, 0.3],
} as const;

/** Grab point of the tab at rest: centre of its pull end, in front of the slot (anchor space, m). */
export const WIND_TAB_GRIP_Z = 0.018;

/** Wind direction, box local XZ: towards the user's right and slightly forward. */
const WIND_DIR = [1, 0.45] as const;
/** Centre of the landing area relative to the slot (box local XZ, m). */
const AREA_OFFSET = [0.13, 0.13] as const;
/** Leaves drawn at quality L2 (plan §3.10). */
const LEAVES_LOW = 24;
/** Highlight easing rate (1/s). */
const HIGHLIGHT_RATE = 12;

export interface WindView extends Qualityable {
  readonly tab: Object3D;
  /** frustumCulled = false (the vertex shader moves the leaves); count = governor lever (M3). */
  readonly leaves: InstancedMesh;
  /** Tab slides along +Z from 0 to travelM. */
  setProgress(p: number): void;
  /** Releases a group of leaves at `time` (world clock, s). Idempotent per group. */
  gust(group: number, time: number): void;
  /** Blows group `group` again (the dawn's wind), even if it was released before. */
  replay(group: number, time: number): void;
  /** Grab affordance on the tab, 0..1 (eased in update). */
  setHighlight(level: number): void;
  update(time: number, dt: number): void;
  /** Drawn leaves (i < leaves.count) whose group was released. */
  readonly leavesReleased: number;
  dispose(): void;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * Tab, anchor space: a cream strip (kraft cut edges) long enough to stay in
 * the box at full pull, ending in a pink pull end (pink = what you pinch)
 * with an ink key line and a printed chevron pointing out of the box.
 */
function buildTabGeometry(): BufferGeometry {
  const b = createPaperBuilder();
  const inside = WIND.travelM + 0.012;
  b.box([-0.016, -0.0015, -inside], [0.016, 0.0015, 0.008], {
    px: INK.board, nx: INK.board, py: INK.paper, ny: INK.paper, pz: null, nz: INK.board,
  });
  b.box([-0.019, -0.0018, 0.008], [0.019, 0.0018, 0.028], {
    px: INK.board, nx: INK.board, py: INK.pink, ny: INK.pink, pz: INK.board, nz: INK.board,
  });
  const y = 0.0018 + 0.0004;
  const up: V3 = [0, 1, 0];
  // Key line around the pink end (canon: every grabbable carries one).
  const k = 0.0006;
  b.stroke([-0.019 + k, y, 0.008], [-0.019 + k, y, 0.028], up, k, INK.ink);
  b.stroke([0.019 - k, y, 0.008], [0.019 - k, y, 0.028], up, k, INK.ink);
  b.stroke([-0.019, y, 0.028 - k], [0.019, y, 0.028 - k], up, k, INK.ink);
  b.stroke([-0.009, y, 0.012], [0, y, 0.021], up, 0.0009, INK.ink);
  b.stroke([0, y, 0.021], [0.009, y, 0.012], up, 0.0009, INK.ink);
  return b.build();
}

/** Builds meshes and materials (call on placement:commit: programs compile during the settle). */
export function createWindView(anchor: Group): WindView {
  const tabMaterial = createPaperMaterial({ octaves: 2 });
  const tab = new Mesh(buildTabGeometry(), tabMaterial);
  tab.name = 'wind-tab';
  anchor.add(tab);

  // The leaves mesh is offset by -anchor.position so its frame is the box frame.
  const slot = anchor.position;
  const { material: leavesMaterial, uniforms } = createLeavesMaterial({
    inks: LEAF_INKS,
    slot: { x: slot.x, y: slot.y, z: slot.z },
    windDir: WIND_DIR,
    areaCenter: [slot.x + AREA_OFFSET[0], slot.z + AREA_OFFSET[1]],
    areaHalf: [WIND.areaM[0] / 2, WIND.areaM[1] / 2],
    octaves: 2,
  });
  const leaves = new InstancedMesh(
    createLeafGeometry(WIND.leafCount, WIND.groups),
    leavesMaterial,
    WIND.leafCount,
  );
  leaves.name = 'wind-leaves';
  leaves.frustumCulled = false;
  leaves.position.set(-slot.x, -slot.y, -slot.z);
  leaves.updateMatrix();
  leaves.matrixAutoUpdate = false;
  anchor.add(leaves);

  // Shader times are relative to the first update/gust: keeps float32 precision in long sessions.
  let epoch = Number.NaN;
  let releasedMask = 0;
  let leavesReleased = 0;
  let highlight = 0;
  let highlightTarget = 0;

  const recount = (): void => {
    let n = 0;
    for (let g = 0; g < WIND.groups; g++) {
      if (releasedMask & (1 << g)) n += leavesInGroup(leaves.count, WIND.groups, g);
    }
    leavesReleased = n;
  };

  return {
    tab,
    leaves,
    get leavesReleased() {
      return leavesReleased;
    },
    setProgress(p) {
      tab.position.z = clamp01(p) * WIND.travelM;
    },
    gust(group, time) {
      if (!Number.isInteger(group) || group < 0 || group >= WIND.groups) return;
      const bit = 1 << group;
      if (releasedMask & bit) return;
      if (Number.isNaN(epoch)) epoch = time;
      releasedMask |= bit;
      uniforms.uGust.value.setComponent(group, time - epoch);
      recount();
    },
    replay(group, time) {
      if (!Number.isInteger(group) || group < 0 || group >= WIND.groups) return;
      if (Number.isNaN(epoch)) epoch = time;
      releasedMask |= 1 << group;
      // The group's leaves are long gone (≈ 22 s of life): restarting them blows a fresh gust.
      uniforms.uGust.value.setComponent(group, time - epoch);
      recount();
    },
    setHighlight(level) {
      highlightTarget = clamp01(level);
    },
    update(time, dt) {
      if (Number.isNaN(epoch)) epoch = time;
      const t = time - epoch;
      uniforms.uTime.value = t;
      tabMaterial.uniforms.uTime.value = t;
      highlight += (highlightTarget - highlight) * (1 - Math.exp(-dt * HIGHLIGHT_RATE));
      tabMaterial.uniforms.uHighlight.value = highlight;
    },
    setQuality(level: QualityLevel) {
      leaves.count = level === 2 ? LEAVES_LOW : WIND.leafCount;
      recount();
      const octaves = octavesForQuality(level);
      setPaperOctaves(tabMaterial, octaves);
      setPaperOctaves(leavesMaterial, octaves);
    },
    dispose() {
      anchor.remove(tab, leaves);
      tab.geometry.dispose();
      tabMaterial.dispose();
      leaves.geometry.dispose();
      leavesMaterial.dispose();
      leaves.dispose();
    },
  };
}
