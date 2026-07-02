import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = f => process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, f)
  : path.join(__dirname, '..', f);
const FILE = base('ratings.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(d) { try { fs.writeFileSync(FILE, JSON.stringify(d)); } catch {} }

export function getRatings(username) {
  return load()[username] || {};
}

export function setRating(username, type, tmdbId, rating) {
  const all = load();
  if (!all[username]) all[username] = {};
  all[username][`${type}:${tmdbId}`] = { rating, ratedAt: Date.now() };
  save(all);
}

export function removeRating(username, type, tmdbId) {
  const all = load();
  if (!all[username]) return;
  delete all[username][`${type}:${tmdbId}`];
  save(all);
}
