// Lab 2 (phase 5, task 5): floor plan + reflections + room modes at the seat, decay analysis + waterfall,
// target-curve editor, microphone pairing, equal-loudness compensation, ART report chart.
// The maths lives in acoustics.js / iso226.js (no DOM); this file is UI only.
import { h, toggle, keys, knob } from './widgets.js';
import { toast, setupCanvas, css, drawGraph } from './ui.js';
import { chainDb, interpCurve } from './dsp.js';
import { SPK } from './eapo.js';
import { analyse } from './lab.js';
import {
  decayTable, csd, firstReflections, matchPeaks, simpleModes, modePressure, seatSearch,
  nodesAt, defaultTarget, TARGET_PRESETS, cleanNodes, parseCalText, seatHeatmap, heatAt, bestArea,
} from './acoustics.js';
import { diagnose, inputFromResults, reportHtml } from './diagnose.js';
import { smooth } from './dsp.js';
import { t, getLang, locale } from './i18n.js';
import { fitLoudness, loudDiff } from './iso226.js';

const head = (tag, title, en, lab) => h('div', { class: 'ph' }, h('span', { class: 'tag' }, tag), h('h2', {}, title), en ? h('span', { class: 'en' }, en) : null, lab ? h('span', { class: 'lab-tag' }, '實驗') : null, h('span', { class: 'rule' }));
const logArr = (lo, hi, n) => Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, i / (n - 1)));
/** Measure-page tab switch (app.js dispatches fono-tab): run fn when tab `id` opens. */
const onTab = (id, fn) => document.addEventListener('fono-tab', e => { if (e.detail === id) fn(); });
const onResize = (el, fn) => { if (window.ResizeObserver) new ResizeObserver(fn).observe(el); };
const select = (opts, value, onchange) => {
  const s = h('select', {}, ...opts.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) ? '' : null }, t)));
  s.onchange = () => onchange(s.value); return s;
};

// ---------------------------------------------------------------- measurement data (real or demo room)
let demoCache = null, demoKey = '';
async function results(getResults, S) {
  const res = getResults() || {};
  // real measurements are 48 kHz; the 1024 Hz set is the ART demo's low-frequency model and is useless for decay / reflections
  if (Object.values(res).some(l => l && l[0] && l[0].ir && l[0].ir.length && l[0].sr >= 8000)) return { res, demo: false };
  if (window.__fonoDemo) {
    // full-band (48 kHz) synthetic room for the *current* dimensions and positions, so every octave band
    // shows in the decay tab and the reflection peaks line up with the floor-plan prediction
    const P = roomPos(S), key = JSON.stringify([S.dims, SPK.map(k => P[k]), P.seat, P.ear]);
    if (key !== demoKey || !demoCache) { demoCache = (await import('./demoroom.js')).demoWideMeasurements(S.dims, P); demoKey = key; }
    return { res: demoCache, demo: true };
  }
  return { res: {}, demo: false };
}
const channelsOf = res => SPK.filter(k => res[k] && res[k][0] && res[k][0].ir && res[k][0].ir.length);
const demoNote = demo => (demo ? h('p', { class: 'hint' }, '示範資料：模擬臥室 3.6 × 3.0 × 2.6 m 的量測（48 kHz 全頻段，用目前的房間尺寸與位置合成）。實機請先做一次一鍵校正。') : null);

// ---------------------------------------------------------------- positions (shared by floor plan, reflections, modes)
const EAR = 1.1;
export function roomPos(S) {
  const d = S.dims, r = S.room, P = r.pos || (r.pos = {});
  const def = {
    seat: [d.L * 0.5, d.W * 0.5], FL: [0.35, d.W * 0.32, 1.0], FR: [0.35, d.W * 0.68, 1.0],
    SL: [d.L - 0.3, d.W * 0.2, Math.min(d.H - 0.3, 1.9)], SR: [d.L - 0.3, d.W * 0.8, Math.min(d.H - 0.3, 1.9)],
  };
  const clamp = (v, hi) => Math.min(hi - 0.05, Math.max(0.05, v));
  for (const k of ['seat', ...SPK]) {
    const p = Array.isArray(P[k]) && P[k].length >= 2 && P[k].every(isFinite) ? P[k].slice() : def[k].slice();
    p[0] = clamp(p[0], d.L); p[1] = clamp(p[1], d.W);
    if (k !== 'seat') p[2] = clamp(isFinite(p[2]) ? p[2] : def[k][2], d.H);
    P[k] = p;
  }
  if (!isFinite(P.ear)) P.ear = EAR;
  return P;
}
const seat3 = P => [P.seat[0], P.seat[1], P.ear];
const posChanged = () => document.dispatchEvent(new Event('fono-pos'));


// ---------------------------------------------------------------- seat heatmap (predicted 30-120 Hz unevenness over the whole room)
const hex = (c, d) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((c || '').trim()); return m ? [1, 2, 3].map(i => parseInt(m[i], 16)) : d; };
/** Colour stops good -> warn -> bad from the theme tokens (so light and dark both work). */
const heatStops = () => [hex(css('--good'), [143, 156, 116]), hex(css('--warn'), [199, 162, 94]), hex(css('--bad'), [180, 101, 78])];
const heatRgb = (st, t) => { const k = Math.min(1, Math.max(0, t)) * 2, i = Math.min(1, Math.floor(k)), a = k - i; return st[i].map((v, j) => v + (st[i + 1][j] - v) * a); };
/** Sources of the bass: the subwoofers when the layout has them (SW1/SW2 positions), else the front pair. */
export function bassSources(S, P) {
  const subs = /\.[12]$/.test(S.room.layout || '') ? ['SW1', 'SW2'].filter(k => Array.isArray(P[k]) && P[k].length >= 3) : [];
  return (subs.length ? subs : ['FL', 'FR']).map(k => P[k]);
}
let heatCache = { key: '', map: null };
/** Cached heatmap for the current room, positions and ear height; `coarse` (10 cm) is used while a speaker is dragged. */
export function heatFor(S, coarse = false) {
  const P = roomPos(S), d = S.dims, srcs = bassSources(S, P), step = coarse ? 0.1 : 0.05;
  const key = JSON.stringify([d.L, d.W, d.H, d.rt60, srcs, P.ear, step]);
  if (heatCache.key !== key) heatCache = { key, map: seatHeatmap(srcs, d, d.rt60, { z: P.ear, step }) };
  return heatCache.map;
}
/** Colour scale of a map: 0 = the best point, 1 = the 90th percentile (RMS dB). */
function heatScale(map) {
  const r = Array.from(map.v, Math.sqrt).sort((a, b) => a - b), lo = r[0], hi = Math.max(lo + 1, r[Math.floor(r.length * 0.9)]);
  return { lo, hi };
}
function drawHeat(g, map, X, Y, st) {
  const { lo, hi } = heatScale(map), off = document.createElement('canvas');
  off.width = map.ny; off.height = map.nx;
  const o = off.getContext('2d'), img = o.createImageData(map.ny, map.nx), cols = heatStops();
  for (let ix = 0; ix < map.nx; ix++) for (let iy = 0; iy < map.ny; iy++) {
    const c = heatRgb(cols, (Math.sqrt(map.v[ix * map.ny + iy]) - lo) / (hi - lo)), k = (ix * map.ny + iy) * 4;
    img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = 255;
  }
  o.putImageData(img, 0, 0);
  const x0 = map.x0 - map.step / 2, y0 = map.y0 - map.step / 2, w = map.ny * map.step, hh = map.nx * map.step;
  g.save(); g.globalAlpha = 0.62; g.imageSmoothingEnabled = true; g.drawImage(off, X(y0), Y(x0), X(y0 + w) - X(y0), Y(x0 + hh) - Y(x0)); g.restore();
  // outline of the best area: every cell edge that borders a cell outside the mask
  const m = bestArea(map, 0.5), inM = (ix, iy) => ix >= 0 && iy >= 0 && ix < map.nx && iy < map.ny && m[ix * map.ny + iy] === 1;
  g.save(); g.strokeStyle = st.acc; g.lineWidth = 2; g.beginPath();
  for (let ix = 0; ix < map.nx; ix++) for (let iy = 0; iy < map.ny; iy++) {
    if (!inM(ix, iy)) continue;
    const xa = map.x0 + (ix - 0.5) * map.step, xb = xa + map.step, ya = map.y0 + (iy - 0.5) * map.step, yb = ya + map.step;
    if (!inM(ix - 1, iy)) { g.moveTo(X(ya), Y(xa)); g.lineTo(X(yb), Y(xa)); }
    if (!inM(ix + 1, iy)) { g.moveTo(X(ya), Y(xb)); g.lineTo(X(yb), Y(xb)); }
    if (!inM(ix, iy - 1)) { g.moveTo(X(ya), Y(xa)); g.lineTo(X(ya), Y(xb)); }
    if (!inM(ix, iy + 1)) { g.moveTo(X(yb), Y(xa)); g.lineTo(X(yb), Y(xb)); }
  }
  g.stroke(); g.restore();
}
/** Legend + live readout under a plan canvas; update(P) after every redraw. */
function heatLegend(S) {
  const bar = h('div', { class: 'heat-bar' }), lo = h('span', {}), hi = h('span', {}), read = h('p', { class: 'hint heat-read' });
  const root = h('div', { class: 'heat-legend' }, h('div', { class: 'heat-scale' }, lo, bar, hi), read);
  const update = P => {
    const map = heatFor(S), { lo: a, hi: b } = heatScale(map), cols = heatStops();
    bar.style.background = `linear-gradient(90deg, ${[0, 0.5, 1].map(t2 => `rgb(${heatRgb(cols, t2).map(Math.round)})`).join(', ')})`;
    lo.textContent = `${a.toFixed(1)} dB`; hi.textContent = `${b.toFixed(1)} dB+`;
    const here = heatAt(map, P.seat[0], P.seat[1]), dist = Math.hypot(map.best.x - P.seat[0], map.best.y - P.seat[1]);
    read.textContent = here == null ? '座位在牆邊 25 cm 內，熱圖不涵蓋這裡。'
      : `目前座位 ${Math.sqrt(here).toFixed(1)} dB RMS · 最佳點 ${Math.sqrt(map.best.v).toFixed(1)} dB RMS（距離 ${Math.round(dist * 100)} cm）· 亮色框 = 最佳區域（差 0.5 dB 以內）`;
  };
  return { el: root, update };
}
const heatToggle = (state, redraw) => toggle({ label: '低頻起伏熱圖', sub: '30–120 Hz，依喇叭位置與房間尺寸預測', value: state.on, onInput: v => { state.on = v; redraw(); } });

