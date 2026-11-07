// Real-hardware capture helpers. The pure parts (channel pick, drift estimate / correction, track checks, level cap) are unit-tested
// (tests/capture.test.mjs); the browser parts (openMic, run lock, wake lock) wrap getUserMedia / navigator.wakeLock with fallbacks.
import { fft, nextPow2 } from './fft.js';

// ---------------------------------------------------------------- level safety
/** The loudest any sweep / pink noise may be played (dBFS): keeps subwoofers and helpers away from full scale. */
export const MAX_OUT_DB = -3;
export const capLevel = (db, max = MAX_OUT_DB) => (Number.isFinite(db) ? Math.min(max, db) : -20);

// ---------------------------------------------------------------- channels
export const CH_MODES = ['mix', 'L', 'R'];
export const CH_LABEL = { mix: '混合', L: '左', R: '右' };
/** The stored input channel of a device (default: both summed, as before). */
export const chanOf = (S, id) => (CH_MODES.includes(S?.mic?.channel?.[id]) ? S.mic.channel[id] : 'mix');
/** Key of a microphone in S.mic.cal: the device id, plus "#L" / "#R" when the microphone is one channel of a stereo input (merge cable). */
export const micKey = (id, ch) => (ch === 'L' || ch === 'R' ? `${id}#${ch}` : id);
export const splitKey = key => { const m = /^(.*)#([LR])$/.exec(key || ''); return m ? { id: m[1], ch: m[2] } : { id: key || '', ch: 'mix' }; };

/** One mono signal from a stereo capture: 'L', 'R', or 'mix' = (L + R) / 2. A mono device (r missing) always gives l. Always a new array. */
export function pickChannel(l, r, mode = 'mix') {
  if (!r || !r.length) return Float32Array.from(l);
  if (mode === 'L') return Float32Array.from(l);
  if (mode === 'R') return Float32Array.from(r);
  const n = Math.min(l.length, r.length), o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = 0.5 * (l[i] + r[i]);
  return o;
}

/** Is the second channel a real second microphone? rmsDb per channel, correlation, and flags (silent: < -90 dBFS; same: identical signal = mono device). */
export function channelHealth(l, r) {
  const n = Math.min(l.length, r ? r.length : 0);
  if (!n) return { rmsL: -200, rmsR: -200, corr: 1, silentL: false, silentR: true, same: true };
  let el = 0, er = 0, ec = 0;
  for (let i = 0; i < n; i++) { el += l[i] * l[i]; er += r[i] * r[i]; ec += l[i] * r[i]; }
  const db = e => 10 * Math.log10(e / n + 1e-20), corr = ec / (Math.sqrt(el * er) + 1e-30);
  return { rmsL: db(el), rmsR: db(er), corr, silentL: db(el) < -90, silentR: db(er) < -90, same: corr > 0.9999 && Math.abs(db(el) - db(er)) < 0.01 };
}

// ---------------------------------------------------------------- track settings
/**
 * Plain-language warnings about what the browser actually delivered (track.getSettings()). want = {sampleRate, channels}.
 * Returns [{id, text}] (zh-TW; i18n resolves the English). Empty = fine.
 */
export function assessTrack(st = {}, want = {}) {
  const w = [];
  for (const [k, name] of [['echoCancellation', '回音消除'], ['noiseSuppression', '雜訊抑制'], ['autoGainControl', '自動增益']]) {
    if (st[k] === true) w.push({ id: k, text: `麥克風的「${name}」沒有關掉：量測會失真（掃頻被當成雜訊壓掉或音量被自動調整）。請在 Windows「設定 > 系統 > 音效 > 麥克風 > 內容」關閉「音訊增強」，並在控制台「聲音 > 通訊」選「不執行任何動作」。` });
  }
  if (st.sampleRate && want.sampleRate && st.sampleRate !== want.sampleRate) w.push({ id: 'sampleRate', text: `麥克風實際取樣率是 ${st.sampleRate} Hz（要求 ${want.sampleRate} Hz），瀏覽器會自動轉換；一般不影響結果，但請確認 Windows 錄製裝置的格式。` });
  if (st.channelCount === 1 && want.channels === 2) w.push({ id: 'channelCount', text: '這個輸入只有一個聲道：「左／右」選項沒有作用（兩邊是同一個訊號）。若用的是雙麥克風合併線，請確認它接在立體聲（TRS）麥克風孔或 USB 音效卡的立體聲輸入。' });
  return w;
}

/** Standing advice about Windows' own processing, shown once in the wizard / mic pages. */
export const WIN_MIC_NOTE = 'Windows 可能會偷偷處理麥克風：「麥克風增強」（音訊增強）會壓縮或改變頻率響應，「通訊」設定會在偵測到通話時自動壓低其他聲音。量測前請到控制台「聲音 > 錄製 > 麥克風 > 內容」：進階頁取消「啟用音訊增強」、關閉「允許應用程式獨佔控制」；「通訊」頁選「不執行任何動作」。';

const nameOf = e => (e && e.name) || '';
const friendlyMicError = e => {
  const n = nameOf(e);
  if (n === 'NotAllowedError' || n === 'SecurityError') return new Error('瀏覽器沒有麥克風權限。請按網址列旁的鎖頭／麥克風圖示允許，或到 Windows「設定 > 隱私權 > 麥克風」開啟。');
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return new Error('找不到這個麥克風輸入（USB 重新插拔後裝置代號會改變）。請按「重新整理裝置」再選一次。');
  if (n === 'NotReadableError' || n === 'AbortError') return new Error('麥克風被其他程式佔用或無法開啟。請關閉其他正在錄音的程式（含獨佔模式）後再試。');
  return e instanceof Error ? e : new Error(String(e));
};

/**
 * Open a microphone for measuring: processing off, 2 channels and the wanted sample rate if the device allows it, falling back step by
 * step (an OverconstrainedError for sampleRate / channelCount must not kill the measurement). A stale deviceId (replugged USB) is
 * looked up again by its label. Returns {stream, settings, warnings, deviceId}.
 */
export async function openMic(deviceId, { sampleRate = 48000, channels = 2, label = '' } = {}) {
  const md = navigator.mediaDevices;
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  const mk = (id, extra) => ({ audio: { ...base, ...(id ? { deviceId: { exact: id } } : {}), ...extra } });
  let id = deviceId, stream = null, lastErr = null;
  const tries = () => [mk(id, { channelCount: { ideal: channels }, sampleRate: { ideal: sampleRate } }), mk(id, { channelCount: { ideal: channels } }), mk(id, {})];
  for (let pass = 0; pass < 2 && !stream; pass++) {
    for (const c of tries()) {
      try { stream = await md.getUserMedia(c); break; } catch (e) { lastErr = e; if (['NotAllowedError', 'SecurityError', 'NotReadableError'].includes(nameOf(e))) throw friendlyMicError(e); }
    }
    if (!stream && pass === 0 && id) {   // device id changed after a reconnect: find the same label
      try {
        const all = (await md.enumerateDevices()).filter(d => d.kind === 'audioinput'), hit = label && all.find(d => d.label === label);
        if (hit) id = hit.deviceId; else break;
      } catch { break; }
    }
  }
  if (!stream) throw friendlyMicError(lastErr);
  const tr = stream.getAudioTracks()[0], settings = (tr && tr.getSettings && tr.getSettings()) || {};
  return { stream, settings, warnings: assessTrack(settings, { sampleRate, channels }), deviceId: settings.deviceId || id };
}

// ---------------------------------------------------------------- clock drift (output and microphone on different devices)
const median = a => { const v = Array.from(a).sort((p, q) => p - q); return v[v.length >> 1] || 0; };

/** Position (fractional samples, in rec) of the best match of `tpl` inside rec[from, to), by FFT cross-correlation; q = peak / median of |corr|. */
function findChirp(rec, tpl, from, to) {
  from = Math.max(0, Math.round(from)); to = Math.min(rec.length, Math.round(to));
  const n = to - from; if (n <= tpl.length + 8) return null;
  const N = nextPow2(n + tpl.length), ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < n; i++) ar[i] = rec[from + i];
  br.set(tpl); fft(ar, ai); fft(br, bi);
  for (let k = 0; k < N; k++) { const r = ar[k] * br[k] + ai[k] * bi[k], i = ai[k] * br[k] - ar[k] * bi[k]; ar[k] = r; ai[k] = i; }   // A * conj(B)
  fft(ar, ai, true);
  const m = new Float64Array(n - tpl.length + 1); let best = 0, at = 0;
  for (let i = 0; i < m.length; i++) { m[i] = Math.abs(ar[i]); if (m[i] > m[at]) at = i; best = m[at]; }
  if (at <= 0 || at >= m.length - 1) return null;
  const y0 = m[at - 1], y1 = m[at], y2 = m[at + 1], d = y0 - 2 * y1 + y2, frac = d < 0 ? 0.5 * (y0 - y2) / d : 0;
  return { pos: from + at + Math.max(-0.5, Math.min(0.5, frac)), q: best / (median(m) + 1e-30) };
}

