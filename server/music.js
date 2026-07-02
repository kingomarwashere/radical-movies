import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import {
  seedboxConfigured, addTorrent, waitForTorrent, seedUntilDone,
  getSeedboxSavePath,
  findAudioFiles, probeAudioMeta, convertAudioOnSeedbox, extractCoverArtOnSeedbox,
} from './seedbox.js';
import { getStreamUrl, UPLOAD_URL, UPLOAD_SECRET } from './r2.js';
import { getUsers, updateUser } from './auth.js';
import { searchTLMusic } from './torrentleech.js';
import { searchTPBMusic } from './piratebay.js';

function cleanAlbumForSearch(album) {
  return album
    .replace(/\s*[-–]\s*(Single|EP)$/i, '')
    .replace(/\s*\((Expanded|Deluxe|Super Deluxe|Anniversary|Remaster(ed)?|Re-?issue|Special|Collector'?s?|Bonus Track[s]?)[^)]*\)/gi, '')
    .replace(/[*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findMusicTorrent(artist, album) {
  const searchAlbum = cleanAlbumForSearch(album);
  console.log(`[music] searching torrent: "${artist} — ${searchAlbum}"${searchAlbum !== album ? ` (cleaned from "${album}")` : ''}`);
  const result =
    await searchTLMusic(artist, searchAlbum).catch(e => { console.error('[tl-music]', e.message); return null; }) ||
    await searchTPBMusic(artist, searchAlbum).catch(e => { console.error('[tpb-music]', e.message); return null; });
  if (!result) throw new Error(`No torrent found for "${artist} — ${album}"`);
  console.log(`[music] torrent found via ${result.source}: ${result.title} (${result.quality}, ${result.seeds} seeds)`);
  return result;
}

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
export async function runMusicPipeline(albumId, _io = null) {
  const uploadUrl    = `${UPLOAD_URL}/upload`;
  const uploadSecret = UPLOAD_SECRET;

  function patch(update) {
    const catalog = loadCatalog();
    const a = catalog.find(x => x.id === albumId);
    if (a) {
      Object.assign(a, update);
      saveCatalog(catalog);
      _io?.to(`music:${albumId}`).emit('music:update', { ...a, ...update });
    }
    return a;
  }

  const album = loadCatalog().find(a => a.id === albumId);
  if (!album) throw new Error('Album not found');

  // Auto-find torrent if not provided by admin
  // 'auto' is a marker meaning "was auto-found last time" — not a real source, re-search on retry
  let torrentSource = album.torrentSource === 'auto' ? null : album.torrentSource;
  if (!torrentSource) {
    patch({ status: 'searching', message: `Searching for "${album.artist} — ${album.album}"…` });
    const torrent = await findMusicTorrent(album.artist, album.album);
    torrentSource = torrent.torrentBuf || torrent.magnet;
    patch({ torrentSource: 'auto', message: `Found via ${torrent.source} (${torrent.quality}) — downloading…` });
  }

  patch({ status: 'searching', message: 'Adding torrent to seedbox…' });
  const sbPath = getSeedboxSavePath(`music-${albumId}`);
  const hash   = await addTorrent(torrentSource, sbPath);
  patch({ status: 'downloading', message: 'Downloading…' });

  await waitForTorrent(hash, ({ progress, speed }) => {
    patch({ status: 'downloading', progress, message: `Downloading ${progress}% @ ${speed}` });
  }, 90 * 60 * 1000);

  patch({ message: 'Scanning audio files…' });
  const audioFiles = await findAudioFiles(`music-${albumId}`, hash);
  if (!audioFiles.length) throw new Error('No audio files found in torrent');

  console.log(`[music] found ${audioFiles.length} audio files for ${album.album}`);

  // Extract cover art from first file if admin didn't provide one
  let coverUrl = album.coverUrl || null;
  if (!coverUrl) {
    patch({ message: 'Extracting cover art…' });
    const coverKey = `music/${albumId}/cover.jpg`;
    const ok = await extractCoverArtOnSeedbox(audioFiles[0].path, uploadUrl, uploadSecret, coverKey);
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
      file.path, file.size, uploadUrl, uploadSecret, r2Key,
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

  // Seed until ratio ≥ 1.0 or 24h before deleting — fires in background
  seedUntilDone(hash, `${album.artist} — ${album.album}`).catch(() => {});
  console.log(`[music] album ready: ${album.artist} — ${album.album} (${tracks.length} tracks)`);
}

// ── Routes ────────────────────────────────────────────────────────────────────
export function musicRoutes(app, { requireAuth, io }) {
  // Public: check if this user has music access
  app.get('/api/music/enabled', requireAuth, (req, res) => {
    const u = getUsers().find(x => x.username === req.username);
    res.json({ enabled: !!u?.musicEnabled });
  });

  // Public: full catalog for users with music access (includes in-progress)
  app.get('/api/music/catalog', requireAuth, (req, res) => {
    const u = getUsers().find(x => x.username === req.username);
    if (!u?.musicEnabled) return res.json([]);
    res.json(loadCatalog().filter(a => a.status !== 'empty'));
  });

  // User: request an album (like /api/watch for movies)
  app.post('/api/music/request', requireAuth, async (req, res) => {
    const u = getUsers().find(x => x.username === req.username);
    if (!u?.musicEnabled) return res.status(403).json({ error: 'Music access not enabled for your account' });

    const { itunesId, artist, album, year, coverUrl, tracks } = req.body || {};
    if (!artist || !album) return res.status(400).json({ error: 'artist and album required' });

    // Dedup by itunesId or artist+album
    const catalog = loadCatalog();
    const existing = catalog.find(a =>
      (itunesId && a.itunesId === itunesId) ||
      (a.artist?.toLowerCase() === artist.toLowerCase() && a.album?.toLowerCase() === album.toLowerCase())
    );

    if (existing) {
      if (existing.status === 'ready') return res.json({ albumId: existing.id, status: 'ready' });
      return res.json({ albumId: existing.id, status: existing.status, message: existing.message });
    }

    const albumId = randomUUID();
    catalog.push({
      id: albumId, artist: artist.trim(), album: album.trim(),
      year: year ? parseInt(year) : null, coverUrl: coverUrl || null,
      tracks: tracks || [], itunesId: itunesId || null,
      torrentSource: null, status: 'searching', message: 'Queued',
      requestedBy: req.username, createdAt: Date.now(),
    });
    saveCatalog(catalog);
    res.json({ albumId, status: 'searching' });

    runMusicPipeline(albumId, io).catch(e => {
      console.error(`[music] pipeline error ${albumId}:`, e.message);
      const c = loadCatalog();
      const a = c.find(x => x.id === albumId);
      if (a) { a.status = 'error'; a.message = e.message; saveCatalog(c); }
      io?.to(`music:${albumId}`).emit('music:update', { id: albumId, status: 'error', message: e.message });
    });
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
