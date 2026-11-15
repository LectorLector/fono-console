// Bug-report bundle (web/js/bugreport.js): contents, identifier hashing, no secrets / raw audio / user names, ASCII config, zip validity.
import { test, ok, eq, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { hashId, redactPaths, asciiOnly, sanitizeSettings, measurementSummaries, buildBundle, idReplacer } from '../web/js/bugreport.js';
import { crc32 } from '../web/js/export.js';
import { genConfig } from '../web/js/eapo.js';

function unzip(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), dec = new TextDecoder();
  let e = u8.length - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no EOCD');
  const n = v.getUint16(e + 10, true), out = {}; let p = v.getUint32(e + 16, true);
  for (let i = 0; i < n; i++) {
    const crc = v.getUint32(p + 16, true), sz = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)), lnl = v.getUint16(lo + 26, true), lxl = v.getUint16(lo + 28, true), data = u8.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + sz);
    if (crc32(data) !== crc) throw new Error('crc ' + name);
    out[name] = dec.decode(data); p += 46 + nl + xl + cl;
  }
  return out;
}

const GUID = '{0.0.0.00000000}.{a1b2c3d4-1111-2222-3333-444455556666}', GUID2 = '{0.0.1.00000000}.{ffeeddcc-9999-8888-7777-666655554444}', MIC = 'c0ffee1234567890deadbeef';
function sample() {
  const S = defaultState();
  S.dev.cm = GUID; S.dev.spark = GUID2; S.mic.deviceId = MIC; S.mic.cal = { [MIC]: { f: [1, 2, 3], db: [0, 1, 2] } }; S.mic.channel = { [MIC]: 'L' };
  S.ui.spotifyToken = 'SECRET-TOKEN-1'; S.ui.wall.src = 'C:\\Users\\alice\\Pictures\\me.jpg'; S.rew.exe = 'C:\\Users\\alice\\apps\\REW\\roomeqwizard.exe';
  S.lib.recent = [{ title: 'Private Song', artist: 'Someone' }];
  S.meas.results = { FL: { f: [20, 100, 1000, 5000], db: [-10, -4, 0, 2] }, FR: { f: [20, 100, 1000], db: [-12, -3, 1] } };
  S.room.ch.FL.corr = { name: 'FL', filters: [{ type: 'PK', fc: 63, gain: -4, q: 2 }], source: 'auto' };
  return S;
}
const devices = [{ guid: GUID, name: '喇叭', iface: 'USB 7.1 Sound Card', rate: 48000, bits: 24, eapo: true }, { guid: GUID2, name: '耳機', iface: 'DAC', rate: 96000, bits: 24, eapo: false }];
const bundle = (extra = {}) => buildBundle({ version: '2.11.0', S: sample(), sys: { platform: 'windows', version: '2.11.0', eapoFound: true, writable: true, included: true, eapoDir: 'C:\\Program Files\\EqualizerAPO\\config' }, devices, configText: genConfig(sample(), {}) + '\n# 備註 café', clientLog: `12:00:00.000 INFO  [toast] saved ${GUID} for C:\\Users\\alice\\x`, serverLog: `listening http://127.0.0.1:47811/ cfg C:\\Users\\alice\\AppData\\Roaming\\FonoConsole`, eapoStatus: { lastWriteOk: true }, env: { userAgent: 'UA' }, date: new Date('2026-11-15T10:00:00Z'), ...extra });

