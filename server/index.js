import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { statfs } from 'fs/promises';
import { fileURLToPath } from 'url';
import os from 'os';
import { spawn } from 'child_process';

import * as tmdb from './tmdb.js';
import { searchYTS } from './yts.js';
import { searchTPB } from './piratebay.js';
import { searchTL } from './torrentleech.js';
import { downloadTorrent, DOWNLOADS_DIR } from './torrent.js';
import {
  seedboxConfigured, addTorrent, waitForTorrent, deleteTorrent,
  pullFileViaSftp, findVideoFile, getSeedboxSavePath, parallelSftpToR2, transcodeAudioAndUploadToR2,
} from './seedbox.js';
import { isFfmpegAvailable, transcodeToMP4, fastStartMP4, getExt, needsTranscode } from './transcoder.js';
import { uploadToR2, getStreamUrl, r2Configured, deleteFromR2, UPLOAD_URL, UPLOAD_SECRET } from './r2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  transports: ['polling'],
  pingTimeout: 120000,  // 2 min — keeps connection alive through long R2 uploads
  pingInterval: 10000,
});
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// In-memory stores
const jobs          = new Map(); // jobId → job
const activeStreams  = new Map(); // streamId → { jobId, title, ip, startedAt, bytesSent }

// ── Job persistence ─────────────────────────────────────────────────────────
const JOBS_FILE = path.join(__dirname, '..', 'jobs.json');

function saveJobs() {
  const out = {};
  for (const [id, job] of jobs) {
    if (job.status === 'ready' || job.status === 'error') out[id] = sanitize(job);
  }
  try { fs.writeFileSync(JOBS_FILE, JSON.stringify(out)); } catch {}
}

(function loadJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const [id, job] of Object.entries(saved)) jobs.set(id, job);
    console.log(`[jobs] restored ${Object.keys(saved).length} jobs from disk`);
  } catch (e) { console.error('[jobs] load failed:', e.message); }
})();

// ── TMDB routes ────────────────────────────────────────────────────────────
const wrap = (fn) => (req, res) =>
  fn(req).then(d => res.json(d)).catch(e => res.status(500).json({ error: e.message }));

app.get('/api/movies/trending', wrap(() => tmdb.getTrending()));
app.get('/api/movies/popular', wrap((req) => tmdb.getPopular(req.query.page)));
app.get('/api/movies/top-rated', wrap((req) => tmdb.getTopRated(req.query.page)));
app.get('/api/movies/now-playing', wrap(() => tmdb.getNowPlaying()));
app.get('/api/movies/genre/:id', wrap((req) => tmdb.getByGenre(req.params.id, req.query.page)));
app.get('/api/movies/search', wrap((req) => tmdb.search(req.query.q, req.query.page)));
app.get('/api/movies/:id', wrap((req) => tmdb.getMovie(req.params.id)));

// ── Watch — start download pipeline ───────────────────────────────────────
app.post('/api/watch', async (req, res) => {
  const { tmdbId, title, year } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  // Dedup: return existing job if we already have this movie
  for (const [id, job] of jobs) {
    const match = (tmdbId && job.tmdbId === tmdbId) ||
                  (job.title?.toLowerCase() === title?.toLowerCase() && String(job.year) === String(year));
    if (!match) continue;
    if (job.status === 'ready' && job.streamUrl) {
      console.log(`[pipeline] serving cached: ${title} (${year})`);
      return res.json({ jobId: id, streamUrl: job.streamUrl, ready: true });
    }
    if (['searching', 'downloading', 'uploading'].includes(job.status)) {
      console.log(`[pipeline] reusing in-progress job: ${id}`);
      return res.json({ jobId: id });
    }
  }

  const jobId = randomUUID();
  jobs.set(jobId, {
    id: jobId, tmdbId, title, year,
    status: 'searching', progress: 0,
    speed: null, eta: null, message: 'Searching for torrent…',
    streamUrl: null, localPath: null, error: null,
    createdAt: Date.now(),
  });

  res.json({ jobId });

  // Fire pipeline without awaiting
  runPipeline(jobId).catch(err => {
    const msg = err?.message ?? String(err) ?? 'Unknown error';
    console.error(`[pipeline] job ${jobId} failed:`, msg);
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'error';
      j.error = msg;
      j.message = `Error: ${msg}`;
      saveJobs();
    }
    io.to(jobId).emit('job:error', { jobId, error: err.message });
    io.to(jobId).emit('job:update', j ? sanitize(j) : { id: jobId, status: 'error', error: err.message });
    broadcastAdmin();
  });
});