/** Top-view plan canvas. x runs front -> back (down the screen), y runs left -> right. */
function planCanvas(ctx, { reflFor, ghost, onDraw, heat } = {}) {
  const S = ctx.S, cv = h('canvas', { class: 'curve plan', style: 'height:' + (reflFor ? 480 : 400) + 'px;width:100%;touch-action:none;cursor:grab' });
  let geo = null, drag = null, lastPreds = [], lastMatch = [], labelRects = [];
  const col = { ink: () => css('--ink') || '#ddd', dim: () => css('--ink-3') || '#888', acc: () => css('--accent') || '#c2a47e', warn: () => css('--warn') || '#c9a04a', line: () => css('--line-2') || '#555' };
  const draw = () => {
    const c = setupCanvas(cv); if (!c) return;
    const { g, w, h: H } = c, d = S.dims, P = roomPos(S), m = 26;
    const sc = Math.min((w - 2 * m) / d.W, (H - 2 * m - 6) / d.L);
    const ox = (w - d.W * sc) / 2, oy = m + 4;
    geo = { sc, ox, oy };
    const X = y => ox + y * sc, Y = x => oy + x * sc;
    g.lineWidth = 1.5; g.strokeStyle = col.line(); g.strokeRect(X(0), Y(0), d.W * sc, d.L * sc);
    g.fillStyle = col.dim(); g.font = '11px sans-serif'; g.textAlign = 'center';
    g.fillText('前牆（喇叭側）', w / 2, oy - 8); g.fillText(`後牆　${d.W.toFixed(2)} × ${d.L.toFixed(2)} m`, w / 2, Y(d.L) + 15);
    g.textAlign = 'left'; g.fillText('左', X(0) + 4, Y(d.L) - 4); g.textAlign = 'right'; g.fillText('右', X(d.W) - 4, Y(d.L) - 4);
    if (heat?.on) drawHeat(g, heatFor(S, !!drag && drag !== 'seat'), X, Y, { acc: col.acc() });
    // 1 m grid
    g.strokeStyle = css('--grid') || '#333'; g.lineWidth = 1;
    for (let v = 1; v < d.W; v++) { g.beginPath(); g.moveTo(X(v), Y(0)); g.lineTo(X(v), Y(d.L)); g.stroke(); }
    for (let v = 1; v < d.L; v++) { g.beginPath(); g.moveTo(X(0), Y(v)); g.lineTo(X(d.W), Y(v)); g.stroke(); }
    // reflection dots
    if (reflFor) {
      const spk = reflFor();
      if (spk) {
        lastPreds = firstReflections(P[spk], seat3(P), d);
        g.font = '11px sans-serif';
        // dots first, then labels placed so no two labels (or a label and a marker) overlap
        const dots = lastPreds.map(r => ({ r, px: X(r.pt[1]), py: Y(r.pt[0]), flat: r.id === 'floor' || r.id === 'ceil' }));
        dots.forEach(({ r, px, py }) => {
          const hit = lastMatch.some(mm => mm.surface === r.name);
          g.strokeStyle = col.warn(); g.fillStyle = hit ? col.warn() : 'transparent'; g.lineWidth = 2;
          g.beginPath(); g.arc(px, py, 5, 0, 7); hit ? g.fill() : 0; g.stroke();
        });
        const obst = [...dots.map(o => [o.px - 7, o.py - 7, 14, 14]), [X(P.seat[1]) - 11, Y(P.seat[0]) - 11, 22, 22], ...SPK.map(k => [X(P[k][1]) - 10, Y(P[k][0]) - 10, 20, 20])];
        const placed = [];
        const hitRect = (a, b2) => a[0] < b2[0] + b2[2] && b2[0] < a[0] + a[2] && a[1] < b2[1] + b2[3] && b2[1] < a[1] + a[3];
        const labels = dots.map(o => ({ ...o, l1: '吸音板放這裡', l2: `${o.r.name}${o.flat ? '（上下）' : ''} +${Math.round(o.r.extra * 100)} cm · ${o.r.ms.toFixed(1)} ms` }));
        labels.forEach(o => { o.w = Math.max(g.measureText(o.l1).width, g.measureText(o.l2).width); });
        labels.sort((p, q) => p.py - q.py).forEach(o => {
          const H2 = 25, pref = o.px > w / 2 ? -1 : 1;
          let best = null;
          // candidates: preferred side then the other side, each nudged up/down in 13 px steps
          for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) for (const sd of [pref, -pref]) {
            const x0 = sd > 0 ? o.px + 9 : o.px - 9 - o.w, y0 = o.py - 11 + k * 13, rect = [x0, y0, o.w, H2];
            if (x0 < 2 || x0 + o.w > w - 2 || y0 < 2 || y0 + H2 > H - 2) continue;
            if (placed.some(p => hitRect(rect, [p[0] - 4, p[1] - 2, p[2] + 8, p[3] + 4])) || obst.some(p => hitRect(rect, p))) continue;
            best = { rect, sd }; break;
          }
          if (!best) best = { rect: [Math.min(Math.max(2, o.px + 9), w - o.w - 2), Math.min(Math.max(2, o.py - 11), H - H2 - 2), o.w, H2], sd: 1 };
          placed.push(best.rect);
          const [x0, y0] = best.rect;
          if (Math.abs(y0 + 11 - o.py) > 14) { g.strokeStyle = col.warn(); g.globalAlpha = 0.45; g.lineWidth = 1; g.beginPath(); g.moveTo(o.px, o.py); g.lineTo(best.sd > 0 ? x0 : x0 + o.w, y0 + 11); g.stroke(); g.globalAlpha = 1; }
          g.textAlign = 'left'; g.fillStyle = col.warn(); g.fillText(o.l1, x0, y0 + 9);
          g.fillStyle = col.dim(); g.fillText(o.l2, x0, y0 + 21);
        });
        labelRects = placed;
        g.strokeStyle = col.warn(); g.globalAlpha = 0.35; g.lineWidth = 1; g.setLineDash([3, 4]);
        for (const r of lastPreds.filter(r => r.id !== 'floor' && r.id !== 'ceil')) { g.beginPath(); g.moveTo(X(P[spk][1]), Y(P[spk][0])); g.lineTo(X(r.pt[1]), Y(r.pt[0])); g.lineTo(X(P.seat[1]), Y(P.seat[0])); g.stroke(); }
        g.setLineDash([]); g.globalAlpha = 1;
      }
    }
    if (ghost) { const gx = ghost(); if (gx != null) { g.strokeStyle = col.acc(); g.setLineDash([4, 3]); g.lineWidth = 1.5; g.beginPath(); g.arc(X(P.seat[1]), Y(gx), 9, 0, 7); g.stroke(); g.setLineDash([]); g.fillStyle = col.acc(); g.textAlign = 'left'; g.fillText('建議', X(P.seat[1]) + 13, Y(gx) + 4); } }
    // markers: speakers = squares, seat = filled circle
    g.font = '700 11px sans-serif';
    for (const k of SPK) {
      const px = X(P[k][1]), py = Y(P[k][0]);
      g.fillStyle = css('--panel') || '#222'; g.strokeStyle = col.ink(); g.lineWidth = 1.5; g.fillRect(px - 8, py - 8, 16, 16); g.strokeRect(px - 8, py - 8, 16, 16);
      g.fillStyle = col.ink(); g.textAlign = 'center'; g.fillText(k, px, py + 4);
    }
    g.fillStyle = col.acc(); g.beginPath(); g.arc(X(P.seat[1]), Y(P.seat[0]), 9, 0, 7); g.fill();
    g.fillStyle = css('--accent-ink') || '#111'; g.textAlign = 'center'; g.fillText('耳', X(P.seat[1]), Y(P.seat[0]) + 4);
    onDraw?.(P);
  };
  const toRoom = e => { const r = cv.getBoundingClientRect(); return [(e.clientY - r.top - geo.oy) / geo.sc, (e.clientX - r.left - geo.ox) / geo.sc]; };
  cv.addEventListener('pointerdown', e => {
    if (!geo) return;
    const P = roomPos(S), [x, y] = toRoom(e);
    let best = null, bd = 16 / geo.sc;
    for (const k of ['seat', ...SPK]) { const dd = Math.hypot(P[k][0] - x, P[k][1] - y); if (dd < bd) { bd = dd; best = k; } }
    if (best) { drag = best; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; }
  });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const P = roomPos(S), d = S.dims, [x, y] = toRoom(e);
    P[drag][0] = Math.round(Math.min(d.L - 0.05, Math.max(0.05, x)) * 100) / 100;
    P[drag][1] = Math.round(Math.min(d.W - 0.05, Math.max(0.05, y)) * 100) / 100;
    posChanged();
  });
  const end = () => { if (drag) { drag = null; cv.style.cursor = 'grab'; ctx.saveState(); posChanged(); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  const redraw = () => draw();
  document.addEventListener('fono-pos', redraw); document.addEventListener('fono-dims', redraw);
  onResize(cv, redraw);
  cv.seatPx = () => { const P = roomPos(S); return geo ? [geo.ox + P.seat[1] * geo.sc, geo.oy + P.seat[0] * geo.sc] : null; };   // for the UI sweep: where the seat marker is, in canvas px
  cv.labelRects = () => labelRects;   // for the UI sweep: label boxes must not overlap
  return { cv, draw, setMatch: m => { lastMatch = m; }, preds: () => lastPreds, labels: () => labelRects };
}

function heightRow(ctx) {
  const S = ctx.S, row = h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin-top:10px' });
  const mk = (label, get, set) => {
    const i = h('input', { type: 'number', step: 0.05, min: 0.1, style: 'width:84px', value: get() });
    i.oninput = () => { const v = +i.value; if (v > 0.05 && v < S.dims.H) { set(v); ctx.saveState(); posChanged(); } };
    document.addEventListener('fono-pos', () => { if (document.activeElement !== i) i.value = get(); });
    return h('label', { class: 'field' }, h('span', {}, label), i);
  };
  row.append(mk('耳朵高度 (m)', () => roomPos(S).ear, v => { roomPos(S).ear = v; }));
  for (const k of SPK) row.append(mk(`${k} 高度 (m)`, () => roomPos(S)[k][2], v => { roomPos(S)[k][2] = v; }));
  return row;
}

// ---------------------------------------------------------------- 5.1 floor plan + 5.3 modes at the seat
export function planPanel(ctx) {
  const S = ctx.S;
  let ghostX = null;
  const heat = { on: false }, legend = heatLegend(S);
  const plan = planCanvas(ctx, { ghost: () => ghostX, heat, onDraw: P => { legend.el.style.display = heat.on ? '' : 'none'; if (heat.on) legend.update(P); } });
  const root = h('div', { class: 'panel', id: 'planPanel' },
    head('P', '房間平面圖', 'Floor plan', true),
    h('p', { class: 'hint', style: 'margin-top:0' }, '房間尺寸可以用掃描檔匯入，或直接在上面的欄位輸入。拖曳「耳」和四顆喇叭到實際位置；位置會用在下面的模態分析與「早期反射」分頁。'),
    h('div', { class: 'graph-tools' }, heatToggle(heat, () => plan.draw()).el),
    plan.cv, legend.el, heightRow(ctx));
  const modesBox = h('div', {});
  root.append(h('div', { class: 'ph', style: 'margin-top:18px' }, h('span', { class: 'tag' }, 'M'), h('h2', {}, '聽音位置的房間模態'), h('span', { class: 'rule' })), modesBox);
  const drawModes = () => {
    modesBox.innerHTML = '';
    const d = S.dims, P = roomPos(S), modes = simpleModes(d, 200), sp = seat3(P);
    const cell = v => h('td', { class: Math.abs(v) < 0.2 ? 'null' : Math.abs(v) > 0.8 ? 'peak' : '' }, v.toFixed(2));
    const rows = modes.map(m => {
      const v = modePressure(m.n, sp, d);
      const st = Math.abs(v) < 0.2 ? '落在節點（這個頻率被抵消）' : Math.abs(v) > 0.8 ? '落在波腹（這個頻率特別大聲）' : '';
      return h('tr', {}, h('td', {}, m.f.toFixed(1) + ' Hz'), h('td', {}, m.kind), h('td', {}, m.n.join(',')), cell(v), ...SPK.map(k => cell(modePressure(m.n, P[k], d))), h('td', {}, st));
    });
    const best = seatSearch(sp, [P.FL, P.FR], d, d.rt60);
    ghostX = best.best.off !== 0 && best.here.v > best.best.v * 1.05 ? best.best.x : null;
    const cvv = h('canvas', { class: 'curve', style: 'height:110px;width:100%;margin-top:10px' });
    const gain = best.here.v > 0 ? (1 - best.best.v / best.here.v) * 100 : 0;
    const go = h('button', { class: 'btn', type: 'button', disabled: ghostX == null ? '' : null, onclick: () => { roomPos(S).seat[0] = Math.round(best.best.x * 100) / 100; ctx.saveState(); posChanged(); } }, '移到建議位置');
    modesBox.append(
      h('p', { class: 'hint', style: 'margin-top:0' }, '軸向與切向模態（200 Hz 以下）在各位置的壓力：cos(nxπx/L)·cos(nyπy/W)·cos(nzπz/H)，1 = 波腹，0 = 節點。'),
      h('div', { style: 'max-height:260px;overflow:auto' }, h('table', { class: 'modes-table' },
        h('tr', {}, ...['頻率', '類型', 'nx,ny,nz', '耳朵', ...SPK, '耳朵位置'].map(t => h('th', {}, t))), ...rows)),
      h('p', { class: 'hint' }, ghostX == null
        ? `沿房間長度 ±60 cm（每 5 cm）找 30–120 Hz 低頻起伏最小的位置：目前位置已經接近最佳（起伏 ${Math.sqrt(best.here.v).toFixed(1)} dB RMS）。`
        : `沿房間長度 ±60 cm（每 5 cm）找 30–120 Hz 低頻起伏最小的位置：建議${best.best.off > 0 ? '往後' : '往前'}移 ${Math.abs(Math.round(best.best.off * 100))} cm，低頻起伏由 ${Math.sqrt(best.here.v).toFixed(1)} 降到 ${Math.sqrt(best.best.v).toFixed(1)} dB RMS（約少 ${gain.toFixed(0)}% 的變異）。以前兩顆喇叭與目前 RT60 估算。`),
      cvv, h('div', { style: 'margin-top:8px' }, go));
    requestAnimationFrame(() => {
      const c = setupCanvas(cvv); if (!c || !best.rows.length) return;
      const { g, w, h: H } = c, vmax = Math.max(...best.rows.map(r => r.v)) || 1, offs = best.rows.map(r => r.off), o0 = Math.min(...offs), o1 = Math.max(...offs);
      const X = o => 30 + (o - o0) / (o1 - o0 || 1) * (w - 40), Y = v => H - 18 - (v / vmax) * (H - 28);
      g.strokeStyle = css('--accent'); g.lineWidth = 1.8; g.beginPath(); best.rows.forEach((r, i) => (i ? g.lineTo(X(r.off), Y(r.v)) : g.moveTo(X(r.off), Y(r.v)))); g.stroke();
      g.fillStyle = css('--ink-3'); g.font = '10px sans-serif'; g.textAlign = 'center';
      for (const o of [-0.6, -0.3, 0, 0.3, 0.6]) if (o >= o0 - 1e-9 && o <= o1 + 1e-9) g.fillText((o > 0 ? '+' : '') + Math.round(o * 100) + ' cm', X(o), H - 4);
      g.textAlign = 'left'; g.fillText('低頻起伏（方差，越低越平）', 34, 12);
      g.fillStyle = css('--warn'); g.beginPath(); g.arc(X(best.here.off), Y(best.here.v), 4, 0, 7); g.fill();
      g.fillStyle = css('--accent'); g.beginPath(); g.arc(X(best.best.off), Y(best.best.v), 4, 0, 7); g.fill();
    });
    plan.draw();
  };
  document.addEventListener('fono-pos', () => { if (root.offsetParent) drawModes(); });
  document.addEventListener('fono-dims', () => { if (root.offsetParent) drawModes(); });
  onTab('modes', drawModes); drawModes();
  return root;
}

// ---------------------------------------------------------------- room diagnosis (task C)
const SEV = { high: '嚴重', mid: '中等', low: '輕微', ok: '正常' };
let diagCache = { key: '', input: null };
/** diagnose() input for the current measurements; the per-channel analysis (curves, auto-EQ, decay) is cached until the data or room change. */
async function diagInput(getResults, S) {
  const { res, demo } = await results(getResults, S), P = roomPos(S);
  const chans = channelsOf(res), key = JSON.stringify([chans.map(k => [k, res[k].length, res[k][0].ir.length, res[k][0].arrivalMs]), S.dims, SPK.map(k => P[k]), P.seat, P.ear, S.room.target, S.meas.maxFilters, S.meas.lfRise]);
  if (diagCache.key !== key) diagCache = { key, input: chans.length ? inputFromResults(res, S, P) : { dims: S.dims, pos: P, chans: {} } };
  const input = { ...diagCache.input, pos: P, dims: S.dims, bassSrcs: bassSources(S, P) };
  return { input, demo, n: chans.length };
}
export function diagPanel(ctx, getResults) {
  const S = ctx.S, list = h('div', { class: 'diag-list' }), sum = h('div', { class: 'diag-sum' }), note = h('div', {});
  let last = null, busy = false, again = false;
  const heat = { on: true }, legend = heatLegend(S);
  const plan = planCanvas(ctx, { heat, onDraw: P => { legend.el.style.display = heat.on ? '' : 'none'; if (heat.on) legend.update(P); } });
  const draw = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const { input, demo, n } = await diagInput(getResults, S), items = diagnose(input);
      last = { input, items, demo };
      note.innerHTML = '';
      note.append(...[demoNote(demo), n ? null : h('p', { class: 'hint' }, '還沒有量測資料：下面只有依房間尺寸與位置算出的項目。做過一次「一鍵校正」後，這裡會加入左右平衡、極性、反射、衰減與 EQ 限制的檢查。')].filter(Boolean));
      sum.innerHTML = '';
      for (const k of ['high', 'mid', 'low', 'ok']) { const c = items.filter(x => x.severity === k).length; if (c) sum.append(h('span', { class: 'sev ' + k }, h('i', {}), `${SEV[k]} ${c}`)); }
      list.innerHTML = '';
      for (const x of items) list.append(h('div', { class: 'diag-item ' + x.severity, 'data-id': x.id },
        h('span', { class: 'sev ' + x.severity }, h('i', {}), SEV[x.severity]),
        h('div', { class: 'diag-body' }, h('b', {}, x.title), h('p', {}, x.detail), x.action ? h('p', { class: 'act' }, h('em', {}, '建議'), ' ', x.action) : null)));
    } catch (e) { list.innerHTML = ''; list.append(h('p', { class: 'hint' }, '診斷失敗：' + e.message)); }
    busy = false;
    if (again) { again = false; draw(); }
  };
  const exportBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!last) await draw();
    const { input, items } = last, curves = Object.entries(input.chans).filter(([, m]) => m.curve).map(([name, m]) => { const c = smooth(m.curve, 12); return { name, f: c.f, db: c.db }; });
    const st = heatStops(), colorAt = t2 => `rgb(${heatRgb(st, t2).map(Math.round)})`, map = heatFor(S);
    const html = reportHtml(items, { t, lang: getLang() === 'en' ? 'en' : 'zh-TW', date: new Date().toLocaleString(locale(), { hour12: false }), dims: S.dims, curves, heat: { map, seat: roomPos(S).seat, colorAt } });
    const a = h('a', { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `fono-room-diagnosis-${new Date().toISOString().slice(0, 10)}.html` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('已匯出診斷報告');
  } }, '匯出報告 (HTML)');
  const rerun = h('button', { class: 'btn', type: 'button', onclick: () => { diagCache.key = ''; draw(); } }, '重新診斷');
  const diagPane = h('div', { class: 'panel', id: 'diagPanel' },
    head('D', '房間診斷', 'Findings'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '把量測結果依嚴重程度排成清單，每一項都附上白話說明和具體做法。全部是固定規則，沒有用模型猜測；數字來自量測和房間模態模型。'),
    h('div', { class: 'graph-tools' }, sum, h('span', { style: 'flex:1' }), rerun, exportBtn), note, list);
  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { if (diagPane.offsetParent) draw(); }, 220); };
  const heatPane = h('div', { class: 'panel', id: 'heatPanel' },
    head('H', '座位低頻熱圖', 'Seat heatmap'),
    h('p', { class: 'hint', style: 'margin-top:0' }, '依房間尺寸和目前的喇叭（有低音喇叭時用低音喇叭）位置，預測每一點 30–120 Hz 的起伏；顏色越暖起伏越大。拖曳「耳」可以即時看到數值，拖曳喇叭則會重算整張圖。'),
    h('div', { class: 'graph-tools' }, heatToggle(heat, () => plan.draw()).el), plan.cv, legend.el);
  document.addEventListener('fono-pos', later); document.addEventListener('fono-dims', later);
  onTab('diag', () => { draw(); plan.draw(); });
  return h('div', {}, diagPane, heatPane);
}

