// Pure room-acoustics helpers for the lab: decay analysis, waterfall, mirror image sources,
// room-mode pressure, target-curve and microphone-calibration utilities. No DOM.
import { fft, nextPow2 } from './fft.js';

export const C_AIR = 343;

// ---------------------------------------------------------------- decay (Schroeder)
export const OCT_BANDS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

/** RBJ constant-0-dB-peak band-pass, one octave wide (Q = 1/(2 sinh(ln2/2)) = sqrt2). */
export function bandpassCoef(fc, sr, oct = 1) {
  const w0 = 2 * Math.PI * fc / sr, s = Math.sin(w0);
  const alpha = s * Math.sinh(Math.log(2) / 2 * oct * w0 / s);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, -2 * Math.cos(w0) / a0, (1 - alpha) / a0];
}
function biquadRun(x, [b0, b1, b2, a1, a2]) {
  const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; y[i] = v; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; }
  return y;
}
/** Forward-backward (zero-phase) 2nd-order octave band-pass, with zero padding so the tails ring out. */
export function octaveFilter(ir, sr, fc, oct = 1) {
  const pad = Math.round(sr * 0.2), x = new Float64Array(ir.length + 2 * pad);
  x.set(ir, pad);
  const co = bandpassCoef(fc, sr, oct);
  let y = biquadRun(x, co).reverse();
  y = biquadRun(y, co).reverse();
  return y;
}

/** Backward-integrated energy decay in dB (0 dB at the start). `e` = energy per sample. */
export function schroederDb(e) {
  const n = e.length, out = new Float64Array(n); let acc = 0;
  for (let i = n - 1; i >= 0; i--) { acc += e[i]; out[i] = acc; }
  const tot = out[0] || 1e-300;
  for (let i = 0; i < n; i++) out[i] = 10 * Math.log10(out[i] / tot + 1e-300);
  return out;
}

/** Least-squares slope (dB/s) of the decay curve between hiDb and loDb (e.g. -5 .. -25); NaN without enough range. */
export function decaySlope(db, sr, hiDb, loDb) {
  let i0 = -1, i1 = -1;
  for (let i = 0; i < db.length; i++) { if (i0 < 0 && db[i] <= hiDb) i0 = i; if (db[i] <= loDb) { i1 = i; break; } }
  if (i0 < 0 || i1 < 0 || i1 - i0 < 4) return NaN;
  let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = i1 - i0 + 1;
  for (let i = i0; i <= i1; i++) { const t = i / sr; sx += t; sy += db[i]; sxx += t * t; sxy += t * db[i]; }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}
/** Reverberation time extrapolated to 60 dB from the fit between hiDb and loDb. */
export const rtFrom = (db, sr, hiDb, loDb) => { const s = decaySlope(db, sr, hiDb, loDb); return s < 0 ? -60 / s : NaN; };

/**
 * EDT (0..-10 dB), T20 (-5..-25) and T30 (-5..-35) of one IR (optionally band-filtered).
 * The integral starts at the main peak and stops where the smoothed energy reaches 3 dB over the
 * noise floor (mean energy of the last 10 %), with the noise power subtracted.
 */
export function decayTimes(ir, sr, fc = 0, oct = 1) {
  // octaveFilter pads both ends with 0.2 s of zeros; cut that off again, otherwise the "noise floor" (mean of the last 10 %) is measured in the padding
  const x = fc ? octaveFilter(ir, sr, fc, oct).subarray(Math.round(sr * 0.2), Math.round(sr * 0.2) + ir.length) : Float64Array.from(ir);
  let pk = 0, pv = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pv) { pv = a; pk = i; } }
  const n = x.length, e = new Float64Array(n - pk);
  for (let i = pk; i < n; i++) e[i - pk] = x[i] * x[i];
  const tail = Math.max(8, Math.floor(e.length * 0.1)); let noise = 0;
  for (let i = e.length - tail; i < e.length; i++) noise += e[i];
  noise /= tail;
  // 10 ms moving average to find the truncation point
  const w = Math.max(1, Math.round(0.01 * sr)); let acc = 0, cut = e.length;
  for (let i = 0; i < e.length; i++) {
    acc += e[i]; if (i >= w) acc -= e[i - w];
    if (i > w && acc / w < noise * 2) { cut = i; break; }
  }
  const use = new Float64Array(cut);
  for (let i = 0; i < cut; i++) use[i] = Math.max(0, e[i] - noise);
  const db = schroederDb(use);
  // dynamic range = peak energy over the noise floor (the noise-subtracted Schroeder curve itself runs to -infinity)
  const range = Math.max(0, Math.min(120, 10 * Math.log10((pv * pv + 1e-300) / (noise + 1e-30))));
  return { edt: rtFrom(db, sr, 0, -10), t20: rtFrom(db, sr, -5, -25), t30: rtFrom(db, sr, -5, -35), db, range };
}

