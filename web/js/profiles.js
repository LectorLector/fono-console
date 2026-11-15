// Correction profiles: named snapshots of the correction-related state (S.profiles = [{id, name, created, data}]).
// Pure functions (no DOM); tested in tests/profiles.test.mjs.
//
// What a profile holds (data.room): per-speaker strips (gain / delay / polarity / mute / PEQ correction), align, sub (bass management),
// fir + art + stereo symmetry settings, target curve, correction on/off, hafler, rear low-pass, crossover. Optionally data.fx (effects).
// What it never holds or changes: device selection (S.dev), the speaker layout (S.room.layout), the channel map, the listening mode,
// the room geometry and measurement results.
// FIR / ART / stereo-phase "built" results are files on disk (latest build only): a profile restores their settings, and their
// on/off + built stamps only when the same build is still the current one; otherwise they stay as they are and a warning is returned.
import { LAYOUTS } from './eapo.js';

export const PROFILE_VERSION = 1, MAX_PROFILES = 50, MAX_NAME = 60;
const CH_KEYS = ['FL', 'FR', 'SL', 'SR', 'SW1', 'SW2'];
const ROOM_KEYS = ['ch', 'align', 'sub', 'fir', 'art', 'stereo', 'target', 'correction', 'hafler', 'rearLP', 'rearLPHz', 'xover'];
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Keys of each sub-object that describe a build on disk (applied only when the stamp matches the current build). */
const FIR_BUILT = ['on', 'built', 'latencyMs'];
const ART_BUILT = ['built', 'preampDb', 'report', 'keys', 'verify'];

export function newId(existing = []) {
  let id; do { id = 'p' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); } while (existing.some(p => p.id === id));
  return id;
}

/** Snapshot the current correction state. includeFx also stores the effects chain (S.fx). */
export function snapshotProfile(S, { includeFx = false } = {}) {
  const room = {};
  for (const k of ROOM_KEYS) if (S.room[k] !== undefined) room[k] = clone(S.room[k]);
  const data = { v: PROFILE_VERSION, layout: S.room.layout, room };
  if (includeFx) data.fx = clone(S.fx);
  return data;
}

export function makeProfile(S, name, opt = {}) {
  return { id: newId(S.profiles || []), name: cleanName(name), created: new Date().toISOString(), data: snapshotProfile(S, opt) };
}

export const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || 'Profile';

function validFilter(f) {
  return isObj(f) && typeof f.type === 'string' && f.type.length <= 8 && num(f.fc, 1, 96000) && num(f.gain ?? 0, -60, 60) && num(f.q ?? 0.7071, 0.01, 1000);
}
function validCorr(c) {
  return c === null || c === undefined || (isObj(c) && Array.isArray(c.filters) && c.filters.length <= 64 && c.filters.every(validFilter));
}

