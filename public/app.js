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
let socket = null;
let currentSection = 'home'; // 'home' | 'tv' | 'library'
let loggedInUser = null;
let libraryPollTimer = null;
let libraryData = [];
let catalogData = [];

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const heroBg         = $('heroBg');
const heroTitle      = $('heroTitle');
const heroMeta       = $('heroMeta');
const heroDesc       = $('heroDesc');
const heroWatch      = $('heroWatch');
const heroInfo       = $('heroInfo');
const searchInput    = $('searchInput');
const searchClear    = $('searchClear');
const searchResults  = $('searchResults');
const searchGrid     = $('searchGrid');
// searchHeading removed — search now shows Movies + TV sections separately
const heroEl         = $('hero');
const rows           = $('rows');
const tvRows         = $('tvRows');
const librarySection = $('librarySection');
const libraryGrid    = $('libraryGrid');
const libBadge       = $('libBadge');
const bottomBadge    = $('bottomBadge');
const navUsername    = $('navUsername');
const logoutBtn      = $('logoutBtn');
const modalWrap      = $('modalWrap');
const modalBackdrop  = $('modalBackdrop');
const modalClose     = $('modalClose');
const modalHero      = $('modalHero');
const modalTitle     = $('modalTitle');
const modalMeta      = $('modalMeta');
const modalOverview  = $('modalOverview');
const modalRight     = $('modalRight');
const modalActions   = $('modalActions');
const modalWatch     = $('modalWatch');
const modalSimilar   = $('modalSimilar');
const tvModalWrap    = $('tvModalWrap');
const tvModalBackdrop = $('tvModalBackdrop');
const tvModalClose   = $('tvModalClose');
const tvModalHero    = $('tvModalHero');
const tvModalTitle   = $('tvModalTitle');
const tvModalMeta    = $('tvModalMeta');
const tvModalOverview = $('tvModalOverview');
const tvModalRight   = $('tvModalRight');
const tvSeasons      = $('tvSeasons');
const tvModalSimilar = $('tvModalSimilar');
const fetchOverlay   = $('fetchOverlay');
const fetchClose     = $('fetchClose');
const fetchTitle     = $('fetchTitle');
const fetchStatus    = $('fetchStatus');
const progressWrap   = $('progressWrap');
const progressFill   = $('progressFill');
const progressInfo   = $('progressInfo');
const playerOverlay  = $('playerOverlay');
const playerClose    = $('playerClose');
const playerTitle    = $('playerTitle');
const videoEl        = $('videoEl');

// ── Socket setup ───────────────────────────────────────────────────────────
function initSocket() {
  socket = io({ transports: ['polling'] });

  socket.on('connect', () => {
    if (currentJobId) socket.emit('watch:join', currentJobId);
  });

  socket.on('job:update', (job) => {
    if (job.id !== currentJobId) return;
    updateFetchUI(job);
    if (job.status === 'ready' && job.streamUrl) openPlayer(job.streamUrl, job.title);
  });

  socket.on('job:ready', ({ jobId, streamUrl, title }) => {
    if (jobId !== currentJobId) return;
    openPlayer(streamUrl, title);
  });

  socket.on('job:error', ({ jobId, error }) => {
    if (jobId !== currentJobId) return;
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

// ── Auth ───────────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.status === 401) { location.href = '/login'; return; }
    const data = await res.json();
    loggedInUser = data.username;
    navUsername.textContent = loggedInUser;
    if (!data.paid) { location.href = '/upgrade'; return; }
    const expiresAt = data.inTrial ? data.trialEndsAt : data.accessExpiresAt;
    if (expiresAt && Date.now() < expiresAt) startExpiryBanner(expiresAt, data.inTrial ? 'trial' : 'access');
  } catch {
    location.href = '/login';
  }
}

function startExpiryBanner(endsAt, type) {
  const banner = $('trialBanner');
  const text   = $('trialText');
  if (!banner || !text) return;

  function update() {
    const ms = endsAt - Date.now();
    if (ms <= 0) { location.href = '/upgrade'; return; }
    const days = Math.floor(ms / 86400000);
    const h    = Math.floor((ms % 86400000) / 3600000);
    const m    = Math.floor((ms % 3600000) / 60000);
    const timeStr = days > 1 ? `${days}d ${h}h` : days === 1 ? `1d ${h}h` : `${h}h ${m}m`;
    const label   = type === 'trial' ? 'Free trial' : 'Access';
    text.textContent = `⏳ ${label} expires in ${timeStr}`;
    banner.hidden = false;
    document.body.classList.add('has-trial-banner');
  }

  update();
  setInterval(update, 60000);
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.href = '/login';
});

// ── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  await checkAuth();
  initSocket();
  setupNav();
  setupSearch();
  setupPlayerControls();
  startLibraryPolling();
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

  renderRow('rowTrending',   trendingMovies,  'movie');
  renderRow('rowPopular',    get(popular),    'movie');
  renderRow('rowTopRated',   get(topRated),   'movie');
  renderRow('rowNowPlaying', get(nowPlaying), 'movie');
  renderRow('rowAction',     get(action),     'movie');
  renderRow('rowScifi',      get(scifi),      'movie');
  renderRow('rowDrama',      get(drama),      'movie');
  renderRow('rowComedy',     get(comedy),     'movie');
}

async function loadTVRows() {
  if (tvRows.dataset.loaded) return;
  const [trending, popular, topRated] = await Promise.allSettled([
    tmdb('/trending/tv/week'),
    tmdb('/tv/popular'),
    tmdb('/tv/top_rated'),
  ]);
  const get = (r) => r.status === 'fulfilled' ? r.value.results ?? [] : [];
  renderRow('rowTVTrending', get(trending), 'tv');
  renderRow('rowTVPopular',  get(popular),  'tv');
  renderRow('rowTVTopRated', get(topRated), 'tv');
  tvRows.dataset.loaded = '1';
}

