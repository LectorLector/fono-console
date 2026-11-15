// Bug-report bundle: what goes into the zip, with identifiers hashed and secrets / raw audio left out. Pure functions
// (the page gathers the inputs and shows the list before anything is downloaded); tested in tests/bugreport.test.mjs.
import { zipStore } from './export.js';
import { stripSecrets } from './backup.js';
import { bugReadme, FILE_INFO } from './bugreport-readme.mjs';

/** Stable, non-reversible short code for an identifier (FNV-1a 64 bit over two seeds -> 12 hex). Same input, same code. */
export function hashId(id, prefix = 'id') {
  const s = String(id); let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0; h2 ^= h2 >>> 13; }
  return `${prefix}-${h1.toString(16).padStart(8, '0')}${(h2 & 0xffff).toString(16).padStart(4, '0')}`;
}
/** Replace a user's profile folder name: C:\Users\name, /Users/name, /home/name (also JSON-escaped backslashes). */
export const redactPaths = s => String(s)
  .replace(/([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\\/\s"'<>|:*?]+/gi, '$1<user>')
  .replace(/(\/(?:Users|home)\/)[^\/\s"'<>|:*?]+/g, '$1<user>');
export const asciiOnly = s => String(s).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?');

/** Build a replacer that swaps every known identifier (device GUIDs, browser device ids) for its hash, in text. */
export function idReplacer(ids) {
  const uniq = [...new Set(ids.filter(x => typeof x === 'string' && x.length >= 4))].sort((a, b) => b.length - a.length);
  const map = new Map(uniq.map(id => [id, hashId(id, 'dev')]));
  const rx = uniq.length ? new RegExp(uniq.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  return { map, text: s => { const r = rx ? String(s).replace(rx, m => map.get(m)) : String(s); return redactPaths(r); } };
}

/** Identifiers in this state / device list that must not leave the machine verbatim. */
export function collectIds(S, devices = []) {
  const ids = [];
  for (const d of devices) if (d?.guid) ids.push(d.guid);
  for (const v of Object.values(S.dev || {})) if (typeof v === 'string') ids.push(v);
  if (S.mic?.deviceId) ids.push(S.mic.deviceId);
  ids.push(...Object.keys(S.mic?.cal || {}), ...Object.keys(S.mic?.channel || {}));
  if (S.hp?.profiles) ids.push(...Object.keys(S.hp.profiles));
  return ids;
}

/** Settings for the bundle: no credentials, no listening history, no calibration / curve data, ids hashed, home folder redacted. */
export function sanitizeSettings(S, devices = []) {
  const rep = idReplacer(collectIds(S, devices));
  const s = stripSecrets(S);
  if (s.lib) s.lib = { recentCount: (S.lib?.recent || []).length, source: S.lib?.source };
  if (s.mic) s.mic = { ...s.mic, cal: Object.fromEntries(Object.keys(S.mic?.cal || {}).map(k => [k, '(calibration data left out)'])) };
  if (s.meas) s.meas = { ...s.meas, results: Object.fromEntries(Object.keys(S.meas?.results || {}).map(k => [k, '(curve data: see measurements.json)'])) };
  if (s.room?.art) s.room.art = { ...s.room.art, weights: s.room.art.weights ? '(omitted)' : null };
  if (s.ui?.wall) s.ui.wall = { ...s.ui.wall, src: s.ui.wall.src ? '(custom image)' : '' };
  return JSON.parse(rep.text(JSON.stringify(s)));
}

const finite = v => typeof v === 'number' && Number.isFinite(v);
/** Per-channel summary of the stored measurement curves (levels, range, point count) plus the correction in force. No audio, no full curves. */
export function measurementSummaries(S) {
  const out = { channels: {}, correction: {}, sub: S.room?.sub?.align || null, artVerify: S.room?.art?.verify ? { ...S.room.art.verify } : null, dims: S.dims, meas: { positions: S.meas?.positions, sweeps: S.meas?.sweeps, level: S.meas?.level, lfRise: S.meas?.lfRise, maxFilters: S.meas?.maxFilters } };
  for (const [k, c] of Object.entries(S.meas?.results || {})) {
    const f = c?.f || [], db = c?.db || [];
    const band = (lo, hi) => { const v = db.filter((x, i) => finite(x) && f[i] >= lo && f[i] <= hi); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
    out.channels[k] = { points: f.length, fmin: f[0] ?? null, fmax: f[f.length - 1] ?? null, avgDb: { '20-200': band(20, 200), '200-2k': band(200, 2000), '2k-20k': band(2000, 20000) }, minDb: db.length ? Math.round(Math.min(...db.filter(finite)) * 10) / 10 : null, maxDb: db.length ? Math.round(Math.max(...db.filter(finite)) * 10) / 10 : null };
  }
  for (const [k, c] of Object.entries(S.room?.ch || {})) out.correction[k] = { gain: c.gain, delay: c.delay, invert: c.invert, mute: !!c.mute, filters: c.corr?.filters?.length || 0, source: c.corr?.source || '' };
  return out;
}

const json = o => JSON.stringify(o, null, 2);

/**
 * Assemble the bundle. inputs: {version, S, sys, devices, configText, clientLog, serverLog, eapoStatus, env}
 * Returns {files: [{name, data, zh, en, bytes}], zip(): Uint8Array, zipName}.
 */
export function buildBundle({ version = '', S, sys = {}, devices = [], configText = '', clientLog = '', serverLog = '', eapoStatus = {}, env = {}, date = new Date() }) {
  const rep = idReplacer(collectIds(S, devices));
  const T = x => rep.text(x);
  const files = [];
  const put = (name, data, info) => files.push({ name, data, zh: info.zh, en: info.en, bytes: new TextEncoder().encode(data).length });
  const sysInfo = { app: 'Fono Console', version, created: date.toISOString(), system: { platform: sys.platform, demo: sys.demo, installed: sys.installed, eapoFound: sys.eapoFound, eapoWritable: sys.writable, configFound: sys.configFound, includeLine: sys.included, eapoDir: sys.eapoDir }, eapo: eapoStatus, env };
  const devInfo = devices.map(d => ({ id: hashId(d.guid, 'dev'), name: d.name, iface: d.iface, rate: d.rate, bits: d.bits, eapo: d.eapo }));
  put('system.json', T(json(sysInfo)), FILE_INFO['system.json']);
  put('devices.json', T(json(devInfo)), FILE_INFO['devices.json']);
  put('fono_console.txt', asciiOnly(T(configText)), FILE_INFO['fono_console.txt']);
  put('settings.sanitized.json', json(sanitizeSettings(S, devices)), FILE_INFO['settings.sanitized.json']);
  put('measurements.json', T(json(measurementSummaries(S))), FILE_INFO['measurements.json']);
  put('client-log.txt', T(clientLog) || '(empty)', FILE_INFO['client-log.txt']);
  if (serverLog) put('server-log.txt', T(serverLog), FILE_INFO['server-log.txt']);
  const readme = bugReadme({ version, created: date.toISOString(), files });
  files.unshift({ name: 'README.txt', data: readme, ...FILE_INFO['README.txt'], bytes: new TextEncoder().encode(readme).length });
  const stamp = date.toISOString().slice(0, 10);
  return { files, zipName: `fono-bugreport-${stamp}.zip`, zip: () => zipStore(files.map(f => ({ name: f.name, data: f.data })), date) };
}
