import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRatchet } from '../../src/input/ratchet.ts';
import {
  createNightHandle,
  createNightModel,
  edgeForLevel,
  finiteVec3,
  NIGHT,
  NIGHT_STAR_FROM,
  NIGHT_KITE_STARS,
  NIGHT_PULL_AXIS,
  NIGHT_RATCHET,
  NIGHT_STAR_COUNT,
  nightStars,
  nightStarVisibility,
  sparkIntensity,
  veilAlpha,
  type NightMilestone,
} from '../../src/mechanisms/night.ts';
import { NIGHT_VEIL_FRAG, NIGHT_VEIL_VERT } from '../../src/render/glsl/night.ts';

const DT = 1 / 72;

function run(model: ReturnType<typeof createNightModel>, seconds: number, onStep?: () => void): NightMilestone[] {
  const all: NightMilestone[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    all.push(...model.step(DT).milestones);
    onStep?.();
  }
  return all;
}

test('handle: pulling the bead 5 cm down is a full pull through the ratchet with 3 notches', () => {
  const h = createNightHandle();
  h.setFrame({ x: 0.1, y: 0.9, z: 0 }, NIGHT_PULL_AXIS, 0, true);
  const r = createRatchet(NIGHT_RATCHET);
  const start = { x: 0.1, y: 0.9, z: 0 };
  const notches: number[] = [];
  let completed = 0;
  for (let mm = 0; mm <= 50; mm++) {
    const step = r.push(h.amountFor(start, { x: 0.1, y: 0.9 - mm / 1000, z: 0.003 }, 0));
    notches.push(...step.notches);
    if (step.completed) completed++;
  }
  assert.deepEqual(notches, [0, 1, 2]);
  assert.equal(completed, 1);
  // Pulling up never darkens.
  assert.ok(h.amountFor(start, { x: 0.1, y: 0.95, z: 0 }, 0) < 0);
});

test('an instantaneous full pull still takes >= 2.4 s to close (Calm >= 4.2 s); milestones once, in order', () => {
  for (const [calm, minS] of [[false, 2.4], [true, 4.2]] as const) {
    const m = createNightModel({ calm });
    m.setTarget(1);
    const seen: NightMilestone[] = [];
    let closedAt = -1;
    for (let i = 0; i < 72 * 8; i++) {
      const s = m.step(DT);
      seen.push(...s.milestones);
      if (closedAt < 0 && s.milestones.includes('closed')) closedAt = (i + 1) * DT;
    }
    assert.ok(closedAt >= minS, `calm=${calm}: closed at ${closedAt}`);
    assert.deepEqual(seen, ['start', 'crickets', 'pool', 'closed']);
    assert.equal(m.state.level, 1);
    assert.equal(m.state.edgeDeg, NIGHT.edgeClosedDeg);
  }
});

test('half pull works as a dimmer: the edge stops, never reopens, and the next pull adds on', () => {
  const m = createNightModel();
  m.setTarget(0.5);
  run(m, 4);
  const half = m.state.level;
  assert.ok(Math.abs(half - 0.5) < 1e-9, `level ${half}`);
  m.setTarget(0.2); // ratchet never goes back
  m.setTarget(Number.NaN);
  run(m, 1);
  assert.equal(m.state.level, half);
  m.setTarget(1);
  run(m, 4);
  assert.equal(m.state.level, 1);
});

test('reset restores without a ramp and without re-reporting milestones', () => {
  const m = createNightModel();
  m.reset(1);
  assert.equal(m.state.level, 1);
  assert.equal(m.state.edgeDeg, edgeForLevel(1));
  assert.deepEqual(run(m, 1), []);
  m.reset(0);
  m.setTarget(1);
  assert.deepEqual(run(m, 5), ['start', 'crickets', 'pool', 'closed']);
});

test('veil alpha: capped (0.62 / 0.45 soft), the pool keeps hands visible (<= 0.15 / 0.10), never full dark', () => {
  for (const soft of [false, true]) {
    const m = createNightModel({ highContrast: soft });
    m.setTarget(1);
    let peak = 0;
    for (let i = 0; i < 72 * 6; i++) {
      const s = m.step(DT);
      for (let th = 0; th <= 180; th += 3) {
        for (const n of [-5, 0, 5]) {
          for (const y of [-0.8, 0, 0.9]) {
            const a = veilAlpha(th, n, y, s);
            peak = Math.max(peak, a);
            if (th < NIGHT.poolDeg) assert.ok(a <= s.poolAlpha + 1e-12);
          }
        }
      }
    }
    assert.ok(peak <= (soft ? NIGHT.veilMaxSoft : NIGHT.veilMax) + 1e-12, `peak ${peak}`);
    assert.ok(peak > 0.4);
  }
});

