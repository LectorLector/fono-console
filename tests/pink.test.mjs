// Pink noise (web/js/pink.js): true -3 dB/oct buffer, power averaging, band level from a spectrum, level offsets between speakers.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { makePink, pinkLength, powerMeanDb, bandLevelDb, avgAlpha, overlapBand, bandsFor, summariseRun, computeOffsets, MAIN_BAND, SUB_BAND } from '../web/js/pink.js';
import { welchNoise } from '../web/js/avg.js';

const SR = 48000;
let seed = 4242;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

suite('pink buffer');
{
  const n = pinkLength(SR), x = makePink(n, { rng: rnd, sr: SR });
  test('at least 10 s (16 s planned) at the usual sample rates', () => { for (const sr of [44100, 48000, 96000, 192000]) ok(pinkLength(sr) / sr >= 16, 'sr ' + sr); ok(n / SR >= 10); });
  test('level: RMS 0.15, peak below 0.9, no DC', () => {
    let e = 0, s = 0, pk = 0; for (const v of x) { e += v * v; s += v; pk = Math.max(pk, Math.abs(v)); }
    near(Math.sqrt(e / n), 0.15, 0.005); ok(pk <= 0.9 + 1e-6, 'peak ' + pk); near(s / n, 0, 1e-3);
  });
  test('slope -3.01 dB/oct within +-0.5 from 50 Hz to 10 kHz (welchNoise, 1/3-octave bands)', () => {
    const W = welchNoise(x, SR, 16384), pts = [];
    for (let c = 50; c <= 10001; c *= Math.pow(2, 1 / 3)) {
      let s = 0, k = 0; W.f.forEach((f, i) => { if (f >= c / Math.pow(2, 1 / 6) && f < c * Math.pow(2, 1 / 6)) { s += W.p[i]; k++; } });
      pts.push([Math.log2(c), 10 * Math.log10(s / k)]);
    }
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const slope = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    near(slope, -3.01, 0.5, 'overall slope');
    // every octave step (not only the average) stays within the tolerance
    for (let i = 3; i < pts.length; i++) near(pts[i][1] - pts[i - 3][1], -3.01, 0.5, `octave ending at ${Math.round(2 ** pts[i][0])} Hz`);
  });
  test('nothing below 10 Hz', () => { const W = welchNoise(x, SR, 16384); ok(W.p[1] < W.p[Math.round(30 * 16384 / SR)] / 4, 'bin 1 (2.9 Hz) is cut'); });
  test('does not repeat like a short loop: no correlation at 3 s, 6 s, 10 s lags', () => {
    for (const lag of [3, 6, 10]) { const L = Math.round(lag * SR); let a = 0, e = 0; for (let i = 0; i < 400000; i++) { a += x[i] * x[i + L]; e += x[i] * x[i]; } ok(Math.abs(a / e) < 0.05, `lag ${lag} s: ${(a / e).toFixed(3)}`); }
  });
  test('periodic in its own length (seamless loop): last and first sample are neighbours', () => {
    let d = 0, v = 0; for (let i = 0; i < 2000; i++) { d += Math.abs(x[(n - 1000 + i) % n] - x[(n - 1000 + i + 1) % n]); v += Math.abs(x[i] - x[i + 1]); }
    ok(d / v < 1.3 && d / v > 0.7, 'jump at the seam ' + (d / v).toFixed(2));
  });
}

suite('power averaging');
{
  test('equal values stay', () => near(powerMeanDb([-30, -30, -30]), -30, 1e-9));
  test('power mean, not dB mean: 0 and -10 dB give -2.6 dB (mean of dB would be -5)', () => near(powerMeanDb([0, -10]), 10 * Math.log10((1 + 0.1) / 2), 1e-9));
  test('a louder burst dominates', () => ok(powerMeanDb([-40, -40, -40, -20]) > -27));
  test('-Infinity bins (digital silence) do not poison the mean', () => ok(Number.isFinite(powerMeanDb([-Infinity, -30]))));
  test('avgAlpha: ramp = running mean (1/k), then exponential', () => {
    near(avgAlpha(0.1, 0, 10, true), 1, 1e-9); near(avgAlpha(0.1, 0.9, 10, true), 0.1, 1e-9);
    near(avgAlpha(0.1, 10, 10, true), 1 - Math.exp(-0.01), 1e-12); near(avgAlpha(0.1, 0.9, 10, false), 1 - Math.exp(-0.01), 1e-12);
  });
  test('ramped average of a constant-power sequence equals its mean after 10 s', () => {
    let p = 0, t = 0; const dt = 0.1; const xs = []; for (let i = 0; i < 100; i++) xs.push(i % 2 ? 4 : 1);
    xs.forEach((v, i) => { p = i ? p + (v - p) * avgAlpha(dt, t, 10, true) : v; t += dt; });
    near(p, 2.5, 1e-9);
  });
}

