// Skeuomorphic-but-flat controls: knob, fader, toggle, rotary selector.
const NS = 'http://www.w3.org/2000/svg';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
export const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else if (k === 'html') e.innerHTML = attrs[k];
    else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) e.setAttribute(k, attrs[k]);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

function quantise(v, step, min) { return step ? Math.round((v - min) / step) * step + min : v; }

/** Rotary knob. */
export function knob(o) {
  const { label, min = 0, max = 1, step = 0.01, def = 0, fmt = v => v.toFixed(1), size = 76, bipolar = false, unit = '' } = o;
  let value = clamp(o.value ?? def, min, max);
  const A0 = -135, A1 = 135, R = 30;
  const root = h('div', { class: 'knob', tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max });
  const svg = svgEl('svg', { viewBox: '0 0 80 80', width: size, height: size, class: 'knob-svg' });
  const ticks = svgEl('g', { class: 'knob-ticks' });
  for (let i = 0; i <= 10; i++) {
    const a = ((A0 + (i / 10) * (A1 - A0)) - 90) * Math.PI / 180;
    const r1 = 36, r2 = i % 5 === 0 ? 39.5 : 38;
    ticks.append(svgEl('line', { x1: 40 + r1 * Math.cos(a), y1: 40 + r1 * Math.sin(a), x2: 40 + r2 * Math.cos(a), y2: 40 + r2 * Math.sin(a) }));
  }
  const track = svgEl('path', { class: 'knob-track' });
  const arc = svgEl('path', { class: 'knob-arc' });
  const skirt = svgEl('circle', { cx: 40, cy: 40, r: 27, class: 'knob-skirt' });
  const knurl = svgEl('g', { class: 'knob-knurl' });
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    knurl.append(svgEl('line', { x1: 40 + 24 * Math.cos(a), y1: 40 + 24 * Math.sin(a), x2: 40 + 27 * Math.cos(a), y2: 40 + 27 * Math.sin(a) }));
  }
  const cap = svgEl('circle', { cx: 40, cy: 40, r: 21, class: 'knob-cap' });
  const capHi = svgEl('circle', { cx: 40, cy: 40, r: 21, class: 'knob-cap-hi' });
  const ptr = svgEl('line', { x1: 40, y1: 24, x2: 40, y2: 31, class: 'knob-ptr' });
  const rot = svgEl('g'); rot.append(knurl, ptr);
  svg.append(ticks, track, arc, skirt, rot, cap, capHi);
  // pointer drawn above cap
  const rot2 = svgEl('g'); const ptr2 = svgEl('line', { x1: 40, y1: 21, x2: 40, y2: 30, class: 'knob-ptr' }); rot2.append(ptr2); svg.append(rot2);
  const readout = h('div', { class: 'knob-val' });
  root.append(svg, h('div', { class: 'knob-label' }, label), readout);

  const arcPath = (a, b) => {
    const p = t => { const r = (t - 90) * Math.PI / 180; return [40 + R * Math.cos(r), 40 + R * Math.sin(r)]; };
    const [x0, y0] = p(a), [x1, y1] = p(b);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${R} ${R} 0 ${Math.abs(b - a) > 180 ? 1 : 0} ${b > a ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };
  track.setAttribute('d', arcPath(A0, A1));
  const draw = () => {
    const t = (value - min) / (max - min);
    const ang = A0 + t * (A1 - A0);
    const zc = o.center ?? 0;
    const zero = bipolar ? A0 + ((zc - min) / (max - min)) * (A1 - A0) : A0;
    arc.setAttribute('d', Math.abs(ang - zero) < 0.5 ? '' : arcPath(Math.min(zero, ang), Math.max(zero, ang)));
    rot.setAttribute('transform', `rotate(${ang} 40 40)`);
    rot2.setAttribute('transform', `rotate(${ang} 40 40)`);
    readout.textContent = fmt(value) + unit;
    root.setAttribute('aria-valuenow', value);
  };
  const set = (v, emit = true) => {
    const nv = clamp(quantise(v, step, min), min, max);
    if (nv === value && emit) return;
    value = nv; draw();
    if (emit) o.onInput?.(value);
  };
  let drag = null;
  root.addEventListener('pointerdown', e => {
    root.setPointerCapture(e.pointerId); root.focus();
    drag = { y: e.clientY, v: value };
    root.classList.add('active');
  });
  root.addEventListener('pointermove', e => {
    if (!drag) return;
    const span = e.shiftKey ? 600 : 160;
    set(drag.v + ((drag.y - e.clientY) / span) * (max - min));
  });
  const end = () => { if (drag) { drag = null; root.classList.remove('active'); o.onChange?.(value); } };
  root.addEventListener('pointerup', end); root.addEventListener('pointercancel', end);
  root.addEventListener('wheel', e => { e.preventDefault(); set(value + (e.deltaY < 0 ? 1 : -1) * (step || (max - min) / 100) * (e.shiftKey ? 1 : 2)); o.onChange?.(value); }, { passive: false });
  root.addEventListener('dblclick', () => { set(def); o.onChange?.(value); });
  root.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); set(value + d * (step || (max - min) / 100)); o.onChange?.(value); }
  });
  draw();
  return { el: root, set: v => set(v, false), get: () => value };
}

