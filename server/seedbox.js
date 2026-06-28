import SftpClient from 'ssh2-sftp-client';
import path from 'path';
import fs from 'fs';

const QB_URL      = process.env.SEEDBOX_QB_URL  || 'https://114.ftl1.seedit4.me/qbittorrent';
const QB_USER     = process.env.SEEDBOX_USER     || 'seedit4me';
const QB_PASS     = process.env.SEEDBOX_PASS     || '123456';
const SFTP_HOST   = process.env.SEEDBOX_SFTP_HOST || 'ftl1.seedit4.me';
const SFTP_PORT   = parseInt(process.env.SEEDBOX_SFTP_PORT || '2090');
const SAVE_PATH   = process.env.SEEDBOX_SAVE_PATH || '/home/seedit4me/torrents/qbittorrent';

export const seedboxConfigured = !!(process.env.SEEDBOX_QB_URL || QB_URL);

const BASIC = Buffer.from(`${QB_USER}:${QB_PASS}`).toString('base64');

// ── qBittorrent API ─────────────────────────────────────────────────────────
let _cookie = null;

async function qbtLogin() {
  const res = await fetch(`${QB_URL}/api/v2/auth/login`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${BASIC}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `username=${QB_USER}&password=${QB_PASS}`,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) _cookie = setCookie.split(';')[0];
  const text = await res.text();
  if (text !== 'Ok.') throw new Error(`qBittorrent login failed: ${text}`);
  console.log('[seedbox] qBittorrent authenticated');
}

async function qbt(path, opts = {}) {
  if (!_cookie) await qbtLogin();
  const res = await fetch(`${QB_URL}/api/v2${path}`, {
    ...opts,
    headers: {
      'Authorization': `Basic ${BASIC}`,
      'Cookie': _cookie,
      ...(opts.headers || {}),
    },
  });
  // Re-auth if session expired
  if (res.status === 403) {
    _cookie = null;
    await qbtLogin();
    return qbt(path, opts);
  }
  return res;
}

// Returns torrent hash so callers can track/delete by hash rather than relying on
// the search result's hash field (which is null for .torrent file sources like TL).
export async function addTorrent(source, savePath) {
  if (!source) throw new Error('No torrent source provided');

  const form = new FormData();
  let magnetHash = null;

  if (Buffer.isBuffer(source)) {
    // Pre-fetched .torrent buffer (e.g. from private tracker that needs auth)
    if (source[0] !== 0x64) throw new Error('Invalid torrent buffer (not bencoded)');
    form.append('torrents', new Blob([source], { type: 'application/x-bittorrent' }), 'movie.torrent');
  } else if (source.startsWith('magnet:')) {
    form.append('urls', source);
    const m = source.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
    magnetHash = m?.[1]?.toLowerCase() || null;
  } else {
    console.log(`[seedbox] fetching .torrent: ${source.slice(0, 80)}`);
    const torrentRes = await fetch(source, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(20000),
    });
    if (!torrentRes.ok) throw new Error(`Torrent fetch failed: ${torrentRes.status}`);
    const torrentBuf = Buffer.from(await torrentRes.arrayBuffer());
    if (torrentBuf[0] !== 0x64) {
      const ct = torrentRes.headers.get('content-type') || 'unknown';
      throw new Error(`Torrent URL returned non-torrent data (${ct}): ${torrentBuf.slice(0, 120).toString('utf8')}`);
    }
    form.append('torrents', new Blob([torrentBuf], { type: 'application/x-bittorrent' }), 'movie.torrent');
  }

  form.append('savepath', savePath || SAVE_PATH);
  form.append('category', 'radical-movies');

  const res = await qbt('/torrents/add', { method: 'POST', body: form });
  const text = await res.text();
  const jobId = path.basename(savePath);

  if (text === 'Ok.') {
    if (magnetHash) return magnetHash;
    return getHashBySavePath(jobId);
  }

  if (text.includes('Fails') || text.includes('fail')) {
    console.warn(`[seedbox] add returned "${text}" — checking for duplicate`);
    const hash = await getHashBySavePath(jobId);
    if (hash) {
      console.log(`[seedbox] found duplicate: ${hash}`);
      return hash;
    }
    throw new Error(`Add torrent failed: ${text}`);
  }

  throw new Error(`Add torrent failed: ${text}`);
}

