// 一鍵校正 (measure every speaker, fit EQ, delays and levels, verify) and FIR phase.
import { h, $, toast, api, css, drawGraph } from './ui.js';
import { keys, toggle, knob } from './widgets.js';
import { makeStimulus, analyseRecording, irToCurve, averageCurves, autoEQ, bandLevel } from './measure.js';
import { smooth, chainDb, encodeWavFloat, schroeder, logGrid } from './dsp.js';
import { excessPhaseFromIR, excessPhaseFromModel, designFIR, groupDelay } from './fir.js';
import { SPK, IR_RATES, alignDelays, activeSpk } from './eapo.js';
import { applyMicCal } from './acoustics.js';
import { locale } from './i18n.js';
import { artReportChart } from './lab2.js';
import { spectra, solveART, predictCV, predictDrift, firFor, mainsFIR, ART_BANDS } from './art.js';

let C; // { S, RT, saveState, applyEapo, syncAll }
const W = { step: 'setup', outputs: [], inputs: [], outId: '', inId: '', results: {}, running: false, log: [], verify: {} };
const COLORS = { FL: '#b08a5e', FR: '#7f9168', SL: '#6f8796', SR: '#a5705f' };
const SPK_NAME0 = { FL: '前左', FR: '前右', SL: '後左', SR: '後右' };
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

/** Play the stimulus on the chosen output and record the mic; returns {rec, offset, peakDb}. */
async function playAndRecord(stim) {
  const ctx = new AudioContext({ sampleRate: stim.sr, latencyHint: 'playback' });
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
    await sleep((stim.total / stim.sr + 0.9) * 1000);
    node.port.postMessage('stop');
    stream.getTracks().forEach(t => t.stop());
    await sleep(60);
    const n = chunks.reduce((a, c) => a + c.length, 0), rec = new Float32Array(n);
    let o = 0, pk = 0;
    for (const c of chunks) { rec.set(c, o); o += c.length; }
    for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(rec[i]));
    return { rec, offset: Math.round(startAt * stim.sr) - first, peakDb: 20 * Math.log10(pk + 1e-9) };
  } finally { ctx.close(); }
}

// ---------------------------------------------------------------- measuring
async function routeTo(ch, raw) {
  const r = C.S.room;
  W.saved = W.saved || { mode: r.mode, measureTarget: r.measureTarget, measureRaw: r.measureRaw };
  r.mode = 'measure'; r.measureTarget = ch; r.measureRaw = raw;
  await C.applyEapo();
  await sleep(900); // let Equalizer APO reload
}
async function restoreRouting() {
  if (!W.saved) return;
  Object.assign(C.S.room, W.saved); W.saved = null;
  await C.applyEapo(); C.syncAll();
}

async function measureOne(ch, raw) {
  await routeTo(ch, raw);
  const stim = makeStimulus(48000, { level: C.S.meas.level, sweepSec: 5.5 });
  const { rec, offset, peakDb } = await playAndRecord(stim);
  const a = analyseRecording(rec, stim, offset);
  a.curve = irToCurve(a.ir, a.sr, { peak: a.irPeak, windowMs: 300 });
  if (!W.calOff) a.curve = applyMicCal(a.curve, C.S.mic.cal?.[W.inId]);   // per-microphone calibration (lab: mic pairing / UMIK file)
  a.peakDb = peakDb;
  // no sound reached the mic: stop instead of "correcting" room noise
  if ((a.sweepGainDb != null && a.sweepGainDb < 3) || a.snrDb < 15) {
    const e = new Error(`${ch}（${SPK_NAME[ch] || ch}）沒有收到掃頻聲音（訊噪比 ${a.snrDb.toFixed(0)} dB${a.sweepGainDb != null ? `，掃頻時音量只比安靜時大 ${a.sweepGainDb.toFixed(1)} dB` : ''}）。請確認擴大機已開機、輸入選對、音量適中，麥克風對著喇叭，再重新量測。`);
    e.noSignal = true; throw e;
  }
  return a;
}

