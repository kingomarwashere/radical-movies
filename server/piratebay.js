const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://tracker.leechers-paradise.org:6969',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

function magnet(hash, name) {
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}${TRACKERS}`;
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
    .sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders));

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