// ---------------------------------------------------------------- 5.2 reflections
export function reflPanel2(ctx, getResults) {
  const S = ctx.S;
  let spk = 'FL';
  const body = h('div', {});
  const sel = h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px' });
  const plan = planCanvas(ctx, { reflFor: () => spk });
  const draw = async () => {
    const { res, demo } = await results(getResults, ctx.S);
    const chans = channelsOf(res);
    if (chans.length && !chans.includes(spk)) spk = chans[0];
    sel.innerHTML = '';
    const k = keys({ options: SPK.map(x => ({ id: x, label: x + (chans.includes(x) ? '' : '（無資料）') })), value: spk, onInput: v => { spk = v; draw(); } });
    sel.append(h('span', { class: 'muted' }, '喇叭'), k.el);
    body.innerHTML = '';
    const P = roomPos(S), preds = firstReflections(P[spk], seat3(P), S.dims);
    const m = res[spk]?.[0];
    let a = null, matched = [];
    if (m) { a = analyse(m); matched = matchPeaks(a.rows, preds, 0.3); }
    plan.setMatch(matched.filter(x => x.surface)); plan.draw();
    const near = r => matched.find(x => x.surface === r.name);
    const predTb = h('table', { class: 'modes-table' },
      h('tr', {}, ...['表面', '多走的路', '預測延遲', '量測到的峰（±0.3 ms）'].map(t => h('th', {}, t))),
      ...preds.slice().sort((p, q) => p.ms - q.ms).map(r => { const x = near(r); return h('tr', {}, h('td', {}, r.name), h('td', {}, Math.round(r.extra * 100) + ' cm'), h('td', {}, r.ms.toFixed(2) + ' ms'), h('td', { class: x ? 'ax' : '' }, x ? `${x.ms.toFixed(2)} ms · ${x.db.toFixed(1)} dB` : '—')); }));
    const cvs = h('canvas', { class: 'curve', style: 'height:150px;width:100%;margin-top:10px' });
    body.append(demoNote(demo), predTb);
    if (a) {
      body.append(cvs, h('p', { class: 'hint' }, matched.length ? matched.map(x => `${x.ms.toFixed(2)} ms ${x.db.toFixed(0)} dB → ${x.surface || '未對應'}`).join('；') : '沒有明顯的早期反射。'));
      requestAnimationFrame(() => etcDraw(cvs, a, matched));
    } else body.append(h('p', { class: 'hint' }, '尚無量測資料：上表是由房間尺寸與位置算出的預測值，做過一鍵校正後會在這裡對照實測的反射峰。'));
  };
  const root = h('div', { class: 'panel', id: 'reflPanel2' },
    head('R', '早期反射分析', 'Reflections', true),
    h('p', { class: 'hint', style: 'margin-top:0' }, '用鏡像聲源法算出每顆喇叭到耳朵的一次反射（兩側牆、天花板、地板、前後牆）。紅點是反射點，把吸音板貼在那裡；若實測的反射峰與預測相差在 ±0.3 ms 內，會標上是哪一面牆。'),
    sel, plan.cv, body);
  document.addEventListener('fono-pos', () => { if (root.offsetParent) draw(); });
  document.addEventListener('fono-dims', () => { if (root.offsetParent) draw(); });
  onTab('refl', draw);
  return root;
}
function etcDraw(cv, a, matched) {
  const c = setupCanvas(cv); if (!c) return;
  const { g, w, h: H } = c, T = 30, mn = -60, pad = 24;
  const X = ms => pad + ms / T * (w - pad - 6), Y = d => 6 + (0 - Math.max(mn, d)) / -mn * (H - 22);
  g.lineWidth = 1; g.strokeStyle = css('--line'); g.fillStyle = css('--ink-3'); g.font = '10px sans-serif';
  for (let ms = 0; ms <= T; ms += 5) { g.beginPath(); g.moveTo(X(ms), 6); g.lineTo(X(ms), H - 16); g.stroke(); g.fillText(ms + '', X(ms) - 4, H - 4); }
  for (let d = 0; d >= mn; d -= 20) { g.beginPath(); g.moveTo(pad, Y(d)); g.lineTo(w - 6, Y(d)); g.stroke(); g.fillText(d + '', 0, Y(d) + 3); }
  g.strokeStyle = css('--accent'); g.lineWidth = 1.5; g.beginPath();
  const i0 = Math.max(0, a.pk), i1 = Math.min(a.etc.length - 1, a.pk + Math.round(T / 1000 * a.sr));
  for (let i = i0, first = true; i <= i1; i++) { const ms = (i - a.pk) / a.sr * 1000, x = X(ms), y = Y(a.db(i)); first ? (g.moveTo(x, y), first = false) : g.lineTo(x, y); }
  g.stroke();
  for (const r of matched) {
    g.fillStyle = r.surface ? css('--warn') : css('--ink-3'); g.beginPath(); g.arc(X(r.ms), Y(r.db), 3.5, 0, 7); g.fill();
    if (r.surface) { g.textAlign = 'left'; g.fillText(r.surface, X(r.ms) + 5, Y(r.db) - 4); }
  }
}

