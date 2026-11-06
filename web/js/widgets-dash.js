// Widget catalog for custom pages (Task 4). dash.js owns the layout; this file only registers widget types.
// render(el, cfg, c) -> { update?(), destroy?(), hide?() }.  cfg is persisted; call c.save() after changing it.
import { h, knob, toggle, keys } from './widgets.js';
import { toast, css, drawGraph, setupCanvas, post, sgn } from './ui.js';
import { createPlayer, createMeterBank } from './player.js';
import { audioCtx } from './audio.js';
import { fxFilters } from './eapo.js';
import { chainDb, logGrid, roomModes, schroeder } from './dsp.js';
import { soundSpeed, splCalc, matchCalc, msFromM, mFromMs, waveLen, freqFromLen, dbFromV, dbFromP, vFromDb, pFromDb } from './dashcalc.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const defaults = (cfg, d) => { for (const k in d) if (typeof cfg[k] !== typeof d[k]) cfg[k] = d[k]; return cfg; };
const fmt = (v, d = 1) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(d)) : '—');
const GRID = logGrid(20, 20000, 160);

/** Number input bound to cfg[key]; out-of-range or empty input is ignored until blur restores the last good value. */
function field(label, cfg, key, o, onChange) {
  const i = h('input', { type: 'number', value: cfg[key], step: o.step ?? 'any', inputmode: 'decimal', 'aria-label': label });
  const lo = o.min ?? -1e9, hi = o.max ?? 1e9;
  i.addEventListener('input', () => { const v = parseFloat(i.value); if (Number.isFinite(v) && v >= lo && v <= hi) { cfg[key] = v; onChange(true); } });
  i.addEventListener('change', () => { i.value = cfg[key]; });
  const el = h('label', { class: 'dw-f' }, h('span', {}, label), h('div', {}, i, o.unit ? h('em', {}, o.unit) : null));
  return { el, input: i, set: v => { i.value = v; } };
}
const row = (k, v, cls = '') => h('div', { class: 'dw-r ' + cls }, h('span', {}, k), h('b', {}, v));
const note = t => h('p', { class: 'dw-note' }, t);

