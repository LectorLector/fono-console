// Measurement engine: log sweep stimulus with acoustic timing reference,
// regularised deconvolution, frequency response, auto-EQ fitting.
import { fft, nextPow2 } from './fft.js';
import { chainDb, smooth, interpCurve } from './dsp.js';
import { nodesAt, cleanNodes } from './acoustics.js';

export function logSweep(sr, f1, f2, sec, fadeIn = 0.02, fadeOut = 0.01) {
  const n = Math.round(sr * sec), out = new Float32Array(n);
  const w1 = 2 * Math.PI * f1, w2 = 2 * Math.PI * f2, K = (sec * w1) / Math.log(w2 / w1), L = sec / Math.log(w2 / w1);
  const fi = Math.round(fadeIn * sr), fo = Math.round(fadeOut * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let g = 1;
    if (i < fi) g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fi);
    if (i > n - fo) g = 0.5 - 0.5 * Math.cos((Math.PI * (n - i)) / fo);
    out[i] = g * Math.sin(K * (Math.exp(t / L) - 1));
  }
  return out;
}

/**
 * Stereo stimulus: R = short timing-reference chirp (routed to FL by EQ APO),
 * L = measurement sweep (routed to the target speaker).
 */
export function makeStimulus(sr, { sweepSec = 5.5, level = -12, f1 = 15, f2 = 22000 } = {}) {
  const g = Math.pow(10, level / 20);
  const lead = Math.round(0.25 * sr), refLen = Math.round(0.25 * sr), gap = Math.round(1.2 * sr), tail = Math.round(1.6 * sr);
  const ref = logSweep(sr, 400, Math.min(18000, sr * 0.45), 0.25, 0.005, 0.005);
  const sweep = logSweep(sr, f1, Math.min(f2, sr * 0.47), sweepSec);
  const total = lead + refLen + gap + sweep.length + tail;
  const L = new Float32Array(total), R = new Float32Array(total);
  for (let i = 0; i < ref.length; i++) R[lead + i] = ref[i] * g;
  const s0 = lead + refLen + gap;
  for (let i = 0; i < sweep.length; i++) L[s0 + i] = sweep[i] * g;
  return { sr, L, R, total, sweepStart: s0, refStart: lead, f1, f2: Math.min(f2, sr * 0.47), refF2: Math.min(18000, sr * 0.45) };
}

/** Regularised deconvolution of rec by the played signal x. Returns full circular IR. */
export function deconvolve(rec, x, { sr = 48000, f1 = 15, f2 = 22000 } = {}) {
  const N = nextPow2(Math.max(rec.length, x.length) * 2);
  const rr = new Float64Array(N), ri = new Float64Array(N), xr = new Float64Array(N), xi = new Float64Array(N);
  rr.set(rec); xr.set(x);
  fft(rr, ri); fft(xr, xi);
  let pmax = 0;
  for (let k = 0; k < N; k++) pmax = Math.max(pmax, xr[k] * xr[k] + xi[k] * xi[k]);
  // In-band: almost no regularisation (keeps the sweep's pink spectrum exact);
  // out of band: strong, so noise there is not amplified.
  const kLo = Math.floor((f1 * N) / sr), kHi = Math.ceil((f2 * N) / sr);
  for (let k = 0; k < N; k++) {
    const kk = k <= N / 2 ? k : N - k;
    const eps = pmax * (kk < kLo || kk > kHi ? 1e-2 : 1e-9);
    const p = xr[k] * xr[k] + xi[k] * xi[k] + eps;
    const a = (rr[k] * xr[k] + ri[k] * xi[k]) / p, b = (ri[k] * xr[k] - rr[k] * xi[k]) / p;
    rr[k] = a; ri[k] = b;
  }
  fft(rr, ri, true);
  return Float32Array.from(rr);
}

export function peakIndex(ir, from = 0, to = ir.length) {
  let m = 0, at = from;
  for (let i = from; i < to; i++) { const v = Math.abs(ir[i]); if (v > m) { m = v; at = i; } }
  return { index: at, value: m, sign: Math.sign(ir[at]) };
}

/**
 * Analyse one recording. offset = samples from recording start to playback start.
 * Returns {ir (from 5 ms before main peak), arrivalMs (target relative to FL ref), snrDb, polarity}.
 */
