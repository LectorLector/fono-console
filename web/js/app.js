// Fono Console UI.
import { loadState, saveState, applyPreset, PRESETS } from './state.js';
import { genConfig, headroom, fxFilters, EQ_BANDS, SPK, IR_RATES, alignDelays, layoutOf } from './eapo.js';
import { chainDb, logGrid, parseFilterText, normaliseRewFilters, rewResponseToCurve, parseRewTextCurve, smooth, interpCurve, roomModes, schroeder } from './dsp.js';
import { knob, fader, toggle, selector, keys, h } from './widgets.js';
import { openSetup } from './setup.js';
import { startTour } from './tour.js';
import * as audio from './audio.js';
import { $, fmtTime, sgn, css, toast, api, post, setupCanvas, drawGraph } from './ui.js';
import { buildLibrary, libraryHooks } from './library.js';
import { buildMeasureWizard, measureMicRaw, refreshLayout } from './wizard.js';
import { planPanel, reflPanel2, decayPanel, targetPanel, micPanel, loudnessPanel } from './lab2.js';
import { roomScanPanel } from './lab.js';
import { applyLookExtras, lookSections, lookExport, lookImport } from './look.js';
import { buildHeadphones, hpHooks } from './headphones.js';
import { createPlayer, playerSections } from './player.js';
import { dash } from './dash.js';
import { initI18n, setLang, getLang, setData, t as tl } from './i18n.js';
function changed() { saveState(S); scheduleApply(); refreshStatus(); }

let S;                    // persisted state
const RT = {              // runtime (not persisted)
  sys: null, media: { sessions: [], cur: '' }, mediaAt: 0, pick: '', devices: [], defDev: '',
  eapo: { ok: null, err: '' }, rew: { ok: false, list: [], curves: {}, sel: new Set(), assign: {} },
  irHash: '', customIR: null, meter: [], meterPeak: [], bridge: {},
};
const ui = window.__fonoUi = {};            // widget handles for refresh

const ICON = {
  prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2.5v14H6zM20 5v14L9.5 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M15.5 5H18v14h-2.5zM4 5l10.5 7L4 19z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15L20 12z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg>',
};
const SPK_DESC_DEFAULT = { FL: '前方喇叭', FR: '前方喇叭', SL: '後方喇叭', SR: '後方喇叭' };
const spkDesc = k => (S.spk && S.spk[k]) || SPK_DESC_DEFAULT[k];
const SPK_NAME = { FL: '前左', FR: '前右', SL: '後左', SR: '後右' };
const MODES = [
  { id: 'stereo', label: '立體聲', name: '立體聲', desc: '只用前方一對喇叭（可走另一台立體聲 DAC），只套用前方矯正，最純粹的雙聲道。' },
  { id: 'quadA', label: '四聲道 A', name: '四聲道 · 氛圍', desc: '後方喇叭比前方晚 10–20 ms、低 4–8 dB，增加空間感，聲像仍在前方。' },
  { id: 'quadB', label: '四聲道 B', name: '四聲道 · 低頻', desc: '後方喇叭只放分頻點以下的低頻，與前方同時到達，補強並抹平駐波。' },
  { id: 'art', label: 'ART 低頻', name: 'ART 低頻主動校正', desc: '實驗功能：四顆喇叭一起抵消低頻駐波的殘響；前方播主聲音，後方只負責低頻。需要先在「量測 → ART 低頻」計算。' },
  { id: 'measure', label: '量測路由', name: '量測路由', desc: 'REW 左聲道只送到目標喇叭，右聲道固定送 FL 當計時參考；矯正照常套用。' },
  { id: 'identify', label: '聲道識別', name: '聲道識別', desc: '左聲道只送到選定的喇叭，用粉紅噪音確認每個插孔接到哪裡。' },
];
const modeInfo = id => MODES.find(m => m.id === id) || MODES[0];

function appName(id = '') {
  const s = id.toLowerCase();
  if (s.includes('spotify')) return 'Spotify';
  if (s.includes('youtube-music') || s.includes('youtube music') || s.includes('ytmdesktop') || s.includes('th-ch') || s.includes('pear')) return 'YouTube Music';
  if (s.includes('msedge')) return 'Edge';
  if (s.includes('chrome')) return 'Chrome';
  if (s.includes('firefox') || s === '308046b0af4a39cb') return 'Firefox';
  if (s.includes('foobar')) return 'foobar2000';
  return id.replace(/\.exe$/i, '').split(/[\\!.]/).filter(Boolean).pop() || '媒體';
}

// ================================================================ EQ APO engine
let applyT = null, applyChain = Promise.resolve();
function scheduleApply(delay = 160) { clearTimeout(applyT); applyT = setTimeout(applyEapo, delay); }
/** Serialised: resolves after this (and any queued) write has finished. */
function applyEapo() { applyChain = applyChain.then(applyEapoInner, applyEapoInner); return applyChain; }

function irKey() {
  const r = S.fx.rev;
  return JSON.stringify([r.src, r.wet, r.rt60, r.predelay, r.damping, r.early, r.customName]);
}

async function applyEapoInner() {
  try {
    const irRates = [];
    if (S.fx.on && S.fx.rev.on && S.fx.rev.wet > 0) {
      const key = irKey();
      if (key !== RT.irHash) {
        let custom = null;
        if (S.fx.rev.src === 'custom') {
          custom = RT.customIR || await fetch('/api/custom-ir').then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
          RT.customIR = custom;
        }
        const files = await audio.buildIRs(S.fx.rev, IR_RATES, custom);
        for (const sr of IR_RATES) {
          await api(`/api/eapo/file?name=${encodeURIComponent(`fono/ir_${sr}.wav`)}`, { method: 'POST', body: files[sr] });
        }
        RT.irHash = key;
      }
      irRates.push(...IR_RATES);
    }
    const fr = S.room.fir;
    const fir = fr.built ? { rates: IR_RATES, chans: fr.chans, latencyMs: fr.latencyMs } : null;
    const ar = S.room.art;
    const art = ar.built ? { rates: IR_RATES, preampDb: ar.preampDb } : null;
    const text = genConfig(S, { irRates, fir, art });
    RT.lastConfig = text;
    await fetch('/api/eapo/console?ensure=1', { method: 'POST', body: text }).then(async r => {
      if (!r.ok) { const j = await r.json().catch(() => ({})); const e = new Error(j.error || 'write'); e.status = r.status; throw e; }
      const j = await r.json();
      if (j.includeAdded) toast('已在 config.txt 加入 Include: fono_console.txt');
    });
    RT.eapo = { ok: true, err: '', at: Date.now() };
  } catch (e) {
    RT.eapo = { ok: false, err: e.status === 403 ? 'permission' : e.status === 404 ? 'no-eapo' : e.message };
  } finally {
    refreshStatus();
    if ($('#cfgPreview')) $('#cfgPreview').textContent = RT.lastConfig || genConfig(S, {});
  }
}

// ================================================================ status / header
function refreshStatus() {
  const le = $('#lampEapo');
  le.className = 'status-lamp ' + (RT.eapo.ok ? 'ok' : RT.eapo.ok === false ? (RT.eapo.err === 'permission' ? 'warn' : 'bad') : '');
  le.title = tl(RT.eapo.ok ? '設定已寫入 Equalizer APO' : RT.eapo.err === 'permission' ? '沒有寫入權限，請到「設定」授權' : RT.eapo.err === 'no-eapo' ? '找不到 Equalizer APO' : RT.eapo.err || '');
  const lr = $('#lampRew'); lr.className = 'status-lamp ' + (RT.rew.ok ? 'ok' : '');
  const lm = $('#lampMedia'); lm.className = 'status-lamp ' + (RT.media.sessions.length ? 'ok' : RT.bridge.winrt === false ? 'bad' : '');
  const m = modeInfo(S.room.mode);
  $('#topMode').innerHTML = '';
  $('#topMode').append(h('span', { class: 'tm-k' }, 'MODE'), h('span', { class: 'tm-v' }, m.name),
    h('span', { class: 'tm-d' }, `${S.fx.on ? '音效開' : '音效關'} · ${S.room.correction ? '矯正開' : '矯正關'} · 削波預留 ${headroom(S).toFixed(1)} dB`));
  document.querySelectorAll('[data-eapo-banner]').forEach(el => renderEapoBanner(el));
}

function renderEapoBanner(el) {
  el.innerHTML = '';
  if (RT.eapo.err === 'permission') {
    el.append(h('div', { class: 'banner warn' }, '控制台沒有 Equalizer APO 設定資料夾的寫入權限。',
      h('button', { class: 'btn', onclick: fixPerm }, '授予寫入權限（一次性）')));
  } else if (RT.eapo.err === 'no-eapo') {
    el.append(h('div', { class: 'banner warn' }, '找不到 Equalizer APO 的設定資料夾，請先安裝 Equalizer APO 1.4.2。',
      h('button', { class: 'btn', onclick: () => post('/api/open', { url: 'https://sourceforge.net/projects/equalizerapo/files/' }) }, '前往下載')));
  }
}
async function fixPerm() {
  toast('請在 Windows 的系統管理員提示中按「是」');
  try { await post('/api/eapo/fixperm'); toast('已授權，重新寫入設定'); RT.irHash = ''; scheduleApply(10); }
  catch (e) { toast('授權失敗：' + (e.body?.detail || e.message), true); }
}

// ================================================================ media / SSE
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.t) {
      case 'media': RT.media = m; RT.mediaAt = performance.now(); renderMedia(); refreshStatus(); libraryHooks.renderSessions(); break;
      case 'bt': RT.bt = m.list || []; hpHooks.renderBT(); break;
      case 'art': renderMedia(); break;
      case 'meter': RT.meter = m.p || []; break;
      case 'devices': RT.devices = m.list || []; RT.defDev = m.def || ''; renderDevices(); hpHooks.renderDevices(); break;
      case 'init': RT.bridge = m; refreshStatus(); break;
      case 'log': console.debug('[bridge]', m.msg); break;
    }
  };
  es.onerror = () => { /* auto-reconnects */ };
}

function curSession() {
  const ss = RT.media.sessions || [];
  return ss.find(s => s.id === RT.pick) || ss.find(s => s.id === RT.media.cur) || ss.find(s => s.status === 'Playing') || ss[0] || null;
}
function livePos(s) {
  if (!s) return 0;
  let p = s.pos || 0;
  if (s.status === 'Playing') p += (performance.now() - RT.mediaAt) / 1000;
  return s.dur > 0 ? Math.min(p, s.dur) : p;
}
function mediaCmd(c, extra = {}) {
  const s = curSession();
  post('/api/media', { c, id: s?.id, ...extra }).catch(() => {});
  if (s && c === 'toggle') { s.status = s.status === 'Playing' ? 'Paused' : 'Playing'; s.pos = livePos(s); RT.mediaAt = performance.now(); renderMedia(); }
}

function progressTrack(cls = '') {
  const el = h('div', { class: 'prog-track ' + cls }, h('div', { class: 'groove' }), h('div', { class: 'ticks' }), h('div', { class: 'fill' }), h('div', { class: 'cap' }));
  el.addEventListener('click', e => {
    const s = curSession(); if (!s || !s.canSeek || !(s.dur > 0)) return;
    const r = el.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * s.dur;
    s.pos = pos; RT.mediaAt = performance.now();
    mediaCmd('seek', { pos });
  });
  return el;
}
function setTrack(el, t, enabled) {
  el.querySelector('.fill').style.width = (t * 100) + '%';
  el.querySelector('.cap').style.left = (t * 100) + '%';
  el.classList.toggle('disabled', !enabled);
}