/** Band reverberation time (T20 extrapolated to 60 dB, in ms; NaN when the band does not decay enough) in a 1/3-octave band around fc: used for the bass bands of the ART verification. */
export function bandT60(ir, sr, fc, oct = 1 / 3) {
  const t = decayTimes(ir, sr, fc, oct).t20;
  return Number.isFinite(t) ? t * 1000 : NaN;
}

/** Per octave band results; bands whose upper edge is above 0.45 sr are skipped. */
export function decayTable(ir, sr, bands = OCT_BANDS) {
  return bands.filter(fc => fc * Math.SQRT2 < 0.45 * sr).map(fc => ({ fc, ...decayTimes(ir, sr, fc) }));
}

// ---------------------------------------------------------------- waterfall (CSD)
/**
 * Cumulative spectral decay: `slices` windowed FFTs of the IR starting at 0 .. tMaxMs after the
 * main peak. Each slice is the IR tail multiplied by the falling half of a Hann window (winMs long).
 * Returns {f, t (ms), db[slice][freq]} normalised to the maximum of slice 0.
 */
export function csd(ir, sr, { slices = 30, tMaxMs = 300, fLo = 20, fHi = 1000, nF = 120, winMs = 120 } = {}) {
  let pk = 0, pv = 0;
  for (let i = 0; i < ir.length; i++) { const a = Math.abs(ir[i]); if (a > pv) { pv = a; pk = i; } }
  const Lw = Math.round(winMs / 1000 * sr), N = nextPow2(Lw * 4);
  const hi = Math.min(fHi, 0.45 * sr);
  const f = Array.from({ length: nF }, (_, i) => fLo * Math.pow(hi / fLo, i / (nF - 1)));
  const t = Array.from({ length: slices }, (_, i) => i * tMaxMs / (slices - 1));
  const out = []; let ref = 0;
  for (const tm of t) {
    const s0 = pk + Math.round(tm / 1000 * sr), re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < Lw && s0 + i < ir.length; i++) re[i] = ir[s0 + i] * (0.5 + 0.5 * Math.cos(Math.PI * i / Lw));
    fft(re, im);
    const row = f.map(fr => { const k = fr * N / sr, k0 = Math.floor(k), a = k - k0; return Math.hypot(re[k0], im[k0]) * (1 - a) + Math.hypot(re[k0 + 1], im[k0 + 1]) * a; });
    if (!out.length) ref = Math.max(...row);
    out.push(row);
  }
  return { f, t, db: out.map(r => r.map(v => 20 * Math.log10(v / (ref || 1) + 1e-9))) };
}

// ---------------------------------------------------------------- mirror image sources
export const SURFACES = [
  { id: 'front', name: '前牆', axis: 0, at: 0 }, { id: 'back', name: '後牆', axis: 0, at: 'L' },
  { id: 'left', name: '左牆', axis: 1, at: 0 }, { id: 'right', name: '右牆', axis: 1, at: 'W' },
  { id: 'floor', name: '地板', axis: 2, at: 0 }, { id: 'ceil', name: '天花板', axis: 2, at: 'H' },
];

/**
 * First-order reflections of source `src` [x,y,z] to receiver `rx` in the box [0,L]x[0,W]x[0,H].
 * Image source = src mirrored in the wall plane; the reflection point is where the straight line
 * image -> receiver crosses that plane. Returns rows {id,name,pt,extra (m),ms,image}.
 */
