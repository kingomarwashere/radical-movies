import { randomUUID } from 'crypto';
import * as tmdb from './tmdb.js';

let _jobs, _runPipeline, _saveJobs;
let _syncing = false;

export function initCatalog({ jobs, runPipeline, saveJobs }) {
  _jobs = jobs;
  _runPipeline = runPipeline;
  _saveJobs = saveJobs;
}

export function getCatalogItems() {
  const items = [];
  for (const j of _jobs.values()) {
    if (j.catalog && j.status === 'ready' && j.streamUrl) {
      items.push({
        id: j.id,
        tmdbId: j.tmdbId,
        title: j.title,
        showTitle: j.showTitle,
        year: j.year,
        type: j.type,
        season: j.season,
        episode: j.episode,
        streamUrl: j.streamUrl,
        catalogSource: j.catalogSource,
        posterPath: j.posterPath,
      });
    }
  }
  return items;
}

export function getCatalogStats() {
  let ready = 0, active = 0, failed = 0;
  for (const j of _jobs.values()) {
    if (!j.catalog) continue;
    if (j.status === 'ready') ready++;
    else if (j.status === 'error') failed++;
    else active++;
  }
  return { ready, active, failed, total: ready + active + failed };
}

async function fetchPages(fn, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await fn(p);
      all.push(...(res.results ?? []));
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.warn(`[catalog] page ${p} failed:`, e.message);
    }
  }
  return all;
}

async function pLimit(tasks, concurrency = 5) {
  const q = [...tasks];
  const run = async () => {
    while (q.length) {
      const t = q.shift();
      try { await t(); } catch (e) { console.error('[catalog] task error:', e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, run));
}

function findCatalogJob(tmdbId, type, season, episode) {
  for (const j of _jobs.values()) {
    if (!j.catalog) continue;
    if (j.tmdbId !== tmdbId || j.type !== type) continue;
    if (type === 'tv' && (j.season !== season || j.episode !== episode)) continue;
    return j;
  }
  return null;
}

function makeMovieTask(movie, source) {
  return async () => {
    const { id: tmdbId, title, release_date, poster_path } = movie;
    const year = release_date?.slice(0, 4);

    const existing = findCatalogJob(tmdbId, 'movie');
    if (existing) {
      if (existing.status === 'error') {
        _jobs.delete(existing.id); // delete and retry
      } else {
        return; // in progress or ready
      }
    }

    // Tag any existing ready non-catalog job rather than re-downloading
    for (const j of _jobs.values()) {
      if (j.tmdbId === tmdbId && j.type === 'movie' && j.status === 'ready' && j.streamUrl) {
        j.catalog = true;
        j.catalogSource = source;
        j.posterPath = j.posterPath || poster_path;
        _saveJobs();
        return;
      }
    }

    const jobId = randomUUID();
    _jobs.set(jobId, {
      id: jobId, tmdbId, title, year,
      type: 'movie',
      user: 'system',
      catalog: true,
      catalogSource: source,
      posterPath: poster_path,
      status: 'searching', progress: 0,
      message: 'Catalog: searching…',
      streamUrl: null, localPath: null, error: null,
      createdAt: Date.now(),
    });

    try {
      await _runPipeline(jobId);
    } catch (err) {
      const j = _jobs.get(jobId);
      if (j && j.status !== 'error') {
        j.status = 'error';
        j.error = err.message;
        j.message = `Catalog error: ${err.message}`;
        _saveJobs();
      }
    }
  };
}

function makeTVTask(show) {
  return async () => {
    const { id: tmdbId, name: showTitle, first_air_date, poster_path } = show;
    const year = first_air_date?.slice(0, 4);

    const existing = findCatalogJob(tmdbId, 'tv', 1, 1);
    if (existing) {
      if (existing.status === 'error') {
        _jobs.delete(existing.id);
      } else {
        return;
      }
    }

    // Tag existing ready S01E01 job
    for (const j of _jobs.values()) {
      if (j.tmdbId === tmdbId && j.type === 'tv' && j.season === 1 && j.episode === 1 && j.status === 'ready' && j.streamUrl) {
        j.catalog = true;
        j.catalogSource = 'popular_tv';
        j.posterPath = j.posterPath || poster_path;
        _saveJobs();
        return;
      }
    }

    let epTitle = '';
    try {
      const s1 = await tmdb.getTVSeason(tmdbId, 1);
      epTitle = s1.episodes?.[0]?.name || '';
    } catch {}

    const title = `${showTitle} S01E01${epTitle ? ' — ' + epTitle : ''}`;
    const jobId = randomUUID();
    _jobs.set(jobId, {
      id: jobId, tmdbId, title, year,
      type: 'tv',
      season: 1, episode: 1,
      showTitle,
      user: 'system',
      catalog: true,
      catalogSource: 'popular_tv',
      posterPath: poster_path,
      status: 'searching', progress: 0,
      message: 'Catalog: searching…',
      streamUrl: null, localPath: null, error: null,
      createdAt: Date.now(),
    });

    try {
      await _runPipeline(jobId);
    } catch (err) {
      const j = _jobs.get(jobId);
      if (j && j.status !== 'error') {
        j.status = 'error';
        j.error = err.message;
        j.message = `Catalog error: ${err.message}`;
        _saveJobs();
      }
    }
  };
}

export async function syncCatalog() {
  if (_syncing) { console.log('[catalog] sync already running, skipping'); return; }
  _syncing = true;

  try {
    console.log('[catalog] fetching lists from TMDB…');
    const [popularMovies, topRatedMovies, popularTV] = await Promise.all([
      fetchPages(tmdb.getPopular, 5),
      fetchPages(tmdb.getTopRated, 5),
      fetchPages(tmdb.getTVPopular, 5),
    ]);

    // Dedupe movies — popular first, then top-rated extras
    const seen = new Set();
    const movies = [
      ...popularMovies.map(m => ({ ...m, _src: 'popular_movies' })),
      ...topRatedMovies.map(m => ({ ...m, _src: 'top_rated_movies' })),
    ].filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });

    const shows = popularTV.slice(0, 100);

    console.log(`[catalog] queuing ${movies.length} movies, ${shows.length} TV shows (S01E01)`);

    const tasks = [
      ...movies.map(m => makeMovieTask(m, m._src)),
      ...shows.map(s => makeTVTask(s)),
    ];

    await pLimit(tasks, 2);
    console.log('[catalog] sync complete');
  } catch (e) {
    console.error('[catalog] sync failed:', e.message);
  } finally {
    _syncing = false;
  }
}
