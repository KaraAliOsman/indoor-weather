/**
 * U-storm: cloud tag gesture, rain density, story clock and photosensitive
 * safety of the lightning glow (WCAG 2.3.1 + direccion/experiencia.md
 * "Sin destellos": dL <= 10%/s, no opposite pair > 0.1 within 333 ms).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bodyDensity,
  createGlowSchedule,
  createStorm,
  GLOW,
  glowAt,
  pullDensity,
  rainCountForQuality,
  rainRankScale,
  rainSeeds,
  rainVisibleCount,
  STORM,
  stormAmount,
  type StormEvent,
} from '../../src/mechanisms/storm.ts';
import { RAIN_FRAG, RAIN_VERT } from '../../src/render/glsl/rain.ts';
import { CAP_FLOATS, PALM_FLOATS, RAIN_CAP_VEC4, RAIN_PALM_VEC4 } from '../../src/storm/hand-field.ts';

const FPS = 72;
const DT = 1 / FPS;

/** Sampled luminance track → peaks and glow widths. */
function analyse(samples: number[], dt: number) {
  const peaks: number[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    if (samples[i] > 1e-6 && samples[i] >= samples[i - 1] && samples[i] > samples[i + 1]) peaks.push(i * dt);
  }
  const widths: number[] = [];
  let start = -1;
  for (let i = 0; i < samples.length; i++) {
    const on = samples[i] > 1e-6;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      widths.push((i - start) * dt);
      start = -1;
    }
  }
  let maxSlope = 0;
  for (let i = 1; i < samples.length; i++) maxSlope = Math.max(maxSlope, Math.abs(samples[i] - samples[i - 1]) / dt);
  return { peaks, widths, maxSlope };
}

