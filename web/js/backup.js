// Settings backup / restore / reset. Pure functions (no DOM); tested in tests/backup.test.mjs.
// The server builds the downloadable backup (/api/backup: settings.json minus credentials); this module validates a file
// before it is merged over the defaults, strips credential-looking keys again (a hand-edited file must not smuggle them in),
// and decides what a reset keeps.
import { defaultState, deepMerge } from './state.js';

export const BACKUP_VERSION = 1;
export const SECRET_KEY = /token|secret|password|passwd|authorization|api[_-]?key|refresh|credential/i;   // same rule as stripSecrets in update.go

/** Deep copy without any key that looks like a credential (at any depth). */
export function stripSecrets(v) {
  if (Array.isArray(v)) return v.map(stripSecrets);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (!SECRET_KEY.test(k)) o[k] = stripSecrets(x); return o; }
  return v;
}

export function buildBackup(S, appVersion = '') {
  return { kind: 'fono-backup', backupVersion: BACKUP_VERSION, app: 'Fono Console', appVersion, created: new Date().toISOString(), settings: stripSecrets(S) };
}

/** Validate a parsed backup. Returns {ok, error, settings (sanitized), warnings}. error ids: not-backup, newer-version, no-settings, bad-settings. */
export function validateBackup(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.kind !== 'fono-backup') return { ok: false, error: 'not-backup' };
  if (!Number.isInteger(j.backupVersion) || j.backupVersion < 1) return { ok: false, error: 'not-backup' };
  if (j.backupVersion > BACKUP_VERSION) return { ok: false, error: 'newer-version' };
  const s = j.settings;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: 'no-settings' };
  for (const k of ['fx', 'room', 'ui']) if (s[k] !== undefined && (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k]))) return { ok: false, error: 'bad-settings' };
  if (s.room?.layout !== undefined && !['hp', '2.0', '2.1', '2.2', '4.0', '4.1', '4.2'].includes(s.room.layout)) return { ok: false, error: 'bad-settings' };
  if (s.fx?.eq !== undefined && !(Array.isArray(s.fx.eq) && s.fx.eq.length === 10 && s.fx.eq.every(Number.isFinite))) return { ok: false, error: 'bad-settings' };
  if (s.profiles !== undefined && !Array.isArray(s.profiles)) return { ok: false, error: 'bad-settings' };
  return { ok: true, settings: stripSecrets(s) };
}

/** Settings after a restore: the backup merged over the defaults (missing keys keep their default, wrong types fall back). */
export function restoredState(j) {
  const v = validateBackup(j); if (!v.ok) throw new Error(v.error);
  const s = deepMerge(defaultState(), v.settings);
  s.meas.routeSaved = null;   // a restored file never resumes a measurement route
  if (Array.isArray(v.settings.profiles)) s.profiles = v.settings.profiles.filter(p => p && typeof p === 'object' && typeof p.id === 'string' && p.data);
  return s;
}

/** Reset to defaults. keepDevices: keep the chosen outputs, the language, the microphone and "setup wizard done" so the app does not start from scratch. */
export function resetState(S, { keepDevices = true } = {}) {
  const d = defaultState();
  if (keepDevices) {
    d.dev = { ...d.dev, ...S.dev };
    d.ui.setupDone = !!S.ui?.setupDone; d.ui.lang = S.ui?.lang || '';
    d.mic.deviceId = S.mic?.deviceId || '';
  }
  return d;
}

/** Replace the contents of the live state object (other modules hold the reference). */
export function replaceState(S, next) { for (const k of Object.keys(S)) delete S[k]; Object.assign(S, next); return S; }
