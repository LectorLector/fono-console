// Phase 5 / task 5 checks (node, no deps):  node research/art/cfg-check.mjs
//  a) generated EQ APO config: ASCII, valid lines, loudness on/off, ART + correction above fc*1.5
//  b) ART robust (3 temperature variants stacked) vs non-robust: CV and +-1 % drift prediction on web/js/demoroom.js
//  c) T30 on a synthetic exponential decay with known RT60
//  d) ISO 226:2003 contour against the standard's table
//  e) auto-EQ with target == default lfRise shelf is identical to the lfRise path
//  f) mirror image sources / mode pressure sanity
import { defaultState } from '../../web/js/state.js';
import { genConfig } from '../../web/js/eapo.js';
import { spectra, solveART, predictCV, predictDrift, ART_BANDS } from '../../web/js/art.js';
import { demoMeasurements } from '../../web/js/demoroom.js';
import { decayTimes, firstReflections, simpleModes, modePressure, defaultTarget, parseCalText, applyMicCal } from '../../web/js/acoustics.js';
import { isoSpl, loudDiff, fitLoudness } from '../../web/js/iso226.js';
import { autoEQ, irToCurve, averageCurves } from '../../web/js/measure.js';
import { chainDb } from '../../web/js/dsp.js';

let fails = 0;
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg); } return c; };
const rows = (n, a) => n.padEnd(20) + a.map(v => (Number.isFinite(v) ? String(Math.round(v)) : '-').padStart(6)).join('');

// ------------------------------------------------------------------ a) config
console.log('== a) config');
const issues = [];
const okLine = /^(Device|Channel|Preamp|Filter( \d+)?|Copy|Delay|Convolution|If|ElseIf|Else|EndIf|Include|Stage):/;
const check = (name, txt) => {
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(txt)) issues.push(name + ': non-ASCII');
  if (/NaN|undefined|null|Infinity/.test(txt)) issues.push(name + ': bad value');
  const lines = txt.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  for (const l of lines) if (!okLine.test(l)) issues.push(name + ': unknown line -> ' + l);
  let d = 0; for (const l of lines) { if (/^If:/.test(l)) d++; if (/^EndIf:/.test(l)) d--; }
  if (d) issues.push(name + ': unbalanced If');
  for (const m of txt.matchAll(/Preamp: (-?[\d.]+) dB/g)) if (+m[1] > 0.01) issues.push(name + ': positive preamp ' + m[1]);
};
const base = () => { const s = defaultState(); s.dev.cm = '{cm}'; s.dev.spark = '{dac}'; return s; };
const artCtx = { art: { rates: [44100, 48000, 96000, 192000], preampDb: -11.4 }, fir: { rates: [44100, 48000, 96000, 192000], chans: ['FL', 'FR'], latencyMs: 85.33 } };
let n = 0;
for (const mode of ['stereo', 'quadA', 'quadB', 'art', 'measure'])
  for (const loud of [false, true]) for (const lv of [60, 70, 83]) for (const fxon of [true, false]) for (const corr of [false, true]) {
    const s = base(); s.room.mode = mode; s.fx.on = fxon; s.fx.loud = { on: loud, level: lv }; s.room.art.fc = 100;
    if (corr) for (const k of ['FL', 'FR', 'SL', 'SR']) { s.room.ch[k].corr = { name: '耳機 x', filters: [{ type: 'PK', fc: 50, gain: -8, q: 7 }, { type: 'PK', fc: 149, gain: -3, q: 2 }, { type: 'PK', fc: 151, gain: -3, q: 2 }, { type: 'LSC', fc: 400, gain: 2, q: 0.7 }, { type: 'PK', fc: 1200, gain: -2, q: 3 }] }; }
    const txt = genConfig(s, mode === 'art' ? artCtx : { fir: artCtx.fir }); n++;
    check(`${mode}/loud${loud}@${lv}/fx${fxon}/corr${corr}`, txt);
    const hasLoud = /Filter: ON (LSC|HSC)/.test(txt);
    if (loud && lv < 83 && fxon && !/Filter: ON LSC Fc \d+\.\d Hz Gain/.test(txt) && mode !== 'measure') issues.push('loudness shelf missing ' + mode + lv);
    if (!loud && hasLoud && corr === false) issues.push('loudness shelf present while off ' + mode);
    if (mode === 'art' && corr) {
      const sec = txt.slice(txt.indexOf('Device: {cm}'));
      const fcs = [...sec.matchAll(/Filter: ON PK Fc (\d+(?:\.\d)?) Hz/g)].map(m => +m[1]);
      if (fcs.some(f => f <= 150)) issues.push('ART: correction filter at/below fc*1.5 kept: ' + fcs.join(','));
      if (!fcs.includes(1200)) issues.push('ART: correction above fc*1.5 dropped');
      if (/Filter: ON LSC Fc 400/.test(sec)) issues.push('ART: low shelf kept');
      if (!sec.includes('(above ART hand-over only)')) issues.push('ART: no marker');
    }
    if (mode === 'quadA' && corr && !/Fc 50\.0 Hz/.test(txt)) issues.push('normal modes lost their bass correction');
  }