/** Mic pairing (lab): one raw sweep of `ch` recorded with input `inId`, without any stored calibration. */
export async function measureMicRaw(ch, inId) {
  if (W.running) throw new Error('量測進行中');
  W.running = true; const prev = W.inId; W.inId = inId; W.calOff = true;
  try { return (await measureOne(ch, true)).curve; }
  finally { W.inId = prev; W.calOff = false; await restoreRouting(); W.running = false; }
}

async function runAll() {
  if (W.running) return;
  W.running = true; W.results = {}; W.log = []; W.err = '';
  const act = activeSpk(C.S), chans = (C.S.meas.chans || SPK).filter(k => act.includes(k)), P = C.S.meas.positions;
  try {
    for (let p = 0; p < P; p++) {
      if (p > 0) {
        render(`位置 ${p + 1} / ${P}：${posHint(p, P)}放穩後按繼續。`, true);
        await new Promise(res => { W.resume = res; });
      }
      for (const ch of chans) {
        render(`位置 ${p + 1}/${P}：正在量測 ${ch}（${SPK_NAME[ch]}）… 請保持安靜`);
        const a = await measureOne(ch, true);
        (W.results[ch] = W.results[ch] || []).push(a);
        const warn = a.peakDb > -1 ? '（錄音削波，請調低麥克風增益或掃頻音量）' : a.snrDb < 40 ? '（訊噪比偏低）' : '';
        W.log.push(`${ch} 位置${p + 1}：到達 ${a.arrivalMs.toFixed(2)} ms · 訊噪比 ${a.snrDb.toFixed(0)} dB · 極性 ${a.polarity > 0 ? '正' : '反'} ${warn}`);
      }
    }
    await restoreRouting();
    compute();
    W.step = 'result';
  } catch (e) {
    await restoreRouting();
    toast('量測失敗：' + e.message, true);
    W.err = e.message; W.results = {};
    W.step = 'setup';
  } finally { W.running = false; render(); }
}

function compute() {
  const S = C.S, out = { chans: {} };
  const fs = Math.round(schroeder(S.dims.rt60, S.dims.L * S.dims.W * S.dims.H) / 10) * 10;
  const fmax = S.meas.fmax || Math.min(350, Math.max(200, fs + 30));
  for (const [ch, list] of Object.entries(W.results)) {
    const avg = averageCurves(list.map(x => x.curve));
    const eq = autoEQ(avg, { fmax, lfRise: S.meas.lfRise, maxFilters: S.meas.maxFilters, target: S.room.target || undefined });
    out.chans[ch] = {
      curve: avg, eq, level: bandLevel(smooth(avg, 6), 500, 2000),
      arrival: list[0].arrivalMs, polarity: list[0].polarity, snr: Math.min(...list.map(x => x.snrDb)),
    };
  }
  const t = { FL: 0, FR: 0, SL: 0, SR: 0 };
  for (const k of SPK) if (out.chans[k]) t[k] = out.chans[k].arrival;
  const act = activeSpk(S);
  if (act.length < 4) t.SL = t.SR = Math.max(t.FL, t.FR);   // 2.0: no rear pair, only the FL/FR time difference matters
  out.allFour = act.every(k => out.chans[k]);   // "all speakers of the layout"
  out.act = act;
  // Delays only make sense when every speaker was measured against the same reference.
  out.delays = out.allFour ? alignDelays(t, S.room.mode === 'quadB' ? 'quadB' : 'quadA') : Object.fromEntries(SPK.map(k => [k, S.room.ch[k].delay]));
  const refL = out.chans.FL?.level ?? Object.values(out.chans)[0]?.level ?? 0;
  out.gains = {};
  for (const [k, c] of Object.entries(out.chans)) {
    const rearOffset = (k === 'SL' || k === 'SR') && S.room.mode !== 'quadB' ? -6 : 0;
    out.gains[k] = Math.round((refL - c.level + rearOffset) * 2) / 2;
  }
  out.fmax = fmax;
  W.calc = out;
}

