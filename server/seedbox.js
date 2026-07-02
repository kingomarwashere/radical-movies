import SftpClient from 'ssh2-sftp-client';
import { Client as SSH2Client } from 'ssh2';
import { Readable } from 'stream';
import { spawn } from 'child_process';
import path from 'path';
import https from 'https';
import fs from 'fs';
import { createHash } from 'crypto';

// Minimal bencode parser — returns the byte-end position of the value starting at pos
function _bencEnd(buf, pos) {
  const c = buf[pos];
  if (c === 0x64 || c === 0x6C) { // 'd' or 'l'
    pos++;
    while (pos < buf.length && buf[pos] !== 0x65) pos = _bencEnd(buf, pos);
    return pos + 1;
  }
  if (c === 0x69) { const e = buf.indexOf(0x65, pos + 1); return e + 1; } // 'i<n>e'
  if (c >= 0x30 && c <= 0x39) { // '<len>:<data>'
    const colon = buf.indexOf(0x3A, pos);
    return colon + 1 + parseInt(buf.slice(pos, colon).toString('ascii'), 10);
  }
  throw new Error(`bencode: unknown type 0x${c.toString(16)} at ${pos}`);
}

// Extract the SHA-1 info hash from a .torrent buffer without a full bencode library
function extractInfoHash(buf) {
  const marker = Buffer.from('4:info');
  for (let i = 0; i <= buf.length - marker.length; i++) {
    if (!buf.slice(i, i + marker.length).equals(marker)) continue;
    const start = i + marker.length;
    try {
      const end = _bencEnd(buf, start);
      return createHash('sha1').update(buf.slice(start, end)).digest('hex');
    } catch { /* false positive, keep scanning */ }
  }
  return null;
}

const QB_URL      = process.env.SEEDBOX_QB_URL   || 'https://60.ftl31.seedit4.me/qbittorrent';
const QB_USER     = process.env.SEEDBOX_USER     || 'seedit4me';
const QB_PASS     = process.env.SEEDBOX_PASS     || '123456';
const SFTP_HOST   = process.env.SEEDBOX_SFTP_HOST || 'ftl31.seedit4.me';
const SFTP_PORT   = parseInt(process.env.SEEDBOX_SFTP_PORT || '2100');
const SAVE_PATH   = process.env.SEEDBOX_SAVE_PATH || '/home/seedit4me/torrents/qbittorrent';

export const seedboxConfigured = !!(process.env.SEEDBOX_QB_URL || QB_URL);
export function clearQbtCooldown()     { _qbtCooldownUntil = 0; console.log('[seedbox] qBit cooldown cleared'); }
export function getQbtCooldownUntil()  { return _qbtCooldownUntil; }
export function getActiveSeedboxOps()  { return _activeSeedboxOps; }
export function incSeedboxOps()        { _activeSeedboxOps++; }
export function decSeedboxOps()        { _activeSeedboxOps = Math.max(0, _activeSeedboxOps - 1); }

export async function getSeedboxDisk() {
  if (Date.now() - _sbDiskCachedAt < 60_000) return _sbDiskFreeGb;
  try {
    const res  = await qbt('/sync/maindata');
    const data = await res.json();
    const free = data?.server_state?.free_space_on_disk ?? null;
    _sbDiskFreeGb   = free !== null ? Math.round(free / 1e9 * 10) / 10 : null;
    _sbDiskCachedAt = Date.now();
  } catch {
    _sbDiskCachedAt = Date.now();
  }
  return _sbDiskFreeGb;
}

const BASIC = Buffer.from(`${QB_USER}:${QB_PASS}`).toString('base64');

// ── qBittorrent API ─────────────────────────────────────────────────────────
let _cookie = null;
let _loginPromise = null;   // serialise concurrent auth requests
let _qbtCooldownUntil = 0; // global back-off after repeated 502s
let _activeSeedboxOps = 0; // concurrent ffmpeg/upload sessions on seedbox
let _sbDiskCachedAt   = 0;
let _sbDiskFreeGb     = null;