export function firstReflections(src, rx, dims) {
  const d0 = Math.hypot(src[0] - rx[0], src[1] - rx[1], src[2] - rx[2]);
  const size = [dims.L, dims.W, dims.H];
  return SURFACES.map(s => {
    const wall = s.at === 0 ? 0 : size[s.axis];
    const img = src.slice(); img[s.axis] = 2 * wall - src[s.axis];
    const path = Math.hypot(img[0] - rx[0], img[1] - rx[1], img[2] - rx[2]);
    const t = (wall - img[s.axis]) / (rx[s.axis] - img[s.axis]);
    const pt = img.map((v, i) => v + t * (rx[i] - v));
    return { id: s.id, name: s.name, pt, image: img, path, extra: path - d0, ms: (path - d0) / C_AIR * 1000 };
  });
}

/** Match measured ETC peaks (rows with .ms) to predicted reflections within tolMs; returns the matched surface per peak. */
export function matchPeaks(peaks, preds, tolMs = 0.3) {
  return peaks.map(p => {
    let best = null;
    for (const r of preds) { const d = Math.abs(r.ms - p.ms); if (d <= tolMs && (!best || d < best.d)) best = { r, d }; }
    return best ? { ...p, surface: best.r.name, err: p.ms - best.r.ms } : { ...p, surface: '' };
  });
}

// ---------------------------------------------------------------- room modes
/** Axial (one non-zero index) and tangential (two) modes below fMax. Oblique ones are excluded. */
export function simpleModes(dims, fMax = 200) {
  const { L, W, H } = dims, out = [];
  for (let a = 0; a < 20; a++) for (let b = 0; b < 20; b++) for (let c = 0; c < 20; c++) {
    const nz = (a ? 1 : 0) + (b ? 1 : 0) + (c ? 1 : 0);
    if (nz < 1 || nz > 2) continue;
    const f = C_AIR / 2 * Math.hypot(a / L, b / W, c / H);
    if (f < fMax) out.push({ n: [a, b, c], f, kind: nz === 1 ? '軸向' : '切向' });
  }
  return out.sort((p, q) => p.f - q.f);
}
/** Mode pressure shape cos(a pi x/L) cos(b pi y/W) cos(c pi z/H) at point p. */
export const modePressure = (n, p, dims) => Math.cos(n[0] * Math.PI * p[0] / dims.L) * Math.cos(n[1] * Math.PI * p[1] / dims.W) * Math.cos(n[2] * Math.PI * p[2] / dims.H);

/** Modal pressure response (dB) at receiver r from sources, all modes (incl. oblique) below 300 Hz, damped resonators. */
export function modalResponse(srcs, r, dims, freqs, rt60 = 0.4) {
  const modes = [];
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let c = 0; c < 12; c++) {
    if (!a && !b && !c) continue;
    const fn = C_AIR / 2 * Math.hypot(a / dims.L, b / dims.W, c / dims.H);
    if (fn < 300) modes.push({ n: [a, b, c], wn: 2 * Math.PI * fn, g: (a ? 2 : 1) * (b ? 2 : 1) * (c ? 2 : 1) });
  }
  const d = 6.91 / rt60;
  const amp = modes.map(m => m.g * modePressure(m.n, r, dims) * srcs.reduce((s, p) => s + modePressure(m.n, p, dims), 0));
  return freqs.map(f => {
    const w = 2 * Math.PI * f; let hr = 0, hi = 0;
    modes.forEach((m, i) => { const dr = m.wn * m.wn - w * w, di = 2 * d * w, dd = dr * dr + di * di; hr += amp[i] * dr / dd; hi -= amp[i] * di / dd; });
    return 10 * Math.log10((hr * hr + hi * hi) * w * w * w * w + 1e-30);
  });
}

/** Seat search along the room length: x +-0.6 m in 5 cm steps, minimising the variance of the 30-120 Hz response (dB). */
export function seatSearch(seat, srcs, dims, rt60, { span = 0.6, step = 0.05, margin = 0.25 } = {}) {
  const fr = Array.from({ length: 48 }, (_, i) => 30 * Math.pow(4, i / 47));
  const rows = [];
  for (let o = -span; o <= span + 1e-9; o += step) {
    const x = seat[0] + o;
    if (x < margin || x > dims.L - margin) continue;
    const db = modalResponse(srcs, [x, seat[1], seat[2]], dims, fr, rt60);
    const m = db.reduce((a, b) => a + b, 0) / db.length;
    rows.push({ off: Math.round(o * 100) / 100, x, v: db.reduce((a, b) => a + (b - m) ** 2, 0) / db.length });
  }
  const here = rows.reduce((a, r) => (Math.abs(r.off) < Math.abs(a.off) ? r : a), rows[0]);
  const best = rows.reduce((a, r) => (r.v < a.v ? r : a), rows[0]);
  return { rows, here, best };
}

