/**
 * ATM Scheduler — backend API + SmartMoving sync + login.
 *
 * Requires Node 22.5+ (see the version check below) — uses Node's built-in `node:sqlite` so there
 * are still zero npm dependencies, but that module needs a fairly recent Node.
 *
 * This backend does three jobs:
 *  1. Serves the scheduler's own data (trucks/drivers/jobs/assignments) from a SQLite database
 *     (`server/db.js`) via a small REST API, so every device sees the same live board instead of
 *     each browser having its own separate localStorage copy.
 *  2. Pulls jobs FROM SmartMoving CRM (webhooks + a polling fallback) and writes them straight into
 *     that same database — see server/README.md "Webhooks vs. polling" for why both exist.
 *  3. Handles login: sign-in with Microsoft (Entra ID), restricted to the Around Town Movers
 *     Microsoft 365 tenant, an httpOnly-cookie session, and role-based access
 *     (admin/dispatcher/crew) — see server/README.md "Login & accounts" for how the first admin
 *     gets access and how roles map to what each route allows. There are no passwords anywhere in
 *     this app.
 *
 * One-way sync only: editing a job's date/truck/time in the scheduler does NOT push back to
 * SmartMoving — their public API has no endpoint for that (checked exhaustively; see
 * ../README.md). Dispatchers need to mirror schedule changes into SmartMoving manually.
 *
 * API summary (routes marked [public] need no login; everything else needs a valid session, and
 * [admin]/[admin+dispatcher] further restrict by role):
 *   GET   /api/health                              [public]
 *   GET   /api/auth/microsoft/login                 [public] redirects to Microsoft's sign-in page
 *   GET   /api/auth/microsoft/callback               [public] Microsoft redirects back here after sign-in
 *   POST  /api/auth/logout
 *   GET   /api/auth/me
 *   GET   /api/users                                [admin]
 *   POST  /api/users                                [admin]  body: {email, role} — grants access, doesn't create a password
 *   PATCH /api/users/:id                             [admin]  body: {role}
 *   DELETE /api/users/:id                            [admin]
 *   GET   /api/state                                -> { trucks, drivers, jobs }
 *   POST  /api/trucks                                [admin]  body: {name, size, capacity, homeBase}
 *   PATCH /api/trucks/:id                            [admin]  body: any truck field(s) to change
 *   POST  /api/trucks/:id/link-driver                [admin]  body: {driverId}
 *   POST  /api/drivers                               [admin]  body: {name, phone, cdl}
 *   PATCH /api/drivers/:id                           [admin]  body: any driver field(s) to change
 *   POST  /api/drivers/:id/unassign-truck            [admin]
 *   PATCH /api/jobs/:id                              [admin+dispatcher] body: any job field(s), incl. truckIds[]
 *   POST  /api/reset-to-sample-data                  [admin]
 *   POST  /api/sync-now                              [admin]  triggers an immediate SmartMoving poll sweep
 *   GET   /api/schedulable-jobs?statuses=4           [admin]  SmartMoving-sourced jobs only (debugging)
 *   POST  /webhooks/smartmoving?secret=...           [public, secret-checked] SmartMoving webhook receiver
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// node:sqlite needs Node 22.5+. Fail loudly and early rather than a confusing crash mid-request.
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    console.error(
      `This backend needs Node 22.5 or newer (found ${process.versions.node}) — it uses the ` +
      `built-in node:sqlite module. Upgrade Node (e.g. via nvm: "nvm install 22 && nvm use 22") and try again.`
    );
    process.exit(1);
  }
}

// Minimal .env loader (kept dependency-free on purpose — see file header). Values already set
// in the real environment (e.g. by your hosting platform) are left untouched.
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) return;
    const key = match[1];
    let value = (match[2] || '').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  });
})();

const db = require('./db');
const auth = require('./auth');
const { getAllLeads, getJobsByOpportunityId, getOpportunityDetails } = require('./smartmovingClient');
const { mapOpportunityToJobs } = require('./mapOpportunity');
const { OPPORTUNITY_STATUS } = require('./mapJobs');

const PORT = process.env.PORT || 8787;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEFAULT_STATUSES = [4]; // Booked — jobs that are past quoting and need to be dispatched
const POLL_INTERVAL_MINUTES = process.env.POLL_INTERVAL_MINUTES !== undefined ? Number(process.env.POLL_INTERVAL_MINUTES) : 15;
const POLL_LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS) || 7;
const POLL_LOOKAHEAD_DAYS = Number(process.env.POLL_LOOKAHEAD_DAYS) || 60;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || '';
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || '';
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || '';
const MICROSOFT_CONFIGURED = Boolean(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET && MICROSOFT_TENANT_ID);
// Must match exactly what's registered as a redirect URI in the Entra ID app registration.
const BACKEND_URL = (process.env.BACKEND_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const MICROSOFT_REDIRECT_URI = `${BACKEND_URL}/api/auth/microsoft/callback`;
// Where to send the browser after a login attempt (success or failure) — the frontend dev server
// by default.
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

let SESSION_SECRET = process.env.SESSION_SECRET;
let sessionSecretIsEphemeral = false;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  sessionSecretIsEphemeral = true;
}

/* ---------- Bootstrap the first admin account ----------
   Only runs when the users table is empty, so it never overwrites real accounts. Set ADMIN_EMAIL
   in .env for the very first run — there's no password to set, since login happens via Microsoft;
   this just grants that email address admin access so someone can sign in and use the Users panel
   to grant everyone else access. Safe to remove ADMIN_EMAIL afterward (or leave it — it's only
   consulted while there are zero users). */
