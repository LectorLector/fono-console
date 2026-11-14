// Stereo symmetry correction (pure DSP + geometry, no DOM).
//   1. magnitude matching of FL / FR: gentle PK filters that move each side toward the mean of the two
//   2. time / phase matching: per-band arrival difference and a short linear-phase FIR pair (each side moves halfway)
//   3. phantom-centre check: measured L+R (mono) against the complex sum and the power sum predicted from FL and FR
//   4. placement geometry from the floor plan (distances, angles, toe-in, wall symmetry)
import { fft, nextPow2 } from './fft.js';
import { smooth, chainDb, interpCurve } from './dsp.js';
import { groupDelay, designFIR, firPhaseAt, excessPhaseFromIR } from './fir.js';

const SR_FIT = 48000, C_AIR = 343;
const fin = Number.isFinite;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const mean = a => { const v = a.filter(fin); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN; };
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));

/** Defaults of S.room.stereo (the state keeps only what the user changes; stereoOf() fills the rest). */
export const STEREO_DEFAULT = {
  matchOn: true, phaseOn: false,
  band: { lo: 150, hi: 8000, maxDb: 4, maxQ: 3, maxFilters: 6 },
  match: { FL: [], FR: [] },
  phase: { built: '', latencyMs: 0, chans: ['FL', 'FR'], taps48: 2048, spreadMs: 0 },
};
/** Stereo settings with defaults filled in. */
export function stereoOf(s) {
  const o = s.room?.stereo || {};
  return { ...STEREO_DEFAULT, ...o, band: { ...STEREO_DEFAULT.band, ...(o.band || {}) }, match: { FL: o.match?.FL || [], FR: o.match?.FR || [] }, phase: { ...STEREO_DEFAULT.phase, ...(o.phase || {}) } };
}
/** Is the whole feature on (core feature `stereo`, default on)? */
export const stereoEnabled = s => s.ui?.features?.stereo !== false;
/** The match filters that eapo.js writes for speaker `key` ([] when off, not a front speaker, or the feature is off). */
export function matchFiltersFor(s, key) {
  if (!stereoEnabled(s) || key !== 'FL' && key !== 'FR') return [];
  const st = stereoOf(s);
  return st.matchOn ? st.match[key] : [];
}

const logSteps = (lo, hi, perOct) => { const g = []; for (let f = lo; f <= hi * 1.0001; f *= Math.pow(2, 1 / perOct)) g.push(f); return g; };

// ---------------------------------------------------------------- 1. magnitude matching
/** Greedy + coordinate-descent fit of gentle peaking filters to `target` (dB) on grid G; points where usable[i] is false do not count. */
function fitPK(G, target, usable, o) {
  const filters = [];
  const clampF = x => ({ type: 'PK', fc: Math.min(o.hi, Math.max(o.lo, x.fc)), gain: Math.max(-o.maxDb, Math.min(o.maxDb, x.gain)), q: Math.max(o.minQ, Math.min(o.maxQ, x.q)) });
  const res = (fl = filters) => G.map((f, i) => target[i] - chainDb(fl, f, SR_FIT));
  const cost = fl => { let c = 0, n = 0; for (let i = 0; i < G.length; i++) { if (!usable[i]) continue; const e = target[i] - chainDb(fl, G[i], SR_FIT); c += e * e; n++; } return n ? c / n : 0; };
  for (let k = 0; k < o.maxFilters; k++) {
    const r = res();
    let mi = -1, mv = o.tol;
    for (let i = 0; i < G.length; i++) if (usable[i] && Math.abs(r[i]) > mv) { mv = Math.abs(r[i]); mi = i; }
    if (mi < 0) break;
    const sg = Math.sign(r[mi]);
    let a = mi, b = mi;
    while (a > 0 && r[a] * sg > mv / 2) a--;
    while (b < G.length - 1 && r[b] * sg > mv / 2) b++;
    const bw = Math.max(G[b] - G[a], G[mi] * 0.12);
    const trial = filters.concat([clampF({ fc: G[mi], gain: sg * mv * 0.9, q: G[mi] / bw })]);
    for (let it = 0; it < 30; it++) {
      let improved = false;
      for (let j = 0; j < trial.length; j++) {
        for (const [key, step] of [['fc', Math.pow(2, 1 / 24)], ['gain', 0.25], ['q', 1.1]]) {
          for (const dir of [1, -1]) {
            const t2 = trial.slice(), x = { ...t2[j] };
            x[key] = key === 'gain' ? x.gain + dir * step : x[key] * Math.pow(step, dir);
            t2[j] = clampF(x);
            if (cost(t2) < cost(trial) - 1e-6) { trial.splice(0, trial.length, ...t2); improved = true; }
          }
        }
      }
      if (!improved) break;
    }
    if (cost(trial) >= cost(filters) - 1e-4) break;
    filters.splice(0, filters.length, ...trial);
  }
  return filters.map(f => ({ type: 'PK', fc: Math.round(f.fc * 10) / 10, gain: Math.round(f.gain * 10) / 10, q: Math.round(f.q * 100) / 100 })).filter(f => Math.abs(f.gain) >= 0.3);
}

