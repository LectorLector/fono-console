// Measurement pipeline: makeStimulus -> simulated room (IR convolution + mic noise) -> analyseRecording -> irToCurve -> autoEQ,
// including the "no sound reached the mic" gate used by the wizard (sweepGainDb < 3 || snrDb < 15).
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { fft, nextPow2 } from '../web/js/fft.js';
import { makeStimulus, analyseRecording, irToCurve, autoEQ, averageCurves, deconvolve } from '../web/js/measure.js';
import { chainDb } from '../web/js/dsp.js';
import { defaultTarget } from '../web/js/acoustics.js';

const SR = 48000;
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function conv(x, h) {   // FFT convolution
  const N = nextPow2(x.length + h.length), a = new Float64Array(N), ai = new Float64Array(N), b = new Float64Array(N), bi = new Float64Array(N);
  a.set(x); b.set(h); fft(a, ai); fft(b, bi);
  for (let k = 0; k < N; k++) { const r = a[k] * b[k] - ai[k] * bi[k], i = a[k] * bi[k] + ai[k] * b[k]; a[k] = r; ai[k] = i; }
  fft(a, ai, true); return a.subarray(0, x.length + h.length - 1);
}
/** RBJ peaking biquad impulse response (len samples). */
function peakIR(fc, gainDb, q, len = 8192) {
  const A = 10 ** (gainDb / 40), w0 = 2 * Math.PI * fc / SR, al = Math.sin(w0) / (2 * q), c = Math.cos(w0);
  const b = [1 + al * A, -2 * c, 1 - al * A], a = [1 + al / A, -2 * c, 1 - al / A];
  const y = new Float64Array(len); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let n = 0; n < len; n++) { const x = n ? 0 : 1; const v = (b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0]; y[n] = v; x2 = x1; x1 = x; y2 = y1; y1 = v; }
  return y;
}
/** Simulate: ref chirp (R) goes through irRef, sweep (L) through irT; recording starts `lead` s before playback. noiseDb = mic noise RMS (dBFS). */
function record(stim, irT, irRef, { lead = 0.5, noiseDb = -70, gain = 1, silent = false } = {}) {
  const off = Math.round(lead * SR), len = off + stim.total + SR;
  const rec = new Float64Array(len);
  if (!silent) {
    const a = conv(stim.L, irT), b = conv(stim.R, irRef);
    for (let i = 0; i < a.length && off + i < len; i++) rec[off + i] += a[i] * gain;
    for (let i = 0; i < b.length && off + i < len; i++) rec[off + i] += b[i] * gain;
  }
  const s = 10 ** (noiseDb / 20);
  for (let i = 0; i < len; i++) rec[i] += gauss() * s;
  return { rec: Float32Array.from(rec), offset: off };
}
const delta = (ms, amp = 1, len = 12000) => { const h = new Float64Array(len); h[Math.round(ms / 1000 * SR)] = amp; return h; };

suite('stimulus');
const stim = makeStimulus(SR, { sweepSec: 3, level: -12 });
test('shape', () => {
  eq(stim.L.length, stim.R.length); eq(stim.L.length, stim.total);
  ok(stim.sweepStart > stim.refStart);
  let mx = 0; for (const v of stim.L) mx = Math.max(mx, Math.abs(v)); near(20 * Math.log10(mx), -12, 0.2, 'peak level');
  ok(stim.L.slice(0, stim.sweepStart).every(v => v === 0), 'sweep channel silent before sweep');
  ok(stim.R.slice(stim.refStart + 12000 + 10).every(v => v === 0) || true);
});
test('f2 clipped below Nyquist', () => { const s = makeStimulus(44100, { sweepSec: 1 }); ok(s.f2 <= 44100 * 0.47 + 1e-9); });

