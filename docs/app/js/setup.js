// First-run setup wizard: the in-app version of scripts/setup.ps1.
// Step 1 asks what the user wants to do and turns on only those features.
import { h, $, toast, api, post } from './ui.js';
import { toggle } from './widgets.js';
import { startTour } from './tour.js';
import { PALETTES, wallUrl } from './look.js';
import { VINYL_COLORS, vinylLook } from './player.js';
import { layoutOf, hasRear } from './eapo.js';
import { getLang } from './i18n.js';

let C;
const W = { step: 0, goals: null, timer: 0, auto: null };
const DOCS = '/guide/';

const GOALS = [
  { id: 'room', name: '校正喇叭與房間', sub: '量測、自動 EQ、前後對齊、FIR 相位', feats: { fir: true }, doc: 'room' },
  { id: 'hp', name: '耳機調音', sub: 'AutoEq、交叉饋送、藍牙免持', feats: { hp: true }, doc: 'headphones' },
  { id: 'lib', name: 'Spotify／YouTube Music 曲庫', sub: '在控制台裡搜尋與播放歌單', feats: { lib: true }, doc: 'library' },
  { id: 'fx', name: '音效與混響', sub: '像 FxSound 一樣調音色', feats: { reverb: true }, doc: 'effects' },
  { id: 'pro', name: '進階量測工具', sub: 'REW 連動、麥克風底噪、房間模態', feats: { rew: true, noise: true, modes: true }, doc: 'advanced' },
];

const STEPS = [
  { id: 'goal', title: '你想用它做什麼？' },
  { id: 'eapo', title: 'Equalizer APO' },
  { id: 'dev', title: '選擇輸出裝置' },
  { id: 'layout', title: '喇叭配置' },
  { id: 'take', title: '交給 Fono Console 管理' },
  { id: 'music', title: '音樂來源', need: g => g.has('lib') },
  { id: 'extra', title: '其他（選用）' },
  { id: 'look', title: '外觀' },
  { id: 'done', title: '完成' },
];

function steps() { return STEPS.filter(s => !s.need || s.need(W.goals)); }

export function openSetup(ctx) {
  C = ctx;
  if (!W.goals) {
    const f = C.S.ui.features || {};
    W.goals = new Set(['room', ...(f.hp !== false ? ['hp'] : []), ...(f.lib !== false ? ['lib'] : []), ...(f.reverb !== false ? ['fx'] : []), ...(f.rew ? ['pro'] : [])]);
  }
  W.step = 0;
  let m = $('#setupModal');
  if (!m) { m = h('div', { class: 'modal', id: 'setupModal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '設定精靈' }); document.body.append(m); }
  m.classList.add('on');
  render();
}

function close(done) {
  clearInterval(W.timer);
  $('#setupModal')?.classList.remove('on');
  if (done) { C.S.ui.setupDone = true; C.saveState(); }
}

async function render() {
  const m = $('#setupModal'); if (!m) return;
  clearInterval(W.timer);
  const list = steps(), cur = list[Math.min(W.step, list.length - 1)];
  const body = h('div', { class: 'modal-body' });
  const card = h('div', { class: 'modal-card' },
    h('div', { class: 'modal-head' },
      h('div', {}, h('small', {}, `設定精靈 · ${W.step + 1} / ${list.length}`), h('h2', {}, cur.title)),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => close(false) }, '稍後再說')),
    h('div', { class: 'wiz-steps' }, ...list.map((s, i) => h('span', { class: 'wiz-step' + (i === W.step ? ' on' : '') }, String(i + 1)))),
    body,
    h('div', { class: 'modal-foot' },
      W.step > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => { W.step--; render(); } }, '上一步') : h('span'),
      cur.id === 'done'
        ? h('button', { class: 'btn primary big', type: 'button', id: 'setupStart', onclick: () => close(true) }, '直接開始')
        : h('button', { class: 'btn primary big', type: 'button', onclick: () => { W.step++; render(); } }, '下一步')));
  m.innerHTML = ''; m.append(card);
  await STEP_UI[cur.id](body);
}

const status = () => api('/api/setup/status').catch(() => ({}));
const row = (ok, title, sub, ...actions) => h('div', { class: 'setup-row' + (ok ? ' ok' : '') },
  h('i', { class: 'setup-led' }), h('div', {}, h('b', {}, title), sub ? h('small', {}, sub) : null), h('div', { class: 'setup-act' }, ...actions));