function buildPlay() {
  const p = $('#page-play');
  p.innerHTML = '';
  const bigVu = h('div', { class: 'big-vu', id: 'bigVu' }), bigCover = h('div', { class: 'big-cover' });
  const mTitle = h('div', { class: 'm-title' }), mArtist = h('div', { class: 'm-artist' });
  const mBars = ['L', 'R'].map(n => h('div', { class: 'm-bar' }, h('small', {}, n), h('span', {}, h('i'))));
  const minimal = h('div', { class: 'minimal' }, mTitle, mArtist, h('div', { class: 'm-bars' }, ...mBars));
  const pl = ui.pl = createPlayer({ S, cmd: c => mediaCmd(c) });   // turntable + cassette scenes (player.js)
  const stage = h('div', { class: 'deck-stage' }, pl.stage, bigVu, bigCover, minimal);
  const layoutK = keys({ options: [{ id: 'deck', label: '唱盤' }, { id: 'vu', label: 'VU' }, { id: 'cover', label: '封面' }, { id: 'cassette', label: '卡帶' }, { id: 'minimal', label: '極簡' }], value: S.ui.play, onInput: v => { S.ui.play = v; applyLook(); saveState(S); } });
  layoutK.el.classList.add('play-layout'); ui.layoutK = layoutK;
  const times = h('div', { class: 'prog-times' }, h('span', { id: 'tCur' }, '0:00'), h('span', { id: 'tDur' }, '0:00'));
  const track = progressTrack();
  const btn = (k, cls = '') => { const b = h('button', { class: 'tbtn ' + cls, type: 'button', 'aria-label': k, html: ICON[k] }); return b; };
  const bPrev = btn('prev'), bPlay = btn('play', 'play'), bNext = btn('next');
  bPrev.onclick = () => mediaCmd('prev'); bNext.onclick = () => mediaCmd('next'); bPlay.onclick = () => mediaCmd('toggle');
  const deck = h('div', { class: 'panel plinth deck', 'data-pk': 'deck' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, '唱盤'), h('span', { class: 'en' }, 'Now playing'), h('span', { class: 'rule' }), layoutK.el),
    stage, h('div', { class: 'progress' }, times, track), h('div', { class: 'transport' }, bPrev, bPlay, bNext), pl.keysEl);

  const src = h('span', { class: 'src' }, h('i'), h('span', { id: 'srcName' }, '—'));
  const card = h('div', { class: 'panel track-card', 'data-pk': 'track' }, src,
    h('div', { class: 'track-title', id: 'trTitle' }, '沒有正在播放的媒體'),
    h('div', { class: 'track-artist', id: 'trArtist' }, '開啟 Spotify 或 YouTube Music 播放音樂'),
    h('div', { class: 'track-album', id: 'trAlbum' }, ''),
    h('div', { class: 'sessions', id: 'sessions' }),
    h('div', { class: 'launch' },
      h('button', { class: 'btn', onclick: () => post('/api/open', { url: 'spotify:' }) }, '開啟 Spotify'),
      h('button', { class: 'btn', onclick: () => post('/api/launch', { app: 'ytm' }).catch(e => toast(e.body?.detail || '無法開啟 YouTube Music', true)) }, '開啟 YouTube Music'),
      h('button', { class: 'btn ghost', onclick: () => goto('lib') }, '曲庫搜尋 →')));

  const meters = h('div', { class: 'meters vu', id: 'meters' });
  const mPanel = h('div', { class: 'panel', 'data-pk': 'meter' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'B'), h('h2', {}, '輸出電平'), h('span', { class: 'en' }, 'Output meter'), h('span', { class: 'rule' })),
    h('div', { class: 'mbridge' },
      h('div', { class: 'mb-cap' }, h('i'), h('span', {}, 'PEAK'), h('span', { class: 'mb-sc' }, ...['-60', '-40', '-20', '-10', '0'].map(v => h('b', { class: v === '0' ? 'hot' : '' }, v)), h('b', {}, 'dBFS'))),
      meters), h('p', { class: 'hint', id: 'meterHint' }, '顯示 Windows 預設輸出裝置每個聲道的峰值。'));

  const quick = h('div', { class: 'quick' });
  const qFx = toggle({ label: '音效', sub: 'EQ・混響・寬度', value: S.fx.on, onInput: v => { S.fx.on = v; syncAll(); changed(); } });
  const qCorr = toggle({ label: '房間矯正', sub: 'A/B 比較', value: S.room.correction, onInput: v => { S.room.correction = v; syncAll(); changed(); } });
  const qRev = toggle({ label: '混響', sub: '空間殘響', value: S.fx.rev.on, onInput: v => { S.fx.rev.on = v; syncAll(); changed(); } });
  const qHaf = toggle({ label: 'Hafler 氛圍', sub: '後方只放 L−R', value: S.room.hafler, onInput: v => { S.room.hafler = v; syncAll(); changed(); } });
  qHaf.el.classList.add('need4');
  quick.append(qFx.el, qCorr.el, qRev.el, qHaf.el);
  ui.quick = { qFx, qCorr, qRev, qHaf };
  const modeKeys = keys({ options: MODES.slice(0, 3).map(m => ({ id: m.id, label: m.label })), value: S.room.mode, onInput: v => setMode(v) });
  ui.playMode = modeKeys;
  [...modeKeys.el.children].slice(1).forEach(b => b.classList.add('need4'));   // 2.0 / headphones: stereo only
  const qPanel = h('div', { class: 'panel', 'data-pk': 'quick' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'C'), h('h2', {}, '快速切換'), h('span', { class: 'rule' })),
    modeKeys.el, h('div', { style: 'height:12px' }), quick);

  const inst = RT.sys?.platform === 'windows' && !RT.sys?.installed
    ? h('div', { class: 'banner' }, '第一次使用：把 Fono Console 安裝到這台電腦（建立開始選單與桌面捷徑）。',
        h('button', { class: 'btn', onclick: e => post('/api/install').then(() => { e.target.closest('.banner').remove(); toast('已安裝，之後從開始選單開啟 Fono Console'); }).catch(err => toast('安裝失敗：' + (err.body?.detail || err.message), true)) }, '安裝'))
    : null;
  p.append(...(inst ? [inst] : []), h('div', { 'data-eapo-banner': '' }),
    h('div', { class: 'play-grid' }, deck, h('div', { class: 'info' }, card, qPanel, mPanel)));
  ui.play = { mTitle, mArtist, mBars, track, bPlay, bPrev, bNext, src, bigCover };
}

function artUrl(s) { return s?.art ? (window.__fonoArt?.[s.art] || `/api/art/${encodeURIComponent(s.art)}`) : ''; }

function renderMedia() {
  const s = curSession();
  const P = ui.play; if (!P) return;
  const url = artUrl(s);
  P.bigCover.style.backgroundImage = url ? `url("${url}")` : '';
  const playing = s?.status === 'Playing';
  ui.pl.update({ s, url, playing });
  P.bPlay.innerHTML = playing ? ICON.pause : ICON.play;
  P.bPrev.disabled = !s || s.canPrev === false; P.bNext.disabled = !s || s.canNext === false;
  P.src.classList.toggle('playing', playing);
  $('#srcName').textContent = s ? appName(s.id) + (playing ? ' · 播放中' : s.status === 'Paused' ? ' · 暫停' : '') : '無媒體';
  const noTitle = s ? '（沒有曲目資訊）' : '沒有正在播放的媒體', noArtist = s ? '' : '開啟 Spotify 或 YouTube Music 播放音樂';
  setData($('#trTitle'), s?.title, noTitle); setData($('#trArtist'), s?.artist, noArtist); setData($('#trAlbum'), s?.album);
  setData(P.mTitle, s?.title, noTitle); setData(P.mArtist, s?.artist, noArtist);
  const box = $('#sessions'); box.innerHTML = '';
  for (const x of RT.media.sessions || []) {
    const c = h('button', { class: 'chip' + (x === s ? ' on' : '') + (x.status === 'Playing' ? ' playing' : ''), type: 'button' }, h('i'), appName(x.id));
    c.onclick = () => { RT.pick = x.id; renderMedia(); };
    box.append(c);
  }
  // mini strip
  const st = $('#strip');
  if (st && ui.mini) {
    ui.mini.rec.classList.toggle('playing', playing);
    ui.mini.art.style.backgroundImage = url ? `url("${url}")` : '';
    setData(ui.mini.title, s?.title, '沒有正在播放的媒體');
    setData(ui.mini.artist, s?.artist ? `${s.artist} · ${appName(s.id)}` : '', s ? appName(s.id) : '');
    ui.mini.play.innerHTML = playing ? ICON.pause : ICON.play;
  }
}

function tick() {
  const s = curSession();
  const pos = livePos(s), dur = s?.dur || 0;
  const t = dur > 0 ? pos / dur : 0;
  if (ui.play) {
    setTrack(ui.play.track, t, !!(s && s.canSeek && dur > 0));
    $('#tCur').textContent = fmtTime(pos); $('#tDur').textContent = dur > 0 ? fmtTime(dur) : '--:--';
    ui.pl.frame({ t, pos, dur });
  }
  if (ui.mini) { setTrack(ui.mini.track, t, !!(s && s.canSeek && dur > 0)); ui.mini.time.textContent = `${fmtTime(pos)} / ${dur > 0 ? fmtTime(dur) : '--:--'}`; }
  renderMeters();
  dash.tick();
  if (RT.rtaOn) drawRta();
  requestAnimationFrame(tick);
}

const METER_NAMES = { 1: ['M'], 2: ['L', 'R'], 4: ['L', 'R', 'RL', 'RR'], 6: ['L', 'R', 'C', 'LFE', 'RL', 'RR'], 8: ['L', 'R', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR'] };
function renderMeters() {
  const box = $('#meters'); if (!box || !ui.pl) return;
  const p = RT.meter || [];
  const n = Math.max(p.length, 2);
  const names = METER_NAMES[n] || Array.from({ length: n }, (_, i) => String(i + 1));
  if (RT.meterPeak.length !== n) RT.meterPeak = new Array(n).fill(-60);
  const raw = Array.from({ length: n }, (_, i) => (p[i] > 0 ? 20 * Math.log10(p[i]) : -60));
  raw.forEach((db, i) => { const cur = RT.meterPeak[i]; RT.meterPeak[i] = db > cur ? cur + (db - cur) * 0.45 : cur + (db - cur) * 0.12; });
  ui.pl.meters({ side: box, big: $('#bigVu'), names, used: new Set(Object.values(S.room.map)), smooth: RT.meterPeak, raw });
  if (S.ui.play === 'minimal' && ui.play) ui.play.mBars.forEach((b, i) => { const db = RT.meterPeak[i] ?? -60; b.querySelector('i').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)).toFixed(1) + '%'; });
}

function buildStrip() {
  const st = $('#strip'); st.innerHTML = '';
  const art = h('i'), rec = h('div', { class: 'mini-rec' }, art);
  const title = h('b'), artist = h('span');
  const track = progressTrack();
  const time = h('span', {}, '0:00 / 0:00');
  const b = k => h('button', { class: 'tbtn' + (k === 'play' ? ' play' : ''), type: 'button', html: ICON[k] });
  const bp = b('prev'), bt = b('play'), bn = b('next');
  bp.onclick = () => mediaCmd('prev'); bt.onclick = () => mediaCmd('toggle'); bn.onclick = () => mediaCmd('next');
  st.append(rec, h('div', { class: 'mini-meta' }, title, artist), h('div', { class: 'mini-prog' }, track, time), h('div', { class: 'mini-btns' }, bp, bt, bn));
  ui.mini = { rec, art, title, artist, track, time, play: bt };
}

