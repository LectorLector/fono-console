// Room diagnosis (phase 6 task C): every rule with synthetic inputs and its thresholds, ranking, report export, and the seat heatmap.
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { diagnose, TH, inputFromResults, reportHtml, curveSvg } from '../web/js/diagnose.js';
import * as AC from '../web/js/acoustics.js';
globalThis.__acoustics = AC;
import { seatHeatmap, seatSearch, heatAt, bestArea } from '../web/js/acoustics.js';
import { demoWideMeasurements } from '../web/js/demoroom.js';
import { defaultState } from '../web/js/state.js';

const grid = Array.from({ length: 300 }, (_, i) => 15 * Math.pow(1500, i / 299));
/** Flat 0 dB curve with a wide log-Gaussian bump (dev dB at f0). */
const curve = (bumps = []) => ({ f: grid, db: grid.map(f => bumps.reduce((s, [f0, dev, oct = 0.45]) => s + dev * Math.exp(-0.5 * (Math.log2(f / f0) / oct) ** 2), 0)) });
const find = (r, id) => r.find(x => x.id === id);
const dims = { L: 3.5, W: 3, H: 2.6, rt60: 0.4 };
const pos = { seat: [1.75, 1.5], ear: 1.1, FL: [0.35, 0.96, 1], FR: [0.35, 2.04, 1], SL: [3.2, 0.6, 1.9], SR: [3.2, 2.4, 1.9] };
const base = () => ({ dims, pos, chans: { FL: { arrival: 0, polarity: 1, level: -20, snr: 60, curve: curve() }, FR: { arrival: 0, polarity: 1, level: -20, snr: 60, curve: curve() } } });

suite('level / arrival');
test('left-right level thresholds 0.75 / 1.5 / 3 dB', () => {
  for (const [d, s] of [[0.5, 'ok'], [0.8, 'low'], [1.6, 'mid'], [3.1, 'high']]) {
    const i = base(); i.chans.FR.level = -20 - d;
    eq(find(diagnose(i), 'lr-level').severity, s, `${d} dB`);
  }
  const i = base(); i.chans.FR.level = -23.5; const it = find(diagnose(i), 'lr-level');
  eq(it.data.louder, 'FL'); ok(it.action.includes('3.5'), 'action quotes the dB');
});
test('rear pair is checked too and the worse pair wins', () => {
  const i = base(); i.chans.SL = { level: -26, arrival: 0 }; i.chans.SR = { level: -20, arrival: 0 };
  const it = find(diagnose(i), 'lr-level'); eq(it.data.a, 'SL'); eq(it.severity, 'high');
});
test('arrival difference thresholds 0.08 / 0.2 / 0.5 ms, with a distance in cm', () => {
  for (const [d, s] of [[0.05, 'ok'], [0.1, 'low'], [0.3, 'mid'], [0.6, 'high']]) {
    const i = base(); i.chans.FR.arrival = d; eq(find(diagnose(i), 'lr-arrival').severity, s, `${d} ms`);
  }
  const i = base(); i.chans.FR.arrival = 1; const it = find(diagnose(i), 'lr-arrival');
  eq(it.data.early, 'FL'); eq(it.data.cm, 34);
});

suite('polarity');
test('a reversed speaker is high, all positive is ok', () => {
  eq(find(diagnose(base()), 'polarity').severity, 'ok');
  const i = base(); i.chans.FR.polarity = -1; const it = find(diagnose(i), 'polarity');
  eq(it.severity, 'high'); eq(it.data.bad, ['FR']);
});