async function qbtLogin() {
  if (_loginPromise) return _loginPromise;

  // Hard cooldown — if we've been getting 502s, refuse all logins until it expires
  const cooldownLeft = _qbtCooldownUntil - Date.now();
  if (cooldownLeft > 0) {
    throw new Error(`qBittorrent cooldown: ${Math.ceil(cooldownLeft / 1000)}s remaining`);
  }

  _loginPromise = (async () => {
    // Retry up to 3 times with increasing delays (20s, 40s)
    const delays = [0, 20_000, 40_000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt] > 0) {
        console.log(`[seedbox] qBit login retry ${attempt} in ${delays[attempt] / 1000}s…`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
      // Use https.request directly — bypasses undici's connection pool which can
      // cache stale/blocked connections and return 502 for a running server.
      let loginResult;
      try {
        loginResult = await new Promise((resolve, reject) => {
          const body = `username=${QB_USER}&password=${QB_PASS}`;
          const urlObj = new URL(`${QB_URL}/api/v2/auth/login`);
          const req = https.request({
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
              'Authorization': `Basic ${BASIC}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(body),
              'Connection': 'close',
            },
            agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0 }), // fresh TLS + no pooling
          }, (r) => {
            const cookies = r.headers['set-cookie'] || [];
            const sid = cookies.map(c => c.split(';')[0]).find(c => c.startsWith('SID='));
            let data = '';
            r.on('data', chunk => { data += chunk; });
            r.on('end', () => resolve({ status: r.statusCode, cookie: sid || null, text: data }));
          });
          req.on('error', reject);
          req.setTimeout(15_000, () => { req.destroy(new Error('qBit login timeout')); });
          req.write(body);
          req.end();
        });
      } catch (reqErr) {
        console.warn(`[seedbox] qBit login request error (attempt ${attempt + 1}/${delays.length}): ${reqErr.message}`);
        continue;
      }
      if (loginResult.cookie) _cookie = loginResult.cookie;
      const { status: resStatus, text } = loginResult;
      if (text === 'Ok.') {
        console.log('[seedbox] qBittorrent authenticated');
        _qbtCooldownUntil = 0;
        return;
      }
      const snippet = text.replace(/\s+/g, ' ').slice(0, 80);
      console.warn(`[seedbox] qBit login HTTP ${resStatus}: "${snippet}" (attempt ${attempt + 1}/${delays.length})`);
      if (resStatus === 502 || resStatus === 503 || text.includes('Bad Gateway') || text.includes('Service Unavailable')) {
        continue; // retry
      }
      throw new Error(`qBittorrent login failed: ${text.slice(0, 200) || String(resStatus)}`);
    }
    // All retries exhausted — impose 30-min cooldown to let nginx rate-limit reset
    _qbtCooldownUntil = Date.now() + 30 * 60_000;
    console.error('[seedbox] qBit login failed after retries — 30 min cooldown started');
    throw new Error('qBittorrent unavailable (502) — cooldown 30 min');
  })().finally(() => { _loginPromise = null; });

  return _loginPromise;
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

// Safe JSON parse for qBit responses — returns [] when qBit is down (502 HTML page)
async function qbtJson(path) {
  try {
    const res = await qbt(path);
    if (!res.ok) return [];
    const text = await res.text();
    if (!text.trimStart().startsWith('[') && !text.trimStart().startsWith('{')) return [];
    return JSON.parse(text);
  } catch { return []; }
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
    console.warn(`[seedbox] add returned "${text}" — stale duplicate detected, forcing re-download`);

    // Find the existing hash so we can delete it
    let staleHash = magnetHash || null;
    if (!staleHash) {
      const hp = await getHashBySavePath(jobId, 3000);
      staleHash = hp;
    }
    if (!staleHash && Buffer.isBuffer(source)) {
      staleHash = extractInfoHash(source);
    }
    if (!staleHash) {
      // Last resort: find any torrent with a path overlapping this jobId
      const all = await qbtJson('/torrents/info');
      const found = all.find(t => (t.save_path || '').includes(jobId) || (t.content_path || '').includes(jobId));
      staleHash = found?.hash || null;
    }

    if (staleHash) {
      // Delete the stale entry (keep files=false so we don't wipe anything still in use)
      // then re-add with the current jobId's save path for a guaranteed fresh download
      console.log(`[seedbox] deleting stale torrent ${staleHash} and re-adding for fresh download`);
      await deleteTorrent(staleHash, false).catch(e => console.warn('[seedbox] stale delete failed:', e.message));
      await sleep(2000);

      const form2 = new FormData();
      if (Buffer.isBuffer(source)) {
        form2.append('torrents', new Blob([source], { type: 'application/x-bittorrent' }), 'movie.torrent');
      } else if (magnetHash) {
        form2.append('urls', source);
      } else {
        throw new Error('Cannot re-add: source is a URL and magnet is unknown');
      }
      form2.append('savepath', savePath || SAVE_PATH);
      form2.append('category', 'radical-movies');
      const res2 = await qbt('/torrents/add', { method: 'POST', body: form2 });
      const text2 = await res2.text();
      if (text2 === 'Ok.') {
        console.log('[seedbox] re-add successful after stale duplicate removal');
        if (magnetHash) return magnetHash;
        return getHashBySavePath(jobId);
      }
      throw new Error(`Re-add after stale duplicate failed: ${text2}`);
    }

    throw new Error(`Add torrent failed: ${text}`);
  }

  throw new Error(`Add torrent failed: ${text}`);
}

async function getHashBySavePath(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await qbtJson('/torrents/info');
    const found = list.find(t => t.save_path?.includes(jobId));
    if (found) return found.hash;
    await sleep(1000);
  }
  return null;
}

export async function getTorrentByHash(hash) {
  const list = await qbtJson(`/torrents/info?hashes=${hash.toLowerCase()}`);
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

// Upload a seedbox file directly to R2 via SSH: run a Python script ON the seedbox
// so bytes travel Seedbox (NL) → Cloudflare R2 and never touch the AU VM.
export function uploadFromSeedbox(remotePath, r2Key, r2Url, r2Secret, onProgress) {
  // Python script that runs ON the seedbox and streams the file to R2 multipart
  const ext = path.extname(remotePath).toLowerCase();
  const mimeMap = {'.mkv':'video/x-matroska','.mp4':'video/mp4','.avi':'video/x-msvideo','.webm':'video/webm','.m4v':'video/mp4'};
  const mime = mimeMap[ext] || 'video/mp4';

  const py = `
import sys, json, math, os
from urllib.request import Request, urlopen
from urllib.parse import quote

FILE   = ${JSON.stringify(remotePath)}
KEY    = ${JSON.stringify(r2Key)}
MIME   = ${JSON.stringify(mime)}
BASE   = ${JSON.stringify(r2Url + '/upload')}
SECRET = ${JSON.stringify(r2Secret)}
CHUNK  = 64 * 1024 * 1024

def api(action, extra='', method='GET', data=None, ct=None):
    url = f"{BASE}?action={action}&key={quote(KEY,safe='')}{extra}"
    hdrs = {'x-upload-secret': SECRET, 'User-Agent': 'curl/7.88.1'}
    if ct: hdrs['content-type'] = ct
    with urlopen(Request(url, data=data, method=method, headers=hdrs)) as r:
        return json.loads(r.read())

size   = os.path.getsize(FILE)
nparts = math.ceil(size / CHUNK)
uid    = api('create', f'&contentType={MIME}', 'POST')['uploadId']
sys.stdout.write(json.dumps({'uid': uid, 'size': size}) + '\\n'); sys.stdout.flush()

parts = []
with open(FILE, 'rb') as f:
    for i in range(nparts):
        chunk = f.read(CHUNK)
        pn    = i + 1
        etag  = api('part', f'&uploadId={uid}&partNumber={pn}', 'PUT', chunk, 'application/octet-stream')['etag']
        parts.append({'partNumber': pn, 'etag': etag})
        sys.stdout.write(json.dumps({'pct': round(pn/nparts*100), 'part': pn, 'total': nparts}) + '\\n')
        sys.stdout.flush()

api('complete', f'&uploadId={uid}', 'POST', json.dumps({'parts': parts}).encode(), 'application/json')
sys.stdout.write(json.dumps({'done': True}) + '\\n'); sys.stdout.flush()
`;

  const pyB64 = Buffer.from(py).toString('base64');

  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    conn.on('ready', () => {
      conn.exec(`echo '${pyB64}' | base64 -d | python3`, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let lineBuf = '';
        let stderr  = '';
        stream.stdout.on('data', (data) => {
          lineBuf += data.toString();
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.pct  !== undefined) onProgress?.(msg.pct);
              if (msg.done) resolve();
            } catch { /* partial line */ }
          }
        });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
        stream.on('close', (code) => {
          conn.end();
          if (code !== 0) reject(new Error(`Seedbox upload failed (exit ${code}): ${stderr.slice(-500)}`));
        });
      });
    });
    conn.on('error', reject);
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}

// Stream file from seedbox SFTP directly into an async iterator (no VM disk).
// Uses parallel SSH reads (64 concurrent) for high-throughput over high-latency links.
export function streamFromSftp(remotePath) {
  const sftp = new SftpClient();
  return {
    async open() {
      await sftp.connect({
        host: SFTP_HOST, port: SFTP_PORT,
        username: QB_USER, password: QB_PASS,
      });
      const stat = await sftp.stat(remotePath);
      const size = stat.size;

      // ssh2-sftp-client exposes the raw ssh2 SFTP session as .sftp after connect
      const ssh2sftp = sftp.sftp;

      // Open the remote file and build the parallel readable
      const handle = await new Promise((res, rej) =>
        ssh2sftp.open(remotePath, 'r', (err, h) => err ? rej(err) : res(h))
      );

      const READ_SIZE  = 32768;
      const CONCURRENT = 64;
      const total   = Math.ceil(size / READ_SIZE);
      const pending = new Map();
      let   nextSend = 0, nextEmit = 0, inFlight = 0, errored = false;
      const out = new Readable({ highWaterMark: 8 * 1024 * 1024, read() {} });

      function tryEmit() {
        while (pending.has(nextEmit)) {
          const data = pending.get(nextEmit);
          pending.delete(nextEmit++);
          if (data.length) out.push(data);
        }
        if (!errored && nextEmit >= total && inFlight === 0 && nextSend >= total) {
          out.push(null);
          ssh2sftp.close(handle, () => {});
        }
      }

      function scheduleReads() {
        while (!errored && inFlight < CONCURRENT && nextSend < total) {
          const idx = nextSend++;
          const offset = idx * READ_SIZE;
          const len    = Math.min(READ_SIZE, size - offset);
          const buf    = Buffer.allocUnsafe(len);
          inFlight++;
          ssh2sftp.read(handle, buf, 0, len, offset, (err, bytesRead) => {
            inFlight--;
            if (err) { errored = true; out.destroy(err); ssh2sftp.close(handle, () => {}); return; }
            pending.set(idx, buf.slice(0, bytesRead));
            tryEmit();
            scheduleReads();
          });
        }
      }

      scheduleReads();
      return { stream: out, size };
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

// Find the largest video file inside a torrent's save folder.
// Pass torrentHash to let us look up the actual save path from qBittorrent —
// handles orphaned torrents that were added under a different jobId.
export async function findVideoFile(jobId, torrentHash) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });

    let saveDir = getSeedboxSavePath(jobId);
    if (torrentHash) {
      const list = await qbtJson(`/torrents/info?hashes=${torrentHash}`);
      if (list[0]) {
        // content_path = actual root of downloaded files (may be a subdir of save_path)
        // save_path = the configured destination directory
        // Try content_path first — more accurate when torrent has its own subdirectory
        const contentPath = (list[0].content_path || '').replace(/\/$/, '');
        const savePath    = (list[0].save_path    || '').replace(/\/$/, '');
        // If content_path is a file (single-file torrent), use its directory
        const isFile = contentPath && path.extname(contentPath).length > 0;
        saveDir = (isFile ? path.dirname(contentPath) : contentPath) || savePath || saveDir;
        console.log(`[sftp] using qBittorrent path: ${saveDir}`);
      }
    }
    console.log(`[sftp] scanning ${saveDir} for video files`);
    const videos = await listVideosRecursive(sftp, saveDir);

    if (!videos.length) throw new Error(`No video file found under ${saveDir}`);
    videos.sort((a, b) => b.size - a.size);
    console.log(`[sftp] found ${videos.length} video(s), largest: ${videos[0].path} (${(videos[0].size/1e9).toFixed(2)} GB)`);
    return { path: videos[0].path, size: videos[0].size };
  } finally {
    await sftp.end().catch(() => {});
  }
}

// ── Internal: SFTP stream → ffmpeg → R2, zero disk ──────────────────────────
// codecArgs controls what ffmpeg does with the streams.
// Remux:     ['-c', 'copy']                              — I/O bound, very fast
// Transcode: ['-c:v','copy','-c:a','aac','-b:a','192k','-ac','2'] — CPU for audio
async function _streamFfmpegToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, codecArgs, onProgress, logTag = 'stream') {
  const mime   = 'video/mp4';
  const PART   = 16 * 1024 * 1024;
  const CONC   = 4;
  const mkUrl  = (action, extra = {}) =>
    `${r2UploadUrl}?${new URLSearchParams({ action, key: r2Key, ...extra })}`;
  const r2h = { 'x-upload-secret': r2Secret };

  const cr = await fetch(mkUrl('create', { contentType: mime }), { method: 'POST', headers: r2h });
  if (!cr.ok) throw new Error(`R2 create: ${await cr.text()}`);
  const { uploadId } = await cr.json();

  const sftp = new SftpClient();
  await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });

  const sftpReadable = sftp.sftp.createReadStream(remotePath, { readAheadCount: 64 });

  const ff = spawn('ffmpeg', [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    ...codecArgs,
    '-map', '0:v:0', '-map', '0:a:0',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ]);
  let ffErr = '';
  ff.stderr.on('data', d => { ffErr += d; });
  const ffClose = new Promise((res, rej) =>
    ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}: ${ffErr.slice(-400)}`)))
  );

  sftpReadable.pipe(ff.stdin);
  sftpReadable.on('error', () => { ff.kill(); });
  ff.stdin.on('error', () => {});  // ignore EPIPE when ffmpeg exits early

  const parts    = [];
  const inFlight = [];
  let   partNum  = 0;
  let   uploaded = 0;
  let   buf      = Buffer.alloc(0);

  function startPart(chunk) {
    const pn = ++partNum;
    return (async () => {
      const res = await fetch(mkUrl('part', { uploadId, partNumber: String(pn) }), {
        method: 'PUT',
        headers: { ...r2h, 'content-type': 'application/octet-stream' },
        body: chunk,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`R2 part ${pn}: ${await res.text()}`);
      const { etag } = await res.json();
      uploaded += chunk.length;
      onProgress?.(Math.round(uploaded / fileSize * 100));
      console.log(`[r2] ${logTag} part ${pn} (${(chunk.length / 1e6).toFixed(0)} MB)`);
      return { partNumber: pn, etag };
    })();
  }

  try {
    for await (const chunk of ff.stdout) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      while (buf.length >= PART) {
        if (inFlight.length >= CONC) parts.push(await inFlight.shift());
        inFlight.push(startPart(Buffer.from(buf.slice(0, PART))));
        buf = buf.slice(PART);
      }
    }
    if (buf.length > 0) {
      if (inFlight.length >= CONC) parts.push(await inFlight.shift());
      inFlight.push(startPart(buf));
    }
    for (const p of inFlight) parts.push(await p);

    await ffClose;

    parts.sort((a, b) => a.partNumber - b.partNumber);
    const done = await fetch(mkUrl('complete', { uploadId }), {
      method: 'POST', headers: { ...r2h, 'content-type': 'application/json' },
      body: JSON.stringify({ parts }),
    });
    if (!done.ok) throw new Error(`R2 complete: ${await done.text()}`);
    console.log(`[r2] ${logTag} complete: ${r2Key}`);

  } catch (err) {
    await fetch(mkUrl('abort', { uploadId }), { method: 'DELETE', headers: r2h }).catch(() => {});
    if (ff.exitCode === null) ff.kill();
    throw err;
  } finally {
    await sftp.end().catch(() => {});
  }
}

// Remux MKV → fragmented MP4 without re-encoding anything.
// Use when audio is already browser-compatible (AAC, AC3).
// I/O bound only — much faster than audio transcode.
export function streamRemuxToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, onProgress) {
  return _streamFfmpegToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key,
    ['-c', 'copy'], onProgress, 'remux');
}

// Remux MKV → fragmented MP4 and transcode audio to AAC.
// Use when audio is DTS / EAC3 / other codec browsers can't decode.
export function streamTranscodeToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, onProgress) {
  return _streamFfmpegToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key,
    ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2'], onProgress, 'transcode');
}

// ── fastGet → disk → ffmpeg (audio→AAC) → R2 ──────────────────────────────
// fastGet uses 64+ concurrent SSH reads = ~35 MB/s vs 4 MB/s for streaming.
// ffmpeg reads from disk (unconstrained), outputs to R2 via concurrent part uploads.
// Only one temp file on disk at a time. ~3× faster than the streaming approach.
export async function transcodeAudioAndUploadToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, onProgress, tempDir = '/tmp') {
  const ext     = path.extname(remotePath).toLowerCase();
  // Always output fragmented MP4 — designed for byte-range seeking in browsers.
  // MKV output to a pipe puts the Cues index at the END so seeking stalls until
  // the full file is buffered. fMP4 fragments are self-contained so the browser
  // can seek by bisecting byte offsets without any front-loaded index.
  const mime    = 'video/mp4';
  const PART    = 16 * 1024 * 1024;
  const CONC    = 4;
  const tmpFile = path.join(tempDir, `radical-tmp-${Date.now()}${ext}`);

  const mkUrl = (action, extra = {}) =>
    `${r2UploadUrl}?${new URLSearchParams({ action, key: r2Key, ...extra })}`;
  const r2h = { 'x-upload-secret': r2Secret };

  try {
    // ── Phase 1: fastGet to disk (~35 MB/s using 64 concurrent SSH reads) ──
    console.log(`[sftp] fastGet → ${tmpFile}`);
    const sftp = new SftpClient();
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
    try {
      await sftp.fastGet(remotePath, tmpFile, {
        concurrency: 128,
        step: (transferred) => {
          onProgress?.(Math.round(transferred / fileSize * 50)); // 0-50%
        },
      });
    } finally {
      await sftp.end().catch(() => {});
    }
    console.log(`[sftp] fastGet complete (${(fileSize/1e9).toFixed(2)} GB)`);

    // ── Phase 2: ffmpeg reads file → transcodes audio → stdout → R2 ──
    const cr = await fetch(mkUrl('create', { contentType: mime }), { method: 'POST', headers: r2h });
    if (!cr.ok) throw new Error(`R2 create: ${await cr.text()}`);
    const { uploadId } = await cr.json();

    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', tmpFile,
      '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ]);
    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d; });

    const parts    = [];
    const inFlight = [];
    let   partNum  = 0;
    let   uploaded = 0;
    let   buf      = Buffer.alloc(0);

    // Capture ffmpeg close BEFORE reading stdout — avoids race where close fires
    // before we register the listener and we hang waiting forever.
    const ffClose = new Promise((res, rej) =>
      ff.on('close', code => code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}: ${ffErr.slice(-300)}`)))
    );

    function startPart(chunk) {
      const pn = ++partNum;
      return (async () => {
        const res = await fetch(mkUrl('part', { uploadId, partNumber: String(pn) }), {
          method: 'PUT',
          headers: { ...r2h, 'content-type': 'application/octet-stream' },
          body: chunk,
          signal: AbortSignal.timeout(120_000), // 2 min per part max
        });
        if (!res.ok) throw new Error(`R2 part ${pn}: ${await res.text()}`);
        const { etag } = await res.json();
        uploaded += chunk.length;
        onProgress?.(50 + Math.round(uploaded / fileSize * 50)); // 50-100%
        console.log(`[r2] transcode part ${pn} (${(chunk.length/1e6).toFixed(0)} MB)`);
        return { partNumber: pn, etag };
      })();
    }

    try {
      for await (const chunk of ff.stdout) {
        buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
        while (buf.length >= PART) {
          if (inFlight.length >= CONC) parts.push(await inFlight.shift());
          inFlight.push(startPart(Buffer.from(buf.slice(0, PART))));
          buf = buf.slice(PART);
        }
      }
      if (buf.length > 0) {
        if (inFlight.length >= CONC) parts.push(await inFlight.shift());
        inFlight.push(startPart(buf));
      }
      for (const p of inFlight) parts.push(await p);

      // Wait for ffmpeg to exit cleanly (already listening — no race condition)
      await ffClose;

      parts.sort((a, b) => a.partNumber - b.partNumber);
      const done = await fetch(mkUrl('complete', { uploadId }), {
        method: 'POST', headers: { ...r2h, 'content-type': 'application/json' },
        body: JSON.stringify({ parts }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!done.ok) throw new Error(`R2 complete: ${await done.text()}`);
      console.log(`[r2] transcode+upload complete: ${r2Key}`);

    } catch (err) {
      await fetch(mkUrl('abort', { uploadId }), { method: 'DELETE', headers: r2h }).catch(() => {});
      if (ff.exitCode === null) ff.kill();
      throw err;
    }

  } finally {
    fs.unlink(tmpFile, () => {}); // always clean up temp file
  }
}

// ── Parallel SFTP → R2 upload ─────────────────────────────────────────────
// Opens N_CONN parallel SFTP connections. Each picks parts off a shared queue,
// reads the part's byte range with 64 concurrent SSH reads, then uploads to R2.
// This saturates both the NL→AU pipe and the AU→CF pipe simultaneously.
const MIME_MAP = { '.mkv':'video/x-matroska', '.mp4':'video/mp4', '.m4v':'video/mp4',
                   '.webm':'video/webm', '.avi':'video/x-msvideo', '.mov':'video/quicktime' };

export async function parallelSftpToR2(remotePath, fileSize, r2BaseUrl, r2Secret, r2Key, ext, onProgress) {
  const N_CONN    = 8;              // parallel SFTP connections (= parallel part uploads)
  const PART_SIZE = 64 * 1024 * 1024; // 64 MB per R2 part
  const BLOCK     = 32768;          // 32 KB per SSH read packet
  const SSH_CONC  = 64;             // concurrent SSH reads per connection
  const nParts    = Math.ceil(fileSize / PART_SIZE);
  const mime      = MIME_MAP[ext.toLowerCase()] || 'video/mp4';

  const mkUrl = (action, extra = {}) =>
    `${r2BaseUrl}?${new URLSearchParams({ action, key: r2Key, ...extra })}`;
  const r2h = { 'x-upload-secret': r2Secret };

  // Create R2 multipart upload
  const cr = await fetch(mkUrl('create', { contentType: mime }), { method: 'POST', headers: r2h });
  if (!cr.ok) throw new Error(`R2 create failed: ${await cr.text()}`);
  const { uploadId } = await cr.json();
  console.log(`[r2] parallel upload: ${nParts} parts × ${N_CONN} connections — ${(fileSize/1e9).toFixed(2)} GB`);

  // Read a specific byte range from SFTP with SSH_CONC concurrent sub-reads
  function readRange(ssh2sftp, handle, fileOffset, length) {
    const buf     = Buffer.allocUnsafe(length);
    const nBlocks = Math.ceil(length / BLOCK);
    let inFlight = 0, nextBlock = 0, done = 0, failed = false;
    return new Promise((resolve, reject) => {
      function go() {
        while (!failed && inFlight < SSH_CONC && nextBlock < nBlocks) {
          const bi  = nextBlock++;
          const pos = fileOffset + bi * BLOCK;
          const len = Math.min(BLOCK, length - bi * BLOCK);
          inFlight++;
          ssh2sftp.read(handle, buf, bi * BLOCK, len, pos, (err) => {
            inFlight--;
            if (err) { failed = true; reject(err); return; }
            if (++done === nBlocks) resolve(buf); else go();
          });
        }
      }
      go();
    });
  }

  // Open N_CONN SFTP connections, each holding an open file handle
  const conns = await Promise.all(Array.from({ length: N_CONN }, async () => {
    const s = new SftpClient();
    await s.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
    const handle = await new Promise((res, rej) =>
      s.sftp.open(remotePath, 'r', (err, h) => err ? rej(err) : res(h))
    );
    return { s, handle };
  }));

  const queue = Array.from({ length: nParts }, (_, i) => i + 1); // [1..nParts]
  const etags = [];
  let   completed = 0;

  try {
    await Promise.all(conns.map(async ({ s, handle }) => {
      while (true) {
        const pn = queue.shift();
        if (pn === undefined) break;
        const offset  = (pn - 1) * PART_SIZE;
        const partLen = Math.min(PART_SIZE, fileSize - offset);

        const data = await readRange(s.sftp, handle, offset, partLen);

        const pr = await fetch(mkUrl('part', { uploadId, partNumber: String(pn) }), {
          method: 'PUT',
          headers: { ...r2h, 'content-type': 'application/octet-stream' },
          body: data,
        });
        if (!pr.ok) throw new Error(`R2 part ${pn} failed: ${await pr.text()}`);
        const { etag } = await pr.json();
        etags.push({ partNumber: pn, etag });
        onProgress?.(Math.round(++completed / nParts * 100));
        console.log(`[r2] part ${pn}/${nParts} (${(partLen/1e6).toFixed(0)} MB)`);
      }
    }));

    const done = await fetch(mkUrl('complete', { uploadId }), {
      method: 'POST', headers: { ...r2h, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: etags.sort((a, b) => a.partNumber - b.partNumber) }),
    });
    if (!done.ok) throw new Error(`R2 complete failed: ${await done.text()}`);
    console.log(`[r2] upload complete: ${r2Key}`);

  } catch (err) {
    await fetch(mkUrl('abort', { uploadId }), { method: 'DELETE', headers: r2h }).catch(() => {});
    throw err;
  } finally {
    for (const { s, handle } of conns) {
      s.sftp.close(handle, () => {});
      await s.end().catch(() => {});
    }
  }
}

// Download the first 1 MB of a remote file via SFTP, run ffprobe locally,
// return the primary audio codec name ('aac', 'ac3', 'dts', 'eac3', …) or null.
// 1 MB is enough to cover MKV/MP4 track headers for all standard releases.
export async function probeRemoteFileAudio(remotePath, tempDir = '/tmp') {
  const tmpFile = path.join(tempDir, `probe-${Date.now()}.hdr`);
  try {
    const sftp = new SftpClient();
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
    try {
      await new Promise((resolve, reject) => {
        const rs = sftp.sftp.createReadStream(remotePath, { start: 0, end: 1024 * 1024 - 1 });
        const ws = fs.createWriteStream(tmpFile);
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      });
    } finally {
      await sftp.end().catch(() => {});
    }

    const codec = await new Promise((resolve) => {
      const ff = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        tmpFile,
      ]);
      let out = '';
      ff.stdout.on('data', d => { out += d; });
      ff.on('close', () => resolve(out.trim().toLowerCase() || null));
    });

    console.log(`[probe] remote audio: ${codec ?? 'undetected'} (${path.basename(remotePath)})`);
    return codec;
  } catch (err) {
    console.warn('[probe] failed:', err.message);
    return null;
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// Probe audio and video codecs in a single SSH connection — faster than two separate calls.
// Returns { audio, video } where each is the codec name string or null.
export async function probeRemoteCodecs(remotePath) {
  return new Promise((resolve) => {
    const conn = new SSH2Client();
    conn.on('ready', () => {
      // One ffprobe call — prints audio stream first, then video
      const cmd = `ffprobe -v error -show_entries stream=codec_name,codec_type -of csv=p=0 ${JSON.stringify(remotePath)} 2>/dev/null`;
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return resolve({ audio: null, video: null }); }
        let out = '';
        stream.stdout.on('data', d => { out += d; });
        stream.on('close', () => {
          conn.end();
          let audio = null, video = null;
          for (const line of out.trim().split('\n')) {
            const [codec, type] = line.trim().split(',');
            if (!codec || !type) continue;
            if (type === 'audio' && !audio) audio = codec.toLowerCase();
            if (type === 'video' && !video) video = codec.toLowerCase();
          }
          resolve({ audio, video });
        });
      });
    });
    conn.on('error', () => resolve({ audio: null, video: null }));
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}

// Legacy single-stream probe — kept for callers that only need audio
export async function probeRemoteAudioCodec(remotePath) {
  const { audio } = await probeRemoteCodecs(remotePath);
  return audio;
}

// ── ffmpeg on seedbox → R2 ───────────────────────────────────────────────────
// Runs ffmpeg ON the seedbox via SSH, pipes output straight to R2.
// Fly.io does zero video work — seedbox disk → seedbox CPU → R2 (NL→EU, fast).
// codecArgs: ['-c','copy'] for remux, ['-c:v','copy','-c:a','aac',...] for transcode.
export function ffmpegSeedboxToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, codecArgs, onProgress) {
  const CHUNK = 64 * 1024 * 1024;

  // Two-phase approach on the seedbox:
  // Phase 1 — ffmpeg reads from the LOCAL file (seekable) → writes to a temp file with
  //   -movflags +faststart.  Because both input and output are seekable files, ffmpeg can
  //   compute the real duration and place moov at byte 0 with correct duration metadata.
  //   Pipe output with empty_moov always produces duration=0, causing browsers to buffer
  //   the entire file before starting playback (1–2 min stall on large files).
  // Phase 2 — read the temp file and upload to R2 in sequential 64 MB chunks.
  const py = `
import sys, json, subprocess, os, threading
from urllib.request import Request, urlopen
from urllib.parse import quote

FILE   = ${JSON.stringify(remotePath)}
KEY    = ${JSON.stringify(r2Key)}
MIME   = 'video/mp4'
BASE   = ${JSON.stringify(r2UploadUrl)}
SECRET = ${JSON.stringify(r2Secret)}
CHUNK  = ${CHUNK}
CODEC  = ${JSON.stringify(codecArgs)}
TMPOUT = '/home/seedit4me/tmp/radical-web-' + str(os.getpid()) + '.mp4'
os.makedirs('/home/seedit4me/tmp', exist_ok=True)

def api(action, extra='', method='GET', data=None, ct=None):
    url = BASE + '?action=' + action + '&key=' + quote(KEY, safe='') + extra
    hdrs = {'x-upload-secret': SECRET, 'User-Agent': 'curl/7.88.1'}
    if ct: hdrs['content-type'] = ct
    with urlopen(Request(url, data=data, method=method, headers=hdrs), timeout=120) as r:
        return json.loads(r.read())

# Get duration so we can report % progress during encode
probe = subprocess.run(
    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
     '-of', 'default=noprint_wrappers=1:nokey=1', FILE],
    capture_output=True, text=True, timeout=30
)
try:
    total_secs = float(probe.stdout.strip())