// ── Hero ───────────────────────────────────────────────────────────────────
function renderHero(m) {
  if (!m) return;
  heroBg.style.backgroundImage = BACKDROP(m.backdrop_path) ? `url(${BACKDROP(m.backdrop_path)})` : '';
  heroTitle.textContent = m.title || m.name || '';
  heroMeta.innerHTML = [
    m.release_date ? `<span>${m.release_date.slice(0, 4)}</span>` : '',
    m.vote_average ? `<span>&#9733; ${m.vote_average.toFixed(1)}</span>` : '',
    m.original_language ? `<span>${m.original_language.toUpperCase()}</span>` : '',
  ].filter(Boolean).join('');
  heroDesc.textContent = m.overview || '';
  const heroCatalog = catalogData.find(c => c.tmdbId === m.id && c.type === 'movie');
  const heroLib     = libraryData.find(j => j.tmdbId === m.id && j.type === 'movie' && j.status !== 'error');
  const heroReady   = heroCatalog?.streamUrl || (heroLib?.status === 'ready' && heroLib?.streamUrl);
  const heroStream  = heroCatalog?.streamUrl || heroLib?.streamUrl;
  const heroTitle2  = m.title || m.name || '';

  if (heroReady) {
    heroWatch.textContent = '▶  Watch Now';
    heroWatch.disabled    = false;
    heroWatch.onclick     = () => openPlayer(heroStream, heroTitle2);
  } else if (heroLib) {
    heroWatch.textContent = '✓ In Library';
    heroWatch.disabled    = true;
    heroWatch.onclick     = null;
  } else {
    heroWatch.textContent = '+ Add to Library';
    heroWatch.disabled    = false;
    heroWatch.onclick     = () => queueWatch(m);
  }
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
function renderRow(trackId, movies, type = 'movie') {
  const track = $(trackId);
  if (!track) return;
  track.innerHTML = '';
  for (const m of movies.slice(0, 20)) {
    track.appendChild(createCard(m, type));
  }
}

function createCard(m, type = 'movie') {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.tmdbId = m.id;
  card.dataset.mediaType = type;
  const displayTitle = m.title || m.name || '';
  const year = m.release_date?.slice(0, 4) || m.first_air_date?.slice(0, 4) || '';
  card.innerHTML = `
    <img class="card-img" src="${POSTER(m.poster_path)}" alt="${escHtml(displayTitle)}" loading="lazy">
    <div class="card-info">
      <div class="card-title">${escHtml(displayTitle)}</div>
      <div class="card-meta">
        ${year ? `<span>${year}</span>` : ''}
        ${m.vote_average ? `<span class="card-rating">&#9733; ${m.vote_average.toFixed(1)}</span>` : ''}
      </div>
    </div>
  `;
  card.addEventListener('click', () => {
    if (type === 'tv') openTVModal(m.id);
    else openModal(m.id);
  });
  return card;
}

function updateCardBadges() {
  document.querySelectorAll('.card[data-tmdb-id]').forEach(card => {
    // Skip catalog cards — they always show their own badge
    if (card.classList.contains('catalog-card')) return;

    const id   = parseInt(card.dataset.tmdbId);
    const type = card.dataset.mediaType || 'movie';
    const job  = libraryData.find(j => j.tmdbId === id && j.type === type && j.status !== 'error');
    const cat  = !job && catalogData.find(c => c.tmdbId === id && c.type === type);

    let badge = card.querySelector('.card-lib-tag');
    if (!job && !cat) { badge?.remove(); return; }
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'card-lib-tag';
      card.appendChild(badge);
    }
    if (cat) {
      badge.textContent = '▶ Ready'; badge.dataset.state = 'ready';
    } else if (job.status === 'ready') {
      badge.textContent = '▶ Ready'; badge.dataset.state = 'ready';
    } else if (job.status === 'downloading') {
      badge.textContent = `↓ ${job.progress ?? 0}%`; badge.dataset.state = 'active';
    } else if (job.status === 'uploading') {
      badge.textContent = `↑ ${job.progress ?? 0}%`; badge.dataset.state = 'active';
    } else {
      badge.textContent = '⌛'; badge.dataset.state = 'active';
    }
  });
}

// ── Movie Modal ────────────────────────────────────────────────────────────
let currentMovie = null;

async function openModal(tmdbId) {
  try {
    const m = await tmdb(`/movie/${tmdbId}`, { append_to_response: 'credits,videos,similar' });
    currentMovie = m;

    modalHero.style.backgroundImage = BACKDROP(m.backdrop_path)
      ? `url(${BACKDROP(m.backdrop_path)})`
      : '';

    modalTitle.textContent = m.title || '';

    const year    = m.release_date?.slice(0, 4) ?? '';
    const runtime = m.runtime ? `${Math.floor(m.runtime / 60)}h ${m.runtime % 60}m` : '';
    const genres  = (m.genres ?? []).map(g => `<span class="meta-tag">${g.name}</span>`).join('');
    const rating  = m.vote_average ? `<span class="meta-tag meta-rating">&#9733; ${m.vote_average.toFixed(1)}</span>` : '';

    modalMeta.innerHTML = [
      year    ? `<span>${year}</span>`    : '',
      runtime ? `<span>${runtime}</span>` : '',
      rating,
      '<span class="meta-tag meta-quality">720p / 1080p</span>',
      genres,
    ].filter(Boolean).join('');

    modalOverview.textContent = m.overview || '';

    const director = m.credits?.crew?.find(c => c.job === 'Director');
    const topCast  = (m.credits?.cast ?? []).slice(0, 5).map(a => a.name).join(', ');

    modalRight.innerHTML = [
      director ? `<div><strong>Director:</strong> ${escHtml(director.name)}</div>` : '',
      topCast  ? `<div><strong>Cast:</strong> ${escHtml(topCast)}</div>`           : '',
      m.original_language ? `<div><strong>Language:</strong> ${m.original_language.toUpperCase()}</div>` : '',
      m.status ? `<div><strong>Status:</strong> ${escHtml(m.status)}</div>`        : '',
    ].filter(Boolean).join('');

    const similar = (m.similar?.results ?? []).slice(0, 12);
    if (similar.length) {
      const simRow = document.createElement('div');
      simRow.className = 'similar-row';
      similar.forEach(s => simRow.appendChild(createCard(s, 'movie')));
      modalSimilar.innerHTML = '<h3>More Like This</h3>';
      modalSimilar.appendChild(simRow);
    } else {
      modalSimilar.innerHTML = '';
    }

    // Show correct button state — check catalog first, then personal library
    const catalogItem = catalogData.find(c => c.tmdbId === m.id && c.type === 'movie');
    const inLibrary   = libraryData.find(j => j.tmdbId === m.id && j.type === 'movie' && j.status !== 'error');

    if (catalogItem?.streamUrl) {
      modalWatch.textContent = '▶  Play Now';
      modalWatch.disabled = false;
      modalWatch.onclick = () => { closeModal(); openPlayer(catalogItem.streamUrl, m.title); };
    } else if (inLibrary?.status === 'ready') {
      modalWatch.textContent = '▶  Play';
      modalWatch.disabled = false;
      modalWatch.onclick = () => { closeModal(); openPlayer(inLibrary.streamUrl, m.title); };
    } else if (inLibrary) {
      modalWatch.textContent = '✓ In Library';
      modalWatch.disabled = true;
    } else {
      modalWatch.textContent = '+ Add to Library';
      modalWatch.disabled = false;
      modalWatch.onclick = () => queueWatch(m);
    }
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

// ── TV Show Modal ──────────────────────────────────────────────────────────
let currentShow = null;
let currentTVSeason = 1;

async function openTVModal(showId) {
  try {
    const show = await tmdb(`/tv/${showId}`, { append_to_response: 'credits,videos,similar' });
    currentShow = show;
    currentTVSeason = 1;

    tvModalHero.style.backgroundImage = BACKDROP(show.backdrop_path)
      ? `url(${BACKDROP(show.backdrop_path)})`
      : '';

    tvModalTitle.textContent = show.name || '';

    const year    = show.first_air_date?.slice(0, 4) ?? '';
    const seasons = show.number_of_seasons ? `${show.number_of_seasons} Season${show.number_of_seasons > 1 ? 's' : ''}` : '';
    const genres  = (show.genres ?? []).map(g => `<span class="meta-tag">${g.name}</span>`).join('');
    const rating  = show.vote_average ? `<span class="meta-tag meta-rating">&#9733; ${show.vote_average.toFixed(1)}</span>` : '';

    tvModalMeta.innerHTML = [
      year    ? `<span>${year}</span>`    : '',
      seasons ? `<span>${seasons}</span>` : '',
      rating,
      genres,
    ].filter(Boolean).join('');

    tvModalOverview.textContent = show.overview || '';

    const creator = show.created_by?.[0];
    const topCast = (show.credits?.cast ?? []).slice(0, 5).map(a => a.name).join(', ');
    tvModalRight.innerHTML = [
      creator  ? `<div><strong>Creator:</strong> ${escHtml(creator.name)}</div>` : '',
      topCast  ? `<div><strong>Cast:</strong> ${escHtml(topCast)}</div>`         : '',
      show.status   ? `<div><strong>Status:</strong> ${escHtml(show.status)}</div>` : '',
      show.networks?.length ? `<div><strong>Network:</strong> ${escHtml(show.networks[0].name)}</div>` : '',
    ].filter(Boolean).join('');

    // Similar shows
    const similar = (show.similar?.results ?? []).slice(0, 12);
    if (similar.length) {
      const simRow = document.createElement('div');
      simRow.className = 'similar-row';
      similar.forEach(s => simRow.appendChild(createCard(s, 'tv')));
      tvModalSimilar.innerHTML = '<h3>More Like This</h3>';
      tvModalSimilar.appendChild(simRow);
    } else {
      tvModalSimilar.innerHTML = '';
    }

    await renderSeasonTabs(show);

    tvModalWrap.hidden = false;
    document.body.style.overflow = 'hidden';
  } catch (e) {
    toast('Failed to load show details');
    console.error(e);
  }
}

async function renderSeasonTabs(show) {
  const regularSeasons = (show.seasons || []).filter(s => s.season_number > 0);
  if (!regularSeasons.length) { tvSeasons.innerHTML = ''; return; }

  let html = '<div class="season-tabs">';
  for (const s of regularSeasons) {
    html += `<button class="season-tab${s.season_number === currentTVSeason ? ' active' : ''}" data-season="${s.season_number}">Season ${s.season_number}</button>`;
  }
  html += '</div><div class="episode-list" id="episodeList"><div style="color:#777;padding:20px 0">Loading episodes…</div></div>';
  tvSeasons.innerHTML = html;

  tvSeasons.querySelectorAll('.season-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentTVSeason = parseInt(btn.dataset.season);
      tvSeasons.querySelectorAll('.season-tab').forEach(b => b.classList.toggle('active', b === btn));
      await loadEpisodes(show.id, show.name, show.first_air_date?.slice(0, 4), currentTVSeason);
    });
  });

  await loadEpisodes(show.id, show.name, show.first_air_date?.slice(0, 4), currentTVSeason);
}

