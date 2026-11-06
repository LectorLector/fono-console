// Simulated bedroom for the demo / tutorial: the same rectangular-room modal model
// as research/art/sim.py, producing "measurements" for 4 speakers at 15 positions.
import { fft } from './fft.js';

/** Source positions of the simulated bedroom (m; x along the length from the front wall, y from the left wall, z height). Subwoofers exist in the .1 / .2 layouts (subs = 1 or 2). */
export const DEMO_DIMS = { L: 3.6, W: 3.0, H: 2.6 };
export const DEMO_SPK = { FL: [0.35, 0.95, 1.0], FR: [0.35, 2.05, 1.0], SL: [3.3, 0.6, 2.0], SR: [3.3, 2.4, 2.0] };
export const DEMO_SUB = { SW1: [0.3, 0.4, 0.15], SW2: [0.3, 2.6, 0.15] };
export const DEMO_SEAT = [1.6, 1.5, 1.1];
export const demoPositions = (subs = 0, rear = true) => ({ ...Object.fromEntries(Object.entries(DEMO_SPK).filter(([k]) => rear || k.startsWith('F'))), ...Object.fromEntries(Object.entries(DEMO_SUB).slice(0, subs)), seat: DEMO_SEAT });

export function demoMeasurements({ L = [3.6, 3.0, 2.6], t60 = 0.45, sr = 1024, N = 4096, secs = 2, subs = 0 } = {}) {
  const c = 343, d = 6.91 / t60;
  const SPK = { ...DEMO_SPK };
  const ROLL = { FL: 55, FR: 55, SL: 60, SR: 60 };
  // subwoofers (sub layouts only): front corners at floor level, 28 Hz roll-off, 2nd-order low-pass at 150 Hz and a 2.4 ms processing delay,
  // so the demo has something to align (the modal model has no propagation delay of its own)
  const SUB = DEMO_SUB, SUB_DELAY = 0.0024;
  for (const k of ['SW1', 'SW2'].slice(0, subs)) { SPK[k] = SUB[k]; ROLL[k] = 28; }
  const seat = DEMO_SEAT, g = 0.25, u = 0.15;
  const grid = [[0, 0, 0], [-g, 0, 0], [g, 0, 0], [0, -g, 0], [0, g, 0], [-g, -g, 0], [-g, g, 0], [g, -g, 0], [g, g, 0],
    [0, 0, u], [0, 0, -u], [0, -u, u], [0, u, u], [0, -u, -u], [0, u, -u]];
  const modes = [];
  for (let nx = 0; nx < 12; nx++) for (let ny = 0; ny < 12; ny++) for (let nz = 0; nz < 8; nz++) {
    const fn = c / 2 * Math.hypot(nx / L[0], ny / L[1], nz / L[2]);
    if (fn < 320) modes.push([nx, ny, nz, fn, (nx ? 2 : 1) * (ny ? 2 : 1) * (nz ? 2 : 1)]);
  }
  const psi = (m, p) => Math.cos(m[0] * Math.PI * p[0] / L[0]) * Math.cos(m[1] * Math.PI * p[1] / L[1]) * Math.cos(m[2] * Math.PI * p[2] / L[2]);
  const out = {};
  for (const [ch, s] of Object.entries(SPK)) {
    out[ch] = grid.map(off => {
      const r = seat.map((v, i) => v + off[i]);
      const re = new Float64Array(N), im = new Float64Array(N);
      const ws = modes.map(m => [2 * Math.PI * m[3], m[4] * psi(m, s) * psi(m, r)]);
      for (let k = 1; k < N / 2; k++) {
        const w = 2 * Math.PI * k * sr / N;
        let hr = 0, hi = 0;
        for (const [wn, a] of ws) { const dr = wn * wn - w * w, di = 2 * d * w, dd = dr * dr + di * di; hr += a * dr / dd; hi -= a * di / dd; }
        hr *= w * w; hi *= w * w;
        // 4th-order Butterworth high-pass (speaker roll-off)
        const x = (k * sr / N) / ROLL[ch];
        const q = b => [1 - x * x, b * x];
        const mul = (p, q2) => [p[0] * q2[0] - p[1] * q2[1], p[0] * q2[1] + p[1] * q2[0]];
        const den = mul(q(0.7654), q(1.8478)), x4 = x ** 4, dd = den[0] ** 2 + den[1] ** 2;
        const hp = [x4 * den[0] / dd, -x4 * den[1] / dd];
        let v = mul([hr, hi], hp);
        if (ch.startsWith('SW')) {
          const xl = (k * sr / N) / 150, lp = mul([1, 0], [1 - xl * xl, -Math.SQRT2 * xl]), ld = lp[0] ** 2 + lp[1] ** 2;
          const ph = -2 * Math.PI * (k * sr / N) * SUB_DELAY;
          v = mul(mul(v, [lp[0] / ld, lp[1] / ld]), [Math.cos(ph), Math.sin(ph)]);
        }
        re[k] = v[0]; im[k] = v[1]; re[N - k] = v[0]; im[N - k] = -v[1];
      }
      fft(re, im, true);
      return { ir: re.slice(0, Math.round(secs * sr)), sr, irPeak: 0, arrivalMs: 0, snrDb: 60 };
    });
  }
  return out;
}