async function getHashBySavePath(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listRes = await qbt('/torrents/info');
    const list = await listRes.json();
    const found = list.find(t => t.save_path?.includes(jobId));
    if (found) return found.hash;
    await sleep(1000);
  }
  return null;
}

export async function getTorrentByHash(hash) {
  const res = await qbt(`/torrents/info?hashes=${hash.toLowerCase()}`);
  const list = await res.json();
  return list[0] || null;
}

export async function waitForTorrent(hash, onProgress, timeoutMs = 30 * 60 * 1000) {
  const start = Date.now();
  const POLL = 3000;

  while (Date.now() - start < timeoutMs) {
    const t = await getTorrentByHash(hash);
    if (!t) {
      await sleep(POLL);
      continue;
    }

    const pct    = Math.floor(t.progress * 100);
    const speed  = `${(t.dlspeed / 1e6).toFixed(2)} MB/s`;
    const eta    = t.eta > 0 && t.eta < 8640000 ? t.eta : null;

    onProgress({ progress: pct, speed, eta, downloaded: t.downloaded, total: t.total_size });
    console.log(`[seedbox] ${t.name} — ${pct}% @ ${speed}`);

    if (t.progress >= 1 && ['uploading', 'seeding', 'stalledUP', 'pausedUP', 'stoppedUP'].includes(t.state)) {
      console.log(`[seedbox] download complete: ${t.name}`);
      return t;
    }

    await sleep(POLL);
  }

  throw new Error('Seedbox download timed out after 30 minutes');
}

export async function deleteTorrent(hash, deleteFiles = true) {
  const form = new FormData();
  form.append('hashes', hash.toLowerCase());
  form.append('deleteFiles', String(deleteFiles));
  await qbt('/torrents/delete', { method: 'POST', body: form });
  console.log(`[seedbox] deleted torrent ${hash}`);
}

// ── SFTP pull ────────────────────────────────────────────────────────────────
export async function pullFileViaSftp(remotePath, localPath, onProgress) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: SFTP_HOST, port: SFTP_PORT,
      username: QB_USER, password: QB_PASS,
    });
    console.log(`[sftp] pulling ${remotePath} → ${localPath}`);
    const stat = await sftp.stat(remotePath);
    const total = stat.size;
    let transferred = 0;
    await sftp.fastGet(remotePath, localPath, {
      step: (bytes) => { transferred = bytes; onProgress?.(Math.floor(transferred / total * 100)); },
    });
    console.log(`[sftp] done: ${(total / 1e9).toFixed(2)} GB`);
    return localPath;
  } finally {
    await sftp.end().catch(() => {});
  }
}

// Stream file from seedbox SFTP directly into an async iterator (no VM disk)
export function streamFromSftp(remotePath) {
  const sftp = new SftpClient();
  return {
    async open() {
      await sftp.connect({
        host: SFTP_HOST, port: SFTP_PORT,
        username: QB_USER, password: QB_PASS,
      });
      const stat = await sftp.stat(remotePath);
      const stream = sftp.createReadStream(remotePath);
      return { stream, size: stat.size };
    },
    async close() { await sftp.end().catch(() => {}); },
  };
}

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);

// Walk a remote directory recursively and return all video files sorted by size desc
async function listVideosRecursive(sftp, dirPath) {
  const results = [];
  let entries;
  try { entries = await sftp.list(dirPath); } catch { return results; }
  for (const e of entries) {
    const full = dirPath.replace(/\/$/, '') + '/' + e.name;
    if (e.type === 'd' && e.name !== '.' && e.name !== '..') {
      results.push(...await listVideosRecursive(sftp, full));
    } else if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
      results.push({ path: full, size: e.size });
    }
  }
  return results;
}

// Find the largest video file inside a torrent's save folder
export async function findVideoFile(jobId) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });

    // Our save path for this job
    const saveDir = getSeedboxSavePath(jobId);
    console.log(`[sftp] scanning ${saveDir} for video files`);
    const videos = await listVideosRecursive(sftp, saveDir);

    if (!videos.length) throw new Error(`No video file found under ${saveDir}`);
    videos.sort((a, b) => b.size - a.size);
    console.log(`[sftp] found ${videos.length} video(s), largest: ${videos[0].path} (${(videos[0].size/1e9).toFixed(2)} GB)`);
    return videos[0].path;
  } finally {
    await sftp.end().catch(() => {});
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function getSeedboxSavePath(jobId) {
  return path.join(SAVE_PATH, jobId);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