/**
 * Fit L/R magnitude matching filters.
 * cL, cR: {f, db} position averaged curves of FL and FR (any grid); maskL / maskR: optional {f, ok:[bool]} reliability (SNR mask).
 * opts: {lo=150, hi=8000, maxDb=4, maxQ=3, minQ=0.5, maxFilters=6, smoothFrac=6, tol=0.4}.
 * The broadband level difference (mean of the band) is NOT part of the fit (that is a gain, set by the one-click calibration).
 * Returns {filters:{FL,FR}, f (grid), L, R, mean (smoothed dB, level offset removed so both sit on the mean), afterL, afterR,
 *          levelOffsetDb (FL - FR), rmsBefore, rmsAfter (RMS of the L-R difference in the band, offset removed), reduction (0..1)}.
 */
export function matchLR(cL, cR, opts = {}) {
  const o = { lo: 150, hi: 8000, maxDb: 4, maxQ: 3, minQ: 0.5, maxFilters: 6, smoothFrac: 6, tol: 0.4, ...opts };
  const sL = smooth(cL, o.smoothFrac), sR = smooth(cR, o.smoothFrac);
  const G = logSteps(o.lo, o.hi, 24);
  const okAt = (m, f) => !m || !m.f?.length ? true : interpCurve({ f: m.f, db: m.ok.map(v => (v ? 1 : 0)) }, f) >= 0.5;
  const usable = G.map(f => okAt(opts.maskL, f) && okAt(opts.maskR, f));
  const L = G.map(f => interpCurve(sL, f)), R = G.map(f => interpCurve(sR, f));
  const diff = L.map((v, i) => v - R[i]);
  const used = diff.filter((_, i) => usable[i]);
  const off = used.length ? mean(used) : 0;
  const dz = diff.map(v => v - off);
  const rmsBefore = used.length ? rms(dz.filter((_, i) => usable[i])) : 0;
  const fl = fitPK(G, dz.map(v => -v / 2), usable, o), fr = fitPK(G, dz.map(v => v / 2), usable, o);
  const gL = G.map(f => chainDb(fl, f, SR_FIT)), gR = G.map(f => chainDb(fr, f, SR_FIT));
  const after = dz.map((v, i) => v + gL[i] - gR[i]);
  const rmsAfter = used.length ? rms(after.filter((_, i) => usable[i])) : 0;
  const m = L.map((v, i) => (v + R[i]) / 2);
  return {
    filters: { FL: fl, FR: fr }, f: G, L, R, mean: m, afterL: L.map((v, i) => v + gL[i]), afterR: R.map((v, i) => v + gR[i]),
    levelOffsetDb: r2(off), rmsBefore, rmsAfter, reduction: rmsBefore > 1e-9 ? 1 - rmsAfter / rmsBefore : 0, usable,
  };
}
/** The largest gain / Q the filters really use (for the "within limits" check). */
export const filterLimits = fl => ({ maxAbsGain: Math.max(0, ...fl.map(x => Math.abs(x.gain))), maxQ: Math.max(0, ...fl.map(x => x.q)), minFc: Math.min(Infinity, ...fl.map(x => x.fc)), maxFc: Math.max(0, ...fl.map(x => x.fc)) });

// ---------------------------------------------------------------- 2. time / phase matching
/** 1/3-octave centres from 100 Hz to 4 kHz. */
export const TIME_BANDS = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000];
const bandAvg = (f, y, fc) => { const a = fc / Math.pow(2, 1 / 6), b = fc * Math.pow(2, 1 / 6); let s = 0, n = 0; for (let i = 0; i < f.length; i++) if (f[i] >= a && f[i] <= b && fin(y[i])) { s += y[i]; n++; } return n ? s / n : NaN; };
/**
 * Per-band arrival difference tL - tR (ms) from the excess phases of the two speakers (fir.js excessPhaseFromIR: {f, phase, delayMs}):
 * the group delay of each excess phase plus its removed delay, plus the arrival difference arrDiffMs (arrivalMs of FL minus FR).
 * Returns {bands:[{f, ms}], meanMs, spreadMs (max - min), rmsMs (RMS around the mean)}.
 */
