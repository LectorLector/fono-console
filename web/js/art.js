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
export function spectra(meas, fMax = 260, keys = ART_SPK) {
  const first = meas[keys[0]][0], sr = first.sr;
  const N = nextPow2(Math.max(...keys.flatMap(k => meas[k].map(m => m.ir.length))) * 2);
  const df = sr / N, K = Math.ceil(fMax / df);
  const f = Float64Array.from({ length: K }, (_, k) => k * df);
  const P = meas[keys[0]].length;
  const H = Array.from({ length: P }, () => keys.map(() => new Array(K)));
  // worst reported SNR (dB, as analyseRecording measures it) per source; NaN = unknown (the SNR rule of the headroom limits is then off)
  const noise = keys.map(ch => { let v = Infinity; for (const m of meas[ch]) if (Number.isFinite(m.snrDb)) v = Math.min(v, m.snrDb); return v === Infinity ? NaN : v; });
  keys.forEach((ch, i) => meas[ch].forEach((m, p) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    re.set(m.ir.subarray ? m.ir : Float64Array.from(m.ir));
    fft(re, im);
    const t0 = m.arrivalMs / 1000 - m.irPeak / m.sr;            // start of the IR slice vs. the reference
    for (let k = 0; k < K; k++) H[p][i][k] = cm([re[k], im[k]], ex(-2 * Math.PI * f[k] * t0));
  }));
  return { f, H, sr, N, df, keys, noise };
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
function solveLegacy(sp, opts) {
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
  return sol.opts?.preRing != null && Number.isFinite(sol.opts.preRing) ? taperPre(h, sr, sol.spectra?.fLowDesign ?? sol.fLow ?? 35, sol.opts.preRing) : h;
}
/** Half-Hann taper of the part before the main lobe of an exported FIR, shortened (down to ~0.25 ms) until the pre-ring level is <= preDb. */
export function taperPre(h, sr, fLow, preDb) {
  const m0 = preRingDb(h, sr, fLow); if (m0.db <= preDb) return h;
  const e0 = m0.edge, out = new Float32Array(h.length);
  for (let len = e0; len >= Math.max(2, Math.round(0.00025 * sr)); len = Math.floor(len * 0.8)) {
    for (let n = 0; n < h.length; n++) out[n] = n >= e0 ? h[n] : n < e0 - len ? 0 : h[n] * (0.5 - 0.5 * Math.cos(Math.PI * (n - (e0 - len)) / len));
    if (preRingDb(out, sr, fLow).db <= preDb) break;
  }
  return out;
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
  const bIdx = sol.beforeIdx || [0, 1];   // sources that play the uncorrected bass (front pair for the classic layout)
  const before = [], after = [];
  for (let p = 0; p < P; p++) {
    const b = [], a = [];
    for (let k = 0; k < K; k++) {
      let x = [0, 0];
      for (const i of bIdx) x = [x[0] + H[p][i][k][0], x[1] + H[p][i][k][1]];
      b.push(cm(x, ex(-2 * Math.PI * f[k] * sol.tau)));
      let y = mains[k][p] || [0, 0];
      for (let i = 0; i < B.length; i++) { const v = cm(H[p][i][k], B[i][k]); y = [y[0] + v[0], y[1] + v[1]]; }
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

/**
 * Equalizer APO lines for the ART listening mode (placed after the FX block).
 * ctx.art.keys = the sources that have solved FIRs (default: the four speakers of the classic layout). FL / FR keep their high-passed
 * direct path (art_hp); every solved source - rear pair, subwoofers, and FL / FR themselves - adds its own FIR of the mono bass.
 */
export function artConfig(s, ctx, speakerStage) {
  const a = ctx.art, m = s.room.map, out = [], keys = a.keys || ART_SPK, chan = k => m[k] || ({ SW1: 'LFE', SW2: 'C' }[k] || k);
  const conv = name => { const o = []; a.rates.forEach((sr, i) => o.push(`${i ? 'ElseIf' : 'If'}: sampleRate == ${sr}`, `Convolution: fono\\${name}_${sr}.wav`)); o.push('EndIf:'); return o; };
  out.push(`# --- room: ART bass control (experimental) - mono bass through solved FIRs on ${keys.join(' ')}`);
  out.push('Channel: L R');
  if (a.preampDb < -0.05) out.push(`Preamp: ${a.preampDb.toFixed(1)} dB`);
  out.push('Copy: XB=0.5*L+0.5*R', 'Channel: L R', ...conv('art_hp'));
  out.push(`Copy: ${m.SL}=0.0 ${m.SR}=0.0`);
  const subs = keys.filter(k => k.startsWith('SW'));
  if (subs.length) out.push('Channel: all', `Copy: ${subs.map(k => chan(k) + '=0.0').join(' ')}`);
  for (const k of ['FL', 'FR']) out.push(...speakerStage(s, k, 'art', ctx));
  out.push('Copy: ' + keys.map(k => `X${k}=XB`).join(' '));
  for (const k of keys) {
    out.push(`Channel: X${k}`, ...conv(`art_${k}`));
    if (ctx.fir && s.room.fir?.on && ctx.fir.latencyMs) out.push(`Delay: ${ctx.fir.latencyMs.toFixed(3)} ms`);
  }
  out.push('Copy: ' + keys.filter(k => !(k.startsWith('SW') && s.room.ch[k]?.mute)).map(k => `${chan(k)}=${chan(k)}+X${k}`).join(' '));
  return out;
}

/** Honest prediction: each measured position is predicted with filters solved from the others. */
function predictCVLegacy(sp, opts) {
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
  const dIdx = sol.directIdx || [0, 1], keys = sp.keys || ART_SPK;
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
      for (const i of dIdx) { const c = cmx(Hp[i][k], mainsChain(state, keys[i], fk)); m = [m[0] + c[0], m[1] + c[1]]; }
      return cmx(cmx(m, [1 - t, 0]), dl);
    }));
    res.push(predict({ ...sol, spectra: { ...sp, H }, mains }));
  }
  const pick = key => ART_BANDS.map((_, b) => Math.max(res[0][key][b], res[1][key][b]));   // worse of the two
  return { bands: ART_BANDS, before: pick('before'), after: pick('after'), devBefore: Math.max(res[0].devBefore, res[1].devBefore), devAfter: Math.max(res[0].devAfter, res[1].devAfter) };
}

