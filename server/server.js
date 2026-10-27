/**
 * ATM Scheduler — backend API + SmartMoving sync + login.
 *
 * Runs on AWS App Runner in production (see server/README.md "AWS deployment") and honors the
 * `PORT` env var. Data lives in Firestore (`server/db.js` / `server/firestore.js`) — a Google
 * product, but accessed here over the network via a service account key, same as any other
 * Firestore client; nothing about running on AWS instead of GCP changes how `db.js` works. Every
 * db.* call is async.
 *
 * This backend does FOUR jobs:
 *  1. Serves the scheduler's own data (trucks/drivers/jobs/assignments) from Firestore
 *     (`server/db.js`) via a small REST API, so every device sees the same live board instead of
 *     each browser having its own separate localStorage copy.
 *  2. Pulls jobs FROM SmartMoving CRM (webhooks + a polling fallback) and writes them straight into
 *     that same database — see server/README.md "Webhooks vs. polling" for why both exist.
 *  3. Handles login: email + password sign-in, an httpOnly-cookie session, and role-based access
 *     (admin/dispatcher/crew) — see server/README.md "Login & accounts" for how the first admin
 *     gets access and how roles map to what each route allows. Nobody's password is ever stored in
 *     plaintext (see auth.js), and there's no admin-set temp password — new accounts (and anyone
 *     locked out) set their own password via an emailed one-time code.
 *  4. Serves the built React frontend as static files (see `serveStatic()` below) — the Docker
 *     image's build stage compiles `frontend/` and copies the output into `server/public/`, so one
 *     AWS App Runner service serves both the site and its API from the same origin. Nothing to
 *     configure for this locally — `server/public/` only exists inside the built container image
 *     (see the root `Dockerfile`), so local dev (`npm run dev` in `frontend/`) is unaffected.
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
 *   DELETE /api/trucks/:id                           [admin]  job_trucks rows cascade-delete; any
 *                                                     truckDrivers entry naming this truck is cleared too
 *   POST  /api/trucks/reorder                        [admin]  body: {truckIds: [...]} — every
 *                                                              current truck id, in the new display order
 *   POST  /api/drivers                               [admin]  body: {name, phone, cdl}
 *   PATCH /api/drivers/:id                           [admin]  body: any driver field(s) to change
 *   DELETE /api/drivers/:id                          [admin]  any job's truckDrivers entry naming this
 *                                                     driver is cleared too
 *   POST  /api/jobs                                   [admin+dispatcher] body: {customer, type, date, endDate,
 *                                                              startTime, origin, destination, trucksNeeded,
 *                                                              crewSize} — creates a manual "placeholder" job,
 *                                                              unassigned. type is 'local'/'long_distance'
 *                                                              (falls back to inferring from date vs endDate
 *                                                              if omitted). customer/type/origin/destination/
 *                                                              trucksNeeded/crewSize are all optional.
 *   PATCH /api/jobs/:id                              [admin+dispatcher] body: any job field(s), incl. truckIds[]
 *                                                              (removing a truck also clears its truckDrivers entry).
 *                                                              Two independent locks, both added
 *                                                              2026-09-08, split apart 2026-09-14 (see
 *                                                              db.js's MANUAL_EDIT_LOCK_FIELDS comment
 *                                                              for the full history): a PATCH that
 *                                                              actually changes customer/type/date/
 *                                                              endDate/startTime/endTime/duration/
 *                                                              origin/destination/crewSize/notes
 *                                                              (MANUAL_EDIT_LOCK_FIELDS) locks the
 *                                                              job's DETAIL fields — every sync source
 *                                                              (REST poll, calendar, Smart Insights)
 *                                                              then skips the whole job entirely on
 *                                                              their next run. A PATCH that changes
 *                                                              truckIds/trucksNeeded (TRUCK_LOCK_FIELDS)
 *                                                              separately locks just the TRUCK
 *                                                              assignment — see db.js's
 *                                                              syncTruckAssignmentUnlessLocked, used by
 *                                                              the calendar sync. Either kind of
 *                                                              correction can happen without the other
 *                                                              also freezing. See POST
 *                                                              /api/jobs/:id/resync to undo both.
 *   POST  /api/jobs/:id/resync                       [admin+dispatcher] clears BOTH locks above (detail
 *                                                              and truck-assignment) so this job resumes
 *                                                              accepting automatic updates from its sync
 *                                                              source(s) — doesn't force an immediate
 *                                                              re-sync, just lifts the block for the
 *                                                              next one.
 *   DELETE /api/jobs/:id                             [admin+dispatcher] soft-deletes a job — archives it to
 *                                                              the deletedJobs collection (with who/when) instead
 *                                                              of a hard delete, offered in the UI for every job
 *                                                              since 2026-09-24 (was placeholder-only before), see
 *                                                              db.js's deleteJob doc comment
 *   GET   /api/deleted-jobs                          [admin]  lists every archived (soft-deleted) job, for the
 *                                                              hidden "Deleted Jobs" panel — see db.js
 *   POST  /api/deleted-jobs/:id/restore               [admin]  restores an archived job back into jobs
 *   DELETE /api/deleted-jobs/:id                      [admin]  permanently removes one archived job — true hard
 *                                                              delete, no further recovery, see db.js's
 *                                                              permanentlyDeleteArchivedJob doc comment
 *   POST  /api/jobs/:id/set-truck-driver             [admin+dispatcher] body: {truckId, driverId} — assigns
 *                                                              (driverId: null clears) the driver for one
 *                                                              truck on this job; truckId must already be
 *                                                              one of the job's assigned trucks. A real
 *                                                              change here locks the truck assignment
 *                                                              (same lock PATCH /api/jobs/:id sets for
 *                                                              truckIds/trucksNeeded above — see db.js's
 *                                                              markTruckAssignmentManual) but not the
 *                                                              job's detail fields.
 *   POST  /api/jobs/:id/color                        [admin+dispatcher+crew] body: {color} — one of
 *                                                              'green'/'yellow'/'purple'/'red'/'orange', or
 *                                                              null to clear back to the automatic category
 *                                                              color. The ONE job field crew can touch (added
 *                                                              2026-09-15 at the user's request) — kept as
 *                                                              its own endpoint rather than opening the
 *                                                              generic PATCH above so nothing else about a
 *                                                              job becomes crew-editable.
 *   POST  /api/reset-to-sample-data                  [admin]
 *   POST  /api/clear-jobs                            [admin]  empties jobs only — trucks/drivers untouched
 *   POST  /api/sync-now?from=YYYY-MM-DD&to=YYYY-MM-DD [admin]  triggers an immediate SmartMoving sync
 *                                                              via the REST API poll sweep (see
 *                                                              pollSweep) — booked jobs only (see
 *                                                              mapJobs.js's BOOKED_STATUSES). The iCal
 *                                                              feed (icalClient.js/pollIcalFeed) is set
 *                                                              aside for now, not deleted — see
 *                                                              README's "Webhooks vs. polling". Split
 *                                                              2026-09-08 from the Calendar sync below —
 *                                                              this endpoint no longer runs
 *                                                              pollGoogleCalendarFeed() at all, so a slow
 *                                                              or timed-out poll sweep can no longer
 *                                                              block or mask the calendar sync's own run.
 *   POST  /api/calendar-sync-now                     [admin]  triggers an immediate Google Calendar sync
 *                                                              (see pollGoogleCalendarFeed) — the same
 *                                                              sweep calendarSweepScheduled /
 *                                                              calendarSweepScheduled403pm already run on
 *                                                              their own schedule (functions-index.js),
 *                                                              now independently reachable on demand
 *                                                              too. Added 2026-09-08 alongside the split
 *                                                              above.
 *   GET   /api/schedulable-jobs?statuses=4           [admin]  SmartMoving-sourced jobs only (debugging)
 *   POST  /api/smart-insights/sync-now                [admin]  triggers an immediate Smart Insights
 *                                                              report sync (Gmail -> parse -> upsert,
 *                                                              see smartInsightsSync.js) — same
 *                                                              pipeline as the daily 6am ET
 *                                                              smartInsightsSyncScheduled function.
 *                                                              Jobs land with source:
 *                                                              'smartmoving-insights'; duplicate
 *                                                              detection against manually-created
 *                                                              placeholders is computed client-side,
 *                                                              see frontend/src/utils/jobs.js's
 *                                                              getPlaceholderDuplicates().
 *   POST  /webhooks/smartmoving?secret=...           [public, secret-checked] SmartMoving webhook receiver
 *   GET   /api/usage?days=14                        [any user] SmartMoving API calls per day/month, by source, vs. daily budget
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// Loads server/.env into process.env (shared with create-admin.js and any other CLI script — see
// load-env.js for why this used to be inline here and why that was a bug). On AWS App Runner
// there's no .env file (config comes from env vars / Secrets Manager set on the service), so this
// is a no-op there — see load-env.js.
require('./load-env');

const db = require('./db');
const auth = require('./auth');
const { sendOtpEmail, otpEmailConfigured } = require('./emailer');
const {
  getJobsByOpportunityId, getOpportunityDetails,
  getAllCrewMembers, getAllJobsByCrewMemberId, getAllCustomersWithOpportunities,
} = require('./smartmovingClient');
const { mapOpportunityToJobs } = require('./mapOpportunity');
const { OPPORTUNITY_STATUS, BOOKED_STATUSES, smartMovingIntDateToIso } = require('./mapJobs');
const { fetchIcalEvents } = require('./icalClient');
const { fetchCalendarEvents } = require('./googleCalendarClient');
const { mapIcalEventToJob, parseDescription } = require('./mapIcalEvent');
const { syncSmartInsights } = require('./smartInsightsSync');
const apiUsage = require('./apiUsage');

const PORT = process.env.PORT || 8787;
// .trim() guards against a real bug hit 2026-09-29: `firebase functions:secrets:set` reads its
// value from stdin, and PowerShell appends a trailing newline whenever it pipes a string to a
// native command (e.g. `Get-Content secret.txt | firebase functions:secrets:set ...`) — even when
// the source file itself has none. That silently baked a trailing \n/\r\n into the stored secret,
// so every webhook delivery 401'd (SmartMoving's clean secret could never equal the stored
// clean-secret-plus-newline) regardless of whether the secret was sent via header or query param.
// Trimming here makes the comparison tolerant of that either way, on top of setting the secret via
// `--data-file` instead of stdin going forward (see server/README.md).
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || '').trim();
const DEFAULT_STATUSES = [4]; // Booked — jobs that are past quoting and need to be dispatched
// Default bumped from 15 -> 120 on 2026-08-18 when REST polling went back to being the primary
// sync path (iCal set aside — see pollIcalFeed's doc comment). 15 minutes is the exact interval
// that burned through this account's ~20,000-call/month Basic-tier quota in about 2 days the last
// time REST polling was primary; the booked-only status filter in pollSweep cuts call volume some,
// but not enough to justify going back anywhere near that frequent. Override via env if needed.
const POLL_INTERVAL_MINUTES = process.env.POLL_INTERVAL_MINUTES !== undefined ? Number(process.env.POLL_INTERVAL_MINUTES) : 120;
const POLL_LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS) || 7;
// The iCal feed (see icalClient.js) is a single account-wide feed covering every branch on this
// SmartMoving account — confirmed live 2026-08-18 it included a second branch ("Campbell Moving
// and Storage") alongside this app's own ("Around Town Movers"). Filter to just this app's branch
// so other branches' jobs never land on this scheduler's board.
const ICAL_BRANCH_FILTER = process.env.SMARTMOVING_ICAL_BRANCH || 'Around Town Movers';
const POLL_LOOKAHEAD_DAYS = Number(process.env.POLL_LOOKAHEAD_DAYS) || 60;
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
// Google's OAuth "Testing" publishing status auto-expires a refresh token exactly 7 days after
// it's issued, no matter how often it's used — see smartInsightsGmail.js's file header. Used by
// GET /api/gmail-auth-status to estimate when the next re-auth is due from when
// gmail-oauth-setup.js last recorded one; not configurable via env because it's Google's rule, not
// this app's, so there's nothing meaningful to override it with.
const GMAIL_AUTH_EXPIRY_DAYS = 7;
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
  // Cloud Functions/Cloud Run runs multiple separate container instances over time — especially
  // with minInstances: 0, where an idle instance can be recycled and a new one cold-started for
  // the very next request. A random-per-instance fallback here means a session token signed by
  // one instance silently fails verification on another: login appears to succeed, then every
  // request right after 401s, with nothing in the logs pointing at why (this exact fallback used
  // to only warn from inside start()'s server.listen() callback, which functions-index.js never
  // calls — so it failed completely silently in this environment until now). Harmless for local
  // dev/AWS (a single long-running process, restart just logs everyone out) but wrong here — fail
  // loudly instead of guessing wrong for every login.
  if (process.env.K_SERVICE || process.env.FUNCTION_TARGET) {
    throw new Error(
      'SESSION_SECRET is not set. Cloud Functions cannot safely fall back to a random per-instance ' +
      'secret — sessions would break unpredictably across cold starts. Set it via: ' +
      'firebase functions:secrets:set SESSION_SECRET'
    );
  }
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  sessionSecretIsEphemeral = true;
}

/* ---------- Bootstrap the first admin account ----------
   Only runs when the users collection is empty, so it never overwrites real accounts. Set
   ADMIN_EMAIL in .env for the very first run. If ADMIN_PASSWORD is also set, the account can sign
   in with it immediately; otherwise it's created with no password, and whoever owns that email
   needs to use "Forgot password?" on the login screen (which requires SMTP_USER/SMTP_PASS to be
   configured — see server/README.md) to set one before they can sign in. Safe to remove
   ADMIN_EMAIL/ADMIN_PASSWORD afterward (or leave them — they're only consulted while there are
   zero users). Called once from the async startup sequence at the bottom of this file, after
   `db.initDb()` has run and before the server starts accepting requests. */