// ---------------------------------------------------------------- decay analysis + waterfall
export function decayPanel(ctx, getResults) {
  let ch = 'FL', band = 1000;
  const body = h('div', {});
  const draw = async () => {
    const { res, demo } = await results(getResults, ctx.S);
    const chans = channelsOf(res);
    body.innerHTML = '';
    if (!chans.length) { body.append(h('p', { class: 'hint' }, '先做一次一鍵校正（或在示範模式載入示範量測）。')); return; }
    if (!chans.includes(ch)) ch = chans[0];
    const m = res[ch][0], tbl = decayTable(m.ir, m.sr);
    if (!tbl.some(r => r.fc === band)) band = tbl[tbl.length - 1]?.fc;
    const chK = keys({ options: chans.map(x => ({ id: x, label: x })), value: ch, onInput: v => { ch = v; draw(); } });
    const bK = keys({ options: tbl.map(r => ({ id: r.fc, label: r.fc >= 1000 ? r.fc / 1000 + 'k' : String(r.fc) })), value: band, onInput: v => { band = +v; draw(); } });
    const f = v => (Number.isFinite(v) ? v.toFixed(2) + ' s' : '—');
    const cell = (v, ok) => h('td', { class: Number.isFinite(v) ? '' : 'na' }, f(v));
    const t = h('table', { class: 'modes-table' }, h('tr', {}, ...['頻帶', 'EDT', 'T20', 'T30', '動態範圍'].map(x => h('th', {}, x))),
      ...tbl.map(r => h('tr', {}, h('td', {}, r.fc >= 1000 ? r.fc / 1000 + ' kHz' : r.fc + ' Hz'), cell(r.edt), cell(r.t20), cell(r.t30), h('td', {}, r.range.toFixed(0) + ' dB'))));
    const dec = h('canvas', { class: 'curve', style: 'height:150px;width:100%' });
    const wf = h('canvas', { class: 'curve', style: 'height:340px;width:100%;margin-top:10px' });
    body.append(demoNote(demo), h('div', { class: 'graph-tools' }, h('span', { class: 'muted' }, '喇叭'), chK.el, h('span', { class: 'muted' }, '頻帶'), bK.el),
      t, h('p', { class: 'hint' }, '— 表示該頻帶的衰減動態範圍不夠（T20 需要 25 dB、T30 需要 35 dB），不要採信。'),
      dec, h('p', { class: 'hint' }, `${band} Hz 倍頻帶的施羅德反向積分曲線（EDT 取 0…−10 dB、T20 取 −5…−25 dB、T30 取 −5…−35 dB 做直線回歸，換算成 60 dB 衰減時間）。`),
      h('div', { class: 'ph', style: 'margin-top:14px' }, h('span', { class: 'tag' }, 'W'), h('h2', {}, '瀑布圖'), h('span', { class: 'en' }, 'CSD · 0–300 ms'), h('span', { class: 'rule' })), wf,
      h('p', { class: 'hint' }, '30 張頻譜切片，間隔約 10 ms，往後方（右上）是時間更晚；每一座山脊拖得越長，表示那個頻率的殘響越久。'));
    requestAnimationFrame(() => {
      const sel = tbl.find(r => r.fc === band);
      if (sel) schroederDraw(dec, sel.db, m.sr);
      waterfallDraw(wf, csd(m.ir, m.sr));
    });
  };
  const root = h('div', { class: 'panel', id: 'decayPanel' }, head('T', '衰減分析', 'Decay · RT60'), body);
  onTab('decay', draw);
  return root;
}
function schroederDraw(cv, db, sr) {
  const c = setupCanvas(cv); if (!c) return;
  const { g, w, h: H } = c, pad = 34;
  let end = db.length - 1; for (let i = 0; i < db.length; i++) if (db[i] < -62) { end = i; break; }
  const T = Math.max(0.1, end / sr), X = t => pad + t / T * (w - pad - 8), Y = d => 8 + (-d / 65) * (H - 26);
  g.lineWidth = 1; g.strokeStyle = css('--line'); g.fillStyle = css('--ink-3'); g.font = '10px sans-serif'; g.textAlign = 'right';
  for (let d = 0; d >= -60; d -= 10) { g.beginPath(); g.moveTo(pad, Y(d)); g.lineTo(w - 8, Y(d)); g.stroke(); g.fillText(d + '', pad - 4, Y(d) + 3); }
  g.textAlign = 'center'; const st = T > 1.2 ? 0.2 : T > 0.5 ? 0.1 : 0.05;
  for (let t = 0; t <= T; t += st) g.fillText((t * 1000).toFixed(0), X(t), H - 4);
  g.strokeStyle = css('--accent'); g.lineWidth = 1.8; g.beginPath();
  for (let i = 0, first = true; i <= end; i += Math.max(1, Math.round(end / 400))) { const x = X(i / sr), y = Y(db[i]); first ? (g.moveTo(x, y), first = false) : g.lineTo(x, y); }
  g.stroke();
}
function waterfallDraw(cv, wf) {
  const c = setupCanvas(cv); if (!c) return;
  const { g, w, h: H } = c, n = wf.t.length, nF = wf.f.length, padL = 14, padB = 22;
  const offX = Math.min(0.3 * w, 280), offY = Math.min(0.42 * H, 160);
  const Wp = w - padL - offX - 44, amp = H - padB - offY - 14, RANGE = 45;
  const bg = css('--bg-2') || '#222', ink3 = css('--ink-3'), acc = css('--accent');
  for (let i = n - 1; i >= 0; i--) {
    const x0 = padL + i / (n - 1) * offX, y0 = H - padB - i / (n - 1) * offY;
    g.beginPath();
    const row = wf.db[i];
    for (let j = 0; j < nF; j++) {
      const x = x0 + j / (nF - 1) * Wp, y = y0 - (Math.max(-RANGE, Math.min(0, row[j])) + RANGE) / RANGE * amp;
      j ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.lineTo(x0 + Wp, y0); g.lineTo(x0, y0); g.closePath();
    g.fillStyle = bg; g.fill();
    g.beginPath();
    for (let j = 0; j < nF; j++) {
      const x = x0 + j / (nF - 1) * Wp, y = y0 - (Math.max(-RANGE, Math.min(0, row[j])) + RANGE) / RANGE * amp;
      j ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.strokeStyle = i === 0 ? acc : ink3; g.globalAlpha = i === 0 ? 1 : 0.35 + 0.65 * (1 - i / (n - 1)); g.lineWidth = i === 0 ? 1.8 : 1; g.stroke(); g.globalAlpha = 1;
  }
  g.fillStyle = ink3; g.font = '10px sans-serif'; g.textAlign = 'center';
  for (const f of [20, 50, 100, 200, 500, 1000]) {
    if (f < wf.f[0] || f > wf.f[nF - 1]) continue;
    g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), padL + Math.log(f / wf.f[0]) / Math.log(wf.f[nF - 1] / wf.f[0]) * Wp, H - 6);
  }
  g.textAlign = 'left';
  for (const ms of [0, 100, 200, 300]) { const i = Math.round(ms / 300 * (n - 1)); g.fillText(ms + ' ms', padL + i / (n - 1) * offX + Wp + 4, H - padB - i / (n - 1) * offY); }
}

