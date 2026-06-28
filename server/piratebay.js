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

// Prefer web-rip MP4 releases; treat MKV remux as last resort
function tpbFormatScore(name) {
  const n = name.toLowerCase();
  if (n.includes('webrip') || n.includes('web-rip') || n.includes('web.rip')) return 0;
  if (n.includes('web-dl') || n.includes('webdl'))  return 0;
  if (n.includes('amzn') || n.includes('nflx') || n.includes('dsnp')) return 0; // streaming sources
  if (n.includes('bluray') || n.includes('blu-ray') || n.includes('bdrip')) return 1;
  if (n.includes('remux')) return 2; // huge files, always MKV
  return 1;
}

export async function searchTPB(title, year) {
  const query = `${title} ${year ?? ''} 1080p`.trim();
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=207`;

  let results;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    results = await res.json();
  } catch {
    return null;
  }

  if (!Array.isArray(results) || results[0]?.id === '0') return null;

  const valid = results
    .filter(t => {
      const n = t.name.toLowerCase();
      return (n.includes('1080p') || n.includes('720p'))
        && !n.includes('cam') && !n.includes('hdcam')
        && !n.includes('.ts.') && !n.includes('3d');
    })
    .sort((a, b) => {
      const fDiff = tpbFormatScore(a.name) - tpbFormatScore(b.name);
      if (fDiff !== 0) return fDiff;
      return parseInt(b.seeders) - parseInt(a.seeders);
    });

  if (!valid.length) return null;

  const best = valid[0];
  const quality = best.name.toLowerCase().includes('1080p') ? '1080p' : '720p';

  return {
    source: 'tpb',
    title: best.name,
    quality,
    size: `${(parseInt(best.size) / 1e9).toFixed(2)} GB`,
    seeds: parseInt(best.seeders),
    hash: best.info_hash,
    magnet: magnet(best.info_hash, best.name),
  };
}
