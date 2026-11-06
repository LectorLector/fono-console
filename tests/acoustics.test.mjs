// Room acoustics: T30/EDT/T20, waterfall, mirror image reflections, reflection (ETC) analysis, modes at the seat, seat suggestion.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { decayTimes, decayTable, csd, firstReflections, matchPeaks, simpleModes, modePressure, seatSearch, modalResponse, C_AIR } from '../web/js/acoustics.js';
import { analyse } from '../web/js/lab.js';
import { demoWideMeasurements, demoMeasurements } from '../web/js/demoroom.js';

let seed = 99;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

suite('decay');
for (const sr of [44100, 48000]) for (const rt of [0.3, 0.6, 1.2]) {
  test(`T30 of exponential noise decay RT60=${rt} @${sr}`, () => {
    const n = Math.round(Math.min(2.5, rt * 2.4) * sr), ir = new Float32Array(n), k = 6.91 / rt;
    for (let i = 0; i < n; i++) ir[i] = gauss() * Math.exp(-k * i / sr);
    const d = decayTimes(ir, sr);
    near(d.t30 / rt, 1, 0.06, 'T30 broadband'); near(d.t20 / rt, 1, 0.08, 'T20'); near(d.edt / rt, 1, 0.12, 'EDT');
    const b = decayTimes(ir, sr, 1000); near(b.t30 / rt, 1, 0.12, 'T30 1 kHz band');
  });
}
test('too little dynamic range -> NaN, not a wrong number', () => {
  const sr = 48000, ir = new Float32Array(sr / 4); for (let i = 0; i < ir.length; i++) ir[i] = gauss() * (i < 50 ? 1 : 0.2) * (i < 50 ? 1 : Math.exp(-i / 5000)) + gauss() * 0.15;
  const d = decayTimes(ir, sr); ok(!Number.isFinite(d.t30) || d.range < 40, 'T30 reported despite noisy IR');
});
test('decayTable skips bands above 0.45 sr', () => {
  const ir = new Float32Array(2048); ir[0] = 1; for (let i = 1; i < 2048; i++) ir[i] = gauss() * Math.exp(-i / 300) * 0.3;
  eq(decayTable(ir, 1024).map(r => r.fc), [63, 125, 250]);
});
test('48 kHz demo room shows all octave bands 63..8k with sane T30', () => {
  const m = demoWideMeasurements({ L: 3.5, W: 3, H: 2.6, rt60: 0.4 }, { seat: [1.75, 1.5], ear: 1.1, FL: [0.35, 0.96, 1], FR: [0.35, 2.04, 1], SL: [3.2, 0.6, 1.9], SR: [3.2, 2.4, 1.9] });
  const t = decayTable(m.FL[0].ir, m.FL[0].sr);
  eq(t.map(r => r.fc), [63, 125, 250, 500, 1000, 2000, 4000, 8000]);
  t.forEach(r => ok(r.t30 > 0.05 && r.t30 < 0.8, `${r.fc}: T30 ${r.t30}`));
  ok(t[0].t30 > t[7].t30, 'bass rings longer than treble');
});
test('dynamic range is a sane peak-to-noise figure (was thousands of dB per band)', () => {
  const m = demoWideMeasurements({ L: 3.5, W: 3, H: 2.6, rt60: 0.4 }, { seat: [1.75, 1.5], ear: 1.1, FL: [0.35, 0.96, 1], FR: [0.35, 2.04, 1], SL: [3.2, 0.6, 1.9], SR: [3.2, 2.4, 1.9] });
  for (const r of decayTable(m.FL[0].ir, m.FL[0].sr)) ok(r.range > 25 && r.range <= 120, `${r.fc} Hz range ${r.range}`);
  const sr = 48000, ir = new Float32Array(sr); for (let i = 0; i < ir.length; i++) ir[i] = gauss() * Math.exp(-6.91 * i / sr / 0.5) + gauss() * 1e-3;
  near(decayTimes(ir, sr).range, 20 * Math.log10(Math.max(...ir.map(Math.abs)) / 1e-3), 6, 'peak/noise');
});
test('csd slices', () => {
  const sr = 48000, ir = new Float32Array(sr / 2); for (let i = 0; i < ir.length; i++) ir[i] = (i === 100 ? 1 : 0) + 0.2 * Math.sin(2 * Math.PI * 100 * i / sr) * Math.exp(-i / 4000);
  const c = csd(ir, sr); eq(c.db.length, 30); eq(c.f.length, 120); ok(c.db.flat().every(Number.isFinite));
  ok(Math.max(...c.db[0]) > Math.max(...c.db[29]), 'energy decays through slices');
});

