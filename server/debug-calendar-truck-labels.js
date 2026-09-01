/**
 * One-off diagnostic — pulls the real "Trucks:" text straight from SmartMoving's synced Google
 * Calendar (via googleCalendarClient.js's fetchCalendarEvents(), the SAME call the live sync uses)
 * and compares it against what's registered in Admin > Trucks. Unlike debug-truck-label-match.js,
 * this does NOT depend on any job already existing in Firestore — it reads the calendar directly, so
 * it still works even if every SmartMoving-sourced job has since been deleted from the board.
 *
 * Read-only: makes a Calendar API read call (counts against no quota — Calendar API isn't
 * rate-limited the way the old SmartMoving REST API was) and one Firestore read for the current
 * truck list. Writes nothing anywhere.
 *
 * Prints:
 *   1. Every truck currently registered in Admin > Trucks, with its SmartMoving label(s) (or a flag
 *      if none are set).
 *   2. Every DISTINCT "Trucks:" value seen across real calendar events in the sync window, how many
 *      events used it, and whether db.findTruckIdBySmartMovingLabel — the EXACT function the live
 *      sync calls — currently matches it to a truck.
 *
 * Usage (run from your machine — needs real Google Calendar OAuth + Firestore access):
 *   cd server
 *   node debug-calendar-truck-labels.js
 *
 * (No GOOGLE_APPLICATION_CREDENTIALS needed for the calendar call itself — that's the OAuth refresh
 * token flow via smartInsightsGmail.js, same as the live sync. Firestore access for the truck list
 * still needs your usual local Firestore credentials/env, same as your other debug-*.js scripts —
 * if `db.getState()` fails below, set GOOGLE_APPLICATION_CREDENTIALS the same way you do for those.)
 */
require('./load-env');
const db = require('./db');
const { fetchCalendarEvents, CALENDAR_ID } = require('./googleCalendarClient');
const { parseDescription } = require('./mapIcalEvent');

(async () => {
  console.log(`Reading calendar ${CALENDAR_ID}...\n`);
  const [events, { trucks }] = await Promise.all([fetchCalendarEvents(), db.getState()]);
  console.log(`Fetched ${events.length} calendar event(s) in the sync window.\n`);

  console.log('=== Registered trucks (Admin > Trucks) ===');
  trucks.forEach((t) => {
    const labels = t.smartMovingLabels || [];
    console.log(`  ${t.name} (${t.id}) — labels: ${labels.length ? labels.map((l) => `"${l}"`).join(', ') : '(none set)'}`);
  });

  const counts = {};
  let withTruckText = 0;
  events.forEach((ev) => {
    const { trucksText } = parseDescription(ev.description);
    if (!trucksText) return;
    withTruckText += 1;
    counts[trucksText] = (counts[trucksText] || 0) + 1;
  });

  console.log(`\n=== Distinct "Trucks:" values seen on the calendar (${withTruckText} of ${events.length} event(s) had one) ===`);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  entries.forEach(([label, count]) => {
    const matchedId = db.findTruckIdBySmartMovingLabel(trucks, label);
    const matchedTruck = matchedId ? trucks.find((t) => t.id === matchedId) : null;
    console.log(`  "${label}" — ${count} event(s) — ${matchedTruck ? `MATCHES ${matchedTruck.name}` : 'NO MATCH'}`);
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

  if (!events.length) {
    console.log(
      '\nNo calendar events were returned at all — double-check SMARTMOVING_CALENDAR_ID / the ' +
      'calendar sync window, or that this account still has calendar.readonly access (see ' +
      'smartInsightsGmail.js).'
    );
  } else if (!withTruckText) {
    console.log(
      '\nEvents were found, but none had a "Trucks:" line at all — that would mean SmartMoving ' +
      'genuinely isn\'t sending truck text in this window\'s events (dispatchers haven\'t filled in ' +
      'the Trucks field on SmartMoving\'s side), not a matching problem on this app\'s side.'
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