export function registerDashWidgets(register) {
  const R = register;

  // ================================================================ media and controls
  R({
    type: 'nowplaying', group: 'media', name: '正在播放', sub: '封面、曲名、上下首與播放鍵', minW: 3, minH: 2, defW: 4, defH: 2,
    render(el, cfg, c) {
      const { env } = c, ICON = env.ICON;
      const cover = h('div', { class: 'dw-cover' });
      const title = h('div', { class: 'dw-np-t' }), artist = h('div', { class: 'dw-np-a' }), bar = h('i');
      const b = (k, cls = '') => h('button', { class: 'tbtn ' + cls, type: 'button', 'aria-label': k, html: ICON[k] });
      const bp = b('prev'), bt = b('play', 'play'), bn = b('next');
      bp.onclick = () => env.mediaCmd('prev'); bt.onclick = () => env.mediaCmd('toggle'); bn.onclick = () => env.mediaCmd('next');
      el.append(h('div', { class: 'dw-np' }, cover, h('div', { class: 'dw-np-m' }, title, artist, h('div', { class: 'dw-prog' }, bar), h('div', { class: 'dw-np-b' }, bp, bt, bn))));
      let sig = '';
      return {
        update() {
          const s = env.curSession(), playing = s?.status === 'Playing', url = env.artUrl(s);
          const k = [s?.id, s?.title, s?.artist, playing, url, s?.canPrev, s?.canNext].join('|');
          if (k !== sig) {
            sig = k;
            cover.style.backgroundImage = url ? `url("${url}")` : '';
            title.textContent = s?.title || (s ? '（沒有曲目資訊）' : '沒有正在播放的媒體');
            artist.textContent = s ? [s.artist, env.appName(s.id)].filter(Boolean).join(' · ') : '開啟 Spotify 或 YouTube Music';
            bt.innerHTML = playing ? ICON.pause : ICON.play;
            bp.disabled = !s || s.canPrev === false; bn.disabled = !s || s.canNext === false;
          }
          const dur = s?.dur || 0;
          bar.style.width = (dur > 0 ? clamp(env.livePos(s) / dur, 0, 1) * 100 : 0).toFixed(1) + '%';
        },
      };
    },
  });

  R({
    type: 'turntable', group: 'media', name: '迷你唱盤', sub: '與播放頁同一個唱盤，會轉、會放下唱針', minW: 4, minH: 3, defW: 5, defH: 4,
    render(el, cfg, c) {
      const { env, S } = c;
      const view = new Proxy(S.ui, { get: (t, k) => (k === 'play' ? 'deck' : t[k]) });   // always the turntable scene, whatever the play page shows
      const pl = createPlayer({ S: { get ui() { return view; } }, cmd: x => env.mediaCmd(x) });
      const host = h('div', { class: 'dw-tt' }, pl.stage);
      el.append(host);
      let sig = '', look = '', k = 0, sz = '';
      const ro = new ResizeObserver(() => { sz = ''; }); ro.observe(host);
      return {
        update() {
          const s = env.curSession(), playing = s?.status === 'Playing', url = env.artUrl(s);
          const k2 = [s?.id, s?.title, s?.album, playing, url].join('|');
          const lk = [S.ui.vinyl?.color, S.ui.vinyl?.deck, S.ui.lid, S.ui.cassette?.shell].join('|');
          if (lk !== look) { look = lk; pl.applyUi(); }
          if (k2 !== sig) { sig = k2; pl.update({ s, url, playing }); }
          const dur = s?.dur || 0, pos = env.livePos(s);
          pl.frame({ t: dur > 0 ? pos / dur : 0, pos, dur });
          const w = host.clientWidth, hh = host.clientHeight, key = w + 'x' + hh;
          if (key !== sz && w && hh) { sz = key; k = Math.min((w - 12) / 660, (hh - 8) / 410); pl.scene.style.setProperty('--k', k.toFixed(4)); pl.scene.style.top = Math.max(0, (hh - 410 * k) / 2).toFixed(1) + 'px'; }
        },
        destroy() { ro.disconnect(); },
      };
    },
  });

  const meterInfo = env => {
    const p = env.RT.meter || [], n = Math.max(p.length, 2);
    const names = env.METER_NAMES[n] || Array.from({ length: n }, (_, i) => String(i + 1));
    const raw = Array.from({ length: n }, (_, i) => (p[i] > 0 ? 20 * Math.log10(p[i]) : -60));
    return { names, raw, smooth: env.RT.meterPeak || [] };
  };

  R({
    type: 'vu', group: 'media', name: 'VU 表（一對）', sub: '依「設定 → 外觀」選的表頭樣式', minW: 3, minH: 2, defW: 4, defH: 3,
    render(el, cfg, c) {
      const { env, S } = c;
      const host = h('div', { class: 'meters vu dw-vu' }); el.append(host);
      const bank = createMeterBank(host);
      return { update() { const m = meterInfo(env); bank.draw({ style: S.ui.meter || 'needle', names: m.names.slice(0, 2), used: new Set(), smooth: m.smooth, raw: m.raw, big: true }); } };
    },
  });

  R({
    type: 'leds', group: 'media', name: 'LED 光柱（全聲道）', sub: '每個輸出聲道一根，含峰值保持', minW: 4, minH: 3, defW: 6, defH: 4,
    render(el, cfg, c) {
      const { env, S } = c;
      const host = h('div', { class: 'meters vu dw-leds' }); el.append(host);
      const bank = createMeterBank(host);
      return { update() { const m = meterInfo(env); bank.draw({ style: 'led', names: m.names, used: new Set(Object.values(S.room.map)), smooth: m.smooth, raw: m.raw }); } };
    },
  });

  R({
    type: 'modes', group: 'media', name: '聆聽模式', sub: '立體聲／四聲道 A／四聲道 B', minW: 3, minH: 2, defW: 4, defH: 2,
    render(el, cfg, c) {
      const { env, S } = c;
      const ms = env.MODES.slice(0, 3);
      const desc = h('p', { class: 'dw-note' });
      const btns = ms.map(m => { const b = h('button', { class: 'key dw-key' + (m.id === 'stereo' ? '' : ' need4'), type: 'button' }, m.label); b.onclick = () => env.setMode(m.id); return [m.id, b]; });
      el.append(h('div', { class: 'dw-keygrid' }, ...btns.map(x => x[1])), desc);
      let last = '';
      return { update() { const v = S.room.mode; if (v === last) return; last = v; btns.forEach(([id, b]) => b.classList.toggle('on', id === v)); desc.textContent = env.MODES.find(m => m.id === v)?.desc || ''; } };
    },
  });

  R({
    type: 'quick', group: 'media', name: '快速開關', sub: '音效、房間矯正、混響、Hafler', minW: 3, minH: 2, defW: 3, defH: 2,
    render(el, cfg, c) {
      const { env, S } = c;
      const mk = (label, get, set) => { const t = toggle({ label, small: true, value: get(), onInput: v => { set(v); env.syncAll(); env.changed(); } }); return { t, get }; };
      const items = [
        mk('音效', () => S.fx.on, v => { S.fx.on = v; }), mk('房間矯正', () => S.room.correction, v => { S.room.correction = v; }),
        mk('混響', () => S.fx.rev.on, v => { S.fx.rev.on = v; }), mk('Hafler 氛圍', () => S.room.hafler, v => { S.room.hafler = v; }),
      ];
      items[3].t.el.classList.add('need4');
      el.append(h('div', { class: 'dw-quick' }, ...items.map(i => i.t.el)));
      let last = '';
      return { update() { const k = items.map(i => +i.get()).join(''); if (k === last) return; last = k; items.forEach(i => i.t.set(i.get())); } };
    },
  });

  R({
    type: 'volume', group: 'media', name: '前級增益旋鈕', sub: '控制 Equalizer APO 前級，不是 Windows 系統音量', minW: 2, minH: 2, defW: 2, defH: 2,
    render(el, cfg, c) {
      const { env, S } = c;
      const k = knob({ label: '前級增益（EQ APO）', min: -24, max: 6, step: 0.5, def: 0, bipolar: true, fmt: v => sgn(v), unit: ' dB', value: S.fx.preamp, onInput: v => { S.fx.preamp = v; env.syncAll(); env.changed(); } });
      el.append(h('div', { class: 'dw-vol' }, k.el, h('p', { class: 'dw-note dw-hint' }, '這是 Equalizer APO 的前級增益，不是 Windows 系統音量。')));
      return { update() { if (S.fx.preamp !== k.get()) k.set(S.fx.preamp); } };
    },
  });

  R({
    type: 'eqmini', group: 'media', name: 'EQ 曲線（唯讀）', sub: '目前音色曲線，點一下前往音效頁', minW: 3, minH: 2, defW: 4, defH: 2,
    render(el, cfg, c) {
      const { env, S } = c;
      const cv = h('canvas', { class: 'dw-eqc', title: '前往音效頁' }); el.append(cv);
      cv.onclick = () => env.goto('fx');
      let sig = '';
      const draw = () => {
        const fl = fxFilters(S.fx);
        drawGraph(cv, { dmin: -15, dmax: 15, dstep: 5, bare: true, pad: { l: 4, r: 4, t: 6, b: 6 },
          curves: [{ f: Array.from(GRID), db: Array.from(GRID, f => chainDb(fl, f)), color: S.fx.on ? css('--accent') : css('--ink-3'), width: 2.2, fill: (S.fx.on ? css('--accent') : css('--ink-3')) + '22' }] });
      };
      const ro = new ResizeObserver(() => { sig = ''; }); ro.observe(cv);
      return { update() { const k = JSON.stringify([S.fx.on, S.fx.eq, S.fx.bass, S.fx.presence, S.fx.treble, S.fx.preamp, S.fx.autoHeadroom, cv.clientWidth, cv.clientHeight, css('--accent')]); if (k !== sig) { sig = k; draw(); } }, destroy() { ro.disconnect(); } };
    },
  });

  R({
    type: 'outdev', group: 'media', name: '輸出裝置切換', sub: '點一下設為 Windows 預設輸出', minW: 3, minH: 2, defW: 3, defH: 2,
    render(el, cfg, c) {
      const { env, RT } = c;
      const box = h('div', { class: 'dw-devs' }); el.append(box);
      let sig = '';
      return {
        update() {
          const k = JSON.stringify([RT.devices.map(d => d.guid), RT.defDev]);
          if (k === sig) return; sig = k;
          box.innerHTML = '';
          for (const d of RT.devices) {
            const on = d.guid === RT.defDev;
            const b = h('button', { class: 'dw-dev' + (on ? ' on' : ''), type: 'button', title: d.iface || '' }, h('i'), h('b', {}, d.name || '喇叭'), h('small', {}, d.iface || ''));
            b.onclick = () => { if (!on) post('/api/media', { c: 'setdef', id: d.guid }).catch(() => toast('切換失敗', true)); };
            box.append(b);
          }
          if (!RT.devices.length) box.append(h('p', { class: 'dw-note' }, '尚未取得裝置清單（需要 Windows）。'));
        },
      };
    },
  });

  R({
    type: 'btbat', group: 'media', name: '藍牙電量', sub: '連線中的藍牙耳機電量', minW: 3, minH: 2, defW: 3, defH: 2, feature: 'hp', featureName: '耳機',
    render(el, cfg, c) {
      const { RT } = c;
      const box = h('div', { class: 'dw-bt' }); el.append(box);
      post('/api/media', { c: 'bt' }).catch(() => {});
      let sig = '';
      return {
        update() {
          const k = JSON.stringify(RT.bt || null);
          if (k === sig) return; sig = k;
          box.innerHTML = '';
          if (RT.bt == null) { box.append(h('p', { class: 'dw-note' }, '讀取藍牙裝置中…')); return; }
          const by = new Map();
          for (const d of RT.bt) { const cur = by.get(d.name) || { name: d.name, battery: null, connected: false }; if (d.connected) { cur.connected = true; if (d.battery != null) cur.battery = d.battery; } by.set(d.name, cur); }
          const on = [...by.values()].filter(d => d.connected);
          for (const d of on) {
            box.append(h('div', { class: 'dw-btr' }, h('b', { title: d.name }, d.name),
              d.battery != null ? h('span', { class: 'bat', title: '電量 ' + d.battery + '%' }, h('i', { style: `width:${Math.max(4, d.battery)}%` }), h('b', {}, d.battery + '%')) : h('span', { class: 'muted' }, '電量未回報')));
          }
          if (!on.length) box.append(h('p', { class: 'dw-note' }, by.size ? '目前沒有連線中的藍牙耳機。' : '沒有找到配對的藍牙裝置。'));
        },
      };
    },
  });

  // ================================================================ clock and timers
  R({
    type: 'clock', group: 'time', name: '時鐘', sub: '類比或翻頁數字', minW: 2, minH: 2, defW: 3, defH: 3,
    render(el, cfg, c) {
      defaults(cfg, { style: 'analog' });
      const NS = 'http://www.w3.org/2000/svg';
      let ticks = ''; for (let i = 0; i < 60; i++) { const a = i * 6 * Math.PI / 180, r1 = i % 5 ? 45 : 41, s = Math.sin(a), co = -Math.cos(a); ticks += `<line class="${i % 5 ? 'm' : 'M'}" x1="${(50 + r1 * s).toFixed(2)}" y1="${(50 + r1 * co).toFixed(2)}" x2="${(50 + 47 * s).toFixed(2)}" y2="${(50 + 47 * co).toFixed(2)}"/>`; }
      const face = h('div', { class: 'dw-an', html: `<svg viewBox="0 0 100 100"><circle class="rim" cx="50" cy="50" r="49"/>${ticks}<line class="hh" x1="50" y1="54" x2="50" y2="28"/><line class="mm" x1="50" y1="56" x2="50" y2="14"/><line class="ss" x1="50" y1="58" x2="50" y2="10"/><circle class="hub" cx="50" cy="50" r="2.6"/></svg>` });
      const hh = face.querySelector('.hh'), mm = face.querySelector('.mm'), ss = face.querySelector('.ss');
      const cards = [0, 1, 2, 3].map(() => h('span', { class: 'fc' }, h('b', {}, '0')));
      const flip = h('div', { class: 'dw-flip' }, h('div', { class: 'fp' }, cards[0], cards[1]), h('i', { class: 'fcolon' }), h('div', { class: 'fp' }, cards[2], cards[3]));
      const date = h('div', { class: 'dw-date' });
      const body = h('div', { class: 'dw-clock' }, face, flip, date);
      const sel = keys({ options: [{ id: 'analog', label: '類比' }, { id: 'flip', label: '翻頁' }], value: cfg.style, onInput: v => { cfg.style = v; c.save(); paint(); last = ''; } });
      sel.el.classList.add('mini'); c.tools.append(sel.el);
      el.append(body);
      const paint = () => { body.dataset.style = cfg.style; };
      paint();
      let last = '', lastS = -1;
      return {
        update() {
          const d = new Date(), s = d.getSeconds();
          if (s === lastS && cfg.style === 'flip') return;
          const ms = cfg.style === 'analog' ? d.getMilliseconds() : 0;
          if (cfg.style === 'analog') {
            const sec = s + ms / 1000, min = d.getMinutes() + sec / 60, hr = (d.getHours() % 12) + min / 60;
            ss.setAttribute('transform', `rotate(${(sec * 6).toFixed(2)} 50 50)`); mm.setAttribute('transform', `rotate(${(min * 6).toFixed(2)} 50 50)`); hh.setAttribute('transform', `rotate(${(hr * 30).toFixed(2)} 50 50)`);
          }
          if (s === lastS) return; lastS = s;
          const t = String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
          if (t !== last) { cards.forEach((cd, i) => { const b = cd.firstChild; if (b.textContent !== t[i]) { b.textContent = t[i]; b.classList.remove('fl'); void b.offsetWidth; if (last) b.classList.add('fl'); } }); last = t; }
          date.textContent = d.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
        },
      };
    },
  });

  R({
    type: 'sleep', group: 'time', name: '睡眠計時器', sub: '時間到時暫停播放（不會關機）', minW: 3, minH: 2, defW: 3, defH: 2, always: true,
    render(el, cfg, c) {
      defaults(cfg, { mins: 30, end: 0 });
      const { env } = c;
      const time = h('div', { class: 'dw-sl-t' }, '--:--');
      const sel = keys({ options: [15, 30, 45, 60, 90].map(m => ({ id: m, label: m + '分' })), value: cfg.mins, onInput: v => { cfg.mins = v; mins.value = v; c.save(); } });
      const mins = h('input', { type: 'number', min: 1, max: 600, value: cfg.mins, 'aria-label': '分鐘' });
      mins.oninput = () => { const v = parseInt(mins.value, 10); if (v >= 1 && v <= 600) { cfg.mins = v; sel.set(v); c.save(); } };
      mins.onchange = () => { mins.value = cfg.mins; };
      const go = h('button', { class: 'btn primary', type: 'button' }, '開始');
      go.onclick = () => { if (cfg.end) cfg.end = 0; else cfg.end = Date.now() + cfg.mins * 60000; c.save(); last = ''; };
      const stateTxt = h('small', { class: 'dw-sl-s' });
      el.append(h('div', { class: 'dw-sl' }, time, stateTxt, sel.el, h('div', { class: 'dw-sl-r' }, h('label', { class: 'dw-f inline' }, mins, h('em', {}, '分鐘')), go)));
      let last = '';
      const fire = () => {
        const late = Date.now() - cfg.end; cfg.end = 0; c.save();
        if (late > 120000) return;            // the app was closed while it ran out: do not surprise-pause later
        const s = env.curSession();
        if (s?.status === 'Playing') { env.mediaCmd('toggle'); toast('睡眠計時結束，已暫停播放'); } else toast('睡眠計時結束');
      };
      return {
        update() {
          if (cfg.end && cfg.end - Date.now() <= 0) fire();
          const left = cfg.end ? Math.max(0, Math.ceil((cfg.end - Date.now()) / 1000)) : 0;
          const k = cfg.end ? left : -1;
          if (String(k) === last) return; last = String(k);
          time.textContent = cfg.end ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}` : `${String(cfg.mins).padStart(2, '0')}:00`;
          time.classList.toggle('run', !!cfg.end);
          stateTxt.textContent = cfg.end ? '倒數中，時間到暫停播放' : '待機';
          go.textContent = cfg.end ? '取消' : '開始'; go.classList.toggle('primary', !cfg.end);
        },
      };
    },
  });

  // ================================================================ calculators
  R({
    type: 'spl', group: 'tool', name: 'SPL／餘裕計算', sub: '擴大機瓦數＋喇叭靈敏度＋距離，算聆聽位置最大音量', minW: 4, minH: 5, defW: 5, defH: 5,
    render(el, cfg, c) {
      defaults(cfg, { P: 50, sens: 88, d: 3, N: 2, avg: 80, crest: 18 });
      const out = h('div', { class: 'dw-out' });
      const calc = () => {
        out.innerHTML = '';
        const r = splCalc(cfg), g = r.headroom;
        const v = g >= 3 ? ['餘裕充足', 'good'] : g >= 0 ? ['勉強夠用', 'warn'] : ['峰值會削波', 'bad'];
        out.append(
          row('最大音量（持續）', `${fmt(r.max)} dB SPL`),
          row(`平均 ${fmt(cfg.avg, 0)} dB 需要`, `${fmt(r.pAvg, r.pAvg < 1 ? 3 : 1)} W 平均`),
          row(`含 ${fmt(cfg.crest, 0)} dB 動態的峰值`, `${fmt(r.pPeak, r.pPeak < 10 ? 1 : 0)} W`),
          row('瓦數餘裕', `${sgn(g)} dB　${v[0]}`, v[1]),
          note(`公式：SPL = 靈敏度 + 10·log₁₀(瓦數) − 20·log₁₀(距離) + 10·log₁₀(喇叭數)。功率加倍 +3 dB；距離加倍 −6 dB；兩顆喇叭不相干相加 +3 dB。`),
          note(`音樂的峰值比平均高出「動態」那麼多（流行約 12、爵士約 16、古典約 20 dB）。餘裕 = 最大音量 − (平均 + 動態)；小於 0 代表大音量時的瞬間峰值會削波。這是無房間反射的自由場估算，未計入喇叭的壓縮與失真。`));
      };
      const F = [['擴大機功率', 'P', { min: 0.1, max: 5000, unit: 'W' }], ['靈敏度 (1W/1m)', 'sens', { min: 60, max: 120, unit: 'dB' }], ['聆聽距離', 'd', { min: 0.3, max: 30, unit: 'm' }], ['喇叭數量', 'N', { min: 1, max: 16, step: 1, unit: '顆' }],
        ['平均聆聽音量', 'avg', { min: 40, max: 120, unit: 'dB' }], ['音樂動態', 'crest', { min: 0, max: 40, unit: 'dB' }]];
      el.append(h('div', { class: 'dw-calc' }, h('div', { class: 'dw-in' }, ...F.map(([l, k, o]) => field(l, cfg, k, o, () => { calc(); c.save(); }).el)), out));
      calc();
      return {};
    },
  });

  R({
    type: 'match', group: 'tool', name: '擴大機／喇叭搭配', sub: '不同阻抗的功率、阻尼係數與線材損耗', minW: 4, minH: 5, defW: 5, defH: 5,
    render(el, cfg, c) {
      defaults(cfg, { p8: 100, z: 4, df: 200, len: 3, mm2: 2.5 });
      const out = h('div', { class: 'dw-out' });
      const calc = () => {
        out.innerHTML = '';
        const r = matchCalc(cfg);
        const dv = r.dfEff >= 50 ? ['很充足', 'good'] : r.dfEff >= 20 ? ['足夠', 'good'] : ['偏低', 'warn'];
        out.append(
          row(`${fmt(cfg.z, 1)} Ω 的輸出功率`, r.bound ? `約 ${fmt(r.pz, 0)} W 上限` : `約 ${fmt(r.pz, 0)} W`),
          row('額定時的電流', `${fmt(r.current, 1)} A (RMS)`),
          row('擴大機輸出阻抗', `${fmt(r.zout * 1000, 0)} mΩ`),
          row('喇叭線電阻（來回）', `${fmt(r.rc * 1000, 0)} mΩ`),
          row('實際阻尼係數', `${fmt(r.dfEff, 0)}　${dv[0]}`, dv[1]),
          row('線材造成的音量損失', `${fmt(r.lossDb, 2)} dB`),
          note(r.bound
            ? `功率：8 Ω 額定 ${fmt(cfg.p8, 0)} W，接 ${fmt(cfg.z, 1)} Ω 的理想值是 ${fmt(r.ideal, 0)} W（電壓不變、電流變大）。電源夠硬的機器最多約 2 倍，實際「依擴大機規格」，很多機器只有 1.3–1.8 倍，不要超過規格表。`
            : `功率：阻抗比 8 Ω 高時，電壓固定，功率約與阻抗成反比（${fmt(cfg.p8, 0)} W × 8 ÷ ${fmt(cfg.z, 1)} Ω）。`),
          note('阻尼係數 = 喇叭阻抗 ÷（擴大機輸出阻抗 + 喇叭線電阻）；擴大機輸出阻抗 = 8 Ω ÷ 規格上的阻尼係數。喇叭線太細太長會把阻尼係數吃掉；大於約 20 對多數喇叭就夠，低頻控制力要求高時再往上。喇叭線電阻 = 0.0172 × 2 × 長度 ÷ 截面積（銅）。'));
      };
      const F = [['8 Ω 額定功率', 'p8', { min: 1, max: 5000, unit: 'W' }], ['喇叭阻抗', 'z', { min: 1, max: 32, unit: 'Ω' }], ['規格阻尼係數', 'df', { min: 1, max: 5000, unit: '' }], ['喇叭線單程長度', 'len', { min: 0.1, max: 100, unit: 'm' }], ['喇叭線截面積', 'mm2', { min: 0.1, max: 25, unit: 'mm²' }]];
      el.append(h('div', { class: 'dw-calc' }, h('div', { class: 'dw-in' }, ...F.map(([l, k, o]) => field(l, cfg, k, o, () => { calc(); c.save(); }).el)), out));
      calc();
      return {};
    },
  });

  R({
    type: 'delay', group: 'tool', name: '距離／延遲／波長', sub: '依溫度換算聲速，距離、毫秒、頻率、波長互換', minW: 4, minH: 4, defW: 5, defH: 4,
    render(el, cfg, c) {
      defaults(cfg, { T: 20, d: 3, f: 100 });
      const cEl = h('b', {});
      const out = h('div', { class: 'dw-out' });
      const fT = field('溫度', cfg, 'T', { min: -30, max: 60, unit: '°C' }, () => sync(null));
      const fD = field('距離', cfg, 'd', { min: 0, max: 1000, unit: 'm' }, () => sync('d'));
      const fF = field('頻率', cfg, 'f', { min: 1, max: 40000, unit: 'Hz' }, () => sync('f'));
      // ms and wavelength are derived from d / f; editing them writes back through these handlers
      const fmsCfg = { ms: 0 }, flCfg = { l: 0 };
      const fMs2 = field('延遲', fmsCfg, 'ms', { min: 0, max: 3000, unit: 'ms' }, () => { cfg.d = mFromMs(fmsCfg.ms, cfg.T); fD.set(+cfg.d.toFixed(3)); sync('ms'); });
      const fL2 = field('波長', flCfg, 'l', { min: 0.001, max: 400, unit: 'm' }, () => { cfg.f = freqFromLen(flCfg.l, cfg.T); fF.set(+cfg.f.toFixed(1)); sync('l'); });
      const sync = src => {
        const T = cfg.T;
        if (src !== 'ms') { fmsCfg.ms = msFromM(cfg.d, T); if (document.activeElement !== fMs2.input) fMs2.set(+fmsCfg.ms.toFixed(3)); }
        if (src !== 'l') { flCfg.l = waveLen(cfg.f, T); if (document.activeElement !== fL2.input) fL2.set(+flCfg.l.toFixed(3)); }
        if (src === 'd') { /* distance edited */ } else if (src === 'ms' && document.activeElement !== fD.input) fD.set(+cfg.d.toFixed(3));
        if (src === 'f') { /* freq edited */ } else if (src === 'l' && document.activeElement !== fF.input) fF.set(+cfg.f.toFixed(1));
        cEl.textContent = `${soundSpeed(T).toFixed(1)} m/s`;
        out.innerHTML = '';
        out.append(row('1/4 波長', `${fmt(flCfg.l / 4, 2)} m`), row('1 ms 約等於', `${fmt(soundSpeed(T) / 1000 * 100, 1)} cm`));
        c.save();
      };
      el.append(h('div', { class: 'dw-calc one' },
        h('div', { class: 'dw-in cols2' }, fT.el, h('div', { class: 'dw-f' }, h('span', {}, '聲速'), h('div', { class: 'ro' }, cEl)), fD.el, fMs2.el, fF.el, fL2.el), out,
        note('聲速 c = 331.3 + 0.606 × 溫度(°C)，20 °C 約 343 m/s。延遲(ms) = 距離 ÷ c × 1000，兩顆喇叭距離差 1 公尺大約差 2.9 ms；波長 = c ÷ 頻率。改任何一格，成對的另一格會跟著算。')));
      sync(null);
      return {};
    },
  });

  R({
    type: 'dbconv', group: 'tool', name: 'dB 與倍數換算', sub: 'dB ↔ 電壓／電流比 ↔ 功率比', minW: 3, minH: 3, defW: 4, defH: 3,
    render(el, cfg, c) {
      defaults(cfg, { db: 6 });
      const o = { db: cfg.db, v: vFromDb(cfg.db), p: pFromDb(cfg.db) };
      const iDb = field('分貝', o, 'db', { min: -200, max: 200, unit: 'dB' }, () => { o.v = vFromDb(o.db); o.p = pFromDb(o.db); show('db'); });
      const iV = field('電壓／電流比', o, 'v', { min: 1e-9, max: 1e9, unit: '×' }, () => { o.db = dbFromV(o.v); o.p = pFromDb(o.db); show('v'); });
      const iP = field('功率比', o, 'p', { min: 1e-9, max: 1e9, unit: '×' }, () => { o.db = dbFromP(o.p); o.v = vFromDb(o.db); show('p'); });
      const show = src => {
        const set = (f, v, key) => { if (src !== key) f.set(+v.toPrecision(5)); };
        set(iDb, o.db, 'db'); set(iV, o.v, 'v'); set(iP, o.p, 'p');
        cfg.db = o.db; c.save();
      };
      const chips = h('div', { class: 'dw-chips' }, ...[-20, -10, -6, -3, 3, 6, 10, 20].map(d => { const b = h('button', { class: 'key', type: 'button' }, (d > 0 ? '+' : '') + d); b.onclick = () => { o.db = d; o.v = vFromDb(d); o.p = pFromDb(d); show(''); }; return b; }));
      el.append(h('div', { class: 'dw-calc one' }, h('div', { class: 'dw-in cols3' }, iDb.el, iV.el, iP.el), chips,
        note('電壓、電流（振幅）用 dB = 20·log₁₀(比值)；功率用 dB = 10·log₁₀(比值)。所以 +6 dB 是電壓 2 倍、功率 4 倍；+3 dB 是電壓 1.41 倍、功率 2 倍；+10 dB 是功率 10 倍。')));
      show('');
      return {};
    },
  });

  R({
    type: 'roomcalc', group: 'tool', name: '房間駐波速算', sub: '用「量測」頁同一組房間尺寸，算軸向模態與施羅德頻率', minW: 4, minH: 4, defW: 5, defH: 4,
    render(el, cfg, c) {
      const { S } = c;
      const out = h('div', { class: 'dw-out' }), cv = h('canvas', { class: 'dw-modec' });
      const draw = () => {
        const D = S.dims, V = D.L * D.W * D.H, fs = schroeder(D.rt60, V), ms = roomModes(D.L, D.W, D.H, 300);
        out.innerHTML = '';
        const ax = k => [1, 2, 3].map(n => (343 / 2 * n / D[k])).filter(f => f < 300).map(f => f.toFixed(0)).join('、');
        out.append(row('體積', `${V.toFixed(1)} m³`), row('施羅德頻率', `${fs.toFixed(0)} Hz`), row('長向駐波', `${ax('L')} Hz`), row('寬向駐波', `${ax('W')} Hz`), row('高向駐波', `${ax('H')} Hz`),
          note('最低的駐波 f = 聲速 ÷ (2 × 尺寸)。低於施羅德頻率時房間以單一模態為主，聆聽位置會有明顯的峰谷，這段才適合用等化器矯正。'));
        const s = setupCanvas(cv); if (!s) return;
        const { g, w, h: H } = s, X = f => 6 + (Math.log(f / 20) / Math.log(300 / 20)) * (w - 12);
        g.fillStyle = css('--grid'); g.fillRect(X(Math.min(fs, 300)), 0, w - X(Math.min(fs, 300)), H);
        g.font = '10px ' + css('--font-disp'); g.fillStyle = css('--ink-3'); g.textAlign = 'center';
        for (const f of [20, 50, 100, 200]) g.fillText(f, X(f), H - 2);
        for (const m of ms) { const hh = m.kind === 'axial' ? H - 18 : m.kind === 'tangential' ? (H - 18) * 0.6 : (H - 18) * 0.35; g.fillStyle = m.kind === 'axial' ? css('--accent') : css('--ink-3'); g.fillRect(X(m.f) - 1, H - 13 - hh, 2, hh); }
      };
      const mk = (k, label, o) => field(label, S.dims, k, o, () => { c.save(); document.dispatchEvent(new Event('fono-dims')); draw(); });
      const ins = [mk('L', '長', { min: 0.5, max: 50, step: 0.05, unit: 'm' }), mk('W', '寬', { min: 0.5, max: 50, step: 0.05, unit: 'm' }), mk('H', '高', { min: 0.5, max: 20, step: 0.05, unit: 'm' }), mk('rt60', 'RT60', { min: 0.05, max: 5, step: 0.05, unit: 's' })];
      el.append(h('div', { class: 'dw-calc one' }, h('div', { class: 'dw-in cols4' }, ...ins.map(i => i.el)), cv, out));
      const ro = new ResizeObserver(draw); ro.observe(cv);
      draw();
      return { destroy() { ro.disconnect(); } };
    },
  });

  // ---- test tone
  let pinkBuf = null, sweepBuf = null;
  const pinkOf = ac => {
    if (pinkBuf && pinkBuf.sampleRate === ac.sampleRate) return pinkBuf;
    const n = Math.floor(ac.sampleRate * 5), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    const f = Math.floor(ac.sampleRate * 0.05); for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[n - f + i] * (1 - t); }
    return (pinkBuf = b);
  };
  const sweepOf = ac => {
    if (sweepBuf && sweepBuf.sampleRate === ac.sampleRate) return sweepBuf;
    const T = 10, n = Math.floor(ac.sampleRate * T), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0), f0 = 20, f1 = 20000, L = Math.log(f1 / f0);
    const fade = Math.floor(ac.sampleRate * 0.02);
    for (let i = 0; i < n; i++) {
      const t = i / ac.sampleRate, ph = 2 * Math.PI * f0 * T / L * (Math.exp(t / T * L) - 1);
      d[i] = Math.sin(ph) * Math.min(1, i / fade, (n - 1 - i) / fade);
    }
    return (sweepBuf = b);
  };

  R({
    type: 'tone', group: 'tool', name: '測試音產生器', sub: '正弦波、粉紅噪音、對數掃頻；從 −30 dBFS 起', minW: 4, minH: 3, defW: 4, defH: 4,
    render(el, cfg, c) {
      defaults(cfg, { kind: 'sine', freq: 1000, level: -30, ch: 'LR' });
      cfg.level = clamp(cfg.level, -60, -6);
      let run = null;
      const stop = () => {
        if (!run) return;
        const r = run; run = null; sync();
        const t = r.ac.currentTime;
        r.g.gain.cancelScheduledValues(t); r.g.gain.setValueAtTime(r.g.gain.value, t); r.g.gain.linearRampToValueAtTime(0, t + 0.06);
        try { r.src.stop(t + 0.1); } catch {}
        r.src.onended = () => { try { r.g.disconnect(); r.m.disconnect(); } catch {} };
      };
      const start = () => {
        stop();
        const ac = audioCtx(), g = ac.createGain(), m = ac.createChannelMerger(2);
        g.gain.value = 0;
        let src;
        if (cfg.kind === 'sine') { src = ac.createOscillator(); src.type = 'sine'; src.frequency.value = cfg.freq; }
        else { src = ac.createBufferSource(); src.buffer = cfg.kind === 'pink' ? pinkOf(ac) : sweepOf(ac); src.loop = true; }
        src.connect(g);
        if (cfg.ch !== 'R') g.connect(m, 0, 0);
        if (cfg.ch !== 'L') g.connect(m, 0, 1);
        m.connect(ac.destination);
        src.start();
        g.gain.setTargetAtTime(10 ** (cfg.level / 20), ac.currentTime, 0.05);       // ramp in: no click
        run = { src, g, m, ac }; sync();
      };
      const kindK = keys({ options: [{ id: 'sine', label: '正弦波' }, { id: 'pink', label: '粉紅噪音' }, { id: 'sweep', label: '掃頻' }], value: cfg.kind, onInput: v => { cfg.kind = v; c.save(); if (run) start(); sync(); } });
      const chK = keys({ options: [{ id: 'LR', label: '左右' }, { id: 'L', label: '左' }, { id: 'R', label: '右' }], value: cfg.ch, onInput: v => { cfg.ch = v; c.save(); if (run) start(); } });
      const ff = field('頻率', cfg, 'freq', { min: 20, max: 20000, unit: 'Hz' }, () => { c.save(); if (run && cfg.kind === 'sine') run.src.frequency.setTargetAtTime(cfg.freq, run.ac.currentTime, 0.02); });
      const lvl = h('input', { type: 'range', min: -60, max: -6, step: 1, value: cfg.level, 'aria-label': '電平', class: 'dw-range' });
      const lvlOut = h('output', {});
      const lvlShow = () => { lvlOut.textContent = `${cfg.level} dBFS`; lvlOut.classList.toggle('hot', cfg.level > -20); };
      lvl.oninput = () => { cfg.level = +lvl.value; lvlShow(); c.save(); if (run) run.g.gain.setTargetAtTime(10 ** (cfg.level / 20), run.ac.currentTime, 0.03); };
      lvlShow();
      const big = h('button', { class: 'dw-bigkey', type: 'button' }, h('i'), h('b', {}, '開始'));
      big.onclick = () => (run ? stop() : start());
      function sync() { big.classList.toggle('on', !!run); big.querySelector('b').textContent = run ? '停止' : '開始'; ff.el.style.display = cfg.kind === 'sine' ? '' : 'none'; }
      const onVis = () => { if (document.hidden) stop(); };
      document.addEventListener('visibilitychange', onVis);
      el.append(h('div', { class: 'dw-tone' }, kindK.el, h('div', { class: 'dw-tone-r' }, ff.el, chK.el), h('div', { class: 'dw-tone-l' }, h('span', {}, '電平'), lvl, lvlOut), big,
        h('p', { class: 'dw-warn' }, '注意：測試音可能很大聲，會傷耳朵也可能燒壞高音單體。先把喇叭音量調低，再從 −30 dBFS 慢慢加大；用完立刻按停止。聲音會經過 Equalizer APO。')));
      sync();
      return { hide: stop, destroy() { document.removeEventListener('visibilitychange', onVis); stop(); } };
    },
  });

  R({
    type: 'notes', group: 'note', name: '便條', sub: '隨手記的文字，自動儲存', minW: 2, minH: 2, defW: 3, defH: 3,
    render(el, cfg, c) {
      defaults(cfg, { text: '' });
      const t = h('textarea', { class: 'dw-notes', placeholder: '寫點什麼…（例如：喇叭擺位、量測參數）', 'aria-label': '便條', spellcheck: 'false' });
      t.value = cfg.text;
      t.oninput = () => { cfg.text = t.value.slice(0, 8000); c.save(); };
      el.append(t);
      return {};
    },
  });
}
