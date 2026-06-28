const IMG = 'https://image.tmdb.org/t/p';
const POSTER = (p) => p ? `${IMG}/w342${p}` : '/no-poster.svg';
const BACKDROP = (b) => b ? `${IMG}/w1280${b}` : '';

// TMDB direct browser calls (bypasses server IP restrictions)
const TMDB_KEY = '0330d4c885535dbcbfc3a1085e098571';
const TMDB = 'https://api.themoviedb.org/3';
const tmdbHeaders = {
  Authorization: `Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiIwMzMwZDRjODg1NTM1ZGJjYmZjM2ExMDg1ZTA5ODU3MSIsIm5iZiI6MTc4MjU3NzkzNC45MTgwMDAyLCJzdWIiOiI2YTNmZmIwZTg5YzkzZGQwNzY5ZjNmOWIiLCJzY29wZXMiOlsiYXBpX3JlYWQiXSwidmVyc2lvbiI6MX0.t2IbUYP_18EI_9IxzPLhVDP7jUCKTTBeRXbZmFFfOgQ`,
};

async function tmdb(path, params = {}) {
  const url = new URL(`${TMDB}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: tmdbHeaders });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

// ── State ──────────────────────────────────────────────────────────────────
let heroMovies = [];
let heroIdx = 0;
let heroTimer = null;
let currentJobId = null;
let countdownInterval = null;
let socket = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const heroBg       = $('heroBg');
const heroTitle    = $('heroTitle');
const heroMeta     = $('heroMeta');
const heroDesc     = $('heroDesc');
const heroWatch    = $('heroWatch');
const heroInfo     = $('heroInfo');
const searchInput  = $('searchInput');
const searchClear  = $('searchClear');
const searchResults = $('searchResults');
const searchGrid   = $('searchGrid');
const searchHeading = $('searchHeading');
const rows         = $('rows');
const modalWrap    = $('modalWrap');
const modalBackdrop = $('modalBackdrop');
const modalClose   = $('modalClose');
const modalHero    = $('modalHero');
const modalTitle   = $('modalTitle');
const modalMeta    = $('modalMeta');
const modalOverview = $('modalOverview');
const modalRight   = $('modalRight');
const modalActions = $('modalActions');
const modalWatch   = $('modalWatch');
const modalSimilar = $('modalSimilar');
const fetchOverlay = $('fetchOverlay');
const fetchClose   = $('fetchClose');
const fetchTitle   = $('fetchTitle');
const ringFill     = $('ringFill');
const countdownTime = $('countdownTime');
const fetchStatus  = $('fetchStatus');
const progressWrap = $('progressWrap');
const progressFill = $('progressFill');
const progressInfo = $('progressInfo');
const playerOverlay = $('playerOverlay');
const playerClose  = $('playerClose');
const playerTitle  = $('playerTitle');
const videoEl      = $('videoEl');

// ── Socket setup ───────────────────────────────────────────────────────────
function initSocket() {
  // Polling only — WebSocket doesn't proxy through the Cloudflare Worker
  socket = io({ transports: ['polling'] });

  // Re-join on reconnect so we get the latest job state if we missed events
  socket.on('connect', () => {
    if (currentJobId) socket.emit('watch:join', currentJobId);
  });

  socket.on('job:update', (job) => {
    if (job.id !== currentJobId) return;
    updateFetchUI(job);
    // Recover if we missed the job:ready event (e.g. reconnect after upload completed)
    if (job.status === 'ready' && job.streamUrl) openPlayer(job.streamUrl, job.title);
  });

  socket.on('job:ready', ({ jobId, streamUrl, title }) => {
    if (jobId !== currentJobId) return;
    openPlayer(streamUrl, title);
  });

  socket.on('job:error', ({ jobId, error }) => {
    if (jobId !== currentJobId) return;
    stopCountdown();
    fetchOverlay.hidden = true;
    toast(`Error: ${error}`);
  });
}

// ── API helpers ────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  initSocket();
  setupNav();
  setupSearch();
  loadAll();
}

async function loadAll() {
  const [trending, popular, topRated, nowPlaying, action, scifi, drama, comedy] =
    await Promise.allSettled([
      tmdb('/trending/movie/week'),
      tmdb('/movie/popular'),
      tmdb('/movie/top_rated'),
      tmdb('/movie/now_playing'),
      tmdb('/discover/movie', { with_genres: 28, sort_by: 'popularity.desc' }),
      tmdb('/discover/movie', { with_genres: 878, sort_by: 'popularity.desc' }),
      tmdb('/discover/movie', { with_genres: 18, sort_by: 'popularity.desc' }),
      tmdb('/discover/movie', { with_genres: 35, sort_by: 'popularity.desc' }),
    ]);

  const get = (r) => (r.status === 'fulfilled' ? r.value.results ?? [] : []);

  const trendingMovies = get(trending);
  heroMovies = trendingMovies.slice(0, 8);
  renderHero(heroMovies[0]);
  startHeroRotation();

  renderRow('rowTrending', trendingMovies);
  renderRow('rowPopular', get(popular));
  renderRow('rowTopRated', get(topRated));
  renderRow('rowNowPlaying', get(nowPlaying));
  renderRow('rowAction', get(action));
  renderRow('rowScifi', get(scifi));
  renderRow('rowDrama', get(drama));
  renderRow('rowComedy', get(comedy));
}

// ── Hero ───────────────────────────────────────────────────────────────────
function renderHero(m) {
  if (!m) return;
  heroBg.style.backgroundImage = BACKDROP(m.backdrop_path) ? `url(${BACKDROP(m.backdrop_path)})` : '';
  heroTitle.textContent = m.title || m.name || '';
  heroMeta.innerHTML = [
    m.release_date ? `<span>${m.release_date.slice(0, 4)}</span>` : '',
    m.vote_average ? `<span>⭐ ${m.vote_average.toFixed(1)}</span>` : '',
    m.original_language ? `<span>${m.original_language.toUpperCase()}</span>` : '',
  ].filter(Boolean).join('');
  heroDesc.textContent = m.overview || '';
  heroWatch.onclick = () => startWatch(m);
  heroInfo.onclick = () => openModal(m.id);
}

function startHeroRotation() {
  clearInterval(heroTimer);
  heroTimer = setInterval(() => {
    heroIdx = (heroIdx + 1) % heroMovies.length;
    renderHero(heroMovies[heroIdx]);
  }, 8000);
}

// ── Row rendering ──────────────────────────────────────────────────────────
function renderRow(trackId, movies) {
  const track = $(trackId);
  if (!track) return;
  track.innerHTML = '';

  for (const m of movies.slice(0, 20)) {
    track.appendChild(createCard(m));
  }
}

function createCard(m) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <img class="card-img" src="${POSTER(m.poster_path)}" alt="${escHtml(m.title || '')}" loading="lazy">
    <div class="card-info">
      <div class="card-title">${escHtml(m.title || m.name || '')}</div>
      <div class="card-meta">
        ${m.release_date ? `<span>${m.release_date.slice(0,4)}</span>` : ''}
        ${m.vote_average ? `<span class="card-rating">★ ${m.vote_average.toFixed(1)}</span>` : ''}
      </div>
    </div>
  `;
  card.addEventListener('click', () => openModal(m.id));
  return card;
}

// ── Modal ──────────────────────────────────────────────────────────────────
let currentMovie = null;

async function openModal(tmdbId) {
  try {
    const m = await tmdb(`/movie/${tmdbId}`, { append_to_response: 'credits,videos,similar' });
    currentMovie = m;

    modalHero.style.backgroundImage = BACKDROP(m.backdrop_path)
      ? `url(${BACKDROP(m.backdrop_path)})`
      : '';

    modalTitle.textContent = m.title || '';

    const year = m.release_date?.slice(0, 4) ?? '';
    const runtime = m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : '';
    const genres = (m.genres ?? []).map(g => `<span class="meta-tag">${g.name}</span>`).join('');
    const rating = m.vote_average ? `<span class="meta-tag meta-rating">★ ${m.vote_average.toFixed(1)}</span>` : '';

    modalMeta.innerHTML = [
      year ? `<span>${year}</span>` : '',
      runtime ? `<span>${runtime}</span>` : '',
      rating,
      '<span class="meta-tag meta-quality">720p / 1080p</span>',
      genres,
    ].filter(Boolean).join('');

    modalOverview.textContent = m.overview || '';

    const director = m.credits?.crew?.find(c => c.job === 'Director');
    const cast = (m.credits?.crew ? m.credits.crew.slice(0,5) : []);
    const topCast = (m.credits?.cast ?? []).slice(0, 5).map(a => a.name).join(', ');

    modalRight.innerHTML = [
      director ? `<div><strong>Director:</strong> ${escHtml(director.name)}</div>` : '',
      topCast ? `<div><strong>Cast:</strong> ${escHtml(topCast)}</div>` : '',
      m.original_language ? `<div><strong>Language:</strong> ${m.original_language.toUpperCase()}</div>` : '',
      m.status ? `<div><strong>Status:</strong> ${escHtml(m.status)}</div>` : '',
    ].filter(Boolean).join('');

    // Similar movies
    const similar = (m.similar?.results ?? []).slice(0, 12);
    if (similar.length) {
      const simRow = document.createElement('div');
      simRow.className = 'similar-row';
      similar.forEach(s => simRow.appendChild(createCard(s)));
      modalSimilar.innerHTML = '<h3>More Like This</h3>';
      modalSimilar.appendChild(simRow);
    } else {
      modalSimilar.innerHTML = '';
    }

    modalWatch.onclick = () => startWatch(m);
    modalWrap.hidden = false;
    document.body.style.overflow = 'hidden';
  } catch (e) {
    toast('Failed to load movie details');
  }
}

function closeModal() {
  modalWrap.hidden = true;
  document.body.style.overflow = '';
  currentMovie = null;
}

modalClose.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', closeModal);

// ── Watch / Download ───────────────────────────────────────────────────────
async function startWatch(movie) {
  closeModal();

  const title = movie.title || movie.name || '';
  const year = movie.release_date?.slice(0, 4) ?? '';

  fetchTitle.textContent = title;
  fetchOverlay.hidden = false;
  document.body.style.overflow = 'hidden';

  setFetchStatus('Initialising…');
  progressWrap.hidden = true;
  progressFill.style.width = '0%';
  startCountdown(360);

  try {
    const { jobId } = await fetch('/api/watch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: movie.id, title, year }),
    }).then(r => r.json());

    currentJobId = jobId;
    socket.emit('watch:join', jobId);
  } catch (e) {
    stopCountdown();
    fetchOverlay.hidden = true;
    document.body.style.overflow = '';
    toast('Failed to start download');
  }
}

