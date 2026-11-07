// Averaged mic pairing DSP (web/js/avg.js): coherent IR averaging, Welch noise, noise scaling vs the real deconvolution chain, SNR mask, crossfade.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { alignAndAverage, welchNoise, smoothPow, noiseEquivCurve, curveWindow, snrMask, crossfadeMask, badRanges, repeatability, measureMicAveraged } from '../web/js/avg.js';
import { makeStimulus, deconvolve, irToCurve, analyseRecording } from '../web/js/measure.js';
import { fft, nextPow2 } from '../web/js/fft.js';

const SR = 48000;
let seed = 777;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const noise = (n, s) => Float32Array.from({ length: n }, () => s * gauss());
const db10 = x => 10 * Math.log10(x);

suite('alignAndAverage');
{
  const L = 4096, base = new Float32Array(L);
  base[300] = 1; for (let i = 301; i < L; i++) base[i] = 0.2 * Math.exp(-(i - 300) / 400) * Math.sin(i * 0.7);
  const copies = (N, sig) => Array.from({ length: N }, (_, k) => { const sh = [0, 3, -2, 5, -4, 1, 2, -1][k % 8], o = new Float32Array(L); for (let i = 20; i < L - 20; i++) o[i] = base[i - sh] + sig * gauss(); return { o, sh }; });
  const resid = (ir, sh0) => { let e = 0, c = 0; for (let i = 40; i < L - 40; i++) { const d = ir[i] - base[i - sh0]; e += d * d; c++; } return e / c; };
  for (const N of [2, 4, 8]) {
    test(`N=${N}: residual noise falls ~${db10(N).toFixed(1)} dB`, () => {
      const cs = copies(N, 0.05), single = resid(cs[0].o, cs[0].sh), r = alignAndAverage(cs.map(c => c.o));
      near(db10(single / resid(r.ir, cs[0].sh)), db10(N), 1);
    });
  }
  test('shifts are peak offsets relative to the first IR', () => {
    const cs = copies(4, 0.0), r = alignAndAverage(cs.map(c => c.o));
    eq(r.shifts, cs.map(c => c.sh - cs[0].sh));
  });
  test('without alignment the HF response of a jittery average would suffer, with it the peak stays 1', () => {
    const cs = copies(8, 0.0), r = alignAndAverage(cs.map(c => c.o)); near(r.ir[300 + cs[0].sh], 1, 1e-6);
  });
}

suite('welchNoise');
{
  const s = 0.1, x = noise(10 * SR, s), w = welchNoise(x, SR, 16384);
  test('white noise: absolute level = variance', () => { let m = 0; for (let k = 10; k < w.p.length - 10; k++) m += w.p[k]; near(db10(m / (w.p.length - 20)), db10(s * s), 0.3); });
  test('white noise: flat within +-1 dB per 1/3 octave (200 Hz - 20 kHz)', () => {
    const sm = smoothPow(w.f, w.p, 3); let worst = 0;
    w.f.forEach((f, i) => { if (f >= 200 && f <= 20000) worst = Math.max(worst, Math.abs(db10(sm[i]) - db10(s * s))); });
    ok(worst < 1, 'worst ' + worst.toFixed(2));
  });
  test('independent of nfft', () => near(db10(welchNoise(x, SR, 4096).p[500]), db10(s * s), 1.5));
}

suite('noise scaling');
{
  // noise only (no sound) goes through the real deconvolution + irToCurve; the predicted noise curve must match its level.
  const stim = makeStimulus(SR, { level: -12, sweepSec: 1.5 }), recLen = stim.total + Math.round(1.25 * SR), s = 0.01;
  const rec = noise(recLen, s), nz = welchNoise(noise(10 * SR, s), SR, 16384);
  const ir = deconvolve(rec, stim.L, { sr: SR, f1: stim.f1, f2: stim.f2 }).slice(0, Math.round(0.6 * SR));
  const cur = irToCurve(ir, SR, { peak: 0, windowMs: 300 });
  const win = curveWindow(ir.length, 0, SR, 300);
  const pred = noiseEquivCurve({ noise: nz, f: cur.f, x: stim.L, winEnergy: win.energy, nSweeps: 1 });
  const bandMean = (c, lo, hi) => { let a = 0, n = 0; c.f.forEach((f, i) => { if (f >= lo && f <= hi) { a += Math.pow(10, c.db[i] / 10); n++; } }); return db10(a / n); };
  for (const [lo, hi] of [[100, 400], [400, 1600], [1600, 6400], [6400, 16000]]) {
    test(`predicted noise curve matches measured noise ${lo}-${hi} Hz (+-1.5 dB)`, () => near(bandMean(pred, lo, hi), bandMean(cur, lo, hi), 1.5));
  }
  test('nSweeps divides the noise power', () => {
    const p4 = noiseEquivCurve({ noise: nz, f: cur.f, x: stim.L, winEnergy: win.energy, nSweeps: 4 });
    near(bandMean(pred, 500, 2000) - bandMean(p4, 500, 2000), db10(4), 1e-6);
  });
  test('a real sweep through a known gain: SNR from the mask equals the true level minus noise', () => {
    // channel: pure gain 0.1 (-20 dB) -> curve ~ -20 dB flat; noise-equivalent per prediction -> SNR = -20 - noise_dB
    const a = 0.1, y = new Float32Array(recLen); for (let i = 0; i < stim.L.length; i++) y[i + 600] = a * stim.L[i];
    const nn = noise(recLen, s); for (let i = 0; i < recLen; i++) y[i] += nn[i];
    const an = analyseRecording(y, stim, 0), cv = irToCurve(an.ir, SR, { peak: an.irPeak, windowMs: 300 });
    const m = snrMask(cv, pred, 15);
    const mid = m.f.map((f, i) => (f > 500 && f < 2000 ? m.snr[i] : null)).filter(v => v != null), avg = mid.reduce((p, c) => p + c, 0) / mid.length;
    near(avg, -20 - bandMean(pred, 500, 2000), 2);
  });
}

