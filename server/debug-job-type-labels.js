/**
 * One-off diagnostic — pulls the real job-type free text straight from SmartMoving's synced Google
 * Calendar (via googleCalendarClient.js's fetchCalendarEvents(), the SAME call the live sync uses)
 * and shows exactly how jobTypeInference.js's classifyJob() would categorize each distinct value —
 * before trusting the DEL/UPK/LOAD/Moving/Long Distance regexes in that module against real data.
 * Same shape as debug-calendar-truck-labels.js (see its header) — read-only, no Firestore writes.
 *
 * The label text this prints is header line 2 of each event's DESCRIPTION — "<jobNumber> / <job
 * type free text> / <ref>" (see mapIcalEvent.js's file header for the full block layout) — split
 * out by parseDescription as `jobTypeLabel`. This text is NOT currently stored anywhere in
 * Firestore (only the derived `type`/`serviceCategory` are, as of 2026-08-28), so the calendar feed
 * is the only place to see the real, raw vocabulary SmartMoving actually sends.
 *
 * Prints, per distinct jobTypeLabel value: how many events used it, and what classifyJob()
 * currently derives from it — `type` (local/long_distance) and `serviceCategory` (the board color
 * grading category) — using ONLY the label (no address/mileage) as the origin/destination inputs,
 * since the point here is to sanity-check the label vocabulary itself.
 *
 * Usage (run from your machine — same requirements as debug-calendar-truck-labels.js):
 *   cd server
 *   node debug-job-type-labels.js
 */
require('./load-env');
const { fetchCalendarEvents, CALENDAR_ID } = require('./googleCalendarClient');
const { parseDescription } = require('./mapIcalEvent');
const { classifyJob, inferServiceCategory } = require('./jobTypeInference');

(async () => {
  console.log(`Reading calendar ${CALENDAR_ID}...\n`);
  const events = await fetchCalendarEvents();
  console.log(`Fetched ${events.length} calendar event(s) in the sync window.\n`);

  const counts = {};
  let withLabel = 0;
  events.forEach((ev) => {
    const { jobTypeLabel } = parseDescription(ev.description);
    if (!jobTypeLabel) return;
    withLabel += 1;
    counts[jobTypeLabel] = (counts[jobTypeLabel] || 0) + 1;
  });

  console.log(`=== Distinct job-type label values seen on the calendar (${withLabel} of ${events.length} event(s) had one) ===`);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  entries.forEach(([label, count]) => {
    // Label only — no address/mileage — so this shows exactly what the TEXT alone would classify
    // as, isolating the label-regex behavior from the separate mileage-override signal.
    const { type, serviceCategory } = classifyJob({ jobTypeLabel: label });
    console.log(`  "${label}" — ${count} event(s) — type: ${type}, category: ${serviceCategory ?? '(none)'}`);
  });

  const uncategorized = entries.filter(([label]) => inferServiceCategory(label) === 'other');
  console.log(`\n${uncategorized.length} of ${entries.length} distinct value(s) fell through to 'other' — check these aren't a` +
    ' common label this app should be recognizing by name (e.g. a variant spelling/casing the current regexes miss).');
  if (uncategorized.length) uncategorized.forEach(([label, count]) => console.log(`  "${label}" — ${count} event(s)`));

  if (!events.length) {
    console.log(
      '\nNo calendar events were returned at all — double-check SMARTMOVING_CALENDAR_ID / the ' +
      'calendar sync window, or that this account still has calendar.readonly access (see ' +
      'smartInsightsGmail.js).'
    );
  } else if (!withLabel) {
    console.log(
      '\nEvents were found, but none had a job-type label at all — that would mean header line 2 ' +
      'of DESCRIPTION isn\'t in the "<jobNumber> / <type> / <ref>" shape this app expects for at ' +
      'least these events, not a classification problem.'
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
