// 曲庫: one search and shelf over Spotify (Web API), YouTube Music (desktop app
// API + public pages) and every other player Windows can see (media sessions).
import { h, $, toast, api, post } from './ui.js';
import { keys } from './widgets.js';
import { t as tl, isEn } from './i18n.js';
import { parseSearch, parseBrowse } from './ytm.js';

const YTM_PARAMS = {
  song: 'EgWKAQIIAWoSEAMQCRAEEBAQBRAKEA4QFRAR',
  album: 'EgWKAQIYAWoSEAMQCRAEEBAQBRAKEA4QFRAR',
  playlist: 'EgeKAQQoADgBahIQAxAJEAQQEBAFEAoQDhAVEBE=',
};
const SRC_NAME = { spotify: 'Spotify', ytm: 'YouTube Music' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtMs = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

let C; // context from app.js: { S, RT, saveState, pauseOthers, refreshMedia }
const L = { sp: { configured: false, connected: false }, ytm: { running: false, installed: false }, results: null, mine: null, open: null, busy: false };

// ---------------------------------------------------------------- Spotify provider
const sp = {
  async get(path) { const r = await fetch('/api/spotify/api/' + path); if (!r.ok) { const e = new Error('Spotify ' + r.status); e.status = r.status; throw e; } return r.status === 204 ? null : r.json(); },
  async send(method, path, body) {
    const r = await fetch('/api/spotify/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok && r.status !== 204) { let m = ''; try { m = (await r.json()).error?.message || ''; } catch {} const e = new Error(m || 'Spotify ' + r.status); e.status = r.status; throw e; }
  },
  img: o => o?.images?.[0]?.url || o?.album?.images?.[0]?.url || '',
  mapAlbum: a => ({ source: 'spotify', kind: 'album', id: a.id, uri: a.uri, title: a.name, artist: (a.artists || []).map(x => x.name).join(', '), subtitle: [a.release_date?.slice(0, 4), a.total_tracks ? tl(`${a.total_tracks} 首`) : ''].filter(Boolean).join(' · '), thumb: sp.img(a) }),
  mapPlaylist: p => ({ source: 'spotify', kind: 'playlist', id: p.id, uri: p.uri, title: p.name, artist: p.owner?.display_name || '', subtitle: p.items?.total != null ? tl(`${p.items.total} 首`) : p.tracks?.total != null ? tl(`${p.tracks.total} 首`) : '', thumb: sp.img(p), own: !!p.owner && p.owner.id === L.sp.me }),
  mapTrack: t => ({ source: 'spotify', kind: 'song', id: t.id, uri: t.uri, title: t.name, artist: (t.artists || []).map(x => x.name).join(', '), album: t.album?.name || '', duration: t.duration_ms ? fmtMs(t.duration_ms) : '', thumb: sp.img(t) }),
  async search(q, type) {
    const types = type === 'all' ? 'album,playlist,track' : { album: 'album', playlist: 'playlist', song: 'track' }[type];
    const j = await sp.get(`search?q=${encodeURIComponent(q)}&type=${types}&limit=10`);
    return {
      albums: (j.albums?.items || []).filter(Boolean).map(sp.mapAlbum),
      playlists: (j.playlists?.items || []).filter(Boolean).map(sp.mapPlaylist),
      songs: (j.tracks?.items || []).filter(Boolean).map(sp.mapTrack),
    };
  },
  async mine() {
    const [me, pl, al] = await Promise.all([sp.get('me').catch(() => null), sp.get('me/playlists?limit=50').catch(() => null), sp.get('me/albums?limit=50').catch(() => null)]);
    L.sp.me = me?.id;
    return [...(al?.items || []).map(x => sp.mapAlbum(x.album)), ...(pl?.items || []).filter(Boolean).map(sp.mapPlaylist)];
  },
  async open(it) {
    if (it.kind === 'album') {
      const a = await sp.get('albums/' + it.id);
      return { ...it, thumb: sp.img(a) || it.thumb, subtitle: [a.release_date, a.label].filter(Boolean).join(' · '), tracks: (a.tracks?.items || []).map(t => ({ ...sp.mapTrack({ ...t, album: a }), thumb: sp.img(a) })) };
    }
    try {
      const j = await sp.get(`playlists/${it.id}/items?limit=100`);
      const tracks = (j.items || []).map(e => e.item || e.track).filter(t => t && t.uri && t.type !== 'episode').map(sp.mapTrack);
      return { ...it, tracks };
    } catch (e) {
      if (e.status === 403 || e.status === 404) return { ...it, tracks: [], note: 'Spotify 開發模式只允許讀取你自己建立或共同編輯的歌單內容；這張歌單仍可以整張播放。' };
      throw e;
    }
  },
  async device() {
    for (let i = 0; i < 4; i++) {
      const j = await sp.get('me/player/devices');
      const list = j?.devices || [];
      const d = list.find(x => x.is_active) || list.find(x => x.type === 'Computer') || list[0];
      if (d) return d.id;
      if (i === 0) { post('/api/launch', { app: 'spotify' }); toast('正在開啟 Spotify…'); }
      await sleep(2500);
    }
    throw new Error('找不到可播放的 Spotify 裝置，請先開啟 Spotify');
  },
  async play(item, tracks, index) {
    const id = await sp.device();
    let body;
    if (item && item.kind !== 'song' && item.uri) body = { context_uri: item.uri, offset: { position: Math.max(0, index || 0) } };
    else body = { uris: (tracks?.length ? tracks : [item]).map(t => t.uri).filter(Boolean), offset: { position: Math.max(0, index || 0) } };
    await sp.send('PUT', `me/player/play?device_id=${encodeURIComponent(id)}`, body);
  },
  pause: () => sp.send('PUT', 'me/player/pause').catch(() => {}),
};

// ---------------------------------------------------------------- YouTube Music provider
const yt = {
  async call(method, path, body) {
    const r = await fetch('/api/ytm/api/' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error('YouTube Music ' + r.status);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return null; }
  },
  async ensure() {
    for (let i = 0; i < 12; i++) {
      const s = await api('/api/ytm/status').catch(() => ({}));
      L.ytm = s;
      if (s.running) return true;
      if (i === 0) { if (!s.installed) throw new Error('YouTube Music 桌面版未安裝'); post('/api/launch', { app: 'ytm' }); toast('正在開啟 YouTube Music…'); }
      await sleep(1500);
    }
    throw new Error('YouTube Music 沒有回應');
  },
  async search(q, type) {
    await yt.ensure();
    const r = parseSearch(await yt.call('POST', 'search', { query: q, ...(type === 'all' ? {} : { params: YTM_PARAMS[type] }) }));
    return { albums: r.albums, playlists: r.playlists, songs: r.songs };
  },
  async open(it) {
    const id = it.browseId || (it.playlistId ? 'VL' + it.playlistId : '');
    const j = await api('/api/ytm/browse?id=' + encodeURIComponent(id));
    const b = parseBrowse(j);
    return { ...it, title: it.title || b.title, artist: it.artist || b.artist, subtitle: b.subtitle || it.subtitle, thumb: b.thumb || it.thumb, tracks: b.tracks.map(t => ({ ...t, source: 'ytm', kind: 'song', album: it.title })) };
  },
  async play(item, tracks, index) {
    await yt.ensure();
    const list = (tracks?.length ? tracks : [item]).filter(t => t.videoId).slice(0, 150);
    if (!list.length) throw new Error('沒有可播放的曲目');
    await yt.call('DELETE', 'queue');
    for (const t of list) await yt.call('POST', 'queue', { videoId: t.videoId, insertPosition: 'INSERT_AT_END' });
    await yt.call('PATCH', 'queue', { index: Math.max(0, Math.min(list.length - 1, index || 0)) });
    await sleep(400);
    await yt.call('POST', 'play').catch(() => {});
  },
  pause: () => yt.call('POST', 'pause').catch(() => {}),
};
const P = { spotify: sp, ytm: yt };

// ---------------------------------------------------------------- playback (seamless switching)
async function playItem(item, tracks, index = 0) {
  if (L.busy) return;
  L.busy = true;
  try {
    // Pause every other player first, so switching sources is seamless.
    await C.pauseOthers(item.source);
    if (item.source !== 'spotify' && L.sp.connected) await sp.pause();
    if (item.source !== 'ytm' && L.ytm.running) await yt.pause();
    await P[item.source].play(item, tracks, index);
    toast(`${SRC_NAME[item.source]} 播放：${(tracks?.[index] || item).title}`);
    C.S.lib.recent = [{ ...item, tracks: undefined }, ...C.S.lib.recent.filter(x => !(x.source === item.source && (x.id || x.browseId) === (item.id || item.browseId)))].slice(0, 18);
    C.saveState();
    setTimeout(C.refreshMedia, 1200);
  } catch (e) {
    toast(e.status === 403 ? 'Spotify 拒絕播放（需要 Premium，且 Spotify 要已登入）' : e.message, true);
  } finally { L.busy = false; }
}

// ---------------------------------------------------------------- rendering
function sleeve(it, onOpen) {
  const cover = h('div', { class: 'sl-cover', style: it.thumb ? `background-image:url("${it.thumb}")` : '' }, it.thumb ? null : h('b', {}, (it.title || '?').slice(0, 1)));
  const el = h('button', { class: 'sleeve-card', type: 'button', title: it.title },
    h('div', { class: 'sl-stack' }, h('div', { class: 'sl-disc' }, h('i', { style: it.thumb ? `background-image:url("${it.thumb}")` : '' })), cover,
      h('span', { class: 'sl-src ' + it.source }, it.source === 'spotify' ? 'SP' : 'YT')),
    h('div', { class: 'sl-title', 'data-i18n-skip': '' }, it.title), h('div', (it.artist || it.subtitle) ? { class: 'sl-sub', 'data-i18n-skip': '' } : { class: 'sl-sub' }, it.artist || it.subtitle || (it.kind === 'playlist' ? '歌單' : '專輯')));
  el.onclick = () => onOpen(it, el);
  return el;
}

function songRow(it, list, i) {
  const b = h('button', { class: 'song-row', type: 'button' },
    h('span', { class: 'sr-thumb', style: it.thumb ? `background-image:url("${it.thumb}")` : '' }),
    h('span', { class: 'sr-main', 'data-i18n-skip': '' }, h('b', {}, it.title), h('small', {}, [it.artist, it.album].filter(Boolean).join(' · '))),
    h('span', { class: 'sl-src ' + it.source }, it.source === 'spotify' ? 'SP' : 'YT'),
    h('span', { class: 'sr-dur' }, it.duration || ''));
  b.onclick = () => playItem(it, list, i);
  return b;
}

function crate(title, items, empty) {
  const g = h('div', { class: 'crate' });
  items.forEach(it => g.append(sleeve(it, openItem)));
  return h('section', { class: 'lib-section' }, h('div', { class: 'ph' }, h('h2', {}, title), h('span', { class: 'rule' }), h('span', { class: 'en' }, `${items.length} 張`)), items.length ? g : h('p', { class: 'hint' }, empty || '沒有結果'));
}

async function openItem(it) {
  const box = $('#libOpen');
  L.open = { ...it, loading: true };
  renderOpen();
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try { L.open = await P[it.source].open(it); }
  catch (e) { L.open = { ...it, tracks: [], note: '讀取失敗：' + e.message }; }
  renderOpen();
}

const motionOk = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
// Closing plays the opening in reverse (tracks fold, record slides back, sleeve tilts in), then hides the panel.
function closeOpen() {
  const box = $('#libOpen'); L.open = null; L.openKey = '';
  if (!box || !box.classList.contains('on') || !motionOk()) { renderOpen(); return; }
  box.classList.add('closing');
  clearTimeout(L.closeT);
  L.closeT = setTimeout(() => { box.classList.remove('closing'); renderOpen(); }, 460);
}
function renderOpen() {
  const box = $('#libOpen'); if (!box) return;
  const o = L.open;
  if (!o) { clearTimeout(L.closeT); box.classList.remove('closing'); box.innerHTML = ''; box.classList.remove('on'); return; }
  clearTimeout(L.closeT); box.classList.remove('closing');
  // same album re-rendered (loading -> loaded): keep it settled instead of replaying the pull-from-shelf motion
  const key = (o.source || '') + '|' + (o.uri || o.id || o.title || '');
  const again = box.classList.contains('on') && L.openKey === key;
  L.openKey = key;
  box.innerHTML = '';
  box.classList.add('on');
  const tracks = o.tracks || [];
  const disc = h('div', { class: 'op-disc spin' + (again ? ' out' : '') }, h('i', { style: o.thumb ? `background-image:url("${o.thumb}")` : '' }));
  const art = h('div', { class: 'op-art' }, disc, h('div', { class: 'op-cover', style: o.thumb ? `background-image:url("${o.thumb}")` : '' }));
  const list = h('ol', { class: 'op-tracks' });
  tracks.forEach((t, i) => {
    const li = h('li', {}, h('span', { class: 'n' }, String(i + 1).padStart(2, '0')), h('span', { class: 't', 'data-i18n-skip': '' }, h('b', {}, t.title), h('small', {}, t.artist || '')), h('span', { class: 'd' }, t.duration || ''));
    li.style.setProperty('--i', Math.min(i, 14));
    li.onclick = () => playItem(o, tracks, i);
    list.append(li);
  });
  box.append(h('div', { class: 'op-wrap' + (again ? ' settled' : '') }, art,
    h('div', { class: 'op-info' },
      h('span', { class: 'sl-src big ' + o.source }, SRC_NAME[o.source] + ' · ' + (o.kind === 'playlist' ? '歌單' : '專輯')),
      h('h2', { class: 'op-title', 'data-i18n-skip': '' }, o.title || ''),
      h('div', { class: 'op-artist', 'data-i18n-skip': '' }, o.artist || ''),
      h('div', { class: 'op-sub' }, o.subtitle || ''),
      h('div', { class: 'op-btns' },
        h('button', { class: 'btn primary', onclick: () => playItem(o, tracks, 0) }, '▶ 播放全部'),
        tracks.length > 1 ? h('button', { class: 'btn', onclick: () => playItem(o, tracks, Math.floor(Math.random() * tracks.length)) }, '隨機一首開始') : null,
        h('button', { class: 'btn ghost', onclick: closeOpen }, '收起')),
      o.loading ? h('p', { class: 'hint' }, '讀取曲目中…') : null,
      o.note ? h('p', { class: 'hint' }, o.note) : null,
      list)));
  if (!again) setTimeout(() => disc.classList.add('out'), 30);
}

function renderResults() {
  const box = $('#libResults'); if (!box) return;
  box.innerHTML = '';
  const r = L.results;
  if (!r) return;
  if (r.error) { box.append(h('p', { class: 'hint' }, r.error)); return; }
  const songs = r.songs || [];
  if (r.albums?.length) box.append(crate('專輯', r.albums));
  if (r.playlists?.length) box.append(crate('歌單', r.playlists));
  if (songs.length) {
    const lst = h('div', { class: 'song-list' });
    songs.forEach((s, i) => lst.append(songRow(s, [s], 0)));
    box.append(h('section', { class: 'lib-section' }, h('div', { class: 'ph' }, h('h2', {}, '歌曲'), h('span', { class: 'rule' })), lst));
  }
  if (!r.albums?.length && !r.playlists?.length && !songs.length) box.append(h('p', { class: 'hint' }, '找不到符合的結果。'));
}

async function doSearch(q) {
  q = q.trim(); if (!q) return;
  const src = C.S.lib.source, type = C.S.lib.type || 'all';
  L.results = { albums: [], playlists: [], songs: [] };
  $('#libResults').innerHTML = '';
  $('#libResults').append(h('p', { class: 'hint' }, '搜尋中…'));
  const jobs = [];
  if ((src === 'all' || src === 'spotify') && L.sp.connected) jobs.push(sp.search(q, type).catch(e => ({ err: 'Spotify：' + e.message })));
  if (src === 'ytm' || (src === 'all' && L.ytm?.installed !== false)) jobs.push(yt.search(q, type).catch(e => ({ err: 'YouTube Music：' + e.message })));
  const res = await Promise.all(jobs);
  const errs = res.filter(x => x.err).map(x => x.err);
  // interleave sources so both appear near the top
  const mix = key => { const lists = res.filter(x => !x.err).map(x => x[key] || []); const out = []; for (let i = 0; lists.some(l => i < l.length); i++) lists.forEach(l => l[i] && out.push(l[i])); return out; };
  L.results = { albums: mix('albums'), playlists: mix('playlists'), songs: mix('songs') };
  renderResults();
  if (errs.length) toast(errs.join('；'), true);
}

async function refreshStatus() {
  [L.sp, L.ytm] = await Promise.all([api('/api/spotify/status').catch(() => ({})), api('/api/ytm/status').catch(() => ({}))]);
  const box = $('#libStatus'); if (!box) return;
  box.innerHTML = '';
  const spChip = L.sp.connected ? h('span', { class: 'svc ok' }, h('i'), 'Spotify 已連接')
    : L.sp.configured ? h('button', { class: 'btn primary', onclick: () => { location.href = '/api/spotify/login'; } }, '連接 Spotify')
      : h('span', { class: 'svc' }, h('i'), 'Spotify 未設定（到「設定」填 Client ID）');
  const ytChip = L.ytm.running ? h('span', { class: 'svc ok' }, h('i'), 'YouTube Music 已連線')
    : L.ytm.installed ? h('button', { class: 'btn', onclick: async () => { try { await yt.ensure(); refreshStatus(); } catch (e) { toast(e.message, true); } } }, '開啟 YouTube Music')
      : h('span', { class: 'svc' }, h('i'), 'YouTube Music 桌面版未安裝');
  box.append(spChip, ytChip);
  if (L.sp.connected && !L.mine) { L.mine = []; sp.mine().then(m => { L.mine = m; renderMine(); }).catch(() => {}); }
}

function renderMine() {
  const box = $('#libMine'); if (!box) return;
  box.innerHTML = '';
  const recent = C.S.lib.recent || [];
  if (recent.length) box.append(crate('最近播放', recent));
  if (L.mine?.length) box.append(crate('我的 Spotify 收藏', L.mine));
}

function renderSessions() {
  const box = $('#libSessions'); if (!box) return;
  box.innerHTML = '';
  const ss = C.RT.media.sessions || [];
  for (const s of ss) {
    const b = h('button', { class: 'chip' + (s.status === 'Playing' ? ' playing on' : '') , type: 'button', title: s.title, 'data-i18n-skip': '' }, h('i'), `${C.appName(s.id)}${isEn() ? ': ' : '：'}${s.title || '—'}`);
    b.onclick = () => { C.pauseOthers(null, s.id); post('/api/media', { c: 'toggle', id: s.id }); };
    box.append(b);
  }
  if (!ss.length) box.append(h('span', { class: 'muted' }, '目前沒有其他播放器在播放。'));
}

export function buildLibrary(root, ctx) {
  C = ctx;
  root.innerHTML = '';
  const input = h('input', { type: 'text', class: 'lib-q', placeholder: '搜尋專輯、歌單、歌曲、演奏者…', value: C.S.lib.lastQ || '' });
  input.onkeydown = e => { if (e.key === 'Enter') { C.S.lib.lastQ = input.value; C.saveState(); doSearch(input.value); } };
  const srcK = keys({ options: [{ id: 'all', label: '全部來源' }, { id: 'spotify', label: 'Spotify' }, { id: 'ytm', label: 'YouTube Music' }], value: C.S.lib.source, onInput: v => { C.S.lib.source = v; C.saveState(); } });
  const typeK = keys({ options: [{ id: 'all', label: '綜合' }, { id: 'album', label: '專輯' }, { id: 'playlist', label: '歌單' }, { id: 'song', label: '歌曲' }], value: C.S.lib.type || 'all', onInput: v => { C.S.lib.type = v; C.saveState(); if (input.value.trim()) doSearch(input.value); } });
  root.append(
    h('div', { class: 'page-head' }, h('div', { class: 'num' }, '02'), h('div', {}, h('h1', {}, '曲庫'), h('div', { class: 'sub' }, 'Spotify 與 YouTube Music 一起搜尋；點唱片封套就能展開。切換來源時會自動暫停另一邊。')), h('div', { class: 'bar' })),
    h('div', { class: 'panel lib-bar' },
      h('div', { class: 'lib-search' }, input, h('button', { class: 'btn primary', onclick: () => { C.S.lib.lastQ = input.value; C.saveState(); doSearch(input.value); } }, '搜尋')),
      h('div', { class: 'lib-filters' }, srcK.el, typeK.el, h('div', { class: 'lib-status', id: 'libStatus' })),
      h('div', { class: 'lib-sessions' }, h('span', { class: 'en' }, '其他播放器'), h('div', { id: 'libSessions', class: 'sessions' }))),
    h('div', { class: 'lib-open', id: 'libOpen' }),
    h('div', { id: 'libResults' }),
    h('div', { id: 'libMine' }));
  refreshStatus();
  renderMine();
  renderSessions();
}

export const libraryHooks = { renderSessions, refreshStatus };
