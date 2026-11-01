import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HandSample } from '../../src/core/types.ts';
import { createHandSample } from '../../src/input/hands-state.ts';
import {
  blockY,
  createHandField,
  fieldBounds,
  updateHandField,
  type BoxFrame,
  type RainSlant,
} from '../../src/storm/hand-field.ts';
import { createWetMap, WET } from '../../src/storm/wet-map.ts';

const BOX: BoxFrame = { position: { x: 0, y: 0, z: 0 }, yaw: 0, scale: 1 };
const VERTICAL: RainSlant = { kx: 0, kz: 0, floorY: 0 };
const SLANT: RainSlant = { kx: 0.14, kz: 0.45, floorY: 0 };

/**
 * A flat right hand, palm down, `y` above the table, wrist at (cx, y, cz + 0.09),
 * fingers pointing to −Z (away from the user), thumb on −X... mirrored for the
 * right hand seen from above with the palm down: thumb towards −X.
 */
function flatHand(cx: number, cz: number, y: number): HandSample {
  const s = createHandSample('right');
  s.device = 'hand';
  s.tracked = true;
  s.jointsValid = true;
  const J = s.joints;
  const put = (j: number, x: number, z: number) => {
    J[j * 3] = cx + x;
    J[j * 3 + 1] = y;
    J[j * 3 + 2] = cz + z;
  };
  put(0, 0, 0.045); // wrist
  // Thumb: metacarpal, proximal, distal, tip.
  put(1, -0.025, 0.03);
  put(2, -0.045, 0.01);
  put(3, -0.06, -0.01);
  put(4, -0.07, -0.03);
  // Index, middle, ring, little: metacarpal, proximal (MCP), intermediate, distal, tip.
  const fx = [-0.025, -0.005, 0.015, 0.033];
  const len = [0.075, 0.085, 0.078, 0.06];
  for (let f = 0; f < 4; f++) {
    const base = 5 + f * 5;
    put(base, fx[f] * 0.5, 0.02);
    put(base + 1, fx[f], -0.045);
    put(base + 2, fx[f], -0.045 - len[f] * 0.45);
    put(base + 3, fx[f], -0.045 - len[f] * 0.75);
    put(base + 4, fx[f], -0.045 - len[f]);
  }
  return s;
}

test('palm slab blocks the vertical rain right above the back of the hand', () => {
  const f = createHandField();
  updateHandField(f, 1, flatHand(0, 0, 0.12), BOX, VERTICAL);
  assert.equal(f.active[1], true);
  const y = blockY(f, 0, 0);
  // Slab: palm plane + 1.2 cm towards the back (k ≈ 1).
  assert.ok(y > 0.125 && y < 0.14, `palm top ${y}`);
  // Finger capsule: the top of a 9 mm capsule above the middle fingertip line.
  const yf = blockY(f, -0.005, -0.1);
  assert.ok(yf > 0.12 && yf < 0.131, `finger top ${yf}`);
  // Between two fingers near the tips: open.
  assert.equal(blockY(f, 0.025, -0.12), -Infinity);
  // Far away: open.
  assert.equal(blockY(f, 0.3, 0), -Infinity);
});

test('an untracked hand is cleared from the field', () => {
  const f = createHandField();
  const s = flatHand(0, 0, 0.12);
  updateHandField(f, 1, s, BOX, VERTICAL);
  s.tracked = false;
  updateHandField(f, 1, s, BOX, VERTICAL);
  assert.equal(f.active[1], false);
  assert.equal(blockY(f, 0, 0), -Infinity);
});

test('slanted rain: the dry patch lands downwind of the hand, by k · height', () => {
  const f = createHandField();
  updateHandField(f, 1, flatHand(0, 0, 0.15), BOX, SLANT);
  // At table height rain space = box space: the palm (x 0, z 0) shelters (0.021, 0.0675).
  assert.ok(blockY(f, 0.14 * 0.15, 0.45 * 0.15) > 0.1);
  assert.equal(blockY(f, -0.06, -0.06), -Infinity);
});

