/**
 * Standalone SmartMoving API playground — completely separate from the scheduler app.
 *
 * This does NOT:
 *  - import server.js or db.js
 *  - touch the scheduler's SQLite database in any way
 *  - write anything back to SmartMoving (read-only GET calls only)
 *
 * It exists purely so you can see exactly what SmartMoving's real API returns — raw, unfiltered —
 * before the scheduler's sync code (server/mapOpportunity.js) assumes anything about the shape.
 * It reuses server/smartmovingClient.js (the same read-only API wrapper the scheduler uses) and
 * server/load-env.js, so it reads the same server/.env — no need to duplicate your API key.
 *
 * This sandbox that built it has no internet access, so it's never been run against a real
 * SmartMoving account — run it on your own machine:
 *
 *   cd smartmoving-playground
 *   node playground-server.js
 *
 * Then open http://localhost:8790
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

require('../server/load-env');
const {
  getAllLeads, getOpportunityDetails, getJobsByOpportunityId,
  getAllCrewMembers, getAllJobsByCrewMemberId, getAllCustomersWithOpportunities, getCustomersPage,
} = require('../server/smartmovingClient');

const PORT = process.env.PLAYGROUND_PORT || 8790;

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

function yyyymmdd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    }

    if (url.pathname === '/api/leads') {
      const daysBack = Number(url.searchParams.get('daysBack') || 60);
      const daysAhead = Number(url.searchParams.get('daysAhead') || 90);
      const includeBad = url.searchParams.get('includeBad') === 'true';
      const includeLost = url.searchParams.get('includeLost') === 'true';
      const from = yyyymmdd(-daysBack);
      const to = yyyymmdd(daysAhead);
      const leads = await getAllLeads({ from, to, includeBad, includeLost });
      return sendJson(res, 200, { from, to, count: leads.length, leads });
    }

    const oppMatch = url.pathname.match(/^\/api\/opportunity\/([^/]+)$/);
    if (oppMatch) {
      const opp = await getOpportunityDetails(decodeURIComponent(oppMatch[1]));
      return sendJson(res, 200, opp);
    }

    if (url.pathname === '/api/crew-jobs') {
      const daysBack = Number(url.searchParams.get('daysBack') || 60);
      const daysAhead = Number(url.searchParams.get('daysAhead') || 90);
      const from = yyyymmdd(-daysBack);
      const to = yyyymmdd(daysAhead);
      const crewMembers = await getAllCrewMembers(); // no status filter — see smartmovingClient.js
      const perCrew = [];
      const opportunityIds = new Set();
      for (const crew of crewMembers) {
        try {
          const jobs = await getAllJobsByCrewMemberId(crew.id, { from, to });
          jobs.forEach(job => { if (job.opportunityId) opportunityIds.add(job.opportunityId); });
          perCrew.push({ crew, jobs, error: null });
        } catch (err) {
          perCrew.push({ crew, jobs: [], error: err.message });
        }
      }
      return sendJson(res, 200, {
        from, to, crewCount: crewMembers.length,
        opportunityIds: [...opportunityIds], perCrew,
      });
    }

    if (url.pathname === '/api/customer-opportunities') {
      const daysBack = Number(url.searchParams.get('daysBack') || 60);
      const daysAhead = Number(url.searchParams.get('daysAhead') || 90);
      const from = yyyymmdd(-daysBack);
      const to = yyyymmdd(daysAhead);

      // Always grab one raw page directly (bypassing the array-extraction logic) so it can be
      // logged/returned as-is — the fastest way to see exactly what the real API sent back if
      // something looks off, without needing to add console.log statements and restart.
      const rawFirstPage = await getCustomersPage({ page: 1, pageSize: 100, fromServiceDate: from, toServiceDate: to });
      console.log(`GET /api/customers raw first page (From=${from} To=${to}):`, JSON.stringify(rawFirstPage).slice(0, 2000));

      const customers = await getAllCustomersWithOpportunities({ fromServiceDate: from, toServiceDate: to });
      const opportunities = [];
      customers.forEach(customer => {
        (customer.opportunities || []).forEach(opp => {
          if (opp.id && Array.isArray(opp.jobs) && opp.jobs.length > 0) {
            opportunities.push({ opportunityId: opp.id, customerName: customer.name, status: opp.status, jobCount: opp.jobs.length });
          }
        });
      });
      return sendJson(res, 200, {
        from, to, customerCount: customers.length, opportunities,
        // Only sent back to the browser when the result looks suspiciously empty, so you can see
        // exactly what came back without digging through the terminal.
        rawFirstPageSample: customers.length === 0 ? rawFirstPage : undefined,
      });
    }

    const jobsMatch = url.pathname.match(/^\/api\/premium-jobs\/([^/]+)$/);
    if (jobsMatch) {
      try {
        const jobs = await getJobsByOpportunityId(decodeURIComponent(jobsMatch[1]));
        return sendJson(res, 200, { ok: true, jobs });
      } catch (err) {
        // A 403/404 here is expected on Basic tier (this endpoint is Premium-only) — surface it
        // plainly instead of a 500, since it's informative rather than a real failure.
        return sendJson(res, 200, { ok: false, status: err.status || null, message: err.message });
      }
    }

    sendJson(res, 404, { error: 'Not found: ' + url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`SmartMoving playground running at http://localhost:${PORT}`);
  console.log('Read-only — does not touch the scheduler database or any SmartMoving write endpoint.');
});