/**
 * Sample-clock mismatch between the output and the recording, from the two timing-reference chirps of makeStimulus (stim.refStart and
 * stim.ref2Start, same speaker, same mic, same acoustic path): ppm > 0 = the recorder produced more samples per second than the player.
 * Returns {ok, ppm, spanSec, q} (ok = both chirps found clearly; no second chirp in the stimulus = ok false).
 */
export function estimateDrift(rec, stim, offset) {
  if (!stim.ref2Start || !stim.refLen || !stim.R) return { ok: false, ppm: 0, reason: 'no-ref2' };
  const sr = stim.sr, tpl = stim.R.subarray(stim.refStart, stim.refStart + stim.refLen), span = stim.ref2Start - stim.refStart;
  const a = findChirp(rec, tpl, offset + stim.refStart - 0.03 * sr, offset + stim.refStart + 0.3 * sr + stim.refLen);
  if (!a || a.q < 8) return { ok: false, ppm: 0, reason: 'chirp1' };
  const pad = 0.03 * sr, c2 = a.pos + span, b = findChirp(rec, tpl, c2 - pad, c2 + pad + stim.refLen);
  if (!b || b.q < 8) return { ok: false, ppm: 0, reason: 'chirp2' };
  const ratio = (b.pos - a.pos) / span;
  return { ok: true, ppm: (ratio - 1) * 1e6, spanSec: span / sr, q: Math.min(a.q, b.q), anchor: a.pos };
}

