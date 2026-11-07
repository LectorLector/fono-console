// 一鍵校正 (measure every speaker, fit EQ, delays and levels, verify) and FIR phase.
import { h, $, toast, api, css, drawGraph } from './ui.js';
import { keys, toggle, knob } from './widgets.js';
import { makeStimulus, analyseRecording, irToCurve, averageCurves, autoEQ, bandLevel, deconvolve } from './measure.js';
import { smooth, chainDb, encodeWavFloat, schroeder, logGrid } from './dsp.js';
import { excessPhaseFromIR, excessPhaseFromModel, designFIR, groupDelay } from './fir.js';
import { SPK, SUBS, ALL_SPK, IR_RATES, alignDelays, activeSpk, mainSpk, subSpk, hasRear, subOf } from './eapo.js';
import { alignSubs } from './subalign.js';
import { applyMicCal } from './acoustics.js';
import { measureMicAveraged, measureAveraged, welchNoise, noiseEquivCurve, curveWindow, snrMask, badRanges, meanSnrCurve, noiseSummary, suggestLevel, ambientVerdict, estimateSeconds } from './avg.js';
import { fft } from './fft.js';
import { locale } from './i18n.js';
import { artReportChart } from './lab2.js';
import { spectra, solveART, predictCV, predictDrift, firFor, mainsFIR, ART_BANDS, artSources, defaultWeights, positionQuality, GRID_CELLS, verifyPositions, systemSpectra, irFromSpec, irBandT60, simulateRemeasure, verifyReport } from './art.js';

let C; // { S, RT, saveState, applyEapo, syncAll }
const W = { step: 'setup', outputs: [], inputs: [], outId: '', inId: '', results: {}, running: false, log: [], verify: {} };
const COLORS = { FL: '#b08a5e', FR: '#7f9168', SL: '#6f8796', SR: '#a5705f', SW1: '#8e7896', SW2: '#b59a5a' };
const SPK_NAME0 = { FL: '前左', FR: '前右', SL: '後左', SR: '後右', SW1: '重低音 1', SW2: '重低音 2' };
const SPK_NAME = new Proxy({}, { get: (_, k) => SPK_NAME0[k] + (C?.S.spk?.[k] ? ' ' + C.S.spk[k] : '') });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- audio I/O
const REC_WORKLET = `class R extends AudioWorkletProcessor{constructor(){super();this.on=true;this.f=-1;this.port.onmessage=e=>{if(e.data==='stop')this.on=false}}process(i){const c=i[0]&&i[0][0];if(c&&this.on){if(this.f<0){this.f=currentFrame;this.port.postMessage({first:currentFrame})}this.port.postMessage(c.slice(0))}return this.on}}registerProcessor('fono-rec',R);`;

async function listDevices() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch {}
  const all = await navigator.mediaDevices.enumerateDevices();
  W.outputs = all.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'communications');
  W.inputs = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications');
  const pick = (list, re) => (list.find(d => re.test(d.label)) || list.find(d => d.deviceId === 'default') || list[0] || {}).deviceId || '';
  W.outId = W.outId || C.S.meas.outId || pick(W.outputs, /USB Sound Device|CM6206/i);
  W.inId = W.inId || C.S.mic.deviceId || pick(W.inputs, /USB Sound Device|CM6206/i);
}

/** Demo: a synthetic recording (see demorec.js). The first ambient check is loud (air conditioner) so the warning shows; later ones are quiet. */
async function demoPlayAndRecord(stim, opts) {
  const { demoRecord } = await import('./demorec.js');
  const silent = !stim.L.some(v => v !== 0), loud = silent && W.demoAmbient === 1;
  return demoRecord(stim, { ch: W.target || 'FL', noiseDb: loud ? -38 : -62, tick: opts.tick, abort: opts.abort });
}

/** Wait `ms`, or until abort() says so (checked every 100 ms). */
async function waitFor(ms, abort) { const t0 = performance.now(); while (performance.now() - t0 < ms && !(abort && abort())) await sleep(Math.min(100, ms)); }

/** Play the stimulus on the chosen output and record the mic; returns {rec, offset, peakDb}. opts.abort(): stop early (the silence check). */
async function playAndRecord(stim, opts = {}) {
  if (window.__fonoDemo) return demoPlayAndRecord(stim, opts);
  const ctx = new AudioContext({ sampleRate: stim.sr, latencyHint: 'playback' });
  const t0 = performance.now(), iv = opts.tick ? setInterval(() => opts.tick(Math.max(0, (performance.now() - t0) / 1000 - 0.55)), 250) : 0;   // ~0.55 s of start-up before the recording runs
  try {
    if (W.outId && W.outId !== 'default' && ctx.setSinkId) await ctx.setSinkId(W.outId);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: W.inId ? { exact: W.inId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: stim.sr } });
    const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'fono-rec');
    const sink = ctx.createGain(); sink.gain.value = 0;
    const chunks = []; let first = -1;
    node.port.onmessage = e => { if (e.data && e.data.first !== undefined) first = e.data.first; else chunks.push(e.data); };
    src.connect(node).connect(sink).connect(ctx.destination);
    await sleep(350);
    const buf = ctx.createBuffer(2, stim.total, stim.sr);
    buf.copyToChannel(stim.L, 0); buf.copyToChannel(stim.R, 1);
    const play = ctx.createBufferSource(); play.buffer = buf; play.connect(ctx.destination);
    const startAt = ctx.currentTime + 0.2;
    play.start(startAt);
    await waitFor((stim.total / stim.sr + 0.9) * 1000, opts.abort);
    node.port.postMessage('stop');
    stream.getTracks().forEach(t => t.stop());
    await sleep(60);
    const n = chunks.reduce((a, c) => a + c.length, 0), rec = new Float32Array(n);
    let o = 0, pk = 0;
    for (const c of chunks) { rec.set(c, o); o += c.length; }
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(rec[i]));
    return { rec, offset: Math.round(startAt * stim.sr) - first, peakDb: 20 * Math.log10(pk + 1e-9) };
  } finally { clearInterval(iv); ctx.close(); }
}

// ---------------------------------------------------------------- measuring
async function routeTo(ch, raw) {
  W.target = ch;
  const r = C.S.room;
  W.saved = W.saved || { mode: r.mode, measureTarget: r.measureTarget, measureRaw: r.measureRaw };
  r.mode = 'measure'; r.measureTarget = ch; r.measureRaw = raw;
  await C.applyEapo();
  await sleep(window.__fonoDemo ? 120 : 900); // let Equalizer APO reload
}
async function restoreRouting() {
  if (!W.saved) return;
  Object.assign(C.S.room, W.saved); W.saved = null;
  await C.applyEapo(); C.syncAll();
}

/** No sound reached the mic: stop instead of "correcting" room noise. */
function noSignalGate(a, ch) {
  if ((a.sweepGainDb != null && a.sweepGainDb < 3) || a.snrDb < 15) {
    const e = new Error(`${ch}（${SPK_NAME[ch] || ch}）沒有收到掃頻聲音（訊噪比 ${a.snrDb.toFixed(0)} dB${a.sweepGainDb != null ? `，掃頻時音量只比安靜時大 ${a.sweepGainDb.toFixed(1)} dB` : ''}）。請確認擴大機已開機、輸入選對、音量適中，麥克風對著喇叭，再重新量測。`);
    e.noSignal = true; throw e;
  }
}

const stimFor = (opts = {}) => makeStimulus(48000, { level: C.S.meas.level, sweepSec: opts.sweepSec || (window.__fonoDemo ? 1.5 : 5.5) });
const nSweeps = () => [1, 2, 4].includes(C.S.meas.sweeps) ? C.S.meas.sweeps : 2;

/**
 * One speaker, S.meas.sweeps sweeps averaged coherently (avg.js combineSweeps: raw deconvolved IRs aligned and averaged before slicing,
 * the timing chirp reference too, so arrivalMs / polarity stay right). The no-signal gate runs on the first sweep only.
 * Result: the usual {ir, curve, arrivalMs, snrDb, polarity, peakDb...} plus sweeps, rep (repeatability, dB std between single sweeps) and,
 * when the run has an ambient noise spectrum, snrF = {f, snr} (per-frequency SNR) and okMask (SNR >= 15 dB).
 */
async function measureOne(ch, raw, { route = true, stim: st, sweeps, noise = true } = {}) {
  if (route) await routeTo(ch, raw);
  const stim = st || stimFor();
  const a = await measureAveraged({ sweeps: sweeps || nSweeps(), stim, grab: () => playAndRecord(stim), gate: x => noSignalGate(x, ch), onSweep: (i, n) => W.onSweep && W.onSweep(i, n) });
  const rawCurve = irToCurve(a.ir, a.sr, { peak: a.irPeak, windowMs: 300 });
  a.curve = rawCurve;
  if (noise && W.noiseRun && W.noiseRun.sr === a.sr) {
    const nc = noiseEquivCurve({ noise: W.noiseRun.noise, f: rawCurve.f, x: stim.L, winEnergy: curveWindow(a.ir.length, a.irPeak, a.sr, 300).energy, nSweeps: a.sweeps }), m = snrMask(rawCurve, nc, SNR_MIN);
    a.snrF = { f: m.f, snr: m.snr }; a.okMask = m.ok;
  }
  delete a.curves;
  if (!W.calOff) a.curve = applyMicCal(a.curve, C.S.mic.cal?.[W.inId]);   // per-microphone calibration (lab: mic pairing / UMIK file)
  return a;
}
const SNR_MIN = 15;   // dB: below this a frequency is not used for EQ filters

/** Mic pairing (lab): one raw sweep of `ch` recorded with input `inId`, without any stored calibration. */
export async function measureMicRaw(ch, inId) {
  if (W.running) throw new Error('量測進行中');
  W.running = true; const prev = W.inId; W.inId = inId; W.calOff = true;
  try { return (await measureOne(ch, true, { sweeps: 1, noise: false })).curve; }
  finally { W.inId = prev; W.calOff = false; await restoreRouting(); W.running = false; }
}