async function loadEpisodes(showId, showTitle, showYear, season) {
  const list = $('episodeList');
  if (!list) return;
  list.innerHTML = '<div style="color:#777;padding:20px 0">Loading…</div>';
  try {
    const data = await tmdb(`/tv/${showId}/season/${season}`);
    const episodes = data.episodes || [];
    if (!episodes.length) {
      list.innerHTML = '<div style="color:#777;padding:20px 0">No episodes found.</div>';
      return;
    }

    list.innerHTML = '';
    for (const ep of episodes) {
      const s0 = String(season).padStart(2, '0');
      const e0 = String(ep.episode_number).padStart(2, '0');

      // Check if this episode is already in the catalog (ready to play)
      const catEp = catalogData.find(c =>
        c.tmdbId === showId && c.type === 'tv' &&
        c.season == season && c.episode == ep.episode_number
      );
      const btnLabel = catEp?.streamUrl ? '&#9654;' : '+';

      const epEl = document.createElement('div');
      epEl.className = 'episode-item';
      epEl.innerHTML = `
        <div class="episode-num">E${e0}</div>
        <div class="episode-info">
          <div class="episode-title">${escHtml(ep.name || '')}</div>
          <div class="episode-meta">${ep.air_date ? ep.air_date.slice(0, 4) : ''}${ep.runtime ? ' &middot; ' + ep.runtime + 'm' : ''}</div>
          ${ep.overview ? `<div class="episode-overview">${escHtml(ep.overview)}</div>` : ''}
        </div>
        <button class="episode-add-btn${catEp ? ' episode-ready-btn' : ''}" title="${catEp ? 'Play' : 'Add to library'}">${btnLabel}</button>
      `;
      epEl.querySelector('.episode-add-btn').addEventListener('click', (e) => {
        const btn = e.currentTarget;
        // Catalog item — play immediately
        const cat = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == season && c.episode == ep.episode_number);
        if (cat?.streamUrl) { openPlayer(cat.streamUrl, `${showTitle} S${s0}E${e0}`); return; }
        // Personal library check
        const alreadyIn = libraryData.find(j => j.tmdbId === showId && j.season == season && j.episode == ep.episode_number && j.status !== 'error');
        if (alreadyIn) {
          if (alreadyIn.status === 'ready' && alreadyIn.streamUrl) { openPlayer(alreadyIn.streamUrl, `${showTitle} S${s0}E${e0}`); }
          return;
        }
        queueEpisode(showTitle, showYear, showId, season, ep.episode_number, ep.name, btn);
      });
      list.appendChild(epEl);
    }
  } catch (e) {
    list.innerHTML = '<div style="color:#777;padding:20px 0">Failed to load episodes.</div>';
  }
}