// ====================================================================================================================
// Task A2: general source sets, automatic regularisation (leave-one-out), headroom limits, pre-ring control, seat weights.
// The classic call (no A2 option) still runs solveLegacy() above, unchanged, so old saved designs reproduce bit for bit.
// ====================================================================================================================
import { bandT60 as bandT60Ir } from './acoustics.js';

/** A2 options that switch the general solver on (anything else = classic path). */
const A2_OPTS = ['mains', 'helpers', 'direct', 'auto', 'weights', 'headroom', 'preRing', 'modern'];
export const isGeneral = o => A2_OPTS.some(k => o?.[k] !== undefined && o[k] !== false && o[k] !== null);

export function solveART(sp, opts = {}) { return isGeneral(opts) ? solveGeneral(sp, opts) : solveLegacy(sp, opts); }
export function predictCV(sp, opts = {}) { return isGeneral(opts) ? predictCVGeneral(sp, opts) : predictCVLegacy(sp, opts); }

/**
 * Which sources take which role for a speaker layout.
 * bass = 'mains': FL/FR play the bass, every other speaker (rear pair, subwoofers) absorbs.
 * bass = 'subs' : the first sub plays the bass, the other sub and the rear pair absorb; FL/FR are only high-passed (direct path).
 * ok = false when there is no helper (2.0, headphones, 2.1 with "subs play the bass").
 */
export function artSources(layout, bass = 'mains') {
  const L = String(layout), rear = L.startsWith('4'), nsub = L === 'hp' ? 0 : (+L.split('.')[1] || 0);
  const front = ['FL', 'FR'], rearK = rear ? ['SL', 'SR'] : [], subs = ['SW1', 'SW2'].slice(0, nsub);
  let mains = front, helpers = [...rearK, ...subs];
  if (bass === 'subs' && subs.length) { mains = [subs[0]]; helpers = [...subs.slice(1), ...rearK]; }
  const keys = [...front, ...rearK, ...subs];
  return { keys, mains, helpers, direct: front, solved: [...mains, ...helpers], ok: L !== 'hp' && helpers.length > 0, bass: bass === 'subs' && subs.length ? 'subs' : 'mains' };
}

/** Position weights of the 15-point grid (centre heavier), normalised to mean 1. Positions beyond the pattern weigh 1. */
export function defaultWeights(P) {
  const w = Array.from({ length: P }, (_, p) => P >= 9 ? (p === 0 ? 2 : p <= 4 ? 1.25 : p <= 8 ? 0.9 : p <= 10 ? 1 : 0.7) : (p === 0 ? 1.5 : 1));
  const m = w.reduce((a, b) => a + b, 0) / Math.max(1, P);
  return w.map(v => v / m);
}
const normW = (w, P) => { const v = Array.from({ length: P }, (_, p) => Math.max(0, +(w?.[p] ?? 1))); const m = v.reduce((a, b) => a + b, 0) / Math.max(1, P) || 1; return v.map(x => x / m); };

// ---- regularisation grid / bands
export const REG_LAMBDAS = [1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1];   // relative to the mean diagonal of the normal equations = mean |H|^2 x positions
export const REG_EDGES = [20, 45, 56, 71, 90, 112, Infinity];     // band edges (Hz) of the per-band choice
const regBand = f => { for (let b = 0; b < REG_EDGES.length - 1; b++) if (f < REG_EDGES[b + 1]) return b; return REG_EDGES.length - 2; };
const capGrid = capDb => [...new Set([capDb - 6, capDb - 3, capDb].filter(c => c >= 3))];