/**
 * Mic pairing (lab), averaged: `noiseSec` seconds of silence, then `sweeps` sweeps of `ch` with input `inId` (no stored calibration).
 * opts: {sweeps, noiseSec, onProgress, isCancelled}. Returns measureMicAveraged()'s result (averaged curve, per-sweep curves, SNR mask…).
 */
export async function measureMicAvg(ch, inId, opts = {}) {
  if (W.running) throw new Error('量測進行中');
  W.running = true; const prev = W.inId; W.inId = inId; W.calOff = true;
  try {
    const sr = 48000, noiseSec = opts.noiseSec || 10, stim = makeStimulus(sr, { level: C.S.meas.level, sweepSec: 5.5 });
    await routeTo(ch, true);
    const io = {
      grabNoise: async (sec, tick) => {
        const n = Math.round(sec * sr), z = { sr, L: new Float32Array(n), R: new Float32Array(n), total: n };
        const t0 = performance.now(), iv = setInterval(() => tick && tick(Math.max(0, (performance.now() - t0) / 1000 - 0.55)), 250);   // ~0.55 s of start-up before the recording runs
        try { const { rec, offset } = await playAndRecord(z); return rec.slice(Math.max(0, offset), Math.max(0, offset) + n); } finally { clearInterval(iv); }
      },
      grabSweep: () => measureOne(ch, true, { route: false, stim, sweeps: 1, noise: false }),
    };
    return await measureMicAveraged({ sweeps: opts.sweeps || 4, noiseSec, stim, io, onProgress: opts.onProgress, isCancelled: opts.isCancelled });
  } finally { W.inId = prev; W.calOff = false; await restoreRouting(); W.running = false; }
}

/** The channels the wizard measures: the user's choice, or every speaker of the layout. */
const measChans = () => { const act = activeSpk(C.S), c = (C.S.meas.chans || act).filter(k => act.includes(k)); return c.length ? c : act; };   // none selected = all

/** Update the headline of the running view without rebuilding it (countdowns). */
const setRunMsg = t => { const b = $('#wizBody .wiz-run b'); if (b) b.textContent = t; };
const fmtDur = sec => { const m = Math.floor(sec / 60), r = Math.round(sec % 60); return m ? `${m} 分 ${r} 秒` : `${r} 秒`; };
const estimate = () => estimateSeconds({ chans: measChans().length, positions: C.S.meas.positions, sweeps: nSweeps(), stimSec: window.__fonoDemo ? 5.5 : 8.8, checks: !!C.S.meas.checks });

/** One silent recording of `sec` seconds (the speakers stay quiet), cut where playback would have started. */
async function recordSilence(sec, onTick, abort) {
  const sr = 48000, n = Math.round(sec * sr), z = { sr, L: new Float32Array(n), R: new Float32Array(n), total: n };
  const { rec, offset } = await playAndRecord(z, { tick: onTick, abort });
  const o = Math.max(0, offset);
  return rec.slice(o, Math.min(rec.length, o + n));
}

/**
 * Before the run: (1) quick 1.5 s sweep on FL -> recording peak / SNR -> suggest or set the sweep level (target peak -12..-6 dBFS, output
 * never above -3 dBFS); (2) 5 s of silence -> Welch noise spectrum, stored with the run, and a warning when the room is too noisy for the
 * expected sweep level. Both can be skipped with the "skip" button (W.skip).
 */
async function preChecks(chans) {
  const S = C.S, sr = 48000, first = chans.includes('FL') ? 'FL' : chans[0];
  W.noiseRun = null; W.skip = false; W.demoAmbient = 0;
  let expectedPeak = S.meas.level - 12;   // when the level check is skipped: assume 12 dB of loss from output to mic
  await routeTo(first, true);
  if (!W.skip) {
    render(`正在檢查音量：${first}（${SPK_NAME[first]}）短掃頻 1.5 秒…`, false, { skip: true });
    try {
      const q = stimFor({ sweepSec: 1.5 }), { rec, offset, peakDb } = await playAndRecord(q), a = analyseRecording(rec, q, offset);
      const r = suggestLevel({ level: S.meas.level, peakDb, snrDb: a.snrDb, gainDb: a.sweepGainDb });
      expectedPeak = r.reason === 'nosignal' ? expectedPeak : peakDb + (r.level - S.meas.level);
      const txt = { ok: `掃頻音量 ${S.meas.level} dBFS 剛好：錄音峰值 ${peakDb.toFixed(0)} dBFS（目標 −12…−6）。`,
        low: `錄音峰值只有 ${peakDb.toFixed(0)} dBFS，太小：掃頻音量由 ${S.meas.level} 調到 ${r.level} dBFS。`,
        max: `錄音峰值只有 ${peakDb.toFixed(0)} dBFS，已調到上限 ${r.level} dBFS；請把麥克風靠近喇叭或調高麥克風增益。`,
        high: `錄音峰值 ${peakDb.toFixed(0)} dBFS 偏大：掃頻音量由 ${S.meas.level} 調到 ${r.level} dBFS。`,
        clip: `錄音峰值 ${peakDb.toFixed(0)} dBFS 已接近削波：掃頻音量由 ${S.meas.level} 調到 ${r.level} dBFS。`,
        nosignal: '短掃頻沒有收到聲音，音量維持不變（接下來的量測會直接告訴你是哪一顆喇叭沒聲音）。' }[r.reason];
      W.log.push('音量檢查：' + txt);
      if (r.changed) { S.meas.level = r.level; C.saveState(); }
    } catch (e) { W.log.push('音量檢查略過：' + e.message); }
  } else W.log.push('音量檢查：已略過。');
  for (let again = true; again;) {
    again = false;
    if (W.skip) { W.log.push('環境噪音檢查：已略過（不會有逐頻率訊噪比）。'); break; }
    W.demoAmbient++;
    const SEC = 5;
    render('正在聽環境噪音… 還剩 ' + SEC + ' 秒（請保持安靜）', false, { skip: true });
    const sil = await recordSilence(SEC, el => setRunMsg(`正在聽環境噪音… 還剩 ${Math.max(0, Math.ceil(SEC - el))} 秒（請保持安靜）`), () => W.skip);
    if (sil.length < 16384 * 1.5) { W.log.push('環境噪音檢查：錄音太短，已略過。'); break; }
    let e = 0; const mean = sil.reduce((x, y) => x + y, 0) / sil.length;
    for (let i = 0; i < sil.length; i++) e += (sil[i] - mean) ** 2;
    const rmsDb = 10 * Math.log10(e / sil.length + 1e-20), noise = welchNoise(sil, sr, 16384);
    W.noiseRun = { noise, sr, rmsDb, when: new Date().toISOString() };
    S.meas.ambient = noiseSummary(noise, rmsDb); C.saveState();
    const v = ambientVerdict({ noiseRmsDb: rmsDb, sweepRmsDb: expectedPeak - 3 });
    W.log.push(`環境噪音：${rmsDb.toFixed(0)} dBFS（相對預期掃頻 ${v.margin.toFixed(0)} dB）${v.level === 'ok' ? '，夠安靜。' : '，偏吵！'}`);
    if (v.level !== 'ok') {
      W.log.push('建議：關掉冷氣、風扇和電腦風扇，關窗，量測時不要說話或走動；噪音大的頻段（通常是低頻）會自動不做 EQ。');
      if (v.level === 'bad') {
        render('環境噪音太大（只比預期掃頻小 ' + v.margin.toFixed(0) + ' dB）：低頻量測會被蓋掉。請關掉冷氣／風扇後重新檢查，或仍要繼續。', true, { ambient: true });
        again = await new Promise(res => { W.resume = res; });
      } else toast('環境有點吵：建議關掉冷氣或風扇', true);
    }
  }
}

async function runAll() {
  if (W.running) return;
  W.running = true; W.results = {}; W.log = []; W.err = ''; W.q = []; W.noiseRun = null;
  const act = activeSpk(C.S), chans = measChans(), P = C.S.meas.positions;
  try {
    W.log.push(`預估時間約 ${fmtDur(estimate())}（${chans.length} 顆 × ${P} 個位置 × ${nSweeps()} 次掃頻${C.S.meas.checks ? '，含檢查' : ''}；不含移動麥克風）。`);
    if (C.S.meas.checks) await preChecks(chans);
    for (let p = 0; p < P; p++) {
      if (p > 0) {
        render(`位置 ${p + 1} / ${P}：${posHint(p, P)}放穩後按繼續。`, true, { pos: p });
        await new Promise(res => { W.resume = res; });
      }
      for (let again = true; again;) {
        again = false;
        for (const ch of chans) {
          const base = `位置 ${p + 1}/${P}：正在量測 ${ch}（${SPK_NAME[ch]}）`;
          W.onSweep = (i, n) => render(`${base}，掃頻 ${i}/${n}… 請保持安靜`, false, { pos: p });
          render(`${base}… 請保持安靜`, false, { pos: p });
          const a = await measureOne(ch, true);
          (W.results[ch] = W.results[ch] || [])[p] = a;
          W.log.push(measLogLine(ch, p, a));
        }
        W.onSweep = null;
        // per-position quality: SNR, repeatability between sweeps, and (9 / 15 point walks) consistency of the bass level with the neighbouring positions measured so far
        const q = positionQuality(W.results, chans, { maxDevDb: P >= 9 ? 9 : Infinity })[p];
        W.q[p] = q;
        if (q && !q.ok) {
          const rs = [];
          if (q.reasons.includes('snr')) rs.push(`訊噪比 ${q.snrDb.toFixed(0)} dB`);
          if (q.reasons.includes('dev')) rs.push(`低頻與鄰近位置差 ${q.devDb.toFixed(1)} dB`);
          if (q.reasons.includes('rep')) rs.push(`掃頻之間重複性 ±${q.repDb.toFixed(1)} dB（> 1.5 dB）`);
          W.log.push(`位置${p + 1}：品質檢查未通過（${rs.join('、')}）`);
          render(`位置 ${p + 1} / ${P}：這一點的量測品質不佳（可能被碰到、有噪音或麥克風沒放穩）。可以只重量這一點，不必從頭來過。`, true, { pos: p, redo: true });
          again = await new Promise(res => { W.resume = res; });
          if (again) for (const ch of chans) W.results[ch].length = p;
        }
      }
    }
    await restoreRouting();
    compute();
    W.step = 'result';
  } catch (e) {
    W.onSweep = null;
    await restoreRouting();
    toast('量測失敗：' + e.message, true);
    W.err = e.message; W.results = {};
    W.step = 'setup';
  } finally { W.running = false; W.onSweep = null; render(); }
}

