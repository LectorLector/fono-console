// Correction profiles (web/js/profiles.js): snapshot / apply round trip, what is never touched, validation, import / export, A/B.
import { test, ok, eq, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { snapshotProfile, makeProfile, applyProfile, validateProfile, validateProfileData, importProfiles, exportProfiles, renameProfile, deleteProfile, abNext, abToggle, layoutMismatch, MAX_PROFILES } from '../web/js/profiles.js';

const filt = (fc, gain) => ({ type: 'PK', fc, gain, q: 2 });
function tuned() {
  const S = defaultState();
  S.room.ch.FL.gain = -2.5; S.room.ch.FL.delay = 1.25; S.room.ch.FR.invert = true; S.room.ch.FL.corr = { name: 'FL', filters: [filt(63, -4), filt(120, 2.5)], source: 'auto' };
  S.room.ch.SW1.gain = 3; S.room.sub.xover = 70; S.room.sub.delay = 4; S.room.align.FL = 0.5; S.room.xover = 90; S.room.rearLPHz = 6000;
  S.room.target = [[20, 3], [200, 0], [20000, -1]]; S.room.stereo.band.maxDb = 3; S.room.stereo.match.FL = [filt(500, -1)]; S.room.art.fc = 100; S.room.fir.lo = 150;
  S.room.correction = false; S.room.hafler = true;
  return S;
}
const corrBits = S => JSON.stringify({ ch: S.room.ch, align: S.room.align, sub: S.room.sub, target: S.room.target, correction: S.room.correction, hafler: S.room.hafler, xover: S.room.xover, rearLPHz: S.room.rearLPHz, stereo: S.room.stereo.match, band: S.room.stereo.band, art: S.room.art.fc, fir: S.room.fir.lo });

suite('snapshot / apply');
test('round trip: save, change everything, load -> the saved values are back', () => {
  const S = tuned(), p = makeProfile(S, 'Night');
  const before = corrBits(S);
  const T = defaultState(); T.profiles = [p];
  T.room.ch.FL.gain = 9; T.room.sub.xover = 120; T.room.target = null; T.room.correction = true;
  const r = applyProfile(T, p);
  ok(r.applied, 'applied'); eq(r.warnings, []);
  eq(corrBits(T), before);
});
test('snapshot is a deep copy (later edits do not change the profile)', () => {
  const S = tuned(), p = makeProfile(S, 'x'); S.room.ch.FL.corr.filters[0].gain = 99; S.room.target[0][1] = 50;
  eq(p.data.room.ch.FL.corr.filters[0].gain, -4); eq(p.data.room.target[0][1], 3);
  const T = defaultState(); applyProfile(T, p); T.room.ch.FL.corr.filters[0].gain = 7; eq(p.data.room.ch.FL.corr.filters[0].gain, -4, 'apply copies too');
});
test('never touches devices, layout, channel map, listening mode, room geometry, measurements', () => {
  const S = tuned(), p = makeProfile(S, 'x');
  const T = defaultState(); T.dev = { cm: 'GUID-1', spark: 'GUID-2', autoSwitch: false, sparkLoad: 'speakers' }; T.room.layout = '2.0'; T.room.mode = 'stereo'; T.room.map.FL = 'C'; T.dims.L = 7; T.room.pos = { seat: [1, 2] }; T.meas.results = { FL: { f: [1], db: [1] } };
  const keep = JSON.stringify({ dev: T.dev, layout: T.room.layout, mode: T.room.mode, map: T.room.map, dims: T.dims, pos: T.room.pos, meas: T.meas, ui: T.ui });
  applyProfile(T, p);
  eq(JSON.stringify({ dev: T.dev, layout: T.room.layout, mode: T.room.mode, map: T.room.map, dims: T.dims, pos: T.room.pos, meas: T.meas, ui: T.ui }), keep);
});
test('layout mismatch is reported (and Hafler stays off on a front-only layout)', () => {
  const S = tuned(), p = makeProfile(S, 'x'); // saved on 4.0 with hafler on
  const T = defaultState(); T.room.layout = '2.0';
  ok(layoutMismatch(T, p));
  const r = applyProfile(T, p); ok(r.warnings.includes('layout')); eq(T.room.layout, '2.0'); eq(T.room.hafler, false);
});
test('effects are stored and restored only when asked for', () => {
  const S = tuned(); S.fx.bass = 3; S.fx.eq[2] = -4; S.fx.rev.on = true; S.fx.preamp = -2;
  const a = makeProfile(S, 'noFx'), b = makeProfile(S, 'fx', { includeFx: true });
  ok(!a.data.fx && b.data.fx);
  const T = defaultState(); applyProfile(T, a); eq(T.fx.bass, 0);
  applyProfile(T, b); eq(T.fx.bass, 3); eq(T.fx.eq[2], -4); eq(T.fx.rev.on, true); eq(T.fx.preamp, -2);
});
test('FIR / ART / phase builds on disk: switched only when the same build is current, otherwise left alone with a warning', () => {
  const S = tuned(); S.room.fir.on = true; S.room.fir.built = 'B1'; S.room.fir.latencyMs = 85; S.room.art.built = 'A1'; S.room.art.preampDb = -3; S.room.stereo.phaseOn = true; S.room.stereo.phase.built = 'P1';
  const p = makeProfile(S, 'x');
  const same = JSON.parse(JSON.stringify(S)); same.room.fir.on = false; same.room.stereo.phaseOn = false; same.room.fir.lo = 20;
  let r = applyProfile(same, p); eq(r.warnings, []); eq(same.room.fir.on, true); eq(same.room.fir.lo, 150); eq(same.room.stereo.phaseOn, true);
  const other = JSON.parse(JSON.stringify(S)); other.room.fir.built = 'B2'; other.room.fir.on = false; other.room.fir.latencyMs = 40; other.room.art.built = 'A2'; other.room.stereo.phase.built = 'P2'; other.room.stereo.phaseOn = false;
  r = applyProfile(other, p);
  eq(r.warnings.sort(), ['art-stale', 'fir-stale', 'phase-stale']);
  eq(other.room.fir.on, false); eq(other.room.fir.built, 'B2'); eq(other.room.fir.latencyMs, 40); eq(other.room.art.built, 'A2'); eq(other.room.stereo.phaseOn, false);
  eq(other.room.fir.lo, 150, 'FIR settings (not the build) still come across');
});

suite('validation');
const good = () => makeProfile(tuned(), 'ok');
test('a fresh profile validates', () => { ok(validateProfile(good()).ok, JSON.stringify(validateProfile(good()))); ok(validateProfile(makeProfile(defaultState(), 'd', { includeFx: true })).ok); });
test('bad values are rejected', () => {
  const bad = f => { const p = good(); f(p); return validateProfile(p); };
  ok(!bad(p => { p.data.room.ch.FL.gain = 'x'; }).ok, 'gain string');
  ok(!bad(p => { p.data.room.ch.FL.gain = 400; }).ok, 'gain range');
  ok(!bad(p => { p.data.room.ch.FL.delay = -1; }).ok, 'delay negative');
  ok(!bad(p => { p.data.room.ch.FL.delay = NaN; }).ok, 'NaN');
  ok(!bad(p => { p.data.room.ch.XX = {}; }).ok, 'unknown channel');
  ok(!bad(p => { p.data.room.ch.FL.corr.filters[0].fc = 0; }).ok, 'fc 0');
  ok(!bad(p => { p.data.room.ch.FL.corr.filters = new Array(100).fill(filt(100, 1)); }).ok, 'too many filters');
  ok(!bad(p => { p.data.layout = '9.9'; }).ok, 'layout');
  ok(!bad(p => { p.data.v = 2; }).ok, 'version');
  ok(!bad(p => { p.data.room.target = [[10]]; }).ok, 'target shape');
  ok(!bad(p => { p.data.room.bogus = 1; }).ok, 'unknown room key');
  ok(!bad(p => { p.data.fx = { on: true, eq: [1, 2], preamp: 0 }; }).ok, 'fx eq length');
  ok(!bad(p => { p.name = ''; }).ok, 'name');
  ok(!bad(p => { p.id = '../x'; }).ok, 'id');
  ok(!validateProfileData(null).ok && !validateProfileData([]).ok && !validateProfileData('x').ok);
});
test('apply refuses an invalid profile and changes nothing', () => {
  const T = defaultState(), p = good(); p.data.room.ch.FL.gain = 'x'; const before = JSON.stringify(T);
  const r = applyProfile(T, p); ok(!r.applied); eq(JSON.stringify(T), before);
});

suite('import / export / manage');
test('export then import into another state: same data, fresh ids, unique names', () => {
  const S = tuned(); S.profiles = [makeProfile(S, 'A'), makeProfile(S, 'B', { includeFx: true })];
  const j = JSON.parse(JSON.stringify(exportProfiles(S.profiles)));
  const T = defaultState(); T.profiles = [makeProfile(T, 'A')];
  const r = importProfiles(T, j); ok(r.ok); eq(r.profiles.length, 2); eq(r.skipped.length, 0);
  eq(r.profiles.map(p => p.name), ['A 2', 'B']);
  ok(r.profiles.every(p => !S.profiles.some(q => q.id === p.id) && validateProfile(p).ok));
  eq(r.profiles[1].data, S.profiles[1].data);
});
test('import: one bare profile; junk; newer version; invalid entries skipped', () => {
  const T = defaultState(), p = good();
  ok(importProfiles(T, p).ok);
  eq(importProfiles(T, { hello: 1 }).error, 'not-profiles'); eq(importProfiles(T, [1, 2]).error, 'not-profiles'); eq(importProfiles(T, null).error, 'not-profiles');
  eq(importProfiles(T, { kind: 'fono-profiles', v: 99, profiles: [p] }).error, 'newer-version');
  const evil = good(); evil.data.room.ch.FL.delay = 1e9; evil.name = 'evil';
  const r = importProfiles(T, { kind: 'fono-profiles', v: 1, profiles: [evil, p, { name: 'x' }] });
  eq(r.profiles.length, 1); eq(r.skipped.length, 2);
  eq(importProfiles(T, { kind: 'fono-profiles', v: 1, profiles: [evil] }).error, 'nothing-valid');
});
test('import: control characters / long names are cleaned; the total is capped', () => {
  const T = defaultState(), p = good(); p.name = 'a\u0000b\n' + 'x'.repeat(200);
  const r = importProfiles(T, p); ok(r.profiles[0].name.length <= 60 && !/[\u0000-\u001f]/.test(r.profiles[0].name));
  const many = Array.from({ length: MAX_PROFILES + 10 }, (_, i) => ({ ...good(), name: 'n' + i }));
  ok(importProfiles(T, { kind: 'fono-profiles', v: 1, profiles: many }).profiles.length <= MAX_PROFILES);
});
test('rename and delete (delete clears A/B)', () => {
  const S = defaultState(); S.profiles = [makeProfile(S, 'A'), makeProfile(S, 'B')]; S.ui.ab = { a: S.profiles[0].id, b: S.profiles[1].id, cur: 'a' };
  ok(renameProfile(S, S.profiles[0].id, '  New   name ')); eq(S.profiles[0].name, 'New name'); ok(!renameProfile(S, 'nope', 'x'));
  ok(deleteProfile(S, S.profiles[0].id)); eq(S.profiles.length, 1); eq(S.ui.ab.a, ''); eq(S.ui.ab.cur, ''); ok(!deleteProfile(S, 'nope'));
});

suite('A/B');
test('abToggle alternates between two profiles and applies them', () => {
  const S = defaultState(); S.room.layout = '2.0';
  S.room.ch.FL.gain = -1; const a = makeProfile(S, 'A'); S.room.ch.FL.gain = -5; const b = makeProfile(S, 'B');
  S.profiles = [a, b]; eq(abNext(S), null);
  S.ui.ab = { a: a.id, b: b.id, cur: '' };
  let r = abToggle(S); ok(r.ok); eq(r.which, 'a'); eq(S.room.ch.FL.gain, -1);
  r = abToggle(S); eq(r.which, 'b'); eq(S.room.ch.FL.gain, -5);
  r = abToggle(S); eq(r.which, 'a'); eq(S.room.ch.FL.gain, -1);
});
test('abToggle refuses when not set up, same profile twice, or a profile of another layout', () => {
  const S = defaultState(), a = makeProfile(S, 'A'); S.profiles = [a];
  eq(abToggle(S).why, 'not-set'); S.ui.ab = { a: a.id, b: a.id, cur: '' }; eq(abToggle(S).why, 'not-set'); S.ui.ab = { a: a.id, b: 'gone', cur: '' }; eq(abToggle(S).why, 'not-set');
  const b = makeProfile(S, 'B'); b.data.layout = '2.0'; S.profiles = [a, b]; S.ui.ab = { a: a.id, b: b.id, cur: 'a' };
  eq(abToggle(S).why, 'layout'); eq(S.ui.ab.cur, 'a');
});
test('defaults: S.profiles = [], update check on', () => { const S = defaultState(); eq(S.profiles, []); eq(S.ui.updateCheck, true); eq(S.ui.ab, { a: '', b: '', cur: '' }); });

done('profiles.test.mjs');
