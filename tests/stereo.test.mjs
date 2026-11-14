// Stereo symmetry correction: L/R magnitude matching, per-band timing + FIR pair, phantom-centre check, placement geometry, config output.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { matchLR, filterLimits, bandTimeDiff, designPhasePair, needsPhaseFix, phantomCheck, geometry, matchFiltersFor, stereoOf } from '../web/js/stereo.js';
import { excessPhaseFromIR } from '../web/js/fir.js';
import { genConfig } from '../web/js/eapo.js';
import { diagnose, TH } from '../web/js/diagnose.js';
import { defaultState } from '../web/js/state.js';
import { configProblems } from './cfgvalidate.mjs';

const grid = Array.from({ length: 300 }, (_, i) => 20 * Math.pow(1000, i / 299));
const bump = (f, f0, db, oct) => db * Math.exp(-0.5 * (Math.log2(f / f0) / oct) ** 2);
const mk = fn => ({ f: grid, db: grid.map(fn) });

suite('magnitude matching');
test('known L/R differences: residual difference RMS drops >= 60% and filters stay in limits', () => {
  const L = mk(f => 80 + bump(f, 1000, 3, 0.4) + bump(f, 3500, -2.5, 0.3) + bump(f, 400, 1.5, 0.5));
  const R = mk(f => 80 + bump(f, 1000, -1, 0.4) + bump(f, 3500, 1, 0.3));
  const r = matchLR(L, R);
  console.log(`  match: RMS ${r.rmsBefore.toFixed(2)} -> ${r.rmsAfter.toFixed(2)} dB (${(r.reduction * 100).toFixed(0)}% less), FL ${r.filters.FL.length} / FR ${r.filters.FR.length} filters`);
  ok(r.reduction >= 0.6, 'reduction ' + r.reduction);
  for (const k of ['FL', 'FR']) { const l = filterLimits(r.filters[k]); ok(l.maxAbsGain <= 4.0001 && l.maxQ <= 3.0001 && l.minFc >= 150 && l.maxFc <= 8000, k + JSON.stringify(l)); }
});
test('limits hold with a huge difference; level offset is not fitted; identical curves need no filters', () => {
  const L = mk(f => 80 + bump(f, 2000, 12, 0.3)), R = mk(() => 82);
  const r = matchLR(L, R); ok(filterLimits(r.filters.FL).maxAbsGain <= 4.0001);
  near(r.levelOffsetDb, -2 + 12 * 0.0, 3, 'offset');
  const e = matchLR(mk(() => 80), mk(() => 83)); eq(e.filters.FL.length + e.filters.FR.length, 0); near(e.levelOffsetDb, -3, 0.05);
});
test('masked (noisy) bands are not fitted', () => {
  const L = mk(f => 80 + bump(f, 1000, 3, 0.3)), R = mk(() => 80);
  const mask = { f: grid, ok: grid.map(f => !(f > 600 && f < 1800)) };
  const r = matchLR(L, R, { maskL: mask, maskR: mask }); eq(r.filters.FL.length, 0);
});
test('custom band and limits are honoured', () => {
  const L = mk(f => 80 + bump(f, 300, 3, 0.3)), R = mk(() => 80);
  const r = matchLR(L, R, { lo: 200, hi: 2000, maxDb: 2, maxQ: 2 });
  for (const x of r.filters.FL.concat(r.filters.FR)) ok(Math.abs(x.gain) <= 2.0001 && x.q <= 2.0001 && x.fc >= 200 && x.fc <= 2000);
});

suite('time / phase');
const apPhase = (f, fc) => -2 * Math.atan(f / fc);
test('all-pass mismatch: FIR pair leaves <= 25% of the per-band time difference', () => {
  const f = Array.from({ length: 4000 }, (_, i) => 5 + i * 6);
  const exL = { f, phase: f.map(x => apPhase(x, 500)), delayMs: 0 }, exR = { f, phase: f.map(() => 0), delayMs: 0 };
  const td = bandTimeDiff(exL, exR, 0);
  ok(needsPhaseFix(td), 'spread ' + td.spreadMs);
  const d = designPhasePair(td, { sr: 48000, taps48: 2048 });
  console.log(`  phase: spread ${td.spreadMs.toFixed(2)} ms, RMS ${td.rmsMs.toFixed(3)} -> ${d.predicted.residualRms.toFixed(3)} ms (${(d.predicted.ratio * 100).toFixed(0)}%), latency ${d.latencyMs.toFixed(1)} ms`);
  ok(d.predicted.ratio <= 0.25, 'ratio ' + d.predicted.ratio);
  eq(d.FL.length, d.FR.length);
});
test('a constant arrival offset is not a frequency-dependent mismatch', () => {
  const f = Array.from({ length: 2000 }, (_, i) => 5 + i * 12);
  const z = { f, phase: f.map(() => 0), delayMs: 0 };
  const td = bandTimeDiff(z, z, 0.3); near(td.meanMs, 0.3, 1e-6); ok(!needsPhaseFix(td));
});
test('real IRs: a pure 0.3 ms offset reads as 0.3 ms in every band', () => {
  const sr = 48000, mkIR = d => { const ir = new Float32Array(8192); ir[240 + d] = 1; ir[240 + d + 30] = 0.1; return ir; };
  const a = excessPhaseFromIR(mkIR(0), sr), b = excessPhaseFromIR(mkIR(0), sr);
  const td = bandTimeDiff(a, b, 0); ok(Math.abs(td.meanMs) < 0.03 && td.spreadMs < 0.1, JSON.stringify([td.meanMs, td.spreadMs]));
});

