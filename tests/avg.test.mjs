// Averaged mic pairing DSP (web/js/avg.js): coherent IR averaging, Welch noise, noise scaling vs the real deconvolution chain, SNR mask, crossfade.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { alignAndAverage, welchNoise, smoothPow, noiseEquivCurve, curveWindow, snrMask, crossfadeMask, badRanges, repeatability, measureMicAveraged, measureAveraged, combineSweeps, suggestLevel, ambientVerdict, estimateSeconds, meanSnrCurve, noiseSummary } from '../web/js/avg.js';
import { positionQuality } from '../web/js/art.js';
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

// ---------------------------------------------------------------- averaged measurement of a speaker (every wizard measurement)
const conv = (x, h) => { const N = nextPow2(x.length + h.length), A = new Float64Array(N), Ai = new Float64Array(N), B = new Float64Array(N), Bi = new Float64Array(N); A.set(x); B.set(h); fft(A, Ai); fft(B, Bi); for (let k = 0; k < N; k++) { const r = A[k] * B[k] - Ai[k] * Bi[k], q = A[k] * Bi[k] + Ai[k] * B[k]; A[k] = r; Ai[k] = q; } fft(A, Ai, true); return A; };
suite('measureAveraged: arrival time and polarity survive averaging jittered sweeps');
{
  const stim = makeStimulus(SR, { level: -12, sweepSec: 0.8 }), dL = 140, dRef = 31;   // speaker path 140 samples (2.92 ms), timing reference path 31 samples
  const room = pol => { const h = new Float32Array(2400); h[dL] = 0.5 * pol; h[dL + 90] = -0.2 * pol; h[dL + 400] = 0.1 * pol; for (let i = 0; i < 1500; i++) h[dL + 100 + i] += 0.05 * pol * Math.sin(i * 0.13) * Math.exp(-i / 300); return h; };
  const ref = new Float32Array(100); ref[dRef] = 0.4;
  const make = (pol, sd, N, jitter) => {
    const y = conv(stim.L, room(pol)), r = conv(stim.R, ref), takes = [];
    for (let k = 0; k < N; k++) {
      const off = 18000 + (jitter ? Math.floor(rnd() * 3000) : 0), len = off + stim.total + Math.round(0.9 * SR), rec = noise(len, sd);
      for (let i = 0; i < stim.total; i++) rec[off + i] += y[i] + r[i];
      takes.push({ rec, offset: off, peakDb: -20 + k });
    }
    return takes;
  };
  const run = async (takes, gate) => { let i = 0; return measureAveraged({ sweeps: takes.length, stim, grab: async () => takes[i++], gate }); };
  const expectArr = ((dL - dRef) / SR) * 1000;
  for (const pol of [1, -1]) {
    const clean = analyseRecording(make(pol, 0, 1, false)[0].rec, stim, 18000);
    const takes = make(pol, 0.004, 4, true), one = analyseRecording(takes[0].rec, stim, takes[0].offset), avg = await run(takes);
    test(`polarity ${pol > 0 ? '+' : '-'}: the noise-free single sweep gives the true arrival and polarity`, () => { near(clean.arrivalMs, expectArr, 0.03); eq(clean.polarity, pol); });
    test(`polarity ${pol > 0 ? '+' : '-'}: averaged arrival equals the true one within one sample, polarity kept`, () => { near(avg.arrivalMs, expectArr, 1000 / SR + 1e-6); eq(avg.polarity, pol); eq(avg.sweeps, 4); eq(avg.dropped, 0); });
    test(`polarity ${pol > 0 ? '+' : '-'}: averaged IR peak sits at the same index offset (irPeak) and SNR improves`, () => {
      eq(avg.irPeak, one.irPeak); ok(Math.abs(avg.ir[avg.irPeak]) > 0 && Math.sign(avg.ir[avg.irPeak]) === pol);
      ok(avg.snrDb > one.snrDb + 3, `snr ${one.snrDb.toFixed(1)} -> ${avg.snrDb.toFixed(1)}`);
    });
    test(`polarity ${pol > 0 ? '+' : '-'}: result carries repeatability, max peakDb and recLen`, () => { ok(avg.rep && avg.rep.n === 4 && avg.rep.maxStd >= 0); eq(avg.peakDb, -17); ok(avg.recLen > stim.total); });
  }
  test('curve of the averaged IR matches the single noise-free one (level and shape)', async () => {
    const takes = make(1, 0.002, 2, true), avg = await run(takes), c0 = irToCurve(analyseRecording(make(1, 0, 1, false)[0].rec, stim, 18000).ir, SR, { peak: 240 }), c1 = irToCurve(avg.ir, SR, { peak: avg.irPeak });
    let worst = 0; c0.f.forEach((f, i) => { if (f > 200 && f < 8000) worst = Math.max(worst, Math.abs(c0.db[i] - c1.db[i])); });
    ok(worst < 1.5, 'worst ' + worst.toFixed(2));
  });
  test('N = 1 is bit-identical to analyseRecording', async () => {
    const t = make(1, 0.003, 1, false), a = analyseRecording(t[0].rec, stim, t[0].offset), b = await run(t);
    eq(b.arrivalMs, a.arrivalMs); eq(b.snrDb, a.snrDb); eq(b.polarity, a.polarity); eq(Array.from(b.ir.slice(0, 400)), Array.from(a.ir.slice(0, 400)));
  });
  {
    let grabs = 0, err = null;
    try { await measureAveraged({ sweeps: 4, stim, grab: async () => { grabs++; return { rec: noise(18000 + stim.total + 40000, 0.001), offset: 18000, peakDb: -60 }; }, gate: a => { if (a.snrDb < 15) throw Object.assign(new Error('no signal'), { noSignal: true }); } }); } catch (e) { err = e; }
    test('no-signal gate runs on the first sweep only: a dead speaker fails after one sweep', () => { ok(err && err.noSignal); eq(grabs, 1); });
  }
  {
    // one sweep where noise wins the peak with the opposite sign must not wreck the average
    const takes = make(1, 0.002, 3, true); const bad = takes[1].rec; for (let i = 0; i < 400; i++) bad[takes[1].offset + dL - 200 + i] = 0;
    const avg = await run(takes);
    test('arrival still right with a damaged sweep in the set', () => near(avg.arrivalMs, expectArr, 0.05));
  }
}