/** Vertical fader. */
export function fader(o) {
  const { label, min = -12, max = 12, step = 0.5, def = 0, fmt = v => (v > 0 ? '+' : '') + v.toFixed(1), height = 168 } = o;
  let value = clamp(o.value ?? def, min, max);
  const root = h('div', { class: 'fader', tabindex: 0, role: 'slider', 'aria-label': label });
  const val = h('div', { class: 'fader-val' });
  const slot = h('div', { class: 'fader-slot', style: `height:${height}px` });
  const scale = h('div', { class: 'fader-scale' });
  const marks = o.marks || [max, max / 2, 0, min / 2, min];
  for (const m of marks) {
    const t = (max - m) / (max - min);
    scale.append(h('i', { style: `top:${(t * 100).toFixed(2)}%`, class: m === 0 ? 'zero' : '' }));
  }
  const groove = h('div', { class: 'fader-groove' });
  const fill = h('div', { class: 'fader-fill' });
  const capEl = h('div', { class: 'fader-cap' }, h('span'), h('span'), h('span'));
  slot.append(scale, groove, fill, capEl);
  root.append(val, slot, h('div', { class: 'fader-label' }, label));
  const zeroT = (max - clamp(0, min, max)) / (max - min);
  const draw = () => {
    const t = (max - value) / (max - min);
    capEl.style.top = `calc(${(t * 100).toFixed(3)}% - 11px)`;
    const a = Math.min(t, zeroT), b = Math.max(t, zeroT);
    fill.style.top = (a * 100) + '%'; fill.style.height = ((b - a) * 100) + '%';
    val.textContent = fmt(value);
  };
  const set = (v, emit = true) => { const nv = clamp(quantise(v, step, min), min, max); if (nv === value && emit) return; value = nv; draw(); if (emit) o.onInput?.(value); };
  const fromY = y => { const r = slot.getBoundingClientRect(); return max - clamp((y - r.top) / r.height, 0, 1) * (max - min); };
  let drag = null;
  slot.addEventListener('pointerdown', e => {
    slot.setPointerCapture(e.pointerId); root.focus();
    const onCap = e.target.closest('.fader-cap');
    drag = onCap ? { y: e.clientY, v: value, rel: true } : { rel: false };
    if (!onCap) set(fromY(e.clientY));
    root.classList.add('active');
  });
  slot.addEventListener('pointermove', e => {
    if (!drag) return;
    if (drag.rel) { const r = slot.getBoundingClientRect(); set(drag.v + ((drag.y - e.clientY) / r.height) * (max - min) * (e.shiftKey ? 0.25 : 1)); }
    else set(fromY(e.clientY));
  });
  const end = () => { if (drag) { drag = null; root.classList.remove('active'); o.onChange?.(value); } };
  slot.addEventListener('pointerup', end); slot.addEventListener('pointercancel', end);
  root.addEventListener('wheel', e => { e.preventDefault(); set(value + (e.deltaY < 0 ? step : -step)); o.onChange?.(value); }, { passive: false });
  root.addEventListener('dblclick', () => { set(def); o.onChange?.(value); });
  root.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (d) { e.preventDefault(); set(value + d * step); o.onChange?.(value); }
  });
  draw();
  return { el: root, set: v => set(v, false), get: () => value };
}

