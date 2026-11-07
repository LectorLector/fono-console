// Real-hardware capture helpers (web/js/capture.js): channel pick, clock-drift estimate + resample, track checks, level cap, run lock, paired io.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { pickChannel, channelHealth, micKey, splitKey, chanOf, assessTrack, estimateDrift, resampleDrift, driftCorrect, capLevel, lockBegin, lockEnd, lockHolder } from '../web/js/capture.js';
import { pairedIO } from '../web/js/avg.js';
import { makeStimulus, deconvolve, peakIndex } from '../web/js/measure.js';
import { fft as fftf } from '../web/js/fft.js';

const SR = 48000;
let seed = 4242;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

suite('channel selection');
{
  const l = Float32Array.from([1, 1, 1, 1]), r = Float32Array.from([0, 2, 0, 2]);
  test('L / R / mix', () => { eq(Array.from(pickChannel(l, r, 'L')), [1, 1, 1, 1]); eq(Array.from(pickChannel(l, r, 'R')), [0, 2, 0, 2]); eq(Array.from(pickChannel(l, r, 'mix')), [0.5, 1.5, 0.5, 1.5]); });
  test('mono device (no right channel): every mode returns the only channel, as a copy', () => { for (const m of ['L', 'R', 'mix']) { const o = pickChannel(l, null, m); eq(Array.from(o), [1, 1, 1, 1]); ok(o !== l); } });
  test('two mics on a merge cable stay separate: picking L does not contain R', () => {
    const a = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 0.05)), b = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 0.31));
    const pa = pickChannel(a, b, 'L'), pb = pickChannel(a, b, 'R'); let e = 0; for (let i = 0; i < 4800; i++) e += (pa[i] - a[i]) ** 2 + (pb[i] - b[i]) ** 2; near(e, 0, 1e-12);
  });
  test('channelHealth: mono duplicate, silent channel, two real mics', () => {
    const a = Float32Array.from({ length: 9600 }, () => 0.1 * gauss()), b = Float32Array.from({ length: 9600 }, () => 0.1 * gauss());
    ok(channelHealth(a, Float32Array.from(a)).same, 'duplicate = mono device');
    ok(channelHealth(a, new Float32Array(9600)).silentR, 'silent right');
    const h = channelHealth(a, b); ok(!h.same && !h.silentL && !h.silentR && Math.abs(h.corr) < 0.1, 'independent mics');
    ok(channelHealth(a, null).same, 'no right channel at all counts as mono');
  });
  test('calibration key: device id, plus #L / #R for a merge-cable channel; mix keeps the old key', () => {
    eq(micKey('abc', 'mix'), 'abc'); eq(micKey('abc', 'R'), 'abc#R'); eq(splitKey('abc#L'), { id: 'abc', ch: 'L' }); eq(splitKey('abc'), { id: 'abc', ch: 'mix' });
    eq(chanOf({ mic: { channel: { x: 'R' } } }, 'x'), 'R'); eq(chanOf({ mic: {} }, 'x'), 'mix'); eq(chanOf({ mic: { channel: { x: 'bad' } } }, 'x'), 'mix');
  });
}