async function bootstrapAdmin() {
  if ((await db.listUsers()).length > 0) return;
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
  await db.createUser({ id, email, role: 'admin', passwordHash });
  console.log(passwordHash
    ? `Granted admin access to: ${email} (signs in with the ADMIN_PASSWORD you set in .env — change it via "Forgot password?" afterward).`
    : `Granted admin access to: ${email} — no password set yet. Use "Forgot password?" on the login screen to set one (requires email sending to be configured), or run: node create-admin.js ${email} admin <password>`);
}

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
  // Cloud Functions (server/functions-index.js's onRequest wrapper) already buffers and parses the
  // body before this handler ever runs, exposing it as req.rawBody — the request stream itself has
  // already been consumed by that point, so req.on('data', ...) below would never fire and this
  // would hang forever waiting on a stream that's already drained. Plain Node http (local dev, the
  // AWS container) has no such thing, so it falls through to the manual read exactly as before.
  if (req.rawBody !== undefined) {
    if (!req.rawBody || !req.rawBody.length) return {};
    return JSON.parse(req.rawBody.toString('utf8'));
  }
  const raw = await readRequestBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

/* ---------- Auth helpers ----------
   getCurrentUser() re-reads the user row from the database on every call rather than trusting
   anything cached in the token, so a role change or account deletion takes effect on the user's
   very next request instead of waiting for their session to expire. */
async function getCurrentUser(req) {
  const cookies = auth.parseCookies(req);
  const token = cookies[auth.COOKIE_NAME];
  if (!token) return null;
  const payload = auth.verifySessionToken(token, SESSION_SECRET);
  if (!payload) return null;
  const row = await db.getUserById(payload.sub);
  if (!row) return null;
  return { id: row.id, email: row.email, role: row.role };
}

async function requireAuth(req) {
  const user = await getCurrentUser(req);
  if (!user) { const err = new Error('Not logged in'); err.status = 401; throw err; }
  return user;
}

function requireRole(user, roles) {
  if (!roles.includes(user.role)) { const err = new Error('Not allowed for your role'); err.status = 403; throw err; }
}

// Only ever used to build a job's audit-log entry (see db.js's logJobChange, called right after
// each of the job routes below, at the user's request 2026-09-02) — a plain shallow old-vs-new diff
// across every key either side has. `id` is skipped (it never changes — a different id is a
// different job, not an update to this one). Object/array-valued fields (truckIds, truckDrivers)
// are compared via JSON.stringify rather than by reference, since Firestore always hands back a
// fresh object/array on every read — a reference-equality check would report every job as "changed"
// on every single update regardless of whether anything real did. Fine to run on every human-driven
// edit; this never runs on the sync paths' much higher write volume (and never should — see
// logJobChange's own doc comment on why sync writes deliberately don't call it at all).
function diffJobFields(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.delete('id');
  keys.forEach((key) => {
    // Normalized to `?? null` up front, not just when recording the diff below — a field that's
    // explicitly `null` on one side (every field docToJob returns is always present, even if the
    // stored value is null) and simply absent/`undefined` on the other (e.g. a caller-supplied
    // `after` object that only carries some keys) means the same thing here: "no value." Without
    // this, those two would incorrectly diff as a change on every comparison involving an object
    // that doesn't carry every field Firestore does.
    const a = (before ? before[key] : undefined) ?? null;
    const b = (after ? after[key] : undefined) ?? null;
    const isObj = (v) => v !== null && typeof v === 'object';
    const same = (isObj(a) || isObj(b)) ? JSON.stringify(a) === JSON.stringify(b) : a === b;
    if (!same) changes[key] = { from: a, to: b };
  });
  return changes;
}

/* ---------- SmartMoving sync diagnostics (state kept for /api/health) ---------- */
let lastPollAt = null;
let lastPollError = null;
let lastIcalSyncAt = null;
let lastIcalSyncError = null;
let lastCalendarSyncAt = null;
let lastCalendarSyncError = null;
let lastWebhookAt = null;
const recentWebhookEvents = []; // small ring buffer for /api/health diagnostics
const MAX_EVENT_LOG = 20;
function recordEvent(entry) {
  recentWebhookEvents.unshift({ at: new Date().toISOString(), ...entry });
  if (recentWebhookEvents.length > MAX_EVENT_LOG) recentWebhookEvents.length = MAX_EVENT_LOG;
}

/**
 * Was the primary SmartMoving sync path from 2026-08-18 for a short window — see icalClient.js's
 * header for why it existed: the REST API's 20,000-calls/month Basic-tier quota got exhausted by
 * the old (leads-based) pollSweep() running every 15 minutes, mid live team test. Set aside again
 * (not deleted — still reachable via POST /api/sync-now with no from/to, see this file's header
 * comment) once pollSweep() itself got a "booked jobs only" status filter that cuts its own call
 * volume — see hydrateOpportunity's doc comment and mapJobs.js's BOOKED_STATUSES. Kept around
 * because the underlying feed still works and this doesn't carry the same quota risk if a future
 * need for a faster/free sync path comes back.
 *
 * Note: unlike pollSweep(), this does NOT filter by opportunity status — the iCal feed's event
 * shape doesn't expose one (see mapIcalEvent.js), so every job on the feed gets imported regardless
 * of booked/quote/lead stage. Worth fixing if this is ever un-shelved as a primary path again.
 *
 * Also auto-assigns truckIds on brand-new jobs: each event's "Trucks:" text (mapIcalEvent.js) is
 * matched against every truck's `smartMovingLabels` (set via the Admin > Trucks panel) via
 * db.findTruckIdBySmartMovingLabel. Only applies at creation — db.upsertSmartMovingJob never
 * touches truckIds on a job that already exists, so it can't undo a dispatcher's manual reassignment
 * on a later re-sync. Jobs whose "Trucks:" text doesn't match any truck's labels just keep
 * truckIds: [] with the raw text preserved on smartMovingTruckText for a dispatcher to read and
 * assign manually — no risk of a wrong auto-assignment from an unmapped/misspelled label.
 */