// ── Job status ─────────────────────────────────────────────────────────────
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// ── Local video streaming with range support ───────────────────────────────
app.get('/api/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.localPath || !fs.existsSync(job.localPath))
    return res.status(404).json({ error: 'not ready' });

  const filePath = job.localPath;
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  // Track this stream
  const streamId = randomUUID();
  const streamEntry = {
    id: streamId,
    jobId: job.id,
    title: job.title,
    ip: req.headers['x-forwarded-for']?.split(',')[0] ?? req.socket.remoteAddress ?? '?',
    startedAt: Date.now(),
    bytesSent: 0,
    size: total,
  };
  activeStreams.set(streamId, streamEntry);
  broadcastAdmin();

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');

  let stream;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : total - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    stream = fs.createReadStream(filePath, { start, end });
  } else {
    res.setHeader('Content-Length', total);
    res.writeHead(200);
    stream = fs.createReadStream(filePath);
  }

  stream.on('data', (chunk) => { streamEntry.bytesSent += chunk.length; });
  stream.pipe(res);

  res.on('close', () => {
    activeStreams.delete(streamId);
    broadcastAdmin();
  });
});

// ── Admin API ──────────────────────────────────────────────────────────────
app.get('/api/admin/stats', async (req, res) => res.json(await buildAdminStats()));

app.delete('/api/admin/job/:jobId', (req, res) => {
  const id = req.params.jobId;
  const job = jobs.get(id);
  if (!job) return res.status(404).json({ error: 'not found' });
  // Clean up local file if present
  if (job.localPath && fs.existsSync(job.localPath)) fs.unlink(job.localPath, () => {});
  jobs.delete(id);
  saveJobs();
  broadcastAdmin();
  res.json({ ok: true });
});

// SSE log tail — streams the last 100 lines then follows live
app.get('/api/admin/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (line) => res.write(`data: ${line}\n\n`);

  // Intercept console methods and forward to SSE
  const origLog   = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);

  const hook = (prefix, orig) => (...args) => {
    orig(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    send(`${prefix} ${msg}`);
  };

  console.log   = hook('[LOG]',   origLog);
  console.error = hook('[ERR]',   origError);
  console.warn  = hook('[WARN]',  origWarn);

  send('[connected to log stream]');

  req.on('close', () => {
    console.log   = origLog;
    console.error = origError;
    console.warn  = origWarn;
    res.end();
  });
});

app.post('/api/admin/cleanup-disk', (req, res) => {
  cleanOldDownloads();
  res.json({ ok: true });
});

app.delete('/api/admin/jobs/completed', (req, res) => {
  for (const [id, job] of jobs) {
    if (job.status === 'ready' || job.status === 'error') {
      if (job.localPath && fs.existsSync(job.localPath)) fs.unlink(job.localPath, () => {});
      jobs.delete(id);
    }
  }
  broadcastAdmin();
  res.json({ ok: true });
});

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('watch:join', (jobId) => {
    socket.join(jobId);
    const job = jobs.get(jobId);
    if (job) socket.emit('job:update', sanitize(job));
    if (job?.status === 'ready') socket.emit('job:ready', { jobId, streamUrl: job.streamUrl, title: job.title });
  });

  socket.on('admin:join', async () => {
    socket.join('admin');
    socket.emit('admin:stats', await buildAdminStats());
  });
});

// ── Admin helpers ──────────────────────────────────────────────────────────
async function buildAdminStats() {
  let disk = { free: null, total: null };
  try {
    const s = await statfs(DOWNLOADS_DIR);
    disk = {
      free:  Math.round(s.bfree  * s.bsize / 1e9 * 10) / 10,
      total: Math.round(s.blocks * s.bsize / 1e9 * 10) / 10,
      used:  Math.round((s.blocks - s.bfree) * s.bsize / 1e9 * 10) / 10,
    };
  } catch {}

  const jobList = [...jobs.values()].map(sanitize).sort((a, b) => b.createdAt - a.createdAt);
  const streams = [...activeStreams.values()];

  return {
    jobs: jobList,
    streams,
    disk,
    server: {
      uptime:   Math.floor(process.uptime()),
      memUsed:  Math.round(process.memoryUsage().rss / 1e6),
      r2:       r2Configured,
      ffmpeg:   await isFfmpegAvailable().catch(() => false),
    },
  };
}

async function broadcastAdmin() {
  const stats = await buildAdminStats();
  io.to('admin').emit('admin:stats', stats);
}

function sanitize(job) {
  const { _rawPath, ...safe } = job;
  return safe;
}

