import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandSample } from '../../src/input/hands-state.ts';
import { createHandField, updateHandField } from '../../src/storm/hand-field.ts';
import { decodePrint, encodePrint, extractPrint, printPath, PRINT_H, PRINT_W } from '../../src/storm/print.ts';
import { createWetMap } from '../../src/storm/wet-map.ts';

/** A relaxed right hand, palm down, 10 cm above the table centred on (cx, cz). */
function relaxedHand(cx: number, cz: number) {
  const s = createHandSample('right');
  s.device = 'hand';
  s.tracked = true;
  s.jointsValid = true;
  const put = (j: number, x: number, z: number) => {
    s.joints[j * 3] = cx + x;
    s.joints[j * 3 + 1] = 0.1;
    s.joints[j * 3 + 2] = cz + z;
  };
  put(0, 0, 0.045);
  put(1, -0.025, 0.03);
  put(2, -0.045, 0.01);
  put(3, -0.06, -0.01);
  put(4, -0.07, -0.03);
  const fx = [-0.027, -0.008, 0.011, 0.029];
  const len = [0.075, 0.085, 0.078, 0.062];
  const ang = [-14, -5, 5, 15];
  for (let f = 0; f < 4; f++) {
    const b = 5 + f * 5;
    const sa = Math.sin((ang[f]! * Math.PI) / 180);
    const ca = Math.cos((ang[f]! * Math.PI) / 180);
    put(b, fx[f]! * 0.5, 0.02);
    put(b + 1, fx[f]!, -0.045);
    for (const [j, t] of [[2, 0.45], [3, 0.75], [4, 1]] as const) put(b + j, fx[f]! + sa * len[f]! * t, -0.045 - ca * len[f]! * t);
  }
  return s;
}

function shelteredMap() {
  const map = createWetMap({ centerX: 0.1, centerZ: 0.15, rainCenter: [0.1, 0.16], rainHalf: [0.15, 0.1] });
  const f = createHandField();
  updateHandField(f, 1, relaxedHand(0.1, 0.15), { position: { x: 0, y: 0, z: 0 }, yaw: 0, scale: 1 }, { kx: 0, kz: 0, floorY: 0 });
  for (let i = 0; i < 3 * 15; i++) map.update(1 / 15, 1, f, 0, false);
  return map;
}

test('a 3 s shelter becomes a 64 × 48 print with the hand in it', () => {
  const map = shelteredMap();
  const p = extractPrint(map.shelter, map.cols, map.rows, map.texel);
  assert.ok(p);
  const on = p.bits.reduce((a, b) => a + b, 0);
  // A hand fills a good part of its own bounding box, but never all of it (gaps between fingers).
  assert.ok(on > 0.2 * PRINT_W * PRINT_H && on < 0.75 * PRINT_W * PRINT_H, `${on} bits`);
  // Finger gaps: the top rows (fingertips, −Z is up in the print) alternate on and off at least 3 times.
  const row = Array.from(p.bits.subarray(6 * PRINT_W, 7 * PRINT_W));
  let edges = 0;
  for (let x = 1; x < PRINT_W; x++) if (row[x] !== row[x - 1]) edges++;
  assert.ok(edges >= 6, `fingertip row edges ${edges}: ${row.join('')}`);
});

test('print RLE: round trip, under 400 bytes, hostile input rejected', () => {
  const map = shelteredMap();
  const p = extractPrint(map.shelter, map.cols, map.rows, map.texel)!;
  const s = encodePrint(p.bits);
  assert.ok(s.length <= 400, `${s.length} chars`);
  assert.deepEqual(decodePrint(s), p.bits);
  assert.equal(decodePrint(''), null);
  assert.equal(decodePrint('@@@'), null);
  assert.equal(decodePrint(s.slice(0, -2)), null, 'truncated');
  const blank = new Uint8Array(PRINT_W * PRINT_H);
  assert.deepEqual(decodePrint(encodePrint(blank)), blank);
});

test('no shelter, or a fingertip only → no print', () => {
  const map = createWetMap({ centerX: 0, centerZ: 0, rainCenter: [0, 0], rainHalf: [0.15, 0.1] });
  assert.equal(extractPrint(map.shelter, map.cols, map.rows, map.texel), null);
  map.shelter.fill(0);
  for (let k = 0; k < 20; k++) map.shelter[60 * map.cols + 100 + k] = 3;
  assert.equal(extractPrint(map.shelter, map.cols, map.rows, map.texel), null);
});

test('printPath draws one rectangle per run', () => {
  const bits = new Uint8Array(PRINT_W * PRINT_H);
  bits.fill(1, 2, 6);
  bits[PRINT_W + 10] = 1;
  assert.equal(printPath(bits), 'M2 0h4v1h-4zM10 1h1v1h-1z');
});