/** One log line per measurement: arrival, SNR, polarity, sweeps and their repeatability (flagged above 1.5 dB). */
const REP_MAX = 1.5;
function measLogLine(ch, p, a) {
  const warn = a.peakDb > -1 ? '（錄音削波，請調低麥克風增益或掃頻音量）' : a.snrDb < 40 ? '（訊噪比偏低）' : '';
  const rep = a.rep ? `重複性 ±${a.rep.maxStd.toFixed(1)} dB（${a.sweeps} 次掃頻）${a.rep.maxStd > REP_MAX ? ' ⚠ 偏大，環境有變動' : ''}` : '單次掃頻';
  const lowSnr = a.snrF && a.okMask ? badRanges(a.snrF.f, a.okMask).filter(([f0]) => f0 < 300).map(([f0, f1]) => `${Math.round(f0)}–${Math.round(f1)} Hz`) : [];
  return `${ch} 位置${p + 1}：到達 ${a.arrivalMs.toFixed(2)} ms · 訊噪比 ${a.snrDb.toFixed(0)} dB · 極性 ${a.polarity > 0 ? '正' : '反'} · ${rep}${a.dropped ? `（${a.dropped} 次無效已剔除）` : ''} ${warn}${lowSnr.length ? ' · 訊噪比不足：' + lowSnr.join('、') : ''}`;
}

/** Which bands the EQ skipped because the room noise was too close to the sweep (SNR < 15 dB). */
function noisyHint(r) {
  const rows = Object.entries(r.chans).filter(([, c]) => c.noisy?.length).map(([k, c]) => `${k}：${c.noisy.map(([a, b]) => `${Math.round(a)}–${Math.round(b)} Hz`).join('、')}`);
  const bad = Object.entries(r.chans).filter(([, c]) => c.rep > REP_MAX).map(([k]) => k);
  return h('div', {}, rows.length ? h('p', { class: 'hint', id: 'noisyHint', style: 'color:var(--warn)' }, `這些頻段訊噪比低於 ${SNR_MIN} dB（被環境噪音蓋住），自動 EQ 不會在那裡放濾波器：${rows.join('；')}。關掉冷氣／風扇再量一次會更準。`) : '',
    bad.length ? h('p', { class: 'hint', id: 'repHint', style: 'color:var(--warn)' }, `${bad.join('、')} 的掃頻之間重複性超過 ${REP_MAX} dB：量測期間環境或麥克風有變動，結果可能不穩。`) : '');
}

function compute() {
  const S = C.S, out = { chans: {} };
  const fs = Math.round(schroeder(S.dims.rt60, S.dims.L * S.dims.W * S.dims.H) / 10) * 10;
  const fmax = S.meas.fmax || Math.min(350, Math.max(200, fs + 30));
  const act = activeSpk(S), mains = mainSpk(S);
  for (const [ch, list] of Object.entries(W.results)) {
    if (!act.includes(ch)) continue;   // measured under another layout
    const avg = averageCurves(list.map(x => x.curve));
    // per-frequency SNR (mean over the positions): no EQ filter where it is below 15 dB
    const sf = meanSnrCurve(list), mask = sf ? { f: sf.f, ok: sf.snr.map(v => v >= SNR_MIN) } : undefined;
    const eq = autoEQ(avg, { fmax, lfRise: S.meas.lfRise, maxFilters: S.meas.maxFilters, target: S.room.target || undefined, mask });
    const reps = list.map(x => x.rep?.maxStd).filter(Number.isFinite);
    out.chans[ch] = {
      curve: avg, eq, level: bandLevel(smooth(avg, 6), 500, 2000),
      arrival: list[0].arrivalMs, polarity: list[0].polarity, snr: Math.min(...list.map(x => x.snrDb)),
      snrF: sf, rep: reps.length ? Math.max(...reps) : null, noisy: mask ? badRanges(mask.f, mask.ok).filter(([f0, f1]) => f1 >= 20 && f0 <= fmax) : [],
    };
  }
  const t = { FL: 0, FR: 0, SL: 0, SR: 0 };
  for (const k of SPK) if (out.chans[k]) t[k] = out.chans[k].arrival;
  if (!hasRear(S)) t.SL = t.SR = Math.max(t.FL, t.FR);   // 2.x: no rear pair, only the FL/FR time difference matters
  out.allFour = mains.every(k => out.chans[k]);   // "all main speakers of the layout" (subwoofers are aligned separately)
  out.act = mains;
  // Delays only make sense when every speaker was measured against the same reference.
  out.delays = out.allFour ? alignDelays(t, S.room.mode === 'quadB' ? 'quadB' : 'quadA') : Object.fromEntries(SPK.map(k => [k, S.room.ch[k].delay]));
  const refL = out.chans.FL?.level ?? Object.values(out.chans).find((_, i) => !SUBS.includes(Object.keys(out.chans)[i]))?.level ?? 0;
  out.gains = {};
  for (const [k, c] of Object.entries(out.chans)) {
    if (SUBS.includes(k)) continue;   // a sub has no 500-2000 Hz output to compare; its level is set by ear / the strip
    const rearOffset = (k === 'SL' || k === 'SR') && S.room.mode !== 'quadB' ? -6 : 0;
    out.gains[k] = Math.round((refL - c.level + rearOffset) * 2) / 2;
  }
  out.fmax = fmax;
  W.calc = out;
  out.sub = calcSubAlign({ delay: true, gain: true });
}

/**
 * Sub delay / polarity relative to the mains from the measured complex responses (see subalign.js).
 * The mains are modelled with the delays and gains that will be in force: the suggested ones when `sel.delay` / `sel.gain` are applied, else the current strips.
 */
function calcSubAlign(sel) {
  const S = C.S, r = W.calc, subs = subSpk(S).filter(k => W.results[k]?.length), mains = ['FL', 'FR'].filter(k => W.results[k]?.length && mainSpk(S).includes(k));
  if (!subs.length || !mains.length) return null;
  const st = subOf(S), useD = sel.delay && r.allFour, useG = sel.gain;
  const mk = (k, sub) => ({ list: W.results[k], gainDb: (useG && r.gains[k] != null && !sub ? r.gains[k] : S.room.ch[k].gain) + (sub ? st.gain : 0), delayMs: useD && !sub ? r.delays[k] : S.room.ch[k].delay });
  try {
    const a = alignSubs({ mains: mains.map(k => mk(k, false)), subs: subs.map(k => mk(k, true)), xover: st.xover, mainsFull: !!st.mainsFull, maxMs: 10, stepMs: 0.1 });
    return { ...a, keys: subs, mains };
  } catch (e) { return null; }
}

async function applyResults(sel) {
  const S = C.S, r = W.calc;
  for (const [k, c] of Object.entries(r.chans)) {
    const isSub = SUBS.includes(k);
    if (sel.eq) S.room.ch[k].corr = { name: `自動校正 ${new Date().toLocaleString(locale(), { hour12: false })}`, filters: c.eq.filters, source: 'auto' };
    if (isSub) continue;
    if (sel.delay && r.allFour) S.room.ch[k].delay = r.delays[k];
    if (sel.gain) S.room.ch[k].gain = Math.max(-24, Math.min(6, r.gains[k]));
    if (sel.pol && c.polarity < 0) S.room.ch[k].invert = true;
  }
  if (sel.sub) {   // recomputed against the delays / gains that were just applied
    const a = calcSubAlign({ delay: false, gain: false });
    if (a) {
      // a negative delay means the mains are late: the subs start at 0 and every other speaker is delayed by the same amount
      for (const k of mainSpk(S)) S.room.ch[k].delay = Math.round((S.room.ch[k].delay + a.shiftMs) * 100) / 100;
      a.keys.forEach((k, i) => { const c = S.room.ch[k]; c.delay = Math.round(Math.max(0, a.subs[i].delayMs + a.shiftMs) * 100) / 100; c.invert = a.subs[i].invert; });
      S.room.sub.align = { when: new Date().toISOString(), xover: a.xover, keys: a.keys, subs: a.subs.map(x => ({ delayMs: x.delayMs, invert: x.invert })), shiftMs: a.shiftMs, gainDb: Math.round(a.gainDb * 10) / 10 };
    }
  }
  S.room.correction = true;
  S.meas.results = Object.fromEntries(Object.entries(r.chans).map(([k, c]) => [k, { f: c.curve.f.filter((_, i) => i % 2 === 0), db: c.curve.db.filter((_, i) => i % 2 === 0) }]));
  C.saveState(); C.syncAll(); await C.applyEapo();
  toast('已套用校正結果');
}

