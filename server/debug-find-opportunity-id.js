/**
 * One-off diagnostic — follow-up to debug-hold-dispatch-info.js.
 *
 * That script assumed a job's SmartMoving "opportunity id" is just its Job Number with the
 * trailing "-<sequence>" stripped (e.g. "1071-1" -> "1071") — true for every BOOKED job we've
 * checked so far (see smartInsightsAllJobsReport.js's opportunityIdFromJobNumber), because booked
 * jobs get sequential "Quote #"-style numbers that match. A Hold job apparently does NOT follow
 * that convention: `node debug-hold-dispatch-info.js 1071-1` 404'd on GET /api/opportunities/1071,
 * meaning "1071" isn't a real opportunity id — SmartMoving's real internal opportunity id is
 * probably some other id/GUID we haven't seen yet.
 *
 * This script sidesteps that guess entirely: GET /api/customers (same source pollSweep's
 * discovery already uses, see server.js) returns each customer's opportunities[] WITH their real
 * internal `id` field attached, across the full status range, no guessing required. This searches
 * that data for a job number or customer name and prints the real opportunity id it belongs to,
 * so debug-hold-dispatch-info.js can be re-run against the correct id.
 *
 * Usage (run from your machine, same as your other debug-*.js scripts):
 *   cd server
 *   node debug-find-opportunity-id.js "1071-1"        (search by job number)
 *   node debug-find-opportunity-id.js "Underwood"      (search by customer name substring)
 *   node debug-find-opportunity-id.js "1071-1" 2026-12-01 2027-01-31   (custom date window,
 *     YYYY-MM-DD — defaults to a wide window centered on today if omitted; widen this if the job's
 *     actual service date is different from what a screenshot's date picker happened to show)
 *
 * Read-only, no writes anywhere.
 */
require('./load-env');
const { getAllCustomersWithOpportunities } = require('./smartmovingClient');

const OPPORTUNITY_STATUS = {
  0: 'NewLead', 1: 'LeadInProgress', 3: 'Opportunity', 4: 'Booked',
  10: 'Completed', 11: 'Closed', 20: 'Cancelled', 30: 'Lost', 50: 'BadLead',
};

const searchTerm = process.argv[2];
if (!searchTerm) {
  console.error('Usage: node debug-find-opportunity-id.js <jobNumberOrCustomerNameSubstring> [fromDate] [toDate]');
  process.exit(1);
}
const searchLower = searchTerm.toLowerCase();

function ymdArgToInt(dateStr, fallbackOffsetDays) {
  if (!dateStr) {
    const d = new Date();
    d.setDate(d.getDate() + fallbackOffsetDays);
    return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
  }
  return Number(dateStr.replace(/-/g, ''));
}

// Default window: 90 days back to 180 days ahead — wide enough to catch a Hold job scheduled well
// into the future (the screenshot that prompted this showed one dated 12/31/2026) without the
// user having to know the exact date.
const from = ymdArgToInt(process.argv[3], -90);
const to = ymdArgToInt(process.argv[4], 180);

(async () => {
  console.log(`Searching for "${searchTerm}" in GET /api/customers, service date window ${from}-${to}...\n`);
  const customers = await getAllCustomersWithOpportunities({ fromServiceDate: from, toServiceDate: to });
  console.log(`${customers.length} customer(s) returned in this window.\n`);

  let matchCount = 0;
  customers.forEach((customer) => {
    (customer.opportunities || []).forEach((opp) => {
      const jobs = Array.isArray(opp.jobs) ? opp.jobs : [];
      const nameMatch = (customer.name || '').toLowerCase().includes(searchLower);
      const jobMatch = jobs.find((j) => String(j.jobNumber || '').toLowerCase() === searchLower);
      if (!nameMatch && !jobMatch) return;

      matchCount += 1;
      console.log(`MATCH: customer "${customer.name}"`);
      console.log(`  Real opportunity id: ${opp.id}`);
      console.log(`  Opportunity status: ${OPPORTUNITY_STATUS[opp.status] ?? opp.status} (code ${opp.status})`);
      console.log(`  Job numbers on this opportunity: ${jobs.map((j) => j.jobNumber).join(', ') || '(none)'}`);
      console.log(`  -> re-run: node debug-hold-dispatch-info.js ${opp.id}\n`);
    });
  });

  if (matchCount === 0) {
    console.log(
      `No match for "${searchTerm}" in this window. If you know the job's actual service date, re-run ` +
      `with an explicit window, e.g.:\n  node debug-find-opportunity-id.js "${searchTerm}" 2026-12-01 2027-01-31\n` +
      `If it still doesn't turn up, this Hold job may not be reachable via GET /api/customers at all ` +
      `(i.e. it may not be a true CRM opportunity/job the public API exposes) — worth checking, that ` +
      `would change the plan entirely.`
    );
  }
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
