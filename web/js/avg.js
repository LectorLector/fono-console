// Averaged mic-pairing measurement: coherent IR averaging, Welch noise spectrum, per-frequency SNR mask, repeatability.
// Pure functions (no DOM, no audio) so they can be unit-tested; the browser I/O is injected into measureMicAveraged().
import { fft, nextPow2 } from './fft.js';
import { irToCurve } from './measure.js';

const argmaxAbs = ir => { let m = -1, at = 0; for (let i = 0; i < ir.length; i++) { const v = Math.abs(ir[i]); if (v > m) { m = v; at = i; } } return at; };

/**
 * Align every IR on its main peak (integer samples, relative to the first IR) and average them coherently.
 * Uncorrelated noise drops by 10*log10(N) dB, the signal stays. Returns {ir, shifts} (shifts[i] = peak_i - peak_0 in samples).
 */
export function alignAndAverage(irs) {
  const n0 = irs[0].length, pk = irs.map(argmaxAbs), out = new Float64Array(n0);
  irs.forEach((ir, k) => {
    const sh = pk[k] - pk[0];
    for (let j = 0; j < n0; j++) { const s = j + sh; if (s >= 0 && s < ir.length) out[j] += ir[s]; }
  });
  for (let j = 0; j < n0; j++) out[j] /= irs.length;
  return { ir: Float32Array.from(out), shifts: pk.map(p => p - pk[0]) };
}

/** Power-domain sliding smoothing of values on an ascending frequency axis, +-half-width of 1/frac octave. */
export function smoothPow(f, p, frac) {
  const half = Math.pow(2, 1 / (2 * frac)), out = new Float64Array(f.length);
  let lo = 0, hi = 0, acc = 0;
  for (let i = 0; i < f.length; i++) {
    const a = f[i] / half, b = f[i] * half;
    while (hi < f.length && f[hi] <= b) { acc += p[hi]; hi++; }
    while (lo < hi && f[lo] < a) { acc -= p[lo]; lo++; }
    out[i] = hi > lo ? Math.max(acc, 0) / (hi - lo) : p[i];
  }
  return out;
}

/**
 * Welch-averaged noise spectrum: Hann window, 50 % overlap, mean removed per segment.
 * p[k] is the two-sided power spectral density per sample, |X_k|^2 / sum(w^2) averaged over the segments,
 * so white noise of variance s^2 gives p = s^2 at every bin (independent of nfft). f[k] = k*sr/nfft.
 */
export function welchNoise(samples, sr, nfft = 16384) {
  const hop = nfft >> 1, w = new Float64Array(nfft);
  let ew = 0;
  for (let i = 0; i < nfft; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft); ew += w[i] * w[i]; }
  const nb = (nfft >> 1) + 1, p = new Float64Array(nb), f = new Float64Array(nb);
  for (let k = 0; k < nb; k++) f[k] = (k * sr) / nfft;
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  let segs = 0;
  for (let s = 0; s + nfft <= samples.length; s += hop) {
    let mean = 0;
    for (let i = 0; i < nfft; i++) mean += samples[s + i];
    mean /= nfft;
    for (let i = 0; i < nfft; i++) { re[i] = (samples[s + i] - mean) * w[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < nb; k++) p[k] += re[k] * re[k] + im[k] * im[k];
    segs++;
  }
  if (!segs) throw new Error('noise recording too short');
  for (let k = 0; k < nb; k++) p[k] /= segs * ew;
  return { f, p, sr, nfft, segs };
}

/** Length of the IR window irToCurve() uses, and the energy sum(w^2) of its 20 % raised-cosine tail (same shape as irToCurve). */
export function curveWindow(irLen, peak, sr, windowMs = 300) {
  const start = Math.max(0, peak - Math.round(0.002 * sr)), n = Math.min(irLen - start, Math.round((windowMs / 1000) * sr)), fadeN = Math.round(n * 0.2);
  let e = 0;
  for (let i = 0; i < n; i++) { let w = 1; if (i > n - fadeN) w = 0.5 + 0.5 * Math.cos((Math.PI * (i - (n - fadeN))) / fadeN); e += w * w; }
  return { n, energy: e };
}

/**
 * Noise expressed on the SAME scale as the curve from irToCurve (20*log10|H(f)|, H = recording / stimulus).
 * Scaling (why each factor is there):
 *  - deconvolve() applies the inverse filter 1/X (X = DTFT of the played sweep), so recording noise of per-sample PSD P(f)
 *    becomes IR noise of per-sample PSD P(f) / |X(f)|^2 (in the part of the IR where the inverse filter fully overlaps the
 *    recording, i.e. around the main arrival, which is where irToCurve looks; NOT P*recLen/nDec, because the circular
 *    deconvolution leaves the noise only in a recLen-long part of the nDec-long IR, which cancels that ratio);
 *  - irToCurve() sums the IR through its window w, so the windowed DFT power of that noise is sum(w^2) * P / |X|^2;
 *  - averaging nSweeps coherently-aligned IRs divides the (uncorrelated) noise power by nSweeps.
 * So noise_dB(f) = 10*log10( P(f) * sum(w^2) / (|X(f)|^2 * nSweeps) ), directly comparable to curve.db.
 * noise: welchNoise() result, f: curve grid, x: played sweep (stim.L), winEnergy: curveWindow().energy.
 */
