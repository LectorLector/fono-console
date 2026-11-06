// Free layout (Task 4): edit mode for every page's panels, editable rail, custom pages with a 12-column widget grid.
// app.js only hooks in: init(env), onGoto(page), tick(), settingsPanel(). Widget types live in widgets-dash.js.
import { h } from './widgets.js';
import { toast } from './ui.js';
import { dataAttr, srcText } from './i18n.js';
import { registerDashWidgets } from './widgets-dash.js';

const COLS = 12, ROW = 80;
export const WIDGETS = new Map();
export function registerWidget(def) { if (def && typeof def.type === 'string' && typeof def.render === 'function') WIDGETS.set(def.type, def); }

const BASE = [['play', '01', '播放', 'PLAY'], ['lib', '02', '曲庫', 'LIBRARY'], ['fx', '03', '音效', 'EFFECT'], ['room', '04', '房間', 'ROOM'], ['measure', '05', '量測', 'MEASURE'], ['hp', '06', '耳機', 'PHONES'], ['settings', '07', '設定', 'SYSTEM']];
const GROUPS = [['media', '媒體與控制'], ['time', '時鐘與計時'], ['tool', '實用工具'], ['note', '便條']];

let E = null, S = null, editing = false, active = '', applying = false, dragging = false, pagesEl = null, dock = null, dockInfo = null;
const PAGES = new Map();            // custom page id -> { pg, sec, grid, items: Map(wid -> item), title, guideKey }
const uid = () => Math.random().toString(36).slice(2, 7);
const strs = a => (Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string'))] : []);
const int = (v, lo, hi, d) => { v = Math.round(+v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const save = () => E?.save();

// ---------------------------------------------------------------- validation of stored data
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Resolve overlaps: `anchor` (if any) keeps its place, the others are pushed down (and, with `compact`, pulled up into free space). */
function pack(list, anchor, compact = false) {
  const placed = anchor ? [anchor] : [];
  for (const r of list.filter(i => i !== anchor).sort((a, b) => a.y - b.y || a.x - b.x)) {
    if (compact) r.y = 0;
    for (let again = true; again;) { again = false; for (const p of placed) if (hit(r, p)) { r.y = p.y + p.h; again = true; } }
    placed.push(r);
  }
}
function freeSpot(recs, w, hh) {
  for (let y = 0; y < 400; y++) for (let x = 0; x <= COLS - w; x++) if (!recs.some(r => hit({ x, y, w, h: hh }, r))) return { x, y };
  return { x: 0, y: 0 };
}

/** Make ui.layout / ui.rail / ui.pages well-formed. Unknown widget types and malformed entries are dropped. */
export function normDash(ui) {
  const lay = {};
  if (ui.layout && typeof ui.layout === 'object' && !Array.isArray(ui.layout)) {
    for (const [k, v] of Object.entries(ui.layout)) if (v && typeof v === 'object') lay[k] = { order: strs(v.order), hidden: strs(v.hidden), wide: strs(v.wide) };
  }
  ui.layout = lay;
  const r = ui.rail && typeof ui.rail === 'object' ? ui.rail : {};
  ui.rail = { order: strs(r.order), hidden: strs(r.hidden).filter(x => x !== 'settings') };
  const seen = new Set(), pages = [];
  for (const p of Array.isArray(ui.pages) ? ui.pages : []) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^c\d{1,6}$/.test(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    const wseen = new Set(), ws = [];
    for (const w of Array.isArray(p.widgets) ? p.widgets : []) {
      const def = w && typeof w === 'object' ? WIDGETS.get(w.type) : null;
      if (!def) continue;
      const id = typeof w.id === 'string' && /^[\w-]{1,16}$/.test(w.id) && !wseen.has(w.id) ? w.id : 'w' + uid();
      wseen.add(id);
      const ww = int(w.w, def.minW, COLS, def.defW || def.minW), hh = int(w.h, def.minH, 40, def.defH || def.minH);
      ws.push({ id, type: w.type, x: int(w.x, 0, COLS - ww, 0), y: int(w.y, 0, 400, 0), w: ww, h: hh, cfg: w.cfg && typeof w.cfg === 'object' && !Array.isArray(w.cfg) ? w.cfg : {} });
    }
    pack(ws, null);
    pages.push({ id: p.id, name: (typeof p.name === 'string' && p.name.trim().slice(0, 24)) || '自訂頁', icon: typeof p.icon === 'string' ? p.icon.slice(0, 3) : '', widgets: ws });
  }
  ui.pages = pages;
}

// ---------------------------------------------------------------- generic pointer sorting (panels in a container, rail buttons)
function flip(before) {
  for (const [s, b] of before) {
    const a = s.getBoundingClientRect(), dx = b.left - a.left, dy = b.top - a.top;
    if (!dx && !dy) continue;
    s.style.transition = 'none'; s.style.transform = `translate(${dx}px,${dy}px)`; void s.offsetWidth;
    s.style.transition = 'transform .2s ease'; s.style.transform = '';
    setTimeout(() => { s.style.transition = ''; }, 240);
  }
}
/**
 * Drag `el` among `o.items()` (its siblings). Uses window listeners so the element may be moved in the DOM while dragged.
 * o.threshold: pixels before a press becomes a drag (0 = immediately); o.onDrop() runs after a real drag.
 */
function sortDrag(e0, el, o) {
  const sx = e0.clientX, sy = e0.clientY, th = o.threshold || 0;
  let on = false, gx = 0, gy = 0, lx = sx, ly = sy, raf = 0;
  const begin = () => {
    on = true; dragging = true;
    const r = el.getBoundingClientRect(); gx = lx - r.left; gy = ly - r.top;
    el.classList.add('dl-drag'); document.documentElement.classList.add('dl-dragging');
  };
  const frame = () => {
    raf = 0;
    const sr = pagesEl.getBoundingClientRect();
    if (o.scroll !== false) { if (ly < sr.top + 56) pagesEl.scrollTop -= 14; else if (ly > sr.bottom - 56) pagesEl.scrollTop += 14; }
    el.style.transition = 'none'; el.style.transform = '';
    const own = el.getBoundingClientRect();
    if (!(lx >= own.left && lx <= own.right && ly >= own.top && ly <= own.bottom)) {
      const sibs = o.items();
      const tgt = sibs.find(s => { const b = s.getBoundingClientRect(); return b.width > 0 && lx >= b.left && lx <= b.right && ly >= b.top && ly <= b.bottom; });
      if (tgt) {
        const b = tgt.getBoundingClientRect(), rects = new Map(sibs.map(s => [s, s.getBoundingClientRect()]));
        const sameRow = Math.abs(b.top - own.top) < Math.min(b.height, own.height) * 0.5;
        const before = sameRow ? lx < b.left + b.width / 2 : ly < b.top + b.height / 2;
        if (before) tgt.before(el); else tgt.after(el);
        flip(rects);
      }
    }
    const r2 = el.getBoundingClientRect();
    el.style.transform = `translate(${(lx - gx - r2.left).toFixed(1)}px,${(ly - gy - r2.top).toFixed(1)}px)`;
  };
  const move = ev => {
    lx = ev.clientX; ly = ev.clientY;
    if (!on) { if (Math.hypot(lx - sx, ly - sy) < th) return; begin(); }
    ev.preventDefault();
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf);
    if (!on) return;
    el.style.transition = 'transform .16s ease'; el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; el.classList.remove('dl-drag'); document.documentElement.classList.remove('dl-dragging'); }, 180);
    const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', stop, true), 60);
    o.onDrop?.(); dragging = false;
  };
  window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  if (!th) { begin(); frame(); }
}