export function analyseRecording(rec, stim, offset) {
  const sr = stim.sr;
  const irL = deconvolve(rec, stim.L, { sr, f1: stim.f1, f2: stim.f2 }), irR = deconvolve(rec, stim.R, { sr, f1: 400, f2: stim.refF2 });
  const win = (ir, max) => peakIndex(ir, Math.max(0, offset - Math.round(0.01 * sr)), Math.min(ir.length, offset + Math.round(max * sr)));
  const pL = win(irL, 0.9), pR = win(irR, 0.9);
  const pre = Math.round(0.005 * sr), len = Math.round(0.6 * sr);
  const ir = irL.slice(Math.max(0, pL.index - pre), pL.index - pre + len);
  // noise: RMS of the deconvolved signal well after the IR has decayed
  let nz = 0, c = 0;
  for (let i = pL.index + Math.round(1.0 * sr); i < Math.min(irL.length, pL.index + Math.round(1.2 * sr)); i++) { nz += irL[i] * irL[i]; c++; }
  // also the region just before the arrival (before playback started), so pure room noise can't pass as a peak
  for (let i = Math.max(0, offset - Math.round(0.3 * sr)); i < offset - Math.round(0.05 * sr); i++) { nz += irL[i] * irL[i]; c++; }
  const snrDb = 20 * Math.log10(pL.value / Math.sqrt(nz / Math.max(1, c) + 1e-30));
  // did the recording get louder while the sweep played? (speakers/amp off -> ~0 dB)
  const rms = (a, b) => { let e = 0, k = 0; for (let i = Math.max(0, a); i < Math.min(rec.length, b); i++) { e += rec[i] * rec[i]; k++; } return k ? Math.sqrt(e / k) : 0; };
  const pre0 = rms(0, offset - Math.round(0.05 * sr)), during = rms(offset + Math.round(0.2 * sr), offset + stim.L.length);
  const sweepGainDb = offset > 0.15 * sr && pre0 > 0 ? 20 * Math.log10((during + 1e-12) / pre0) : null;
  return { ir, irPeak: pre, sr, arrivalMs: ((pL.index - pR.index) / sr) * 1000, snrDb, sweepGainDb, polarity: pL.sign, level: 20 * Math.log10(pL.value + 1e-12) };
}

/** Magnitude response (dB) on a 1/48-octave grid from an IR. */
export function irToCurve(ir, sr, { windowMs = 300, peak = 0 } = {}) {
  const start = Math.max(0, peak - Math.round(0.002 * sr));
  const n = Math.min(ir.length - start, Math.round((windowMs / 1000) * sr));
  const N = nextPow2(Math.max(n * 2, 65536));
  const re = new Float64Array(N), im = new Float64Array(N);
  const fadeN = Math.round(n * 0.2);
  for (let i = 0; i < n; i++) {
    let w = 1;
    if (i > n - fadeN) w = 0.5 + 0.5 * Math.cos((Math.PI * (i - (n - fadeN))) / fadeN);
    re[i] = ir[start + i] * w;
  }
  fft(re, im);
  const f = [], db = [];
  for (let fr = 15; fr < sr * 0.47; fr *= Math.pow(2, 1 / 48)) {
    const k = (fr * N) / sr, k0 = Math.floor(k), t = k - k0;
    const m0 = Math.hypot(re[k0], im[k0]), m1 = Math.hypot(re[k0 + 1], im[k0 + 1]);
    f.push(fr); db.push(20 * Math.log10(m0 * (1 - t) + m1 * t + 1e-12));
  }
  return { f, db };
}

/** Power average of several curves on the same grid. */
export function averageCurves(curves) {
  const f = curves[0].f;
  const db = f.map((_, i) => 10 * Math.log10(curves.reduce((s, c) => s + Math.pow(10, c.db[i] / 10), 0) / curves.length));
  return { f, db };
}

export function bandLevel(curve, lo, hi) {
  const v = [];
  curve.f.forEach((f, i) => { if (f >= lo && f <= hi) v.push(curve.db[i]); });
  v.sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : 0;
}

/**
 * Fit peaking filters that flatten room-mode peaks.
 * opts: {fmin, fmax, lfRise dB (20 Hz vs 200 Hz), maxFilters, maxBoost, maxCut, ref:[lo,hi],
 *        target: [[f,dB],...] user target curve (log-f interpolated, normalised to its mean level in `ref`);
 *        without it the classic lfRise shelf is used, which equals target [[20,lfRise],[200,0],[20000,0]]}
 */
