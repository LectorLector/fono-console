// 耳機：per-device profiles (AutoEq, crossfeed, tone), Bluetooth battery and
// hands-free control. Profiles are written as Device: blocks in Equalizer APO.
import { h, $, toast, api, post, css, drawGraph } from './ui.js';
import { toggle, knob, keys } from './widgets.js';
import { parseFilterText, chainDb, logGrid } from './dsp.js';

let C; // { S, RT, saveState, changed }
const H = { index: null, sel: '', query: '' };
const GRID = Array.from(logGrid(20, 20000, 200));

async function loadIndex() {
  if (H.index) return H.index;
  const t = await fetch('/api/autoeq/index').then(r => { if (!r.ok) throw new Error('AutoEq ' + r.status); return r.text(); });
  H.index = [];
  for (const line of t.split('\n')) {
    const m = /^- \[(.+?)\]\(\.\/(.+?)\) by (.+)$/.exec(line.trim());
    if (m) H.index.push({ name: m[1], path: decodeURIComponent(m[2]), by: m[3] });
  }
  return H.index;
}

async function loadProfile(entry) {
  const txt = await fetch('/api/autoeq/file?path=' + encodeURIComponent(`${entry.path}/${entry.name} ParametricEQ.txt`)).then(r => { if (!r.ok) throw new Error('找不到這個耳機的 ParametricEQ'); return r.text(); });
  const pre = /Preamp:\s*([-\d.]+)/i.exec(txt);
  return { title: entry.name, by: entry.by, path: entry.path, preamp: pre ? +pre[1] : 0, filters: parseFilterText(txt) };
}

// The multichannel card is speakers only. The stereo DAC can drive speakers or
// headphones (Equalizer APO cannot tell which is plugged in), so it is listed
// here with a speakers / headphones switch.
const isSpeaker = g => !!g && g === C.S.dev.cm;
const isDac = g => !!g && g === C.S.dev.spark && g !== C.S.dev.cm;
const label = d => `${d.name || '輸出'}${d.iface ? ' (' + d.iface + ')' : ''}`;
const devList = () => (C.RT.devices || []).filter(d => !isSpeaker(d.guid));

function profileFor(guid, d) {
  const P = C.S.hp.profiles;
  if (!P[guid]) P[guid] = { name: d ? label(d) : guid, enabled: true, eqOn: true, fx: true, bass: 0, treble: 0, autoeq: null, crossfeed: { on: false, level: -6, fc: 700, delay: 0.3 } };
  return P[guid];
}

function ensureSelection() {
  const list = devList();
  if (list.some(d => d.guid === H.sel)) return false;
  const pick = list.find(d => d.guid === C.RT.defDev) || list.find(d => isDac(d.guid)) || list[0];
  H.sel = pick ? pick.guid : '';
  return true;
}

function renderDevices() {
  const box = $('#hpDevices'); if (!box) return;
  const changedSel = ensureSelection();
  box.innerHTML = '';
  const list = devList();
  for (const d of list) {
    const prof = C.S.hp.profiles[d.guid];
    const dac = isDac(d.guid);
    const tags = [
      d.guid === C.RT.defDev ? '目前輸出' : '',
      dac ? (C.S.dev.sparkLoad === 'headphones' ? '立體聲 DAC · 接耳機' : '立體聲 DAC · 接喇叭') : '',
      prof?.autoeq ? 'AutoEq：' + prof.autoeq.title : prof && !dac ? '已建立設定' : '',
      d.eapo ? '' : '⚠ 尚未安裝 EQ APO'].filter(Boolean);
    const b = h('button', { class: 'hp-dev' + (H.sel === d.guid ? ' on' : ''), type: 'button', title: label(d) },
      h('b', {}, label(d)),
      h('small', {}, tags.join(' · ') || '點選建立設定'));
    b.onclick = () => { H.sel = d.guid; renderDevices(); renderEditor(); };
    box.append(b);
  }
  if (!list.length) box.append(h('p', { class: 'hint' }, '目前沒有連接中的耳機或其他輸出裝置。藍牙耳機連上後會自動出現。'));
  if (changedSel) renderEditor();
}

