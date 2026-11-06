// Browser-side audio: pink noise, microphone analyser, reverb IR building.
import { makeReverbIR, mixCustomIR, encodeWavFloat } from './dsp.js';

let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// ------------------------------------------------------------------ pink noise
let noise = null;
function pinkBuffer(c, seconds = 6) {
  const n = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, n, c.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  // crossfade loop ends
  const f = Math.floor(c.sampleRate * 0.05);
  for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[n - f + i] * (1 - t); }
  return buf;
}

/** Start pink noise. side: 'L' (left only, for EQ APO routing) or 'LR'. level dBFS. */
export function noiseStart(side = 'L', levelDb = -20) {
  noiseStop();
  const c = audioCtx();
  const buf = pinkBuffer(c);
  if (side === 'LR') buf.copyToChannel(buf.getChannelData(0), 1);
  const src = c.createBufferSource();
  src.buffer = buf; src.loop = true; src.loopEnd = buf.duration - 0.05;
  const g = c.createGain();
  g.gain.value = 0; g.gain.linearRampToValueAtTime(Math.pow(10, levelDb / 20), c.currentTime + 0.3);
  src.connect(g).connect(c.destination);
  src.start();
  noise = { src, g };
}
export function noiseStop() {
  if (!noise) return;
  const c = audioCtx(), n = noise;
  n.g.gain.cancelScheduledValues(c.currentTime);
  n.g.gain.setValueAtTime(n.g.gain.value, c.currentTime);
  n.g.gain.linearRampToValueAtTime(0, c.currentTime + 0.15);
  setTimeout(() => { try { n.src.stop(); } catch {} }, 200);
  noise = null;
}
export const noiseOn = () => !!noise;

// ------------------------------------------------------------------ microphone analyser
let mic = null;
export async function listInputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
  } catch { return []; }
}
export async function micStart(deviceId) {
  micStop();
  const c = audioCtx();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
    },
  });
  const src = c.createMediaStreamSource(stream);
  const an = c.createAnalyser();
  an.fftSize = 32768; an.smoothingTimeConstant = 0.55;
  an.minDecibels = -140; an.maxDecibels = 0;
  src.connect(an);
  mic = { stream, src, an, bins: new Float32Array(an.frequencyBinCount), sr: c.sampleRate };
  return mic;
}
export function micStop() {
  if (!mic) return;
  mic.stream.getTracks().forEach(t => t.stop());
  try { mic.src.disconnect(); } catch {}
  mic = null;
}
export function micFrame() {
  if (!mic) return null;
  mic.an.getFloatFrequencyData(mic.bins);
  // Analyser dB is per-bin relative to full scale with a window gain; convert
  // to a sine-referenced dBFS (Blackman window coherent gain ~0.42).
  return { bins: mic.bins, sr: mic.sr, n: mic.an.fftSize };
}

/** Hum analysis around mains harmonics (Taiwan: 60 Hz). */
export function humReport(frame, mains = 60) {
  const { bins, sr, n } = frame;
  const hz = i => (i * sr) / n;
  const idx = f => Math.round((f * n) / sr);
  const peakNear = f => { let m = -200; for (let i = idx(f - 2); i <= idx(f + 2); i++) m = Math.max(m, bins[i]); return m; };
  const harm = [1, 2, 3, 4, 5].map(k => ({ f: mains * k, db: peakNear(mains * k) }));
  const floorVals = [];
  for (let i = idx(30); i < idx(400); i++) {
    const f = hz(i);
    if (harm.some(h => Math.abs(f - h.f) < 6)) continue;
    floorVals.push(bins[i]);
  }
  floorVals.sort((a, b) => a - b);
  const floor = floorVals.length ? floorVals[Math.floor(floorVals.length / 2)] : -140;
  const worst = harm.reduce((a, b) => (b.db > a.db ? b : a));
  let pw = 0;
  for (let i = idx(20); i < Math.min(bins.length, idx(20000)); i++) pw += Math.pow(10, bins[i] / 10);
  return { harm, floor, worst, above: worst.db - floor, broadband: 10 * Math.log10(pw || 1e-20) };
}

// ------------------------------------------------------------------ IR files
async function decodeAt(arrayBuf, sr) {
  const off = new OfflineAudioContext(2, 1, sr);
  const ab = await off.decodeAudioData(arrayBuf.slice(0));
  const chs = [ab.getChannelData(0), ab.numberOfChannels > 1 ? ab.getChannelData(1) : ab.getChannelData(0)];
  return chs.map(c => c.slice(0, Math.min(c.length, sr * 6)));
}

/** Build WAV ArrayBuffers for each sample rate. custom: ArrayBuffer of a user IR (optional). */
export async function buildIRs(rev, rates, custom) {
  const out = {};
  for (const sr of rates) {
    let chs;
    if (rev.src === 'custom' && custom) chs = mixCustomIR(await decodeAt(custom, sr), rev.wet);
    else chs = makeReverbIR(sr, { rt60: rev.rt60, predelay: rev.predelay, damping: rev.damping, wet: rev.wet, early: rev.early });
    out[sr] = encodeWavFloat(chs, sr);
  }
  return out;
}
