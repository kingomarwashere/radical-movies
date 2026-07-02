import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const base = f => process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, f)
  : path.join(__dirname, '..', f);
const FILE = base('progress.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function save(d) { try { fs.writeFileSync(FILE, JSON.stringify(d)); } catch {} }

export function getUserProgress(username) {
  return load()[username] || {};
}

export function setProgress(username, jobId, record) {
  const all = load();
  if (!all[username]) all[username] = {};
  all[username][jobId] = { ...record, updatedAt: Date.now() };
  save(all);
}

export function deleteProgress(username, jobId) {
  const all = load();
  if (all[username]?.[jobId]) {
    delete all[username][jobId];
    save(all);
  }
}