function curveOf(prof) {
  const fl = [...(prof.eqOn !== false && prof.autoeq ? prof.autoeq.filters : []),
    ...(Math.abs(prof.bass) > 0.05 ? [{ type: 'LSC', fc: 105, gain: prof.bass, q: 0.707 }] : []),
    ...(Math.abs(prof.treble) > 0.05 ? [{ type: 'HSC', fc: 8000, gain: prof.treble, q: 0.707 }] : [])];
  const pre = prof.eqOn !== false && prof.autoeq ? prof.autoeq.preamp : 0;
  return { f: GRID, db: GRID.map(f => chainDb(fl, f) + pre) };
}

function renderEditor() {
  const box = $('#hpEditor'); if (!box) return;
  box.innerHTML = '';
  const d = (C.RT.devices || []).find(x => x.guid === H.sel);
  if (!d) { box.append(h('p', { class: 'hint' }, '從左邊選一個耳機或輸出裝置。')); return; }
  const prof = profileFor(d.guid, d);
  const upd = () => { C.saveState(); C.changed(); drawCurve(prof); renderDevices(); };
  const q = h('input', { type: 'text', placeholder: '搜尋耳機型號，例如 Px7、HD 650、WF-1000XM5', value: H.query, style: 'flex:1' });
  const res = h('div', { class: 'ae-results' });
  const search = async () => {
    H.query = q.value.trim(); res.innerHTML = '';
    if (H.query.length < 2) return;
    res.append(h('p', { class: 'hint' }, '搜尋 AutoEq 資料庫…'));
    try {
      const idx = await loadIndex();
      const words = H.query.toLowerCase().split(/\s+/);
      const hits = idx.filter(e => words.every(w => e.name.toLowerCase().includes(w))).slice(0, 30);
      res.innerHTML = '';
      hits.forEach(e => { const b = h('button', { class: 'ae-hit', type: 'button' }, h('b', {}, e.name), h('small', {}, e.by)); b.onclick = async () => { try { prof.autoeq = await loadProfile(e); prof.eqOn = true; upd(); renderEditor(); toast('已套用 AutoEq：' + e.name); } catch (err) { toast(err.message, true); } }; res.append(b); });
      if (!hits.length) res.append(h('p', { class: 'hint' }, '找不到。可以試試較短的型號，或同系列前一代（例如 Px7 S2）。'));
    } catch (err) { res.innerHTML = ''; res.append(h('p', { class: 'hint' }, '無法載入 AutoEq：' + err.message)); }
  };
  q.onkeydown = e => { if (e.key === 'Enter') search(); };
  const t = (lab, sub, obj, key) => toggle({ label: lab, sub, value: obj[key], onInput: v => { obj[key] = v; upd(); } }).el;
  const k = (lab, obj, key, o) => knob({ label: lab, size: 62, value: obj[key], ...o, onInput: v => { obj[key] = v; upd(); } }).el;
  const dac = isDac(d.guid);
  const loadK = dac ? keys({ options: [{ id: 'speakers', label: '喇叭' }, { id: 'headphones', label: '耳機' }], value: C.S.dev.sparkLoad || 'speakers',
    onInput: v => { C.S.dev.sparkLoad = v; C.saveState(); C.changed(); renderDevices(); renderEditor(); toast(v === 'headphones' ? '立體聲 DAC 改用下面的耳機設定' : '立體聲 DAC 改回喇叭（房間矯正）'); } }) : null;
  box.append(...[
    h('div', { class: 'ph' }, h('h2', { title: label(d) }, label(d)), h('span', { class: 'rule' })),
    dac ? h('div', { class: 'hp-load' }, h('span', {}, '這台 DAC 目前接：'), loadK.el,
      h('p', { class: 'hint' }, C.S.dev.sparkLoad === 'headphones'
        ? '現在套用下面的耳機設定，不做房間矯正。換回喇叭時記得切回來。'
        : '現在套用房間矯正（立體聲模式）。插耳機聽時切到「耳機」，下面的設定才會生效。')) : null,
    d.eapo ? null : h('div', { class: 'banner warn' }, '這個裝置還沒安裝 Equalizer APO，設定不會生效。', h('button', { class: 'btn', onclick: () => post('/api/eapo/selector').then(() => toast('在 Device Selector 勾選這個裝置後按 OK（需要按 UAC「是」）')).catch(e => toast(e.message, true)) }, '開啟 Device Selector')),
    h('div', { class: 'hp-row' }, t('啟用這個設定', '關閉＝這個裝置不做任何處理', prof, 'enabled'), t('套用音效頁的 EQ／混響', '', prof, 'fx')),
    h('div', { class: 'field', style: 'margin-top:12px' }, h('span', {}, 'AutoEq 耳機頻響校正（目標曲線：Harman）'), h('div', { style: 'display:flex;gap:8px;flex:1 1 100%' }, q, h('button', { class: 'btn', onclick: search }, '搜尋'))),
    res,
    prof.autoeq ? h('div', { class: 'hp-row' }, t('AutoEq 校正', `${prof.autoeq.title} · ${prof.autoeq.by} · ${prof.autoeq.filters.length} 個濾波器`, prof, 'eqOn'), h('button', { class: 'btn ghost', onclick: () => { prof.autoeq = null; upd(); renderEditor(); } }, '移除')) : null,
    h('canvas', { class: 'curve', id: 'hpCurve' }),
    h('div', { class: 'knob-row', style: 'margin-top:10px' },
      k('低音', prof, 'bass', { min: -8, max: 8, step: 0.5, def: 0, bipolar: true, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1), unit: ' dB' }),
      k('高音', prof, 'treble', { min: -8, max: 8, step: 0.5, def: 0, bipolar: true, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1), unit: ' dB' })),
    h('div', { class: 'ph', style: 'margin-top:14px' }, h('h2', {}, '交叉饋送'), h('span', { class: 'en' }, 'Crossfeed'), h('span', { class: 'rule' })),
    h('p', { class: 'hint', style: 'margin-top:0' }, '把一點延遲、低通過的對側聲道混進每一耳，模擬聽喇叭時兩耳都聽得到兩邊的聲音，聲像會從腦中移到前方，聽久比較不累。'),
    h('div', { class: 'hp-row' }, t('交叉饋送', '', prof.crossfeed, 'on'),
      k('饋送量', prof.crossfeed, 'level', { min: -15, max: -3, step: 0.5, def: -6, fmt: v => v.toFixed(1), unit: ' dB' }),
      k('低通', prof.crossfeed, 'fc', { min: 300, max: 1500, step: 10, def: 700, fmt: v => v + ' Hz' }),
      k('延遲', prof.crossfeed, 'delay', { min: 0.1, max: 0.6, step: 0.01, def: 0.3, fmt: v => v.toFixed(2), unit: ' ms' }))].filter(Boolean));
  requestAnimationFrame(() => drawCurve(prof));
}