async function applyResults(sel) {
  const S = C.S, r = W.calc;
  for (const [k, c] of Object.entries(r.chans)) {
    if (sel.eq) S.room.ch[k].corr = { name: `自動校正 ${new Date().toLocaleString(locale(), { hour12: false })}`, filters: c.eq.filters, source: 'auto' };
    if (sel.delay && r.allFour) S.room.ch[k].delay = r.delays[k];
    if (sel.gain) S.room.ch[k].gain = Math.max(-24, Math.min(6, r.gains[k]));
    if (sel.pol && c.polarity < 0) S.room.ch[k].invert = true;
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
      render(`驗證：量測 ${ch}（已套用矯正）…`);
      const a = await measureOne(ch, false);
      W.verify[ch] = a.curve;
    }
  } catch (e) { toast('驗證失敗：' + e.message, true); }
  await restoreRouting();
  W.running = false; W.step = 'verify'; render();
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

function render(msg, waiting) {
  const box = $('#wizBody'); if (!box) return;
  box.innerHTML = '';
  const S = C.S;
  const steps = [['setup', '1 準備'], ['run', '2 量測'], ['result', '3 套用'], ['verify', '4 驗證']];
  const cur = W.running ? (W.step === 'verify' ? 'verify' : 'run') : W.step;
  box.append(h('div', { class: 'wiz-steps' }, ...steps.map(([id, t]) => h('span', { class: 'wiz-step' + (id === cur ? ' on' : '') }, t))));
  if (W.running) {
    box.append(h('div', { class: 'wiz-run' }, h('div', { class: 'wiz-dot' }), h('b', {}, msg || '量測中…')),
      waiting ? h('button', { class: 'btn primary', onclick: () => { const r = W.resume; W.resume = null; r && r(); } }, '繼續') : '',
      h('div', { class: 'wiz-log' }, ...W.log.map(l => h('div', {}, l))));
    return;
  }
  if (W.step === 'setup') {
    if (W.err) box.append(h('div', { class: 'banner', style: 'border-color:var(--bad)' }, '⚠ 上次量測沒有完成：' + W.err));
    const outSel = h('select', {}, ...W.outputs.map(d => h('option', { value: d.deviceId, selected: d.deviceId === W.outId ? '' : null }, d.label || d.deviceId)));
    outSel.onchange = () => { W.outId = outSel.value; S.meas.outId = W.outId; C.saveState(); };
    const inSel = h('select', {}, ...W.inputs.map(d => h('option', { value: d.deviceId, selected: d.deviceId === W.inId ? '' : null }, d.label || d.deviceId)));
    inSel.onchange = () => { W.inId = inSel.value; S.mic.deviceId = W.inId; C.saveState(); };
    const chK = h('div', { class: 'keys' }, ...activeSpk(S).map(k => { const on = (S.meas.chans || SPK).includes(k); const b = h('button', { class: 'key' + (on ? ' on' : ''), type: 'button' }, k); b.onclick = () => { const set = new Set(S.meas.chans || SPK); set.has(k) ? set.delete(k) : set.add(k); S.meas.chans = activeSpk(S).filter(x => set.has(x)); C.saveState(); render(); }; return b; }));
    const posK = keys({ options: [1, 3, 5, 9, 15].map(n => ({ id: n, label: n >= 9 ? `${n} 點（ART）` : `${n} 個位置` })), value: S.meas.positions, onInput: v => { S.meas.positions = v; C.saveState(); } });
    const lvl = knob({ label: '掃頻音量', min: -30, max: -3, step: 1, def: -12, size: 62, value: S.meas.level, fmt: v => v + ' dBFS', onInput: v => { S.meas.level = v; C.saveState(); } });
    const rise = knob({ label: '低頻抬升', min: 0, max: 6, step: 0.5, def: 2, size: 62, value: S.meas.lfRise, fmt: v => '+' + v + ' dB', onInput: v => { S.meas.lfRise = v; C.saveState(); } });
    box.append(
      h('div', { class: 'wiz-grid' },
        h('label', { class: 'field' }, h('span', {}, '播放裝置（選多聲道音效卡）'), outSel),
        h('label', { class: 'field' }, h('span', {}, '量測麥克風'), inSel),
        h('div', { class: 'field' }, h('span', {}, '要量的喇叭'), chK),
        h('div', { class: 'field' }, h('span', {}, '麥克風位置數（多點平均更準）'), posK.el)),
      h('div', { class: 'knob-row', style: 'margin-top:12px' }, lvl.el, rise.el),
      h('ol', { class: 'wiz-tips' },
        h('li', {}, '麥克風放在耳朵高度、朝天花板，用腳架或書固定。'),
        h('li', {}, '擴大機音量旋鈕放在平常聽的位置，量測期間不要動。'),
        h('li', {}, '每顆喇叭會播一聲短嗶（計時參考，固定由 FL 發出）和約 6 秒的掃頻。')),
      h('div', { class: 'wiz-actions' }, h('button', { class: 'btn primary big', onclick: () => { W.step = 'run'; runAll(); } }, '開始一鍵校正')));
    return;
  }
  if (W.step === 'result' && W.calc) {
    const r = W.calc;
    const rows = Object.entries(r.chans).map(([k, c]) => h('tr', {},
      h('td', { style: `color:${COLORS[k]}` }, h('b', {}, k)),
      h('td', {}, c.eq.filters.length + ' 個'), h('td', {}, `${c.eq.rmsBefore.toFixed(1)} → ${c.eq.rmsAfter.toFixed(1)} dB`),
      h('td', {}, `${c.arrival.toFixed(2)} ms`), h('td', {}, r.allFour ? `${r.delays[k].toFixed(2)} ms` : `—（需量全部${r.act.length === 4 ? '四' : '兩'}顆）`),
      h('td', {}, `${r.gains[k] > 0 ? '+' : ''}${r.gains[k].toFixed(1)} dB`),
      h('td', {}, c.polarity < 0 ? h('span', { style: 'color:var(--bad)' }, '反相！') : '正常'), h('td', {}, c.snr.toFixed(0) + ' dB')));
    const sel = { eq: true, delay: true, gain: true, pol: false };
    const tg = (k, label) => toggle({ label, small: true, value: sel[k], onInput: v => { sel[k] = v; } }).el;
    box.append(
      h('canvas', { class: 'graph', id: 'wizGraph', style: 'height:300px' }),
      h('table', { class: 'modes-table', style: 'margin-top:12px' },
        h('tr', {}, ...['聲道', '濾波器', '駐波誤差', '到達', '建議延遲', '建議增益', '極性', '訊噪比'].map(t => h('th', {}, t))), ...rows),
      h('p', { class: 'hint' }, `矯正範圍 ${Math.round(r.fLowAll || 20)}–${r.fmax} Hz（依房間尺寸算出的施羅德頻率）。只削峰不補凹陷；延遲依目前模式（${C.S.room.mode === 'quadB' ? 'B 同時到達' : 'A 後方晚 15 ms'}）計算。`),
      h('div', { class: 'wiz-actions' }, tg('eq', '套用 EQ'), tg('delay', '套用延遲'), tg('gain', '套用音量'), tg('pol', '自動反相（建議先檢查接線）'),
        h('button', { class: 'btn primary big', onclick: async () => { await applyResults(sel); W.step = 'applied'; render(); } }, '套用'),
        h('button', { class: 'btn', onclick: () => { W.step = 'setup'; render(); } }, '重新量測')));
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
  const chans = fr.chans.filter(k => activeSpk(S).includes(k));
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
  const chK = h('div', { class: 'keys' }, ...activeSpk(S).map(k => { const on = fr.chans.includes(k); const b = h('button', { class: 'key' + (on ? ' on' : ''), type: 'button' }, k); b.onclick = () => { fr.chans = on ? fr.chans.filter(x => x !== k) : activeSpk(S).filter(x => x === k || fr.chans.includes(x)); C.saveState(); renderFir(); }; return b; }));
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
const A = { sol: null, cv: null, drift: null, busy: false };
function artData() {
  const n = Math.min(...SPK.map(k => (W.results[k] || []).length));
  return { n, ok: n >= 9, meas: Object.fromEntries(SPK.map(k => [k, (W.results[k] || []).slice(0, n)])) };
}
function artOpts() { const a = C.S.room.art; return { fc: a.fc, capDb: a.capDb, fLow: a.fLow, tau: a.tauMs / 1000, state: C.S, robust: a.robust !== false }; }

async function computeArt() {
  const d = artData(); if (!d.ok) return;
  A.busy = true; renderArt();
  await sleep(30);
  try {
    const sp = spectra(d.meas, 260), o = artOpts();
    A.sol = solveART(sp, o); A.cv = predictCV(sp, o); A.drift = predictDrift(A.sol, C.S, 1);
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
      for (let i = 0; i < 4; i++) await api(`/api/eapo/file?name=${encodeURIComponent(`fono/art_${SPK[i]}_${sr}.wav`)}`, { method: 'POST', body: encodeWavFloat([firFor(sol, i, sr, 1.0)], sr) });
    }
    a.preampDb = sol.preampDb; a.built = new Date().toISOString();
    a.report = { bands: ART_BANDS, before: A.cv.before, cv: A.cv.after, drift: A.drift.after, points: artData().n };
    S.room.mode = 'art';
    C.saveState(); await C.applyEapo(); C.syncAll(); renderArt();
    toast('ART 已套用，聆聽模式切到「ART 低頻」');
  } catch (e) { toast('套用失敗：' + (e.body?.detail || e.message), true); }
}

function renderArt() {
  const box = $('#artBody'); if (!box) return;
  box.innerHTML = '';
  const S = C.S, a = S.room.art, d = artData();
  if (activeSpk(S).length < 4) { box.append(h('div', { class: 'banner warn', id: 'artNeed4' }, 'ART 需要前後四顆喇叭（4.0 配置）。到「設定 → 喇叭配置」改成 4.0 後才能使用。')); return; }
  const kn = (label, key, o) => knob({ label, size: 62, value: a[key], ...o, onInput: v => { a[key] = v; C.saveState(); A.sol = null; } }).el;
  box.append(
    h('p', { class: 'hint', style: 'margin-top:0' }, '像 Dirac Live ART 的做法：把四顆喇叭到你耳邊的低頻都量下來，解出每顆喇叭的濾波器，讓後方喇叭幫忙吸掉前方喇叭在房間裡造成的低頻殘響（駐波「嗡」的尾巴）。前方照常播音樂，後方只負責低頻。'),
    h('div', { class: 'hp-row' },
      kn('交接頻率', 'fc', { min: 70, max: 160, step: 5, def: 120, fmt: v => v + ' Hz' }),
      kn('最大推力', 'capDb', { min: 6, max: 15, step: 1, def: 12, fmt: v => '+' + v + ' dB' }),
      kn('低頻下限', 'fLow', { min: 25, max: 60, step: 1, def: 35, fmt: v => v + ' Hz' }),
      toggle({ label: '耐溫度變化設計', sub: '同時照顧室溫 ±1% 的三種房間', small: true, value: a.robust !== false, onInput: v => { a.robust = v; C.saveState(); A.sol = null; } }).el),
    h('p', { class: 'hint' }, '交接頻率以下由四顆喇叭一起處理。模擬顯示超過約 120 Hz 時，室溫一變就容易適得其反；最大推力越大低頻改善越多，但擴大機和單體要有餘裕。'));
  if (window.__fonoDemo) box.append(h('div', { class: 'wiz-actions', style: 'margin-top:0' }, h('button', { class: 'btn', type: 'button', id: 'artDemoLoad', onclick: async () => {
    const { demoMeasurements } = await import('./demoroom.js');
    W.results = demoMeasurements(); A.sol = null; renderArt(); toast('已載入模擬臥室（3.6 × 3.0 × 2.6 m）15 點量測');
  } }, '載入示範量測（模擬臥室 15 點）')));
  if (!d.ok) {
    box.append(h('div', { class: 'banner warn' }, `需要先在「一鍵校正」用 9 或 15 點量測全部四顆喇叭（目前 ${d.n} 點）。量測時室溫不要變、喇叭不要動。`));
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
      h('p', { class: 'hint' }, '「量測區域內」：每一點都用其他點算出的濾波器來預測（不偷看答案）。「室溫差 6 °C」：模態頻率偏移 1% 時同一組濾波器的表現，比較接近日常。真正的效果請套用後再用一鍵校正量一次比較。'),
      artReportChart(rep),
      a.built ? h('p', { class: 'hint' }, `已套用：${new Date(a.built).toLocaleString(locale(), { hour12: false })} · 前級 ${a.preampDb.toFixed(1)} dB（保留推力空間）。到「房間」把模式切回別的即可關閉。`) : null);
  }
}
