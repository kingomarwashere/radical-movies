import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import {
  seedboxConfigured, addTorrent, waitForTorrent, deleteTorrent,
  getSeedboxSavePath, deleteSeedboxDir,
  findAudioFiles, probeAudioMeta, convertAudioOnSeedbox, extractCoverArtOnSeedbox,
} from './seedbox.js';
import { getStreamUrl } from './r2.js';
import { getUsers, updateUser } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const base = (f) => process.env.DATA_DIR ? path.join(process.env.DATA_DIR, f) : path.join(__dirname, '..', f);
const SETTINGS_FILE = base('settings.json');
const MUSIC_FILE    = base('music.json');

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s)); } catch {}
}
export function getSetting(key, def = null) { return loadSettings()[key] ?? def; }
export function setSetting(key, val)        { const s = loadSettings(); s[key] = val; saveSettings(s); }

// ── Music catalog ─────────────────────────────────────────────────────────────
function loadCatalog() {
  try {
    if (!fs.existsSync(MUSIC_FILE)) return [];
    return JSON.parse(fs.readFileSync(MUSIC_FILE, 'utf8'));
  } catch { return []; }
}
function saveCatalog(c) {
  try { fs.writeFileSync(MUSIC_FILE, JSON.stringify(c)); } catch {}
}