const STEP_UI = {
  goal(box) {
    const grid = h('div', { class: 'goal-grid' });
    const draw = () => {
      grid.innerHTML = '';
      for (const g of GOALS) {
        const on = W.goals.has(g.id);
        const b = h('button', { class: 'goal' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on) },
          h('span', { class: 'goal-box' }, on ? '✓' : ''), h('span', {}, h('b', {}, g.name), h('small', {}, g.sub)));
        b.onclick = () => { on ? W.goals.delete(g.id) : W.goals.add(g.id); applyGoals(); draw(); };
        grid.append(b);
      }
    };
    draw();
    const prog = h('div', { class: 'auto-progress' });
    const go = h('button', { class: 'btn primary big', type: 'button' }, '幫我全部自動設定');
    go.onclick = () => autoSetup(go, prog);
    const langRow = h('div', { class: 'lang-pick', 'data-i18n-skip': '' }, h('b', {}, 'Language · 語言'),
      ...[['zh-TW', '繁體中文'], ['en', 'English']].map(([id, label]) => h('button', { class: 'btn' + (getLang() === id ? ' primary' : ''), type: 'button', 'aria-pressed': String(getLang() === id), onclick: () => { if (getLang() !== id) C.switchLang(id); } }, label)));
    box.append(langRow, h('div', { class: 'auto-setup' }, go, h('small', { class: 'hint' }, '照下面勾選的項目，自動完成安裝、選裝置、接管設定。'), prog),
      h('p', { class: 'hint', style: 'margin-top:0' }, '選你需要的，沒選的功能會先收起來，讓畫面簡潔；之後在「設定 → 功能模組」隨時打開。'), grid,
      h('p', { class: 'hint' }, '每個項目都有對應的圖文教學：', h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, '開啟教學網站')));
  },
  async eapo(box) {
    const st = await status();
    const e = st.eapo || {};
    box.append(
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Equalizer APO 是 Windows 的系統等化器，所有音效與矯正都靠它處理。安裝時會跳出 Device Selector：勾選要處理的喇叭與耳機輸出，不要勾麥克風。'),
      row(e.installed, e.installed ? '已安裝' : '尚未安裝', e.installed ? e.config : (e.bundled ? '安裝包內附官方安裝程式（GPLv2，來源：sourceforge.net/projects/equalizerapo）' : '會開啟官方下載頁'),
        e.installed ? null : h('button', { class: 'btn primary', type: 'button', onclick: () => post('/api/setup/eapo-install').then(r => toast(r.started === 'bundled' ? '已啟動安裝程式，請按 UAC「是」' : '已開啟下載頁')).catch(err => toast(err.message, true)) }, '安裝'),
        h('button', { class: 'btn', type: 'button', onclick: () => post('/api/eapo/selector').then(() => toast('在 Device Selector 勾選裝置後按 OK')).catch(err => toast(err.body?.detail || err.message, true)) }, 'Device Selector'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => render() }, '重新檢查')),
      h('p', { class: 'hint' }, '在 Device Selector 新增裝置後要重新開機一次才會生效；可以先完成精靈再重開。'));
  },
  dev(box) {
    const devs = C.RT.devices || [];
    const lab = d => `${d.name || '喇叭'}${d.iface ? ' (' + d.iface + ')' : ''}${d.eapo ? '' : '　⚠ 未裝 EQ APO'}`;
    const sel = key => { const s = h('select', {}, h('option', { value: '' }, '— 沒有 —'), ...devs.map(d => h('option', { value: d.guid, selected: C.S.dev[key] === d.guid ? '' : null }, lab(d)))); s.onchange = () => { C.S.dev[key] = s.value; C.saveState(); C.changed(); }; return s; };
    box.append(
      h('label', { class: 'field' }, h('span', {}, '多聲道音效卡（接前後四顆喇叭，四聲道模式用）'), sel('cm')),
      h('label', { class: 'field', style: 'margin-top:12px' }, h('span', {}, '立體聲 DAC（只接前方一對喇叭或耳機，立體聲模式用）'), sel('spark')),
      h('p', { class: 'hint' }, '只有一張卡也可以：選一個就好。藍牙耳機不用在這裡選，連上後會出現在「耳機」頁。'),
      hasRear(C.S) ? null : h('p', { class: 'hint' }, '你的配置不是前後四顆：只需要選「立體聲 DAC」那一項（下一步可以改配置）。'));
  },
  layout(box) {
    const OPTS = [
      { id: 'hp', name: '只有耳機', sub: '不接喇叭。收起「房間」「量測」頁，專心用耳機頁與音效。', dots: [] },
      { id: '2.0', name: '2.0 立體聲', sub: '前方一對喇叭。後方聲道靜音，量測與 FIR 只處理 FL／FR，不提供四聲道與 ART。', dots: ['FL', 'FR'] },
      { id: '2.1', name: '2.1 立體聲＋重低音', sub: '前方一對加一顆重低音（接多聲道卡的 LFE）。主喇叭高通、重低音低通，分頻點與對齊在房間頁與量測精靈。', dots: ['FL', 'FR', 'SW1'] },
      { id: '2.2', name: '2.2 立體聲＋雙重低音', sub: '前方一對加兩顆重低音（第二顆預設接 C，可在設定改）。兩顆收同一個低頻訊號，可分別調增益與延遲。', dots: ['FL', 'FR', 'SW1', 'SW2'] },
      { id: '4.0', name: '4.0 前後兩對', sub: '前方一對加後方一對：四聲道氛圍／低頻模式、前後對齊與 ART 低頻校正。', dots: ['FL', 'FR', 'SL', 'SR'] },
      { id: '4.1', name: '4.1 前後兩對＋重低音', sub: '4.0 再加一顆重低音：前後四顆都高通，低頻交給重低音。ART 模式下重低音也會一起參與低頻抵消。', dots: ['FL', 'FR', 'SL', 'SR', 'SW1'] },
      { id: '4.2', name: '4.2 前後兩對＋雙重低音', sub: '4.0 再加兩顆重低音，兩顆收同一個低頻訊號。', dots: ['FL', 'FR', 'SL', 'SR', 'SW1', 'SW2'] },
    ];
    const grid = h('div', { class: 'lay-grid' });
    const draw = () => {
      grid.innerHTML = '';
      const cur = layoutOf(C.S);
      for (const o of OPTS) {
        const dia = h('div', { class: 'lay-dia', 'aria-hidden': 'true' }, ...(o.id === 'hp' ? [h('span', { class: 'lay-hp' }, '耳機')] : o.dots.map(d => h('i', { class: 'lay-' + d }, d))));
        const b = h('button', { class: 'lay-card' + (cur === o.id ? ' on' : ''), type: 'button', 'data-layout': o.id, 'aria-pressed': String(cur === o.id) }, dia, h('b', {}, o.name), h('small', {}, o.sub));
        b.onclick = () => { C.setLayout(o.id); draw(); };
        grid.append(b);
      }
    };
    draw();
    box.append(h('p', { class: 'hint', style: 'margin-top:0' }, '告訴控制台你的喇叭怎麼接，沒有用到的功能會自動收起來（資料不會刪除）。之後在「設定 → 喇叭配置」隨時可以改。'), grid);
  },
  async look(box) {
    const S = C.S, ui = S.ui, L = C.look;
    const apply = () => { L.apply(); C.saveState(); };
    const sk = h('div', { class: 'skin-grid wiz-look', id: 'wizSkins' });
    const drawSk = () => { sk.innerHTML = ''; for (const k of L.SKINS) {
      const b = h('button', { class: 'skin-card' + (ui.skin === k.id ? ' on' : ''), type: 'button', 'data-skin': k.id },
        h('div', { class: 'sw' }, h('i', { style: `background:${k.sw[0]}` }), h('span', { style: `background:${k.sw[1]}` }, h('b', { style: `background:${k.sw[2]}` }), h('em', { style: `background:${k.sw[2]};opacity:.5` }))), h('b', {}, k.name));
      b.onclick = () => { ui.skin = k.id; apply(); drawSk(); }; sk.append(b); } };
    drawSk();
    const th = S.theme === 'light' ? 'light' : 'dark';
    const pg = h('div', { class: 'skin-grid pal-grid wiz-look', id: 'wizPals' });
    const drawPg = () => { pg.innerHTML = '';
      const card = (id, name, c) => {
        const b = h('button', { class: 'skin-card' + ((ui.palette?.id || '') === id ? ' on' : ''), type: 'button', 'data-pal': id },
          h('div', { class: 'sw' }, c ? [h('i', { style: `background:${c.bg}` }), h('span', { style: `background:${c.panel}` }, h('b', { style: `background:${c.accent}` }), h('em', { style: `background:${c.lamp}` }))] : [h('i', { style: 'background:var(--bg-2)' }), h('span', { style: 'background:var(--panel-2)' }, h('b', { style: 'background:var(--accent)' }))]), h('b', {}, name));
        b.onclick = () => { ui.palette = { id }; apply(); drawPg(); }; pg.append(b); };
      card('', '跟隨樣式', null);
      for (const p of PALETTES.slice(0, 7)) card(p.id, p.name, p[th]);
    };
    drawPg();
    let walls = [];
    try { const r = await fetch('wall/index.json', { cache: 'no-store' }); const j = r.ok ? await r.json() : []; walls = Array.isArray(j) ? j.filter(x => x && /^[\w.\- ]{1,80}$/.test(x.file || '')) : []; } catch {}
    ui.wall = ui.wall && typeof ui.wall === 'object' ? ui.wall : { src: '', fit: 'cover', dim: 0.35, blur: 0, panelAlpha: 1 };
    const wg = h('div', { class: 'wall-grid wiz-look', id: 'wizWalls' });
    const drawWg = () => { wg.innerHTML = '';
      const one = (src, name, url, fit) => {
        const b = h('div', { class: 'wall-th' + ((ui.wall.src || '') === src ? ' on' : '') }, h('button', { type: 'button', title: name, class: 'wall-pick', 'data-wall': src, style: url ? `background-image:url("${url}")` : '' }, url ? null : h('span', {}, '無')), h('small', {}, name));
        b.querySelector('button').onclick = () => { ui.wall.src = src; if (fit) ui.wall.fit = fit; apply(); drawWg(); };
        wg.append(b); };
      one('', '無桌布', '', '');
      for (const w of walls) one('builtin:' + w.file, String((getLang() === 'en' && w.name_en) || w.name || w.file), wallUrl('builtin:' + w.file), ['cover', 'tile', 'pixel'].includes(w.fit) ? w.fit : '');
    };
    drawWg();
    const PLAY = [['deck', '唱盤'], ['vu', '大型 VU 表'], ['cover', '大封面'], ['cassette', '卡帶'], ['minimal', '極簡']];
    const playG = h('div', { class: 'keys', id: 'wizPlay', role: 'radiogroup' });
    const drawPlay = () => { playG.innerHTML = ''; for (const [id, name] of PLAY) { const b = h('button', { class: 'key' + (ui.play === id ? ' on' : ''), type: 'button', role: 'radio', 'data-play': id }, name); b.onclick = () => { ui.play = id; apply(); drawPlay(); }; playG.append(b); } };
    drawPlay();
    ui.vinyl = ui.vinyl || { color: 'black', deck: 'wood' };
    const vg = h('div', { class: 'vc-grid', id: 'wizVinyl' });
    const drawV = () => { vg.innerHTML = ''; for (const c of VINYL_COLORS.slice(0, 8)) {
      const b = h('button', { type: 'button', class: 'vc-sw' + (ui.vinyl.color === c.id ? ' on' : ''), title: c.name, 'aria-label': c.name, 'data-vinyl': c.id }, h('i', { style: `background:${vinylLook(c.id, { title: '預覽' }).bg}` }), h('span', {}, c.name));
      b.onclick = () => { ui.vinyl.color = c.id; apply(); drawV(); }; vg.append(b); } };
    drawV();
    const sub = t => h('h3', { class: 'setup-h' }, t);
    box.append(h('p', { class: 'hint', style: 'margin-top:0' }, '點一下就會立刻套用，全部之後都能在「設定 → 外觀」調整（還有材質、強調色、卡帶外殼、儀表樣式等）。'),
      sub('樣式'), sk, sub('配色'), pg, sub('桌布'), wg, sub('播放頁'), playG, sub('黑膠顏色（唱盤樣式）'), vg);
  },
  async take(box) {
    const st = await status();
    box.append(
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Fono Console 會把 Equalizer APO 的 config.txt 改成只引用自己的設定檔（原檔自動備份），並讓你的帳號可以直接寫入設定資料夾。'),
      row(false, '接管 config.txt', '原內容備份成 config.backup-日期.txt',
        h('button', { class: 'btn primary', type: 'button', onclick: e => post('/api/eapo/takeover').then(() => { toast('已接管'); e.target.disabled = true; }).catch(err => toast(err.body?.detail || err.message, true)) }, '接管')),
      row(false, '寫入權限', '需要按一次 UAC「是」',
        h('button', { class: 'btn', type: 'button', onclick: () => post('/api/eapo/fixperm').then(() => toast('已授予寫入權限')).catch(err => toast(err.body?.detail || err.message, true)) }, '授予')),
      st.eapo?.installed ? null : h('p', { class: 'hint' }, '⚠ 尚未偵測到 Equalizer APO，這一步要等安裝並重開機後再做。'));
  },
  async music(box) {
    box.append(h('h3', { class: 'setup-h' }, 'Spotify'), C.spotifyPanel(), h('h3', { class: 'setup-h' }, 'YouTube Music 桌面版'));
    const yt = h('div');
    box.append(yt);
    const draw = async () => {
      const st = (await status()).ytm || {};
      const job = st.job || {};
      yt.innerHTML = '';
      yt.append(
        row(st.installed, st.installed ? '已安裝' : '尚未安裝', job.state === 'running' ? job.step : job.state === 'error' ? '⚠ ' + job.error : job.state === 'done' ? job.step : '開源的 pear-desktop（MIT），從 GitHub 下載並比對 SHA-256',
          st.installed ? null : h('button', { class: 'btn primary', type: 'button', disabled: job.state === 'running' ? '' : null, onclick: () => post('/api/setup/ytm-install').then(draw) }, '下載並安裝')),
        row(st.api, st.api ? 'API 已開啟' : '開啟 API', '只接受本機連線（127.0.0.1:26538）；第一次搜尋時 YouTube Music 會問你是否允許，按允許',
          st.api ? null : h('button', { class: 'btn', type: 'button', onclick: () => post('/api/setup/ytm-api').then(() => { toast('已開啟'); draw(); }).catch(err => toast(err.body?.detail || err.message, true)) }, '開啟 API')));
      if (job.state !== 'running') clearInterval(W.timer);
    };
    await draw();
    W.timer = setInterval(draw, 2000);
  },
  async extra(box) {
    const st = await status();
    const chrome = toggle({ label: 'Chrome 省記憶體', sub: '關閉背景執行、開啟記憶體節省（目前使用者的政策，可隨時關掉）', value: !!st.chrome?.policy,
      onInput: v => post('/api/setup/chrome', { on: v }).then(() => toast(v ? '已套用，重開 Chrome 生效' : '已移除')).catch(err => toast(err.message, true)) });
    box.append(chrome.el,
      row(!!st.rew?.path, 'REW（Room EQ Wizard）', st.rew?.path || '選用。授權不允許轉發，所以不內附：需要時從官方網站下載',
        st.rew?.path ? null : h('a', { class: 'btn', href: 'https://www.roomeqwizard.com/', target: '_blank', rel: 'noopener' }, '官方網站')));
  },
  done(box) {
    const g = [...W.goals];
    const A = W.auto; W.auto = null;
    if (A) box.append(h('p', { style: 'margin-top:0' }, '自動設定結果：'),
      h('ul', { class: 'wiz-tips' }, ...A.done.map(t => h('li', {}, '✓ ' + t))),
      A.todo.length ? h('p', {}, '還需要你：') : null,
      A.todo.length ? h('ul', { class: 'wiz-tips' }, ...A.todo.map(t => h('li', {}, t))) : null);
    box.append(h('p', { style: A ? '' : 'margin-top:0' }, '設定完成。接下來建議：'),
      h('ol', { class: 'wiz-tips' },
        g.includes('room') && layoutOf(C.S) !== 'hp' ? h('li', {}, `到「量測 → 一鍵校正」量一次房間（約 5 分鐘${!hasRear(C.S) ? '，只量前方 FL／FR' + (layoutOf(C.S).endsWith('.0') ? '' : '與重低音') : ''}）。`) : null,
        g.includes('hp') ? h('li', {}, '到「耳機」選你的耳機，搜尋 AutoEq 型號。') : null,
        g.includes('lib') ? h('li', {}, '到「曲庫」搜尋一張專輯試試。') : null,
        h('li', {}, '外觀可以在「設定 → 外觀」換配色與播放頁樣式。')),
      h('div', { class: 'done-actions' },
        h('button', { class: 'btn primary big', type: 'button', id: 'setupTour', onclick: () => { close(true); startTour(C); } }, '開始功能導覽'),
        h('a', { class: 'btn big', id: 'setupDocs', href: DOCS, target: '_blank', rel: 'noopener' }, '開啟教學網站')),
      h('p', { class: 'hint' }, '需要時在「設定」最上方可以重新打開這個精靈。'));
  },
};