// ---- small complex linear algebra on flat Float64Arrays (Hermitian positive definite, n <= 6)
const _Lr = new Float64Array(64), _Li = new Float64Array(64), _yr = new Float64Array(8), _yi = new Float64Array(8);
/** Solve (A + beta I) x = b by complex Cholesky; A is the Hermitian matrix with A[i*n+j] = conj(a_i) a_j (lower triangle used). */
function herSolve(Ar, Ai, br, bi, n, beta, xr, xi) {
  for (let j = 0; j < n; j++) {
    let d = Ar[j * n + j] + beta;
    for (let k = 0; k < j; k++) d -= _Lr[j * n + k] ** 2 + _Li[j * n + k] ** 2;
    if (!(d > 1e-300)) d = 1e-300;
    const l = Math.sqrt(d); _Lr[j * n + j] = l; _Li[j * n + j] = 0;
    for (let i = j + 1; i < n; i++) {
      let sr = Ar[i * n + j], si = Ai[i * n + j];
      for (let k = 0; k < j; k++) { const a = _Lr[i * n + k], b = _Li[i * n + k], c = _Lr[j * n + k], e = -_Li[j * n + k]; sr -= a * c - b * e; si -= a * e + b * c; }
      _Lr[i * n + j] = sr / l; _Li[i * n + j] = si / l;
    }
  }
  for (let i = 0; i < n; i++) {
    let sr = br[i], si = bi[i];
    for (let k = 0; k < i; k++) { const a = _Lr[i * n + k], b = _Li[i * n + k]; sr -= a * _yr[k] - b * _yi[k]; si -= a * _yi[k] + b * _yr[k]; }
    _yr[i] = sr / _Lr[i * n + i]; _yi[i] = si / _Lr[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {
    let sr = _yr[i], si = _yi[i];
    for (let k = i + 1; k < n; k++) { const a = _Lr[k * n + i], b = -_Li[k * n + i]; sr -= a * xr[k] - b * xi[k]; si -= a * xi[k] + b * xr[k]; }
    xr[i] = sr / _Lr[i * n + i]; xi[i] = si / _Lr[i * n + i];
  }
}
/** Ridge solve with the same "cap the filter" rule as the classic path: double beta until every |x_u| <= cap_u. */
function solveCapped(Ar, Ai, br, bi, n, beta0, cap, xr, xi) {
  let beta = beta0;
  for (let it = 0; it < 48; it++) {
    herSolve(Ar, Ai, br, bi, n, beta, xr, xi);
    let ok = true; for (let u = 0; u < n; u++) if (Math.hypot(xr[u], xi[u]) > cap[u]) { ok = false; break; }
    if (ok) break; beta *= 2;
  }
}

// ---- per-source limits (point 3)
const smoothPow = (pw, f, oct = 1 / 3) => {   // fractional-octave moving average of a power spectrum (prefix sums)
  const K = f.length, c = new Float64Array(K + 1); for (let k = 0; k < K; k++) c[k + 1] = c[k] + pw[k];
  const out = new Float64Array(K), r = Math.pow(2, oct / 2); let lo = 0, hi = 0;
  for (let k = 0; k < K; k++) { const a = f[k] / r, b = f[k] * r; while (lo < K - 1 && f[lo] < a) lo++; hi = Math.max(hi, k); while (hi < K - 1 && f[hi + 1] <= b) hi++; out[k] = (c[hi + 1] - c[Math.min(lo, k)]) / Math.max(1, hi + 1 - Math.min(lo, k)); }
  return out;
};
/**
 * Where a source must not be boosted: below its own -10 dB point (smoothed, position-averaged level versus the median level
 * between fc/2 and fc) and wherever the measurement SNR is under 20 dB. Returns {f10, locked: Uint8Array(K)} per source index.
 */
export function sourceLimits(sp, fc) {
  const { f, H } = sp, K = f.length, P = H.length, keys = sp.keys || ART_SPK;
  return keys.map((key, i) => {
    // the room adds its own level slope, so the speaker's own roll-off is read from the upper envelope (loudest position) of the 1/3-octave levels
    const env = new Float64Array(K), mean = new Float64Array(K);
    for (let p = 0; p < P; p++) {
      const pw = new Float64Array(K); for (let k = 0; k < K; k++) pw[k] = H[p][i][k][0] ** 2 + H[p][i][k][1] ** 2;
      const sm1 = smoothPow(pw, f); for (let k = 0; k < K; k++) { env[k] = Math.max(env[k], sm1[k]); mean[k] += sm1[k] / P; }
    }
    const db = Array.from(env, v => 10 * Math.log10(v + 1e-300)), sm = mean;
    // passband trend = least-squares line (dB per octave, clamped to 0..18) through the envelope between fc/2 and fc, extrapolated downwards
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 1; k < K; k++) if (f[k] >= fc / 2 && f[k] <= fc) { const x = Math.log2(f[k]); n++; sx += x; sy += db[k]; sxx += x * x; sxy += x * db[k]; }
    let slope = n > 2 && n * sxx - sx * sx > 1e-9 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0; slope = Math.max(0, Math.min(18, slope));
    const x0 = n ? sx / n : Math.log2(fc * 0.7), y0 = n ? sy / n : Math.max(...db), r0 = y0, trend = fk => y0 + slope * (Math.log2(fk) - x0);
    let kHi = 1; while (kHi < K - 1 && f[kHi] < fc / 2) kHi++;
    let f10 = 0; for (let k = kHi; k >= 1; k--) if (db[k] < trend(f[k]) - 10) { f10 = f[k]; break; }
    // SNR rule: the reported SNR belongs to the passband level; a bin that sits d dB below the passband median has d dB less SNR
    const snr = sp.noise?.[i], pm = []; for (let k = 1; k < K; k++) if (f[k] >= fc / 2 && f[k] <= fc) pm.push(10 * Math.log10(sm[k] + 1e-300));
    pm.sort((u, v) => u - v); const pmed = pm.length ? pm[pm.length >> 1] : 0, locked = new Uint8Array(K);
    for (let k = 0; k < K; k++) locked[k] = (f[k] <= f10 || (Number.isFinite(snr) && snr - (pmed - 10 * Math.log10(sm[k] + 1e-300)) < 20)) ? 1 : 0;
    return { key, f10, locked, refDb: r0 };
  });
}

// ---- pre-ring (point 4)
/** Energy before the main peak relative to the energy from the main peak on, in dB. The main lobe starts half a period of the lowest corrected frequency (fLow) before the peak: that part belongs to the peak itself. */
export function preRingDb(h, sr, fLow = 35) {
  let pk = 0; for (let n = 0; n < h.length; n++) if (Math.abs(h[n]) > Math.abs(h[pk])) pk = n;
  const edge = Math.max(0, pk - Math.round(sr / (2 * fLow)));
  let pre = 0, post = 0; for (let n = 0; n < h.length; n++) { if (n < edge) pre += h[n] * h[n]; else post += h[n] * h[n]; }
  return { db: 10 * Math.log10((pre + 1e-300) / (post + 1e-300)), peak: pk, edge };
}
/** Time-domain FIR (length lenSec, N-point circular buffer) from the bins; null if the bins are empty. */
function binsToTime(b, N, K) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 1; k < K; k++) { re[k] = b[k][0]; im[k] = b[k][1]; re[N - k] = b[k][0]; im[N - k] = -b[k][1]; }
  fft(re, im, true); const sc = fftInverseScale(N); for (let n = 0; n < N; n++) re[n] *= sc;
  return re;
}
/** windowBins() plus, when preDb is a number, a half-Hann taper over the part before the main lobe, shortened until the pre-ring is <= preDb. */
function windowBinsPR(b, sp, lenSec, fLow, preDb) {
  const { N, sr } = sp, K = b.length;
  const timeOf = bins => { const h = binsToTime(bins, N, K); const L = Math.min(N, Math.round(lenSec * sr)), fade = Math.round(L * 0.2); const o = new Float64Array(L); for (let n = 0; n < L; n++) o[n] = h[n] * (n > L - fade ? 0.5 + 0.5 * Math.cos(Math.PI * (n - (L - fade)) / fade) : 1); return o; };
  const toBins = h => { const tr = new Float64Array(N), ti = new Float64Array(N); tr.set(h); fft(tr, ti); return Array.from({ length: K }, (_, k) => [tr[k], ti[k]]); };
  let h = timeOf(b), bins = toBins(h);
  let h1 = timeOf(bins); const m0 = preRingDb(h1, sr, fLow);   // after the same truncation the classic path applies
  const info = { beforeDb: m0.db, afterDb: m0.db, taperMs: 0 };
  if (!Number.isFinite(preDb) || m0.db <= preDb) return { bins, info };
  let len = m0.edge;
  for (let it = 0; it < 14 && len >= 2; it++, len = Math.floor(len * 0.7)) {
    // taper, then band-limit again (the solution lives below 260 Hz); a few alternating projections pull the leakage of the band limit down too
    let cur = h1, bt = bins, m = m0;
    for (let rep = 0; rep < 4; rep++) {
      const e0 = m0.edge, g = new Float64Array(cur.length).fill(1);
      for (let n = 0; n < e0; n++) g[n] = n < e0 - len ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * (n - (e0 - len)) / len);
      bt = toBins(cur.map((v, n) => v * g[n])); cur = timeOf(bt); m = preRingDb(cur, sr, fLow);
      if (m.db <= preDb) break;
    }
    info.afterDb = m.db; info.taperMs = len / sr * 1000; bins = bt;
    if (m.db <= preDb) break;
  }
  return { bins, info };
}