// ================================================================ FX page
function buildFx() {
  const p = $('#page-fx'); p.innerHTML = '';
  const F = S.fx;
  const mk = (o, path) => knob({ ...o, value: path.get(), onInput: v => { path.set(v); F.preset = 'custom'; drawFxCurve(); syncPresets(); changed(); } });
  const P = (obj, k) => ({ get: () => obj[k], set: v => { obj[k] = v; } });

  const power = toggle({ label: '音效總開關', sub: '關閉＝只保留房間矯正', value: F.on, onInput: v => { F.on = v; changed(); syncAll(); } });
  const auto = toggle({ label: '自動防削波', sub: '依 EQ 提升量自動降前級', value: F.autoHeadroom, onInput: v => { F.autoHeadroom = v; changed(); } });
  const presets = h('div', { class: 'presets' });
  ui.presetBtns = Object.entries(PRESETS).map(([id, pr]) => {
    const b = h('button', { class: 'key', type: 'button' }, pr.name);
    b.onclick = () => { applyPreset(S, id); syncAll(); changed(); };
    presets.append(b); return [id, b];
  });
  const kPre = mk({ label: '前級', min: -24, max: 6, step: 0.5, def: 0, bipolar: true, fmt: v => sgn(v), unit: ' dB' }, P(F, 'preamp'));
  const kBass = mk({ label: '低音', min: -12, max: 12, step: 0.5, def: 0, bipolar: true, fmt: v => sgn(v), unit: ' dB' }, P(F, 'bass'));
  const kPres = mk({ label: '臨場', min: -8, max: 8, step: 0.5, def: 0, bipolar: true, fmt: v => sgn(v), unit: ' dB' }, P(F, 'presence'));
  const kTreb = mk({ label: '高音', min: -12, max: 12, step: 0.5, def: 0, bipolar: true, fmt: v => sgn(v), unit: ' dB' }, P(F, 'treble'));
  const kWidth = mk({ label: '寬度', min: 0, max: 2, step: 0.01, def: 1, bipolar: true, center: 1, fmt: v => Math.round(v * 100) + '%' }, P(F, 'width'));
  const kBal = mk({ label: '平衡', min: -1, max: 1, step: 0.01, def: 0, bipolar: true, fmt: v => (Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100)) }, P(F, 'balance'));
  const hr = h('div', { class: 'headroom' }, '削波預留', h('b', { id: 'hrVal' }, '0.0 dB'));

  const top = h('div', { class: 'fx-top' },
    h('div', { class: 'panel power', 'data-pk': 'power' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, '總控'), h('span', { class: 'rule' })), power.el, auto.el, hr),
    h('div', { class: 'panel', 'data-pk': 'tone' },
      h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'B'), h('h2', {}, '音色'), h('span', { class: 'en' }, 'Tone'), h('span', { class: 'rule' }), presets),
      h('div', { class: 'knob-row' }, kPre.el, kBass.el, kPres.el, kTreb.el, kWidth.el, kBal.el),
      h('p', { class: 'hint' }, '拖曳旋鈕上下調整，按住 Shift 微調，雙擊歸零。所有參數即時寫入 Equalizer APO，作用於 Spotify、YouTube Music 等所有程式。')));

  const curve = h('canvas', { class: 'curve', id: 'fxCurve' });
  const faders = h('div', { class: 'faders' });
  ui.eq = EQ_BANDS.map((f, i) => {
    const fd = fader({ label: f >= 1000 ? f / 1000 + 'k' : String(f), min: -12, max: 12, step: 0.5, value: F.eq[i], height: 170, onInput: v => { F.eq[i] = v; F.preset = 'custom'; drawFxCurve(); syncPresets(); changed(); } });
    faders.append(fd.el); return fd;
  });
  const eqPanel = h('div', { class: 'panel eq-wrap', 'data-pk': 'eq' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'C'), h('h2', {}, '十段等化器'), h('span', { class: 'en' }, 'Graphic EQ'), h('span', { class: 'rule' }),
      h('button', { class: 'btn ghost', onclick: () => { F.eq = F.eq.map(() => 0); syncAll(); changed(); } }, '全部歸零')),
    curve, faders);

  const R = F.rev;
  const mr = (o, k) => knob({ ...o, value: R[k], onInput: v => { R[k] = v; F.preset = 'custom'; syncPresets(); changed(); } });
  const rOn = toggle({ label: '混響', sub: '以卷積寫入 EQ APO', value: R.on, onInput: v => { R.on = v; changed(); syncAll(); } });
  const rEarly = toggle({ label: '早期反射', small: true, value: R.early, onInput: v => { R.early = v; changed(); } });
  const kWet = mr({ size: 64, label: '混響量', min: 0, max: 0.6, step: 0.01, def: 0.18, fmt: v => Math.round(v * 100) + '%' }, 'wet');
  const kRt = mr({ size: 64, label: '空間', min: 0.3, max: 4.5, step: 0.05, def: 1.8, fmt: v => v.toFixed(2) + ' s' }, 'rt60');
  const kPd = mr({ size: 64, label: '預延遲', min: 0, max: 80, step: 1, def: 18, fmt: v => v.toFixed(0) + ' ms' }, 'predelay');
  const kDamp = mr({ size: 64, label: '阻尼', min: 0, max: 0.95, step: 0.01, def: 0.45, fmt: v => Math.round(v * 100) + '%' }, 'damping');
  const srcKeys = keys({ options: [{ id: 'gen', label: '生成殘響' }, { id: 'custom', label: '自訂 IR' }], value: R.src, onInput: v => { R.src = v; changed(); syncAll(); } });
  const file = h('input', { type: 'file', accept: '.wav,audio/wav', style: 'display:none' });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    const buf = await f.arrayBuffer();
    try { await new OfflineAudioContext(2, 1, 48000).decodeAudioData(buf.slice(0)); } catch { toast('無法讀取這個 WAV 檔', true); return; }
    await fetch('/api/custom-ir', { method: 'POST', body: buf });
    RT.customIR = buf; R.customName = f.name; R.src = 'custom'; RT.irHash = '';
    syncAll(); changed(); toast('已載入 ' + f.name);
  };
  const irName = h('div', { class: 'hint', id: 'irName' });
  const revPanel = h('div', { class: 'panel', id: 'revPanel', 'data-pk': 'reverb' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'D'), h('h2', {}, '空間混響'), h('span', { class: 'en' }, 'Reverb'), h('span', { class: 'rule' })),
    h('div', { style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap' }, rOn.el, rEarly.el),
    h('div', { class: 'knob-row', style: 'margin-top:12px' }, kWet.el, kRt.el, kPd.el, kDamp.el),
    h('div', { style: 'margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, srcKeys.el, h('button', { class: 'btn', onclick: () => file.click() }, '載入 WAV…'), file),
    irName,
    h('p', { class: 'hint' }, '自訂 IR 可用 OpenAIR 等真實廳堂的脈衝響應；控制台會自動轉成 44.1 / 48 / 96 / 192 kHz 並加回乾聲。'));

  p.append(h('div', { 'data-eapo-banner': '' }),
    h('div', { class: 'page-head' }, h('div', { class: 'num' }, '03'), h('div', {}, h('h1', {}, '音效'), h('div', { class: 'sub' }, '像 FxSound 一樣調音色，但全部在 Equalizer APO 裡完成，不經過額外驅動。')), h('div', { class: 'bar' })),
    top, h('div', { class: 'fx-main' }, eqPanel, revPanel), loudnessPanel({ ...ctx(), redrawFx: () => drawFxCurve() }));
  ui.fx = { power, auto, kPre, kBass, kPres, kTreb, kWidth, kBal, rOn, rEarly, kWet, kRt, kPd, kDamp, srcKeys };
  new ResizeObserver(() => drawFxCurve()).observe(curve);
}

function syncPresets() {
  ui.presetBtns?.forEach(([id, b]) => b.classList.toggle('on', S.fx.preset === id));
  const hv = $('#hrVal'); if (hv) hv.textContent = headroom(S).toFixed(1) + ' dB';
}

const GRID = logGrid(20, 20000, 260);
function drawFxCurve() {
  const c = $('#fxCurve'); if (!c) return;
  const fl = fxFilters(S.fx);
  const db = Array.from(GRID, f => chainDb(fl, f));
  drawGraph(c, { dmin: -15, dmax: 15, dstep: 5, zero: true, curves: [{ f: Array.from(GRID), db, color: css('--accent'), width: 2.4, fill: css('--accent') + '22' }],
    points: EQ_BANDS.map((f, i) => ({ f, db: chainDb(fl, f), color: S.fx.eq[i] ? css('--ink') : css('--ink-3') })) });
  syncPresets();
}

// ================================================================ ROOM page
function setMode(id) {
  const prev = S.room.mode;
  S.room.mode = id;
  if (S.dev.autoSwitch && id !== prev) {
    const target = id === 'stereo' ? S.dev.spark : S.dev.cm;
    if (target && target !== RT.defDev && (id === 'stereo' || prev === 'stereo')) post('/api/media', { c: 'setdef', id: target });
  }
  if (id !== 'identify' && id !== 'measure' && audio.noiseOn()) audio.noiseStop();
  syncAll(); changed();
}

function corrCurve(corr) {
  const fl = corr?.filters || [];
  return { f: Array.from(GRID), db: Array.from(GRID, f => chainDb(fl, f)) };
}

function buildRoom() {
  const p = $('#page-room'); p.innerHTML = '';
  const R = S.room;
  const MODES2 = ['stereo', 'measure', 'identify'];   // what a 2.0 layout can use
  const mkSel = () => selector({ options: (layoutOf(S) === '4.0' ? MODES : MODES.filter(m => MODES2.includes(m.id))).map(m => ({ id: m.id, label: m.label })), value: R.mode, size: 250, span: 220, onInput: v => setMode(v) });
  const sel = mkSel();
  ui.mkSel = mkSel; ui.selLayout = layoutOf(S);
  const desc = h('div', { class: 'mode-desc', id: 'modeDesc' });
  const corrT = toggle({ label: '房間矯正', sub: '開／關做 A/B 比較', value: R.correction, onInput: v => { R.correction = v; changed(); syncAll(); } });
  const noiseBtn = h('button', { class: 'btn', id: 'noiseBtn', onclick: () => {
    if (audio.noiseOn()) audio.noiseStop(); else audio.noiseStart('L', -20);
    noiseBtn.textContent = audio.noiseOn() ? '停止粉紅噪音' : '播放粉紅噪音（左聲道）';
  } }, '播放粉紅噪音（左聲道）');
  const modePanel = h('div', { class: 'panel plinth mode-box', 'data-pk': 'mode' },
    h('div', { class: 'ph', style: 'align-self:stretch' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, '模式'), h('span', { class: 'rule' })),
    sel.el, desc, h('div', { style: 'display:flex;flex-direction:column;gap:10px;align-items:center;margin-top:8px' }, corrT.el, noiseBtn));

  const strips = h('div', { class: 'strips' });
  ui.strips = {};
  for (const k of SPK) {
    const c = R.ch[k];
    const name = h('button', { class: 'cname', type: 'button', style: 'background:none;border:0;cursor:pointer', title: '設為識別／量測目標' }, k);
    name.onclick = () => { if (R.mode === 'measure') R.measureTarget = k; else R.identify = k; syncAll(); changed(); };
    const g = fader({ label: '增益', min: -24, max: 6, step: 0.5, value: c.gain, height: 140, marks: [6, 0, -6, -12, -18, -24], onInput: v => { c.gain = v; changed(); } });
    const d = knob({ label: '延遲', min: 0, max: 40, step: 0.05, def: 0, size: 64, value: c.delay, fmt: v => v.toFixed(2), unit: ' ms', onInput: v => { c.delay = v; changed(); } });
    const inv = toggle({ label: '反相', small: true, value: c.invert, onInput: v => { c.invert = v; changed(); } });
    const mute = toggle({ label: '靜音', small: true, value: c.mute, onInput: v => { c.mute = v; changed(); syncAll(); } });
    const cv = h('canvas');
    const cname = h('div', { class: 'corr-name' });
    const file = h('input', { type: 'file', accept: '.txt', style: 'display:none' });
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      const filters = parseFilterText(await f.text());
      if (!filters.length) { toast('檔案裡沒有可用的 Filter 行', true); return; }
      c.corr = { name: f.name, filters, source: 'file' }; changed(); syncAll(); toast(`${k}：載入 ${filters.length} 個濾波器`);
    };
    const btns = h('div', { class: 'cbtns' },
      h('button', { class: 'btn', onclick: () => file.click() }, '匯入檔案'),
      h('button', { class: 'btn', onclick: () => { goto('measure'); toast('在量測頁選一筆 REW 量測，按「拉取濾波器」並指派到 ' + k); } }, '從 REW'),
      h('button', { class: 'btn ghost', onclick: () => { c.corr = null; changed(); syncAll(); } }, '清除'), file);
    const el = h('div', { class: 'cstrip' + (k === 'SL' || k === 'SR' ? ' need4' : '') }, name, h('div', { class: 'cspk' }, SPK_NAME[k], ' · ', h('span', S.spk?.[k] ? { 'data-i18n-skip': '' } : {}, spkDesc(k))),
      h('div', { class: 'crow' }, g.el, h('div', { style: 'display:flex;flex-direction:column;gap:6px;align-items:flex-start' }, d.el, inv.el, mute.el)),
      h('div', { class: 'corr' }, h('div', { class: 'corr-name' }, '矯正濾波器'), cname, cv, btns));
    strips.append(el);
    ui.strips[k] = { el, g, d, inv, mute, cv, cname };
  }
  const stripPanel = h('div', { class: 'panel', 'data-pk': 'channels' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'B'), h('h2', {}, '聲道'), h('span', { class: 'en' }, 'Channels'), h('span', { class: 'rule' })),
    strips, h('p', { class: 'hint' }, '每顆喇叭的增益、延遲、反相與矯正濾波器。點聲道名稱可設為「聲道識別」或「量測路由」的目標。'));

  // rear options
  const haf = toggle({ label: 'Hafler 氛圍', sub: 'A 模式：後方只放 L−R 殘響', value: R.hafler, onInput: v => { R.hafler = v; changed(); syncAll(); } });
  const rlp = toggle({ label: '後方柔化', sub: 'A 模式：後方低通', value: R.rearLP, onInput: v => { R.rearLP = v; changed(); } });
  const kLp = knob({ label: '柔化頻率', min: 2000, max: 14000, step: 100, def: 7000, size: 64, value: R.rearLPHz, fmt: v => (v / 1000).toFixed(1) + 'k', onInput: v => { R.rearLPHz = v; changed(); } });
  const kX = knob({ label: 'B 分頻點', min: 50, max: 200, step: 1, def: 100, size: 64, value: R.xover, fmt: v => v.toFixed(0) + ' Hz', onInput: v => { R.xover = v; changed(); } });
  const rearPanel = h('div', { class: 'panel need4', 'data-pk': 'rear' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'C'), h('h2', {}, '後方選項'), h('span', { class: 'rule' })),
    h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, haf.el, rlp.el),
    h('div', { class: 'knob-row', style: 'margin-top:10px' }, kLp.el, kX.el),
    h('p', { class: 'hint' }, 'B 模式的後方是 LR4（24 dB/oct）低通。前後加總若在分頻點附近出現凹陷，試試後方「反相」。'));

  // alignment
  const tin = {};
  const ag = h('div', { class: 'align-grid' });
  for (const k of SPK) {
    const i = h('input', { type: 'number', step: '0.01', value: R.align[k] });
    i.oninput = () => { R.align[k] = +i.value || 0; saveState(S); };
    tin[k] = i;
    ag.append(h('label', { class: 'field' }, h('span', {}, `${k} 到達 (ms)`), i));
  }
  const out = h('div', { class: 'hint', id: 'alignOut' });
  const alignPanel = h('div', { class: 'panel need4', 'data-pk': 'align' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'D'), h('h2', {}, '前後對齊'), h('span', { class: 'rule' })),
    ag,
    h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
      h('button', { class: 'btn primary', onclick: () => {
        const m = R.mode === 'quadB' ? 'quadB' : 'quadA';
        const d = alignDelays(R.align, m);
        for (const k of SPK) R.ch[k].delay = d[k];
        out.textContent = `已依 ${m === 'quadA' ? 'A（後方晚到 15 ms）' : 'B（同時到達）'} 套用：` + SPK.map(k => `${k} ${d[k].toFixed(2)} ms`).join('　');
        syncAll(); changed();
      } }, '計算並套用延遲')),
    out,
    h('p', { class: 'hint' }, '填入 REW 脈衝響應主峰的時間（量測時以 FL 為聲學計時參考）。'));

  // devices
  const devPanel = h('div', { class: 'panel', id: 'devPanel', 'data-pk': 'devices' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'E'), h('h2', {}, '裝置'), h('span', { class: 'rule' })),
    h('div', { id: 'devRows' }),
    toggle({ label: '切換模式時自動切換預設輸出', small: true, value: S.dev.autoSwitch, onInput: v => { S.dev.autoSwitch = v; saveState(S); } }).el,
    h('p', { class: 'hint' }, '指定後，設定檔會用 Device: 區塊分別套用：立體聲 DAC 永遠只放前方；多聲道音效卡依目前模式。'));

  p.append(h('div', { 'data-eapo-banner': '' }),
    h('div', { class: 'page-head' }, h('div', { class: 'num' }, '04'), h('div', {}, h('h1', {}, '房間'), h('div', { class: 'sub' }, '前後兩對喇叭的模式、矯正、延遲與音量。')), h('div', { class: 'bar' })),
    h('div', { class: 'room-top' }, modePanel, stripPanel),
    h('div', { class: 'room-bottom' }, rearPanel, alignPanel, devPanel));
  ui.room = { sel, corrT, haf, rlp, kLp, kX, tin };
  renderDevices();
}