async function pollIcalFeed() {
  let jobCount = 0;
  let skippedOtherBranch = 0;
  let skippedUnparseable = 0;
  let autoAssignedCount = 0;
  const errors = [];

  try {
    const [events, { trucks }] = await Promise.all([fetchIcalEvents(), db.getState()]);

    for (const event of events) {
      let job;
      try {
        job = mapIcalEventToJob(event);
      } catch (err) {
        skippedUnparseable += 1;
        errors.push({ uid: event.uid, message: `mapping failed: ${err.message}` });
        continue;
      }
      if (!job) { skippedUnparseable += 1; continue; }

      // Branch filter needs the raw parsed value, not anything mapIcalEventToJob kept — re-parse
      // just the branch line rather than threading it through the job shape for one field.
      const branch = parseDescription(event.description).branch;
      if (branch && branch !== ICAL_BRANCH_FILTER) { skippedOtherBranch += 1; continue; }

      const matchedTruckId = db.findTruckIdBySmartMovingLabel(trucks, job.smartMovingTruckText);
      if (matchedTruckId) { job.truckIds = [matchedTruckId]; autoAssignedCount += 1; }

      try {
        await db.upsertSmartMovingJob(job);
        jobCount += 1;
      } catch (err) {
        errors.push({ uid: event.uid, jobId: job.id, message: err.message });
      }
    }

    lastIcalSyncAt = new Date().toISOString();
    lastIcalSyncError = null;
  } catch (err) {
    lastIcalSyncAt = new Date().toISOString();
    lastIcalSyncError = err.message;
    errors.push({ message: `feed fetch failed: ${err.message}` });
  }

  recordEvent({
    type: 'ical-sweep', jobCount, autoAssignedCount, skippedOtherBranch, skippedUnparseable,
    errorCount: errors.length,
  });
  return { jobCount, autoAssignedCount, skippedOtherBranch, skippedUnparseable, errors };
}

// Driver auto-assignment, OFF as of 2026-08-27 per explicit request ("for now don't bother about
// the driver, just assign the job to the truck") — trucks are matched off the truck board's own
// smartMovingLabels regardless of this flag; only the Crew:-text-to-driver matching pauses. Kept as
// a one-line flag rather than deleting db.findDriverIdBySmartMovingLabel/the DriverAdminList.jsx
// label field/etc. so turning it back on later is exactly that: flip this back to true. No data is
// lost while this is off — smartMovingCrewText is still recorded on every synced job either way,
// so a dispatcher can always see (and re-running a sync after flipping this on can still pick up)
// whichever crew text SmartMoving sent, even from jobs synced while this was disabled.
const DRIVER_AUTO_ASSIGN_ENABLED = false;

/**
 * Added 2026-08-26, at the user's explicit request to merge the calendar/iCal data with the Smart
 * Insights report data and have truck (and, while DRIVER_AUTO_ASSIGN_ENABLED above is true, driver)
 * assignments made automatically "as in SmartMoving." Same event-shape and mapping logic as
 * pollIcalFeed() above (both feed the same mapIcalEventToJob(), see googleCalendarClient.js's
 * header for why) but reads from a Google Calendar SmartMoving is synced into
 * (googleCalendarClient.js) instead of polling the bare iCal feed URL.
 *
 * CHANGED 2026-08-27, at the user's explicit request ("don't add new jobs" — a live run the day
 * before had synced 341 calendar events against only 258 Smart Insights counterparts, and the other
 * 83 landed as brand-new, truck-less, "non-binding" entries cluttering the board): this is now
 * ENRICHMENT ONLY. For each calendar event, if there's no existing job for that job number already
 * on the board — neither a doc under its own `SM-` id from an earlier sync, nor a `SI-` counterpart
 * from a Smart Insights report — the event is now SKIPPED, not turned into a new job. See
 * db.mergeCalendarDataOntoExistingJob (used here instead of db.upsertSmartMovingJob) for the exact
 * matching logic; db.upsertSmartMovingJob itself is untouched and still creates new jobs for the
 * REST poll (pollSweep/hydrateOpportunity), which is unaffected by this change.
 *
 * What "enrichment" still means for a job that DOES already exist:
 *
 *  1. Truck auto-assignment/sync. Each event's "Trucks:" text (mapIcalEvent.js) is matched against
 *     every truck's `smartMovingLabels` (Admin > Trucks panel) via db.findTruckIdBySmartMovingLabel.
 *     Until 2026-09-14 this only ever FILLED an empty assignment slot (fillAssignmentIfEmpty in
 *     db.js) — now (see db.js's syncTruckAssignmentUnlessLocked) it actively keeps the job's truck in
 *     step with this match, including clearing it if the calendar shows none, UNLESS a dispatcher has
 *     manually fixed that job's truck assignment here (db.js's truckLockedAt — see
 *     markTruckAssignmentManual). A dispatcher's locked assignment is still never overwritten by a
 *     later sync; an unlocked one now genuinely tracks SmartMoving instead of only ever growing.
 *
 *  2. Driver auto-assignment (currently disabled — see DRIVER_AUTO_ASSIGN_ENABLED above). When on:
 *     each event's "Crew:" text is matched against every driver's `smartMovingLabels` (Admin >
 *     Drivers panel) via db.findDriverIdBySmartMovingLabel — EXACT match only, per explicit
 *     instruction (no fuzzy/best-effort name guessing, since crew text format is "wildly
 *     inconsistent" — see that function's doc comment). A driver is only ever recorded
 *     (`job.truckDrivers[truckId] = driverId`) when a truck ALSO matched, since truckDrivers is
 *     keyed by truck id.
 *
 *  3. Date fields, including — since 2026-08-27 — a real end date for long-distance jobs when the
 *     calendar event itself spans more than one day (see mapIcalEvent.js's endDate derivation),
 *     extending the job on the board from its start date through its actual delivery date instead
 *     of collapsing to a single day.
 *
 * CHANGED 2026-08-31, at the user's explicit request ("allow both branches"): this used to skip any
 * event whose Branch: line wasn't ICAL_BRANCH_FILTER ("Around Town Movers"), the same filter
 * pollIcalFeed() below still applies. That made sense back when this sync could CREATE new board
 * entries (branch filtering kept a second SmartMoving branch on the same account, "Campbell Moving
 * and Storage," off this board entirely) — but since the 2026-08-27 "don't add new jobs" change
 * above, this function only ever enriches a job that's ALREADY on the board, and the Smart Insights
 * report sync (smartInsightsSync.js) was never branch-filtered in the first place, so Campbell jobs
 * were already landing on the board that way — just never getting truck/crew/date enrichment from
 * the calendar, because THIS filter (not the report sync) was the only thing still branch-scoped.
 * Confirmed live: job 23917-1, a real Campbell-branch job already on the board via Smart Insights,
 * had a calendar event with a real, matching truck ("ZCMS - 377" -> YCMS 377) that this filter was
 * silently discarding. Removed here — enrichment now applies regardless of branch, matching how the
 * report sync already treats both branches as one shared pool. NOT changed in pollIcalFeed() below,
 * which is dormant but CAN still create new board entries if ever reactivated — that path keeps the
 * original branch scoping so reactivating it doesn't suddenly start creating Campbell-branch jobs on
 * this board as a side effect.
 */
async function pollGoogleCalendarFeed() {
  let matchedCount = 0;
  let mergedCount = 0;
  let skippedNoMatch = 0;
  let skippedUnparseable = 0;
  let autoAssignedTruckCount = 0;
  let autoAssignedDriverCount = 0;
  // Manual edit lock (added 2026-09-08 — see db.js's markJobManuallyEdited/mergeCalendarDataOntoExistingJob):
  // counted separately from skippedNoMatch below — this is a job the calendar sync DID find, it's
  // just deliberately leaving it alone because a dispatcher hand-corrected it.
  let skippedManualEdit = 0;
  const errors = [];

  try {
    const [events, { trucks, drivers }] = await Promise.all([fetchCalendarEvents(), db.getState()]);

    for (const event of events) {
      let job;
      try {
        job = mapIcalEventToJob(event);
      } catch (err) {
        skippedUnparseable += 1;
        errors.push({ uid: event.uid, message: `mapping failed: ${err.message}` });
        continue;
      }
      if (!job) { skippedUnparseable += 1; continue; }

      const matchedTruckId = db.findTruckIdBySmartMovingLabel(trucks, job.smartMovingTruckText);
      if (matchedTruckId) {
        job.truckIds = [matchedTruckId];
        autoAssignedTruckCount += 1;
        if (DRIVER_AUTO_ASSIGN_ENABLED) {
          const matchedDriverId = db.findDriverIdBySmartMovingLabel(drivers, job.smartMovingCrewText);
          if (matchedDriverId) {
            job.truckDrivers = { [matchedTruckId]: matchedDriverId };
            autoAssignedDriverCount += 1;
          }
        }
      }

      try {
        const result = await db.mergeCalendarDataOntoExistingJob(job);
        if (result.matched) {
          matchedCount += 1;
          if (result.merged) mergedCount += 1;
          if (result.skippedManualEdit) skippedManualEdit += 1;
        } else {
          skippedNoMatch += 1;
        }
      } catch (err) {
        errors.push({ uid: event.uid, jobId: job.id, message: err.message });
      }
    }

    lastCalendarSyncAt = new Date().toISOString();
    lastCalendarSyncError = null;
  } catch (err) {
    lastCalendarSyncAt = new Date().toISOString();
    lastCalendarSyncError = err.message;
    errors.push({ message: `calendar fetch failed: ${err.message}` });
  }

  recordEvent({
    type: 'calendar-sweep', matchedCount, mergedCount, skippedNoMatch, autoAssignedTruckCount,
    autoAssignedDriverCount, skippedUnparseable, skippedManualEdit, errorCount: errors.length,
  });
  return {
    matchedCount, mergedCount, skippedNoMatch, autoAssignedTruckCount, autoAssignedDriverCount,
    skippedUnparseable, skippedManualEdit, errors,
  };
}