suite('modes');
test('peak and dip severities follow 3/5/8 and 4/6/10 dB', () => {
  for (const [dev, s] of [[1.5, 'ok'], [4.5, 'low'], [7, 'mid'], [11, 'high']]) {
    const i = base(); i.chans.FL.curve = curve([[63, dev, 0.5]]);
    const it = find(diagnose(i), 'mode-peak'); eq(it.severity, s, `peak ${dev}`); ok(Math.abs(it.data.f - 63) <= 8, 'frequency found');
  }
  for (const [dev, s] of [[-2, 'ok'], [-5, 'low'], [-8, 'mid'], [-13, 'high']]) {
    const i = base(); i.chans.FR.curve = curve([[90, dev, 0.5]]);
    eq(find(diagnose(i), 'mode-dip').severity, s, `dip ${dev}`);
  }
});
test('peak is matched to the nearest room mode and says where the ear is', () => {
  const f1 = 343 / 2 / dims.L;   // first length mode, 49 Hz: the ear is at L/2 = a node
  const i = base(); i.chans.FL.curve = curve([[f1, 12, 0.3]]);
  const it = find(diagnose(i), 'mode-peak');
  eq(it.data.mode, '1,0,0'); near(it.data.pressure, 0, 0.01); ok(it.detail.includes('節點'), 'node wording');
  i.pos = { ...pos, seat: [0.5, 1.5] }; const it2 = find(diagnose(i), 'mode-peak');
  ok(Math.abs(it2.data.pressure) > TH.antiP, 'near the wall = antinode'); ok(it2.detail.includes('波腹'));
});
test('seat: a bad seat position is flagged with the search result, the best one is ok', () => {
  const bad = find(diagnose(base()), 'seat');
  const s = seatSearch([1.75, 1.5, 1.1], [pos.FL, pos.FR], dims, dims.rt60);
  const gain = 1 - s.best.v / s.here.v;
  eq(bad.severity === 'ok', gain < TH.seatGain[0]); near(bad.data.gain, gain, 0.01);
  const i = base(); i.pos = { ...pos, seat: [s.best.x, 1.5] }; eq(find(diagnose(i), 'seat').severity, 'ok');
});

suite('reflections');
test('only reflections within 6 ms and above -10 dB count; -6 dB is high', () => {
  const mk = rows => { const i = base(); i.chans.FL.refl = rows; return find(diagnose(i), 'refl'); };
  eq(mk([{ ms: 3, db: -12 }, { ms: 8, db: -3 }]).severity, 'ok');
  eq(mk([{ ms: 3, db: -9 }]).severity, 'mid'); eq(mk([{ ms: 3, db: -5 }]).severity, 'high');
  eq(mk([{ ms: 6.5, db: -4 }]).severity, 'ok');
  eq(mk([{ ms: 6, db: -10 }]).severity, 'ok');   // exactly -10 is not "stronger than"
});
test('the reflection is matched to a wall and gets a mirror point', () => {
  const i = base(); i.chans.FL.refl = [{ ms: 0, db: 0 }];
  const { firstReflections } = globalThis.__acoustics;
  const left = firstReflections(pos.FL, [pos.seat[0], pos.seat[1], pos.ear], dims).find(r => r.id === 'left');
  i.chans.FL.refl = [{ ms: left.ms, db: -7 }];
  const it = find(diagnose(i), 'refl');
  eq(it.data.rows[0].surface, '左牆'); near(it.data.rows[0].pt[1], 0, 0.01); near(it.data.rows[0].pt[0], left.pt[0], 0.01);
  ok(it.action.includes('吸音板'));
});

suite('snr / clipping');
test('SNR thresholds 40 / 30 / 20 dB', () => {
  for (const [v, s] of [[45, 'ok'], [35, 'low'], [25, 'mid'], [15, 'high']]) {
    const i = base(); i.chans.FR.snr = v; eq(find(diagnose(i), 'snr').severity, s, `${v} dB`);
  }
  const i = base(); i.chans.FR.snr = 22; eq(find(diagnose(i), 'snr').data.rows.find(r => r.snr === 22).ch, 'FR');
});
test('clipping above -1 dBFS', () => {
  const i = base(); i.chans.FL.peakDb = -3; eq(find(diagnose(i), 'clip').severity, 'ok');
  i.chans.FL.peakDb = -0.5; eq(find(diagnose(i), 'clip').severity, 'mid');
});