fetchClose.addEventListener('click', () => {
  stopCountdown();
  fetchOverlay.hidden = true;
  document.body.style.overflow = '';
  currentJobId = null;
});

// ── Countdown ──────────────────────────────────────────────────────────────
const CIRCUMFERENCE = 2 * Math.PI * 54; // ~339.3

function startCountdown(seconds) {
  stopCountdown();
  let remaining = seconds;
  ringFill.style.strokeDashoffset = '0';
  updateCountdownDisplay(remaining, seconds);

  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      remaining = 0;
      clearInterval(countdownInterval);
      setFetchStatus('Still working… please wait a moment longer.');
    }
    updateCountdownDisplay(remaining, seconds);
  }, 1000);
}

function stopCountdown() {
  clearInterval(countdownInterval);
  countdownInterval = null;
}

function updateCountdownDisplay(remaining, total) {
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  countdownTime.textContent = `${mins}:${String(secs).padStart(2, '0')}`;

  // Stroke offset: 0 = full ring, CIRCUMFERENCE = empty
  const pct = remaining / total;
  ringFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - pct));
}

function setFetchStatus(msg) {
  fetchStatus.textContent = msg;
}

function updateFetchUI(job) {
  setFetchStatus(job.message || job.status);

  if (job.status === 'downloading' && job.progress > 0) {
    progressWrap.hidden = false;
    progressFill.style.width = `${job.progress}%`;

    const dlMB = job.downloaded ? (job.downloaded / 1e6).toFixed(0) : 0;
    const totMB = job.total ? (job.total / 1e6).toFixed(0) : 0;
    const etaStr = job.eta ? fmtEta(job.eta) : '';
    progressInfo.innerHTML = `
      <span>${job.progress}% · ${job.speed ?? ''}</span>
      <span>${dlMB} / ${totMB} MB ${etaStr ? '· ' + etaStr : ''}</span>
    `;
  }
}

