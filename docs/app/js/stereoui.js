// 「左右對稱」 tab of the measure page: L/R magnitude matching, per-band timing + FIR pair, phantom-centre check, placement geometry.
// The maths is in stereo.js (pure); this file is UI only.
import { h, toggle } from './widgets.js';
import { toast, css, drawGraph, api, setupCanvas } from './ui.js';
import { encodeWavFloat, smooth } from './dsp.js';
import { IR_RATES } from './eapo.js';
import { irToCurve, averageCurves } from './measure.js';
import { meanSnrCurve } from './avg.js';
import { excessPhaseFromIR } from './fir.js';
import { roomPos, planCanvas } from './lab2.js';
import { measureMono } from './wizard.js';
import { stereoOf, matchLR, bandTimeDiff, needsPhaseFix, designPhasePair, phantomCheck, geometry, PHASE_SPREAD_MS } from './stereo.js';
import { t, locale } from './i18n.js';

const head = (tag, title, en) => h('div', { class: 'ph' }, h('span', { class: 'tag' }, tag), h('h2', {}, title), en ? h('span', { class: 'en' }, en) : null, h('span', { class: 'rule' }));
const onTab = (id, fn) => document.addEventListener('fono-tab', e => { if (e.detail === id) fn(); });
const COL = { L: '#b08a5e', R: '#7f9168' };
const fmtHz = f => (f >= 1000 ? (f / 1000).toFixed(f % 1000 ? 2 : 0).replace(/0$/, '') + ' kHz' : Math.round(f) + ' Hz');
let demoCache = { key: '', res: null };

/** FL / FR (and a mono run) for the tab: the real measurements, or in the demo a synthetic full-band room. */
async function gather(getResults, S) {
  const res = (getResults() || {}), real = ['FL', 'FR'].every(k => res[k]?.[0]?.ir?.length && res[k][0].sr >= 8000);
  if (real) return { FL: res.FL, FR: res.FR, LR: res.LR?.[0]?.ir?.length ? res.LR : null, demo: false };
  if (!window.__fonoDemo) return { FL: null, FR: null, LR: null, demo: false };
  const P = roomPos(S), key = JSON.stringify([S.dims, P.FL, P.FR, P.seat, P.ear]);
  if (demoCache.key !== key) {
    const dr = await import('./demoroom.js'), m = dr.demoWideMeasurements(S.dims, P);
    demoCache = { key, res: { FL: m.FL, FR: m.FR, LR: [dr.demoMonoMeasurement(m.FL[0], m.FR[0])] } };
  }
  return { ...demoCache.res, demo: true };
}
const curveOf = x => x.curve || irToCurve(x.ir, x.sr, { peak: x.irPeak || 0, windowMs: 300 });
const maskOf = list => { const s = meanSnrCurve(list); return s ? { f: s.f, ok: s.snr.map(v => v >= 15) } : undefined; };

