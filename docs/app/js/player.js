// Player page: turntable, cassette deck, analogue / LED / nixie meters and their appearance pickers.
// app.js builds the page with createPlayer() and forwards media state (update), animation frames (frame) and meter levels (meters).
import { h, keys } from './widgets.js';

// ---------------------------------------------------------------- options + state validation
export const METER_STYLES = [{ id: 'needle', name: '指針' }, { id: 'led', name: 'LED 光柱' }, { id: 'nixie', name: '輝光管' }];
export const VINYL_COLORS = [
  { id: 'black', name: '黑膠黑' }, { id: 'red', name: '紅' }, { id: 'blue', name: '藍' }, { id: 'green', name: '綠' }, { id: 'yellow', name: '黃' },
  { id: 'clear', name: '透明' }, { id: 'marble', name: '大理石' }, { id: 'splatter', name: '潑墨' }, { id: 'picture', name: '圖案盤' }, { id: 'auto', name: '依封面' },
];
export const DECKS = [{ id: 'wood', name: '木紋' }, { id: 'silver', name: '銀色直驅' }, { id: 'acrylic', name: '透明壓克力' }, { id: 'white', name: '極簡白' }];
export const SHELLS = [{ id: 'clear', name: '透明' }, { id: 'black', name: '黑色' }, { id: 'white', name: '白色' }, { id: 'auto', name: '依封面' }];
const has = (list, id) => list.some(x => x.id === id);

/** Make S.ui.meter / vinyl / cassette / lid valid (called on load, on import and by the pickers). */
export function normPlayerUi(ui) {
  if (!has(METER_STYLES, ui.meter)) ui.meter = 'needle';
  const v = ui.vinyl && typeof ui.vinyl === 'object' ? ui.vinyl : {};
  ui.vinyl = { color: has(VINYL_COLORS, v.color) ? v.color : 'black', deck: has(DECKS, v.deck) ? v.deck : 'wood' };
  const c = ui.cassette && typeof ui.cassette === 'object' ? ui.cassette : {};
  ui.cassette = { shell: has(SHELLS, c.shell) ? c.shell : 'clear' };
  ui.lid = ui.lid !== false;
  return ui;
}
export function playerExport(ui) {
  normPlayerUi(ui);
  return { meter: ui.meter, vinyl: { ...ui.vinyl }, cassette: { ...ui.cassette }, lid: ui.lid };
}
/** Apply the player part of an imported theme; anything invalid falls back to the default. */
export function playerImport(d, ui) {
  if ('meter' in d) ui.meter = d.meter;
  if (d.vinyl && typeof d.vinyl === 'object') ui.vinyl = { ...ui.vinyl, ...d.vinyl };
  if (d.cassette && typeof d.cassette === 'object') ui.cassette = { ...ui.cassette, ...d.cassette };
  if ('lid' in d) ui.lid = d.lid !== false;
  normPlayerUi(ui);
}

