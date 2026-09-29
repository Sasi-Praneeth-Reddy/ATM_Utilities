/**
 * One-off diagnostic — dumps the FULL raw SmartMoving opportunity detail (including whatever
 * `IncludeDispatchInfo: true` adds — see smartmovingClient.js's getOpportunityDetails) for ONE
 * opportunity/job, so we can find the exact field SmartMoving uses to mark a job "Hold" (the new
 * "reserves a dispatch slot / capacity, but not booked, never published to crew" state seen on the
 * live dispatch board — see the 2026-09-28 conversation this was written for).
 *
 * getOpportunityDetails is already called by every real sync path (hydrateOpportunity in
 * server.js) with this same IncludeDispatchInfo flag — this script changes nothing about what gets
 * fetched, it just prints what's already being requested and, today, thrown away unread (neither
 * mapJobs.js nor mapOpportunity.js currently reads anything dispatch-specific off the response).
 *
 * Why this matters before touching the sync: mapJobs.js's OPPORTUNITY_STATUS enum (0 NewLead,
 * 1 LeadInProgress, 3 Opportunity, 4 Booked, 10 Completed, 11 Closed, 20 Cancelled, 30 Lost,
 * 50 BadLead) has NO "Hold" value at all — so Hold can't be a simple opportunity-status widening
 * (adding status 3 "Opportunity" to BOOKED_STATUSES would readmit every ordinary unconfirmed
 * quote, exactly the flood the 2026-09-24 cleanup just fixed). Hold is almost certainly a
 * job-level/dispatch-level field instead, which is exactly what IncludeDispatchInfo is for.
 *
 * Usage (run from your machine — same SMARTMOVING_API_KEY requirement as debug-smartmoving.js):
 *   cd server
 *   node debug-hold-dispatch-info.js 1071-1
 *
 * Read-only. SmartMoving's API has no write endpoints at all (see smartmovingClient.js's file
 * header), and this makes exactly one GET call — safe to run as many times as you want.
 */
require('./load-env');
const { getOpportunityDetails, getJobDetails } = require('./smartmovingClient');
const { opportunityIdFromJobNumber } = require('./smartInsightsAllJobsReport');

const OPPORTUNITY_STATUS = {
  0: 'NewLead', 1: 'LeadInProgress', 3: 'Opportunity', 4: 'Booked',
  10: 'Completed', 11: 'Closed', 20: 'Cancelled', 30: 'Lost', 50: 'BadLead',
};

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node debug-hold-dispatch-info.js <jobNumberOrOpportunityId>   (e.g. node debug-hold-dispatch-info.js 1071-1)');
  process.exit(1);
}
const opportunityId = opportunityIdFromJobNumber(arg);

/** Recursively walks the response looking for any key that mentions "hold" or "dispatch" —
 * wherever SmartMoving put the Hold flag, it's almost certainly named something in that family.
 * Prints the path (e.g. "jobs[0].dispatchInfo.status") and value so it's easy to spot without
 * reading the whole dump line by line. Not a guarantee — if nothing turns up here, the full dump
 * below is still printed so we can eyeball it by hand. */
function findInterestingFields(value, path, out) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => findInterestingFields(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, v]) => {
      const nextPath = path ? `${path}.${key}` : key;
      if (/hold|dispatch/i.test(key)) out.push({ path: nextPath, value: v });
      findInterestingFields(v, nextPath, out);
    });
  }
}

(async () => {
  console.log(`Fetching opportunity "${opportunityId}" (from "${arg}")...\n`);
  const opp = await getOpportunityDetails(opportunityId);

  console.log(`Opportunity status: ${OPPORTUNITY_STATUS[opp.status] ?? opp.status} (code ${opp.status})`);
  console.log(`Jobs on this opportunity: ${Array.isArray(opp.jobs) ? opp.jobs.length : '(jobs field missing)'}\n`);

  console.log('=== Fields with "hold" or "dispatch" anywhere in their name ===');
  const interesting = [];
  findInterestingFields(opp, '', interesting);
  if (interesting.length === 0) {
    console.log('  None found by name — the Hold flag may be named something else. See the full dump below.');
  } else {
    interesting.forEach(({ path, value }) => {
      console.log(`  ${path} = ${JSON.stringify(value)}`);
    });
  }

  console.log('\n=== Full raw response ===');
  console.log(JSON.stringify(opp, null, 2));

  // Added 2026-09-28: the basic opportunity endpoint's IncludeDispatchInfo turned up nothing on a
  // real Hold job — no dispatchInfo object, no truck/crew field. Last remaining candidate: the
  // Premium-tier per-job detail endpoint, which this codebase has a client for (getJobDetails) but
  // has never actually called anywhere. Likely to 403 on a Basic-tier account — that's a real,
  // expected outcome here, not a bug in this script, and tells us just as much as a success would.
  const jobs = Array.isArray(opp.jobs) ? opp.jobs : [];
  if (jobs.length > 0) {
    console.log(`\n=== Premium job detail (GET /api/premium/opportunities/{id}/jobs/{jobId}) ===`);
    for (const job of jobs) {
      try {
        const detail = await getJobDetails(opportunityId, job.id, { includeStops: true, includeDispatchInfo: true });
        console.log(`  Job ${job.jobNumber} (${job.id}) — SUCCESS, full response:`);
        console.log(JSON.stringify(detail, null, 2));
        const premiumInteresting = [];
        findInterestingFields(detail, `premium(${job.jobNumber})`, premiumInteresting);
        if (premiumInteresting.length > 0) {
          console.log('  Fields with "hold" or "dispatch" in their name, from the premium response:');
          premiumInteresting.forEach(({ path, value }) => console.log(`    ${path} = ${JSON.stringify(value)}`));
        }
      } catch (err) {
        console.log(`  Job ${job.jobNumber} (${job.id}) — FAILED: ${err.message}`);
        console.log('  (A 403 here likely just means this account isn\'t on SmartMoving\'s Premium tier — that\'s expected, not an error to fix.)');
      }
    }
  }

  console.log('\nPaste this whole output back — this is your own account\'s data, nothing needs redacting.');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