// speaker layouts (phase 5 / task 6): 2.0 and headphones-only collapse every quad / ART mode to the front pair and mute the rear channels
{
  let m = 0;
  for (const layout of ['hp', '2.0', '2.1', '2.2', '4.0', '4.1', '4.2'])
    for (const mode of ['stereo', 'quadA', 'quadB', 'art', 'measure', 'identify']) for (const hafler of [false, true]) {
      const s = base(); s.room.layout = layout; s.room.mode = mode; s.room.hafler = hafler; s.room.measureTarget = 'SL'; s.room.identify = 'SR';
      for (const k of ['SL', 'SR']) { s.room.ch[k].corr = { name: 'x', filters: [{ type: 'PK', fc: 900, gain: -3, q: 2 }] }; }
      const txt = genConfig(s, mode === 'art' ? artCtx : { fir: artCtx.fir }); m++;
      const name = `layout ${layout}/${mode}/hafler${hafler}`;
      check(name, txt);
      const cm = txt.slice(txt.indexOf('Device: {cm}'));
      const front = layout.startsWith('4'), nsub = layout === 'hp' ? 0 : +layout.split('.')[1];
      const rearStage = /Channel: SL\b/.test(cm);                    // a per-speaker stage for a rear speaker
      const rearMute = /Copy: SL=0\.0 SR=0\.0/.test(cm);
      const rearFed = /Copy: SL=L SR=R|Copy: SL=0\.5\*L/.test(cm);    // rear fed from the stereo bus
      if (!front) {
        if (rearStage) issues.push(name + ': rear speaker stage present');
        if (rearFed) issues.push(name + ': rear channels fed');
        if (/Fc 900(\.0)? Hz/.test(cm) && /Channel: S[LR]/.test(cm)) issues.push(name + ': rear correction present');
        if (/fir_S[LR]|art_S[LR]/.test(cm)) issues.push(name + ': rear convolution present');
        if (['stereo', 'quadA', 'quadB', 'art'].includes(mode) && !rearMute) issues.push(name + ': rear not muted');
        if (mode === 'measure' && /SL=L\b/.test(cm)) issues.push(name + ': measure target is a rear speaker');
        if (mode === 'identify' && /SR=L\b/.test(cm)) issues.push(name + ': identify target is a rear speaker');
        { const dac = txt.slice(txt.indexOf('Device: {dac}'), txt.indexOf('Device: {cm}')); if (/SL|SR/.test(dac)) issues.push(name + ': rear channel in the stereo DAC block'); }
      } else if (mode === 'quadA' && !rearStage) issues.push(name + ': 4.0 lost its rear stage');
      // bass management (phase 6 / A1): subs only on the multichannel card, mains high-passed, subs low-passed, nothing for layouts without subs
      const dacBlk = txt.slice(txt.indexOf('Device: {dac}'), txt.indexOf('Device: {cm}'));
      if (/LFE|HP Fc/.test(dacBlk)) issues.push(name + ': bass management leaked into the stereo DAC block');
      const bmMode = ['stereo', 'quadA', 'quadB'].includes(mode);
      if (!nsub && /LFE|Copy: [^\n]*C=|Filter: ON HP/.test(cm)) issues.push(name + ': sub processing without a sub');
      if (nsub && bmMode) {
        if (!/Copy: LFE=0\.5\*L\+0\.5\*R/.test(cm)) issues.push(name + ': no sub feed');
        if ((nsub === 2) !== /C=0\.5\*L\+0\.5\*R/.test(cm)) issues.push(name + ': second sub feed mismatch');
        if (!/Channel: L\n[^]*?HP Fc 80/.test(cm)) issues.push(name + ': mains not high-passed');
        if (!/Channel: LFE\n[^]*?LP Fc 80/.test(cm)) issues.push(name + ': sub not low-passed');
      }
      if (nsub && front && mode === 'art' && !/LFE=0\.0/.test(cm)) issues.push(name + ': sub not muted in ART');
    }
  const hs = base(); hs.room.layout = 'garbage'; hs.room.mode = 'quadA';
  if (!/Channel: SL\b/.test(genConfig(hs, {}))) issues.push('unknown layout should behave as 4.0');
  console.log(`layouts: ${m} combos checked (hp, 2.x, 4.x with 0-2 subs: front pair only and rear muted without rear speakers; bass management)`);
}
ok(!issues.length, [...new Set(issues)].slice(0, 12).join('\n'));
console.log(issues.length ? 'issues:\n' + [...new Set(issues)].slice(0, 12).join('\n') : `config OK (${n} combos, ASCII, loudness on/off, ART + corr above fc*1.5)`);