// ---------------------------------------------------------------- panels of the built-in pages
const slug = t => (t || '').replace(/\s+/g, ' ').trim().slice(0, 24);
const topPanels = page => [...page.querySelectorAll('.panel')].filter(el => !el.parentElement.closest('.panel'));
const pageIdOf = el => el.closest('.page')?.id.slice(5) || '';
const layoutOf = pid => (S.ui.layout[pid] ??= { order: [], hidden: [], wide: [] });
const toggleIn = (arr, k, on) => { const i = arr.indexOf(k); if (on && i < 0) arr.push(k); else if (!on && i >= 0) arr.splice(i, 1); };

function ensureBar(el) {
  let bar = el.querySelector(':scope > .dl-bar');
  if (!bar) {
    const grip = h('button', { class: 'dl-grip', type: 'button', title: '拖曳排序', 'aria-label': '拖曳排序' }, h('i'));
    const wide = h('button', { class: 'dl-wide', type: 'button', title: '加寬／還原寬度', 'aria-label': '加寬' }, '↔');
    const eye = h('button', { class: 'dl-eye', type: 'button', title: '隱藏', 'aria-label': '隱藏' }, '×');
    bar = h('div', { class: 'dl-bar' }, grip, wide, eye);
    grip.addEventListener('pointerdown', e => {
      if (e.button) return;
      sortDrag(e, el, { items: () => topPanels(el.closest('.page')).filter(s => s !== el && s.parentElement === el.parentElement && s.offsetParent !== null), onDrop: () => persistOrder(pageIdOf(el)) });
    });
    wide.onclick = () => { const L = layoutOf(pageIdOf(el)), on = !el.classList.contains('dash-wide'); toggleIn(L.wide, el.dataset.pk, on); el.classList.toggle('dash-wide', on); save(); };
    eye.onclick = () => { const L = layoutOf(pageIdOf(el)), on = !el.classList.contains('dash-hide'); toggleIn(L.hidden, el.dataset.pk, on); el.classList.toggle('dash-hide', on); save(); };
    el.append(bar);
  }
  bar.dataset.canwide = getComputedStyle(el.parentElement).display === 'grid' ? '1' : '';
  bar.querySelector('.dl-eye').textContent = el.classList.contains('dash-hide') ? '顯示' : '×';
}
function persistOrder(pid) {
  const page = document.getElementById('page-' + pid); if (!page) return;
  layoutOf(pid).order = topPanels(page).map(el => el.dataset.pk);
  save();
}

