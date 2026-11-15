// Settings backup / restore / reset (web/js/backup.js) and the in-app log ring (web/js/applog.js).
import { test, ok, eq, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { stripSecrets, buildBackup, validateBackup, restoredState, resetState, replaceState, BACKUP_VERSION } from '../web/js/backup.js';
import * as applog from '../web/js/applog.js';

suite('secrets');
test('stripSecrets removes credential-looking keys at any depth, keeps the rest', () => {
  const o = { a: 1, spotify: { accessToken: 'T1', refresh_token: 'T2', clientSecret: 'T3', clientId: 'ok' }, list: [{ apiKey: 'T4', name: 'n' }], deep: { x: { password: 'T5', y: 2 } }, Authorization: 'T6' };
  const s = JSON.stringify(stripSecrets(o));
  for (const t of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6']) ok(!s.includes(t), t);
  eq(stripSecrets(o).deep.x.y, 2); eq(stripSecrets(o).list[0].name, 'n'); eq(stripSecrets(o).spotify.clientId, 'ok');
});
test('the default state has no key that the filter would drop (nothing real is lost)', () => { eq(stripSecrets(defaultState()), defaultState()); });
test('buildBackup: version field, kind, no secrets even if one slipped into the state', () => {
  const S = defaultState(); S.ui.spotifyToken = 'LEAK'; S.dev.cm = 'GUID';
  const b = buildBackup(S, '2.11.0');
  eq(b.kind, 'fono-backup'); eq(b.backupVersion, BACKUP_VERSION); eq(b.appVersion, '2.11.0'); ok(!JSON.stringify(b).includes('LEAK')); eq(b.settings.dev.cm, 'GUID');
});

suite('validate / restore');
const good = () => buildBackup(defaultState(), 'x');
test('a backup validates', () => ok(validateBackup(good()).ok));
test('rejects: junk, wrong kind, newer version, missing / wrong-typed sections', () => {
  for (const j of [null, 1, 'x', [], {}, { kind: 'fono-theme' }, { kind: 'fono-backup' }, { kind: 'fono-backup', backupVersion: 'a', settings: {} }]) ok(!validateBackup(j).ok, JSON.stringify(j));
  eq(validateBackup({ ...good(), backupVersion: BACKUP_VERSION + 1 }).error, 'newer-version');
  eq(validateBackup({ ...good(), settings: null }).error, 'no-settings');
  eq(validateBackup({ ...good(), settings: { fx: 5 } }).error, 'bad-settings');
  eq(validateBackup({ ...good(), settings: { room: { layout: '9.9' } } }).error, 'bad-settings');
  eq(validateBackup({ ...good(), settings: { fx: { eq: [1, 2, 3] } } }).error, 'bad-settings');
  eq(validateBackup({ ...good(), settings: { profiles: 'x' } }).error, 'bad-settings');
});
test('restoredState: merged over the defaults; missing keys default; wrong types fall back; secrets dropped; no measurement route', () => {
  const j = good(); j.settings = { fx: { bass: 4 }, room: { ch: { FL: { gain: -3 } } }, ui: { lang: 'en', skin: 5, token: 'LEAK' }, meas: { routeSaved: { mode: 'measure' } }, extraKey: 1 };
  const s = restoredState(j), d = defaultState();
  eq(s.fx.bass, 4); eq(s.fx.treble, d.fx.treble); eq(s.room.ch.FL.gain, -3); eq(s.room.ch.FL.delay, 0); eq(s.room.ch.SW2, d.room.ch.SW2);
  eq(s.ui.lang, 'en'); eq(s.ui.skin, d.ui.skin, 'wrong type falls back'); ok(!JSON.stringify(s).includes('LEAK')); eq(s.meas.routeSaved, null); eq(s.extraKey, 1);
});
test('restoredState keeps valid correction profiles and drops malformed entries', () => {
  const j = good(); j.settings = { profiles: [{ id: 'a', name: 'A', data: { v: 1 } }, 7, { id: 5 }, null] };
  eq(restoredState(j).profiles.map(p => p.id), ['a']);
  throws2(() => restoredState({ kind: 'nope' }));
});
function throws2(fn) { try { fn(); } catch { return; } throw new Error('did not throw'); }
test('round trip through JSON text', () => {
  const S = defaultState(); S.fx.bass = 2.5; S.room.ch.FR.corr = { name: 'x', filters: [{ type: 'PK', fc: 100, gain: 1, q: 1 }] }; S.profiles = [{ id: 'p1', name: 'P', created: '2026-01-01T00:00:00Z', data: { v: 1 } }];
  const s = restoredState(JSON.parse(JSON.stringify(buildBackup(S, '1'))));
  eq(s.fx.bass, 2.5); eq(s.room.ch.FR.corr.filters[0].fc, 100); eq(s.profiles[0].id, 'p1');
});

suite('reset');
test('resetState keeps devices, language, mic and setup progress when asked; resets the rest', () => {
  const S = defaultState(); S.dev = { cm: 'G1', spark: 'G2', autoSwitch: false, sparkLoad: 'headphones' }; S.ui.setupDone = true; S.ui.lang = 'en'; S.mic.deviceId = 'mic1'; S.fx.bass = 5; S.profiles = [{ id: 'x' }]; S.room.ch.FL.gain = -4; S.ui.skin = 'deck';
  const k = resetState(S, { keepDevices: true });
  eq(k.dev, S.dev); eq(k.ui.setupDone, true); eq(k.ui.lang, 'en'); eq(k.mic.deviceId, 'mic1'); eq(k.fx.bass, 0); eq(k.profiles, []); eq(k.room.ch.FL.gain, 0); eq(k.ui.skin, defaultState().ui.skin);
  const a = resetState(S, { keepDevices: false }); eq(a, defaultState());
});
test('replaceState swaps the contents in place (same object reference)', () => {
  const S = { a: 1, b: 2 }, ref = S; replaceState(S, { c: 3 }); ok(S === ref); eq(S, { c: 3 });
});

suite('applog ring buffer');
test('keeps the last 500 lines, truncates long lines, formats', () => {
  applog.clear();
  for (let i = 0; i < 730; i++) applog.add('toast', 'line ' + i);
  eq(applog.size(), 500); eq(applog.entries()[0].text, 'line 230'); eq(applog.entries()[499].text, 'line 729');
  applog.add('console', 'x'.repeat(5000), 'error'); ok(applog.entries().pop().text.length <= applog.MAX_LEN + 1);
  ok(/^\d\d:\d\d:\d\d\.\d{3} ERROR \[console\] x+/.test(applog.text().split('\n').pop()));
  applog.add('meas', '   '); eq(applog.size(), 500);
  applog.clear(); eq(applog.size(), 0); eq(applog.text(), '');
});

done('backup.test.mjs');