// ------------------------------------------------------------------ b) ART robust
console.log('== b) ART robust vs non-robust (demoroom 15 pts, CV leave-one-out and +-1 % drift)');
{
  const st = defaultState(), sp = spectra(demoMeasurements(), 260);
  const o = { fc: 120, fLow: 35, capDb: 12, tau: 0.05, state: st };
  console.log(' '.repeat(20) + ART_BANDS.map(b => String(b).padStart(6)).join('') + '  dev dB (before->after)');
  let first = true; const res = {};
  for (const robust of [false, true]) {
    const t0 = Date.now(), sol = solveART(sp, { ...o, robust }), cv = predictCV(sp, { ...o, robust }), dr = predictDrift(sol, st, 1), dr2 = predictDrift(sol, st, 2);
    if (first) { console.log(rows('before (T60 ms)', cv.before)); first = false; }
    console.log(rows(`CV ${robust ? 'robust' : 'plain '}`, cv.after) + `  ${cv.devBefore.toFixed(2)} -> ${cv.devAfter.toFixed(2)}`);
    console.log(rows(`drift1% ${robust ? 'robust' : 'plain '}`, dr.after) + `  ${dr.devBefore.toFixed(2)} -> ${dr.devAfter.toFixed(2)}   (preamp ${sol.preampDb.toFixed(1)} dB, ${Date.now() - t0} ms)`);
    console.log(rows(`drift2% ${robust ? 'robust' : 'plain '}`, dr2.after) + `  ${dr2.devBefore.toFixed(2)} -> ${dr2.devAfter.toFixed(2)}`);
    res[robust] = { cv, dr, dr2 };
  }
  ok(res[true].dr.devAfter <= res[false].dr.devAfter + 0.05, 'robust design should not be worse under +-1 % drift');
  ok(res[true].dr2.devAfter < res[false].dr2.devAfter, 'robust design should be better under +-2 % drift');
}