async function verify() {
  if (W.running) return;
  W.running = true; W.verify = {};
  try {
    for (const ch of Object.keys(W.calc?.chans || {})) {
      const base = `驗證：量測 ${ch}（已套用矯正）`;
      W.onSweep = (i, n) => render(`${base}，掃頻 ${i}/${n}…`);
      render(`${base}…`);
      const a = await measureOne(ch, false);
      W.verify[ch] = a.curve;
      W.log.push(`驗證 ${ch}：${a.rep ? `重複性 ±${a.rep.maxStd.toFixed(1)} dB（${a.sweeps} 次掃頻）` : '單次掃頻'} · 訊噪比 ${a.snrDb.toFixed(0)} dB`);
    }
  } catch (e) { toast('驗證失敗：' + e.message, true); }
  W.onSweep = null;
  await restoreRouting();
  W.running = false; W.step = 'verify'; render();
}

/** Demo only: simulated bedroom measurements (with the subwoofers of the chosen layout) go through the same compute() as a real run. */
async function demoLoad() {
  const { demoMeasurements } = await import('./demoroom.js');
  const act = activeSpk(C.S), raw = demoMeasurements({ subs: subSpk(C.S).length });
  W.results = {};
  for (const k of act) {
    if (!raw[k]) continue;
    W.results[k] = raw[k].slice(0, 3).map(m => ({ ...m, curve: irToCurve(m.ir, m.sr, { windowMs: 1500 }), snrDb: 60, polarity: 1, peakDb: -12 }));
  }
  compute(); W.step = 'result'; render();
  toast('已載入模擬臥室的量測');
}

// ---------------------------------------------------------------- UI
function graph(id, curves, o = {}) {
  const c = $('#' + id); if (!c) return;
  const all = [];
  curves.forEach(cv => cv.f.forEach((f, i) => { if (f > 100 && f < 2000) all.push(cv.db[i]); }));
  all.sort((a, b) => a - b);
  const mid = all.length ? all[Math.floor(all.length / 2)] : -40;
  drawGraph(c, { fmin: 20, fmax: o.fmax || 20000, dmin: Math.round(mid / 5) * 5 - 30, dmax: Math.round(mid / 5) * 5 + 20, dstep: 5, curves, markers: o.markers || [] });
}

// Where to put the mic for position p of P. For 9/15 points (ART) it walks a grid around the head.
const GRID9 = ['正中央（頭的位置）', '往前 25 cm', '往後 25 cm', '往左 25 cm', '往右 25 cm', '左前（左 25、前 25 cm）', '右前（右 25、前 25 cm）', '左後（左 25、後 25 cm）', '右後（右 25、後 25 cm）'];
const GRID15 = [...GRID9, '正中央、往上 15 cm', '正中央、往下 15 cm', '往左 15 cm、往上 15 cm', '往右 15 cm、往上 15 cm', '往左 15 cm、往下 15 cm', '往右 15 cm、往下 15 cm'];
function posHint(p, P) {
  if (P >= 9) return `把麥克風移到「${(P >= 15 ? GRID15 : GRID9)[p]}」（以第 1 點為準，左右以面向喇叭為準），`;
  return '把麥克風移到聽音位置周圍約 30 cm 內的另一點（前後、左右或高低），';
}

/** 3 x 5 map of the 15-point walk: columns left / centre / right, rows front / middle / back / up / down. cur = the next position, W.q marks bad ones. */
export function posDiagram(cur, P) {
  const cells = Array.from({ length: P }, (_, p) => { const [c, r] = GRID_CELLS[p % GRID_CELLS.length]; return h('i', { class: 'pg-c' + (p === cur ? ' on' : p < cur ? ' done' : '') + (W.q?.[p] && !W.q[p].ok ? ' bad' : ''), style: `grid-column:${c + 1};grid-row:${r + 1}`, title: GRID15[p] || '' }, String(p + 1)); });
  return h('div', { class: 'pos-diagram' }, h('div', { class: 'pg-grid' }, ...cells), h('div', { class: 'pg-cap' }, '上三排：水平面（上＝前方）；下兩排：往上／往下 15 cm。亮的是下一個位置。'));
}

