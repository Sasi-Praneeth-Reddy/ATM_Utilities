/**
 * One-time cleanup: removes leftover "opportunity-level" Smart Insights jobs from Firestore.
 *
 * Before the 2026-08-24 two-report redesign (see smartInsightsSync.js's file header), the Smart
 * Insights pipeline created one job PER OPPORTUNITY directly from the Booked Opportunities report,
 * keyed `SI-<opportunityId>` (e.g. "SI-24100"). The redesign replaced that with one job PER JOB
 * NUMBER from the All Jobs report, keyed `SI-<jobNumber>` (e.g. "SI-24100-1", "SI-24100-2",
 * "SI-24100-3") — but Firestore doesn't delete old documents just because the code that created
 * them changed. Any jobs the old code already wrote during earlier testing are still sitting
 * there, so an opportunity like 24100 now shows FOUR board entries instead of three: the stale
 * "SI-24100" alongside the three real "SI-24100-N" ones.
 *
 * This script finds and removes exactly those stale entries — jobs with source ===
 * 'smartmoving-insights' whose id has no trailing "-<sequence>" (a real All-Jobs-sourced job
 * number always has one — confirmed against a real report, see smartInsightsAllJobsReport.js's
 * file header). It does NOT touch anything else: not placeholder jobs, not SmartMoving-REST-poll
 * jobs (source: 'smartmoving'), and not any correctly-shaped "SI-<id>-<N>" job.
 *
 * Usage:
 *   cd server
 *   node cleanup-stale-smart-insights-jobs.js         # dry run — prints what WOULD be deleted
 *   node cleanup-stale-smart-insights-jobs.js --yes    # actually deletes them
 *
 * Point this at the REAL deployed Firestore (the same "atm-scheduler" project the live app and
 * Cloud Functions use — there's only one, so this really does affect what everyone sees on the
 * live board) with a ONE-OFF environment variable, not by adding anything to server/local.secrets
 * — that file is loaded unconditionally by every server process INCLUDING the deployed Cloud
 * Function, so a GOOGLE_APPLICATION_CREDENTIALS path sitting in it would crash the live function on
 * its next deploy (see local.secrets' own header comment; same reasoning as
 * migrate-to-firestore.js's usage notes). From server/, using the same downloaded service account
 * key already used for that script:
 *
 *   PowerShell:
 *     $env:FIREBASE_PROJECT_ID="atm-scheduler"; $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; node cleanup-stale-smart-insights-jobs.js
 *   then, once the dry-run list looks right:
 *     $env:FIREBASE_PROJECT_ID="atm-scheduler"; $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; node cleanup-stale-smart-insights-jobs.js --yes
 *
 * Without both env vars set for this specific command, this fails outright (no credentials to
 * authenticate with) rather than silently doing nothing or hitting the wrong project — a missing
 * var is a safe failure here, not a silent risk.
 */

require('./load-env');

const DRY_RUN = !process.argv.includes('--yes');

// A real All-Jobs-sourced job id always ends in "-<digits>" (the job's sequence number within its
// opportunity) — e.g. "SI-24100-1". A stale opportunity-level id from the old design has no such
// suffix — e.g. "SI-24100". This intentionally does NOT match "SI-24100-1" (has a suffix) so it
// only ever selects the old shape.
const STALE_ID_PATTERN = /^SI-[^-]+$/;

async function main() {
  const { db } = require('./firestore');
  const jobsCol = db.collection('jobs');

  const snap = await jobsCol.where('source', '==', 'smartmoving-insights').get();
  const stale = snap.docs.filter((doc) => STALE_ID_PATTERN.test(doc.id));

  if (stale.length === 0) {
    console.log('No stale opportunity-level Smart Insights jobs found — nothing to do.');
    return;
  }

  console.log(`Found ${stale.length} stale opportunity-level job(s):\n`);
  stale.forEach((doc) => {
    const d = doc.data();
    console.log(`  ${doc.id}  —  ${d.customer || '(no customer)'}  —  ${d.date || '(no date)'}`);
  });

  if (DRY_RUN) {
    console.log(`\nDry run — nothing deleted. Re-run with --yes to actually delete these ${stale.length} job(s).`);
    return;
  }

  console.log(`\nDeleting ${stale.length} job(s)...`);
  for (const doc of stale) {
    await doc.ref.delete();
    console.log(`  deleted ${doc.id}`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
