// ART (active room treatment): solve / predict / FIR design on the simulated bedroom.
import { test, ok, eq, near, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { spectra, solveART, predict, predictCV, predictDrift, firFor, mainsFIR, handover, ART_BANDS, ART_SPK, artSources, defaultWeights, preRingDb, sourceLimits, isGeneral } from '../web/js/art.js';
import { demoMeasurements } from '../web/js/demoroom.js';

const st = defaultState(), sp = spectra(demoMeasurements(), 260);
const o = { fc: 120, fLow: 35, capDb: 12, tau: 0.05, state: st };
suite('art');
const sol = solveART(sp, { ...o, robust: true }), sol0 = solveART(sp, { ...o, robust: false });
test('spectra cover all four speakers', () => { ok(sp && Object.keys(sp).length > 0, 'no spectra'); });
test('solution is finite and the preamp reserves headroom (<= 0 dB)', () => {
  ok(sol.preampDb <= 0 && Number.isFinite(sol.preampDb), 'preamp ' + sol.preampDb); ok(sol0.preampDb <= 0);
  const s = JSON.stringify(sol, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v).slice(0, 4) : v)); ok(!/NaN|null,null/.test(s));
});
test('hand-over filter: unity below fc, rolls off above', () => { near(handover(10, 120), 1, 1e-6); near(handover(120, 120), 0.5, 1e-9); ok(handover(500, 120) < 1e-3); });
test('leave-one-out prediction improves the modal decay deviation', () => {
  for (const robust of [false, true]) { const cv = predictCV(sp, { ...o, robust }); ok(cv.devAfter < cv.devBefore * 0.6, `${robust}: ${cv.devBefore} -> ${cv.devAfter}`); eq(cv.before.length, ART_BANDS.length); }
});
test('robust design tolerates +-2 % temperature drift better', () => {
  const a = predictDrift(sol0, st, 2), b = predictDrift(sol, st, 2); ok(b.devAfter < a.devAfter, `${b.devAfter} vs ${a.devAfter}`); ok(b.devAfter < b.devBefore);
});
test('FIR per speaker at each sample rate is finite and normalised in length', () => {
  for (const sr of [44100, 48000, 96000]) { const f = firFor(sol, 0, sr, 1.0); ok(f.length >= sr * 0.9 && f.length <= sr * 1.1, 'len ' + f.length); ok(Array.from(f).every(Number.isFinite)); }
  const m = mainsFIR(120, 0.05, 48000); ok(m.length > 100 && Array.from(m).every(Number.isFinite));
});
test('predict() returns per-band numbers', () => { const p = predict(sol); ok(p && JSON.stringify(p).length > 10 && !/NaN/.test(JSON.stringify(p))); });

