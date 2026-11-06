// Bilingual UI: Traditional Chinese (zh-TW) strings stay in the code as the source; English is looked up in i18n/en.json.
//   t(zh)            the English for a zh string when the language is 'en' (identity otherwise)
//   initI18n(S)      resolve the language (S.ui.lang; first run: English unless the browser language starts with 'zh'), load the dictionary,
//                    translate the page and keep translating whatever the app renders (MutationObserver, batched per animation frame)
//   setLang(S, l)    persist the choice and reload (every page is rebuilt from the saved state)
// Dictionary format: { strings: { "zh": "en", "zh with {} holes": "en with {} / {1} {2}" }, patterns: [[regexSource, replacement with $1…]] }.
// Anything under an element with data-i18n-skip (media titles, device names, user-typed names, file names…) is never translated.
let lang = 'zh-TW';
const exact = new Map(), tpls = [], pats = [];
const cache = new Map();
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
const CJK_LETTER = /[\u3400-\u9fff\uf900-\ufaff]/, CJK_LETTER_G = /[\u3400-\u9fff\uf900-\ufaff]/g;
const PUNCT = { '：': ': ', '；': '; ', '，': ', ', '、': ', ', '。': '. ', '！': '!', '？': '?', '（': ' (', '）': ')', '＋': '+', '－': '-', '～': '~', '　': ' ', '・': ' · ', '「': '"', '」': '"', '《': '"', '》': '"' };
const punct = s => s.replace(/[：；，、。！？（）＋－～　・「」《》]/g, c => PUNCT[c]).replace(/ {2,}/g, ' ').replace(/\( /g, '(').trim();
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
let subs = [];       // [zhKey, en] for the substring fallback, longest first

export const getLang = () => lang;
export const isEn = () => lang === 'en';
/** BCP-47 locale for Date formatting. */
export const locale = () => lang === 'en' ? 'en-GB' : 'zh-TW';
export const norm = s => s.replace(/\s+/g, ' ').trim();

export function detectLang(S) {
  // ?lang=en|zh (the tutorial site passes this to the embedded demo) wins
  let q = null; try { q = new URLSearchParams(location.search).get('lang'); } catch {}
  if (q === 'en') return 'en';
  if (q === 'zh' || q === 'zh-TW') return 'zh-TW';
  const saved = S?.ui?.lang;
  if (saved === 'en' || saved === 'zh-TW') return saved;
  let nav = ''; try { nav = (navigator.language || '').toLowerCase(); } catch {}
  return nav && !nav.startsWith('zh') ? 'en' : 'zh-TW';
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function fill(tpl, caps) {
  let seq = 0;
  return tpl.replace(/\{(\d*)\}/g, (_, n) => { const v = caps[n ? +n - 1 : seq++]; return v === undefined ? '' : tr(v); });
}
function compile(strings, patterns) {
  for (const [k, v] of Object.entries(strings)) {
    if (k.includes('{}')) {
      const re = new RegExp('^' + k.split('{}').map(esc).join('(.*?)') + '$', 's');
      const parts = k.split('{}'), inner = parts[0].length >= 2 && parts.at(-1).length >= 2;   // inner = literal at both ends: usable inside a longer run-time string
      const weak = (k.match(CJK_LETTER_G) || []).length < 2;   // e.g. "{}：{}": matches far too much, so only a last resort
      tpls.push({ re, v, weak, len: k.length, sub: inner ? new RegExp(parts.map(esc).join('(.*?)'), 'gs') : null });
    } else exact.set(k, v);
  }
  tpls.sort((a, b) => b.len - a.len);          // most specific (longest literal) first
  for (const [src, rep] of patterns || []) pats.push({ re: new RegExp(src, 's'), rep });
  subs = [...exact].filter(([k]) => k.length >= 2 && CJK.test(k)).sort((a, b) => b[0].length - a[0].length);
}

/** Translate a (possibly padded) string; returns it unchanged when nothing matches. */
function tr(text) {
  if (!CJK.test(text)) return text;
  const hit = cache.get(text); if (hit !== undefined) return hit;
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/), core = norm(m[2]);
  let out = null;
  const keepWs = v => (m[1] || v.match(/^\s*/)[0]) + v.trim() + (m[3] || v.match(/\s*$/)[0]);
  if (exact.has(core)) out = keepWs(exact.get(core));
  else {
    for (const p of pats) { const r = core.match(p.re); if (r) { out = keepWs(core.replace(p.re, (...a) => p.rep.replace(/\$(\d)/g, (_, i) => tr(a[+i] ?? '')))); break; } }   // hand-written patterns win over generated templates
    if (out === null) for (const t of tpls) if (!t.weak) { const r = core.match(t.re); if (r) { out = keepWs(fill(t.v, r.slice(1))); break; } }
    if (out === null) {          // pieces of a string that was assembled at run time: translate the known fragments
      let s = core, changed = false;
      for (const t of tpls) if (t.sub && t.sub.test(s)) { t.sub.lastIndex = 0; s = s.replace(t.sub, (...a) => fill(t.v, a.slice(1, -2))); changed = true; }
      for (const [k, v] of subs) if (s.includes(k)) { s = s.split(k).join(v); changed = true; }
      if (!changed) for (const t of tpls) if (t.weak) { const r = core.match(t.re); if (r) { s = fill(t.v, r.slice(1)); changed = true; break; } }
      out = changed ? m[1] + punct(s) + m[3] : (CJK_LETTER.test(text) ? text : m[1] + punct(core) + m[3]);   // a mixed string keeps its Chinese; punctuation-only is normalised
    }
  }
  if (cache.size > 6000) cache.clear();
  cache.set(text, out); return out;
}

export function t(zh) {
  if (lang !== 'en' || typeof zh !== 'string') return zh;
  return tr(zh);
}

// ---------------------------------------------------------------- DOM translator
const SKIP_TAG = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);
const skipped = el => !el || !!el.closest?.('[data-i18n-skip]') || SKIP_TAG.has(el.tagName) || el.isContentEditable;