suite('phantom centre');
const delta = (ms, g = 1, sr = 48000) => { const ir = new Float32Array(4096), pk = 240; ir[pk] = g; return { ir, sr, irPeak: pk, arrivalMs: ms }; };
const sumIR = (a, b) => { const ir = new Float32Array(4096), pk = 240, d = Math.round((b.arrivalMs - a.arrivalMs) / 1000 * 48000); ir[pk] = a.ir[240]; ir[pk + d] += b.ir[240]; return { ir, sr: 48000, irPeak: pk, arrivalMs: a.arrivalMs }; };
test('timing offset makes a comb: cancellation reported, explained by the complex sum', () => {
  const L = delta(3.0), R = delta(3.5), M = sumIR(L, R);   // 0.5 ms: first notch at 1 kHz
  const r = phantomCheck([L], [R], [M]);
  ok(r.cancel.length >= 1, 'bands ' + JSON.stringify(r.cancel));
  ok(r.cancel.some(c => c.f0 <= 1000 && c.f1 >= 1000 && c.explained), JSON.stringify(r.cancel));
  console.log('  phantom: ' + r.cancel.map(c => `${c.f0}-${c.f1} Hz ${c.depthDb} dB`).join(', '));
});
test('aligned speakers: no cancellation; a polarity-flipped mono run is cancelled but NOT explained', () => {
  const L = delta(3), R = delta(3), M = sumIR(L, R);
  eq(phantomCheck([L], [R], [M]).cancel.length, 0);
  const Mb = sumIR(L, delta(3, -1)), r = phantomCheck([L], [R], [Mb]);
  ok(r.cancel.length >= 1 && r.cancel.every(c => !c.explained), JSON.stringify(r.cancel));
});

suite('geometry');
const dims = { L: 3.6, W: 3, H: 2.6 };
test('symmetric equilateral setup', () => {
  const P = { seat: [2.6, 1.5], ear: 1, FL: [0.35, 0.5, 1], FR: [0.35, 2.5, 1] };   // listen distance ~2.5 m, spacing 2 m
  const g = geometry(P, dims);
  near(g.diffCm, 0, 0.01); near(g.angle.FL, -g.angle.FR, 1e-9); near(g.sideDiffCm, 0, 1e-6); near(g.seatOffsetCm, 0, 1e-6);
  near(g.ratio, 2 / Math.hypot(2.25, 1), 1e-9); ok(g.toe.FL.behind < g.toe.FL.atHead);
});
test('asymmetric setup: distance difference in cm and ms, nearer speaker, wall difference', () => {
  const P = { seat: [2, 1.2], ear: 1.1, FL: [0.4, 0.4, 1], FR: [0.4, 2.2, 1] };
  const g = geometry(P, dims); ok(g.diffCm > 5); eq(g.nearer, 'FL'); near(g.diffMs, g.diffCm / 100 / 343 * 1000, 1e-9);
  near(g.sideDiffCm, 40, 1e-6); ok(g.seatOffsetCm < 0);
});

suite('config');
const base = () => { const s = defaultState(); s.dev.cm = '{cm}'; s.dev.spark = '{dac}'; return s; };
const F = { FL: [{ type: 'PK', fc: 1000, gain: -1.5, q: 2 }], FR: [{ type: 'PK', fc: 1000, gain: 1.5, q: 2 }] };
for (const layout of ['2.0', '2.1', '2.2', '4.0', '4.1', '4.2'])
  for (const mode of ['stereo', 'quadA', 'quadB', 'measure'])
    test(`match filters ${layout}/${mode}: on, off, feature off, low latency`, () => {
      const s = base(); Object.assign(s.room, { layout, mode, measureTarget: 'FR' });
      s.room.stereo = { match: F, matchOn: true };
      for (const k of ['FL', 'FR']) s.room.ch[k].corr = { name: 'x', filters: [{ type: 'PK', fc: 60, gain: -3, q: 4 }] };
      const on = genConfig(s, {}); ok(!configProblems(on, 'x').length, 'valid'); ok(on.includes('Gain -1.50 dB Q 2.000'), 'has FL match');
      ok(on.includes('Gain 1.50 dB Q 2.000'));
      ok(!/[^\x00-\x7f]/.test(on), 'ASCII');
      s.room.stereo.matchOn = false; ok(!genConfig(s, {}).includes('Gain 1.50 dB Q 2.000'), 'off');
      s.room.stereo.matchOn = true; s.ui.features.stereo = false; ok(!genConfig(s, {}).includes('Gain 1.50 dB Q 2.000'), 'feature off');
      s.ui.features.stereo = true; s.ui.lowLatency = true; ok(genConfig(s, {}).includes('Gain 1.50 dB Q 2.000'), 'low latency keeps IIR match');
    });