// ---- the general solver
function setupGeneral(sp, o) {
  const { f, H } = sp, K = f.length, P = H.length, keys = sp.keys || ART_SPK, n = keys.length, ix = k => keys.indexOf(k);
  const mains = (o.mains || keys.slice(0, 2)).filter(k => ix(k) >= 0);
  const helpers = (o.helpers || keys.filter(k => !mains.includes(k))).filter(k => ix(k) >= 0 && !mains.includes(k));
  const solvedKeys = keys.filter(k => mains.includes(k) || helpers.includes(k)), U = solvedKeys.map(ix), nu = U.length;
  const directIdx = (o.direct || ['FL', 'FR']).map(ix).filter(i => i >= 0);
  const { fc = 150, fLow = 35, capDb = 12, tau = 0.05, state } = o;
  const w = normW(o.weights, P);
  const weighted = !!o.weights;
  const drift = (o.driftPct ?? 1) / 100;
  const Hv = (o.robust ? [1, 1 + drift, 1 - drift] : [1]).map(a => (a === 1 ? H : warpH(sp, a)));
  const mIdx = mains.map(ix);
  let ls = 0, ln = 0;
  for (let k = 0; k < K; k++) if (f[k] >= 40 && f[k] <= 120) {
    let m = 0; for (let p = 0; p < P; p++) { let a = [0, 0]; for (const i of mIdx) a = [a[0] + H[p][i][k][0], a[1] + H[p][i][k][1]]; m += a[0] * a[0] + a[1] * a[1]; }
    ls += Math.log(Math.sqrt(m / P) + 1e-30); ln++;
  }
  const lvl = Math.exp(ls / Math.max(1, ln));
  const limits = o.headroom ? sourceLimits(sp, fc) : null;
  return { sp, f, K, P, keys, n, mains, helpers, solvedKeys, U, nu, directIdx, fc, fLow, capDb, tau, state, w, weighted, Hv, lvl, limits, o, mIdx };
}
const nz = (n) => new Float64Array(n);
/** Normal equations of bin k, per position (all variants summed): AAp[p] (nu x nu), Arp[p] (nu), plus the nominal row a0/r0 for scoring. */
function binEquations(c, k, E) {
  const { f, P, nu, U, directIdx, fc, fLow, tau, state, w, Hv, lvl } = c, fk = f[k], t = handover(fk, fc);
  const ang = -2 * Math.PI * fk * tau, dlr = Math.cos(ang), dli = Math.sin(ang);
  const th = hp4(fk, fLow), tg = [th[0] * lvl, th[1] * lvl], target = [tg[0] * dlr - tg[1] * dli, tg[0] * dli + tg[1] * dlr];
  const mc = directIdx.map(i => mainsChain(state, c.keys[i], fk));
  E.AAr.fill(0); E.AAi.fill(0); E.Arr.fill(0); E.Ari.fill(0);
  const ar = E.tmpr, ai = E.tmpi;
  Hv.forEach((Hx, vi) => {
    for (let p = 0; p < P; p++) {
      let mr = 0, mi = 0;
      for (let d = 0; d < directIdx.length; d++) { const h = Hx[p][directIdx[d]][k], q = mc[d]; mr += h[0] * q[0] - h[1] * q[1]; mi += h[0] * q[1] + h[1] * q[0]; }
      mr *= 1 - t; mi *= 1 - t; const m2r = mr * dlr - mi * dli, m2i = mr * dli + mi * dlr;
      const rr = target[0] - m2r, ri = target[1] - m2i;
      for (let u = 0; u < nu; u++) { const h = Hx[p][U[u]][k]; ar[u] = h[0] * t; ai[u] = h[1] * t; }
      if (vi === 0) { E.mr[p] = m2r; E.mi[p] = m2i; E.r0r[p] = rr; E.r0i[p] = ri; for (let u = 0; u < nu; u++) { E.a0r[p * nu + u] = ar[u]; E.a0i[p * nu + u] = ai[u]; } }
      const wp = w[p], base = p * nu * nu;
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j <= i; j++) { E.AAr[base + i * nu + j] += wp * (ar[i] * ar[j] + ai[i] * ai[j]); E.AAi[base + i * nu + j] += wp * (ar[i] * ai[j] - ai[i] * ar[j]); }
        E.Arr[p * nu + i] += wp * (ar[i] * rr + ai[i] * ri); E.Ari[p * nu + i] += wp * (ar[i] * ri - ai[i] * rr);
      }
    }
  });
  return { t, target };
}
const newEq = (c) => ({ AAr: nz(c.P * c.nu * c.nu), AAi: nz(c.P * c.nu * c.nu), Arr: nz(c.P * c.nu), Ari: nz(c.P * c.nu), mr: nz(c.P), mi: nz(c.P), r0r: nz(c.P), r0i: nz(c.P), a0r: nz(c.P * c.nu), a0i: nz(c.P * c.nu), tmpr: nz(c.nu), tmpi: nz(c.nu), totAr: nz(c.nu * c.nu), totAi: nz(c.nu * c.nu), totBr: nz(c.nu), totBi: nz(c.nu), x0: nz(c.nu), x1: nz(c.nu), capv: nz(c.nu) });
function totals(c, E, skip = -1) {
  const { P, nu } = c; E.totAr.fill(0); E.totAi.fill(0); E.totBr.fill(0); E.totBi.fill(0);
  for (let p = 0; p < P; p++) { if (p === skip) continue; const b = p * nu * nu; for (let i = 0; i < nu * nu; i++) { E.totAr[i] += E.AAr[b + i]; E.totAi[i] += E.AAi[b + i]; } for (let i = 0; i < nu; i++) { E.totBr[i] += E.Arr[p * nu + i]; E.totBi[i] += E.Ari[p * nu + i]; } }
  let tr = 0; for (let i = 0; i < nu; i++) tr += E.totAr[i * nu + i];
  return tr;
}
const capVec = (c, E, k, capDb) => { const base = Math.pow(10, capDb / 20); for (let u = 0; u < c.nu; u++) E.capv[u] = c.limits && c.limits[c.U[u]].locked[k] ? 1 : base; };