except:
    total_secs = 0

# Phase 1: ffmpeg reads FILE → TMPOUT with faststart.
# -progress pipe:2 streams structured progress to stderr every 3 s.
# A reader thread parses out_time_ms and emits encode_pct (0-49%) to stdout.
sys.stdout.write(json.dumps({'phase': 'remux'}) + '\\n'); sys.stdout.flush()

last_pct = [0]
stderr_buf = []

proc = subprocess.Popen(
    ['ffmpeg', '-loglevel', 'error', '-i', FILE] + CODEC +
    ['-map', '0:v:0', '-map', '0:a:0', '-movflags', '+faststart',
     '-progress', 'pipe:2', '-y', TMPOUT],
    stderr=subprocess.PIPE
)

def read_progress():
    buf = b''
    while True:
        chunk = proc.stderr.read(512)
        if not chunk:
            break
        buf += chunk
        lines = buf.split(b'\\n')
        buf = lines[-1]
        for line in lines[:-1]:
            txt = line.decode('utf-8', errors='replace').strip()
            stderr_buf.append(txt)
            if txt.startswith('out_time_ms=') and total_secs > 0:
                try:
                    ms = int(txt.split('=')[1])
                    pct = min(48, int(ms / 1e6 / total_secs * 49))
                    if pct > last_pct[0]:
                        last_pct[0] = pct
                        sys.stdout.write(json.dumps({'encode_pct': pct}) + '\\n')
                        sys.stdout.flush()
                except:
                    pass