// ---------------------------------------------------------------- small helpers
const reduceMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const reduced = () => reduceMq.matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hash = str => { let x = 2166136261; for (const c of String(str)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
const rng = seed => () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hex2 = n => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

function rgb2hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let hh = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
  }
  return [hh, s, l];
}
const hsl = (hh, s, l) => `hsl(${hh.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

// Dominant colour of the cover, from a 16x16 canvas sample, tamed to a matte, low-saturation tone.
const colCache = new Map();
export function artColor(url) {
  if (!url) return Promise.resolve(null);
  if (colCache.has(url)) return colCache.get(url);
  const p = new Promise(res => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 16;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        let R = 0, G = 0, B = 0, W = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [, s, l] = rgb2hsl([d[i], d[i + 1], d[i + 2]]);
          const w = 0.05 + s * (1 - Math.abs(2 * l - 1)) ** 0.7;
          R += d[i] * w; G += d[i + 1] * w; B += d[i + 2] * w; W += w;
        }
        const [hh, s, l] = rgb2hsl([R / W, G / W, B / W]);
        res({ h: hh, s: Math.min(s, 0.42), l: clamp(l, 0.3, 0.5) });
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
  colCache.set(url, p);
  return p;
}

// ---------------------------------------------------------------- vinyl looks (flat fills only; grooves are drawn by CSS as thin lines)
const SOLID = { red: '#a44f45', blue: '#4a6f94', green: '#52806a', yellow: '#b9a04c' };
const MARBLE = [['#38494c', '#d3cbb6', '#93604a', '#6f8d8f'], ['#3b425d', '#cfccc4', '#7f92a3', '#907ea3'], ['#4c3d3a', '#dbd0bb', '#9d7d55', '#80695f']];
const SPLAT = [['#d3ccb8', '#2a2623', '#a44f45', '#4a6f94'], ['#8d4e47', '#e6dcc8', '#2a2623', '#c6a85e'], ['#436584', '#e9e3d3', '#c6a85e', '#2a2623']];
const uri = svg => `url("data:image/svg+xml,${encodeURIComponent(svg)}") center/100% 100%`;

function splatterUri(title) {
  const r = rng(hash(title || 'fono')), pal = SPLAT[hash(title || '') % SPLAT.length];
  let s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect width='200' height='200' fill='${pal[0]}'/>`;
  for (let i = 0; i < 34; i++) {
    const a = r() * 6.283, d = Math.sqrt(r()) * 100, x = 100 + Math.cos(a) * d, y = 100 + Math.sin(a) * d;
    s += `<circle cx='${x.toFixed(1)}' cy='${y.toFixed(1)}' r='${(1 + r() ** 2.2 * 7).toFixed(1)}' fill='${pal[1 + Math.floor(r() * 3)]}'/>`;
  }
  return uri(s + '</svg>');
}
function marbleUri(title) {
  const r = rng(hash(title || 'marble')), m = MARBLE[hash(title || 'marble') % MARBLE.length];
  let s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><rect width='200' height='200' fill='${m[0]}'/>`;
  [1, 2, 3].forEach(i => {
    const cx = 40 + r() * 120, cy = 40 + r() * 120, rx = 34 + r() * 40, ry = 18 + r() * 26, rot = Math.floor(r() * 180);
    s += `<ellipse cx='${cx.toFixed(0)}' cy='${cy.toFixed(0)}' rx='${rx.toFixed(0)}' ry='${ry.toFixed(0)}' fill='${m[i]}' transform='rotate(${rot} ${cx.toFixed(0)} ${cy.toFixed(0)})'/>`;
  });
  return uri(s + '</svg>');
}

/** { bg, tr, pic } for the record body layer. tr = translucent (platter shows through). */
export function vinylLook(color, o = {}) {
  switch (color) {
    case 'red': case 'blue': case 'green': case 'yellow': return { bg: SOLID[color], tr: false };
    case 'clear': return { bg: 'color-mix(in srgb, #cfd6da 40%, transparent)', tr: true };
    case 'marble': return { bg: marbleUri(o.title), tr: false };
    case 'splatter': return { bg: splatterUri(o.title), tr: false };
    case 'picture': return o.url ? { bg: `url("${o.url}") center/cover`, tr: false, pic: true } : vinylLook('black');
    case 'auto': return o.auto ? { bg: hsl(o.auto.h, o.auto.s, o.auto.l), tr: false } : vinylLook('black');
    default: return { bg: 'var(--vinyl)', tr: false };
  }
}

// ---------------------------------------------------------------- meters
const VU_DB = [-20, -10, -5, 0, 3];
const VU_MAP = [[-60, -50], [-20, -32], [-10, -13], [-5, 9], [0, 32], [3, 50]]; // dB -> needle angle, like a printed VU dial
export const vuAngle = db => { db = clamp(db, -60, 3); for (let i = 1; i < VU_MAP.length; i++) { const [d0, a0] = VU_MAP[i - 1], [d1, a1] = VU_MAP[i]; if (db <= d1) return a0 + (db - d0) / (d1 - d0) * (a1 - a0); } return 50; };
const LED_MAP = [[-60, 0], [-40, 0.18], [-20, 0.46], [-10, 0.68], [-3, 0.9], [0, 1]];
const ledPos = db => { db = clamp(db, -60, 0); for (let i = 1; i < LED_MAP.length; i++) { const [d0, p0] = LED_MAP[i - 1], [d1, p1] = LED_MAP[i]; if (db <= d1) return p0 + (db - d0) / (d1 - d0) * (p1 - p0); } return 1; };
const LED_SEGS = 32;

function vuSvg(name) {
  const pt = (a, r) => { const t = (a - 90) * Math.PI / 180; return [50 + r * Math.cos(t), 62 + r * Math.sin(t)]; };
  const f = n => n.toFixed(2);
  const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `M${f(x0)} ${f(y0)} A${r} ${r} 0 0 1 ${f(x1)} ${f(y1)}`; };
  let minor = '', major = '', nums = '';
  for (const db of [-40, -30, -15, -7, -3, -2, -1, 1, 2]) { const a = vuAngle(db), [x1, y1] = pt(a, 44), [x2, y2] = pt(a, 41); minor += `<line class="vu-tick minor" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`; }
  for (const db of VU_DB) {
    const a = vuAngle(db), [x1, y1] = pt(a, 44.5), [x2, y2] = pt(a, 38), [nx, ny] = pt(a, 32);
    major += `<line class="vu-tick" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>`;
    nums += `<text class="vu-num${db >= 0 ? ' hot' : ''}" x="${f(nx)}" y="${f(ny + 2.2)}" text-anchor="middle">${db > 0 ? '+' + db : db}</text>`;
  }
  return `<svg viewBox="0 0 100 64" preserveAspectRatio="none"><rect class="vu-face" width="100" height="64"/>
    <path class="vu-red" d="${arc(vuAngle(-3), vuAngle(3), 41.5)}"/><path class="vu-scale" d="${arc(vuAngle(-60), vuAngle(3), 44)}"/>
    ${minor}${major}${nums}<text class="vu-vu" x="50" y="47" text-anchor="middle">VU</text>
    <text class="vu-name" x="7" y="53">${name}</text><text class="vu-unit" x="93" y="53" text-anchor="end">dBFS</text>
    <line class="vu-needle" x1="50" y1="62" x2="50" y2="14"/><circle class="vu-hub" cx="50" cy="62" r="3.4"/>
    <circle class="vu-peak" cx="91" cy="9" r="2.3"/></svg>`;
}

// Flat seven-segment digits for the nixie style (segments a-g on an 8 x 15 cell).
const SEG = {
  a: [1.5, 0, 5, 1.7], b: [6.3, 1.5, 1.7, 5.2], c: [6.3, 8.3, 1.7, 5.2], d: [1.5, 13.3, 5, 1.7], e: [0, 8.3, 1.7, 5.2], f: [0, 1.5, 1.7, 5.2], g: [1.5, 6.65, 5, 1.7],
};
const DIGIT_SEGS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g' };
const segRect = k => { const [x, y, w, hh] = SEG[k]; return `x="${x}" y="${y}" width="${w}" height="${hh}" rx=".5"`; };
const NX_CELLS = [3, 16, 29, 47]; // sign, tens, ones, tenth (the dot sits at x=42)
function nixieSvg(name) {
  let cells = '';
  NX_CELLS.forEach((x, i) => {
    cells += `<g transform="translate(${x} 5)" data-i="${i}">`;
    for (const k of i === 0 ? 'g' : 'abcdefg') cells += `<rect class="nx-seg" data-s="${k}" ${segRect(k)}/>`;
    cells += '</g>';
  });
  return `<svg viewBox="0 0 62 30"><rect class="nx-face" width="62" height="30"/>${cells}<circle class="nx-dot" cx="43.5" cy="19.4" r="1.2"/>
    <text class="nx-name" x="2" y="28">${name}</text><text class="nx-unit" x="60" y="28" text-anchor="end">dBFS</text></svg>`;
}

/**
 * A group of meters drawn inside `host`. draw() takes smoothed dB per channel (needle ballistics) and raw dB (for peaks).
 * Rebuilds itself when the style or channel set changes.
 */
export function createMeterBank(host) {
  let key = '', cells = [], style = 'needle';
  const bank = { host };
  function build(st, names, used, big) {
    style = st; host.innerHTML = ''; cells = [];
    host.dataset.ms = st;
    if (st === 'led') {
      host.style.gridTemplateColumns = '1fr';
      const scale = h('div', { class: 'led-scale' }), chs = h('div', { class: 'led-chs' });
      for (const db of [0, -6, -12, -20, -30, -40, -60]) scale.append(h('span', { style: `bottom:${(ledPos(db) * 100).toFixed(1)}%` }, String(db)));
      names.forEach((nm, i) => {
        const on = h('i', { class: 'led-on' }), pk = h('i', { class: 'led-pk' });
        const tube = h('div', { class: 'led-tube' }, h('i', { class: 'led-off' }), on, pk);
        chs.append(h('div', { class: 'led-ch' + (names.length > 2 && !used.has(nm) ? ' idle' : '') }, tube, h('small', {}, nm)));
        cells.push({ on, pk, tube, hold: 0, holdAt: 0, over: false });
      });
      const lb = h('div', { class: 'led-bank' }, scale, chs);
      host.append(lb); cells.forEach(c => { c.el = lb; c.sg = -1; });
    } else {
      const cols = st === 'nixie' ? Math.min(names.length, 2) : Math.min(names.length, big ? 2 : 4);
      host.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      names.forEach((nm, i) => {
        const idle = names.length > 2 && !used.has(nm) ? ' idle' : '';
        const d = h('div', { class: 'vu-m' + (st === 'nixie' ? ' nx' : '') + idle });
        d.innerHTML = `<div class="vu-win">${st === 'nixie' ? nixieSvg(nm) : vuSvg(nm)}</div>`;
        host.append(d);
        if (st === 'nixie') cells.push({ el: d, sg: -1, g: [...d.querySelectorAll('g[data-i]')].map(g => ({ g, k: [...g.querySelectorAll('.nx-seg')], cur: '' })), dot: d.querySelector('.nx-dot'), last: '' });
        else cells.push({ el: d, sg: -1, needle: d.querySelector('.vu-needle'), led: d.querySelector('.vu-peak'), until: 0, lit: false });
      });
    }
  }
  bank.draw = ({ style: st, names, used = new Set(), smooth, raw, now = performance.now(), big = false }) => {
    const k = st + '|' + names.join(',') + '|' + big + '|' + [...used].join(',');
    if (k !== key) { key = k; build(st, names, used, big); }
    cells.forEach((c, i) => {
      const db = smooth[i] ?? -60, r = raw[i] ?? -60;
      const sg = clamp((db + 50) / 50, 0, 1);   // signal level 0..1 drives the lamp glow around the face
      if (Math.abs(sg - c.sg) > 0.03) { c.sg = sg; c.el.style.setProperty('--sig', sg.toFixed(2)); }
      if (style === 'needle') {
        const a = vuAngle(db).toFixed(2);
        c.needle.style.transform = `rotate(${a}deg)`;
        if (r > 0) c.until = now + 800;
        const lit = now < c.until; if (lit !== c.lit) { c.lit = lit; c.led.classList.toggle('on', lit); }
      } else if (style === 'led') {
        const p = ledPos(Math.max(db, r > db ? r : db));
        c.on.style.clipPath = `inset(${((1 - p) * 100).toFixed(1)}% 0 0 0)`;
        if (p >= c.hold || now - c.holdAt > 1400) { if (p >= c.hold) { c.hold = p; c.holdAt = now; } else c.hold = Math.max(p, c.hold - 0.012); }
        const seg = Math.min(LED_SEGS - 1, Math.floor(c.hold * LED_SEGS));
        c.pk.style.bottom = (seg / LED_SEGS * 100).toFixed(2) + '%'; c.pk.style.opacity = c.hold > 0.02 ? '1' : '0';
        const over = r > -1; if (over !== c.over) { c.over = over; c.tube.classList.toggle('hot', over); }
      } else {
        const v = clamp(db, -60, 3), str = (v < 0 ? '-' : ' ') + String(Math.floor(Math.abs(v))).padStart(2, ' ') + String(Math.floor((Math.abs(v) % 1) * 10));
        if (str === c.last) return;
        c.last = str;
        const chars = [str[0], str[1], str[2], str[3]];
        c.g.forEach((cell, j) => {
          const want = chars[j] === ' ' ? '' : chars[j] === '-' && j === 0 ? '-' : chars[j];
          if (want === cell.cur) return;
          cell.cur = want;
          const on = DIGIT_SEGS[want] || ''; cell.k.forEach(p => p.classList.toggle('on', on.includes(p.dataset.s)));
        });
      }
    });
  };
  return bank;
}

// ---------------------------------------------------------------- icons for the cassette keys
const KI = {
  rew: '<path d="M11 6v12l-8-6zM21 6v12l-8-6z"/>', play: '<path d="M7 5v14l12-7z"/>', ff: '<path d="M3 6v12l8-6zM13 6v12l8-6z"/>',
  stop: '<path d="M12 4.5l7 8H5zM5 15.5h14v3.2H5z"/>', pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
};

// ---------------------------------------------------------------- turntable geometry (scene is 660 x 410 px)
const SW = 660, SH = 410, PC = [372, 205], PIV = [626, 62], ARM_L = 258, R_OUT = 154, R_IN = 70, REC_R = 165;
const stylus = deg => { const a = deg * Math.PI / 180; return [PIV[0] - ARM_L * Math.sin(a), PIV[1] + ARM_L * Math.cos(a)]; };
const armDist = deg => { const [x, y] = stylus(deg); return Math.hypot(x - PC[0], y - PC[1]); };
function armAngleFor(r) { let lo = 0, hi = 58; for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (armDist(m) > r) lo = m; else hi = m; } return (lo + hi) / 2; }
const ARM_REST = 1.5, ARM_OUT = armAngleFor(R_OUT + 4), ARM_IN = armAngleFor(R_IN);
const armTo = t => lerp(armAngleFor(R_OUT), ARM_IN, clamp(t, 0, 1));

// Tonearm as plain stroke geometry: counterweight, pivot, tube, small rect headshell. Colours come from CSS (--arm, --pl-key, --pl-edge).
const ARM_SVG = `<svg viewBox="-60 -60 120 340" width="120" height="340" style="left:-60px;top:-60px">
  <g class="arm-art">
    <rect class="arm-fill" x="-8" y="-50" width="16" height="36" rx="2"/><rect class="arm-fill" x="-10" y="-56" width="20" height="14" rx="2"/>
    <path class="arm-tube" d="M0 0V ${ARM_L - 34}"/>
    <circle class="arm-base" r="20"/><circle class="arm-ring" r="11"/><circle class="arm-cap" r="3.6"/>
    <g transform="translate(0 ${ARM_L - 34}) rotate(14)"><path class="arm-tube thin" d="M0 0V8"/><rect class="arm-head" x="-7" y="6" width="14" height="24" rx="1.5"/><path class="arm-stylus" d="M0 30v6"/><path class="arm-tube thin" d="M7 4l11 -5"/></g>
  </g></svg>`;

const dropIcon = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">';
const CAS_W = 468, CAS_H = 292;

/**
 * Builds the player stage. env = { S, cmd(name), playing() }.
 * Returns { stage, keysEl, update(info), frame(info), meters(info), applyUi() }.
 */
export function createPlayer(env) {
  const S = env.S;
  const el = {};

  // ---- turntable scene
  const sleeve = h('div', { class: 'pl-sleeve' });
  const mkLabel = () => h('div', { class: 'pl-label' }, h('i'));
  const label = mkLabel();
  const recBody = h('div', { class: 'pl-rec-body' });
  const recSpin = h('div', { class: 'pl-rec-spin' }, recBody, h('div', { class: 'pl-rec-grooves' }), label);
  const rec = h('div', { class: 'pl-record away' }, recSpin);
  const platter = h('div', { class: 'pl-platter' }, h('div', { class: 'pl-mat' }));
  const spindle = h('div', { class: 'pl-spindle' });
  const speedBtn = (v, t) => h('button', { type: 'button', class: 'key' + (v === 33 ? ' on' : ''), 'aria-label': t + ' RPM' }, t);
  const b33 = speedBtn(33, '33'), b45 = speedBtn(45, '45');
  const rpmTxt = h('span', { class: 'pl-rpm' }, '33⅓ RPM');
  const pitchOut = h('output', {}, '±0.0%');
  const pitch = h('input', { type: 'range', class: 'pl-pitch', min: -8, max: 8, step: 0.1, value: 0, 'aria-label': '音高微調' });
  const plinth = h('div', { class: 'pl-plinth' }, h('div', { class: 'pl-plinth-tex' }), h('div', { class: 'pl-motor' }), platter,
    h('div', { class: 'pl-ctl' }, h('div', { class: 'keys' }, b33, b45), rpmTxt), h('div', { class: 'pl-pitchbox' }, pitch, pitchOut));
  const armInner = h('div', { class: 'pl-arm-in', html: ARM_SVG });
  const arm = h('div', { class: 'pl-arm' }, armInner);
  const armRest = h('div', { class: 'pl-armrest' });
  const lid = h('div', { class: 'pl-lid' }, h('i', { class: 'pl-lid-hinge' }));
  const deckScene = h('div', { class: 'pl-deck' }, plinth, sleeve, rec, spindle, armRest, arm, lid);

  // ---- cassette scene
  const jArt = h('div', { class: 'pl-jart' });
  const jTitle = h('b'), jArtist = h('span'), jAlbum = h('small');
  const jcard = h('div', { class: 'pl-jcard' }, jArt, h('div', { class: 'pl-jtext' }, h('em', {}, 'SIDE A'), jTitle, jArtist, jAlbum), h('i', { class: 'pl-jband' }));
  const spokes = [0, 120, 240].map(a => `<line class="spoke" x1="0" y1="-4.2" x2="0" y2="-11.6" transform="rotate(${a})"/>`).join('');
  const winSvg = h('div', { class: 'pl-cwin', html: `<svg viewBox="0 0 300 82">
    <circle class="pk-l pack" cx="88" cy="38" r="22"/><circle class="pk-r pack" cx="212" cy="38" r="22"/>
    <path class="tape" d=""/><path class="tape-hi" d=""/>
    <circle class="guide" cx="112" cy="76" r="3.2"/><circle class="guide" cx="188" cy="76" r="3.2"/>
    ${['l', 'r'].map(s => `<g class="hub-${s}" transform="translate(${s === 'l' ? 88 : 212} 38)"><circle class="hub" r="12.5"/>${spokes}<circle class="hub-c" r="3"/></g>`).join('')}
    </svg>` });
  const shell = h('div', { class: 'pl-shell' }, jcard, winSvg, h('div', { class: 'pl-lip' }, h('i'), h('i'), h('i'), h('i')));
  const cas = h('div', { class: 'pl-cass out' }, shell);
  const door = h('div', { class: 'pl-door open' });
  const digits = [0, 1, 2].map(() => h('span', {}, '0'));
  const counter = h('div', { class: 'pl-counter' }, h('small', {}, 'COUNTER'), h('div', { class: 'pl-drums' }, ...digits));
  const casScene = h('div', { class: 'pl-casdeck' }, h('div', { class: 'pl-faceplate' }, h('div', { class: 'pl-well' }, cas, door)),
    h('div', { class: 'pl-casbar' }, h('span', { class: 'pl-engrave' }, 'TAPE  TYPE I / NORM'), counter));

  const scene = h('div', { class: 'pl-scene' }, deckScene, casScene);
  const stage = scene;

  // ---- piano keys (cassette transport)
  const mkKey = (id, label, svg) => h('button', { type: 'button', class: 'key pk pk-' + id, 'aria-label': label }, h('span', { class: 'pk-i', html: `<svg viewBox="0 0 24 24">${KI[svg]}</svg>` }), h('small', {}, label));
  const K = { rew: mkKey('rew', 'REW', 'rew'), play: mkKey('play', 'PLAY', 'play'), ff: mkKey('ff', 'FF', 'ff'), stop: mkKey('stop', 'STOP/EJECT', 'stop'), pause: mkKey('pause', 'PAUSE', 'pause') };
  const keysEl = h('div', { class: 'keys pl-pkeys', role: 'group', 'aria-label': '卡座按鍵' }, K.rew, K.play, K.ff, K.stop, K.pause);

  // ---- state
  let cur = { has: false, albumKey: '', trackKey: '', playing: false, title: '', artist: '', album: '', url: '', t: 0, pos: 0 };
  const D = { rec: false, albumKey: '', trackKey: '', arm: 'rest', busy: false, tok: 0, omega: 0, ang: 0, speed: 33.333, pitch: 0, first: true, lidOpen: false, t: 0 };
  const C = { inserted: false, key: '', busy: false, tok: 0, ejected: false, ejKey: '', omega: 0, ang: 0, first: true, rl: 22, rr: 22, dash: 0 };
  let last = performance.now(), visible = 'deck';

  const wait = (ms, st) => new Promise(res => { const tok = st.tok; setTimeout(() => res(st.tok === tok), reduced() ? 0 : ms); });
  const omegaT = () => 360 * D.speed / 60 * (1 + D.pitch);
  const flash = (node, cls, ms) => { node.classList.add(cls); setTimeout(() => node.classList.remove(cls), ms); };

  // ---- vinyl look (record body, label, sleeve)
  let shown = { url: '', title: '' };
  function paintRecord() {
    const ui = S.ui; normPlayerUi(ui);
    const c = ui.vinyl.color, url = shown.url;
    const go = auto => {
      const lk = vinylLook(c, { title: shown.title, url, auto });
      recBody.style.background = lk.bg; rec.classList.toggle('tr', !!lk.tr); rec.classList.toggle('pic', !!lk.pic); rec.classList.toggle('lt', c !== 'black');
    };
    go(null);
    if (c === 'auto' && url) artColor(url).then(a => { if (shown.url === url && S.ui.vinyl.color === 'auto') go(a); });
  }
  function paintCassette() {
    const url = shown.url;
    jArt.style.backgroundImage = url ? `url("${url}")` : '';
    if (S.ui.cassette.shell === 'auto') {
      shell.style.removeProperty('--sh');
      artColor(url).then(a => { if (shown.url === url && S.ui.cassette.shell === 'auto') shell.style.setProperty('--sh', a ? hsl(a.h, Math.min(a.s, 0.3), clamp(a.l, 0.28, 0.42)) : '#3a3835'); });
    } else shell.style.removeProperty('--sh');
  }
  function swapArt(w) {
    shown = { url: w.url, title: w.title };
    sleeve.style.backgroundImage = w.url ? `url("${w.url}")` : ''; sleeve.classList.toggle('empty', !w.url);
    label.firstChild.style.backgroundImage = w.url ? `url("${w.url}")` : '';
    paintRecord();
  }
  function swapCassetteText(w) {
    shown = { url: w.url, title: w.title };
    jTitle.textContent = w.title || '（沒有曲目資訊）'; jArtist.textContent = w.artist || ''; jAlbum.textContent = w.album || '';
    paintCassette();
  }

  // ---- arm
  function setArm(angle, o = {}) {
    arm.style.transition = o.ms && !reduced() ? `transform ${o.ms}ms cubic-bezier(.4,.05,.2,1)` : 'none';
    if (angle != null) arm.style.transform = `rotate(${angle.toFixed(2)}deg)`;
    armInner.classList.toggle('lifted', !!o.lift);
  }
  const setLid = open => { D.lidOpen = open; lid.classList.toggle('open', open || !S.ui.lid); };

  async function cueArm() {           // lift, swing to the lead-in groove, lower
    D.arm = 'cue';
    setArm(null, { lift: true });
    await wait(260, D); if (D.arm !== 'cue') return;
    setArm(armTo(D.t), { lift: true, ms: 900 });
    await wait(950, D); if (D.arm !== 'cue') return;
    setArm(armTo(D.t), { lift: false });
    await wait(260, D); if (D.arm !== 'cue') return;
    D.arm = 'play'; D.trackKey = cur.trackKey;
  }

  async function deckLoad() {
    D.busy = true; const tok = ++D.tok;
    D.omegaTarget = 0; D.arm = 'lift';
    setArm(D.rec ? null : ARM_REST, { lift: true });
    if (S.ui.lid) setLid(true);
    if (D.rec) { await wait(140, D); if (D.tok !== tok) return; rec.classList.add('away'); await wait(480, D); if (D.tok !== tok) return; D.rec = false; }
    setArm(ARM_REST, { lift: false, ms: 500 });
    swapArt(cur);
    await wait(80, D); if (D.tok !== tok) return;
    rec.classList.remove('away'); await wait(740, D); if (D.tok !== tok) return;
    D.rec = true; D.albumKey = cur.albumKey; D.arm = 'rest';
    if (cur.playing) {
      D.omegaTarget = omegaT(); await wait(380, D); if (D.tok !== tok) return;
      await cueArm(); if (D.tok !== tok) return;
      await wait(120, D); if (D.tok !== tok) return;
      setLid(false);
    }
    D.busy = false; deckSync();
  }
  async function deckEject() {
    D.busy = true; const tok = ++D.tok;
    D.omegaTarget = 0; D.arm = 'lift'; setArm(null, { lift: true });
    await wait(300, D); if (D.tok !== tok) return;
    setArm(ARM_REST, { lift: true, ms: 800 }); await wait(850, D); if (D.tok !== tok) return;
    setArm(ARM_REST, { lift: false }); D.arm = 'rest';
    rec.classList.add('away'); D.rec = false; D.albumKey = ''; D.trackKey = '';
    await wait(560, D); if (D.tok !== tok) return;
    sleeve.style.backgroundImage = ''; sleeve.classList.add('empty');
    setLid(false);
    D.busy = false; deckSync();
  }
  async function deckCue() {
    D.busy = true; const tok = ++D.tok;
    await cueArm(); if (D.tok !== tok) return;
    D.busy = false; deckSync();
  }
  function deckInstant() {
    D.first = false;
    scene.classList.add('instant');
    swapArt(cur); rec.classList.remove('away'); D.rec = true; D.albumKey = cur.albumKey; D.trackKey = cur.trackKey;
    D.t = cur.t; setArm(armTo(D.t), { lift: !cur.playing }); D.arm = cur.playing ? 'play' : 'lift';
    D.omegaTarget = cur.playing ? omegaT() : 0; if (cur.playing) D.omega = D.omegaTarget;
    setLid(false);
    requestAnimationFrame(() => requestAnimationFrame(() => scene.classList.remove('instant')));
  }
  function deckSync() {
    if (D.busy) return;
    if (!cur.has) { if (D.rec || D.arm !== 'rest') deckEject(); else if (!D.lidOpen) { /* idle */ } return; }
    if (D.first) { deckInstant(); return; }
    if (!D.rec || D.albumKey !== cur.albumKey) { deckLoad(); return; }
    if (D.trackKey !== cur.trackKey && cur.playing) { deckCue(); return; }
    if (D.trackKey !== cur.trackKey) D.trackKey = cur.trackKey;
    if (cur.playing) {
      D.omegaTarget = omegaT();
      if (D.arm === 'lift') { D.arm = 'cue'; setArm(armTo(cur.t), { lift: false, ms: 400 }); setTimeout(() => { if (D.arm === 'cue') D.arm = 'play'; }, 450); }
      else if (D.arm === 'rest') deckCue();
    } else if (D.arm === 'play') { D.arm = 'lift'; D.omegaTarget = 0; armInner.classList.add('lifted'); }
    else D.omegaTarget = 0;
  }

  // ---- cassette sequences
  const setDoor = open => { door.classList.toggle('open', open); };
  async function casLoad() {
    C.busy = true; const tok = ++C.tok;
    C.omegaTarget = 0; setDoor(true);
    if (C.inserted) {
      await wait(380, C); if (C.tok !== tok) return;
      cas.classList.remove('in'); cas.classList.add('pop'); await wait(360, C); if (C.tok !== tok) return;
      cas.classList.remove('pop'); cas.classList.add('out'); await wait(300, C); if (C.tok !== tok) return;
    }
    swapCassetteText(cur);
    await wait(80, C); if (C.tok !== tok) return;
    cas.classList.remove('out', 'pop'); cas.classList.add('in');
    await wait(640, C); if (C.tok !== tok) return;
    C.inserted = true; C.key = cur.trackKey;
    setDoor(false); await wait(480, C); if (C.tok !== tok) return;
    C.busy = false; casSync();
  }
  async function casEject() {
    C.busy = true; const tok = ++C.tok;
    C.omegaTarget = 0; setDoor(true);
    await wait(380, C); if (C.tok !== tok) return;
    cas.classList.remove('in', 'out'); cas.classList.add('pop');
    if (!cur.has) { await wait(380, C); if (C.tok !== tok) return; cas.classList.remove('pop'); cas.classList.add('out'); }
    C.inserted = false; C.key = '';
    C.busy = false;
  }
  function casInstant() {
    C.first = false; scene.classList.add('instant');
    swapCassetteText(cur); cas.classList.remove('out', 'pop'); cas.classList.add('in'); setDoor(false); C.inserted = true; C.key = cur.trackKey;
    requestAnimationFrame(() => requestAnimationFrame(() => scene.classList.remove('instant')));
  }
  function casSync() {
    renderKeys();
    if (C.busy) return;
    if (C.ejected && (cur.playing || cur.trackKey !== C.ejKey)) C.ejected = false;
    const want = cur.has && !C.ejected;
    if (!want) { if (C.inserted) casEject(); else if (!cur.has && !cas.classList.contains('out')) { cas.classList.remove('in', 'pop'); cas.classList.add('out'); setDoor(true); } C.omegaTarget = 0; return; }
    if (C.first) { casInstant(); }
    else if (!C.inserted || C.key !== cur.trackKey) { casLoad(); return; }
    C.omegaTarget = cur.playing ? 1 : 0;
  }
  function renderKeys() {
    const ins = C.inserted && !C.ejected;
    K.play.classList.toggle('on', cur.playing && ins);
    K.pause.classList.toggle('on', cur.has && !cur.playing && ins && !C.busy);
    K.stop.classList.toggle('on', !cur.has || C.ejected);
  }
  K.rew.onclick = () => { flash(K.rew, 'on', 220); env.cmd('prev'); };
  K.ff.onclick = () => { flash(K.ff, 'on', 220); env.cmd('next'); };
  K.play.onclick = () => { if (!cur.has) return; C.ejected = false; if (!cur.playing) env.cmd('toggle'); casSync(); };
  K.pause.onclick = () => { if (!cur.has) return; if (C.ejected) { C.ejected = false; if (!cur.playing) env.cmd('toggle'); } else env.cmd('toggle'); casSync(); };
  K.stop.onclick = () => { if (!cur.has) return; if (cur.playing) env.cmd('toggle'); C.ejected = true; C.ejKey = cur.trackKey; setTimeout(casSync, 30); };

  // ---- deck controls
  const setSpeed = v => {
    D.speed = v; b33.classList.toggle('on', v < 40); b45.classList.toggle('on', v >= 40);
    rpmTxt.textContent = v < 40 ? '33⅓ RPM' : '45 RPM'; if (cur.playing && D.rec) D.omegaTarget = omegaT();
  };
  b33.onclick = () => setSpeed(33.333); b45.onclick = () => setSpeed(45);
  pitch.oninput = () => { D.pitch = +pitch.value / 100; pitchOut.textContent = (pitch.value > 0 ? '+' : pitch.value < 0 ? '−' : '±') + Math.abs(pitch.value).toFixed(1) + '%'; if (cur.playing && D.rec) D.omegaTarget = omegaT(); };

  // ---- scene scale (fixed 660x410 design box, shrunk when the column is narrow)
  let ro = null;
  const fit = () => {
    const host = scene.parentElement; if (!host) return;
    if (!ro && typeof ResizeObserver === 'function') { ro = new ResizeObserver(fit); ro.observe(host); }
    const w = host.clientWidth; if (!w) return;
    scene.style.setProperty('--k', Math.min(1, w / SW).toFixed(4));
  };
  addEventListener('resize', fit);

  // ---- public API
  const api = { stage, keysEl, scene };
  api.applyUi = () => {
    const ui = normPlayerUi(S.ui);
    stage.dataset.deck = ui.vinyl.deck; stage.dataset.shell = ui.cassette.shell;
    if (scene.parentElement) scene.parentElement.dataset.deck = ui.vinyl.deck;
    scene.classList.toggle('lid-off', !ui.lid);
    setLid(D.lidOpen); fit();
    if (cur.has) { paintRecord(); paintCassette(); }
  };
  api.update = info => {
    const s = info.s;
    const prev = cur;
    cur = {
      has: !!s, playing: !!info.playing, title: s?.title || '', artist: s?.artist || '', album: s?.album || '', url: info.url || '',
      albumKey: s ? (s.album || s.title || '') + '|' + (s.artist || '') + '|' + (s.id || '') : '',
      trackKey: s ? (s.title || '') + '|' + (s.artist || '') + '|' + (s.album || '') : '', t: prev.t, pos: prev.pos,
    };
    if (cur.url !== prev.url && cur.has && D.rec && !D.busy && cur.albumKey === prev.albumKey) { /* art arrived late */ swapArt(cur); }
    if (C.first && !cur.has) C.first = false;
    if (D.first && !cur.has) D.first = false;
    deckSync(); casSync();
    if (cur.has && C.inserted && !C.busy && cur.url !== shown.url) { swapCassetteText(cur); }
  };
  api.frame = info => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    cur.t = info.t; cur.pos = info.pos; D.t = info.t;
    const lay = S.ui.play;
    visible = lay === 'cassette' ? 'cassette' : lay === 'deck' ? 'deck' : '';
    const noSpin = reduced();
    // platter
    const tgt = noSpin ? 0 : (D.omegaTarget || 0);
    D.omega += (tgt - D.omega) * (1 - Math.exp(-dt / (tgt > D.omega ? 0.22 : 0.55)));
    if (Math.abs(D.omega) < 0.05 && tgt === 0) D.omega = 0;
    D.ang = (D.ang + D.omega * dt) % 360;
    if (visible === 'deck') {
      const tr = `rotate(${D.ang.toFixed(2)}deg)`;
      recSpin.style.transform = tr; platter.style.transform = tr;
      if (D.arm === 'play') setArm(armTo(info.t), { lift: false });
    } else if (D.arm === 'play') arm.style.transform = `rotate(${armTo(info.t).toFixed(2)}deg)`;
    // cassette reels: pack radii follow progress, angular speed follows 1 / radius
    const tt = clamp(info.t, 0, 1), rmin = 13.8, rmax = 29;
    C.rr = Math.sqrt(rmin * rmin + tt * (rmax * rmax - rmin * rmin)); C.rl = Math.sqrt(rmin * rmin + (1 - tt) * (rmax * rmax - rmin * rmin));
    const ct = noSpin ? 0 : (C.omegaTarget || 0) * 100;           // tape linear speed (svg units / s)
    C.omega += (ct - C.omega) * (1 - Math.exp(-dt / (ct > C.omega ? 0.25 : 0.5)));
    if (C.omega < 0.2 && ct === 0) C.omega = 0;
    C.ang = (C.ang + C.omega * dt) % 100000;
    if (visible === 'cassette') {
      const q = winSvg.querySelector('svg');
      q.querySelector('.pk-l').setAttribute('r', C.rl.toFixed(2)); q.querySelector('.pk-r').setAttribute('r', C.rr.toFixed(2));
      q.querySelector('.hub-l').setAttribute('transform', `translate(88 38) rotate(${(-(C.ang / C.rl) * 57.3).toFixed(1)})`);
      q.querySelector('.hub-r').setAttribute('transform', `translate(212 38) rotate(${(-(C.ang / C.rr) * 57.3).toFixed(1)})`);
      const d = `M${(88 - C.rl * 0.0).toFixed(1)} ${(38 + C.rl).toFixed(1)} L112 73.5 L188 73.5 L212 ${(38 + C.rr).toFixed(1)}`;
      const tp = q.querySelector('.tape'), th = q.querySelector('.tape-hi'); tp.setAttribute('d', d); th.setAttribute('d', d); th.setAttribute('stroke-dashoffset', (-C.ang * 0.4).toFixed(1));
      const n = Math.floor(info.pos) % 1000; digits[0].textContent = Math.floor(n / 100); digits[1].textContent = Math.floor(n / 10) % 10; digits[2].textContent = n % 10;
    }
  };
  // meters: side panel host + big VU host, driven from app.js
  const sideBank = { b: null }, bigBank = { b: null };
  api.meters = info => {
    const ui = S.ui;
    const vu = ui.play === 'vu';
    const hot = Math.max(-60, ...(info.smooth || []).map(v => v ?? -60));
    info.side?.closest('.mbridge')?.style.setProperty('--sig', clamp((hot + 50) / 50, 0, 1).toFixed(2));
    if (info.side) { sideBank.b ??= createMeterBank(info.side); sideBank.b.draw({ style: vu ? 'led' : ui.meter, names: info.names, used: info.used, smooth: info.smooth, raw: info.raw }); }
    if (info.big && vu) { bigBank.b ??= createMeterBank(info.big); bigBank.b.draw({ style: ui.meter === 'nixie' ? 'nixie' : 'needle', names: info.names.slice(0, 2), smooth: info.smooth, raw: info.raw, big: true }); }
  };
  api.applyUi();
  setSpeed(33.333);
  return api;
}

// ---------------------------------------------------------------- appearance pickers
const sub = (title, hint) => h('div', { class: 'look-sub' }, h('b', {}, title), hint ? h('small', {}, hint) : null);

/** env = { S, apply(), save() } -> elements for the appearance panel. */
export function playerSections(env) {
  const { S } = env; normPlayerUi(S.ui);
  const set = fn => v => { fn(v); env.apply(); env.save(); };
  const meterK = keys({ options: METER_STYLES.map(x => ({ id: x.id, label: x.name })), value: S.ui.meter, onInput: set(v => { S.ui.meter = v; }) });
  const deckK = keys({ options: DECKS.map(x => ({ id: x.id, label: x.name })), value: S.ui.vinyl.deck, onInput: set(v => { S.ui.vinyl.deck = v; }) });
  const shellK = keys({ options: SHELLS.map(x => ({ id: x.id, label: x.name })), value: S.ui.cassette.shell, onInput: set(v => { S.ui.cassette.shell = v; }) });
  const lidK = keys({ options: [{ id: 'on', label: '顯示' }, { id: 'off', label: '不顯示' }], value: S.ui.lid ? 'on' : 'off', onInput: set(v => { S.ui.lid = v === 'on'; }) });
  const grid = h('div', { class: 'vc-grid' });
  const draw = () => {
    grid.innerHTML = '';
    for (const c of VINYL_COLORS) {
      const lk = c.id === 'auto' ? { bg: 'conic-gradient(#8a6a5a, #5a7a8a, #7a8a5a, #8a6a5a)' } : c.id === 'picture' ? { bg: 'conic-gradient(from 30deg, #b8a27a, #5f7f8f, #8a5a52, #b8a27a)' } : vinylLook(c.id, { title: '預覽' });
      const b = h('button', { type: 'button', class: 'vc-sw' + (S.ui.vinyl.color === c.id ? ' on' : ''), title: c.name, 'aria-label': c.name },
        h('i', { style: `background:${lk.bg}` }), h('span', {}, c.name));
      b.onclick = () => { S.ui.vinyl.color = c.id; env.apply(); env.save(); draw(); };
      grid.append(b);
    }
  };
  draw();
  return [
    sub('儀表', '輸出電平與大型 VU 表的外觀。「VU」播放頁的側欄固定用 LED 光柱。'), h('div', { class: 'accent-row' }, h('div', { class: 'field' }, h('span', {}, '樣式'), meterK.el)),
    sub('唱盤', '黑膠顏色、唱盤外觀與防塵蓋。'), grid,
    h('div', { class: 'hp-row' }, h('div', { class: 'field' }, h('span', {}, '唱盤樣式'), deckK.el), h('div', { class: 'field' }, h('span', {}, '防塵蓋'), lidK.el)),
    sub('卡帶', '外殼顏色。'), h('div', { class: 'accent-row' }, h('div', { class: 'field' }, h('span', {}, '外殼'), shellK.el)),
  ];
}