/**
 * Automatic regularisation: for every band of REG_EDGES pick (lambda, cap) from the grid by leave-one-out cross-validation over the
 * measured positions (the filters of each fold never see the left-out position; the nominal room is scored, error relative to |target|, position weights applied).
 */
export function chooseReg(sp, opts, stride) {
  const c = setupGeneral(sp, opts), E = newEq(c), { f, K, P, nu } = c;
  const step = stride || Math.max(1, Math.round(1 / (f[1] - f[0]))), caps = capGrid(c.capDb), nb = REG_EDGES.length - 1;
  const cand = []; for (const l of REG_LAMBDAS) for (const cp of caps) cand.push([l, cp]);
  const err = Array.from({ length: nb }, () => new Float64Array(cand.length)), den = new Float64Array(nb);
  for (let k = 1; k < K; k += step) {
    if (f[k] < 20) continue;
    const { t, target } = binEquations(c, k, E);
    if (t < 1e-3) continue;
    const b = regBand(f[k]), t2 = target[0] ** 2 + target[1] ** 2;
    for (let q = 0; q < P; q++) den[b] += c.w[q] * t2;
    for (let q = 0; q < P; q++) {
      const tr = totals(c, E, q);
      cand.forEach(([lam, cp], ci) => {
        capVec(c, E, k, cp);
        solveCapped(E.totAr, E.totAi, E.totBr, E.totBi, nu, lam * tr / nu + 1e-30, E.capv, E.x0, E.x1);
        let er = E.r0r[q], ei = E.r0i[q];
        for (let u = 0; u < nu; u++) { const ar = E.a0r[q * nu + u], ai = E.a0i[q * nu + u]; er -= ar * E.x0[u] - ai * E.x1[u]; ei -= ar * E.x1[u] + ai * E.x0[u]; }
        err[b][ci] += c.w[q] * (er * er + ei * ei);
      });
    }
  }
  const bands = [], def = cand.findIndex(([l, cp]) => l === REG_LAMBDAS[0] && cp === caps[caps.length - 1]);
  for (let b = 0; b < nb; b++) {
    if (!(den[b] > 0)) { bands.push({ f0: REG_EDGES[b], f1: Math.min(REG_EDGES[b + 1], c.fc), lambda: REG_LAMBDAS[0], capDb: c.capDb, err: NaN, errDefault: NaN }); continue; }
    let best = 0; for (let ci = 1; ci < cand.length; ci++) if (err[b][ci] < err[b][best] * 0.999) best = ci;
    bands.push({ f0: REG_EDGES[b], f1: Math.min(REG_EDGES[b + 1], c.fc), lambda: cand[best][0], capDb: cand[best][1], err: Math.sqrt(err[b][best] / den[b]), errDefault: Math.sqrt(err[b][def] / den[b]) });
  }
  return { bands, grid: { lambdas: REG_LAMBDAS, caps } };
}