function drawCurve(prof) {
  const c = $('#hpCurve'); if (!c) return;
  drawGraph(c, { dmin: -15, dmax: 10, dstep: 5, zero: true, curves: [{ ...curveOf(prof), color: css('--accent'), width: 2.2 }] });
}

export function renderBT() {
  const box = $('#hpBT'); if (!box) return;
  box.innerHTML = '';
  // One physical headset shows up as several Bluetooth nodes (classic + LE): merge by name.
  const byName = new Map();
  for (const d of C.RT.bt || []) {
    const cur = byName.get(d.name) || { name: d.name, battery: null, hfp: [], connected: false, last: null };
    if (d.connected) cur.connected = true;
    if (d.connected && d.battery != null) cur.battery = d.battery;
    if (d.last && (!cur.last || d.last > cur.last)) cur.last = d.last;
    for (const x of d.hfp || []) if (!cur.hfp.some(y => y.id === x.id)) cur.hfp.push(x);
    byName.set(d.name, cur);
  }
  const all = [...byName.values()];
  const on = all.filter(d => d.connected), off = all.filter(d => !d.connected);
  for (const d of on) {
    const bat = d.battery != null
      ? h('span', { class: 'bat', title: '電量 ' + d.battery + '%' }, h('i', { style: `width:${Math.max(4, d.battery)}%` }), h('b', {}, d.battery + '%'))
      : h('span', { class: 'muted bt-nobat' }, '電量未回報');
    const hf = d.hfp.find(x => x.status !== 'Unknown') || null;
    const hfOn = hf ? hf.status === 'OK' : false;
    const hfT = hf ? toggle({ label: '免持通話', sub: hfOn ? '開麥克風時會掉成單聲道' : '已停用，維持立體聲音質', small: true, value: hfOn, onInput: async v => {
      toast('請在 UAC 視窗按「是」');
      try { for (const x of d.hfp) await post('/api/bt/hfp', { id: x.id, enable: v }); toast(v ? '已啟用免持模式' : '已停用免持模式'); post('/api/media', { c: 'bt' }); } catch (e) { toast('切換失敗：' + (e.body?.detail || e.message), true); }
    } }).el : h('span', { class: 'muted' }, '沒有免持服務');
    box.append(h('div', { class: 'bt-row' }, h('div', { class: 'bt-head' }, h('i', { class: 'bt-dot' }), h('b', { title: d.name }, d.name), bat), h('div', { class: 'bt-ctl' }, hfT)));
  }
  if (!on.length) box.append(h('p', { class: 'hint', style: 'margin-top:0' }, '目前沒有連線中的藍牙耳機。'));
  if (off.length) {
    const fmtLast = t => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t || ''); return m ? `${+m[2]}/${+m[3]}` : ''; };
    box.append(h('div', { class: 'bt-off' }, h('span', {}, `已配對、未連線（${off.length}）`),
      h('ul', {}, ...off.map(d => h('li', { title: d.name }, d.name, d.last ? h('small', {}, ' · 上次 ' + fmtLast(d.last)) : '')))));
  }
  if (C.RT.bt == null) { box.innerHTML = ''; box.append(h('p', { class: 'hint', style: 'margin-top:0' }, '讀取藍牙裝置中…')); return; }
  if (!all.length) box.append(h('p', { class: 'hint' }, '沒有找到配對的藍牙裝置。'));
}

