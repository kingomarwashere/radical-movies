import 'dotenv/config';

const KEY = process.env.TMDB_API_KEY;
const BASE = 'https://api.themoviedb.org/3';

async function get(path, params = {}) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url);
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