function render(msg, waiting, opt = {}) {
  const box = $('#wizBody'); if (!box) return;
  box.innerHTML = '';
  const S = C.S;
  const steps = [['setup', '1 準備'], ['run', '2 量測'], ['result', '3 套用'], ['verify', '4 驗證']];
  const cur = W.running ? (W.step === 'verify' ? 'verify' : 'run') : W.step;
  box.append(h('div', { class: 'wiz-steps' }, ...steps.map(([id, t]) => h('span', { class: 'wiz-step' + (id === cur ? ' on' : '') }, t))));
  if (W.running) {
    const go = redo => () => { const r = W.resume; W.resume = null; r && r(redo); };
    box.append(h('div', { class: 'wiz-run' }, h('div', { class: 'wiz-dot' }), h('b', {}, msg || '量測中…')),
      opt.pos !== undefined && S.meas.positions >= 9 ? posDiagram(opt.pos, S.meas.positions) : '',
      opt.skip ? h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', type: 'button', id: 'wizSkip', onclick: () => { W.skip = true; setRunMsg('正在略過檢查…'); } }, '略過檢查')) : '',
      waiting && opt.ambient ? h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', type: 'button', id: 'wizAmbientRedo', onclick: go(true) }, '關掉風扇後重新檢查'), h('button', { class: 'btn primary', type: 'button', id: 'wizAmbientGo', onclick: go(false) }, '仍要繼續')) : '',
      waiting && !opt.ambient ? h('div', { class: 'wiz-actions' }, opt.redo ? h('button', { class: 'btn', type: 'button', id: 'wizRedo', onclick: go(true) }, '重量這一點') : '', h('button', { class: 'btn primary', type: 'button', onclick: go(false) }, opt.redo ? '接受並繼續' : '繼續')) : '',
      h('div', { class: 'wiz-log' }, ...W.log.map(l => h('div', {}, l))));
    return;
  }
  if (W.step === 'setup') {
    if (W.err) box.append(h('div', { class: 'banner', style: 'border-color:var(--bad)' }, '⚠ 上次量測沒有完成：' + W.err));
    const outSel = h('select', {}, ...W.outputs.map(d => h('option', { value: d.deviceId, selected: d.deviceId === W.outId ? '' : null }, d.label || d.deviceId)));
    outSel.onchange = () => { W.outId = outSel.value; S.meas.outId = W.outId; C.saveState(); };
    const inSel = h('select', {}, ...W.inputs.map(d => h('option', { value: d.deviceId, selected: d.deviceId === W.inId ? '' : null }, d.label || d.deviceId)));
    inSel.onchange = () => { W.inId = inSel.value; S.mic.deviceId = W.inId; C.saveState(); };
    const chK = h('div', { class: 'keys' }, ...activeSpk(S).map(k => { const on = measChans().includes(k); const b = h('button', { class: 'key' + (on ? ' on' : ''), type: 'button' }, k); b.onclick = () => { const set = new Set(measChans()); set.has(k) ? set.delete(k) : set.add(k); S.meas.chans = activeSpk(S).filter(x => set.has(x)); C.saveState(); render(); }; return b; }));
    const posK = keys({ options: [1, 3, 5, 9, 15].map(n => ({ id: n, label: n >= 9 ? `${n} 點（ART）` : `${n} 個位置` })), value: S.meas.positions, onInput: v => { S.meas.positions = v; C.saveState(); } });
    const est = h('div', { class: 'hint', id: 'wizEstimate', style: 'margin:6px 0 0' });
    const upEst = () => { est.textContent = `預估時間：約 ${fmtDur(estimate())}（${measChans().length} 顆 × ${S.meas.positions} 個位置 × ${nSweeps()} 次掃頻${S.meas.checks ? '，含量測前檢查' : ''}；不含移動麥克風的時間）`; };
    const swK = keys({ options: [1, 2, 4].map(n => ({ id: n, label: n === 1 ? '1 次（最快）' : `${n} 次平均` })), value: nSweeps(), onInput: v => { S.meas.sweeps = v; C.saveState(); upEst(); } });
    const chkT = toggle({ label: '量測前檢查環境噪音與音量', small: true, value: !!S.meas.checks, onInput: v => { S.meas.checks = v; C.saveState(); upEst(); } });
    upEst();
    const lvl = knob({ label: '掃頻音量', min: -30, max: -3, step: 1, def: -12, size: 62, value: S.meas.level, fmt: v => v + ' dBFS', onInput: v => { S.meas.level = v; C.saveState(); } });
    const rise = knob({ label: '低頻抬升', min: 0, max: 6, step: 0.5, def: 2, size: 62, value: S.meas.lfRise, fmt: v => '+' + v + ' dB', onInput: v => { S.meas.lfRise = v; C.saveState(); } });
    box.append(
      h('div', { class: 'wiz-grid' },
        h('label', { class: 'field' }, h('span', {}, '播放裝置（選多聲道音效卡）'), outSel),
        h('label', { class: 'field' }, h('span', {}, '量測麥克風'), inSel),
        h('div', { class: 'field' }, h('span', {}, '要量的喇叭'), chK),
        h('div', { class: 'field' }, h('span', {}, '麥克風位置數（多點平均更準）'), posK.el),
        h('div', { class: 'field' }, h('span', {}, '掃頻次數（每顆喇叭、每個位置；多次平均可壓低噪音）'), swK.el),
        h('div', { class: 'field' }, h('span', {}, '自動檢查'), chkT.el)),
      est,
      h('div', { class: 'knob-row', style: 'margin-top:12px' }, lvl.el, rise.el),
      h('ol', { class: 'wiz-tips' },
        h('li', {}, '麥克風放在耳朵高度、朝天花板，用腳架或書固定。'),
        h('li', {}, '擴大機音量旋鈕放在平常聽的位置，量測期間不要動。'),
        h('li', {}, '每顆喇叭會播一聲短嗶（計時參考，固定由 FL 發出）和約 6 秒的掃頻，依「掃頻次數」重複並平均。'),
        h('li', {}, '開始前會先聽 5 秒環境噪音、用 FL 播 1.5 秒短掃頻檢查音量（可略過）；太吵的頻段不會被 EQ 修正。')),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'btn primary big', onclick: () => { W.step = 'run'; runAll(); } }, '開始一鍵校正'),
        window.__fonoDemo ? h('button', { class: 'btn', type: 'button', id: 'wizDemoLoad', onclick: demoLoad }, '載入示範量測（模擬臥室）看結果') : null));
    return;
  }
  if (W.step === 'result' && W.calc) {
    const r = W.calc;
    const sa = r.sub;
    const rows = Object.entries(r.chans).map(([k, c]) => { const sub = SUBS.includes(k), si = sa ? sa.keys.indexOf(k) : -1; return h('tr', {},
      h('td', { style: `color:${COLORS[k]}` }, h('b', {}, k)),
      h('td', {}, `${c.eq.filters.length} 個`), h('td', {}, `${c.eq.rmsBefore.toFixed(1)} → ${c.eq.rmsAfter.toFixed(1)} dB`),
      h('td', {}, `${c.arrival.toFixed(2)} ms`),
      h('td', {}, sub ? (si >= 0 ? `${(sa.subs[si].delayMs + sa.shiftMs).toFixed(2)} ms` : '—') : r.allFour ? `${r.delays[k].toFixed(2)} ms` : `—（需量全部${r.act.length === 4 ? '四' : '兩'}顆）`),
      h('td', {}, sub ? '—' : `${r.gains[k] > 0 ? '+' : ''}${r.gains[k].toFixed(1)} dB`),
      h('td', {}, sub ? (si >= 0 ? (sa.subs[si].invert ? h('span', { style: 'color:var(--bad)' }, '反相 180°') : '正相 0°') : '—') : c.polarity < 0 ? h('span', { style: 'color:var(--bad)' }, '反相！') : '正常'), h('td', {}, c.snr.toFixed(0) + ' dB'),
      h('td', { style: c.rep > REP_MAX ? 'color:var(--bad)' : '' }, c.rep == null ? '—' : `±${c.rep.toFixed(1)} dB${c.rep > REP_MAX ? ' ⚠' : ''}`)); });
    const sel = { eq: true, delay: true, gain: true, pol: false, sub: !!sa };
    const tg = (k, label) => toggle({ label, small: true, value: sel[k], onInput: v => { sel[k] = v; } }).el;
    const subBox = sa ? h('div', { class: 'sub-align', id: 'subAlign' },
      h('h3', { class: 'feat-h' }, '重低音對齊'),
      h('p', { class: 'hint', style: 'margin-top:0' }, `分頻 ${sa.xover} Hz（LR4）。在 ${Math.round(sa.band[0])}–${Math.round(sa.band[1])} Hz（0.5–2 倍分頻點）內，用實測的複數響應（含到達時間與相位）搜尋重低音的延遲（±10 ms，每 0.1 ms）與極性，使聽音位置的加總振幅最大。`),
      h('table', { class: 'modes-table' }, h('tr', {}, ...['重低音', '建議延遲', '極性', '加總分數（前 → 後）'].map(t => h('th', {}, t))),
        ...sa.keys.map((k, i) => h('tr', {}, h('td', { style: `color:${COLORS[k]}` }, h('b', {}, k)),
          h('td', {}, `${(sa.subs[i].delayMs + sa.shiftMs).toFixed(2)} ms`), h('td', {}, sa.subs[i].invert ? '反相 180°' : '正相 0°'),
          h('td', {}, `${sa.subs[i].scoreBefore.toFixed(3)} → ${sa.subs[i].score.toFixed(3)}`)))),
      h('p', { class: 'hint', id: 'subAlignSum' }, `分頻點附近加總平均提高 ${sa.gainDb >= 0 ? '+' : ''}${sa.gainDb.toFixed(1)} dB。` + (sa.shiftMs > 0 ? `重低音比主喇叭早到，所以主喇叭（前後全部）會再多延遲 ${sa.shiftMs.toFixed(1)} ms，重低音從 0 起算。` : '')),
      h('canvas', { class: 'graph', id: 'subGraph', style: 'height:200px' }),
      h('p', { class: 'hint' }, '亮線：套用對齊後；灰線：延遲 0、正相。這是依實測算出的預測，套用後可再量一次驗證。重低音的音量請用耳朵或在房間頁調整。')) : null;
    box.append(
      h('canvas', { class: 'graph', id: 'wizGraph', style: 'height:300px' }),
      h('table', { class: 'modes-table', style: 'margin-top:12px' },
        h('tr', {}, ...['聲道', '濾波器', '駐波誤差', '到達', '建議延遲', '建議增益', '極性', '訊噪比', '重複性'].map(t => h('th', {}, t))), ...rows),
      noisyHint(r),
      subBox || '',
      h('p', { class: 'hint' }, `矯正範圍 ${Math.round(r.fLowAll || 20)}–${r.fmax} Hz（依房間尺寸算出的施羅德頻率）。只削峰不補凹陷；延遲依目前模式（${C.S.room.mode === 'quadB' ? 'B 同時到達' : 'A 後方晚 15 ms'}）計算。`),
      h('div', { class: 'wiz-actions' }, tg('eq', '套用 EQ'), tg('delay', '套用延遲'), tg('gain', '套用音量'), tg('pol', '自動反相（建議先檢查接線）'), sa ? tg('sub', '套用重低音對齊') : null,
        h('button', { class: 'btn primary big', onclick: async () => { await applyResults(sel); W.step = 'applied'; render(); } }, '套用'),
        h('button', { class: 'btn', onclick: () => { W.step = 'setup'; render(); } }, '重新量測')));
    if (sa) requestAnimationFrame(() => {
      const c = $('#subGraph'); if (!c) return;
      const all = [...sa.before.db, ...sa.after.db], hi = Math.ceil(Math.max(...all) / 5) * 5;
      drawGraph(c, { fmin: 20, fmax: 250, dmin: hi - 40, dmax: hi + 5, dstep: 5, curves: [{ f: sa.f, db: sa.before.db, color: css('--ink-3'), width: 1.6 }, { f: sa.f, db: sa.after.db, color: css('--accent'), width: 2.2 }], bands: [{ f0: sa.band[0], f1: sa.band[1], color: css('--grid') }] });
    });
    requestAnimationFrame(() => graph('wizGraph', Object.entries(r.chans).flatMap(([k, c]) => [
      { ...smooth(c.curve, 12), color: COLORS[k], width: 1.8 },
      { f: c.curve.f, db: smooth(c.curve, 12).db.map((v, i) => v + chainDb(c.eq.filters, c.curve.f[i])), color: COLORS[k], width: 1.4, dash: [5, 4] }]), { fmax: 1000 }));
    return;
  }
  if (W.step === 'applied') {
    box.append(h('p', { class: 'hint' }, '已寫入 Equalizer APO。建議做一次驗證：會在矯正開啟的狀態下再量一次，和預測曲線比對。'),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'btn primary big', onclick: verify }, '驗證量測'), h('button', { class: 'btn', onclick: () => { W.step = 'setup'; render(); } }, '完成')));
    return;
  }
  if (W.step === 'verify') {
    box.append(h('canvas', { class: 'graph', id: 'wizGraph', style: 'height:300px' }),
      h('p', { class: 'hint' }, '實線：矯正後實測；虛線：矯正前。300 Hz 以下的峰應該降到 ±3 dB 內。'),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'btn', onclick: () => { W.step = 'setup'; render(); } }, '完成')));
    requestAnimationFrame(() => graph('wizGraph', Object.entries(W.verify).flatMap(([k, cv]) => [
      { ...smooth(cv, 12), color: COLORS[k], width: 2 },
      ...(W.calc?.chans[k] ? [{ ...smooth(W.calc.chans[k].curve, 12), color: COLORS[k], width: 1.2, dash: [5, 4] }] : [])]), { fmax: 1000 }));
  }
}

// ---------------------------------------------------------------- FIR
const F = { preview: null };
function firSource(ch) {
  const S = C.S, fr = S.room.fir;
  if (fr.mode === 'model') return excessPhaseFromModel(fr.model, 48000);
  const m = W.results[ch]?.[0];
  if (!m) return null;
  return excessPhaseFromIR(m.ir, m.sr, { lo: fr.lo, hi: fr.hi });
}

function drawFirPreview() {
  const c = $('#firGraph'); if (!c) return;
  const S = C.S, fr = S.room.fir;
  const ch = fr.chans[0] || 'FL';
  const ex = firSource(ch);
  if (!ex) { const s = c.getContext('2d'); s.clearRect(0, 0, c.width, c.height); return; }
  const gd = groupDelay(ex);
  const keep = gd.f.map((f, i) => [f, gd.ms[i]]).filter(([f]) => f >= 20 && f <= 20000);
  const tap = f => (f >= fr.lo && f <= fr.hi ? 0 : 1);
  const before = { f: keep.map(x => x[0]), db: keep.map(x => x[1]) };
  const after = { f: before.f, db: before.f.map((f, i) => before.db[i] * tap(f)) };
  const dmax = Math.max(2, Math.ceil(Math.max(...before.db.filter(isFinite)) + 0.5));
  drawGraph(c, { fmin: 20, fmax: 20000, dmin: dmax > 8 ? -2 : -1, dmax: dmax > 8 ? Math.ceil(dmax / 2) * 2 : dmax, dstep: dmax > 8 ? 2 : 1, zero: true,
    curves: [{ ...before, color: css('--ink-3'), width: 1.6 }, { ...after, color: css('--accent'), width: 2.2 }],
    bands: [{ f0: fr.lo, f1: fr.hi, color: css('--grid') }] });
}

