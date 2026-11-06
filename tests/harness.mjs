// Tiny test harness: no dependencies. Each *.test.mjs imports { test, eq, near, ok, done }.
let pass = 0, fail = 0, group = '';
export const ok = (c, msg = 'assertion failed') => { if (!c) throw new Error(msg); };
export const eq = (a, b, msg = '') => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
export const near = (a, b, tol, msg = '') => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} expected ${b} +-${tol}, got ${a}`); };
export const throws = (fn, re, msg = '') => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${msg} wrong error: ${e.message}`); return; } throw new Error(`${msg} did not throw`); };
export function test(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`  FAIL ${group}${name}: ${e.message}`); }
}
export function suite(name) { group = name + ' / '; }
export function done(file) {
  console.log(`TESTS ${file}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