function applyPage(pid) {
  const page = document.getElementById('page-' + pid);
  if (!page || page.classList.contains('custom')) return;
  applying = true;
  try {
    const panels = topPanels(page), used = new Set();
    panels.forEach((el, i) => {
      if (el.__o === undefined) el.__o = i;
      let k = el.dataset.pk || el.id || slug(srcText(el.querySelector(':scope > .ph h2') || document.createElement('i'))) || 'p' + i;
      if (used.has(k)) { let n = 2; while (used.has(k + '-' + n)) n++; k += '-' + n; }
      used.add(k); el.dataset.pk = k;
    });
    const L = S.ui.layout[pid], order = L?.order || [], hid = L?.hidden || [], wide = L?.wide || [];
    for (const el of panels) {
      el.classList.toggle('dash-hide', hid.includes(el.dataset.pk));
      el.classList.toggle('dash-wide', wide.includes(el.dataset.pk));
      ensureBar(el);
    }
    const groups = new Map();
    for (const el of panels) { if (!groups.has(el.parentElement)) groups.set(el.parentElement, []); groups.get(el.parentElement).push(el); }
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      const rank = el => { const i = order.indexOf(el.dataset.pk); return i >= 0 ? i : 1000 + el.__o; };
      const sorted = [...items].sort((a, b) => rank(a) - rank(b));
      if (sorted.every((el, i) => el === items[i])) continue;
      const marks = items.map(el => { const m = document.createComment(''); el.before(m); return m; });
      sorted.forEach((el, i) => marks[i].before(el));
      marks.forEach(m => m.remove());
    }
  } finally { applying = false; }
}
function applyAll() { for (const [id] of BASE) applyPage(id); }