function closeTVModal() {
  tvModalWrap.hidden = true;
  document.body.style.overflow = '';
  currentShow = null;
}

tvModalClose.addEventListener('click', closeTVModal);
tvModalBackdrop.addEventListener('click', closeTVModal);

// ── Watch / Queue ──────────────────────────────────────────────────────────
// Hero "Watch Now" — shows the blocking overlay and plays immediately if ready
async function startWatch(movie) {
  closeModal();
  const title = movie.title || movie.name || '';
  const year  = movie.release_date?.slice(0, 4) ?? '';

  fetchTitle.textContent = title;
  fetchOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
  setFetchStatus('Initialising…');
  progressWrap.hidden = true;
  progressFill.style.width = '0%';

  try {
    const res = await fetch('/api/watch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tmdbId: movie.id, title, year, type: 'movie' }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast(data.error || 'Failed to queue');
      fetchOverlay.hidden = true;
      document.body.style.overflow = '';
      return;
    }
    const { jobId, streamUrl, ready } = data;
    currentJobId = jobId;
    if (ready && streamUrl) { openPlayer(streamUrl, title); return; }
    socket.emit('watch:join', jobId);
  } catch {
    fetchOverlay.hidden = true;
    document.body.style.overflow = '';
    toast('Failed to start download');
  }
}

// Modal "Add to Library" — non-blocking, shows toast
async function queueWatch(movie) {
  const title = movie.title || movie.name || '';
  const year  = movie.release_date?.slice(0, 4) ?? '';

  // Optimistically update button immediately
  modalWatch.textContent = '⏳ Queuing…';
  modalWatch.disabled = true;

  try {
    const res = await fetch('/api/watch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tmdbId: movie.id, title, year, type: 'movie' }),
    });
    const data = await res.json();
    if (!res.ok) {
      modalWatch.textContent = '+ Add to Library';
      modalWatch.disabled = false;
      toast(data.error || 'Failed to queue');
      return;
    }

    const { jobId, streamUrl, ready } = data;
    if (ready && streamUrl) {
      closeModal();
      openPlayer(streamUrl, title);
      return;
    }

    currentJobId = jobId;
    socket.emit('watch:join', jobId);
    modalWatch.textContent = '✓ In Library';
    modalWatch.disabled = true;
    toast(`Added "${title}" to library`);
    fetchLibrary();
  } catch {
    modalWatch.textContent = '+ Add to Library';
    modalWatch.disabled = false;
    toast('Failed to queue download');
  }
}

async function queueEpisode(showTitle, showYear, showId, season, episode, epTitle, btn) {
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const jobTitle = `${showTitle} S${s}E${e}${epTitle ? ' — ' + epTitle : ''}`;

  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  try {
    const res = await fetch('/api/watch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'tv', title: jobTitle, showTitle, year: showYear, tmdbId: showId, season, episode }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (btn) { btn.textContent = '+'; btn.disabled = false; }
      toast(data.error || 'Failed to queue');
      return;
    }

    const { jobId, streamUrl, ready } = data;
    if (ready && streamUrl) { openPlayer(streamUrl, jobTitle); return; }

    currentJobId = jobId;
    socket.emit('watch:join', jobId);
    if (btn) { btn.textContent = '✓'; btn.title = 'In library'; }
    toast(`Queued: ${jobTitle}`);
    fetchLibrary();
  } catch {
    if (btn) { btn.textContent = '+'; btn.disabled = false; }
    toast('Failed to queue episode');
  }
}

fetchClose.addEventListener('click', () => {
    fetchOverlay.hidden = true;
  document.body.style.overflow = '';
  currentJobId = null;
});

function setFetchStatus(msg) { fetchStatus.textContent = msg; }

