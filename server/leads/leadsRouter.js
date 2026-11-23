/**
 * server/leads/leadsRouter.js
 *
 * Dedicated router for Pre-Mover Leads, Customer Address Matching, and Outreach.
 * Fully encapsulated in the leads/ subfolder.
 */

const crypto = require('crypto');
const leadsDb = require('./leadsDb');
const { generateOutreachDraft, sendOutreachEmail } = require('./outreachMailer');
const { hasValidScraperKey } = require('../scraperAuth');

/** Constant-time string compare (avoids leaking the scraper key through response timing). */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sendJson(req, res, status, body, extraHeaders) {
  const data = JSON.stringify(body);
  const origin = req.headers.origin;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
    ...(extraHeaders || {}),
  });
  res.end(data);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5e6) req.destroy(); // 5MB max for bulk imports
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  if (req.rawBody !== undefined) {
    if (!req.rawBody || !req.rawBody.length) return {};
    return JSON.parse(req.rawBody.toString('utf8'));
  }
  const raw = await readRequestBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * Handle incoming request if it matches /api/leads/*.
 * Returns true if handled, false if not a leads route.
 */
async function handleLeadsRequest(req, res, url, currentUser) {
  const p = url.pathname;
  if (!p.startsWith('/api/leads')) return false;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    sendJson(req, res, 204, {});
    return true;
  }

  // Auth requirement: Lead intelligence is restricted to logged-in admin and dispatcher users,
  // OR automated scrapers authenticated via x-api-key header matching SECRET_WEBHOOK_KEY.
  const hasValidApiKey = hasValidScraperKey(req);
  // 'owner' and 'developer' are above admin, so they count as admin here.
  const effectiveRole = currentUser && ['owner', 'developer'].includes(currentUser.role) ? 'admin' : (currentUser && currentUser.role);
  const isAuthorizedUser = Boolean(currentUser && ['admin', 'dispatcher'].includes(effectiveRole));
  const isAdmin = Boolean(currentUser && effectiveRole === 'admin');

  if (p === '/api/leads/ingest' || p === '/api/leads/analytics/refresh') {
    if (!hasValidApiKey && !isAuthorizedUser) {
      sendJson(req, res, 401, { error: 'Unauthorized: valid x-api-key header or dispatcher session required' });
      return true;
    }
  } else if (!isAuthorizedUser) {
    sendJson(req, res, 403, { error: 'Forbidden: Leads and matching require admin or dispatcher access' });
    return true;
  }

  try {
    // -------------------------------------------------------------
    // GET /api/leads/summary
    // -------------------------------------------------------------
    if (p === '/api/leads/summary' && req.method === 'GET') {
      const summary = await leadsDb.getLeadsSummary();
      sendJson(req, res, 200, summary);
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/analytics — Market breakdown, top realtors, counties
    // -------------------------------------------------------------
    if (p === '/api/leads/analytics' && req.method === 'GET') {
      // Served from one stored document (recomputed over ALL listings at most once a day).
      // ?refresh=1 forces a recompute (a full scan of every listing), so it is admin-only.
      const wantsRefresh = url.searchParams.get('refresh') === '1';
      if (wantsRefresh && !isAdmin) {
        sendJson(req, res, 403, { error: 'Forbidden: only admins can force an analytics refresh' });
        return true;
      }
      // Same filter params as /listings and /stats: the charts then cover only the matching listings.
      const monthParam = url.searchParams.get('month') || undefined;
      const filters = {
        status: url.searchParams.get('status') || undefined,
        state: url.searchParams.get('state') || undefined,
        county: url.searchParams.get('county') || undefined,
        search: url.searchParams.get('search') || undefined,
        minPrice: url.searchParams.get('minPrice') || undefined,
        maxPrice: url.searchParams.get('maxPrice') || undefined,
        month: monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : undefined,
      };
      const analytics = await leadsDb.getLeadsAnalytics({ refresh: wantsRefresh, filters });
      sendJson(req, res, 200, analytics);
      return true;
    }

    // POST /api/leads/analytics/refresh - the scraper calls this once after its last upload batch
    if (p === '/api/leads/analytics/refresh' && req.method === 'POST') {
      const fresh = await leadsDb.refreshLeadsAnalytics({ reload: true });
      sendJson(req, res, 200, { ok: true, computedAt: fresh.computedAt, totalListings: fresh.totalListings });
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/matches — List matched previous customers
    // -------------------------------------------------------------
    if (p === '/api/leads/matches' && req.method === 'GET') {
      const status = url.searchParams.get('status') || 'all';
      const matches = await leadsDb.listMatchedLeads(status);
      sendJson(req, res, 200, matches);
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/matches/:id/draft — Generate email draft
    // -------------------------------------------------------------
    const draftMatch = p.match(/^\/api\/leads\/matches\/([^/]+)\/draft$/);
    if (draftMatch && req.method === 'GET') {
      const matchId = draftMatch[1];
      const matches = await leadsDb.listMatchedLeads('all');
      const target = matches.find((m) => m.id === matchId);
      if (!target) {
        sendJson(req, res, 404, { error: 'Match record not found' });
        return true;
      }
      const draft = generateOutreachDraft(target);
      sendJson(req, res, 200, {
        ...draft,
        recipientEmail: target.customerEmail || '',
        customerName: target.customerName,
        customerPhone: target.customerPhone,
        matchedAddress: target.matchedAddress,
      });
      return true;
    }

    // -------------------------------------------------------------
    // POST /api/leads/matches/:id/status — Update match review status
    // -------------------------------------------------------------
    const statusMatch = p.match(/^\/api\/leads\/matches\/([^/]+)\/status$/);
    if (statusMatch && req.method === 'POST') {
      const matchId = statusMatch[1];
      const body = await readJsonBody(req);
      if (!body.status) {
        sendJson(req, res, 400, { error: 'Missing status field' });
        return true;
      }
      const updated = await leadsDb.updateMatchedLeadStatus(matchId, body.status, body.notes);
      sendJson(req, res, 200, updated);
      return true;
    }

    // -------------------------------------------------------------
    // POST /api/leads/matches/:id/send-outreach — 1-Click Ping
    // -------------------------------------------------------------
    const outreachMatch = p.match(/^\/api\/leads\/matches\/([^/]+)\/send-outreach$/);
    if (outreachMatch && req.method === 'POST') {
      const matchId = outreachMatch[1];
      const body = await readJsonBody(req);

      if (!body.to) {
        sendJson(req, res, 400, { error: 'Recipient email address (to) is required' });
        return true;
      }

      const emailResult = await sendOutreachEmail({
        toEmail: body.to,
        subject: body.subject || 'Around Town Movers — Thinking of your next move?',
        text: body.messageBody || body.text || '',
        html: body.html || undefined,
      });

      const outreachRecord = {
        sentBy: currentUser.email,
        recipient: body.to,
        subject: body.subject,
        messageBody: body.messageBody,
        notes: body.notes || '',
        emailResult,
      };

      const updated = await leadsDb.recordOutreach(matchId, outreachRecord);
      sendJson(req, res, 200, { success: true, emailResult, match: updated });
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/listings — List USA Home Listings
    // -------------------------------------------------------------
    if (p === '/api/leads/listings' && req.method === 'GET') {
      const status = url.searchParams.get('status') || undefined;
      const state = url.searchParams.get('state') || undefined;
      const county = url.searchParams.get('county') || undefined;
      const search = url.searchParams.get('search') || undefined;
      const minPrice = url.searchParams.get('minPrice') || undefined;
      const maxPrice = url.searchParams.get('maxPrice') || undefined;
      const monthParam = url.searchParams.get('month') || undefined;
      const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : undefined;
      const limit = Number(url.searchParams.get('limit')) || 200;
      const offset = Number(url.searchParams.get('offset')) || 0;
      const after = url.searchParams.get('after') || undefined; // previous page's endCursor (cheap paging)

      const result = await leadsDb.listPreMoverLeads({
        status,
        state,
        county,
        search,
        minPrice,
        maxPrice,
        month,
        limit,
        offset,
        after,
      });
      sendJson(req, res, 200, result);
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/stats — KPI numbers for the current filters (same params as /listings)
    // -------------------------------------------------------------
    if (p === '/api/leads/stats' && req.method === 'GET') {
      const monthParam = url.searchParams.get('month') || undefined;
      const stats = await leadsDb.getFilteredStats({
        status: url.searchParams.get('status') || undefined,
        state: url.searchParams.get('state') || undefined,
        county: url.searchParams.get('county') || undefined,
        search: url.searchParams.get('search') || undefined,
        minPrice: url.searchParams.get('minPrice') || undefined,
        maxPrice: url.searchParams.get('maxPrice') || undefined,
        month: monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : undefined,
      });
      sendJson(req, res, 200, stats);
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/export.csv — all listings matching the same filters as /listings, as CSV
    // -------------------------------------------------------------
    if (p === '/api/leads/export.csv' && req.method === 'GET') {
      const monthParam = url.searchParams.get('month') || undefined;
      const { csv, count } = await leadsDb.exportListingsCsv({
        status: url.searchParams.get('status') || undefined,
        state: url.searchParams.get('state') || undefined,
        county: url.searchParams.get('county') || undefined,
        search: url.searchParams.get('search') || undefined,
        minPrice: url.searchParams.get('minPrice') || undefined,
        maxPrice: url.searchParams.get('maxPrice') || undefined,
        month: monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : undefined,
      });
      const origin = req.headers.origin;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pre-mover-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
        'X-Row-Count': String(count),
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'X-Row-Count',
      });
      res.end(csv);
      return true;
    }

    // -------------------------------------------------------------
    // POST /api/leads/ingest — Ingest raw listings (from scraper)
    // -------------------------------------------------------------
    if (p === '/api/leads/ingest' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const leads = Array.isArray(body) ? body : body.leads || [];
      if (!Array.isArray(leads) || leads.length === 0) {
        sendJson(req, res, 400, { error: 'Invalid or empty listings payload' });
        return true;
      }
      const result = await leadsDb.upsertPreMoverLeads(leads);
      sendJson(req, res, 200, result);
      return true;
    }

    // -------------------------------------------------------------
    // POST /api/leads/import-legacy-customers — Upload customer CSV/JSON
    // -------------------------------------------------------------
    if (p === '/api/leads/import-legacy-customers' && req.method === 'POST') {
      if (!isAdmin) {
        sendJson(req, res, 403, { error: 'Forbidden: importing legacy customers requires admin access' });
        return true;
      }
      const body = await readJsonBody(req);
      const customers = Array.isArray(body) ? body : body.customers || [];
      if (!Array.isArray(customers) || customers.length === 0) {
        sendJson(req, res, 400, { error: 'Invalid or empty customer records array' });
        return true;
      }
      const result = await leadsDb.importLegacyCustomers(customers);
      sendJson(req, res, 200, result);
      return true;
    }

    // -------------------------------------------------------------
    // GET /api/leads/legacy-customers — List legacy records
    // -------------------------------------------------------------
    if (p === '/api/leads/legacy-customers' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 100;
      const customers = await leadsDb.listLegacyCustomers(limit);
      sendJson(req, res, 200, customers);
      return true;
    }

    // -------------------------------------------------------------
    // POST /api/leads/reconcile — match listings against past customers
    //   default: only listings added/changed since the last run (the first ever run checks all)
    //   ?full=1: re-check every listing (reads ~all of them — use sparingly)
    // Admin-only, and throttled to one manual run per 5 minutes.
    // -------------------------------------------------------------
    if (p === '/api/leads/reconcile' && req.method === 'POST') {
      if (!isAdmin) {
        sendJson(req, res, 403, { error: 'Forbidden: running a match sweep requires admin access' });
        return true;
      }
      const waitMs = await leadsDb.getReconcileCooldownMs();
      if (waitMs > 0) {
        sendJson(req, res, 429, { error: `A match sweep ran recently. Try again in ${Math.ceil(waitMs / 1000)} seconds.`, retryAfterSeconds: Math.ceil(waitMs / 1000) });
        return true;
      }
      await leadsDb.markManualReconcile();
      const result = await leadsDb.reconcileMatches({ full: url.searchParams.get('full') === '1' });
      leadsDb.invalidateLeadsCache();
      sendJson(req, res, 200, result);
      return true;
    }

    // If route matches /api/leads/* but unrecognized endpoint:
    sendJson(req, res, 404, { error: `Endpoint not found: ${p}` });
    return true;
  } catch (err) {
    console.error(`[leadsRouter] Error handling ${p}:`, err);
    sendJson(req, res, 500, { error: err.message || 'Internal server error' });
    return true;
  }
}

module.exports = {
  handleLeadsRequest,
};
