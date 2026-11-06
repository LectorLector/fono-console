// Look system: colour palettes, panel textures, wallpaper layer and the settings UI for them.
// app.js calls applyLookExtras(S) from applyLook() and lookSections(env) from appearancePanel().
import { h, keys, toggle } from './widgets.js';
import { toast } from './ui.js';
import { t, isEn } from './i18n.js';
import { playerExport, playerImport } from './player.js';

// ---------------------------------------------------------------- colour helpers
const HEX = /^#[0-9a-f]{6}$/i;
const rgbOf = x => { const n = parseInt(x.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const hexOf = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = rgbOf(a), y = rgbOf(b); return hexOf(x.map((v, i) => v + (y[i] - v) * t)); };
const rgba = (a, al) => `rgba(${rgbOf(a).join(',')},${al})`;
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lumOf = x => { const [r, g, b] = rgbOf(x); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
export function contrast(a, b) { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

// ---------------------------------------------------------------- palettes
const P = (id, name, d, l) => ({ id, name, dark: { bg: d[0], panel: d[1], ink: d[2], accent: d[3], lamp: d[4] }, light: { bg: l[0], panel: l[1], ink: l[2], accent: l[3], lamp: l[4] } });
export const PALETTES = [
  P('champagne', '香檳金面板', ['#17150f', '#26221a', '#ece4d2', '#c9ae7a', '#6fa3d6'], ['#e6dfcf', '#f2ecdc', '#2c261b', '#8f6f33', '#3f76ad']),
  P('meter', '藍色電表', ['#090c10', '#12171d', '#dbe6ee', '#5ea8d6', '#49b6d9'], ['#dde4ea', '#edf1f4', '#19242d', '#23638a', '#1d7fa3']),
  P('minimal', '白色極簡', ['#151515', '#202020', '#eeeeea', '#e8742c', '#e8742c'], ['#e8e7e3', '#f4f3ef', '#1f1f1d', '#c24e0c', '#d4560f']),
  P('deck', '銀色卡座', ['#1b1c1e', '#2a2c2f', '#e4e5e6', '#d9a54f', '#e0a840'], ['#d6d8da', '#e8e9ea', '#202224', '#94640f', '#c98a1c']),
  P('olive', '軍綠器材', ['#12140e', '#1e2218', '#dfe3d0', '#a6b374', '#b8c87a'], ['#dcdfcd', '#eceedf', '#232717', '#55632a', '#6f8a2a']),
  P('oxblood', '牛血紅', ['#140b0b', '#251615', '#ecdcd6', '#b8584a', '#d9705a'], ['#e6d8d3', '#f2e8e4', '#2c1714', '#8a2f25', '#b0402f']),
  P('navy', '海軍藍', ['#0c1118', '#151d29', '#dde3ec', '#7f9fcf', '#8fb4e8'], ['#dae0ea', '#eaeef4', '#172033', '#2f4f88', '#3d68b0']),
  P('cream', '奶油色收音機', ['#1d1913', '#2d261c', '#f0e6d0', '#d6a24e', '#e8b860'], ['#efe4cb', '#f8f0dc', '#33281a', '#9c6420', '#c98a30']),
  P('carbon', '碳黑', ['#0b0b0c', '#161617', '#e6e6e6', '#d0392f', '#e04a3a'], ['#dcdcdc', '#ebebeb', '#161616', '#b0241b', '#c8352a']),
  P('mint', '薄荷', ['#0f1614', '#19231f', '#dcebe4', '#7fc2a6', '#8fd6b6'], ['#dcebe4', '#ecf5f0', '#15251e', '#2a7156', '#3a9272']),
];
const TOKENS = ['--bg', '--bg-2', '--panel', '--panel-2', '--raised', '--line', '--line-2', '--ink', '--ink-2', '--ink-3', '--accent', '--accent-2', '--accent-ink',
  '--lit-glow', '--lcd', '--lcd-ink', '--lamp', '--brown', '--brown-2', '--knob-cap', '--knob-skirt', '--metal', '--dial', '--dial-ink', '--paper', '--bev-hi', '--bev-lo', '--grid'];

/** Every token the UI uses, derived from the five picked colours. */
export function deriveTokens(c, dark) {
  const { bg, panel, ink, accent, lamp } = c;
  const t = {};
  t['--bg'] = bg; t['--panel'] = panel; t['--ink'] = ink; t['--accent'] = accent; t['--lamp'] = lamp;
  t['--bg-2'] = dark ? mix(bg, panel, 0.5) : mix(bg, ink, 0.05);
  t['--panel-2'] = mix(panel, ink, dark ? 0.05 : 0.06);
  t['--raised'] = mix(panel, ink, dark ? 0.11 : 0.1);
  t['--line'] = mix(panel, ink, 0.14);
  t['--line-2'] = mix(panel, ink, 0.26);
  t['--ink-2'] = mix(ink, panel, 0.3);
  t['--ink-3'] = mix(ink, panel, 0.52);
  t['--accent-2'] = mix(accent, '#000000', 0.3);
  t['--accent-ink'] = lumOf(accent) > 0.3 ? '#1a1612' : '#faf7f2';
  t['--lit-glow'] = rgba(accent, dark ? 0.26 : 0.22);
  t['--lcd'] = dark ? mix(bg, '#000000', 0.45) : mix(ink, bg, 0.12);
  t['--lcd-ink'] = mix(lamp, '#ffffff', 0.45);
  t['--brown'] = mix(panel, accent, 0.35);
  t['--brown-2'] = mix(panel, accent, 0.55);
  t['--knob-cap'] = mix(panel, ink, 0.14);
  t['--knob-skirt'] = dark ? mix(panel, '#000000', 0.35) : mix(panel, ink, 0.25);
  t['--metal'] = t['--ink-3'];
  t['--dial'] = t['--paper'] = dark ? mix(ink, panel, 0.1) : mix(panel, '#ffffff', 0.45);
  t['--dial-ink'] = '#2a231c';
  t['--bev-hi'] = dark ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.7)';
  t['--bev-lo'] = dark ? 'rgba(0,0,0,.5)' : rgba(ink, 0.2);
  t['--grid'] = rgba(ink, 0.08);
  return t;
}
const toLight = d => ({ bg: mix(d.bg, '#f3efe6', 0.88), panel: mix(d.panel, '#ffffff', 0.9), ink: mix(d.bg, '#000000', 0.25), accent: mix(d.accent, '#000000', 0.25), lamp: mix(d.lamp, '#000000', 0.2) });
const toDark = l => ({ bg: mix(l.ink, '#000000', 0.45), panel: mix(l.ink, '#ffffff', 0.1), ink: mix(l.bg, '#ffffff', 0.4), accent: mix(l.accent, '#ffffff', 0.2), lamp: mix(l.lamp, '#ffffff', 0.2) });
const validColors = c => c && ['bg', 'panel', 'ink', 'accent', 'lamp'].every(k => HEX.test(c[k] || ''));

/** The colour set for the active palette and theme, or null when the skin's own colours apply. */
export function paletteColors(pal, theme) {
  if (!pal || !pal.id) return null;
  if (pal.id === 'custom') {
    const own = pal[theme];
    if (validColors(own)) return own;
    const other = pal[theme === 'dark' ? 'light' : 'dark'];
    return validColors(other) ? (theme === 'dark' ? toDark(other) : toLight(other)) : null;
  }
  const p = PALETTES.find(x => x.id === pal.id);
  return p ? p[theme] : null;
}

function applyPalette(de, ui, theme) {
  for (const k of TOKENS) de.style.removeProperty(k);
  const c = paletteColors(ui.palette, theme);
  de.classList.toggle('has-palette', !!c);
  if (!c) return;
  const tk = deriveTokens(c, theme === 'dark');
  for (const k in tk) de.style.setProperty(k, tk[k]);
}

// ---------------------------------------------------------------- textures
export const TEXTURES = [
  { id: 'auto', name: '跟隨主題' }, { id: 'none', name: '無' },
  { id: 'grain', name: '顆粒' }, { id: 'brushed', name: '髮絲紋' }, { id: 'wood', name: '木紋' }, { id: 'leather', name: '皮革' },
  { id: 'felt', name: '毛氈' }, { id: 'linen', name: '亞麻' }, { id: 'paper', name: '紙張' }, { id: 'carbon', name: '碳纖維' }, { id: 'crackle', name: '老漆龜裂' },
];
const TEX_KINDS = TEXTURES.map(x => x.id);
export function normTexture(t) {
  if (t === true) return { kind: 'grain', amount: 0.5 };
  if (t === false) return { kind: 'none', amount: 0.5 };
  if (!t || typeof t !== 'object' || !TEX_KINDS.includes(t.kind)) return { kind: 'auto', amount: 0.5 };
  const a = Number(t.amount);
  return { kind: t.kind, amount: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 0.5 };
}
const svg = inner => `<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256' viewBox='0 0 256 256'>${inner}</svg>`;
// One noise layer as a grey image centred on 50% so overlay blending lightens and darkens evenly.
const turb = (id, freq, oct, seed, type = 'fractalNoise') => `<feTurbulence type='${type}' baseFrequency='${freq}' numOctaves='${oct}' seed='${seed}' stitchTiles='stitch' result='${id}'/>`;
const grey = (src, c, a, out) => `<feColorMatrix in='${src}' values='${c} 0 0 0 ${(0.5 - c / 2).toFixed(3)} ${c} 0 0 0 ${(0.5 - c / 2).toFixed(3)} ${c} 0 0 0 ${(0.5 - c / 2).toFixed(3)} 0 0 0 0 ${a.toFixed(3)}' result='${out}'/>`;
const flt = body => `<filter id='f' x='0' y='0' width='100%' height='100%' color-interpolation-filters='sRGB'>${body}</filter><rect width='256' height='256' filter='url(#f)'/>`;
export function textureSvg(kind, amount) {
  const a = Math.min(1, Math.max(0, amount));
  switch (kind) {
    case 'grain': return svg(flt(turb('n', 0.85, 2, 3) + grey('n', 2.4, a * 0.26, 'o')));
    case 'brushed': return svg(flt(turb('n', '0.008 0.95', 3, 7) + grey('n', 2.6, a * 0.22, 'o')));
    // wood: low-frequency noise pushed through a rippled transfer curve gives growth-ring bands; a second noise bends them
    case 'wood': return svg(flt(turb('n', '0.005 0.06', 2, 11) + turb('w', '0.02 0.01', 2, 5) + `<feComposite in='n' in2='w' operator='arithmetic' k1='0' k2='0.8' k3='0.2' k4='0' result='m'/>` +
      `<feComponentTransfer in='m' result='r'><feFuncR type='table' tableValues='0 1 0 1 0 1 0 1 0 1 0 1'/></feComponentTransfer>` + grey('r', 1, a * 0.2, 'o') + `<feGaussianBlur in='o' stdDeviation='0.6'/>`));
    case 'leather': return svg(flt(turb('n', 0.07, 2, 9, 'turbulence') + grey('n', 3.2, a * 0.22, 'o')));
    case 'felt': return svg(flt(turb('n', 0.55, 3, 13) + turb('m', 0.03, 2, 4) + `<feComposite in='n' in2='m' operator='arithmetic' k1='0' k2='0.75' k3='0.25' k4='0' result='c'/>` + grey('c', 2, a * 0.24, 'o')));
    case 'linen': return svg(flt(turb('a', '0.9 0.03', 2, 2) + turb('b', '0.03 0.9', 2, 8) + `<feComposite in='a' in2='b' operator='arithmetic' k1='0' k2='0.5' k3='0.5' k4='0' result='c'/>` + grey('c', 3, a * 0.22, 'o')));
    case 'paper': return svg(flt(turb('a', 0.04, 5, 6) + turb('b', 0.95, 2, 1) + `<feComposite in='a' in2='b' operator='arithmetic' k1='0' k2='0.65' k3='0.35' k4='0' result='c'/>` + grey('c', 2.6, a * 0.22, 'o')));
    case 'carbon': return svg(`<defs><pattern id='p' width='8' height='8' patternUnits='userSpaceOnUse'>` +
      `<rect x='0' y='0' width='4' height='4' fill='#000' fill-opacity='${(a * 0.2).toFixed(3)}'/><rect x='4' y='4' width='4' height='4' fill='#000' fill-opacity='${(a * 0.2).toFixed(3)}'/>` +
      `<rect x='4' y='0' width='4' height='4' fill='#fff' fill-opacity='${(a * 0.12).toFixed(3)}'/><rect x='0' y='4' width='4' height='4' fill='#fff' fill-opacity='${(a * 0.12).toFixed(3)}'/></pattern></defs><rect width='256' height='256' fill='url(#p)'/>`);
    // old lacquer: ridged noise is near zero along thin veins; invert it so the veins become dark hairlines
    case 'crackle': return svg(flt(turb('n', 0.022, 1, 21, 'turbulence') + turb('w', 0.05, 2, 3) + `<feDisplacementMap in='n' in2='w' scale='8' xChannelSelector='R' yChannelSelector='G' result='d'/>` +
      `<feComponentTransfer in='d' result='t'><feFuncR type='linear' slope='-22' intercept='1.05'/></feComponentTransfer>` +
      `<feColorMatrix in='t' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${(a * 0.4).toFixed(3)} 0 0 0 0'/>`));
    default: return '';
  }
}
export const textureUri = (kind, amount) => { const s = textureSvg(kind, amount); return s ? `url("data:image/svg+xml,${encodeURIComponent(s)}")` : ''; };

function applyTexture(de, tex) {
  const t = normTexture(tex), uri = textureUri(t.kind, t.amount);
  de.classList.toggle('no-texture', t.kind === 'none');
  de.classList.toggle('tex-on', !!uri);
  if (uri) de.style.setProperty('--tex', uri); else de.style.removeProperty('--tex');
}

// ---------------------------------------------------------------- wallpaper
// panelAlpha / panelBlur frost the panels (backdrop blur in px); immersive hides the play page's side-panel fills.
// `ov` records which of these the user changed by hand, so picking a new wallpaper only resets the untouched ones.
export const WALL_FROST = { panelAlpha: 0.72, panelBlur: 16, immersive: true };
export const defaultWall = () => ({ src: '', fit: 'cover', dim: 0.35, blur: 0, ...WALL_FROST, ov: {} });
const clampN = (v, a, b, d) => Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d;
/** Fill in missing fields. Frost settings the user never touched (not in `ov`) always follow the frost defaults. */
export function normWall(w) {
  const o = w && typeof w === 'object' ? w : {};
  const r = { ...defaultWall(), ...o };
  if (!r.ov || typeof r.ov !== 'object') r.ov = {};
  for (const k in WALL_FROST) if (!r.ov[k]) r[k] = WALL_FROST[k];
  r.panelBlur = clampN(r.panelBlur, 0, 40, 16); r.panelAlpha = clampN(r.panelAlpha, 0.2, 1, 0.72); r.immersive = r.immersive !== false;
  return r;
}
const SAFE_FILE = /^[\w.\- ]{1,80}$/;
export function wallUrl(src) {
  if (typeof src !== 'string') return '';
  if (src.startsWith('builtin:')) { const f = src.slice(8); return SAFE_FILE.test(f) ? 'wall/' + encodeURIComponent(f) : ''; }
  if (src.startsWith('user:')) {
    const n = src.slice(5);
    if (!SAFE_FILE.test(n)) return '';
    return window.__fonoWallUrls?.[n] || '/api/wallpaper/' + encodeURIComponent(n);
  }
  return '';
}
function applyWall(de, wall) {
  const w = normWall(wall);
  const url = wallUrl(w.src);
  let layer = document.getElementById('wallLayer'), dim = document.getElementById('wallDim');
  if (!url) { layer?.remove(); dim?.remove(); de.classList.remove('has-wall', 'wall-glass', 'wall-immersive'); for (const k of ['--pa', '--pb', '--pa-bar']) de.style.removeProperty(k); return; }
  if (!layer) { layer = h('div', { id: 'wallLayer', 'aria-hidden': 'true' }); dim = h('div', { id: 'wallDim', 'aria-hidden': 'true' }); document.body.prepend(dim); document.body.prepend(layer); }
  layer.style.backgroundImage = `url("${url}")`;
  layer.dataset.fit = w.fit;
  const b = Math.max(0, Math.min(40, +w.blur || 0));
  layer.style.filter = b ? `blur(${b}px)` : '';
  layer.style.inset = b ? `${-b * 2}px` : '0';
  dim.style.opacity = String(Math.max(0, Math.min(0.95, +w.dim || 0)));
  de.classList.add('has-wall');
  const pa = w.panelAlpha;
  de.classList.toggle('wall-glass', pa < 0.999 || w.panelBlur > 0);
  de.classList.toggle('wall-immersive', w.immersive);
  de.style.setProperty('--pa', Math.round(pa * 100) + '%');
  de.style.setProperty('--pb', w.panelBlur + 'px');
  de.style.setProperty('--pa-bar', Math.round(Math.min(pa, 0.8) * 100) + '%');   // top bar, rail and strip are always a little see-through
}

/** Called at the end of the token section of applyLook(); app.js applies the single-accent override after this. */
export function applyLookExtras(S) {
  const de = document.documentElement, ui = S.ui;
  applyPalette(de, ui, S.theme === 'light' ? 'light' : 'dark');
  applyTexture(de, ui.texture);
  ui.wall = normWall(ui.wall);
  applyWall(de, ui.wall);
  redrawHooks.forEach(f => f());
}
const redrawHooks = new Set();

// ---------------------------------------------------------------- user wallpapers (API)
let builtinCache = null;
async function loadBuiltin() {
  if (builtinCache) return builtinCache;
  try {
    const r = await fetch('wall/index.json', { cache: 'no-store' });
    if (!r.ok) throw 0;
    const j = await r.json();
    builtinCache = Array.isArray(j) ? j.filter(x => x && SAFE_FILE.test(x.file || '')).map(x => ({ file: x.file, name: String((isEn() && x.name_en) || x.name || x.file), credit: String((isEn() && x.credit_en) || x.credit || '') })) : [];
  } catch { builtinCache = []; }
  return builtinCache;
}
async function loadUserWalls() {
  try { const r = await fetch('/api/wallpaper', { cache: 'no-store' }); if (!r.ok) throw 0; const j = await r.json(); return Array.isArray(j) ? j : []; } catch { return []; }
}

// ---------------------------------------------------------------- theme export / import
export function lookExport(S) {
  return { palette: structuredClone(S.ui.palette || { id: '' }), texture: normTexture(S.ui.texture), wall: normWall(S.ui.wall), ...playerExport(S.ui) };
}
/** Validate and apply the look part of an imported theme file. Returns true if something was ignored. */
export async function lookImport(d, S) {
  let ignored = false;
  if (d.palette && typeof d.palette === 'object') {
    const p = d.palette;
    if (p.id === 'custom') {
      const np = { id: 'custom' };
      for (const m of ['dark', 'light']) if (validColors(p[m])) np[m] = Object.fromEntries(['bg', 'panel', 'ink', 'accent', 'lamp'].map(k => [k, p[m][k].toLowerCase()]));
      S.ui.palette = np.dark || np.light ? np : { id: '' };
    } else S.ui.palette = { id: PALETTES.some(x => x.id === p.id) ? p.id : '' };
  }
  playerImport(d, S.ui);
  if ('texture' in d) S.ui.texture = normTexture(d.texture);
  if (d.wall && typeof d.wall === 'object') {
    const w = { ...defaultWall() }, x = d.wall, num = (v, a, b, def) => Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : def;
    if (['cover', 'tile', 'pixel'].includes(x.fit)) w.fit = x.fit;
    w.dim = num(x.dim, 0, 0.95, w.dim); w.blur = num(x.blur, 0, 40, 0); w.panelAlpha = num(x.panelAlpha, 0.2, 1, WALL_FROST.panelAlpha);
    w.panelBlur = num(x.panelBlur, 0, 40, WALL_FROST.panelBlur); w.immersive = x.immersive !== false; w.ov = { panelAlpha: 1, panelBlur: 1, immersive: 1 };
    const s = typeof x.src === 'string' ? x.src : '';
    if (s.startsWith('builtin:') && (await loadBuiltin()).some(b => 'builtin:' + b.file === s)) w.src = s;
    else if (s.startsWith('user:') && (await loadUserWalls()).some(u => 'user:' + u.name === s)) w.src = s;
    else if (s) { ignored = true; toast('桌布檔案不在這台電腦上，已略過桌布', true); }
    S.ui.wall = w;
  }
  return ignored;
}

// ---------------------------------------------------------------- settings UI
const sub = (title, hint) => h('div', { class: 'look-sub' }, h('b', {}, title), hint ? h('small', {}, hint) : null);
function range(label, o) {
  const out = h('output', {}, o.fmt(o.value));
  const inp = h('input', { type: 'range', class: 'rng', min: o.min, max: o.max, step: o.step, value: o.value, 'aria-label': label });
  inp.oninput = () => { out.textContent = o.fmt(+inp.value); o.onInput(+inp.value); };
  inp.onchange = () => o.onChange?.(+inp.value);
  const row = h('label', { class: 'rng-row' }, h('span', {}, label), inp, out);
  row.set = v => { inp.value = v; out.textContent = o.fmt(+v); };
  return row;
}

/** env = { S, apply(), save() } -- returns an array of elements to append inside the appearance panel. */
export function lookSections(env) {
  const { S } = env;
  S.ui.texture = normTexture(S.ui.texture);
  if (!S.ui.palette || typeof S.ui.palette !== 'object') S.ui.palette = { id: '' };
  S.ui.wall = normWall(S.ui.wall);
  const themeKey = () => S.theme === 'light' ? 'light' : 'dark';

  // ---- 配色
  const palGrid = h('div', { class: 'skin-grid pal-grid' });
  const editor = h('div', { class: 'pal-editor' });
  const FIELDS = [['bg', '背景'], ['panel', '面板'], ['ink', '文字'], ['accent', '強調色'], ['lamp', '表燈']];
  const warn = h('div', { class: 'pal-warn' });
  const inputs = {};
  for (const [k, label] of FIELDS) {
    const inp = h('input', { type: 'color', value: '#808080', 'aria-label': label });
    inp.oninput = () => { const c = S.ui.palette[themeKey()]; if (c) { c[k] = inp.value; env.apply(); checkContrast(); } };
    inp.onchange = () => env.save();
    inputs[k] = inp;
    editor.append(h('label', { class: 'pal-field' }, inp, h('span', {}, label)));
  }
  editor.append(warn);
  const checkContrast = () => {
    const c = paletteColors(S.ui.palette, themeKey()); if (!c) return;
    const r = contrast(c.ink, c.panel);
    warn.className = 'pal-warn' + (r < 4.5 ? ' bad' : '');
    warn.textContent = r < 4.5 ? `文字與面板對比 ${r.toFixed(1)}:1，低於 4.5:1，小字可能難以閱讀。` : `文字與面板對比 ${r.toFixed(1)}:1`;
  };
  const syncEditor = () => {
    const isCustom = S.ui.palette.id === 'custom';
    editor.style.display = isCustom ? '' : 'none';
    if (!isCustom) return;
    const c = paletteColors(S.ui.palette, themeKey());
    if (c) for (const [k] of FIELDS) inputs[k].value = c[k];
    checkContrast();
  };
  const customStart = () => {
    const cs = getComputedStyle(document.documentElement), g = n => { const v = cs.getPropertyValue(n).trim(); return HEX.test(v) ? v : null; };
    const cur = paletteColors(S.ui.palette, themeKey()) || { bg: g('--bg') || '#191715', panel: g('--panel') || '#29251f', ink: g('--ink') || '#ece2d2', accent: g('--accent') || '#c2a47e', lamp: g('--accent') || '#c2a47e' };
    const dark = themeKey() === 'dark';
    return { id: 'custom', [themeKey()]: { ...cur }, [dark ? 'light' : 'dark']: dark ? toLight(cur) : toDark(cur) };
  };
  let palTheme = null;
  const drawPal = () => {
    palTheme = S.theme; palGrid.innerHTML = '';
    const card = (id, name, desc, cols) => {
      const b = h('button', { class: 'skin-card' + ((S.ui.palette.id || '') === id ? ' on' : ''), type: 'button' },
        h('div', { class: 'sw' }, cols ? [h('i', { style: `background:${cols.bg}` }), h('span', { style: `background:${cols.panel}` }, h('b', { style: `background:${cols.accent}` }), h('em', { style: `background:${cols.lamp}` }))] : [h('i', { style: 'background:var(--bg-2)' }), h('span', { style: 'background:var(--panel-2)' }, h('b', { style: 'background:var(--accent)' }))]),
        h('b', {}, name), h('small', {}, desc));
      b.onclick = () => {
        S.ui.palette = id === 'custom' ? (S.ui.palette.id === 'custom' ? S.ui.palette : customStart()) : { id };
        env.apply(); env.save(); drawPal(); syncEditor();
      };
      palGrid.append(b);
    };
    card('', '跟隨主題', '用外觀樣式的顏色', null);
    for (const p of PALETTES) card(p.id, p.name, '', p[themeKey()]);
    card('custom', '自訂', '自己選五個顏色', paletteColors(S.ui.palette, themeKey()) || { bg: '#2a2a2a', panel: '#3a3a3a', accent: '#aaa', lamp: '#ccc' });
  };

  // ---- 材質
  const texGrid = h('div', { class: 'tex-grid' });
  const drawTex = () => {
    texGrid.innerHTML = '';
    for (const t of TEXTURES) {
      const prev = h('i', { class: 'tex-prev' + (t.id === 'auto' || t.id === 'none' ? ' blank' : '') });
      if (t.id !== 'auto' && t.id !== 'none') prev.style.backgroundImage = textureUri(t.id, 1);
      const b = h('button', { class: 'tex-card' + (S.ui.texture.kind === t.id ? ' on' : ''), type: 'button', title: t.name }, prev, h('span', {}, t.name));
      b.onclick = () => { S.ui.texture = { kind: t.id, amount: S.ui.texture.amount }; env.apply(); env.save(); drawTex(); };
      texGrid.append(b);
    }
  };
  const amt = range('強度', { min: 0, max: 1, step: 0.05, value: S.ui.texture.amount, fmt: v => Math.round(v * 100) + '%', onInput: v => { S.ui.texture.amount = v; env.apply(); }, onChange: () => { env.save(); drawTex(); } });

  // ---- 桌布
  const wallGrid = h('div', { class: 'wall-grid' });
  const credit = h('div', { class: 'hint', style: 'margin-top:6px' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: 'display:none' });
  const up = h('button', { class: 'btn', type: 'button' }, '上傳桌布');
  up.onclick = () => file.click();
  let builtin = [], user = [];
  const setWall = src => {
    const W0 = S.ui.wall, fresh = src && src !== W0.src;
    W0.src = src;
    if (fresh) for (const k in WALL_FROST) if (!W0.ov[k]) W0[k] = WALL_FROST[k];   // a new pick starts frosted; hand-set values stay
    syncSliders(); env.apply(); env.save(); drawWall(); drawPrev();
  };
  const drawWall = () => {
    wallGrid.innerHTML = '';
    const th = (src, name, url, onDel, own = false) => {
      const b = h('div', { class: 'wall-th' + ((S.ui.wall.src || '') === src ? ' on' : '') },
        h('button', { type: 'button', title: name, class: 'wall-pick', style: url ? `background-image:url("${url}")` : '', ...(own ? { 'data-i18n-skip': '' } : {}) }, url ? null : h('span', {}, '無')),
        h('small', own ? { 'data-i18n-skip': '' } : {}, name));
      b.querySelector('button').onclick = () => setWall(src);
      if (onDel) { const d = h('button', { type: 'button', class: 'wall-del', 'data-i18n-skip': '', title: t('刪除'), 'aria-label': t('刪除') + ' ' + name }, '×'); d.onclick = e => { e.stopPropagation(); onDel(); }; b.append(d); }
      wallGrid.append(b);
    };
    th('', '無桌布', '', null);
    for (const w of builtin) th('builtin:' + w.file, w.name, wallUrl('builtin:' + w.file), null);
    for (const u of user) th('user:' + u.name, u.name, wallUrl('user:' + u.name), async () => {
      if (!confirm('刪除桌布「' + u.name + '」？')) return;
      try { const r = await fetch('/api/wallpaper/' + encodeURIComponent(u.name), { method: 'DELETE' }); if (!r.ok) throw 0; } catch { toast('刪除失敗', true); return; }
      user = user.filter(x => x.name !== u.name);
      if (S.ui.wall.src === 'user:' + u.name) { S.ui.wall.src = ''; env.apply(); env.save(); }
      drawWall();
    }, true);
    const cur = builtin.find(w => 'builtin:' + w.file === S.ui.wall.src);
    credit.textContent = cur?.credit ? '出處：' + cur.credit : (builtin.length ? '' : '尚無內建桌布，可以上傳自己的圖片。');
  };
  file.onchange = async () => {
    const f = file.files[0]; file.value = ''; if (!f) return;
    if (f.size > 8 << 20) { toast('圖片超過 8 MB', true); return; }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { toast('只支援 PNG、JPEG、WebP、GIF', true); return; }
    const fd = new FormData(); fd.append('file', f, f.name);
    try {
      const r = await fetch('/api/wallpaper', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.name) throw new Error(j.detail || '');
      user = await loadUserWalls(); setWall('user:' + j.name); toast('已加入桌布');
    } catch (e) { toast('上傳失敗' + (e.message ? '：' + e.message : ''), true); }
  };
  Promise.all([loadBuiltin(), loadUserWalls()]).then(([b, u]) => { builtin = b; user = u; drawWall(); });
  const W = () => S.ui.wall;
  // live preview: the same wallpaper, dim, blur, frost and immersive setting on a miniature play page
  const prev = h('div', { class: 'wall-prev' },
    h('div', { class: 'wp-bg' }), h('div', { class: 'wp-dim' }),
    h('div', { class: 'wp-ui' }, h('div', { class: 'wp-top' }, h('i'), h('i'), h('i')), h('div', { class: 'wp-rail' }, h('i'), h('i'), h('i'), h('i')),
      h('div', { class: 'wp-main' }, h('div', { class: 'wp-stage' }, h('div', { class: 'wp-rec' }, h('i')), h('s', {}, '')),
        h('div', { class: 'wp-side' }, ...[0, 1, 2].map(() => h('b', {}, h('i'), h('i'), h('i')))))),
    h('div', { class: 'wp-none' }, '選一張桌布，這裡會預覽播放頁的樣子'));
  const drawPrev = () => {
    const w = W(), url = wallUrl(w.src), bg = prev.querySelector('.wp-bg');
    prev.classList.toggle('none', !url); prev.classList.toggle('imm', !!url && w.immersive);
    if (!url) return;
    bg.style.backgroundImage = `url("${url}")`; bg.dataset.fit = w.fit;
    bg.style.filter = w.blur ? `blur(${(w.blur * 0.4).toFixed(1)}px)` : ''; bg.style.inset = w.blur ? `${-w.blur}px` : '0';
    prev.querySelector('.wp-dim').style.opacity = String(Math.min(0.95, +w.dim || 0));
    prev.style.setProperty('--pa', Math.round(w.panelAlpha * 100) + '%');
    prev.style.setProperty('--pb', (w.panelBlur * 0.4).toFixed(1) + 'px');
    prev.style.setProperty('--pa-bar', Math.round(Math.min(w.panelAlpha, 0.8) * 100) + '%');
  };
  const sliders = {};
  const syncSliders = () => { for (const k in sliders) sliders[k].set(W()[k]); imm.set(W().immersive); };
  const imm = toggle({ label: '沉浸播放', sub: '播放頁的面板不填色，唱盤與卡座直接放在桌布上', value: W().immersive, onInput: v => { W().immersive = v; W().ov.immersive = 1; env.apply(); env.save(); drawPrev(); } });
  const fitK = keys({ options: [{ id: 'cover', label: '填滿' }, { id: 'tile', label: '平鋪' }, { id: 'pixel', label: '像素' }], value: W().fit || 'cover', onInput: v => { W().fit = v; env.apply(); env.save(); drawPrev(); } });
  const sl = (label, key, min, max, step, fmt) => {
    const r = range(label, { min, max, step, value: W()[key], fmt, onInput: v => { W()[key] = v; if (key in WALL_FROST) W().ov[key] = 1; env.apply(); drawPrev(); }, onChange: () => env.save() });
    sliders[key] = r; return r;
  };

  drawPal(); syncEditor(); drawTex(); drawWall(); drawPrev();
  redrawHooks.clear();
  redrawHooks.add(() => { if (palTheme !== S.theme) { drawPal(); syncEditor(); } });

  return [
    sub('配色', '覆蓋外觀樣式的顏色；材質與形狀仍依樣式。'), palGrid, editor,
    sub('材質', '面板、側欄與頂欄的表面紋理。'), texGrid, amt,
    sub('桌布', '放在最底層；選了桌布後面板會自動變成毛玻璃，播放頁的唱盤直接放在桌布上。'), wallGrid, credit,
    h('div', { class: 'accent-row' }, up, file, h('span', { class: 'hint', style: 'margin:0' }, 'PNG／JPEG／WebP／GIF，8 MB 以內'), h('div', { class: 'field', style: 'margin-left:auto' }, fitK.el)),
    h('div', { class: 'look-sliders' }, sl('壓暗', 'dim', 0, 0.9, 0.05, v => Math.round(v * 100) + '%'), sl('模糊', 'blur', 0, 24, 1, v => v + ' px'), sl('面板透明度', 'panelAlpha', 0.3, 1, 0.05, v => Math.round(v * 100) + '%'), sl('面板霧化', 'panelBlur', 0, 32, 1, v => v + ' px')),
    h('div', { style: 'margin-top:12px' }, imm.el), prev,
  ];
}
