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
import { downloadTorrent, DOWNLOADS_DIR } from './torrent.js';
import { isFfmpegAvailable, transcodeToMP4, fastStartMP4, getExt, needsTranscode } from './transcoder.js';
import { uploadToR2, getStreamUrl, r2Configured, deleteFromR2 } from './r2.js';

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
    console.error(`[pipeline] job ${jobId} failed:`, err.message);
    const j = jobs.get(jobId);
    if (j) {
      j.status = 'error';
      j.error = err.message;
      j.message = `Error: ${err.message}`;
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

  // 1. Search
  emit({ status: 'searching', message: 'Searching YTS…' });
  let torrent = await searchYTS(job.title, job.year).catch(e => { console.error('[yts]', e.message); return null; });

  if (!torrent) {
    emit({ message: 'Not on YTS — trying The Pirate Bay…' });
    torrent = await searchTPB(job.title, job.year).catch(e => { console.error('[tpb]', e.message); return null; });
  }

  console.log(`[pipeline] search result for "${job.title}":`, torrent ? `${torrent.quality} via ${torrent.source}` : 'NOT FOUND');
  if (!torrent) throw new Error(`No 720p/1080p torrent found for "${job.title}"`);

  emit({
    status: 'downloading',
    message: `Found ${torrent.quality} via ${torrent.source.toUpperCase()} (${torrent.size}, ${torrent.seeds} seeds) — starting download…`,
    quality: torrent.quality,
    size: torrent.size,
    seeds: torrent.seeds,
  });

  // 2. Download — prefer .torrent file URL (avoids UDP tracker issues), fall back to magnet
  const downloadSource = torrent.torrentUrl || torrent.magnet;
  console.log(`[pipeline] using source: ${torrent.torrentUrl ? '.torrent file' : 'magnet'}`);
  await new Promise((resolve, reject) => {
    downloadTorrent(downloadSource, jobId, {
      onProgress: (p) => emit({ status: 'downloading', ...p }),
      onDone: (rawPath) => {
        job._rawPath = rawPath;
        resolve();
      },
      onError: reject,
    });
  });

  emit({ status: 'processing', progress: 100, message: 'Processing video file…' });

  // 3. Process / transcode only if needed
  const rawPath = job._rawPath;
  let finalPath = rawPath;
  const ffmpegOk = await isFfmpegAvailable().catch(() => false);

  if (ffmpegOk) {
    const outPath = rawPath.replace(/\.[^.]+$/, '_web.mp4');
    if (needsTranscode(rawPath)) {
      // MKV, AVI, etc — transcode to MP4 (stream-copy video first, re-encode audio)
      emit({ message: 'Transcoding to web MP4…' });
      finalPath = await transcodeToMP4(rawPath, outPath);
    } else if (getExt(rawPath) === '.mp4') {
      // Already MP4 — just add faststart moov atom for instant browser streaming
      emit({ message: 'Optimising MP4 for streaming…' });
      finalPath = await fastStartMP4(rawPath, outPath);
    }
  } else if (needsTranscode(rawPath)) {
    console.warn('[warn] ffmpeg not found — serving original file (may not play in browser)');
  }

  job.localPath = finalPath;

  // 4. Upload to R2 (optional)
  let streamUrl = `/api/stream/${jobId}`;

  if (r2Configured) {
    emit({ status: 'uploading', progress: 0, message: 'Uploading to Cloudflare R2…' });
    const key = `movies/${jobId}/${path.basename(finalPath)}`;
    await uploadToR2(finalPath, key, (pct) => {
      emit({ status: 'uploading', progress: pct, message: `Uploading to R2… ${pct}%` });
    });
    streamUrl = getStreamUrl(key);
    fs.unlink(finalPath, () => {});
  }

  // 5. Done
  job.status = 'ready';
  job.streamUrl = streamUrl;
  io.to(jobId).emit('job:ready', { jobId, streamUrl, title: job.title });
  io.to(jobId).emit('job:update', sanitize(job));
}

// ── Boot ───────────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
  console.log(`\n🎬  Radical Movies → http://localhost:${PORT}\n`);
  const ffmpegOk = await isFfmpegAvailable().catch(() => false);
  if (!ffmpegOk) console.warn('  ⚠  ffmpeg not found — install with: brew install ffmpeg');
  if (!r2Configured) console.warn('  ⚠  R2 not configured — videos served from local storage');
  if (!process.env.TMDB_API_KEY) console.warn('  ⚠  TMDB_API_KEY missing — movie metadata will fail');
});
