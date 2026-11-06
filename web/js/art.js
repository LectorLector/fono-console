// ART-style bass control ("Active Room Treatment"-like), experimental.
// All four speakers get their own FIR for the mono bass, solved by regularised
// least squares over many measured positions so the bass at the listening area
// matches a target with *short* decay. The mains are high-passed with a linear-
// phase filter carrying the same delay, so mains + bass sum flat.
// Method and feasibility study: research/art/README.md.
import { fft, nextPow2 } from './fft.js';

export const ART_SPK = ['FL', 'FR', 'SL', 'SR'];
export const ART_BANDS = [40, 50, 63, 80, 100, 125];

// complex helpers on [re, im]
const cm = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const ex = ph => [Math.cos(ph), Math.sin(ph)];

function hp4(f, fc) { // 4th-order Butterworth high-pass, complex
  const s = [0, f / fc];
  const q = (b) => { const s2 = cm(s, s); return [s2[0] + b * s[0] + 1, s2[1] + b * s[1]]; };
  const den = cm(q(0.7654), q(1.8478)), s4 = cm(cm(s, s), cm(s, s));
  const d = den[0] * den[0] + den[1] * den[1];
  return [(s4[0] * den[0] + s4[1] * den[1]) / d, (s4[1] * den[0] - s4[0] * den[1]) / d];
}
function lp4(f, fc) { const s = [0, f / fc]; const q = b => { const s2 = cm(s, s); return [s2[0] + b * s[0] + 1, s2[1] + b * s[1]]; }; const den = cm(q(0.7654), q(1.8478)); const d = den[0] * den[0] + den[1] * den[1]; return [den[0] / d, -den[1] / d]; }
/** Hand-over weight: 1 in the bass, 0 above; zero-phase (both paths share the same delay). */
export const handover = (f, fc) => 1 / (1 + Math.pow(f / fc, 8));

/** Complex 4x4-at-most solve (Gaussian elimination with partial pivoting). */
function csolve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r.map(x => [...x]), [...b[i]]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.hypot(...M[r][c]) > Math.hypot(...M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c], pd = pv[0] * pv[0] + pv[1] * pv[1] || 1e-300, inv = [pv[0] / pd, -pv[1] / pd];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const fct = cm(M[r][c], inv);
      for (let k = c; k <= n; k++) { const t = cm(fct, M[c][k]); M[r][k] = [M[r][k][0] - t[0], M[r][k][1] - t[1]]; }
    }
  }
  return M.map((r, i) => cm(r[n], (() => { const pv = r[i], pd = pv[0] * pv[0] + pv[1] * pv[1] || 1e-300; return [pv[0] / pd, -pv[1] / pd]; })()));
}

/**
 * Spectra of the measurements, re-aligned to the timing reference so phases are
 * comparable across speakers and positions.
 * meas[ch][p] = { ir, sr, irPeak, arrivalMs }   (from measure.js analyseRecording)
 */
export function spectra(meas, fMax = 260) {
  const first = meas[ART_SPK[0]][0], sr = first.sr;
  const N = nextPow2(Math.max(...ART_SPK.flatMap(k => meas[k].map(m => m.ir.length))) * 2);
  const df = sr / N, K = Math.ceil(fMax / df);
  const f = Float64Array.from({ length: K }, (_, k) => k * df);
  const P = meas[ART_SPK[0]].length;
  const H = Array.from({ length: P }, () => ART_SPK.map(() => new Array(K)));
  ART_SPK.forEach((ch, i) => meas[ch].forEach((m, p) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    re.set(m.ir.subarray ? m.ir : Float64Array.from(m.ir));
    fft(re, im);
    const t0 = m.arrivalMs / 1000 - m.irPeak / m.sr;            // start of the IR slice vs. the reference
    for (let k = 0; k < K; k++) H[p][i][k] = cm([re[k], im[k]], ex(-2 * Math.PI * f[k] * t0));
  }));
  return { f, H, sr, N, df };
}

/** Per-speaker response of the main (non-bass) path set up by the room page: gain, polarity, delay. */
function mainsChain(s, ch, f) {
  const c = s.room.ch[ch];
  if (c.mute || (ch !== 'FL' && ch !== 'FR')) return [0, 0];
  const g = Math.pow(10, (c.gain || 0) / 20) * (c.invert ? -1 : 1);
  return cm([g, 0], ex(-2 * Math.PI * f * (c.delay || 0) / 1000));
}