t = threading.Thread(target=read_progress, daemon=True)
t.start()
proc.wait()
t.join(timeout=5)

if proc.returncode != 0:
    err = '\\n'.join(stderr_buf[-20:])
    sys.stdout.write(json.dumps({'error': 'ffmpeg: ' + err[-400:]}) + '\\n')
    if os.path.exists(TMPOUT): os.unlink(TMPOUT)
    sys.exit(1)

out_size = os.path.getsize(TMPOUT)
sys.stdout.write(json.dumps({'remuxed': True, 'size': out_size}) + '\\n'); sys.stdout.flush()

# Phase 2: upload TMPOUT to R2
uid = api('create', '&contentType=' + MIME, 'POST')['uploadId']
parts = []; pn = 0; done_bytes = 0
try:
    with open(TMPOUT, 'rb') as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk: break
            pn += 1
            r = api('part', '&uploadId=' + uid + '&partNumber=' + str(pn), 'PUT', chunk, 'application/octet-stream')
            parts.append({'partNumber': pn, 'etag': r['etag']})
            done_bytes += len(chunk)
            sys.stdout.write(json.dumps({'part': pn, 'bytes': done_bytes, 'total': out_size}) + '\\n'); sys.stdout.flush()
    api('complete', '&uploadId=' + uid, 'POST', json.dumps({'parts': parts}).encode(), 'application/json')
    sys.stdout.write(json.dumps({'done': True}) + '\\n'); sys.stdout.flush()