function solveGeneral(sp, o) {
  const c = setupGeneral(sp, o), E = newEq(c), { f, K, P, n, nu, U, fc, tau } = c;
  const reg = o.auto ? chooseReg(sp, o) : { bands: REG_EDGES.slice(0, -1).map((e, b) => ({ f0: e, f1: Math.min(REG_EDGES[b + 1], fc), lambda: o.lambda ?? o.reg ?? 1e-3, capDb: c.capDb })), fixed: true };
  const B = Array.from({ length: n }, () => Array.from({ length: K }, () => [0, 0])), target = new Array(K), mains = new Array(K);
  target[0] = [0, 0]; mains[0] = Array(P).fill([0, 0]);
  for (let k = 1; k < K; k++) {
    const { t, target: tg } = binEquations(c, k, E); target[k] = tg;
    mains[k] = Array.from({ length: P }, (_, p) => [E.mr[p], E.mi[p]]);
    if (t < 1e-3) continue;
    const rb = reg.bands[regBand(f[k])], tr = totals(c, E);
    capVec(c, E, k, rb.capDb);
    solveCapped(E.totAr, E.totAi, E.totBr, E.totBi, nu, rb.lambda * tr / nu + 1e-30, E.capv, E.x0, E.x1);
    for (let u = 0; u < nu; u++) B[U[u]][k] = [E.x0[u] * t, E.x1[u] * t];
  }
  // what will really run: truncation (and, if asked, the pre-ring taper) in the time domain
  const preDb = o.preRing ? (typeof o.preRing === 'number' ? o.preRing : -30) : null, pre = {};
  const Bw = B.map((b, i) => {
    if (!U.includes(i)) return b;
    const r = windowBinsPR(b, sp, o.lenSec || 1.0, c.fLow, preDb); pre[c.keys[i]] = r.info; return r.bins;
  });
  let maxGain = 0; const perSource = {}, sum = [];
  for (let k = 1; k < K; k++) {
    const t = handover(f[k], fc); let s = 0;
    Bw.forEach((b, i) => { const a = Math.hypot(...b[k]), g = a + (c.directIdx.includes(i) ? 1 - t : 0); maxGain = Math.max(maxGain, g); perSource[i] = Math.max(perSource[i] || 0, g); s += a; });
    sum.push(s);
  }
  const preampDb = -Math.max(0, 20 * Math.log10(maxGain));
  const headroom = { preampDb, sumDb: 20 * Math.log10(Math.max(...sum, 1e-9)), perSource: c.keys.map((key, i) => ({ key, solved: U.includes(i), peakDb: 20 * Math.log10((perSource[i] || 0) + 1e-12), f10: c.limits ? c.limits[i].f10 : null, lockedBins: c.limits ? c.limits[i].locked.reduce((a, v, k) => a + (v && f[k] <= fc ? 1 : 0), 0) : 0 })) };
  const beforeIdx = [...new Set([...c.directIdx, ...c.keys.map((k, i) => k.startsWith('SW') ? i : -1).filter(i => i >= 0)])].sort((a, b) => a - b);
  return { f, B: Bw, target, mains, fc, tau, lvl: c.lvl, preampDb, spectra: sp, keys: c.keys, mainsKeys: c.mains, helperKeys: c.helpers, solvedKeys: c.solvedKeys, directIdx: c.directIdx, beforeIdx, fLow: c.fLow, reg, headroom, preRing: o.preRing ? pre : null, weights: c.weighted ? c.w : null, opts: { auto: !!o.auto, headroom: !!o.headroom, preRing: preDb } };
}

