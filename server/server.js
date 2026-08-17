/**
 * ATM Scheduler — backend API + SmartMoving sync + login.
 *
 * Requires Node 22.5+ (see the version check below) — uses Node's built-in `node:sqlite`, which
 * needs a fairly recent Node. This backend is otherwise dependency-free except for `nodemailer`
 * (see `emailer.js` for why that's the one deliberate exception).
 *
 * This backend does three jobs:
 *  1. Serves the scheduler's own data (trucks/drivers/jobs/assignments) from a SQLite database
 *     (`server/db.js`) via a small REST API, so every device sees the same live board instead of
 *     each browser having its own separate localStorage copy.
 *  2. Pulls jobs FROM SmartMoving CRM (webhooks + a polling fallback) and writes them straight into
 *     that same database — see server/README.md "Webhooks vs. polling" for why both exist.
 *  3. Handles login: email + password sign-in, an httpOnly-cookie session, and role-based access
 *     (admin/dispatcher/crew) — see server/README.md "Login & accounts" for how the first admin
 *     gets access and how roles map to what each route allows. Nobody's password is ever stored in
 *     plaintext (see auth.js), and there's no admin-set temp password — new accounts (and anyone
 *     locked out) set their own password via an emailed one-time code.
 *
 * One-way sync only: editing a job's date/truck/time in the scheduler does NOT push back to
 * SmartMoving — their public API has no endpoint for that (checked exhaustively; see
 * ../README.md). Dispatchers need to mirror schedule changes into SmartMoving manually.
 *
 * API summary (routes marked [public] need no login; everything else needs a valid session, and
 * [admin]/[admin+dispatcher] further restrict by role):
 *   GET   /api/health                              [public]
 *   POST  /api/auth/login                            [public] body: {email, password}
 *   POST  /api/auth/forgot-password                  [public] body: {email} — emails a one-time code if the account exists
 *   POST  /api/auth/reset-password                   [public] body: {email, otp, newPassword} — sets a new password and signs in
 *   GET   /api/auth/status                           [public] { otpEmailConfigured, devBypassEnabled }
 *   GET   /api/auth/dev-login?role=admin             [public, dev-only] signs in without a password — only
 *                                                     responds when DEV_BYPASS_LOGIN=true. See server/README.md.
 *   POST  /api/auth/logout
 *   GET   /api/auth/me
 *   GET   /api/users                                [admin]
 *   POST  /api/users                                [admin]  body: {email, role} — grants access with no password set yet
 *   PATCH /api/users/:id                             [admin]  body: {role}
 *   DELETE /api/users/:id                            [admin]
 *   GET   /api/state                                -> { trucks, drivers, jobs }
 *   POST  /api/trucks                                [admin]  body: {name, size, capacity, homeBase}
 *   PATCH /api/trucks/:id                            [admin]  body: any truck field(s) to change
 *   DELETE /api/trucks/:id                           [admin]  job_trucks rows cascade-delete; any driver
 *                                                     linked to this truck is unlinked
 *   POST  /api/trucks/:id/link-driver                [admin]  body: {driverId}
 *   POST  /api/drivers                               [admin]  body: {name, phone, cdl}
 *   PATCH /api/drivers/:id                           [admin]  body: any driver field(s) to change
 *   DELETE /api/drivers/:id                          [admin]  any truck linked to this driver is unlinked
 *   POST  /api/drivers/:id/unassign-truck            [admin]
 *   POST  /api/jobs                                   [admin+dispatcher] body: {customer, date, endDate, startTime}
 *                                                              — creates a manual "placeholder" job, unassigned,
 *                                                              type inferred from date vs endDate
 *   PATCH /api/jobs/:id                              [admin+dispatcher] body: any job field(s), incl. truckIds[]
 *   DELETE /api/jobs/:id                             [admin+dispatcher] permanently removes a job — UI only
 *                                                              offers this for placeholder jobs, see db.js
 *   POST  /api/reset-to-sample-data                  [admin]
 *   POST  /api/clear-jobs                            [admin]  empties jobs only — trucks/drivers untouched
 *   POST  /api/sync-now?from=YYYY-MM-DD&to=YYYY-MM-DD [admin]  triggers an immediate SmartMoving poll
 *                                                              sweep; from/to are optional and override
 *                                                              POLL_LOOKBACK_DAYS/POLL_LOOKAHEAD_DAYS
 *                                                              for this sync only
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

// Loads server/.env into process.env (shared with create-admin.js and any other CLI script — see
// load-env.js for why this used to be inline here and why that was a bug).
require('./load-env');

const db = require('./db');
const auth = require('./auth');
const { sendOtpEmail, otpEmailConfigured } = require('./emailer');
const {
  getAllLeads, getJobsByOpportunityId, getOpportunityDetails,
  getAllCrewMembers, getAllJobsByCrewMemberId, getAllCustomersWithOpportunities,
} = require('./smartmovingClient');
const { mapOpportunityToJobs } = require('./mapOpportunity');
const { OPPORTUNITY_STATUS } = require('./mapJobs');

const PORT = process.env.PORT || 8787;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEFAULT_STATUSES = [4]; // Booked — jobs that are past quoting and need to be dispatched
const POLL_INTERVAL_MINUTES = process.env.POLL_INTERVAL_MINUTES !== undefined ? Number(process.env.POLL_INTERVAL_MINUTES) : 15;
const POLL_LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS) || 7;
const POLL_LOOKAHEAD_DAYS = Number(process.env.POLL_LOOKAHEAD_DAYS) || 60;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
// Only used by the dev-login bypass below, which is a full-page browser navigation (like an old
// OAuth redirect) rather than a fetch call, so it needs somewhere to send the browser back to.
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

// ---- Local dev login bypass (NOT for production) ----
// Lets you sign in without a real password or a configured email provider — useful for local
// development/testing. Requires an explicit opt-in flag; never enable this on anything reachable
// outside your own machine.
const DEV_BYPASS_LOGIN = process.env.DEV_BYPASS_LOGIN === 'true';

let SESSION_SECRET = process.env.SESSION_SECRET;
let sessionSecretIsEphemeral = false;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  sessionSecretIsEphemeral = true;
}

/* ---------- Bootstrap the first admin account ----------
   Only runs when the users table is empty, so it never overwrites real accounts. Set ADMIN_EMAIL
   in .env for the very first run. If ADMIN_PASSWORD is also set, the account can sign in with it
   immediately; otherwise it's created with no password, and whoever owns that email needs to use
   "Forgot password?" on the login screen (which requires SMTP_USER/SMTP_PASS to be
   configured — see server/README.md) to set one before they can sign in. Safe to remove
   ADMIN_EMAIL/ADMIN_PASSWORD afterward (or leave them — they're only consulted while there are
   zero users). */