async function buildFir() {
  const S = C.S, fr = S.room.fir;
  const chans = fr.chans.filter(k => mainSpk(S).includes(k));
  if (!chans.length) { toast('請至少選一個聲道', true); return; }
  try {
    let latency = 0;
    for (const ch of chans) {
      const ex = firSource(ch);
      if (!ex) { toast(`${ch} 沒有量測資料，請先做一鍵校正或改用模型模式`, true); return; }
      for (const sr of IR_RATES) {
        const { h: taps, latencyMs } = designFIR(ex, sr, { lo: fr.lo, hi: fr.hi });
        latency = latencyMs;
        await api(`/api/eapo/file?name=${encodeURIComponent(`fono/fir_${ch}_${sr}.wav`)}`, { method: 'POST', body: encodeWavFloat([taps], sr) });
      }
    }
    fr.latencyMs = latency; fr.built = new Date().toISOString(); fr.on = true;
    C.saveState(); await C.applyEapo(); C.syncAll(); renderFir();
    toast(`已建立 FIR（延遲 ${latency.toFixed(0)} ms，其他聲道已自動補償）`);
  } catch (e) { toast('建立 FIR 失敗：' + e.message, true); }
}

function renderFir() {
  const box = $('#firBody'); if (!box) return;
  box.innerHTML = '';
  const S = C.S, fr = S.room.fir;
  const modeK = keys({ options: [{ id: 'model', label: '分頻器模型' }, { id: 'measured', label: '依實際量測' }], value: fr.mode, onInput: v => { fr.mode = v; C.saveState(); renderFir(); } });
  const chK = h('div', { class: 'keys' }, ...mainSpk(S).map(k => { const on = fr.chans.includes(k); const b = h('button', { class: 'key' + (on ? ' on' : ''), type: 'button' }, k); b.onclick = () => { fr.chans = on ? fr.chans.filter(x => x !== k) : mainSpk(S).filter(x => x === k || fr.chans.includes(x)); C.saveState(); renderFir(); }; return b; }));
  const kn = (label, obj, key, o) => knob({ label, size: 62, value: obj[key], ...o, onInput: v => { obj[key] = v; C.saveState(); drawFirPreview(); } }).el;
  const onT = toggle({ label: 'FIR 相位校正', sub: fr.built ? `已建立 ${new Date(fr.built).toLocaleString(locale(), { hour12: false })} · 延遲 ${fr.latencyMs.toFixed(0)} ms` : '尚未建立', value: fr.on && !!fr.built, onInput: async v => { if (v && !fr.built) { toast('請先按「建立並套用 FIR」', true); renderFir(); return; } fr.on = v; C.saveState(); await C.applyEapo(); C.syncAll(); } });
  box.append(
    h('div', { class: 'fir-top' }, onT.el, modeK.el, h('div', { class: 'field' }, h('span', {}, '套用聲道'), chK)),
    h('div', { class: 'knob-row', style: 'margin-top:12px' },
      kn('校正下限', fr, 'lo', { min: 80, max: 1000, step: 10, def: 200, fmt: v => v + ' Hz' }),
      kn('校正上限', fr, 'hi', { min: 2000, max: 20000, step: 500, def: 12000, fmt: v => (v / 1000).toFixed(1) + 'k' }),
      ...(fr.mode === 'model' ? [
        kn('分頻點', fr.model, 'xover', { min: 500, max: 6000, step: 50, def: 3000, fmt: v => (v / 1000).toFixed(2) + 'k' }),
        kn('低頻滾降', fr.model, 'hpFreq', { min: 20, max: 120, step: 1, def: 50, fmt: v => v + ' Hz' }),
        kn('滾降階數', fr.model, 'hpOrder', { min: 2, max: 4, step: 1, def: 4, fmt: v => ({ 2: '2 密閉', 3: '3', 4: '4 倒相' })[v] }),
      ] : [])),
    h('canvas', { class: 'graph', id: 'firGraph', style: 'height:240px' }),
    h('p', { class: 'hint' }, '灰線：喇叭本身的群延遲（相位扭轉造成的時間差）；亮色線：校正後。FIR 是線性相位全通濾波器，只修正相位、不改變頻響；會讓所有聲道一起延遲約 85 ms（影音同步時注意），未套用 FIR 的聲道會自動補上同樣的延遲。'),
    h('p', { class: 'hint' }, fr.mode === 'measured' ? (Object.keys(W.results).length ? '使用這次一鍵校正的第一個位置量測。' : '這個模式需要先做一次一鍵校正（本次開啟控制台後）。') : '分頻點請依喇叭說明書填入；倒相式喇叭的低頻滾降選 4 階、頻率填 −6 dB 點附近，密閉式選 2 階。'),
    h('div', { class: 'wiz-actions' }, h('button', { class: 'btn primary big', onclick: buildFir }, '建立並套用 FIR')));
  requestAnimationFrame(drawFirPreview);
  const cv = $('#firGraph');
  if (cv && window.ResizeObserver) new ResizeObserver(() => drawFirPreview()).observe(cv);
}

export function buildMeasureWizard(root, firRoot, ctx, artRoot) {
  C = ctx;
  window.__fonoWizardResults = () => W.results;
  root.innerHTML = '';
  root.append(h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, '一鍵校正'), h('span', { class: 'en' }, 'Auto room correction'), h('span', { class: 'rule' })),
    h('p', { class: 'hint', style: 'margin-top:0' }, '不需要開 REW：控制台會自動切換聲道路由、逐顆播放掃頻、計算駐波 EQ、前後延遲與音量，再寫入 Equalizer APO。'),
    h('div', { id: 'wizBody' })));
  firRoot.innerHTML = '';
  firRoot.append(h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'F'), h('h2', {}, 'FIR 相位校正'), h('span', { class: 'en' }, 'Linear phase'), h('span', { class: 'rule' })), h('div', { id: 'firBody' })));
  if (artRoot) {
    artRoot.innerHTML = '';
    artRoot.append(h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'R'), h('h2', {}, 'ART 低頻主動校正'), h('span', { class: 'en' }, 'Active bass control · experimental'), h('span', { class: 'rule' })), h('div', { id: 'artBody' })));
  }
  setTimeout(() => { render(); renderFir(); renderArt(); }, 0);
  listDevices().then(() => render()).catch(() => render());
}

/** The speaker layout changed (wizard or settings): redraw the channel lists, FIR and ART tabs. */
export function refreshLayout() { if (!C) return; render(); renderFir(); renderArt(); }

// ---------------------------------------------------------------- ART (experimental)
const A = { sol: null, cv: null, drift: null, busy: false, vbusy: false, wOpen: false, vN: 3 };
/** Sources and roles for the current layout (and the "who plays the bass" choice). */
const artSrc = () => artSources(C.S.room.layout || '4.0', C.S.room.art.bass);
function artData() {
  const as = artSrc(), n = as.ok ? Math.min(...as.keys.map(k => (W.results[k] || []).length)) : 0;
  return { n, as, ok: as.ok && n >= 9, meas: Object.fromEntries(as.keys.map(k => [k, (W.results[k] || []).slice(0, n)])) };
}
/** Solver options from the panel: every A2 feature is a switch. */
function artOpts(n) {
  const a = C.S.room.art, as = artSrc();
  return { fc: a.fc, capDb: a.capDb, fLow: a.fLow, tau: a.tauMs / 1000, state: C.S, robust: a.robust !== false,
    mains: as.mains, helpers: as.helpers, direct: as.direct, auto: a.auto !== false, headroom: a.headroom !== false, preRing: a.preRing === true ? -30 : false,
    weights: (a.weights && a.weights.length ? a.weights : defaultWeights(n)).slice(0, n) };
}

async function computeArt() {
  const d = artData(); if (!d.ok) return;
  A.busy = true; A.verifyRes = null; renderArt();
  await sleep(30);
  try {
    const sp = spectra(d.meas, 260, d.as.keys), o = artOpts(d.n);
    A.sol = solveART(sp, o); A.cv = predictCV(sp, o); A.drift = predictDrift(A.sol, C.S, 1); A.n = d.n;
  } catch (e) { toast('ART 計算失敗：' + e.message, true); }
  A.busy = false; renderArt();
}

async function applyArt() {
  const S = C.S, a = S.room.art, sol = A.sol; if (!sol) return;
  try {
    toast('產生濾波器中…');
    await sleep(30);
    for (const sr of IR_RATES) {
      await api(`/api/eapo/file?name=${encodeURIComponent(`fono/art_hp_${sr}.wav`)}`, { method: 'POST', body: encodeWavFloat([mainsFIR(a.fc, a.tauMs / 1000, sr)], sr) });
      for (const k of sol.solvedKeys) await api(`/api/eapo/file?name=${encodeURIComponent(`fono/art_${k}_${sr}.wav`)}`, { method: 'POST', body: encodeWavFloat([firFor(sol, sol.keys.indexOf(k), sr, 1.0)], sr) });
    }
    a.preampDb = sol.preampDb; a.built = new Date().toISOString(); a.keys = [...sol.solvedKeys]; a.verify = null;
    a.report = { bands: ART_BANDS, before: A.cv.before, cv: A.cv.after, drift: A.drift.after, points: A.n, sources: { mains: sol.mainsKeys, helpers: sol.helperKeys },
      reg: sol.reg.bands.map(b => ({ f0: b.f0, f1: b.f1, lambda: b.lambda, capDb: b.capDb })), preampDb: sol.preampDb,
      headroom: sol.headroom.perSource.filter(x => x.solved).map(x => ({ key: x.key, peakDb: x.peakDb, f10: x.f10 })),
      preRing: sol.preRing ? Object.fromEntries(Object.entries(sol.preRing).map(([k, v]) => [k, { beforeDb: v.beforeDb, afterDb: v.afterDb }])) : null };
    S.room.mode = 'art';
    C.saveState(); await C.applyEapo(); C.syncAll(); A.verifyRes = null; renderArt();
    toast('ART 已套用，聆聽模式切到「ART 低頻」');
  } catch (e) { toast('套用失敗：' + (e.body?.detail || e.message), true); }
}