// ---------------------------------------------------------------- rail
const pageName = id => BASE.find(b => b[0] === id)?.[2] || PAGES.get(id)?.pg.name || id;
function railIds() {
  const all = [...BASE.map(b => b[0]), ...S.ui.pages.map(p => p.id)];
  const ord = S.ui.rail.order.filter(id => all.includes(id));
  for (const id of all) {
    if (ord.includes(id)) continue;
    const at = ord.indexOf('settings');
    if (at >= 0 && !BASE.some(b => b[0] === id)) ord.splice(at, 0, id); else ord.push(id);
  }
  return ord;
}
function renderRail() {
  const rail = document.getElementById('rail');
  rail.innerHTML = '';
  const hid = S.ui.rail.hidden;
  railIds().forEach(id => {
    const base = BASE.find(b => b[0] === id), cp = S.ui.pages.find(p => p.id === id);
    const num = base ? base[1] : cp.icon || 'C' + (S.ui.pages.indexOf(cp) + 1);
    const b = h('button', { 'data-page': id, type: 'button', class: (id === S.page ? 'on' : '') + (hid.includes(id) ? ' rl-hidden' : '') }, h('em', {}, num), h('b', base ? {} : dataAttr(cp.name), base ? base[2] : cp.name), h('small', {}, base ? base[3] : 'PAGE'));
    b.title = base ? base[2] : cp.name;
    if (id !== 'settings') {
      const eye = h('span', { class: 'rl-ctl rl-eye', role: 'button', tabindex: 0, title: hid.includes(id) ? '顯示此頁' : '隱藏此頁' }, hid.includes(id) ? '顯示' : '×');
      eye.addEventListener('click', ev => { ev.stopPropagation(); setRailHidden(id, !hid.includes(id)); });
      eye.addEventListener('pointerdown', ev => ev.stopPropagation());
      b.append(eye);
    }
    if (cp) {
      const del = h('span', { class: 'rl-ctl rl-del', role: 'button', tabindex: 0, title: '刪除此分頁' }, '刪');
      del.addEventListener('click', ev => { ev.stopPropagation(); deletePage(id); });
      del.addEventListener('pointerdown', ev => ev.stopPropagation());
      b.append(del);
      b.addEventListener('dblclick', () => renamePage(id, b));
    }
    b.addEventListener('click', () => E.goto(id));
    b.addEventListener('pointerdown', ev => {
      if (!editing || ev.button || ev.target.closest('.rl-ctl, input')) return;
      sortDrag(ev, b, { threshold: 6, scroll: false, items: () => [...rail.querySelectorAll(':scope > button')].filter(x => x !== b), onDrop: () => { S.ui.rail.order = [...rail.querySelectorAll(':scope > button')].map(x => x.dataset.page); save(); } });
    });
    rail.append(b);
  });
  rail.append(h('div', { class: 'rl-foot' },
    h('button', { class: 'btn', type: 'button', onclick: addPage }, '＋ 新增分頁'),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => { S.ui.rail = { order: [], hidden: [] }; renderRail(); save(); } }, '還原導覽列')));
  E.applyFeatures();
}
function setRailHidden(id, on) {
  toggleIn(S.ui.rail.hidden, id, on); save(); renderRail();
  if (on && S.page === id) E.goto(railIds().find(x => !S.ui.rail.hidden.includes(x)) || 'settings');
}
function renamePage(id, btn) {
  const pg = S.ui.pages.find(p => p.id === id); if (!pg) return;
  const t = btn.querySelector('b'), inp = h('input', { type: 'text', value: pg.name, maxlength: 24, class: 'rl-input', 'aria-label': '分頁名稱' });
  t.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const fin = ok => {
    if (done) return; done = true;
    if (ok && inp.value.trim()) { pg.name = inp.value.trim().slice(0, 24); save(); const ps = PAGES.get(id); if (ps) { ps.title.textContent = pg.name; ps.title.toggleAttribute('data-i18n-skip', 'data-i18n-skip' in dataAttr(pg.name)); } }
    renderRail(); updateDock();
  };
  inp.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); else if (ev.key === 'Escape') fin(false); };
  inp.onblur = () => fin(true);
  inp.addEventListener('click', ev => ev.stopPropagation());
  inp.addEventListener('dblclick', ev => ev.stopPropagation());
}
function addPage() {
  let n = 1; while (S.ui.pages.some(p => p.id === 'c' + n)) n++;
  const pg = { id: 'c' + n, name: `自訂 ${n}`, icon: '', widgets: [] };
  S.ui.pages.push(pg); buildPage(pg); renderRail(); save();
  E.goto(pg.id);
}
function deletePage(id) {
  const pg = S.ui.pages.find(p => p.id === id); if (!pg) return;
  if (!confirm(`刪除分頁「${pg.name}」和裡面的 ${pg.widgets.length} 個小工具？`)) return;
  const ps = PAGES.get(id);
  if (ps) { ps.items.forEach(it => it.api?.destroy?.()); ps.sec.remove(); PAGES.delete(id); }
  S.ui.pages = S.ui.pages.filter(p => p.id !== id);
  S.ui.rail.order = S.ui.rail.order.filter(x => x !== id); S.ui.rail.hidden = S.ui.rail.hidden.filter(x => x !== id);
  save(); renderRail();
  if (S.page === id) E.goto('play');
}

// ---------------------------------------------------------------- custom pages and widgets
function buildPage(pg) {
  const idx = S.ui.pages.indexOf(pg);
  const title = h('h1', dataAttr(pg.name), pg.name);
  title.title = '雙擊重新命名';
  title.ondblclick = () => { const b = document.querySelector(`#rail button[data-page="${pg.id}"]`); if (b) renamePage(pg.id, b); };
  const grid = h('div', { class: 'dg' });
  const sec = h('section', { class: 'page custom', id: 'page-' + pg.id },
    h('div', { class: 'page-head' }, h('div', { class: 'num' }, pg.icon || 'C' + (idx + 1)), h('div', {}, title, h('div', { class: 'sub' }, '自訂版面：在「編輯版面」中新增、拖曳與調整小工具。')), h('div', { class: 'bar' })), grid);
  pagesEl.insertBefore(sec, dock);
  const ps = { pg, sec, grid, title, items: new Map(), guideKey: '' };
  PAGES.set(pg.id, ps);
  for (const rec of pg.widgets) addItem(ps, rec);
  relayout(ps);
  if (S.page === pg.id) sec.classList.add('on');
  return ps;
}