// ------------------------------------------------------------------ c) T30
console.log('== c) T30 on synthetic exponential decay');
{
  const sr = 48000; let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  for (const rt of [0.3, 0.6, 1.2]) {
    const ir = new Float32Array(Math.round(sr * Math.max(1.5, rt * 2.2)));
    for (let i = 0; i < ir.length; i++) ir[i] = gauss() * Math.exp(-6.9078 * (i / sr) / rt);
    const out = [0, 500, 1000, 2000].map(fc => { const d = decayTimes(ir, sr, fc); return [fc, d.t30, d.t20, d.edt]; });
    for (const [fc, t30] of out) ok(Math.abs(t30 / rt - 1) < 0.05, `T30 ${fc} Hz RT ${rt}: ${t30}`);
    console.log(`RT60 ${rt}: ` + out.map(([fc, t30, t20, e]) => `${fc || 'wide'}Hz T30 ${t30.toFixed(3)} (${((t30 / rt - 1) * 100).toFixed(1)}%) T20 ${t20.toFixed(3)} EDT ${e.toFixed(3)}`).join(' | '));
  }
  // noise floor: decay on top of white noise at -70 dB must still give the right T30
  const rt = 0.5, ir = new Float32Array(sr * 2);
  for (let i = 0; i < ir.length; i++) ir[i] = gauss() * Math.exp(-6.9078 * (i / sr) / rt) + gauss() * 3e-4;
  const d = decayTimes(ir, sr, 1000);
  console.log(`with noise floor: T30 ${d.t30.toFixed(3)} (${((d.t30 / rt - 1) * 100).toFixed(1)}%)`);
  ok(Math.abs(d.t30 / rt - 1) < 0.05, 'T30 with noise floor');
}

// ------------------------------------------------------------------ d) ISO 226
console.log('== d) ISO 226:2003');
{
  // Standard table values, 40 phon: 100 Hz 64.37 (the standard; not ~62), 1 kHz 40.0, 4 kHz 36.65, 20 Hz 99.85, 12.5 kHz 51.49
  const T40 = { 20: 99.85, 100: 64.37, 1000: 40.01, 4000: 36.65, 12500: 51.49 };
  for (const [f, v] of Object.entries(T40)) { const got = isoSpl(+f, 40); console.log(`40 phon @ ${f} Hz: ${got.toFixed(2)} dB SPL (standard ${v})`); ok(Math.abs(got - v) < 0.1, 'iso ' + f); }
  ok(Math.abs(isoSpl(1000, 60) - 60) < 0.1, '1 kHz 60 phon');
  ok(isoSpl(100, 40) > 60 && isoSpl(100, 40) < 66, '100 Hz 40 phon in 60..66 dB');
  for (const L of [60, 70, 80]) {
    const r = fitLoudness(L), at = f => loudDiff(f, L).toFixed(1);
    console.log(`listen ${L} phon vs 83: diff 20 Hz ${at(20)}, 100 Hz ${at(100)}, 1 kHz ${at(1000)}, 4 kHz ${at(4000)}, 12.5 kHz ${at(12500)} dB; shelves ${r.filters.map(f => `${f.type} ${f.fc} Hz ${f.gain} dB`).join(', ')}; fit rms ${r.rms.toFixed(2)} dB`);
    ok(Math.abs(loudDiff(1000, L)) < 1e-9, 'normalised at 1 kHz');
    ok(r.rms < 1.5, 'shelf fit rms');
  }
  ok(loudDiff(100, 60) > 0 && loudDiff(100, 83) === 0, 'bass boost at low level');
}

