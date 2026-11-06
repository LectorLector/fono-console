// Task A1: subwoofer layouts, bass-management config, and the sub delay / polarity search.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { genConfig, activeSpk, mainSpk, subSpk, layoutOf, LAYOUTS, hasRear, layoutSubs, headroom } from '../web/js/eapo.js';
import { alignSubs, responseAt, lr4 } from '../web/js/subalign.js';
import { demoMeasurements } from '../web/js/demoroom.js';

const SR = 48000;
// ---------------------------------------------------------------- synthetic measurements
/** Impulse response with a unit impulse (sign `sign`) at the peak position; arrivalMs is relative to the FL timing reference. */
const delta = (arrivalMs, sign = 1, n = 0.5 * SR, pre = 240) => { const ir = new Float32Array(n); ir[pre] = sign; return { ir, sr: SR, irPeak: pre, arrivalMs }; };
/** RBJ biquad in the time domain (what EQ APO runs), Q 0.7071. */
function biq(x, kind, fc) {
  const w0 = 2 * Math.PI * fc / SR, c = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
  const b0 = kind === 'LP' ? (1 - c) / 2 : (1 + c) / 2, b1 = kind === 'LP' ? 1 - c : -(1 + c), a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = new Float64Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}
const through = (x, kind, fc) => biq(biq(x, kind, fc), kind, fc);   // LR4
const shifted = (x, samples) => { const y = new Float64Array(x.length); for (let i = 0; i < x.length; i++) if (i - samples >= 0 && i - samples < x.length) y[i] = x[i - samples]; return y; };

suite('layouts');
test('layout ids, rear and sub counts', () => {
  eq(LAYOUTS, ['hp', '2.0', '2.1', '2.2', '4.0', '4.1', '4.2']);
  const want = { hp: [['FL', 'FR'], 0], '2.0': [['FL', 'FR'], 0], '2.1': [['FL', 'FR', 'SW1'], 1], '2.2': [['FL', 'FR', 'SW1', 'SW2'], 2], '4.0': [['FL', 'FR', 'SL', 'SR'], 0], '4.1': [['FL', 'FR', 'SL', 'SR', 'SW1'], 1], '4.2': [['FL', 'FR', 'SL', 'SR', 'SW1', 'SW2'], 2] };
  for (const [id, [act, n]] of Object.entries(want)) {
    const s = defaultState(); s.room.layout = id;
    eq(activeSpk(s), act, id); eq(subSpk(s).length, n, id); eq(layoutSubs(id), n, id); eq(hasRear(s), id.startsWith('4'), id);
    eq(mainSpk(s), act.filter(k => !k.startsWith('SW')), id);
  }
  const s = defaultState(); s.room.layout = '9.9'; eq(layoutOf(s), '4.0');
});
test('default channel map: SW1 -> LFE, SW2 -> C', () => { const s = defaultState(); eq([s.room.map.SW1, s.room.map.SW2], ['LFE', 'C']); eq(s.room.sub.xover, 80); eq(s.room.sub.slope, 24); eq(s.room.sub.mono, true); eq(s.room.sub.mainsFull, false); });

