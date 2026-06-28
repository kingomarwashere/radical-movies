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

async function tpbQuery(q, cat) {
  try {
    const res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=${cat}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return Array.isArray(data) && data[0]?.id !== '0' ? data : [];
  } catch { return []; }
}

function isNotCam(t) {
  const n = t.name.toLowerCase();
  return !n.includes('cam') && !n.includes('hdcam') && !n.includes('.ts.') && !n.includes('3d');
}

export async function searchTPB(title, year) {
  // Progressive attempts: HD with year → HD no year → all Video with year → all Video no year
  const attempts = [
    { q: `${title}${year ? ' ' + year : ''} 1080p`, cat: '207' },
    { q: `${title} 1080p`,                            cat: '207' },
    { q: `${title}${year ? ' ' + year : ''}`,         cat: '200' },
    { q: title,                                        cat: '200' },
  ];

  for (const { q, cat } of attempts) {
    const results = await tpbQuery(q, cat);
    if (!results.length) continue;

    const nonCam = results.filter(isNotCam);
    if (!nonCam.length) continue;

    // Prefer HD, fall back to anything seeded
    const hd = nonCam.filter(t => {
      const n = t.name.toLowerCase();
      return n.includes('1080p') || n.includes('720p');
    }).sort((a, b) => {
      const fDiff = tpbFormatScore(a.name) - tpbFormatScore(b.name);
      return fDiff !== 0 ? fDiff : parseInt(b.seeders) - parseInt(a.seeders);
    });

    const best = hd[0] ?? nonCam.sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders))[0];
    if (!best || parseInt(best.seeders) === 0) continue;

    const n = best.name.toLowerCase();
    const quality = n.includes('1080p') ? '1080p' : n.includes('720p') ? '720p' : 'SD';
    console.log(`[tpb] found via "${q}": ${best.name} (${best.seeders} seeds)`);

    return {
      source:  'tpb',
      title:   best.name,
      quality,
      size:    `${(parseInt(best.size) / 1e9).toFixed(2)} GB`,
      seeds:   parseInt(best.seeders),
      hash:    best.info_hash,
      magnet:  magnet(best.info_hash, best.name),
    };
  }

  return null;
}
