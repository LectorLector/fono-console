// Simulated backend for the static demo (tutorial site / GitHub Pages).
// It answers the same /api/* calls and pushes the same events as the real
// Fono Console server, entirely inside the page. Nothing leaves the browser.
const realFetch = window.fetch.bind(window);
const listeners = new Set();
const send = m => { const data = JSON.stringify(m); for (const l of listeners) l({ data }); };

// ---------------------------------------------------------------- media
const TRACKS = [
  { title: 'Goldberg Variations, BWV 988: Aria', artist: '示範鋼琴獨奏', album: 'Bach: Goldberg Variations', dur: 287, hue: 24 },
  { title: 'Cello Suite No. 1: Prélude', artist: '示範大提琴', album: 'Six Suites (Demo)', dur: 151, hue: 200 },
  { title: 'Clair de lune', artist: '示範鋼琴獨奏', album: 'Suite bergamasque', dur: 302, hue: 330 },
];
const cover = (h, label = '') => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},26%,30%)"/><stop offset="1" stop-color="hsl(${h},30%,16%)"/></linearGradient></defs>` +
  `<rect width="600" height="600" fill="url(#g)"/><circle cx="410" cy="230" r="150" fill="hsl(${(h + 30) % 360},34%,52%)" opacity=".85"/>` +
  `<path d="M0 470 L600 330 L600 400 L0 540Z" fill="#e9dfcf" opacity=".9"/><rect x="64" y="70" width="34" height="260" fill="#14110f"/>` +
  `<text x="64" y="560" font-family="Georgia,serif" font-size="40" fill="#efe6d6">${label}</text></svg>`);
window.__fonoArt = Object.fromEntries(TRACKS.map((t, i) => ['demo' + i, cover(t.hue, 'DEMO')]));
const M = { playing: true, pos: 74, track: 0 };
function mediaMsg() {
  const t = TRACKS[M.track];
  return { t: 'media', cur: 'Spotify.exe', sessions: [
    { id: 'Spotify.exe', title: t.title, artist: t.artist, album: t.album, status: M.playing ? 'Playing' : 'Paused', pos: Math.round(M.pos * 100) / 100, dur: t.dur, art: 'demo' + M.track, canSeek: true, canNext: true, canPrev: true },
    { id: 'com.github.th-ch.youtube-music', title: 'Gymnopédie No. 1', artist: '示範鋼琴獨奏', album: 'Demo', status: 'Paused', pos: 12, dur: 210, art: 'demo2', canSeek: true, canNext: true, canPrev: true }] };
}
const DEVICES = { t: 'devices', def: '{demo-multich}', list: [
  { guid: '{demo-multich}', name: '喇叭', iface: 'USB 7.1 Sound Card', eapo: true },
  { guid: '{demo-dac}', name: '喇叭', iface: 'USB Stereo DAC', eapo: true },
  { guid: '{demo-bt}', name: '耳機', iface: 'Wireless Over-Ear Headphones', eapo: true }] };
const BT = { t: 'bt', list: [
  { name: 'Wireless Over-Ear Headphones', id: 'BT1', battery: 80, connected: true, hfp: [{ id: 'HF1', status: 'OK', name: 'Hands-Free' }] },
  { name: 'True Wireless Buds', id: 'BT2', battery: null, connected: false, last: '2026-11-02T07:13:10', hfp: [{ id: 'HF2', status: 'Unknown' }] }] };
let tick = 0;
setInterval(() => {
  tick++;
  if (M.playing) { M.pos += 0.08; if (M.pos > TRACKS[M.track].dur) { M.track = (M.track + 1) % TRACKS.length; M.pos = 0; } }
  if (tick % 6 === 0) send(mediaMsg());
  const base = 0.35 + 0.25 * Math.sin(tick / 7);
  send({ t: 'meter', p: Array.from({ length: 8 }, (_, i) => M.playing ? Math.max(0, Math.min(1, (i >= 2 && i <= 5 ? 0 : i >= 6 ? 0.5 : 1) * (base + Math.random() * 0.3))) : 0) });
}, 80);

class FakeEventSource {
  constructor() { this.readyState = 1; setTimeout(() => { listeners.add(this._l = e => this.onmessage?.(e)); this.onopen?.(); send({ t: 'init', winrt: true, audio: true }); send(DEVICES); send(BT); send(mediaMsg()); }, 30); }
  addEventListener(type, fn) { if (type === 'message') this.onmessage = fn; if (type === 'open') this.onopen = fn; }
  close() { listeners.delete(this._l); this.readyState = 2; }
}
window.EventSource = FakeEventSource;

// ---------------------------------------------------------------- state
let STATE = null;
try { STATE = JSON.parse(sessionStorage.getItem('fono-demo-state') || 'null'); } catch {}
if (!STATE) STATE = { dev: { cm: '{demo-multich}', spark: '{demo-dac}' } };   // the demo already has its two outputs picked (headphones tutorial needs the DAC)
let EAPO = '# (示範) Equalizer APO 設定檔會顯示在這裡\n';
const files = {};