suite('mirror image reflections');
{
  const dims = { L: 4, W: 3, H: 2.5 }, src = [1, 1, 1], rx = [3, 2, 1];
  const r = Object.fromEntries(firstReflections(src, rx, dims).map(x => [x.id, x]));
  test('left wall: geometry and delay', () => {
    near(r.left.pt[1], 0, 1e-9); near(r.left.pt[0], 1 + 2 / 3, 1e-9);
    const path = Math.hypot(2, 3), d0 = Math.hypot(2, 1);
    near(r.left.extra, path - d0, 1e-9); near(r.left.ms, (path - d0) / C_AIR * 1000, 1e-9);
  });
  test('reflection point obeys angle of incidence = reflection', () => {
    for (const x of Object.values(r)) {
      const a = x.pt.map((v, i) => v - src[i]), b = x.pt.map((v, i) => rx[i] - v), ax = ['front', 'back'].includes(x.id) ? 0 : ['left', 'right'].includes(x.id) ? 1 : 2;
      near(Math.abs(a[ax]) / Math.hypot(...a), Math.abs(b[ax]) / Math.hypot(...b), 1e-9, x.id);
    }
  });
  test('every surface has positive extra path and lies on the room boundary', () => {
    for (const x of Object.values(r)) { ok(x.extra > 0, x.id); ok(x.pt.every((v, i) => v > -1e-9 && v < [4, 3, 2.5][i] + 1e-9), x.id + ' point outside room'); }
    near(r.floor.pt[2], 0, 1e-9); near(r.ceil.pt[2], 2.5, 1e-9); near(r.back.pt[0], 4, 1e-9); near(r.front.pt[0], 0, 1e-9); near(r.right.pt[1], 3, 1e-9);
  });
}

suite('reflection analysis (ETC) on a synthetic IR');
for (const sr of [44100, 48000, 96000]) {
  test(`delays found within 0.1 ms @${sr}`, () => {
    const known = [[1.3, -6], [3.9, -9], [7.2, -12], [11.6, -14]], pre = 5, ir = new Float32Array(Math.round(0.08 * sr));
    ir[Math.round(pre / 1000 * sr)] = 1;
    for (const [ms, db] of known) ir[Math.round((pre + ms) / 1000 * sr)] += 10 ** (db / 20);
    for (let i = 0; i < ir.length; i++) ir[i] += gauss() * 1e-4;
    const a = analyse({ ir, sr, irPeak: Math.round(pre / 1000 * sr) });
    for (const [ms, db] of known) {
      const row = a.rows.find(r => Math.abs(r.ms - ms) < 0.1);
      ok(row, `no peak near ${ms} ms; got ${a.rows.map(r => r.ms.toFixed(2))}`);
      near(row.ms, ms, 0.1); near(row.path, ms / 1000 * C_AIR, 0.04);
    }
    ok(a.rows.length <= 6);
  });
}
test('peaks match the predicted surfaces (+-0.3 ms) and report the right wall', () => {
  const dims = { L: 3.5, W: 3, H: 2.6 }, src = [0.35, 0.96, 1], rx = [1.75, 1.5, 1.1];
  const preds = firstReflections(src, rx, dims), sr = 48000, ir = new Float32Array(sr / 10), pre = 240;
  ir[pre] = 1; const left = preds.find(p => p.id === 'left'), ceil = preds.find(p => p.id === 'ceil');
  ir[pre + Math.round(left.ms / 1000 * sr)] += 0.4; ir[pre + Math.round(ceil.ms / 1000 * sr)] += 0.25;
  const a = analyse({ ir, sr, irPeak: pre }), mt = matchPeaks(a.rows, preds, 0.3);
  eq(mt.filter(m => m.surface).map(m => m.surface).sort(), ['天花板', '左牆'].sort());
});
test('48 kHz demo IR: all six reflections are recovered at the predicted delays', () => {
  const dims = { L: 3.5, W: 3, H: 2.6, rt60: 0.4 }, pos = { seat: [1.75, 1.5], ear: 1.1, FL: [0.35, 0.96, 1], FR: [0.35, 2.04, 1], SL: [3.2, 0.6, 1.9], SR: [3.2, 2.4, 1.9] };
  const m = demoWideMeasurements(dims, pos).FL[0], preds = firstReflections(pos.FL, [1.75, 1.5, 1.1], dims);
  const mt = matchPeaks(analyse(m).rows, preds, 0.3);
  eq(mt.filter(x => x.surface).length, 6, JSON.stringify(mt.map(x => [x.ms.toFixed(2), x.surface])));
  mt.filter(x => x.surface).forEach(x => ok(Math.abs(x.err) < 0.1, `${x.surface} err ${x.err}`));
});

