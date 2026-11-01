/**
 * U-glsl: our shaders stay multiview-safe and the codebase never reaches for
 * the material/loader APIs we ruled out (docs/architecture-m1.md §2, §8.1).
 *
 * IWER does not emulate multiview, so this lint plus checkShaderErrors in the
 * E2E runs are the only automatic guard before a real Quest.
 *
 * declaredIdentifiers() is adapted from immersive-web-sdk,
 * packages/core/tests/environment/gradient-environment.test.ts:
 *   Copyright (c) Meta Platforms, Inc. and affiliates.
 *   This source code is licensed under the MIT license.
 * Changes: precision qualifiers, int/uint/bool vector types and array
 * declarators are recognised.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GLSL_DIR = join(ROOT, 'src', 'render', 'glsl');
const SRC_DIR = join(ROOT, 'src');

/**
 * Declared by three's WebGLProgram prefix for every ShaderMaterial
 * (nm/three/src/renderers/webgl/WebGLProgram.js:662-693). In multiview the
 * matrices become per-view arrays behind #defines (:896-937): redeclaring any
 * of these breaks compilation in XR only.
 */
const INJECTED = [
  'modelMatrix',
  'modelViewMatrix',
  'projectionMatrix',
  'viewMatrix',
  'normalMatrix',
  'cameraPosition',
  'isOrthographic',
  'position',
  'normal',
  'uv',
  'instanceMatrix',
  'instanceColor',
  'color',
];
/** Per-view arrays that only exist in the multiview VERTEX prefix. */
const VERTEX_ONLY = ['modelViewMatrix', 'normalMatrix', 'projectionMatrix'];
const FORBIDDEN_GLSL: ReadonlyArray<[RegExp, string]> = [
  [/#version\b/, '#version (three adds it)'],
  // canon §11: the only textures are CPU-written data maps; no image is ever sampled.
  [/\bsampler2D\s+(?!uWetTex\b|uNoiseTex\b)\w+/, 'a sampler2D other than uWetTex / uNoiseTex'],
  [/\btexture\s*\(/, 'texture()'],
  [/\btexture2D\s*\(\s*(?!uWetTex\b|uNoiseTex\b)/, 'texture2D() on anything but uWetTex / uNoiseTex'],
  [/\bgl_DrawID\b/, 'gl_DrawID (no BatchedMesh)'],
];
const ALLOWED_INCLUDES = new Set(['tonemapping_fragment', 'colorspace_fragment']);
/** Case-sensitive identifiers banned from src/ ("Draco/KTX2" prose must not trip it). */
const FORBIDDEN_TS = ['RawShaderMaterial', 'TextureLoader', 'DRACOLoader', 'KTX2Loader'];

const PRECISION = String.raw`(?:(?:lowp|mediump|highp)\s+)?`;
const TYPE = String.raw`(?:float|int|uint|bool|[biu]?vec[234]|mat[234](?:x[234])?)`;
const STORAGE_DECL = new RegExp(
  String.raw`\b(?:uniform|varying|attribute|in|out)\s+${PRECISION}(\w+)\s+(\w+)\s*(\[\s*\w+\s*\])?\s*;`,
  'g',
);
const LOCAL_DECL = new RegExp(String.raw`\b${PRECISION}${TYPE}\s+(\w+)\s*(?:[=;,)(]|\[)`, 'g');

function declaredIdentifiers(glsl: string): string[] {
  return [...[...glsl.matchAll(STORAGE_DECL)].map((m) => m[2]), ...[...glsl.matchAll(LOCAL_DECL)].map((m) => m[1])];
}

/** qualifier → name → "type[size]" for uniform/varying/attribute declarations. */
function storage(glsl: string, qualifier: 'uniform' | 'varying' | 'attribute'): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of glsl.matchAll(STORAGE_DECL)) {
    if (!m[0].startsWith(qualifier)) continue;
    out.set(m[2], `${m[1]}${(m[3] ?? '').replace(/\s+/g, '')}`);
  }
  return out;
}

/** GLSL without comments, so prose never trips a rule. */
function code(glsl: string): string {
  return glsl.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

interface Shader {
  module: string;
  name: string;
  kind: 'VERT' | 'FRAG' | 'CHUNK';
  /** Name without the _VERT/_FRAG/_CHUNK suffix (pairs vertex and fragment). */
  stem: string;
  glsl: string;
}

async function loadShaders(): Promise<Shader[]> {
  const files = readdirSync(GLSL_DIR).filter((f) => f.endsWith('.ts')).sort();
  assert.ok(files.length > 0, 'no GLSL modules found');
  const shaders: Shader[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(GLSL_DIR, file)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      assert.equal(typeof value, 'string', `${file}: ${name} must be a GLSL string (glsl modules export only strings)`);
      const m = /^([A-Z0-9_]+)_(VERT|FRAG|CHUNK)$/.exec(name);
      assert.ok(m, `${file}: ${name} must be named X_VERT, X_FRAG or X_CHUNK`);
      shaders.push({ module: file, name, kind: m[2] as Shader['kind'], stem: m[1], glsl: code(value as string) });
    }
  }
  return shaders;
}

const shadersPromise = loadShaders();

test('self-test: the declaration regex catches redeclared injected names', () => {
  assert.ok(declaredIdentifiers('uniform mat4 viewMatrix;').includes('viewMatrix'));
  assert.ok(declaredIdentifiers('uniform highp mat4 projectionMatrix;').includes('projectionMatrix'));
  assert.ok(declaredIdentifiers('uniform mat3 normalMatrix[2];').includes('normalMatrix'));
  assert.ok(declaredIdentifiers('uniform vec3 cameraPosition;').includes('cameraPosition'));
  assert.ok(declaredIdentifiers('attribute vec3 position;').includes('position'));
  assert.ok(declaredIdentifiers('void main() { vec3 normal = vec3(0.0); }').includes('normal'));
  assert.ok(declaredIdentifiers('float f(vec3 color) { return 1.0; }').includes('color'));
  // Plain use is not a declaration.
  assert.deepEqual(
    declaredIdentifiers('void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'),
    [],
  );
});

test('self-test: the source grep is case-sensitive and per identifier', () => {
  const hit = (s: string) => FORBIDDEN_TS.some((id) => new RegExp(String.raw`\b${id}\b`).test(s));
  assert.equal(hit('Draco/KTX2/meshopt are never used'), false);
  assert.equal(hit('new RawShaderMaterial({})'), true);
  assert.equal(hit('import { DRACOLoader } from "x"'), true);
});

test('GLSL modules export the expected shaders', async () => {
  const names = (await shadersPromise).map((s) => s.name);
  for (const expected of ['NOISE_CHUNK', 'PAPER_VERT', 'PAPER_CHUNK', 'PAPER_FRAG', 'LEAVES_VERT', 'LEAVES_FRAG']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('no shader declares an identifier that three injects', async () => {
  for (const s of await shadersPromise) {
    const clash = declaredIdentifiers(s.glsl).filter((id) => INJECTED.includes(id));
    assert.deepEqual(clash, [], `${s.module}:${s.name} declares ${clash.join(', ')}`);
  }
});

test('no #version, no sampler but the data maps, no gl_DrawID; only allowed #includes', async () => {
  for (const s of await shadersPromise) {
    for (const [re, what] of FORBIDDEN_GLSL) assert.ok(!re.test(s.glsl), `${s.module}:${s.name} uses ${what}`);
    for (const m of s.glsl.matchAll(/#include\s*<(\w+)>/g)) {
      assert.ok(ALLOWED_INCLUDES.has(m[1]), `${s.module}:${s.name} includes <${m[1]}>`);
    }
  }
});

test('*_VERT writes gl_Position, *_FRAG writes gl_FragColor', async () => {
  for (const s of await shadersPromise) {
    if (s.kind === 'VERT') {
      assert.match(s.glsl, /\bgl_Position\s*=/, `${s.name} never writes gl_Position`);
      assert.doesNotMatch(s.glsl, /\bgl_FragColor\b/, `${s.name} writes gl_FragColor`);
    }
    if (s.kind === 'FRAG') {
      assert.match(s.glsl, /\bgl_FragColor\s*=/, `${s.name} never writes gl_FragColor`);
      assert.doesNotMatch(s.glsl, /\bgl_Position\b/, `${s.name} touches gl_Position`);
    }
  }
});

test('fragment code never uses the per-view vertex matrices', async () => {
  for (const s of await shadersPromise) {
    if (s.kind === 'VERT') continue;
    for (const id of VERTEX_ONLY) {
      assert.doesNotMatch(s.glsl, new RegExp(String.raw`\b${id}\b`), `${s.module}:${s.name} uses ${id}`);
    }
  }
});

test('naming: attributes a*, uniforms u*, varyings v*', async () => {
  for (const s of await shadersPromise) {
    for (const name of storage(s.glsl, 'attribute').keys()) assert.match(name, /^a[A-Z]/, `${s.name}: attribute ${name}`);
    for (const name of storage(s.glsl, 'uniform').keys()) assert.match(name, /^u[A-Z]/, `${s.name}: uniform ${name}`);
    for (const name of storage(s.glsl, 'varying').keys()) assert.match(name, /^v[A-Z]/, `${s.name}: varying ${name}`);
  }
});

test('every varying a *_FRAG reads is written by its *_VERT with the same type', async () => {
  const shaders = await shadersPromise;
  const frags = shaders.filter((s) => s.kind === 'FRAG');
  assert.ok(frags.length > 0);
  for (const frag of frags) {
    const vert = shaders.find((s) => s.kind === 'VERT' && s.stem === frag.stem);
    assert.ok(vert, `${frag.name} has no ${frag.stem}_VERT`);
    const out = storage(vert.glsl, 'varying');
    for (const [name, type] of storage(frag.glsl, 'varying')) {
      assert.equal(out.get(name), type, `${frag.name} reads varying ${type} ${name}; ${vert.name} declares ${out.get(name)}`);
      assert.match(vert.glsl, new RegExp(String.raw`\b${name}\s*=[^=]`), `${vert.name} never writes ${name}`);
    }
  }
});

test('a uniform shared by several shaders has one type everywhere', async () => {
  const seen = new Map<string, { type: string; where: string }>();
  for (const s of await shadersPromise) {
    for (const [name, type] of storage(s.glsl, 'uniform')) {
      const prev = seen.get(name);
      if (prev) assert.equal(type, prev.type, `uniform ${name}: ${type} in ${s.name}, ${prev.type} in ${prev.where}`);
      else seen.set(name, { type, where: s.name });
    }
  }
});

test('braces and parentheses are balanced', async () => {
  for (const s of await shadersPromise) {
    for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']]) {
      let depth = 0;
      for (const ch of s.glsl) {
        if (ch === open) depth++;
        else if (ch === close) depth--;
        assert.ok(depth >= 0, `${s.name}: unexpected '${close}'`);
      }
      assert.equal(depth, 0, `${s.name}: unbalanced '${open}${close}'`);
    }
  }
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

test('src/**/*.ts never uses the banned material and loader classes', () => {
  const files = walk(SRC_DIR);
  assert.ok(files.length > 0);
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const id of FORBIDDEN_TS) {
      if (new RegExp(String.raw`\b${id}\b`).test(text)) hits.push(`${relative(ROOT, file)}: ${id}`);
    }
  }
  assert.deepEqual(hits, []);
});
