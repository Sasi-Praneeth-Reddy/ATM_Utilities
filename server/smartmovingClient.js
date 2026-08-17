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

// The crew-jobs discovery source added 2026-08-10 (see server.js pollSweep) turns one sync into
// potentially hundreds of sequential calls on a real account (one per crew member, plus two per
// discovered opportunity) — confirmed live against a real account with 26+ crew members and
// dozens of opportunities: firing those back-to-back with no pacing hit SmartMoving's rate limit
// almost immediately (HTTP 429, "rate limit is exceeded. Try again in N seconds."). Every call in
// this file funnels through smartMovingGet, so pacing + automatic retry-on-429 live here once,
// rather than needing every caller (pollSweep, the playground, debug-smartmoving.js) to handle it.
const MIN_REQUEST_INTERVAL_MS = Number(process.env.SMARTMOVING_MIN_REQUEST_INTERVAL_MS) || 350;
const MAX_429_RETRIES = 6;
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Parses "...Try again in 29 seconds." out of a 429 response body — the only place SmartMoving's
 * rate-limit response actually states how long to wait (no Retry-After header observed live). */
function parseRetryAfterSeconds(retryAfterHeader, body) {
  const headerSeconds = Number(retryAfterHeader);
  if (retryAfterHeader && !isNaN(headerSeconds)) return headerSeconds;
  const match = /try again in (\d+(?:\.\d+)?) seconds?/i.exec(body || '');
  if (match) return Number(match[1]);
  return null;
}

async function smartMovingGet(path, params = {}) {
  if (!API_KEY) {
    throw new Error('SMARTMOVING_API_KEY is not set. Add it to server/.env (see .env.example).');
  }
  const url = new URL(BASE_URL + path);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });

  for (let attempt = 0; ; attempt++) {
    // Simple global pacing: never let two requests (across every call in this module) fire closer
    // together than MIN_REQUEST_INTERVAL_MS apart, so a big sync doesn't burst the account's rate
    // limit in the first place.
    const waitMs = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
      },
    });

    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');

    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retrySeconds = parseRetryAfterSeconds(res.headers.get('retry-after'), body) ?? Math.min(2 ** attempt, 30);
      await sleep((retrySeconds + 0.5) * 1000); // small buffer past what SmartMoving asked for
      continue;
    }

    const err = new Error(`SmartMoving API ${res.status} ${res.statusText} for ${path}: ${body}`);
    err.status = res.status;
    throw err;
  }
}

/**
 * GET /api/leads — paginated. CONFIRMED live in the dev portal (2026-08-10, browsed api-details
 * for the "Get leads" operation): its own description reads "By default, only New and In Progress
 * leads are returned, but Lost and Bad Leads can be included through query parameters." There is
 * no parameter of any kind to widen this to Booked/Completed/Closed — IncludeBad/IncludeLost are
 * the only two flags this endpoint has. So this endpoint CANNOT EVER surface an already-booked
 * job, regardless of date range or any other option — not a bug to fix here, a hard ceiling on
 * what this one source can see. See getAllJobsByCrewMemberId below for the source that actually
 * finds booked jobs, and server.js's pollSweep() for how the two are combined.
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
 * GET /api/opportunities/{opportunityId}/jobs — jobs for one opportunity, exact timing only
 * (no stops/crew — those come from GET /api/opportunities/{id}'s own jobs[], see
 * mapOpportunity.js). Returns BasicJobViewModel[]: id, type, jobNumber, jobDate, startTimeUtc,
 * endTimeUtc, completedAtUtc, confirmedAtUtc, closedAtUtc.
 *
 * CORRECTED 2026-08-10 — confirmed live in the dev portal (api-details, "Get jobs by
 * opportunityId" operation): this is tagged "basic opportunities", NOT premium, and lives at this
 * path with no "premium" segment. An earlier version of this client called
 * `/api/premium/opportunities/{opportunityId}/jobs` (no jobId) based on an inferred-by-convention
 * guess — that path doesn't exist. The real premium-tier job endpoint needs a specific jobId:
 * `/api/premium/opportunities/{opportunityId}/jobs/{jobId}` (see getJobDetails below). Because the
 * old guess always 404'd and was caught as "not fatal" by its caller, exact per-job start/end
 * times were never actually being applied on ANY account/tier — only the coarser arrivalWindow
 * fallback in mapOpportunity.js was ever used. This fix makes exact timing work for everyone,
 * Premium tier or not.
 */
