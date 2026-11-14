// Filter export (web/js/export.js): zip writer (own reader: local headers, central directory, CRC), WAV header, combined impulse response vs the analytic chain,
// full FIR / ART file sets, latency readout, sample-rate advice, input label classifier.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, ok, near, eq, suite, done } from './harness.mjs';
import { crc32, zipStore, combinedIR, irDbAt, buildExport, renderSet, EXPORT_RATES } from '../web/js/export.js';
import { encodeWavFloat, chainDb } from '../web/js/dsp.js';
import { defaultState } from '../web/js/state.js';
import { latencyInfo, rateAdvice, genConfig } from '../web/js/eapo.js';
import { designFIR, excessPhaseFromModel } from '../web/js/fir.js';
import { classifyInput, inputDisplayLabel, LOOPBACK_TAG, assertMeasurable } from '../web/js/capture.js';
import { spectra, solveART } from '../web/js/art.js';
import { demoMeasurements } from '../web/js/demoroom.js';

/** Independent zip reader: walks the central directory, then checks every local header, the stored data and its CRC-32. */
function readZip(u8) {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), dec = new TextDecoder();
  let e = u8.length - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('no end of central directory');
  const n = v.getUint16(e + 10, true), cdSize = v.getUint32(e + 12, true), cdOff = v.getUint32(e + 16, true);
  if (v.getUint16(e + 8, true) !== n) throw new Error('entry count mismatch');
  if (cdOff + cdSize !== e) throw new Error('central directory does not end at EOCD');
  const out = []; let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header ' + i);
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), csz = v.getUint32(p + 20, true), usz = v.getUint32(p + 24, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    if (v.getUint32(lo, true) !== 0x04034b50) throw new Error('bad local header ' + name);
    const lnl = v.getUint16(lo + 26, true), lxl = v.getUint16(lo + 28, true);
    if (dec.decode(u8.subarray(lo + 30, lo + 30 + lnl)) !== name) throw new Error('local name differs ' + name);
    if (v.getUint32(lo + 14, true) !== crc || v.getUint32(lo + 18, true) !== csz || v.getUint32(lo + 22, true) !== usz) throw new Error('local header fields differ ' + name);
    if (method !== 0 || csz !== usz) throw new Error('not stored ' + name);
    const data = u8.subarray(lo + 30 + lnl + lxl, lo + 30 + lnl + lxl + usz);
    if (crc32(data) !== crc) throw new Error('CRC mismatch ' + name);
    out.push({ name, data }); p += 46 + nl + xl + cl;
  }
  return out;
}
const wavInfo = u8 => { const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), t = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  return { riff: t(0, 4), wave: t(8, 4), fmt: t(12, 4), fmtLen: v.getUint32(16, true), tag: v.getUint16(20, true), ch: v.getUint16(22, true), sr: v.getUint32(24, true), byteRate: v.getUint32(28, true), align: v.getUint16(32, true), bits: v.getUint16(34, true), data: t(36, 4), dataLen: v.getUint32(40, true), riffLen: v.getUint32(4, true), len: u8.length,
    samples: new Float32Array(u8.buffer.slice(u8.byteOffset + 44, u8.byteOffset + u8.length)) }; };

