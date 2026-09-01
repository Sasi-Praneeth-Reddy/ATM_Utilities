/**
 * One-off diagnostic — checks what SmartMoving's iCal (.ics) calendar feed actually contains, as a
 * possible NON-API way to pull jobs (no API key, no per-call quota — see server/README.md and the
 * 2026-08-18 quota-exhaustion incident). SmartMoving publishes a per-user iCal feed URL (Profile
 * menu -> Calendar Syncing -> iCal Calendar sync -> Copy) meant for subscribing Dispatch/Office
 * calendars into Apple/Google Calendar. It's a plain unauthenticated-by-URL-secret .ics file, which
 * is a completely different mechanism from the REST API — worth checking whether it carries enough
 * detail (customer, address, crew/truck info) to actually replace polling, or only enough for a
 * basic "something's on the calendar" signal.
 *
 * Deliberately does NOT touch server/db.js, server/mapOpportunity.js, or the SmartMoving REST API —
 * this is read-only, doesn't use SMARTMOVING_API_KEY, and doesn't count against the API quota.
 *
 * Usage (run from your machine — needs real internet access):
 *   node debug-ical-feed.js "<your iCal feed URL>"
 *
 * Don't commit or paste the URL anywhere shared — it's a per-user secret link, same as a webhook
 * secret or an API key. Prints the raw .ics text for the first few events only, so you can see the
 * real field names/structure yourself before deciding whether to paste any of it back (redact
 * customer names/addresses if you do paste output back — only the field NAMES matter for design,
 * e.g. whether SUMMARY/DESCRIPTION/LOCATION show up, not real customer data).
 */
const url = process.argv[2];
if (!url) {
  console.error('Usage: node debug-ical-feed.js "<your iCal feed URL>"\n' +
    'Get it from: SmartMoving -> your Profile menu -> Calendar Syncing -> iCal Calendar sync -> Copy');
  process.exit(1);
}

(async () => {
  const res = await fetch(url);
  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log('Content-Type:', res.headers.get('content-type'));
  const text = await res.text();
  console.log(`\nTotal length: ${text.length} chars\n`);

  // Split into VEVENT blocks and print just the first few, so this doesn't dump your entire
  // schedule's worth of customer data to the terminal at once.
  const events = text.split('BEGIN:VEVENT').slice(1).map(e => 'BEGIN:VEVENT' + e.split('END:VEVENT')[0] + 'END:VEVENT');
  console.log(`Found ${events.length} event(s) in the feed. First 3 raw:\n`);
  events.slice(0, 3).forEach((e, i) => {
    console.log(`--- Event ${i + 1} ---`);
    console.log(e.trim());
    console.log();
  });

  // Field-name summary across ALL events (no values, just which iCal properties are actually used)
  // — safe to paste back even without redacting, since it's just property names like SUMMARY/
  // DESCRIPTION/LOCATION/DTSTART, not values.
  const fieldNames = new Set();
  events.forEach(e => {
    e.split('\n').forEach(line => {
      const m = /^([A-Z-]+)(;[^:]*)?:/.exec(line.trim());
      if (m) fieldNames.add(m[1]);
    });
  });
  console.log('=== Field names used across all events (safe to share, no values) ===');
  console.log([...fieldNames].sort().join(', '));
})();