function addItem(ps, rec) {
  const def = WIDGETS.get(rec.type); if (!def) return null;
  const tools = h('span', { class: 'dw-tools' }), body = h('div', { class: 'dw-body' });
  const del = h('button', { class: 'dw-x', type: 'button', title: '移除小工具', 'aria-label': '移除小工具' }, '×');
  const head = h('div', { class: 'dw-h' }, h('i', { class: 'dw-grip' }), h('span', { class: 'dw-t' }, def.name), tools, del);
  const rs = h('i', { class: 'dw-rs', title: '拖曳調整大小' });
  const el = h('div', { class: 'dw panel', 'data-type': rec.type, 'data-wid': rec.id }, head, body, rs);
  const item = { rec, def, el, body, tools, api: null, featOff: false, ps };
  del.onclick = () => removeItem(ps, item);
  head.addEventListener('pointerdown', ev => { if (!editing || ev.button || ev.target.closest('button, .dw-tools')) return; ev.preventDefault(); gridDrag(ev, ps, item, 'move'); });
  rs.addEventListener('pointerdown', ev => { if (!editing || ev.button) return; ev.preventDefault(); ev.stopPropagation(); gridDrag(ev, ps, item, 'resize'); });
  ps.items.set(rec.id, item);
  ps.grid.append(el);
  mountBody(item);
  return item;
}
function mountBody(item) {
  const { def, rec, body, ps } = item;
  try { item.api?.destroy?.(); } catch {}
  item.api = null; body.innerHTML = ''; item.tools.innerHTML = '';
  item.featOff = !!def.feature && S.ui.features?.[def.feature] === false;
  if (item.featOff) {
    body.append(h('div', { class: 'dw-off' }, h('p', {}, `這個小工具需要「${def.featureName || def.feature}」功能，目前在功能模組中是關閉的。`), h('button', { class: 'btn', type: 'button', onclick: () => E.goto('settings') }, '到設定開啟')));
    return;
  }
  try {
    item.api = def.render(body, rec.cfg, { env: E, S, RT: E.RT, tools: item.tools, save, wid: rec.id, active: () => active === ps.pg.id }) || {};
  } catch (err) {
    console.error('widget ' + rec.type, err);
    body.innerHTML = ''; body.append(h('div', { class: 'dw-off' }, h('p', {}, '這個小工具無法顯示。')));
  }
}
function removeItem(ps, item) {
  try { item.api?.destroy?.(); } catch {}
  item.el.remove(); ps.items.delete(item.rec.id);
  ps.pg.widgets = ps.pg.widgets.filter(r => r !== item.rec);
  relayout(ps); save();
}
function place(el, r) { el.style.gridColumn = `${r.x + 1} / span ${r.w}`; el.style.gridRow = `${r.y + 1} / span ${r.h}`; }
function rowsOf(list) { return list.reduce((m, r) => Math.max(m, r.y + r.h), 0); }
function relayout(ps, list = ps.pg.widgets) {
  const rows = Math.max(rowsOf(list) + (editing ? 4 : 0), editing ? 6 : 1);
  ps.grid.style.gridTemplateRows = `repeat(${rows}, ${ROW}px)`;
  for (const it of ps.items.values()) place(it.el, list.find(r => r.id === it.rec.id) || it.rec);
  const key = editing ? rows : 0;
  if (key !== ps.guideKey) {
    ps.guideKey = key;
    ps.grid.querySelector(':scope > .dg-guides')?.remove();
    if (editing) ps.grid.prepend(h('div', { class: 'dg-guides', 'aria-hidden': 'true', html: '<i></i>'.repeat(COLS * rows) }));
  }
  let empty = ps.grid.querySelector(':scope > .dg-empty');
  if (!ps.pg.widgets.length) {
    if (!empty) {
      empty = h('div', { class: 'dg-empty' }, h('b', {}, '這個分頁還沒有小工具'), h('p', {}, '把常用的控制、儀表和計算工具放在同一頁。'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { setEdit(true); openCatalog(ps.pg.id); } }, '＋ 新增小工具'));
      ps.grid.append(empty);
    }
  } else empty?.remove();
}