/**
 * Fetches one opportunity's full detail + (best-effort) precise per-job timing, maps it into
 * scheduler job objects, and upserts each into the database. Shared by both the webhook handler
 * and the poll sweep so they can't drift out of sync with each other.
 */
async function hydrateOpportunity(opportunityId) {
  const opportunity = await getOpportunityDetails(opportunityId);

  // "Booked jobs only" filter (2026-08-18) — a live dispatch board shouldn't be cluttered with
  // quotes/leads that might never actually happen, and importing them wasted API calls on the
  // Basic tier's 20,000/month quota for opportunities that usually weren't schedulable anyway.
  // Checked here, not before this getOpportunityDetails call, because `status` is only reliably
  // known once we've fetched the opportunity itself — but skipping the SECOND call
  // (getJobsByOpportunityId, the more expensive premium-tier one) for anything that fails this
  // check still meaningfully cuts call volume. See mapJobs.js's BOOKED_STATUSES for exactly which
  // statuses count and why. Does NOT retroactively remove a job that was already imported while
  // Booked and has since moved to a non-booked status (e.g. Cancelled) — this app has no
  // delete-on-cancel logic anywhere yet, that's a separate gap, not something this filter covers.
  if (!BOOKED_STATUSES.has(opportunity.status)) return [];

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
  for (const job of mappedJobs) await db.upsertSmartMovingJob(job);
  return mappedJobs;
}

/* ---------- Poll sweep (primary sync path again as of the 2026-08-18 "booked jobs only"
   redesign — see mapJobs.js's BOOKED_STATUSES and hydrateOpportunity's doc comment above. The
   iCal feed (server/icalClient.js) briefly held this role but is set aside for now, not deleted —
   see README's "Webhooks vs. polling" for why. ---------- */
/**
 * Two independent discovery sources, merged before hydrating (a third, GET /api/leads, was
 * dropped — see below):
 *
 *  1. GET /api/crew-members/{id}/jobs — real JOBS, filtered by service date, assigned to actual
 *     crew. Requires enumerating crew members first (no status filter — see getAllCrewMembers's
 *     doc comment; filtering to Active-only was found 2026-08-10 to silently miss real jobs on
 *     crew with any other status). Crew only ever get assigned to real, already-booked work, so
 *     this source's opportunities are implicitly booked already — hydrateOpportunity's status
 *     check still runs on them as a safety net, at the cost of one call per opportunity to learn
 *     that (this endpoint's own job shape carries no status field to pre-filter on before that).
 *  2. GET /api/customers — lists customers filtered by job service date, each with
 *     opportunities[] across the FULL status range and their jobs[] embedded. Pre-filtered by
 *     `opp.status` right here, before it's even added to the discovery Map, to skip opportunities
 *     that clearly aren't booked WITHOUT spending a hydration call to find that out — this is the
 *     single biggest lever on the account's monthly call quota, since this source alone
 *     previously found ~977 opportunities-with-jobs in one real test, most of which weren't
 *     Booked. If `opp.status` is ever missing/undefined on a real response (a shape mismatch, not
 *     expected per the confirmed-live shape in mock-smartmoving-server.js), this fails OPEN —
 *     still includes it, letting hydrateOpportunity's authoritative check decide, rather than
 *     silently dropping a real job over an unexpected response shape.
 *
 * DROPPED: GET /api/leads. Confirmed live in the dev portal (2026-08-10) to ONLY EVER return
 * New/InProgress opportunities by default — by definition it can never surface a Booked+
 * opportunity, so under a "booked jobs only" sync it contributed nothing but wasted calls. Its
 * only value (earliest-possible signal a lead exists, a free customer name) doesn't matter once
 * the whole point is to keep pre-booking pipeline stuff OFF the live board.
 *
 * Each opportunity discovered by either source is hydrated exactly once via the shared
 * hydrateOpportunity() (a Map dedupes by opportunityId before the hydration loop runs) — that
 * function is the single source of truth for the booked-status check, so a customer-sourced
 * opportunity that slips past this file's fail-open pre-filter still gets caught there.
 */
/*
 * DIFF-ONLY RECONCILE (2026-09-30, user decision). Now that SmartMoving webhooks push every new /
 * changed opportunity straight into Firestore, re-downloading every booked opportunity in a
 * -7..+60 day window each run is wasted quota (≈30 crew-member calls + customer pages + 2 calls per
 * opportunity). Default `mode: 'diff'` now:
 *   1. Discovers via GET /api/customers ONLY (a few paged calls; each opportunity already carries
 *      its status and its jobs' service dates). The crew-member source is skipped.
 *   2. Compares against what's already in Firestore (db.listSmartMovingJobsInRange) and hydrates
 *      ONLY opportunities that are missing, whose status changed, or whose job date(s) moved —
 *      i.e. exactly what a missed/failed webhook would have left behind.
 * `mode: 'full'` keeps the old behaviour (both discovery sources, hydrate everything) for a manual
 * backfill via POST /api/sync-now?full=1.
 *
 * DAILY BUDGET: every SmartMoving call is counted in Firestore (apiUsage.js). The sweep refuses to
 * start once the scheduler's daily budget (SMARTMOVING_DAILY_BUDGET, default 1,000) is used up, and
 * stops hydrating mid-run when it runs out. Webhooks are never blocked by the budget — live sync
 * keeps working; only this reconciliation backstop pauses. `ignoreBudget: true` (admin manual sync
 * only) overrides.
 */
function smartMovingDateToIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const iso = smartMovingIntDateToIso(value);
  if (iso) return iso;
  const str = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : null;
}

function yyyymmddToIso(n) { return smartMovingIntDateToIso(n); }

/** Why (if at all) an opportunity from GET /api/customers needs a hydration call. */
function diffReason(opp, existingJobs) {
  if (!existingJobs || existingJobs.length === 0) return 'missing';
  if (opp.status !== undefined && opp.status !== null &&
      existingJobs.some(j => !j.manuallyEditedAt && j.smartMovingStatusCode !== undefined &&
        j.smartMovingStatusCode !== null && Number(j.smartMovingStatusCode) !== Number(opp.status))) {
    return 'status-changed';
  }
  const smDates = [...new Set((opp.jobs || []).map(j => smartMovingDateToIso(j.serviceDate ?? j.jobDate)).filter(Boolean))];
  const haveDates = new Set(existingJobs.map(j => j.date));
  const uncovered = smDates.filter(d => !haveDates.has(d));
  // A dispatcher's manually-edited job intentionally sits on a different date than SmartMoving's —
  // let each one "cover" one uncovered date so we don't re-hydrate it every day for nothing
  // (upsertSmartMovingJob would skip it anyway).
  const manualCount = existingJobs.filter(j => j.manuallyEditedAt).length;
  if (uncovered.length > manualCount) return 'date-changed';
  return null;
}

async function pollSweep(options = {}) {
  return apiUsage.withApiSource('poll', () => pollSweepInner(options));
}

async function pollSweepInner({ from: fromOverride, to: toOverride, mode = 'diff', ignoreBudget = false } = {}) {
  const from = fromOverride ?? todayYyyymmdd(-POLL_LOOKBACK_DAYS);
  const to = toOverride ?? todayYyyymmdd(POLL_LOOKAHEAD_DAYS);
  const errors = [];
  let crewJobOpportunityCount = 0;
  let customerJobOpportunityCount = 0;
  let jobCount = 0;
  let skippedNotBookedCount = 0;
  let skippedUpToDateCount = 0;
  let sourcesFailed = 0;
  let stoppedForBudget = false;
  const reasons = {};

  let budget = await apiUsage.getBudgetStatus().catch(() => null);
  if (!ignoreBudget && budget && budget.exceeded) {
    lastPollAt = new Date().toISOString();
    recordEvent({ type: 'poll-sweep-skipped-budget', used: budget.used, budget: budget.budget });
    return { skipped: 'daily-budget-exceeded', budget, errors, from, to, mode, jobCount: 0 };
  }

  // opportunityId -> customerName
  const opportunityIds = new Map();

  if (mode === 'full') {
    try {
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
  }

  // Firestore snapshot of what webhooks / earlier syncs already stored, keyed by opportunity id.
  let existingByOpp = null;
  if (mode === 'diff') {
    try {
      const existing = await db.listSmartMovingJobsInRange(yyyymmddToIso(from), yyyymmddToIso(to));
      existingByOpp = new Map();
      existing.forEach(j => {
        const list = existingByOpp.get(j.smartMovingOpportunityId) || [];
        list.push(j);
        existingByOpp.set(j.smartMovingOpportunityId, list);
      });
    } catch (err) {
      // Can't diff without the snapshot — fall back to hydrating everything found (old behaviour)
      // rather than silently skipping real jobs.
      errors.push({ opportunityId: null, customer: null, message: `Firestore diff snapshot failed, hydrating all: ${err.message}` });
      existingByOpp = null;
    }
  }

  try {
    const customers = await getAllCustomersWithOpportunities({ fromServiceDate: from, toServiceDate: to });
    const customerOpportunityIds = new Set();
    customers.forEach(customer => {
      (customer.opportunities || []).forEach(opp => {
        if (!opp.id || !Array.isArray(opp.jobs) || opp.jobs.length === 0) return;
        // Fail OPEN on a missing/unrecognized status — only skip once we positively know it's not
        // booked.
        if (opp.status !== undefined && opp.status !== null && !BOOKED_STATUSES.has(opp.status)) return;
        customerOpportunityIds.add(opp.id);
        if (existingByOpp) {
          const reason = diffReason(opp, existingByOpp.get(opp.id));
          if (!reason) { skippedUpToDateCount += 1; return; }
          reasons[reason] = (reasons[reason] || 0) + 1;
        }
        if (!opportunityIds.has(opp.id)) opportunityIds.set(opp.id, customer.name);
      });
    });
    customerJobOpportunityCount = customerOpportunityIds.size;
  } catch (err) {
    sourcesFailed += 1;
    errors.push({ opportunityId: null, customer: null, message: `GET /api/customers: ${err.message}` });
  }

  let hydratedSinceCheck = 0;
  for (const [opportunityId, customerName] of opportunityIds) {
    if (!ignoreBudget) {
      // Re-read the real Firestore count every 20 hydrations (cheap), estimate in between
      // (each hydration ≈ 2 SmartMoving calls).
      if (hydratedSinceCheck >= 20 || !budget) {
        budget = await apiUsage.getBudgetStatus().catch(() => budget);
        hydratedSinceCheck = 0;
      }
      const estRemaining = budget ? budget.remaining - hydratedSinceCheck * 2 : Infinity;
      if (estRemaining < 2) { stoppedForBudget = true; break; }
    }
    try {
      const mappedJobs = await hydrateOpportunity(opportunityId);
      jobCount += mappedJobs.length;
      if (mappedJobs.length === 0) skippedNotBookedCount += 1;
    } catch (err) {
      errors.push({ opportunityId, customer: customerName, message: err.message });
    }
    hydratedSinceCheck += 1;
  }

  lastPollAt = new Date().toISOString();
  const expectedSources = mode === 'full' ? 2 : 1;
  lastPollError = sourcesFailed >= expectedSources ? errors[errors.length - 1].message
    : stoppedForBudget ? 'Stopped early: daily SmartMoving API budget reached' : null;
  recordEvent({
    type: 'poll-sweep', mode, crewJobOpportunityCount, customerJobOpportunityCount,
    opportunityCount: opportunityIds.size, skippedUpToDateCount, reasons, jobCount,
    skippedNotBookedCount, errorCount: errors.length, stoppedForBudget,
  });
  return {
    errors, mode, crewJobOpportunityCount, customerJobOpportunityCount, hydratedCount: opportunityIds.size,
    skippedUpToDateCount, reasons, jobCount, skippedNotBookedCount, stoppedForBudget, from, to,
  };
}

let pollTimer = null;
function startPolling() {
  if (POLL_INTERVAL_MINUTES <= 0) return; // webhook-only mode
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { pollSweep().catch(() => {}); }, POLL_INTERVAL_MINUTES * 60 * 1000);
}