(function bootstrapAdmin() {
  if (db.listUsers().length > 0) return;
  const email = auth.normalizeEmail(process.env.ADMIN_EMAIL);
  if (!email) {
    console.warn(
      'No user accounts exist yet and ADMIN_EMAIL is not set in .env — nobody can log in. Set it ' +
      'in server/.env and restart, or run: node create-admin.js <email> [admin|dispatcher|crew] [password]'
    );
    return;
  }
  if (!auth.isCompanyEmail(email)) {
    console.error(`ADMIN_EMAIL (${email}) is not a @${auth.EMAIL_DOMAIN} address — refusing to create it. Fix .env and restart.`);
    return;
  }
  const id = 'U1';
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  const passwordHash = adminPassword ? auth.hashPassword(adminPassword) : undefined;
  db.createUser({ id, email, role: 'admin', passwordHash });
  console.log(passwordHash
    ? `Granted admin access to: ${email} (signs in with the ADMIN_PASSWORD you set in .env — change it via "Forgot password?" afterward).`
    : `Granted admin access to: ${email} — no password set yet. Use "Forgot password?" on the login screen to set one (requires email sending to be configured), or run: node create-admin.js ${email} admin <password>`);
})();

function todayYyyymmdd(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

/** Parses a "YYYY-MM-DD" string (as sent by an HTML <input type="date">) into the yyyymmdd integer
 * format used everywhere else in this file (e.g. 20260812). Returns null for an empty/missing
 * value, throws a descriptive error for a non-empty value that doesn't parse — so a bad manual
 * sync-range request fails with a clear 400 instead of silently syncing the wrong window. */
function parseDateParamToYyyymmdd(value, paramName) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`${paramName} must be in YYYY-MM-DD format, got "${value}"`);
  const [, y, mo, d] = m;
  const asDate = new Date(`${y}-${mo}-${d}T00:00:00`);
  if (isNaN(asDate.getTime())) throw new Error(`${paramName} is not a valid date: "${value}"`);
  return Number(`${y}${mo}${d}`);
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