function renderDevices() {
  const box = $('#devRows'); if (!box) return;
  box.innerHTML = '';
  const label = d => `${d.name || '喇叭'}${d.iface ? ' (' + d.iface + ')' : ''}`;
  for (const [key, title] of [['cm', '多聲道音效卡'], ['spark', '立體聲 DAC']]) {
    const s = h('select', {}, h('option', { value: '' }, '— 未指定 —'), ...RT.devices.map(d => h('option', { value: d.guid, selected: S.dev[key] === d.guid ? '' : null }, label(d) + (d.guid === RT.defDev ? '  ★預設' : ''))));
    if (S.dev[key] && !RT.devices.some(d => d.guid === S.dev[key])) s.append(h('option', { value: S.dev[key], selected: '' }, '（目前未連接）' + S.dev[key]));
    s.onchange = () => { S.dev[key] = s.value; changed(); };
    const b = h('button', { class: 'btn', onclick: () => { if (S.dev[key]) post('/api/media', { c: 'setdef', id: S.dev[key] }); } }, '設為預設');
    if (S.dev[key] && S.dev[key] === RT.defDev) b.disabled = true;
    box.append(h('div', { class: 'dev-row' }, h('b', {}, title), s, b));
  }
  if (!RT.devices.length) box.append(h('p', { class: 'hint' }, '尚未取得裝置清單（需要 Windows）。'));
}

function drawStripCurves() {
  if (!ui.strips) return;
  for (const k of SPK) {
    const u = ui.strips[k], c = S.room.ch[k];
    const cv = corrCurve(c.corr);
    drawGraph(u.cv, { dmin: -15, dmax: 6, dstep: 50, zero: false, bare: true, pad: { l: 2, r: 2, t: 2, b: 2 }, fmin: 20, fmax: 1000,
      curves: c.corr ? [{ ...cv, color: S.room.correction ? css('--accent') : css('--ink-3'), width: 1.6 }] : [],
      markers: [] });
    u.cname.textContent = c.corr ? `${c.corr.name} · ${c.corr.filters.length} 個` : '未載入';
  }
}

