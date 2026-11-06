import fs from 'fs';
import { spectra, solveART, predict, firFor, mainsFIR, ART_SPK, ART_BANDS } from './art.js';
import { defaultState } from './state.js';
const D = JSON.parse(fs.readFileSync(process.argv[2]));
const toMeas = set => Object.fromEntries(ART_SPK.map(k => [k, set[k].map(ir => ({ ir: Float64Array.from(ir), sr: D.sr, irPeak: 0, arrivalMs: 0 }))]));
const st = defaultState();
const t0 = Date.now();
const sp = spectra(toMeas(D.train), 260);
const sol = solveART(sp, { fc: 150, fLow: 38, capDb: 12, tau: 0.04, state: st });
const pr = predict(sol);
console.log('solve ms', Date.now() - t0, ' preamp', sol.preampDb.toFixed(1), 'dB');
const row = (n, a) => console.log(n.padEnd(22) + a.map(v => String(Math.round(v)).padStart(6)).join(''));
console.log(''.padEnd(22) + ART_BANDS.map(b => String(b).padStart(6)).join(''));
row('train: before', pr.before); row('train: after', pr.after);
console.log('dev before/after (dB):', pr.devBefore.toFixed(1), pr.devAfter.toFixed(1));
// unseen positions in a slightly different room
const spv = spectra(toMeas(D.val), 260);
const val = { ...sol, spectra: spv, mains: null };
// recompute the mains contribution at the validation positions
const { f } = sol; const cm = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
val.mains = Array.from(f, (fk, k) => spv.H.map(Hp => { const t = 1 / (1 + Math.pow(fk / 150, 8)); let m = [Hp[0][k][0] + Hp[1][k][0], Hp[0][k][1] + Hp[1][k][1]]; m = cm(m, [1 - t, 0]); return cm(m, [Math.cos(-2 * Math.PI * fk * 0.04), Math.sin(-2 * Math.PI * fk * 0.04)]); }));
const pv = predict(val);
row('unseen: before', pv.before); row('unseen: after', pv.after);
console.log('dev before/after (dB):', pv.devBefore.toFixed(1), pv.devAfter.toFixed(1));
// FIR synthesis sanity: time-domain filter at 48 kHz reproduces the bins
const h = firFor(sol, 2, 48000, 0.5), hp = mainsFIR(150, 0.04, 48000);
let e = 0; for (const v of h) e += v * v;
console.log('SL fir taps', h.length, 'energy', e.toExponential(2), 'mains hp taps', hp.length, 'hp sum (DC gain≈0)', hp.reduce((a, b) => a + b, 0).toFixed(4));
const t1 = Date.now();
const cv = (await import('./art.js')).predictCV(sp, { fc: 150, fLow: 38, capDb: 12, tau: 0.04, state: st });
console.log('cross-validated (leave-one-out) ms', Date.now() - t1);
row('CV: before', cv.before); row('CV: after', cv.after);
console.log('CV dev before/after (dB):', cv.devBefore.toFixed(1), cv.devAfter.toFixed(1));
const dr = (await import('./art.js')).predictDrift(sol, st, 1);
row('drift ±1%: before', dr.before); row('drift ±1%: after', dr.after);
console.log('drift dev before/after (dB):', dr.devBefore.toFixed(1), dr.devAfter.toFixed(1));