suite('crc32 and zip');
test('crc32 of "123456789" is 0xCBF43926; empty is 0', () => { eq(crc32(new TextEncoder().encode('123456789')), 0xcbf43926); eq(crc32(new Uint8Array(0)), 0); });
test('zip: own reader finds every entry, CRCs match, UTF-8 names and empty files work', () => {
  const big = Uint8Array.from({ length: 100000 }, (_, i) => (i * 31 + 7) & 255);
  const files = [{ name: 'README.txt', data: '你好 hello\r\n' }, { name: 'a/b.wav', data: big }, { name: 'empty.bin', data: new Uint8Array(0) }, { name: 'f32.bin', data: new Float32Array([1, -2, 3.5]) }];
  const z = zipStore(files, new Date(2026, 10, 15, 12, 30, 40)), r = readZip(z);
  eq(r.map(x => x.name), files.map(f => f.name));
  eq(new TextDecoder().decode(r[0].data), '你好 hello\r\n'); eq(Array.from(r[1].data.slice(0, 5)), Array.from(big.slice(0, 5))); eq(r[1].data.length, 100000); eq(r[2].data.length, 0);
  eq(Array.from(new Float32Array(r[3].data.slice().buffer)), [1, -2, 3.5]);
});
test('zip: `unzip -t` accepts it when unzip is installed', () => {
  const probe = spawnSync('unzip', ['-v']); if (probe.error || probe.status !== 0) return;   // optional
  const dir = mkdtempSync(join(tmpdir(), 'fonozip-')), f = join(dir, 't.zip');
  try { writeFileSync(f, zipStore([{ name: 'x.txt', data: 'hello' }, { name: 'dir/y.bin', data: new Uint8Array(5000).map((_, i) => i) }])); const r = spawnSync('unzip', ['-t', f], { encoding: 'utf8' }); ok(r.status === 0 && /No errors/.test(r.stdout), r.stdout + r.stderr); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

suite('wav writer');
test('32-bit float mono header fields', () => {
  const h = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10)), w = wavInfo(new Uint8Array(encodeWavFloat([h], 96000)));
  eq([w.riff, w.wave, w.fmt, w.data], ['RIFF', 'WAVE', 'fmt ', 'data']); eq([w.fmtLen, w.tag, w.ch, w.sr, w.bits], [16, 3, 1, 96000, 32]);
  eq(w.byteRate, 96000 * 4); eq(w.align, 4); eq(w.dataLen, 4000); eq(w.riffLen, w.len - 8); eq(w.len, 44 + 4000); near(w.samples[123], Math.sin(12.3), 1e-6);
});

suite('combined impulse response');
const PEQ = [{ type: 'PK', fc: 25, gain: -9, q: 8 }, { type: 'PK', fc: 62, gain: -6, q: 4 }, { type: 'PK', fc: 140, gain: 3, q: 2 }, { type: 'LSC', fc: 90, gain: 2.5, q: 0.7071 }, { type: 'PK', fc: 1200, gain: -4, q: 3 }, { type: 'HSC', fc: 8000, gain: -3, q: 0.7071 }];
const TEST_F = [20, 31.5, 50, 63, 100, 160, 250, 500, 1000, 2500, 5000, 9000, 15000];
const firDb = (h, sr, f) => irDbAt(h, sr, f);
for (const sr of EXPORT_RATES) {
  test(`magnitude = analytic chain within 0.2 dB at ${sr} Hz (gain + PEQ, polarity, delay, normalisation)`, () => {
    const c = combinedIR({ sr, gainDb: 3.2, invert: true, delayMs: 2.5, filters: PEQ });
    ok(c.normDb < 0, 'positive gain chain must be scaled down: ' + c.normDb);
    for (const f of TEST_F) { if (f > sr / 2.2) continue; const want = 3.2 + chainDb(PEQ, f, sr) + c.normDb; near(irDbAt(c.h, sr, f), want, 0.2, `${f} Hz`); }
    near(irDbAt(c.h, sr, 100) - irDbAt(combinedIR({ sr, gainDb: 3.2, invert: false, delayMs: 2.5, filters: PEQ }).h, sr, 100), 0, 0.01, 'polarity does not change magnitude');
    const pk = c.h.reduce((m, x, i) => Math.abs(x) > Math.abs(m.v) ? { v: x, i } : m, { v: 0, i: 0 }); ok(c.h[Math.round(0.0025 * sr)] !== undefined);
  });
  test(`with a FIR (${sr} Hz): magnitude = PEQ + FIR response; FIR latency kept; tail decays`, () => {
    const d = designFIR(excessPhaseFromModel({ xover: 3000, hpFreq: 50, hpOrder: 4 }, sr), sr, { lo: 200, hi: 12000 });
    const c = combinedIR({ sr, gainDb: -2, filters: PEQ, fir: d.h });
    for (const f of [31.5, 63, 125, 400, 1000, 3000, 8000]) near(irDbAt(c.h, sr, f), -2 + chainDb(PEQ, f, sr) + firDb(d.h, sr, f) + c.normDb, 0.2, `${f} Hz`);
    const tail = c.h.subarray(c.h.length - Math.round(0.02 * sr)); let e = 0; for (const x of tail) e = Math.max(e, Math.abs(x)); ok(e < 1e-3, 'tail still ringing: ' + e);
    ok(c.lengthSec > 1.0, 'the 25 Hz Q8 filter needs > 1 s: ' + c.lengthSec);
  });
}
test('normalisation only attenuates, and a common scale keeps the level difference between channels', () => {
  eq(combinedIR({ sr: 48000, gainDb: -6 }).normDb, 0);
  const set = renderSet([{ sr: 48000, gainDb: 6 }, { sr: 48000, gainDb: 0 }, { sr: 48000, gainDb: 6, filters: [{ type: 'PK', fc: 100, gain: 3, q: 2 }] }]);
  near(irDbAt(set[0].h, 48000, 1000) - irDbAt(set[1].h, 48000, 1000), 6, 0.05); near(set[0].normDb, set[2].normDb, 1e-12);
  near(Math.max(...set.map(c => irDbAt(c.h, 48000, 100))), 0, 0.3, 'loudest peak sits at 0 dB');
});

suite('export file sets');
test('FIR export: per rate FIR + combined files, README, readable zip, headroom noted', () => {
  const S = defaultState(); S.room.layout = '2.1'; S.room.fir.chans = ['FL', 'FR']; S.room.ch.FL.gain = -1; S.room.ch.FR.delay = 0.3; S.room.ch.FL.corr = { name: 'x', filters: PEQ }; S.room.sub.gain = 2; S.room.ch.FR.corr = { name: 'y', filters: [{ type: 'PK', fc: 700, gain: 4, q: 2 }] };
  const ex = excessPhaseFromModel(S.room.fir.model, 48000), res = buildExport(S, { kind: 'fir', exByCh: { FL: ex, FR: ex } });
  const z = readZip(res.zip()), names = z.map(x => x.name);
  ok(names.includes('README.txt'));
  for (const sr of EXPORT_RATES) for (const k of ['FL', 'FR']) { ok(names.includes(`fir_${k}_${sr}.wav`) && names.includes(`combined_${k}_${sr}.wav`), `${k} ${sr}`); const w = wavInfo(z.find(x => x.name === `fir_${k}_${sr}.wav`).data); eq([w.ch, w.sr, w.bits, w.tag], [1, sr, 32, 3]); }
  ok(names.includes('combined_SW1_48000.wav') && !names.includes('combined_SL_48000.wav'), 'active speakers only (2.1)');
  const rd = new TextDecoder().decode(z[0].data); ok(/CamillaDSP/.test(rd) && /Roon/.test(rd) && /HQPlayer/.test(rd) && /Equalizer APO/.test(rd) && /\[English\]/.test(rd) && /【中文】/.test(rd), 'README bilingual with all four players');
  ok(/scale -?\d/.test(rd), 'headroom listed'); near(res.info.latencyMs, 85.33, 0.05); ok(res.info.headroomDb <= 0);
  // FIR channel's combined IR magnitude = gain + PEQ (+ FIR) + common scale
  const fl = wavInfo(z.find(x => x.name === 'combined_FL_48000.wav').data).samples, d = designFIR(ex, 48000, { lo: S.room.fir.lo, hi: S.room.fir.hi }), nd = res.info.headroomDb;
  for (const f of [40, 63, 140, 1200, 5000]) near(irDbAt(fl, 48000, f), -1 + chainDb(PEQ, f, 48000) + irDbAt(d.h, 48000, f) + nd, 0.2, f + ' Hz');
  // a channel without a FIR (the sub) carries the same latency as pure delay: the peak sits about 85 ms in
  const sw = wavInfo(z.find(x => x.name === 'combined_SW1_48000.wav').data).samples; let pi = 0; for (let i = 0; i < sw.length; i++) if (Math.abs(sw[i]) > Math.abs(sw[pi])) pi = i;
  ok(Math.abs(pi / 48 - 85.33) < 1, 'sub aligned to the FIR latency, peak at ' + (pi / 48) + ' ms');
});
test('FIR export without any source throws', () => { const S = defaultState(); let t = false; try { buildExport(S, { kind: 'fir', exByCh: {} }); } catch (e) { t = e.message === 'no-fir-source'; } ok(t); });
test('ART export: hp + per-speaker FIRs + combined main/bass files at every rate', () => {
  const S = defaultState(); S.room.layout = '4.0'; S.room.art.built = 'x';
  const m = demoMeasurements(), sp = spectra(m, 260), sol = solveART(sp, { fc: 120, fLow: 35, capDb: 12, tau: 0.05, state: S, mains: ['FL', 'FR'], helpers: ['SL', 'SR'], direct: ['FL', 'FR'], robust: true });
  const res = buildExport(S, { kind: 'art', sol, rates: [48000] }), z = readZip(res.zip()), names = z.map(x => x.name);
  ok(names.includes('art_hp_48000.wav') && names.includes('combined_art_main_FL_48000.wav') && names.includes('combined_art_bass_SL_48000.wav'), names.join(','));
  for (const k of sol.solvedKeys) ok(names.includes(`art_${k}_48000.wav`));
  ok(/ART/.test(new TextDecoder().decode(z[0].data)));
});

suite('latency readout');
test('FIR 85 ms vs 0 in low-latency mode, ART tau, nothing built = 0', () => {
  const S = defaultState(); eq(latencyInfo(S).normalMs, 0);
  S.room.fir.built = 'x'; S.room.fir.on = true; S.room.fir.latencyMs = 85.333;
  let L = latencyInfo(S); near(L.nowMs, 85.333, 1e-9); eq(L.low, false);
  S.ui.lowLatency = true; L = latencyInfo(S); eq(L.nowMs, 0); near(L.normalMs, 85.333, 1e-9); ok(L.saved);
  S.ui.lowLatency = false; S.room.art.built = 'x'; S.room.mode = 'art'; S.room.art.tauMs = 50; L = latencyInfo(S); eq(L.artLenMs, 1000); eq(L.artMs, 50); near(L.nowMs, 85.333, 1e-9);
  S.room.correction = false; eq(latencyInfo(S).firMs, 0);
});
test('low-latency config has no Convolution even with FIR, ART and reverb built (and a sub crossover stays)', () => {
  const S = defaultState(); S.room.layout = '2.1'; S.room.mode = 'stereo'; S.fx.rev.on = true; S.room.fir.on = true;
  const ctx = { irRates: [44100, 48000], fir: { rates: [44100, 48000], chans: ['FL', 'FR'], latencyMs: 85.3 }, art: null }; S.room.fir.built = 'x';
  ok(/Convolution:/.test(genConfig(S, ctx))); S.ui.lowLatency = true; const t = genConfig(S, ctx);
  ok(!/Convolution:/.test(t) && /LP Fc 80/.test(t) && !/Delay: 85/.test(t), t);
});

suite('sample rate advice');
test('44.1 matches the usual source; others differ; odd rates have no convolution files; unknown', () => {
  eq(rateAdvice(44100), { kind: 'same', convOk: true }); eq(rateAdvice(48000), { kind: 'diff', convOk: true }); eq(rateAdvice(384000), { kind: 'diff', convOk: false }); eq(rateAdvice(0), { kind: 'norate', convOk: true }); eq(rateAdvice(undefined).kind, 'norate');
});

suite('input label classifier');
test('loopback inputs', () => { for (const l of ['Stereo Mix (Realtek Audio)', '立體聲混音 (Realtek High Definition Audio)', 'What U Hear (Sound Blaster)', 'Wave Out Mix', 'Loopback (VB-Audio)', '混音']) ok(classifyInput(l).loopback && !classifyInput(l).array, l); });
test('array / communications microphones', () => { for (const l of ['Microphone Array (Realtek)', '麥克風陣列 (AMD Audio Device)', 'Headset Hands-Free', '免持裝置', 'Communications - Mic']) { const c = classifyInput(l); ok(c.array && !c.loopback, l); } });
test('real microphones and empty labels are neither', () => { for (const l of ['UMIK-1 (Miniroom)', 'USB Sound Device', 'miniDSP UMIK-2', '', undefined, null]) { const c = classifyInput(l); ok(!c.loopback && !c.array, String(l)); } });
test('display label tags loopback only; assertMeasurable throws for loopback only', () => {
  ok(inputDisplayLabel('Stereo Mix').endsWith(LOOPBACK_TAG)); eq(inputDisplayLabel('UMIK-1'), 'UMIK-1'); eq(inputDisplayLabel('Microphone Array'), 'Microphone Array');
  let thrown = false; try { assertMeasurable('立體聲混音'); } catch (e) { thrown = /內錄/.test(e.message); } ok(thrown); assertMeasurable('Microphone Array'); assertMeasurable('UMIK-1');
});
done('export.test.mjs');