test('box yaw: joints are brought into the box frame before testing', () => {
  const f = createHandField();
  // Box turned 90° (its +Z faces world +X); a hand at world (0.2, 0.12, 0) is box-local z ≈ 0.2.
  const box: BoxFrame = { position: { x: 0, y: 0, z: 0 }, yaw: Math.PI / 2, scale: 1 };
  updateHandField(f, 1, flatHand(0.2, 0, 0.12), box, VERTICAL);
  const b = [0, 0, 0, 0];
  fieldBounds(f, b);
  assert.ok(b[1] < 0.2 && b[3] > 0.2, `w range ${b[1]}..${b[3]}`);
  assert.ok(blockY(f, 0, 0.2) > 0.1);
});

test('wet map: 6 s of rain around a held hand leave a dry handprint on wet wood', () => {
  const map = createWetMap({ centerX: 0, centerZ: 0, rainCenter: [0, 0], rainHalf: [0.15, 0.1] });
  const f = createHandField();
  updateHandField(f, 1, flatHand(0, 0.02, 0.12), BOX, VERTICAL);
  for (let i = 0; i < 6 * 72; i++) map.update(1 / 72, 1, f, 0, false);
  const under = { r: 0, g: 0 };
  const around = { r: 0, g: 0 };
  map.sample(-0.01, 0.01, 0.01, 0.03, under);
  map.sample(0.1, -0.02, 0.12, 0.0, around);
  assert.ok(under.r < 0.02 && under.g < 0.02, `under the palm r ${under.r} g ${under.g}`);
  assert.ok(around.r > 0.85, `around r ${around.r}`);
  assert.ok(around.g > 0.4 && around.g < 0.5, `around g ${around.g}`);
  assert.ok(map.sheltered > 0.05 && map.sheltered < 0.6, `sheltered ${map.sheltered}`);

  // Lift the hand: the print fills in drop by drop, the shine first.
  updateHandField(f, 1, { ...flatHand(0, 0.02, 0.12), tracked: false } as HandSample, BOX, VERTICAL);
  for (let i = 0; i < 3 * 72; i++) map.update(1 / 72, 1, f, 0, false);
  map.sample(-0.01, 0.01, 0.01, 0.03, under);
  assert.ok(under.r > 0.6, `print shine after 3 s ${under.r}`);
  assert.ok(under.g < around.g, 'the print stays lighter than its surroundings for a while');
});

test('wet map bytes mirror the state; no rain and dry → no work, no version bump', () => {
  const map = createWetMap({ centerX: 0, centerZ: 0, rainCenter: [0, 0], rainHalf: [0.15, 0.1] });
  const f = createHandField();
  const v0 = map.version;
  map.update(1, 0, f, 0, false);
  assert.equal(map.version, v0);
  for (let i = 0; i < 4 * 15; i++) map.update(1 / 15, 1, f, 0, false);
  assert.ok(map.version > v0);
  // Drop by drop: after 4 s most texels near the centre were hit, every one has soaked.
  let hit = 0;
  for (let dj = -5; dj <= 5; dj++) {
    for (let di = -5; di <= 5; di++) {
      const k = ((Math.floor(WET.rows / 2) + dj) * WET.cols + Math.floor(WET.cols / 2) + di) * 2;
      if (map.data[k] > 200) hit++;
      assert.ok(map.data[k + 1] > 0);
    }
  }
  assert.ok(hit > 0.7 * 121 && hit < 121, `hit ${hit}/121 (speckled, not uniform)`);
  // Outside the rain ellipse nothing changes.
  assert.equal(map.data[0], 0);
  assert.equal(map.data[1], 0);
});

test('wet map: dawn dries three times faster', () => {
  const a = createWetMap({ centerX: 0, centerZ: 0, rainCenter: [0, 0], rainHalf: [0.15, 0.1] });
  const b = createWetMap({ centerX: 0, centerZ: 0, rainCenter: [0, 0], rainHalf: [0.15, 0.1] });
  const f = createHandField();
  for (const m of [a, b]) for (let i = 0; i < 300; i++) m.update(1 / 60, 1, f, 0, false);
  for (let i = 0; i < 300; i++) {
    a.update(1 / 60, 0, f, 0, false);
    b.update(1 / 60, 0, f, 0, true);
  }
  const ga = { r: 0, g: 0 };
  const gb = { r: 0, g: 0 };
  a.sample(-0.02, -0.02, 0.02, 0.02, ga);
  b.sample(-0.02, -0.02, 0.02, 0.02, gb);
  assert.ok(gb.g < ga.g - 0.15, `dawn ${gb.g} vs plain ${ga.g}`);
});