function fmtEta(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

// ── Player ─────────────────────────────────────────────────────────────────
function openPlayer(streamUrl, title) {
  stopCountdown();
  fetchOverlay.hidden = true;
  document.body.style.overflow = 'hidden';

  playerTitle.textContent = title || '';
  videoEl.src = streamUrl;
  playerOverlay.hidden = false;
  videoEl.play().catch(() => {});
}

playerClose.addEventListener('click', () => {
  videoEl.pause();
  videoEl.src = '';
  playerOverlay.hidden = true;
  document.body.style.overflow = '';
  currentJobId = null;
});

// ── Search ─────────────────────────────────────────────────────────────────
function setupSearch() {
  let debounce;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.hidden = !q;
    clearTimeout(debounce);
    if (!q) { showRows(); return; }
    debounce = setTimeout(() => doSearch(q), 400);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    showRows();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!playerOverlay.hidden) {
        videoEl.pause();
        videoEl.src = '';
        playerOverlay.hidden = true;
        document.body.style.overflow = '';
        return;
      }
      if (!fetchOverlay.hidden) {
        stopCountdown();
        fetchOverlay.hidden = true;
        document.body.style.overflow = '';
        return;
      }
      if (!modalWrap.hidden) { closeModal(); return; }
    }
  });
}

async function doSearch(q) {
  searchHeading.textContent = `Results for "${q}"`;
  searchResults.hidden = false;
  rows.hidden = true;
  searchGrid.innerHTML = '';

  try {
    const data = await tmdb('/search/movie', { query: q });
    const movies = data.results ?? [];
    if (!movies.length) {
      searchGrid.innerHTML = '<p style="color:#777;padding:20px 0">No results found.</p>';
      return;
    }
    for (const m of movies.slice(0, 30)) searchGrid.appendChild(createCard(m));
  } catch {
    searchGrid.innerHTML = '<p style="color:#777;padding:20px 0">Search failed.</p>';
  }
}

function showRows() {
  searchResults.hidden = true;
  rows.hidden = false;
}

// ── Nav ────────────────────────────────────────────────────────────────────
function setupNav() {
  window.addEventListener('scroll', () => {
    document.querySelector('.nav').classList.toggle('scrolled', window.scrollY > 20);
  });

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────
function toast(msg, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ── Util ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Go ─────────────────────────────────────────────────────────────────────
init();