async function getJobsByOpportunityId(opportunityId) {
  return smartMovingGet(`/api/opportunities/${encodeURIComponent(opportunityId)}/jobs`);
}

/**
 * GET /api/premium/opportunities/{opportunityId}/jobs/{jobId} — Premium tier only. Full job
 * detail: stops (with lat/lng, not just address strings), crewMembers, charges, materials, notes,
 * arrivalWindow. Confirmed live in the dev portal 2026-08-10. Not currently wired into
 * mapOpportunity.js — the basic-tier GET /api/opportunities/{id} already gives jobAddresses[] and
 * crewMembers[] per job, which is enough for the scheduler today. Kept here for when richer detail
 * (exact stop lat/lng, dispatcher/crew notes) is worth the extra Premium-only call.
 */
async function getJobDetails(opportunityId, jobId, { includeStops = true, includeDispatchInfo = true } = {}) {
  return smartMovingGet(`/api/premium/opportunities/${encodeURIComponent(opportunityId)}/jobs/${encodeURIComponent(jobId)}`, {
    IncludeStops: includeStops,
    IncludeDispatchInfo: includeDispatchInfo,
  });
}

/**
 * GET /api/crew-members — basic tier, confirmed live in the dev portal 2026-08-10. Lists crew
 * members (id, name, status, role, branch). Used to enumerate who to check for jobs via
 * getJobsByCrewMemberId below, since there's no "list all jobs" endpoint on this API.
 */
async function getCrewMembersPage({ page = 1, pageSize = 100, status } = {}) {
  return smartMovingGet('/api/crew-members', { Page: page, PageSize: pageSize, Status: status });
}

/**
 * Deliberately NO status filter by default. Confirmed live in the dev portal that `Status` only
 * documents two values ("Active" or "Inactive"), but real accounts may have crew in states that
 * don't map cleanly to those two strings (on leave, seasonal, a typo'd value, etc.) — filtering by
 * `Status=Active` risks silently excluding a crew member (and therefore every job assigned to
 * them) for reasons that have nothing to do with whether they're actually working jobs today.
 * Pass `{ status: 'Active' }` explicitly if you want the narrower list.
 */
async function getAllCrewMembers({ status } = {}) {
  const all = [];
  let page = 1;
  for (let i = 0; i < 50; i++) {
    const result = await getCrewMembersPage({ page, pageSize: 100, status });
    const results = result.pageResults || [];
    all.push(...results);
    if (result.lastPage || results.length === 0) break;
    page += 1;
  }
  return all;
}

/**
 * GET /api/crew-members/{crewMemberId}/jobs — basic tier, confirmed live in the dev portal
 * 2026-08-10. Returns real JOBS directly (id, jobNumber, opportunityId, serviceType, serviceDate,
 * completedAtUtc, confirmedAtUtc, closedAtUtc), filtered by service date — and critically, this
 * does NOT go through /api/leads at all. /api/leads is confirmed to only ever return New/
 * InProgress opportunities (see getAllLeads above), so this is the source that actually finds
 * already-booked jobs during a poll sweep, rather than relying solely on webhooks.
 */
async function getJobsByCrewMemberIdPage(crewMemberId, { from, to, page = 1, pageSize = 100 } = {}) {
  return smartMovingGet(`/api/crew-members/${encodeURIComponent(crewMemberId)}/jobs`, {
    From: from, To: to, Page: page, PageSize: pageSize,
  });
}

async function getAllJobsByCrewMemberId(crewMemberId, { from, to } = {}) {
  const all = [];
  let page = 1;
  for (let i = 0; i < 50; i++) {
    const result = await getJobsByCrewMemberIdPage(crewMemberId, { from, to, page, pageSize: 100 });
    const results = result.pageResults || [];
    all.push(...results);
    if (result.lastPage || results.length === 0) break;
    page += 1;
  }
  return all;
}

