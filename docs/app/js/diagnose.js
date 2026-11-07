// Room diagnosis (phase 6, task C): a rule-based, ranked list of what is wrong with the room / setup, from the measurements.
// Pure logic, no DOM. diagnose(input) -> [{id, severity: 'high'|'mid'|'low'|'ok', title, detail, action, data}] (most severe first).
// Texts are zh-TW (the UI translates them through i18n/en.json like every other string).
//
// input = {
//   dims: {L, W, H, rt60}, pos: {seat:[x,y], ear, FL:[x,y,z], ...} (metres, x from the front wall, y from the left wall),
//   xover: Hz of the sub/mains crossover (default 80), maxFilters, maxCut,
//   bassSrcs: [[x,y,z],...] sources of the bass (default FL+FR) for the seat check,
//   chans: { FL: { arrival (ms), polarity (+1/-1), snr (dB), snrF ({f, snr[]} per-frequency SNR, optional), rep (dB, repeatability between sweeps, optional), peakDb, level (dB), curve:{f,db},
//                  refl: [{ms, db}], decay: [{fc, t30, t20}], eq: {filters, rmsAfter} } , ... }
// }
import { simpleModes, modePressure, firstReflections, seatSearch, decayTable } from './acoustics.js';
import { smooth, interpCurve } from './dsp.js';
import { bandLevel, averageCurves, irToCurve, autoEQ } from './measure.js';
import { meanSnrCurve } from './avg.js';
import { analyse } from './lab.js';
import { t, isEn } from './i18n.js';

/** Thresholds, exported so the tests (and the docs) quote the same numbers. */
export const TH = {
  levelDb: [0.75, 1.5, 3],          // |L - R| level difference: low / mid / high
  arrivalMs: [0.08, 0.2, 0.5],      // |L - R| arrival difference
  peakDb: [3, 5, 8],                // modal peak above the 200-1500 Hz level
  dipDb: [4, 6, 10],                // modal dip below it
  reflMs: 6, reflDb: -10, reflHighDb: -6,
  snrDb: [40, 30, 20],              // below 40 low, below 30 mid, below 20 high
  snrFreqDb: 15,                    // per-frequency SNR below this: the band is not trusted (no peak/dip, no EQ)
  repDb: 1.5,                       // repeatability between sweeps above this: unstable measurement
  clipDb: -1,
  subLevelDb: [1.5, 3, 6], subPhaseDeg: [30, 60, 100],
  decayRatio: [1.3, 1.5, 2],        // band T30 / median over the bands
  residualDb: [3, 4.5],             // EQ residual RMS: mid / high
  seatGain: [0.2, 0.4, 0.65],       // fraction of the 30-120 Hz unevenness a better seat would remove
  nodeP: 0.2, antiP: 0.8,           // |mode pressure| at the ear: below = node, above = antinode
};
const RANK = { high: 0, mid: 1, low: 2, ok: 3 };
const sev = (v, [lo, mid, hi]) => (v >= hi ? 'high' : v >= mid ? 'mid' : v >= lo ? 'low' : 'ok');
const sevLow = (v, [lo, mid, hi]) => (v < hi ? 'high' : v < mid ? 'mid' : v < lo ? 'low' : 'ok');   // for "lower is worse" (SNR)
const fin = Number.isFinite;
const med = a => { const v = a.filter(fin).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : NaN; };
const mean = a => { const v = a.filter(fin); return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN; };
/** Join already-built pieces: each piece is translated on its own (a run-time sentence made of several rules never matches one dictionary entry). */
const J = a => a.map(t).join(isEn() ? '; ' : '；');
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const MAINS = ['FL', 'FR', 'SL', 'SR'], SUBS = ['SW1', 'SW2'];
const seat3 = P => [P.seat[0], P.seat[1], P.ear ?? 1.1];
const item = (id, severity, title, detail, action, data = {}) => ({ id, severity, title, detail, action, data });

