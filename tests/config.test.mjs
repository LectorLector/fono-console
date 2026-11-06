// EQ APO config generator: ASCII, valid directives, balanced If/EndIf, no NaN, never a positive preamp,
// over every mode x layout x feature combination (superset of research/art/cfg-check.mjs section a).
import { test, ok, eq, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { genConfig, headroom } from '../web/js/eapo.js';
import { loudFilters } from '../web/js/iso226.js';
import { configProblems } from './cfgvalidate.mjs';

function validate(name, txt) { const p = configProblems(txt, name); ok(!p.length, p.slice(0, 3).join(' | ')); }
const base = () => { const s = defaultState(); s.dev.cm = '{cm-guid}'; s.dev.spark = '{dac-guid}'; return s; };
const corr = () => ({ name: '耳機 x', filters: [{ type: 'PK', fc: 50, gain: -8, q: 7 }, { type: 'PK', fc: 151, gain: -3, q: 2 }, { type: 'LSC', fc: 400, gain: 2, q: 0.7 }, { type: 'PK', fc: 1200, gain: -2, q: 3 }, { type: 'HSC', fc: 9000, gain: -1.5, q: 0.7 }] });
const ctxFull = { art: { rates: [44100, 48000, 96000, 192000], preampDb: -11.4 }, fir: { rates: [44100, 48000, 96000, 192000], chans: ['FL', 'FR'], latencyMs: 85.33 } };

suite('layout x mode x feature');
let count = 0;
for (const layout of ['hp', '2.0', '4.0'])
  for (const mode of ['stereo', 'quadA', 'quadB', 'art', 'measure', 'identify'])
    for (const hafler of [false, true]) for (const rearLP of [false, true])
      for (const fxon of [true, false]) for (const loud of [false, true]) for (const rev of [false, true]) for (const fir of [false, true]) {
        const s = base();
        Object.assign(s.room, { layout, mode, hafler, rearLP, measureTarget: 'SL', identify: 'SR' });
        s.fx.on = fxon; s.fx.loud = { on: loud, level: 65 }; s.fx.rev.on = rev; s.fx.bass = 3; s.fx.treble = -2; s.fx.width = 1.2; s.fx.balance = 0.3; s.fx.eq = [1, 2, 3, 0, -1, -2, 0, 1, 2, 3];
        s.room.fir.on = fir; s.room.fir.built = fir ? 'x' : '';
        for (const k of ['FL', 'FR', 'SL', 'SR']) { s.room.ch[k].corr = corr(); s.room.ch[k].invert = k === 'SR'; s.room.ch[k].mute = false; }
        const txt = genConfig(s, ctxFull); count++;
        test(`${layout}/${mode}/h${+hafler}/lp${+rearLP}/fx${+fxon}/loud${+loud}/rev${+rev}/fir${+fir}`, () => validate('cfg', txt));
      }
console.log(`  (${count} config combos)`);

suite('devices');
test('no device chosen -> Device: all', () => { const s = defaultState(); s.dev.cm = ''; s.dev.spark = ''; validate('x', genConfig(s)); ok(/Device: all/.test(genConfig(s))); });
test('headphone profile for a third device', () => {
  const s = base(); s.hp.profiles['{bt}'] = { enabled: true, name: 'Test', preamp: -5, filters: [{ type: 'PK', fc: 1000, gain: -3, q: 2 }, { type: 'LSC', fc: 100, gain: 4, q: 0.7 }] };
  const t = genConfig(s, {}); validate('hp', t); ok(t.includes('Device: {bt}'));
});
test('stereo DAC on headphones', () => {
  const s = base(); s.dev.sparkLoad = 'headphones'; s.hp.profiles['{dac-guid}'] = { enabled: true, preamp: -4, filters: [{ type: 'PK', fc: 500, gain: -2, q: 1 }] };
  validate('dac', genConfig(s, {}));
});
test('ASCII even with a non-ASCII profile name', () => {
  const s = base(); s.hp.profiles['{bt}'] = { enabled: true, name: '耳機', preamp: -3, filters: [] };
  validate('name', genConfig(s, {}));
});

suite('loudness');
test('off at/above reference, shelves below', () => {
  eq(loudFilters({ on: false, level: 60 }), []);
  eq(loudFilters({ on: true, level: 83 }), []);
  const f = loudFilters({ on: true, level: 60 });
  eq(f.map(x => x.type), ['LSC', 'HSC']); ok(f[0].gain > 5 && f[1].gain > 0);
});
test('level clamped to 60..83', () => { eq(loudFilters({ on: true, level: 10 }), loudFilters({ on: true, level: 60 })); eq(loudFilters({ on: true, level: 999 }), []); });
test('headroom is a non-negative reserve and covers the loudness boost', () => {
  for (const lv of [60, 70, 80]) { const s = base(); s.fx.loud = { on: true, level: lv }; s.fx.bass = 6; s.fx.treble = 6; s.fx.eq = Array(10).fill(6); const hr = headroom(s); ok(hr >= 6, 'headroom ' + hr); s.fx.loud.on = false; ok(headroom(s) <= hr, 'loudness adds boost'); }
});
done('config');