suite('snrMask / crossfadeMask');
{
  const f = Array.from({ length: 200 }, (_, i) => 20 * Math.pow(1000, i / 199));
  const curve = { f, db: f.map(() => -20) }, nz = { f, db: f.map((x, i) => -60 + i * 0.25) };   // noise rises 0.25 dB per step: SNR 40 -> -9.75
  const m = snrMask(curve, nz, 15, { smoothFrac: 48 });
  test('ok below the SNR crossing, not above', () => { ok(m.ok[0] && !m.ok[199]); const k = m.ok.indexOf(false); near(m.snr[k - 1], 15, 0.5 + 0.25); ok(m.ok.slice(k).every(v => !v)); });
  const w = crossfadeMask(f, m.ok, 1 / 3), k = m.ok.indexOf(false);
  test('weights are 0 on unreliable, 1 far away, within [0,1], monotone ramp', () => {
    ok(w.slice(k).every(v => v === 0)); eq(w[0], 1);
    ok(w.every(v => v >= 0 && v <= 1));
    for (let i = 1; i < k; i++) ok(w[i] <= w[i - 1] + 1e-12 || w[i - 1] === 1, 'not monotone at ' + i);
    ok(w[k - 1] < 0.1);
  });
  test('ramp spans about 1/3 octave', () => { const i1 = w.findIndex(v => v < 1); near(Math.log2(f[k] / f[i1]), 1 / 3, 0.05); });
  test('no unreliable region leaves all weights at 1; all unreliable gives 0', () => { ok(crossfadeMask(f, f.map(() => true)).every(v => v === 1)); ok(crossfadeMask(f, f.map(() => false)).every(v => v === 0)); });
  test('badRanges', () => { eq(badRanges([1, 2, 3, 4, 5, 6], [true, false, false, true, false, false]), [[2, 3], [5, 6]]); });
  test('stored calibration = diff * weight is 0 where unreliable and continuous', () => {
    const diff = f.map(() => 3), cal = diff.map((d, i) => d * w[i]);
    eq(cal[199], 0); eq(cal[0], 3); for (let i = 1; i < f.length; i++) ok(Math.abs(cal[i] - cal[i - 1]) < 1.0);
  });
}

suite('repeatability');
{
  const f = Array.from({ length: 400 }, (_, i) => 20 * Math.pow(1000, i / 399)), off = [-0.5, 0.5, -0.5, 0.5];
  const r = repeatability(off.map(o => ({ f, db: f.map(() => -20 + o) })));
  test('std across sweeps per 1/3 octave', () => { near(r.maxStd, Math.sqrt(4 * 0.25 / 3), 1e-6); ok(r.fc.length > 25); });
  test('a single sweep has no repeatability', () => eq(repeatability([{ f, db: f }]), null));
}

suite('measureMicAveraged (synthetic recordings)');
{
  const stim = makeStimulus(SR, { level: -12, sweepSec: 0.8 }), recLen = Math.round(0.35 * SR) + stim.total + Math.round(0.9 * SR), off = Math.round(0.35 * SR);
  const grabNoise = async (sec, tick) => { tick && tick(sec); return noise(sec * SR, 0.004); };
  const grabSweep = async () => { const y = noise(recLen, 0.004); for (let i = 0; i < stim.L.length; i++) y[off + 120 + i] += 0.1 * stim.L[i]; for (let i = 0; i < stim.R.length; i++) y[off + 120 + i] += 0.05 * stim.R[i]; const a = analyseRecording(y, stim, off); a.recLen = recLen; a.peakDb = -20; return a; };
  test('runs, reports progress, averages and gives a mask + repeatability', async () => {
    const steps = []; const r = await measureMicAveraged({ sweeps: 3, noiseSec: 3, stim, io: { grabNoise, grabSweep }, onProgress: p => steps.push(p.step) });
    ok(steps.includes('noise') && steps.includes('sweep') && steps.includes('calc')); eq(r.curves.length, 3); ok(r.rep.maxStd >= 0);
    ok(r.mask.ok.some(v => v)); near(r.curve.db[Math.round(r.curve.f.length / 2)], -20, 2);
  });
  test('cancel throws an error flagged cancelled', async () => {
    let n = 0, err = null; try { await measureMicAveraged({ sweeps: 4, noiseSec: 1, stim, io: { grabNoise, grabSweep }, isCancelled: () => ++n > 3 }); } catch (e) { err = e; }
    ok(err && err.cancelled);
  });
}
done('avg.test.mjs');