/** Move or resize a widget on the 12-column grid: free pointer movement, snapped ghost, overlapped widgets pushed down. */
function gridDrag(e0, ps, item, mode) {
  const grid = ps.grid, r = item.rec, el = item.el;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 12;
  const g0 = grid.getBoundingClientRect(), px = (g0.width + gap) / COLS, py = ROW + gap;
  const er = el.getBoundingClientRect();
  const gx = e0.clientX - er.left, gy = e0.clientY - er.top;
  const ghost = h('div', { class: 'dg-ghost' }); grid.append(ghost);
  let cur = { x: r.x, y: r.y, w: r.w, h: r.h }, lx = e0.clientX, ly = e0.clientY, raf = 0;
  el.classList.add('dw-drag'); grid.classList.add('dg-dragging');
  if (mode === 'resize') { el.style.width = er.width + 'px'; el.style.height = er.height + 'px'; el.style.justifySelf = 'start'; el.style.alignSelf = 'start'; }
  const frame = () => {
    raf = 0;
    const sr = pagesEl.getBoundingClientRect();
    if (ly < sr.top + 56) pagesEl.scrollTop -= 16; else if (ly > sr.bottom - 56) pagesEl.scrollTop += 16;
    const gr = grid.getBoundingClientRect();
    let nx = r.x, ny = r.y, nw = r.w, nh = r.h;
    if (mode === 'move') {
      const left = lx - gr.left - gx, top = ly - gr.top - gy;
      el.style.transform = `translate(${(left - r.x * px).toFixed(1)}px,${(top - r.y * py).toFixed(1)}px)`;
      nx = Math.min(COLS - r.w, Math.max(0, Math.round(left / px))); ny = Math.max(0, Math.round(top / py));
    } else {
      const wpx = Math.max(40, er.width + (lx - e0.clientX)), hpx = Math.max(40, er.height + (ly - e0.clientY));
      el.style.width = Math.min(wpx, g0.width - r.x * px + gap) + 'px'; el.style.height = hpx + 'px';
      nw = Math.min(COLS - r.x, Math.max(item.def.minW, Math.round((wpx + gap) / px))); nh = Math.min(40, Math.max(item.def.minH, Math.round((hpx + gap) / py)));
    }
    if (nx !== cur.x || ny !== cur.y || nw !== cur.w || nh !== cur.h) {
      cur = { x: nx, y: ny, w: nw, h: nh };
      const copy = ps.pg.widgets.map(w => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }));
      const anchor = copy.find(w => w.id === r.id); Object.assign(anchor, cur);
      pack(copy, anchor, true);
      relayout(ps, copy);
      place(el, mode === 'move' ? { ...cur, x: r.x, y: r.y, w: r.w, h: r.h } : { ...cur, x: r.x, y: r.y });   // dragged element keeps its own cell; ghost shows the target
      ghost.style.gridColumn = `${cur.x + 1} / span ${cur.w}`; ghost.style.gridRow = `${cur.y + 1} / span ${cur.h}`;
    } else if (!ghost.style.gridColumn) { ghost.style.gridColumn = `${cur.x + 1} / span ${cur.w}`; ghost.style.gridRow = `${cur.y + 1} / span ${cur.h}`; }
  };
  const move = ev => { lx = ev.clientX; ly = ev.clientY; ev.preventDefault(); if (!raf) raf = requestAnimationFrame(frame); };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    cancelAnimationFrame(raf); frame();
    const copy = ps.pg.widgets.map(w => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }));
    const anchor = copy.find(w => w.id === r.id); Object.assign(anchor, cur); pack(copy, anchor, true);
    for (const c of copy) { const w = ps.pg.widgets.find(x => x.id === c.id); if (w) { w.x = c.x; w.y = c.y; w.w = c.w; w.h = c.h; } }
    el.classList.remove('dw-drag'); grid.classList.remove('dg-dragging'); ghost.remove();
    el.style.transform = el.style.width = el.style.height = el.style.justifySelf = el.style.alignSelf = '';
    relayout(ps); save();
  };
  window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  frame();
}

