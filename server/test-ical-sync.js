/**
 * One-shot local test for the new iCal sync (pollIcalFeed in server.js) — run this BEFORE
 * deploying to Firebase to confirm the feed fetch, DESCRIPTION parsing, branch filtering, and
 * truck auto-matching all behave as expected against your real account.
 *
 * IMPORTANT: this writes to the SAME Firestore database the deployed app (and anyone currently
 * using it) reads from — there's no separate staging DB for this project. That's actually the
 * point (you want these real jobs in the real board), but it does mean this isn't a throwaway
 * test; any job it creates/updates will be visible to anyone using the app right now. Safe to
 * run — createJob/upsertSmartMovingJob never touch a dispatcher's existing truckIds/status on an
 * already-synced job (see db.js's upsertSmartMovingJob doc comment) — but not a no-op.
 *
 * Usage (run from server/, against real Firestore — see server/local.secrets for why
 * GOOGLE_APPLICATION_CREDENTIALS is set per-command instead of living in a file):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; node test-ical-sync.js
 *
 * (Adjust the key filename if yours differs — same file migrate-to-firestore.js's README section uses.)
 */
require('./load-env');
const { pollIcalFeed, db } = require('./server');

(async () => {
  console.log('Running pollIcalFeed()...\n');
  const result = await pollIcalFeed();

  console.log('=== Summary ===');
  console.log(`Jobs synced (created or updated): ${result.jobCount}`);
  console.log(`Auto-assigned a truck on creation: ${result.autoAssignedCount}`);
  console.log(`Skipped — other branch: ${result.skippedOtherBranch}`);
  console.log(`Skipped — unparseable: ${result.skippedUnparseable}`);
  console.log(`Errors: ${result.errors.length}`);
  if (result.errors.length) {
    console.log('\nFirst 5 errors:');
    result.errors.slice(0, 5).forEach(e => console.log(' ', JSON.stringify(e)));
  }

  const { trucks, jobs } = await db.getState();
  const smJobs = jobs.filter(j => j.source === 'smartmoving' && j.smartMovingTruckText);

  console.log(`\n=== Distinct "Trucks:" labels seen (${smJobs.length} SmartMoving job(s) with truck text) ===`);
  const labelCounts = {};
  smJobs.forEach(j => { labelCounts[j.smartMovingTruckText] = (labelCounts[j.smartMovingTruckText] || 0) + 1; });
  Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).forEach(([label, count]) => {
    console.log(`  "${label}" — ${count} job(s)`);
  });
  console.log('\nGo to Admin > Trucks and set each truck\'s "SmartMoving label" field to the matching ' +
    'text above (comma-separate if a truck goes by more than one label) — future syncs will then ' +
    'auto-assign that truck whenever a job lists it.');

  console.log('\n=== Trucks currently missing a SmartMoving label ===');
  trucks.filter(t => !(t.smartMovingLabels || []).length).forEach(t => console.log(`  ${t.id}: ${t.name}`));

  console.log('\n=== Sample of 3 synced jobs ===');
  smJobs.slice(0, 3).forEach(j => {
    console.log(`  ${j.id} | ${j.customer} | ${j.date} ${j.startTime} | Trucks: "${j.smartMovingTruckText}" | truckIds: ${JSON.stringify(j.truckIds)}`);
  });

  process.exit(0);
})().catch(err => {
  console.error('FAILED:', err);
  process.exit(1);
});
