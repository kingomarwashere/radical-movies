// TorrentLeech private tracker — much higher seeder counts than public trackers
const TL_BASE = 'https://www.torrentleech.org';
const TL_USER = process.env.TL_USER || 'jennyformtheblock123';
const TL_PASS = process.env.TL_PASS || '25010568%';
const TL_PK   = process.env.TL_PASSKEY || 'ebd03ad82d775608df5e98308905a2b8';

// HD movie categories on TL
// 37 = HD Movies (WEB-DL/WEBRip 1080p/720p) — most common
// 36 = HD Movies (alt encodings)
// 8  = Blu-ray
const MOVIE_CATS = '8,36,37';

let _cookie = null;
let _loginAt = 0;
let _loginPromise = null;
const SESSION_TTL = 3 * 60 * 60 * 1000; // 3 hours

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function _doLogin() {
  // redirect:'manual' so all Set-Cookie headers from the 302 are visible —
  // following the redirect discards intermediate cookies.
  const res = await fetch(`${TL_BASE}/user/account/login/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Referer': `${TL_BASE}/user/account/login/`,
      'Origin': TL_BASE,
    },
    body: new URLSearchParams({ username: TL_USER, password: TL_PASS }),
    redirect: 'manual',
  });

  // TL sets PHPSESSID + tluid + tlpass — capture ALL of them.
  // Node 18+ provides getSetCookie() returning an array; fall back to splitting
  // the combined set-cookie string for older environments.
  const rawCookies = res.headers.getSetCookie?.()
    ?? (res.headers.get('set-cookie') || '').split(/,\s*(?=[A-Za-z_-]+=)/).filter(Boolean);

  const jar = {};
  for (const sc of rawCookies) {
    const nameVal = sc.split(';')[0].trim();
    const eq = nameVal.indexOf('=');
    if (eq > 0) jar[nameVal.slice(0, eq)] = nameVal.slice(eq + 1);
  }

  if (!jar.PHPSESSID) {
    const body = await res.text().catch(() => '');
    const hint = body.includes('Invalid') ? 'Invalid credentials' : `status ${res.status}`;
    throw new Error(`TorrentLeech login failed: ${hint}`);
  }

  _cookie  = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  _loginAt = Date.now();
  console.log('[tl] session established, cookies:', Object.keys(jar).join(', '));
}

// Serialise logins — concurrent callers share one in-flight promise
async function ensureLogin() {
  if (_cookie && Date.now() - _loginAt < SESSION_TTL) return;
  if (_loginPromise) return _loginPromise;
  _loginPromise = _doLogin().finally(() => { _loginPromise = null; });
  return _loginPromise;
}

async function tlFetch(path, opts = {}, _retried = false) {
  await ensureLogin();

  const res = await fetch(`${TL_BASE}${path}`, {
    ...opts,
    headers: {
      'User-Agent': UA,
      'Cookie': _cookie,
      'X-Requested-With': 'XMLHttpRequest',
      ...(opts.headers || {}),
    },
  });

  const text = await res.text();

  // Session expired — retry exactly once, never recurse further
  if (!_retried && text.includes('Login :: TorrentLeech')) {
    console.warn('[tl] session expired, re-authenticating once');
    _cookie  = null;
    _loginAt = 0;
    return tlFetch(path, opts, true);
  }

  return text;
}

// Quality score — prefer clean web sources, avoid cams/telecines
function qualScore(name) {
  const n = name.toLowerCase();
  if (n.includes('telesync') || n.includes(' ts ') || n.includes('.ts.') || n.includes('hdts')) return -1;
  if (n.includes('cam') || n.includes('hdcam')) return -1;
  if (n.includes('web-dl') || n.includes('webdl')) return 2;
  if (n.includes('webrip') || n.includes('web.rip') || n.includes('web rip')) return 2;
  if (n.includes('amzn') || n.includes('nflx') || n.includes('dsnp') || n.includes('itunes')) return 2;
  if (n.includes('bluray') || n.includes('blu-ray') || n.includes('bdrip')) return 1;
  return 0;
}

// Audio compatibility — lower score = better for direct browser streaming.
// Brave/Chrome/Safari play AAC and AC3/DD natively.
// DDP (E-AC3), DTS, TrueHD, Atmos need a Dolby license Chrome doesn't have.
function audioScore(t) {
  const n = (t.name || '').toLowerCase();
  if (n.includes('.mp4') || n.includes(' mp4')) return 0;
  if (n.includes('aac'))                         return 0;
  if (/\bdts\b|eac3|e-ac3|\bddp|dd\+|truehd|atmos/.test(n)) return 2;
  return 1; // AC3/DD — works in Chrome/Safari on Mac
}

// Non-English language tags that appear in release names
const FOREIGN_RE = /\b(italian|french|spanish|german|portuguese|dutch|korean|japanese|chinese|turkish|swedish|norwegian|danish|finnish|polish|russian|romanian|hungarian|czech|slovak|ita|fre|spa|ger|por|dut|kor|jpn|chi|tur|swe|nor|dan|pol|rus|rum|hun|cze)\b/i;

// Title words must appear in order with only separators between them.
// "The Boys" → /the[.\s_\-]+boys/i — matches "The.Boys.S04E01" but NOT "The.Invisible.Boys".
// Apostrophes are made optional so "Schindler's List" matches "Schindlers.List".
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

async function tlSearch(query) {
  try {
    const text = await tlFetch(
      `/torrents/browse/list/query/${encodeURIComponent(query)}/categories/${MOVIE_CATS}`,
      { headers: { 'Accept': 'application/json, */*' } }
    );
    return JSON.parse(text);
  } catch (e) {
    console.error('[tl] search error:', e.message);
    return null;
  }
}

export async function searchTL(title, year) {
  const queries = [
    year ? `${title} ${year} 1080p mp4` : `${title} 1080p mp4`,
    year ? `${title} ${year} 1080p aac` : `${title} 1080p aac`,
    year ? `${title} ${year} 1080p`     : `${title} 1080p`,
    year ? `${title} ${year} 720p mp4`  : `${title} 720p mp4`,
    year ? `${title} ${year} 720p aac`  : `${title} 720p aac`,
    year ? `${title} ${year} 720p`      : `${title} 720p`,
    year ? `${title} ${year}`           : null,
    title,
  ].filter(Boolean);

  let data = null;
  for (const q of queries) {
    data = await tlSearch(q);
    if (data?.torrentList?.length) break;
  }

  if (!data) return null;

  const results = data?.torrentList || [];
  if (!results.length) return null;

  const GB = 1024 * 1024 * 1024;
  const MAX_SIZE = 4 * GB;

  const sizeOf      = (t) => parseInt(t.size || 0);
  const isEnglish   = (t) => !FOREIGN_RE.test(t.name);
  // Title words must appear in order with only separators between them
  const titleRe    = makeTitleRe(title);
  const titleMatch = (t) => titleRe.test(t.name);
  const hasYear     = (t) => !year || t.name.includes(String(year));
  const hasWrongYear = (t) => {
    if (!year) return false;
    const found = t.name.match(/\b(?:19|20)\d{2}\b/g) || [];
    return found.length > 0 && !found.includes(String(year));
  };
  const sizeOk      = (t) => sizeOf(t) <= MAX_SIZE;

  const baseFilter  = (t) => {
    const n = t.name.toLowerCase();
    if (n.includes('remux') || n.includes('2160p') || n.includes('4k') || n.includes('uhd')) return false;
    return qualScore(t.name) >= 0 && (n.includes('1080p') || n.includes('720p'));
  };

  const rank = (a, b) => {
    const audioDiff = audioScore(a) - audioScore(b);
    if (audioDiff !== 0) return audioDiff;
    const qDiff = qualScore(b.name) - qualScore(a.name);
    if (qDiff !== 0) return qDiff;
    const a1080 = a.name.toLowerCase().includes('1080p');
    const b1080 = b.name.toLowerCase().includes('1080p');
    if (a1080 && !b1080) return -1;
    if (b1080 && !a1080) return 1;
    return (b.seeders || 0) - (a.seeders || 0);
  };

  // 1. Title match + correct year + English + HD + under 4 GB
  let valid = results.filter(t => titleMatch(t) && baseFilter(t) && isEnglish(t) && hasYear(t) && sizeOk(t)).sort(rank);

  // 2. Relax year — exclude results with a different year, keep title match
  if (!valid.length) {
    valid = results.filter(t => titleMatch(t) && baseFilter(t) && isEnglish(t) && !hasWrongYear(t) && sizeOk(t)).sort(rank);
    if (valid.length) console.log(`[tl] relaxed year filter`);
  }

  // 3. Last resort — title match, English, under 4 GB, any resolution
  if (!valid.length) {
    valid = results
      .filter(t => titleMatch(t) && qualScore(t.name) >= 0 && !t.name.toLowerCase().includes('remux') && isEnglish(t) && sizeOk(t))
      .sort((a, b) => audioScore(a) - audioScore(b) || sizeOf(a) - sizeOf(b));
    if (valid.length) console.log(`[tl] no HD results, best available: ${valid[0].name}`);
  }

  // 4. Absolute last resort — ignore language but keep title match
  if (!valid.length) {
    valid = results.filter(t => titleMatch(t) && baseFilter(t) && sizeOk(t)).sort(rank);
    if (valid.length) console.log(`[tl] no English results, using any language`);
  }

  if (!valid.length) return null;

  const best = valid[0];
  const n = best.name.toLowerCase();
  const quality = n.includes('1080p') ? '1080p' : n.includes('720p') ? '720p' : 'SD';

  console.log(`[tl] best match: ${best.name} | audio:${audioScore(best)} | seeds: ${best.seeders} | id: ${best.fid}`);

  // Download the .torrent file now, while we have a valid TL session.
  // The download endpoint requires the session cookie — no cookie, just gets HTML.
  const torrentBuf = await tlFetchBinary(`${TL_BASE}/download/${best.fid}/${TL_PK}`);

  return {
    source:     'tl',
    title:      best.name,
    quality,
    seeds:      best.seeders || 0,
    size:       best.size || '?',
    hash:       null,
    torrentBuf,
    magnet:     null,
  };
}

async function tlFetchBinary(url) {
  await ensureLogin();
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cookie': _cookie },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`TL torrent download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x64) {
    throw new Error(`TL torrent download returned non-torrent data: ${buf.slice(0, 100).toString('utf8')}`);
  }
  return buf;
}