// ---------------------------------------------------------------- target curve editor
export function targetPanel(ctx) {
  const S = ctx.S;
  const cv = h('canvas', { class: 'graph', style: 'height:260px;touch-action:none;cursor:crosshair' });
  const cur = () => cleanNodes(S.room.target) || defaultTarget(S.meas.lfRise);
  const pad = { l: 40, r: 12, t: 10, b: 22 };
  let drag = -1, nodes = null;
  const geo = () => ({ w: cv.clientWidth, H: cv.clientHeight });
  const toF = px => 20 * Math.exp(Math.min(1, Math.max(0, (px - pad.l) / (geo().w - pad.l - pad.r))) * Math.log(1000));
  const toDb = py => 12 - (Math.min(geo().H - pad.b, Math.max(pad.t, py)) - pad.t) / (geo().H - pad.t - pad.b) * 24;
  const fx = f => pad.l + Math.log(f / 20) / Math.log(1000) * (geo().w - pad.l - pad.r);
  const dy = d => pad.t + (1 - (d + 12) / 24) * (geo().H - pad.t - pad.b);
  const status = h('p', { class: 'hint' });
  const draw = () => {
    const ns = nodes || cur(), grid = logArr(20, 20000, 220);
    drawGraph(cv, { dmin: -12, dmax: 12, dstep: 3, zero: true, pad, curves: [{ f: grid, db: grid.map(f => nodesAt(ns, f)), color: css('--accent'), width: 2.4 }] });
    const c = cv.getContext('2d'); c.fillStyle = css('--ink'); c.strokeStyle = css('--accent'); c.lineWidth = 2;
    for (const [f, d] of ns) { c.fillStyle = css('--panel'); c.beginPath(); c.arc(fx(f), dy(d), 6, 0, 7); c.fill(); c.stroke(); }
    const isDef = !S.room.target;
    status.textContent = isDef ? `使用中：預設低頻抬升（20 Hz 比 200 Hz 高 ${S.meas.lfRise} dB，在「一鍵校正」的低頻抬升旋鈕調整）。拖曳任一節點即改為自訂目標曲線。` : '使用中：自訂目標曲線。「一鍵校正」的 EQ 會把量測拉向這條曲線（以 200–1500 Hz 的平均音量為 0 dB）。';
  };
  const save = () => { S.room.target = nodes.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]); ctx.saveState(); };
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
    nodes = cur().map(p => p.slice());
    let hit = -1, bd = 12; nodes.forEach((p, i) => { const d = Math.hypot(fx(p[0]) - px, dy(p[1]) - py); if (d < bd) { bd = d; hit = i; } });
    if (hit < 0) { nodes.push([toF(px), Math.round(toDb(py) * 2) / 2]); nodes.sort((a, b) => a[0] - b[0]); hit = nodes.findIndex(p => p[0] === toF(px)); }
    drag = hit; cv.setPointerCapture(e.pointerId); draw();
  });
  cv.addEventListener('pointermove', e => {
    if (drag < 0) return;
    const r = cv.getBoundingClientRect(), n = nodes.length;
    let f = toF(e.clientX - r.left); const lo = drag > 0 ? nodes[drag - 1][0] * 1.02 : 20, hi = drag < n - 1 ? nodes[drag + 1][0] / 1.02 : 20000;
    f = Math.min(hi, Math.max(lo, f));
    if (drag === 0) f = 20; if (drag === n - 1) f = 20000;   // the end nodes stay at the edges
    nodes[drag] = [f, Math.round(toDb(e.clientY - r.top) * 2) / 2]; draw();
  });
  const up = () => { if (drag >= 0) { drag = -1; save(); nodes = null; draw(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('dblclick', e => {
    const r = cv.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, ns = cur().map(p => p.slice());
    const i = ns.findIndex(p => Math.hypot(fx(p[0]) - px, dy(p[1]) - py) < 12);
    if (i > 0 && i < ns.length - 1) { ns.splice(i, 1); nodes = ns; save(); nodes = null; draw(); }
  });
  const pre = keys({ options: [{ id: 'def', label: '預設' }, ...Object.entries(TARGET_PRESETS).map(([id, p]) => ({ id, label: p.name }))], value: S.room.target ? '' : 'def', onInput: id => {
    S.room.target = id === 'def' ? null : TARGET_PRESETS[id].nodes.map(p => p.slice()); ctx.saveState(); draw();
  } });
  const root = h('div', { class: 'panel', id: 'targetPanel' },
    head('Z', '目標曲線', 'Target curve'),
    h('div', { class: 'graph-tools' }, h('span', { class: 'muted' }, '預設組'), pre.el),
    cv, status,
    h('p', { class: 'hint' }, '拖曳節點調整（20 Hz–20 kHz，±12 dB）；點空白處新增節點，連按兩下節點刪除。自動 EQ 只修 300 Hz 以下，但整條曲線的形狀（以 200–1500 Hz 為基準）都會一併參考。'));
  onResize(cv, draw); requestAnimationFrame(draw); onTab('auto', draw);
  return root;
}

// ---------------------------------------------------------------- mic pairing
const smoothDb = (f, db, frac) => {
  const half = Math.pow(2, 1 / (2 * frac));
  return f.map((fr, i) => { let s = 0, n = 0; for (let j = 0; j < f.length; j++) if (f[j] >= fr / half && f[j] <= fr * half) { s += db[j]; n++; } return n ? s / n : db[i]; });
};
export function micPanel(ctx) {
  const S = ctx.S, mic = () => (S.mic.cal ||= {});
  let devs = [], A = '', B = '', ch = 'FL', curA = null, curB = null;
  const body = h('div', {});
  const demoMics = () => window.__fonoDemoMics || null;
  const listDevs = async () => {
    if (demoMics()) { devs = demoMics(); }
    else {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch {}
      try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'communications'); } catch { devs = []; }
    }
    if (!devs.some(d => d.deviceId === A)) A = devs[0]?.deviceId || '';
    if (!devs.some(d => d.deviceId === B) || B === A) B = devs.find(d => d.deviceId !== A)?.deviceId || '';
    draw();
  };
  const name = id => (devs.find(d => d.deviceId === id)?.label || id || '').slice(0, 48) || '（未命名）';
  const measure = async which => {
    const id = which === 'A' ? A : B;
    if (!id) { toast('請先選擇麥克風', true); return; }
    try {
      toast(`量測麥克風 ${which}…`);
      const curve = demoMics() ? window.__fonoDemoMicCurve(id) : await ctx.measureMic(ch, id);
      if (which === 'A') curA = curve; else curB = curve;
      draw();
    } catch (e) { toast('量測失敗：' + e.message, true); }
  };
  const compute = () => {
    if (!curA || !curB) return;
    const f = curA.f, raw = f.map((_, i) => curB.db[i] - curA.db[i]);
    const ref = raw.filter((_, i) => f[i] >= 500 && f[i] <= 2000).sort((a, b) => a - b), off = ref[ref.length >> 1] || 0;   // only the shape matters, not the sensitivity
    const sm = smoothDb(f, raw.map(v => v - off), 6), nodes = [];
    for (let fr = 20; fr <= 20000 * 1.001; fr *= Math.pow(2, 1 / 12)) nodes.push([Math.round(fr * 10) / 10, Math.round(interpCurve({ f, db: sm }, fr) * 100) / 100]);
    mic()[B] = nodes; ctx.saveState(); toast('已儲存麥克風 B 的校正曲線'); draw();
  };
  const draw = () => {
    body.innerHTML = '';
    const chSel = select(SPK.map(k => [k, k]), ch, v => { ch = v; });
    const mkSel = (val, set) => select([['', '（選擇）'], ...devs.map(d => [d.deviceId, d.label || d.deviceId.slice(0, 12)])], val, v => { set(v); draw(); });
    const calSel = select(Object.keys(mic()).concat(B && !mic()[B] ? [B] : []).map(id => [id, name(id)]), B, v => { B = v; draw(); });
    const file = h('input', { type: 'file', accept: '.txt,.cal,text/plain', style: 'display:none' });
    file.onchange = async () => {
      const fl = file.files[0]; file.value = ''; if (!fl) return;
      const cal = parseCalText(await fl.text());
      if (!cal) { toast(fl.name + '：讀不到「頻率 dB」資料', true); return; }
      if (!B) { toast('請先選擇要套用的麥克風 B', true); return; }
      mic()[B] = cal; ctx.saveState(); toast(`已匯入 ${cal.length} 點，套用到 ${name(B)}`); draw();
    };
    const cvs = h('canvas', { class: 'graph', style: 'height:220px;margin-top:10px' });
    const saved = Object.entries(mic());
    body.append(
      h('div', { class: 'wiz-grid' },
        h('label', { class: 'field' }, h('span', {}, '麥克風 A（基準）'), mkSel(A, v => { A = v; curA = null; })),
        h('label', { class: 'field' }, h('span', {}, '麥克風 B（要被校正的）'), mkSel(B, v => { B = v; curB = null; })),
        h('label', { class: 'field' }, h('span', {}, '量測用喇叭'), chSel)),
      h('div', { class: 'wiz-actions', style: 'margin-top:10px' },
        h('button', { class: 'btn', type: 'button', onclick: () => measure('A') }, curA ? '重新量 A ✓' : '1. 用 A 量測'),
        h('button', { class: 'btn', type: 'button', onclick: () => measure('B') }, curB ? '重新量 B ✓' : '2. 用 B 量測（麥克風放在同一個位置）'),
        h('button', { class: 'btn primary', type: 'button', disabled: curA && curB ? null : '', onclick: compute }, '3. 儲存差異曲線'),
        h('button', { class: 'btn', type: 'button', onclick: listDevs }, '重新整理裝置')),
      h('p', { class: 'hint' }, 'A 和 B 先後量同一顆喇叭、同一個位置（用腳架固定，不要動）。差異曲線（B − A，1/6 倍頻平滑，只取形狀）會存在這支麥克風的名下，之後用 B 做的一鍵校正都會先扣掉它。'),
      h('div', { class: 'ph', style: 'margin-top:14px' }, h('span', { class: 'tag' }, 'U'), h('h2', {}, '匯入校正檔'), h('span', { class: 'rule' })),
      h('div', { class: 'wiz-actions', style: 'margin-top:0' }, h('span', { class: 'muted' }, '套用到'), calSel,
        h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, '選擇 .txt 校正檔'), file),
      h('p', { class: 'hint' }, '格式：每行「頻率 增益dB」（UMIK 等原廠檔）；以 " 或 * 開頭的行會略過。'),
      saved.length ? h('table', { class: 'modes-table' }, h('tr', {}, h('th', {}, '麥克風'), h('th', {}, '點數'), h('th', {}, '範圍'), h('th', {}, '')),
        ...saved.map(([id, c]) => h('tr', {}, h('td', {}, name(id)), h('td', {}, c.length), h('td', {}, `${Math.min(...c.map(p => p[1])).toFixed(1)} … ${Math.max(...c.map(p => p[1])).toFixed(1)} dB`),
          h('td', {}, h('button', { class: 'btn ghost', type: 'button', onclick: () => { delete mic()[id]; ctx.saveState(); draw(); } }, '刪除'))))) : h('p', { class: 'hint' }, '還沒有儲存任何校正。'),
      cvs);
    requestAnimationFrame(() => {
      const cal = mic()[B]; const curves = [];
      if (cal) curves.push({ f: cal.map(p => p[0]), db: cal.map(p => p[1]), color: css('--accent'), width: 2.2 });
      drawGraph(cvs, { dmin: -8, dmax: 8, dstep: 2, zero: true, curves });
    });
  };
  const root = h('div', { class: 'panel', id: 'micPanel' }, head('B', '麥克風配對', 'Mic matching', true), body);
  draw(); onTab('mic', listDevs);
  return root;
}

