// Equalizer APO config generator. Output is ASCII only.
import { artConfig, ART_SPK } from './art.js';
import { filterLine, maxBoostDb } from './dsp.js';
import { loudFilters } from './iso226.js';

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const SPK = ['FL', 'FR', 'SL', 'SR'];
export const IR_RATES = [44100, 48000, 96000, 192000];
export const SUBS = ['SW1', 'SW2'];
export const ALL_SPK = [...SPK, ...SUBS];
export const LAYOUTS = ['hp', '2.0', '2.1', '2.2', '4.0', '4.1', '4.2'];
/** Speaker layout chosen in the wizard: 'hp' (headphones only), 'F.S' = F front/rear speakers (2 = front pair, 4 = front + rear pair) plus S subwoofers (0, 1 or 2). */
export const layoutOf = s => LAYOUTS.includes(s.room?.layout) ? s.room.layout : '4.0';
/** Layout id helpers (take a layout id like '2.1'). */
export const layoutHasRear = id => String(id).startsWith('4');
export const layoutSubs = id => id === 'hp' ? 0 : (+String(id).split('.')[1] || 0);
export const hasRear = s => layoutHasRear(layoutOf(s));
export const subSpk = s => SUBS.slice(0, layoutSubs(layoutOf(s)));
/** The non-sub speakers that really exist in the chosen layout. */
export const mainSpk = s => hasRear(s) ? SPK : ['FL', 'FR'];
/** The speakers that really exist in the chosen layout (measurement, ART, FIR and routing only use these). SW1 = LFE output, SW2 = C by default. */
export const activeSpk = s => [...mainSpk(s), ...subSpk(s)];
export const SUB_DEFAULT = { xover: 80, slope: 24, gain: 0, delay: 0, invert: false, mono: true, mainsFull: false };
/** Bass management settings with defaults filled in (older saved states have none). Only LR4 (24 dB/oct) is generated. */
export const subOf = s => ({ ...SUB_DEFAULT, ...(s.room?.sub || {}) });
/** EQ APO channel names that carry a speaker in the chosen layout (the four main ones as before, plus the subs of a .1 / .2 layout). */
export const usedChannels = s => [...SPK, ...subSpk(s)].map(k => s.room.map[k]);
const chanOf = (s, k) => s.room.map?.[k] || ({ SW1: 'LFE', SW2: 'C' }[k] || k);

export function fxFilters(fx) {
  const f = [];
  if (Math.abs(fx.bass) >= 0.05) f.push({ type: 'LSC', fc: 105, gain: fx.bass, q: 0.7071 });
  if (Math.abs(fx.presence) >= 0.05) f.push({ type: 'PK', fc: 3000, gain: fx.presence, q: 1.0 });
  if (Math.abs(fx.treble) >= 0.05) f.push({ type: 'HSC', fc: 8000, gain: fx.treble, q: 0.7071 });
  fx.eq.forEach((g, i) => { if (Math.abs(g) >= 0.05) f.push({ type: 'PK', fc: EQ_BANDS[i], gain: g, q: 1.41 }); });
  f.push(...loudFilters(fx.loud));   // ISO 226 equal-loudness shelf pair (lab)
  return f;
}

