// App state, presets and persistence.
const ch = () => ({ gain: 0, delay: 0, invert: false, mute: false, corr: null });

export function defaultState() {
  return {
    v: 1,
    theme: 'dark',
    ui: { lang: '', skin: 'mixer', accent: '', play: 'deck', meter: 'needle', vinyl: { color: 'black', deck: 'wood' }, cassette: { shell: 'clear' }, lid: true, setupDone: false, texture: { kind: 'auto', amount: 0.5 }, palette: { id: '' }, wall: { src: '', fit: 'cover', dim: 0.35, blur: 0, panelAlpha: 0.72, panelBlur: 16, immersive: true, ov: {} }, layout: {}, rail: { order: [], hidden: [] }, pages: [], features: { lib: true, hp: true, fir: true, rew: false, noise: false, modes: false, reverb: true, art: false, scan: false, refl: false, micpair: false, loud: false, target: true, decay: true } },
    page: 'play',
    fx: {
      on: true, autoHeadroom: true, preamp: 0,
      bass: 0, presence: 0, treble: 0, width: 1, balance: 0,
      eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preset: 'flat',
      rev: { on: false, wet: 0.18, rt60: 1.8, predelay: 18, damping: 0.45, early: true, src: 'gen', customName: '' },
      loud: { on: false, level: 70 },   // equal-loudness compensation (ISO 226): listening level in phon, reference 83
    },
    room: {
      layout: '4.0',          // speaker layout: 'hp' headphones only | '2.0' front pair | '4.0' front + rear pair; '.1' / '.2' suffix = one / two subwoofers
      mode: 'quadA', correction: true,
      hafler: false, rearLP: true, rearLPHz: 7000, xover: 100,
      measureTarget: 'FL', identify: 'FL',
      map: { FL: 'L', FR: 'R', SL: 'SL', SR: 'SR', SW1: 'LFE', SW2: 'C' },
      sub: { xover: 80, slope: 24, gain: 0, delay: 0, invert: false, mono: true, mainsFull: false, align: null },   // bass management for the .1 / .2 layouts: LR4 crossover; align = last auto-alignment report
      ch: { FL: ch(), FR: ch(), SL: { ...ch(), gain: -6, delay: 15 }, SR: { ...ch(), gain: -6, delay: 15 }, SW1: ch(), SW2: ch() },
      align: { FL: 0, FR: 0, SL: 0, SR: 0 },
      measureRaw: false,
      fir: { on: false, mode: 'model', lo: 200, hi: 12000, model: { xover: 3000, hpFreq: 50, hpOrder: 4 }, chans: ['FL', 'FR'], latencyMs: 0, built: '' },
      art: { fc: 120, capDb: 12, fLow: 35, tauMs: 50, built: '', preampDb: 0, report: null, robust: true, auto: true, headroom: true, preRing: false, bass: 'mains', weights: null, keys: [], verify: null },
      target: null,          // [[f,dB],...] auto-EQ target; null = the classic low-frequency shelf (meas.lfRise)
      pos: {},               // metres: {seat:[x,y], ear:1.1, FL:[x,y,z], ...} - x along the room length from the front wall, y across from the left wall
    },
    hp: { profiles: {} },
    lib: { source: 'all', recent: [] },
    meas: { positions: 1, sweeps: 2, checks: true, level: -12, lfRise: 2, fmax: 0, maxFilters: 8, settleMs: 900, routeSaved: null, results: {} },   // routeSaved: the listening mode to put back while a measurement route is active (crash repair at start-up)
    dev: { cm: '', spark: '', autoSwitch: true, sparkLoad: 'speakers' },
    rew: { port: 4735, exe: '', smoothing: 12, showModes: true },
    dims: { L: 3.5, W: 3.0, H: 2.6, rt60: 0.4 },
    mic: { deviceId: '', cal: {}, pairSweeps: 4, rtaAvg: 'live', channel: {} },   // channel[deviceId]: 'mix' | 'L' | 'R' (two mics on a merge cable)
    spk: {},
  };
}

export const PRESETS = {
  flat:    { name: '平直', fx: { bass: 0, presence: 0, treble: 0, width: 1, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], rev: { on: false } } },
  hall:    { name: '音樂廳', fx: { bass: 1, presence: 0, treble: 0.5, width: 1.12, eq: [0, 0.5, 0, 0, 0, 0, 0, 0, 0.5, 0.5], rev: { on: true, wet: 0.24, rt60: 2.3, predelay: 24, damping: 0.5, early: true } } },
  chamber: { name: '室內樂', fx: { bass: 0, presence: 0.5, treble: 0.5, width: 1.05, eq: [0, 0, 0, -0.5, 0, 0, 0.5, 0.5, 0, 0], rev: { on: true, wet: 0.14, rt60: 1.2, predelay: 12, damping: 0.4, early: true } } },
  vocal:   { name: '人聲', fx: { bass: -1, presence: 2, treble: 0.5, width: 1, eq: [0, 0, -0.5, -1, 0, 0.5, 1.5, 1, 0, 0], rev: { on: true, wet: 0.08, rt60: 0.9, predelay: 8, damping: 0.5, early: false } } },
  warm:    { name: '溫暖', fx: { bass: 2, presence: -0.5, treble: -1.5, width: 1, eq: [0.5, 0.5, 1, 0.5, 0, 0, 0, -0.5, -0.5, -1], rev: { on: false } } },
  night:   { name: '深夜', fx: { bass: -3, presence: 1, treble: -1, width: 0.9, eq: [-2, -1.5, -1, 0, 0, 0, 0.5, 0, -0.5, -1], rev: { on: false } } },
};

export function applyPreset(s, id) {
  const p = PRESETS[id];
  if (!p) return;
  const { rev, ...rest } = p.fx;
  Object.assign(s.fx, structuredClone(rest));
  Object.assign(s.fx.rev, rev);
  s.fx.preset = id;
}

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) && (over.length === base.length || typeof base[0] !== 'number') ? over : base;
  if (base && typeof base === 'object') {
    const out = { ...base };
    if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
    return out;
  }
  return over === undefined || typeof over !== typeof base ? base : over;
}

export async function loadState() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    const j = await r.json();
    // v5: texture was a boolean before the look system
    if (j?.ui && typeof j.ui.texture === 'boolean') j.ui.texture = j.ui.texture ? { kind: 'grain', amount: 0.5 } : { kind: 'none', amount: 0.5 };
    const s = deepMerge(defaultState(), j);
    // corr may be null in defaults: keep saved objects.
    for (const k of ['FL', 'FR', 'SL', 'SR', 'SW1', 'SW2']) if (j?.room?.ch?.[k]?.corr) s.room.ch[k].corr = j.room.ch[k].corr;
    if (!['hp', '2.0', '2.1', '2.2', '4.0', '4.1', '4.2'].includes(s.room.layout)) s.room.layout = '4.0';
    return s;
  } catch { return defaultState(); }
}

let saveTimer = null;
const post = s => fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).catch(() => {});
/** Debounced save (400 ms); now = true writes immediately and returns the promise (used when a crash must find the right state on disk). */
export function saveState(s, now = false) {
  clearTimeout(saveTimer);
  if (now) return post(s);
  saveTimer = setTimeout(() => post(s), 400);
}