export function bandTimeDiff(exL, exR, arrDiffMs = 0, centres = TIME_BANDS) {
  const gL = groupDelay(exL), gR = groupDelay(exR), dL = exL.delayMs || 0, dR = exR.delayMs || 0;
  const bands = centres.map(fc => ({ f: fc, ms: bandAvg(gL.f, gL.ms, fc) + dL - (bandAvg(gR.f, gR.ms, fc) + dR) + arrDiffMs })).filter(b => fin(b.ms));
  const v = bands.map(b => b.ms), m = mean(v);
  return { bands, meanMs: m, spreadMs: v.length ? Math.max(...v) - Math.min(...v) : 0, rmsMs: rms(v.map(x => x - m)) };
}
/** Is the mismatch worth a FIR? It must vary with frequency (spread beyond 0.1 ms), a constant offset is just a delay. */
export const PHASE_SPREAD_MS = 0.1;
export const needsPhaseFix = td => td.spreadMs > PHASE_SPREAD_MS;

/**
 * The added group delay (ms) per band for each side so that tL - tR becomes constant: L moves -d/2, R moves +d/2 (d = deviation from the mean).
 * Returns {L:[{f, ms}], R:[...]}.
 */
export function halfwayTargets(td) {
  return { L: td.bands.map(b => ({ f: b.f, ms: -(b.ms - td.meanMs) / 2 })), R: td.bands.map(b => ({ f: b.f, ms: (b.ms - td.meanMs) / 2 })) };
}
/** Excess-phase object ({f, phase}) whose designFIR() correction adds the group delay `pts` ([{f, ms}], faded out half an octave outside the bands). */
function phaseFromDelays(pts, sr) {
  const lo = pts[0].f, hi = pts[pts.length - 1].f;
  const tau = f => {
    let y;
    if (f <= pts[0].f) y = pts[0].ms; else if (f >= pts[pts.length - 1].f) y = pts[pts.length - 1].ms;
    else { let i = 0; while (pts[i + 1].f < f) i++; const t = Math.log(f / pts[i].f) / Math.log(pts[i + 1].f / pts[i].f); y = pts[i].ms + (pts[i + 1].ms - pts[i].ms) * t; }
    const oct = f < lo ? Math.log2(lo / f) : f > hi ? Math.log2(f / hi) : 0;
    return oct >= 0.5 ? 0 : y * (0.5 + 0.5 * Math.cos(Math.PI * oct / 0.5)) * (oct > 0 ? 1 : 1);
  };
  const f = [], phase = [], df = 4; let ph = 0, prev = 0;
  for (let fr = df; fr < sr / 2; fr += df) { const t = tau(fr); ph += 2 * Math.PI * (t / 1000) * df; f.push(fr); phase.push(ph); prev = t; }
  return { f, phase, delayMs: 0 };
}
/**
 * Short linear-phase FIR pair for FL / FR from the per-band time difference.
 * opts: {sr=48000, taps48=2048}. Returns {FL: Float32Array, FR: Float32Array, latencyMs, targets, predicted:{bands, residualRms, beforeRms, ratio}}.
 * `predicted` evaluates the real FIR pair (group delay of the taps) against the measured per-band difference.
 */
export function designPhasePair(td, { sr = 48000, taps48 = 2048 } = {}) {
  if (td.bands.length < 3) throw new Error('not enough bands');
  const tg = halfwayTargets(td), lo = td.bands[0].f / 1.12, hi = td.bands[td.bands.length - 1].f * 1.12;
  const fL = designFIR(phaseFromDelays(tg.L, sr), sr, { lo, hi, taps48 }), fR = designFIR(phaseFromDelays(tg.R, sr), sr, { lo, hi, taps48 });
  const gd = (h, fc) => { const d = fc / 12; return -(firPhaseAt(h, sr, fc + d).phase - firPhaseAt(h, sr, fc - d).phase) * 1000 / (2 * Math.PI * 2 * d); };
  const after = td.bands.map(b => ({ f: b.f, ms: b.ms + gd(fL.h, b.f) - gd(fR.h, b.f) }));
  const m2 = mean(after.map(x => x.ms)), residualRms = rms(after.map(x => x.ms - m2));
  return { FL: fL.h, FR: fR.h, latencyMs: fL.latencyMs, targets: tg, predicted: { bands: after, residualRms, beforeRms: td.rmsMs, ratio: td.rmsMs > 1e-9 ? residualRms / td.rmsMs : 0 } };
}

