/**
 * One-off diagnostic — answers "SmartMoving shows date X for this job, the scheduler board still
 * shows date Y, why?" for one job/opportunity number.
 *
 * Three things can each independently explain a stale date, and this prints all three so it's
 * obvious which one actually applies instead of guessing:
 *
 *   1. MANUAL EDIT LOCK (db.js's manuallyEditedAt/manuallyEditedBy) — if a dispatcher has EVER
 *      hand-edited customer/type/date/endDate/startTime/endTime/duration/origin/destination/
 *      crewSize/notes on this job, upsertSmartMovingJob AND mergeCalendarDataOntoExistingJob both
 *      skip the job ENTIRELY on every future sync (not just leave the edited field alone — see
 *      db.js's MANUAL_EDIT_LOCK_FIELDS comment) until someone clicks "Resync from source". This is
 *      very likely to be it: it's the one path where the date can be stuck FOREVER, not just until
 *      the next sync runs.
 *   2. NO SYNC HAS RUN SINCE THE CHANGE — pollSweepScheduled was paused in the live Cloud Scheduler
 *      console 2026-08-24 and was only re-enabled (as a once-daily 6am backstop) on 2026-09-29; the
 *      calendar sync (calendarSweepScheduled/403pm) kept running throughout, but only carries truck/
 *      crew TEXT and a long-distance endDate — see mapIcalEvent.js — not the primary jobDate. If
 *      this job isn't locked, this is the next most likely explanation.
 *   3. SOURCE MISMATCH — a job that only ever came from a Smart Insights report (source: a bare
 *      quarterly/booked-opportunities/all-jobs email) doesn't get touched by the REST poll or
 *      calendar sync at all unless/until it's matched up (see db.js's findCounterpartJobId) — see
 *      debug-job-lookup.js for tracing that path specifically.
 *
 * Read-only: one live SmartMoving API call (getOpportunityDetails), one Firestore read per
 * candidate doc id. Writes nothing.
 *
 * Usage:
 *   cd server
 *   node debug-job-date-drift.js 24131
 *   node debug-job-date-drift.js 24131-1
 */
require('./load-env');
const { getOpportunityDetails } = require('./smartmovingClient');
const { opportunityIdFromJobNumber } = require('./smartInsightsAllJobsReport');
const db = require('./db');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node debug-job-date-drift.js <jobNumberOrOpportunityId>   (e.g. node debug-job-date-drift.js 24131)');
  process.exit(1);
}
const opportunityId = opportunityIdFromJobNumber(arg);

function smartMovingIntDateToIso(intDate) {
  if (!intDate) return null;
  const s = String(intDate);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

(async () => {
  console.log(`Checking "${arg}" (opportunity id "${opportunityId}")...\n`);

  console.log('=== Live SmartMoving data (GET /api/opportunities/{id}) ===');
  const opp = await getOpportunityDetails(opportunityId);
  const jobs = Array.isArray(opp.jobs) ? opp.jobs : [];
  if (!jobs.length) {
    console.log('  No jobs[] on this opportunity — nothing to compare.');
  } else {
    jobs.forEach((j) => {
      console.log(`  Job ${j.jobNumber}: live jobDate = ${smartMovingIntDateToIso(j.jobDate)} (raw ${j.jobDate})`);
    });
  }

  console.log('\n=== What the scheduler board has stored (Firestore) ===');
  const candidateIds = [`SM-${arg}`, `SI-${arg}`];
  // Also try every job number actually returned by the live call above, in case the arg given was
  // a bare opportunity id rather than a full job number.
  jobs.forEach((j) => {
    candidateIds.push(`SM-${j.jobNumber}`, `SI-${j.jobNumber}`);
  });
  const seen = new Set();
  let foundAny = false;
  for (const id of candidateIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const job = await db.getJob(id);
    if (!job) continue;
    foundAny = true;
    console.log(`  FOUND ${job.id}:`);
    console.log(`    date = ${job.date}   endDate = ${job.endDate}`);
    console.log(`    source = ${job.source}`);
    console.log(`    manuallyEditedAt = ${job.manuallyEditedAt || '(not locked)'}${job.manuallyEditedBy ? `  by ${job.manuallyEditedBy}` : ''}`);
    console.log(`    truckLockedAt = ${job.truckLockedAt || '(not locked)'}`);
    if (job.manuallyEditedAt) {
      console.log(
        '    ^ THIS IS LIKELY THE CAUSE: this job is manual-edit-locked, so upsertSmartMovingJob and ' +
        'mergeCalendarDataOntoExistingJob both SKIP it entirely on every sync (see db.js\'s ' +
        'MANUAL_EDIT_LOCK_FIELDS comment) — the date will never update on its own again until ' +
        '"Resync from source" is used on this job, regardless of how many more times SmartMoving ' +
        'changes it.'
      );
    }
  }
  if (!foundAny) {
    console.log(`  Not found under any of: ${[...seen].join(', ')}`);
  }

  console.log(
    '\nIf manuallyEditedAt is NOT set above and the board date still doesn\'t match the live date: ' +
    'the most likely cause is simply that no sync has touched this job since the date changed in ' +
    'SmartMoving — pollSweepScheduled only just resumed today (2026-09-29) as a once-daily 6am job, ' +
    'so it may not have run yet since this change. Use the "Sync Now" button (if the UI has one for ' +
    'a manual poll) or wait for tomorrow\'s 6am run to confirm this resolves on its own.'
  );

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