/** Bat-handle toggle switch with indicator lamp. */
export function toggle(o) {
  let on = !!o.value;
  const root = h('button', { class: 'tgl' + (o.small ? ' small' : ''), type: 'button', role: 'switch', 'aria-label': o.label });
  const st = h('span', { class: 'tgl-st' });
  const key = h('span', { class: 'tgl-key' }, h('i', { class: 'tgl-led' }), st);
  root.append(key, h('span', { class: 'tgl-text' }, h('b', {}, o.label), o.sub ? h('small', {}, o.sub) : null));
  const draw = () => { root.setAttribute('aria-checked', on); root.classList.toggle('on', on); st.textContent = on ? (o.onText || 'ON') : (o.offText || 'OFF'); };
  root.addEventListener('click', () => { on = !on; draw(); o.onInput?.(on); });
  draw();
  return { el: root, set: v => { on = !!v; draw(); }, get: () => on };
}

/** Rotary selector switch with labelled detents. */
export function selector(o) {
  const opts = o.options; // [{id,label}]
  let idx = Math.max(0, opts.findIndex(x => x.id === o.value));
  const n = opts.length, span = o.span || 200, a0 = -span / 2;
  const angle = i => (n === 1 ? 0 : a0 + (i / (n - 1)) * span);
  const size = o.size || 220;
  const root = h('div', { class: 'selector', style: `width:${size}px;height:${size}px`, role: 'radiogroup', 'aria-label': o.label || '' });
  const svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'sel-svg' });
  for (let i = 0; i < n; i++) {
    const a = (angle(i) - 90) * Math.PI / 180;
    svg.append(svgEl('line', { x1: 100 + 58 * Math.cos(a), y1: 100 + 58 * Math.sin(a), x2: 100 + 66 * Math.cos(a), y2: 100 + 66 * Math.sin(a), class: 'sel-tick' }));
  }
  svg.append(svgEl('circle', { cx: 100, cy: 100, r: 50, class: 'sel-skirt' }));
  const body = svgEl('g');
  body.append(svgEl('rect', { x: 88, y: 52, width: 24, height: 96, rx: 6, class: 'sel-bar' }), svgEl('line', { x1: 100, y1: 56, x2: 100, y2: 76, class: 'sel-ptr' }));
  svg.append(body, svgEl('circle', { cx: 100, cy: 100, r: 6, class: 'sel-hub' }));
  root.append(svg);
  const labels = opts.map((op, i) => {
    const a = (angle(i) - 90) * Math.PI / 180, rr = 0.5 * size * 0.86;
    const b = h('button', { class: 'sel-label', type: 'button', role: 'radio', style: `left:${(size / 2 + rr * Math.cos(a)).toFixed(1)}px;top:${(size / 2 + rr * Math.sin(a)).toFixed(1)}px` }, op.label);
    b.addEventListener('click', () => set(i, true));
    root.append(b);
    return b;
  });
  const draw = () => {
    body.setAttribute('transform', `rotate(${angle(idx)} 100 100)`);
    labels.forEach((b, i) => { b.classList.toggle('on', i === idx); b.setAttribute('aria-checked', i === idx); });
  };
  function set(i, emit) { idx = clamp(i, 0, n - 1); draw(); if (emit) o.onInput?.(opts[idx].id); }
  svg.addEventListener('click', () => set((idx + 1) % n, true));
  root.addEventListener('wheel', e => { e.preventDefault(); set(idx + (e.deltaY > 0 ? 1 : -1), true); }, { passive: false });
  draw();
  return { el: root, set: id => set(Math.max(0, opts.findIndex(x => x.id === id)), false) };
}

/** Chunky key buttons (segmented). */
export function keys(o) {
  const root = h('div', { class: 'keys' + (o.cls ? ' ' + o.cls : ''), role: 'radiogroup' });
  const btns = o.options.map(op => {
    const b = h('button', { class: 'key', type: 'button', role: 'radio' }, op.label);
    b.addEventListener('click', () => { set(op.id); o.onInput?.(op.id); });
    root.append(b);
    return [op.id, b];
  });
  const set = id => btns.forEach(([k, b]) => { b.classList.toggle('on', k === id); b.setAttribute('aria-checked', k === id); });
  set(o.value);
  return { el: root, set };
}
