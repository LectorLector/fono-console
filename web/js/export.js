// Filter export: store-only zip writer (CRC-32), per-channel combined correction impulse responses, and the file set of the
// "export filters" buttons in the FIR and ART tabs. Pure functions (no DOM); tested in tests/export.test.mjs.
import { fft, nextPow2 } from './fft.js';
import { biquadCoeffs, encodeWavFloat } from './dsp.js';
import { designFIR } from './fir.js';
import { firFor, mainsFIR } from './art.js';
import { mainSpk, activeSpk, subOf } from './eapo.js';
import { matchFiltersFor, stereoOf, stereoEnabled } from './stereo.js';
import { readmeText } from './export-readme.mjs';

export const EXPORT_RATES = [44100, 48000, 96000];

// ---------------------------------------------------------------- zip (store only)
let CRC_T = null;
export function crc32(u8) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const toU8 = d => (typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d));

/** files: [{name, data: Uint8Array | ArrayBuffer | string}] -> one .zip (method 0 = stored, UTF-8 names). */
export function zipStore(files, date = new Date()) {
  const enc = new TextEncoder(), parts = [], central = [];
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = toU8(f.data), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- combined impulse response
function convolve(a, b) {
  const N = nextPow2(a.length + b.length - 1), ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(a); br.set(b); fft(ar, ai); fft(br, bi);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] - ai[k] * bi[k], i = ar[k] * bi[k] + ai[k] * br[k]; ar[k] = r; ai[k] = i; }
  fft(ar, ai, true);
  return ar.subarray(0, a.length + b.length - 1);
}
/** Seconds for the slowest filter to decay by ~80 dB (envelope exp(-pi fc t / Q)). */
export function filterDecaySec(filters, sr) {
  let t = 0;
  for (const f of filters) { if (!(f.fc > 0) || f.fc >= sr / 2 || !biquadCoeffs(f, sr)) continue; t = Math.max(t, 2.93 * Math.max(0.5, f.q > 0 ? f.q : 0.7071) / f.fc); }
  return t;
}
/**
 * One channel's whole correction as an impulse response: gain, polarity, delay, the parametric filters (EQ APO biquads at this
 * sample rate), then an optional FIR. The tail is long enough for the lowest filter to decay (<= 6 s). The result is scaled down
 * (never up) so that its magnitude peak is <= 0 dBFS; normDb (<= 0) is that scale (norm: a number = use that scale instead). Returns {h: Float32Array, normDb, peakDb, lengthSec}.
 */
export function combinedIR({ sr, gainDb = 0, invert = false, delayMs = 0, filters = [], fir = null, norm = 'auto' }) {
  const dl = Math.max(0, Math.round((delayMs * sr) / 1000));
  const nb = Math.max(1024, Math.ceil(sr * Math.min(6, Math.max(0.25, filterDecaySec(filters, sr) * 1.1))));
  let y = new Float64Array(nb); y[0] = (invert ? -1 : 1) * Math.pow(10, gainDb / 20);
  for (const f of filters) {
    if (!(f.fc > 0) || f.fc >= sr / 2) continue;
    const c = biquadCoeffs(f, sr); if (!c) continue;
    const [b0, b1, b2, a1, a2] = c; let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < nb; n++) { const x = y[n], o = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = o; y[n] = o; }
  }
  if (fir && fir.length) y = convolve(y, fir);
  const len = dl + y.length, h = new Float64Array(len); h.set(y, dl);
  const N = nextPow2(len * 2), re = new Float64Array(N), im = new Float64Array(N); re.set(h); fft(re, im);
  let pk = 0; for (let k = 0; k <= N / 2; k++) pk = Math.max(pk, Math.hypot(re[k], im[k]));
  const peakDb = 20 * Math.log10(pk + 1e-30), normDb = typeof norm === 'number' ? norm : peakDb > 0 ? -peakDb : 0, g = Math.pow(10, normDb / 20);
  const out = new Float32Array(len); for (let i = 0; i < len; i++) out[i] = h[i] * g;
  return { h: out, normDb, peakDb, lengthSec: len / sr };
}
/** Magnitude (dB) of an impulse response at hz (direct DFT). */
export function irDbAt(h, sr, hz) {
  let re = 0, im = 0; const w = 2 * Math.PI * hz / sr;
  for (let n = 0; n < h.length; n++) { re += h[n] * Math.cos(w * n); im -= h[n] * Math.sin(w * n); }
  return 20 * Math.log10(Math.hypot(re, im) + 1e-30);
}

// ---------------------------------------------------------------- file sets
const wav = (h, sr) => new Uint8Array(encodeWavFloat([h], sr));
/** Per-speaker strip + correction parameters as the EQ APO config applies them (sub: plus the global sub gain / delay / polarity). */
export function stageOf(s, key, { artHandover = 0 } = {}) {
  const r = s.room, isSub = key.startsWith('SW'), sub = subOf(s), c = r.ch[key];
  let filters = r.correction && c.corr?.filters ? c.corr.filters : [];
  if (artHandover) filters = filters.filter(f => f.fc > artHandover * 1.5 && !/^LS/.test(f.type));
  // stereo symmetry L/R magnitude match: after the per-channel correction, like the EQ APO config
  if (r.correction) { const mf = matchFiltersFor(s, key).filter(f => !artHandover || f.fc > artHandover * 1.5); filters = [...filters, ...mf]; }
  return { gainDb: c.gain + (isSub ? sub.gain : 0), delayMs: c.delay + (isSub ? sub.delay : 0), invert: isSub ? c.invert !== !!sub.invert : !!c.invert, filters, mute: !!c.mute };
}
const firDelayMs = (n, sr) => ((n / 2) / sr) * 1000;