const fmt = (x, d = 2) => {
  const s = (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
  return d > 0 ? s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : s;
};
const num = x => { const s = fmt(x, 4); return s.includes('.') ? s : s + '.0'; };

/** Headroom needed (dB, >= 0) to keep the chain from clipping. */
export function headroom(s) {
  let fx = 0;
  if (s.fx.on && !['measure', 'identify'].includes(s.room.mode)) {
    fx = Math.max(0, maxBoostDb(fxFilters(s.fx)));
    if (s.fx.width > 1) fx += 20 * Math.log10(s.fx.width);
    if (s.fx.rev.on) fx += 1.0 * s.fx.rev.wet;
  }
  let room = 0;
  for (const k of activeSpk(s)) {
    const c = s.room.ch[k];
    let b = Math.max(0, c.gain + (k.startsWith('SW') ? subOf(s).gain : 0));
    if (s.room.correction && c.corr && c.corr.filters?.length) b += Math.max(0, maxBoostDb(c.corr.filters));
    room = Math.max(room, b);
  }
  return Math.ceil((fx + room) * 2) / 2;
}

function fxBlock(s, ctx) {
  const fx = s.fx, out = [];
  out.push('# --- FX (stereo, before routing)', 'Channel: L R');
  const total = (fx.autoHeadroom ? -headroom(s) : 0) + fx.preamp;
  if (Math.abs(total) >= 0.05) out.push(`Preamp: ${fmt(total, 1)} dB`);
  for (const f of fxFilters(fx)) out.push(filterLine(f));
  if (Math.abs(fx.width - 1) >= 0.01) {
    const a = (1 + fx.width) / 2, b = (1 - fx.width) / 2;
    out.push(`Copy: L=${num(a)}*L+${num(b)}*R R=${num(b)}*L+${num(a)}*R`);
  }
  if (Math.abs(fx.balance) >= 0.01) {
    const lg = fx.balance > 0 ? 20 * Math.log10(1 - fx.balance) : 0;
    const rg = fx.balance < 0 ? 20 * Math.log10(1 + fx.balance) : 0;
    if (lg) out.push('Channel: L', `Preamp: ${fmt(Math.max(lg, -60), 1)} dB`);
    if (rg) out.push('Channel: R', `Preamp: ${fmt(Math.max(rg, -60), 1)} dB`);
  }
  if (fx.rev.on && fx.rev.wet > 0 && ctx.irRates?.length) {
    out.push('Channel: L R');
    ctx.irRates.forEach((sr, i) => {
      out.push(`${i ? 'ElseIf' : 'If'}: sampleRate == ${sr}`, `Convolution: fono\\ir_${sr}.wav`);
    });
    out.push('EndIf:');
  }
  return out;
}

function firLines(s, key, ctx) {
  const f = ctx.fir;
  if (!f || !f.rates?.length || !s.room.fir?.on) return [];
  if (f.chans.includes(key)) {
    const out = [];
    f.rates.forEach((sr, i) => out.push(`${i ? 'ElseIf' : 'If'}: sampleRate == ${sr}`, `Convolution: fono\\fir_${key}_${sr}.wav`));
    out.push('EndIf:');
    return out;
  }
  return [`Delay: ${fmt(f.latencyMs, 3)} ms`]; // keep channels without FIR time-aligned
}

/** LR4 = two cascaded 2nd-order Butterworth sections. */
const lr4 = (kind, hz) => { const l = `Filter: ON ${kind} Fc ${fmt(hz, 0)} Hz Q 0.707`; return [l, l]; };

function speakerStage(s, key, role, ctx = {}) {
  const r = s.room, ch = chanOf(s, key), out = [`Channel: ${ch}`];
  const isSub = key.startsWith('SW'), sub = subOf(s);
  // a subwoofer adds the global bass-management gain / delay / polarity on top of its own strip
  const c = isSub ? { ...r.ch[key], gain: r.ch[key].gain + sub.gain, delay: r.ch[key].delay + sub.delay, invert: r.ch[key].invert !== !!sub.invert } : r.ch[key];
  if (c.mute) { out.push(`Copy: ${ch}=0.0`); return out; }
  if (role === 'measure' && r.measureRaw) return out;
  if (Math.abs(c.gain) >= 0.05) out.push(`Preamp: ${fmt(c.gain, 1)} dB`);
  if (c.invert) out.push(`Copy: ${ch}=-1*${ch}`);
  if (c.delay >= 0.01) out.push(`Delay: ${fmt(c.delay, 2)} ms`);
  // ART owns the bass below its hand-over; the normal correction still applies above fc * 1.5 (and never as a low shelf)
  const corr = role !== 'art' ? c.corr?.filters : c.corr?.filters?.filter(f => f.fc > (r.art?.fc || 120) * 1.5 && !/^LS/.test(f.type));
  if (r.correction && corr?.length) {
    out.push(`# correction: ${String(c.corr.name || 'REW').replace(/[^\x20-\x7e]/g, '?')}${role === 'art' ? ' (above ART hand-over only)' : ''}`);
    for (const f of corr) out.push(filterLine(f));
  }
  const rear = key === 'SL' || key === 'SR';
  const bm = !!ctx.bm && ['stereo', 'quadA', 'quadB', 'measure'].includes(role);   // bass management active for this stage
  if (rear && role === 'quadA' && r.rearLP) out.push(`Filter: ON LP Fc ${fmt(r.rearLPHz, 0)} Hz Q 0.707`);
  if (rear && role === 'quadB' && !ctx.bm) out.push(...lr4('LP', r.xover));
  if (bm && isSub) out.push(`# bass management: LR4 low-pass ${fmt(sub.xover, 0)} Hz`, ...lr4('LP', sub.xover));
  else if (bm && !sub.mainsFull) out.push(`# bass management: LR4 high-pass ${fmt(sub.xover, 0)} Hz`, ...lr4('HP', sub.xover));
  if (r.correction && role !== 'identify') out.push(...firLines(s, key, ctx));
  return out;
}

function deviceBody(s, ctx0, role, multi = false) {
  const r = s.room, m = r.map, out = [], act = activeSpk(s), rear = hasRear(s), subs = subSpk(s);
  // bass management (sub crossover) only exists on the multichannel card; the stereo DAC carries the full-range front pair
  const ctx = { ...ctx0, bm: multi && subs.length > 0 };
  // 2.x / headphones layouts: only the front pair exists; every quad / ART mode collapses to stereo and the rear channels are muted
  if (!rear && !['stereo', 'measure', 'identify'].includes(role) && !(role === 'art' && subs.length)) role = 'stereo';   // 2.1 / 2.2: ART may use the subwoofers as its helpers
  const muteRear = () => { if (multi && !rear) out.push('# rear channels muted (layout ' + layoutOf(s) + ')', 'Channel: all', `Copy: ${m.SL}=0.0 ${m.SR}=0.0`); };
  const routed = ctx.bm ? [...SPK, ...subs] : SPK;
  if (role === 'identify') {
    const tgt = act.includes(r.identify) ? r.identify : 'FL';
    out.push('# --- channel identify: left input goes only to ' + tgt, 'Channel: all');
    out.push('Copy: ' + routed.map(k => `${chanOf(s, k)}=${k === tgt ? 'L' : '0.0'}`).join(' '));
    return out;
  }
  if (role === 'measure') {
    const tgt = act.includes(r.measureTarget) ? r.measureTarget : 'FL';
    out.push('# --- measurement routing: REW left -> ' + tgt + ', REW right (timing ref) -> FL', 'Channel: all');
    const hr = headroom(s);
    if (hr > 0) out.push(`Preamp: ${fmt(-hr, 1)} dB`);
    out.push('Copy: ' + routed.map(k => {
      const isT = k === tgt, isRef = k === 'FL';
      const v = isT && isRef ? '1.0*L+1.0*R' : isT ? 'L' : isRef ? 'R' : '0.0';
      return `${chanOf(s, k)}=${v}`;
    }).join(' '));
    for (const k of act) out.push(...speakerStage(s, k, role, ctx));
    return out;
  }
  // ART sources that exist in this layout (a design built for another layout loses the speakers that are gone); fewer than two = front pair only
  const artKeys = ctx.art ? (ctx.art.keys || ART_SPK).filter(k => act.includes(k)) : [];
  if (role === 'art' && (!ctx.art || artKeys.length < 2 || (!rear && !artKeys.some(k => k.startsWith('SW'))))) role = 'stereo';
  if (s.fx.on) out.push(...fxBlock(s, ctx));
  else {
    const hr = headroom(s);
    out.push('Channel: L R');
    if (hr > 0) out.push(`Preamp: ${fmt(-hr, 1)} dB`);
  }
  // sub feeds are taken from the stereo bus before any per-speaker stage: (L+R)/2 for both subs, or L / R when mono is off in a 2.2 layout
  const subFeed = () => {
    if (!ctx.bm) return;
    const st = subOf(s);
    out.push(`# --- bass management: ${subs.length} sub, ${st.mono || subs.length < 2 ? 'mono (L+R)/2' : 'SW1=L SW2=R'}, LR4 ${fmt(st.xover, 0)} Hz${st.mainsFull ? ', mains full range' : ''}`, 'Channel: all');
    out.push('Copy: ' + subs.map((k, i) => `${chanOf(s, k)}=${st.mono || subs.length < 2 ? '0.5*L+0.5*R' : i ? 'R' : 'L'}`).join(' '));
  };
  const subStages = () => { if (ctx.bm) for (const k of subs) out.push(...speakerStage(s, k, role, ctx)); };
  if (role === 'art') {
    out.push(...artConfig(s, { ...ctx, art: { ...ctx.art, keys: artKeys } }, speakerStage));
    const idle = subs.filter(k => !artKeys.includes(k));
    if (ctx.bm && idle.length) out.push('# subwoofers without an ART filter stay silent', 'Channel: all', `Copy: ${idle.map(k => chanOf(s, k) + '=0.0').join(' ')}`);
    return out;
  }
  if (role === 'stereo') {
    out.push('# --- room: stereo (front pair only)');
    subFeed();
    for (const k of ['FL', 'FR']) out.push(...speakerStage(s, k, role, ctx));
    muteRear();
    subStages();
    return out;
  }
  out.push(`# --- room: ${role === 'quadA' ? 'A ambience (rear delayed)' : 'B bass reinforcement (rear low-passed)'}`);
  subFeed();
  if (role === 'quadA' && r.hafler) out.push(`Copy: ${m.SL}=0.5*L+-0.5*R ${m.SR}=0.5*R+-0.5*L`);
  else out.push(`Copy: ${m.SL}=L ${m.SR}=R`);
  for (const k of SPK) out.push(...speakerStage(s, k, role, ctx));
  subStages();
  return out;
}

/** Headphone profile block (AutoEq + crossfeed), applied per output device. */
export function headphoneBody(s, prof, ctx) {
  const out = [];
  if (prof.fx && s.fx.on) out.push(...fxBlock({ ...s, room: { ...s.room, correction: false } }, ctx));
  out.push('# --- headphone profile: ' + (String(prof.name || '').replace(/[^\x20-\x7e]/g, '').replace(/^\s*\(|\)\s*$/g, '').replace(/\s+/g, ' ').trim() || 'device'), 'Channel: L R');
  const ae = prof.autoeq;
  if (ae?.filters?.length && prof.eqOn !== false) {
    if (ae.preamp) out.push(`Preamp: ${fmt(ae.preamp, 1)} dB`);
    for (const f of ae.filters) out.push(filterLine(f));
  }
  if (Math.abs(prof.bass || 0) >= 0.1) out.push(filterLine({ type: 'LSC', fc: 105, gain: prof.bass, q: 0.707 }));
  if (Math.abs(prof.treble || 0) >= 0.1) out.push(filterLine({ type: 'HSC', fc: 8000, gain: prof.treble, q: 0.707 }));
  const cf = prof.crossfeed;
  if (cf?.on) {
    out.push('# crossfeed: delayed, low-passed copy of the opposite ear',
      'Copy: XFL=L XFR=R', 'Channel: XFL XFR',
      `Filter: ON LP Fc ${fmt(cf.fc || 700, 0)} Hz Q 0.5`,
      `Delay: ${fmt(cf.delay ?? 0.3, 2)} ms`, `Preamp: ${fmt(cf.level ?? -6, 1)} dB`,
      'Copy: L=L+XFR R=R+XFL', 'Channel: L R', `Preamp: ${fmt(Math.min(0, 20 * Math.log10(1 / (1 + Math.pow(10, (cf.level ?? -6) / 20)))), 1)} dB`);
  }
  return out;
}

export function genConfig(s, ctx = {}) {
  const L = [
    '# Fono Console - generated ' + new Date().toISOString(),
    '# This file is rewritten by Fono Console; edit settings in the app instead.',
    '',
  ];
  const mode = s.room.mode;
  const cm = (s.dev.cm || '').trim(), sp = (s.dev.spark || '').trim();
  for (const [guid, prof] of Object.entries(s.hp?.profiles || {})) {
    if (!guid || guid === cm || guid === sp || prof.enabled === false) continue;
    L.push('', `Device: ${guid}`, ...headphoneBody(s, prof, ctx));
  }
  if (!cm && !sp) {
    L.push('Device: all', ...deviceBody(s, ctx, mode, true));
  } else {
    if (sp && sp !== cm) {
      const hp = s.dev.sparkLoad === 'headphones' ? s.hp?.profiles?.[sp] : null;
      if (hp && hp.enabled !== false) L.push('', `Device: ${sp}`, '# stereo DAC is driving headphones', ...headphoneBody(s, hp, ctx));
      else if (hp) L.push('', `Device: ${sp}`, '# stereo DAC on headphones, profile off', 'Channel: all');
      else L.push('', `Device: ${sp}`, ...deviceBody(s, ctx, 'stereo'));
    }
    if (cm) L.push('', `Device: ${cm}`, ...deviceBody(s, ctx, mode, true));
  }
  L.push('', 'Device: all', 'Channel: all', '');
  return L.join('\n');
}

/** Delay suggestion from arrival times (ms, REW acoustic timing reference). */
export function alignDelays(t, mode) {
  const tf = Math.max(t.FL, t.FR), tr = Math.max(t.SL, t.SR); // arrival after pair alignment
  const out = { FL: 0, FR: 0, SL: 0, SR: 0 };
  // Left/right inside each pair: delay the earlier speaker.
  const pair = (a, b) => { const d = t[a] - t[b]; if (d > 0) out[b] += d; else out[a] += -d; };
  pair('FL', 'FR'); pair('SL', 'SR');
  if (mode === 'quadA') {
    const d = tf - tr + 15;
    if (d > 0) { out.SL += d; out.SR += d; } else { out.FL += -d; out.FR += -d; }
  } else {
    const d = tf - tr;
    if (d > 0) { out.SL += d; out.SR += d; } else { out.FL += -d; out.FR += -d; }
  }
  // Remove the common offset so the smallest delay is 0.
  const mn = Math.min(...Object.values(out));
  for (const k in out) out[k] = Math.round((out[k] - mn) * 100) / 100;
  return out;
}
