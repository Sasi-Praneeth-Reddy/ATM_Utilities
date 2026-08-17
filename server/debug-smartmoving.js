/**
 * One-off diagnostic — NOT used by the running server. Run this from your own machine (this
 * sandbox has no internet access to SmartMoving) to see exactly what your account's real API
 * returns from all three of the poll sweep's discovery sources:
 *
 *   1. GET /api/leads — confirmed via the dev portal to only ever return New/InProgress
 *      opportunities by default; it can never include Booked/Completed/Closed ones.
 *   2. GET /api/crew-members/{id}/jobs — lists real jobs directly, bypassing /api/leads
 *      entirely, but only finds jobs that already have a crew member assigned.
 *   3. GET /api/customers — finds a job regardless of lead-pipeline stage OR crew assignment;
 *      this is what catches a Booked job that's had nobody staffed on it yet.
 *
 * Usage:
 *   cd server
 *   node debug-smartmoving.js [daysBack] [daysAhead]
 *
 * Defaults to a wide window (60 days back, 90 ahead) so it's unlikely to miss anything.
 * Prints only counts, statuses, ids, and field names — no customer names/addresses.
 */
require('./load-env');
const {
  getAllLeads, getOpportunityDetails, getAllCrewMembers, getAllJobsByCrewMemberId,
  getAllCustomersWithOpportunities, getCustomersPage,
} = require('./smartmovingClient');

const OPPORTUNITY_STATUS = {
  0: 'NewLead', 1: 'LeadInProgress', 3: 'Opportunity', 4: 'Booked',
  10: 'Completed', 11: 'Closed', 20: 'Cancelled', 30: 'Lost', 50: 'BadLead',
};

function yyyymmdd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

(async () => {
  const daysBack = Number(process.argv[2] || 60);
  const daysAhead = Number(process.argv[3] || 90);
  const from = yyyymmdd(-daysBack);
  const to = yyyymmdd(daysAhead);

  console.log(`Window: From=${from} To=${to}\n`);

  console.log('=== Source 1: GET /api/leads (IncludeBad=false IncludeLost=false) ===');
  let leads = [];
  try {
    leads = await getAllLeads({ from, to, includeBad: false, includeLost: false });
    console.log(`Returned ${leads.length} lead(s).`);
    const byStatus = {};
    leads.forEach(l => {
      const label = OPPORTUNITY_STATUS[l.status] ?? `unknown(${l.status})`;
      byStatus[label] = (byStatus[label] || 0) + 1;
    });
    console.log('Status breakdown:', byStatus);
    const hasBookedOrLater = Object.keys(byStatus).some(s => ['Booked', 'Completed', 'Closed'].includes(s));
    if (!hasBookedOrLater) {
      console.log('(Expected: no Booked/Completed/Closed here — /api/leads structurally never includes them.)');
    }
  } catch (err) {
    console.error('FAILED to fetch leads:', err.message);
  }

  console.log('\n=== Source 2: GET /api/crew-members (all statuses) + GET /api/crew-members/{id}/jobs ===');
  const crewOpportunityIds = new Set();
  try {
    const crewMembers = await getAllCrewMembers(); // no status filter — see smartmovingClient.js
    const byStatus = {};
    crewMembers.forEach(c => { byStatus[c.status || '(none)'] = (byStatus[c.status || '(none)'] || 0) + 1; });
    console.log(`${crewMembers.length} crew member(s) total. Status breakdown:`, byStatus);
    for (const crew of crewMembers) {
      try {
        const jobs = await getAllJobsByCrewMemberId(crew.id, { from, to });
        jobs.forEach(job => { if (job.opportunityId) crewOpportunityIds.add(job.opportunityId); });
        console.log(`  ${crew.name} (${crew.id}, ${crew.status}): ${jobs.length} job(s) in window`);
      } catch (err) {
        console.log(`  ${crew.name} (${crew.id}, ${crew.status}): ERROR ${err.message}`);
      }
    }
    console.log(`Distinct opportunities found via crew jobs: ${crewOpportunityIds.size}`);
  } catch (err) {
    console.error('FAILED to fetch crew members:', err.message);
  }

  console.log('\n=== Source 3: GET /api/customers (filtered by service date, all opportunity statuses) ===');
  const customerOpportunityIds = new Set();
  try {
    const rawFirstPage = await getCustomersPage({ page: 1, pageSize: 100, fromServiceDate: from, toServiceDate: to });
    const rawIsArray = Array.isArray(rawFirstPage);
    console.log(`Raw first-page response shape: ${rawIsArray ? 'plain array' : typeof rawFirstPage}` +
      (!rawIsArray && rawFirstPage && typeof rawFirstPage === 'object' ? ` with keys [${Object.keys(rawFirstPage).join(', ')}]` : ''));
    if (!rawIsArray) {
      console.log('Full raw response (first 2000 chars):', JSON.stringify(rawFirstPage).slice(0, 2000));
    }

    const customers = await getAllCustomersWithOpportunities({ fromServiceDate: from, toServiceDate: to });
    console.log(`${customers.length} customer(s) returned in this window.`);
    if (customers.length === 0) {
      console.log('0 customers found — if the raw shape above looks like real data, the array-extraction fallback in ' +
        'smartmovingClient.js may need another key name added. Paste the "Full raw response" line above if you report this.');
    }
    customers.forEach(customer => {
      (customer.opportunities || []).forEach(opp => {
        if (opp.id && Array.isArray(opp.jobs) && opp.jobs.length > 0) customerOpportunityIds.add(opp.id);
      });
    });
    console.log(`Distinct opportunities-with-jobs found via customers: ${customerOpportunityIds.size}`);
  } catch (err) {
    console.error('FAILED to fetch customers:', err.message);
  }

  const leadIds = new Set(leads.map(l => l.id));
  const onlyViaCrewJobs = [...crewOpportunityIds].filter(id => !leadIds.has(id));
  const onlyViaCustomers = [...customerOpportunityIds].filter(id => !leadIds.has(id) && !crewOpportunityIds.has(id));
  console.log(`\nOpportunities found via crew jobs but NOT in /api/leads: ${onlyViaCrewJobs.length}`);
  console.log(`Opportunities found via customers but NOT in leads or crew jobs (likely unstaffed bookings): ${onlyViaCustomers.length}`);
  if (onlyViaCustomers.length > 0) {
    console.log('These are exactly the jobs neither the old leads-only nor the crew-jobs-only poll sweep could ever find.');
  }

  const allIds = new Set([...leadIds, ...crewOpportunityIds, ...customerOpportunityIds]);
  console.log(`\n=== Opportunity detail + jobs[] check (union of all three sources, ${allIds.size} total, first 20) ===`);
  console.log('id | status | jobs[].length | top-level keys returned\n');
  let i = 0;
  for (const id of allIds) {
    if (i++ >= 20) break;
    try {
      const opp = await getOpportunityDetails(id);
      const jobCount = Array.isArray(opp.jobs) ? opp.jobs.length : 'jobs field missing/not array';
      console.log(`${id} | ${OPPORTUNITY_STATUS[opp.status] ?? opp.status} | ${jobCount} | ${Object.keys(opp).join(', ')}`);
    } catch (err) {
      console.log(`${id} | ERROR: ${err.message}`);
    }
  }

  console.log('\nDone. Paste this whole output back — no customer PII is printed, just ids/statuses/counts/field names.');
})();
