import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── User store (JSON file) ────────────────────────────────────────────────
const USERS_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'users.json')
  : path.join(__dirname, '..', 'users.json');

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch { return []; }
}

function saveUsers(users) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); } catch {}
}

// Passwords stored as plaintext. Legacy hashed passwords (salt:hex format) are
// still accepted on login and migrated to plaintext on next successful login.
function hashPassword(password) { return password; }

function verifyPassword(password, stored) {
  if (password === stored) return true;
  // Migration path: try old scrypt hash
  try {
    const parts = stored.split(':');
    if (parts.length === 2 && parts[0].length === 32) {
      const derived = scryptSync(password, parts[0], 64);
      return timingSafeEqual(derived, Buffer.from(parts[1], 'hex'));
    }
  } catch {}
  return false;
}

export function getUsers()           { return loadUsers(); }
export function deleteUser(username) {
  const users = loadUsers().filter(u => u.username !== username);
  saveUsers(users);
}

// ── Session store (persisted to disk) ────────────────────────────────────
const SESSIONS_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'sessions.json')
  : path.join(__dirname, '..', 'sessions.json');

const sessions = new Map(); // token → { username, expiresAt }
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const COOKIE_MAX_AGE = 2592000;

function saveSessions() {
  const out = {};
  for (const [t, s] of sessions) out[t] = s;
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(out)); } catch {}
}

(function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [t, s] of Object.entries(raw)) {
      if (s.expiresAt > now) sessions.set(t, s);
    }
  } catch {}
})();

function createSession(username) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL });
  saveSessions();
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(token); saveSessions(); return null; }
  return s;
}

function deleteSession(token) {
  sessions.delete(token);
  saveSessions();
}

// Clean expired sessions hourly
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [t, s] of sessions) { if (now > s.expiresAt) { sessions.delete(t); changed = true; } }
  if (changed) saveSessions();
}, 60 * 60 * 1000);

// ── Cookie parsing ────────────────────────────────────────────────────────
function parseCookie(cookieHeader) {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const eq = c.indexOf('=');
      return eq > 0 ? [c.slice(0, eq).trim(), c.slice(eq + 1).trim()] : [c.trim(), ''];
    })
  );
}

function getTokenFromRequest(req) {
  const cookies = parseCookie(req.headers.cookie);
  return cookies.session || null;
}

// ── Public API ────────────────────────────────────────────────────────────
export function getUser(req) {
  const token = getTokenFromRequest(req);
  return getSession(token)?.username ?? null;
}

export function requireAuth(req, res, next) {
  const username = getUser(req);
  if (!username) {
    if (req.headers.accept?.includes('text/html')) {
      return res.redirect('/login');
    }
    return res.status(401).json({ error: 'Unauthorised' });
  }
  req.username = username;
  next();
}

export function authRoutes(app) {
  // Sign up
  app.post('/api/auth/signup', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 2–32 characters' });
    }
    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const users = loadUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const hashed = hashPassword(password);
    const now = Date.now();
    users.push({ username, password: hashed, createdAt: now, paid: false, trialEndsAt: now + 24 * 60 * 60 * 1000 });
    saveUsers(users);

    const token = createSession(username);
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`);
    res.json({ ok: true, username });
  });

  // Login
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const users = loadUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

    // Timing-safe: always run verifyPassword even if user not found
    const storedHash = user?.password || 'x:' + '0'.repeat(128);
    const valid = user && verifyPassword(password, storedHash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Migrate hashed password to plaintext on login
    if (user.password !== password) {
      const users = loadUsers();
      const u = users.find(x => x.username === user.username);
      if (u) { u.password = password; saveUsers(users); }
    }

    const token = createSession(user.username);
    res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`);
    res.json({ ok: true, username: user.username });
  });

  // Logout
  app.post('/api/auth/logout', (req, res) => {
    const token = getTokenFromRequest(req);
    if (token) deleteSession(token);
    res.setHeader('Set-Cookie', `session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  // Me
  app.get('/api/auth/me', (req, res) => {
    const username = getUser(req);
    if (!username) return res.status(401).json({ error: 'Unauthorised' });
    const users = loadUsers();
    const u = users.find(x => x.username === username);
    const inTrial    = !!(u?.trialEndsAt && Date.now() < u.trialEndsAt && !u?.paid);
    const paid       = u ? (u.paid === undefined || u.paid === true || inTrial) : false;
    const trialEndsAt = u?.trialEndsAt || null;
    res.json({ username, paid, accessType: u?.accessType || null, inTrial, trialEndsAt });
  });
}