// ---------------------------------------------------------------- equal-loudness compensation (fx page)
export function loudnessPanel(ctx) {
  const S = ctx.S, L = S.fx.loud || (S.fx.loud = { on: false, level: 70 });
  const cv = h('canvas', { class: 'curve', style: 'height:180px;width:100%;margin-top:10px' });
  const info = h('p', { class: 'hint' });
  const update = () => {
    const lv = Math.min(83, Math.max(60, L.level)), fit = fitLoudness(lv), grid = fit.grid;
    info.textContent = lv >= 83 ? '聆聽音量與基準相同，不需要補償。' : `ISO 226:2003 等響度曲線在 ${lv} phon 與 83 phon 的差（以 1 kHz 為準），擬合成：` + (fit.filters.map(f => `${f.type === 'LSC' ? '低頻擱架' : '高頻擱架'} ${f.fc} Hz ${f.gain > 0 ? '+' : ''}${f.gain} dB`).join('、') || '無') + `（擬合誤差 RMS ${fit.rms.toFixed(1)} dB）。`;
    const mx = Math.max(4, Math.ceil(Math.max(...fit.target)) + 1);
    drawGraph(cv, { fmin: 20, fmax: 12500, dmin: -4, dmax: mx, dstep: mx > 12 ? 4 : 2, zero: true, curves: [
      { f: grid, db: fit.target, color: css('--ink-3'), width: 1.6, dash: [5, 4] },
      { f: grid, db: grid.map(f => chainDb(fit.filters, f)), color: css('--accent'), width: 2.4 }] });
  };
  const apply = () => { ctx.changed(); ctx.redrawFx?.(); update(); };
  const onT = toggle({ label: '等響度補償', sub: '小聲聽時補回低頻與高頻', value: L.on, onInput: v => { L.on = v; apply(); } });
  const lvK = knob({ label: '聆聽音量', size: 64, min: 60, max: 83, step: 1, def: 70, value: L.level, fmt: v => v + ' phon', onInput: v => { L.level = v; apply(); } });
  const root = h('div', { class: 'panel', id: 'loudPanel' }, head('L', '等響度補償', 'Equal loudness', true),
    h('div', { style: 'display:flex;gap:18px;align-items:center;flex-wrap:wrap' }, onT.el, lvK.el),
    cv, info,
    h('p', { class: 'hint' }, '人耳在小聲時對低頻和高頻較不敏感。以 83 phon（一般錄音／混音的參考音量）為基準，音量調低時依 ISO 226:2003 補回差距：灰虛線是標準曲線的差，亮線是實際寫進 EQ APO 的一組低頻＋高頻擱架濾波器。'));
  onResize(cv, update); requestAnimationFrame(update);
  return root;
}

