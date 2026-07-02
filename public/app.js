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
let _watchProgress = {};
let _lastProgressSave = 0;
let _currentPosterPath = null;
let _nowPlaying = null;        // { type, showId, showName, season, episode } for TV
let _autoNextTimer = null;
let _partyRoomId = null;
let _partyIsHost = false;
let _partyEnabled = false;     // true once party panel is open
let _watchlist = [];
let _ratings = {};
let _watchedTmdbSet = new Set();

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

  socket.on('music:update', (album) => {
    // Update catalog entry
    const idx = _musicCatalog.findIndex(a => a.id === album.id);
    if (idx >= 0) _musicCatalog[idx] = { ..._musicCatalog[idx], ...album };
    else _musicCatalog.push(album);

    // Update card badge in grid
    const card = document.querySelector(`.music-card[data-album-id="${album.id}"]`);
    if (card) {
      const badge = card.querySelector('.music-card-badge');
      const b = getMusicBadge(album);
      if (b && badge) badge.textContent = b;
      else if (b && !badge) {
        const el = document.createElement('div');
        el.className = 'music-card-badge'; el.textContent = b;
        card.appendChild(el);
      } else if (!b && badge) badge.remove();
    }

    // Update modal status if open
    const statusEl = document.getElementById('musicModalStatus');
    if (statusEl && _musicAlbum?.id === album.id) {
      statusEl.textContent = album.message || album.status;
      if (album.status === 'ready') {
        closeMusicModal();
        openMusicAlbum(_musicCatalog.find(a => a.id === album.id));
      }
    }
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
    if (data.musicEnabled) initMusic(true);
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
  setupSubtitles();
  setupParty();
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
    heroWatch.onclick     = () => openPlayer(heroStream, heroTitle2, m.poster_path);
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
      modalWatch.onclick = () => { closeModal(); openPlayer(catalogItem.streamUrl, m.title, m.poster_path); };
    } else if (inLibrary?.status === 'ready') {
      modalWatch.textContent = '▶  Play';
      modalWatch.disabled = false;
      modalWatch.onclick = () => { closeModal(); openPlayer(inLibrary.streamUrl, m.title, m.poster_path); };
    } else if (inLibrary) {
      modalWatch.textContent = '✓ In Library';
      modalWatch.disabled = true;
    } else {
      modalWatch.textContent = '+ Add to Library';
      modalWatch.disabled = false;
      modalWatch.onclick = () => queueWatch(m);
    }
    // Clean up previous dynamic additions
    document.getElementById('modalWlBtn')?.remove();
    document.getElementById('modalRatingWrap')?.remove();
    document.getElementById('modalWhyBox')?.remove();

    // Watchlist button
    const inWl = _watchlist.some(i => i.tmdbId === m.id && i.type === 'movie');
    const wlBtn = document.createElement('button');
    wlBtn.id = 'modalWlBtn';
    wlBtn.className = `btn btn-wl${inWl ? ' active' : ''}`;
    wlBtn.textContent = inWl ? '♥ Watchlisted' : '♡ Watchlist';
    wlBtn.addEventListener('click', () => toggleWatchlist(m.id, 'movie', m.title, m.poster_path, m.release_date?.slice(0, 4)));
    modalActions.appendChild(wlBtn);

    // Star rating
    const ratingWrap = document.createElement('div');
    ratingWrap.id = 'modalRatingWrap';
    ratingWrap.className = 'modal-rating-wrap';
    modalSimilar.before(ratingWrap);
    renderStarRating('modalRatingWrap', 'movie', m.id);

    // Why you'll like this — async, non-blocking
    const openedId = m.id;
    buildWhyLikeThis(m, 'movie').then(reasons => {
      if (!reasons.length || modalWrap.hidden || currentMovie?.id !== openedId) return;
      document.getElementById('modalWhyBox')?.remove();
      const box = document.createElement('div');
      box.id = 'modalWhyBox';
      box.className = 'why-like-box';
      box.innerHTML = `<div class="why-like-title">Why you'll like this</div><ul class="why-like-list">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
      (document.getElementById('modalRatingWrap') || modalSimilar).before(box);
    }).catch(() => {});

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
      tvStatusLabel(show.status, show.last_air_date),
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

    // Clean up previous dynamic additions
    document.getElementById('tvModalWlBtn')?.remove();
    document.getElementById('tvModalRatingWrap')?.remove();
    document.getElementById('tvModalWhyBox')?.remove();

    // Watchlist button
    const tvModalActionsEl = $('tvModalActions');
    if (tvModalActionsEl) {
      const inWlTV = _watchlist.some(i => i.tmdbId === show.id && i.type === 'tv');
      const tvWlBtn = document.createElement('button');
      tvWlBtn.id = 'tvModalWlBtn';
      tvWlBtn.className = `btn btn-wl btn-lg${inWlTV ? ' active' : ''}`;
      tvWlBtn.textContent = inWlTV ? '♥ Watchlisted' : '♡ Watchlist';
      tvWlBtn.addEventListener('click', () => toggleWatchlist(show.id, 'tv', show.name, show.poster_path, show.first_air_date?.slice(0, 4)));
      tvModalActionsEl.appendChild(tvWlBtn);
    }

    // Star rating
    const tvRatingWrap = document.createElement('div');
    tvRatingWrap.id = 'tvModalRatingWrap';
    tvRatingWrap.className = 'modal-rating-wrap';
    tvModalSimilar.before(tvRatingWrap);
    renderStarRating('tvModalRatingWrap', 'tv', show.id);

    // Why you'll like this — async, non-blocking
    const openedShowId = show.id;
    buildWhyLikeThis(show, 'tv').then(reasons => {
      if (!reasons.length || tvModalWrap.hidden || currentShow?.id !== openedShowId) return;
      document.getElementById('tvModalWhyBox')?.remove();
      const box = document.createElement('div');
      box.id = 'tvModalWhyBox';
      box.className = 'why-like-box';
      box.innerHTML = `<div class="why-like-title">Why you'll like this</div><ul class="why-like-list">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>`;
      (document.getElementById('tvModalRatingWrap') || tvModalSimilar).before(box);
    }).catch(() => {});

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
        const epMeta = { type: 'tv', showId, showName: showTitle, season, episode: ep.episode_number, posterPath: currentShow?.poster_path };
        if (cat?.streamUrl) { openPlayer(cat.streamUrl, `${showTitle} S${s0}E${e0}`, currentShow?.poster_path, epMeta); return; }
        // Personal library check
        const alreadyIn = libraryData.find(j => j.tmdbId === showId && j.season == season && j.episode == ep.episode_number && j.status !== 'error');
        if (alreadyIn) {
          if (alreadyIn.status === 'ready' && alreadyIn.streamUrl) { openPlayer(alreadyIn.streamUrl, `${showTitle} S${s0}E${e0}`, currentShow?.poster_path, epMeta); }
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
    if (ready && streamUrl) { openPlayer(streamUrl, jobTitle, null, { type: 'tv', showId, showName: showTitle, season, episode }); return; }

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

function openPlayer(streamUrl, title, posterPath = null, meta = null) {
  cancelAutoNext();
  fetchOverlay.hidden = true;
  document.body.style.overflow = 'hidden';
  playerTitle.textContent = title || '';
  _currentPosterPath = posterPath;
  _nowPlaying = meta;
  videoEl.src = streamUrl;
  playerOverlay.hidden = false;
  $('playerUi').classList.add('visible');
  // Restore saved position
  const saved = currentJobId ? _watchProgress[currentJobId] : null;
  if (saved?.position > 5 && saved?.pct < 92) {
    videoEl.addEventListener('loadedmetadata', () => {
      videoEl.currentTime = saved.position;
    }, { once: true });
  }
  videoEl.play().catch(() => {});
  if (currentJobId) loadSubtitlesForJob(currentJobId);
  _currentStreamId = Math.random().toString(36).slice(2);
  socket.emit('stream:start', { streamId: _currentStreamId, title, streamUrl, jobId: currentJobId });
  // Hide overlapping UI
  $('trialBanner').hidden = true;
  window.Tawk_API?.hideWidget?.();
}

function closePlayer() {
  cancelAutoNext();
  leaveParty();
  if (document.fullscreenElement) document.exitFullscreen();
  videoEl.pause();
  videoEl.src = '';
  playerOverlay.hidden = true;
  document.body.style.overflow = '';
  if (_currentStreamId) { socket.emit('stream:end', { streamId: _currentStreamId }); _currentStreamId = null; }
  currentJobId = null;
  _nowPlaying = null;
  videoEl.querySelectorAll('track').forEach(t => t.remove());
  const ccBtn = $('playerCcBtn'); if (ccBtn) { ccBtn.hidden = true; ccBtn.classList.remove('active'); }
  const subMenu = $('subMenu'); if (subMenu) subMenu.hidden = true;
  // Restore overlapping UI
  const banner = $('trialBanner');
  if (banner && document.body.classList.contains('has-trial-banner')) banner.hidden = false;
  window.Tawk_API?.showWidget?.();
}

// ── Subtitles ──────────────────────────────────────────────────────────────
function loadSubtitlesForJob(jobId) {
  const job    = libraryData.find(j => j.id === jobId);
  const tracks = job?.subtitleTracks || [];
  const ccBtn  = $('playerCcBtn');
  const menu   = $('subMenu');

  videoEl.querySelectorAll('track').forEach(t => t.remove());
  ccBtn.hidden = !tracks.length;
  menu.hidden  = true;
  if (!tracks.length) return;

  tracks.forEach((t) => {
    const el = document.createElement('track');
    el.kind    = 'subtitles';
    el.src     = t.url;
    el.srclang = t.lang;
    el.label   = t.label;
    videoEl.appendChild(el);
  });

  menu.innerHTML = `<div class="sub-menu-item active" data-idx="-1">Off</div>`
    + tracks.map((t, i) => `<div class="sub-menu-item" data-idx="${i}">${escHtml(t.label)}</div>`).join('');

  menu.querySelectorAll('.sub-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.idx);
      for (let i = 0; i < videoEl.textTracks.length; i++)
        videoEl.textTracks[i].mode = (i === idx) ? 'showing' : 'hidden';
      menu.querySelectorAll('.sub-menu-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      ccBtn.classList.toggle('active', idx >= 0);
      menu.hidden = true;
    });
  });
}