const orig = new WeakMap();    // text node -> the zh text it had before translation
function textNode(n) {
  const v = n.nodeValue; if (!v || !CJK.test(v) || skipped(n.parentElement)) return;
  const o = tr(v); if (o !== v) { orig.set(n, v); n.nodeValue = o; }
}
/** The zh (source) textContent of an element, whatever the current language (used for language-independent keys such as panel ids). */
export function srcText(el) {
  let s = ''; const w = document.createTreeWalker(el, 4);
  for (let n = w.nextNode(); n; n = w.nextNode()) s += orig.get(n) ?? n.nodeValue;
  return s;
}
function attrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a); if (v && CJK.test(v) && !el.closest?.('[data-i18n-skip]')) { const o = tr(v); if (o !== v) el.setAttribute(a, o); }
  }
}
export function translateTree(root) {
  if (lang !== 'en' || !root) return;
  if (root.nodeType === 3) { textNode(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) { attrs(root); if (skipped(root)) return; }
  const w = document.createTreeWalker(root, 1 | 4);   // elements + text
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) textNode(n);
    else if (n.hasAttribute && n.hasAttribute('data-i18n-skip')) { // jump past the skipped subtree
      let last = n; while (last.lastChild) last = last.lastChild; w.currentNode = last;
    } else attrs(n);
  }
}

/** Translate whatever the app just rendered. Runs in the MutationObserver callback (a microtask: before the browser paints, so no flash of Chinese);
 *  the records of one task are batched, and our own writes only re-enter once with already-English text. */
let obs = null;
function observe() {
  obs = new MutationObserver(list => {
    const seen = new Set();
    for (const m of list) {
      if (m.type === 'childList') m.addedNodes.forEach(n => seen.add(n));
      else seen.add(m.target);
    }
    for (const n of seen) if (n.isConnected) translateTree(n);
  });
  obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

export async function initI18n(S) {
  lang = detectLang(S);
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  try { localStorage.setItem('fono-lang', lang); } catch {}
  if (S?.ui) S.ui.lang = lang;
  if (lang !== 'en') { document.documentElement.dataset.i18n = 'ready'; return; }
  try {
    const j = await (await fetch('i18n/en.json', { cache: 'no-cache' })).json();
    compile(j.strings || {}, j.patterns || []);
  } catch (e) { console.warn('i18n: dictionary failed to load', e); }
  // canvas labels (graphs, floor plan, waterfall…) are drawn with fillText / strokeText / measureText: translate there
  const C2 = window.CanvasRenderingContext2D?.prototype;
  if (C2) for (const f of ['fillText', 'strokeText', 'measureText']) { const o = C2[f]; C2[f] = function (txt, ...r) { return o.call(this, typeof txt === 'string' && CJK.test(txt) ? tr(txt) : txt, ...r); }; }
  for (const f of ['alert', 'confirm', 'prompt']) { const o = window[f].bind(window); window[f] = (m, ...r) => o(t(String(m ?? '')), ...r); }
  document.title = t(document.title);
  translateTree(document.body);
  observe();
  document.documentElement.dataset.i18n = 'ready';
}

/** Test hook: load a dictionary and switch language without a DOM. */
export function _useForTest(l, json) {
  lang = l; exact.clear(); tpls.length = 0; pats.length = 0; cache.clear(); subs = [];
  if (json) compile(json.strings || {}, json.patterns || []);
}

/** Put data (a track title, a name…) or a placeholder UI string into an element; data is never translated. */
export function setData(el, data, placeholder = '') {
  el.textContent = data || placeholder;
  el.toggleAttribute('data-i18n-skip', !!data);
  return el;
}
/** Attributes for an element showing user / library / device data: skipped by the translator, unless the text is a known UI string (e.g. the default page name). */
export const dataAttr = text => { const c = norm(String(text ?? '')); return exact.has(c) || tpls.some(t => !t.weak && t.re.test(c)) ? {} : { 'data-i18n-skip': '' }; };

export function setLang(S, l) {
  if (S?.ui) S.ui.lang = l;
  try { localStorage.setItem('fono-lang', l); } catch {}
  return l;
}