// ---------------------------------------------------------------- library data
const img = h => [{ url: cover(h) }];
const album = (i, name, artist) => ({ id: 'al' + i, uri: 'spotify:album:al' + i, name, artists: [{ name: artist }], release_date: (1955 + i * 7) + '-01-01', total_tracks: 12, images: img(i * 47 % 360), type: 'album' });
const ALBUMS = [album(1, 'Goldberg Variations (Demo)', '示範鋼琴獨奏'), album(2, 'Cello Suites', '示範大提琴'), album(3, 'Nocturnes', '示範鋼琴獨奏'), album(4, 'String Quartets', '示範四重奏'), album(5, 'Night Jazz Trio', '示範三重奏'), album(6, 'Ambient Rooms', '示範合成器')];
const SP = (path) => {
  const u = new URL(path, 'http://x');
  if (u.pathname === '/search') return { albums: { items: ALBUMS }, playlists: { items: [{ id: 'pl1', uri: 'spotify:playlist:pl1', name: '示範歌單：深夜古典', owner: { id: 'me', display_name: '你' }, images: img(30), items: { total: 23 } }] }, tracks: { items: ALBUMS.slice(0, 4).map((a, i) => ({ id: 't' + i, uri: 'spotify:track:t' + i, name: ['Aria', 'Prélude', 'Nocturne', 'Adagio'][i], artists: a.artists, album: a, duration_ms: 113000 + i * 40000 })) } };
  if (u.pathname === '/me') return { id: 'me' };
  if (u.pathname === '/me/playlists') return { items: [{ id: 'pl2', uri: 'spotify:playlist:pl2', name: '示範歌單：深夜古典', owner: { id: 'me' }, images: img(30), items: { total: 23 } }] };
  if (u.pathname === '/me/albums') return { items: ALBUMS.slice(0, 3).map(album => ({ album })) };
  if (u.pathname.startsWith('/albums/')) { const a = ALBUMS.find(x => u.pathname.endsWith(x.id)) || ALBUMS[0]; return { ...a, label: 'Demo Records', tracks: { items: Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, uri: 'spotify:track:t' + i, name: i ? '第 ' + i + ' 首' : '序曲', artists: a.artists, duration_ms: 90000 + i * 13000 })) } }; }
  if (u.pathname.startsWith('/playlists/')) return { items: Array.from({ length: 8 }, (_, i) => ({ item: { id: 'p' + i, uri: 'spotify:track:p' + i, name: '示範曲目 ' + (i + 1), artists: [{ name: '示範演奏者' }], album: ALBUMS[i % 6], duration_ms: 180000 + i * 7000 } })), total: 8 };
  if (u.pathname === '/me/player/devices') return { devices: [{ id: 'dev1', type: 'Computer', is_active: true, name: '這台電腦' }] };
  return null;
};
const AUTOEQ = ['- [Wireless Over-Ear Headphones](./oratory1990/over-ear/Wireless Over-Ear Headphones) by oratory1990',
  '- [Studio Monitor Headphones](./oratory1990/over-ear/Studio Monitor Headphones) by oratory1990',
  '- [True Wireless Buds](./Rtings/in-ear/True Wireless Buds) by Rtings'].join('\n');
const AUTOEQ_FILE = 'Preamp: -6.2 dB\nFilter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70\nFilter 2: ON PK Fc 180 Hz Gain -2.4 dB Q 0.9\nFilter 3: ON PK Fc 2600 Hz Gain 3.1 dB Q 2.1\nFilter 4: ON PK Fc 5400 Hz Gain -4.2 dB Q 3.0\nFilter 5: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70\n';
const SETUP = { eapo: { installed: true, config: 'C:\\Program Files\\EqualizerAPO\\config', bundled: true }, ytm: { installed: false, config: false, api: false, running: false, job: { state: 'idle' } }, chrome: { policy: false }, rew: { path: '' }, windows: true };

// ---------------------------------------------------------------- wallpapers (kept as object URLs in memory)
const WALL = new Map();
window.__fonoWallUrls = {};
const wallExt = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
async function wallpaperApi(p, m, opt) {
  if (p === '/api/wallpaper') {
    if (m === 'POST') {
      const f = opt.body instanceof FormData ? opt.body.get('file') : null;
      if (!f || !f.size) return json({ error: 'no-file' }, 400);
      if (f.size > 8 << 20) return json({ error: 'too-large' }, 413);
      const ext = wallExt[f.type];
      if (!ext) return json({ error: 'bad-type' }, 415);
      const stem = ((f.name || 'wallpaper').replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_ -]+/gu, '_').trim().slice(0, 48).replace(/^[ _-]+|[ _-]+$/g, '')) || 'wallpaper';
      let name = stem + ext;
      for (let i = 2; WALL.has(name); i++) name = stem + '-' + i + ext;
      const url = URL.createObjectURL(f);
      WALL.set(name, { size: f.size, url }); window.__fonoWallUrls[name] = url;
      return json({ ok: true, name, size: f.size });
    }
    return json([...WALL].map(([name, v]) => ({ name, size: v.size })));
  }
  const name = decodeURIComponent(p.slice('/api/wallpaper/'.length));
  const w = WALL.get(name);
  if (!w) return new Response(null, { status: 404 });
  if (m === 'DELETE') { URL.revokeObjectURL(w.url); WALL.delete(name); delete window.__fonoWallUrls[name]; return json({ ok: true }); }
  return realFetch(w.url);
}