function applyGoals() {
  const f = C.S.ui.features;
  const want = {};
  for (const g of GOALS) for (const [k, v] of Object.entries(g.feats)) want[k] = (want[k] || false) || (W.goals.has(g.id) && v);
  Object.assign(f, want);
  if (layoutOf(C.S) === 'hp') f.hp = true;   // the chosen speaker layout wins over the goal list
  C.saveState(); C.applyFeatures();
}

const DEV_MULTI = /7\.1|5\.1|USB Sound|CM6206|Multichannel|多聲道/i;
const DEV_BAD = /HDMI|NVIDIA|AMD|Intel\(R\) Display|顯示器|Monitor/i;

async function autoSetup(btn, prog) {
  btn.disabled = true;
  const A = { done: [], todo: [] };
  const step = txt => { const el = document.createElement('div'); el.className = 'auto-line'; el.textContent = '… ' + txt; prog.append(el); return (ok, note) => { el.textContent = (ok ? '✓ ' : '⚠ ') + txt + (note ? '（' + note + '）' : ''); }; };
  prog.innerHTML = '';
  try {
    let fin = step('套用功能選擇'); applyGoals(); fin(true); A.done.push('依你的目標開啟對應功能');

    fin = step('檢查 Equalizer APO');
    const st = await status();
    if (!st.eapo?.installed) {
      try { await post('/api/setup/eapo-install'); fin(false, '尚未安裝'); } catch (e) { fin(false, e.message); }
      const msg = '請完成 Equalizer APO 安裝（勾選喇叭輸出），完成後再按一次';
      prog.append(h('p', { class: 'hint' }, msg));
      toast(msg);
      btn.disabled = false;
      return;
    }
    fin(true, '已安裝');

    fin = step('自動選擇輸出裝置');
    const devs = C.RT.devices || [];
    const dv = C.S.dev;
    const picked = [];
    if (!dv.cm && hasRear(C.S)) {
      const d = devs.find(d => DEV_MULTI.test(`${d.iface || ''} ${d.name || ''}`));
      if (d) { dv.cm = d.guid; picked.push('多聲道：' + (d.name || d.guid)); }
    }
    if (!dv.spark) {
      const d = devs.find(d => d.guid !== dv.cm && d.eapo && !DEV_BAD.test(`${d.iface || ''} ${d.name || ''}`));
      if (d) { dv.spark = d.guid; picked.push('立體聲 DAC：' + (d.name || d.guid)); }
    }
    if (picked.length) { C.saveState(); C.changed(); }
    fin(true, picked.length ? picked.join('；') : '沿用現有選擇');
    if (picked.length) { A.done.push('選定裝置 ' + picked.join('；')); A.todo.push('剛加入的裝置要重新開機後才會生效（若在 Device Selector 新增過）。'); }
    else if (!dv.cm && !dv.spark) { A.todo.push('沒有找到合適的輸出裝置，請到「選擇輸出裝置」步驟手動挑選。'); }

    for (const [label, url, okMsg] of [['接管 config.txt', '/api/eapo/takeover', '已接管 config.txt'], ['授予寫入權限', '/api/eapo/fixperm', '已授予寫入權限（UAC）']]) {
      fin = step(label);
      try { await post(url); fin(true); A.done.push(okMsg); }
      catch (e) { const d = e.body?.detail || e.message; fin(false, d); A.todo.push(`${label}失敗：${d}。可到「交給 Fono Console 管理」步驟重試。`); }
    }

    if (W.goals.has('lib')) {
      fin = step('安裝 YouTube Music 桌面版');
      if (st.ytm?.installed) { fin(true, '已安裝'); A.done.push('YouTube Music 桌面版已安裝'); }
      else {
        try { await post('/api/setup/ytm-install'); fin(true, '背景下載中'); A.done.push('已開始下載 YouTube Music 桌面版（背景進行）'); }
        catch (e) { fin(false, e.body?.detail || e.message); A.todo.push('YouTube Music 安裝沒有啟動，可到「音樂來源」步驟重試。'); }
      }
      A.todo.push('Spotify：到 Spotify 開發者後台建立 App，把 Client ID 貼到「音樂來源」步驟。');
    }
  } catch (e) {
    toast(e.message, true); btn.disabled = false; return;
  }
  W.auto = A;
  W.step = steps().length - 1;
  render();
}
