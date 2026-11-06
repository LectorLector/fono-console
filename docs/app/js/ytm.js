// YouTube Music (innertube JSON) parsers: search results and album/playlist pages.
const runsText = r => (r && Array.isArray(r.runs) ? r.runs.map(x => x.text).join('') : (r && r.simpleText) || '');
const lastThumb = t => {
  const arr = t?.musicThumbnailRenderer?.thumbnail?.thumbnails || t?.croppedSquareThumbnailRenderer?.thumbnail?.thumbnails || t?.thumbnails || [];
  return arr.length ? arr[arr.length - 1].url : '';
};
const bigThumb = u => (u ? u.replace(/=w\d+-h\d+/, '=w544-h544').replace(/\/(hq|mq|sd)default\.jpg/, '/hqdefault.jpg') : '');

function* walk(o, key) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const v of o) yield* walk(v, key); return; }
  for (const k in o) {
    if (k === key) yield o[k];
    else yield* walk(o[k], key);
  }
}

function pageType(nav) {
  return nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
}

function itemFromListItem(it) {
  const cols = (it.flexColumns || []).map(c => runsText(c.musicResponsiveListItemFlexColumnRenderer?.text));
  const firstRuns = it.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const play = it.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint || {};
  const videoId = it.playlistItemData?.videoId || play.watchEndpoint?.videoId || firstRuns[0]?.navigationEndpoint?.watchEndpoint?.videoId || '';
  const browseId = it.navigationEndpoint?.browseEndpoint?.browseId || '';
  const pt = pageType(it.navigationEndpoint);
  const dur = runsText(it.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text);
  const sub = cols.slice(1).filter(Boolean).join(' · ');
  const subRuns = (it.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const artist = subRuns.filter(r => /ARTIST|USER_CHANNEL/.test(pageType(r.navigationEndpoint))).map(r => r.text).join(', ');
  const album = subRuns.find(r => /ALBUM/.test(pageType(r.navigationEndpoint)))?.text || '';
  let kind = 'song';
  if (pt.includes('ALBUM')) kind = 'album';
  else if (pt.includes('PLAYLIST')) kind = 'playlist';
  else if (pt.includes('ARTIST') || pt.includes('USER_CHANNEL')) kind = 'artist';
  else if (!videoId) kind = 'other';
  return {
    source: 'ytm', kind, title: cols[0] || '', subtitle: sub, artist: artist || (subRuns[0]?.text && kind !== 'song' ? '' : ''),
    album, videoId, browseId, playlistId: play.watchPlaylistEndpoint?.playlistId || '',
    duration: dur, thumb: bigThumb(lastThumb(it.thumbnail)),
  };
}

function itemFromCard(c) {
  const title = runsText(c.title);
  const tRuns = c.title?.runs || [];
  const nav = c.onTap || tRuns[0]?.navigationEndpoint || {};
  const pt = pageType(nav);
  const videoId = nav.watchEndpoint?.videoId || '';
  const kind = pt.includes('ALBUM') ? 'album' : pt.includes('PLAYLIST') ? 'playlist' : pt.includes('ARTIST') ? 'artist' : videoId ? 'song' : 'other';
  return { source: 'ytm', kind, title, subtitle: runsText(c.subtitle), artist: '', album: '', videoId, browseId: nav.browseEndpoint?.browseId || '', playlistId: '', duration: '', thumb: bigThumb(lastThumb(c.thumbnail)) };
}

/** Parse a search response into {songs, albums, playlists, artists, chips}. */
export function parseSearch(json) {
  const out = { songs: [], albums: [], playlists: [], artists: [], chips: {} };
  const seen = new Set();
  const add = x => {
    const key = x.kind + ':' + (x.videoId || x.browseId || x.title);
    if (seen.has(key) || !x.title) return;
    seen.add(key);
    ({ song: out.songs, album: out.albums, playlist: out.playlists, artist: out.artists })[x.kind]?.push(x);
  };
  for (const c of walk(json, 'musicCardShelfRenderer')) add(itemFromCard(c));
  for (const it of walk(json, 'musicResponsiveListItemRenderer')) add(itemFromListItem(it));
  for (const chip of walk(json, 'chipCloudChipRenderer')) {
    const p = chip.navigationEndpoint?.searchEndpoint?.params;
    if (p) out.chips[runsText(chip.text) || chip.uniqueId] = p;
  }
  return out;
}

/** Parse an album / playlist browse response. */
export function parseBrowse(json) {
  let header = null;
  for (const h of walk(json, 'musicResponsiveHeaderRenderer')) { header = h; break; }
  if (!header) for (const h of walk(json, 'musicDetailHeaderRenderer')) { header = h; break; }
  const title = runsText(header?.title) || json?.microformat?.microdataRenderer?.title || '';
  const artist = runsText(header?.straplineTextOne) || '';
  const subtitle = runsText(header?.subtitle) || '';
  const thumb = bigThumb(lastThumb(header?.thumbnail) || lastThumb(header?.thumbnail?.musicThumbnailRenderer));
  const tracks = [];
  for (const it of walk(json, 'musicResponsiveListItemRenderer')) {
    const x = itemFromListItem(it);
    if (!x.videoId) continue;
    const first = x.subtitle.split(' · ')[0] || '';
    const looksLikePlays = /\d/.test(first) && /(次|views|plays|觀看)/i.test(first);
    tracks.push({ videoId: x.videoId, title: x.title, artist: x.artist || (looksLikePlays ? artist : first) || artist, duration: x.duration, thumb: x.thumb || thumb });
  }
  return { title, artist, subtitle, thumb, tracks };
}

// Chip labels differ by UI language; map the common ones.
export const CHIP_KIND = {
  song: ['歌曲', 'Songs', '歌曲 '],
  album: ['專輯', 'Albums'],
  playlist: ['精選播放清單', 'Featured playlists', '社群播放清單', 'Community playlists'],
};