function updateFetchUI(job) {
  setFetchStatus(job.message || job.status);
  if (job.status === 'downloading' && job.progress > 0) {
    progressWrap.hidden = false;
    progressFill.style.width = `${job.progress}%`;
    const dlMB  = job.downloaded ? (job.downloaded / 1e6).toFixed(0) : 0;
    const totMB = job.total ? (job.total / 1e6).toFixed(0) : 0;
    const etaStr = job.eta ? fmtEta(job.eta) : '';
    progressInfo.innerHTML = `
      <span>${job.progress}% &middot; ${job.speed ?? ''}</span>
      <span>${dlMB} / ${totMB} MB ${etaStr ? '&middot; ' + etaStr : ''}</span>
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
const PLAY_ICON    = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const VOL_ICON     = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
const MUTED_ICON   = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
const FS_ICON      = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;
const EXIT_FS_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;

let _currentStreamId  = null;
let _playerTogglePlay = null;
let _playerToggleFs   = null;
let _playerToggleMute = null;

function openPlayer(streamUrl, title) {
  fetchOverlay.hidden = true;
  document.body.style.overflow = 'hidden';
  playerTitle.textContent = title || '';
  videoEl.src = streamUrl;
  playerOverlay.hidden = false;
  $('playerUi').classList.add('visible');
  videoEl.play().catch(() => {});
  _currentStreamId = Math.random().toString(36).slice(2);
  socket.emit('stream:start', { streamId: _currentStreamId, title, streamUrl, jobId: currentJobId });
  // Hide overlapping UI
  $('trialBanner').hidden = true;
  window.Tawk_API?.hideWidget?.();
}

function closePlayer() {
  if (document.fullscreenElement) document.exitFullscreen();
  videoEl.pause();
  videoEl.src = '';
  playerOverlay.hidden = true;
  document.body.style.overflow = '';
  if (_currentStreamId) { socket.emit('stream:end', { streamId: _currentStreamId }); _currentStreamId = null; }
  currentJobId = null;
  // Restore overlapping UI
  const banner = $('trialBanner');
  if (banner && document.body.classList.contains('has-trial-banner')) banner.hidden = false;
  window.Tawk_API?.showWidget?.();
}

function setupPlayerControls() {
  const playerUi    = $('playerUi');
  const playBtn     = $('playerPlayBtn');
  const muteBtn     = $('playerMuteBtn');
  const volSlider   = $('playerVolSlider');
  const timeDisplay = $('playerTimeDisplay');
  const scrubber    = $('playerScrubber');
  const bufferedBar = $('playerBufferedBar');
  const seekLeft    = $('playerSeekLeft');
  const handle      = $('playerHandle');
  const tooltip     = $('playerTooltip');
  const fsBtn       = $('playerFsBtn');
  const spinner     = $('playerSpinner');
  const centerIcon  = $('playerCenterIcon');

  let hideTimer  = null;
  let isSeeking  = false;
  let wasPlaying = false;

  playBtn.innerHTML = PLAY_ICON;
  muteBtn.innerHTML = VOL_ICON;
  fsBtn.innerHTML   = FS_ICON;

  // ── Auto-hide controls ───────────────────────────────────────────────────
  function showControls() {
    playerUi.classList.add('visible');
    playerOverlay.style.cursor = '';
    clearTimeout(hideTimer);
    if (!videoEl.paused) {
      hideTimer = setTimeout(() => {
        playerUi.classList.remove('visible');
        playerOverlay.style.cursor = 'none';
      }, 3000);
    }
  }

  playerOverlay.addEventListener('mousemove', showControls);
  playerOverlay.addEventListener('mouseleave', () => {
    if (!videoEl.paused) {
      clearTimeout(hideTimer);
      playerUi.classList.remove('visible');
      playerOverlay.style.cursor = 'none';
    }
  });

  // Click video area to toggle play/pause
  playerOverlay.addEventListener('click', (e) => {
    if (e.target.closest('.player-top') || e.target.closest('.player-bottom')) return;
    showControls();
    _playerTogglePlay();
  });

  // ── Play / Pause ─────────────────────────────────────────────────────────
  _playerTogglePlay = () => {
    if (videoEl.paused) { videoEl.play().catch(() => {}); flashCenter(PLAY_ICON); }
    else                { videoEl.pause();                flashCenter(PAUSE_ICON); }
    showControls();
  };
  playBtn.addEventListener('click', _playerTogglePlay);
  playerClose.addEventListener('click', closePlayer);

  videoEl.addEventListener('play', () => { playBtn.innerHTML = PAUSE_ICON; showControls(); });
  videoEl.addEventListener('pause', () => {
    playBtn.innerHTML = PLAY_ICON;
    clearTimeout(hideTimer);
    playerUi.classList.add('visible');
    playerOverlay.style.cursor = '';
  });

  // ── Center flash icon ─────────────────────────────────────────────────────
  function flashCenter(svg) {
    centerIcon.innerHTML = svg;
    centerIcon.classList.remove('flash');
    void centerIcon.offsetWidth;
    centerIcon.classList.add('flash');
  }

  // ── Volume / Mute ─────────────────────────────────────────────────────────
  function syncVolIcon() {
    muteBtn.innerHTML = (videoEl.muted || videoEl.volume === 0) ? MUTED_ICON : VOL_ICON;
  }
  _playerToggleMute = () => { videoEl.muted = !videoEl.muted; syncVolIcon(); };
  muteBtn.addEventListener('click', _playerToggleMute);
  volSlider.addEventListener('input', () => {
    videoEl.volume = parseFloat(volSlider.value);
    videoEl.muted  = videoEl.volume === 0;
    syncVolIcon();
  });
  videoEl.addEventListener('volumechange', () => { volSlider.value = videoEl.volume; syncVolIcon(); });

  // ── Time & scrubber ───────────────────────────────────────────────────────
  function fmt(s) {
    if (!isFinite(s)) return '0:00';
    const h  = Math.floor(s / 3600);
    const m  = Math.floor((s % 3600) / 60);
    const sc = Math.floor(s % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`
      : `${m}:${String(sc).padStart(2,'0')}`;
  }

  videoEl.addEventListener('timeupdate', () => {
    if (!isSeeking) {
      const pct = videoEl.duration ? (videoEl.currentTime / videoEl.duration) * 100 : 0;
      seekLeft.style.width    = `${pct}%`;
      handle.style.left       = `${pct}%`;
      timeDisplay.textContent = `${fmt(videoEl.currentTime)} / ${fmt(videoEl.duration)}`;
    }
    syncBuffered();
  });
  videoEl.addEventListener('progress', syncBuffered);

  function syncBuffered() {
    if (!videoEl.duration) return;
    let end = 0;
    for (let i = 0; i < videoEl.buffered.length; i++) {
      if (videoEl.buffered.start(i) <= videoEl.currentTime + 1)
        end = Math.max(end, videoEl.buffered.end(i));
    }
    bufferedBar.style.width = `${(end / videoEl.duration) * 100}%`;
  }

  // ── Scrubber drag ─────────────────────────────────────────────────────────
  function getSeekPct(e) {
    const r = scrubber.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }

  scrubber.addEventListener('mousemove', (e) => {
    const r   = scrubber.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    tooltip.textContent = fmt(pct * (videoEl.duration || 0));
    tooltip.style.left  = `${pct * r.width}px`;
    tooltip.classList.add('visible');
  });
  scrubber.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));

  scrubber.addEventListener('mousedown', (e) => {
    isSeeking  = true;
    wasPlaying = !videoEl.paused;
    videoEl.pause();
    applySeek(e);
    document.addEventListener('mousemove', applySeek);
    document.addEventListener('mouseup', endSeek, { once: true });
  });

  function applySeek(e) {
    const pct = getSeekPct(e);
    seekLeft.style.width = `${pct * 100}%`;
    handle.style.left    = `${pct * 100}%`;
    if (videoEl.duration) videoEl.currentTime = pct * videoEl.duration;
  }

  function endSeek() {
    isSeeking = false;
    document.removeEventListener('mousemove', applySeek);
    if (wasPlaying) videoEl.play().catch(() => {});
  }

  // ── Fullscreen ────────────────────────────────────────────────────────────
  _playerToggleFs = () => {
    if (!document.fullscreenElement) playerOverlay.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  fsBtn.addEventListener('click', _playerToggleFs);
  document.addEventListener('fullscreenchange', () => {
    fsBtn.innerHTML = document.fullscreenElement ? EXIT_FS_ICON : FS_ICON;
  });

  // ── Spinner ───────────────────────────────────────────────────────────────
  videoEl.addEventListener('waiting', () => { spinner.hidden = false; });
  videoEl.addEventListener('canplay', () => { spinner.hidden = true; });
  videoEl.addEventListener('playing', () => { spinner.hidden = true; });
}