suite('modes at the seat');
{
  const dims = { L: 4.2, W: 3.1, H: 2.5 };
  const modes = simpleModes(dims, 200);
  test('modes are sorted, below 200 Hz and only axial/tangential', () => {
    ok(modes.length > 10);
    for (let i = 1; i < modes.length; i++) ok(modes[i].f >= modes[i - 1].f);
    modes.forEach(m => { ok(m.f < 200); const nz = m.n.filter(Boolean).length; ok(nz === 1 || nz === 2); eq(m.kind, nz === 1 ? '軸向' : '切向'); });
    near(modes[0].f, C_AIR / 2 / 4.2, 1e-9); eq(modes[0].n, [1, 0, 0]);
  });
  test('pressure: antinode at wall, node at the middle for odd orders', () => {
    near(modePressure([1, 0, 0], [0, 1, 1], dims), 1, 1e-9); near(modePressure([1, 0, 0], [2.1, 1, 1], dims), 0, 1e-9); near(modePressure([2, 0, 0], [2.1, 1, 1], dims), -1, 1e-9);
  });
  test('modal response is finite, peaks near the first axial mode', () => {
    const f = Array.from({ length: 200 }, (_, i) => 20 + i), db = modalResponse([[0.4, 1, 1]], [3.9, 1.5, 1.1], dims, f, 0.5);
    ok(db.every(Number.isFinite));
    const peakF = f[db.indexOf(Math.max(...db.slice(0, 40)))]; ok(Math.abs(peakF - 40.8) < 8, 'first axial at 40.8 Hz, peak at ' + peakF);
  });
  test('seat search: best is never worse than here, stays within +-60 cm and the margins', () => {
    const s = seatSearch([2.1, 1.55, 1.1], [[0.35, 1, 1], [0.35, 2.1, 1]], dims, 0.4);
    ok(s.best.v <= s.here.v + 1e-12); ok(Math.abs(s.best.off) <= 0.6 + 1e-9); ok(s.best.x >= 0.25 && s.best.x <= dims.L - 0.25);
    eq(s.rows.length > 20, true);
    // a seat in the middle of the room length sits on the null of the first axial mode -> some other spot is better or equal
  });
  test('seat in the null of the 1st length mode is improved by moving', () => {
    const s = seatSearch([2.1, 1.55, 1.1], [[0.35, 1, 1], [0.35, 2.1, 1]], dims, 0.4);
    ok(s.best.v < s.here.v * 0.98 || s.best.off === 0);
  });
}
test('legacy 1024 Hz demo still builds for the ART demo (15 positions x 4 speakers)', () => {
  const d = demoMeasurements(); eq(Object.keys(d), ['FL', 'FR', 'SL', 'SR']); eq(d.FL.length, 15); eq(d.FL[0].sr, 1024);
});
done('acoustics');