// ---- verification (point 6): re-measure 3 or 5 positions with ART on, compare the measured modal decay with the prediction
/** One sweep through the whole ART chain (the same mono sweep on both inputs; there is no timing beep, the beep would be part of the bass sum). */
async function measureArtOnce() {
  const stim = stimFor();
  stim.R = Float32Array.from(stim.L);
  const a = await measureAveraged({ sweeps: nSweeps(), stim, grab: () => playAndRecord(stim),
    gate: x => { if (x.snrDb < 15) throw new Error(`沒有收到足夠的聲音（訊噪比 ${x.snrDb.toFixed(0)} dB）。請確認擴大機已開機、麥克風放在原本的位置。`); },
    onSweep: (i, n) => { A.vmsg = `量測第 ${A.vpos + 1} 點（ART 已開啟）… 掃頻 ${i}/${n}，請保持安靜`; renderArt(); } });
  return a;
}
async function verifyArt() {
  const S = C.S, a = S.room.art, sol = A.sol;
  if (!a.built) return;
  if (!sol) { toast('請先按「計算」重新算出這組濾波器，才能和預測比較', true); return; }
  const pos = verifyPositions(A.vN), demo = !!window.__fonoDemo;
  A.vbusy = true; A.vmsg = ''; renderArt();
  try {
    const after = [];
    if (demo) {
      await sleep(400);
      simulateRemeasure(sol, pos).forEach(m => after.push(m));
    } else {
      if (S.room.mode !== 'art') { S.room.mode = 'art'; C.saveState(); await C.applyEapo(); C.syncAll(); await sleep(900); }
      for (let i = 0; i < pos.length; i++) {
        A.vmsg = `驗證 ${i + 1} / ${pos.length}：把麥克風放回第 ${pos[i] + 1} 點（${GRID15[pos[i]]}），放穩後按下面的按鈕開始量測。`; A.vpos = pos[i]; A.vwait = true; renderArt();
        await new Promise(res => { A.vresume = res; }); A.vwait = false; A.vmsg = `量測第 ${pos[i] + 1} 點（ART 已開啟）… 請保持安靜`; renderArt();
        after.push(await measureArtOnce());
      }
    }
    const sp = sol.spectra, before = pos.map(p => irBandT60(irFromSpec(systemSpectra(sol, p).before, sp.N), sp.sr)), predicted = pos.map(p => irBandT60(irFromSpec(systemSpectra(sol, p).after, sp.N), sp.sr));
    const meas = after.map(m => irBandT60(m.ir, m.sr));
    const rep = verifyReport({ before, after: meas, predicted, fc: a.fc });
    a.verify = { ...rep, when: new Date().toISOString(), simulated: demo, positions: pos.map(p => p + 1) };
    C.saveState();
  } catch (e) { toast('驗證失敗：' + e.message, true); }
  A.vbusy = false; A.vwait = false; renderArt();
}

const VERDICT = { improved: '有改善', nochange: '沒有明顯變化', worse: '變差了', unknown: '資料不足' };
function verifyText(v) {
  const pct = x => `${x > 0 ? '+' : ''}${Math.round(x)}%`;
  const head = v.verdict === 'improved' ? `驗證結果：有改善。低頻殘響時間實測平均${v.overallPct < 0 ? '縮短' : '變長'} ${Math.abs(Math.round(v.overallPct))}%（預測 ${pct(v.predictedPct)}）。`
    : v.verdict === 'nochange' ? `驗證結果：沒有明顯變化。實測殘響時間變動 ${pct(v.overallPct)}（預測 ${pct(v.predictedPct)}）。`
    : v.verdict === 'worse' ? `驗證結果：變差了。實測殘響時間 ${pct(v.overallPct)}（預測 ${pct(v.predictedPct)}），最差的頻帶 ${pct(v.worstBand)}。` : '驗證資料不足，無法判斷。';
  const tips = { remeasure: '先確認麥克風放回原本的位置、室溫和擺設沒變，再驗證一次。', gap: '預測和實測差很多：房間在量測後改變了（溫度、家具、門窗），或量測位置不準。',
    lambda: '把「自動正則化」開著，或重新計算並換成較保守的設定（較大的 λ 會讓濾波器更平緩、更耐變動）。', fc: '把交接頻率調低（例如 100 Hz 以下），只處理最有把握的低頻。', positions: '量測位置改用較少的 9 點，並確保每一點都放穩。' };
  return { head, tips: v.suggestions.map(k => tips[k]).filter(Boolean) };
}

function whatIsArt() {
  const li = (...t) => h('li', {}, ...t);
  return h('details', { class: 'art-explain', id: 'artExplain', open: A.exOpen ? '' : null, ontoggle: e => { A.exOpen = e.target.open; } }, h('summary', {}, '這是什麼？'),
    h('div', { class: 'art-explain-body' },
      h('h4', {}, '它做什麼'),
      h('p', {}, '小房間的低頻會在固定的頻率「嗡」一下並拖很久（駐波）。這個功能把幾顆喇叭到你耳邊的低頻都量下來，替每顆算一個濾波器，讓其中一部分喇叭（後方一對，或重低音）在恰當的時間放出相反的聲波，把前方喇叭激發出來的殘響吸掉。前方照常播音樂。'),
      h('h4', {}, '需要什麼'),
      h('ul', {}, li('至少一組「協助」的喇叭：後方一對（4.x 配置）或重低音（2.1／2.2、4.1／4.2）。2.0 和耳機用不到。'),
        li('一支量測麥克風，在聽音位置周圍量 9 或 15 個點（約 20 分鐘）。'), li('量測時房間要安靜，音量旋鈕和擺設不要動。')),
      h('h4', {}, '預期效果'),
      h('p', {}, '在模擬臥室（3.6 × 3.0 × 2.6 m）裡，用其他位置預測被留下的位置：40–63 Hz 的殘響時間約縮短 25–50%，80 Hz 以上變化不大，低頻起伏的平均誤差降到原來的三分之一左右。真實房間差異很大：牆面材質、家具、喇叭擺位都會影響，請以「驗證量測」的實測結果為準，不要只看預測。'),
      h('h4', {}, '限制'),
      h('ul', {}, li('只處理約 150 Hz 以下；再高的頻率位置稍動就會反效果。'),
        li('室溫變化會讓駐波頻率飄移（約每 6 °C 偏 1%），效果跟著打折；移動大型家具、開關門窗也一樣。'),
        li('需要安靜的房間量測；噪音會讓濾波器學到錯的東西。'),
        li('不會增加低頻延伸，也不會把深凹陷補平；為保護喇叭，單體低頻下限以下不會加大推力。')),
      h('h4', {}, '如何還原'),
      h('p', {}, '到「房間」把聆聽模式切回「立體聲」或「四聲道」即可立刻關閉；濾波器檔案保留，下次切回「ART 低頻」就會再用上。')));
}

function weightsEditor(n) {
  const a = C.S.room.art, w = (a.weights && a.weights.length ? a.weights : defaultWeights(n)).slice(0, n);
  while (w.length < n) w.push(1);
  const cells = w.map((v, p) => { const [c, r] = GRID_CELLS[p % GRID_CELLS.length]; const inp = h('input', { type: 'number', min: 0, max: 5, step: 0.1, value: v.toFixed(2), title: GRID15[p] || '', 'aria-label': `位置 ${p + 1}` });
    inp.onchange = () => { const nv = Math.max(0, Math.min(5, +inp.value || 0)); w[p] = nv; a.weights = w.slice(); C.saveState(); A.sol = null; renderArt(); };
    return h('label', { class: 'wt-c', style: `grid-column:${c + 1};grid-row:${r + 1}` }, h('em', {}, String(p + 1)), inp); });
  return h('details', { class: 'art-weights', open: A.wOpen ? '' : null, ontoggle: e => { A.wOpen = e.target.open; } }, h('summary', {}, '位置權重（預設：中間重、外圍輕）'),
    h('div', { class: 'wt-grid' }, ...cells),
    h('div', { class: 'wiz-actions', style: 'margin-top:8px' }, h('button', { class: 'btn', type: 'button', onclick: () => { a.weights = null; C.saveState(); A.sol = null; renderArt(); } }, '還原預設權重')),
    h('p', { class: 'hint' }, '權重越大，濾波器越照顧那個位置；排列和量測時的 3 × 5 位置圖一致（前三排水平面，後兩排高低）。0 = 完全不考慮。'));
}

