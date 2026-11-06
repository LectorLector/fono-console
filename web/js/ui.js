// Shared UI helpers.
import { h } from './widgets.js';
export { h };
export const $ = (sel, root = document) => root.querySelector(sel);
// ================================================================ utils
export const fmtTime = s => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), x = Math.floor(s % 60); return `${m}:${String(x).padStart(2, '0')}`; };
export const sgn = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);
export const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let toastT;
export function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('bad', bad); t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
}
export async function api(path, opt = {}) {
  const r = await fetch(path, opt);
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j?.error || r.statusText); e.status = r.status; e.body = j; throw e; }
  return j;
}
export const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

export function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, hh = c.clientHeight;
  if (!w || !hh) return null;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hh * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, hh);
  return { g, w, h: hh };
}

/** Generic log-frequency graph. */
export function drawGraph(c, o) {
  const s = setupCanvas(c); if (!s) return;
  const { g, w, h: H } = s;
  const pad = { l: 40, r: 12, t: 10, b: 22, ...o.pad };
  const fmin = o.fmin || 20, fmax = o.fmax || 20000, dmin = o.dmin, dmax = o.dmax;
  const X = f => pad.l + (Math.log(f / fmin) / Math.log(fmax / fmin)) * (w - pad.l - pad.r);
  const Y = d => pad.t + (1 - (d - dmin) / (dmax - dmin)) * (H - pad.t - pad.b);
  g.font = '11px ' + css('--font-disp'); g.lineWidth = 1;
  const grid = css('--grid'), ink3 = css('--ink-3');
  g.strokeStyle = grid; g.fillStyle = ink3;
  if (o.bare) { g.strokeStyle = ink3; g.beginPath(); g.moveTo(pad.l, Y(0) + .5); g.lineTo(w - pad.r, Y(0) + .5); g.stroke(); }
  for (const f of o.bare ? [] : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f < fmin || f > fmax) continue;
    g.beginPath(); g.moveTo(X(f) + .5, pad.t); g.lineTo(X(f) + .5, H - pad.b); g.stroke();
    g.textAlign = 'center'; g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), X(f), H - 6);
  }
  const step = o.dstep || 5;
  for (let d = Math.ceil(dmin / step) * step; d <= dmax && !o.bare; d += step) {
    g.strokeStyle = d === 0 && o.zero ? ink3 : grid;
    g.beginPath(); g.moveTo(pad.l, Y(d) + .5); g.lineTo(w - pad.r, Y(d) + .5); g.stroke();
    g.textAlign = 'right'; g.fillStyle = ink3; g.fillText((d > 0 && o.zero ? '+' : '') + d, pad.l - 6, Y(d) + 4);
  }
  for (const b of o.bands || []) { g.fillStyle = b.color; g.fillRect(X(b.f0), pad.t, X(b.f1) - X(b.f0), H - pad.t - pad.b); }
  for (const m of o.markers || []) {
    g.strokeStyle = m.color; g.setLineDash(m.dash || [3, 3]); g.beginPath(); g.moveTo(X(m.f) + .5, pad.t); g.lineTo(X(m.f) + .5, H - pad.b); g.stroke(); g.setLineDash([]);
    if (m.label) { g.fillStyle = m.color; g.textAlign = 'left'; g.fillText(m.label, X(m.f) + 3, pad.t + 11 + (m.row || 0) * 12); }
  }
  for (const cv of o.curves || []) {
    g.strokeStyle = cv.color; g.lineWidth = cv.width || 2; g.setLineDash(cv.dash || []);
    g.beginPath(); let started = false;
    for (let i = 0; i < cv.f.length; i++) {
      const f = cv.f[i]; if (f < fmin || f > fmax) continue;
      const y = Y(Math.max(dmin - 50, Math.min(dmax + 50, cv.db[i])));
      if (!started) { g.moveTo(X(f), y); started = true; } else g.lineTo(X(f), y);
    }
    g.stroke(); g.setLineDash([]);
    if (cv.fill) { g.lineTo(X(Math.min(fmax, cv.f[cv.f.length - 1])), Y(0)); g.lineTo(X(Math.max(fmin, cv.f[0])), Y(0)); g.closePath(); g.fillStyle = cv.fill; g.fill(); }
  }
  for (const pt of o.points || []) { g.fillStyle = pt.color; g.beginPath(); g.arc(X(pt.f), Y(pt.db), 3.5, 0, Math.PI * 2); g.fill(); }
  return { X, Y };
}

