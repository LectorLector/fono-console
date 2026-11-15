// Small in-app ring buffer (max 500 lines): console warnings / errors, uncaught errors, toasts and measurement log lines.
// Kept in memory only; the bug-report bundle (bugreport.js) is the only thing that ever reads it, and only when the user asks.
export const MAX_LINES = 500, MAX_LEN = 600;
const buf = [];
let installed = false;

const str = a => { if (typeof a === 'string') return a; if (a instanceof Error) return a.stack ? a.stack.split('\n').slice(0, 3).join(' | ') : a.message; try { return JSON.stringify(a); } catch { return String(a); } };
/** Add a line. level: 'info' | 'warn' | 'error'. src: 'console' | 'toast' | 'meas' | 'window' ... */
export function add(src, text, level = 'info') {
  let s = String(text).replace(/\s+/g, ' ').trim(); if (!s) return;
  if (s.length > MAX_LEN) s = s.slice(0, MAX_LEN) + '…';
  buf.push({ t: Date.now(), level, src, text: s });
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
}
export const size = () => buf.length;
export const clear = () => { buf.length = 0; };
export const entries = () => buf.slice();
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const fmt = e => { const d = new Date(e.t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} ${e.level.toUpperCase().padEnd(5)} [${e.src}] ${e.text}`; };
/** The whole log as text, oldest first. */
export const text = () => buf.map(fmt).join('\n');

/** Hook console.warn / console.error and window errors (once). Original behaviour is kept. */
export function install() {
  if (installed || typeof window === 'undefined') return; installed = true;
  for (const lv of ['warn', 'error']) {
    const orig = console[lv].bind(console);
    console[lv] = (...a) => { try { add('console', a.map(str).join(' '), lv); } catch {} orig(...a); };
  }
  window.addEventListener('error', e => add('window', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`, 'error'));
  window.addEventListener('unhandledrejection', e => add('window', 'unhandled rejection: ' + str(e.reason), 'error'));
}