suite('sub / mains');
test('no sub measured, no sub item', () => ok(!find(diagnose(base()), 'sub')));
test('sub level and phase at the crossover', () => {
  const mk = (lvl, dt, x = 80) => {
    const i = base(); i.xover = x;
    i.chans.FL.curve = curve([[x, 0]]); i.chans.FR.curve = curve([[x, 0]]);
    i.chans.SW1 = { arrival: dt, polarity: 1, level: -20, curve: { f: grid, db: grid.map(() => lvl) } };
    return find(diagnose(i), 'sub');
  };
  eq(mk(0.5, 0).severity, 'ok');
  eq(mk(2, 0).severity, 'low'); eq(mk(4, 0).severity, 'mid'); eq(mk(7, 0).severity, 'high');
  eq(mk(-7, 0).data.levelDb < 0, true);
  // 80 Hz: 1 ms = 28.8 deg, 2.2 ms = 63 deg, 4 ms = 115 deg
  eq(mk(0, 0.5).severity, 'ok'); eq(mk(0, 1.2).severity, 'low'); eq(mk(0, 2.2).severity, 'mid'); eq(mk(0, 4).severity, 'high');
  near(mk(0, 2.2).data.phaseDeg, 63, 1);
});

suite('decay');
test('band T30 relative to the median: 1.3 / 1.5 / 2', () => {
  const mk = t125 => { const i = base(); i.chans.FL.decay = [63, 125, 250, 500, 1000, 2000].map(fc => ({ fc, t30: fc === 125 ? t125 : 0.4 })); return find(diagnose(i), 'decay'); };
  eq(mk(0.45).severity, 'ok'); eq(mk(0.55).severity, 'low'); eq(mk(0.65).severity, 'mid'); eq(mk(0.85).severity, 'high');
  const it = mk(0.85); eq(it.data.rows.find(r => r.fc === 125).t, 0.85); ok(it.action.includes('低頻'));
  const i = base(); i.chans.FL.decay = [250, 500, 1000, 2000].map(fc => ({ fc, t30: fc === 2000 ? 1 : 0.4 })); ok(find(diagnose(i), 'decay').action.includes('窗簾'));
});
test('t20 is used when t30 has too little range', () => {
  const i = base(); i.chans.FL.decay = [125, 250, 500, 1000].map(fc => ({ fc, t30: NaN, t20: fc === 125 ? 1 : 0.4 }));
  eq(find(diagnose(i), 'decay').severity, 'high');
});

suite('correction limits');
test('full filter budget, depth limit and residual', () => {
  const f = n => Array.from({ length: n }, () => ({ gain: -3 }));
  const mk = eq => { const i = base(); i.chans.FL.eq = eq; i.maxFilters = 8; return find(diagnose(i), 'limits'); };
  eq(mk({ filters: f(5), rmsAfter: 1 }).severity, 'ok');
  eq(mk({ filters: f(8), rmsAfter: 1 }).severity, 'mid');
  eq(mk({ filters: [{ gain: -15 }], rmsAfter: 1 }).severity, 'mid');
  eq(mk({ filters: f(3), rmsAfter: 3.2 }).severity, 'mid');
  eq(mk({ filters: f(3), rmsAfter: 4.6 }).severity, 'high');
});

suite('ranking');
test('sorted high -> ok, magnitude breaks ties, rules without data are absent', () => {
  const i = base(); i.chans.FR.polarity = -1; i.chans.FR.level = -21; i.chans.FR.arrival = 0.3;
  const r = diagnose(i), order = ['high', 'mid', 'low', 'ok'];
  for (let k = 1; k < r.length; k++) ok(order.indexOf(r[k - 1].severity) <= order.indexOf(r[k].severity), 'order');
  eq(r[0].id, 'polarity'); ok(!find(r, 'decay') && !find(r, 'limits') && !find(r, 'sub') && !find(r, 'refl'));
  ok(r.every(x => x.id && x.title && x.detail != null && x.action != null && x.data), 'shape');
  eq(diagnose({}).length, 0);
});
test('real-looking demo room: inputFromResults -> diagnose finds the demo reflections', () => {
  const S = defaultState(); const p = { ...pos };
  const res = demoWideMeasurements(S.dims, p);
  const r = diagnose(inputFromResults(res, S, p, { eq: false }));
  ok(find(r, 'refl') && find(r, 'decay') && find(r, 'lr-level'), 'rules ran');
  ok(find(r, 'refl').severity !== 'ok', 'demo reflections are around -7 dB');
});