suite('bass management config');
const cfgOf = (layout, mode, tweak) => { const s = defaultState(); s.dev.cm = '{cm}'; s.dev.spark = '{dac}'; s.room.layout = layout; s.room.mode = mode; tweak?.(s); return genConfig(s, {}); };
const multi = t => t.slice(t.indexOf('Device: {cm}'), t.indexOf('Device: all', t.indexOf('Device: {cm}') + 5));
const section = (t, ch) => { const i = t.indexOf(`Channel: ${ch}\n`); return i < 0 ? '' : t.slice(i, t.indexOf('\nChannel:', i + 5) < 0 ? undefined : t.indexOf('\nChannel:', i + 5)); };
test('2.1 stereo: sub fed from (L+R)/2, LR4 low-pass on LFE, LR4 high-pass on the mains', () => {
  const t = multi(cfgOf('2.1', 'stereo'));
  ok(/Copy: LFE=0\.5\*L\+0\.5\*R/.test(t), t);
  ok(!/Copy: .*C=0\.5/.test(t), 'only one sub');
  eq((section(t, 'LFE').match(/Filter: ON LP Fc 80 Hz Q 0\.707/g) || []).length, 2, 'LR4 = two sections');
  for (const ch of ['L', 'R']) eq((section(t, ch).match(/Filter: ON HP Fc 80 Hz Q 0\.707/g) || []).length, 2, 'mains HP ' + ch);
  ok(t.indexOf('Copy: LFE=') < t.indexOf('Channel: L\n'), 'sub feed is taken before the per-speaker stages');
});
test('2.2: both subs get the same mono signal; mono off sends L / R', () => {
  const t = multi(cfgOf('2.2', 'stereo'));
  ok(/Copy: LFE=0\.5\*L\+0\.5\*R C=0\.5\*L\+0\.5\*R/.test(t), t);
  const u = multi(cfgOf('2.2', 'stereo', s => { s.room.sub.mono = false; }));
  ok(/Copy: LFE=L C=R/.test(u), u);
});
test('mains full range, custom crossover, per-sub and global gain / delay / polarity', () => {
  const t = multi(cfgOf('2.1', 'stereo', s => { s.room.sub.mainsFull = true; s.room.sub.xover = 100; s.room.sub.gain = -3; s.room.sub.delay = 2; s.room.sub.invert = true; s.room.ch.SW1.gain = -1; s.room.ch.SW1.delay = 1.5; }));
  ok(!/Filter: ON HP/.test(t), 'no mains high-pass');
  const sw = section(t, 'LFE');
  ok(/Preamp: -4 dB/.test(sw) && /Delay: 3\.5 ms/.test(sw) && /Copy: LFE=-1\*LFE/.test(sw) && /LP Fc 100 Hz/.test(sw), sw);
  const inv = multi(cfgOf('2.1', 'stereo', s => { s.room.sub.invert = true; s.room.ch.SW1.invert = true; }));
  ok(!/Copy: LFE=-1\*LFE/.test(inv), 'global and per-sub polarity cancel');
});
test('4.1 quadA / quadB: rears are high-passed like the mains and the rear bass reinforcement is replaced by the sub', () => {
  for (const mode of ['quadA', 'quadB']) {
    const t = multi(cfgOf('4.1', mode));
    ok(/Copy: LFE=0\.5/.test(t), mode);
    for (const ch of ['L', 'R', 'SL', 'SR']) eq((section(t, ch).match(/HP Fc 80 Hz/g) || []).length, 2, `${mode} ${ch}`);
    ok(!/LP Fc 100 Hz/.test(t), 'no rear low-pass in quadB when a sub exists');
  }
  const b = multi(cfgOf('4.0', 'quadB')); ok(/Channel: SL\n[^]*LP Fc 100 Hz/.test(b), 'quadB without a sub is unchanged');
});
test('the stereo DAC block and layouts without subs get no bass management; ART mutes the subs', () => {
  const t = cfgOf('2.1', 'stereo'), dac = t.slice(t.indexOf('Device: {dac}'), t.indexOf('Device: {cm}'));
  ok(!/LFE|HP Fc|LP Fc/.test(dac), 'DAC block');
  for (const l of ['2.0', '4.0', 'hp']) ok(!/LFE|HP Fc 80/.test(multi(cfgOf(l, 'stereo'))), l);
  const art = multi((() => { const s = defaultState(); s.dev.cm = '{cm}'; s.room.layout = '4.2'; s.room.mode = 'art'; return genConfig(s, { art: { rates: [48000], preampDb: -3 } }); })());
  ok(/Copy: LFE=0\.0 C=0\.0/.test(art) && !/HP Fc 80/.test(art), art);
});
test('measure / identify route to the subs; measure of a mains channel keeps subs silent', () => {
  const m = multi(cfgOf('2.2', 'measure', s => { s.room.measureTarget = 'SW2'; s.room.measureRaw = true; }));
  ok(/Copy: L=R R=0\.0 LFE=0\.0 C=L/.test(m) || /L=R R=0\.0 SL=0\.0 SR=0\.0 LFE=0\.0 C=L/.test(m), m);
  const i = multi(cfgOf('2.1', 'identify', s => { s.room.identify = 'SW1'; }));
  ok(/LFE=L/.test(i) && /L=0\.0 R=0\.0/.test(i), i);
  const fl = multi(cfgOf('2.1', 'measure', s => { s.room.measureTarget = 'FL'; }));
  ok(/LFE=0\.0/.test(fl), fl);
  const none = multi(cfgOf('2.0', 'measure')); ok(!/LFE/.test(none), 'no sub, no LFE copy');
});
test('whole matrix: layouts x modes x options are ASCII, balanced and valid', () => {
  const okLine = /^(Device|Channel|Preamp|Filter( \d+)?|Copy|Delay|Convolution|If|ElseIf|Else|EndIf|Include|Stage):/;
  let n = 0;
  for (const layout of LAYOUTS) for (const mode of ['stereo', 'quadA', 'quadB', 'art', 'measure', 'identify'])
    for (const opt of [{}, { mainsFull: true }, { mono: false }, { invert: true, delay: 4, gain: -6, xover: 120 }])
      for (const corr of [false, true]) {
        const t = cfgOf(layout, mode, s => {
          Object.assign(s.room.sub, opt); s.room.measureTarget = 'SW1'; s.room.identify = 'SW2'; s.room.measureRaw = !corr;
          if (corr) for (const k of ['FL', 'SW1']) s.room.ch[k].corr = { name: 'x', filters: [{ type: 'PK', fc: 45, gain: -6, q: 5 }] };
        });
        n++;
        ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(t), 'non-ascii'); ok(!/NaN|undefined|null|Infinity/.test(t), 'bad value');
        for (const l of t.split('\n').filter(x => x.trim() && !x.startsWith('#'))) ok(okLine.test(l), `${layout}/${mode}: ${l}`);
        for (const mm of t.matchAll(/Preamp: (-?[\d.]+) dB/g)) ok(+mm[1] <= 0.01, `${layout}/${mode}: positive preamp`);
      }
  ok(n === 7 * 6 * 4 * 2);
});
test('headroom counts the sub gain', () => {
  const s = defaultState(); s.room.layout = '2.1'; s.room.sub.gain = 6; s.room.mode = 'stereo';
  const a = headroom(s); s.room.sub.gain = 0; ok(a >= headroom(s) + 5.5, `${a}`);
});