function setupSubtitles() {
  const ccBtn = $('playerCcBtn');
  const menu  = $('subMenu');
  ccBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!ccBtn.contains(e.target) && !menu.contains(e.target)) menu.hidden = true;
  });
  // Re-check when job updates arrive (subtitle extraction is async)
  socket.on('job:update', (job) => {
    if (job.id === currentJobId && job.subtitleTracks?.length) {
      loadSubtitlesForJob(currentJobId);
    }
  });
}

// ── Auto-next episode ──────────────────────────────────────────────────────
function cancelAutoNext() {
  clearInterval(_autoNextTimer);
  _autoNextTimer = null;
  const el = $('autoNextOverlay');
  if (el) el.hidden = true;
}

function showAutoNext(next) {
  const overlay = $('autoNextOverlay');
  const countEl = $('autoNextCount');
  $('autoNextTitle').textContent = next.title;
  $('autoNextPoster').src = next.posterPath ? POSTER(next.posterPath) : '/no-poster.svg';
  overlay.hidden = false;

  let secs = 10;
  countEl.textContent = secs;
  _autoNextTimer = setInterval(() => {
    secs--;
    countEl.textContent = secs;
    if (secs <= 0) { cancelAutoNext(); playNext(next); }
  }, 1000);

  $('autoNextPlay').onclick   = () => { cancelAutoNext(); playNext(next); };
  $('autoNextCancel').onclick = () => cancelAutoNext();
}