// ---------------------------------------------------------------- ART report chart (before / after per 1/3-octave band)
export function artReportChart(rep) {
  const cv = h('canvas', { class: 'curve', style: 'height:190px;width:100%;margin-top:10px' });
  const draw = () => {
    const c = setupCanvas(cv); if (!c) return;
    const { g, w, h: H } = c, n = rep.bands.length, padL = 40, padB = 34, padT = 22;
    const vals = [...rep.before, ...rep.cv, ...(rep.drift || [])].filter(Number.isFinite), mx = Math.max(100, Math.ceil(Math.max(...vals) / 100) * 100);
    const Y = v => H - padB - v / mx * (H - padB - padT), slot = (w - padL - 10) / n, bw = Math.min(26, slot * 0.34);
    g.font = '10px sans-serif'; g.lineWidth = 1; g.strokeStyle = css('--line'); g.fillStyle = css('--ink-3'); g.textAlign = 'right';
    for (let v = 0; v <= mx; v += mx / 4) { g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(w - 6, Y(v)); g.stroke(); g.fillText(Math.round(v) + '', padL - 4, Y(v) + 3); }
    g.textAlign = 'center';
    rep.bands.forEach((b, i) => {
      const cx = padL + slot * (i + 0.5);
      const bar = (v, dx, color) => { if (!Number.isFinite(v)) return; g.fillStyle = color; g.fillRect(cx + dx, Y(v), bw, H - padB - Y(v)); };
      bar(rep.before[i], -bw - 1, css('--ink-3')); bar(rep.cv[i], 1, css('--accent'));
      if (rep.drift && Number.isFinite(rep.drift[i])) { g.strokeStyle = css('--ink'); g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx + 1, Y(rep.drift[i])); g.lineTo(cx + 1 + bw, Y(rep.drift[i])); g.stroke(); }
      g.fillStyle = css('--ink-3'); g.fillText(b + ' Hz', cx, H - padB + 13);
    });
    g.textAlign = 'left'; g.fillStyle = css('--ink-3'); g.fillText(rep.title || '殘響時間 ms（1/3 倍頻帶）', padL, 11);
    let lx = w - 10; g.textAlign = 'right';
    const LB = rep.labels || ['室溫差 6 °C', '校正後（預估）', '校正前'];
    for (const [t, col] of [[LB[0], css('--ink')], [LB[1], css('--accent')], [LB[2], css('--ink-3')]]) { g.fillStyle = col; g.fillText(t, lx, 11); lx -= g.measureText(t).width + 18; }
  };
  onResize(cv, draw); requestAnimationFrame(draw);
  return cv;
}