// ---------------------------------------------------------------- rules (each returns an item or null when it has no data)
function ruleLevel(c) {
  let worst = null;
  for (const [a, b] of [['FL', 'FR'], ['SL', 'SR']]) {
    if (!fin(c[a]?.level) || !fin(c[b]?.level)) continue;
    const d = Math.abs(c[a].level - c[b].level);
    if (!worst || d > worst.d) worst = { a, b, d, loud: c[a].level > c[b].level ? a : b };
  }
  if (!worst) return null;
  const s = sev(worst.d, TH.levelDb), { a, b, d, loud } = worst;
  return item('lr-level', s, `${a}／${b} 音量差 ${d.toFixed(1)} dB`,
    s === 'ok' ? '左右兩顆的 500–2000 Hz 音量一致，聲像不會偏。' : `${loud} 比另一側大聲，聲像會往 ${loud} 偏。`,
    s === 'ok' ? '' : `把 ${loud} 的增益降低 ${d.toFixed(1)} dB（一鍵校正會自動算出），並檢查兩顆喇叭是否同樣朝向耳朵。`,
    { a, b, diffDb: r2(d), louder: loud, score: d });
}
function ruleArrival(c) {
  let worst = null;
  for (const [a, b] of [['FL', 'FR'], ['SL', 'SR']]) {
    if (!fin(c[a]?.arrival) || !fin(c[b]?.arrival)) continue;
    const d = Math.abs(c[a].arrival - c[b].arrival);
    if (!worst || d > worst.d) worst = { a, b, d, early: c[a].arrival < c[b].arrival ? a : b };
  }
  if (!worst) return null;
  const s = sev(worst.d, TH.arrivalMs), { a, b, d, early } = worst, cm = Math.round(d * 34.3);
  return item('lr-arrival', s, `${a}／${b} 到達時間差 ${d.toFixed(2)} ms（約 ${cm} cm）`,
    s === 'ok' ? '兩顆到耳朵的距離幾乎相同。' : `${early} 的聲音先到，中央的人聲會往 ${early} 那邊偏。`,
    s === 'ok' ? '' : `在 ${early} 加上 ${d.toFixed(2)} ms 延遲（一鍵校正可自動套用），或把 ${early} 往後移約 ${cm} cm。`,
    { a, b, diffMs: r2(d), cm, early, score: d });
}
function rulePolarity(c) {
  const chs = Object.keys(c).filter(k => fin(c[k].polarity));
  if (!chs.length) return null;
  const bad = chs.filter(k => c[k].polarity < 0);
  return item('polarity', bad.length ? 'high' : 'ok', bad.length ? `${bad.join('、')} 極性反相` : '所有喇叭極性正確',
    bad.length ? '反相的喇叭會和其他喇叭互相抵消，低頻變薄、聲像空洞。' : '主脈衝方向一致，沒有接反。',
    bad.length ? `在${bad.join('、')}勾選「反相」，或檢查喇叭線正負極有沒有接反。` : '', { bad, score: bad.length * 100 });
}
/** Strongest low-frequency peak and dip (30-200 Hz, vs the 200-1500 Hz level), with the nearest room mode and what it does at the ear. */
function modeScan(c, P, dims) {
  const out = { peak: null, dip: null };
  for (const [ch, m] of Object.entries(c)) {
    if (!m.curve || SUBS.includes(ch)) continue;
    const sm = smooth(m.curve, 6), ref = bandLevel(sm, 200, 1500);
    for (let f = 30; f <= 200; f *= Math.pow(2, 1 / 12)) {
      if (m.snrF && interpCurve({ f: m.snrF.f, db: m.snrF.snr }, f) < TH.snrFreqDb) continue;   // drowned in room noise: neither a peak nor a dip
      const dev = interpCurve(sm, f) - ref;
      if (!out.peak || dev > out.peak.dev) out.peak = { ch, f, dev };
      if (!out.dip || dev < out.dip.dev) out.dip = { ch, f, dev };
    }
  }
  const modes = dims ? simpleModes(dims, 230) : [];
  for (const k of ['peak', 'dip']) {
    const x = out[k]; if (!x) continue;
    x.f = Math.round(x.f);
    const near = modes.filter(m => Math.abs(m.f / x.f - 1) < 0.07).sort((p, q) => Math.abs(p.f / x.f - 1) - Math.abs(q.f / x.f - 1))[0];
    if (near) { x.mode = near.n.join(','); x.modeHz = r1(near.f); if (P?.seat) x.pressure = r2(modePressure(near.n, seat3(P), dims)); }
  }
  return out;
}
function rulePeak(scan) {
  const x = scan.peak; if (!x) return null;
  const s = sev(x.dev, TH.peakDb);
  if (s === 'ok') return item('mode-peak', 'ok', '低頻沒有突出的峰', `30–200 Hz 最高的一處只比中頻高 ${x.dev.toFixed(1)} dB。`, '', { ...x, score: x.dev });
  const at = x.pressure == null ? '' : Math.abs(x.pressure) > TH.antiP ? `，而且耳朵剛好在波腹（壓力 ${x.pressure}），所以特別明顯` : Math.abs(x.pressure) < TH.nodeP ? '，但耳朵在這個模態的節點附近，所以聽到的比其他位置小' : `（耳朵位置的壓力 ${x.pressure}）`;
  return item('mode-peak', s, `${x.f} Hz 低頻峰 +${x.dev.toFixed(1)} dB`,
    x.mode ? `最接近 ${x.modeHz} Hz 的房間模態（${x.mode}）${at}。` : '附近沒有對應的房間模態，可能是喇叭與牆之間的反射疊加。',
    '用一鍵校正的自動 EQ 壓低這個峰（頻率與 Q 由量測決定）；也可以把喇叭或座位挪離這個模態的波腹。', { ...x, score: x.dev });
}
function ruleDip(scan) {
  const x = scan.dip; if (!x) return null;
  const d = -x.dev, s = sev(d, TH.dipDb);
  if (s === 'ok') return item('mode-dip', 'ok', '低頻沒有深的谷', `30–200 Hz 最低的一處只比中頻低 ${d.toFixed(1)} dB。`, '', { ...x, score: d });
  const at = x.pressure == null ? '' : Math.abs(x.pressure) < TH.nodeP ? `，耳朵剛好在節點（壓力 ${x.pressure}）` : `（耳朵位置的壓力 ${x.pressure}）`;
  return item('mode-dip', s, `${x.f} Hz 低頻谷 −${d.toFixed(1)} dB`,
    x.mode ? `最接近 ${x.modeHz} Hz 的房間模態（${x.mode}）${at}。` : '附近沒有對應的房間模態，多半是喇叭與牆之間的反射互相抵消。',
    'EQ 補不起來這種谷（硬補只會多耗功率）：改移動座位或喇叭，或在低頻加一顆低音喇叭。', { ...x, score: d });
}
function ruleSeat(P, dims, srcs) {
  if (!P?.seat || !dims || !srcs?.length) return null;
  const r = seatSearch(seat3(P), srcs, dims, dims.rt60);
  if (!r.rows.length) return null;
  const gain = r.here.v > 0 ? 1 - r.best.v / r.here.v : 0, s = sev(gain, TH.seatGain), off = Math.round(r.best.off * 100);
  const data = { gain: r2(gain), offCm: off, here: r2(Math.sqrt(r.here.v)), best: r2(Math.sqrt(r.best.v)), bestX: r2(r.best.x), score: gain * 10 };
  if (s === 'ok' || !off) return item('seat', 'ok', '座位的低頻起伏已接近最佳', `沿房間長度 ±60 cm 內，這裡的 30–120 Hz 起伏（${data.here} dB RMS）已經夠低。`, '', data);
  return item('seat', s, `座位${off > 0 ? '往後' : '往前'}移 ${Math.abs(off)} cm 可少 ${Math.round(gain * 100)}% 低頻起伏`,
    `30–120 Hz 起伏由 ${data.here} 降到 ${data.best} dB RMS（模態模型的預測，非量測值）。`,
    `把座位${off > 0 ? '往後' : '往前'}移 ${Math.abs(off)} cm（平面圖的熱圖會標出整個最佳區域）。`, data);
}
function ruleReflections(c, P, dims) {
  const rows = [];
  for (const [ch, m] of Object.entries(c)) for (const r of m.refl || []) {
    if (!(r.ms > 0.3 && r.ms <= TH.reflMs && r.db > TH.reflDb)) continue;
    const pred = P?.[ch] && P.seat && dims ? firstReflections(P[ch], seat3(P), dims).filter(p => p.ms > 0.05 && Math.abs(p.ms - r.ms) <= 0.3).sort((p, q) => Math.abs(p.ms - r.ms) - Math.abs(q.ms - r.ms))[0] : null;
    rows.push({ ch, ms: r2(r.ms), db: r1(r.db), surface: pred?.name || '', pt: pred ? pred.pt.map(r2) : null });
  }
  const have = Object.values(c).some(m => m.refl);
  if (!have) return null;
  if (!rows.length) return item('refl', 'ok', '6 ms 內沒有強的早期反射', '所有反射都比直達聲低 10 dB 以上。', '', { rows, score: 0 });
  rows.sort((p, q) => q.db - p.db);
  const top = rows[0], s = top.db > TH.reflHighDb ? 'high' : 'mid';
  const where = r => (r.pt ? `${r.surface}（距前牆 ${r.pt[0].toFixed(2)} m、距左牆 ${r.pt[1].toFixed(2)} m、高 ${r.pt[2].toFixed(2)} m）` : '來源不明');
  return item('refl', s, `${rows.length} 個早期反射高於 −10 dB（最強 ${top.db.toFixed(0)} dB @ ${top.ms.toFixed(1)} ms）`,
    rows.slice(0, 3).map(r => `${r.ch} ${r.ms.toFixed(2)} ms ${r.db.toFixed(0)} dB → ${t(where(r))}`).join(isEn() ? '; ' : '；'),
    top.pt ? `在${top.surface}的反射點貼吸音板或擴散板：距前牆 ${top.pt[0].toFixed(2)} m、距左牆 ${top.pt[1].toFixed(2)} m、高 ${top.pt[2].toFixed(2)} m（平面圖上的紅點）。` : '用鏡像法對照平面圖找出反射點，貼吸音板。',
    { rows, score: -top.db });
}
function ruleSnr(c) {
  const rows = Object.entries(c).filter(([, m]) => fin(m.snr)).map(([ch, m]) => ({ ch, snr: m.snr }));
  if (!rows.length) return null;
  const w = rows.reduce((p, q) => (q.snr < p.snr ? q : p)), s0 = sevLow(w.snr, TH.snrDb);
  // per-frequency view: bands below TH.snrFreqDb in 20-300 Hz, and the repeatability between sweeps
  const noisy = Object.entries(c).filter(([, m]) => m.snrF).map(([ch, m]) => {
    const fs = m.snrF.f.filter((f, i) => f >= 20 && f <= 300 && m.snrF.snr[i] < TH.snrFreqDb);
    return fs.length ? { ch, f0: Math.round(fs[0]), f1: Math.round(fs[fs.length - 1]), n: fs.length } : null;
  }).filter(Boolean);
  const rep = Object.entries(c).filter(([, m]) => fin(m.rep)).map(([ch, m]) => ({ ch, rep: r1(m.rep) })), unstable = rep.filter(x => x.rep > TH.repDb);
  const s = [s0, noisy.length ? 'mid' : 'ok', unstable.length ? 'mid' : 'ok'].reduce((p, q) => (RANK[q] < RANK[p] ? q : p));
  const extra = [];
  if (noisy.length) extra.push(...noisy.map(x => `${x.ch} 的 ${x.f0}–${x.f1} Hz 訊噪比低於 ${TH.snrFreqDb} dB（這段不做 EQ）`));
  if (unstable.length) extra.push(...unstable.map(x => `${x.ch} 掃頻之間重複性 ±${x.rep} dB（超過 ${TH.repDb} dB，量測時環境有變動）`));
  return item('snr', s, `最低訊噪比 ${w.snr.toFixed(0)} dB（${w.ch}）`,
    s === 'ok' ? '量測的訊噪比足夠，低頻細節不會被房間噪音蓋掉。' : (s0 === 'ok' ? '' : '訊噪比太低時，低頻曲線和衰減分析都不可靠。') + (extra.length ? J(extra) + t('。') : ''),
    s === 'ok' ? '' : '關掉冷氣、風扇與電腦風扇再量一次，或把掃頻音量調高 3–6 dB（注意不要削波），也可以把掃頻次數調到 4 次。', { rows, min: r1(w.snr), noisy, rep, score: 100 - w.snr + noisy.length * 5 + unstable.length * 5 });
}
function ruleClip(c) {
  const bad = Object.entries(c).filter(([, m]) => fin(m.peakDb) && m.peakDb > TH.clipDb).map(([k]) => k);
  if (!Object.values(c).some(m => fin(m.peakDb))) return null;
  return item('clip', bad.length ? 'mid' : 'ok', bad.length ? `${bad.join('、')} 錄音削波` : '錄音沒有削波', bad.length ? '削波會產生假的諧波，曲線會失真。' : '', bad.length ? '調低麥克風增益或掃頻音量後重量。' : '', { bad, score: bad.length * 100 });
}
function ruleSub(c, xover = 80) {
  const subs = SUBS.filter(k => c[k]?.curve), mains = ['FL', 'FR'].filter(k => c[k]?.curve);
  if (!subs.length || !mains.length) return null;
  const band = k => bandLevel(smooth(c[k].curve, 3), xover / 1.4, xover * 1.4);
  const dLevel = mean(subs.map(band)) - mean(mains.map(band));
  const arr = k => c[k].arrival, dt = mean(subs.map(arr)) - mean(mains.map(arr));
  let phase = fin(dt) ? ((360 * xover * dt / 1000) % 360 + 540) % 360 - 180 : NaN;
  const sl = sev(Math.abs(dLevel), TH.subLevelDb), sp = fin(phase) ? sev(Math.abs(phase), TH.subPhaseDeg) : 'ok';
  const s = RANK[sl] <= RANK[sp] ? sl : sp;
  const bits = [`低音喇叭比主喇叭在 ${Math.round(xover)} Hz 附近${dLevel >= 0 ? '大' : '小'} ${Math.abs(dLevel).toFixed(1)} dB`];
  if (fin(phase)) bits.push(`到達時間差 ${dt.toFixed(2)} ms（交越點相位差約 ${Math.abs(Math.round(phase))}°）`);
  const act = [];
  if (RANK[sl] < 3) act.push(`把低音喇叭的增益${dLevel > 0 ? '降低' : '調高'} ${Math.abs(dLevel).toFixed(1)} dB`);
  if (RANK[sp] < 3) act.push(`低音喇叭的延遲${dt > 0 ? '減少' : '增加'} ${Math.abs(dt).toFixed(2)} ms，或試試反相`);
  return item('sub', s, s === 'ok' ? `低音喇叭與主喇叭在 ${Math.round(xover)} Hz 銜接良好` : `低音喇叭與主喇叭在 ${Math.round(xover)} Hz 銜接不良`, J(bits) + t('。'),
    J(act) + (act.length ? t('（量測頁的自動對齊會幫你算）。') : ''), { xover, levelDb: r1(dLevel), dtMs: r2(dt), phaseDeg: fin(phase) ? Math.round(phase) : null, score: Math.max(Math.abs(dLevel) / 3, Math.abs(phase || 0) / 30) });
}
function ruleDecay(c) {
  const bands = new Map();
  for (const m of Object.values(c)) for (const r of m.decay || []) { const t = fin(r.t30) ? r.t30 : r.t20; if (fin(t)) (bands.get(r.fc) || bands.set(r.fc, []).get(r.fc)).push(t); }
  if (bands.size < 3) return null;
  const rows = [...bands].map(([fc, a]) => ({ fc, t: mean(a) })).sort((p, q) => p.fc - q.fc), m0 = med(rows.map(r => r.t));
  const w = rows.reduce((p, q) => (q.t > p.t ? q : p)), ratio = w.t / m0, s = sev(ratio, TH.decayRatio);
  const hz = w.fc >= 1000 ? w.fc / 1000 + ' kHz' : w.fc + ' Hz';
  return item('decay', s, s === 'ok' ? '各頻段的殘響時間均勻' : `${hz} 的殘響比其他頻段長 ${ratio.toFixed(1)} 倍`,
    `${hz} 的 T30 是 ${w.t.toFixed(2)} s，各頻段的中位數是 ${m0.toFixed(2)} s。`,
    s === 'ok' ? '' : w.fc <= 250 ? '低頻殘響拖長：在房間轉角放低頻吸音（厚吸音棉、低頻陷阱），或用 ART 低頻主動校正。' : '中高頻殘響偏長：加地毯、厚窗簾或牆面吸音板。', { rows: rows.map(r => ({ fc: r.fc, t: r2(r.t) })), median: r2(m0), ratio: r2(ratio), score: ratio });
}
function ruleLimits(c, maxFilters = 8, maxCut = -15) {
  const rows = Object.entries(c).filter(([, m]) => m.eq).map(([ch, m]) => {
    const f = m.eq.filters || [];
    return { ch, n: f.length, full: f.length >= maxFilters, cut: f.some(x => x.gain <= maxCut + 0.5), rms: m.eq.rmsAfter };
  });
  if (!rows.length) return null;
  const hit = rows.filter(r => r.full || r.cut), resid = rows.filter(r => fin(r.rms) && r.rms >= TH.residualDb[0]);
  const s = resid.some(r => r.rms >= TH.residualDb[1]) ? 'high' : hit.length || resid.length ? 'mid' : 'ok';
  const reasons = [...hit.filter(r => r.full).map(r => `${r.ch} 用滿了 ${maxFilters} 個濾波器`), ...hit.filter(r => r.cut).map(r => `${r.ch} 有濾波器碰到 ${maxCut} dB 的下限`), ...resid.map(r => `${r.ch} 校正後仍有 ${r.rms.toFixed(1)} dB RMS 的起伏`)];
  return item('limits', s, s === 'ok' ? '自動 EQ 沒有碰到限制' : '自動 EQ 碰到限制', s === 'ok' ? '濾波器數量與深度都在範圍內。' : J(reasons) + t('。'),
    s === 'ok' ? '' : '增加濾波器數量，或先用物理方法（移動座位／喇叭、加吸音）減少問題，EQ 只修得了峰、補不了谷。', { rows, score: resid.length + hit.length });
}