function addWidget(pid, type) {
  const ps = PAGES.get(pid), def = WIDGETS.get(type); if (!ps || !def) return;
  const w = def.defW || def.minW, hh = def.defH || def.minH, at = freeSpot(ps.pg.widgets, w, hh);
  const rec = { id: 'w' + uid(), type, x: at.x, y: at.y, w, h: hh, cfg: structuredClone(def.cfg || {}) };
  ps.pg.widgets.push(rec);
  const it = addItem(ps, rec);
  relayout(ps); save();
  it?.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function openCatalog(pid) {
  if (!PAGES.has(pid)) return;
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  const groups = GROUPS.map(([id, label]) => {
    const defs = [...WIDGETS.values()].filter(d => d.group === id);
    if (!defs.length) return null;
    return h('section', { class: 'cat-g' }, h('h3', {}, label), h('div', { class: 'cat-grid' }, ...defs.map(d => {
      const off = d.feature && S.ui.features?.[d.feature] === false;
      const b = h('button', { class: 'cat-card', type: 'button' }, h('b', {}, d.name), h('small', {}, d.sub), h('em', {}, `最小 ${d.minW}×${d.minH}` + (off ? `　需開啟「${d.featureName || d.feature}」` : '')));
      b.onclick = () => { addWidget(pid, d.type); close(); };
      return b;
    })));
  });
  const modal = h('div', { class: 'dw-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '新增小工具' },
    h('div', { class: 'dw-cat panel' }, h('div', { class: 'ph' }, h('span', { class: 'tag' }, '＋'), h('h2', {}, '新增小工具'), h('span', { class: 'en' }, 'Widgets'), h('span', { class: 'rule' }), h('button', { class: 'btn ghost', type: 'button', onclick: close }, '關閉')), ...groups));
  modal.addEventListener('pointerdown', ev => { if (ev.target === modal) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(modal);
  modal.querySelector('.cat-card')?.focus();
}

// ---------------------------------------------------------------- edit mode
function updateDock() {
  if (!dock) return;
  const custom = PAGES.has(S.page);
  dockInfo.textContent = pageName(S.page);
  dock.querySelector('.dk-add').style.display = custom ? '' : 'none';
  dock.querySelector('.dk-reset').textContent = custom ? '清空小工具' : '還原預設版面';
}
function setEdit(on) {
  editing = !!on;
  document.documentElement.classList.toggle('edit-layout', editing);
  const b = document.getElementById('editBtn');
  if (b) { b.classList.toggle('on', editing); b.setAttribute('aria-pressed', editing); b.textContent = editing ? '完成編輯' : '編輯版面'; }
  for (const ps of PAGES.values()) { ps.guideKey = -1; relayout(ps); }
  if (editing) applyAll();
  else if (S.ui.rail.hidden.includes(S.page)) E.goto(railIds().find(x => !S.ui.rail.hidden.includes(x)) || 'settings');
  updateDock();
}
function resetPage() {
  const ps = PAGES.get(S.page);
  if (ps) {
    if (!ps.pg.widgets.length || !confirm(`清空「${ps.pg.name}」的 ${ps.pg.widgets.length} 個小工具？`)) return;
    ps.items.forEach(it => { try { it.api?.destroy?.(); } catch {} it.el.remove(); }); ps.items.clear(); ps.pg.widgets = [];
    relayout(ps); save(); return;
  }
  delete S.ui.layout[S.page];
  const page = document.getElementById('page-' + S.page);
  page?.querySelectorAll('.panel.dash-hide, .panel.dash-wide').forEach(el => el.classList.remove('dash-hide', 'dash-wide'));
  applyPage(S.page); save();
  toast('已還原這一頁的預設版面');
}

// ---------------------------------------------------------------- settings: export / import
function layoutExport() { return { kind: 'fono-layout', v: 1, layout: S.ui.layout, rail: S.ui.rail, pages: S.ui.pages }; }
function layoutImport(d) {
  if (!d || typeof d !== 'object' || d.kind !== 'fono-layout') throw new Error('bad');
  const t = { layout: d.layout, rail: d.rail, pages: d.pages };
  const before = Array.isArray(d.pages) ? d.pages.reduce((n, p) => n + (Array.isArray(p?.widgets) ? p.widgets.length : 0), 0) : 0;
  normDash(t);
  const kept = t.pages.reduce((n, p) => n + p.widgets.length, 0);
  resetAll(t);
  return before - kept;
}
function resetAll(t) {
  for (const ps of PAGES.values()) { ps.items.forEach(it => { try { it.api?.destroy?.(); } catch {} }); ps.sec.remove(); }
  PAGES.clear();
  S.ui.layout = t?.layout || {}; S.ui.rail = t?.rail || { order: [], hidden: [] }; S.ui.pages = t?.pages || [];
  document.querySelectorAll('.panel.dash-hide, .panel.dash-wide').forEach(el => el.classList.remove('dash-hide', 'dash-wide'));
  S.ui.pages.forEach(buildPage);
  renderRail(); applyAll();
  if (!hasPage(S.page)) E.goto('play'); else E.goto(S.page);
  save(); updateDock();
}
function settingsPanel() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
  file.onchange = async () => {
    const f = file.files[0]; file.value = ''; if (!f) return;
    try { const dropped = layoutImport(JSON.parse(await f.text())); toast(dropped ? `已匯入版面（略過 ${dropped} 個無法辨識的小工具）` : '已匯入版面'); }
    catch { toast('版面檔格式不正確', true); }
  };
  const exp = h('button', { class: 'btn', type: 'button' }, '匯出版面');
  exp.onclick = () => {
    const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(layoutExport(), null, 2)], { type: 'application/json' })), download: 'fono-layout.json' });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return h('div', { class: 'panel', 'data-pk': 'layout' },
    h('div', { class: 'ph' }, h('span', { class: 'tag' }, 'L'), h('h2', {}, '版面與小工具'), h('span', { class: 'rule' })),
    h('p', { class: 'hint', style: 'margin-top:0' }, '按上方的「編輯版面」可以拖曳面板重新排列、隱藏、加寬；左側分頁可排序、隱藏，也能新增自訂分頁並放入小工具（播放、儀表、計算工具、測試音…）。'),
    h('div', { class: 'accent-row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => setEdit(true) }, '開始編輯版面'), exp,
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, '匯入版面'), file,
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (confirm('還原所有頁面的預設版面，並刪除所有自訂分頁？')) { resetAll(null); toast('已還原預設版面'); } } }, '還原所有版面')),
    h('p', { class: 'hint' }, '版面檔只含面板排列與自訂分頁，不含外觀主題；主題請用上方「外觀」的匯出入。'));
}