function maxPeaksPerSecond(peaks: number[]): number {
  let best = 0;
  for (let i = 0; i < peaks.length; i++) {
    let n = 0;
    for (let j = i; j < peaks.length && peaks[j] - peaks[i] < 1; j++) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** Largest rise followed by a fall (or vice versa) inside any 333 ms window. */
function maxOppositePair(samples: number[], dt: number): number {
  const w = Math.round(0.333 / dt);
  let worst = 0;
  for (let i = 0; i + w < samples.length; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i; j <= i + w; j++) {
      lo = Math.min(lo, samples[j]);
      hi = Math.max(hi, samples[j]);
    }
    const a = samples[i];
    const b = samples[i + w];
    // An up-then-down (or down-then-up) excursion that returns.
    worst = Math.max(worst, Math.min(hi - a, hi - b), Math.min(a - lo, b - lo));
  }
  return worst;
}

function runGoldenPath(seed: number, attending: (t: number) => boolean = () => true, lightning = false) {
  const storm = createStorm({ seed, lightning });
  const glow: number[] = [];
  const density: number[] = [];
  const events: Array<StormEvent & { t: number }> = [];
  let t = 0;
  storm.grab();
  for (let i = 0; i <= FPS; i++, t += DT) {
    storm.drag(i / FPS);
    const f = storm.update(DT, true);
    for (const e of f.events) events.push({ ...e, t });
    density.push(f.density);
    glow.push(f.glow);
  }
  storm.release();
  for (let i = 0; i < FPS * 45 && storm.phase !== 'done'; i++, t += DT) {
    const f = storm.update(DT, attending(t));
    for (const e of f.events) events.push({ ...e, t });
    density.push(f.density);
    glow.push(f.glow);
  }
  return { storm, glow, density, events };
}

test('stormAmount maps the hand delta along +Y and ignores non-finite input', () => {
  assert.equal(stormAmount(0.1, 0.1), 0);
  assert.ok(Math.abs(stormAmount(0.1, 0.14) - 0.5) < 1e-9);
  assert.equal(stormAmount(0.1, 0.3), 1);
  assert.equal(stormAmount(0.1, 0.0), 0);
  assert.equal(stormAmount(0.1, Number.NaN), 0);
});

test('rain only starts above p 0.35 and follows a smoothstep', () => {
  assert.equal(pullDensity(0.2), 0);
  assert.equal(pullDensity(0.35), 0);
  assert.ok(pullDensity(0.6) > 0 && pullDensity(0.6) < 1);
  assert.equal(pullDensity(1), 1);
});

test('releasing below p 0.6 springs the tag back, no auto-complete', () => {
  const s = createStorm();
  s.grab();
  s.drag(0.5);
  s.update(DT, true);
  assert.equal(s.release(), false);
  let complete = 0;
  for (let i = 0; i < FPS; i++) complete += s.update(DT, true).events.filter((e) => e.type === 'auto-complete').length;
  assert.equal(complete, 0);
  assert.equal(s.phase, 'idle');
  assert.equal(s.update(DT, true).pull, 0);
});

test('releasing at p >= 0.6 auto-completes once, floats and runs a 30 s body', () => {
  const { storm, events } = runGoldenPath(1);
  const types = events.map((e) => e.type);
  assert.equal(types.filter((x) => x === 'auto-complete').length, 1);
  assert.equal(types.filter((x) => x === 'body').length, 1);
  assert.equal(types.filter((x) => x === 'rain-start').length, 1);
  assert.equal(types.filter((x) => x === 'done').length, 1);
  assert.deepEqual(events.filter((e) => e.type === 'thunder').map((e) => (e as { index: number }).index), [0, 1]);
  assert.equal(events.filter((e) => e.type === 'last-drop').length, 3);
  const body = events.find((e) => e.type === 'body')!.t;
  const done = events.find((e) => e.type === 'done')!.t;
  assert.ok(Math.abs(done - body - STORM.bodyS) < 2 * DT, `body lasted ${done - body}`);
  assert.equal(storm.phase, 'done');
});

test('storyTime freezes while looking away and rain eases to 30% without a step', () => {
  const away = (t: number) => !(t > 10 && t < 20);
  const { events, density } = runGoldenPath(1, away);
  const body = events.find((e) => e.type === 'body')!.t;
  const done = events.find((e) => e.type === 'done')!.t;
  assert.ok(done - body > STORM.bodyS + 9, 'the body did not freeze');
  const mid = density[Math.round(18 * FPS)];
  assert.ok(Math.abs(mid - STORM.inattentiveRain) < 0.02, `rain while away ${mid}`);
  for (let i = 1; i < density.length; i++) {
    assert.ok(Math.abs(density[i] - density[i - 1]) < 0.05, `density jump at frame ${i}`);
  }
});

test('the body density ramps from the release level and drains to 0', () => {
  assert.equal(bodyDensity(0, 0.4), 0.4);
  assert.equal(bodyDensity(STORM.rampS + 1, 0.4), 1);
  assert.equal(bodyDensity(STORM.drainEndS), 0);
  assert.equal(bodyDensity(STORM.bodyS), 0);
});

test('glow schedule is deterministic per seed and never overlaps', () => {
  assert.deepEqual(createGlowSchedule(7), createGlowSchedule(7));
  for (let seed = 0; seed < 200; seed++) {
    const s = createGlowSchedule(seed);
    assert.equal(s.length, STORM.thunderS.length + GLOW.extra, `seed ${seed}`);
    for (let i = 1; i < s.length; i++) {
      assert.ok(s[i].at - s[i - 1].at >= GLOW.minGapS - 1e-9, `seed ${seed}: glows too close`);
      assert.ok(s[i].at - s[i - 1].at >= s[i - 1].riseS + s[i - 1].fallS, `seed ${seed}: overlap`);
    }
    for (const g of s) assert.ok(g.at + g.riseS + g.fallS <= STORM.drainStartS + 1e-9, `seed ${seed}: glow in drain`);
  }
});

test('SAFETY: <= 3 luminance peaks per second, every glow >= 300 ms, gentle slopes (1 kHz, 200 seeds)', () => {
  const dt = 0.001;
  for (let seed = 0; seed < 200; seed++) {
    const sched = createGlowSchedule(seed);
    const samples: number[] = [];
    for (let t = -1; t <= STORM.bodyS + 1; t += dt) samples.push(glowAt(sched, t));
    const { peaks, widths, maxSlope } = analyse(samples, dt);
    assert.ok(maxPeaksPerSecond(peaks) <= 3, `seed ${seed}: ${maxPeaksPerSecond(peaks)} peaks/s`);
    assert.ok(maxPeaksPerSecond(peaks) <= 1, `seed ${seed}: more than one glow in a second`);
    assert.equal(widths.length, sched.length, `seed ${seed}: glow count`);
    for (const w of widths) assert.ok(w >= 0.3, `seed ${seed}: glow of ${w * 1000} ms`);
    assert.ok(maxSlope <= 0.1 + 1e-3, `seed ${seed}: dL/dt ${maxSlope}`);
    assert.ok(maxOppositePair(samples, dt) < 0.1, `seed ${seed}: opposite pair >= 0.1 in 333 ms`);
    assert.ok(Math.max(...samples) <= GLOW.peak + 1e-9);
  }
});

test('SAFETY: the frame glow of a full run obeys the same limits at 72 Hz', () => {
  for (const seed of [0, 1, 42, 0x5707]) {
    const { glow } = runGoldenPath(seed, () => true, true);
    const { peaks, widths, maxSlope } = analyse(glow, DT);
    assert.ok(maxPeaksPerSecond(peaks) <= 3);
    assert.ok(peaks.length >= 1, 'no glow at all');
    for (const w of widths) assert.ok(w >= 0.3, `glow of ${w * 1000} ms`);
    assert.ok(maxSlope <= 0.1 + 1e-3, `dL/dt ${maxSlope}`);
    assert.ok(maxOppositePair(glow, DT) < 0.1);
  }
});

test('drop budget per quality level', () => {
  assert.deepEqual([0, 1, 2, 9, -1].map(rainCountForQuality), [900, 600, 300, 300, 900]);
});

test('rain GLSL never declares identifiers that multiview injects', () => {
  const INJECTED = ['modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix', 'cameraPosition', 'position'];
  const PRECISION = String.raw`(?:(?:lowp|mediump|highp)\s+)?`;
  const TYPE = String.raw`(?:float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?)`;
  const STORAGE = new RegExp(String.raw`\b(?:uniform|varying|attribute|in|out)\s+${PRECISION}(\w+)\s+(\w+)`, 'g');
  const LOCAL = new RegExp(String.raw`\b${PRECISION}${TYPE}\s+(\w+)\s*(?:[=;,)(]|\[)`, 'g');
  for (const glsl of [RAIN_VERT, RAIN_FRAG]) {
    const declared = [...[...glsl.matchAll(STORAGE)].map((m) => m[2]), ...[...glsl.matchAll(LOCAL)].map((m) => m[1])];
    assert.deepEqual(declared.filter((d) => INJECTED.includes(d)), []);
  }
  assert.match(RAIN_VERT, /gl_Position\s*=/);
  assert.match(RAIN_FRAG, /gl_FragColor\s*=/);
});

// ---- Adversarial review regressions ----

test('lightning is off by default (arte.md F5): glow stays 0, no glow events, thunder still sounds', () => {
  const { glow, events } = runGoldenPath(1);
  assert.equal(Math.max(...glow), 0);
  assert.equal(events.filter((e) => e.type === 'glow').length, 0);
  assert.equal(events.filter((e) => e.type === 'thunder').length, 2);
  const lit = runGoldenPath(1, () => true, true);
  assert.equal(lit.events.filter((e) => e.type === 'glow').length, STORM.thunderS.length + GLOW.extra);
});

test('hand jitter around p 0.35 fires rain-start once per pull, not every frame', () => {
  const s = createStorm();
  s.grab();
  let starts = 0;
  for (let i = 0; i < FPS * 2; i++) {
    s.drag(i % 2 ? 0.34 : 0.37);
    starts += s.update(DT, true).events.filter((e) => e.type === 'rain-start').length;
  }
  assert.equal(starts, 1);
  // Back to the slot re-arms it for the next pull.
  s.release();
  for (let i = 0; i < FPS; i++) s.update(DT, true);
  assert.equal(s.phase, 'idle');
  s.grab();
  s.drag(0.5);
  assert.equal(s.update(DT, true).events.filter((e) => e.type === 'rain-start').length, 1);
});

test('release at p 0.6: the tag and the cloud move continuously (no one-frame jump)', () => {
  const s = createStorm();
  s.grab();
  s.drag(0.6);
  let prev = s.update(DT, true);
  let pull = prev.pull;
  let lift = prev.cloudLift;
  let scale = prev.cloudScale;
  assert.equal(s.release(), true);
  for (let i = 0; i < FPS * 3; i++) {
    const f = s.update(DT, true);
    assert.ok(Math.abs(f.pull - pull) < 0.08, `pull jump ${pull} -> ${f.pull} at frame ${i}`);
    // The 0.6 s critical spring peaks at ~0.051/frame at 72 Hz.
    assert.ok(Math.abs(f.cloudLift - lift) < 0.08, `lift jump ${lift} -> ${f.cloudLift} at frame ${i}`);
    assert.ok(Math.abs(f.cloudScale - scale) < 0.05, `scale jump at frame ${i}`);
    pull = f.pull;
    lift = f.cloudLift;
    scale = f.cloudScale;
  }
  assert.equal(pull, 1);
  assert.equal(lift, 1);
});

test('governor: density keeps meaning "fraction drawn" at L0, L1 and L2', () => {
  const seeds = rainSeeds(STORM.drops[0]);
  assert.deepEqual(rainSeeds(64, 3), rainSeeds(64, 3));
  for (const level of [0, 1, 2]) {
    const drawn = rainCountForQuality(level);
    for (const d of [0, 0.1, STORM.inattentiveRain, 0.5, 0.9, 1]) {
      const frac = rainVisibleCount(seeds, drawn, d, rainRankScale(level)) / drawn;
      assert.ok(Math.abs(frac - d) <= 1.5 / drawn + 1e-9, `L${level} density ${d}: ${frac} drawn`);
    }
  }
});

test('rain shader tests the whole HandField (2 palm slabs, 12 capsules)', () => {
  assert.match(RAIN_VERT, new RegExp(String.raw`uniform\s+vec4\s+uPalm\[${RAIN_PALM_VEC4}\]`));
  assert.match(RAIN_VERT, new RegExp(String.raw`uniform\s+vec4\s+uCap\[${RAIN_CAP_VEC4}\]`));
  assert.equal(RAIN_PALM_VEC4 * 4, PALM_FLOATS);
  assert.equal(RAIN_CAP_VEC4 * 4, CAP_FLOATS);
  assert.match(RAIN_VERT, /i\s*<\s*12\s*;/);
  assert.match(RAIN_VERT, /uniform\s+float\s+uRankScale/);
});

test('hostile input: NaN / huge / negative dt, non-finite drag keep the frame finite and in range', () => {
  const s = createStorm({ seed: 9 });
  s.grab();
  for (const a of [Number.NaN, Infinity, -Infinity, -5, 7]) s.drag(a);
  const dts = [Number.NaN, Infinity, -1, 0, 1e9, DT];
  for (let i = 0; i < 2000; i++) {
    if (i === 10) s.release();
    const f = s.update(dts[i % dts.length], i % 7 !== 0);
    for (const v of [f.pull, f.cloudScale, f.cloudLift, f.density, f.glow, f.bodyTime]) assert.ok(Number.isFinite(v));
    assert.ok(f.pull >= 0 && f.pull <= 1 && f.density >= 0 && f.density <= 1 && f.cloudLift >= 0 && f.cloudLift <= 1);
    assert.ok(f.bodyTime <= STORM.bodyS);
  }
});