/** Render several channels with ONE common scale (so the level balance between channels is kept): peak of the loudest <= 0 dB. */
export function renderSet(specs) {
  const raw = specs.map(sp => combinedIR({ ...sp, norm: 0 }));
  const mx = Math.max(...raw.map(c => c.peakDb)), nd = mx > 0 ? -mx : 0, g = Math.pow(10, nd / 20);
  return raw.map(c => { for (let i = 0; i < c.h.length; i++) c.h[i] *= g; return { ...c, normDb: nd }; });
}

/**
 * Build the export for the FIR tab (kind 'fir') or the ART tab (kind 'art').
 *  fir: exByCh = {FL: excessPhase, ...}   art: sol = solveART result (+ S.room.art)
 * sym (fir kind): function (sr) -> {FL, FR, latencyMs} (stereo.js designPhasePair taps); used when the L/R phase match is on (S.room.stereo.phaseOn):
 *  sym_FL/FR_<rate>.wav files, convolved into the combined IRs, every other channel carries the same latency as a delay.
 * Returns {files: [{name, data}], zipName, zip(), info: {rates, latencyMs, headroomDb, channels:[{key, role, name, normDb, peakDb, file, lengthSec}], ...}}.
 */
export function buildExport(S, { kind, exByCh = {}, sol = null, rates = EXPORT_RATES, date = new Date(), sym = null }) {
  const r = S.room, fr = r.fir, a = r.art, files = [], chans = [], info = { kind, rates, channels: chans, latencyMs: 0, headroomDb: 0 };
  const name = k => r.map[k] || k;
  if (kind === 'fir') {
    const keys = fr.chans.filter(k => mainSpk(S).includes(k) && exByCh[k]);
    if (!keys.length) throw new Error('no-fir-source');
    const symOn = typeof sym === 'function' && stereoEnabled(S) && stereoOf(S).phaseOn && r.correction;
    for (const sr of rates) {
      const firs = {}, specs = [], sy = symOn ? sym(sr) : null, symMs = sy ? sy.latencyMs : 0;
      if (sy) { for (const k of ['FL', 'FR']) files.push({ name: `sym_${k}_${sr}.wav`, data: wav(sy[k], sr) }); info.sym = { latencyMs: symMs }; }
      for (const k of keys) { const d = designFIR(exByCh[k], sr, { lo: fr.lo, hi: fr.hi }); firs[k] = d.h; info.latencyMs = d.latencyMs; files.push({ name: `fir_${k}_${sr}.wav`, data: wav(d.h, sr) }); }
      for (const k of activeSpk(S)) {
        const st = stageOf(S, k); if (st.mute) continue;
        const own = firs[k], so = sy && (k === 'FL' || k === 'FR') ? sy[k] : null;
        const fir = own && so ? Float32Array.from(convolve(own, so)) : own || so || null;
        specs.push({ k, sr, gainDb: st.gainDb, invert: st.invert, delayMs: st.delayMs + (own ? 0 : firDelayMs(firs[keys[0]].length, sr)) + (sy && !so ? symMs : 0), filters: st.filters, fir });
      }
      renderSet(specs).forEach((c, i) => {
        const sp = specs[i]; files.push({ name: `combined_${sp.k}_${sr}.wav`, data: wav(c.h, sr) });
        if (sr === 48000) chans.push({ key: sp.k, role: 'full', name: name(sp.k), normDb: c.normDb, peakDb: c.peakDb, file: `combined_${sp.k}_<rate>.wav`, lengthSec: c.lengthSec, fir: !!sp.fir });
      });
    }
  } else {
    if (!sol) throw new Error('no-art-solution');
    const keys = sol.solvedKeys, fc = a.fc, tau = a.tauMs / 1000, pre = sol.preampDb ?? a.preampDb ?? 0;
    for (const sr of rates) {
      const hp = mainsFIR(fc, tau, sr), specs = [];
      files.push({ name: `art_hp_${sr}.wav`, data: wav(hp, sr) });
      const bass = {};
      for (const k of keys) { bass[k] = firFor(sol, sol.keys.indexOf(k), sr, 1.0); files.push({ name: `art_${k}_${sr}.wav`, data: wav(bass[k], sr) }); }
      for (const k of ['FL', 'FR']) {
        const st = stageOf(S, k, { artHandover: fc }); if (st.mute) continue;
        specs.push({ k, role: 'main', pre: 'combined_art_main_', sr, gainDb: pre + st.gainDb, invert: st.invert, delayMs: st.delayMs, filters: st.filters, fir: hp });
      }
      for (const k of keys) specs.push({ k, role: 'bass', pre: 'combined_art_bass_', sr, gainDb: pre, delayMs: fr.on && fr.built ? fr.latencyMs : 0, fir: bass[k] });
      renderSet(specs).forEach((c, i) => {
        const sp = specs[i]; files.push({ name: `${sp.pre}${sp.k}_${sr}.wav`, data: wav(c.h, sr) });
        if (sr === 48000) chans.push({ key: sp.k, role: sp.role, name: name(sp.k), normDb: c.normDb, peakDb: c.peakDb, file: `${sp.pre}${sp.k}_<rate>.wav`, lengthSec: c.lengthSec });
      });
    }
    info.latencyMs = tau * 1000; info.artKeys = keys; info.fc = fc; info.preampDb = pre;
  }
  if (info.sym) info.latencyMs += info.sym.latencyMs;
  info.headroomDb = Math.min(0, ...chans.map(c => c.normDb));
  files.unshift({ name: 'README.txt', data: readmeText(S, info) });
  return { files, zipName: `fono-${kind}-filters.zip`, info, zip: () => zipStore(files, date) };
}