/** Honest prediction for the general solver: each position is predicted with filters (and regularisation!) solved from the others. */
function predictCVGeneral(sp, opts) {
  const P = sp.H.length, perPos = [], keys = sp.keys || ART_SPK;
  const w = opts.weights ? normW(opts.weights, P) : null;
  for (let q = 0; q < P; q++) {
    const train = { ...sp, H: sp.H.filter((_, p) => p !== q) };
    const sol = solveGeneral(train, { ...opts, weights: w ? w.filter((_, p) => p !== q) : null });
    const f = sol.f, K = f.length, mains = [];
    for (let k = 0; k < K; k++) {
      const t = handover(f[k], sol.fc), ang = -2 * Math.PI * f[k] * sol.tau, dl = [Math.cos(ang), Math.sin(ang)];
      let m = [0, 0];
      for (const i of sol.directIdx) { const cc = cm(sp.H[q][i][k], mainsChain(opts.state, keys[i], f[k])); m = [m[0] + cc[0], m[1] + cc[1]]; }
      mains.push([cm(cm(m, [1 - t, 0]), dl)]);
    }
    perPos.push(predict({ ...sol, spectra: { ...sp, H: [sp.H[q]] }, mains }));
  }
  const med = key => ART_BANDS.map((_, b) => median(perPos.map(r => r[key][b])));
  const avg = key => perPos.reduce((s, r) => s + r[key], 0) / P;
  return { bands: ART_BANDS, before: med('before'), after: med('after'), devBefore: avg('devBefore'), devAfter: avg('devAfter') };
}

// ---------------------------------------------------------------- guided measurement (point 7)
/** Cell [column 0..2 left/centre/right, row 0..4 front/middle/back/up/down] of position p in the 15-point walk (see wizard GRID15). */
export const GRID_CELLS = [[1, 1], [1, 0], [1, 2], [0, 1], [2, 1], [0, 0], [2, 0], [0, 2], [2, 2], [1, 3], [1, 4], [0, 3], [2, 3], [0, 4], [2, 4]];
/** Metric offsets (m: right, front, up) of the same walk; neighbours are positions within 0.3 m. */
export const GRID_OFFSETS = [[0, 0, 0], [0, 0.25, 0], [0, -0.25, 0], [-0.25, 0, 0], [0.25, 0, 0], [-0.25, 0.25, 0], [0.25, 0.25, 0], [-0.25, -0.25, 0], [0.25, -0.25, 0], [0, 0, 0.15], [0, 0, -0.15], [-0.15, 0, 0.15], [0.15, 0, 0.15], [-0.15, 0, -0.15], [0.15, 0, -0.15]];
/** Level (dB) of the IR at 1/3-octave points 31..125 Hz. */
function lfLevels(m) {
  const ir = m.ir, N = nextPow2(ir.length * 2), re = new Float64Array(N), im = new Float64Array(N);
  re.set(ir.subarray ? ir : Float64Array.from(ir)); fft(re, im);
  return [31.5, 40, 50, 63, 80, 100, 125].map(fc => { const a = Math.round(fc / Math.pow(2, 1 / 6) * N / m.sr), b = Math.max(a + 1, Math.round(fc * Math.pow(2, 1 / 6) * N / m.sr)); let s = 0; for (let k = a; k <= b; k++) s += re[k] * re[k] + im[k] * im[k]; return 10 * Math.log10(s / (b - a + 1) + 1e-30); });
}
// the wizard calls positionQuality() after every position: each recording's FFT is done once
const lfCache = new WeakMap();
const lfCached = m => { let v = lfCache.get(m); if (!v) lfCache.set(m, v = lfLevels(m)); return v; };
/**
 * Quality of each measured position: worst SNR over the speakers and the deviation of its 31-125 Hz levels from the mean of its
 * already-measured neighbours (positions within 0.3 m), rms in dB. ok = SNR >= minSnr and deviation <= maxDevDb.
 * meas[ch][p] = {ir, sr, snrDb}. Positions with no neighbour yet (the first) only get the SNR test.
 */
export function positionQuality(meas, keys, { minSnr = 20, maxDevDb = 9 } = {}) {
  if (!keys.length) return [];   // Math.min() of nothing is Infinity
  const P = Math.min(...keys.map(k => (meas[k] || []).length)), lv = keys.map(k => meas[k].slice(0, P).map(lfCached)), out = [];
  const dist = (a, b) => Math.hypot(...GRID_OFFSETS[a % 15].map((v, i) => v - GRID_OFFSETS[b % 15][i]));
  for (let p = 0; p < P; p++) {
    const snr = Math.min(...keys.map(k => meas[k][p].snrDb ?? Infinity));
    const nb = []; for (let q = 0; q < P; q++) if (q !== p && dist(p, q) <= 0.3) nb.push(q);
    let s = 0, c = 0;
    if (nb.length) keys.forEach((_, i) => lv[i][p].forEach((v, j) => { const m = nb.reduce((a, q) => a + lv[i][q][j], 0) / nb.length; s += (v - m) ** 2; c++; }));
    const dev = c ? Math.sqrt(s / c) : 0, reasons = [];
    if (snr < minSnr) reasons.push('snr'); if (dev > maxDevDb) reasons.push('dev');
    out.push({ p, snrDb: snr, devDb: dev, neighbours: nb.length, ok: !reasons.length, reasons });
  }
  return out;
}