// ---------------------------------------------------------------- broadband (48 kHz) demo IR
// demoMeasurements() above is a low-frequency modal model sampled at 1024 Hz (good for ART, useless for
// octave-band decay or 0.3 ms reflection matching). For the decay and reflection tabs the demo needs a full-band IR:
// direct sound + the six first-order mirror reflections of the *current* room/positions + an octave-band
// shaped exponential tail. Deterministic (seeded noise), so screenshots and tests are repeatable.
import { OCT_BANDS, octaveFilter, firstReflections } from './acoustics.js';

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const gauss = r => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
// T60 relative to the 125 Hz value: a typical lightly furnished bedroom (long bass, short treble)
const T60_REL = { 63: 1.15, 125: 1, 250: 0.95, 500: 0.85, 1000: 0.8, 2000: 0.7, 4000: 0.55, 8000: 0.4 };
const REFL_GAIN = { front: 0.4, back: 0.45, left: 0.5, right: 0.5, floor: 0.35, ceil: 0.3 };

/**
 * One 48 kHz IR for speaker `src` [x,y,z] heard at `rx` [x,y,z] in a room of dims {L,W,H}.
 * Returns {ir, sr, irPeak, arrivalMs} like a real measurement.
 */
export function demoWideIR(src, rx, dims, { t60 = 0.45, sr = 48000, secs = 1.0, seed = 7 } = {}) {
  const n = Math.round(secs * sr), pre = Math.round(0.005 * sr), r = rng(seed), ir = new Float32Array(n);
  const d0 = Math.hypot(src[0] - rx[0], src[1] - rx[1], src[2] - rx[2]);
  ir[pre] = 1;
  for (const f of firstReflections(src, rx, dims)) {
    const at = pre + Math.round(f.ms / 1000 * sr);
    if (f.ms > 0.05 && at < n - 1) ir[at] += (REFL_GAIN[f.id] || 0.4) * d0 / f.path;
  }
  // diffuse tail, starting 6 ms after the direct sound, about -30 dB at the start, tilted -3 dB/oct from 125 Hz
  const t0 = pre + Math.round(0.006 * sr), len = n - t0;
  for (const fc of OCT_BANDS) {
    const noise = new Float64Array(len); for (let i = 0; i < len; i++) noise[i] = gauss(r);
    const band = octaveFilter(noise, sr, fc), off = Math.round(sr * 0.2);
    let e = 0; for (let i = 0; i < len; i++) e += band[off + i] ** 2;
    const norm = Math.sqrt(len / (e + 1e-30)), tilt = Math.pow(10, -3 * Math.log2(fc / 125) / 20);
    const a = 0.022 * norm * tilt * Math.sqrt(1 / 8), k = 6.91 / (t60 * T60_REL[fc]);
    for (let i = 0; i < len; i++) ir[t0 + i] += a * band[off + i] * Math.exp(-k * i / sr);
  }
  for (let i = 0; i < n; i++) ir[i] += 2e-5 * gauss(r);   // measurement noise floor, about -94 dB
  return { ir, sr, irPeak: pre, arrivalMs: d0 / 343 * 1000 };
}

/** {FL:[m],FR:[m],SL:[m],SR:[m]} full-band demo measurements for the current room; `pos` = {seat:[x,y],ear,FL:[x,y,z],...}. */
export function demoWideMeasurements(dims, pos, opts = {}) {
  const seat = [pos.seat[0], pos.seat[1], pos.ear ?? 1.1], out = {};
  ['FL', 'FR', 'SL', 'SR'].forEach((k, i) => { out[k] = [demoWideIR(pos[k], seat, dims, { t60: dims.rt60 || 0.45, seed: 7 + i, ...opts })]; });
  return out;
}
