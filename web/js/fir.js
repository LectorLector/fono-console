// FIR phase correction: removes the excess (non-minimum) phase of a speaker,
// from a measured impulse response or from a crossover model, as a linear-phase
// all-pass FIR for EQ APO's Convolution.
import { fft, nextPow2 } from './fft.js';

export const FIR_TAPS_48K = 8192; // ~85 ms latency at 48 kHz

function unwrap(ph) {
  const out = Float64Array.from(ph);
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > Math.PI) { out[i] -= 2 * Math.PI; d -= 2 * Math.PI; }
    while (d < -Math.PI) { out[i] += 2 * Math.PI; d += 2 * Math.PI; }
  }
  return out;
}

/** Spectrum of an IR with its peak moved to t=0 and a right-side window. */
function spectrum(ir, peak, sr, rightMs, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const left = Math.round(0.001 * sr), right = Math.round((rightMs / 1000) * sr);
  for (let i = -left; i < right; i++) {
    const j = peak + i; if (j < 0 || j >= ir.length) continue;
    let w = 1;
    if (i < 0) w = 0.5 + 0.5 * Math.cos((Math.PI * i) / left);
    else if (i > right * 0.6) w = 0.5 + 0.5 * Math.cos((Math.PI * (i - right * 0.6)) / (right * 0.4));
    re[(i + N) % N] = ir[j] * w;
  }
  fft(re, im);
  return { re, im };
}

function minimumPhase(mag) { // real cepstrum method, mag: |H| (length N)
  const N = mag.length;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < N; k++) re[k] = Math.log(Math.max(mag[k], 1e-9));
  fft(re, im, true);
  for (let n = 1; n < N / 2; n++) { re[n] *= 2; im[n] *= 2; }
  for (let n = N / 2 + 1; n < N; n++) { re[n] = 0; im[n] = 0; }
  im[0] = 0;
  fft(re, im);
  return Float64Array.from(im); // phase of exp(...) = imaginary part
}

function taper(f, lo, hi) {
  if (f >= lo && f <= hi) return 1;
  const oct = f < lo ? Math.log2(lo / f) : Math.log2(f / hi);
  return oct >= 0.7 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * oct) / 0.7);
}

function smoothLog(f, y, frac) {
  const out = new Float64Array(y.length), h = Math.pow(2, 1 / (2 * frac));
  let a = 0, b = 0, s = 0;
  for (let i = 0; i < f.length; i++) {
    while (b < f.length && f[b] <= f[i] * h) { s += y[b]; b++; }
    while (a < b && f[a] < f[i] / h) { s -= y[a]; a++; }
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

/** Excess phase (radians) vs frequency from a measured IR. */
export function excessPhaseFromIR(ir, sr, { lo = 200, hi = 12000 } = {}) {
  const N = 32768;
  let peak = 0, m = 0;
  for (let i = 0; i < ir.length; i++) if (Math.abs(ir[i]) > m) { m = Math.abs(ir[i]); peak = i; }
  // Frequency-dependent window: short above 1 kHz (direct sound), longer below.
  const sS = spectrum(ir, peak, sr, 4, N), sL = spectrum(ir, peak, sr, 25, N);
  const half = N / 2, f = [], ex = [];
  const magS = new Float64Array(N), magL = new Float64Array(N);
  for (let k = 0; k < N; k++) { magS[k] = Math.hypot(sS.re[k], sS.im[k]); magL[k] = Math.hypot(sL.re[k], sL.im[k]); }
  const pmS = minimumPhase(magS), pmL = minimumPhase(magL);
  const phS = unwrap(Array.from({ length: half }, (_, k) => Math.atan2(sS.im[k], sS.re[k])));
  const phL = unwrap(Array.from({ length: half }, (_, k) => Math.atan2(sL.im[k], sL.re[k])));
  for (let k = 1; k < half; k++) {
    const fr = (k * sr) / N;
    const t = Math.min(1, Math.max(0, Math.log2(fr / 500) / 1)); // blend 500 Hz -> 1 kHz
    f.push(fr);
    ex.push((1 - t) * (phL[k] - pmL[k]) + t * (phS[k] - pmS[k]));
  }
  // remove residual pure delay (linear phase) fitted over the band
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] < lo || f[i] > hi) continue;
    const w = 1 / f[i], x = 2 * Math.PI * f[i], y = ex[i];
    sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y;
  }
  const slope = (sw * sxy - sx * sy) / (sw * sxx - sx * sx || 1), icpt = (sy - slope * sx) / (sw || 1);
  const k2 = Math.round(icpt / (2 * Math.PI)) * 2 * Math.PI;
  const res = ex.map((y, i) => y - slope * 2 * Math.PI * f[i] - k2);
  return { f, phase: Array.from(smoothLog(f, res, 6)), delayMs: (-slope * 1000) };
}