function renderArt() {
  const box = $('#artBody'); if (!box) return;
  box.innerHTML = '';
  const S = C.S, a = S.room.art, d = artData(), as = d.as;
  box.append(whatIsArt());
  if (!as.ok) {
    box.append(h('div', { class: 'banner warn', id: 'artNeed4' }, '這個喇叭配置沒有可以協助的喇叭。需要後方一對（4.x）或重低音（2.1、2.2、4.1、4.2）才能使用。到「設定 → 喇叭配置」更換後即可。'));
    return;
  }
  const subs = as.keys.filter(k => k.startsWith('SW')), hasSubBass = subs.length >= 2 || (subs.length === 1 && as.keys.includes('SL'));
  const kn = (label, key, o) => knob({ label, size: 62, value: a[key], ...o, onInput: v => { a[key] = v; C.saveState(); A.sol = null; } }).el;
  const tg = (label, sub, key) => toggle({ label, sub, small: true, value: a[key] !== false, onInput: v => { a[key] = v; C.saveState(); A.sol = null; } }).el;
  box.append(
    h('p', { class: 'hint', style: 'margin-top:0' }, `參與的喇叭：${as.mains.join('、')}（播低頻）${as.helpers.length ? '＋ ' + as.helpers.join('、') + '（協助吸收）' : ''}。交接頻率以下由它們一起處理，其餘照常播放。`),
    subs.length && hasSubBass ? h('div', { class: 'field' }, h('span', {}, '低頻由誰播'), keys({ options: [{ id: 'mains', label: '前方主喇叭' }, { id: 'subs', label: '重低音' }], value: as.bass, onInput: v => { a.bass = v; C.saveState(); A.sol = null; renderArt(); } }).el) : null,
    h('div', { class: 'hp-row' },
      kn('交接頻率', 'fc', { min: 70, max: 160, step: 5, def: 120, fmt: v => v + ' Hz' }),
      kn('最大推力', 'capDb', { min: 6, max: 15, step: 1, def: 12, fmt: v => '+' + v + ' dB' }),
      kn('低頻下限', 'fLow', { min: 25, max: 60, step: 1, def: 35, fmt: v => v + ' Hz' }),
      tg('耐溫度變化設計', '同時照顧室溫 ±1% 的三種房間', 'robust'),
      tg('自動正則化', '每個頻帶用交叉驗證挑 λ 與推力上限', 'auto'),
      tg('保護喇叭', '低於各喇叭 −10 dB 點或訊噪比不足處不加大推力', 'headroom'),
      tg('限制預振鈴', '把主波峰之前的能量壓到 −30 dB 以下', 'preRing')),
    h('p', { class: 'hint' }, '最大推力越大低頻改善越多，但擴大機和單體要有餘裕。超過約 120 Hz 時，室溫一變就容易適得其反。'),
    d.n >= 9 ? weightsEditor(d.n) : null);
  if (window.__fonoDemo) box.append(h('div', { class: 'wiz-actions', style: 'margin-top:0' }, h('button', { class: 'btn', type: 'button', id: 'artDemoLoad', onclick: async () => {
    const { demoMeasurements } = await import('./demoroom.js');
    W.results = demoMeasurements({ subs: subSpk(C.S).length }); A.sol = null; renderArt(); toast('已載入模擬臥室（3.6 × 3.0 × 2.6 m）15 點量測');
  } }, '載入示範量測（模擬臥室 15 點）')));
  if (!d.ok) {
    box.append(h('div', { class: 'banner warn' }, `需要先在「一鍵校正」用 9 或 15 點量測這個配置的全部喇叭（${as.keys.join('、')}；目前 ${d.n} 點）。量測時室溫不要變、喇叭不要動。`));
  } else {
    box.append(h('div', { class: 'wiz-actions' },
      h('button', { class: 'btn primary', type: 'button', disabled: A.busy ? '' : null, onclick: computeArt }, A.busy ? '計算中…' : `計算（${d.n} 點）`),
      A.sol ? h('button', { class: 'btn primary', type: 'button', onclick: applyArt }, '套用 ART') : null));
  }
  const rep = A.sol ? { bands: ART_BANDS, before: A.cv.before, cv: A.cv.after, drift: A.drift.after } : a.report;
  if (rep) {
    const cell = (v, ref) => { const pct = ref ? Math.round((v / ref - 1) * 100) : 0; return h('td', { class: pct <= -10 ? 'good' : pct >= 5 ? 'bad' : '' }, `${Math.round(v)} ms` + (ref ? `（${pct > 0 ? '+' : ''}${pct}%）` : '')); };
    box.append(h('table', { class: 'modes-table art-table' },
      h('tr', {}, h('th', {}, '低頻殘響時間'), ...rep.bands.map(b => h('th', {}, b + ' Hz'))),
      h('tr', {}, h('td', {}, '校正前'), ...rep.before.map(v => cell(v))),
      h('tr', {}, h('td', {}, '預估：量測區域內'), ...rep.cv.map((v, i) => cell(v, rep.before[i]))),
      h('tr', {}, h('td', {}, '預估：室溫差 6 °C'), ...rep.drift.map((v, i) => cell(v, rep.before[i])))),
      h('p', { class: 'hint' }, '「量測區域內」：每一點都用其他點算出的濾波器來預測（不偷看答案）。「室溫差 6 °C」：模態頻率偏移 1% 時同一組濾波器的表現，比較接近日常。真正的效果請套用後用下面的「驗證量測」確認。'),
      artReportChart(rep));
    // chosen regularisation, headroom and pre-ring (what the solver decided)
    const R = A.sol ? { reg: A.sol.reg.bands, pre: A.sol.preampDb, head: A.sol.headroom.perSource.filter(x => x.solved), preRing: A.sol.preRing } : (a.report.reg ? { reg: a.report.reg, pre: a.report.preampDb, head: a.report.headroom, preRing: a.report.preRing } : null);
    if (R) {
      const auto = a.auto !== false;
      box.append(h('div', { class: 'art-detail', id: 'artDetail' },
        h('h3', { class: 'feat-h' }, auto ? '自動挑選的正則化' : '正則化（固定）'),
        h('table', { class: 'modes-table art-table' }, h('tr', {}, h('th', {}, '頻帶'), ...R.reg.map(b => h('th', {}, `${b.f0 < 25 ? 20 : b.f0}–${Math.round(b.f1)} Hz`))),
          h('tr', {}, h('td', {}, 'λ（相對）'), ...R.reg.map(b => h('td', {}, b.lambda >= 0.1 ? b.lambda.toFixed(1) : b.lambda.toExponential(0).replace('e-', 'e-')))),
          h('tr', {}, h('td', {}, '推力上限'), ...R.reg.map(b => h('td', {}, '+' + b.capDb + ' dB')))),
        h('p', { class: 'hint', id: 'artPreamp' }, `需要的前級衰減 ${(-R.pre).toFixed(1)} dB（讓每顆喇叭「直通＋低頻濾波器」的最壞情況不超過 0 dBFS）。` + R.head.map(x => ` ${x.key} 最大 ${x.peakDb >= 0 ? '+' : ''}${x.peakDb.toFixed(1)} dB${x.f10 ? `（−10 dB 點 ${Math.round(x.f10)} Hz，以下不加大）` : ''}`).join('；')),
        R.preRing ? h('p', { class: 'hint', id: 'artPre' }, '預振鈴（主波峰之前的能量，相對主波峰以後）：' + Object.entries(R.preRing).map(([k, v]) => `${k} ${v.beforeDb.toFixed(0)} → ${v.afterDb.toFixed(0)} dB`).join('；') + '。') : null));
    }
  }
  if (a.built) box.append(h('p', { class: 'hint' }, `已套用：${new Date(a.built).toLocaleString(locale(), { hour12: false })} · 前級 ${a.preampDb.toFixed(1)} dB（保留推力空間）。到「房間」把模式切回別的即可關閉。`));
  if (a.built || a.verify) box.append(verifyPanel());
}

function verifyPanel() {
  const a = C.S.room.art, v = a.verify, demo = !!window.__fonoDemo;
  const nK = keys({ options: [{ id: 3, label: '3 點' }, { id: 5, label: '5 點' }], value: A.vN, onInput: x => { A.vN = x; } });
  const root = h('div', { class: 'art-verify', id: 'artVerify' }, h('h3', { class: 'feat-h' }, '驗證量測'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '套用之後，在 ART 開啟的狀態下回到前幾個量測位置再量一次，用實測的低頻殘響時間和預測比較。' + (demo ? '示範模式沒有真的麥克風：結果是用預測加上 0.5% 的室溫變化和雜訊模擬出來的，僅供示範（模擬）。' : '')),
    h('div', { class: 'wiz-actions', style: 'margin-top:8px' }, nK.el,
      h('button', { class: 'btn primary', type: 'button', id: 'artVerifyBtn', disabled: A.vbusy || !a.built ? '' : null, onclick: verifyArt }, A.vbusy ? '驗證中…' : demo ? '驗證量測（模擬）' : '驗證量測')));
  if (A.vbusy && A.vmsg) root.append(h('div', { class: 'wiz-run' }, h('div', { class: 'wiz-dot' }), h('b', {}, A.vmsg)), A.vwait ? h('div', { class: 'wiz-actions' }, posDiagram(A.vpos, 15), h('button', { class: 'btn primary', type: 'button', onclick: () => { const r = A.vresume; A.vresume = null; r && r(); } }, '開始量測這一點')) : '');
  if (v) {
    const t = verifyText(v);
    root.append(
      h('div', { class: 'verdict ' + v.verdict, id: 'artVerdict' }, h('b', {}, VERDICT[v.verdict]), v.simulated ? h('span', { class: 'sim-tag' }, '模擬') : null, h('span', {}, ' ' + t.head)),
      v.simulated ? h('p', { class: 'hint sim-note' }, '這是示範模擬的結果，不是真的量測。') : null,
      t.tips.length ? h('ul', { class: 'hint' }, ...t.tips.map(x => h('li', {}, x))) : null,
      h('table', { class: 'modes-table art-table' }, h('tr', {}, h('th', {}, `殘響時間（${v.n} 點中位數）`), ...v.bands.map(b => h('th', {}, b + ' Hz'))),
        h('tr', {}, h('td', {}, '校正前'), ...v.before.map(x => h('td', {}, Number.isFinite(x) ? Math.round(x) + ' ms' : '—'))),
        h('tr', {}, h('td', {}, '預測'), ...v.predicted.map(x => h('td', {}, Number.isFinite(x) ? Math.round(x) + ' ms' : '—'))),
        h('tr', {}, h('td', {}, v.simulated ? '實測（模擬）' : '實測'), ...v.after.map((x, i) => { const pc = Number.isFinite(x) && Number.isFinite(v.before[i]) ? Math.round((x / v.before[i] - 1) * 100) : null; return h('td', { class: pc === null ? '' : pc <= -10 ? 'good' : pc >= 10 ? 'bad' : '' }, Number.isFinite(x) ? `${Math.round(x)} ms${pc === null ? '' : `（${pc > 0 ? '+' : ''}${pc}%）`}` : '—'); }))),
      artReportChart({ bands: v.bands, before: v.before, cv: v.after, drift: v.predicted, labels: ['預測', v.simulated ? '實測（模擬）' : '實測', '校正前'], title: '殘響時間 ms（驗證：實測與預測）' }));
  }
  return root;
}