suite('track settings and level cap');
{
  test('processing still on is reported', () => { const w = assessTrack({ echoCancellation: true, noiseSuppression: false, autoGainControl: true, sampleRate: 48000, channelCount: 2 }, { sampleRate: 48000, channels: 2 }); eq(w.map(x => x.id), ['echoCancellation', 'autoGainControl']); });
  test('other sample rate / mono input reported; a clean track is silent', () => {
    eq(assessTrack({ sampleRate: 44100, channelCount: 1, echoCancellation: false }, { sampleRate: 48000, channels: 2 }).map(x => x.id), ['sampleRate', 'channelCount']);
    eq(assessTrack({ sampleRate: 48000, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, { sampleRate: 48000, channels: 2 }), []);
    eq(assessTrack({}, {}), []);
  });
  test('output level never above -3 dBFS, sweep and stimulus included', () => {
    eq(capLevel(0), -3); eq(capLevel(-12), -12); eq(capLevel(NaN), -20);
    const s = makeStimulus(SR, { level: 6, sweepSec: 1 }); let pk = 0; for (const v of s.L) pk = Math.max(pk, Math.abs(v)); for (const v of s.Rplay) pk = Math.max(pk, Math.abs(v));
    ok(pk <= Math.pow(10, -3 / 20) + 1e-6, 'peak ' + pk);
  });
  test('sweep and timing chirps start and end at zero (no click)', () => {
    const s = makeStimulus(SR, { level: -12, sweepSec: 2 });
    near(s.L[0], 0, 1e-9); near(s.L[s.total - 1], 0, 1e-9); near(s.Rplay[0], 0, 1e-9); near(s.Rplay[s.total - 1], 0, 1e-9);
  });
}

suite('run lock');
{
  test('one measurement at a time; release by the owner only', () => {
    ok(lockBegin('wizard')); ok(!lockBegin('mic')); eq(lockHolder(), 'wizard'); lockEnd('mic'); eq(lockHolder(), 'wizard'); lockEnd('wizard'); eq(lockHolder(), null); ok(lockBegin('mic')); lockEnd('mic');
  });
}

suite('paired io (two mics, one recording)');
{
  test('B replays what A recorded, in order, without recording again', async () => {
    let n = 0; const pr = pairedIO({ grabNoise2: async () => [`nA`, `nB`], grabSweep2: async () => { n++; return [`a${n}`, `b${n}`]; } });
    const out = [await pr.A.grabNoise(1), await pr.A.grabSweep(), await pr.A.grabSweep()];
    eq(out, ['nA', 'a1', 'a2']);
    const outB = [await pr.B.grabNoise(1), await pr.B.grabSweep(), await pr.B.grabSweep()];
    eq(outB, ['nB', 'b1', 'b2']); eq(n, 2);
  });
}

suite('clock drift');
{
  // "rec" = what the microphone captured: the played stimulus through a simple room (direct sound at 3.7 ms + one reflection) at the
  // PLAYER's clock, then resampled to the recorder's clock that runs `ppm` faster. Both go through resampleDrift (inverse ratio), so the
  // test asserts the round trip and the estimate, not the interpolator against itself only: the peak / HF numbers are measured on the result.
  const stim = makeStimulus(SR, { level: -12, sweepSec: 5.5 });
  const delay = Math.round(0.0037 * SR), refl = Math.round(0.0112 * SR), offset = 9000;
  const room = x => { const y = new Float32Array(offset + x.length + 2000); for (let i = 0; i < x.length; i++) { y[offset + i + delay] += x[i]; y[offset + i + refl] += 0.35 * x[i]; } return y; };
  const clean = (() => { const L = room(stim.L), R = room(stim.Rplay), y = new Float32Array(L.length); for (let i = 0; i < y.length; i++) y[i] = L[i] + R[i] * 0.8 + 0.0005 * gauss(); return y; })();
  const drifted = ppm => resampleDrift(clean, (1 / (1 + ppm * 1e-6) - 1) * 1e6, offset);   // recorder clock ppm faster: rec(j) = y(j / r)
  const irOf = rec => deconvolve(rec, stim.L, { sr: SR, f1: stim.f1, f2: stim.f2 });
  // Arrival time of the sweep's 12-18 kHz part vs its 100-300 Hz part: a clock mismatch is a frequency dependent delay (50 ppm: ~0.35 ms over the sweep), a clean IR has none
  const hfLag = ir => { const bp = (lo, hi) => { const n = 4096, p = peakIndex(ir, offset, offset + 4000).index, re = new Float64Array(n), im = new Float64Array(n); for (let i = 0; i < n; i++) re[i] = ir[p - 2048 + i]; fftf(re, im); const f = (k) => k * SR / n; for (let k = 0; k < n; k++) { const fr = k <= n / 2 ? f(k) : f(n - k); if (fr < lo || fr > hi) { re[k] = 0; im[k] = 0; } } fftf(re, im, true); return peakIndex(re, 0, n).index; }; return bp(12000, 18000) - bp(100, 300); };
  const ref = irOf(clean);
  for (const ppm of [-80, -50, 50, 120]) {
    test(`estimate recovers ${ppm} ppm`, () => { const d = estimateDrift(drifted(ppm), stim, offset); ok(d.ok, 'found both chirps'); near(d.ppm, ppm, 3); });
  }
  test('no drift: estimate ~0 and nothing is resampled', () => { const d = estimateDrift(clean, stim, offset); ok(d.ok); near(d.ppm, 0, 3); const c = driftCorrect([clean], stim, offset); ok(!c.applied && c.recs[0] === clean); });
  for (const ppm of [50, -50]) {
    test(`${ppm} ppm: correction removes the HF smear`, () => {
      const bad = drifted(ppm), c = driftCorrect([bad], stim, offset); ok(c.applied, 'applied'); near(c.ppm, ppm, 3);
      const lRef = hfLag(ref), lBad = hfLag(irOf(bad)), lFix = hfLag(irOf(c.recs[0]));
      console.log(`    ${ppm} ppm: 12-18 kHz arrives ${lRef} samples after 100-300 Hz undrifted, ${lBad} drifted, ${lFix} corrected (estimate ${c.ppm.toFixed(1)} ppm)`);
      ok(Math.abs(lBad - lRef) >= 7, 'the drift is visible'); ok(Math.abs(lFix - lRef) <= 2, 'frequency-dependent delay removed');
    });
  }
  test('both channels get the same correction; a recording without the chirps is left alone', () => {
    const bad = drifted(60), c = driftCorrect([bad, bad], stim, offset); ok(c.applied); near(c.recs[0][70000], c.recs[1][70000], 1e-9);
    const noise = Float32Array.from({ length: clean.length }, () => 0.01 * gauss()); const n = driftCorrect([noise], stim, offset); ok(!n.applied && n.recs[0] === noise);
    ok(!estimateDrift(clean, { ...stim, ref2Start: 0 }, offset).ok, 'stimulus without a second chirp');
  });
}
done('capture.test.mjs');