suite('sub alignment: complex response');
test('responseAt keeps absolute time: a delta at t gives magnitude 1 and phase -w t', () => {
  const m = delta(3.2, 1), t = 3.2e-3, H = responseAt(m, [40, 80, 160]);
  [40, 80, 160].forEach((f, i) => { near(Math.hypot(...H[i]), 1, 2e-3); const ph = Math.atan2(H[i][1], H[i][0]), want = -2 * Math.PI * f * t, d = Math.atan2(Math.sin(ph - want), Math.cos(ph - want)); near(d, 0, 2e-3, f + ' Hz phase'); });
});
test('LR4 high-pass + low-pass sum is flat (all-pass) and -6 dB at the crossover', () => {
  for (const f of [30, 80, 200, 1000]) { const a = lr4('LP', 80, f, SR), b = lr4('HP', 80, f, SR); near(Math.hypot(a[0] + b[0], a[1] + b[1]), 1, 1e-3, f + ' Hz'); }
  near(20 * Math.log10(Math.hypot(...lr4('LP', 80, 80, SR))), -6.02, 0.1);
});

suite('sub alignment: search');
const mainsOf = (n = 1) => [{ list: Array.from({ length: n }, () => delta(0)), gainDb: 0, delayMs: 0 }, { list: Array.from({ length: n }, () => delta(0)), gainDb: 0, delayMs: 0 }];
test('pure-delay subs: the true delay is found exactly (sub late -> mains delayed, sub early -> sub delayed)', () => {
  for (const [arr, want] of [[3.2, -3.2], [-2.0, 2.0], [0, 0], [7.7, -7.7], [-9.3, 9.3], [1.0, -1.0]]) {
    const r = alignSubs({ mains: mainsOf(), subs: [{ list: [delta(arr)], gainDb: 0 }], xover: 80 });
    near(r.subs[0].delayMs, want, 0.0501, `arrival ${arr}`); eq(r.subs[0].invert, false, `arrival ${arr}`);
    ok(r.subs[0].score >= r.subs[0].scoreBefore - 1e-9, 'never worse than delay 0');
  }
});
test('inverted sub (wiring) is detected', () => {
  for (const [arr, want] of [[1.5, -1.5], [-4.1, 4.1], [0, 0]]) {
    const r = alignSubs({ mains: mainsOf(), subs: [{ list: [delta(arr, -1)], gainDb: 0 }], xover: 80 });
    eq(r.subs[0].invert, true, `arrival ${arr}`); near(r.subs[0].delayMs, want, 0.0501, `arrival ${arr}`);
  }
});
test('works at other crossovers and with unequal levels, over several positions', () => {
  for (const xover of [50, 80, 120]) {
    const r = alignSubs({ mains: [{ list: [delta(0), delta(0.2), delta(-0.1)], gainDb: -3 }], subs: [{ list: [delta(2.4, -1), delta(2.6, -1), delta(2.3, -1)], gainDb: 4 }], xover });
    eq(r.subs[0].invert, true, 'x' + xover); near(r.subs[0].delayMs, -2.4, 0.3, 'x' + xover);
    ok(r.subs[0].score > r.subs[0].scoreBefore, 'improves');
  }
});
test('gain of alignment: a polarity-inverted sub cancels at the crossover before and sums after', () => {
  const r = alignSubs({ mains: mainsOf(), subs: [{ list: [delta(0, -1)], gainDb: 0 }], xover: 80 });
  const i = r.f.findIndex(f => f >= 80);
  ok(r.before.db[i] < r.after.db[i] - 8, `before ${r.before.db[i].toFixed(1)} dB after ${r.after.db[i].toFixed(1)} dB at ${r.f[i].toFixed(0)} Hz`);
  ok(r.gainDb > 4, 'mean gain ' + r.gainDb);
});
test('two subs are aligned one after the other; negative delays become a shift of the mains', () => {
  const r = alignSubs({ mains: mainsOf(), subs: [{ list: [delta(3.2)], gainDb: 0 }, { list: [delta(1.0)], gainDb: 0 }], xover: 80 });
  near(r.subs[0].delayMs, -3.2, 0.0501); near(r.subs[1].delayMs, -1.0, 0.0501); near(r.shiftMs, 3.2, 0.0501);
  const r2 = alignSubs({ mains: mainsOf(), subs: [{ list: [delta(-2)], gainDb: 0 }, { list: [delta(1)], gainDb: 0 }], xover: 80 });
  near(r2.subs[0].delayMs, 2, 0.0501); near(r2.subs[1].delayMs, -1, 0.0501); near(r2.shiftMs, 1, 0.0501);
});
test('model agrees with a time-domain simulation of the real filter chain and finds its optimum (band-limited sub with its own phase)', () => {
  // sub measured through its own 2nd-order low-pass at 110 Hz (group delay) and a 25 Hz high-pass, arriving 4.4 ms before the mains, inverted
  const mk = (arr) => { let x = new Float64Array(0.5 * SR); x[240] = -1; x = biq(biq(x, 'LP', 110), 'HP', 25); return { ir: Float32Array.from(x), sr: SR, irPeak: 240, arrivalMs: arr }; };
  const subM = mk(-4.4), mainM = delta(0), xover = 80;
  const r = alignSubs({ mains: [{ list: [mainM], gainDb: 0 }, { list: [mainM], gainDb: 0 }], subs: [{ list: [subM], gainDb: 0 }], xover, maxMs: 10, stepMs: 0.1 });
  // time-domain score for one candidate: mains through LR4 HP, sub through LR4 LP, delayed by tau / inverted, both placed at their absolute time, summed, mean |FFT| over 0.5..2 x xover
  const freqs = Array.from({ length: 49 }, (_, i) => xover * 0.5 * Math.pow(4, i / 48));
  const tdScore = (tau, pol) => {
    const N = 0.5 * SR, a = new Float64Array(N), b = new Float64Array(N), off = 20 * SR / 1000;   // 20 ms offset so negative delays stay causal
    a[240] = 1; b[240] = 1;
    const mh = shifted(through(a, 'HP', xover), Math.round(off)), sb = through(Float64Array.from(subM.ir), 'LP', xover);
    const sh = shifted(sb, Math.round(off + (subM.arrivalMs + tau) / 1000 * SR));
    const sum = new Float32Array(N); for (let i = 0; i < N; i++) sum[i] = mh[i] * 2 + pol * sh[i];   // two mains
    const H = responseAt({ ir: sum, sr: SR, irPeak: 0, arrivalMs: 0 }, freqs, 400);
    return H.reduce((s, v) => s + Math.hypot(...v), 0) / freqs.length;
  };
  // the model uses the two mains as two separate speakers in phase: sum = 2 * mains
  let bestTd = { s: -1 };
  for (let k = -100; k <= 100; k += 1) for (const pol of [1, -1]) { const s = tdScore(k * 0.1, pol); if (s > bestTd.s) bestTd = { s, tau: k * 0.1, pol }; }
  near(r.subs[0].delayMs, bestTd.tau, 0.0501, 'delay vs brute force'); eq(r.subs[0].invert, bestTd.pol < 0, 'polarity vs brute force');
  near(r.subs[0].score, bestTd.s, bestTd.s * 0.02, 'model score vs time-domain score');
  ok(r.subs[0].invert === true, 'true polarity (inverted) found');
});
test('demo room: sub measurements exist for sub layouts only and align to a finite, improving result', () => {
  eq(Object.keys(demoMeasurements()).sort(), ['FL', 'FR', 'SL', 'SR']);
  const d = demoMeasurements({ subs: 2 }); ok(d.SW1 && d.SW2 && d.SW1.length === 15, 'SW1 / SW2 at 15 positions');
  eq(Object.keys(demoMeasurements({ subs: 1 })).sort(), ['FL', 'FR', 'SL', 'SR', 'SW1']);
  const r = alignSubs({ mains: ['FL', 'FR'].map(k => ({ list: d[k], gainDb: 0 })), subs: ['SW1', 'SW2'].map(k => ({ list: d[k], gainDb: 0 })), xover: 80 });
  for (const x of r.subs) ok(Number.isFinite(x.delayMs) && x.score >= x.scoreBefore - 1e-9, JSON.stringify(x));
  ok(Number.isFinite(r.gainDb) && r.gainDb > -0.01, 'gain ' + r.gainDb);
});

done('subwoofer.test.mjs');
