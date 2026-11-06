// Pure DSP helpers: biquad magnitude (RBJ cookbook, matches EQ APO filter
// types), REW filter text parsing, impulse-response generation, WAV encoding.

export const FS_PREVIEW = 48000;

function coeffs(f, sr) {
  const w0 = (2 * Math.PI * f.fc) / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const q = f.q > 0 ? f.q : 0.7071;
  const A = Math.pow(10, (f.gain || 0) / 40);
  const alpha = sin / (2 * q);
  let b0, b1, b2, a0, a1, a2;
  switch (f.type) {
    case 'PK':
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A; break;
    case 'LSC': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + s); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - s; break;
    }
    case 'HSC': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + s); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - s; break;
    }
    case 'LP':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    case 'HP':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha; break;
    default:
      return null;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

/** Magnitude (dB) of one biquad at frequency hz. */
export function biquadDb(f, hz, sr = FS_PREVIEW) {
  if (f.fc >= sr / 2) return 0;
  const c = coeffs(f, sr);
  if (!c) return 0;
  const [b0, b1, b2, a1, a2] = c;
  const w = (2 * Math.PI * hz) / sr;
  const cr1 = Math.cos(w), ci1 = -Math.sin(w), cr2 = Math.cos(2 * w), ci2 = -Math.sin(2 * w);
  const nr = b0 + b1 * cr1 + b2 * cr2, ni = b1 * ci1 + b2 * ci2;
  const dr = 1 + a1 * cr1 + a2 * cr2, di = a1 * ci1 + a2 * ci2;
  const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
  return 10 * Math.log10(Math.max(mag2, 1e-20));
}

export function chainDb(filters, hz, sr) {
  let s = 0;
  for (const f of filters) s += biquadDb(f, hz, sr);
  return s;
}

/** Log-spaced frequency grid. */
export function logGrid(lo = 20, hi = 20000, n = 240) {
  const out = new Float64Array(n);
  const r = Math.log(hi / lo);
  for (let i = 0; i < n; i++) out[i] = lo * Math.exp((r * i) / (n - 1));
  return out;
}

export function maxBoostDb(filters, grid = logGrid(20, 20000, 300)) {
  let m = -Infinity;
  for (const hz of grid) m = Math.max(m, chainDb(filters, hz));
  return m;
}

// ------------------------------------------------------------------ REW text

const TYPE_MAP = { PK: 'PK', PEQ: 'PK', MODAL: 'PK', LS: 'LSC', LSC: 'LSC', LSQ: 'LSC', HS: 'HSC', HSC: 'HSC', HSQ: 'HSC', LP: 'LP', LPQ: 'LP', HP: 'HP', HPQ: 'HP' };

function bwToQ(bw) { const p = Math.pow(2, bw); return Math.sqrt(p) / (p - 1); }

/** Parse REW "Generic"/Equalizer APO filter text into filter objects. */
export function parseFilterText(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^Filter\s*\d*\s*:\s*ON\s+([A-Za-z]+)(?:\s+[\d.]+\s*dB)?\s+Fc\s+([\d.]+)\s*Hz(.*)$/i.exec(line);
    if (!m) continue;
    const type = TYPE_MAP[m[1].toUpperCase()];
    if (!type) continue;
    const rest = m[3];
    const g = /Gain\s+([-+\d.]+)\s*dB/i.exec(rest);
    const q = /\bQ\s+([\d.]+)/i.exec(rest);
    const bw = /BW\s+Oct\s+([\d.]+)/i.exec(rest);
    const f = { type, fc: +m[2], gain: g ? +g[1] : 0, q: q ? +q[1] : bw ? bwToQ(+bw[1]) : 0.7071 };
    if (isFinite(f.fc) && f.fc > 0) out.push(f);
  }
  return out;
}

