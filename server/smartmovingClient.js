/**
 * Thin client for SmartMoving's public "External API v1".
 * Docs: https://smartmoving-prod-api-management.developer.azure-api.net/
 * Auth: header `x-api-key: <key>` (confirmed via help.smartmoving.com's Open API article, 2026-08-05).
 *
 * IMPORTANT — read-only by design: SmartMoving's API has no endpoint that lets you set a job's
 * jobDate / startTimeUtc / endTimeUtc, even on the paid Premium tier. This client only implements
 * the read (GET) endpoints needed to pull jobs into the scheduler. See ../README.md for the full
 * writeup of what was checked and why write-back isn't implemented yet.
 */

const BASE_URL = process.env.SMARTMOVING_BASE_URL || 'https://api-public.smartmoving.com/v1';
const API_KEY = process.env.SMARTMOVING_API_KEY || '';

async function smartMovingGet(path, params = {}) {
  if (!API_KEY) {
    throw new Error('SMARTMOVING_API_KEY is not set. Add it to server/.env (see .env.example).');
  }
  const url = new URL(BASE_URL + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`SmartMoving API ${res.status} ${res.statusText} for ${path}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * GET /api/leads — paginated, spans the lead→opportunity→booked pipeline via `status`.
 * From/To use SmartMoving's yyyyMMdd integer date format.
 * OpportunityStatus: 0 NewLead, 1 LeadInProgress, 3 Opportunity, 4 Booked, 10 Completed,
 *                     11 Closed, 20 Cancelled, 30 Lost, 50 BadLead
 */
async function getLeadsPage({ page = 1, pageSize = 100, from, to, includeBad = false, includeLost = false } = {}) {
  return smartMovingGet('/api/leads', {
    Page: page,
    PageSize: pageSize,
    From: from,
    To: to,
    IncludeBad: includeBad,
    IncludeLost: includeLost,
  });
}

/** Pulls every page of /api/leads for the given date range. */
async function getAllLeads({ from, to, includeBad = false, includeLost = false } = {}) {
  const all = [];
  let page = 1;
  // Safety cap so a bad response shape can't loop forever.
  for (let i = 0; i < 200; i++) {
    const result = await getLeadsPage({ page, pageSize: 100, from, to, includeBad, includeLost });
    const results = result.pageResults || [];
    all.push(...results);
    if (result.lastPage || results.length === 0) break;
    page += 1;
  }
  return all;
}

/**
 * GET /api/premium/opportunities/{opportunityId}/jobs — jobs for one opportunity.
 * NOTE: this is a "premium"-tagged endpoint per the dev portal. On the Basic (free) tier this
 * will likely 403/404 — confirm your account's SmartMoving API tier (Settings > Integrations >
 * SmartMoving API) before relying on it.
 * The exact path for this list call (vs. the single "Get job by id" at .../jobs/{jobId}, which
 * was directly confirmed in the dev portal) is inferred by REST convention from "Create job"
 * (POST to this same .../jobs collection) — worth a quick live check once you have a real key.
 */
async function getJobsByOpportunityId(opportunityId) {
  return smartMovingGet(`/api/premium/opportunities/${encodeURIComponent(opportunityId)}/jobs`, {
    IncludeStops: true,
    IncludeDispatchInfo: true,
  });
}

/**
 * GET /api/opportunities/{opportunityId} — full opportunity detail, tagged "basic opportunities"
 * in the dev portal (so unlike getJobsByOpportunityId this should work on the free tier too).
 * Confirmed live in the portal 2026-08-05: returns `opportunityType` (0 Local/1 Intrastate/
 * 2 Interstate — the authoritative long-distance flag we don't have to infer from addresses),
 * `customer.name`, `status`, and `jobs[]` (id, jobNumber, jobDate, jobAddresses, arrivalWindow).
 * With IncludeTripInfo, also returns `tripInfo.confirmedPickupDate`/`confirmedDeliveryDate` —
 * the real multi-day date range for long-distance moves, which the premium jobs endpoint doesn't
 * expose. This is the endpoint webhook-driven ingestion hydrates from, since a webhook payload
 * only ever gives an opportunity-id or job-id.
 */
async function getOpportunityDetails(opportunityId) {
  return smartMovingGet(`/api/opportunities/${encodeURIComponent(opportunityId)}`, {
    IncludeJobAddresses: true,
    IncludeTripInfo: true,
    IncludeDispatchInfo: true,
  });
}

module.exports = { getLeadsPage, getAllLeads, getJobsByOpportunityId, getOpportunityDetails, BASE_URL };