// Not called from start() anymore as of 2026-08-18 — iCal is set aside as the primary sync path
// (see pollIcalFeed's doc comment), so nothing schedules this timer currently. Kept, not deleted,
// in case a faster/free sync path is needed again later; call startIcalPolling() manually or wire
// it back into start() to reactivate.
const ICAL_POLL_INTERVAL_MINUTES = process.env.ICAL_POLL_INTERVAL_MINUTES !== undefined
  ? Number(process.env.ICAL_POLL_INTERVAL_MINUTES) : 10;
let icalPollTimer = null;
function startIcalPolling() {
  if (ICAL_POLL_INTERVAL_MINUTES <= 0 || !process.env.SMARTMOVING_ICAL_URL) return;
  if (icalPollTimer) clearInterval(icalPollTimer);
  icalPollTimer = setInterval(() => { pollIcalFeed().catch(() => {}); }, ICAL_POLL_INTERVAL_MINUTES * 60 * 1000);
}

/* ---------- Webhook receiver ---------- */
// Events that mean "go re-fetch this opportunity": job-created fires for every new job regardless
// of whether it was ever a lead; opportunity-status-changed and opportunity-created catch the
// booking moment too, so between the three there's no origin-path this can miss.
const RELEVANT_EVENTS = new Set(['job-created', 'opportunity-created', 'opportunity-status-changed', 'opportunity-changed']);

async function handleWebhook(req, res, url) {
  if (WEBHOOK_SECRET) {
    // Trimmed for the same reason WEBHOOK_SECRET itself is (see that const's comment) — belt and
    // suspenders against either side (SmartMoving's own value, or a copy/paste into its webhook
    // URL) picking up stray leading/trailing whitespace.
    const headerSecret = (req.headers['x-webhook-secret'] || '').trim();
    const querySecret = (url.searchParams.get('secret') || '').trim();
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
    // Tagged 'webhook' so these calls show up separately in the daily API usage (apiUsage.js).
    const jobs = await apiUsage.withApiSource('webhook', () => hydrateOpportunity(opportunityId));
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

/* ---------- Static frontend (see the "4." doc-comment item at the top of this file) ---------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
// Only exists inside the built container image (root Dockerfile's frontend build stage) — absent
// in local dev, where the frontend runs separately via `npm run dev` on its own port instead.
const SERVING_STATIC_FRONTEND = fs.existsSync(PUBLIC_DIR);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

/**
 * Serves the built frontend for any GET/HEAD request that isn't an API or webhook path. Tries the
 * requested path as an exact static file first (JS/CSS bundles, images, etc.); falls back to
 * `index.html` for anything else (e.g. `/`, or a future client-side route) — the same "SPA
 * catchall" behavior Firebase Hosting's rewrites used to provide, just implemented directly here
 * now that one process serves both the site and the API. Deliberately runs BEFORE `requireAuth()`
 * below — the login page itself (and the JS that renders it) has to be reachable by a signed-out
 * browser, or nobody could ever reach the login form in the first place.
 *
 * Blocks path traversal (`..`) by resolving against PUBLIC_DIR and checking the result is still
 * inside it — `url.pathname` is attacker-controlled input from the request line.
 */
function serveStatic(req, res, pathname) {
  if (!SERVING_STATIC_FRONTEND) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname.startsWith('/api/') || pathname.startsWith('/webhooks/')) return false;

  const decoded = decodeURIComponent(pathname);
  let filePath = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!filePath.startsWith(PUBLIC_DIR)) filePath = PUBLIC_DIR; // traversal attempt — fall back safely

  let stat;
  try { stat = fs.statSync(filePath); } catch (err) { /* no exact file at this path */ }
  if (!stat || stat.isDirectory()) filePath = path.join(PUBLIC_DIR, 'index.html');

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      // index.html changes which hashed JS/CSS bundle it references on every deploy — never cache
      // it. The hashed asset files themselves (Vite's default build output naming) are safe to
      // cache aggressively since a new deploy gives them new filenames.
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  } catch (err) {
    return false; // no index.html either — let the normal 404 path handle it
  }
}