export function buildHeadphones(root, ctx) {
  C = ctx;
  root.innerHTML = '';
  root.append(
    h('div', { class: 'page-head' }, h('div', { class: 'num' }, '06'), h('div', {}, h('h1', {}, '耳機'), h('div', { class: 'sub' }, '每個耳機各自一組設定，切換輸出裝置時自動套用。')), h('div', { class: 'bar' })),
    h('div', { class: 'hp-grid' },
      h('div', { class: 'grid' },
        h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, '輸出裝置'), h('span', { class: 'rule' })), h('div', { id: 'hpDevices', class: 'hp-devs' })),
        h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'B'), h('h2', {}, '藍牙'), h('span', { class: 'rule' }),
          h('button', { class: 'btn ghost', onclick: () => post('/api/media', { c: 'bt' }) }, '重新整理'),
          h('button', { class: 'btn ghost', onclick: () => post('/api/launch', { app: 'bluetooth' }) }, 'Windows 藍牙設定')),
          h('div', { id: 'hpBT' }),
          h('p', { class: 'hint' }, 'Windows 的藍牙音質（AAC、aptX、LDAC）由耳機與藍牙晶片協商，軟體無法指定；停用免持模式可以避免開會軟體或遊戲開麥克風時，耳機掉成通話用的單聲道低音質。'))),
      h('div', { class: 'panel', id: 'hpEditor' })));
  ensureSelection();
  renderDevices(); renderEditor(); renderBT();
}

export const hpHooks = { renderDevices, renderBT, renderEditor };