function playNext(next) {
  currentJobId = next.jobId;
  openPlayer(next.streamUrl, next.title, next.posterPath, { type: 'tv', showId: next.showId, showName: next.showName, season: next.season, episode: next.episode, posterPath: next.posterPath });
}

async function checkAutoNext() {
  if (!_nowPlaying || _nowPlaying.type !== 'tv') return;
  const { showId, showName, season, episode, posterPath } = _nowPlaying;

  for (const [s, e] of [[season, episode + 1], [season + 1, 1]]) {
    const cat = catalogData.find(c => c.tmdbId === showId && c.type === 'tv' && c.season == s && c.episode == e && c.streamUrl);
    const lib = libraryData.find(j => j.tmdbId === showId && j.type === 'tv' && j.season == s && j.episode == e && j.status === 'ready' && j.streamUrl);
    if (!cat && !lib) continue;
    const streamUrl = cat?.streamUrl || lib?.streamUrl;
    const jobId     = lib?.id || null;
    const ss = String(s).padStart(2, '0'), ee = String(e).padStart(2, '0');
    try {
      const eps = await tmdb(`/tv/${showId}/season/${s}`);
      const ep  = (eps.episodes || []).find(x => x.episode_number === e);
      if (!ep) continue;
      showAutoNext({ showId, showName, season: s, episode: e, streamUrl, jobId, posterPath,
        title: `${showName} S${ss}E${ee} — ${ep.name}` });
      return;
    } catch { continue; }
  }
}

// ── Watch Party ────────────────────────────────────────────────────────────
function leaveParty() {
  if (_partyRoomId) { socket.emit('party:leave', _partyRoomId); _partyRoomId = null; }
  _partyIsHost = false;
  _partyEnabled = false;
  const panel = $('partyPanel');
  if (panel) panel.hidden = true;
  $('playerPartyBtn')?.classList.remove('active');
}

function setupParty() {
  const partyBtn  = $('playerPartyBtn');
  const panel     = $('partyPanel');
  const closeBtn  = $('partyClose');
  const copyBtn   = $('partyCopyBtn');
  const linkInput = $('partyLinkInput');
  const statusEl  = $('partyStatus');
  const membersEl = $('partyMembers');
  const linkRow   = $('partyLinkRow');

  partyBtn.addEventListener('click', () => {
    if (panel.hidden) {
      panel.hidden = false;
      partyBtn.classList.add('active');
      if (!_partyRoomId) {
        statusEl.textContent = 'Creating room…';
        linkRow.hidden = true;
        socket.emit('party:create', { streamUrl: videoEl.src, title: playerTitle.textContent });
      }
    } else {
      leaveParty();
    }
  });

  closeBtn.addEventListener('click', leaveParty);

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(linkInput.value).catch(() => {});
    const orig = copyBtn.textContent;
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyBtn.textContent = orig; }, 1500);
  });

  socket.on('party:joined', ({ roomId, isHost, memberCount, streamUrl, title }) => {
    _partyRoomId = roomId;
    _partyIsHost = isHost;
    _partyEnabled = true;
    panel.hidden = false;
    partyBtn.classList.add('active');
    membersEl.textContent = `${memberCount} watching`;
    const url = `${location.origin}/?party=${roomId}`;
    linkInput.value = url;
    linkRow.hidden  = false;
    statusEl.textContent = isHost ? 'You are the host — share the link!' : 'Joined! Host controls playback.';
    if (!isHost && streamUrl && videoEl.src !== streamUrl) {
      openPlayer(streamUrl, title || playerTitle.textContent);
    }
  });

  socket.on('party:sync', ({ currentTime, playing }) => {
    if (_partyIsHost) return;
    if (Math.abs(videoEl.currentTime - currentTime) > 2) videoEl.currentTime = currentTime;
    if (playing && videoEl.paused)  videoEl.play().catch(() => {});
    if (!playing && !videoEl.paused) videoEl.pause();
    statusEl.textContent = playing ? '▶ In sync' : '⏸ Paused by host';
    statusEl.className = 'party-status syncing';
    setTimeout(() => { statusEl.className = 'party-status'; statusEl.textContent = 'Synced'; }, 1500);
  });

  socket.on('party:members', (count) => {
    membersEl.textContent = `${count} watching`;
  });

  socket.on('party:error', (msg) => {
    statusEl.textContent = `Error: ${msg}`;
    panel.hidden = false;
  });

  // Auto-join from URL ?party=ROOMID
  const partyParam = new URLSearchParams(location.search).get('party');
  if (partyParam) {
    socket.emit('party:join', partyParam);
    history.replaceState({}, '', location.pathname);
  }
}