/** For the dev-login bypass — a top-level browser navigation, not a fetch call, so this just needs
    a Location header alongside the Set-Cookie that signs the browser in. */
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
/**
 * Three independent discovery sources, merged before hydrating:
 *
 *  1. GET /api/leads — confirmed live in the dev portal (2026-08-10) to ONLY EVER return
 *     New/InProgress opportunities by default (IncludeBad/IncludeLost are the only two widening
 *     params that exist — there's no way to ask it for Booked/Completed/Closed). So on its own
 *     this can never surface an already-booked job. Kept because it's the earliest signal (a lead
 *     the moment it's created) and gives a customer name for free.
 *  2. GET /api/crew-members/{id}/jobs — real JOBS, filtered by service date, that never go
 *     through /api/leads at all. Finds already-booked, already-staffed work. Requires enumerating
 *     crew members first (no status filter — see getAllCrewMembers's doc comment; filtering to
 *     Active-only was found 2026-08-10 to silently miss real jobs on crew with any other status).
 *  3. GET /api/customers — confirmed live 2026-08-10, added after a real user report of jobs
 *     missing even with NO crew assigned yet (source 2 can't find those — nothing to enumerate
 *     from). Lists customers filtered by job service date, each with opportunities[] across the
 *     FULL status range and their jobs[] embedded — doesn't depend on lead-pipeline stage OR crew
 *     assignment at all, closing the one gap sources 1 and 2 structurally can't reach.
 *
 * Each opportunity discovered by any source is hydrated exactly once via the shared
 * hydrateOpportunity() (a Map dedupes by opportunityId before the hydration loop runs).
 */
