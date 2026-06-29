const YTS = 'https://yts.mx/api/v2';

// HTTP/HTTPS trackers only — UDP blocked on VPS, openbittorrent.com returns 500
const TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'http://open.acgnxtracker.com:80/announce',
  'https://opentracker.i2p.rocks:443/announce',
  'http://nyaa.tracker.wf:7777/announce',
  'http://tracker.gbitt.info:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'http://tracker.files.fm:6969/announce',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function magnet(hash, name) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${TRACKERS}`;
}

// YTS provides a direct .torrent file — use it instead of magnet when available
// so peer discovery doesn't depend on trackers at all initially
function torrentUrl(hash) {
  return `https://yts.mx/torrent/download/${hash.toUpperCase()}`;
}

function formatScore(type = '') {
  const t = type.toLowerCase();
  if (t === 'web') return 0;
  if (t === 'bluray') return 1;
  if (t === 'hdts') return 2;
  return 3;
}

async function ytsQuery(query) {
  try {
    const url = `${YTS}/list_movies.json?query_term=${encodeURIComponent(query)}&sort_by=seeds&order_by=desc&limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    return data.status === 'ok' && data.data?.movie_count ? data.data.movies ?? [] : [];
  } catch { return []; }
}

const MAX_BYTES = 4 * 1024 ** 3;

function parseYtsSize(s) {
  if (!s) return 0;
  const m = String(s).match(/([\d.]+)\s*(GB|MB|KB)/i);
  if (!m) return parseInt(s) || 0;
  const n = parseFloat(m[1]);
  return m[2].toUpperCase() === 'GB' ? n * 1e9 : m[2].toUpperCase() === 'MB' ? n * 1e6 : n * 1e3;
}

export async function searchYTS(title, year) {
  // Try with year first, then title only
  const movies = (await ytsQuery(year ? `${title} ${year}` : title))
    .concat(year ? await ytsQuery(title) : []);

  // Deduplicate by id
  const seen = new Set();
  const unique = movies.filter(m => seen.has(m.id) ? false : seen.add(m.id));

  // Only return movies that match the requested year.
  // Never fall back to a different year — a wrong movie is worse than no result.
  const yearInt = year ? parseInt(year) : null;
  const candidates = yearInt ? unique.filter(m => m.year === yearInt) : unique;

  for (const movie of candidates) {
    const torrents = (movie.torrents ?? [])
      .filter(t => ['1080p', '720p'].includes(t.quality) && parseYtsSize(t.size) <= MAX_BYTES)
      .sort((a, b) => {
        const fDiff = formatScore(a.type) - formatScore(b.type);
        if (fDiff !== 0) return fDiff;
        if (a.quality === '1080p' && b.quality !== '1080p') return -1;
        if (b.quality === '1080p' && a.quality !== '1080p') return 1;
        return b.seeds - a.seeds;
      });

    if (!torrents.length) continue;
    const best = torrents[0];

    return {
      source:      'yts',
      title:       movie.title,
      year:        movie.year,
      quality:     best.quality,
      type:        best.type,
      size:        best.size,
      seeds:       best.seeds,
      hash:        best.hash,
      torrentUrl:  torrentUrl(best.hash),   // .torrent file — preferred over magnet
      magnet:      magnet(best.hash, `${movie.title} ${best.quality}`),
    };
  }

  return null;
}