(function bootstrapAdmin() {
  if (db.listUsers().length > 0) return;
  const email = auth.normalizeEmail(process.env.ADMIN_EMAIL);
  if (!email) {
    console.warn(
      'No user accounts exist yet and ADMIN_EMAIL is not set in .env — nobody can log in. Set it ' +
      'in server/.env and restart, or run: node create-admin.js <email> [admin|dispatcher|crew]'
    );
    return;
  }
  if (!auth.isCompanyEmail(email)) {
    console.error(`ADMIN_EMAIL (${email}) is not a @${auth.EMAIL_DOMAIN} address — refusing to create it. Fix .env and restart.`);
    return;
  }
  const id = 'U1';
  db.createUser({ id, email, role: 'admin' });
  console.log(`Granted admin access to: ${email} (they sign in with Microsoft using that address)`);
})();

function todayYyyymmdd(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

function nextId(rows, prefix) {
  const nums = rows.map(r => parseInt(String(r.id).replace(prefix, ''), 10)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return prefix + (max + 1);
}

function sendJson(req, res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  const origin = req.headers.origin;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Credentialed cross-origin requests (cookies) can't use a wildcard origin — echo the caller's
    // own origin instead. Falls back to '*' for non-browser callers (curl, server-to-server) that
    // don't send an Origin header at all, where this distinction doesn't matter.
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
    ...(extraHeaders || {}),
  });
  res.end(data);
}

/** For the OAuth redirect dance — a top-level browser navigation, not a fetch call, so this just
    needs a Location header (and, on the callback's success path, a Set-Cookie alongside it). */
function sendRedirect(res, status, location, extraHeaders) {
  res.writeHead(status, { Location: location, ...(extraHeaders || {}) });
  res.end();
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
async function readJsonBody(req) {
  const raw = await readRequestBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

/* ---------- Auth helpers ----------
   getCurrentUser() re-reads the user row from the database on every call rather than trusting
   anything cached in the token, so a role change or account deletion takes effect on the user's
   very next request instead of waiting for their session to expire. */
function getCurrentUser(req) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.COOKIE_NAME];
  if (!token) return null;
  const payload = auth.verifySessionToken(token, SESSION_SECRET);
  if (!payload) return null;
  const row = db.getUserById(payload.sub);
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role };
}