/** Check a profile's data. Returns {ok, errors:[string]} (English ids, shown to the user as a short list). */
export function validateProfileData(d) {
  const e = [];
  if (!isObj(d)) return { ok: false, errors: ['data is not an object'] };
  if (d.v !== PROFILE_VERSION) e.push('unsupported data version ' + d.v);
  if (!LAYOUTS.includes(d.layout)) e.push('unknown layout ' + d.layout);
  const r = d.room;
  if (!isObj(r)) e.push('room missing');
  else {
    for (const k of Object.keys(r)) if (!ROOM_KEYS.includes(k)) e.push('unknown room key ' + k);
    if (r.ch !== undefined) {
      if (!isObj(r.ch)) e.push('ch is not an object');
      else for (const [k, c] of Object.entries(r.ch)) {
        if (!CH_KEYS.includes(k)) { e.push('unknown channel ' + k); continue; }
        if (!isObj(c)) { e.push(k + ' is not an object'); continue; }
        if (!num(c.gain, -60, 30)) e.push(k + ' gain out of range');
        if (!num(c.delay, 0, 1000)) e.push(k + ' delay out of range');
        if (typeof c.invert !== 'boolean') e.push(k + ' invert');
        if (c.mute !== undefined && typeof c.mute !== 'boolean') e.push(k + ' mute');
        if (!validCorr(c.corr)) e.push(k + ' correction filters');
      }
    }
    if (r.align !== undefined && (!isObj(r.align) || !Object.values(r.align).every(v => num(v, -1000, 1000)))) e.push('align');
    if (r.sub !== undefined) {
      const s = r.sub;
      if (!isObj(s) || !num(s.xover, 20, 500) || !num(s.gain, -60, 30) || !num(s.delay, 0, 1000) || typeof s.invert !== 'boolean') e.push('sub');
    }
    if (r.fir !== undefined && (!isObj(r.fir) || typeof r.fir.on !== 'boolean' || !num(r.fir.lo, 1, 24000) || !num(r.fir.hi, 1, 24000))) e.push('fir');
    if (r.art !== undefined && (!isObj(r.art) || !num(r.art.fc, 10, 1000) || !num(r.art.capDb, 0, 40) || !num(r.art.tauMs, 1, 1000))) e.push('art');
    if (r.stereo !== undefined) {
      const s = r.stereo;
      if (!isObj(s) || typeof s.matchOn !== 'boolean' || !isObj(s.band) || !isObj(s.match) || !isObj(s.phase)) e.push('stereo');
      else for (const k of ['FL', 'FR']) if (s.match[k] !== undefined && !(Array.isArray(s.match[k]) && s.match[k].length <= 64 && s.match[k].every(validFilter))) e.push('stereo match ' + k);
    }
    if (r.target !== undefined && r.target !== null && !(Array.isArray(r.target) && r.target.length <= 512 && r.target.every(p => Array.isArray(p) && p.length === 2 && num(p[0], 1, 96000) && num(p[1], -100, 100)))) e.push('target');
    for (const k of ['correction', 'hafler', 'rearLP']) if (r[k] !== undefined && typeof r[k] !== 'boolean') e.push(k);
    if (r.rearLPHz !== undefined && !num(r.rearLPHz, 20, 24000)) e.push('rearLPHz');
    if (r.xover !== undefined && !num(r.xover, 20, 500)) e.push('xover');
  }
  if (d.fx !== undefined) {
    const f = d.fx;
    if (!isObj(f) || typeof f.on !== 'boolean' || !Array.isArray(f.eq) || f.eq.length !== 10 || !f.eq.every(v => num(v, -30, 30)) || !num(f.preamp, -60, 30)) e.push('fx');
  }
  if (JSON.stringify(d).length > 2_000_000) e.push('too large');
  return { ok: !e.length, errors: e };
}

export function validateProfile(p) {
  const e = [];
  if (!isObj(p)) return { ok: false, errors: ['profile is not an object'] };
  if (typeof p.id !== 'string' || !/^[\w-]{1,40}$/.test(p.id)) e.push('id');
  if (typeof p.name !== 'string' || !p.name.trim()) e.push('name');
  if (typeof p.created !== 'string' || Number.isNaN(Date.parse(p.created))) e.push('created');
  const d = validateProfileData(p.data);
  return { ok: !e.length && d.ok, errors: [...e, ...d.errors] };
}

/** Layout of a profile vs the current layout. */
export const layoutMismatch = (S, p) => p.data.layout !== S.room.layout;

const sameBuild = (a, b) => !!a && a === b;

/**
 * Apply a profile to S (in place). Never touches S.dev, S.room.layout / map / mode / pos, measurement results.
 * Returns {applied, warnings: [ids]}: 'layout' (saved for another layout), 'fir-stale' / 'art-stale' / 'phase-stale' (a FIR / ART / phase build on disk is not the one the profile was saved with, so it was not switched).
 */
export function applyProfile(S, p) {
  const v = validateProfile(p);
  if (!v.ok) return { applied: false, warnings: [], errors: v.errors };
  const d = clone(p.data), r = S.room, w = [];
  if (layoutMismatch(S, p)) w.push('layout');
  const R = d.room;
  for (const k of ['correction', 'hafler', 'rearLP', 'rearLPHz', 'xover', 'target']) if (R[k] !== undefined) r[k] = R[k];
  if (R.ch) for (const k of Object.keys(R.ch)) r.ch[k] = { ...r.ch[k], ...R.ch[k] };
  if (R.align) r.align = { ...r.align, ...R.align };
  if (R.sub) r.sub = { ...r.sub, ...R.sub };
  if (!/^4/.test(S.room.layout)) r.hafler = false;   // Hafler ambience needs a rear pair
  if (R.fir) {
    const same = sameBuild(R.fir.built, r.fir.built);
    for (const k of Object.keys(R.fir)) if (same || !FIR_BUILT.includes(k)) r.fir[k] = R.fir[k];
    if (!same && (R.fir.on || R.fir.built)) w.push('fir-stale');
  }
  if (R.art) {
    const same = sameBuild(R.art.built, r.art.built);
    for (const k of Object.keys(R.art)) if (same || !ART_BUILT.includes(k)) r.art[k] = R.art[k];
    if (!same && R.art.built) w.push('art-stale');
  }
  if (R.stereo) {
    const st = r.stereo, ps = R.stereo;
    for (const k of ['matchOn', 'band', 'match']) if (ps[k] !== undefined) st[k] = ps[k];
    const same = sameBuild(ps.phase.built, st.phase.built);
    for (const k of Object.keys(ps.phase)) if (same || !['built', 'latencyMs', 'chans'].includes(k)) st.phase[k] = ps.phase[k];
    if (same) st.phaseOn = ps.phaseOn; else if (ps.phaseOn || ps.phase.built) w.push('phase-stale');
  }
  if (d.fx) { const keep = S.fx.rev.src === 'custom' ? { customName: S.fx.rev.customName } : {}; S.fx = { ...S.fx, ...d.fx, rev: { ...S.fx.rev, ...d.fx.rev, ...keep } }; }
  return { applied: true, warnings: w };
}

