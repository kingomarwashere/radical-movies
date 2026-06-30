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

const FOREIGN_RE = /\b(italian|french|spanish|german|portuguese|dutch|korean|japanese|chinese|turkish|swedish|norwegian|danish|finnish|polish|russian|romanian|hungarian|czech|slovak|ita|fre|spa|ger|por|dut|kor|jpn|chi|tur|swe|nor|dan|pol|rus|rum|hun|cze)\b/i;
function isEnglish(t) { return !FOREIGN_RE.test(t.name); }

function cleanQuery(s) { return s.replace(/[''`]/g, '').replace(/\s+/g, ' ').trim(); }

function makeTitleRe(title) {
  const words = title.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return /.*/;
  return new RegExp(
    words.map(w => w
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/'/g, "'?")
    ).join('[.\\s_\\-]+'),
    'i'
  );
}

const MAX_BYTES = 4 * 1024 ** 3;

export async function searchTPB(title, year) {
  title = cleanQuery(title);
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

    const titleRe = makeTitleRe(title);
    const nonCam  = results.filter(t =>
      isNotCam(t) && isEnglish(t) && titleRe.test(t.name) && parseInt(t.size) <= MAX_BYTES
    );
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

export async function searchTPBEpisode(showTitle, season, episode) {
  showTitle = cleanQuery(showTitle);
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const tag = `S${s}E${e}`;
  const attempts = [
    { q: `${showTitle} ${tag} 1080p`, cat: '208' },
    { q: `${showTitle} ${tag}`,       cat: '208' },
    { q: `${showTitle} ${tag}`,       cat: '200' },
  ];
  const MAX_BYTES = 4 * 1024 ** 3;
  const titleRe  = makeTitleRe(showTitle);
  const tagLower = tag.toLowerCase();

  for (const { q, cat } of attempts) {
    const results = await tpbQuery(q, cat);
    if (!results.length) continue;
    const valid = results.filter(t => {
      const n = t.name.toLowerCase();
      return isNotCam(t) && isEnglish(t) &&
        n.includes(tagLower) &&
        titleRe.test(t.name) &&
        parseInt(t.size) <= MAX_BYTES &&
        parseInt(t.seeders) > 0;
    }).sort((a, b) => parseInt(b.seeders) - parseInt(a.seeders));
    if (!valid.length) continue;
    const best = valid[0];
    console.log(`[tpb] TV episode via "${q}": ${best.name} (${best.seeders} seeds)`);
    return { source: 'tpb', title: best.name, quality: '1080p', size: `${(parseInt(best.size)/1e9).toFixed(2)} GB`, seeds: parseInt(best.seeders), hash: best.info_hash, magnet: magnet(best.info_hash, best.name) };
  }
  return null;
}
