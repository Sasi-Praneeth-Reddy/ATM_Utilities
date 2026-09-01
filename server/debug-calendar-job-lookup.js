/**
 * One-off diagnostic — traces ONE job number through the Google Calendar truck-auto-assignment path
 * end to end, to answer "this job is on SmartMoving's calendar with a truck, why does the board still
 * show it unassigned?" Complements debug-job-lookup.js (which traces the Smart Insights report path)
 * and debug-calendar-truck-labels.js / debug-truck-label-match.js (which audit label matching across
 * ALL jobs at once, not one specific job).
 *
 * Read-only everywhere: one Calendar API events.list call (via fetchCalendarEvents — same call the
 * live sync makes), one Firestore db.getState() read. Does NOT call db.mergeCalendarDataOntoExistingJob
 * or write anything — it reimplements just the READ side of that decision (see server.js's
 * pollGoogleCalendarFeed / db.js's mergeCalendarDataOntoExistingJob for the real logic this mirrors)
 * so it's safe to run as many times as you want.
 *
 * Checks, in order:
 *   1. Is there a calendar event at all whose "<jobNumber> / ..." line matches this job number, in
 *      the sync window (googleCalendarClient.js: 60 days back, 240 days forward)? If not, this job's
 *      dispatch event either isn't in that window, was deleted/never created on SmartMoving's side,
 *      or the job number was mistyped.
 *   2. Does the event have a "Trucks:" line, and does that text match a registered truck via
 *      db.findTruckIdBySmartMovingLabel — the EXACT function the live sync calls?
 *   3. Does a Firestore job doc already exist for this job (under its own SM-<jobNumber> id, or a
 *      SI-<opportunityId> counterpart)? What's its current truckIds / source / smartMovingTruckText?
 *      fillAssignmentIfEmpty (db.js) only ever fills a truck when the EXISTING doc's truckIds is
 *      still empty — a doc that already shows a truck (even a wrong-looking one from an older sync)
 *      is left alone by design, never overwritten by a later calendar sync.
 *
 * NOTE (2026-08-31): the event's Branch: line is printed for context only — it no longer gates
 * anything in the live sync. Until 2026-08-31, pollGoogleCalendarFeed() (server.js) skipped any
 * event whose branch wasn't ICAL_BRANCH_FILTER ("Around Town Movers"), which is what caused this
 * script to be written in the first place (job 23917-1, a real "Campbell Moving and Storage"-branch
 * job already on the board via a Smart Insights report, had a matching truck on its calendar event
 * that was being silently discarded). At the user's request ("allow both branches"), that filter was
 * removed from the calendar sync — branch no longer affects whether truck/crew/date enrichment
 * applies. pollIcalFeed() (the older, currently-dormant feed poller, still capable of CREATING new
 * board entries if reactivated) intentionally keeps its own branch filter — see its doc comment in
 * server.js.
 *
 * Usage (run from your machine — same Google Calendar OAuth + Firestore requirements as your other
 * calendar/sync debug scripts):
 *   cd server
 *   node debug-calendar-job-lookup.js 23917-1
 */
require('./load-env');
const db = require('./db');
const { fetchCalendarEvents, CALENDAR_ID, WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS } = require('./googleCalendarClient');
const { parseDescription } = require('./mapIcalEvent');

const jobNumberArg = process.argv[2];
if (!jobNumberArg) {
  console.error('Usage: node debug-calendar-job-lookup.js <jobNumber>   (e.g. node debug-calendar-job-lookup.js 23917-1)');
  process.exit(1);
}
// Same "arg might be a bare opportunity id, or a full job number" tolerance as debug-job-lookup.js.
const opportunityIdArg = jobNumberArg.replace(/-\d+$/, '');