// ---------------------------------------------------------------- lifecycle hooks used by app.js
function init(env) {
  E = env; S = env.S;
  registerDashWidgets(registerWidget);
  normDash(S.ui);
  pagesEl = document.querySelector('.pages');
  dockInfo = h('b', { class: 'dk-page' });
  dock = h('div', { class: 'dl-dock' }, h('div', { class: 'dl-dock-in', role: 'toolbar', 'aria-label': '版面編輯' },
    h('span', { class: 'dk-t' }, '編輯版面'), dockInfo,
    h('button', { class: 'btn dk-add', type: 'button', onclick: () => openCatalog(S.page) }, '＋ 新增小工具'),
    h('button', { class: 'btn ghost dk-reset', type: 'button', onclick: resetPage }, '還原預設版面'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => setEdit(false) }, '完成')));
  pagesEl.append(dock);
  S.ui.pages.forEach(buildPage);
  if (!hasPage(S.page)) S.page = 'play';
  active = S.page;
  renderRail();
  applyAll();
  // panels are rebuilt by the page modules at any time (settings, room, wizard…): re-apply when a panel appears
  const relevant = n => n.nodeType === 1 && (n.matches('.panel, .dl-bar') || n.querySelector('.panel'));
  const mo = new MutationObserver(recs => {
    if (applying || dragging) return;
    const dirty = new Set();
    for (const r of recs) {
      const pid = pageIdOf(r.target.nodeType === 1 ? r.target : r.target.parentElement || r.target);
      if (!pid || PAGES.has(pid)) continue;
      if ([...r.addedNodes].some(relevant) || [...r.removedNodes].some(n => n.nodeType === 1 && n.matches('.dl-bar'))) dirty.add(pid);
    }
    if (dirty.size) requestAnimationFrame(() => { if (!dragging) dirty.forEach(applyPage); });
  });
  document.querySelectorAll('.page').forEach(p => { if (!p.classList.contains('custom')) mo.observe(p, { childList: true, subtree: true }); });
  document.getElementById('editBtn')?.addEventListener('click', () => setEdit(!editing));
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && editing && !document.querySelector('.dw-modal') && !ev.target.closest('input,textarea,select')) setEdit(false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) for (const ps of PAGES.values()) ps.items.forEach(it => it.api?.hide?.()); });
}
const hasPage = id => BASE.some(b => b[0] === id) || PAGES.has(id);

function onGoto(page) {
  if (!E) return;
  if (active !== page) PAGES.get(active)?.items.forEach(it => { try { it.api?.hide?.(); } catch {} });
  active = page;
  const ps = PAGES.get(page);
  if (ps) {
    for (const it of ps.items.values()) if (!!it.def.feature && (S.ui.features?.[it.def.feature] === false) !== it.featOff) mountBody(it);
    relayout(ps);
  }
  updateDock();
}

function tick() {
  if (!E) return;
  for (const ps of PAGES.values()) {
    const on = ps.pg.id === active;
    for (const it of ps.items.values()) {
      const api = it.api;
      if (!api?.update || (!on && !it.def.always)) continue;
      try { api.update(); } catch (err) { console.error('widget ' + it.rec.type, err); api.update = null; }
    }
  }
}

export const dash = { init, onGoto, tick, settingsPanel, hasPage, applyAll, setEdit, isEditing: () => editing };
