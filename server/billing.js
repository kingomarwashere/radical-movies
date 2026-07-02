import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERS_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'users.json')
  : path.join(__dirname, '..', 'users.json');

const CODES_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'invite-codes.json')
  : path.join(__dirname, '..', 'invite-codes.json');

const SITE_URL = process.env.SITE_URL || 'https://movies.theradicalparty.com';

function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers(u) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(u)); } catch {}
}

function loadCodes() {
  try {
    if (!fs.existsSync(CODES_FILE)) return [];
    return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
  } catch { return []; }
}
function saveCodes(c) {
  try { fs.writeFileSync(CODES_FILE, JSON.stringify(c)); } catch {}
}

// ── Paid status ──────────────────────────────────────────────────────────────
// Users created before billing was introduced have no 'paid' field — grandfather them in.
export function isPaid(username) {
  const users = loadUsers();
  const u = users.find(x => x.username === username);
  if (!u) return false;
  if (u.paid === undefined) return true;           // legacy user — grandfathered
  if (u.paid === true) {
    if (u.accessExpiresAt && Date.now() > u.accessExpiresAt) return false; // time-limited access expired
    return true;
  }
  if (u.trialEndsAt && Date.now() < u.trialEndsAt) return true; // free 1-day trial
  return false;
}

export function getPaidInfo(username) {
  const users = loadUsers();
  const u = users.find(x => x.username === username);
  if (!u) return { paid: false };
  const now = Date.now();
  const inTrial        = !!(u.trialEndsAt && now < u.trialEndsAt && !u.paid);
  const accessExpired  = !!(u.accessExpiresAt && now > u.accessExpiresAt);
  const paid           = u.paid === undefined || (u.paid === true && !accessExpired) || inTrial;
  return {
    paid,
    accessType:      u.accessType || null,
    inTrial,
    trialEndsAt:     u.trialEndsAt     || null,
    accessExpiresAt: u.accessExpiresAt || null,
  };
}

export function markUserPaid(username, accessType = 'stripe', extra = {}) {
  const users = loadUsers();
  const u = users.find(x => x.username === username);
  if (!u) return;
  u.paid       = true;
  u.accessType = accessType;
  u.paidAt     = u.paidAt || Date.now();
  if (extra.subscriptionId)  u.stripeSubscriptionId = extra.subscriptionId;
  if (extra.customerId)      u.stripeCustomerId     = extra.customerId;
  if (extra.accessExpiresAt) u.accessExpiresAt      = extra.accessExpiresAt;
  else                       delete u.accessExpiresAt; // stripe sub = permanent
  saveUsers(users);
  const expiry = extra.accessExpiresAt ? ` until ${new Date(extra.accessExpiresAt).toLocaleDateString()}` : '';
  console.log(`[billing] ${username} → paid (${accessType})${expiry}`);
}

// ── Webhook handler (needs raw body — mounted before express.json()) ─────────
export async function handleWebhook(req, res) {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).send('STRIPE_WEBHOOK_SECRET not set');

  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('[webhook] sig verify failed:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const username = s.client_reference_id || s.metadata?.username;
    if (username) markUserPaid(username, 'stripe', { subscriptionId: s.subscription, customerId: s.customer });
  }

  if (event.type === 'customer.subscription.deleted') {
    console.log(`[billing] subscription cancelled: ${event.data.object.id}`);
    // Future: revoke access on cancellation
  }

  res.json({ received: true });
}

// ── Routes ───────────────────────────────────────────────────────────────────
export function billingRoutes(app, { requireAuth }) {
  // Create Stripe Checkout session
  app.post('/api/billing/checkout', requireAuth, async (req, res) => {
    const { plan, introPeriod } = req.body;

    try {
      let sessionParams;

      if (plan === 'intro') {
        const periodDays = { '7days': 7, '1month': 30, '3month': 90, '6month': 180, '1year': 365 };
        const days = periodDays[introPeriod] || 30;
        const introPrice   = process.env.STRIPE_PRICE_INTRO;
        const monthlyPrice = process.env.STRIPE_PRICE_MONTHLY;
        if (!introPrice || !monthlyPrice) return res.status(500).json({ error: 'Stripe intro prices not configured' });

        sessionParams = {
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: monthlyPrice, quantity: 1 }],
          subscription_data: {
            trial_period_days: days,
            add_invoice_items: [{ price: introPrice, quantity: 1 }],
            metadata: { intro: 'true', introPeriod: introPeriod || '1month' },
          },
          client_reference_id: req.username,
          metadata: { username: req.username },
          success_url: `${SITE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${SITE_URL}/upgrade`,
        };
      } else {
        const priceId = plan === 'annual'
          ? process.env.STRIPE_PRICE_ANNUAL
          : process.env.STRIPE_PRICE_MONTHLY;
        if (!priceId) return res.status(500).json({ error: 'Stripe prices not configured' });

        sessionParams = {
          mode: 'subscription',
          payment_method_types: ['card'],
          line_items: [{ price: priceId, quantity: 1 }],
          client_reference_id: req.username,
          metadata: { username: req.username },
          success_url: `${SITE_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url:  `${SITE_URL}/upgrade`,
        };
      }

      const session = await stripe().checkout.sessions.create(sessionParams);
      res.json({ url: session.url });
    } catch (e) {
      console.error('[billing] checkout error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Stripe redirects here after successful payment
  app.get('/billing/success', requireAuth, async (req, res) => {
    const { session_id } = req.query;
    if (session_id) {
      try {
        const session = await stripe().checkout.sessions.retrieve(session_id);
        if (session.status === 'complete' || session.payment_status === 'paid') {
          markUserPaid(req.username, 'stripe', {
            subscriptionId: session.subscription,
            customerId: session.customer,
          });
        }
      } catch (e) {
        console.error('[billing] success verify:', e.message);
      }
    }
    res.redirect('/');
  });

  // Redeem invite code
  app.post('/api/billing/redeem', requireAuth, (req, res) => {
    const code = req.body?.code?.trim();
    if (!code) return res.status(400).json({ error: 'Code required' });

    const codes = loadCodes();
    const entry = codes.find(c => c.code.toLowerCase() === code.toLowerCase() && !c.usedBy);
    if (!entry) return res.status(400).json({ error: 'Invalid or already used code' });

    entry.usedBy = req.username;
    entry.usedAt = Date.now();
    saveCodes(codes);

    const accessExpiresAt = entry.durationMs ? Date.now() + entry.durationMs : null;
    markUserPaid(req.username, 'invite', { accessExpiresAt });
    res.json({ ok: true, accessExpiresAt });
  });

  // ── Admin: invite codes ───────────────────────────────────────────────────
  app.get('/api/admin/invite-codes', requireAuth, (_req, res) => res.json(loadCodes()));

  app.post('/api/admin/invite-codes', requireAuth, (req, res) => {
    const { code, notes, durationMs } = req.body || {};
    const newCode = code?.trim().toUpperCase() || genCode();
    const codes = loadCodes();
    if (codes.find(c => c.code.toLowerCase() === newCode.toLowerCase())) {
      return res.status(409).json({ error: 'Code already exists' });
    }
    codes.push({
      code: newCode,
      notes: notes || '',
      durationMs: durationMs || null, // null = lifetime
      createdAt: Date.now(),
      usedBy: null,
      usedAt: null,
    });
    saveCodes(codes);
    res.json({ ok: true, code: newCode });
  });

  app.delete('/api/admin/invite-codes/:code', requireAuth, (req, res) => {
    saveCodes(loadCodes().filter(c => c.code !== req.params.code));
    res.json({ ok: true });
  });
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