except Exception as e:
    try: api('abort', '&uploadId=' + uid, 'DELETE')
    except: pass
    sys.stdout.write(json.dumps({'error': str(e)}) + '\\n'); sys.stdout.flush()
    sys.exit(1)
finally:
    if os.path.exists(TMPOUT): os.unlink(TMPOUT)
`;

  // Base64-encode the script to avoid all shell quoting/newline issues.
  // bash receives: echo 'BASE64' | base64 -d | python3
  // Python gets the script with real newlines, no escaping problems.
  const pyB64 = Buffer.from(py).toString('base64');

  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    conn.on('ready', () => {
      conn.exec(`echo '${pyB64}' | base64 -d | python3`, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let lineBuf = '', stderr = '';
        stream.stdout.on('data', (data) => {
          lineBuf += data.toString();
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.error) return reject(new Error(`Seedbox ffmpeg: ${msg.error}`));
              if (msg.phase === 'remux') onProgress?.(0);
              if (msg.encode_pct !== undefined) onProgress?.(msg.encode_pct); // 0-48% during encode
              if (msg.remuxed) onProgress?.(50);
              if (msg.bytes !== undefined) {
                const total = msg.total || fileSize;
                onProgress?.(50 + Math.min(49, Math.round(msg.bytes / total * 50)));
              }
              if (msg.done) resolve();
            } catch {}
          }
        });
        stream.stderr.on('data', (d) => { stderr += d.toString(); });
        stream.on('close', (code) => {
          conn.end();
          if (code !== 0) reject(new Error(`Seedbox ffmpeg SSH exit ${code}: ${stderr.slice(-300)}`));
        });
      });
    });
    conn.on('error', reject);
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}

// Remux container only (no re-encode) — I/O bound, very fast
export function remuxOnSeedbox(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, onProgress) {
  console.log(`[seedbox] remux on seedbox: ${path.basename(remotePath)}`);
  return ffmpegSeedboxToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, ['-c', 'copy'], onProgress);
}

// Re-encode audio to AAC only — video stream copied
export function transcodeOnSeedbox(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, onProgress) {
  console.log(`[seedbox] transcode audio on seedbox: ${path.basename(remotePath)}`);
  return ffmpegSeedboxToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key,
    ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2'], onProgress);
}

// Re-encode video H.265→H.264 for Safari compatibility + optionally audio→AAC
// CRF 20 + fast preset: ~7 min for a 2h movie on seedbox CPU — acceptable for correctness
export function transcodeVideoOnSeedbox(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key, onProgress, audioNeedsTranscode = false) {
  const audioArgs = audioNeedsTranscode
    ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']
    : ['-c:a', 'copy'];
  console.log(`[seedbox] transcode video (H.265→H.264)${audioNeedsTranscode ? ' + audio→AAC' : ''}: ${path.basename(remotePath)}`);
  return ffmpegSeedboxToR2(remotePath, fileSize, r2UploadUrl, r2Secret, r2Key,
    ['-c:v', 'libx264', '-crf', '20', '-preset', 'ultrafast', ...audioArgs], onProgress);
}

// Delete a directory on the seedbox via SSH — used after upload to free disk
export function deleteSeedboxDir(dirPath) {
  return new Promise((resolve) => {
    const conn = new SSH2Client();
    conn.on('ready', () => {
      conn.exec(`rm -rf ${JSON.stringify(dirPath)}`, (err, stream) => {
        if (err) { conn.end(); return resolve(); }
        stream.on('close', () => { conn.end(); resolve(); });
      });
    });
    conn.on('error', () => resolve()); // best-effort, never throw
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
export function getSeedboxSavePath(jobId) {
  return path.join(SAVE_PATH, jobId);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Audio helpers ─────────────────────────────────────────────────────────────
const AUDIO_EXTS = new Set(['.mp3','.flac','.m4a','.aac','.ogg','.wav','.opus','.ape','.wma','.alac']);

async function listAudioRecursive(sftp, dirPath) {
  const results = [];
  let entries;
  try { entries = await sftp.list(dirPath); } catch { return results; }
  for (const e of entries) {
    const full = dirPath.replace(/\/$/, '') + '/' + e.name;
    if (e.type === 'd' && e.name !== '.' && e.name !== '..') {
      results.push(...await listAudioRecursive(sftp, full));
    } else if (AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) {
      results.push({ path: full, name: e.name, size: e.size });
    }
  }
  return results;
}

export async function findAudioFiles(jobId, torrentHash) {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
    let saveDir = getSeedboxSavePath(jobId);
    if (torrentHash) {
      const list = await qbtJson(`/torrents/info?hashes=${torrentHash}`);
      if (list[0]) {
        const cp = (list[0].content_path || '').replace(/\/$/, '');
        const sp = (list[0].save_path    || '').replace(/\/$/, '');
        const isFile = cp && path.extname(cp).length > 0;
        saveDir = (isFile ? path.dirname(cp) : cp) || sp || saveDir;
      }
    }
    const files = await listAudioRecursive(sftp, saveDir);
    // Sort naturally by filename (handles "01 - Track.flac" etc.)
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return files;
  } finally {
    await sftp.end().catch(() => {});
  }
}

// Probe audio file metadata via ffprobe on the seedbox
export async function probeAudioMeta(remotePath) {
  return new Promise((resolve) => {
    const conn = new SSH2Client();
    conn.on('ready', () => {
      const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams ${JSON.stringify(remotePath)} 2>/dev/null`;
      conn.exec(cmd, (err, stream) => {
        if (err) { conn.end(); return resolve({}); }
        let out = '';
        stream.stdout.on('data', d => { out += d; });
        stream.on('close', () => {
          conn.end();
          try {
            const p    = JSON.parse(out);
            const tags = { ...(p.format?.tags || {}), ...(p.streams?.[0]?.tags || {}) };
            const getTag = (...keys) => {
              for (const k of keys) {
                const v = tags[k] || tags[k.toUpperCase()] || tags[k.toLowerCase()];
                if (v) return String(v).trim();
              }
              return null;
            };
            const trackRaw = getTag('track');
            const discRaw  = getTag('disc', 'disk');
            resolve({
              title:    getTag('title'),
              artist:   getTag('artist', 'albumartist'),
              album:    getTag('album'),
              track:    trackRaw ? parseInt(trackRaw.split('/')[0]) || 0 : 0,
              disc:     discRaw  ? parseInt(discRaw.split('/')[0])  || 1 : 1,
              duration: Math.round(parseFloat(p.format?.duration) || 0),
            });
          } catch { resolve({}); }
        });
      });
    });
    conn.on('error', () => resolve({}));
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}

