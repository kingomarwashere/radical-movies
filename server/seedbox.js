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

export async function addTorrent(source, savePath) {
  const form = new FormData();
  if (source.startsWith('magnet:')) {
    form.append('urls', source);
  } else {
    // .torrent file URL — fetch and add as file
    const torrentRes = await fetch(source);
    const buf = Buffer.from(await torrentRes.arrayBuffer());
    const blob = new Blob([buf], { type: 'application/x-bittorrent' });
    form.append('torrents', blob, 'movie.torrent');
  }
  form.append('savepath', savePath || SAVE_PATH);
  form.append('category', 'radical-movies');

  const res = await qbt('/torrents/add', { method: 'POST', body: form });
  const text = await res.text();
  if (text !== 'Ok.') throw new Error(`Add torrent failed: ${text}`);
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
      host:     SFTP_HOST,
      port:     SFTP_PORT,
      username: QB_USER,
      password: QB_PASS,
    });

    console.log(`[sftp] pulling ${remotePath} → ${localPath}`);
    const stat = await sftp.stat(remotePath);
    const total = stat.size;
    let transferred = 0;

    await sftp.fastGet(remotePath, localPath, {
      step: (bytes) => {
        transferred = bytes;
        onProgress?.(Math.floor(transferred / total * 100));
      },
    });

    console.log(`[sftp] transfer complete: ${(total / 1e9).toFixed(2)} GB`);
    return localPath;
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
