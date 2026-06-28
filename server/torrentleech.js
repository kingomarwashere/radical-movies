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
const SESSION_TTL = 3 * 60 * 60 * 1000; // 3 hours

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function ensureLogin() {
  if (_cookie && Date.now() - _loginAt < SESSION_TTL) return;

  const res = await fetch(`${TL_BASE}/user/account/login/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Referer': `${TL_BASE}/user/account/login/`,
    },
    body: `username=${encodeURIComponent(TL_USER)}&password=${encodeURIComponent(TL_PASS)}`,
    redirect: 'manual',
  });

  const setCookie = res.headers.get('set-cookie') || '';
  const sid = setCookie.match(/PHPSESSID=([^;]+)/)?.[1];
  if (!sid) {
    // Follow redirect and check cookies from redirect response
    const res2 = await fetch(`${TL_BASE}/user/account/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: `username=${encodeURIComponent(TL_USER)}&password=${encodeURIComponent(TL_PASS)}`,
    });
    const text = await res2.text();
    if (!text.includes('logout') && !text.includes(TL_USER.slice(0, 8))) {
      throw new Error('TorrentLeech login failed — check credentials');
    }
    const set = res2.headers.get('set-cookie') || '';
    _cookie = `PHPSESSID=${set.match(/PHPSESSID=([^;]+)/)?.[1]}`;
  } else {
    _cookie = `PHPSESSID=${sid}`;
  }

  _loginAt = Date.now();
  console.log('[tl] logged in, session:', _cookie.slice(0, 25));
}

async function tlFetch(path, opts = {}) {
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
  // Session expired — re-login once
  const text = await res.text();
  if (text.includes('Login :: TorrentLeech') || text.includes('"login"')) {
    _cookie = null;
    await ensureLogin();
    return tlFetch(path, opts);
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

export async function searchTL(title, year) {
  const query = year ? `${title} ${year} 1080p` : `${title} 1080p`;

  let data;
  try {
    const text = await tlFetch(
      `/torrents/browse/list/query/${encodeURIComponent(query)}/categories/${MOVIE_CATS}`,
      { headers: { 'Accept': 'application/json, */*' } }
    );
    data = JSON.parse(text);
  } catch (e) {
    console.error('[tl] search error:', e.message);
    // Try 720p fallback
    try {
      const text = await tlFetch(
        `/torrents/browse/list/query/${encodeURIComponent(title + (year ? ' ' + year : '') + ' 720p')}/categories/${MOVIE_CATS}`,
        { headers: { 'Accept': 'application/json, */*' } }
      );
      data = JSON.parse(text);
    } catch {
      return null;
    }
  }

  const results = data?.torrentList || [];
  if (!results.length) return null;

  // Filter and rank
  const valid = results
    .filter(t => {
      const n = t.name.toLowerCase();
      const score = qualScore(t.name);
      return score >= 0 && (n.includes('1080p') || n.includes('720p'));
    })
    .sort((a, b) => {
      const qDiff = qualScore(b.name) - qualScore(a.name);
      if (qDiff !== 0) return qDiff;
      // Prefer 1080p
      const a1080 = a.name.toLowerCase().includes('1080p');
      const b1080 = b.name.toLowerCase().includes('1080p');
      if (a1080 && !b1080) return -1;
      if (b1080 && !a1080) return 1;
      return (b.seeders || 0) - (a.seeders || 0);
    });

  if (!valid.length) return null;

  const best = valid[0];
  const quality = best.name.toLowerCase().includes('1080p') ? '1080p' : '720p';
  const torrentUrl = `${TL_BASE}/download/${best.fid}/${TL_PK}/${encodeURIComponent(best.name)}.torrent`;

  console.log(`[tl] best match: ${best.name} | seeds: ${best.seeders} | id: ${best.fid}`);

  return {
    source:     'tl',
    title:      best.name,
    quality,
    seeds:      best.seeders || 0,
    size:       best.size || '?',
    hash:       null, // TL torrents reveal hash after download
    torrentUrl,
    magnet:     null,
  };
}