// ---------------------------------------------------------------- verification loop (point 6)
/** Time-domain IR (N samples, circular) of a spectrum given on bins 0..K-1. */
export function irFromSpec(spec, N) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 1; k < spec.length; k++) { re[k] = spec[k][0]; im[k] = spec[k][1]; re[N - k] = spec[k][0]; im[N - k] = -spec[k][1]; }
  fft(re, im, true); const sc = fftInverseScale(N); for (let n = 0; n < N; n++) re[n] *= sc;
  return re;
}
/** Modal-decay bands (ms) of a single IR via acoustics.bandT60, clipped to maxSec after the start. */
export const irBandT60 = (ir, sr, bands = ART_BANDS, maxSec = 0.6) => { const x = ir.subarray ? ir.subarray(0, Math.round(maxSec * sr)) : ir.slice(0, Math.round(maxSec * sr)); return bands.map(fc => bandT60Ir(x, sr, fc)); };
/** Positions the verification re-measures: the centre first, then the axes (3 or 5). */
export const verifyPositions = n => [0, 1, 2, 3, 4].slice(0, n === 5 ? 5 : 3);
/** Spectrum a given position would have with the solution playing: [uncorrected mono front, predicted with ART]. */
export function systemSpectra(sol, p, H = sol.spectra.H) {
  const { f, B, mains } = sol, K = f.length, bIdx = sol.beforeIdx || [0, 1], before = [], after = [];
  for (let k = 0; k < K; k++) {
    let x = [0, 0]; for (const i of bIdx) x = [x[0] + H[p][i][k][0], x[1] + H[p][i][k][1]];
    before.push(cm(x, ex(-2 * Math.PI * f[k] * sol.tau)));
    let y = mains[k][p] || [0, 0];
    for (let i = 0; i < B.length; i++) { const v = cm(H[p][i][k], B[i][k]); y = [y[0] + v[0], y[1] + v[1]]; }
    after.push(y);
  }
  return { before, after };
}
/** Simulated re-measurement (demo only): the predicted system in a room that drifted by driftPct %, plus noise noiseDb below the peak. Deterministic. */
export function simulateRemeasure(sol, positions, { driftPct = 0.5, noiseDb = -55, seed = 5 } = {}) {
  const sp = sol.spectra, N = sp.N, warped = warpH(sp, 1 + driftPct / 100);
  let s = seed >>> 0 || 1; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  return positions.map(p => {
    const { after } = systemSpectra(sol, p, warped);
    const pk = Math.max(...after.map(v => Math.hypot(...v))), a = pk * Math.pow(10, noiseDb / 20);
    const noisy = after.map((v, k) => k ? [v[0] + a * (rnd() - 0.5) * 2, v[1] + a * (rnd() - 0.5) * 2] : v);
    return { ir: irFromSpec(noisy, N), sr: sp.sr };
  });
}
const medianOf = a => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : NaN; };
/**
 * Compare band decay before / after / predicted. before, after, predicted: arrays (per position) of arrays (per band, ms).
 * Verdict is based on the median change over the bands below fc: improved <= -10 %, worse >= +10 % (or any band >= +30 %), else no change.
 * suggestions: ids for the UI ('lambda' larger regularisation, 'fc' lower hand-over, 'positions' fewer positions, 'remeasure' repeat it, 'gap' prediction missed).
 */
export function verifyReport({ before, after, predicted, bands = ART_BANDS, fc = 120 }) {
  const med = arr => bands.map((_, b) => medianOf(arr.map(r => r[b])));
  const b0 = med(before), a1 = med(after), pr = predicted ? med(predicted) : null;
  const use = bands.map((fb, i) => fb <= fc && Number.isFinite(b0[i]) && Number.isFinite(a1[i]) ? i : -1).filter(i => i >= 0);
  const pct = (x, y) => use.length ? medianOf(use.map(i => (x[i] / y[i] - 1) * 100)) : NaN;
  const overallPct = pct(a1, b0), predictedPct = pr ? pct(pr, b0) : NaN;
  const worstBand = use.length ? Math.max(...use.map(i => (a1[i] / b0[i] - 1) * 100)) : NaN;
  const verdict = !use.length ? 'unknown' : (overallPct >= 10 || worstBand >= 30) ? 'worse' : overallPct <= -10 ? 'improved' : 'nochange';
  const suggestions = [];
  if (verdict === 'worse' || verdict === 'nochange') {
    suggestions.push('remeasure');
    if (Number.isFinite(predictedPct) && predictedPct < overallPct - 15) suggestions.push('gap');
    suggestions.push('lambda', 'fc', 'positions');
  }
  return { bands, fc, before: b0, after: a1, predicted: pr, overallPct, predictedPct, worstBand, verdict, suggestions, n: after.length };
}