// ── Library polling ────────────────────────────────────────────────────────
function startLibraryPolling() {
  fetchLibrary();
  fetchCatalog();
  libraryPollTimer = setInterval(fetchLibrary, 5000);
  setInterval(fetchCatalog, 30_000);
}

async function fetchLibrary() {
  try {
    libraryData = await fetch('/api/library').then(r => r.json());
    updateLibraryBadge();
    updateCardBadges();
    if (currentSection === 'library') renderLibraryGrid();
    // Re-render hero so Watch Now / Add to Library stays in sync with library state
    if (heroMovies.length) renderHero(heroMovies[heroIdx]);
  } catch {}
}

async function fetchCatalog() {
  try {
    const data = await fetch('/api/catalog').then(r => r.json());
    catalogData = Array.isArray(data) ? data : [];
    renderReadyNowRows();
    updateCardBadges();
  } catch {}
}

function renderReadyNowRows() {
  const movies = catalogData.filter(c => c.type === 'movie');
  const shows  = catalogData.filter(c => c.type === 'tv');

  const rowNow   = $('rowReadyNow');
  const trackNow = $('rowReadyNowTrack');
  if (rowNow && trackNow) {
    trackNow.innerHTML = '';
    if (movies.length) {
      movies.forEach(item => trackNow.appendChild(createCatalogCard(item)));
      rowNow.hidden = false;
    } else {
      rowNow.hidden = true;
    }
  }

  const rowTV   = $('rowReadyTV');
  const trackTV = $('rowReadyTVTrack');
  if (rowTV && trackTV) {
    trackTV.innerHTML = '';
    if (shows.length) {
      shows.forEach(item => trackTV.appendChild(createCatalogCard(item)));
      rowTV.hidden = false;
    } else {
      rowTV.hidden = true;
    }
  }
}

function createCatalogCard(item) {
  const card = document.createElement('div');
  card.className = 'card catalog-card';
  card.dataset.tmdbId = item.tmdbId;
  card.dataset.mediaType = item.type;

  const displayTitle = item.showTitle || item.title || '';
  const year = item.year || '';
  const subLabel = item.type === 'tv' ? 'S01E01' : '';

  card.innerHTML = `
    <img class="card-img" src="${POSTER(item.posterPath)}" alt="${escHtml(displayTitle)}" loading="lazy">
    <div class="card-play-btn">&#9654;</div>
    <div class="card-info">
      <div class="card-title">${escHtml(displayTitle)}</div>
      <div class="card-meta">
        ${year ? `<span>${year}</span>` : ''}
        ${subLabel ? `<span class="card-rating">${subLabel}</span>` : ''}
      </div>
    </div>
    <div class="card-lib-tag" data-state="ready">&#9654; Ready</div>
  `;

  card.addEventListener('click', () => {
    const playTitle = item.type === 'tv'
      ? `${item.showTitle || item.title} S01E01`
      : (item.title || '');
    openPlayer(item.streamUrl, playTitle);
  });

  return card;
}

