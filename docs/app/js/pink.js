// Pink noise and the maths behind the pink-noise level matching (pure functions: no DOM, no audio, unit-tested in tests/pink.test.mjs).
import { fft, nextPow2 } from './fft.js';

/** Length (samples) of the pink-noise buffer: a power of two of at least `minSec` seconds (16 s -> 21.8 s at 48 kHz). */
export const pinkLength = (sr, minSec = 16) => nextPow2(Math.ceil(sr * minSec));

/**
 * True pink noise (power density ~ 1/f, -3.01 dB per octave) made in the frequency domain: gaussian white noise, every FFT bin scaled by
 * 1/sqrt(f), content below 10 Hz removed (no DC / subsonic). The result is periodic in its own length, so a looping buffer has no seam
 * and no crossfade; at 16 s or more the loop is not heard as a pattern. rms = target RMS (linear); the peak is limited to 0.9.
 * (The Paul Kellet filter this replaces was 6 s long and flattened below ~100 Hz: only -1.6 dB between 50 and 100 Hz.)
 */
export function makePink(n, { rms = 0.15, rng = Math.random, sr = 48000 } = {}) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(rng() + 1e-12)), t = 2 * Math.PI * rng();
    re[i] = r * Math.cos(t); if (i + 1 < n) re[i + 1] = r * Math.sin(t);
  }
  fft(re, im);
  const k10 = Math.ceil((10 * n) / sr);
  for (let k = 0; k <= n / 2; k++) {
    const g = k < k10 ? 0 : 1 / Math.sqrt(k);
    re[k] *= g; im[k] *= g;
    if (k > 0 && k < n / 2) { re[n - k] *= g; im[n - k] *= g; }
  }
  im[0] = 0; im[n / 2] = 0;
  fft(re, im, true);
  let e = 0, pk = 0;
  for (let i = 0; i < n; i++) { e += re[i] * re[i]; pk = Math.max(pk, Math.abs(re[i])); }
  const k = Math.min(rms / Math.sqrt(e / n), 0.9 / pk), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i] * k;
  return out;
}

// ---------------------------------------------------------------- levels
const pw = db => Math.pow(10, db / 10), dbOf = p => 10 * Math.log10(p + 1e-20);

/** Power (energy) mean of dB values: 10*log10(mean(10^(x/10))). Not the mean of the dB values (that would under-read a fluctuating signal). */
export function powerMeanDb(db) {
  if (!db.length) return -Infinity;
  let s = 0; for (const x of db) s += pw(Math.max(-200, x));
  return dbOf(s / db.length);
}

/** Total power (dB) of the analyser bins (per-bin dB) between f0 and f1: the sum of the bin powers. bins.length = n / 2, n = fftSize. */
export function bandLevelDb(bins, sr, n, f0, f1) {
  const i0 = Math.max(1, Math.round((f0 * n) / sr)), i1 = Math.min(bins.length - 1, Math.round((f1 * n) / sr));
  let s = 0; for (let i = i0; i <= i1; i++) s += pw(Math.max(-200, bins[i]));
  return dbOf(s);
}

/**
 * Weight of the newest sample in the running average. Normal exponential average: 1 - exp(-dt / tau). While the average is still
 * filling (ramp, elapsed < tau seconds since it started) use dt / (elapsed + dt) instead, which makes it the plain mean of everything
 * so far: after tau seconds it is a true 10 s average, afterwards it keeps sliding with time constant tau.
 */
export function avgAlpha(dt, elapsed, tau, ramp = false) {
  const a = 1 - Math.exp(-dt / tau);
  return ramp && elapsed < tau ? Math.max(a, dt / (elapsed + dt)) : a;
}

// ---------------------------------------------------------------- level matching
export const MAIN_BAND = [500, 2000];     // mains: where a small speaker is flat and direction/room matter least
export const SUB_BAND = [30, 80];         // subwoofers: their own pass-band
/** Overlap band around the crossover (half an octave to each side): mains and subs both radiate here, so it is where they must match. */
export const overlapBand = xover => [xover / Math.SQRT2, xover * Math.SQRT2];
/** Bands measured for one speaker: own = its level, x = the overlap band (compare sub against mains). */
export const bandsFor = (isSub, xover = 80) => ({ own: isSub ? SUB_BAND : MAIN_BAND, x: overlapBand(xover) });

/**
 * One speaker's recorded frames -> averaged levels. frames: [{own, x}] (dB, in time order). Power average over the whole run;
 * spread = |level of the first half - level of the second half| (own band): small means the room and the noise were steady.
 */
export function summariseRun(frames) {
  const own = frames.map(f => f.own), x = frames.map(f => f.x), h = own.length >> 1;
  return { own: powerMeanDb(own), x: powerMeanDb(x), spread: h ? Math.abs(powerMeanDb(own.slice(0, h)) - powerMeanDb(own.slice(h))) : 0, n: own.length };
}

/**
 * Gain offsets relative to the reference speaker. runs: {key: summariseRun()}, gains: {key: current gain dB}, subs: keys that are subwoofers.
 * Mains are matched on their own band (500 Hz-2 kHz): offset = ref.own - k.own. A subwoofer is matched on the overlap band around the crossover
 * (ref.x - k.x), because a sub's own band (30-80 Hz) and the mains' band are different parts of the spectrum.
 * Suggested gain = current + offset, then the whole set is shifted down so that none is above 0 dB (a channel boost is a positive preamp and
 * costs headroom: the louder speakers are turned down instead), rounded to 0.5 dB and clamped to +-12 dB (and to the fader range -24..+6).
 * The offsets themselves (relative to the reference) are not changed by the shift.
 */
export function computeOffsets(runs, { ref = 'FL', gains = {}, subs = [] } = {}) {
  const r = runs[ref], out = {}, raw = {};
  for (const k of Object.keys(runs)) {
    const isSub = subs.includes(k), cmp = isSub ? 'x' : 'own';
    const offset = k === ref || !r ? 0 : r[cmp] - runs[k][cmp], cur = gains[k] || 0;
    out[k] = { level: runs[k].own, x: runs[k].x, spread: runs[k].spread, cmp, offset, current: cur }; raw[k] = cur + offset;
  }
  const shift = Math.max(0, ...Object.values(raw));
  for (const k in out) out[k].suggested = Math.max(-24, Math.min(6, Math.max(-12, Math.min(12, Math.round((raw[k] - shift) * 2) / 2))));
  return out;
}
