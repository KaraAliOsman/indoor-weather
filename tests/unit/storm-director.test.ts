import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStormDirector, STORM_TIMING, type StormCue } from '../../src/storm/storm-director.ts';

const DT = 1 / 72;

function run(d: ReturnType<typeof createStormDirector>, seconds: number, cover: number | ((t: number) => number)) {
  const cues: Array<[number, StormCue]> = [];
  let last = d.step(0, 0);
  for (let i = 0, t = 0; t < seconds; i++, t += DT) {
    last = d.step(DT, typeof cover === 'number' ? cover : cover(t));
    for (const c of last.cues) cues.push([t, c]);
  }
  return { cues, last };
}

test('hidden → revealed → floating → body (rain cue) → drain → over', () => {
  const d = createStormDirector();
  d.complete();
  assert.equal(d.stage, 'floating', 'complete() works straight from hidden (debug / replay)');
  d.reset();
  d.reveal();
  assert.equal(d.stage, 'revealed');
  assert.equal(d.step(1, 0).density, 0);
  d.complete();
  const { cues } = run(d, 60, 0);
  const names = cues.map(([, c]) => c);
  assert.deepEqual(names, ['rain', 'thunder', 'drain', 'over']);
  const [tRain] = cues.find(([, c]) => c === 'rain')!;
  const [tDrain] = cues.find(([, c]) => c === 'drain')!;
  // Nobody shelters: 2 s ramp + 20 s of full rain.
  assert.ok(Math.abs(tDrain - tRain - (STORM_TIMING.rampS + STORM_TIMING.maxFullS)) < 0.05, `${tDrain - tRain}`);
  assert.equal(d.stage, 'over');
});

test('density ramps in 2 s and drains to 0 in 6 s, never jumps', () => {
  const d = createStormDirector();
  d.complete();
  let prev = 0;
  for (let t = 0; t < 40; t += DT) {
    const s = d.step(DT, 0);
    assert.ok(Math.abs(s.density - prev) < 0.025, `jump at ${t}: ${prev} → ${s.density}`);
    prev = s.density;
  }
  assert.equal(prev, 0);
});

test('a 5 s shelter, then lifting the hand: print, and the storm ends 6 s later', () => {
  const d = createStormDirector();
  d.complete();
  // Rain from 0.6 s; shelter from 3 s to 8 s, then lift.
  const { cues } = run(d, 30, (t) => (t >= 3 && t < 8 ? 0.8 : 0));
  const names = cues.map(([, c]) => c);
  assert.deepEqual(names.slice(0, 5), ['rain', 'shelter-on', 'thunder', 'shelter-off', 'print']);
  const tPrint = cues.find(([, c]) => c === 'print')![0];
  const tDrain = cues.find(([, c]) => c === 'drain')![0];
  assert.ok(Math.abs(tDrain - tPrint - STORM_TIMING.afterPrintS) < 0.05, `${tDrain - tPrint}`);
});

test('a brief touch is no print; a partial cover below 40 % is no shelter', () => {
  const d = createStormDirector();
  d.complete();
  const { cues } = run(d, 10, (t) => (t >= 3 && t < 4 ? 1 : 0.3));
  const names = cues.map(([, c]) => c);
  assert.ok(names.includes('shelter-on') && names.includes('shelter-off'));
  assert.ok(!names.includes('print'));
});

test('still holding the shelter when the rain ends: that hand is the print', () => {
  const d = createStormDirector();
  d.complete();
  const { cues } = run(d, 40, (t) => (t >= 2 ? 1 : 0));
  const names = cues.map(([, c]) => c);
  assert.ok(names.indexOf('print') >= 0 && names.indexOf('print') < names.indexOf('drain'), names.join(','));
  assert.equal(names.filter((c) => c === 'print').length, 1);
});

test('hostile dt: NaN, negative and huge steps keep the output finite', () => {
  const d = createStormDirector();
  d.complete();
  for (const dt of [Number.NaN, -1, 1e9, Infinity]) {
    const s = d.step(dt, Number.NaN);
    assert.ok(Number.isFinite(s.density) && s.density >= 0 && s.density <= 1);
  }
});
