import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = f => process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, f)
  : path.join(__dirname, '..', f);
const FILE = base('watchlist.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(d) { try { fs.writeFileSync(FILE, JSON.stringify(d)); } catch {} }

export function getWatchlist(username) {
  return load()[username] || [];
}

export function addToWatchlist(username, item) {
  const all = load();
  if (!all[username]) all[username] = [];
  const exists = all[username].find(i => i.tmdbId === item.tmdbId && i.type === item.type);
  if (exists) return false;
  all[username].unshift({ ...item, addedAt: Date.now() });
  save(all);
  return true;
}

export function removeFromWatchlist(username, type, tmdbId) {
  const all = load();
  if (!all[username]) return;
  all[username] = all[username].filter(i => !(i.tmdbId === tmdbId && i.type === type));
  save(all);
}