/** Run every rule; rules without data are left out. Sorted by severity, then by magnitude. */
export function diagnose(input) {
  const c = input.chans || {}, P = input.pos, dims = input.dims;
  const scan = modeScan(c, P, dims);
  const bass = input.bassSrcs || (P && P.FL && P.FR ? [P.FL, P.FR] : null);
  const out = [ruleLevel(c), ruleArrival(c), rulePolarity(c), rulePeak(scan), ruleDip(scan), ruleSeat(P, dims, bass), ruleReflections(c, P, dims),
    ruleSnr(c), ruleClip(c), ruleSub(c, input.xover), ruleDecay(c), ruleLimits(c, input.maxFilters, input.maxCut)].filter(Boolean);
  return out.map((x, i) => ({ x, i })).sort((p, q) => RANK[p.x.severity] - RANK[q.x.severity] || (q.x.data.score || 0) - (p.x.data.score || 0) || p.i - q.i).map(o => o.x);
}

// ---------------------------------------------------------------- building the input from the app's measurements
/** Per-channel analysis of wizard results ({ch: [measurement,...]}) for diagnose(): curve, reflections, decay, auto-EQ. */
export function inputFromResults(res, S, P, { eq = true } = {}) {
  const chans = {};
  for (const [ch, list] of Object.entries(res || {})) {
    const m = list && list[0]; if (!m || !m.ir || !m.ir.length || !(m.sr >= 8000)) continue;
    const curves = list.map(x => x.curve || irToCurve(x.ir, x.sr, { peak: x.irPeak || 0, windowMs: 300 })), curve = averageCurves(curves);
    let pk = 0, pv = 0; const lim = Math.min(m.ir.length, Math.round(0.03 * m.sr) + (m.irPeak | 0));
    for (let i = 0; i < lim; i++) { const a = Math.abs(m.ir[i]); if (a > pv) { pv = a; pk = i; } }
    const dec = decayTable(m.ir, m.sr).map(r => ({ fc: r.fc, t30: r.t30, t20: r.t20 }));
    const sf = meanSnrCurve(list), reps = list.map(x => x.rep?.maxStd).filter(fin);
    const o = {
      snrF: sf || undefined, rep: reps.length ? Math.max(...reps) : undefined,
      arrival: m.arrivalMs, polarity: m.polarity ?? Math.sign(m.ir[pk] || 1), snr: list.some(x => fin(x.snrDb)) ? Math.min(...list.map(x => x.snrDb).filter(fin)) : undefined,
      peakDb: list.some(x => fin(x.peakDb)) ? Math.max(...list.map(x => x.peakDb).filter(fin)) : undefined,
      level: bandLevel(smooth(curve, 6), 500, 2000), curve, refl: analyse(m).rows, decay: dec,
    };
    if (eq) { const e = autoEQ(curve, { maxFilters: S.meas?.maxFilters || 8, lfRise: S.meas?.lfRise ?? 2, target: S.room?.target || undefined, mask: sf ? { f: sf.f, ok: sf.snr.map(v => v >= TH.snrFreqDb) } : undefined }); o.eq = { filters: e.filters, rmsAfter: e.rmsAfter, rmsBefore: e.rmsBefore }; }
    chans[ch] = o;
  }
  return { dims: S.dims, pos: P, xover: S.room?.sub?.xover || S.room?.xover, maxFilters: S.meas?.maxFilters || 8, maxCut: -15, chans };
}