(async () => {
  console.log(`Looking up job "${jobNumberArg}" on the synced Google Calendar (${CALENDAR_ID})...`);
  console.log(`Sync window: ${WINDOW_PAST_DAYS} days back to ${WINDOW_FUTURE_DAYS} days forward from now.\n`);

  const [events, { trucks, jobs }] = await Promise.all([fetchCalendarEvents(), db.getState()]);
  console.log(`Fetched ${events.length} calendar event(s) in the sync window.\n`);

  // --- 1. On the calendar at all? ---
  const matches = events
    .map((ev) => ({ ev, d: parseDescription(ev.description) }))
    .filter(({ d }) => d.jobNumber === jobNumberArg || d.jobNumber === opportunityIdArg
      || (d.jobNumber && d.jobNumber.replace(/-\d+$/, '') === opportunityIdArg));

  console.log('=== On the synced calendar? ===');
  if (!matches.length) {
    console.log(`  NOT FOUND — no event in this window has a job number matching "${jobNumberArg}".`);
    console.log(
      '  This means either: the dispatch event is outside the sync window (job date more than ' +
      `${WINDOW_PAST_DAYS} days in the past or ${WINDOW_FUTURE_DAYS} days in the future), it was ` +
      'never created / was deleted on SmartMoving\'s side, or the job number here doesn\'t match what ' +
      'SmartMoving actually put in the event\'s DESCRIPTION (worth double-checking for a typo).'
    );
  } else {
    matches.forEach(({ ev, d }) => {
      console.log(`  FOUND event uid ${ev.uid} — job number "${d.jobNumber}", date ${ev.dtstart.toISOString()}`);
      console.log(`    Branch: "${d.branch}" (informational only — no longer filters calendar enrichment, see NOTE above)`);
      if (!d.trucksText) {
        console.log('    Trucks: (none) — SmartMoving didn\'t send any truck text on this event; nothing for this app to match against.');
      } else {
        const matchedId = db.findTruckIdBySmartMovingLabel(trucks, d.trucksText);
        const matchedTruck = matchedId ? trucks.find((t) => t.id === matchedId) : null;
        console.log(`    Trucks: "${d.trucksText}" — ${matchedTruck ? `MATCHES ${matchedTruck.name} (${matchedTruck.id})` : 'NO MATCH against any registered truck label'}`);
      }
    });
  }

  // --- 2. Already on the board, and what does it show right now? ---
  console.log('\n=== Current board state ===');
  const idPrefixes = ['SM-', 'SI-'];
  const existing = jobs.filter((j) => idPrefixes.some((p) =>
    j.id === `${p}${jobNumberArg}` || j.id.startsWith(`${p}${jobNumberArg}-`) || j.id.startsWith(`${p}${opportunityIdArg}-`)));
  if (!existing.length) {
    console.log(`  Not found under any SM-${opportunityIdArg}* or SI-${opportunityIdArg}* job id.`);
    console.log(
      '  If a calendar event WAS found above, this is exactly the "don\'t add new jobs" behavior ' +
      '(mergeCalendarDataOntoExistingJob, added 2026-08-27): the calendar sync only ENRICHES a job ' +
      'that already exists from a report or manual entry — it never creates one on its own. This job ' +
      'needs to land on the board some other way first (a Smart Insights report, the REST poll, or a ' +
      'dispatcher creating it manually) before a calendar sync can attach a truck to it.'
    );
  } else {
    existing.forEach((j) => {
      const hasTruck = Array.isArray(j.truckIds) && j.truckIds.length > 0;
      console.log(`  ${j.id} — source: "${j.source}", truckIds: ${JSON.stringify(j.truckIds || [])}${hasTruck ? '' : ' (UNASSIGNED)'}, smartMovingTruckText on record: ${j.smartMovingTruckText ? `"${j.smartMovingTruckText}"` : '(none)'}`);
      if (hasTruck) {
        console.log('    Already has a truck — fillAssignmentIfEmpty would leave this alone even on a fresh sync (by design, never overwrites an existing assignment).');
      }
    });
  }

  console.log(
    '\nHow to read this: for a truck to auto-assign onto an EXISTING board job, all of the following ' +
    'need to be true at the same time — (a) a calendar event for this job number exists in the sync ' +
    'window, (b) its Trucks: text matches a registered truck label, (c) the board job already exists ' +
    '(from a report/manual entry, not the calendar itself), and (d) that job doesn\'t already have a ' +
    'truck assigned. If all of (a)-(d) check out above but the board still shows unassigned, the fix ' +
    'is simply to click Sync Now again — this reads live, so if a truck\'s label was JUST registered ' +
    'in Admin > Trucks, the very next sync will pick it up (nothing here is cached from a stale prior ' +
    'run).'
  );

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