/** For buildExport(): sr -> {FL, FR, latencyMs} from the FL / FR measurements (res = {FL:[m], FR:[m]}), or null when there are none / no frequency-dependent mismatch. */
export function symProvider(res, taps48 = STEREO_DEFAULT.phase.taps48) {
  const a = res?.FL?.[0], b = res?.FR?.[0];
  if (!a?.ir?.length || !b?.ir?.length) return null;
  const td = bandTimeDiff(excessPhaseFromIR(a.ir, a.sr), excessPhaseFromIR(b.ir, b.sr), (a.arrivalMs || 0) - (b.arrivalMs || 0));
  if (td.bands.length < 3 || !needsPhaseFix(td)) return null;
  return sr => designPhasePair(td, { sr, taps48 });
}

// ---------------------------------------------------------------- 3. phantom centre
/**
 * Complex frequency response of one measurement on grid `fr` with the time origin at the timing reference
 * (m = {ir, sr, irPeak, arrivalMs}: the IR window starts irPeak samples before the main peak, which arrived arrivalMs after the reference).
 * Returns {re[], im[]}.
 */
export function complexResponse(m, fr, { windowMs = 60 } = {}) {
  const sr = m.sr, pk = m.irPeak || 0, n = Math.min(m.ir.length, Math.round(windowMs / 1000 * sr)), N = nextPow2(Math.max(n * 2, 16384));
  const re = new Float64Array(N), im = new Float64Array(N), fade = Math.round(n * 0.25);
  for (let i = 0; i < n; i++) re[i] = m.ir[i] * (i > n - fade ? 0.5 + 0.5 * Math.cos(Math.PI * (i - (n - fade)) / fade) : 1);
  fft(re, im);
  const t0 = m.arrivalMs / 1000 - pk / sr, outRe = [], outIm = [];
  for (const f of fr) {
    const k = Math.min(N / 2 - 1, Math.max(0, Math.round(f * N / sr))), a = -2 * Math.PI * f * t0, c = Math.cos(a), s = Math.sin(a);
    outRe.push(re[k] * c - im[k] * s); outIm.push(re[k] * s + im[k] * c);
  }
  return { re: outRe, im: outIm };
}
const pwr = (r, i) => r * r + i * i;
const toDb = p => 10 * Math.log10(Math.max(p, 1e-20));

/**
 * Phantom-centre check. L, R, M = arrays (one entry per measured position, same length) of measurements of FL, FR and FL+FR played together.
 * Predicts the mono measurement from the individual ones: complex sum (with the real timing and phase) and power sum (|L|^2 + |R|^2),
 * averages every quantity in power over the positions, smooths in 1/6 octave and reports the bands where the measured sum is more than
 * `cancelDb` (6) below the power sum.
 * Returns {f, measured, complex, power (dB), cancel:[{f0, f1, fc, depthDb, explained}], worstDb, bandMeanDb}
 * `explained` = the complex-sum prediction shows the same hole (within 3 dB), i.e. it comes from the timing / phase of FL and FR themselves
 * (asymmetric reflections, arrival difference) and not from a wrong routing or a polarity error in the mono run.
 */
