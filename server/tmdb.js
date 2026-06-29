import 'dotenv/config';

const TOKEN = process.env.TMDB_READ_TOKEN || process.env.TMDB_API_KEY;
const USE_BEARER = TOKEN && TOKEN.length > 40; // read access tokens are JWTs
const BASE = 'https://api.themoviedb.org/3';

async function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  const headers = {};
  if (USE_BEARER) {
    headers['Authorization'] = `Bearer ${TOKEN}`;
  } else {
    url.searchParams.set('api_key', TOKEN);
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${path}`);
  return res.json();
}

export const getTrending = () => get('/trending/movie/week');
export const getPopular = (page = 1) => get('/movie/popular', { page });
export const getTopRated = (page = 1) => get('/movie/top_rated', { page });
export const getNowPlaying = () => get('/movie/now_playing');
export const getByGenre = (id, page = 1) =>
  get('/discover/movie', { with_genres: id, page, sort_by: 'popularity.desc' });
export const search = (query, page = 1) => get('/search/movie', { query, page });
export const getMovie = (id) =>
  get(`/movie/${id}`, { append_to_response: 'credits,videos,similar' });

export const getTVTrending = () => get('/trending/tv/week');
export const getTVPopular = (page = 1) => get('/tv/popular', { page });
export const getTVTopRated = (page = 1) => get('/tv/top_rated', { page });
export const searchTV = (query, page = 1) => get('/search/tv', { query, page });
export const getTVShow = (id) => get(`/tv/${id}`, { append_to_response: 'credits,videos,similar' });
export const getTVSeason = (id, season) => get(`/tv/${id}/season/${season}`);
export const getTVExternalIds = (id) => get(`/tv/${id}/external_ids`);
