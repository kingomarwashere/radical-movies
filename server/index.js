import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import * as tmdb from './tmdb.js';
import { searchYTS } from './yts.js';
import { searchTPB } from './piratebay.js';
import { downloadTorrent, DOWNLOADS_DIR } from './torrent.js';
import { isFfmpegAvailable, transcodeToMP4, fastStartMP4, getExt } from './transcoder.js';
import { uploadToR2, getSignedStreamUrl, r2Configured } from './r2.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// In-memory job store
const jobs = new Map();

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
    const j = jobs.get(jobId);
    if (j) { j.status = 'error'; j.error = err.message; }
    io.to(jobId).emit('job:error', { jobId, error: err.message });
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

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(s, 10);
    const end = e ? parseInt(e, 10) : total - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', total);
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Socket.io ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('watch:join', (jobId) => {
    socket.join(jobId);
    const job = jobs.get(jobId);
    if (job) socket.emit('job:update', sanitize(job));
    if (job?.status === 'ready') socket.emit('job:ready', { jobId, streamUrl: job.streamUrl, title: job.title });
  });
});

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
  };

  // 1. Search
  emit({ status: 'searching', message: 'Searching YTS…' });
  let torrent = await searchYTS(job.title, job.year);

  if (!torrent) {
    emit({ message: 'Not on YTS — trying The Pirate Bay…' });
    torrent = await searchTPB(job.title, job.year);
  }

  if (!torrent) throw new Error('No 720p/1080p torrent found for this title');

  emit({
    status: 'downloading',
    message: `Found ${torrent.quality} via ${torrent.source.toUpperCase()} (${torrent.size}, ${torrent.seeds} seeds) — starting download…`,
    quality: torrent.quality,
    size: torrent.size,
    seeds: torrent.seeds,
  });

  // 2. Download
  await new Promise((resolve, reject) => {
    downloadTorrent(torrent.magnet, jobId, {
      onProgress: (p) => emit({ status: 'downloading', ...p }),
      onDone: (rawPath) => {
        job._rawPath = rawPath;
        resolve();
      },
      onError: reject,
    });
  });

  emit({ status: 'processing', progress: 100, message: 'Processing video file…' });

  // 3. Transcode if needed
  const rawPath = job._rawPath;
  let finalPath = rawPath;
  const ext = getExt(rawPath);
  const ffmpegOk = await isFfmpegAvailable().catch(() => false);

  if (ffmpegOk) {
    const outPath = rawPath.replace(/\.[^.]+$/, '_web.mp4');
    emit({ message: ext === '.mp4' ? 'Optimising MP4 for streaming…' : 'Transcoding to MP4…' });
    finalPath = ext === '.mp4'
      ? await fastStartMP4(rawPath, outPath)
      : await transcodeToMP4(rawPath, outPath);
  } else if (ext !== '.mp4') {
    console.warn('[warn] ffmpeg not found — serving original file (may not play in browser)');
  }

  job.localPath = finalPath;

  // 4. Upload to R2 (optional)
  let streamUrl = `/api/stream/${jobId}`;

  if (r2Configured) {
    emit({ status: 'uploading', message: 'Uploading to Cloudflare R2…' });
    const key = `movies/${jobId}/${path.basename(finalPath)}`;
    await uploadToR2(finalPath, key);
    const signed = await getSignedStreamUrl(key);
    if (signed) streamUrl = signed;
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
