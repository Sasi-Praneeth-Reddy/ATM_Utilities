/**
 * One-off diagnostic — checks what SmartMoving actually returns per job for crew/driver/vehicle
 * assignment, to decide how to auto-populate the truck board from an already-staffed SmartMoving
 * job. Not used by the running server. Read-only, no writes.
 *
 * What it prints, for a handful of real booked jobs:
 *   - The FULL crewMembers[] objects on each job (not just the count) — need to see what fields
 *     each crew member has (id? name? role? "driver" flag?).
 *   - All top-level keys on the opportunity and job objects, so we can spot anything vehicle/truck
 *     related that isn't already known about (dispatchInfo, assignedVehicle, truckId, etc.)
 *   - Whether the Premium-tier per-job detail endpoint (getJobDetails) is reachable on this account,
 *     and if so, its crewMembers/dispatch shape too (it may carry more detail than the basic
 *     opportunity endpoint).
 *
 * Usage (run from your machine — this needs internet access to SmartMoving and has none from
 * Claude's sandbox):
 *   cd server
 *   node debug-crew-truck-fields.js [daysBack] [daysAhead]
 *
 * Prints crew member names — that's the whole point, we need to see real values to judge whether
 * name-matching against your driver list is viable. Nothing else identifying (no customer names,
 * addresses) is printed.
 */
require('./load-env');
const {
  getAllCrewMembers, getAllJobsByCrewMemberId, getOpportunityDetails, getJobDetails,
} = require('./smartmovingClient');

function yyyymmdd(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

(async () => {
  const daysBack = Number(process.argv[2] || 30);
  const daysAhead = Number(process.argv[3] || 30);
  const from = yyyymmdd(-daysBack);
  const to = yyyymmdd(daysAhead);
  console.log(`Window: From=${from} To=${to}\n`);

  console.log('=== Your crew member roster (GET /api/crew-members) ===');
  const crewMembers = await getAllCrewMembers();
  console.log(`${crewMembers.length} crew member(s). First 10 raw objects:`);
  crewMembers.slice(0, 10).forEach(c => console.log(JSON.stringify(c)));

  console.log('\n=== Finding a few real staffed opportunities via crew jobs ===');
  const opportunityIds = new Set();
  for (const crew of crewMembers) {
    if (opportunityIds.size >= 5) break;
    try {
      const jobs = await getAllJobsByCrewMemberId(crew.id, { from, to });
      jobs.forEach(j => { if (j.opportunityId) opportunityIds.add(j.opportunityId); });
    } catch (err) {
      console.log(`  (skipping crew ${crew.name}: ${err.message})`);
    }
  }
  console.log(`Found ${opportunityIds.size} distinct opportunity id(s) to inspect.\n`);

  let checkedPremium = false;
  for (const oppId of opportunityIds) {
    console.log(`\n--- Opportunity ${oppId} ---`);
    const opp = await getOpportunityDetails(oppId);
    console.log('Opportunity top-level keys:', Object.keys(opp).join(', '));
    const jobs = opp.jobs || [];
    for (const job of jobs) {
      console.log(`  Job ${job.id} — top-level keys: ${Object.keys(job).join(', ')}`);
      console.log(`  Job ${job.id} — crewMembers[]:`, JSON.stringify(job.crewMembers, null, 2));

      if (!checkedPremium) {
        checkedPremium = true;
        console.log('\n  Trying Premium-tier per-job detail endpoint (getJobDetails)...');
        try {
          const premium = await getJobDetails(oppId, job.id);
          console.log('  Premium job top-level keys:', Object.keys(premium).join(', '));
          console.log('  Premium job crewMembers[]:', JSON.stringify(premium.crewMembers, null, 2));
          if (premium.dispatchInfo) {
            console.log('  Premium job dispatchInfo:', JSON.stringify(premium.dispatchInfo, null, 2));
          }
        } catch (err) {
          console.log(`  Premium endpoint not reachable (expected on Basic tier): ${err.message}`);
        }
      }
    }
  }

  console.log('\nDone. Paste this whole output back so we can design the driver/truck matching logic against real field names.');
})();
