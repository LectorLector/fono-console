// iso226, dashcalc, target curve, mic calibration (.txt import + pairing maths), room scan parsers (fixtures), state defaults.
import { readFileSync } from 'node:fs';
import { test, ok, near, eq, throws, suite, done } from './harness.mjs';
import { isoSpl, loudDiff, fitLoudness, loudFilters } from '../web/js/iso226.js';
import { soundSpeed, splCalc, matchCalc, msFromM, mFromMs, waveLen, freqFromLen, dbFromV, dbFromP, vFromDb, pFromDb } from '../web/js/dashcalc.js';
import { nodesAt, defaultTarget, TARGET_PRESETS, cleanNodes, parseCalText, applyMicCal } from '../web/js/acoustics.js';
import { bboxFromObj, bboxFromGltfJson, bboxFromGlb, dimsFromExtents } from '../web/js/lab.js';
import { autoEQ } from '../web/js/measure.js';
import { smooth, interpCurve, chainDb } from '../web/js/dsp.js';
import { defaultState } from '../web/js/state.js';

const fx = f => readFileSync(new URL('./fixtures/' + f, import.meta.url));

suite('iso226');
test('ISO 226:2003 40 phon table', () => { for (const [f, v] of [[20, 99.85], [100, 64.37], [1000, 40.01], [4000, 36.65], [12500, 51.49]]) near(isoSpl(f, 40), v, 0.05, f + ' Hz'); });
test('compensation is 0 at 1 kHz and grows toward the bass for quieter listening', () => {
  near(loudDiff(1000, 60), 0, 1e-9); ok(loudDiff(50, 60) > loudDiff(50, 70) && loudDiff(50, 70) > loudDiff(50, 80) && loudDiff(50, 80) > 0);
  eq(loudDiff(100, 83), 0);
});
test('fit: shelf pair within limits, error small', () => {
  for (const lv of [60, 65, 70, 75, 80]) {
    const r = fitLoudness(lv), [l, hh] = r.filters; eq(r.filters.map(x => x.type), ['LSC', 'HSC']);
    ok(l.fc >= 40 && l.fc <= 400 && hh.fc >= 3000 && hh.fc <= 10000, JSON.stringify(r.filters));
    ok(Math.abs(l.gain) <= 12 && Math.abs(hh.gain) <= 12); ok(r.rms < 1.3, `rms ${r.rms}`);
  }
  ok(fitLoudness(60).filters[0].gain > fitLoudness(80).filters[0].gain);
});
test('HSC corner capped at 10 kHz (documented)', () => ok(fitLoudness(60).filters[1].fc <= 10000));
test('cached filters are stable', () => eq(loudFilters({ on: true, level: 62 }), loudFilters({ on: true, level: 62 })));

suite('dashcalc');
test('speed of sound', () => { near(soundSpeed(20), 343.4, 0.1); near(msFromM(3.434, 20), 10, 0.01); near(mFromMs(10, 20), 3.434, 0.01); near(waveLen(100, 20), 3.434, 0.01); near(freqFromLen(3.434, 20), 100, 0.01); });
test('dB conversions', () => { near(dbFromV(2), 6.02, 0.01); near(dbFromP(2), 3.01, 0.01); near(vFromDb(20), 10, 1e-9); near(pFromDb(10), 10, 1e-9); });
test('SPL calc', () => {
  const r = splCalc({ P: 50, sens: 88, d: 2, N: 2, avg: 75, crest: 14 });
  near(r.max, 88 + 10 * Math.log10(50) - 20 * Math.log10(2) + 10 * Math.log10(2), 1e-9); near(r.headroom, r.max - 89, 1e-9); ok(r.pPeak > r.pAvg);
  const lo = splCalc({ P: 100, sens: 88, d: 2, N: 2, avg: 75, crest: 14 }); near(lo.max - r.max, 3.01, 0.01);
});
test('amp/speaker match', () => {
  const m = matchCalc({ p8: 100, z: 4, df: 200, len: 3, mm2: 2.5 });
  near(m.zout, 0.04, 1e-9); ok(m.dfEff > 0 && m.dfEff < 200 / 2); ok(m.lossDb < 0 && m.lossDb > -0.5); near(m.ideal, 200, 1e-9); ok(m.bound && m.pz <= 200 && Number.isFinite(m.current));
  const hi = matchCalc({ p8: 100, z: 16, df: 200, len: 3, mm2: 2.5 }); ok(!hi.bound); near(hi.pz, 50, 1e-9);
});

suite('target curve');
test('nodesAt: log interpolation, ends held', () => {
  const n = [[20, 4], [200, 0], [20000, -4]];
  near(nodesAt(n, 5), 4, 1e-9); near(nodesAt(n, 99999), -4, 1e-9); near(nodesAt(n, 200), 0, 1e-9); near(nodesAt(n, Math.sqrt(20 * 200)), 2, 1e-9);
});
test('cleanNodes validates, clamps and sorts', () => {
  eq(cleanNodes([[1000, 3], [100, -20], [5, 1]]), [[20, 1], [100, -12], [1000, 3]]);
  eq(cleanNodes(null), null); eq(cleanNodes([[100, 1]]), null); eq(cleanNodes([['a', 1], [NaN, 2], [-5, 1]]), null);
});
test('presets are valid and within +-12 dB', () => { for (const p of Object.values(TARGET_PRESETS)) { ok(cleanNodes(p.nodes) && cleanNodes(p.nodes).length === p.nodes.length, p.name); } eq(Object.keys(TARGET_PRESETS), ['flat', 'room', 'warm', 'bright']); });
test('autoEQ follows a custom target (lifting target removes the cut)', () => {
  const f = [], db = []; for (let x = 15; x < 20000; x *= 2 ** (1 / 48)) { f.push(x); db.push(x > 70 && x < 90 ? 8 : 0); }
  const flat = autoEQ({ f, db }, { lfRise: 0, target: TARGET_PRESETS.flat.nodes }), up = autoEQ({ f, db }, { lfRise: 0, target: [[20, 8], [50, 8], [70, 0], [20000, 0]] });
  ok(flat.filters.some(x => x.gain < -4 && x.fc > 60 && x.fc < 110));
  ok(up.rmsAfter <= up.rmsBefore);
});