function requireAuth(req) {
  const user = getCurrentUser(req);
  if (!user) { const err = new Error('Not logged in'); err.status = 401; throw err; }
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) { const err = new Error('Not allowed for your role'); err.status = 403; throw err; }
}

/* ---------- SmartMoving sync diagnostics (state kept for /api/health) ---------- */
let lastPollAt = null;
let lastPollError = null;
let lastWebhookAt = null;
const recentWebhookEvents = []; // small ring buffer for /api/health diagnostics
const MAX_EVENT_LOG = 20;
function recordEvent(entry) {
  recentWebhookEvents.unshift({ at: new Date().toISOString(), ...entry });
  if (recentWebhookEvents.length > MAX_EVENT_LOG) recentWebhookEvents.length = MAX_EVENT_LOG;
}

/**
 * Fetches one opportunity's full detail + (best-effort) precise per-job timing, maps it into
 * scheduler job objects, and upserts each into the database. Shared by both the webhook handler
 * and the poll sweep so they can't drift out of sync with each other.
 */
async function hydrateOpportunity(opportunityId) {
  const opportunity = await getOpportunityDetails(opportunityId);

  let premiumJobsById = {};
  try {
    const result = await getJobsByOpportunityId(opportunityId);
    const rawJobs = Array.isArray(result) ? result : (result.pageResults || result.jobs || []);
    rawJobs.forEach(job => { premiumJobsById[job.id] = job; });
  } catch (err) {
    // Premium endpoint may 403 on non-Premium accounts, or the opportunity may have no jobs yet.
    // Not fatal — mapOpportunityToJobs falls back to the basic-tier arrivalWindow for timing.
  }

  const mappedJobs = mapOpportunityToJobs(opportunity, premiumJobsById);
  mappedJobs.forEach(job => db.upsertSmartMovingJob(job));
  return mappedJobs;
}

/* ---------- Poll sweep (fallback/backfill) ---------- */
async function pollSweep() {
  const from = todayYyyymmdd(-POLL_LOOKBACK_DAYS);
  const to = todayYyyymmdd(POLL_LOOKAHEAD_DAYS);
  const errors = [];
  let leadCount = 0;
  try {
    const leads = await getAllLeads({ from, to, includeBad: false, includeLost: false });
    leadCount = leads.length;
    for (const lead of leads) {
      try {
        await hydrateOpportunity(lead.id);
      } catch (err) {
        errors.push({ opportunityId: lead.id, customer: lead.customerName, message: err.message });
      }
    }
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    recordEvent({ type: 'poll-sweep', leadCount, errorCount: errors.length });
  } catch (err) {
    lastPollError = err.message;
    recordEvent({ type: 'poll-sweep-failed', message: err.message });
  }
  return { errors, leadCount };
}

let pollTimer = null;
function startPolling() {
  if (POLL_INTERVAL_MINUTES <= 0) return; // webhook-only mode
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollSweep().catch(() => {}); }, POLL_INTERVAL_MINUTES * 60 * 1000);
}

/* ---------- Webhook receiver ---------- */
// Events that mean "go re-fetch this opportunity": job-created fires for every new job regardless
// of whether it was ever a lead; opportunity-status-changed and opportunity-created catch the
// booking moment too, so between the three there's no origin-path this can miss.
const RELEVANT_EVENTS = new Set(['job-created', 'opportunity-created', 'opportunity-status-changed', 'opportunity-changed']);