// ── Util ──────────────────────────────────────────────────────────────────────
function slugify(str) {
  return (str || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
export async function runMusicPipeline(albumId) {
  const UPLOAD_URL    = process.env.UPLOAD_URL    || process.env.R2_STREAM_URL;
  const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

  function patch(update) {
    const catalog = loadCatalog();
    const a = catalog.find(x => x.id === albumId);
    if (a) { Object.assign(a, update); saveCatalog(catalog); }
    return a;
  }

  const album = loadCatalog().find(a => a.id === albumId);
  if (!album) throw new Error('Album not found');

  patch({ status: 'searching', message: 'Adding torrent to seedbox…' });
  const sbPath = getSeedboxSavePath(`music-${albumId}`);
  const hash   = await addTorrent(album.torrentSource, sbPath);
  patch({ status: 'downloading', message: 'Downloading…' });

  await waitForTorrent(hash, ({ progress, speed }) => {
    patch({ status: 'downloading', message: `Downloading ${progress}% @ ${speed}` });
  });

  deleteTorrent(hash, false).catch(() => {});

  patch({ message: 'Scanning audio files…' });
  const audioFiles = await findAudioFiles(`music-${albumId}`, hash);
  if (!audioFiles.length) throw new Error('No audio files found in torrent');

  console.log(`[music] found ${audioFiles.length} audio files for ${album.album}`);

  // Extract cover art from first file if admin didn't provide one
  let coverUrl = album.coverUrl || null;
  if (!coverUrl) {
    patch({ message: 'Extracting cover art…' });
    const coverKey = `music/${albumId}/cover.jpg`;
    const ok = await extractCoverArtOnSeedbox(audioFiles[0].path, UPLOAD_URL, UPLOAD_SECRET, coverKey);
    if (ok) {
      coverUrl = getStreamUrl(coverKey);
      patch({ coverUrl });
    }
  }

  // Process each audio file
  // If we have pre-fetched iTunes tracks, use them (more reliable than file tags).
  // Match by position (audio files are sorted by filename which usually includes track number).
  const prefetched = album.tracks || [];
  const tracks = [];

  for (let i = 0; i < audioFiles.length; i++) {
    const file   = audioFiles[i];
    const itunes = prefetched[i] || null;
    patch({ message: `Processing ${i + 1}/${audioFiles.length}: ${itunes?.title || file.name}` });

    let disc, track, title, duration;
    if (itunes) {
      disc = itunes.disc || 1; track = itunes.n || (i + 1);
      title = itunes.title; duration = itunes.duration || 0;
    } else {
      const meta = await probeAudioMeta(file.path);
      disc = meta.disc || 1; track = meta.track || (i + 1);
      title = meta.title || path.basename(file.name, path.extname(file.name));
      duration = meta.duration || 0;
    }

    const r2Key = `music/${albumId}/${disc}-${String(track).padStart(2,'0')}-${slugify(title)}.mp3`;
    await convertAudioOnSeedbox(
      file.path, file.size, UPLOAD_URL, UPLOAD_SECRET, r2Key,
      (pct) => patch({ message: `Track ${i + 1}/${audioFiles.length} — ${pct}%` })
    );

    tracks.push({ n: track, disc, title, duration, url: getStreamUrl(r2Key) });
    console.log(`[music] ✓ ${disc}-${track} ${title}`);
  }

  // Sort tracks by disc then track number
  tracks.sort((a, b) => a.disc - b.disc || a.n - b.n);

  patch({
    status:   'ready',
    message:  null,
    coverUrl,
    tracks,
    artist:   album.artist || tracks[0]?.artist || 'Unknown Artist',
  });

  deleteSeedboxDir(sbPath).catch(() => {});
  console.log(`[music] album ready: ${album.artist} — ${album.album} (${tracks.length} tracks)`);
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function musicRoutes(app, { requireAuth }) {
  // Public: check if this user has music access
  app.get('/api/music/enabled', requireAuth, (req, res) => {
    const u = getUsers().find(x => x.username === req.username);
    res.json({ enabled: !!u?.musicEnabled });
  });

  // Public: catalog — only for users with music access
  app.get('/api/music/catalog', requireAuth, (req, res) => {
    const u = getUsers().find(x => x.username === req.username);
    if (!u?.musicEnabled) return res.json([]);
    res.json(loadCatalog().filter(a => a.status === 'ready'));
  });

  // Admin: toggle music for a specific user
  app.patch('/api/admin/user/:username/music', requireAuth, (req, res) => {
    const users = getUsers();
    const u = users.find(x => x.username === req.params.username);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const next = !u.musicEnabled;
    updateUser(req.params.username, { musicEnabled: next });
    res.json({ ok: true, musicEnabled: next });
  });

  // Admin: all albums including pipeline status
  app.get('/api/admin/music/albums', (req, res) => res.json(loadCatalog()));

  // Admin: add album + kick off pipeline
  app.post('/api/admin/music/album', async (req, res) => {
    const { artist, album, year, torrentSource, coverUrl, tracks: prefetchedTracks, itunesId } = req.body || {};
    if (!artist || !album) return res.status(400).json({ error: 'artist and album required' });

    const albumId = randomUUID();
    const catalog = loadCatalog();
    catalog.push({
      id:              albumId,
      artist:          artist.trim(),
      album:           album.trim(),
      year:            year ? parseInt(year) : null,
      coverUrl:        coverUrl?.trim() || null,
      torrentSource:   torrentSource?.trim() || null,
      tracks:          prefetchedTracks || [],  // iTunes tracks stored immediately
      itunesId:        itunesId || null,
      status:          torrentSource ? 'pending' : 'empty',
      message:         null,
      createdAt:       Date.now(),
    });
    saveCatalog(catalog);
    res.json({ ok: true, albumId });

    if (torrentSource && seedboxConfigured) {
      runMusicPipeline(albumId).catch(e => {
        console.error(`[music] pipeline error for ${albumId}:`, e.message);
        const c = loadCatalog();
        const a = c.find(x => x.id === albumId);
        if (a) { a.status = 'error'; a.message = e.message; saveCatalog(c); }
      });
    }
  });

  // Admin: delete album
  app.delete('/api/admin/music/album/:id', (req, res) => {
    saveCatalog(loadCatalog().filter(a => a.id !== req.params.id));
    res.json({ ok: true });
  });

  // Admin: retry failed album
  app.post('/api/admin/music/album/:id/retry', (req, res) => {
    const catalog = loadCatalog();
    const album   = catalog.find(a => a.id === req.params.id);
    if (!album) return res.status(404).json({ error: 'Not found' });
    album.status  = 'pending';
    album.message = null;
    saveCatalog(catalog);
    res.json({ ok: true });
    runMusicPipeline(req.params.id).catch(e => {
      const c = loadCatalog();
      const a = c.find(x => x.id === req.params.id);
      if (a) { a.status = 'error'; a.message = e.message; saveCatalog(c); }
    });
  });
}
