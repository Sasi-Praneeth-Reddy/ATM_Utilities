/**
 * One-off diagnostic — explains why the last live calendar sync auto-assigned 0 trucks out of 341
 * matched jobs. Read-only: only reads Firestore (via db.getState()), makes NO calendar/API calls
 * and writes nothing.
 *
 * Why this doesn't need to hit the Calendar API again: every calendar-matched job already has its
 * real SmartMoving "Trucks:" text written onto smartMovingTruckText (see db.js's
 * mergeCalendarDataOntoExistingJob / upsertSmartMovingJob) from the last sync run — so the raw
 * values worth comparing against Admin > Trucks are already sitting in Firestore right now.
 *
 * Prints:
 *   1. Every truck currently registered in Admin > Trucks, with its SmartMoving label(s) (or a flag
 *      if none are set).
 *   2. Every DISTINCT "Trucks:" value SmartMoving has sent on a synced job, how many jobs used it,
 *      and whether db.findTruckIdBySmartMovingLabel — the EXACT real matching function the live
 *      sync uses — currently matches it to a truck. Same normalization the real sync applies
 *      (uppercase, strip everything that isn't a letter or digit), so what's shown here is exactly
 *      what the sync sees — no guessing, no separate matching logic.
 *
 * Usage (run from your machine — needs real Firestore access, same as your other debug-*.js scripts):
 *   cd server
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; node debug-truck-label-match.js
 *
 * (Adjust the key filename if yours differs.)
 */
require('./load-env');
const db = require('./db');

(async () => {
  const { trucks, jobs } = await db.getState();

  console.log('=== Registered trucks (Admin > Trucks) ===');
  trucks.forEach((t) => {
    const labels = t.smartMovingLabels || [];
    console.log(`  ${t.name} (${t.id}) — labels: ${labels.length ? labels.map((l) => `"${l}"`).join(', ') : '(none set)'}`);
  });

  // Deliberately NOT filtering on `j.source === 'smartmoving'` here. A job's `source` field gets
  // flipped back to 'smartmoving-insights' every time the (separate, still-running) Smart Insights
  // report sync re-syncs that same job — see db.js's upsertSmartInsightsJob, own-id branch — even
  // after a calendar merge had upgraded it to 'smartmoving'. That overwrite does NOT clear
  // smartMovingTruckText (upsertSmartInsightsJob never touches that field), so filtering on source
  // would wrongly hide jobs that DO have real calendar truck text sitting on them. Truck text
  // presence alone is the reliable signal.
  const smJobs = jobs.filter((j) => j.smartMovingTruckText);
  console.log(`\n=== Distinct "Trucks:" values from SmartMoving (${smJobs.length} job(s) with truck text) ===`);
  const counts = {};
  smJobs.forEach((j) => {
    counts[j.smartMovingTruckText] = (counts[j.smartMovingTruckText] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  entries.forEach(([label, count]) => {
    const matchedId = db.findTruckIdBySmartMovingLabel(trucks, label);
    const matchedTruck = matchedId ? trucks.find((t) => t.id === matchedId) : null;
    console.log(`  "${label}" — ${count} job(s) — ${matchedTruck ? `MATCHES ${matchedTruck.name}` : 'NO MATCH'}`);
  });

  const unmatchedCount = entries.filter(([label]) => !db.findTruckIdBySmartMovingLabel(trucks, label)).length;
  console.log(`\n${unmatchedCount} of ${entries.length} distinct value(s) currently have no matching truck.`);
  console.log(
    'Fix: in Admin > Trucks, set each truck\'s "SmartMoving label" field to match the exact text ' +
    'shown above (comma-separate multiple aliases on one truck if it goes by more than one label). ' +
    'Matching is exact after uppercasing and stripping spaces/punctuation, so "ARC 130-2" and ' +
    '"arc1302" are treated the same — but "ARC 130" alone would NOT match "ARC 130-2", so copy the ' +
    'full value shown above, not a shortened version.'
  );

  if (!smJobs.length) {
    console.log(
      '\nNo jobs with truck text were found at all — that likely means no calendar-matched job ' +
      'currently exists (either the sync hasn\'t run since deploy, or every event this window is ' +
      'genuinely unmatched-and-skipped). Re-run the calendar sync first, then run this script again.'
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