export function stereoPanel(ctx, getResults) {
  const S = ctx.S;
  const st = () => (S.room.stereo ||= {});
  const cur = () => stereoOf(S);
  let D = null, busy = false;   // D = last analysis
  const note = h('div', {});

  // ---------------------------------------------------------------- 1 magnitude
  const matchGraph = h('canvas', { class: 'graph', id: 'stereoMatchGraph', style: 'height:260px' });
  const matchList = h('div', { id: 'stereoMatchList' }), matchRead = h('p', { class: 'hint', id: 'stereoMatchRead' });
  const matchT = toggle({ label: '套用左右頻響配對', sub: '前左／前右各加幾個溫和的 PK，往兩者平均靠攏', value: cur().matchOn, onInput: async v => {
    st().matchOn = v;
    if (v && D?.match && !cur().match.FL.length && !cur().match.FR.length) storeMatch();
    ctx.saveState(); await ctx.applyEapo(); ctx.syncAll(); drawMatch();
  } });
  matchT.el.id = 'stereoMatchT';
  const num = (label, key, step, min, max) => {
    const i = h('input', { type: 'number', step, min, max, value: cur().band[key], style: 'width:84px', id: 'stereoBand_' + key });
    i.onchange = () => { const v = +i.value; if (v >= min && v <= max) { (st().band ||= {})[key] = v; ctx.saveState(); analyse(); } else i.value = cur().band[key]; };
    return h('label', { class: 'field' }, h('span', {}, label), i);
  };
  function storeMatch() { const m = D.match; st().match = { FL: m.filters.FL, FR: m.filters.FR }; }
  const recalcB = h('button', { class: 'btn', type: 'button', id: 'stereoMatchApply', onclick: async () => {
    if (!D?.match) { toast('還沒有前左／前右的量測', true); return; }
    storeMatch(); st().matchOn = true; matchT.set(true); ctx.saveState(); await ctx.applyEapo(); ctx.syncAll(); drawMatch(); toast('已套用左右頻響配對');
  } }, '計算並套用');
  function drawMatch() {
    const M = D?.match; matchList.innerHTML = ''; matchRead.textContent = '';
    if (!M) { drawGraph(matchGraph, { dmin: -10, dmax: 10, dstep: 5, curves: [] }); return; }
    const c = cur(), band = c.band, all = [...M.L, ...M.R];
    const mid = Math.round(all.reduce((a, b) => a + b, 0) / all.length), lo = Math.floor(Math.min(...all) - mid - 2), hi = Math.ceil(Math.max(...all) - mid + 2);
    const rel = a => a.map(v => v - mid), mk = (y, color, o = {}) => ({ f: M.f, db: rel(y), color, width: 1.8, ...o });
    drawGraph(matchGraph, { fmin: 100, fmax: 10000, dmin: lo, dmax: hi, dstep: Math.max(1, Math.round((hi - lo) / 8)), zero: false,
      curves: [mk(M.L, COL.L), mk(M.R, COL.R), mk(M.mean, css('--ink-3'), { dash: [5, 4], width: 1.4 }), mk(M.afterL, COL.L, { width: 1.1, dash: [2, 3] }), mk(M.afterR, COL.R, { width: 1.1, dash: [2, 3] })],
      bands: [{ f0: band.lo, f1: band.hi, color: css('--grid') }] });
    const stored = c.match, same = JSON.stringify(stored) === JSON.stringify({ FL: M.filters.FL, FR: M.filters.FR });
    for (const k of ['FL', 'FR']) {
      const fl = M.filters[k];
      matchList.append(h('table', { class: 'modes-table', style: 'margin-top:8px' }, h('tr', {}, h('th', {}, k), h('th', {}, '頻率'), h('th', {}, '增益'), h('th', {}, 'Q')),
        ...(fl.length ? fl.map(f => h('tr', {}, h('td', {}, 'PK'), h('td', {}, fmtHz(f.fc)), h('td', {}, (f.gain > 0 ? '+' : '') + f.gain.toFixed(1) + ' dB'), h('td', {}, f.q.toFixed(2)))) : [h('tr', {}, h('td', { colspan: 4 }, '不需要濾波器')) ])));
    }
    matchRead.textContent = t('左右差（150–8k Hz，已扣除整體音量差 {} dB）：') .replace('{}', M.levelOffsetDb.toFixed(1)) + `${M.rmsBefore.toFixed(2)} → ${M.rmsAfter.toFixed(2)} dB RMS（${t('減少')} ${(M.reduction * 100).toFixed(0)}%）` + ' · ' + (c.matchOn && same ? t('已套用') : c.matchOn ? t('已套用舊的結果，按「計算並套用」更新') : t('未套用'));
  }

  // ---------------------------------------------------------------- 2 time / phase
  const timeGraph = h('canvas', { class: 'graph', id: 'stereoTimeGraph', style: 'height:220px' }), timeRead = h('p', { class: 'hint', id: 'stereoTimeRead' });
  const llNote = h('p', { class: 'hint', 'data-ll-note': '', hidden: S.ui.lowLatency ? null : '' }, '低延遲模式開啟中：左右相位配對的 FIR 不會寫進 Equalizer APO；關閉低延遲模式才會套用。');
  const phaseT = toggle({ label: '左右相位配對（FIR）', sub: cur().phase.built ? `已建立 · 延遲 ${(+cur().phase.latencyMs).toFixed(0)} ms` : '尚未建立', value: cur().phaseOn && !!cur().phase.built, onInput: async v => {
    if (v && !cur().phase.built) { toast('請先按「建立相位 FIR」', true); phaseT.set(false); return; }
    st().phaseOn = v; ctx.saveState(); await ctx.applyEapo(); ctx.syncAll();
  } });
  phaseT.el.id = 'stereoPhaseT';
  const buildB = h('button', { class: 'btn', type: 'button', id: 'stereoPhaseBuild', onclick: async () => {
    const T = D?.time;
    if (!T) { toast('還沒有前左／前右的量測', true); return; }
    if (!needsPhaseFix(T)) { toast(`左右時間差隨頻率只差 ${T.spreadMs.toFixed(2)} ms（< ${PHASE_SPREAD_MS} ms），不需要 FIR`); return; }
    try {
      let lat = 0; const ph = cur().phase;
      for (const sr of IR_RATES) {
        const d = designPhasePair(T, { sr, taps48: ph.taps48 }); lat = d.latencyMs;
        for (const k of ['FL', 'FR']) await api(`/api/eapo/file?name=${encodeURIComponent(`fono/sym_${k}_${sr}.wav`)}`, { method: 'POST', body: encodeWavFloat([d[k]], sr) });
      }
      st().phase = { ...ph, built: new Date().toISOString(), latencyMs: lat, chans: ['FL', 'FR'], spreadMs: T.spreadMs }; st().phaseOn = true; phaseT.set(true);
      ctx.saveState(); await ctx.applyEapo(); ctx.syncAll(); toast(`已建立左右相位 FIR（延遲 ${lat.toFixed(0)} ms，其他聲道已自動補償）`);
    } catch (e) { toast('建立失敗：' + e.message, true); }
  } }, '建立相位 FIR');
  function drawTime() {
    const T = D?.time;
    if (!T) { drawGraph(timeGraph, { fmin: 80, fmax: 5000, dmin: -1, dmax: 1, dstep: 0.5, zero: true, curves: [] }); timeRead.textContent = ''; return; }
    const pr = D.pred, vals = T.bands.map(b => b.ms - T.meanMs), mx = Math.max(0.3, ...vals.map(Math.abs)), top = Math.ceil(mx * 5) / 5;
    const mk = (bands, color, o = {}) => ({ f: bands.map(b => b.f), db: bands.map(b => b.ms - T.meanMs), color, ...o });
    drawGraph(timeGraph, { fmin: 80, fmax: 5000, dmin: -top, dmax: top, dstep: top > 1 ? 0.5 : 0.1 * Math.max(1, Math.round(top / 0.5)), zero: true,
      curves: [mk(T.bands, css('--ink-3'), { width: 1.8 }), ...(pr ? [mk(pr.bands, css('--accent'), { width: 2.2 })] : [])],
      points: T.bands.map(b => ({ f: b.f, db: b.ms - T.meanMs, color: css('--ink-3') })) });
    timeRead.textContent = `${t('前左比前右晚到')} ${T.meanMs.toFixed(2)} ms（${t('這是單純的延遲，用「房間」頁的延遲補償')}）· ${t('隨頻率的變化')} ${T.spreadMs.toFixed(2)} ms${pr ? ` → ${t('預估殘留')} ${(pr.ratio * 100).toFixed(0)}%` : ''} · ${needsPhaseFix(T) ? t('超過 0.1 ms，建議建立 FIR') : t('小於 0.1 ms，不需要 FIR')}`;
  }

  // ---------------------------------------------------------------- 3 phantom centre
  const phGraph = h('canvas', { class: 'graph', id: 'stereoPhantomGraph', style: 'height:240px' }), phList = h('div', { id: 'stereoPhantomList' });
  const monoB = h('button', { class: 'btn primary', type: 'button', id: 'stereoMono', onclick: async () => {
    monoB.disabled = true;
    try { toast('左右同時播放掃頻中…請保持安靜'); await measureMono(); toast('單聲道量測完成'); await analyse(); }
    catch (e) { toast(e.cancelled ? '已取消' : '量測失敗：' + e.message, true); }
    monoB.disabled = false;
  } }, '左右同時（單聲道）量測');
  function drawPhantom() {
    phList.innerHTML = '';
    const P = D?.phantom;
    if (!P) { drawGraph(phGraph, { fmin: 100, fmax: 8000, dmin: -20, dmax: 10, dstep: 5, curves: [] }); phList.append(h('p', { class: 'hint' }, D?.FL ? '還沒有單聲道量測：按上面的按鈕，讓左右喇叭同時播放同一個掃頻（麥克風放在聽音位置）。' : '')); return; }
    const ref = P.power, rel = y => y.map((v, i) => v - ref[i]);
    drawGraph(phGraph, { fmin: 100, fmax: 8000, dmin: -24, dmax: 8, dstep: 4, zero: true,
      curves: [{ f: P.f, db: rel(P.complex), color: css('--ink-3'), width: 1.4, dash: [5, 4] }, { f: P.f, db: rel(P.measured), color: css('--accent'), width: 2.2 }],
      bands: P.cancel.map(c => ({ f0: c.f0, f1: c.f1, color: css('--grid') })) });
    if (!P.cancel.length) { phList.append(h('p', { class: 'hint', id: 'stereoPhantomOk' }, '幻象中央沒有明顯抵消：左右同時播放的聲音，和由兩顆各別量測預測的功率和一致（沒有哪個頻段低 6 dB 以上）。')); return; }
    phList.append(h('p', { class: 'hint' }, `${t('下列頻段的左右合成比功率和低超過 6 dB（實線為量測、虛線為由兩顆各別量測算出的複數和，0 dB 是功率和）：')}`),
      h('table', { class: 'modes-table' }, h('tr', {}, h('th', {}, '頻段'), h('th', {}, '最深'), h('th', {}, '可能原因')),
        ...P.cancel.map(c => h('tr', {}, h('td', {}, `${fmtHz(c.f0)} – ${fmtHz(c.f1)}`), h('td', {}, `−${c.depthDb.toFixed(0)} dB @ ${fmtHz(c.fc)}`),
          h('td', {}, c.explained ? '左右到達時間或反射不對稱（各別量測也預測得到）' : '單聲道量測比預測更差：檢查兩顆極性是否一致、兩次量測之間是否移動過麥克風')))));
  }

  // ---------------------------------------------------------------- 4 geometry
  const geoBox = h('div', { id: 'stereoGeo' });
  const plan = planCanvas(ctx, { stereo: () => true });
  function drawGeo() {
    const P = roomPos(S), g = geometry(P, S.dims), ok = (v, lim) => (v <= lim ? 'good' : 'warn');
    const row = (a, b, c, cls) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', { class: cls || '' }, c));
    geoBox.innerHTML = '';
    geoBox.append(h('table', { class: 'modes-table' },
      h('tr', {}, h('th', {}, '項目'), h('th', {}, '數值'), h('th', {}, '判讀')),
      row('到耳朵的距離 FL／FR', `${g.dist.FL.toFixed(2)} m／${g.dist.FR.toFixed(2)} m`, `${t('差')} ${g.diffCm.toFixed(0)} cm · ${g.diffMs.toFixed(2)} ms${g.nearer ? '，' + g.nearer + ' ' + t('較近') : ''}`, ok(g.diffCm, 3)),
      row('喇叭間距／聽音距離', `${g.spacing.toFixed(2)} m／${g.listen.toFixed(2)} m`, Math.abs(g.triangleDevPct) <= 15 ? t('接近正三角形') : `${t('與正三角形差')} ${Math.abs(g.triangleDevPct).toFixed(0)}%（${g.triangleDevPct > 0 ? t('間距偏寬') : t('間距偏窄')}）`, ok(Math.abs(g.triangleDevPct), 15)),
      row('離中線的角度 FL／FR', `${Math.abs(g.angle.FL).toFixed(0)}°／${Math.abs(g.angle.FR).toFixed(0)}°`, `${t('開角')} ${g.openingDeg.toFixed(0)}°（${t('常見建議 60°')}）`, ok(g.angleDiff, 3)),
      row('建議內八（FL／FR）', `${g.toe.FL.atHead.toFixed(0)}°／${g.toe.FR.atHead.toFixed(0)}°`, `${t('對準頭部；稍微對準頭後方約 30 cm 則是')} ${g.toe.FL.behind.toFixed(0)}°／${g.toe.FR.behind.toFixed(0)}°`, ''),
      row('離側牆 FL／FR', `${g.wall.FL.side.toFixed(2)} m／${g.wall.FR.side.toFixed(2)} m`, `${t('差')} ${g.sideDiffCm.toFixed(0)} cm`, ok(g.sideDiffCm, 20)),
      row('座位離兩顆中線', `${g.seatOffsetCm >= 0 ? '+' : ''}${g.seatOffsetCm.toFixed(0)} cm`, Math.abs(g.seatOffsetCm) <= 5 ? t('在中線上') : g.seatOffsetCm > 0 ? t('偏右') : t('偏左'), ok(Math.abs(g.seatOffsetCm), 5))));
    plan.draw();
  }

  // ---------------------------------------------------------------- analysis
  async function analyse() {
    if (busy) return; busy = true;
    try {
      const g = await gather(getResults, S);
      note.innerHTML = '';
      if (!g.FL) { D = null; note.append(h('p', { class: 'hint', id: 'stereoHint' }, '還沒有前左（FL）和前右（FR）的量測：先到「一鍵校正」量一次（2.0／2.1／2.2／4.x 都只用 FL／FR）。下面的擺位檢查不需要量測。')); }
      else {
        if (g.demo) note.append(h('p', { class: 'hint' }, '示範資料：用目前的房間尺寸與位置合成的前左／前右量測。實機請先做一次一鍵校正。'));
        const c = cur(), band = c.band, cl = averageCurves(g.FL.map(curveOf)), cr = averageCurves(g.FR.map(curveOf));
        const match = matchLR(cl, cr, { ...band, maskL: maskOf(g.FL), maskR: maskOf(g.FR) });
        let time = null, pred = null, phantom = null;
        try {
          const a = g.FL[0], b = g.FR[0];
          time = bandTimeDiff(excessPhaseFromIR(a.ir, a.sr), excessPhaseFromIR(b.ir, b.sr), (a.arrivalMs || 0) - (b.arrivalMs || 0));
          if (time.bands.length >= 3) pred = designPhasePair(time, { sr: 48000, taps48: c.phase.taps48 }).predicted;
        } catch (e) { time = null; }
        if (g.LR) { try { const n = Math.min(g.FL.length, g.FR.length, g.LR.length); phantom = phantomCheck(g.FL.slice(0, n), g.FR.slice(0, n), g.LR.slice(0, n)); } catch (e) { phantom = null; } }
        D = { FL: g.FL, match, time, pred, phantom };
      }
    } catch (e) { D = null; note.append(h('p', { class: 'hint' }, '分析失敗：' + e.message)); }
    busy = false;
    drawMatch(); drawTime(); drawPhantom(); drawGeo();
  }

  const root = h('div', { id: 'stereoPanel' },
    h('div', { class: 'panel' }, head('S', '左右聲道對稱校正', 'Stereo symmetry'),
      h('p', { class: 'hint', style: 'margin-top:0' }, '讓前左與前右在頻率、時間與位置上更像一對：中央的人聲才會穩穩站在兩顆喇叭正中間。順序建議：先調整擺位（最下面），再做頻響配對，最後視需要做相位配對。'), note),
    h('div', { class: 'panel' }, head('A', '左右頻響配對', 'Magnitude match'),
      h('p', { class: 'hint', style: 'margin-top:0' }, '把前左、前右的頻響（多個位置平均、1/6 oct 平滑、略過訊噪比不足的頻段）都往兩者的平均靠攏。每側最多幾個 PK，預設 ±4 dB、Q ≤ 3、150 Hz–8 kHz；整體音量差不在這裡處理（用一鍵校正的增益）。'),
      h('div', { class: 'graph-tools' }, matchT.el, recalcB), h('div', { class: 'graph-tools' }, num('下限 (Hz)', 'lo', 10, 80, 2000), num('上限 (Hz)', 'hi', 100, 2000, 16000), num('最大增減 (dB)', 'maxDb', 0.5, 1, 8), num('最大 Q', 'maxQ', 0.5, 0.7, 8)),
      matchGraph, h('p', { class: 'hint' }, '實線：前左（暖色）、前右（綠）；灰色虛線：兩者平均；細點線：套用後。'), matchRead, matchList),
    h('div', { class: 'panel' }, head('B', '左右相位配對', 'Time / phase match'),
      h('p', { class: 'hint', style: 'margin-top:0' }, '每個 1/3 oct 頻帶（100 Hz–4 kHz）算左右的到達時間差（激發相位的群延遲差）。若差距隨頻率變化超過 0.1 ms，可建立一對短的線性相位 FIR，左右各修正一半；預設關閉，會增加約 21 ms 延遲。'),
      h('div', { class: 'graph-tools' }, phaseT.el, buildB), llNote, timeGraph, h('p', { class: 'hint' }, '灰線：左右到達時間差（扣掉平均）；亮線：套用 FIR 後的預估。'), timeRead),
    h('div', { class: 'panel' }, head('C', '幻象中央檢查', 'Phantom centre'),
      h('p', { class: 'hint', style: 'margin-top:0' }, '左右喇叭同時播放同一個掃頻，把量到的合成，和由前左、前右各別量測預測的複數和與功率和比較。低於功率和 6 dB 以上的頻段表示左右互相抵消：通常是反射或到達時間不對稱。'),
      h('div', { class: 'graph-tools' }, monoB), phGraph, phList),
    h('div', { class: 'panel' }, head('D', '擺位檢查', 'Placement'),
      h('p', { class: 'hint', style: 'margin-top:0' }, '依平面圖上的座位與前左／前右位置計算。實線是座位到喇叭的距離與角度，虛線是建議的內八方向（對準頭後方約 30 cm）。拖曳平面圖上的「耳」與喇叭可以立刻看到變化。'),
      plan.cv, geoBox));
  const later = () => { if (root.offsetParent) { clearTimeout(later.t); later.t = setTimeout(analyse, 200); } };
  document.addEventListener('fono-pos', later); document.addEventListener('fono-dims', later);
  onTab('stereo', analyse);
  if (window.ResizeObserver) new ResizeObserver(() => { if (root.offsetParent) { drawMatch(); drawTime(); drawPhantom(); drawGeo(); } }).observe(root);
  return root;
}