test('flash safety: per-frame alpha change is tiny and the darkening is a single ramp (no blink)', () => {
  const m = createNightModel();
  m.setTarget(1); // worst case: instant pull
  const thetas = [15, 25, 40, 70, 110, 160];
  const prev = thetas.map(() => 0);
  const drop = thetas.map(() => 0);
  let maxDelta = 0;
  for (let i = 0; i < 72 * 6; i++) {
    const s = m.step(DT);
    thetas.forEach((th, k) => {
      const a = veilAlpha(th, 0, 0, s);
      maxDelta = Math.max(maxDelta, Math.abs(a - prev[k]));
      if (a < prev[k]) drop[k] += prev[k] - a;
      prev[k] = a;
    });
  }
  assert.ok(maxDelta < 0.02, `max per-frame delta ${maxDelta}`);
  // Only the ink lip fades after the front stops: well below a 10 % luminance swing.
  for (const d of drop) assert.ok(d <= NIGHT.lipAlpha + 1e-9, `drop ${d}`);
});

test('stars: deterministic, unit directions above the horizon, kite constellation first', () => {
  const a = nightStars();
  const b = nightStars();
  assert.deepEqual(a, b);
  assert.equal(a.length, NIGHT_STAR_COUNT);
  for (const s of a) {
    assert.ok(Math.abs(Math.hypot(s.dir.x, s.dir.y, s.dir.z) - 1) < 1e-9);
    assert.ok(s.dir.y > 0.05);
    assert.ok(s.size > 0 && s.size < 0.012);
  }
  // Kite stars sit towards the box (-Z in the sky frame).
  for (let i = 0; i < NIGHT_KITE_STARS; i++) assert.ok(a[i].dir.z < -0.8);
  assert.notDeepEqual(nightStars(1), a);
});