// ================================================================ MEASURE page
const PALETTE = ['#b08a5e', '#7f9168', '#6f8796', '#b59a5a', '#8e7896', '#a5705f', '#5f8f84', '#8f8476'];
function buildMeasure() {
  const p = $('#page-measure'); p.innerHTML = '';
  const tabs = h('div', { class: 'tabs' });
  const panes = {};
  const mkTab = (id, label) => {
    const b = h('button', { class: 'tab', type: 'button' }, label);
    b.onclick = () => { RT.mtab = id; [...tabs.children].forEach(x => x.classList.toggle('on', x === b)); Object.entries(panes).forEach(([k, el]) => el.classList.toggle('on', k === id)); if (id === 'rew') { if (!RT.rewTried) { RT.rewTried = true; rewRefresh(); } drawRew(); } if (id === 'modes') drawModes(); document.dispatchEvent(new CustomEvent('fono-tab', { detail: id })); };
    tabs.append(b);
    panes[id] = h('div', { class: 'tabpane' });
    return b;
  };
  const tAuto = mkTab('auto', '一鍵校正'); mkTab('fir', 'FIR 相位'); mkTab('art', 'ART 低頻'); mkTab('rew', 'REW 曲線'); mkTab('noise', '麥克風底噪'); mkTab('modes', '房間模態'); mkTab('refl', '早期反射'); mkTab('decay', '衰減'); mkTab('mic', '麥克風配對');
  buildMeasureWizard(panes.auto, panes.fir, ctx(), panes.art);
  const labRes = () => window.__fonoWizardResults?.() || {};
  panes.auto.append(targetPanel(ctx()));
  panes.decay.append(decayPanel(ctx(), labRes));
  panes.mic.append(micPanel({ ...ctx(), measureMic: measureMicRaw }));

  // --- REW
  const port = h('input', { type: 'number', value: S.rew.port, style: 'width:90px' });
  port.onchange = () => { S.rew.port = +port.value || 4735; saveState(S); rewRefresh(); };
  const list = h('div', { class: 'mlist', id: 'rewList' });
  const assignSel = h('select', {}, ...SPK.map(k => h('option', { value: k }, `指派到 ${k}（${SPK_NAME[k]}）`)));
  const left = h('div', { class: 'panel' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, 'REW 連線'), h('span', { class: 'rule' })),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
      h('label', { class: 'field' }, h('span', {}, 'API 埠'), port),
      h('button', { class: 'btn', onclick: rewRefresh }, '重新整理'),
      h('button', { class: 'btn', onclick: () => post('/api/rew-launch', { path: S.rew.exe }).then(() => { toast('已啟動 REW（API 模式），約 10 秒後按重新整理'); }).catch(e => toast(e.body?.detail || '無法啟動 REW', true)) }, '啟動 REW')),
    h('p', { class: 'hint', id: 'rewStatus' }, '未連線。'),
    h('div', { style: 'height:8px' }), list,
    h('div', { style: 'display:grid;gap:8px;margin-top:12px' },
      assignSel,
      h('button', { class: 'btn primary', onclick: () => rewPullFilters(assignSel.value) }, '拉取選取量測的濾波器'),
      h('button', { class: 'btn', onclick: rewMeasure }, '觸發掃頻（需 REW Pro）'),
      h('label', { class: 'btn' }, '匯入 REW 匯出的曲線 .txt', h('input', { type: 'file', accept: '.txt', multiple: '', style: 'display:none', onchange: async e => {
        for (const f of e.target.files) {
          const cv = parseRewTextCurve(await f.text());
          if (!cv) { toast(f.name + '：讀不到頻率響應', true); continue; }
          const id = 'file:' + f.name; RT.rew.curves[id] = cv; RT.rew.list.push({ id, title: f.name, local: true }); RT.rew.sel.add(id);
        }
        renderRewList(); drawRew();
      } }))));

  const smoothK = keys({ options: [0, 48, 12, 6, 3].map(v => ({ id: v, label: v ? `1/${v}` : '無' })), value: S.rew.smoothing, onInput: v => { S.rew.smoothing = v; saveState(S); drawRew(); } });
  const modesT = toggle({ label: '房間模態與施羅德頻率', small: true, value: S.rew.showModes, onInput: v => { S.rew.showModes = v; saveState(S); drawRew(); } });
  const rangeK = keys({ options: [{ id: 'lf', label: '20–500 Hz' }, { id: 'full', label: '全頻' }], value: RT.rewRange || 'lf', onInput: v => { RT.rewRange = v; drawRew(); } });
  const graph = h('canvas', { class: 'graph', id: 'rewGraph' });
  const right = h('div', { class: 'panel' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'B'), h('h2', {}, '頻率響應'), h('span', { class: 'en' }, 'SPL'), h('span', { class: 'rule' })),
    h('div', { class: 'graph-tools' }, h('span', { class: 'muted' }, '平滑'), smoothK.el, rangeK.el, modesT.el),
    graph, h('p', { class: 'hint', id: 'rewLegend' }, '虛線為套用該聲道矯正濾波器後的預測曲線。'));
  panes.rew.append(h('div', { class: 'meas-grid' }, left, right));
  new ResizeObserver(() => drawRew()).observe(graph);

  // --- noise
  const inSel = h('select', { id: 'micSel', style: 'min-width:260px' }, h('option', { value: '' }, '預設輸入裝置'));
  const startB = h('button', { class: 'btn primary' }, '開始量測');
  const refB = h('button', { class: 'btn' }, '記錄為參考（播放粉紅噪音時）');
  const pinkB = h('button', { class: 'btn' }, '播放粉紅噪音（左聲道）');
  startB.onclick = async () => {
    if (RT.rtaOn) { audio.micStop(); RT.rtaOn = false; startB.textContent = '開始量測'; return; }
    try {
      await audio.micStart(inSel.value || S.mic.deviceId);
      RT.rtaOn = true; startB.textContent = '停止';
      const ins = await audio.listInputs();
      const cur = inSel.value;
      inSel.innerHTML = ''; inSel.append(h('option', { value: '' }, '預設輸入裝置'), ...ins.map(d => h('option', { value: d.deviceId, selected: d.deviceId === (cur || S.mic.deviceId) ? '' : null }, d.label || '麥克風')));
    } catch (e) { toast('無法開啟麥克風：' + e.message, true); }
  };
  inSel.onchange = async () => { S.mic.deviceId = inSel.value; saveState(S); if (RT.rtaOn) { await audio.micStart(inSel.value); } };
  refB.onclick = () => { const f = audio.micFrame(); if (!f) { toast('請先開始量測', true); return; } RT.rtaRef = Float32Array.from(f.bins); toast('已記錄參考頻譜'); };
  pinkB.onclick = () => { if (audio.noiseOn()) audio.noiseStop(); else audio.noiseStart('L', -20); pinkB.textContent = audio.noiseOn() ? '停止粉紅噪音' : '播放粉紅噪音（左聲道）'; };
  const rta = h('canvas', { class: 'graph', id: 'rtaGraph', style: 'height:340px' });
  const reads = h('div', { class: 'rta-read', id: 'rtaRead' });
  panes.noise.append(h('div', { class: 'panel' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'C'), h('h2', {}, '底噪檢查'), h('span', { class: 'en' }, 'Noise floor / hum'), h('span', { class: 'rule' })),
    h('div', { class: 'graph-tools' }, inSel, startB, pinkB, refB),
    rta, reads,
    h('p', { class: 'hint' }, '先在喇叭靜音時看底噪，再播粉紅噪音按「記錄為參考」。60 / 120 / 180 Hz 的尖峰是電流哼聲；參考曲線比底噪高 30 dB 以上，量測就不受影響。音量讀數是相對於滿刻度的 dBFS。')));

  // --- modes
  panes.refl.append(reflPanel2(ctx(), labRes));
  const dims = {};
  const dimRow = h('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
  for (const [k, lab, st] of [['L', '長 (m)', 0.05], ['W', '寬 (m)', 0.05], ['H', '高 (m)', 0.05], ['rt60', 'RT60 (s)', 0.05]]) {
    const i = h('input', { type: 'number', step: st, value: S.dims[k], style: 'width:96px' });
    i.oninput = () => { S.dims[k] = Math.max(0.1, +i.value || S.dims[k]); saveState(S); drawModes(); document.dispatchEvent(new Event('fono-dims')); };
    dims[k] = i; dimRow.append(h('label', { class: 'field' }, h('span', {}, lab), i));
  }
  panes.modes.append(h('div', { class: 'meas-grid' },
    h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'D'), h('h2', {}, '房間尺寸'), h('span', { class: 'rule' })), dimRow, h('div', { id: 'schroeder', style: 'margin-top:14px' })),
    h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'E'), h('h2', {}, '300 Hz 以下的模態'), h('span', { class: 'rule' })),
      h('canvas', { class: 'curve', id: 'modeBar', style: 'height:90px' }),
      h('div', { style: 'max-height:300px;overflow:auto;margin-top:10px' }, h('table', { class: 'modes-table', id: 'modeTable' })))));
  panes.modes.append(roomScanPanel({ ...ctx(), dimsChanged: () => { for (const k of ['L', 'W', 'H']) dims[k].value = S.dims[k]; drawModes(); document.dispatchEvent(new Event('fono-dims')); } }));
  panes.modes.append(planPanel(ctx()));

  p.append(h('div', { class: 'page-head' }, h('div', { class: 'num' }, '05'), h('div', {}, h('h1', {}, '量測'), h('div', { class: 'sub' }, '一鍵量測與自動矯正、FIR 相位、REW 曲線、麥克風底噪與房間模態。')), h('div', { class: 'bar' })),
    tabs, ...Object.values(panes));
  tAuto.click();
}

function rewFetch(path, opt = {}) {
  return fetch('/api/rew' + path, { ...opt, headers: { 'X-Rew-Port': String(S.rew.port), ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(opt.headers || {}) } })
    .then(async r => { const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; } if (!r.ok) { const e = new Error(j?.message || j?.error || r.statusText); e.status = r.status; e.body = j; throw e; } return j; });
}

async function rewRefresh() {
  const st = $('#rewStatus');
  try {
    const data = await rewFetch('/measurements');
    const arr = Array.isArray(data) ? data.map((m, i) => ({ key: String(i + 1), ...m })) : Object.entries(data || {}).map(([k, m]) => ({ key: k, ...m }));
    const local = RT.rew.list.filter(x => x.local);
    RT.rew.list = arr.map(m => ({ id: m.uuid || m.key, title: m.title || m.name || ('量測 ' + m.key) })).concat(local);
    RT.rew.ok = true;
    if (st) st.textContent = `已連線 REW API（埠 ${S.rew.port}），共 ${arr.length} 筆量測。`;
  } catch (e) {
    RT.rew.ok = false;
    if (st) st.textContent = e.status === 502 ? '連不到 REW。請用「啟動 REW」或在 REW 偏好設定的 API 頁啟動 API。' : 'REW 回應錯誤：' + e.message;
  }
  renderRewList(); refreshStatus(); drawRew();
}

function renderRewList() {
  const box = $('#rewList'); if (!box) return;
  box.innerHTML = '';
  RT.rew.list.forEach((m, i) => {
    const on = RT.rew.sel.has(m.id);
    const sw = h('span', { class: 'sw', style: `background:${on ? PALETTE[i % PALETTE.length] : 'transparent'};border:1px solid ${PALETTE[i % PALETTE.length]}` });
    const it = h('div', { class: 'mitem' + (on ? ' on' : '') }, sw, h('span', { class: 't', title: m.title, 'data-i18n-skip': '' }, m.title), h('span', { class: 'muted' }, RT.rew.assign[m.id] || ''));
    it.onclick = async () => { if (on) RT.rew.sel.delete(m.id); else { RT.rew.sel.add(m.id); await rewLoadCurve(m.id); } renderRewList(); drawRew(); };
    box.append(it);
  });
  if (!RT.rew.list.length) box.append(h('p', { class: 'hint' }, '沒有量測。連上 REW 或匯入匯出的 .txt。'));
}

async function rewLoadCurve(id) {
  if (RT.rew.curves[id] || String(id).startsWith('file:')) return;
  try {
    const fr = await rewFetch(`/measurements/${encodeURIComponent(id)}/frequency-response?ppo=48`);
    const cv = rewResponseToCurve(fr);
    if (cv) RT.rew.curves[id] = cv; else toast('讀不懂這筆量測的資料格式', true);
  } catch (e) { toast('讀取量測失敗：' + e.message, true); }
}

async function rewPullFilters(ch) {
  const ids = [...RT.rew.sel].filter(id => !String(id).startsWith('file:'));
  if (ids.length !== 1) { toast('請在清單中只選一筆 REW 量測', true); return; }
  const id = ids[0];
  try {
    const data = await rewFetch(`/measurements/${encodeURIComponent(id)}/filters`);
    const filters = normaliseRewFilters(data);
    if (!filters.length) { toast('這筆量測還沒有濾波器（先在 REW 的 EQ 視窗按 Match response to target）', true); return; }
    const title = RT.rew.list.find(m => m.id === id)?.title || 'REW';
    S.room.ch[ch].corr = { name: title, filters, source: 'rew' };
    RT.rew.assign[id] = ch;
    changed(); syncAll(); renderRewList(); drawRew();
    toast(`已把 ${filters.length} 個濾波器指派到 ${ch}`);
  } catch (e) { toast('拉取失敗：' + e.message, true); }
}

async function rewMeasure() {
  try {
    const cmds = await rewFetch('/measure/commands');
    const list = Array.isArray(cmds) ? cmds : Object.values(cmds || {});
    const spl = list.find(c => /^spl$/i.test(String(c))) || list.find(c => /spl/i.test(String(c))) || list[0];
    if (!spl) throw new Error('REW 沒有回報可用的量測指令');
    await rewFetch('/measure/command', { method: 'POST', body: JSON.stringify({ command: String(spl) }) });
    toast('已觸發 REW 掃頻：' + spl);
    setTimeout(rewRefresh, 15000);
  } catch (e) {
    toast(e.status === 403 || /pro/i.test(e.message) ? '自動掃頻需要 REW Pro 授權；請在 REW 按 Measure。' : '無法觸發：' + e.message, true);
  }
}

function drawRew() {
  const c = $('#rewGraph'); if (!c || !c.clientWidth) return;
  const full = (RT.rewRange || 'lf') === 'full';
  const fmin = 20, fmax = full ? 20000 : 500;
  const curves = []; const all = [];
  RT.rew.list.forEach((m, i) => {
    if (!RT.rew.sel.has(m.id) || !RT.rew.curves[m.id]) return;
    const cv = smooth(RT.rew.curves[m.id], S.rew.smoothing);
    const color = PALETTE[i % PALETTE.length];
    curves.push({ ...cv, color, width: 2 });
    cv.f.forEach((f, k) => { if (f >= 100 && f <= 2000) all.push(cv.db[k]); });
    const ch = RT.rew.assign[m.id];
    const corr = ch && S.room.ch[ch].corr;
    if (corr) curves.push({ f: cv.f, db: cv.f.map((f, k) => cv.db[k] + chainDb(corr.filters, f)), color, width: 1.6, dash: [5, 4] });
  });
  all.sort((a, b) => a - b);
  const mid = all.length ? all[Math.floor(all.length / 2)] : 75;
  const markers = [], bands = [];
  if (S.rew.showModes) {
    const D = S.dims, fs = schroeder(D.rt60, D.L * D.W * D.H);
    roomModes(D.L, D.W, D.H, Math.min(fmax, 300)).filter(m => m.kind === 'axial' && m.f < fs * 1.25).forEach((m, i) => markers.push({ f: m.f, color: css('--ink-3'), label: i < 9 ? m.f.toFixed(0) : '', row: i % 3 }));
    markers.push({ f: fs, color: css('--accent'), dash: [6, 3], label: '施羅德 ' + fs.toFixed(0) + ' Hz', row: 3 });
    bands.push({ f0: fs, f1: fmax, color: css('--grid') });
  }
  drawGraph(c, { fmin, fmax, dmin: Math.round(mid / 5) * 5 - 30, dmax: Math.round(mid / 5) * 5 + 20, dstep: 5, curves, markers, bands });
}