/** Spectra of a room whose modes are all shifted by factor a (temperature): H'(f) = H(f / a), complex linear interpolation. */
export function warpH(sp, a) {
  const { f, H } = sp, K = f.length, df = f[1] - f[0];
  return H.map(Hp => Hp.map(row => Array.from(f, fk => {
    const x = fk / a / df, i = Math.floor(x), t = x - i;
    if (i + 1 >= K) return row[K - 1];
    return [row[i][0] * (1 - t) + row[i + 1][0] * t, row[i][1] * (1 - t) + row[i + 1][1] * t];
  })));
}

/**
 * Solve the bass filters.
 * opts: fc (hand-over Hz), fLow (target low roll-off Hz), capDb (max boost per speaker),
 *       tau (s, modelling delay), reg (relative Tikhonov), state (Fono state for the mains path)
 */
export function solveART(sp, opts) {
  const { f, H } = sp, P = H.length, K = f.length;
  const { fc = 150, fLow = 35, capDb = 12, tau = 0.05, reg = 1e-3, state } = opts;   // opts.robust: solve jointly over rooms with every mode frequency scaled by 1 +- driftPct %
  const cap = Math.pow(10, capDb / 20);
  const Hv = (opts.robust ? [1, 1 + (opts.driftPct ?? 1) / 100, 1 - (opts.driftPct ?? 1) / 100] : [1]).map(a => (a === 1 ? H : warpH(sp, a)));
  // target level: geometric mean of the front pair (mono) between 40 and 120 Hz
  let ls = 0, ln = 0, arr = 0;
  for (let k = 0; k < K; k++) if (f[k] >= 40 && f[k] <= 120) {
    let m = 0; for (let p = 0; p < P; p++) { const a = H[p][0][k], b = H[p][1][k]; m += Math.hypot(a[0] + b[0], a[1] + b[1]) ** 2; }
    ls += Math.log(Math.sqrt(m / P) + 1e-30); ln++;
  }
  const lvl = Math.exp(ls / Math.max(1, ln));
  // acoustic delay of the front pair (median group delay proxy: first-arrival from the phase slope is noisy, use 0;
  // the spectra are referenced to the timing chirp so a few ms of acoustic delay are inside H already)
  const B = ART_SPK.map(() => new Array(K).fill(null).map(() => [0, 0]));
  const target = new Array(K), mains = new Array(K);
  let maxGain = 0;
  for (let k = 1; k < K; k++) {
    const fk = f[k], t = handover(fk, fc);
    const dl = ex(-2 * Math.PI * fk * tau);
    target[k] = cm(cm(hp4(fk, fLow), [lvl, 0]), dl);
    // what the mains already deliver at each position (mono content, high-passed by 1-t, delayed by tau)
    mains[k] = [];
    const mc = ART_SPK.slice(0, 2).map(c => mainsChain(state, c, fk));
    // equations of every variant (nominal first; robust adds the two drifted rooms) are stacked into the same normal equations
    const AA = ART_SPK.map(() => ART_SPK.map(() => [0, 0])), Ar = ART_SPK.map(() => [0, 0]);
    Hv.forEach((Hx, vi) => {
      for (let p = 0; p < P; p++) {
        let m = [0, 0];
        for (const i of [0, 1]) { const c = cm(Hx[p][i][k], mc[i]); m = [m[0] + c[0], m[1] + c[1]]; }
        m = cm(cm(m, [1 - t, 0]), dl);
        if (vi === 0) mains[k].push(m);
        const r = [target[k][0] - m[0], target[k][1] - m[1]];
        const a = ART_SPK.map((_, i) => [Hx[p][i][k][0] * t, Hx[p][i][k][1] * t]);   // A[p][i] = H[p][i] * t
        for (let i = 0; i < 4; i++) {
          const ah = [a[i][0], -a[i][1]];
          for (let j = 0; j < 4; j++) { const v = cm(ah, a[j]); AA[i][j][0] += v[0]; AA[i][j][1] += v[1]; }
          const v = cm(ah, r); Ar[i][0] += v[0]; Ar[i][1] += v[1];
        }
      }
    });
    if (t < 1e-3) continue;
    const tr = AA.reduce((s, r, i) => s + r[i][0], 0);
    let beta = reg * tr / 4 + 1e-30, x;
    for (let it = 0; it < 48; it++) {
      x = csolve(AA.map((r, i) => r.map((v, j) => (i === j ? [v[0] + beta, v[1]] : v))), Ar);
      if (Math.max(...x.map(v => Math.hypot(v[0], v[1]))) <= cap) break;   // cap the filter itself, so it fades with the hand-over
      beta *= 2;
    }
    x.forEach((v, i) => { B[i][k] = [v[0] * t, v[1] * t]; maxGain = Math.max(maxGain, Math.hypot(...B[i][k]) + (i < 2 ? 1 - t : 0)); });
  }
  target[0] = [0, 0]; mains[0] = Array(P).fill([0, 0]);
  // Truncate to what will really run (opts.lenSec, default 1 s) so predictions match the exported FIRs.
  const Bw = B.map(b => windowBins(b, sp, opts.lenSec || 1.0));
  maxGain = 0;
  for (let k = 1; k < K; k++) { const t = handover(f[k], fc); Bw.forEach((b, i) => { maxGain = Math.max(maxGain, Math.hypot(...b[k]) + (i < 2 ? 1 - t : 0)); }); }
  return { f, B: Bw, target, mains, fc, tau, lvl, preampDb: -Math.max(0, 20 * Math.log10(maxGain)), spectra: sp };
}