async function pollSweep({ from: fromOverride, to: toOverride } = {}) {
  const from = fromOverride ?? todayYyyymmdd(-POLL_LOOKBACK_DAYS);
  const to = toOverride ?? todayYyyymmdd(POLL_LOOKAHEAD_DAYS);
  const errors = [];
  let leadCount = 0;
  let crewJobOpportunityCount = 0;
  let customerJobOpportunityCount = 0;
  let jobCount = 0;
  let leadsWithNoJobCount = 0;
  let sourcesFailed = 0;

  // opportunityId -> customerName (undefined if only found via sources 2/3, which don't carry one
  // in the shape used for the Map key — source 3 actually does have a name, applied below).
  const opportunityIds = new Map();

  try {
    const leads = await getAllLeads({ from, to, includeBad: false, includeLost: false });
    leadCount = leads.length;
    leads.forEach(l => opportunityIds.set(l.id, l.customerName));
  } catch (err) {
    sourcesFailed += 1;
    errors.push({ opportunityId: null, customer: null, message: `GET /api/leads: ${err.message}` });
  }

  try {
    // No status filter — see smartmovingClient.js's getAllCrewMembers doc comment. Filtering to
    // "Active" only risks silently missing jobs assigned to crew whose real status string doesn't
    // exactly match that, which has no relationship to whether they're actually working today.
    const crewMembers = await getAllCrewMembers();
    const crewOpportunityIds = new Set();
    for (const crew of crewMembers) {
      try {
        const jobs = await getAllJobsByCrewMemberId(crew.id, { from, to });
        jobs.forEach(job => { if (job.opportunityId) crewOpportunityIds.add(job.opportunityId); });
      } catch (err) {
        errors.push({ opportunityId: null, customer: crew.name, message: `crew jobs: ${err.message}` });
      }
    }
    crewJobOpportunityCount = crewOpportunityIds.size;
    crewOpportunityIds.forEach(id => { if (!opportunityIds.has(id)) opportunityIds.set(id, undefined); });
  } catch (err) {
    sourcesFailed += 1;
    errors.push({ opportunityId: null, customer: null, message: `GET /api/crew-members: ${err.message}` });
  }

  try {
    const customers = await getAllCustomersWithOpportunities({ fromServiceDate: from, toServiceDate: to });
    const customerOpportunityIds = new Set();
    customers.forEach(customer => {
      (customer.opportunities || []).forEach(opp => {
        if (opp.id && Array.isArray(opp.jobs) && opp.jobs.length > 0) {
          customerOpportunityIds.add(opp.id);
          if (!opportunityIds.has(opp.id)) opportunityIds.set(opp.id, customer.name);
        }
      });
    });
    customerJobOpportunityCount = customerOpportunityIds.size;
  } catch (err) {
    sourcesFailed += 1;
    errors.push({ opportunityId: null, customer: null, message: `GET /api/customers: ${err.message}` });
  }

  for (const [opportunityId, customerName] of opportunityIds) {
    try {
      const mappedJobs = await hydrateOpportunity(opportunityId);
      jobCount += mappedJobs.length;
      if (mappedJobs.length === 0) leadsWithNoJobCount += 1;
    } catch (err) {
      errors.push({ opportunityId, customer: customerName, message: err.message });
    }
  }

  lastPollAt = new Date().toISOString();
  lastPollError = sourcesFailed >= 3 ? errors[0].message : null;
  recordEvent({
    type: 'poll-sweep', leadCount, crewJobOpportunityCount, customerJobOpportunityCount,
    opportunityCount: opportunityIds.size, jobCount, leadsWithNoJobCount, errorCount: errors.length,
  });
  return { errors, leadCount, crewJobOpportunityCount, customerJobOpportunityCount, jobCount, leadsWithNoJobCount, from, to };
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

/** Shapes a user row for the API response — deliberately leaves out passwordHash/otpHash/
    otpExpiresAt, which should never go out over the wire. `hasPassword` lets the Users panel show
    whether an account has finished first-time setup yet without exposing the hash itself. */
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role, createdAt: row.createdAt, hasPassword: Boolean(row.passwordHash ?? row.hasPassword) };
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

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      const password = body.password || '';
      const row = db.getUserByEmail(email);
      // Same generic error either way — confirming "that email exists but the password's wrong"
      // vs. "no such account" would let someone probe which addresses have access.
      if (!row || !auth.verifyPassword(password, row.passwordHash)) {
        recordEvent({ type: 'login-failed', email });
        sendJson(req, res, 401, { error: 'Incorrect email or password.' });
        return;
      }
      const token = auth.createSessionToken(row, SESSION_SECRET);
      recordEvent({ type: 'login', email });
      sendJson(req, res, 200, publicUser(row), { 'Set-Cookie': auth.sessionCookieHeader(token, COOKIE_SECURE) });
      return;
    }

    if (p === '/api/auth/forgot-password' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      const row = db.getUserByEmail(email);
      // Always the same response regardless of whether the account exists — otherwise this route
      // becomes a way to enumerate which addresses have access to the app.
      if (row) {
        const code = auth.generateOtp();
        const otpHash = auth.hashOtp(code, SESSION_SECRET);
        db.setUserOtp(row.id, otpHash, new Date(Date.now() + auth.OTP_TTL_MS).toISOString());
        try {
          await sendOtpEmail(email, code);
          recordEvent({ type: 'otp-sent', email });
        } catch (err) {
          recordEvent({ type: 'otp-send-failed', email, message: err.message });
        }
      }
      sendJson(req, res, 200, { ok: true, message: 'If that email has access, a reset code was sent to it.' });
      return;
    }

    if (p === '/api/auth/reset-password' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      const code = String(body.otp || '').trim();
      const newPassword = body.newPassword || '';
      const row = db.getUserByEmail(email);
      const otpValid = row && row.otpHash && row.otpExpiresAt
        && Date.now() <= Date.parse(row.otpExpiresAt)
        && auth.verifyOtp(code, row.otpHash, SESSION_SECRET);
      if (!otpValid) {
        sendJson(req, res, 400, { error: 'That code is invalid or has expired. Request a new one.' });
        return;
      }
      if (newPassword.length < 8) {
        sendJson(req, res, 400, { error: 'Password must be at least 8 characters.' });
        return;
      }
      db.setUserPassword(row.id, auth.hashPassword(newPassword));
      const token = auth.createSessionToken(row, SESSION_SECRET);
      recordEvent({ type: 'password-reset', email });
      sendJson(req, res, 200, publicUser(db.getUserById(row.id)), { 'Set-Cookie': auth.sessionCookieHeader(token, COOKIE_SECURE) });
      return;
    }

    if (p === '/api/auth/status' && req.method === 'GET') {
      sendJson(req, res, 200, { otpEmailConfigured: otpEmailConfigured(), devBypassEnabled: DEV_BYPASS_LOGIN });
      return;
    }

    if (p === '/api/auth/dev-login' && req.method === 'GET') {
      if (!DEV_BYPASS_LOGIN) { sendJson(req, res, 404, { error: 'Not found' }); return; }
      const requestedRole = url.searchParams.get('role');
      const users = db.listUsers();
      if (users.length === 0) {
        sendJson(req, res, 500, { error: 'No user accounts exist yet — set ADMIN_EMAIL in server/.env and restart, or run node create-admin.js <email> [role].' });
        return;
      }
      const row = users.find(u => u.role === requestedRole) || users.find(u => u.role === 'admin') || users[0];
      const token = auth.createSessionToken(row, SESSION_SECRET);
      recordEvent({ type: 'dev-login-bypass', email: row.email, role: row.role });
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
      // Grants access only — no password set. This person uses "Forgot password?" on the login
      // screen to set one via an emailed one-time code before they can sign in.
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

    if (p === '/api/clear-jobs' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, db.clearJobs());
      return;
    }

    if (p === '/api/sync-now' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      let from, to;
      try {
        from = parseDateParamToYyyymmdd(url.searchParams.get('from'), 'from');
        to = parseDateParamToYyyymmdd(url.searchParams.get('to'), 'to');
      } catch (err) {
        sendJson(req, res, 400, { error: err.message });
        return;
      }
      if (from && to && from > to) {
        sendJson(req, res, 400, { error: '"from" date must be on or before "to" date' });
        return;
      }
      const result = await pollSweep({ from, to });
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
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const { trucks } = db.getState();
      if (!trucks.some(t => t.id === m[1])) { sendJson(req, res, 404, { error: 'Truck not found' }); return; }
      sendJson(req, res, 200, db.deleteTruck(m[1]));
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
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const { drivers } = db.getState();
      if (!drivers.some(d => d.id === m[1])) { sendJson(req, res, 404, { error: 'Driver not found' }); return; }
      sendJson(req, res, 200, db.deleteDriver(m[1]));
      return;
    }

    m = p.match(/^\/api\/drivers\/([^/]+)\/unassign-truck$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      db.unassignDriverTruck(m[1]);
      sendJson(req, res, 200, db.getState());
      return;
    }

    // Manually created "placeholder" job — a stub for a booking that isn't in SmartMoving yet (or
    // never will be), created directly from the day view with just a name/date/time so a
    // dispatcher can pencil something in and fill in the rest later. `source: 'placeholder'`
    // reuses the same column SmartMoving-sourced jobs use to tag themselves (see SmBadge in
    // JobVisuals.jsx) rather than adding a new column for what's really the same concept —
    // "where did this job come from."
    if (p === '/api/jobs' && req.method === 'POST') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const body = await readJsonBody(req);
      if (!body.date) { sendJson(req, res, 400, { error: 'date is required' }); return; }
      const { jobs } = db.getState();
      const id = nextId(jobs, 'J-');
      const endDate = body.endDate || body.date;
      // No explicit type picker in the quick-add form — inferred the same way the rest of the
      // board treats dates: a job that runs past a single day is a multi-day (long-distance-style)
      // placeholder, otherwise it's a same-day local one. Matches how JobEditModal already frames
      // "until which day" as the field that distinguishes the two.
      const type = endDate > body.date ? 'long_distance' : 'local';
      const job = db.createJob({
        id,
        customer: (body.customer || '').trim() || 'New job',
        type,
        date: body.date,
        endDate,
        startTime: body.startTime || null,
        duration: type === 'local' ? 2 : null,
        origin: '',
        destination: '',
        crewSize: null,
        trucksNeeded: 1,
        status: 'scheduled',
        source: 'placeholder',
        truckIds: [],
      });
      sendJson(req, res, 201, { ...job, state: db.getState() });
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

    // Same role gate as PATCH — the frontend only ever offers this for placeholder jobs (see
    // db.js's deleteJob doc comment for why), but that's a UI choice, not enforced here.
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const job = db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      sendJson(req, res, 200, db.deleteJob(m[1]));
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
  console.log(otpEmailConfigured()
    ? 'Password-reset emails are configured (SMTP).'
    : 'Password-reset emails are NOT configured — set SMTP_USER and SMTP_PASS in .env, or nobody without a password can get one (see server/README.md "Login & accounts").');
  if (DEV_BYPASS_LOGIN) {
    console.warn('⚠️  DEV_BYPASS_LOGIN is active — /api/auth/dev-login skips password checks entirely. ' +
      'Local dev only. Do not set this on anything reachable outside your own machine.');
  }
  console.log(`${db.listUsers().length} user account(s) have access.`);
  if (process.env.SMARTMOVING_API_KEY) pollSweep().catch(() => {}); // warm the store on startup
  startPolling();
});

module.exports = { server, db, auth, hydrateOpportunity, pollSweep };