export function autoEQ(curve, o = {}) {
  const opt = { fmin: 20, fmax: 300, lfRise: 2, maxFilters: 8, maxBoost: 0, maxCut: -15, minQ: 0.7, maxQ: 10, tol: 1.5, ref: [200, 1500], ...o };
  const sm = smooth(curve, 12);
  const ref = bandLevel(sm, opt.ref[0], opt.ref[1]);
  // Find the speaker's own low-frequency roll-off: do not EQ below its -6 dB point.
  let fLow = opt.fmin;
  for (let f = 150; f >= opt.fmin; f /= Math.pow(2, 1 / 24)) {
    const s = smooth(curve, 3);
    if (interpCurve(s, f) < ref - 6) { fLow = f * Math.pow(2, 1 / 6); break; }
  }
  const lo = Math.max(opt.fmin, fLow), hi = opt.fmax;
  const G = [];
  for (let f = lo; f <= hi; f *= Math.pow(2, 1 / 24)) G.push(f);
  const nodes = cleanNodes(opt.target);
  let target = f => ref + opt.lfRise * Math.min(1, Math.max(0, Math.log(200 / f) / Math.log(10)));
  if (nodes) {
    let tr = 0; const nr = 40;
    for (let i = 0; i < nr; i++) tr += nodesAt(nodes, opt.ref[0] * Math.pow(opt.ref[1] / opt.ref[0], i / (nr - 1)));
    tr /= nr;
    target = f => ref + nodesAt(nodes, f) - tr;
  }
  const meas = G.map(f => interpCurve(sm, f)), tgt = G.map(target);
  const filters = [];
  const errAt = (i, fl = filters) => meas[i] + chainDb(fl, G[i]) - tgt[i];
  const cost = fl => { let c = 0; for (let i = 0; i < G.length; i++) { const e = errAt(i, fl); c += e > 0 ? e * e : 0.35 * e * e; } return c / G.length; };
  const clampF = x => ({ ...x, fc: Math.min(hi * 1.2, Math.max(lo * 0.8, x.fc)), gain: Math.max(opt.maxCut, Math.min(opt.maxBoost, x.gain)), q: Math.max(opt.minQ, Math.min(opt.maxQ, x.q)) });
  const before = Math.sqrt(cost([]));
  for (let k = 0; k < opt.maxFilters; k++) {
    let mi = -1, mv = opt.tol;
    for (let i = 0; i < G.length; i++) { const e = errAt(i); if (e > mv) { mv = e; mi = i; } }
    if (mi < 0) break;
    let a = mi, b = mi;
    while (a > 0 && errAt(a) > mv / 2) a--;
    while (b < G.length - 1 && errAt(b) > mv / 2) b++;
    const bw = Math.max(G[b] - G[a], G[mi] * 0.05);
    filters.push(clampF({ type: 'PK', fc: G[mi], gain: -mv * 0.9, q: G[mi] / bw }));
    // joint refinement (coordinate descent)
    for (let it = 0; it < 25; it++) {
      let improved = false;
      for (let j = 0; j < filters.length; j++) {
        for (const [key, step] of [['fc', Math.pow(2, 1 / 48)], ['gain', 0.3], ['q', 1.08]]) {
          for (const dir of [1, -1]) {
            const trial = filters.slice();
            const x = { ...trial[j] };
            x[key] = key === 'gain' ? x.gain + dir * step : x[key] * Math.pow(step, dir);
            trial[j] = clampF(x);
            if (cost(trial) < cost(filters) - 1e-6) { filters.splice(0, filters.length, ...trial); improved = true; }
          }
        }
      }
      if (!improved) break;
    }
  }
  filters.forEach(f => { f.fc = Math.round(f.fc * 10) / 10; f.gain = Math.round(f.gain * 10) / 10; f.q = Math.round(f.q * 100) / 100; });
  const kept = filters.filter(f => Math.abs(f.gain) >= 0.5);
  return { filters: kept, ref, fLow: lo, rmsBefore: before, rmsAfter: Math.sqrt(cost(kept)), grid: G, target: G.map(target) };
}