test('match filters come after the per-channel correction', () => {
  const s = base(); s.room.layout = '2.0'; s.room.mode = 'stereo'; s.room.stereo = { match: F, matchOn: true };
  s.room.ch.FL.corr = { name: 'x', filters: [{ type: 'PK', fc: 60, gain: -3, q: 4 }] };
  const t = genConfig(s, {}); ok(t.indexOf('Fc 60.0 Hz') < t.indexOf('Gain -1.50 dB'));
});
test('phase FIR pair: lines for FL/FR, delay for other channels, omitted in low-latency mode', () => {
  const s = base(); s.room.layout = '4.0'; s.room.mode = 'quadA';
  s.room.stereo = { phaseOn: true, phase: { built: 'x', latencyMs: 21.33, chans: ['FL', 'FR'] } };
  const ctx = { sym: { rates: [44100, 48000], chans: ['FL', 'FR'], latencyMs: 21.33 } };
  const t = genConfig(s, ctx); ok(!configProblems(t, 'x').length); ok(t.includes('Convolution: fono\\sym_FL_48000.wav') && t.includes('Convolution: fono\\sym_FR_44100.wav'));
  ok(t.includes('Delay: 21.33 ms'));
  s.ui.lowLatency = true; ok(!genConfig(s, ctx).includes('sym_FL'), 'low latency omits');
  s.ui.lowLatency = false; s.room.stereo.phaseOn = false; ok(!genConfig(s, ctx).includes('sym_FL'), 'off');
});
test('matchFiltersFor ignores rear speakers', () => { const s = base(); s.room.stereo = { match: F, matchOn: true }; eq(matchFiltersFor(s, 'SL'), []); eq(stereoOf(s).band.maxDb, 4); });

suite('diagnosis rules');
const find = (r, id) => r.find(x => x.id === id);
const dbase = st => ({ dims, pos: {}, chans: {}, stereo: st });
test('lr-match thresholds 1 / 2 / 3.5 dB RMS', () => {
  for (const [v, s] of [[0.5, 'ok'], [1.2, 'low'], [2.5, 'mid'], [4, 'high']]) eq(find(diagnose(dbase({ match: { rmsBefore: v, rmsAfter: v / 4, lo: 150, hi: 8000, maxDiffDb: 2 * v, nFilters: 4 } })), 'lr-match').severity, s, '' + v);
});
test('lr-time thresholds 0.1 / 0.25 / 0.5 ms', () => {
  for (const [v, s] of [[0.05, 'ok'], [0.15, 'low'], [0.3, 'mid'], [0.6, 'high']]) eq(find(diagnose(dbase({ time: { spreadMs: v, meanMs: 0 } })), 'lr-time').severity, s, '' + v);
});
test('phantom: no holes ok; holes ranked by depth, explained flag changes the text', () => {
  eq(find(diagnose(dbase({ phantom: { cancel: [] } })), 'phantom').severity, 'ok');
  const mk = (d, e) => find(diagnose(dbase({ phantom: { cancel: [{ f0: 800, f1: 1200, fc: 1000, depthDb: d, explained: e }] } })), 'phantom');
  eq(mk(7, true).severity, 'low'); eq(mk(10, true).severity, 'mid'); eq(mk(16, false).severity, 'high');
  ok(mk(10, true).detail !== mk(10, false).detail);
});
test('geometry rule: ok for a symmetric setup, flags distance / triangle / wall asymmetry', () => {
  const ok0 = geometry({ seat: [2.082, 1.5], ear: 1, FL: [0.35, 0.5, 1], FR: [0.35, 2.5, 1] }, dims);
  eq(find(diagnose(dbase({ geo: ok0 })), 'geo-sym').severity, 'ok');
  const bad = geometry({ seat: [2, 1.2], ear: 1.1, FL: [0.4, 0.4, 1], FR: [0.4, 2.2, 1] }, dims);
  const it = find(diagnose(dbase({ geo: bad })), 'geo-sym'); ok(it.severity !== 'ok'); ok(it.data.diffCm > 5);
});
test('no stereo data = no stereo items', () => { ok(!diagnose(dbase(undefined)).some(x => ['lr-match', 'lr-time', 'phantom', 'geo-sym'].includes(x.id))); });

done('stereo.test.mjs');
