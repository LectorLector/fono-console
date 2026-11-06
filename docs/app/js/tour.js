// In-app feature tour: highlight ring + caption card. Stores nothing.
import { h } from './ui.js';

const STEPS = [
  { sel: '#rail button[data-page="play"]', page: 'play', text: '播放：唱盤、封面、VU 表，右上可換樣式。' },
  { sel: '.play-layout', page: 'play', text: '播放頁樣式：唱盤／VU／封面。' },
  { sel: '#rail button[data-page="lib"]', text: '曲庫：Spotify 與 YouTube Music 一起搜尋。' },
  { sel: '#rail button[data-page="fx"]', text: '音效：EQ、混響、寬度。' },
  { sel: '#rail button[data-page="room"]', text: '房間：聆聽模式與每顆喇叭。' },
  { sel: '#rail button[data-page="measure"]', text: '量測：一鍵校正、FIR、ART。' },
  { sel: '#rail button[data-page="hp"]', text: '耳機：AutoEq、交叉饋送、藍牙。' },
  { sel: '#editBtn', text: '編輯版面：按下後每個面板都能拖曳、縮放、隱藏，導覽列也能排序或隱藏頁面。改完按「完成編輯」。' },
  { sel: '#editBtn', text: '自訂分頁：進入編輯版面後，導覽列最下方有「＋ 新增分頁」，建立空白分頁再從小工具目錄加入電平表、曲線、快速開關、便條紙等。' },
  { sel: '#rail button[data-page="settings"]', text: '設定：外觀、功能模組與實驗室、設定精靈。' },
  { sel: '#helpBtn', text: '隨時按這裡重看導覽或開教學網站。' },
];

let active = null;

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

export function startTour(ctx) {
  if (active) active.end();
  const ring = h('div', { class: 'tour-ring' });
  const overlay = h('div', { class: 'tour-overlay' }, ring);
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-label': '功能導覽' });
  overlay.append(card);
  document.body.append(overlay);
  let i = 0;

  const end = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (active && active.end === end) active = null;
  };
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); end(); } };
  document.addEventListener('keydown', onKey, true);
  active = { end };

  let cur = null;
  const place = () => {
    if (!cur) return;
    const el = document.querySelector(cur.sel);
    if (!visible(el)) return;
    const r = el.getBoundingClientRect(), pad = 4;
    Object.assign(ring.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px', opacity: 1 });
    const cw = card.offsetWidth || 300, ch = card.offsetHeight || 120, vw = innerWidth, vh = innerHeight;
    let x = r.right + 14, y = r.top;
    if (x + cw > vw - 8) { x = Math.min(Math.max(8, r.left), vw - cw - 8); y = r.bottom + 14; }
    if (y + ch > vh - 8) y = Math.max(8, Math.min(r.top - ch - 14, vh - ch - 8));
    card.style.left = x + 'px'; card.style.top = y + 'px';
  };
  window.addEventListener('resize', place);

  // find the nearest visible step in a direction
  const find = (from, dir) => {
    for (let k = from; k >= 0 && k < STEPS.length; k += dir) {
      const s = STEPS[k];
      if (s.page) ctx.goto(s.page);
      if (visible(document.querySelector(s.sel))) return k;
    }
    return -1;
  };

  const show = dir => {
    const k = find(i, dir);
    if (k < 0) { if (dir > 0) end(); return; }
    i = k; cur = STEPS[i];
    const last = find(i + 1, 1) < 0;
    card.innerHTML = '';
    card.append(
      h('small', {}, `功能導覽 · ${i + 1} / ${STEPS.length}`),
      h('p', {}, cur.text),
      h('div', { class: 'tour-btns' },
        h('button', { class: 'btn ghost', type: 'button', onclick: end }, '結束'),
        h('span', { style: 'flex:1' }),
        h('button', { class: 'btn', type: 'button', disabled: find(i - 1, -1) < 0 ? 'disabled' : null, onclick: () => { i--; show(-1); } }, '上一步'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { if (last) end(); else { i++; show(1); } } }, last ? '完成' : '下一步')));
    requestAnimationFrame(place);
  };
  requestAnimationFrame(() => show(1));
  return end;
}