// Convert any audio file to MP3 320kbps on the seedbox and upload to R2
export function convertAudioOnSeedbox(remotePath, fileSize, uploadUrl, secret, r2Key, onProgress) {
  const CHUNK = 32 * 1024 * 1024;
  const ext   = path.extname(remotePath).toLowerCase();

  const py = `
import sys, json, subprocess, os
from urllib.request import Request, urlopen
from urllib.parse import quote

FILE   = ${JSON.stringify(remotePath)}
KEY    = ${JSON.stringify(r2Key)}
MIME   = 'audio/mpeg'
BASE   = ${JSON.stringify(uploadUrl)}
SECRET = ${JSON.stringify(secret)}
CHUNK  = ${CHUNK}
TMPOUT = '/home/seedit4me/tmp/radical-audio-' + str(os.getpid()) + '.mp3'
os.makedirs('/home/seedit4me/tmp', exist_ok=True)

def api(action, extra='', method='GET', data=None, ct=None):
    url = BASE + '?action=' + action + '&key=' + quote(KEY, safe='') + extra
    h = {'x-upload-secret': SECRET, 'User-Agent': 'radical/1.0'}
    if ct: h['content-type'] = ct
    with urlopen(Request(url, data=data, method=method, headers=h), timeout=300) as r:
        return json.loads(r.read())

sys.stdout.write(json.dumps({'phase':'encode'})+'\\n'); sys.stdout.flush()

ext = os.path.splitext(FILE)[1].lower()
if ext == '.mp3':
    cmd = ['ffmpeg','-loglevel','error','-i',FILE,'-c:a','copy','-y',TMPOUT]
else:
    cmd = ['ffmpeg','-loglevel','error','-i',FILE,'-vn','-c:a','libmp3lame','-q:a','0','-y',TMPOUT]

proc = subprocess.run(cmd, capture_output=True)
if proc.returncode != 0:
    sys.stdout.write(json.dumps({'error':proc.stderr.decode(errors='replace')[-400:]})+'\\n')
    sys.exit(1)

sys.stdout.write(json.dumps({'phase':'upload'})+'\\n'); sys.stdout.flush()
size = os.path.getsize(TMPOUT)
r    = api('create','&contentType='+MIME,method='POST')
uid  = r['uploadId']
parts = []
pn    = 0
up    = 0
with open(TMPOUT,'rb') as f:
    while True:
        chunk = f.read(CHUNK)
        if not chunk: break
        pn += 1
        r = api('part','&uploadId='+uid+'&partNumber='+str(pn),method='PUT',data=chunk,ct='application/octet-stream')
        parts.append({'partNumber':pn,'etag':r['etag']})
        up += len(chunk)
        sys.stdout.write(json.dumps({'pct':min(99,int(up/size*100))})+'\\n'); sys.stdout.flush()
api('complete','&uploadId='+uid,method='POST',data=json.dumps(parts).encode(),ct='application/json')
if os.path.exists(TMPOUT): os.unlink(TMPOUT)
sys.stdout.write(json.dumps({'done':True})+'\\n')
`;

  const pyB64 = Buffer.from(py).toString('base64');
  return new Promise((resolve, reject) => {
    const conn = new SSH2Client();
    conn.on('ready', () => {
      conn.exec(`echo '${pyB64}' | base64 -d | python3`, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        let errOut = '';
        stream.stdout.on('data', d => {
          for (const line of d.toString().split('\n')) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.error)  { errOut = msg.error; }
              if (msg.pct)    onProgress?.(msg.pct);
              if (msg.done)   {}
            } catch {}
          }
        });
        stream.stderr.on('data', d => { errOut += d.toString(); });
        stream.on('close', code => {
          conn.end();
          if (code !== 0) reject(new Error(`audio convert failed: ${errOut.slice(-300)}`));
          else resolve();
        });
      });
    });
    conn.on('error', reject);
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}