// Emit party sync when host plays/pauses (called from player event handlers)
function emitPartySync() {
  if (!_partyEnabled || !_partyIsHost || !_partyRoomId) return;
  socket.emit('party:update', { roomId: _partyRoomId, currentTime: videoEl.currentTime, playing: !videoEl.paused });
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

  videoEl.addEventListener('play',  () => { playBtn.innerHTML = PAUSE_ICON; showControls(); emitPartySync(); });
  videoEl.addEventListener('pause', () => {
    playBtn.innerHTML = PLAY_ICON;
    clearTimeout(hideTimer);
    playerUi.classList.add('visible');
    playerOverlay.style.cursor = '';
    emitPartySync();
  });
  videoEl.addEventListener('ended', () => {
    cancelAutoNext();
    checkAutoNext();
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
    // Save progress every 10s (skip short clips and near start)
    if (currentJobId && videoEl.duration > 60 && videoEl.currentTime > 5 && Date.now() - _lastProgressSave > 10000) {
      _lastProgressSave = Date.now();
      const watchPct = Math.round(videoEl.currentTime / videoEl.duration * 100);
      const record = { position: videoEl.currentTime, duration: videoEl.duration, pct: watchPct,
                       title: playerTitle.textContent, streamUrl: videoEl.src, posterPath: _currentPosterPath };
      _watchProgress[currentJobId] = record;
      fetch(`/api/progress/${currentJobId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record),
      }).catch(() => {});
      if (watchPct >= 92) {
        delete _watchProgress[currentJobId];
        renderContinueWatching();
      } else {
        renderContinueWatching();
      }
    }
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
    emitPartySync();
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

function fmtTime(s) {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}` : `${m}:${String(sc).padStart(2,'0')}`;
}

// ── Continue Watching ──────────────────────────────────────────────────────
async function loadProgress() {
  try {
    _watchProgress = await fetch('/api/progress').then(r => r.json());
    renderContinueWatching();
  } catch {}
}

function renderContinueWatching() {
  const items = Object.entries(_watchProgress)
    .filter(([, v]) => v.pct > 3 && v.pct < 92)
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const row   = $('rowContinue');
  const track = $('rowContinueTrack');
  if (!items.length) { row.hidden = true; return; }
  row.hidden = false;

  track.innerHTML = items.map(([jobId, v]) => `
    <div class="card" data-continue-id="${jobId}" style="cursor:pointer">
      <div style="position:relative">
        <img class="card-img" src="${v.posterPath ? POSTER(v.posterPath) : '/no-poster.svg'}" loading="lazy">
        <div class="continue-progress-wrap">
          <div class="continue-progress-fill" style="width:${v.pct}%"></div>
        </div>
        <div class="continue-play-icon">▶</div>
      </div>
      <div class="card-info" style="opacity:1;position:relative;background:none;padding:8px 4px 4px">
        <div class="card-title">${escHtml(v.title || '')}</div>
        <div class="card-meta" style="color:#888">${v.duration ? fmtTime(v.position) + ' / ' + fmtTime(v.duration) : ''}</div>
      </div>
    </div>`).join('');

  track.querySelectorAll('[data-continue-id]').forEach(card => {
    card.addEventListener('click', () => {
      const v = _watchProgress[card.dataset.continueId];
      if (!v?.streamUrl) return;
      currentJobId = card.dataset.continueId;
      openPlayer(v.streamUrl, v.title, v.posterPath);
    });
  });
}

// ── Library polling ────────────────────────────────────────────────────────
function startLibraryPolling() {
  fetchLibrary();
  fetchCatalog();
  loadProgress();
  loadWatchlistAndRatings();
  libraryPollTimer = setInterval(fetchLibrary, 5000);
  setInterval(fetchCatalog, 30_000);
}

async function fetchLibrary() {
  try {
    libraryData = await fetch('/api/library').then(r => r.json());
    updateWatchedSet();
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
    openPlayer(item.streamUrl, playTitle, item.posterPath);
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
      if (!document.getElementById('musicModalWrap').hidden) { closeMusicModal(); return; }
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
  const musicSec = document.getElementById('musicSection');
  if (musicSec) musicSec.hidden = section !== 'music';
  window.scrollTo(0, 0);

  searchInput.placeholder = section === 'music' ? 'Search music…' : 'Search movies & TV shows…';
  if (section === 'tv') {
    loadTVRows();
  } else if (section === 'library') {
    fetchLibrary();
  } else if (section === 'music') {
    loadMusicSection();
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

// ── Music ──────────────────────────────────────────────────────────────────
let _musicCatalog   = [];
let _musicQueue     = [];
let _musicQueueIdx  = 0;
let _musicAlbum     = null;
const musicAudio    = document.getElementById('musicAudio');
const musicBar      = document.getElementById('musicBar');
const musicBarArt   = document.getElementById('musicBarArt');
const musicBarTitle = document.getElementById('musicBarTitle');
const musicBarArtist = document.getElementById('musicBarArtist');
const musicBarPlay  = document.getElementById('musicBarPlay');
const musicBarFill  = document.getElementById('musicBarFill');
const musicBarProgressWrap = document.getElementById('musicBarProgressWrap');

function initMusic(musicEnabled) {
  if (!musicEnabled) return;
  document.querySelectorAll('.music-nav').forEach(el => el.hidden = false);

  let musicSearchDebounce;
  const musicInput = document.getElementById('musicSearchInput');
  const musicBtn   = document.getElementById('musicSearchBtn');
  const musicClear = document.getElementById('musicSearchClear');

  const doSearch = () => {
    const q = musicInput?.value.trim();
    if (!q) return;
    musicClear.hidden = false;
    doMusicSearch(q);
  };

  musicBtn?.addEventListener('click', doSearch);
  musicInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  musicClear?.addEventListener('click', () => {
    if (musicInput) musicInput.value = '';
    musicClear.hidden = true;
    renderMusicGrid(_musicCatalog);
  });
}

async function loadMusicSection() {
  await fetchMusicCatalog();
  renderMusicGrid(_musicCatalog);
}

async function fetchMusicCatalog() {
  try {
    _musicCatalog = await fetch('/api/music/catalog').then(r => r.json());
    // Subscribe to socket updates for in-progress albums
    for (const a of _musicCatalog) {
      if (a.status !== 'ready') socket.emit('music:join', a.id);
    }
  } catch {}
}

function renderMusicGrid(albums) {
  const grid = document.getElementById('musicGrid');
  if (!grid) return;
  if (!albums.length) {
    grid.innerHTML = '<p style="color:#555;padding:20px 0">No music yet — search for an album to add it.</p>';
    return;
  }
  grid.innerHTML = '';
  for (const album of albums) {
    grid.appendChild(createMusicCard(album));
  }
}

function createMusicCard(album) {
  const card = document.createElement('div');
  card.className = 'music-card';
  card.dataset.albumId = album.id;
  const artHtml = album.coverUrl
    ? `<img class="music-card-art" src="${escHtml(album.coverUrl)}" alt="" loading="lazy">`
    : `<div class="music-card-art-placeholder">♪</div>`;
  const badge = getMusicBadge(album);
  card.innerHTML = `
    ${artHtml}
    ${badge ? `<div class="music-card-badge">${badge}</div>` : ''}
    <div class="music-card-body">
      <div class="music-card-album">${escHtml(album.album)}</div>
      <div class="music-card-artist">${escHtml(album.artist)}</div>
    </div>`;
  card.addEventListener('click', () => openMusicAlbum(album));
  return card;
}

function getMusicBadge(album) {
  if (album.status === 'ready')       return '▶';
  if (album.status === 'downloading') return `↓ ${album.progress || 0}%`;
  if (album.status === 'searching')   return '⌛';
  if (album.status === 'error')       return '✗';
  return null;
}

// iTunes search for users
async function musicSearch(q) {
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: q, media: 'music', entity: 'album', limit: 30 })}`;
  const results = await fetch(url).then(r => r.json()).then(d => d.results || []);
  return results;
}

async function doMusicSearch(q) {
  const grid = document.getElementById('musicGrid');
  if (!grid) return;
  grid.innerHTML = '<p style="color:#555;padding:20px 0">Searching…</p>';
  try {
    const results = await musicSearch(q);
    if (!results.length) { grid.innerHTML = '<p style="color:#555;padding:20px 0">No results found.</p>'; return; }

    grid.innerHTML = '';
    for (const r of results) {
      const itunesId = r.collectionId;
      // Check if already in our catalog
      const inCatalog = _musicCatalog.find(a => a.itunesId === String(itunesId));
      const artUrl    = (r.artworkUrl100 || '').replace('100x100', '600x600');
      const year      = r.releaseDate ? new Date(r.releaseDate).getFullYear() : null;

      if (inCatalog) {
        // Show catalog card
        grid.appendChild(createMusicCard(inCatalog));
      } else {
        // Show iTunes result card with Add button
        const card = document.createElement('div');
        card.className = 'music-card';
        card.innerHTML = `
          ${artUrl ? `<img class="music-card-art" src="${escHtml(artUrl)}" alt="" loading="lazy">` : `<div class="music-card-art-placeholder">♪</div>`}
          <div class="music-card-body">
            <div class="music-card-album">${escHtml(r.collectionName)}</div>
            <div class="music-card-artist">${escHtml(r.artistName)}</div>
          </div>`;
        card.addEventListener('click', () => openMusicItunes(r, artUrl, year));
        grid.appendChild(card);
      }
    }
  } catch {
    grid.innerHTML = '<p style="color:#555;padding:20px 0">Search failed.</p>';
  }
}

function openMusicAlbum(album) {
  _musicAlbum = album;
  const wrap = document.getElementById('musicModalWrap');
  const hero = document.getElementById('musicModalHero');
  const info = document.getElementById('musicModalInfo');
  const list = document.getElementById('musicTrackList');

  hero.src = album.coverUrl || '';
  hero.style.display = album.coverUrl ? 'block' : 'none';

  // Status badge for non-ready albums
  let statusHtml = '';
  if (album.status !== 'ready') {
    const colors = { downloading: '#f59e0b', searching: '#888', error: '#f87171', pending: '#888' };
    const col = colors[album.status] || '#888';
    statusHtml = `<div style="margin-top:10px;padding:10px 14px;background:#0d0d0d;border:1px solid #1e1e1e;border-radius:6px;font-size:12px;color:${col}" id="musicModalStatus">
      ${escHtml(album.message || album.status)}
    </div>`;
  }

  info.innerHTML = `
    <div class="music-modal-album">${escHtml(album.album)}</div>
    <div class="music-modal-artist">${escHtml(album.artist)}</div>
    <div class="music-modal-meta">${album.year || ''} · ${album.tracks.length} tracks</div>
    ${statusHtml}`;

  list.innerHTML = '';
  if (album.status === 'ready') {
    album.tracks.forEach((track, i) => {
      const el = document.createElement('div');
      el.className = 'music-track';
      el.dataset.idx = i;
      el.innerHTML = `
        <div class="music-track-n">${track.n}</div>
        <div class="music-track-title">${escHtml(track.title)}</div>
        <div class="music-track-dur">${fmtMusicTime(track.duration)}</div>`;
      el.addEventListener('click', () => playMusicFrom(album.tracks, i, album));
      list.appendChild(el);
    });
  } else if (album.tracks.length) {
    // Show track names from iTunes metadata even before download is done
    album.tracks.forEach(t => {
      const el = document.createElement('div');
      el.className = 'music-track';
      el.style.opacity = '.4';
      el.innerHTML = `
        <div class="music-track-n">${t.n}</div>
        <div class="music-track-title">${escHtml(t.title)}</div>
        <div class="music-track-dur">${fmtMusicTime(t.duration)}</div>`;
      list.appendChild(el);
    });
  }

  // Listen for socket updates while modal is open
  socket.emit('music:join', album.id);

  wrap.hidden = false;
  document.body.style.overflow = 'hidden';
}

// Opens an iTunes result (not yet in catalog) with "Add" button
async function openMusicItunes(itunesAlbum, artUrl, year) {
  // Fetch tracks from iTunes
  const trackRes = await fetch(`https://itunes.apple.com/lookup?${new URLSearchParams({ id: itunesAlbum.collectionId, entity: 'song', limit: 100 })}`).then(r => r.json()).catch(() => ({ results: [] }));
  const tracks = (trackRes.results || [])
    .filter(r => r.wrapperType === 'track')
    .sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
    .map(r => ({ n: r.trackNumber, disc: r.discNumber || 1, title: r.trackName, duration: Math.round((r.trackTimeMillis || 0) / 1000) }));

  const fakeAlbum = {
    id: null, itunesId: String(itunesAlbum.collectionId),
    artist: itunesAlbum.artistName, album: itunesAlbum.collectionName,
    year, coverUrl: artUrl, tracks, status: 'not_added',
  };

  const wrap = document.getElementById('musicModalWrap');
  const hero = document.getElementById('musicModalHero');
  const info = document.getElementById('musicModalInfo');
  const list = document.getElementById('musicTrackList');

  hero.src = artUrl || '';
  hero.style.display = artUrl ? 'block' : 'none';

  info.innerHTML = `
    <div class="music-modal-album">${escHtml(itunesAlbum.collectionName)}</div>
    <div class="music-modal-artist">${escHtml(itunesAlbum.artistName)}</div>
    <div class="music-modal-meta">${year || ''} · ${tracks.length} tracks</div>
    <button class="btn btn-watch" id="musicAddBtn" style="margin-top:14px;padding:10px 24px;font-size:13px">
      + Add to Library
    </button>`;

  document.getElementById('musicAddBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('musicAddBtn');
    btn.textContent = 'Adding…'; btn.disabled = true;
    try {
      const res = await fetch('/api/music/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itunesId: String(itunesAlbum.collectionId),
          artist: itunesAlbum.artistName,
          album: itunesAlbum.collectionName,
          year, coverUrl: artUrl, tracks,
        }),
      });
      const data = await res.json();
      if (!res.ok) { btn.textContent = data.error || 'Error'; btn.disabled = false; return; }

      toast(`Added "${itunesAlbum.collectionName}" to library`);
      closeMusicModal();
      await fetchMusicCatalog();
      renderMusicGrid(_musicCatalog);
    } catch {
      btn.textContent = 'Error'; btn.disabled = false;
    }
  });

  list.innerHTML = '';
  tracks.forEach(t => {
    const el = document.createElement('div');
    el.className = 'music-track';
    el.style.opacity = '.5';
    el.innerHTML = `
      <div class="music-track-n">${t.n}</div>
      <div class="music-track-title">${escHtml(t.title)}</div>
      <div class="music-track-dur">${fmtMusicTime(t.duration)}</div>`;
    list.appendChild(el);
  });

  wrap.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeMusicModal() {
  document.getElementById('musicModalWrap').hidden = true;
  document.body.style.overflow = '';
}

document.getElementById('musicModalClose')?.addEventListener('click', closeMusicModal);
document.getElementById('musicModalBackdrop')?.addEventListener('click', closeMusicModal);

function playMusicFrom(tracks, idx, album) {
  _musicQueue    = tracks;
  _musicQueueIdx = idx;
  _musicAlbum    = album;
  playCurrentTrack();
}

function playCurrentTrack() {
  const track  = _musicQueue[_musicQueueIdx];
  const album  = _musicAlbum;
  if (!track) return;

  musicAudio.src = track.url;
  musicAudio.play().catch(() => {});

  musicBarTitle.textContent  = track.title;
  musicBarArtist.textContent = album?.artist || '';
  musicBarArt.src            = album?.coverUrl || '';
  musicBarArt.style.display  = album?.coverUrl ? 'block' : 'none';
  musicBarPlay.textContent   = '⏸';
  musicBar.hidden            = false;
  document.body.classList.add('has-music-bar');

  // Highlight playing track in modal
  document.querySelectorAll('.music-track').forEach(el => {
    el.classList.toggle('playing', parseInt(el.dataset.idx) === _musicQueueIdx);
  });
}

musicAudio?.addEventListener('ended', () => {
  if (_musicQueueIdx < _musicQueue.length - 1) {
    _musicQueueIdx++;
    playCurrentTrack();
  } else {
    musicBarPlay.textContent = '▶';
  }
});
musicAudio?.addEventListener('play',  () => { musicBarPlay.textContent = '⏸'; });
musicAudio?.addEventListener('pause', () => { musicBarPlay.textContent = '▶'; });
musicAudio?.addEventListener('timeupdate', () => {
  const pct = musicAudio.duration ? (musicAudio.currentTime / musicAudio.duration) * 100 : 0;
  musicBarFill.style.width = `${pct}%`;
});

musicBarPlay?.addEventListener('click', () => {
  if (musicAudio.paused) musicAudio.play().catch(() => {});
  else musicAudio.pause();
});
musicBarProgressWrap?.addEventListener('click', (e) => {
  const r   = musicBarProgressWrap.getBoundingClientRect();
  const pct = (e.clientX - r.left) / r.width;
  if (musicAudio.duration) musicAudio.currentTime = pct * musicAudio.duration;
});
document.getElementById('musicBarPrev')?.addEventListener('click', () => {
  if (musicAudio.currentTime > 3) { musicAudio.currentTime = 0; return; }
  if (_musicQueueIdx > 0) { _musicQueueIdx--; playCurrentTrack(); }
});
document.getElementById('musicBarNext')?.addEventListener('click', () => {
  if (_musicQueueIdx < _musicQueue.length - 1) { _musicQueueIdx++; playCurrentTrack(); }
});

function fmtMusicTime(s) {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const sc = Math.floor(s % 60);
  return `${m}:${String(sc).padStart(2, '0')}`;
}

// ── Watchlist & Ratings ────────────────────────────────────────────────────
async function loadWatchlistAndRatings() {
  try {
    const [wl, rt] = await Promise.all([
      fetch('/api/watchlist').then(r => r.json()),
      fetch('/api/ratings').then(r => r.json()),
    ]);
    _watchlist = Array.isArray(wl) ? wl : [];
    _ratings   = rt || {};
    renderWatchlistRow();
  } catch {}
}

function updateWatchedSet() {
  _watchedTmdbSet = new Set(libraryData.filter(j => j.tmdbId).map(j => j.tmdbId));
}

function renderWatchlistRow() {
  const row   = $('rowWatchlist');
  const track = $('rowWatchlistTrack');
  if (!row || !track) return;
  if (!_watchlist.length) { row.hidden = true; return; }
  row.hidden = false;
  track.innerHTML = '';
  for (const item of _watchlist.slice(0, 20)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.tmdbId    = item.tmdbId;
    card.dataset.mediaType = item.type;
    card.innerHTML = `
      <img class="card-img" src="${POSTER(item.posterPath)}" alt="${escHtml(item.title || '')}" loading="lazy">
      <div class="card-info">
        <div class="card-title">${escHtml(item.title || '')}</div>
        <div class="card-meta">${item.year ? `<span>${item.year}</span>` : ''}</div>
      </div>
    `;
    card.addEventListener('click', () => {
      if (item.type === 'tv') openTVModal(item.tmdbId);
      else openModal(item.tmdbId);
    });
    track.appendChild(card);
  }
  updateCardBadges();
}

async function toggleWatchlist(tmdbId, type, title, posterPath, year) {
  const inWl = _watchlist.some(i => i.tmdbId === tmdbId && i.type === type);
  if (inWl) {
    _watchlist = _watchlist.filter(i => !(i.tmdbId === tmdbId && i.type === type));
    await fetch(`/api/watchlist/${type}/${tmdbId}`, { method: 'DELETE' }).catch(() => {});
    toast('Removed from watchlist');
  } else {
    _watchlist.unshift({ tmdbId, type, title, posterPath, year, addedAt: Date.now() });
    await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId, type, title, posterPath, year }),
    }).catch(() => {});
    toast('Added to watchlist');
  }
  const nowIn = !inWl;
  for (const id of ['modalWlBtn', 'tvModalWlBtn']) {
    const btn = $(id);
    if (btn) { btn.textContent = nowIn ? '♥ Watchlisted' : '♡ Watchlist'; btn.classList.toggle('active', nowIn); }
  }
  renderWatchlistRow();
}