// ------------------------------------------------------------------ e) auto-EQ target
console.log('== e) auto-EQ: target == default lfRise shelf');
{
  const m = demoMeasurements({ sr: 1024 }), curves = [];
  for (const ch of ['FL', 'FR', 'SL']) for (const p of [0, 3]) { const x = m[ch][p]; curves.push(irToCurve(x.ir, x.sr, { windowMs: 1500 })); }
  const avg = averageCurves(curves.slice(0, 2)), avg2 = averageCurves(curves.slice(2, 4)), avg3 = averageCurves(curves.slice(4));
  let worst = 0;
  for (const [name, cv] of [['FL', avg], ['FR', avg2], ['SL', avg3]]) for (const lf of [0, 2, 4]) {
    const a = autoEQ(cv, { fmax: 300, lfRise: lf }), b = autoEQ(cv, { fmax: 300, lfRise: lf, target: defaultTarget(lf) });
    const same = JSON.stringify(a.filters) === JSON.stringify(b.filters);
    const dt = Math.max(...a.target.map((v, i) => Math.abs(v - b.target[i])));
    worst = Math.max(worst, dt);
    console.log(`${name} lfRise ${lf}: ${a.filters.length} vs ${b.filters.length} filters, identical=${same}, rms ${a.rmsBefore.toFixed(2)}->${a.rmsAfter.toFixed(2)} vs ${b.rmsBefore.toFixed(2)}->${b.rmsAfter.toFixed(2)}, max |target diff| ${dt.toExponential(1)} dB`);
    ok(same && dt < 1e-9, `auto-EQ differs ${name} ${lf}`);
  }
  // a different target changes the result in the expected direction
  const flat = autoEQ(avg, { fmax: 300, target: [[20, 0], [20000, 0]], lfRise: 2 }), rise = autoEQ(avg, { fmax: 300, lfRise: 2 });
  console.log(`flat target vs lfRise 2: target at ${flat.grid[0].toFixed(0)} Hz differs by ${(rise.target[0] - flat.target[0]).toFixed(2)} dB`);
  ok(Math.abs((rise.target[0] - flat.target[0]) - 2 * Math.log10(200 / rise.grid[0])) < 1e-9, 'flat target differs from the shelf by exactly the shelf value');
}

// ------------------------------------------------------------------ f) geometry
console.log('== f) geometry');
{
  const dims = { L: 4, W: 3, H: 2.5 }, src = [0.5, 1, 1], rx = [2, 1.5, 1.1];
  const r = firstReflections(src, rx, dims), d0 = Math.hypot(1.5, 0.5, 0.1);
  const fl = r.find(x => x.id === 'floor'), left = r.find(x => x.id === 'left');
  // floor: image z = -1 -> path hypot(1.5,0.5,2.1)
  ok(Math.abs(fl.path - Math.hypot(1.5, 0.5, 2.1)) < 1e-9 && Math.abs(fl.extra - (fl.path - d0)) < 1e-12, 'floor image');
  ok(Math.abs(fl.pt[2]) < 1e-9 && Math.abs(left.pt[1]) < 1e-9, 'reflection points lie on the walls');
  // reflection point: equal angles => point divides the segment in the ratio of heights
  ok(Math.abs(fl.pt[0] - (0.5 + 1.5 * 1 / 2.1)) < 1e-9, 'floor point by similar triangles');
  const modes = simpleModes(dims, 200);
  const m1 = modes.find(m => m.n.join() === '1,0,0');
  ok(Math.abs(m1.f - 343 / 8) < 1e-9, '1,0,0 mode at c/2L');
  ok(Math.abs(modePressure([1, 0, 0], [0, 1, 1], dims) - 1) < 1e-12 && Math.abs(modePressure([1, 0, 0], [2, 1, 1], dims)) < 1e-12, 'axial pressure: antinode at wall, node at mid');
  ok(!modes.some(m => m.n.filter(Boolean).length > 2), 'no oblique modes');
  const cal = parseCalText('"Sens Factor =-1.2dB"\n* comment\n20 -1.0\n100\t0.5\n1000, 0\n10000 3\n');
  ok(cal && cal.length === 4, 'cal parse');
  const cv = applyMicCal({ f: [100, 1000], db: [10, 10] }, cal);
  ok(Math.abs(cv.db[0] - 9.5) < 1e-9 && Math.abs(cv.db[1] - 10) < 1e-9, 'cal subtracted');
  console.log(`modes < 200 Hz: ${modes.length}; first ${modes.slice(0, 3).map(m => m.n.join('') + '@' + m.f.toFixed(1)).join(' ')}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
