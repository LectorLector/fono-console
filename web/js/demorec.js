// Demo only: a simulated "play the stimulus and record the mic" for the one-click wizard (no audio hardware).
// The recording is the stimulus convolved with a small synthetic room (direct sound, three early reflections, a few bass modes)
// plus the timing chirp, plus colored noise whose level fluctuates from call to call, so sweep averaging and the ambient warning can be seen.
import { fft, nextPow2 } from './fft.js';

const DELAY_MS = { FL: 2.62, FR: 2.71, SL: 3.9, SR: 3.95, SW1: 3.1, SW2: 3.2 };
const g = () => Math.sqrt(-2 * Math.log(Math.random() + 1e-12)) * Math.cos(2 * Math.PI * Math.random());

/** Colored noise (strong low end, like a fan or an air conditioner) with RMS `rmsDb` dBFS and a slow level wobble. */
function coloredNoise(n, rmsDb) {
  const o = new Float32Array(n); let y = 0, e = 0;
  const wob = 0.6 + 0.8 * Math.random(), ph = Math.random() * 6.28;
  for (let i = 0; i < n; i++) { y = 0.985 * y + g(); o[i] = (0.35 * y + g()) * (1 + 0.35 * Math.sin(ph + (i / 48000) * wob * 2.1)); e += o[i] * o[i]; }
  const k = Math.pow(10, rmsDb / 20) / Math.sqrt(e / n);
  for (let i = 0; i < n; i++) o[i] *= k;
  return o;
}

function roomIR(sr, ch, gain) {
  const h = new Float32Array(Math.round(0.45 * sr)), d = Math.round(((DELAY_MS[ch] ?? 3) / 1000) * sr);
  h[d] = gain;
  for (const [ms, a] of [[1.1, -0.12], [3.4, 0.15], [6.2, -0.1]]) h[d + Math.round((ms / 1000) * sr)] += gain * a;
  const f0 = { FL: [38, 52, 71, 97, 128], FR: [38, 54, 69, 99, 126], SL: [41, 52, 77, 94, 130], SR: [41, 55, 79, 96, 128], SW1: [34, 52, 70, 92, 120], SW2: [34, 53, 72, 93, 122] }[ch] || [40, 60, 90];
  // a mode of decay 75 ms adds roughly +/-5 dB around its frequency
  f0.forEach((f, k) => { const a = gain * 0.0007 * (1 - 0.15 * k) * (k % 2 ? -1 : 1); for (let i = 0; i < h.length - d; i++) h[d + i] += a * Math.exp(-i / sr / 0.075) * Math.sin(2 * Math.PI * f * i / sr); });
  return h;
}

function conv(x, h) {
  const N = nextPow2(x.length + h.length), A = new Float64Array(N), Ai = new Float64Array(N), B = new Float64Array(N), Bi = new Float64Array(N);
  A.set(x); B.set(h); fft(A, Ai); fft(B, Bi);
  for (let k = 0; k < N; k++) { const r = A[k] * B[k] - Ai[k] * Bi[k], q = A[k] * Bi[k] + Ai[k] * B[k]; A[k] = r; Ai[k] = q; }
  fft(A, Ai, true);
  return A;
}

/** {rec, offset, peakDb} like the real playAndRecord(). opts: {ch, noiseDb (RMS dBFS of the room noise), tick(elapsedSec), abort()}. */
export async function demoRecord(stim, { ch = 'FL', noiseDb = -62, tick, abort } = {}) {
  const sr = stim.sr, sleep = ms => new Promise(r => setTimeout(r, ms));
  const offset = Math.round(0.55 * sr) + Math.floor(Math.random() * 400), recLen = offset + stim.total + Math.round(0.9 * sr);
  const secs = stim.total / sr, silent = !stim.L.some(v => v !== 0);
  const steps = silent ? 10 : 2;
  for (let i = 1; i <= steps; i++) { await sleep(silent ? 120 : 60); tick && tick((secs * i) / steps + 0.55); if (abort && abort()) break; }
  const rec = coloredNoise(recLen, noiseDb * 1 + (Math.random() - 0.5) * 3);
  if (!silent) {
    const y = conv(stim.L, roomIR(sr, ch, 0.7));
    for (let i = 0; i < stim.total && offset + i < recLen; i++) rec[offset + i] += y[i];
    // the timing chirp plays on the R channel and comes out of FL
    const rr = conv(stim.R, (() => { const h = new Float32Array(Math.round(0.02 * sr)); h[Math.round((DELAY_MS.FL / 1000) * sr)] = 0.7; return h; })());
    for (let i = 0; i < stim.total && offset + i < recLen; i++) rec[offset + i] += rr[i];
  }
  let pk = 0; for (let i = 0; i < recLen; i++) pk = Math.max(pk, Math.abs(rec[i]));
  return { rec, offset, peakDb: 20 * Math.log10(pk + 1e-9) };
}