/**
 * Resample rec so that it runs on the player's clock: out[i] = rec(anchor + (i - anchor) * (1 + ppm * 1e-6)), 32-tap Hann-windowed sinc
 * (linear interpolation would lose ~11 dB at 20 kHz). The anchor sample stays where it is, so `offset` stays valid. Same length as rec.
 */
export function resampleDrift(rec, ppm, anchor = 0, half = 16) {
  const r = 1 + ppm * 1e-6, n = rec.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = anchor + (i - anchor) * r, p0 = Math.floor(p), fr = p - p0;
    if (Math.abs(fr) < 1e-9) { out[i] = p0 >= 0 && p0 < n ? rec[p0] : 0; continue; }
    let s = 0;
    for (let k = -half + 1; k <= half; k++) {
      const j = p0 + k; if (j < 0 || j >= n) continue;
      const x = fr - k, sinc = Math.sin(Math.PI * x) / (Math.PI * x), w = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
      s += rec[j] * sinc * w;
    }
    out[i] = s;
  }
  return out;
}

/** Drift threshold: below this the correction is not worth its (tiny) risk. */
export const DRIFT_MIN_PPM = 20, DRIFT_MAX_PPM = 1000;
/** Estimate and, when needed, remove the drift. Returns {recs (same arrays or resampled), ppm, applied, note}. recs: array of channels (all get the same correction). */
export function driftCorrect(recs, stim, offset) {
  const probe = recs.length > 1 ? pickChannel(recs[0], recs[1], 'mix') : recs[0], d = estimateDrift(probe, stim, offset);
  if (!d.ok) return { recs, ppm: 0, applied: false, note: d.reason };
  if (Math.abs(d.ppm) < DRIFT_MIN_PPM) return { recs, ppm: d.ppm, applied: false, note: 'small' };
  if (Math.abs(d.ppm) > DRIFT_MAX_PPM) return { recs, ppm: d.ppm, applied: false, note: 'implausible' };
  return { recs: recs.map(x => resampleDrift(x, d.ppm, d.anchor)), ppm: d.ppm, applied: true, note: 'corrected' };
}

// ---------------------------------------------------------------- one global run lock (wizard, mic pairing, pink match, ART verify...)
let holder = null, wake = null, wakeWant = false;
export const lockHolder = () => holder;
const wakeAcquire = async () => {
  try { if (wakeWant && navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { wake = null; }
};
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeAcquire(); });
/** Take the lock; false when another measurement holds it. Also keeps the screen awake (Wake Lock API, when available) until released. */
export function lockBegin(name) {
  if (holder) return false;
  holder = name; wakeWant = true; wakeAcquire();
  return true;
}
export function lockEnd(name) {
  if (name && holder !== name) return;
  holder = null; wakeWant = false;
  try { if (wake) { wake.release(); wake = null; } } catch { wake = null; }
}