// ---------------------------------------------------------------- router
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
async function handle(path, opt = {}) {
  const u = new URL(path, location.href), p = u.pathname.replace(/^.*?(\/api\/)/, '/api/'), m = (opt.method || 'GET').toUpperCase();
  if (p === '/api/state') {
    if (m === 'POST') { STATE = JSON.parse(opt.body); try { sessionStorage.setItem('fono-demo-state', opt.body); } catch {} return json({ ok: true }); }
    return json(STATE || {});
  }
  if (p === '/api/system') return json({ version: 'demo', platform: 'demo', demo: true, installed: true, eapoDir: 'C:\\Program Files\\EqualizerAPO\\config', eapoFound: true, writable: true, configFound: true, included: true, configTxt: 'Include: fono_console.txt' });
  if (p === '/api/media') { const c = JSON.parse(opt.body || '{}'); if (c.c === 'toggle') M.playing = !M.playing; if (c.c === 'play') M.playing = true; if (c.c === 'pause') M.playing = false; if (c.c === 'next') { M.track = (M.track + 1) % 3; M.pos = 0; } if (c.c === 'prev') M.pos = 0; if (c.c === 'seek') M.pos = +c.pos || 0; if (c.c === 'bt') send(BT); if (c.c === 'devices' || c.c === 'setdef') { if (c.id) DEVICES.def = c.id; send(DEVICES); } send(mediaMsg()); return json({ ok: true }); }
  if (p === '/api/eapo/console') { if (m === 'POST') EAPO = opt.body; return json({ ok: true, writable: true }); }
  if (p === '/api/eapo/file') { if (m === 'POST') files[u.searchParams.get('name')] = true; return json({ ok: true }); }
  if (p.startsWith('/api/eapo/')) return json({ ok: true, writable: true });
  if (p === '/api/wallpaper' || p.startsWith('/api/wallpaper/')) return wallpaperApi(p, m, opt);
  if (p === '/api/custom-ir') return new Response(null, { status: 404 });
  if (p === '/api/spotify/status') return json({ configured: true, connected: true, redirectUri: 'http://127.0.0.1:47811/api/spotify/callback' });
  if (p.startsWith('/api/spotify/api/')) { const r = SP(path.slice(path.indexOf('/api/spotify/api/') + 16)); return r ? json(r) : new Response(null, { status: 204 }); }
  if (p === '/api/ytm/status') return json({ running: false, installed: false });
  if (p.startsWith('/api/ytm/')) return json({}, 503);
  if (p === '/api/autoeq/index') return new Response(AUTOEQ);
  if (p === '/api/autoeq/file') return new Response(AUTOEQ_FILE);
  if (p === '/api/setup/status') return json(SETUP);
  if (p === '/api/setup/ytm-install') { SETUP.ytm.job = { state: 'running', step: '（示範）下載並比對 SHA-256…' }; setTimeout(() => { SETUP.ytm.installed = true; SETUP.ytm.job = { state: 'done', step: '（示範）已安裝' }; }, 2500); return json(SETUP.ytm.job); }
  if (p === '/api/setup/ytm-api') { SETUP.ytm.api = true; return json({ ok: true }); }
  if (p === '/api/setup/chrome') { SETUP.chrome.policy = JSON.parse(opt.body || '{}').on; return json({ on: SETUP.chrome.policy }); }
  if (p.startsWith('/api/rew')) return json({ error: 'demo' }, 503);
  return json({ ok: true, demo: true });
}
window.fetch = (input, opt) => {
  const url = typeof input === 'string' ? input : input.url;
  if (/^\/api\/|\/api\//.test(url) && !/^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(url)) return handle(url, opt);
  return realFetch(input, opt);
};
// Mic pairing (lab) in the demo: two fake inputs with a known response difference (B has a +3 dB peak at 8 kHz and a weak bass).
window.__fonoDemoMics = [{ deviceId: 'demo-mic-a', label: '示範麥克風 A（基準）' }, { deviceId: 'demo-mic-b', label: '示範麥克風 B' }];
window.__fonoDemoMicCurve = id => {
  const f = [], db = [];
  for (let x = 15; x < 22000; x *= Math.pow(2, 1 / 48)) {
    const l = Math.log2(x / 1000);
    f.push(x); db.push(-20 + 0.4 * Math.sin(x / 37) + (id === 'demo-mic-b' ? 3 * Math.exp(-((l - 3) ** 2) / 0.5) - 2.5 / (1 + (x / 60) ** 2) + 0.6 : 0));
  }
  return { f, db };
};
window.__fonoDemo = true;