// ---------------------------------------------------------------- crossover model
function cmul(a, b) { return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]; }
function cdiv(a, b) { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; }
const BUTTER = { 2: [[1.4142]], 3: [[1]], 4: [[0.7654], [1.8478]] };
function butterDen(s, order) { // product of 2nd-order sections (and a 1st-order term for odd orders)
  let d = [1, 0];
  if (order === 3) d = cmul(d, [s[0] + 1, s[1]]);
  for (const [b] of order === 3 ? [[1]] : BUTTER[order]) d = cmul(d, [s[0] * s[0] - s[1] * s[1] + b * s[0] + 1, 2 * s[0] * s[1] + b * s[1]]);
  return d;
}

/** Phase (radians) of a 2-way LR4 crossover sum and a woofer/port high-pass. */
export function modelPhase(fr, { xover = 3000, hpFreq = 50, hpOrder = 4 } = {}) {
  let ph = 0;
  if (xover > 0) { // LR4 sum = (1 + s^4) / (s^2 + sqrt2 s + 1)^2
    const s = [0, fr / xover];
    const s2 = cmul(s, s), s4 = cmul(s2, s2);
    const den = cmul([s2[0] + 1.4142 * s[0] + 1, s2[1] + 1.4142 * s[1]], [s2[0] + 1.4142 * s[0] + 1, s2[1] + 1.4142 * s[1]]);
    const h = cdiv([1 + s4[0], s4[1]], den);
    ph += Math.atan2(h[1], h[0]);
  }
  if (hpFreq > 0 && hpOrder > 0) {
    const s = [0, fr / hpFreq];
    let num = [1, 0];
    for (let i = 0; i < hpOrder; i++) num = cmul(num, s);
    const h = cdiv(num, butterDen(s, hpOrder));
    ph += Math.atan2(h[1], h[0]);
  }
  return ph;
}

export function excessPhaseFromModel(m, sr) {
  const f = [], phase = [];
  for (let fr = 10; fr < sr / 2; fr *= Math.pow(2, 1 / 96)) { f.push(fr); phase.push(modelPhase(fr, m)); }
  return { f, phase: Array.from(unwrap(phase)), delayMs: 0 };
}

function interpPhase(ex, fr) {
  const { f, phase } = ex;
  if (fr <= f[0]) return phase[0];
  if (fr >= f[f.length - 1]) return phase[phase.length - 1];
  let a = 0, b = f.length - 1;
  while (b - a > 1) { const c = (a + b) >> 1; if (f[c] <= fr) a = c; else b = c; }
  const t = (fr - f[a]) / (f[b] - f[a]);
  return phase[a] + (phase[b] - phase[a]) * t;
}

/** Linear-phase all-pass FIR that cancels `ex` between lo and hi. */
export function designFIR(ex, sr, { lo = 200, hi = 12000, taps48 = FIR_TAPS_48K } = {}) {
  // Same latency at every sample rate: L/2 samples = taps48/2 at 48 kHz.
  const L = 2 * Math.round(((taps48 / 2) * sr) / 48000);
  const N = nextPow2(L);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k <= N / 2; k++) {
    const fr = (k * sr) / N;
    const p = k === 0 ? 0 : -interpPhase(ex, fr) * taper(fr, lo, hi);
    const d = -Math.PI * k; // centre delay N/2 samples: exp(-j 2pi k (N/2)/N)
    re[k] = Math.cos(p + d); im[k] = Math.sin(p + d);
    if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
  }
  im[N / 2] = 0;
  fft(re, im, true);
  const h = new Float32Array(L), edge = Math.round(L * 0.12), off = N / 2 - L / 2;
  for (let i = 0; i < L; i++) {
    let w = 1;
    if (i < edge) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge);
    else if (i > L - edge) w = 0.5 - 0.5 * Math.cos((Math.PI * (L - i)) / edge);
    h[i] = re[off + i] * w;
  }
  return { h, latencyMs: ((L / 2) / sr) * 1000 };
}

/** Group delay (ms) of a phase curve. */
export function groupDelay(ex) {
  const { f, phase } = ex, out = [];
  for (let i = 1; i < f.length - 1; i++) out.push(-(phase[i + 1] - phase[i - 1]) / (2 * Math.PI * (f[i + 1] - f[i - 1])) * 1000);
  return { f: f.slice(1, -1), ms: out };
}

/** Phase of an FIR's response at fr (relative to its centre delay). */
export function firPhaseAt(h, sr, fr) {
  const c = h.length / 2;
  let re = 0, im = 0;
  const w = (2 * Math.PI * fr) / sr;
  for (let n = 0; n < h.length; n++) { re += h[n] * Math.cos(w * (n - c)); im -= h[n] * Math.sin(w * (n - c)); }
  return { phase: Math.atan2(im, re), mag: Math.hypot(re, im) };
}