suite('level / ambient / estimate helpers');
{
  test('suggestLevel: in range keeps, too low raises, too loud lowers, never above -3', () => {
    eq(suggestLevel({ level: -12, peakDb: -9, snrDb: 50, gainDb: 20 }), { level: -12, changed: false, reason: 'ok' });
    const lo = suggestLevel({ level: -20, peakDb: -20, snrDb: 40, gainDb: 15 }); eq(lo.level, -9); eq(lo.reason, 'low');
    const hi = suggestLevel({ level: -6, peakDb: -2, snrDb: 60, gainDb: 20 }); eq(hi.level, -13); ok(['high', 'clip'].includes(hi.reason));
    const mx = suggestLevel({ level: -12, peakDb: -50, snrDb: 30, gainDb: 10 }); eq(mx.level, -3); eq(mx.reason, 'max');
    const cl = suggestLevel({ level: -3, peakDb: -0.5, snrDb: 60, gainDb: 20 }); eq(cl.reason, 'clip'); ok(cl.level < -3);
  });
  test('suggestLevel: no signal leaves the level alone', () => { const r = suggestLevel({ level: -12, peakDb: -60, snrDb: 3, gainDb: 0.5 }); eq(r.level, -12); eq(r.reason, 'nosignal'); });
  test('ambientVerdict thresholds', () => { eq(ambientVerdict({ noiseRmsDb: -60, sweepRmsDb: -12 }).level, 'ok'); eq(ambientVerdict({ noiseRmsDb: -50, sweepRmsDb: -12 }).level, 'warn'); eq(ambientVerdict({ noiseRmsDb: -40, sweepRmsDb: -12 }).level, 'bad'); });
  test('estimateSeconds grows with sweeps, positions and channels', () => {
    const b = estimateSeconds({ chans: 4, positions: 1, sweeps: 1 }), t = estimateSeconds({ chans: 4, positions: 1, sweeps: 4 });
    ok(t > b && estimateSeconds({ chans: 4, positions: 3, sweeps: 1 }) > b * 2 && estimateSeconds({ chans: 4, sweeps: 2, checks: false }) < estimateSeconds({ chans: 4, sweeps: 2 }));
  });
  test('meanSnrCurve / noiseSummary', () => {
    eq(meanSnrCurve([{}, {}]), null); eq(meanSnrCurve([{ snrF: { f: [1, 2], snr: [10, 20] } }, { snrF: { f: [1, 2], snr: [20, 30] } }]).snr, [15, 25]);
    const ns = noiseSummary(welchNoise(noise(4 * SR, 0.01), SR, 8192), -40); ok(ns.f.length > 25 && near(ns.db[10], db10(1e-4), 1.5) === undefined && ns.rmsDb === -40);
  });
  test('positionQuality flags repeatability above 1.5 dB', () => {
    const m = (rep) => ({ ir: new Float32Array(2048).fill(0).map((_, i) => (i === 100 ? 1 : 0)), sr: 48000, snrDb: 50, rep: rep == null ? null : { maxStd: rep } });
    const good = positionQuality({ FL: [m(0.6)] }, ['FL'])[0], bad = positionQuality({ FL: [m(2.1)] }, ['FL'])[0], none = positionQuality({ FL: [m(null)] }, ['FL'])[0];
    ok(good.ok && good.repDb === 0.6); ok(!bad.ok && bad.reasons.includes('rep')); ok(none.ok && none.repDb === null);
  });
}
done('avg.test.mjs');