/** Bins (on the spectra grid) -> causal FIR of lenSec with a 20 % fade-out -> bins again. */
function windowBins(b, sp, lenSec) {
  const { N, sr } = sp, K = b.length, re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 1; k < K; k++) { re[k] = b[k][0]; im[k] = b[k][1]; re[N - k] = b[k][0]; im[N - k] = -b[k][1]; }
  fft(re, im, true);
  const sc = fftInverseScale(N), L = Math.min(N, Math.round(lenSec * sr)), fade = Math.round(L * 0.2);
  const tr = new Float64Array(N), ti = new Float64Array(N);
  for (let n = 0; n < L; n++) tr[n] = re[n] * sc * (n > L - fade ? 0.5 + 0.5 * Math.cos(Math.PI * (n - (L - fade)) / fade) : 1);
  fft(tr, ti);
  return Array.from({ length: K }, (_, k) => [tr[k], ti[k]]);
}

/** Time-domain FIR for one speaker at rate sr (inverse FFT of the solved bins, content < fMax). */
export function firFor(sol, i, sr, lenSec = 1.0) {
  const { f, B } = sol, df = f[1] - f[0], L = Math.round(lenSec * sr);
  const N = nextPow2(L * 2), dfr = sr / N, re = new Float64Array(N), im = new Float64Array(N);
  const kmax = Math.min(N / 2 - 1, Math.floor(f[f.length - 1] / dfr));
  for (let k = 1; k <= kmax; k++) {          // resample the solution onto this rate's FFT grid
    const x = (k * dfr) / df, j = Math.floor(x), t = x - j;
    if (j + 1 >= f.length) break;
    const v = [B[i][j][0] * (1 - t) + B[i][j + 1][0] * t, B[i][j][1] * (1 - t) + B[i][j + 1][1] * t];
    re[k] = v[0]; im[k] = v[1]; re[N - k] = v[0]; im[N - k] = -v[1];
  }
  fft(re, im, true);
  const scale = fftInverseScale(N), h = new Float32Array(L), fade = Math.round(L * 0.2);
  for (let n = 0; n < L; n++) {
    const win = n > L - fade ? 0.5 + 0.5 * Math.cos(Math.PI * (n - (L - fade)) / fade) : 1;
    h[n] = re[n] * scale * win;
  }
  return h;
}
// fft.js may or may not divide by N on the inverse; measure it once.
let _invNorm = null;
function fftInverseScale(N) {
  if (_invNorm === null) { const r = new Float64Array(8), q = new Float64Array(8); r[0] = 1; fft(r, q); fft(r, q, true); _invNorm = r[0] > 4 ? 'raw' : 'norm'; }
  return _invNorm === 'raw' ? 1 / N : 1;
}