// ---------------------------------------------------------------- seat heatmap
/**
 * Predicted low-frequency unevenness (variance of the 30-120 Hz modal response in dB, the same figure seatSearch minimises)
 * at every point of a grid in the plane z = `z`. Same model as modalResponse(): the mode shapes are separable, so the
 * per-axis cosines and the per-mode resonator terms are tabulated once and each point only costs modes x frequencies.
 * Returns {x0, y0, step, nx, ny, v (Float64Array, row = x index), min, max, best:{x,y,v,i}}; v[ix * ny + iy] at x = x0 + ix * step.
 */
export function seatHeatmap(srcs, dims, rt60 = 0.4, { z = 1.1, step = 0.05, margin = 0.25, nF = 48, fLo = 30, fHi = 120 } = {}) {
  const { L, W, H } = dims, d = 6.91 / rt60;
  const fr = Array.from({ length: nF }, (_, i) => fLo * Math.pow(fHi / fLo, i / (nF - 1)));
  const modes = [];
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (let c = 0; c < 12; c++) {
    if (!a && !b && !c) continue;
    const fn = C_AIR / 2 * Math.hypot(a / L, b / W, c / H);
    if (fn < 300) modes.push({ a, b, c, wn: 2 * Math.PI * fn, g: (a ? 2 : 1) * (b ? 2 : 1) * (c ? 2 : 1) });
  }
  const M = modes.length, w = fr.map(f => 2 * Math.PI * f);
  const Dr = new Float64Array(M * nF), Di = new Float64Array(M * nF);
  modes.forEach((m, i) => w.forEach((ww, k) => {
    const dr = m.wn * m.wn - ww * ww, di = 2 * d * ww, dd = dr * dr + di * di;
    Dr[i * nF + k] = dr / dd; Di[i * nF + k] = -di / dd;
  }));
  const w4 = w.map(ww => ww * ww * ww * ww);
  const nx = Math.max(0, Math.floor((L - 2 * margin) / step + 1e-9) + 1), ny = Math.max(0, Math.floor((W - 2 * margin) / step + 1e-9) + 1);
  const cosTab = (n, len, count) => Array.from({ length: n }, (_, k) => Float64Array.from({ length: count }, (_, i) => Math.cos(k * Math.PI * (margin + i * step) / len)));
  const cx = cosTab(16, L, nx), cy = cosTab(16, W, ny);
  const sumSrc = modes.map(m => srcs.reduce((s, p) => s + Math.cos(m.a * Math.PI * p[0] / L) * Math.cos(m.b * Math.PI * p[1] / W) * Math.cos(m.c * Math.PI * p[2] / H), 0));
  const kz = modes.map((m, i) => m.g * sumSrc[i] * Math.cos(m.c * Math.PI * z / H));
  const v = new Float64Array(nx * ny), A = new Float64Array(M), db = new Float64Array(nF), hr = new Float64Array(nF), hi = new Float64Array(nF);
  let min = Infinity, max = -Infinity, bi = 0;
  for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
    for (let i = 0; i < M; i++) A[i] = kz[i] * cx[modes[i].a][ix] * cy[modes[i].b][iy];
    hr.fill(0); hi.fill(0);
    for (let i = 0; i < M; i++) {
      const a = A[i]; if (a === 0) continue;
      const o = i * nF;
      for (let k = 0; k < nF; k++) { hr[k] += a * Dr[o + k]; hi[k] += a * Di[o + k]; }
    }
    let mean = 0;
    for (let k = 0; k < nF; k++) { db[k] = 10 * Math.log10((hr[k] * hr[k] + hi[k] * hi[k]) * w4[k] + 1e-30); mean += db[k]; }
    mean /= nF; let s = 0;
    for (let k = 0; k < nF; k++) s += (db[k] - mean) ** 2;
    const idx = ix * ny + iy; v[idx] = s / nF;
    if (v[idx] < min) { min = v[idx]; bi = idx; }
    if (v[idx] > max) max = v[idx];
  }
  return { x0: margin, y0: margin, step, nx, ny, v, min, max, best: { i: bi, x: margin + Math.floor(bi / ny) * step, y: margin + (bi % ny) * step, v: min } };
}
/** Bilinear lookup of a heatmap at room position (x, y); null outside the grid. */
export function heatAt(map, x, y) {
  const fx = (x - map.x0) / map.step, fy = (y - map.y0) / map.step;
  if (!(fx >= -1e-9 && fy >= -1e-9 && fx <= map.nx - 1 + 1e-9 && fy <= map.ny - 1 + 1e-9)) return null;
  const ix = Math.min(map.nx - 2 < 0 ? 0 : map.nx - 2, Math.floor(fx + 1e-9)), iy = Math.min(map.ny - 2 < 0 ? 0 : map.ny - 2, Math.floor(fy + 1e-9));
  const tx = fx - ix, ty = fy - iy, at = (i, j) => map.v[Math.min(map.nx - 1, i) * map.ny + Math.min(map.ny - 1, j)];
  return at(ix, iy) * (1 - tx) * (1 - ty) + at(ix + 1, iy) * tx * (1 - ty) + at(ix, iy + 1) * (1 - tx) * ty + at(ix + 1, iy + 1) * tx * ty;
}
/** Mask (Uint8Array like map.v) of the best area: cells whose RMS unevenness is within `tolDb` of the minimum. */
export function bestArea(map, tolDb = 0.5) {
  const lim = Math.sqrt(map.min) + tolDb, m = new Uint8Array(map.v.length);
  for (let i = 0; i < m.length; i++) m[i] = Math.sqrt(map.v[i]) <= lim ? 1 : 0;
  return m;
}