suite('report');
test('self-contained HTML with every item and inline SVG curves', () => {
  const i = base(); i.chans.FR.polarity = -1; const items = diagnose(i);
  const html = reportHtml(items, { date: '2026-01-01', dims, curves: [{ name: 'FL', f: grid, db: grid.map(() => -20) }, { name: 'FR', f: grid, db: grid.map(() => -22) }],
    heat: { map: seatHeatmap([pos.FL, pos.FR], dims, 0.4), seat: pos.seat } });
  ok(html.startsWith('<!doctype html>') && html.includes('<svg') && (html.match(/<svg/g) || []).length === 2, 'two svgs');
  for (const x of items) ok(html.includes(x.title.replace(/&/g, '&amp;')) || html.includes(x.title), x.id);
  ok(!/<script|https?:\/\//.test(html.replaceAll('http://www.w3.org/2000/svg', '')), 'no scripts or external links');
  ok(curveSvg([{ name: 'a', f: grid, db: grid.map(() => 0) }]).includes('polyline'));
  eq(reportHtml(items, { t: s => s.toUpperCase() }).includes('<H3>'), false);
});

suite('seat heatmap');
test('symmetric setup gives a symmetric map (left-right mirror)', () => {
  const m = seatHeatmap([pos.FL, pos.FR], dims, 0.4, { z: 1.1 });
  for (let ix = 0; ix < m.nx; ix += 7) for (let iy = 0; iy < m.ny; iy++) {
    const a = m.v[ix * m.ny + iy], b = m.v[ix * m.ny + (m.ny - 1 - iy)];
    near(a / b, 1, 1e-8, `ix ${ix} iy ${iy}`);
  }
});
test('values equal the seat-suggestion search along the room length; its minimum is the map value at the same place', () => {
  const m = seatHeatmap([pos.FL, pos.FR], dims, dims.rt60, { z: 1.1 }), s = seatSearch([1.75, 1.5, 1.1], [pos.FL, pos.FR], dims, dims.rt60);
  const iy = Math.round((1.5 - m.y0) / m.step);
  for (const r of s.rows) { const ix = Math.round((r.x - m.x0) / m.step); near(m.v[ix * m.ny + iy] / r.v, 1, 1e-9, `x ${r.x}`); near(heatAt(m, r.x, 1.5) / r.v, 1, 1e-6, 'bilinear'); }
  const best = Math.min(...s.rows.map(r => m.v[Math.round((r.x - m.x0) / m.step) * m.ny + iy]));
  near(best / s.best.v, 1, 1e-9);
  ok(m.min <= s.best.v * (1 + 1e-9), 'global minimum is at most the line minimum');
  near(Math.sqrt(m.best.v), Math.sqrt(m.min), 1e-12);
  const area = bestArea(m); ok(area[m.best.i] === 1 && area.reduce((a, b) => a + b, 0) < m.v.length * 0.5, 'best area is a small region around the minimum');
});
test('5 x 4 m room at 5 cm takes < 200 ms', () => {
  const big = { L: 5, W: 4, H: 2.6 }, src = [[0.4, 1.3, 1], [0.4, 2.7, 1]];
  seatHeatmap(src, big, 0.4, { z: 1.1 });   // warm up the JIT
  const ts = Array.from({ length: 3 }, () => { const t = performance.now(); const m = seatHeatmap(src, big, 0.4, { z: 1.1 }); ok(m.nx * m.ny > 5000, 'grid size'); return performance.now() - t; });
  console.log('  heatmap 5x4 m @5 cm: ' + ts.map(v => v.toFixed(0)).join(', ') + ' ms');
  ok(Math.min(...ts) < 200, `took ${Math.min(...ts)} ms`);
});
test('moving the speakers changes the map (it is not only a function of the room)', () => {
  const a = seatHeatmap([pos.FL, pos.FR], dims, 0.4), b = seatHeatmap([[0.35, 0.5, 1], [0.35, 2.5, 1]], dims, 0.4);
  ok(a.v.some((v, i) => Math.abs(v - b.v[i]) > 0.1));
});
done('diagnose.test.mjs');