export function phantomCheck(L, R, M, { lo = 100, hi = 8000, cancelDb = 6, smoothFrac = 6, windowMs = 60 } = {}) {
  const f = logSteps(lo, hi, 24), P = Math.min(L.length, R.length, M.length);
  if (!P) throw new Error('no measurements');
  const acc = { m: new Float64Array(f.length), c: new Float64Array(f.length), p: new Float64Array(f.length) };
  for (let p = 0; p < P; p++) {
    const a = complexResponse(L[p], f, { windowMs }), b = complexResponse(R[p], f, { windowMs }), m = complexResponse(M[p], f, { windowMs });
    for (let i = 0; i < f.length; i++) {
      acc.m[i] += pwr(m.re[i], m.im[i]); acc.c[i] += pwr(a.re[i] + b.re[i], a.im[i] + b.im[i]); acc.p[i] += pwr(a.re[i], a.im[i]) + pwr(b.re[i], b.im[i]);
    }
  }
  const sm = v => smooth({ f, db: Array.from(v, x => toDb(x / P)) }, smoothFrac);
  const mm = sm(acc.m), cc = sm(acc.c), pp = sm(acc.p);
  const dev = mm.db.map((v, i) => v - pp.db[i]);
  const cancel = [];
  let s = -1;
  const close = e => {
    if (s < 0) return;
    const a = s, b = e - 1, width = Math.log2(f[b] / f[a]);
    if (width >= 1 / 6 - 1e-9) {
      let w = a; for (let i = a; i <= b; i++) if (dev[i] < dev[w]) w = i;
      cancel.push({ f0: Math.round(f[a]), f1: Math.round(f[b]), fc: Math.round(f[w]), depthDb: r1(-dev[w]), explained: Math.abs(mm.db[w] - cc.db[w]) <= 3 });
    }
    s = -1;
  };
  for (let i = 0; i < f.length; i++) { if (dev[i] < -cancelDb) { if (s < 0) s = i; } else close(i); }
  close(f.length);
  return { f, measured: mm.db, complex: cc.db, power: pp.db, cancel, worstDb: r1(Math.min(...dev)), bandMeanDb: r1(mean(dev)) };
}

// ---------------------------------------------------------------- 4. placement geometry
/**
 * Geometry of the front pair from the floor plan. P = {seat:[x,y], ear, FL:[x,y,z], FR:[x,y,z]} (metres, x from the front wall,
 * y from the left wall; the listener faces the front wall); dims = {L, W, H}. Pure.
 * Returns {dist:{FL,FR} (3D, to the ear), diffCm, diffMs, nearer, spacing, listen (mean horizontal distance), ratio (spacing / listen),
 * triangleDevPct (spacing vs the equilateral triangle), angle:{FL,FR} (deg from the centre line, negative = left), angleDiff,
 * toe:{FL:{atHead, behind, aimX}, FR:{...}} (toe-in in degrees from the straight-ahead axis), wall:{FL:{side, front}, FR:{...}} (m),
 * sideDiffCm, frontDiffCm, seatOffsetCm (seat vs the speaker midline; + = right), seatWall:{left, right}}.
 */
export function geometry(P, dims, { behind = 0.3 } = {}) {
  const seat = [P.seat[0], P.seat[1], P.ear ?? 1.1], out = { dist: {}, angle: {}, toe: {}, wall: {} };
  const sp = { FL: P.FL, FR: P.FR }, hor = {};
  for (const k of ['FL', 'FR']) {
    const p = sp[k], dx = seat[0] - p[0], dy = p[1] - seat[1];
    out.dist[k] = Math.hypot(dx, dy, (p[2] ?? seat[2]) - seat[2]);
    hor[k] = Math.hypot(dx, dy);
    out.angle[k] = Math.atan2(dy, dx) * 180 / Math.PI;
    out.toe[k] = {
      atHead: Math.abs(out.angle[k]),
      behind: Math.atan2(Math.abs(dy), dx + behind) * 180 / Math.PI,
      aimX: seat[0] + behind,
    };
    out.wall[k] = { side: k === 'FL' ? p[1] : dims.W - p[1], front: p[0] };
  }
  const d = out.dist.FL - out.dist.FR;
  out.diffCm = Math.abs(d) * 100; out.diffMs = Math.abs(d) / C_AIR * 1000; out.nearer = d < 0 ? 'FL' : d > 0 ? 'FR' : '';
  out.spacing = Math.hypot(P.FL[0] - P.FR[0], P.FL[1] - P.FR[1]);
  out.listen = (hor.FL + hor.FR) / 2;
  out.ratio = out.listen > 0 ? out.spacing / out.listen : NaN;
  out.triangleDevPct = (out.ratio - 1) * 100;   // equilateral: spacing == listening distance
  out.angleDiff = Math.abs(Math.abs(out.angle.FL) - Math.abs(out.angle.FR));
  out.sideDiffCm = Math.abs(out.wall.FL.side - out.wall.FR.side) * 100;
  out.frontDiffCm = Math.abs(out.wall.FL.front - out.wall.FR.front) * 100;
  out.seatOffsetCm = (seat[1] - (P.FL[1] + P.FR[1]) / 2) * 100;
  out.seatWall = { left: seat[1], right: dims.W - seat[1] };
  out.openingDeg = Math.abs(out.angle.FL) + Math.abs(out.angle.FR);
  return out;
}