// ── Download pipeline ──────────────────────────────────────────────────────
async function runPipeline(jobId) {
  const job = jobs.get(jobId);

  const emit = (patch) => {
    Object.assign(job, patch);
    io.to(jobId).emit('job:update', sanitize({ ...job, ...patch }));
    broadcastAdmin();
  };

  // 1. Search — TorrentLeech first (private, high seeds), then YTS, then TPB
  emit({ status: 'searching', message: 'Searching TorrentLeech…' });
  let torrent = await searchTL(job.title, job.year).catch(e => { console.error('[tl]', e.message); return null; });

  if (!torrent) {
    emit({ message: 'Not on TL — trying YTS…' });
    torrent = await searchYTS(job.title, job.year).catch(e => { console.error('[yts]', e.message); return null; });
  }

  if (!torrent) {
    emit({ message: 'Not on YTS — trying The Pirate Bay…' });
    torrent = await searchTPB(job.title, job.year).catch(e => { console.error('[tpb]', e.message); return null; });
  }

  console.log(`[pipeline] search result for "${job.title}":`, torrent ? `${torrent.quality} via ${torrent.source}` : 'NOT FOUND');
  if (!torrent) throw new Error(`No torrent found for "${job.title}"`);

  emit({
    status: 'downloading',
    message: `Found ${torrent.quality} via ${torrent.source.toUpperCase()} (${torrent.size}, ${torrent.seeds} seeds) — starting download…`,
    quality: torrent.quality,
    size: torrent.size,
    seeds: torrent.seeds,
  });

  // 2. Download — seedbox (10Gbps) preferred, WebTorrent fallback
  const downloadSource = torrent.torrentBuf || torrent.torrentUrl || torrent.magnet;

  if (seedboxConfigured) {
    console.log(`[pipeline] using seedbox for job ${jobId}`);
    emit({ message: '⚡ Sending to seedbox (10Gbps)…' });

    const sbSavePath = getSeedboxSavePath(jobId);
    const torrentHash = await addTorrent(downloadSource, sbSavePath);
    console.log(`[seedbox] torrent added, hash: ${torrentHash}, save path: ${sbSavePath}`);

    const completed = await waitForTorrent(torrentHash, (p) => {
      emit({ status: 'downloading', ...p, message: `Seedbox: ${p.progress}% @ ${p.speed}` });
    });

    // Scan the seedbox save dir to find the actual video file (avoids content_path quirks)
    job.downloadedAt = Date.now(); // ← seedbox download complete
    emit({ status: 'downloading', progress: 100, message: 'Locating video file on seedbox…' });
    const { path: remoteVideoPath, size: remoteFileSize } = await findVideoFile(jobId, torrentHash);

    if (r2Configured) {
      const remoteExt = path.extname(remoteVideoPath).toLowerCase();
      const r2Key     = `movies/${jobId}/${path.basename(remoteVideoPath)}`;
      emit({ status: 'uploading', progress: 0, message: 'Uploading to R2…' });

      // MKV almost always has AC3/EAC3/DTS audio — transcode to AAC for browser compat.
      // MP4 files are usually already AAC so upload directly.
      if (remoteExt !== '.mp4') {
        await transcodeAudioAndUploadToR2(remoteVideoPath, remoteFileSize, `${UPLOAD_URL}/upload`, UPLOAD_SECRET, r2Key, (pct) => {
          emit({ status: 'uploading', progress: pct,
                 message: pct <= 50 ? `Reading from seedbox… ${pct * 2}%` : `Uploading to R2… ${(pct - 50) * 2}%` });
        });
      } else {
        await parallelSftpToR2(remoteVideoPath, remoteFileSize, `${UPLOAD_URL}/upload`, UPLOAD_SECRET, r2Key, remoteExt, (pct) => {
          emit({ status: 'uploading', progress: pct, message: `Uploading to R2… ${pct}%` });
        });
      }
      // deleteTorrent disabled for testing — re-enable when done
      // if (torrentHash) await deleteTorrent(torrentHash, true).catch(e => console.warn('[seedbox] delete failed:', e.message));
      job.status    = 'ready';
      job.readyAt   = Date.now(); // ← transcode+upload complete
      job.streamUrl = getStreamUrl(r2Key);
      saveJobs();
      io.to(jobId).emit('job:ready', { jobId, streamUrl: job.streamUrl, title: job.title });
      io.to(jobId).emit('job:update', sanitize(job));
      return;
    }

    // No R2 — pull to VM disk for local serving / transcoding
    const localJobDir = path.join(DOWNLOADS_DIR, jobId);
    fs.mkdirSync(localJobDir, { recursive: true });
    const localPath = path.join(localJobDir, path.basename(remoteVideoPath));

    emit({ status: 'downloading', progress: 100, message: 'Pulling from seedbox via SFTP…' });
    await pullFileViaSftp(remoteVideoPath, localPath, (pct) => {
      emit({ status: 'downloading', progress: pct, message: `Pulling from seedbox… ${pct}%` });
    });

    job._rawPath = localPath;

    // deleteTorrent disabled for testing
    // if (torrentHash) await deleteTorrent(torrentHash, true).catch(e => console.warn('[seedbox] delete failed:', e.message));

  } else {
    console.log(`[pipeline] using WebTorrent (no seedbox) for job ${jobId}`);
    await new Promise((resolve, reject) => {
      downloadTorrent(downloadSource, jobId, {
        onProgress: (p) => emit({ status: 'downloading', ...p }),
        onDone: (rawPath) => { job._rawPath = rawPath; resolve(); },
        onError: reject,
      });
    });
  }

  const rawPath = job._rawPath;
  const rawExt  = getExt(rawPath);
  let streamUrl = `/api/stream/${jobId}`;

  if (r2Configured) {
    // When R2 is configured: skip transcoding entirely — upload the raw file directly.
    // MKV (H.264) plays natively in Chrome, Firefox, Edge via the R2 streaming Worker
    // which handles byte-range requests. Transcoding doubles disk usage and isn't needed.
    emit({ status: 'uploading', progress: 0, message: `Uploading ${rawExt} to R2…` });
    const key = `movies/${jobId}/${path.basename(rawPath)}`;
    console.log(`[pipeline] uploading raw file to R2: ${key} (${rawExt})`);
    await uploadToR2(rawPath, key, rawExt, (pct) => {
      emit({ status: 'uploading', progress: pct, message: `Uploading to R2… ${pct}%` });
    });
    streamUrl = getStreamUrl(key);
    fs.unlink(rawPath, () => {});
    console.log('[pipeline] local file deleted after R2 upload');
  } else {
    // No R2 — serve locally. Transcode MKV→MP4 for browser compatibility.
    emit({ status: 'processing', progress: 100, message: 'Processing video…' });
    const ffmpegOk = await isFfmpegAvailable().catch(() => false);
    let finalPath = rawPath;

    if (ffmpegOk) {
      const outPath = rawPath.replace(/\.[^.]+$/, '_web.mp4');
      if (needsTranscode(rawPath)) {
        emit({ message: 'Transcoding to MP4 for local streaming…' });
        finalPath = await transcodeToMP4(rawPath, outPath);
        fs.unlink(rawPath, () => {}); // delete raw after transcode
      } else if (rawExt === '.mp4') {
        emit({ message: 'Optimising MP4…' });
        finalPath = await fastStartMP4(rawPath, outPath);
        fs.unlink(rawPath, () => {});
      }
    }
    job.localPath = finalPath;
  }

  // 5. Done
  job.status    = 'ready';
  job.readyAt   = Date.now();
  job.streamUrl = streamUrl;
  saveJobs();
  io.to(jobId).emit('job:ready', { jobId, streamUrl, title: job.title });
  io.to(jobId).emit('job:update', sanitize(job));
}

// ── Auto disk cleanup ──────────────────────────────────────────────────────
function cleanOldDownloads() {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  try {
    const entries = fs.readdirSync(DOWNLOADS_DIR);
    for (const entry of entries) {
      const p = path.join(DOWNLOADS_DIR, entry);
      const stat = fs.statSync(p);
      if (Date.now() - stat.mtimeMs > TWO_HOURS) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`[cleanup] deleted old download: ${entry}`);
      }
    }
  } catch (e) {
    console.warn('[cleanup] error:', e.message);
  }
}
// Run cleanup every 30 minutes
setInterval(cleanOldDownloads, 30 * 60 * 1000);

// ── Boot ───────────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
  console.log(`\n🎬  Radical Movies → http://localhost:${PORT}\n`);
  const ffmpegOk = await isFfmpegAvailable().catch(() => false);
  if (!ffmpegOk) console.warn('  ⚠  ffmpeg not found — install with: brew install ffmpeg');
  if (!r2Configured) console.warn('  ⚠  R2 not configured — videos served from local storage');
  if (!process.env.TMDB_API_KEY) console.warn('  ⚠  TMDB_API_KEY missing — movie metadata will fail');
});