/** Index of a profile by id, or -1. */
export const findProfile = (S, id) => (S.profiles || []).findIndex(p => p.id === id);

export function renameProfile(S, id, name) {
  const p = (S.profiles || []).find(x => x.id === id); if (!p) return false;
  p.name = cleanName(name); return true;
}
export function deleteProfile(S, id) {
  const i = findProfile(S, id); if (i < 0) return false;
  S.profiles.splice(i, 1);
  const ab = S.ui.ab; if (ab) { if (ab.a === id) ab.a = ''; if (ab.b === id) ab.b = ''; if (!ab.a || !ab.b) ab.cur = ''; }
  return true;
}

// ---------------------------------------------------------------- export / import
export const exportProfiles = (list, app = 'Fono Console') => ({ kind: 'fono-profiles', v: PROFILE_VERSION, app, exported: new Date().toISOString(), profiles: clone(list) });

/**
 * Validate an imported JSON (parsed). Accepts {kind:'fono-profiles', profiles:[...]} or one bare profile.
 * Returns {ok, profiles: [valid, with fresh ids / unique names], skipped: [{name, errors}], error}.
 */
export function importProfiles(S, json) {
  let list;
  if (isObj(json) && json.kind === 'fono-profiles' && Array.isArray(json.profiles)) list = json.profiles;
  else if (isObj(json) && json.data && json.name) list = [json];
  else return { ok: false, profiles: [], skipped: [], error: 'not-profiles' };
  if (json.v !== undefined && json.v > PROFILE_VERSION) return { ok: false, profiles: [], skipped: [], error: 'newer-version' };
  const have = [...(S.profiles || [])], out = [], skipped = [];
  for (const raw of list.slice(0, MAX_PROFILES)) {
    const v = validateProfile({ ...raw, id: typeof raw?.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : 'x' });
    if (!v.ok) { skipped.push({ name: String(raw?.name ?? '?').slice(0, 40), errors: v.errors.slice(0, 3) }); continue; }
    if (have.length + out.length >= MAX_PROFILES) { skipped.push({ name: String(raw.name).slice(0, 40), errors: ['too many profiles'] }); continue; }
    let name = cleanName(raw.name); const names = [...have, ...out].map(p => p.name);
    for (let n = 2; names.includes(name); n++) name = cleanName(raw.name).slice(0, MAX_NAME - 4) + ' ' + n;
    out.push({ id: newId([...have, ...out]), name, created: raw.created, data: clone(raw.data) });
  }
  return { ok: out.length > 0, profiles: out, skipped, error: out.length ? '' : 'nothing-valid' };
}

// ---------------------------------------------------------------- A/B
/** The profile the A/B key would switch to next, or null when A/B is not set up. */
export function abNext(S) {
  const ab = S.ui.ab; if (!ab || !ab.a || !ab.b || ab.a === ab.b) return null;
  const pa = (S.profiles || []).find(p => p.id === ab.a), pb = (S.profiles || []).find(p => p.id === ab.b);
  if (!pa || !pb) return null;
  return ab.cur === 'a' ? { which: 'b', profile: pb } : { which: 'a', profile: pa };
}
/** Toggle A/B. Refuses (returns {ok:false, why}) when the profile belongs to another layout. */
export function abToggle(S) {
  const nx = abNext(S); if (!nx) return { ok: false, why: 'not-set' };
  if (layoutMismatch(S, nx.profile)) return { ok: false, why: 'layout' };
  const r = applyProfile(S, nx.profile);
  if (!r.applied) return { ok: false, why: 'invalid' };
  S.ui.ab.cur = nx.which;
  return { ok: true, which: nx.which, name: nx.profile.name, warnings: r.warnings };
}