export function noiseEquivCurve({ noise, f, x, winEnergy, nSweeps = 1, smoothFrac = 6 }) {
  const N = nextPow2(x.length), re = new Float64Array(N), im = new Float64Array(N);
  re.set(x); fft(re, im);
  const sr = noise.sr, ps = smoothPow(noise.f, noise.p, smoothFrac);
  let xmax = 0; const X2 = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) { X2[k] = re[k] * re[k] + im[k] * im[k]; if (X2[k] > xmax) xmax = X2[k]; }
  const db = f.map(fr => {
    const kx = Math.min(N / 2, Math.round((fr * N) / sr)), xs = Math.max(X2[kx], xmax * 1e-9);   // 1e-9: same floor as deconvolve()
    const kn = (fr * noise.nfft) / sr, k0 = Math.min(ps.length - 2, Math.floor(kn)), t = Math.min(1, kn - k0), pn = ps[k0] * (1 - t) + ps[k0 + 1] * t;
    return 10 * Math.log10((pn * winEnergy) / (xs * nSweeps) + 1e-40);
  });
  return { f, db };
}

/** Per-frequency SNR = (1/frac-octave smoothed) signal curve - noise curve; ok = SNR >= thrDb. */
export function snrMask(curve, noiseCurve, thrDb = 15, { smoothFrac = 6 } = {}) {
  const sig = smoothPow(curve.f, curve.db.map(v => Math.pow(10, v / 10)), smoothFrac);
  const snr = curve.f.map((_, i) => 10 * Math.log10(sig[i] + 1e-30) - noiseCurve.db[i]);
  return { f: curve.f, snr, ok: snr.map(v => v >= thrDb) };
}

/**
 * Smooth weights from a reliability mask: 1 where reliable, 0 where not, with a raised-cosine ramp of fadeOct octaves
 * inside the reliable side of every edge (so the stored correction never leans on the first doubtful points).
 */
export function crossfadeMask(f, ok, fadeOct = 1 / 3) {
  const bad = []; ok.forEach((v, i) => { if (!v) bad.push(Math.log2(f[i])); });
  if (!bad.length) return f.map(() => 1);
  return f.map((fr, i) => {
    if (!ok[i]) return 0;
    const l = Math.log2(fr); let d = Infinity;
    for (const b of bad) { const x = Math.abs(l - b); if (x < d) d = x; }
    return d >= fadeOct ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * d) / fadeOct);
  });
}

/** Contiguous [f0, f1] ranges where ok is false (for shading). */
export function badRanges(f, ok) {
  const r = []; let s = -1;
  ok.forEach((v, i) => { if (!v && s < 0) s = i; if ((v || i === ok.length - 1) && s >= 0) { r.push([f[s], f[v ? i - 1 : i]]); s = -1; } });
  return r;
}

/** Repeatability: standard deviation across single-sweep curves per 1/3 octave. maxStd is the worst band in 100 Hz - 10 kHz. */
export function repeatability(curves) {
  if (!curves || curves.length < 2) return null;
  const f = curves[0].f, fc = [], std = [], r = Math.pow(2, 1 / 6);
  for (let k = -17; k <= 13; k++) {
    const c = 1000 * Math.pow(2, k / 3), idx = []; f.forEach((x, i) => { if (x >= c / r && x < c * r) idx.push(i); });
    if (idx.length < 2) continue;
    const m = curves.map(cv => idx.reduce((s, i) => s + cv.db[i], 0) / idx.length), mean = m.reduce((a, b) => a + b, 0) / m.length;
    fc.push(c); std.push(Math.sqrt(m.reduce((s, v) => s + (v - mean) ** 2, 0) / (m.length - 1)));
  }
  let maxStd = 0; fc.forEach((c, i) => { if (c >= 100 && c <= 10000) maxStd = Math.max(maxStd, std[i]); });
  return { fc, std, maxStd, n: curves.length };
}

/**
 * Whole averaged measurement of one microphone.
 * io.grabNoise(sec, onTick(elapsedSec)) -> Float32Array of silence; io.grabSweep() -> analyseRecording() result + recLen.
 * onProgress({step: 'noise'|'sweep'|'calc', left, i, n, frac}); isCancelled() is polled between steps (throws an Error with .cancelled = true).
 */
export async function measureMicAveraged({ sweeps = 4, noiseSec = 10, stim, io, onProgress = () => {}, isCancelled = () => false, nfft = 16384, windowMs = 300 }) {
  const sr = stim.sr, sweepSec = stim.total / sr + 1.5, tot = noiseSec + sweeps * sweepSec;
  const chk = () => { if (isCancelled()) { const e = new Error('已取消'); e.cancelled = true; throw e; } };
  chk(); onProgress({ left: noiseSec, frac: 0, step: 'noise' });
  const silence = await io.grabNoise(noiseSec, el => onProgress({ left: Math.max(0, Math.ceil(noiseSec - el)), frac: Math.min(1, el / tot), step: 'noise' }));
  const noise = welchNoise(silence, sr, nfft);
  const irs = [], curves = [], peaks = []; let first = null;
  for (let i = 0; i < sweeps; i++) {
    chk(); onProgress({ i: i + 1, n: sweeps, frac: (noiseSec + i * sweepSec) / tot, step: 'sweep' });
    const a = await io.grabSweep(); first = first || a;
    irs.push(a.ir); peaks.push(a.peakDb ?? -99); curves.push(irToCurve(a.ir, a.sr, { peak: a.irPeak, windowMs }));
  }
  chk(); onProgress({ frac: 1, step: 'calc' });
  const avg = alignAndAverage(irs), curve = irToCurve(avg.ir, sr, { peak: first.irPeak, windowMs });
  const win = curveWindow(avg.ir.length, first.irPeak, sr, windowMs);
  const noiseCurve = noiseEquivCurve({ noise, f: curve.f, x: stim.L, winEnergy: win.energy, nSweeps: sweeps });
  return { curve, curves, rep: repeatability(curves), noiseCurve, mask: snrMask(curve, noiseCurve, 15), sweeps, shifts: avg.shifts, peakDb: Math.max(...peaks) };
}