/* ---------- HTTP server ----------
   handleRequest is a plain (req, res) => Promise<void> function, deliberately not tied to Node's
   http module — that's what lets server/functions-index.js reuse it as-is inside a Cloud Functions
   onRequest handler (Express-like req/res objects support the same writeHead/end/on('data') calls
   Node's raw http ones do). http.createServer(handleRequest) below is only how the AWS
   container/local dev path turns it into an actual listening server. */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'OPTIONS') { sendJson(req, res, 204, {}); return; }

    if (p === '/api/health') {
      const counts = await db.getCounts(); // count() aggregation — this endpoint is public, so no full reads
      sendJson(req, res, 200, {
        ok: true,
        hasApiKey: Boolean(process.env.SMARTMOVING_API_KEY),
        webhookSecretConfigured: Boolean(WEBHOOK_SECRET),
        pollIntervalMinutes: POLL_INTERVAL_MINUTES,
        truckCount: counts.trucks, driverCount: counts.drivers, jobCount: counts.jobs,
        userCount: counts.users,
        dataStore: 'firestore',
        hasIcalUrl: Boolean(process.env.SMARTMOVING_ICAL_URL),
        hasCalendarSync: Boolean(process.env.GMAIL_OAUTH_REFRESH_TOKEN),
        lastPollAt, lastPollError, lastIcalSyncAt, lastIcalSyncError,
        lastCalendarSyncAt, lastCalendarSyncError, lastWebhookAt,
        recentEvents: recentWebhookEvents,
        apiBudget: await apiUsage.getBudgetStatus().catch(() => null),
      });
      return;
    }

    if (p === '/webhooks/smartmoving' && req.method === 'POST') {
      await handleWebhook(req, res, url);
      return;
    }

    if (serveStatic(req, res, p)) return;

    /* ---- Auth ---- */

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      const password = body.password || '';
      const row = await db.getUserByEmail(email);
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
      const row = await db.getUserByEmail(email);
      // Always the same response regardless of whether the account exists — otherwise this route
      // becomes a way to enumerate which addresses have access to the app.
      if (row) {
        const code = auth.generateOtp();
        const otpHash = auth.hashOtp(code, SESSION_SECRET);
        await db.setUserOtp(row.id, otpHash, new Date(Date.now() + auth.OTP_TTL_MS).toISOString());
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
      const row = await db.getUserByEmail(email);
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
      await db.setUserPassword(row.id, auth.hashPassword(newPassword));
      const token = auth.createSessionToken(row, SESSION_SECRET);
      recordEvent({ type: 'password-reset', email });
      sendJson(req, res, 200, publicUser(await db.getUserById(row.id)), { 'Set-Cookie': auth.sessionCookieHeader(token, COOKIE_SECURE) });
      return;
    }

    if (p === '/api/auth/status' && req.method === 'GET') {
      sendJson(req, res, 200, { otpEmailConfigured: otpEmailConfigured(), devBypassEnabled: DEV_BYPASS_LOGIN });
      return;
    }

    if (p === '/api/auth/dev-login' && req.method === 'GET') {
      if (!DEV_BYPASS_LOGIN) { sendJson(req, res, 404, { error: 'Not found' }); return; }
      const requestedRole = url.searchParams.get('role');
      const users = await db.listUsers();
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
      const user = await getCurrentUser(req);
      if (!user) { sendJson(req, res, 401, { error: 'Not logged in' }); return; }
      sendJson(req, res, 200, user);
      return;
    }

    /* ---- Everything below here requires a logged-in user ---- */
    const currentUser = await requireAuth(req);

    /* ---- SmartMoving API usage (2026-09-30) — any logged-in user can view, it's read-only ---- */
    if (p === '/api/usage' && req.method === 'GET') {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 14, 1), 62);
      const [budget, today, month, recent] = await Promise.all([
        apiUsage.getBudgetStatus(), apiUsage.getDayUsage(), apiUsage.getMonthUsage(), apiUsage.getRecentDays(days),
      ]);
      sendJson(req, res, 200, {
        budget, today, month, monthlyQuota: apiUsage.MONTHLY_QUOTA,
        monthRemaining: Math.max(apiUsage.MONTHLY_QUOTA - (month.total || 0), 0),
        recent: recent.map(d => ({ date: d.date, total: d.total || 0, bySource: d.bySource || {}, status429: d.status429 || 0 })),
      });
      return;
    }

    /* ---- User management (admin only) ---- */

    if (p === '/api/users' && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, await db.listUsers());
      return;
    }

    if (p === '/api/users' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      // Company-domain addresses are always allowed; anything else needs to have been explicitly
      // added to the allowed-external-emails list first (see the routes below and db.js's
      // isEmailAllowedExternally doc comment) — e.g. a partner/subcontractor's own email address.
      if (!auth.isCompanyEmail(email) && !(await db.isEmailAllowedExternally(email))) {
        sendJson(req, res, 400, {
          error: `Email must be a @${auth.EMAIL_DOMAIN} address, or first added under "External Access" below`,
        });
        return;
      }
      const role = ['admin', 'dispatcher', 'crew'].includes(body.role) ? body.role : 'dispatcher';
      if (await db.getUserByEmail(email)) {
        sendJson(req, res, 409, { error: 'A user with that email already exists' });
        return;
      }
      const id = nextId(await db.listUsers(), 'U');
      // Grants access only — no password set. This person uses "Forgot password?" on the login
      // screen to set one via an emailed one-time code before they can sign in.
      const user = await db.createUser({ id, email, role });
      sendJson(req, res, 201, publicUser(user));
      return;
    }

    /* ---- Allowed external emails (admin only) — see db.js's doc comment on this collection.
       Lifts the @aroundtownmovers.com restriction above for specific one-off addresses; doesn't by
       itself grant access — an admin still has to create the actual user (with a role) via
       POST /api/users afterward, same as any other account. */

    if (p === '/api/allowed-external-emails' && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, await db.listAllowedExternalEmails());
      return;
    }

    if (p === '/api/allowed-external-emails' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      const email = auth.normalizeEmail(body.email);
      if (!email || !email.includes('@')) {
        sendJson(req, res, 400, { error: 'A valid email address is required' });
        return;
      }
      if (auth.isCompanyEmail(email)) {
        sendJson(req, res, 400, { error: `@${auth.EMAIL_DOMAIN} addresses are already allowed — no need to add them here` });
        return;
      }
      const entry = await db.addAllowedExternalEmail(email, { addedByEmail: currentUser.email, note: String(body.note || '').slice(0, 200) });
      sendJson(req, res, 201, entry);
      return;
    }

    let m = p.match(/^\/api\/allowed-external-emails\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const email = auth.normalizeEmail(decodeURIComponent(m[1]));
      await db.removeAllowedExternalEmail(email);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    m = p.match(/^\/api\/users\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin']);
      const targetId = m[1];
      const target = await db.getUserById(targetId);
      if (!target) { sendJson(req, res, 404, { error: 'User not found' }); return; }
      const body = await readJsonBody(req);
      if (body.role !== undefined) {
        if (!['admin', 'dispatcher', 'crew'].includes(body.role)) {
          sendJson(req, res, 400, { error: 'Invalid role' });
          return;
        }
        if (target.role === 'admin' && body.role !== 'admin' && (await db.countAdmins()) <= 1) {
          sendJson(req, res, 400, { error: "Can't remove the last admin — promote someone else first" });
          return;
        }
        await db.updateUserRole(targetId, body.role);
      }
      sendJson(req, res, 200, publicUser(await db.getUserById(targetId)));
      return;
    }

    m = p.match(/^\/api\/users\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const targetId = m[1];
      const target = await db.getUserById(targetId);
      if (!target) { sendJson(req, res, 404, { error: 'User not found' }); return; }
      if (targetId === currentUser.id) { sendJson(req, res, 400, { error: "You can't delete your own account while logged in" }); return; }
      if (target.role === 'admin' && (await db.countAdmins()) <= 1) {
        sendJson(req, res, 400, { error: "Can't delete the last admin" });
        return;
      }
      await db.deleteUser(targetId);
      sendJson(req, res, 200, { ok: true });
      return;
    }

    /* ---- Scheduler data API ---- */

    if (p === '/api/state' && req.method === 'GET') {
      // ?since=<version> -> 1-read "no change" reply when nothing was written (see db.getStateIfChanged).
      // No `since` (old clients, first load, periodic full refresh) -> full state as before, plus `version`.
      const sinceParam = url.searchParams.get('since');
      const since = sinceParam !== null && sinceParam !== '' && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : null;
      sendJson(req, res, 200, await db.getStateIfChanged(since));
      return;
    }

    // DISABLED 2026-09-30 (user request): the app runs on real production data now, so wiping every
    // truck/driver/job back to sample data must not be reachable at all — the UI button was removed
    // too. db.resetToSampleData() is left in db.js (unused) in case a dev/emulator setup needs it.
    if (p === '/api/reset-to-sample-data' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 410, { error: 'Reset to sample data is disabled on this deployment.' });
      return;
    }

    if (p === '/api/clear-jobs' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, await db.clearJobs());
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
      // REST poll sweep is the sync path again (see pollSweep's doc comment) — with or without an
      // explicit from/to, since pollSweep already defaults to POLL_LOOKBACK_DAYS/POLL_LOOKAHEAD_DAYS
      // when neither is given. The iCal feed is set aside for now; it's still reachable directly if
      // ever needed by calling pollIcalFeed() (not wired to this endpoint anymore).
      //
      // SPLIT 2026-09-08 (at the user's request): this used to also run pollGoogleCalendarFeed()
      // sequentially right after pollSweep(), in the same request/response. The problem: the `api`
      // Cloud Function has no timeoutSeconds override, so it runs on the platform's 60s default —
      // and pollSweep's fully-sequential, unbatched per-crew-member/per-opportunity SmartMoving API
      // calls can exceed that under real data volume (confirmed via a live 502 + Cloud Run
      // "maximum request timeout" log entry). When that happened, the request was killed before
      // pollGoogleCalendarFeed() ever got a chance to run — so a slow poll sweep silently prevented
      // the calendar sync from running too, even though the calendar sync itself was healthy. Now
      // each has its own endpoint (see POST /api/calendar-sync-now just below) and can succeed or
      // time out independently — see SyncPanel.jsx for the two buttons this backs.
      // 2026-09-30: diff-only by default (see pollSweep). `?full=1` re-hydrates everything in range
      // (old behaviour, for a manual backfill); `?ignoreBudget=1` lets an admin run past the
      // scheduler's daily SmartMoving API budget.
      const result = await pollSweep({
        from, to,
        mode: url.searchParams.get('full') === '1' ? 'full' : 'diff',
        ignoreBudget: url.searchParams.get('ignoreBudget') === '1',
      });
      sendJson(req, res, 200, { ...result, state: await db.getState() });
      return;
    }

    if (p === '/api/calendar-sync-now' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      // Split out of /api/sync-now 2026-09-08 — see that handler's comment for why. This is the
      // Google Calendar sync (pollGoogleCalendarFeed) on its own, independent of the SmartMoving
      // REST poll sweep — it's what actually carries truck/driver assignment data (pollSweep's REST
      // source doesn't), and it's where the iCal/Smart-Insights record merge happens (see
      // db.mergeCalendarDataOntoExistingJob). Same function calendarSweepScheduled /
      // calendarSweepScheduled403pm already run on their own schedule (functions-index.js) — this
      // just makes it reachable on demand too, without waiting for pollSweep to finish (or time out)
      // first.
      const result = await pollGoogleCalendarFeed();
      sendJson(req, res, 200, { ...result, state: await db.getState() });
      return;
    }

    if (p === '/api/smart-insights/sync-now' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      // Manual trigger for the same pipeline smartInsightsSyncScheduled runs daily at 6am ET (see
      // functions-index.js) — checks Gmail for any not-yet-processed "SmartMoving Report is Ready"
      // email right now instead of waiting for the next scheduled run. Requires GMAIL_OAUTH_*
      // secrets to be set (see smartInsightsGmail.js / server/gmail-oauth-setup.js) — throws a clear
      // error via syncSmartInsights -> getAuthenticatedClient if they aren't.
      const result = await syncSmartInsights();
      sendJson(req, res, 200, { ...result, state: await db.getState() });
      return;
    }

    if (p === '/api/gmail-auth-status' && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      // Backs the "Gmail authorization" countdown in SyncPanel (added 2026-09-08 at the user's
      // request) — Google's OAuth "Testing" publishing status auto-expires the refresh token
      // server/smartInsightsGmail.js runs on (both the report-email sync and the Calendar sync
      // share it) exactly GMAIL_AUTH_EXPIRY_DAYS after it's issued, regardless of activity. The
      // board can't know the actual expiry moment Google enforces server-side, only estimate it
      // from when server/gmail-oauth-setup.js last recorded a successful re-auth (db.js's
      // getGmailAuthStatus) — see that script for why it has to be the one writing this, not the
      // deployed backend itself.
      const status = await db.getGmailAuthStatus();
      if (!status || !status.refreshedAt) {
        sendJson(req, res, 200, { tracked: false });
        return;
      }
      const refreshedAt = new Date(status.refreshedAt);
      const expiresAt = new Date(refreshedAt.getTime() + GMAIL_AUTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
      const daysRemaining = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      sendJson(req, res, 200, {
        tracked: true,
        refreshedAt: status.refreshedAt,
        expiresAt: expiresAt.toISOString(),
        daysRemaining,
        expired: daysRemaining <= 0,
      });
      return;
    }

    if (p === '/api/trucks' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      const { trucks } = await db.getState();
      const id = nextId(trucks, 'T');
      const truck = await db.createTruck({ id, name: body.name || `Truck ${trucks.length + 1}`, size: body.size, capacity: body.capacity, homeBase: body.homeBase, status: 'available' });
      sendJson(req, res, 201, truck);
      return;
    }

    m = p.match(/^\/api\/trucks\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      sendJson(req, res, 200, await db.updateTruck(m[1], body));
      return;
    }
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const { trucks } = await db.getState();
      if (!trucks.some(t => t.id === m[1])) { sendJson(req, res, 404, { error: 'Truck not found' }); return; }
      sendJson(req, res, 200, await db.deleteTruck(m[1]));
      return;
    }

    if (p === '/api/trucks/reorder' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      if (!Array.isArray(body.truckIds) || !body.truckIds.length) {
        sendJson(req, res, 400, { error: 'truckIds must be a non-empty array' });
        return;
      }
      const { trucks } = await db.getState();
      const knownIds = new Set(trucks.map((t) => t.id));
      if (body.truckIds.length !== trucks.length || !body.truckIds.every((id) => knownIds.has(id))) {
        sendJson(req, res, 400, { error: 'truckIds must include every current truck exactly once' });
        return;
      }
      sendJson(req, res, 200, await db.reorderTrucks(body.truckIds));
      return;
    }

    if (p === '/api/drivers' && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      if (!body.name) { sendJson(req, res, 400, { error: 'name is required' }); return; }
      const { drivers } = await db.getState();
      const id = nextId(drivers, 'D');
      const driver = await db.createDriver({ id, name: body.name, phone: body.phone, cdl: body.cdl });
      sendJson(req, res, 201, driver);
      return;
    }

    m = p.match(/^\/api\/drivers\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin']);
      const body = await readJsonBody(req);
      sendJson(req, res, 200, await db.updateDriver(m[1], body));
      return;
    }
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const { drivers } = await db.getState();
      if (!drivers.some(d => d.id === m[1])) { sendJson(req, res, 404, { error: 'Driver not found' }); return; }
      sendJson(req, res, 200, await db.deleteDriver(m[1]));
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
      // Color override, optionally picked in JobCreateModal at creation time (added 2026-09-16 —
      // "for placeholder give option for colors"). Same allowed set and same validation as the
      // dedicated POST /api/jobs/:id/color route below (ALLOWED_COLORS duplicated here on purpose,
      // same "small constant, kept in sync by hand" tradeoff already used throughout this file/
      // frontend for the color taxonomy — see that route's own comment) — this just lets a
      // placeholder start out with a pick already applied instead of needing a second click right
      // after creation.
      const ALLOWED_JOB_CREATE_COLORS = ['green', 'yellow', 'purple', 'red', 'orange'];
      const colorOverride = body.colorOverride || null;
      if (colorOverride !== null && !ALLOWED_JOB_CREATE_COLORS.includes(colorOverride)) {
        sendJson(req, res, 400, { error: `colorOverride must be one of ${ALLOWED_JOB_CREATE_COLORS.join(', ')}, or null` });
        return;
      }
      const { jobs } = await db.getState();
      const id = nextId(jobs, 'J-');
      const endDate = body.endDate || body.date;
      // JobCreateModal now sends an explicit type (a "Local"/"Long Distance" toggle, added
      // 2026-08-18 — used to only be inferred). Still falls back to the old date-range inference
      // for any other caller that doesn't send one, rather than requiring it.
      const type = body.type === 'long_distance' || body.type === 'local'
        ? body.type
        : (endDate > body.date ? 'long_distance' : 'local');
      const job = await db.createJob({
        id,
        customer: (body.customer || '').trim() || 'New job',
        type,
        date: body.date,
        endDate,
        startTime: body.startTime || null,
        duration: type === 'local' ? 2 : null,
        origin: (body.origin || '').trim(),
        destination: (body.destination || '').trim(),
        crewSize: body.crewSize ? Number(body.crewSize) : null,
        trucksNeeded: body.trucksNeeded ? Number(body.trucksNeeded) : 1,
        status: 'scheduled',
        source: 'placeholder',
        truckIds: [],
        colorOverride,
      });
      // Audit log (see db.js's logJobChange) — a create has no "before" to diff against, so the
      // whole new job is logged as-is rather than a field-by-field diff.
      await db.logJobChange({ jobId: id, action: 'create', actor: currentUser, changes: { job } });
      sendJson(req, res, 201, { ...job, state: await db.getState() });
      return;
    }

    m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const body = await readJsonBody(req);
      const job = await db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      let updatedJob = await db.updateJob(m[1], body);
      // Audit log — diffed against the actual before/after job docs (not just the request body),
      // so this also picks up side effects like a removed truck's driver assignment clearing along
      // with it (see db.js's updateJob), not just the fields the caller explicitly sent.
      const changes = diffJobFields(job, updatedJob);
      if (Object.keys(changes).length) {
        await db.logJobChange({ jobId: m[1], action: 'update', actor: currentUser, changes });
      }
      // Manual edit lock (added 2026-09-08 at the user's request): if this PATCH actually changed
      // one of db.js's MANUAL_EDIT_LOCK_FIELDS (customer/date/time/addresses/crewSize/notes/type —
      // the fields every sync source treats as its own, see db.js's jobData() comment on
      // manuallyEditedAt), mark this job as manually edited so the next poll sweep / calendar sync /
      // Smart Insights sync leaves it alone entirely instead of silently reverting the correction.
      // Checked against `changes` (the real before/after diff), not the raw request body, so simply
      // opening JobEditModal and clicking Save without changing anything doesn't lock a job that
      // didn't need it — see db.js's markJobManuallyEdited for what "locked" actually does.
      if (Object.keys(changes).some((field) => db.MANUAL_EDIT_LOCK_FIELDS.includes(field))) {
        updatedJob = await db.markJobManuallyEdited(m[1], currentUser);
      }
      // Truck-assignment lock (added 2026-09-14, split out from the check above — see db.js's
      // markTruckAssignmentManual comment for the full reasoning): a PATCH that actually changed
      // truckIds/trucksNeeded locks JUST the truck assignment, independent of the detail lock above —
      // a job can be truck-locked without being detail-locked and vice versa. This is what lets the
      // calendar sync keep an unlocked job's truck in step with SmartMoving (including clearing it if
      // SmartMoving now shows none) while a dispatcher's deliberate reassignment here still sticks.
      if (Object.keys(changes).some((field) => db.TRUCK_LOCK_FIELDS.includes(field))) {
        updatedJob = await db.markTruckAssignmentManual(m[1], currentUser);
      }
      sendJson(req, res, 200, updatedJob);
      return;
    }

    // "Resync from source" — clears BOTH locks a prior PATCH/set-truck-driver above may have set
    // (the detail lock and the truck-assignment lock — see db.js's clearJobManualEdit), so this job
    // goes back to accepting automatic updates from whichever sync source(s) still recognize it.
    // Doesn't force an immediate re-sync itself — see clearJobManualEdit's own doc comment for why
    // that's a deliberate choice, not an oversight.
    m = p.match(/^\/api\/jobs\/([^/]+)\/resync$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const job = await db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      const updatedJob = await db.clearJobManualEdit(m[1]);
      if (job.manuallyEditedAt || job.truckLockedAt) {
        await db.logJobChange({
          jobId: m[1], action: 'resync', actor: currentUser,
          changes: {
            ...(job.manuallyEditedAt ? { manuallyEditedAt: { from: job.manuallyEditedAt, to: null } } : {}),
            ...(job.truckLockedAt ? { truckLockedAt: { from: job.truckLockedAt, to: null } } : {}),
          },
        });
      }
      sendJson(req, res, 200, updatedJob);
      return;
    }

    // Same role gate as PATCH. Now offered in the UI for every job, not just placeholders (widened
    // 2026-09-24 alongside the delete-archive/restore feature — see db.js's deleteJob doc comment
    // for the full story and its still-standing caveat about real synced jobs). The route itself
    // never enforced the old placeholder-only restriction anyway — that was always a UI-level
    // choice, not a data-layer one.
    //
    // Re-matches m against the plain /api/jobs/:id pattern (bug fix, 2026-09-16) — this block used
    // to just reuse whatever `m` the /resync POST handler above had already set, which only ever
    // matches a URL ending in /resync. A plain DELETE /api/jobs/:id never matches that regex, so `m`
    // came in null here, this whole block was skipped, and the request fell through every remaining
    // route with no match — the exact "Backend returned 404 — Not found" the user reported when
    // trying to delete a placeholder job (confirmed still present in Firestore, since the delete
    // never actually reached db.deleteJob at all).
    m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const job = await db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      // Audit log BEFORE the delete — there's no "after" doc to read back once it's gone, so the
      // full job as it existed right before deletion is what gets recorded. This is separate from
      // (and in addition to) the deletedJobs archive doc db.deleteJob itself now writes below —
      // this one lives at jobs/{id}/history (Firebase-console-only, see logJobChange's own doc
      // comment), that one powers the actual Deleted Jobs UI/restore.
      await db.logJobChange({ jobId: m[1], action: 'delete', actor: currentUser, changes: { job } });
      sendJson(req, res, 200, await db.deleteJob(m[1], job, currentUser));
      return;
    }

    // Deleted-jobs archive (added 2026-09-24) — GET lists every soft-deleted job for the "secret"
    // Deleted Jobs panel, POST .../restore brings one back. Deliberately admin-only, one notch
    // tighter than the ['admin','dispatcher'] gate DELETE /api/jobs/:id itself uses — this is the
    // hidden view of everything anyone with delete access has ever removed, not the delete action
    // itself, and the user asked for it to be somewhere "only I should know" (see Header.jsx's
    // hidden logo-click trigger, admin-role-gated the same way on the frontend — this is the
    // server-side backstop so that restriction holds even if someone guessed the click pattern).
    m = p.match(/^\/api\/deleted-jobs$/);
    if (m && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      sendJson(req, res, 200, await db.listDeletedJobs());
      return;
    }
    m = p.match(/^\/api\/deleted-jobs\/([^/]+)\/restore$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin']);
      const restoredState = await db.restoreJob(m[1]);
      await db.logJobChange({ jobId: m[1], action: 'restore', actor: currentUser, changes: null });
      sendJson(req, res, 200, restoredState);
      return;
    }
    // Permanently removes one archived job — added 2026-09-24 (right after the 131-job Smart
    // Insights cleanup filled this panel with entries nobody would ever restore), no route above
    // this offered a way to actually clear them back out. Same admin-only gate as the rest of this
    // block. True hard delete, no audit-log entry (unlike DELETE /api/jobs/:id's soft-delete, which
    // logs to the job's own history subcollection before removing it from jobsCol) — the job's
    // 'delete' history entry already recorded who/when it was first soft-deleted; permanently
    // clearing the archive copy afterward isn't a new fact about the job worth a second entry, and
    // by this point the job doc itself (and its history subcollection) is long gone from jobsCol
    // anyway, so there'd be nowhere for that entry to live even if it were wanted.
    m = p.match(/^\/api\/deleted-jobs\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      requireRole(currentUser, ['admin']);
      const existed = await db.permanentlyDeleteArchivedJob(m[1]);
      if (!existed) { sendJson(req, res, 404, { error: 'Deleted job not found' }); return; }
      sendJson(req, res, 200, { ok: true });
      return;
    }

    // Assigns (or, with driverId: null, clears) which driver is driving one specific truck on this
    // job — see db.js's file header for why driver assignment moved off the truck and onto this
    // per-job pairing. Requires truckId to already be one of this job's assigned trucks, so a
    // dispatcher can't pin a driver to a truck the job doesn't actually have.
    m = p.match(/^\/api\/jobs\/([^/]+)\/set-truck-driver$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin', 'dispatcher']);
      const body = await readJsonBody(req);
      const job = await db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      if (!body.truckId || !(job.truckIds || []).includes(body.truckId)) {
        sendJson(req, res, 400, { error: 'truckId must be one of this job\'s assigned trucks' });
        return;
      }
      const newDriverId = body.driverId || null;
      const priorDriverId = (job.truckDrivers || {})[body.truckId] || null;
      if (priorDriverId !== newDriverId) {
        await db.logJobChange({
          jobId: m[1],
          action: 'set-truck-driver',
          actor: currentUser,
          changes: { [`truckDrivers.${body.truckId}`]: { from: priorDriverId, to: newDriverId } },
        });
      }
      // Driver assignment briefly locked the WHOLE job too (2026-09-08 to 2026-09-14, at the user's
      // follow-up request) — reverted (see db.js's MANUAL_EDIT_LOCK_FIELDS comment for why): a
      // routine driver assignment shouldn't freeze the job's date/customer/etc against further
      // syncing. It now trips only the narrower truck-assignment lock instead (added 2026-09-14 — see
      // db.js's markTruckAssignmentManual), same real-change guard as before (priorDriverId !==
      // newDriverId, already computed above for the audit log) — this is what lets a dispatcher's
      // deliberate driver pick stick through the next calendar sync while everything else about the
      // job keeps syncing normally.
      let updatedJob = await db.setJobTruckDriver(m[1], body.truckId, newDriverId);
      if (priorDriverId !== newDriverId) {
        updatedJob = await db.markTruckAssignmentManual(m[1], currentUser);
      }
      sendJson(req, res, 200, updatedJob);
      return;
    }

    // Sets (or, with color: null, clears) a job's manual color override — added 2026-09-15 at the
    // user's explicit request that ALL roles, including crew (normally locked out of every other
    // job edit — see DayBoard.jsx's canEdit), be able to change a job's color. Deliberately its own
    // narrow endpoint rather than an opening in the generic PATCH /api/jobs/:id above (which stays
    // [admin+dispatcher] only): this is the one field crew is allowed to touch, so it gets the one
    // role gate that includes crew, and nothing else about a job becomes editable by widening this
    // route. Body: {color: 'green'|'yellow'|'purple'|'red'|'orange'|null} — anything else is
    // rejected; null clears the override so the job goes back to its automatic category color (see
    // frontend's utils/jobs.js's jobColorOverride list, kept in sync with this one by hand).
    m = p.match(/^\/api\/jobs\/([^/]+)\/color$/);
    if (m && req.method === 'POST') {
      requireRole(currentUser, ['admin', 'dispatcher', 'crew']);
      const body = await readJsonBody(req);
      const job = await db.getJob(m[1]);
      if (!job) { sendJson(req, res, 404, { error: 'Job not found' }); return; }
      const ALLOWED_COLORS = ['green', 'yellow', 'purple', 'red', 'orange'];
      const color = body.color || null;
      if (color !== null && !ALLOWED_COLORS.includes(color)) {
        sendJson(req, res, 400, { error: `color must be one of ${ALLOWED_COLORS.join(', ')}, or null` });
        return;
      }
      const priorColor = job.colorOverride || null;
      if (priorColor !== color) {
        await db.logJobChange({
          jobId: m[1], action: 'set-color', actor: currentUser,
          changes: { colorOverride: { from: priorColor, to: color } },
        });
      }
      const updatedJob = await db.setJobColor(m[1], color);
      sendJson(req, res, 200, updatedJob);
      return;
    }

    /* ---- SmartMoving-sourced jobs only (debugging / the old sync panel view) ---- */
    if (p === '/api/schedulable-jobs' && req.method === 'GET') {
      requireRole(currentUser, ['admin']);
      const statusesParam = url.searchParams.get('statuses');
      const statuses = statusesParam ? statusesParam.split(',').map(Number) : DEFAULT_STATUSES;
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      if (forceRefresh) await pollSweep();

      const { jobs } = await db.getState();
      const smJobs = jobs.filter(j => j.source === 'smartmoving' &&
        (j.smartMovingStatusCode === null || j.smartMovingStatusCode === undefined || statuses.includes(j.smartMovingStatusCode)));

      sendJson(req, res, 200, {
        fetchedAt: new Date().toISOString(),
        statuses: statuses.map(s => ({ code: s, label: OPPORTUNITY_STATUS[s] || s })),
        count: smJobs.length,
        jobs: smJobs,
        lastPollAt, lastPollError, lastIcalSyncAt, lastIcalSyncError, lastWebhookAt,
      });
      return;
    }

    sendJson(req, res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(req, res, err.status || 500, { error: err.message });
  }
}