function drawRta() {
  const c = $('#rtaGraph'); const f = audio.micFrame();
  if (!c || !f || !c.clientWidth) return;
  RT.rtaFrameN = (RT.rtaFrameN || 0) + 1;
  if (RT.rtaFrameN % 2) return;
  const n = f.bins.length, sr = f.sr;
  // Peak-hold per log bucket so high frequencies read as an envelope, not hash.
  const bucket = src => {
    const fs = [], db = [], B = 900, lo = Math.log(10), hi = Math.log(Math.min(24000, sr / 2));
    let i = 1;
    for (let b = 0; b < B; b++) {
      const fEnd = Math.exp(lo + ((b + 1) / B) * (hi - lo));
      const iEnd = Math.min(n - 1, Math.floor((fEnd * f.n) / sr));
      if (iEnd < i) continue;
      let m = -200; for (; i <= iEnd; i++) m = Math.max(m, src[i]);
      fs.push(fEnd); db.push(m);
    }
    return { f: fs, db };
  };
  const curves = [{ ...bucket(f.bins), color: css('--accent'), width: 1.4 }];
  if (RT.rtaRef) curves.unshift({ ...bucket(RT.rtaRef), color: css('--good'), width: 1.4 });
  const rep = audio.humReport(f, 60);
  drawGraph(c, { fmin: 10, fmax: Math.min(24000, sr / 2), dmin: -140, dmax: -20, dstep: 10, curves,
    markers: rep.harm.map((x, i) => ({ f: x.f, color: css('--bad'), label: i < 3 ? x.f + ' Hz' : '', row: i })) });
  if (RT.rtaFrameN % 10 === 0) {
    const box = $('#rtaRead'); box.innerHTML = '';
    let snr = null;
    if (RT.rtaRef) {
      let a = 0, b = 0, k = 0;
      for (let i = Math.round(40 * f.n / sr); i < Math.round(300 * f.n / sr); i++) { a += RT.rtaRef[i]; b += f.bins[i]; k++; }
      snr = (a - b) / k;
    }
    const verdict = rep.above > 20 ? ['明顯哼聲', 'bad'] : rep.above > 8 ? ['輕微哼聲', 'warn'] : ['乾淨', 'good'];
    box.append(
      h('div', { class: 'readout' }, h('small', {}, '最強哼聲'), h('b', {}, `${rep.worst.f} Hz`), h('div', { class: 'note' }, `比底噪高 ${rep.above.toFixed(1)} dB · `, h('span', { style: `color:var(--${verdict[1]})` }, verdict[0]))),
      h('div', { class: 'readout' }, h('small', {}, '底噪中位數 30–400 Hz'), h('b', {}, `${rep.floor.toFixed(1)}`), h('div', { class: 'note' }, 'dBFS / bin')),
      h('div', { class: 'readout' }, h('small', {}, '寬頻能量'), h('b', {}, `${rep.broadband.toFixed(1)}`), h('div', { class: 'note' }, 'dBFS 20 Hz–20 kHz')),
      h('div', { class: 'readout' }, h('small', {}, '訊噪比 40–300 Hz'), h('b', {}, snr == null ? '—' : `${snr.toFixed(1)} dB`), h('div', { class: 'note' }, snr == null ? '先記錄參考' : snr >= 30 ? '足夠量測' : '偏低：提高音量或排除哼聲')));
  }
}

function drawModes() {
  const D = S.dims, V = D.L * D.W * D.H, fs = schroeder(D.rt60, V);
  const ms = roomModes(D.L, D.W, D.H, 300);
  const sc = $('#schroeder');
  if (sc) {
    sc.innerHTML = '';
    sc.append(h('div', { class: 'rta-read', style: 'grid-template-columns:1fr 1fr' },
      h('div', { class: 'readout' }, h('small', {}, '體積'), h('b', {}, V.toFixed(1) + ' m³')),
      h('div', { class: 'readout' }, h('small', {}, '施羅德頻率'), h('b', {}, fs.toFixed(0) + ' Hz'), h('div', { class: 'note' }, '建議矯正上限'))),
      h('p', { class: 'hint' }, '縱向（axial）模態最強，通常就是量測上最明顯的峰；切向較弱，斜向最弱。'));
  }
  const t = $('#modeTable');
  if (t) {
    t.innerHTML = '';
    t.append(h('tr', {}, h('th', {}, '頻率'), h('th', {}, '類型'), h('th', {}, '(長,寬,高)')));
    const kind = { axial: '縱向', tangential: '切向', oblique: '斜向' };
    ms.filter(m => m.kind !== 'oblique' || m.f < 150).forEach(m => t.append(h('tr', {}, h('td', { class: m.kind === 'axial' ? 'ax' : '' }, m.f.toFixed(1) + ' Hz'), h('td', {}, kind[m.kind]), h('td', { class: 'mono' }, m.n.join(',')))));
  }
  const c = $('#modeBar'); if (!c) return;
  const s = setupCanvas(c); if (!s) return;
  const { g, w, h: H } = s;
  const X = f => 30 + (Math.log(f / 20) / Math.log(300 / 20)) * (w - 50);
  g.fillStyle = css('--grid'); g.fillRect(X(fs), 0, w - X(fs), H);
  g.font = '11px ' + css('--font-disp'); g.fillStyle = css('--ink-3'); g.textAlign = 'center';
  for (const f of [20, 30, 50, 80, 100, 150, 200, 300]) g.fillText(f, X(f), H - 4);
  for (const m of ms) {
    const hh = m.kind === 'axial' ? H - 30 : m.kind === 'tangential' ? (H - 30) * 0.6 : (H - 30) * 0.35;
    g.fillStyle = m.kind === 'axial' ? css('--accent') : css('--ink-3');
    g.fillRect(X(m.f) - 1.5, H - 18 - hh, 3, hh);
  }
}

// ================================================================ SETTINGS page
async function buildSettings() {
  const p = $('#page-settings'); p.innerHTML = '';
  const sys = RT.sys || {};
  const eapoBox = h('div', { class: 'kv' },
    h('span', {}, '設定資料夾'), h('b', { class: 'mono', style: 'user-select:text' }, sys.eapoDir || '—'),
    h('span', {}, '狀態'), h('b', {}, !sys.eapoFound ? '找不到（請安裝 Equalizer APO 1.4.2）' : sys.writable ? '可寫入' : '需要授權'),
    h('span', {}, 'config.txt'), h('b', {}, sys.included ? '已包含 Include: fono_console.txt' : '尚未包含（寫入時會自動加上）'));
  const preview = h('pre', { class: 'code', id: 'cfgPreview' }, RT.lastConfig || genConfig(S, {}));
  const port = h('input', { type: 'number', value: S.rew.port, style: 'width:100px' });
  port.onchange = () => { S.rew.port = +port.value || 4735; saveState(S); };
  const exe = h('input', { type: 'text', value: S.rew.exe, placeholder: 'C:\\Program Files\\REW\\roomeqwizard.exe', style: 'width:100%' });
  exe.onchange = () => { S.rew.exe = exe.value.trim(); saveState(S); };
  const mapRow = h('div', { class: 'align-grid' });
  for (const k of SPK) {
    const s = h('select', {}, ...['L', 'R', 'C', 'LFE', 'RL', 'RR', 'SL', 'SR'].map(c => h('option', { value: c, selected: S.room.map[k] === c ? '' : null }, c)));
    s.onchange = () => { S.room.map[k] = s.value; changed(); };
    mapRow.append(h('label', { class: 'field' }, h('span', {}, `${k} → EQ APO 聲道`), s));
  }
  const install = sys.installed ? h('p', { class: 'hint' }, '已安裝在這台電腦。到 Windows「設定 → 應用程式」可移除。')
    : sys.platform === 'windows' ? h('div', { class: 'banner' }, '目前從下載位置執行。安裝後會建立開始選單與桌面捷徑。', h('button', { class: 'btn', onclick: () => post('/api/install').then(() => toast('已安裝，下次從開始選單開啟')).catch(e => toast('安裝失敗：' + (e.body?.detail || e.message), true)) }, '安裝到這台電腦'))
    : h('p', { class: 'hint' }, '示範模式（非 Windows）：媒體與裝置為模擬資料。');

  p.append(h('div', { 'data-eapo-banner': '' }),
    h('div', { class: 'page-head' }, h('div', { class: 'num' }, '07'), h('div', {}, h('h1', {}, '設定'), h('div', { class: 'sub' }, `Fono Console ${sys.version || ''} · 外觀、Equalizer APO、REW`)), h('div', { class: 'bar' })),
    install,
    h('div', { class: 'set-grid' },
      h('div', { class: 'grid' },
        h('div', { class: 'panel setup-cta' }, h('div', {}, h('b', {}, '設定精靈'), h('small', {}, '安裝 Equalizer APO、選裝置、連接 Spotify／YouTube Music、選擇要用的功能。')),
          h('div', { style: 'display:flex;gap:8px' }, h('a', { class: 'btn', href: '/guide/', target: '_blank', rel: 'noopener' }, '教學網站'), h('button', { class: 'btn primary', type: 'button', onclick: () => openSetup(ctx()) }, '開啟精靈'))),
        appearancePanel(), layoutPanel(), featuresPanel(), dash.settingsPanel(),
        h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'B'), h('h2', {}, 'Equalizer APO'), h('span', { class: 'rule' })), eapoBox,
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:12px' },
            h('button', { class: 'btn primary', onclick: () => { RT.irHash = ''; applyEapo().then(() => { toast(RT.eapo.ok ? '已寫入' : '寫入失敗', !RT.eapo.ok); reloadSys(); }); } }, '立即寫入'),
            h('button', { class: 'btn', onclick: fixPerm }, '授予寫入權限'),
            h('button', { class: 'btn', onclick: () => { if (confirm('把 config.txt 換成只含 Include: fono_console.txt？原內容會備份。')) post('/api/eapo/takeover').then(() => { toast('已接管 config.txt'); reloadSys(); }).catch(e => toast('失敗：' + e.message, true)); } }, '接管 config.txt'),
            h('button', { class: 'btn', onclick: () => post('/api/open-folder') }, '開啟資料夾'),
            h('button', { class: 'btn', onclick: () => post('/api/open', { url: 'ms-settings:sound' }) }, 'Windows 音效設定')),
          h('p', { class: 'hint' }, '控制台只寫入 fono_console.txt 與 fono\\ 資料夾。如果 config.txt 還有你以前手寫的 EQ，會和控制台的設定疊加；建議「接管」。')),
        h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'C'), h('h2', {}, 'REW'), h('span', { class: 'rule' })),
          h('div', { style: 'display:grid;gap:10px' }, h('label', { class: 'field' }, h('span', {}, 'API 埠（預設 4735）'), port), h('label', { class: 'field' }, h('span', {}, 'roomeqwizard.exe 路徑（留空用預設位置）'), exe)),
          h('p', { class: 'hint' }, 'REW 5.20.14 以上支援 API。讀取量測與濾波器免費；由 API 觸發掃頻需要 REW Pro。')),
        spotifyPanel(),
        speakerNamesPanel(),
        h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'D'), h('h2', {}, '聲道對應'), h('span', { class: 'rule' })), mapRow,
          h('p', { class: 'hint' }, 'Windows 設 7.1 時，多數 USB 7.1 音效卡（如 CM6206）的後方插孔是 SL / SR。若你的實測不同，在這裡改。'))),
      h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'E'), h('h2', {}, '產生的設定檔'), h('span', { class: 'en' }, 'fono_console.txt'), h('span', { class: 'rule' })), preview)));
}