/** Normalise filters returned by the REW API (field names vary by version). */
export function normaliseRewFilters(data) {
  const arr = Array.isArray(data) ? data : data && typeof data === 'object' ? (Array.isArray(data.filters) ? data.filters : Object.values(data)) : [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    if (it.enabled === false || it.isEnabled === false) continue;
    const rawType = String(it.type ?? it.filterType ?? it.Type ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    let type = TYPE_MAP[rawType];
    if (!type && /PEAK/.test(rawType)) type = 'PK';
    if (!type && /LOWSHELF|LS/.test(rawType)) type = 'LSC';
    if (!type && /HIGHSHELF|HS/.test(rawType)) type = 'HSC';
    if (!type) continue;
    const fc = +(it.frequency ?? it.fc ?? it.freq ?? it.Fc ?? 0);
    const gain = +(it.gaindB ?? it.gain ?? it.gainDB ?? it.Gain ?? 0);
    const q = +(it.q ?? it.Q ?? it.qValue ?? 0.7071);
    if (fc > 0 && isFinite(gain)) out.push({ type, fc, gain, q: q > 0 ? q : 0.7071 });
  }
  return out;
}

export function filterLine(f) {
  const fc = f.fc >= 1000 ? f.fc.toFixed(0) : f.fc.toFixed(1);
  if (f.type === 'LP' || f.type === 'HP') return `Filter: ON ${f.type} Fc ${fc} Hz Q ${f.q.toFixed(3)}`;
  return `Filter: ON ${f.type} Fc ${fc} Hz Gain ${f.gain.toFixed(2)} dB Q ${f.q.toFixed(3)}`;
}

// ------------------------------------------------------------------ REW API data

/** Decode REW base64 big-endian float32 arrays. */
export function decodeBE32(b64) {
  const bin = atob(b64);
  const n = bin.length >> 2;
  const out = new Float32Array(n);
  const dv = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) dv.setUint8(k, bin.charCodeAt(i * 4 + k));
    out[i] = dv.getFloat32(0, false);
  }
  return out;
}

/** Turn a REW FrequencyResponse object into {f:[], db:[]} */
export function rewResponseToCurve(fr) {
  if (!fr || typeof fr !== 'object') return null;
  let magKey = Object.keys(fr).find(k => /mag/i.test(k) && typeof fr[k] === 'string');
  if (!magKey) magKey = Object.keys(fr).find(k => typeof fr[k] === 'string' && fr[k].length > 24 && /^[A-Za-z0-9+/=]+$/.test(fr[k]));
  if (!magKey) return null;
  const mag = decodeBE32(fr[magKey]);
  const start = +(fr.startFreq ?? fr.startFrequency ?? 0);
  const f = new Float64Array(mag.length);
  if (fr.ppo) {
    const k = Math.log(2) / fr.ppo;
    for (let i = 0; i < mag.length; i++) f[i] = start * Math.exp(i * k);
  } else {
    const step = +(fr.freqStep ?? fr.frequencyStep ?? 1);
    for (let i = 0; i < mag.length; i++) f[i] = start + i * step;
  }
  return { f: Array.from(f), db: Array.from(mag) };
}

/** Parse a REW "Export measurement as text" file: "freq spl phase" rows. */
export function parseRewTextCurve(text) {
  const f = [], db = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l[0] === '*' || l[0] === '#' || /[a-df-z]/i.test(l)) continue;
    const p = l.split(/[\s,;]+/).map(Number);
    if (p.length >= 2 && isFinite(p[0]) && isFinite(p[1]) && p[0] > 0) { f.push(p[0]); db.push(p[1]); }
  }
  return f.length > 4 ? { f, db } : null;
}

/** Fractional-octave smoothing on an arbitrary grid (power average). */
export function smooth(curve, frac) {
  if (!frac) return curve;
  const { f, db } = curve;
  const half = Math.pow(2, 1 / (2 * frac));
  const pw = db.map(v => Math.pow(10, v / 10));
  const out = new Array(f.length);
  let lo = 0, hi = 0, acc = 0;
  for (let i = 0; i < f.length; i++) {
    const a = f[i] / half, b = f[i] * half;
    while (hi < f.length && f[hi] <= b) { acc += pw[hi]; hi++; }
    while (lo < hi && f[lo] < a) { acc -= pw[lo]; lo++; }
    const n = hi - lo;
    out[i] = n > 0 ? 10 * Math.log10(Math.max(acc / n, 1e-20)) : db[i];
  }
  return { f, db: out };
}

export function interpCurve(curve, hz) {
  const { f, db } = curve;
  if (hz <= f[0]) return db[0];
  if (hz >= f[f.length - 1]) return db[db.length - 1];
  let lo = 0, hi = f.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (f[m] <= hz) lo = m; else hi = m; }
  const t = Math.log(hz / f[lo]) / Math.log(f[hi] / f[lo]);
  return db[lo] + (db[hi] - db[lo]) * t;
}

// ------------------------------------------------------------------ room modes