function updateLibraryBadge() {
  const inProgress = libraryData.filter(j => ['searching','downloading','uploading'].includes(j.status)).length;
  if (inProgress > 0) {
    libBadge.textContent = inProgress;
    libBadge.hidden = false;
    if (bottomBadge) { bottomBadge.textContent = inProgress; bottomBadge.hidden = false; }
  } else {
    libBadge.hidden = true;
    if (bottomBadge) bottomBadge.hidden = true;
  }
}

function statusPillHtml(status, progress) {
  const map = {
    searching:   ['gray',   'Searching'],
    downloading: ['yellow', `Downloading${progress ? ' ' + progress + '%' : ''}`],
    uploading:   ['blue',   `Uploading${progress ? ' ' + progress + '%' : ''}`],
    processing:  ['blue',   'Processing'],
    ready:       ['green',  'Ready'],
    error:       ['red',    'Error'],
  };
  const [color, label] = map[status] || ['gray', status];
  return `<span class="status-pill status-${color}">${label}</span>`;
}

function renderLibraryGrid() {
  if (!libraryData.length) {
    libraryGrid.innerHTML = '<p style="color:#777;padding:20px 0">Your library is empty. Add movies or TV episodes to get started.</p>';
    return;
  }

  libraryGrid.innerHTML = '';
  for (const job of libraryData) {
    const card = document.createElement('div');
    card.className = 'lib-card';

    const progressBar = ['downloading','uploading'].includes(job.status) && job.progress
      ? `<div class="lib-progress-wrap"><div class="lib-progress" style="width:${job.progress}%"></div></div>`
      : '';

    const r2Missing = job.status === 'ready' && !job.streamUrl;
    const playBtn = job.status === 'ready' && job.streamUrl
      ? `<button class="lib-play-btn" data-url="${escHtml(job.streamUrl)}" data-title="${escHtml(job.title || '')}">&#9654; Play</button>`
      : '';

    const episodeInfo = job.type === 'tv' && job.season && job.episode
      ? `<div class="lib-episode">S${String(job.season).padStart(2,'0')}E${String(job.episode).padStart(2,'0')}</div>`
      : '';

    const displayTitle = job.showTitle || job.title || '';
    const subTitle     = job.showTitle ? job.title : '';

    card.innerHTML = `
      <div class="lib-card-inner">
        <img class="lib-poster" src="/no-poster.svg" alt="" loading="lazy">
        <div class="lib-card-body">
          <div class="lib-title">${escHtml(displayTitle)}</div>
          ${episodeInfo}
          ${subTitle && subTitle !== displayTitle ? `<div class="lib-subtitle">${escHtml(subTitle)}</div>` : ''}
          ${statusPillHtml(job.status, job.progress)}
          ${progressBar}
          ${job.status !== 'ready' && job.status !== 'error' && job.message ? `<div class="lib-msg">${escHtml(job.message)}</div>` : ''}
          ${job.error ? `<div class="lib-error">${escHtml(job.error)}</div>` : ''}
        </div>
        <div class="lib-card-actions">
          ${playBtn}
          <button class="lib-del-btn" data-id="${job.id}" title="Remove">&#10005;</button>
        </div>
      </div>
    `;

    if (job.tmdbId) {
      loadPosterForCard(card.querySelector('.lib-poster'), job.tmdbId, job.type || 'movie');
    }

    card.querySelector('.lib-play-btn')?.addEventListener('click', (e) => {
      openPlayer(e.currentTarget.dataset.url, e.currentTarget.dataset.title);
    });

    card.querySelector('.lib-del-btn').addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      await fetch(`/api/admin/job/${id}`, { method: 'DELETE' });
      libraryData = libraryData.filter(j => j.id !== id);
      updateLibraryBadge();
      renderLibraryGrid();
    });

    libraryGrid.appendChild(card);
  }
}

// Poster cache: tmdbId → poster_path
const posterCache = new Map();

async function loadPosterForCard(imgEl, tmdbId, type) {
  const cached = posterCache.get(String(tmdbId));
  if (cached) { imgEl.src = `${IMG}/w185${cached}`; return; }
  try {
    const path = type === 'tv' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
    const data = await tmdb(path);
    if (data.poster_path) {
      posterCache.set(String(tmdbId), data.poster_path);
      imgEl.src = `${IMG}/w185${data.poster_path}`;
    }
  } catch {}
}

// ── Search ─────────────────────────────────────────────────────────────────
function setupSearch() {
  let debounce;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.hidden = !q;
    clearTimeout(debounce);
    if (!q) { showCurrentRows(); return; }
    debounce = setTimeout(() => doSearch(q), 400);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.hidden = true;
    showCurrentRows();
  });

  $('filmographyBack').addEventListener('click', () => {
    $('searchFilmography').hidden = true;
    $('searchNormal').hidden = false;
  });

  document.addEventListener('keydown', (e) => {
    if (!playerOverlay.hidden) {
      switch (e.key) {
        case 'Escape':   closePlayer(); break;
        case ' ': case 'k': e.preventDefault(); _playerTogglePlay?.(); break;
        case 'f': case 'F': _playerToggleFs?.(); break;
        case 'm': case 'M': _playerToggleMute?.(); break;
        case 'ArrowLeft':  e.preventDefault(); videoEl.currentTime = Math.max(0, videoEl.currentTime - 10); break;
        case 'ArrowRight': e.preventDefault(); if (videoEl.duration) videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + 10); break;
        case 'ArrowUp':    e.preventDefault(); videoEl.volume = Math.min(1, videoEl.volume + 0.1); break;
        case 'ArrowDown':  e.preventDefault(); videoEl.volume = Math.max(0, videoEl.volume - 0.1); break;
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!fetchOverlay.hidden) {
        stopCountdown(); fetchOverlay.hidden = true;
        document.body.style.overflow = ''; return;
      }
      if (!tvModalWrap.hidden) { closeTVModal(); return; }
      if (!modalWrap.hidden)   { closeModal();   return; }
    }
  });
}