function spotifyPanel() {
  const box = h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'S'), h('h2', {}, 'Spotify 與 YouTube Music'), h('span', { class: 'rule' })));
  const id = h('input', { type: 'text', placeholder: 'Spotify Client ID（32 碼）', style: 'width:100%' });
  const st = h('p', { class: 'hint' }, '讀取中…');
  const load = async () => {
    const [sp, yt] = await Promise.all([api('/api/spotify/status').catch(() => ({})), api('/api/ytm/status').catch(() => ({}))]);
    st.textContent = `Spotify：${sp.connected ? '已連接' : sp.configured ? '已設定，尚未連接' : '未設定'}　·　YouTube Music 桌面版：${yt.running ? '執行中' : yt.installed ? '已安裝，未開啟' : '未安裝'}`;
    st.dataset.redirect = sp.redirectUri || '';
  };
  box.append(
    h('label', { class: 'field' }, h('span', {}, 'Client ID（在 developer.spotify.com 建立應用後取得，不需要 Client Secret）'), id),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' },
      h('button', { class: 'btn primary', onclick: () => post('/api/spotify/config', { clientId: id.value }).then(() => { toast('已儲存，接著按「連接 Spotify」'); load(); }).catch(() => toast('Client ID 應為 32 碼', true)) }, '儲存 Client ID'),
      h('button', { class: 'btn', onclick: () => { location.href = '/api/spotify/login'; } }, '連接 Spotify'),
      h('button', { class: 'btn ghost', onclick: () => post('/api/spotify/logout').then(load) }, '中斷連接'),
      h('button', { class: 'btn ghost', onclick: () => post('/api/open', { url: 'https://developer.spotify.com/dashboard' }) }, '開啟開發者後台')),
    st,
    h('p', { class: 'hint' }, '建立 Spotify 應用時，Redirect URI 請填 http://127.0.0.1:47811/api/spotify/callback、勾選 Web API。依 Spotify 2026 年規定，應用擁有者需為 Premium；直接播放也需要 Premium。'));
  load();
  return box;
}

function speakerNamesPanel() {
  const box = h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'N'), h('h2', {}, '喇叭名稱'), h('span', { class: 'rule' })));
  const g = h('div', { class: 'align-grid' });
  for (const k of SPK) {
    const i = h('input', { type: 'text', value: spkDesc(k) });
    i.onchange = () => { S.spk = { ...(S.spk || {}), [k]: i.value.trim() }; saveState(S); buildRoom(); syncAll(); };
    g.append(h('label', { class: 'field' }, h('span', {}, k), i));
  }
  box.append(g, h('p', { class: 'hint' }, '只影響顯示，例如「書架喇叭 · 擴大機 A」。'));
  return box;
}

async function reloadSys() {
  try { RT.sys = await api('/api/system'); } catch {}
  if (S.page === 'settings') buildSettings();
}

function setTheme(t) {
  S.theme = t; applyLook(); saveState(S);
}