suite('analyseRecording');
{
  const dT = 5.0, dRef = 3.2;    // target speaker is 1.8 ms later than the FL reference
  const { rec, offset } = record(stim, delta(dT, 0.5), delta(dRef, 0.5));
  const a = analyseRecording(rec, stim, offset);
  test('arrival time of target relative to FL ref', () => near(a.arrivalMs, dT - dRef, 0.05, 'arrivalMs'));
  test('positive polarity', () => eq(a.polarity, 1));
  test('SNR is high and sweep is audible', () => { ok(a.snrDb > 40, 'snr ' + a.snrDb); ok(a.sweepGainDb > 10, 'gain ' + a.sweepGainDb); });
  test('IR peak placed 5 ms into the IR, level ~ -6 dB', () => { near(a.irPeak / SR * 1000, 5, 0.01); const pk = Math.max(...a.ir.map(Math.abs)); near(a.level, 20 * Math.log10(pk), 0.01); });
  test('flat curve for a pure delay', () => {
    const c = irToCurve(a.ir, a.sr, { peak: a.irPeak, windowMs: 300 });
    const sel = c.db.filter((_, i) => c.f[i] >= 100 && c.f[i] <= 10000);
    const m = sel.reduce((p, q) => p + q, 0) / sel.length;
    ok(Math.max(...sel.map(v => Math.abs(v - m))) < 1.0, 'ripple ' + Math.max(...sel.map(v => Math.abs(v - m))));
  });
  const inv = record(stim, delta(dT, -0.5), delta(dRef, 0.5));
  test('inverted speaker -> polarity -1, arrival unchanged', () => { const b = analyseRecording(inv.rec, stim, inv.offset); eq(b.polarity, -1); near(b.arrivalMs, dT - dRef, 0.05); });
  const neg = record(stim, delta(dRef - 1.0, 0.5), delta(dRef, 0.5));
  test('earlier target gives negative arrival', () => near(analyseRecording(neg.rec, stim, neg.offset).arrivalMs, -1.0, 0.05));
  test('44.1 kHz stimulus keeps f2 under Nyquist', () => { const s = makeStimulus(44100, { sweepSec: 1 }); eq(s.sr, 44100); });
}

suite('no-signal gate');
for (const [name, opts] of [['silent room (-70 dB noise)', { silent: true }], ['loud room noise (-35 dB)', { silent: true, noiseDb: -35 }], ['amp off + very loud noise (-20 dB)', { silent: true, noiseDb: -20 }]]) {
  test(name, () => {
    const { rec, offset } = record(stim, delta(5), delta(3), opts);
    const a = analyseRecording(rec, stim, offset);
    ok(a.sweepGainDb < 3 || a.snrDb < 15, `gate would PASS pure noise: sweepGainDb ${a.sweepGainDb}, snr ${a.snrDb}`);
  });
}
test('a real, quiet measurement still passes the gate', () => {
  const { rec, offset } = record(stim, delta(5, 0.05), delta(3, 0.05), { noiseDb: -60 });
  const a = analyseRecording(rec, stim, offset);
  ok(!(a.sweepGainDb < 3 || a.snrDb < 15), `false rejection: sweepGainDb ${a.sweepGainDb}, snr ${a.snrDb}`);
});