export async function searchTLEpisode(showTitle, season, episode) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const tag = `S${s}E${e}`;
  const queries = [
    `${showTitle} ${tag} 1080p`,
    `${showTitle} ${tag}`,
  ];
  // TL TV categories: 26=TV Episodes, 27=TV HD, 32=TV Boxsets
  const TV_CATS = '26,27,32';
  let data = null;
  for (const q of queries) {
    try {
      const text = await tlFetch(`/torrents/browse/list/query/${encodeURIComponent(q)}/categories/${TV_CATS}`, { headers: { Accept: 'application/json, */*' } });
      data = JSON.parse(text);
      if (data?.torrentList?.length) break;
    } catch {}
  }
  if (!data?.torrentList?.length) return null;

  const GB = 1024 ** 3;
  const results = data.torrentList;

  const titleRe  = makeTitleRe(showTitle);
  const tagLower = tag.toLowerCase();

  const valid = results
    .filter(t => {
      const n = t.name.toLowerCase();
      const hasTag   = n.includes(tagLower);
      const hasTitle = titleRe.test(t.name);
      return hasTag && hasTitle && !n.includes('remux') && !FOREIGN_RE.test(t.name) && parseInt(t.size || 0) <= 4 * GB && audioScore(t) < 2;
    })
    .sort((a, b) => audioScore(a) - audioScore(b) || (b.seeders || 0) - (a.seeders || 0));

  if (!valid.length) return null;
  const best = valid[0];
  const torrentBuf = await tlFetchBinary(`${TL_BASE}/download/${best.fid}/${TL_PK}`);
  console.log(`[tl] TV episode: ${best.name} | seeds: ${best.seeders}`);
  return { source: 'tl', title: best.name, quality: '1080p', seeds: best.seeders || 0, size: best.size || '?', torrentBuf };
}