const server = http.createServer(handleRequest);

/**
 * Async startup sequence — Firestore needs an `await` before the server can safely accept
 * requests, unlike the old SQLite version where the database was ready synchronously as soon as
 * `require('./db')` returned. Order matters: seed sample data (only on a brand new, empty
 * database) before bootstrapping the first admin (only on zero users) before opening the port.
 *
 * Also used (minus the server.listen() call) by server/functions-index.js's ensureInit() — Cloud
 * Functions has no single "startup" moment the way a long-running container does, so that file
 * calls initOnce() lazily on first invocation of either exported function instead.
 */
async function initOnce() {
  await db.initDb();
  await bootstrapAdmin();
}

/**
 * Starts the plain-Node listening server — used by local dev and the AWS container (see
 * server/start.js, which is the only thing that actually calls this). Deliberately NOT invoked
 * just by requiring this file: Firebase's own `firebase deploy` runs a local "analyze the source
 * to see what's exported" pass over server/functions-index.js (which requires this file) before
 * ever touching Cloud Functions/Cloud Run — that pass expects requiring the module to be a fast,
 * side-effect-free operation, and a real Firestore init + an actual listen() call blew straight
 * through its 10s timeout ("Cannot determine backend specification"). Splitting "define the app"
 * from "run the app" like this is what makes the same server.js safely reusable by three different
 * entry points (server/start.js, server/functions-index.js, and Firebase's own analysis pass)
 * without needing to sniff environment variables to guess which one is currently loading it.
 */
