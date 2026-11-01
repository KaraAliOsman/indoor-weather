// Post-build guard for the public build.
//  - the IWER emulator must never ship to the judges' Quest
//  - the bundle must stay under the size budget (fast start)
// Usage: node tools/check-dist.mjs [distDir]
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] ?? 'dist');
// Startup = entry script + modulepreloads referenced by index.html (what the
// Quest downloads before the Enter AR button works). Lazy chunks (fonts,
// physics wasm, workers) only load if used and count toward the total only.
// Baselines measured 2026-10-31 (M0) + headroom. Raise only on purpose.
const MAX_STARTUP_BYTES = 2.6 * 1024 * 1024;
const MAX_TOTAL_BYTES = 13 * 1024 * 1024;
const FORBIDDEN = ['Immersive Web Emulation Runtime', 'IWER_DEVICE', '__iwer_mcp', '@iwer/devui'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist);
const problems = [];
let total = 0;
for (const file of files) {
  const size = fs.statSync(file).size;
  total += size;
  if (/\.(js|html|css)$/.test(file)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) problems.push(`${path.relative(dist, file)} contains "${needle}"`);
    }
  }
}
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
if (total > MAX_TOTAL_BYTES) problems.push(`dist is ${mb(total)}, budget ${mb(MAX_TOTAL_BYTES)}`);

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const startupRefs = [
  ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
  ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g),
].map((m) => m[1]);
let startup = 0;
for (const ref of startupRefs) {
  if (/^(https?:)?\/\//.test(ref)) {
    problems.push(`index.html references cross-origin ${ref}`);
    continue;
  }
  const rel = ref.replace(/^\.?\//, '').replace(process.env.VITE_BASE_PATH?.replace(/^\//, '') ?? '', '');
  const file = path.join(dist, rel);
  if (!fs.existsSync(file)) problems.push(`index.html references missing ${ref}`);
  else startup += fs.statSync(file).size;
}
if (startup > MAX_STARTUP_BYTES) problems.push(`startup JS is ${mb(startup)}, budget ${mb(MAX_STARTUP_BYTES)}`);

console.log(`check-dist: ${files.length} files, total ${mb(total)}, startup ${mb(startup)} (${startupRefs.length} files)`);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('  ✓ no emulator in build, no cross-origin entry, sizes within budget');