async function handleWebhook(req, res, url) {
  if (WEBHOOK_SECRET) {
    const headerSecret = req.headers['x-webhook-secret'];
    const querySecret = url.searchParams.get('secret');
    if (headerSecret !== WEBHOOK_SECRET && querySecret !== WEBHOOK_SECRET) {
      recordEvent({ type: 'webhook-rejected', reason: 'bad or missing secret' });
      sendJson(req, res, 401, { error: 'Invalid or missing webhook secret' });
      return;
    }
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(req, res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const eventType = payload['event-type'] || payload.eventType;
  const opportunityId = payload['opportunity-id'] || payload.opportunityId;
  lastWebhookAt = new Date().toISOString();

  // Acknowledge immediately — SmartMoving likely retries on non-2xx or slow responses, and the
  // actual hydration call can take a moment.
  sendJson(req, res, 202, { received: true, eventType: eventType || null });

  if (!RELEVANT_EVENTS.has(eventType)) {
    recordEvent({ type: 'webhook-ignored', eventType: eventType || '(missing)' });
    return;
  }
  if (!opportunityId) {
    // job-created payloads only carry job-id per the docs — can't hydrate without an opportunity
    // id (SmartMoving's job-detail endpoints all require one). The poll sweep will pick this up
    // on its next pass instead.
    recordEvent({ type: 'webhook-no-opportunity-id', eventType });
    return;
  }

  try {
    const jobs = await hydrateOpportunity(opportunityId);
    recordEvent({ type: 'webhook-ingested', eventType, opportunityId, jobCount: jobs.length });
  } catch (err) {
    recordEvent({ type: 'webhook-ingest-failed', eventType, opportunityId, message: err.message });
  }
}

/** Shapes a user row for the API response (kept as its own function in case fields are added
    later that shouldn't go out over the wire). */
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role, createdAt: row.createdAt };
}

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'OPTIONS') { sendJson(req, res, 204, {}); return; }

    if (p === '/api/health') {
      const state = db.getState();
      sendJson(req, res, 200, {
        ok: true,
        hasApiKey: Boolean(process.env.SMARTMOVING_API_KEY),
        webhookSecretConfigured: Boolean(WEBHOOK_SECRET),
        pollIntervalMinutes: POLL_INTERVAL_MINUTES,
        truckCount: state.trucks.length, driverCount: state.drivers.length, jobCount: state.jobs.length,
        userCount: db.listUsers().length,
        dbFile: db.DB_FILE,
        lastPollAt, lastPollError, lastWebhookAt,
        recentEvents: recentWebhookEvents,
      });
      return;
    }

    if (p === '/webhooks/smartmoving' && req.method === 'POST') {
      await handleWebhook(req, res, url);
      return;
    }

    /* ---- Auth ---- */

    if (p === '/api/auth/microsoft/login' && req.method === 'GET') {
      if (!MICROSOFT_CONFIGURED) {
        sendJson(req, res, 500, { error: 'Microsoft sign-in is not configured on this server — set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_TENANT_ID in server/.env.' });
        return;
      }
      const state = auth.createOAuthState(SESSION_SECRET);
      const authorizeUrl = auth.buildMicrosoftAuthorizeUrl({
        tenantId: MICROSOFT_TENANT_ID, clientId: MICROSOFT_CLIENT_ID, redirectUri: MICROSOFT_REDIRECT_URI, state,
      });
      sendRedirect(res, 302, authorizeUrl);
      return;
    }

    if (p === '/api/auth/microsoft/callback' && req.method === 'GET') {
      const msError = url.searchParams.get('error');
      if (msError) {
        recordEvent({ type: 'login-failed', reason: msError });
        sendRedirect(res, 302, `${FRONTEND_URL}/?authError=${encodeURIComponent(msError)}`);
        return;
      }

      const state = url.searchParams.get('state');
      if (!auth.verifyOAuthState(state, SESSION_SECRET)) {
        sendRedirect(res, 302, `${FRONTEND_URL}/?authError=invalid_state`);
        return;
      }

      const code = url.searchParams.get('code');
      let tokenData, claims;
      try {
        tokenData = await auth.exchangeMicrosoftCode({
          tenantId: MICROSOFT_TENANT_ID, clientId: MICROSOFT_CLIENT_ID, clientSecret: MICROSOFT_CLIENT_SECRET,
          redirectUri: MICROSOFT_REDIRECT_URI, code,
        });
        claims = auth.decodeJwtPayload(tokenData.id_token);
        auth.validateMicrosoftIdToken(claims, { clientId: MICROSOFT_CLIENT_ID, tenantId: MICROSOFT_TENANT_ID });
      } catch (err) {
        recordEvent({ type: 'login-failed', reason: err.message });
        sendRedirect(res, 302, `${FRONTEND_URL}/?authError=sign_in_failed`);
        return;
      }

      const email = auth.normalizeEmail(claims.email || claims.preferred_username);
      if (!auth.isCompanyEmail(email)) {
        recordEvent({ type: 'login-rejected', reason: 'wrong domain', email });
        sendRedirect(res, 302, `${FRONTEND_URL}/?authError=wrong_domain`);
        return;
      }

      const row = db.getUserByEmail(email);
      if (!row) {
        recordEvent({ type: 'login-rejected', reason: 'no account', email });
        sendRedirect(res, 302, `${FRONTEND_URL}/?authError=not_authorized`);
        return;
      }

      const token = auth.createSessionToken(row, SESSION_SECRET);
      recordEvent({ type: 'login', email });
      sendRedirect(res, 302, FRONTEND_URL, { 'Set-Cookie': auth.sessionCookieHeader(token, COOKIE_SECURE) });
      return;
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': auth.clearSessionCookieHeader(COOKIE_SECURE) });
      return;
    }

    if (p === '/api/auth/me' && req.method === 'GET') {
      const user = getCurrentUser(req);
      if (!user) { sendJson(req, res, 401, { error: 'Not logged in' }); return; }
      sendJson(req, res, 200, user);
      return;
    }

    /* ---- Everything below here requires a logged-in user ---- */
    const currentUser = requireAuth(req);

    /* ---- User management (admin only) ---- */

    if (p === '/api/users' && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, db.listUsers());
      return;
    }

    if (p === '/api/users' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      if (!auth.isCompanyEmail(email)) {
        sendJson(req, res, 400, { error: `Email must be a @${auth.EMAIL_DOMAIN} address` });
        return;
      }
      const role = ['admin', 'dispatcher', 'crew'].includes(body.role) ? body.role : 'dispatcher';
      if (db.getUserByEmail(email)) {
        sendJson(req, res, 409, { error: 'A user with that email already exists' });
        return;
      }
      const id = nextId(db.listUsers(), 'U');
      // Grants access only — there's no password to set. This person can now sign in with
      // Microsoft using this exact email address.
      const user = db.createUser({ id, email, role });
      sendJson(req, res, 201, publicUser(user));
      return;
    }

    let m = p.match(/^\/api\/users\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin']);
      const targetId = m[1];
      const target = db.getUserById(targetId);
      if (!target) { sendJson(req, res, 404, { error: 'User not found' }); return; }
      const body = await readJsonBody(req);
      if (body.role !== undefined) {
        if (!['admin', 'dispatcher', 'crew'].includes(body.role)) {
          sendJson(req, res, 400, { error: 'Invalid role' });
          return;
        }
        if (target.role === 'admin' && body.role !== 'admin' && db.countAdmins() <= 1) {
          sendJson(req, res, 400, { error: "Can't remove the last admin — promote someone else first" });
          return;
        }
        db.updateUserRole(targetId, body.role);
      }
      sendJson(req, res, 200, publicUser(db.getUserById(targetId)));
      return;
    }

    m = p.match(/^\/api\/users\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const targetId = m[1];
      const target = db.getUserById(targetId);
      if (!target) { sendJson(req, res, 404, { error: 'User not found' }); return; }
      if (targetId === currentUser.id) { sendJson(req, res, 400, { error: "You can't delete your own account while logged in" }); return; }
      if (target.role === 'admin' && db.countAdmins() <= 1) {
        sendJson(req, res, 400, { error: "Can't delete the last admin" });
        return;
      }
      db.deleteUser(targetId);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    /* ---- Scheduler data API ---- */

    if (p === '/api/state' && req.method === 'GET') {
      sendJson(req, res, 200, db.getState());
      return;
    }

    if (p === '/api/reset-to-sample-data' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, db.resetToSampleData());
      return;
    }

    if (p === '/api/sync-now' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const result = await pollSweep();
      sendJson(req, res, 200, { ...result, state: db.getState() });
      return;
    }

    if (p === '/api/trucks' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      const { trucks } = db.getState();
      const id = nextId(trucks, 'T');
      const truck = db.createTruck({ id, name: body.name || `Truck ${trucks.length + 1}`, size: body.size, capacity: body.capacity, homeBase: body.homeBase, status: 'available' });
      sendJson(req, res, 201, truck);
      return;
    }

    m = p.match(/^\/api\/trucks\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      sendJson(req, res, 200, db.updateTruck(m[1], body));
      return;
    }

    m = p.match(/^\/api\/trucks\/([^/]+)\/link-driver$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      db.linkTruckDriver(m[1], body.driverId || null);
      sendJson(req, res, 200, db.getState());
      return;
    }

    if (p === '/api/drivers' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      if (!body.name) { sendJson(req, res, 400, { error: 'name is required' }); return; }
      const { drivers } = db.getState();
      const id = nextId(drivers, 'D');
      const driver = db.createDriver({ id, name: body.name, phone: body.phone, cdl: body.cdl });
      sendJson(req, res, 201, driver);
      return;
    }

    m = p.match(/^\/api\/drivers\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      sendJson(req, res, 200, db.updateDriver(m[1], body));
      return;
    }

    m = p.match(/^\/api\/drivers\/([^/]+)\/unassign-truck$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      db.unassignDriverTruck(m[1]);
      sendJson(req, res, 200, db.getState());
      return;
    }

    m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const body = await readJsonBody(req);
      const job = db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      sendJson(req, res, 200, db.updateJob(m[1], body));
      return;
    }

    /* ---- SmartMoving-sourced jobs only (debugging / the old sync panel view) ---- */
    if (p === '/api/schedulable-jobs' && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      const statusesParam = url.searchParams.get('statuses');
      const statuses = statusesParam ? statusesParam.split(',').map(Number) : DEFAULT_STATUSES;
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      if (forceRefresh) await pollSweep();

      const { jobs } = db.getState();
      const smJobs = jobs.filter(j => j.source === 'smartmoving' &&
        (j.smartMovingStatusCode === null || j.smartMovingStatusCode === undefined || statuses.includes(j.smartMovingStatusCode)));

      sendJson(req, res, 200, {
        fetchedAt: new Date().toISOString(),
        statuses: statuses.map(s => ({ code: s, label: OPPORTUNITY_STATUS[s] || s })),
        count: smJobs.length,
        jobs: smJobs,
        lastPollAt, lastPollError, lastWebhookAt,
      });
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(req, res, err.status || 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`ATM Scheduler backend listening on http://localhost:${PORT}`);
  console.log(`Database: ${db.DB_FILE}`);
  console.log(`SmartMoving API key ${process.env.SMARTMOVING_API_KEY ? 'is' : 'is NOT'} configured.`);
  console.log(`Webhook secret ${WEBHOOK_SECRET ? 'is' : 'is NOT'} configured (POST /webhooks/smartmoving).`);
  console.log(POLL_INTERVAL_MINUTES > 0
    ? `Poll sweep every ${POLL_INTERVAL_MINUTES} min (fallback/backfill).`
    : `Poll sweep disabled — webhook-only mode.`);
  if (sessionSecretIsEphemeral) {
    console.warn('SESSION_SECRET is not set in .env — using a random one generated for this run. ' +
      'Everyone will be logged out on the next restart. Set SESSION_SECRET in .env to avoid that.');
  }
  console.log(MICROSOFT_CONFIGURED
    ? `Microsoft sign-in is configured (tenant ${MICROSOFT_TENANT_ID}). Redirect URI: ${MICROSOFT_REDIRECT_URI}`
    : 'Microsoft sign-in is NOT configured — set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_TENANT_ID in .env before anyone can log in.');
  console.log(`${db.listUsers().length} user account(s) have access.`);
  if (process.env.SMARTMOVING_API_KEY) pollSweep().catch(() => {}); // warm the store on startup
  startPolling();
});

module.exports = { server, db, auth, hydrateOpportunity, pollSweep };