async function start() {
  await initOnce();

  server.listen(PORT, () => {
    console.log(`ATM Scheduler backend listening on http://localhost:${PORT}`);
    console.log('Database: Firestore');
    console.log(`SmartMoving API key ${process.env.SMARTMOVING_API_KEY ? 'is' : 'is NOT'} configured.`);
    console.log(`Webhook secret ${WEBHOOK_SECRET ? 'is' : 'is NOT'} configured (POST /webhooks/smartmoving).`);
    console.log(POLL_INTERVAL_MINUTES > 0
      ? `Poll sweep every ${POLL_INTERVAL_MINUTES} min (primary sync, booked jobs only).`
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
    db.listUsers().then(users => console.log(`${users.length} user account(s) have access.`));
    // REST poll sweep is the primary sync path again as of 2026-08-18 (see pollSweep's doc
    // comment) — the iCal feed is set aside for now, not deleted, so startIcalPolling() is no
    // longer called from here; pollIcalFeed itself still works via POST /api/sync-now (no from/to).
    if (process.env.SMARTMOVING_API_KEY) pollSweep().catch(() => {});
    startPolling();
  });
}

module.exports = {
  server, db, auth, hydrateOpportunity, pollSweep, pollIcalFeed, pollGoogleCalendarFeed,
  syncSmartInsights, handleRequest, initOnce, start,
};