/** Linear-phase high-pass for the mains: delta(n - tau) minus the same hand-over low-pass. */
export function mainsFIR(fc, tau, sr) {
  const c = Math.round(tau * sr), L = 2 * c + 1, h = new Float32Array(L);
  // zero-phase low-pass impulse (numeric inverse transform of the hand-over weight), centred at tau
  const df = 0.25, K = Math.ceil((fc * 4) / df);
  const cosTab = new Float64Array(K);
  for (let k = 0; k < K; k++) cosTab[k] = handover(k * df, fc);
  for (let n = 0; n < L; n++) {
    const tt = (n - c) / sr; let s = 0.5 * cosTab[0];
    for (let k = 1; k < K; k++) s += cosTab[k] * Math.cos(2 * Math.PI * k * df * tt);
    const lp = (2 * df * s) / sr;
    const win = 0.5 + 0.5 * Math.cos(Math.PI * (n - c) / (c + 1));   // Hann centred on the delay
    h[n] = (n === c ? 1 : 0) - lp * win;
  }
  return h;
}

// ---------------------------------------------------------------- prediction / report
function bandT60(spec, f, N, sr, fcBand) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 1; k < f.length; k++) {
    const g = cm(hp4(f[k], fcBand / Math.pow(2, 1 / 6)), lp4(f[k], fcBand * Math.pow(2, 1 / 6)));
    const v = cm(spec[k], g); re[k] = v[0]; im[k] = v[1]; re[N - k] = v[0]; im[N - k] = -v[1];
  }
  fft(re, im, true);
  const stop = Math.round(N * 0.85);
  let t0 = 0, mx = 0; for (let n = 0; n < stop; n++) if (re[n] * re[n] > mx) { mx = re[n] * re[n]; t0 = n; }
  const e = []; for (let n = t0; n < stop; n++) e.push(re[n] * re[n]);
  let acc = 0; const sch = new Float64Array(e.length); for (let n = e.length - 1; n >= 0; n--) { acc += e[n]; sch[n] = acc; }
  let i5 = -1, i25 = -1; for (let n = 0; n < sch.length; n++) { const db = 10 * Math.log10(sch[n] / sch[0] + 1e-30); if (i5 < 0 && db < -5) i5 = n; if (db < -25) { i25 = n; break; } }
  return i5 >= 0 && i25 > i5 ? 3 * (i25 - i5) / sr * 1000 : NaN;
}
const median = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };

/** Before (front pair, mono, raw) vs. predicted after, at the measured positions. */
export function predict(sol) {
  const { f, B, mains, target, spectra: { H, N, sr } } = sol, P = H.length, K = f.length;
  const before = [], after = [];
  for (let p = 0; p < P; p++) {
    const b = [], a = [];
    for (let k = 0; k < K; k++) {
      const x = [H[p][0][k][0] + H[p][1][k][0], H[p][0][k][1] + H[p][1][k][1]];
      b.push(cm(x, ex(-2 * Math.PI * f[k] * sol.tau)));
      let y = mains[k][p] || [0, 0];
      for (let i = 0; i < 4; i++) { const v = cm(H[p][i][k], B[i][k]); y = [y[0] + v[0], y[1] + v[1]]; }
      a.push(y);
    }
    before.push(b); after.push(a);
  }
  const t60 = specs => ART_BANDS.map(bc => median(specs.map(s => bandT60(s, f, N, sr, bc))));
  const curve = specs => { const out = []; for (let k = 1; k < K; k++) { if (f[k] < 20) continue; let m = 0; for (const s of specs) m += Math.hypot(...s[k]) ** 2; out.push([f[k], 10 * Math.log10(m / specs.length + 1e-30)]); } return out; };
  const dev = specs => { let s = 0, n = 0; for (let k = 1; k < K; k++) if (f[k] >= 25 && f[k] <= sol.fc) for (const sp of specs) { s += Math.abs(20 * Math.log10((Math.hypot(...sp[k]) + 1e-30) / (Math.hypot(...target[k]) + 1e-30))); n++; } return s / Math.max(1, n); };
  return { bands: ART_BANDS, before: t60(before), after: t60(after), devBefore: dev(before), devAfter: dev(after),
    curveBefore: curve(before), curveAfter: curve(after), curveTarget: curve([target]) };
}