async function doSearch(q) {
  searchResults.hidden = false;
  heroEl.hidden = true;
  rows.hidden = true; tvRows.hidden = true; librarySection.hidden = true;

  // Show normal results, hide filmography drilldown
  $('searchNormal').hidden = false;
  $('searchFilmography').hidden = true;

  searchGrid.innerHTML = '<p style="color:#555;padding:8px 0">Searching…</p>';
  const tvGrid      = $('searchTVGrid');
  const peopleGrid  = $('searchPeopleGrid');
  const peopleSection = $('searchPeopleSection');
  tvGrid.innerHTML  = '';
  peopleGrid.innerHTML = '';
  peopleSection.hidden = true;

  const [moviesRes, tvRes, peopleRes] = await Promise.allSettled([
    tmdb('/search/movie', { query: q }),
    tmdb('/search/tv',    { query: q }),
    fetch(`/api/people/search?q=${encodeURIComponent(q)}`).then(r => r.json()),
  ]);

  // Movies
  const movies = moviesRes.status === 'fulfilled' ? (moviesRes.value.results ?? []) : [];
  searchGrid.innerHTML = '';
  if (movies.length) {
    for (const m of movies.slice(0, 20)) searchGrid.appendChild(createCard(m, 'movie'));
  } else {
    searchGrid.innerHTML = '<p style="color:#555;padding:8px 0">No movies found.</p>';
  }

  // TV
  const shows = tvRes.status === 'fulfilled' ? (tvRes.value.results ?? []) : [];
  if (shows.length) {
    for (const s of shows.slice(0, 20)) tvGrid.appendChild(createCard(s, 'tv'));
  } else {
    tvGrid.innerHTML = '<p style="color:#555;padding:8px 0">No TV shows found.</p>';
  }

  // People
  const people = peopleRes.status === 'fulfilled' ? (peopleRes.value.results ?? []) : [];
  if (people.length) {
    for (const p of people.slice(0, 12)) peopleGrid.appendChild(createActorCard(p));
    peopleSection.hidden = false;
  }
}

function createActorCard(person) {
  const card = document.createElement('div');
  card.className = 'actor-card';
  const photo = person.profile_path
    ? `${IMG}/w185${person.profile_path}`
    : `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect width='80' height='80' rx='40' fill='%231a1a1a'/%3E%3Ctext x='40' y='48' text-anchor='middle' font-size='32' fill='%23444'%3E👤%3C/text%3E%3C/svg%3E`;
  const knownFor = (person.known_for ?? [])
    .map(k => k.title || k.name).filter(Boolean).slice(0, 2).join(', ');
  card.innerHTML = `
    <img class="actor-photo" src="${photo}" alt="${escHtml(person.name)}">
    <div class="actor-name">${escHtml(person.name)}</div>
    <div class="actor-dept">${escHtml(person.known_for_department || '')}</div>
    ${knownFor ? `<div class="actor-known">${escHtml(knownFor)}</div>` : ''}
  `;
  card.addEventListener('click', () => openFilmography(person.id, person.name));
  return card;
}

async function openFilmography(personId, personName) {
  $('searchNormal').hidden = true;
  $('searchFilmography').hidden = false;
  $('filmographyName').textContent = personName;
  $('filmographyMoviesGrid').innerHTML = '<p style="color:#555;padding:8px 0">Loading…</p>';
  $('filmographyTVGrid').innerHTML = '';

  const data = await fetch(`/api/people/${personId}/credits`).then(r => r.json()).catch(() => ({}));
  const cast = data.cast ?? [];

  const movies = cast
    .filter(c => c.media_type === 'movie' && c.poster_path)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i) // dedupe
    .slice(0, 40);

  const shows = cast
    .filter(c => c.media_type === 'tv' && c.poster_path)
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
    .slice(0, 20);

  $('filmographyMoviesGrid').innerHTML = '';
  if (movies.length) {
    for (const m of movies) $('filmographyMoviesGrid').appendChild(createCard(m, 'movie'));
  } else {
    $('filmographyMoviesGrid').innerHTML = '<p style="color:#555;padding:8px 0">No movies found.</p>';
  }

  $('filmographyTVGrid').innerHTML = '';
  if (shows.length) {
    for (const s of shows) $('filmographyTVGrid').appendChild(createCard(s, 'tv'));
  } else {
    $('filmographyTVGrid').innerHTML = '<p style="color:#555;padding:8px 0">No TV shows found.</p>';
  }

  updateCardBadges();
}

function showCurrentRows() {
  searchResults.hidden  = true;
  heroEl.hidden         = currentSection !== 'home';
  rows.hidden           = currentSection !== 'home';
  tvRows.hidden         = currentSection !== 'tv';
  librarySection.hidden = currentSection !== 'library';
}

// ── Nav ────────────────────────────────────────────────────────────────────
function syncBottomTabs(section) {
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.section === section);
  });
}

function setupNav() {
  window.addEventListener('scroll', () => {
    document.querySelector('.nav').classList.toggle('scrolled', window.scrollY > 20);
  });

  // Bottom tab bar (mobile)
  document.querySelectorAll('.bottom-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const section = tab.dataset.section;
      if (section) switchSection(section);
    });
  });

  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
      const section = link.dataset.section;
      if (!section) return;
      switchSection(section);
    });
  });
}

function switchSection(section) {
  currentSection = section;
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.section === section);
  });
  syncBottomTabs(section);
  searchInput.value = '';
  searchClear.hidden = true;
  searchResults.hidden = true;

  heroEl.hidden         = section !== 'home';
  rows.hidden           = section !== 'home';
  tvRows.hidden         = section !== 'tv';
  librarySection.hidden = section !== 'library';
  window.scrollTo(0, 0);

  searchInput.placeholder = 'Search movies & TV shows…';
  if (section === 'tv') {
    loadTVRows();
  } else if (section === 'library') {
    fetchLibrary();
  }
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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Go ─────────────────────────────────────────────────────────────────────
init();
