// node tests/run.mjs [--ui]   Runs every tests/*.test.mjs (plus research/art/cfg-check.mjs) and tallies the results.
// --ui additionally runs tests/ui-sweep.mjs (Playwright browser sweep; skipped when Playwright is not installed).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
const node = process.execPath;
const run = (file, args = []) => spawnSync(node, [file, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
let pass = 0, fail = 0, failedFiles = [];

const gen = run(join(here, 'make-fixtures.mjs'));
if (gen.status) { console.log(gen.stdout + gen.stderr); process.exit(1); }

const files = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort().map(f => join(here, f));
files.push(join(root, 'research/art/cfg-check.mjs'));
if (process.argv.includes('--ui')) files.push(join(here, 'ui-sweep.mjs'));
for (const f of files) {
  const t0 = Date.now(), r = run(f), out = r.stdout + r.stderr, name = f.replace(root + '/', '');
  const m = out.match(/TESTS \S+: (\d+) passed, (\d+) failed/);
  if (m) { pass += +m[1]; fail += +m[2]; } else if (r.status === 0) pass += 1; else fail += 1;   // cfg-check has its own summary: ALL OK / exit code
  const bad = r.status !== 0;
  console.log(`${bad ? 'FAIL' : 'ok  '} ${name}  ${m ? `${m[1]} passed, ${m[2]} failed` : bad ? 'exit ' + r.status : 'all checks passed'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (bad) { failedFiles.push(name); console.log(out.split('\n').filter(l => /FAIL|Error|issues|expected/.test(l)).slice(0, 25).join('\n')); }
}
console.log(`\n${pass} checks passed, ${fail} failed across ${files.length} files`);
process.exit(fail || failedFiles.length ? 1 : 0);
