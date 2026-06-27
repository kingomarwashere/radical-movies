import WebTorrent from 'webtorrent';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const client = new WebTorrent();

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v']);

export function downloadTorrent(magnetLink, jobId, { onProgress, onDone, onError }) {
  const jobDir = path.join(DOWNLOADS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  client.add(magnetLink, { path: jobDir }, (torrent) => {
    torrent.on('download', () => {
      onProgress({
        progress: Math.floor((torrent.downloaded / torrent.length) * 100),
        speed: `${(torrent.downloadSpeed / 1e6).toFixed(2)} MB/s`,
        eta: torrent.timeRemaining ? Math.ceil(torrent.timeRemaining / 1000) : null,
        downloaded: torrent.downloaded,
        total: torrent.length,
      });
    });

    torrent.on('done', () => {
      const videoFile = torrent.files
        .filter(f => VIDEO_EXTS.has(path.extname(f.name).toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];

      if (!videoFile) {
        onError('No video file found in torrent');
        torrent.destroy();
        return;
      }

      onDone(path.join(jobDir, videoFile.path));
      torrent.destroy();
    });

    torrent.on('error', (err) => onError(err.message));
  });

  client.on('error', (err) => onError(err.message));
}
