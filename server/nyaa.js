// Nyaa.si — primary anime tracker, uses absolute episode numbers not S?E? format
const NYAA_BASE = 'https://nyaa.si';
const NYAA_CAT  = '1_2'; // Anime - English-translated
const BAD_AUDIO = /\bdts\b|eac3|e-ac3|\bddp\b|dd\+|truehd|atmos/i;

function buildMagnet(hash, title) {
  const trackers = [
    'http://nyaa.tracker.wf:7777/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.opentrackr.org:1337/announce',
  ].map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}${trackers}`;
}

function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) =>
      block.match(new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`))?.[1]
        ?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() ?? '';
    const id = get('link').match(/\/view\/(\d+)/)?.[1];
    items.push({
      title:      get('title'),
      torrentUrl: id ? `${NYAA_BASE}/download/${id}.torrent` : null,
      hash:       get('nyaa:infoHash').toLowerCase(),
      seeders:    parseInt(get('nyaa:seeders')) || 0,
      size:       get('nyaa:size'), // already formatted e.g. "1.4 GiB"
    });
  }
  return items;
}

export async function searchNyaa(showTitle, season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const absEp = parseInt(episode, 10);

  // Try S?E? format first (works for non-anime), then absolute episode number
  // which is how all anime is named on Nyaa (e.g. "One Piece - 1157")
  const queries = [
    `${showTitle} S${s}E${e}`,
    `${showTitle} - ${absEp}`,
    `${showTitle} ${absEp}`,
  ];

  for (const q of queries) {
    try {
      const url = `${NYAA_BASE}/?q=${encodeURIComponent(q)}&c=${NYAA_CAT}&f=0&page=rss`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const items = parseRss(await res.text());

      const tagLower = `s${s}e${e}`;
      // Match S?E? tag OR the absolute episode number as a standalone token
      const epRe = new RegExp(`[\\s\\-_\\[]0*${absEp}(?:[\\s\\[\\(\\._v]|$)`, 'i');

      const valid = items.filter(t => {
        const n = t.title.toLowerCase();
        return (n.includes(tagLower) || epRe.test(t.title))
          && !BAD_AUDIO.test(t.title)
          && t.seeders > 0
          && (t.torrentUrl || t.hash);
      }).sort((a, b) => {
        const aHD = /1080p/i.test(a.title), bHD = /1080p/i.test(b.title);
        if (aHD !== bHD) return aHD ? -1 : 1;
        return b.seeders - a.seeders;
      });

      if (!valid.length) continue;
      const best = valid[0];
      const quality = /1080p/i.test(best.title) ? '1080p' : /720p/i.test(best.title) ? '720p' : 'SD';
      console.log(`[nyaa] ${best.title} | seeds: ${best.seeders} (query: "${q}")`);

      return {
        source:     'nyaa',
        title:      best.title,
        quality,
        seeds:      best.seeders,
        size:       best.size || '?',
        hash:       best.hash,
        magnet:     best.hash ? buildMagnet(best.hash, best.title) : null,
        torrentUrl: best.torrentUrl,
      };
    } catch (err) {
      console.error('[nyaa] error:', err.message);
    }
  }
  return null;
}