export function roomModes(L, W, H, fmax = 300, c = 343) {
  const out = [];
  const nx = Math.ceil((2 * L * fmax) / c), ny = Math.ceil((2 * W * fmax) / c), nz = Math.ceil((2 * H * fmax) / c);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) for (let k = 0; k <= nz; k++) {
    if (!i && !j && !k) continue;
    const fr = (c / 2) * Math.sqrt((i / L) ** 2 + (j / W) ** 2 + (k / H) ** 2);
    if (fr > fmax) continue;
    const nz0 = [i, j, k].filter(Boolean).length;
    out.push({ f: fr, n: [i, j, k], kind: nz0 === 1 ? 'axial' : nz0 === 2 ? 'tangential' : 'oblique' });
  }
  return out.sort((a, b) => a.f - b.f);
}

export const schroeder = (rt60, V) => 2000 * Math.sqrt(rt60 / V);

// ------------------------------------------------------------------ IR + WAV

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stereo reverb impulse response with the dry path baked in (EQ APO's
 * Convolution replaces the signal, so dry + wet must live in one IR).
 * p: {rt60 s, predelay ms, damping 0..1, wet 0..1, early bool}
 */
export function makeReverbIR(sr, p) {
  const rt = Math.max(0.2, Math.min(6, p.rt60));
  const pre = Math.max(0, p.predelay || 0) / 1000;
  const len = Math.ceil(sr * Math.min(6.5, pre + rt * 1.15 + 0.05));
  const L = new Float32Array(len), R = new Float32Array(len);
  const wet = Math.max(0, Math.min(1, p.wet));
  const dry = 1 - 0.45 * wet;
  L[0] = dry; R[0] = dry;
  if (wet <= 0) return [L, R];
  const rndL = mulberry32(1234567), rndR = mulberry32(7654321);
  const s0 = Math.floor(pre * sr);
  const decay = -6.907755 / (rt * sr);
  const damp = Math.max(0, Math.min(0.98, p.damping ?? 0.4));
  let yl = 0, yr = 0;
  const tail = len - s0;
  const tl = new Float32Array(tail), tr = new Float32Array(tail);
  let eL = 0, eR = 0;
  for (let n = 0; n < tail; n++) {
    const env = Math.exp(decay * n) * Math.min(1, n / (0.004 * sr));
    // Progressive one-pole low-pass: high frequencies die faster.
    const a = 1 - damp * Math.min(1, n / (rt * sr * 0.6)) * 0.95;
    yl += a * ((rndL() * 2 - 1) - yl);
    yr += a * ((rndR() * 2 - 1) - yr);
    tl[n] = yl * env; tr[n] = yr * env;
    eL += tl[n] * tl[n]; eR += tr[n] * tr[n];
  }
  const gl = wet * 0.55 / Math.sqrt(eL || 1), gr = wet * 0.55 / Math.sqrt(eR || 1);
  for (let n = 0; n < tail; n++) { L[s0 + n] += tl[n] * gl; R[s0 + n] += tr[n] * gr; }
  if (p.early) {
    const taps = [[7, 0.42, 0], [11, 0.36, 1], [17, 0.3, 0], [23, 0.27, 1], [29, 0.22, 0], [37, 0.18, 1], [43, 0.15, 0], [53, 0.12, 1]];
    for (const [ms, g, side] of taps) {
      const i = Math.floor((pre * 0.5 + ms / 1000) * sr);
      if (i < len) { (side ? R : L)[i] += g * wet * 0.6; (side ? L : R)[Math.min(len - 1, i + Math.floor(0.0007 * sr))] += g * wet * 0.35; }
    }
  }
  return [L, R];
}

/** Mix a user-supplied (already resampled) IR with the dry path. */
export function mixCustomIR(chs, wet) {
  const L0 = chs[0], R0 = chs[1] || chs[0];
  const len = L0.length;
  const L = new Float32Array(len), R = new Float32Array(len);
  let e = 0;
  for (let i = 0; i < len; i++) e += L0[i] * L0[i] + R0[i] * R0[i];
  const g = (wet * 0.55) / Math.sqrt(e / 2 || 1);
  for (let i = 0; i < len; i++) { L[i] = L0[i] * g; R[i] = R0[i] * g; }
  L[0] += 1 - 0.45 * wet; R[0] += 1 - 0.45 * wet;
  return [L, R];
}

/** 32-bit float stereo WAV (WAVE_FORMAT_IEEE_FLOAT). */
export function encodeWavFloat(chs, sr) {
  const nch = chs.length, len = chs[0].length;
  const dataBytes = len * nch * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 4, true); v.setUint16(32, nch * 4, true); v.setUint16(34, 32, true);
  w(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) { v.setFloat32(o, chs[c][i], true); o += 4; }
  return buf;
}