// ---------------------------------------------------------------- target curve
/** Piecewise-linear in log f, ends held. nodes = [[f,dB],...] sorted by f. */
export function nodesAt(nodes, f) {
  if (f <= nodes[0][0]) return nodes[0][1];
  const n = nodes.length;
  if (f >= nodes[n - 1][0]) return nodes[n - 1][1];
  let i = 0; while (nodes[i + 1][0] < f) i++;
  const t = Math.log(f / nodes[i][0]) / Math.log(nodes[i + 1][0] / nodes[i][0]);
  return nodes[i][1] + (nodes[i + 1][1] - nodes[i][1]) * t;
}
/** The shelf measure.js has always used: +lfRise dB at 20 Hz sliding to 0 at 200 Hz (log-linear). */
export const defaultTarget = (lfRise = 2) => [[20, lfRise], [200, 0], [20000, 0]];
export const TARGET_PRESETS = {
  flat: { name: '平直', nodes: [[20, 0], [20000, 0]] },
  room: { name: '房間曲線', nodes: [[20, 4], [60, 3.7], [120, 2], [240, 0.3], [480, 0], [1000, 0], [2000, -1], [4000, -2], [8000, -3], [16000, -4], [20000, -4.3]] },
  warm: { name: '暖', nodes: [[20, 3], [100, 2.5], [300, 1], [1000, 0], [4000, -1], [10000, -2.5], [20000, -3]] },
  bright: { name: '亮', nodes: [[20, 0], [200, 0], [2000, 0.5], [5000, 2], [10000, 3], [20000, 3]] },
};
/** Validate and sort user nodes; returns null if unusable. */
export function cleanNodes(nodes) {
  if (!Array.isArray(nodes)) return null;
  const v = nodes.filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && p[0] > 0).map(p => [Math.min(20000, Math.max(20, +p[0])), Math.min(12, Math.max(-12, +p[1]))]).sort((a, b) => a[0] - b[0]);
  return v.length >= 2 ? v : null;
}

// ---------------------------------------------------------------- microphone calibration
/** UMIK-style text: "f dB" per line, lines starting with " or * are header/comments. */
export function parseCalText(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l[0] === '"' || l[0] === '*' || l[0] === '#') continue;
    const p = l.split(/[\s,;]+/).map(Number);
    if (p.length >= 2 && p[0] > 0 && isFinite(p[0]) && isFinite(p[1])) out.push([p[0], p[1]]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.length >= 3 ? out : null;
}
/** Subtract a calibration (array of [f,dB]) from a curve {f,db}; returns a new curve. */
export function applyMicCal(curve, cal) {
  if (!cal || cal.length < 2) return curve;
  return { f: curve.f, db: curve.db.map((v, i) => v - nodesAt(cal, curve.f[i])) };
}