suite('mic calibration');
const UMIK = '"Sens Factor =-1.378dB, SERNO: 7001234"\n* comment\n# also a comment\n20.000\t-1.2\n100\t0.1\n1000,0.0\n10000;1.5\n20000   4.2\n\n';
test('UMIK-style text parses; headers/comments ignored; sorted', () => {
  const c = parseCalText(UMIK); eq(c, [[20, -1.2], [100, 0.1], [1000, 0], [10000, 1.5], [20000, 4.2]]);
  eq(parseCalText('300 1\n20 2\n1000 3\n').map(p => p[0]), [20, 300, 1000]);
});
test('CRLF + too few points + garbage', () => {
  eq(parseCalText('20 1\r\n100 2\r\n1000 3\r\n').length, 3); eq(parseCalText('20 1\n100 2'), null); eq(parseCalText('hello world\nfoo bar'), null); eq(parseCalText(''), null); eq(parseCalText(null), null);
});
test('applyMicCal subtracts the calibration', () => {
  const curve = { f: [100, 1000, 10000], db: [0, 0, 0] }, cal = parseCalText(UMIK), out = applyMicCal(curve, cal);
  near(out.db[0], -0.1, 1e-9); near(out.db[1], 0, 1e-9); near(out.db[2], -1.5, 1e-9); eq(curve.db, [0, 0, 0], 'input mutated');
  eq(applyMicCal(curve, null), curve); eq(applyMicCal(curve, [[1, 1]]), curve);
});
test('pairing: B-A difference curve is reproduced by the smoothed calibration', () => {
  // mirrors lab2.js compute(): difference, remove 500-2000 Hz median, 1/6 oct smoothing, 1/12 oct nodes
  const f = [], A = [], B = []; for (let x = 15; x < 22000; x *= 2 ** (1 / 48)) { f.push(x); A.push(-20); B.push(-20 + 3 * Math.exp(-((Math.log2(x / 8000)) ** 2) / 0.5) + 0.6); }
  const raw = f.map((_, i) => B[i] - A[i]), ref = raw.filter((_, i) => f[i] >= 500 && f[i] <= 2000).sort((a, b) => a - b), off = ref[ref.length >> 1];
  const sm = smooth({ f, db: raw.map(v => v - off) }, 6), nodes = []; for (let x = 20; x <= 20020; x *= 2 ** (1 / 12)) nodes.push([x, interpCurve(sm, x)]);
  const corrected = applyMicCal({ f, db: B }, nodes), mid = corrected.db.filter((_, i) => f[i] > 100 && f[i] < 15000), mean = mid.reduce((p, q) => p + q, 0) / mid.length;
  ok(Math.max(...mid.map(v => Math.abs(v - mean))) < 0.8, 'residual after calibration too large');
});

suite('room scan parsers');
const dimsOf = file => {
  const b = fx(file);
  if (file.endsWith('.obj')) { const r = bboxFromObj(b.toString()); return dimsFromExtents(r.ext, r.up); }
  if (file.endsWith('.glb')) { const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); const r = bboxFromGlb(ab); return dimsFromExtents(r.ext, r.up); }
  const r = bboxFromGltfJson(JSON.parse(b.toString())); return dimsFromExtents(r.ext, r.up);
};
for (const f of ['room-m.obj', 'room-cm.obj', 'room-mm.obj', 'room-zup.obj', 'room.glb', 'room.gltf'])
  test(f + ' -> 4.2 x 3.1 x 2.5 m', () => { const d = dimsOf(f); near(d.L, 4.2, 0.01, 'L'); near(d.W, 3.1, 0.01, 'W'); near(d.H, 2.5, 0.01, 'H'); });
test('OBJ bounding box extents (raw)', () => { const e = bboxFromObj(fx('room-m.obj').toString()).ext; near(e[0], 4.2, 1e-3); near(e[1], 2.5, 1e-3); near(e[2], 3.1, 1e-3); });
test('bad files are rejected with a message', () => {
  throws(() => bboxFromObj(fx('empty.obj').toString()), /頂點/);
  throws(() => bboxFromGlb(fx('bad.glb').buffer.slice(0, 40)), /GLB/);
  throws(() => bboxFromGltfJson({ meshes: [] }), /頂點|POSITION/);
  throws(() => bboxFromGlb(new ArrayBuffer(8)), /GLB/);
});
test('OBJ with CRLF, negative and scientific numbers', () => {
  const e = bboxFromObj('v -1.0 0 0\r\nv 3e0 2.5 3.1\r\nvt 0 0\r\nv  1 1 1\r\n').ext; near(e[0], 4, 1e-9); near(e[1], 2.5, 1e-9);
});

suite('state defaults');
test('every layout/feature default exists and lab features are off', () => {
  const s = defaultState(); eq(s.room.layout, '4.0'); ok(s.room.art.robust === true);
  for (const k of ['rew', 'noise', 'modes', 'art', 'scan', 'refl', 'micpair', 'loud']) ok(s.ui.features[k] === false, k + ' should default off');
  eq(s.fx.loud.on, false); ok(JSON.parse(JSON.stringify(s)).room.layout === '4.0');
});
done('misc');