// ---------------------------------------------------------------- appearance
export const SKINS = [
  { id: 'mixer', name: '混音台', desc: '低彩度硬體面板', sw: ['#191715', '#29251f', '#c2a47e'] },
  { id: 'walnut', name: '胡桃木 Hi-Fi', desc: '木紋側板、黃銅指示', sw: ['#4a3020', '#2d2219', '#c9a25a'] },
  { id: 'silver', name: '鋁面卡座', desc: '髮絲紋鋁板、琥珀燈', sw: ['#2a2c30', '#383b40', '#d0a15a'] },
  { id: 'studio', name: '石墨錄音室', desc: '安靜、扁平、鼠尾草綠', sw: ['#161918', '#222725', '#9fb59a'] },
];
export const ACCENTS = ['', '#c2a47e', '#c98f5a', '#b4654e', '#9fb59a', '#7f9fb0', '#a58fb2', '#d0b25a'];
function hexRgb(x) { const m = /^#?([0-9a-f]{6})$/i.exec(x || ''); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
function applyLook() {
  const de = document.documentElement, ui = S.ui;
  de.dataset.theme = S.theme; de.dataset.skin = ui.skin || 'mixer';
  for (const k of ['--accent', '--accent-2', '--accent-ink', '--lit-glow']) de.style.removeProperty(k);
  applyLookExtras(S);   // palette tokens, texture, wallpaper (look.js)
  const rgb = hexRgb(ui.accent);
  if (rgb) {
    const dk = rgb.map(v => Math.round(v * 0.7)), lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    de.style.setProperty('--accent', ui.accent);
    de.style.setProperty('--accent-2', '#' + dk.map(v => v.toString(16).padStart(2, '0')).join(''));
    de.style.setProperty('--accent-ink', lum > 0.5 ? '#1a1612' : '#faf7f2');
    de.style.setProperty('--lit-glow', `rgba(${rgb.join(',')},.26)`);
  }
  // window title bar follows the page's theme-color in app windows
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.append(meta); }
  const bar = ui.skin === 'walnut' ? '#3b281b' : getComputedStyle(de).getPropertyValue('--bg-2').trim();
  meta.content = bar || '#191715';
  const pp = $('#page-play'); if (pp) pp.dataset.play = ui.play || 'deck';
  window.__fonoUi?.layoutK?.set(ui.play || 'deck'); window.__fonoUi?.playK?.set(ui.play || 'deck');
  window.__fonoUi?.pl?.applyUi();
  applyFeatures();
  requestAnimationFrame(() => { drawFxCurve(); drawStripCurves(); drawRew(); drawModes(); });
}
const FEATURES = [
  { id: 'lib', name: '曲庫', sub: 'Spotify／YouTube Music 搜尋與歌單' },
  { id: 'hp', name: '耳機', sub: '耳機 AutoEq、交叉饋送、藍牙' },
  { id: 'fir', name: 'FIR 相位校正', sub: '量測頁的 FIR 分頁' },
  { id: 'reverb', name: '混響', sub: '音效頁的空間混響' },
    { id: 'rew', name: 'REW 連動', sub: '讀取 REW 量測與濾波器' },
  { id: 'noise', name: '麥克風底噪', sub: '量測環境噪音與哼聲' },
  { id: 'modes', name: '房間模態計算', sub: '依房間尺寸算駐波' },
  { id: 'art', name: 'ART 低頻主動校正（實驗）', sub: '四顆喇叭一起抵消低頻殘響', lab: true },
  { id: 'scan', name: '房間掃描匯入（實驗）', sub: '從手機 3D 掃描檔讀出房間長寬高', lab: true },
  { id: 'refl', name: '早期反射分析（實驗）', sub: '房間平面圖、鏡像反射點與吸音板位置，對照量測的反射峰', lab: true },
  { id: 'micpair', name: '麥克風配對（實驗）', sub: '兩支麥克風的差異曲線，或匯入 UMIK 校正檔', lab: true },
  { id: 'loud', name: '等響度補償（實驗）', sub: '音效頁：小聲聽時依 ISO 226 補回低頻與高頻', lab: true },
  { id: 'target', name: '目標曲線編輯器', sub: '量測頁：自訂自動 EQ 要追的曲線' },
  { id: 'decay', name: '衰減分析', sub: '量測頁：EDT／T20／T30 與瀑布圖' },
];
function setLayout(id) {
  if (!['hp', '2.0', '4.0'].includes(id)) return;
  S.room.layout = id;
  if (id !== '4.0') S.room.hafler = false;
  if (id === 'hp') S.ui.features.hp = true;
  applyFeatures();
  if (id !== '4.0' && ['quadA', 'quadB', 'art'].includes(S.room.mode)) setMode('stereo');
  else { syncAll(); changed(); }
  saveState(S);
  refreshLayout();
}
function applyFeatures() {
  const f = S.ui.features || {};
  const hide = (el, off) => el && el.classList.toggle('hidden-feature', !!off);
  // speaker layout (wizard step 「喇叭配置」): hp hides the room + measure pages (data stays), 2.0 hides everything rear-only (CSS .need4)
  const lay = layoutOf(S);
  document.documentElement.dataset.layout = lay;
  hide(document.querySelector('#rail button[data-page="room"]'), lay === 'hp');
  hide(document.querySelector('#rail button[data-page="measure"]'), lay === 'hp');
  if (lay === 'hp') f.hp = true;
  if (lay === 'hp' && (S.page === 'room' || S.page === 'measure')) goto('play');
  if (lay !== '4.0' && ['quadA', 'quadB', 'art'].includes(S.room.mode)) setTimeout(() => setMode('stereo'), 0);
  if (ui.layoutK) ui.layoutK.set(lay);
  if (ui.mkSel && ui.room && ui.selLayout !== lay) { const n = ui.mkSel(); ui.room.sel.el.replaceWith(n.el); ui.room.sel = n; ui.selLayout = lay; n.set(S.room.mode); }
  hide(document.querySelector('#rail button[data-page="lib"]'), f.lib === false);
  hide(document.querySelector('#rail button[data-page="hp"]'), f.hp === false);
  const tabs = document.querySelectorAll('#page-measure .tab');
  const ids = ['auto', 'fir', 'art', 'rew', 'noise', 'modes', 'refl', 'decay', 'mic'];
  const tabOff = id => id === 'refl' ? f.refl !== true : id === 'mic' ? f.micpair !== true : id === 'modes' ? (f.modes === false && f.scan !== true) : f[id] === false;   // room scan lives in the modes tab
  tabs.forEach((t, i) => hide(t, ids[i] !== 'auto' && tabOff(ids[i])));
  hide(document.querySelector('#revPanel'), f.reverb === false);
  hide(document.querySelector('#scanPanel'), f.scan !== true);
  hide(document.querySelector('#planPanel'), f.scan !== true && f.refl !== true);
  hide(document.querySelector('#targetPanel'), f.target === false);
  hide(document.querySelector('#loudPanel'), f.loud !== true);
  if (f.loud !== true && S.fx.loud?.on) { S.fx.loud.on = false; setTimeout(changed, 0); }   // a hidden panel must not leave an EQ on
  if ((S.page === 'lib' && f.lib === false) || (S.page === 'hp' && f.hp === false)) goto('play');
  const on = document.querySelector('#page-measure .tab.on');
  if (on && on.classList.contains('hidden-feature')) document.querySelector('#page-measure .tab')?.click();
}
function appearancePanel() {
  const box = h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'A'), h('h2', {}, '外觀'), h('span', { class: 'rule' })));
  const themeK = keys({ options: [{ id: 'dark', label: '深色' }, { id: 'light', label: '淺色' }], value: S.theme, onInput: v => setTheme(v) });
  const langK = keys({ options: [{ id: 'zh-TW', label: '繁體中文' }, { id: 'en', label: 'English' }], value: getLang(), onInput: v => { if (v !== getLang()) switchLang(v); } });
  langK.el.setAttribute('data-i18n-skip', '');
  const playK = window.__fonoUi.playK = keys({ options: [{ id: 'deck', label: '唱盤' }, { id: 'vu', label: '大型 VU 表' }, { id: 'cover', label: '大封面' }, { id: 'cassette', label: '卡帶' }, { id: 'minimal', label: '極簡' }], value: S.ui.play, onInput: v => { S.ui.play = v; applyLook(); saveState(S); } });
  const grid = h('div', { class: 'skin-grid' });
  const drawSkins = () => { grid.innerHTML = ''; for (const k of SKINS) { const b = h('button', { class: 'skin-card' + (S.ui.skin === k.id ? ' on' : ''), type: 'button' },
    h('div', { class: 'sw' }, h('i', { style: `background:${k.sw[0]}` }), h('span', { style: `background:${k.sw[1]}` }, h('b', { style: `background:${k.sw[2]}` }), h('em', { style: `background:${k.sw[2]};opacity:.5` }))),
    h('b', {}, k.name), h('small', {}, k.desc)); b.onclick = () => { S.ui.skin = k.id; applyLook(); saveState(S); drawSkins(); }; grid.append(b); } };
  drawSkins();
  const acc = h('div', { class: 'accent-row' }, h('span', { class: 'hint', style: 'margin:0' }, '強調色'));
  const pick = h('input', { type: 'color', value: S.ui.accent || '#c2a47e', title: '自訂顏色' });
  const drawAcc = () => { acc.querySelectorAll('.accent-dot').forEach(x => x.remove()); ACCENTS.forEach(c => { const d = h('button', { class: 'accent-dot' + ((S.ui.accent || '') === c ? ' on' : ''), type: 'button', title: c || '跟隨主題', style: c ? `background:${c}` : 'background:conic-gradient(var(--accent) 0 50%, var(--panel-2) 0)' }); d.onclick = () => { S.ui.accent = c; applyLook(); saveState(S); drawAcc(); }; acc.insertBefore(d, pick); }); };
  pick.oninput = () => { S.ui.accent = pick.value; applyLook(); drawAcc(); };
  pick.onchange = () => saveState(S);
  acc.append(pick); drawAcc();
  const lookEls = lookSections({ S, apply: applyLook, save: () => saveState(S) });
  const exp = h('button', { class: 'btn', type: 'button' }, '匯出主題');
  exp.onclick = () => {
    const data = { skin: S.ui.skin || 'mixer', accent: S.ui.accent || '', theme: S.theme, play: S.ui.play || 'deck', ...lookExport(S) };
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'fono-theme.json' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
  const imp = h('button', { class: 'btn', type: 'button' }, '匯入主題');
  imp.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0]; file.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw 0;
      if (!SKINS.some(k => k.id === d.skin) || !['dark', 'light'].includes(d.theme) || !['deck', 'vu', 'cover', 'cassette', 'minimal'].includes(d.play)
        || typeof d.accent !== 'string' || (d.accent && !hexRgb(d.accent))) throw 0;
      S.ui.skin = d.skin; S.ui.accent = d.accent; S.ui.play = d.play; S.theme = d.theme;
      const skipped = await lookImport(d, S);
      applyLook(); saveState(S); buildSettings(); if (!skipped) toast('已套用主題');
    } catch { toast('主題檔格式不正確', true); }
  };
  box.append(h('div', { class: 'hp-row', style: 'margin-top:0' }, h('div', { class: 'field' }, h('span', {}, '明暗'), themeK.el), h('div', { class: 'field' }, h('span', {}, '播放頁樣式'), playK.el), h('div', { class: 'field' }, h('span', {}, '語言'), langK.el)), grid, acc, ...lookEls, ...playerSections({ S, apply: applyLook, save: () => saveState(S) }),
    h('div', { class: 'accent-row' }, exp, imp, file));
  return box;
}
function layoutPanel() {
  const k = ui.layoutK = keys({ options: [{ id: 'hp', label: '只有耳機' }, { id: '2.0', label: '2.0 立體聲' }, { id: '4.0', label: '4.0 前後兩對' }], value: layoutOf(S), onInput: v => setLayout(v) });
  return h('div', { class: 'panel', 'data-pk': 'layout-sel', id: 'layoutPanel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'K'), h('h2', {}, '喇叭配置'), h('span', { class: 'rule' })),
    k.el,
    h('p', { class: 'hint' }, '只有耳機：收起「房間」「量測」頁；2.0：只用前方一對，後方聲道靜音，只量測 FL／FR，ART 停用；4.0：前後兩對，全部功能。資料都會保留，隨時可以改回來。'));
}
function featuresPanel() {
  const f = S.ui.features;
  const mk = x => {
    const t = toggle({ label: x.name, sub: x.sub, value: x.lab ? f[x.id] === true : f[x.id] !== false, onInput: v => { f[x.id] = v; saveState(S); applyFeatures(); } }).el;
    if (x.lab) { const l = t.querySelector('.tgl-text b'); if (l) l.append(h('span', { class: 'lab-tag' }, '實驗')); }
    return t;
  };
  const core = h('div', { class: 'feat-grid' }, ...FEATURES.filter(x => !x.lab).map(mk));
  const lab = h('div', { class: 'feat-grid' }, ...FEATURES.filter(x => x.lab).map(mk));
  return h('div', { class: 'panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'M'), h('h2', {}, '功能模組'), h('span', { class: 'rule' })),
    h('p', { class: 'hint', style: 'margin-top:0' }, '用不到的功能可以關掉，畫面會更簡潔；設定與資料都會保留，隨時再開。'),
    h('h3', { class: 'feat-h' }, '核心功能'), core,
    h('h3', { class: 'feat-h' }, '實驗室'), h('p', { class: 'hint', style: 'margin-top:0' }, '實驗功能：可能不完整，隨時可以關掉。'), lab);
}

// ================================================================ sync + router
function syncAll() {
  const F = S.fx, R = S.room;
  if (ui.fx) {
    const u = ui.fx;
    u.power.set(F.on); u.auto.set(F.autoHeadroom); u.kPre.set(F.preamp); u.kBass.set(F.bass); u.kPres.set(F.presence); u.kTreb.set(F.treble);
    u.kWidth.set(F.width); u.kBal.set(F.balance); u.rOn.set(F.rev.on); u.rEarly.set(F.rev.early); u.kWet.set(F.rev.wet); u.kRt.set(F.rev.rt60);
    u.kPd.set(F.rev.predelay); u.kDamp.set(F.rev.damping); u.srcKeys.set(F.rev.src);
    ui.eq.forEach((fd, i) => fd.set(F.eq[i]));
    const n = $('#irName'); if (n) { n.textContent = F.rev.src === 'custom' ? (F.rev.customName ? '自訂 IR：' : '尚未載入自訂 IR') : ''; if (F.rev.src === 'custom' && F.rev.customName) n.append(h('span', { 'data-i18n-skip': '' }, F.rev.customName)); }
    drawFxCurve();
  }
  if (ui.quick) { ui.quick.qFx.set(F.on); ui.quick.qCorr.set(R.correction); ui.quick.qRev.set(F.rev.on); ui.quick.qHaf.set(R.hafler); ui.playMode.set(R.mode); }
  if (ui.room) {
    const u = ui.room;
    u.sel.set(R.mode); u.corrT.set(R.correction); u.haf.set(R.hafler); u.rlp.set(R.rearLP); u.kLp.set(R.rearLPHz); u.kX.set(R.xover);
    $('#modeDesc').textContent = modeInfo(R.mode).desc;
    const nb = $('#noiseBtn'); if (nb) nb.style.display = ['identify', 'measure'].includes(R.mode) ? '' : 'none';
    for (const k of SPK) {
      const s = ui.strips[k], c = R.ch[k];
      s.g.set(c.gain); s.d.set(c.delay); s.inv.set(c.invert); s.mute.set(c.mute);
      s.el.classList.toggle('muted-ch', c.mute || (R.mode === 'stereo' && (k === 'SL' || k === 'SR')));
      s.el.classList.toggle('target', (R.mode === 'identify' && R.identify === k) || (R.mode === 'measure' && R.measureTarget === k));
    }
    drawStripCurves();
  }
  syncPresets();
  refreshStatus();
}

function goto(page) {
  S.page = page; saveState(S);
  document.querySelectorAll('#rail button').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('on', el.id === 'page-' + page));
  $('#strip').classList.toggle('on', page !== 'play');
  if (page === 'settings') reloadSys();
  if (page === 'measure') { if (!RT.rewTried && S.ui.features?.rew === true) { RT.rewTried = true; rewRefresh(); } drawRew(); drawModes(); }
  if (page === 'fx') drawFxCurve();
  if (page === 'room') drawStripCurves();
  if (page === 'lib') libraryHooks.refreshStatus();
  if (page === 'hp') { hpHooks.renderDevices(); hpHooks.renderEditor(); post('/api/media', { c: 'bt' }).catch(() => {}); }
  dash.onGoto(page);
  refreshStatus();
}

// ================================================================ shared context for page modules
function sourceOf(id) { const n = appName(id); return n === 'Spotify' ? 'spotify' : n === 'YouTube Music' ? 'ytm' : 'other'; }
async function pauseOthers(source, exceptId) {
  for (const s of RT.media.sessions || []) {
    if (s.status !== 'Playing') continue;
    if ((source && sourceOf(s.id) === source) || (exceptId && s.id === exceptId)) continue;
    await post('/api/media', { c: 'pause', id: s.id }).catch(() => {});
  }
}
function ctx() {
  return { get S() { return S; }, RT, switchLang, saveState: () => saveState(S), applyEapo, syncAll, changed, pauseOthers, appName, goto, applyFeatures, setLayout, look: { SKINS, apply: applyLook }, spotifyPanel, refreshMedia: () => post('/api/media', { c: 'devices' }).catch(() => {}) };
}

// ================================================================ dashboard (dash.js: free layout, rail, custom pages, widgets)
function dashEnv() {
  return { get S() { return S; }, RT, ICON, METER_NAMES, MODES, save: () => saveState(S), changed, syncAll, goto, setMode, mediaCmd, curSession, livePos, artUrl, appName, applyFeatures };
}

// ================================================================ boot
/** Persist the language and reload: every page is rebuilt from the saved state in the other language. */
async function switchLang(l) {
  setLang(S, l);
  try { await fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(S) }); } catch {}
  location.reload();
}
async function boot() {
  S = await loadState();
  await initI18n(S);
  document.documentElement.dataset.theme = S.theme; document.documentElement.dataset.skin = S.ui?.skin || 'mixer';
  try { RT.sys = await api('/api/system'); } catch { RT.sys = {}; }
  buildPlay(); buildStrip(); buildFx(); buildRoom(); buildMeasure(); await buildSettings();
  buildLibrary($('#page-lib'), ctx()); buildHeadphones($('#page-hp'), ctx());
  dash.init(dashEnv());
  const langSw = $('#langSwitch');
  for (const k of langSw.querySelectorAll('.ls-k')) k.classList.toggle('on', k.dataset.l === getLang());
  langSw.onclick = () => switchLang(getLang() === 'en' ? 'zh-TW' : 'en');
  $('#themeSwitch').onclick = () => setTheme(S.theme === 'dark' ? 'light' : 'dark');
  $('#helpBtn').onclick = e => {
    e.stopPropagation();
    const old = document.querySelector('.help-menu'); if (old) { old.remove(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    const item = (t, fn) => h('button', { type: 'button', onclick: () => { close(); fn(); } }, t);
    const menu = h('div', { class: 'help-menu', style: `top:${r.bottom + 6}px;right:${Math.max(8, innerWidth - r.right)}px` },
      item('功能導覽', () => startTour(ctx())),
      item('教學網站', () => window.open('/guide/', '_blank', 'noopener')),
      item('設定精靈', () => openSetup(ctx())));
    document.body.append(menu);
    setTimeout(() => document.addEventListener('click', close), 0);
  };
  applyLook();
  syncAll();
  goto(location.hash === '#library' ? 'lib' : dash.hasPage(S.page) ? S.page : 'play');
  if (location.hash) history.replaceState(null, '', '/');
  connectEvents();
  renderMedia();
  if (!S.ui.setupDone && (RT.sys?.platform === 'windows' || (window.__fonoDemo && /[?&]firstrun\b/.test(location.search)))) setTimeout(() => openSetup(ctx()), 1200);
  scheduleApply(300);
  requestAnimationFrame(tick);
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,select,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); mediaCmd('toggle'); }
  });
}
boot();