/**
 * GET /api/customers — basic tier, confirmed live in the dev portal 2026-08-10 (found while
 * chasing a real user report of jobs missing even with no crew assigned yet). Its own description:
 * "Get a list of all customers ordered by name. Optionally, you can filter them based on the job
 * service date associated with each customer's opportunities." This is the closest thing this API
 * has to a true "list every job in a date range" endpoint — each customer comes back with
 * `opportunities[]` (id, quoteNumber, status — the FULL OpportunityStatus range, not leads-scoped
 * at all) and each opportunity's `jobs[]` (id, jobNumber, serviceDate, type). Critically, this
 * doesn't depend on crew assignment OR lead-pipeline stage the way the other two sources do — an
 * opportunity that's Booked with a job created but genuinely nobody staffed on it yet (invisible to
 * both getAllLeads and getAllJobsByCrewMemberId) shows up here.
 *
 * Response shape is a plain array (`GetAllCustomersViewModel[]`), NOT the
 * `{pageResults, lastPage, ...}` wrapper the other paginated endpoints use — so pagination here
 * stops on a short/empty page instead of a `lastPage` flag.
 */
async function getCustomersPage({ page = 1, pageSize = 100, fromServiceDate, toServiceDate, includeOpportunityInfo = true } = {}) {
  return smartMovingGet('/api/customers', {
    Page: page, PageSize: pageSize,
    FromServiceDate: fromServiceDate, ToServiceDate: toServiceDate,
    IncludeOpportunityInfo: includeOpportunityInfo,
  });
}

/**
 * Pulls an array out of whatever shape `GET /api/customers` actually returns. The dev portal's
 * documented shape is a plain array, but that's never been checked against a real response (this
 * sandbox has no internet access to SmartMoving) — real API responses have twice already turned
 * out to differ from the portal's documented shape in this project (see getJobsByOpportunityId's
 * history above). Tries the plain-array shape first, then falls back to the common wrapper keys
 * used elsewhere in this same API (`pageResults`) and a couple of generic ones, so a shape
 * mismatch degrades to "still finds the data" instead of "silently returns nothing."
 */
function extractCustomersArray(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    for (const key of ['pageResults', 'results', 'customers', 'items', 'data']) {
      if (Array.isArray(result[key])) return result[key];
    }
  }
  console.warn(
    `smartmovingClient: GET /api/customers returned an unexpected shape (not an array, and no ` +
    `pageResults/results/customers/items/data array found). Got: ${typeof result} with keys ` +
    `${result && typeof result === 'object' ? Object.keys(result).join(', ') : String(result)}. ` +
    `This endpoint's real response shape may not match what's documented — check the raw response.`
  );
  return [];
}

async function getAllCustomersWithOpportunities({ fromServiceDate, toServiceDate } = {}) {
  const all = [];
  let page = 1;
  const pageSize = 100;
  for (let i = 0; i < 200; i++) {
    const result = await getCustomersPage({ page, pageSize, fromServiceDate, toServiceDate });
    const results = extractCustomersArray(result);
    all.push(...results);
    // Some APIs report `lastPage`/`totalPages` even when the body itself is a bare array under a
    // wrapper — check for that too before falling back to "short page means done."
    const lastPageFlag = result && typeof result === 'object' && !Array.isArray(result) ? result.lastPage : undefined;
    if (lastPageFlag === true || (lastPageFlag === undefined && results.length < pageSize) || results.length === 0) break;
    page += 1;
  }
  return all;
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

module.exports = {
  getLeadsPage, getAllLeads, getJobsByOpportunityId, getJobDetails, getOpportunityDetails,
  getCrewMembersPage, getAllCrewMembers, getJobsByCrewMemberIdPage, getAllJobsByCrewMemberId,
  getCustomersPage, getAllCustomersWithOpportunities,
  BASE_URL,
};