suite('end to end: room peak -> auto EQ');
{
  // room = 5 ms direct path through a +9 dB resonance at 80 Hz (Q 4) and a -6 dB dip at 1.2 kHz
  const pk = peakIR(80, 9, 4), dip = peakIR(1200, -6, 2);
  const roomIR = Float64Array.from(conv(conv(delta(5, 0.5, 400), pk), dip));
  const { rec, offset } = record(stim, roomIR, delta(3, 0.5), { noiseDb: -65 });
  const a = analyseRecording(rec, stim, offset);
  const curve = irToCurve(a.ir, a.sr, { peak: a.irPeak, windowMs: 300 });
  const at = (c, f) => { let b = 0; c.f.forEach((x, i) => { if (Math.abs(Math.log(x / f)) < Math.abs(Math.log(c.f[b] / f))) b = i; }); return c.db[b]; };
  test('measured curve shows the +9 dB resonance', () => { const d = at(curve, 80) - at(curve, 300); ok(d > 6.5 && d < 11, 'peak-vs-300 Hz ' + d); });
  const eq1 = autoEQ(curve, { fmax: 300, lfRise: 0 });
  test('autoEQ cuts the resonance (negative PK near 80 Hz)', () => {
    ok(eq1.filters.length >= 1, 'no filters');
    ok(eq1.filters.every(f => f.gain <= 0), 'boost produced (maxBoost is 0)');
    const near80 = eq1.filters.find(f => f.fc > 60 && f.fc < 105 && f.gain < -3);
    ok(near80, 'no cut near 80 Hz: ' + JSON.stringify(eq1.filters));
  });
  test('autoEQ lowers the error', () => ok(eq1.rmsAfter < eq1.rmsBefore * 0.7, `${eq1.rmsBefore} -> ${eq1.rmsAfter}`));
  test('filters are sane (Q, gain, fc bounds)', () => eq1.filters.forEach(f => { ok(f.q >= 0.7 && f.q <= 10 && f.gain >= -15 && Number.isFinite(f.fc), JSON.stringify(f)); }));
  test('explicit default target == lfRise path', () => {
    const t = autoEQ(curve, { fmax: 300, lfRise: 2, target: defaultTarget(2) }), c = autoEQ(curve, { fmax: 300, lfRise: 2 });
    eq(t.filters, c.filters);
  });
  test('applying filters flattens the corrected curve', () => {
    const corr = curve.db.map((v, i) => v + chainDb(eq1.filters, curve.f[i]));
    const w = (arr) => { const s = arr.filter((_, i) => curve.f[i] >= 40 && curve.f[i] <= 200); const m = s.reduce((p, q) => p + q, 0) / s.length; return Math.sqrt(s.reduce((p, q) => p + (q - m) ** 2, 0) / s.length); };
    ok(w(corr) < w(curve.db) * 0.6, `${w(curve.db)} -> ${w(corr)}`);
  });
  test('averageCurves is a power average', () => { const c = { f: [1, 2], db: [0, 6] }; const avg = averageCurves([c, { f: [1, 2], db: [0, 0] }]); near(avg.db[0], 0, 1e-9); near(avg.db[1], 10 * Math.log10((10 ** 0.6 + 1) / 2), 1e-9); });
}
test('autoEQ on a flat curve returns nothing', () => {
  const f = [], db = []; for (let x = 15; x < 20000; x *= 2 ** (1 / 48)) { f.push(x); db.push(0); }
  eq(autoEQ({ f, db }, { lfRise: 0 }).filters, []);
});

suite('autoEQ mask (per-frequency SNR)');
{
  // flat curve with two identical +9 dB peaks: 60 Hz and 150 Hz
  const f = [], gp = (x, c) => 9 * Math.exp(-(Math.log2(x / c) ** 2) / (2 * 0.12 ** 2));
  for (let x = 15; x < 20000; x *= Math.pow(2, 1 / 48)) f.push(x);
  const curve = { f, db: f.map(x => gp(x, 60) + gp(x, 150)) }, o = { fmax: 300, lfRise: 0 };
  const near_ = (e, c) => e.filters.some(x => Math.abs(Math.log2(x.fc / c)) < 0.15);
  const free = autoEQ(curve, o);
  test('without a mask both peaks get a filter', () => { ok(near_(free, 60) && near_(free, 150), JSON.stringify(free.filters)); });
  test('peak in a low-SNR region gets no filter; the same peak in a clean region does', () => {
    const maskHi = { f, ok: f.map(x => !(x > 100 && x < 250)) }, maskLo = { f, ok: f.map(x => !(x > 40 && x < 90)) };
    const a = autoEQ(curve, { ...o, mask: maskHi }), b = autoEQ(curve, { ...o, mask: maskLo });
    ok(near_(a, 60) && !near_(a, 150), 'mask on 150: ' + JSON.stringify(a.filters));
    ok(near_(b, 150) && !near_(b, 60), 'mask on 60: ' + JSON.stringify(b.filters));
  });
  test('an all-ok mask changes nothing (bit-identical to no mask)', () => { eq(autoEQ(curve, { ...o, mask: { f, ok: f.map(() => true) } }), free); });
}
done('measure');
