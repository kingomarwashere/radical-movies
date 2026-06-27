const YTS = 'https://yts.mx/api/v2';

const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://glotorrents.pw:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function magnet(hash, name) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${TRACKERS}`;
}

// Format score: lower = prefer (web MP4 first, MKV remux last)
function formatScore(type = '') {
  const t = type.toLowerCase();
  if (t === 'web') return 0;       // WEBRip / WEB-DL — MP4, browser-native
  if (t === 'bluray') return 1;    // BluRay encode — often MKV, needs transcode
  if (t === 'hdts') return 2;      // HD telecine — avoid
  return 3;
}

export async function searchYTS(title, year) {
  const query = year ? `${title} ${year}` : title;
  const url = `${YTS}/list_movies.json?query_term=${encodeURIComponent(query)}&sort_by=seeds&order_by=desc&limit=10`;

  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    data = await res.json();
  } catch {
    return null;
  }

  if (data.status !== 'ok' || !data.data?.movie_count) return null;

  for (const movie of data.data.movies ?? []) {
    const torrents = (movie.torrents ?? [])
      .filter(t => ['1080p', '720p'].includes(t.quality))
      .sort((a, b) => {
        // 1. Prefer web (MP4) over bluray (MKV)
        const fDiff = formatScore(a.type) - formatScore(b.type);
        if (fDiff !== 0) return fDiff;
        // 2. Prefer 1080p
        if (a.quality === '1080p' && b.quality !== '1080p') return -1;
        if (b.quality === '1080p' && a.quality !== '1080p') return 1;
        // 3. Most seeds
        return b.seeds - a.seeds;
      });

    if (!torrents.length) continue;
    const best = torrents[0];

    return {
      source: 'yts',
      title: movie.title,
      year: movie.year,
      quality: best.quality,
      type: best.type,
      size: best.size,
      seeds: best.seeds,
      hash: best.hash,
      magnet: magnet(best.hash, `${movie.title} ${best.quality}`),
    };
  }

  return null;
}