// ---------------------------------------------------------------- self-contained HTML report
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LINE = ['#8a6a3f', '#5b7a4a', '#4f7384', '#9c7a2a', '#7a5f86', '#96584a'];

/** Inline SVG of {name, f, db} curves on a log-frequency axis (20 Hz - 20 kHz, auto dB range around the median). */
export function curveSvg(curves, { w = 720, h = 260, fmin = 20, fmax = 20000, title = '' } = {}) {
  const pad = { l: 40, r: 10, t: 14, b: 22 }, all = curves.flatMap(c => c.db.filter((_, i) => c.f[i] >= 100 && c.f[i] <= 2000));
  const mid = all.length ? Math.round(med(all) / 5) * 5 : 0, dmin = mid - 30, dmax = mid + 20;
  const X = f => pad.l + Math.log(f / fmin) / Math.log(fmax / fmin) * (w - pad.l - pad.r), Y = d => pad.t + (1 - (Math.min(dmax, Math.max(dmin, d)) - dmin) / (dmax - dmin)) * (h - pad.t - pad.b);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" font-family="sans-serif" font-size="10">`;
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) s += `<line x1="${X(f).toFixed(1)}" x2="${X(f).toFixed(1)}" y1="${pad.t}" y2="${h - pad.b}" stroke="#d8d2c8"/><text x="${X(f).toFixed(1)}" y="${h - 7}" text-anchor="middle" fill="#7a746a">${f >= 1000 ? f / 1000 + 'k' : f}</text>`;
  for (let d = dmin; d <= dmax; d += 10) s += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(d).toFixed(1)}" y2="${Y(d).toFixed(1)}" stroke="#d8d2c8"/><text x="${pad.l - 5}" y="${(Y(d) + 3).toFixed(1)}" text-anchor="end" fill="#7a746a">${d}</text>`;
  curves.forEach((c, k) => {
    const pts = c.f.map((f, i) => (f >= fmin && f <= fmax ? `${X(f).toFixed(1)},${Y(c.db[i]).toFixed(1)}` : '')).filter(Boolean);
    s += `<polyline fill="none" stroke="${LINE[k % LINE.length]}" stroke-width="1.6" points="${pts.join(' ')}"/>`;
    s += `<text x="${pad.l + 6 + k * 52}" y="${pad.t + 10}" fill="${LINE[k % LINE.length]}" font-weight="700">${esc(c.name)}</text>`;
  });
  return s + '</svg>';
}
/** Inline SVG of a seat heatmap (see acoustics.seatHeatmap); `colorAt(t)` maps 0..1 to a css colour. */
export function heatSvg(map, dims, seat, { w = 360, colorAt = t => `hsl(${Math.round(110 - 110 * t)},35%,55%)` } = {}) {
  const sc = w / dims.W, h = dims.L * sc, lo = Math.sqrt(map.min), hi = Math.max(lo + 1, Math.sqrt(map.max)), k = Math.max(1, Math.round(map.nx / 45));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h.toFixed(0)}" width="${w}" height="${h.toFixed(0)}" role="img" font-family="sans-serif" font-size="10"><rect width="${w}" height="${h.toFixed(0)}" fill="none" stroke="#9a9488"/>`;
  for (let ix = 0; ix < map.nx; ix += k) for (let iy = 0; iy < map.ny; iy += k) {
    const t = (Math.sqrt(map.v[ix * map.ny + iy]) - lo) / (hi - lo);
    s += `<rect x="${((map.y0 + iy * map.step - map.step * k / 2) * sc).toFixed(1)}" y="${((map.x0 + ix * map.step - map.step * k / 2) * sc).toFixed(1)}" width="${(map.step * k * sc + 0.5).toFixed(1)}" height="${(map.step * k * sc + 0.5).toFixed(1)}" fill="${colorAt(Math.min(1, Math.max(0, t)))}"/>`;
  }
  if (seat) s += `<circle cx="${(seat[1] * sc).toFixed(1)}" cy="${(seat[0] * sc).toFixed(1)}" r="6" fill="#222" stroke="#fff"/>`;
  s += `<circle cx="${(map.best.y * sc).toFixed(1)}" cy="${(map.best.x * sc).toFixed(1)}" r="7" fill="none" stroke="#222" stroke-dasharray="3 2"/>`;
  return s + '</svg>';
}
const SEV_NAME = { high: '嚴重', mid: '中等', low: '輕微', ok: '正常' };
const SEV_COL = { high: '#b4654e', mid: '#c7a25e', low: '#8a8f78', ok: '#66784c' };