/** Equalizer APO lines for the ART listening mode (placed after the FX block). */
export function artConfig(s, ctx, speakerStage) {
  const a = ctx.art, m = s.room.map, out = [];
  const conv = name => { const o = []; a.rates.forEach((sr, i) => o.push(`${i ? 'ElseIf' : 'If'}: sampleRate == ${sr}`, `Convolution: fono\\${name}_${sr}.wav`)); o.push('EndIf:'); return o; };
  out.push('# --- room: ART bass control (experimental) - mono bass through solved FIRs on all four speakers');
  out.push('Channel: L R');
  if (a.preampDb < -0.05) out.push(`Preamp: ${a.preampDb.toFixed(1)} dB`);
  out.push('Copy: XB=0.5*L+0.5*R', 'Channel: L R', ...conv('art_hp'));
  out.push(`Copy: ${m.SL}=0.0 ${m.SR}=0.0`);
  for (const k of ['FL', 'FR']) out.push(...speakerStage(s, k, 'art', ctx));
  out.push('Copy: XFL=XB XFR=XB XSL=XB XSR=XB');
  for (const k of ART_SPK) {
    out.push(`Channel: X${k}`, ...conv(`art_${k}`));
    if (ctx.fir && s.room.fir?.on && ctx.fir.latencyMs) out.push(`Delay: ${ctx.fir.latencyMs.toFixed(3)} ms`);
  }
  out.push(`Copy: ${m.FL}=${m.FL}+XFL ${m.FR}=${m.FR}+XFR ${m.SL}=${m.SL}+XSL ${m.SR}=${m.SR}+XSR`);
  return out;
}

/** Honest prediction: each measured position is predicted with filters solved from the others. */
export function predictCV(sp, opts) {
  const P = sp.H.length, perPos = [];
  for (let q = 0; q < P; q++) {
    const train = { ...sp, H: sp.H.filter((_, p) => p !== q) };
    const sol = solveART(train, opts);
    const test = { ...sp, H: [sp.H[q]] };
    const { f, B } = sol, K = f.length;
    const mains = [], cmx = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
    for (let k = 0; k < K; k++) {
      const t = handover(f[k], sol.fc), dl = [Math.cos(-2 * Math.PI * f[k] * sol.tau), Math.sin(-2 * Math.PI * f[k] * sol.tau)];
      let m = [0, 0];
      for (const i of [0, 1]) { const c = cmx(sp.H[q][i][k], mainsChain(opts.state, ART_SPK[i], f[k])); m = [m[0] + c[0], m[1] + c[1]]; }
      mains.push([cmx(cmx(m, [1 - t, 0]), dl)]);
    }
    perPos.push(predict({ ...sol, spectra: test, mains }));
  }
  const med = key => ART_BANDS.map((_, b) => median(perPos.map(r => r[key][b])));
  const avg = key => perPos.reduce((s, r) => s + r[key], 0) / P;
  return { bands: ART_BANDS, before: med('before'), after: med('after'), devBefore: avg('devBefore'), devAfter: avg('devAfter') };
}

/** Robustness: the same filters when the room is warmer/colder (all modes shift by ±1 % ≈ ±6 °C). */
export function predictDrift(sol, state, pct = 1) {
  const { f, spectra: sp } = sol, K = f.length, df = f[1] - f[0];
  const cmx = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const res = [];
  for (const a of [1 + pct / 100, 1 - pct / 100]) {
    const H = sp.H.map(Hp => Hp.map(row => Array.from(f, fk => {   // H'(f) = H(f / a), complex linear interpolation
      const x = fk / a / df, i = Math.floor(x), t = x - i;
      if (i + 1 >= K) return row[K - 1];
      return [row[i][0] * (1 - t) + row[i + 1][0] * t, row[i][1] * (1 - t) + row[i + 1][1] * t];
    })));
    const mains = Array.from(f, (fk, k) => H.map(Hp => {
      const t = handover(fk, sol.fc), dl = [Math.cos(-2 * Math.PI * fk * sol.tau), Math.sin(-2 * Math.PI * fk * sol.tau)];
      let m = [0, 0];
      for (const i of [0, 1]) { const c = cmx(Hp[i][k], mainsChain(state, ART_SPK[i], fk)); m = [m[0] + c[0], m[1] + c[1]]; }
      return cmx(cmx(m, [1 - t, 0]), dl);
    }));
    res.push(predict({ ...sol, spectra: { ...sp, H }, mains }));
  }
  const pick = key => ART_BANDS.map((_, b) => Math.max(res[0][key][b], res[1][key][b]));   // worse of the two
  return { bands: ART_BANDS, before: pick('before'), after: pick('after'), devBefore: Math.max(res[0].devBefore, res[1].devBefore), devAfter: Math.max(res[0].devAfter, res[1].devAfter) };
}
