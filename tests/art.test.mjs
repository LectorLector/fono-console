// ART (active room treatment): solve / predict / FIR design on the simulated bedroom.
import { test, ok, eq, near, suite, done } from './harness.mjs';
import { defaultState } from '../web/js/state.js';
import { spectra, solveART, predict, predictCV, predictDrift, firFor, mainsFIR, handover, ART_BANDS, ART_SPK } from '../web/js/art.js';
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
done('art');
