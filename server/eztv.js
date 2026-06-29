// EZTV — public TV-only tracker with IMDB-based API.
// Much more reliable than name-based TPB search for TV episodes.
const EZTV_BASE = 'https://eztv.re/api';

const BAD_AUDIO = /\bdts\b|eac3|e-ac3|\bddp\b|dd\+|truehd|atmos/i;
const MAX_BYTES = 4 * 1024 ** 3;

export async function searchEZTV(imdbId, season, episode) {
  if (!imdbId) return null;

  const numericId = String(imdbId).replace(/^tt/i, '');
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const tag = `S${s}E${e}`;
  const tagLower = tag.toLowerCase();

  try {
    // EZTV returns all torrents for the show — we filter client-side
    const res = await fetch(`${EZTV_BASE}/get-torrents?imdb_id=${numericId}&limit=100`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.torrents?.length) return null;

    const valid = data.torrents
      .filter(t => {
        const nameL = (t.filename || t.title || '').toLowerCase();
        // Match by both API season/episode fields AND filename tag
        const epMatch = (String(t.season) === String(season) && String(t.episode) === String(episode))
          || nameL.includes(tagLower);
        return epMatch
          && !BAD_AUDIO.test(t.filename || '')
          && parseInt(t.size_bytes || 0) <= MAX_BYTES
          && parseInt(t.seeds || 0) > 0;
      })
      .sort((a, b) => {
        const aHD = /1080p/i.test(a.filename || '');
        const bHD = /1080p/i.test(b.filename || '');
        if (aHD && !bHD) return -1;
        if (bHD && !aHD) return 1;
        return parseInt(b.seeds || 0) - parseInt(a.seeds || 0);
      });

    if (!valid.length) return null;
    const best = valid[0];

    const nameL = (best.filename || best.title || '').toLowerCase();
    const quality = /1080p/.test(nameL) ? '1080p' : /720p/.test(nameL) ? '720p' : 'SD';
    console.log(`[eztv] ${best.filename} | seeds: ${best.seeds}`);

    return {
      source:     'eztv',
      title:      best.filename || best.title,
      quality,
      seeds:      parseInt(best.seeds) || 0,
      size:       best.size_bytes || '?',
      hash:       best.hash,
      magnet:     best.magnet_url,
      torrentUrl: best.torrent_url,
    };
  } catch (e) {
    console.error('[eztv] error:', e.message);
    return null;
  }
}