// Extract embedded cover art from an audio file on the seedbox and upload to R2
export function extractCoverArtOnSeedbox(audioPath, uploadUrl, secret, r2Key) {
  const py = `
import sys, json, subprocess, os
from urllib.request import Request, urlopen
from urllib.parse import quote

FILE   = ${JSON.stringify(audioPath)}
KEY    = ${JSON.stringify(r2Key)}
BASE   = ${JSON.stringify(uploadUrl)}
SECRET = ${JSON.stringify(secret)}
TMPOUT = '/home/seedit4me/tmp/radical-cover-' + str(os.getpid()) + '.jpg'
os.makedirs('/home/seedit4me/tmp', exist_ok=True)

def api(action, extra='', method='GET', data=None, ct=None):
    url = BASE + '?action=' + action + '&key=' + quote(KEY, safe='') + extra
    h = {'x-upload-secret': SECRET, 'User-Agent': 'radical/1.0'}
    if ct: h['content-type'] = ct
    with urlopen(Request(url, data=data, method=method, headers=h), timeout=120) as r:
        return json.loads(r.read())

proc = subprocess.run(
    ['ffmpeg','-loglevel','error','-i',FILE,'-an','-vcodec','copy','-y',TMPOUT],
    capture_output=True
)
if proc.returncode != 0 or not os.path.exists(TMPOUT):
    sys.stdout.write(json.dumps({'error':'no cover art'})+'\\n'); sys.exit(0)

size = os.path.getsize(TMPOUT)
r    = api('create','&contentType=image/jpeg',method='POST')
uid  = r['uploadId']
with open(TMPOUT,'rb') as f:
    data = f.read()
r = api('part','&uploadId='+r['uploadId']+'&partNumber=1',method='PUT',data=data,ct='application/octet-stream')
api('complete','&uploadId='+uid,method='POST',data=json.dumps([{'partNumber':1,'etag':r['etag']}]).encode(),ct='application/json')
if os.path.exists(TMPOUT): os.unlink(TMPOUT)
sys.stdout.write(json.dumps({'done':True})+'\\n')
`;
  const pyB64 = Buffer.from(py).toString('base64');
  return new Promise((resolve) => { // best-effort, never throw
    const conn = new SSH2Client();
    conn.on('ready', () => {
      conn.exec(`echo '${pyB64}' | base64 -d | python3`, (err, stream) => {
        if (err) { conn.end(); return resolve(false); }
        let ok = false;
        stream.stdout.on('data', d => { try { if (JSON.parse(d.toString()).done) ok = true; } catch {} });
        stream.stderr.on('data', () => {});
        stream.on('close', () => { conn.end(); resolve(ok); });
      });
    });
    conn.on('error', () => resolve(false));
    conn.connect({ host: SFTP_HOST, port: SFTP_PORT, username: QB_USER, password: QB_PASS });
  });
}