function renderStarRating(containerId, type, tmdbId) {
  const container = $(containerId);
  if (!container) return;
  const key     = `${type}:${tmdbId}`;
  const current = _ratings[key]?.rating || 0;
  container.innerHTML = `
    <div class="star-rating-wrap">
      <span class="star-label">Your rating</span>
      <div class="stars">
        ${[1,2,3,4,5].map(v => `<span class="star${current >= v ? ' active' : ''}" data-v="${v}">&#9733;</span>`).join('')}
      </div>
    </div>
  `;
  const starsEl = container.querySelector('.stars');
  starsEl?.addEventListener('mouseleave', () => {
    container.querySelectorAll('.star').forEach(s => s.classList.remove('hover'));
  });
  container.querySelectorAll('.star').forEach(star => {
    star.addEventListener('mouseenter', () => {
      const v = parseInt(star.dataset.v);
      container.querySelectorAll('.star').forEach(s => s.classList.toggle('hover', parseInt(s.dataset.v) <= v));
    });
    star.addEventListener('click', async () => {
      const v   = parseInt(star.dataset.v);
      const cur = _ratings[key]?.rating;
      if (cur === v) {
        delete _ratings[key];
        await fetch(`/api/ratings/${type}/${tmdbId}`, { method: 'DELETE' }).catch(() => {});
      } else {
        _ratings[key] = { rating: v, ratedAt: Date.now() };
        await fetch('/api/ratings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tmdbId, type, rating: v }),
        }).catch(() => {});
      }
      renderStarRating(containerId, type, tmdbId);
    });
  });
}

async function buildWhyLikeThis(item, mediaType) {
  if (!_watchedTmdbSet.size) return [];
  const reasons = [];

  // Similar overlap
  const similar = item.similar?.results ?? [];
  for (const s of similar.slice(0, 15)) {
    if (_watchedTmdbSet.has(s.id) && s.id !== item.id) {
      reasons.push(`Similar to <em>${escHtml(s.title || s.name || '')}</em> in your library`);
      break;
    }
  }

  // Director's other films (movies only)
  if (mediaType === 'movie') {
    const director = item.credits?.crew?.find(c => c.job === 'Director');
    if (director?.id) {
      try {
        const data = await fetch(`/api/people/${director.id}/credits`).then(r => r.json());
        const directed = (data.crew ?? [])
          .filter(c => c.job === 'Director' && c.media_type === 'movie' && _watchedTmdbSet.has(c.id) && c.id !== item.id)
          .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
          .slice(0, 2);
        if (directed.length) {
          const titles = directed.map(c => `<em>${escHtml(c.title || '')}</em>`).join(' and ');
          reasons.push(`You have ${titles} in your library — also directed by ${escHtml(director.name)}`);
        }
      } catch {}
    }
  }

  // Creator's other works (TV only)
  if (mediaType === 'tv') {
    const creator = item.created_by?.[0];
    if (creator?.id) {
      try {
        const data = await fetch(`/api/people/${creator.id}/credits`).then(r => r.json());
        const works = [...(data.cast ?? []), ...(data.crew ?? [])]
          .filter(c => _watchedTmdbSet.has(c.id) && c.id !== item.id)
          .filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i)
          .slice(0, 2);
        if (works.length) {
          const titles = works.map(c => `<em>${escHtml(c.title || c.name || '')}</em>`).join(' and ');
          reasons.push(`You have ${titles} in your library — also by ${escHtml(creator.name)}`);
        }
      } catch {}
    }
  }

  return reasons;
}

function tvStatusLabel(status, lastAirDate) {
  if (!status) return '';
  const endYear = lastAirDate ? lastAirDate.slice(0, 4) : '';
  const map = {
    'Returning Series': ['status-green', 'Returning'],
    'Ended':            ['status-gray',  endYear ? `Ended ${endYear}` : 'Ended'],
    'Canceled':         ['status-red',   'Cancelled'],
    'In Production':    ['status-blue',  'In Production'],
    'Planned':          ['status-blue',  'Planned'],
    'Pilot':            ['status-gray',  'Pilot'],
  };
  const entry = map[status];
  if (!entry) return '';
  const [cls, label] = entry;
  return `<span class="status-pill ${cls}">${escHtml(label)}</span>`;
}

// ── Go ─────────────────────────────────────────────────────────────────────
init();
