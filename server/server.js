/**
 * ATM Scheduler — SmartMoving sync backend.
 *
 * Zero npm dependencies (Node 18+ has global fetch). Run with: node server.js
 * Reads SMARTMOVING_API_KEY from the environment (see .env.example) — the key never touches
 * the browser/frontend.
 *
 * Two ways jobs get into the local store:
 *  1. Webhooks (primary, real-time): SmartMoving POSTs to /webhooks/smartmoving whenever a job or
 *     opportunity is created/changed. This fires regardless of whether the booking ever passed
 *     through the lead pipeline (see README "Webhooks vs. polling") — it's the fix for jobs that
 *     were booked directly and never showed up via GET /api/leads.
 *  2. Polling sweep (fallback/backfill, runs on an interval): walks GET /api/leads like before, so
 *     jobs aren't lost if a webhook is ever missed, delayed, or misconfigured. Requires Premium
 *     tier for the events used here — see README.
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/schedulable-jobs?statuses=4        -> serves from the in-memory store (instant)
 *   POST /webhooks/smartmoving?secret=...        -> SmartMoving webhook receiver
 *
 * One-way sync only: this pulls jobs FROM SmartMoving. Editing a job's date/truck/time in the
 * scheduler does NOT push back to SmartMoving — their public API has no endpoint for that
 * (checked exhaustively; see ../README.md). Dispatchers need to mirror schedule changes into
 * SmartMoving manually until that's unblocked.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
  });
  res.end(data);
}

/* ---------- In-memory job store ---------- */
// Keyed by smartMovingJobId. Holds every job seen regardless of status; GET /api/schedulable-jobs
// filters at read time so a status change (e.g. Cancelled) fades a job out of the feed without a
// destructive delete — the frontend's merge logic only ever adds/updates, never removes, so this
// keeps that behavior safe even if a webhook payload turns out to be wrong.
const jobStore = new Map();
let lastPollAt = null;
let lastPollError = null;
let lastWebhookAt = null;
const recentWebhookEvents = []; // small ring buffer for /api/health diagnostics
const MAX_EVENT_LOG = 20;

function recordEvent(entry) {
  recentWebhookEvents.unshift({ at: new Date().toISOString(), ...entry });
  if (recentWebhookEvents.length > MAX_EVENT_LOG) recentWebhookEvents.length = MAX_EVENT_LOG;
}

function upsertJobs(jobs) {
  jobs.forEach(j => { if (j.smartMovingJobId) jobStore.set(j.smartMovingJobId, j); });
}

/**
 * Fetches one opportunity's full detail + (best-effort) precise per-job timing, and maps it into
 * scheduler job objects. Shared by both the webhook handler and the poll sweep so they produce
 * identical output.
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

  return mapOpportunityToJobs(opportunity, premiumJobsById);
}

/* ---------- Poll sweep (fallback/backfill) ---------- */
async function pollSweep() {
  const from = todayYyyymmdd(-POLL_LOOKBACK_DAYS);
  const to = todayYyyymmdd(POLL_LOOKAHEAD_DAYS);
  const errors = [];
  try {
    const leads = await getAllLeads({ from, to, includeBad: false, includeLost: false });
    for (const lead of leads) {
      try {
        const jobs = await hydrateOpportunity(lead.id);
        upsertJobs(jobs);
      } catch (err) {
        errors.push({ opportunityId: lead.id, customer: lead.customerName, message: err.message });
      }
    }
    lastPollAt = new Date().toISOString();
    lastPollError = null;
    recordEvent({ type: 'poll-sweep', leadCount: leads.length, errorCount: errors.length });
  } catch (err) {
    lastPollError = err.message;
    recordEvent({ type: 'poll-sweep-failed', message: err.message });
  }
  return { errors };
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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

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
    const body = await readRequestBody(req);
    payload = body ? JSON.parse(body) : {};
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
    upsertJobs(jobs);
    recordEvent({ type: 'webhook-ingested', eventType, opportunityId, jobCount: jobs.length });
  } catch (err) {
    recordEvent({ type: 'webhook-ingest-failed', eventType, opportunityId, message: err.message });
  }
}

/* ---------- HTTP server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      hasApiKey: Boolean(process.env.SMARTMOVING_API_KEY),
      webhookSecretConfigured: Boolean(WEBHOOK_SECRET),
      pollIntervalMinutes: POLL_INTERVAL_MINUTES,
      storeSize: jobStore.size,
      lastPollAt, lastPollError, lastWebhookAt,
      recentEvents: recentWebhookEvents,
    });
    return;
  }

  if (url.pathname === '/webhooks/smartmoving' && req.method === 'POST') {
    await handleWebhook(req, res, url);
    return;
  }

  if (url.pathname === '/api/schedulable-jobs' && req.method === 'GET') {
    try {
      const statusesParam = url.searchParams.get('statuses');
      const statuses = statusesParam ? statusesParam.split(',').map(Number) : DEFAULT_STATUSES;
      const forceRefresh = url.searchParams.get('refresh') === 'true';

      if (forceRefresh || (jobStore.size === 0 && !lastPollAt)) {
        await pollSweep();
      }

      const jobs = Array.from(jobStore.values()).filter(j =>
        j.smartMovingStatusCode === undefined || statuses.includes(j.smartMovingStatusCode)
      );

      sendJson(res, 200, {
        fetchedAt: new Date().toISOString(),
        statuses: statuses.map(s => ({ code: s, label: OPPORTUNITY_STATUS[s] || s })),
        count: jobs.length,
        jobs,
        lastPollAt, lastPollError, lastWebhookAt,
      });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`ATM Scheduler sync backend listening on http://localhost:${PORT}`);
  console.log(`SmartMoving API key ${process.env.SMARTMOVING_API_KEY ? 'is' : 'is NOT'} configured.`);
  console.log(`Webhook secret ${WEBHOOK_SECRET ? 'is' : 'is NOT'} configured (POST /webhooks/smartmoving).`);
  console.log(POLL_INTERVAL_MINUTES > 0
    ? `Poll sweep every ${POLL_INTERVAL_MINUTES} min (fallback/backfill).`
    : `Poll sweep disabled — webhook-only mode.`);
  pollSweep().catch(() => {}); // warm the store on startup
  startPolling();
});

module.exports = { server, jobStore, hydrateOpportunity, pollSweep };