/**
 * One self-contained HTML document (inline CSS + SVG, no scripts) with the ranked list and the curves.
 * opt: {t (translate, default identity), lang, date, dims, curves:[{name,f,db}], heat:{map, seat}, title}
 */
export function reportHtml(items, opt = {}) {
  const t = opt.t || (x => x), d = opt.dims;
  const rows = items.map(x => `<li class="it ${x.severity}"><span class="chip" style="--c:${SEV_COL[x.severity]}">${esc(t(SEV_NAME[x.severity]))}</span><div><h3>${esc(t(x.title))}</h3><p>${esc(t(x.detail))}</p>${x.action ? `<p class="act"><b>${esc(t('建議'))}</b> ${esc(t(x.action))}</p>` : ''}</div></li>`).join('');
  const counts = ['high', 'mid', 'low', 'ok'].map(k => `${t(SEV_NAME[k])} ${items.filter(x => x.severity === k).length}`).join(' · ');
  return `<!doctype html><html lang="${opt.lang || 'zh-TW'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t(opt.title || '房間診斷報告'))}</title>
<style>body{font:14px/1.6 system-ui,sans-serif;background:#f4f1ea;color:#2a2722;margin:0;padding:24px}main{max-width:820px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#7a746a;border-bottom:1px solid #cfc8bb;padding-bottom:4px;margin:26px 0 10px}
.meta{color:#7a746a;font-size:12.5px}ol{list-style:none;margin:0;padding:0}.it{display:flex;gap:12px;background:#fbf9f4;border:1px solid #d8d2c8;border-left:3px solid var(--c,#999);padding:10px 12px;margin:0 0 8px}.chip{flex:none;align-self:flex-start;min-width:52px;text-align:center;font-size:11px;font-weight:700;padding:2px 6px;border:1px solid var(--c);color:var(--c);box-shadow:inset 3px 0 0 var(--c)}
.it h3{margin:0;font-size:14px}.it p{margin:2px 0 0;color:#4a463f}.act{color:#2a2722}svg{max-width:100%;height:auto;background:#fbf9f4;border:1px solid #d8d2c8}</style></head><body><main>
<h1>${esc(t(opt.title || '房間診斷報告'))}</h1><div class="meta">${esc(opt.date || '')}${d ? ` · ${esc(t('房間'))} ${d.L} × ${d.W} × ${d.H} m, RT60 ${d.rt60} s` : ''} · ${esc(counts)}</div>
<h2>${esc(t('診斷結果'))}</h2><ol>${rows}</ol>
${opt.curves?.length ? `<h2>${esc(t('頻率響應'))}</h2>${curveSvg(opt.curves, { title: t('頻率響應') })}` : ''}
${opt.heat ? `<h2>${esc(t('座位低頻起伏熱圖'))}</h2>${heatSvg(opt.heat.map, d, opt.heat.seat)}<p class="meta">${esc(t('顏色越暖，30–120 Hz 的起伏越大；虛線圈是預測最佳位置，黑點是目前座位。'))}</p>` : ''}
</main></body></html>`;
}