suite('band level from a spectrum');
{
  const n = 32768, bins = new Float32Array(n / 2).fill(-200), k = f => Math.round(f * n / SR);
  test('one bin: its own level', () => { bins[k(1000)] = -40; near(bandLevelDb(bins, SR, n, 500, 2000), -40, 1e-6); bins[k(1000)] = -200; });
  test('two equal bins add 3 dB; a bin outside the band is ignored', () => {
    bins[k(1000)] = -40; bins[k(1200)] = -40; bins[k(5000)] = -10; near(bandLevelDb(bins, SR, n, 500, 2000), -40 + 3.0103, 1e-4); bins.fill(-200);
  });
  test('pink spectrum: every octave carries the same power (500-1k = 1k-2k), full band is 10*log10(octaves) above', () => {
    for (let i = 1; i < bins.length; i++) bins[i] = -30 - 10 * Math.log10((i * SR) / n / 1000);
    near(bandLevelDb(bins, SR, n, 500, 1000) - bandLevelDb(bins, SR, n, 1000, 2000), 0, 0.05);
    near(bandLevelDb(bins, SR, n, 20, 20000) - bandLevelDb(bins, SR, n, 1000, 2000), 10 * Math.log10(Math.log2(1000)), 0.3);
  });
  test('bands: mains 500-2k, subs 30-80, overlap around the crossover +-half an octave', () => {
    eq(MAIN_BAND, [500, 2000]); eq(SUB_BAND, [30, 80]);
    const [a, b] = overlapBand(80); near(a, 56.57, 0.01); near(b, 113.14, 0.01); eq(bandsFor(true, 100).own, [30, 80]); eq(bandsFor(false, 100).x, overlapBand(100));
  });
}

suite('offsets');
{
  const frames = (own, x, n = 100) => Array.from({ length: n }, () => ({ own, x }));
  const runs = { FL: summariseRun(frames(-30, -34)), FR: summariseRun(frames(-31.5, -35.5)), SL: summariseRun(frames(-36, -40)), SW1: summariseRun(frames(-25, -39)) };
  const R = computeOffsets(runs, { ref: 'FL', gains: { FL: 0, FR: 0, SL: -6, SW1: 0 }, subs: ['SW1'] });
  test('mains: offset = ref - own band', () => { near(R.FR.offset, 1.5, 1e-9); near(R.SL.offset, 6, 1e-9); });
  test('the reference has offset 0', () => eq(R.FL.offset, 0));
  test('a subwoofer is matched on the overlap band, not on its own (30-80 Hz) level', () => { eq(R.SW1.cmp, 'x'); near(R.SW1.offset, 5, 1e-9); near(R.SW1.level, -25, 1e-9); });
  test('suggested = current + offset, shifted so nothing is above 0 dB (the loudest is turned down, not the quiet ones up)', () => {
    // raw: FL 0, FR +1.5, SL 0, SW1 +5 -> shift 5
    eq(R.FL.suggested, -5); eq(R.FR.suggested, -3.5); eq(R.SL.suggested, -5); eq(R.SW1.suggested, 0);
  });
  test('relative differences between speakers after the shift equal the offsets (FL / FR / SL)', () => {
    const q = computeOffsets({ FL: summariseRun(frames(-30, -30)), FR: summariseRun(frames(-31.5, -30)), SL: summariseRun(frames(-33, -30)) }, { gains: {} });
    eq([q.FL.suggested, q.FR.suggested, q.SL.suggested], [-3, -1.5, 0]);
  });
  test('rounded to 0.5 dB and clamped to +-12 dB', () => {
    const r = computeOffsets({ FL: summariseRun(frames(-30, -30)), FR: summariseRun(frames(-31.33, -30)) }, { gains: {} });
    eq([r.FL.suggested, r.FR.suggested], [-1.5, 0]);
    const q = computeOffsets({ FL: summariseRun(frames(-30, -30)), FR: summariseRun(frames(-60, -30)) }, { gains: {} }); eq([q.FL.suggested, q.FR.suggested], [-12, 0]);
    const w = computeOffsets({ FL: summariseRun(frames(-30, -30)), FR: summariseRun(frames(-10, -30)) }, { gains: { FR: -5 } }); eq(w.FR.suggested, -12);
  });
  test('repeat spread: two halves of the run compared', () => {
    const f = [...frames(-30, -30, 50), ...frames(-31, -30, 50)];
    near(summariseRun(f).spread, 1, 1e-9); near(summariseRun(f).own, powerMeanDb([-30, -31]), 1e-9); near(summariseRun(frames(-30, -30)).spread, 0, 1e-9);
  });
}
done('pink.test.mjs');
