/**
 * ATM Scheduler — backend API + SmartMoving sync.
 *
 * Requires Node 22.5+ (see the version check below) — uses Node's built-in `node:sqlite` so there
 * are still zero npm dependencies, but that module needs a fairly recent Node.
 *
 * This backend now does two jobs:
 *  1. Serves the scheduler's own data (trucks/drivers/jobs/assignments) from a SQLite database
 *     (`server/db.js`) via a small REST API, so every device sees the same live board instead of
 *     each browser having its own separate localStorage copy.
 *  2. Pulls jobs FROM SmartMoving CRM (webhooks + a polling fallback) and writes them straight into
 *     that same database — see server/README.md "Webhooks vs. polling" for why both exist.
 *
 * One-way sync only: editing a job's date/truck/time in the scheduler does NOT push back to
 * SmartMoving — their public API has no endpoint for that (checked exhaustively; see
 * ../README.md). Dispatchers need to mirror schedule changes into SmartMoving manually.
 *
 * API summary:
 *   GET   /api/health
 *   GET   /api/state                              -> { trucks, drivers, jobs }
 *   POST  /api/trucks                              body: {name, size, capacity, homeBase}
 *   PATCH /api/trucks/:id                          body: any truck field(s) to change
 *   POST  /api/trucks/:id/link-driver              body: {driverId}
 *   POST  /api/drivers                             body: {name, phone, cdl}
 *   PATCH /api/drivers/:id                         body: any driver field(s) to change
 *   POST  /api/drivers/:id/unassign-truck
 *   PATCH /api/jobs/:id                            body: any job field(s), incl. truckIds[]
 *   POST  /api/reset-to-sample-data
 *   POST  /api/sync-now                            triggers an immediate SmartMoving poll sweep
 *   GET   /api/schedulable-jobs?statuses=4         SmartMoving-sourced jobs only (debugging)
 *   POST  /webhooks/smartmoving?secret=...         SmartMoving webhook receiver
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

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
const { getAllLeads, getJobsByOpportunityId, getOpportunityDetails } = require('./smartmovingClient');
const { mapOpportunityToJobs } = require('./mapOpportunity');
const { OPPORTUNITY_STATUS } = require('./mapJobs');

const PORT = process.env.PORT || 8787;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DEFAULT_STATUSES = [4]; // Booked — jobs that are past quoting and need to be dispatched
const POLL_INTERVAL_MINUTES = process.env.POLL_INTERVAL_MINUTES !== undefined ? Number(process.env.POLL_INTERVAL_MINUTES) : 15;
const POLL_LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS) || 7;
const POLL_LOOKAHEAD_DAYS = Number(process.env.POLL_LOOKAHEAD_DAYS) || 60;

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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
  });
  res.end(data);
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
      sendJson(res, 401, { error: 'Invalid or missing webhook secret' });
      return;
    }
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const eventType = payload['event-type'] || payload.eventType;
  const opportunityId = payload['opportunity-id'] || payload.opportunityId;
  lastWebhookAt = new Date().toISOString();

  // Acknowledge immediately — SmartMoving likely retries on non-2xx or slow responses, and the
  // actual hydration call can take a moment.
  sendJson(res, 202, { received: true, eventType: eventType || null });

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

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

    if (p === '/api/health') {
      const state = db.getState();
      sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(process.env.SMARTMOVING_API_KEY),
        webhookSecretConfigured: Boolean(WEBHOOK_SECRET),
        pollIntervalMinutes: POLL_INTERVAL_MINUTES,
        truckCount: state.trucks.length, driverCount: state.drivers.length, jobCount: state.jobs.length,
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

    /* ---- Scheduler data API ---- */

    if (p === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, db.getState());
      return;
    }

    if (p === '/api/reset-to-sample-data' && req.method === 'POST') {
      sendJson(res, 200, db.resetToSampleData());
      return;
    }

    if (p === '/api/sync-now' && req.method === 'POST') {
      const result = await pollSweep();
      sendJson(res, 200, { ...result, state: db.getState() });
      return;
    }

    if (p === '/api/trucks' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const { trucks } = db.getState();
      const id = nextId(trucks, 'T');
      const truck = db.createTruck({ id, name: body.name || `Truck ${trucks.length + 1}`, size: body.size, capacity: body.capacity, homeBase: body.homeBase, status: 'available' });
      sendJson(res, 201, truck);
      return;
    }

    let m = p.match(/^\/api\/trucks\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      sendJson(res, 200, db.updateTruck(m[1], body));
      return;
    }

    m = p.match(/^\/api\/trucks\/([^/]+)\/link-driver$/);
    if (m && req.method === 'POST') {
      const body = await readJsonBody(req);
      db.linkTruckDriver(m[1], body.driverId || null);
      sendJson(res, 200, db.getState());
      return;
    }

    if (p === '/api/drivers' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body.name) { sendJson(res, 400, { error: 'name is required' }); return; }
      const { drivers } = db.getState();
      const id = nextId(drivers, 'D');
      const driver = db.createDriver({ id, name: body.name, phone: body.phone, cdl: body.cdl });
      sendJson(res, 201, driver);
      return;
    }

    m = p.match(/^\/api\/drivers\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      sendJson(res, 200, db.updateDriver(m[1], body));
      return;
    }

    m = p.match(/^\/api\/drivers\/([^/]+)\/unassign-truck$/);
    if (m && req.method === 'POST') {
      db.unassignDriverTruck(m[1]);
      sendJson(res, 200, db.getState());
      return;
    }

    m = p.match(/^\/api\/jobs\/([^/]+)$/);
    if (m && req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const job = db.getJob(m[1]);
      if (!job) { sendJson(res, 404, { error: 'Job not found' }); return; }
      sendJson(res, 200, db.updateJob(m[1], body));
      return;
    }

    /* ---- SmartMoving-sourced jobs only (debugging / the old sync panel view) ---- */
    if (p === '/api/schedulable-jobs' && req.method === 'GET') {
      const statusesParam = url.searchParams.get('statuses');
      const statuses = statusesParam ? statusesParam.split(',').map(Number) : DEFAULT_STATUSES;
      const forceRefresh = url.searchParams.get('refresh') === 'true';
      if (forceRefresh) await pollSweep();

      const { jobs } = db.getState();
      const smJobs = jobs.filter(j => j.source === 'smartmoving' &&
        (j.smartMovingStatusCode === null || j.smartMovingStatusCode === undefined || statuses.includes(j.smartMovingStatusCode)));

      sendJson(res, 200, {
        fetchedAt: new Date().toISOString(),
        statuses: statuses.map(s => ({ code: s, label: OPPORTUNITY_STATUS[s] || s })),
        count: smJobs.length,
        jobs: smJobs,
        lastPollAt, lastPollError, lastWebhookAt,
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
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
  if (process.env.SMARTMOVING_API_KEY) pollSweep().catch(() => {}); // warm the store on startup
  startPolling();
});

module.exports = { server, db, hydrateOpportunity, pollSweep };