test('veil GLSL is multiview-safe and leaves the injected names alone', () => {
  const strip = (g: string) => g.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const g of [NIGHT_VEIL_VERT, NIGHT_VEIL_FRAG].map(strip)) {
    assert.doesNotMatch(g, /\b(?:uniform|varying|attribute)\s+\w+\s+(?:viewMatrix|projectionMatrix|modelViewMatrix|cameraPosition|modelMatrix|normalMatrix)\b/);
    assert.doesNotMatch(g, /\bsampler2D\b|#version|\btexture\s*\(/);
  }
  assert.doesNotMatch(strip(NIGHT_VEIL_FRAG), /\b(?:modelViewMatrix|projectionMatrix|normalMatrix|uTime)\b/);
  assert.match(NIGHT_VEIL_FRAG, /#include <colorspace_fragment>/);
});

// Sweeps every direction the veil can show (theta 0..180, ink noise +-5) for one state.
function peakAlpha(st: Parameters<typeof veilAlpha>[3]): number {
  let peak = 0;
  for (let th = 0; th <= 180; th += 1) {
    for (const n of [-NIGHT.edgeNoiseDeg, 0, NIGHT.edgeNoiseDeg]) {
      for (const y of [-0.9, 0, 0.9]) peak = Math.max(peak, veilAlpha(th, n, y, st));
    }
  }
  return peak;
}

test('bug: open veil is clear everywhere, so showing the mesh never pops a dark patch behind the head', () => {
  const m = createNightModel();
  assert.equal(peakAlpha(m.state), 0);
  m.setTarget(0.25);
  const first = m.step(DT); // first frame the mesh becomes visible
  assert.ok(first.level > 0);
  assert.ok(peakAlpha(first) < 0.01, `first visible frame peak ${peakAlpha(first)}`);
  // reset(0) after a night is also clear.
  m.reset(0);
  assert.equal(peakAlpha(m.state), 0);
});

test('bug: F1 (arte §10) per pixel <= 0.40 alpha in any 333 ms window and 10->90 % ramp >= 300 ms', () => {
  for (const calm of [false, true]) {
    const m = createNightModel({ calm });
    m.setTarget(1);
    const thetas = [15, 25, 40, 70, 110, 160, 180];
    const hist = thetas.map(() => [] as number[]);
    for (let i = 0; i < 72 * 8; i++) {
      const s = m.step(DT);
      thetas.forEach((th, k) => hist[k].push(veilAlpha(th, 0, 0.3, s)));
    }
    const win = Math.round(0.333 / DT);
    hist.forEach((h, k) => {
      for (let i = win; i < h.length; i++) {
        assert.ok(Math.abs(h[i] - h[i - win]) <= 0.4, `calm=${calm} theta ${thetas[k]}: ${h[i] - h[i - win]}`);
      }
      const end = h[h.length - 1];
      if (end < 0.3) return;
      const t10 = h.findIndex((a) => a >= 0.1 * end);
      const t90 = h.findIndex((a) => a >= 0.9 * end);
      assert.ok((t90 - t10) * DT >= 0.3, `calm=${calm} theta ${thetas[k]}: 10->90 in ${(t90 - t10) * DT}s`);
    });
  }
});

test('bug: switching Calm / high contrast at night eases the caps instead of stepping the room', () => {
  const m = createNightModel();
  m.setTarget(1);
  run(m, 5);
  assert.equal(m.state.veilMax, NIGHT.veilMax);
  let prevA = veilAlpha(60, 0, 0, m.state);
  m.setMode({ calm: true });
  assert.equal(m.state.veilMax, NIGHT.veilMax, 'no step on the switch itself');
  let maxDelta = 0;
  for (let i = 0; i < 72 * 3; i++) {
    const a = veilAlpha(60, 0, 0, m.step(DT));
    maxDelta = Math.max(maxDelta, Math.abs(a - prevA));
    prevA = a;
  }
  assert.ok(maxDelta <= NIGHT.capRate * DT + 1e-9, `cap delta ${maxDelta}`);
  assert.equal(m.state.veilMax, NIGHT.veilMaxSoft);
  assert.equal(m.state.poolAlpha, NIGHT.poolAlphaSoft);
  // Daytime switch (veil hidden) and reset take the mode at once.
  const d = createNightModel();
  d.setMode({ highContrast: true });
  assert.equal(d.state.veilMax, NIGHT.veilMaxSoft);
  m.setMode({});
  m.reset(1);
  assert.equal(m.state.veilMax, NIGHT.veilMax);
});

test('bug: star fade and spark/pose inputs survive NaN, huge dt and out-of-range values', () => {
  assert.equal(nightStarVisibility(0, 1, Number.NaN), 0);
  assert.equal(nightStarVisibility(Number.NaN, 1, DT) >= 0, true);
  // A 2 s hitch moves at most one clamped step (0.1 s), never pops the sky.
  const hitch = nightStarVisibility(0, 1, 2);
  assert.ok(hitch > 0 && hitch < 0.2, `hitch ${hitch}`);
  assert.equal(nightStarVisibility(0.5, NIGHT_STAR_FROM, 0.1) < 0.5, true);
  let v = 0;
  for (let i = 0; i < 72 * 10; i++) v = nightStarVisibility(v, 7, DT);
  assert.ok(Math.abs(v - 1) < 1e-3 && v <= 1);
  assert.equal(sparkIntensity(Number.NaN), 0);
  assert.equal(sparkIntensity(Number.POSITIVE_INFINITY), 0);
  assert.equal(sparkIntensity(3), 1);
  assert.equal(sparkIntensity(-1), 0);
  assert.equal(finiteVec3({ x: 0, y: Number.NaN, z: 0 }), false);
  assert.equal(finiteVec3({ x: 0, y: 1.6, z: 0 }), true);
  // Model: NaN / negative / huge dt never move the edge backwards or past the cap.
  const m = createNightModel();
  m.setTarget(1);
  m.step(Number.NaN);
  assert.equal(m.state.level, 0);
  m.step(-1);
  assert.equal(m.state.level, 0);
  m.step(1e9);
  assert.ok(m.state.edgeDeg >= NIGHT.edgeOpenDeg - NIGHT.maxEdgeSpeedDegS * 0.1 - 1e-9);
  for (const k of Object.values(m.state)) if (typeof k === 'number') assert.ok(Number.isFinite(k));
});

test('veil GLSL constants mirror NIGHT (band, noise, pool, ramp, speed, lip, sky)', () => {
  const num = (re: RegExp): number => {
    const mm = NIGHT_VEIL_FRAG.match(re);
    assert.ok(mm, `missing ${re}`);
    return Number(mm[1]);
  };
  assert.equal(num(/VEIL_BAND = ([\d.]+);/), NIGHT.edgeBandDeg);
  assert.equal(num(/VEIL_POOL_DEG = ([\d.]+);/), NIGHT.poolDeg);
  assert.equal(num(/VEIL_RAMP_DEG = ([\d.]+);/), NIGHT.nightRampDeg);
  assert.equal(num(/VEIL_MAX_SPEED = ([\d.]+);/), NIGHT.maxEdgeSpeedDegS);
  assert.equal(num(/float n = ([\d.]+) \* \(2\.0 \* paperFbm/), NIGHT.edgeNoiseDeg);
  assert.equal(num(/float lip = ([\d.]+) \* exp/), NIGHT.lipAlpha);
  assert.equal(num(/float sky = ([\d.]+) \* smoothstep/), NIGHT.skyAlpha);
});
