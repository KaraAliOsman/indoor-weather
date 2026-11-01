import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { installMesaSem, MESA_DEFAULT, type MesaSemConfig } from '../../src/debug/mesa-sem.ts';

interface Sem {
  version: string;
  computeHitTestResults(m: ArrayLike<number>): Float32Array[];
  computeDepthBuffer(): null;
  render(time: number): void;
  readonly trackedPlanes: Set<unknown>;
  readonly trackedMeshes: Set<unknown>;
}

type SemCtor = new (device: unknown) => Sem;

const g = globalThis as unknown as { window?: unknown };
let captured: SemCtor | null = null;

beforeEach(() => {
  captured = null;
  g.window = {
    IWER_DEVICE: {
      installSEM(ctor: SemCtor) {
        captured = ctor;
      },
    },
  };
});

afterEach(() => {
  delete g.window;
});

/** Install and construct the SEM the way IWER does (`new semConstructor(device)`). */
function install(cfg: MesaSemConfig = MESA_DEFAULT): Sem {
  installMesaSem(cfg);
  assert.ok(captured, 'installSEM was called');
  return new captured({});
}

const DEG = Math.PI / 180;

/**
 * Column-major ray matrix as the native XRRay.matrix composes it: rotation
 * R = Ry(yaw) * Rx(pitch) (maps -Z onto the ray direction) plus translation.
 */
function rayMatrix(origin: [number, number, number], yawDeg: number, pitchDeg: number): Float32Array {
  const cy = Math.cos(yawDeg * DEG), sy = Math.sin(yawDeg * DEG);
  const cp = Math.cos(pitchDeg * DEG), sp = Math.sin(pitchDeg * DEG);
  // Columns of Ry * Rx.
  const x = [cy, 0, -sy];
  const y = [sy * sp, cp, cy * sp];
  const z = [sy * cp, -sp, cy * cp];
  return new Float32Array([...x, 0, ...y, 0, ...z, 0, ...origin, 1]);
}

function position(m: Float32Array): [number, number, number] {
  return [m[12]!, m[13]!, m[14]!];
}

function assertNear(actual: number, expected: number, tol: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} vs ${expected} (±${tol})`);
}

test('mesa-sem: ray matrix helper points the way IWSDK reads it', () => {
  const m = rayMatrix([0, 1.2, 0], 30, -40);
  // direction = -(column Z)
  assertNear(-m[8]!, -Math.sin(30 * DEG) * Math.cos(40 * DEG), 1e-6, 'dx');
  assertNear(-m[9]!, -Math.sin(40 * DEG), 1e-6, 'dy');
  assertNear(-m[10]!, -Math.cos(30 * DEG) * Math.cos(40 * DEG), 1e-6, 'dz');
});

test('mesa-sem: a seated head looking 30° left and 40° down hits the table', () => {
  const sem = install();
  const hits = sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 30, -40));
  assert.equal(hits.length, 1);
  const hit = hits[0]!;
  const [x, y, z] = position(hit);
  assertNear(x, -0.274, 0.001, 'x');
  assertNear(y, 0.74, 1e-6, 'y');
  assertNear(z, -0.475, 0.001, 'z');
  // Identity rotation: the pose +Y (IWSDK's hit normal) is up.
  assert.deepEqual([...hit.subarray(0, 12)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  assert.equal(hit[15], 1);
});

test('mesa-sem: rays that do not go down never hit', () => {
  const sem = install();
  assert.deepEqual(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 0, 10)), []);
  assert.deepEqual(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 0, 0)), []);
});

test('mesa-sem: outside the table rectangle the ray lands on the floor', () => {
  const sem = install();
  // Looking backwards (+Z) and 70° down: the table plane is crossed at z ≈ 0.17 (> maxZ).
  const hits = sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 180, -70));
  assert.equal(hits.length, 1);
  const [x, y, z] = position(hits[0]!);
  assertNear(x, 0, 1e-6, 'x');
  assert.equal(y, 0);
  assertNear(z, 1.2 / Math.tan(70 * DEG), 0.001, 'z');
});

test('mesa-sem: floor disabled returns nothing outside the table', () => {
  const sem = install({ ...MESA_DEFAULT, floor: false });
  assert.deepEqual(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 180, -70)), []);
  assert.equal(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 30, -40)).length, 1);
});

test("mesa-sem: kind 'empty' grants hit-test but never finds a surface", () => {
  const sem = install({ ...MESA_DEFAULT, kind: 'empty' });
  assert.deepEqual(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 30, -40)), []);
  assert.deepEqual(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 180, -70)), []);
});

test('mesa-sem: implements the rest of the SEM surface without a DOM', () => {
  const sem = install();
  assert.equal(sem.version, 'mesa-1');
  assert.equal(sem.computeDepthBuffer(), null);
  assert.equal(sem.trackedPlanes.size, 0);
  assert.equal(sem.trackedMeshes.size, 0);
  sem.render(0);
});

test('mesa-sem: without IWER_DEVICE it warns and does nothing', (t) => {
  g.window = {};
  const warn = t.mock.method(console, 'warn', () => {});
  installMesaSem(MESA_DEFAULT);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(captured, null);
});

test('mesa-sem: the installer is self-contained (safe for Function.toString())', () => {
  const src = installMesaSem.toString();
  // Rebuild it from source in an empty scope: any module-level reference would throw.
  const rebuilt = new Function(`return (${src});`)() as typeof installMesaSem;
  rebuilt(MESA_DEFAULT);
  assert.ok(captured);
  const sem = new captured({});
  assert.equal(sem.computeHitTestResults(rayMatrix([0, 1.2, 0], 30, -40)).length, 1);
});