suite('helpers');
test('hashId: stable, distinct, hides the input', () => {
  eq(hashId(GUID, 'dev'), hashId(GUID, 'dev')); ok(hashId(GUID) !== hashId(GUID2)); ok(!hashId(GUID).includes('a1b2')); ok(/^dev-[0-9a-f]{12}$/.test(hashId(GUID, 'dev')));
});
test('redactPaths: Windows (plain and JSON-escaped), macOS, Linux', () => {
  eq(redactPaths('C:\\Users\\alice\\x'), 'C:\\Users\\<user>\\x'); eq(redactPaths('C:\\\\Users\\\\alice\\\\x'), 'C:\\\\Users\\\\<user>\\\\x');
  eq(redactPaths('/Users/bob/doc'), '/Users/<user>/doc'); eq(redactPaths('/home/carol/x'), '/home/<user>/x'); eq(redactPaths('C:\\Program Files\\EqualizerAPO'), 'C:\\Program Files\\EqualizerAPO');
});
test('asciiOnly and idReplacer', () => {
  eq(asciiOnly('a 備註 é\r\nb'), 'a ?? ?\r\nb');
  const r = idReplacer([GUID, GUID2, 'ab']); ok(!r.text('x ' + GUID + ' y ' + GUID2).includes('a1b2')); eq(r.text('plain'), 'plain');
});

suite('settings / summaries');
test('sanitizeSettings: no secrets, ids hashed, no history / calibration / curves / user name', () => {
  const j = JSON.stringify(sanitizeSettings(sample(), devices));
  for (const bad of ['SECRET-TOKEN-1', 'alice', 'Private Song', 'a1b2c3d4', 'ffeeddcc', MIC]) ok(!j.includes(bad), 'leaked: ' + bad);
  ok(j.includes('dev-'), 'hashed ids present'); ok(j.includes('recentCount'));
});
test('measurementSummaries: levels and counts, never the curves', () => {
  const m = measurementSummaries(sample());
  eq(m.channels.FL.points, 4); eq(m.channels.FL.fmin, 20); eq(m.channels.FL.maxDb, 2); eq(m.correction.FL.filters, 1);
  ok(!JSON.stringify(m).includes('"db":['), 'no curve arrays');
});

suite('bundle');
test('file list, README mentions every file, bilingual descriptions', () => {
  const b = bundle(), names = b.files.map(f => f.name);
  eq(names, ['README.txt', 'system.json', 'devices.json', 'fono_console.txt', 'settings.sanitized.json', 'measurements.json', 'client-log.txt', 'server-log.txt']);
  ok(b.files.every(f => f.zh && f.en && f.bytes > 0), 'descriptions + sizes');
  const readme = b.files[0].data; for (const n of names.slice(1)) ok(readme.includes(n), 'README lists ' + n); ok(/【中文】/.test(readme) && /English/.test(readme));
  eq(b.zipName, 'fono-bugreport-2026-11-15.zip');
});
test('server log omitted when the endpoint gave nothing', () => { ok(!bundle({ serverLog: '' }).files.some(f => f.name === 'server-log.txt')); });
test('zip is valid (CRC checked) and its text has no secrets, device ids, user names, or raw audio', () => {
  const z = unzip(bundle().zip()), all = Object.values(z).join('\n');
  eq(Object.keys(z).length, 8);
  for (const bad of ['SECRET-TOKEN-1', 'alice', 'Private Song', 'a1b2c3d4', 'ffeeddcc', MIC]) ok(!all.includes(bad), 'leaked: ' + bad);
  ok(JSON.parse(z['devices.json'])[0].id.startsWith('dev-')); ok(z['client-log.txt'].includes('dev-') && z['client-log.txt'].includes('<user>'));
  ok(z['server-log.txt'].includes('<user>'));
  ok(all.length < 400000, 'small: ' + all.length);
  JSON.parse(z['system.json']); JSON.parse(z['settings.sanitized.json']); JSON.parse(z['measurements.json']);
});
test('fono_console.txt in the bundle is pure ASCII', () => {
  const z = unzip(bundle().zip()); ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(z['fono_console.txt'])); ok(z['fono_console.txt'].includes('Preamp') || z['fono_console.txt'].length > 10);
});
test('the same device gets the same code in every file', () => {
  const z = unzip(bundle().zip()), id = JSON.parse(z['devices.json'])[0].id;
  ok(z['settings.sanitized.json'].includes(id), 'settings uses the same code'); ok(z['client-log.txt'].includes(id));
});

done('bugreport.test.mjs');
