import WebTorrent from 'webtorrent';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Disable DHT + uTP — both use UDP which is blocked on most VPS providers
// Rely entirely on HTTP trackers for peer discovery
const client = new WebTorrent({ dht: false, utp: false });

// Single client-level error handler — don't re-register per download
client.on('error', (err) => {
  console.error('[webtorrent] client error:', err.message);
});

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);

export async function downloadTorrent(magnetOrUrl, jobId, { onProgress, onDone, onError }) {
  const jobDir = path.join(DOWNLOADS_DIR, jobId);
  try {
    fs.mkdirSync(jobDir, { recursive: true });
  } catch (e) {
    console.error('[torrent] mkdir failed:', e.message);
    onError(`Disk error: ${e.message}`);
    return;
  }

  // If given a .torrent URL, fetch the file first — avoids UDP tracker dependency
  let source = magnetOrUrl;
  if (magnetOrUrl.startsWith('http') && !magnetOrUrl.startsWith('magnet:')) {
    try {
      console.log(`[torrent] fetching .torrent file: ${magnetOrUrl}`);
      const res = await fetch(magnetOrUrl, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        source = Buffer.from(await res.arrayBuffer());
        console.log(`[torrent] .torrent file fetched (${source.length} bytes)`);
      } else {
        console.warn(`[torrent] .torrent fetch failed ${res.status} — falling back to magnet`);
      }
    } catch (e) {
      console.warn(`[torrent] .torrent fetch error: ${e.message} — falling back to magnet`);
    }
  }

  console.log(`[torrent] adding to client for job ${jobId}`);

  const torrent = client.add(source, { path: jobDir });

  torrent.on('error', (err) => {
    console.error(`[torrent] torrent error (${jobId}):`, err.message);
    onError(err.message);
  });

  torrent.on('warning', (warn) => {
    console.warn(`[torrent] warning (${jobId}):`, warn.message ?? warn);
  });

  torrent.on('ready', () => {
    console.log(`[torrent] ready (${jobId}): ${torrent.name} — ${torrent.files.length} files, ${(torrent.length / 1e9).toFixed(2)} GB`);
  });

  torrent.on('download', () => {
    onProgress({
      progress:   Math.floor((torrent.downloaded / torrent.length) * 100),
      speed:      `${(torrent.downloadSpeed / 1e6).toFixed(2)} MB/s`,
      eta:        torrent.timeRemaining ? Math.ceil(torrent.timeRemaining / 1000) : null,
      downloaded: torrent.downloaded,
      total:      torrent.length,
    });
  });

  torrent.on('done', () => {
    const videoFile = torrent.files
      .filter(f => VIDEO_EXTS.has(path.extname(f.name).toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];

    if (!videoFile) {
      const names = torrent.files.map(f => f.name).join(', ');
      console.error(`[torrent] no video file found. files: ${names}`);
      onError(`No video file found in torrent (got: ${names})`);
      torrent.destroy();
      return;
    }

    console.log(`[torrent] done (${jobId}): ${videoFile.name}`);
    onDone(path.join(jobDir, videoFile.path));
    torrent.destroy();
  });
}