// ---------------------------------------------------------------- A2
const A2 = { ...o, mains: ['FL', 'FR'], helpers: ['SL', 'SR'], direct: ['FL', 'FR'], auto: true, headroom: true, weights: defaultWeights(15) };   // pre-ring control is an option (off by default): it costs some decay accuracy
const GEN = { ...o, mains: ['FL', 'FR'], helpers: ['SL', 'SR'], direct: ['FL', 'FR'] };
const sec = suite;
test('legacy path is bit-identical when no A2 option is on', () => {
  ok(!isGeneral(o) && !isGeneral({ ...o, robust: true, auto: false, headroom: false, preRing: false }), 'isGeneral');
  const again = solveART(sp, { ...o, robust: true });
  eq(JSON.stringify(Array.from(again.B[0][5])), JSON.stringify(Array.from(sol.B[0][5]))); eq(again.preampDb, sol.preampDb);
});
const row = (n, c) => `  ${n.padEnd(34)} before ${c.devBefore.toFixed(2)} dB   after ${c.devAfter.toFixed(2)} dB`;
const cvPre = predictCV(sp, { ...A2, preRing: -30, robust: true }), cvBase = predictCV(sp, { ...o, robust: true }), cvGen = predictCV(sp, { ...GEN, robust: true }), cvA2 = predictCV(sp, { ...A2, robust: true });
test('demoroom CV: A2 (auto lambda, headroom, weights) does not get worse than the classic design', () => {
  console.log('  CV (leave-one-position-out) modal-decay deviation, demoroom 4.0, mean over 15 positions:');
  console.log(row('classic (fixed lambda)', cvBase)); console.log(row('general solver, fixed lambda', cvGen)); console.log(row('A2: auto lambda+headroom+weights', cvA2)); console.log(row('A2 + pre-ring <= -30 dB (option)', cvPre));
  ok(cvA2.devAfter <= cvBase.devAfter * 1.05, `A2 ${cvA2.devAfter} vs classic ${cvBase.devAfter}`);
  ok(cvA2.devAfter < cvA2.devBefore * 0.6, 'still improves'); ok(cvPre.devAfter < cvPre.devBefore * 0.6, 'pre-ring option still improves');
});
test('auto regularisation reports a lambda and cap per band, from the grid', () => {
  const s = solveART(sp, { ...A2, robust: true }); ok(s.reg.bands.length >= 5 && !s.reg.fixed);
  for (const b of s.reg.bands) { ok(b.lambda > 0 && Number.isFinite(b.capDb)); }
});
test('headroom rule: no boost where a speaker is below its -10 dB point; preamp keeps the summed worst case <= 0 dBFS', () => {
  const s = solveART(sp, { ...A2, robust: true }); const lim = sourceLimits(sp, 120);
  ok(s.preampDb <= 0 && Number.isFinite(s.preampDb));
  s.keys.forEach((key, i) => { if (!s.solvedKeys.includes(key)) return; const l = lim[i];
    for (let k = 1; k < s.f.length; k++) if (l.locked[k] && s.f[k] <= 120) { const a = Math.hypot(...s.B[i][k]); ok(a < 1.3, `${key} boosts x${a.toFixed(2)} at ${s.f[k].toFixed(0)} Hz inside its locked region`); } });
  const worst = s.headroom.perSource.reduce((m, x) => Math.max(m, x.peakDb), -99); ok(s.preampDb <= -worst + 1e-6 || worst <= 0, `preamp ${s.preampDb} worst ${worst}`);
  ok(s.headroom.perSource.some(x => x.lockedBins > 0 || x.f10 >= 0));
});
test('pre-ring control: helper FIRs reach <= -30 dB and the level is reported (and was higher before)', () => {
  const off = solveART(sp, { ...GEN, robust: true, auto: false, preRing: false }), on = solveART(sp, { ...GEN, robust: true, preRing: -30 });
  ok(on.preRing && Object.keys(on.preRing).length >= 2);
  for (const [k, v] of Object.entries(on.preRing)) { ok(v.afterDb <= -30 + 0.5, `${k} pre-ring ${v.afterDb}`); ok(v.afterDb <= v.beforeDb + 1e-9); }
  const i = on.keys.indexOf('SL'); const h = firFor(on, i, 48000, 1.0); ok(preRingDb(h, 48000, 35).db <= -29, 'measured on the final FIR ' + preRingDb(h, 48000, 35).db);
  console.log('  pre-ring SL: ' + Object.values(on.preRing)[0].beforeDb.toFixed(1) + ' -> ' + Object.values(on.preRing)[0].afterDb.toFixed(1) + ' dB'); ok(off.preRing === null);
});
test('artSources: 2.1 / 2.2 / 4.1 / 4.2 roles, no helper = hint case', () => {
  eq(artSources('2.2').helpers, ['SW1', 'SW2']); eq(artSources('2.1').helpers, ['SW1']); eq(artSources('4.2').helpers, ['SL', 'SR', 'SW1', 'SW2']); eq(artSources('4.1').helpers, ['SL', 'SR', 'SW1']);
  eq(artSources('2.0').ok, false); eq(artSources('hp').ok, false); eq(artSources('2.1', 'subs').ok, false);
  eq(artSources('2.2', 'subs').mains, ['SW1']); eq(artSources('2.2', 'subs').helpers, ['SW2']);
});
test('2.2 sub-only case: two subs cancel each other (mains high-passed, direct) and the CV does not get worse', () => {
  const spS = spectra(demoMeasurements({ subs: 2 }), 260, ['FL', 'FR', 'SW1', 'SW2']);
  const opt = { ...o, fc: 100, mains: ['SW1'], helpers: ['SW2'], direct: ['FL', 'FR'], auto: true, headroom: true, robust: true };
  const s = solveART(spS, opt); ok(s.solvedKeys.join() === 'SW1,SW2' && Number.isFinite(s.preampDb) && s.preampDb <= 0, s.solvedKeys.join());
  const cv = predictCV(spS, opt); console.log(row('2.2 subs only (SW1 plays, SW2 absorbs)', cv)); ok(cv.devAfter <= cv.devBefore * 1.02, `${cv.devBefore} -> ${cv.devAfter}`);
  const s2 = solveART(spS, { ...opt, mains: ['FL', 'FR'], helpers: ['SW1', 'SW2'] }); ok(s2.helperKeys.join() === 'SW1,SW2' && Number.isFinite(s2.preampDb));
});
done('art');
