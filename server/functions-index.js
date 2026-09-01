/**
 * Cloud Functions (2nd gen) entry point — the Firebase-native alternative to running server.js as
 * a long-lived container (the old AWS App Runner/ECS Express path). Deployed via `firebase deploy`
 * only; no gcloud commands needed. See server/README.md "Firebase deployment".
 *
 * Split into three functions rather than one, because a Cloud Functions instance is only guaranteed
 * full CPU while actively handling a request — a setInterval-based background timer (the old
 * AWS-era poll sweep, server.js's startPolling()) would run badly throttled between requests on
 * this platform. The two *Scheduled functions sidestep that entirely: Cloud Scheduler invokes each
 * directly on its own cron, it runs once with full CPU, then exits — no "keep an instance warm to
 * keep a timer alive" hack needed, unlike the AWS deployment's --min-instances requirement.
 *
 *  - `api` — the actual HTTP backend (all REST routes + the SmartMoving webhook receiver).
 *  - `pollSweepScheduled` — DISABLED (not exported) as of 2026-08-27 — the SmartMoving REST API
 *    account's call quota was exhausted again, so this is paused at the user's request until that's
 *    resolved. Was the PRIMARY SmartMoving sync path (see server.js's pollSweep/hydrateOpportunity
 *    doc comments and mapJobs.js's BOOKED_STATUSES) whenever it's on. See its own comment below for
 *    the full history and — importantly — what being off means for `smartMovingOpportunityId`.
 *  - `icalSweepScheduled` — DISABLED (not exported) as of 2026-08-18. Briefly held the primary role
 *    (see server/icalClient.js's header for why it existed — the REST API's monthly quota got
 *    burned through by the old 15-minute pollSweepScheduled) but is set aside for now, not deleted,
 *    now that pollSweep's own status filter cuts REST call volume. The function definition is kept
 *    below, just commented out of `exports`, so it's a one-line change to reactivate if ever needed.
 *  - `smartInsightsSyncScheduled` — added 2026-08-24, tightened to every 5 minutes (weekdays,
 *    8 AM-5 PM ET) 2026-08-27. Runs the Smart Insights report pipeline (smartInsightsSync.js:
 *    Gmail -> parse -> upsert) — see its own comment below for the cadence and why it's cheap to run
 *    this often. Separate from pollSweepScheduled above — this reads SmartMoving's emailed report
 *    exports via Gmail, not the SmartMoving REST API, so it needs its own Gmail OAuth secrets
 *    (GMAIL_OAUTH_*, see smartInsightsGmail.js and server/gmail-oauth-setup.js) rather than
 *    SMARTMOVING_API_KEY.
 *  - `calendarSweepScheduled` — added 2026-08-26, tightened to every 5 minutes (weekdays, 8 AM-5 PM
 *    ET) 2026-08-27. Reads SmartMoving's dispatch calendar (truck/crew text, dates/times) via the
 *    Google Calendar API — see its own comment below for the cadence tradeoffs.
 *
 * Requiring ./server below runs its top-level code exactly once per cold start — including its
 * `if (!process.env.K_SERVICE)` guard, which Cloud Functions gen2 always sets, so it correctly
 * skips server.js's own http.createServer().listen() call here. handleRequest/pollSweep/
 * pollIcalFeed/initOnce are reused completely unchanged from the AWS version.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');

// Each of these maps to a value set via `firebase functions:secrets:set <NAME>` (see
// server/README.md "Firebase deployment") — listing them in a function's `secrets` option below is
// what actually injects the value into process.env.<NAME> at invocation time, same env var names
// server.js already reads via require('./load-env') on every other platform.
const SESSION_SECRET = defineSecret('SESSION_SECRET');
const SMTP_PASS = defineSecret('SMTP_PASS');
const SMARTMOVING_API_KEY = defineSecret('SMARTMOVING_API_KEY');
const WEBHOOK_SECRET = defineSecret('WEBHOOK_SECRET');
// Per-user SmartMoving iCal feed URL (Profile menu -> Calendar Syncing -> iCal Calendar sync ->
// Copy) — see server/icalClient.js. Same sensitivity as an API key, so it's a Secret Manager secret
// like the others, not a plain .env value. Set via: firebase functions:secrets:set SMARTMOVING_ICAL_URL
const SMARTMOVING_ICAL_URL = defineSecret('SMARTMOVING_ICAL_URL');
// Gmail API OAuth2 credentials for the Smart Insights report pipeline (smartInsightsGmail.js) — a
// "Desktop app" OAuth client id/secret plus the refresh token produced by the one-time local
// `node server/gmail-oauth-setup.js` consent flow. Entirely separate from SMARTMOVING_API_KEY above
// (that's SmartMoving's own REST API; this is read-only access to the inbox that receives
// SmartMoving's emailed report exports). See .env.example for how each is set.
const GMAIL_OAUTH_CLIENT_ID = defineSecret('GMAIL_OAUTH_CLIENT_ID');
const GMAIL_OAUTH_CLIENT_SECRET = defineSecret('GMAIL_OAUTH_CLIENT_SECRET');
const GMAIL_OAUTH_REFRESH_TOKEN = defineSecret('GMAIL_OAUTH_REFRESH_TOKEN');
const ALL_SECRETS = [
  SESSION_SECRET, SMTP_PASS, SMARTMOVING_API_KEY, WEBHOOK_SECRET, SMARTMOVING_ICAL_URL,
  GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN,
];

// No FIREBASE_PROJECT_ID / FIREBASE_SERVICE_ACCOUNT_JSON needed here, unlike the AWS deployment —
// Cloud Functions has its own built-in GCP identity and sets GCLOUD_PROJECT automatically, both of
// which server/firestore.js already checks for and prefers when present (see its header comment).

const { handleRequest, pollSweep, pollIcalFeed, pollGoogleCalendarFeed, syncSmartInsights, initOnce } = require('./server');

// initOnce() (db.initDb() seeding + bootstrapAdmin()) needs to run before the first real request
// on a fresh instance, but Cloud Functions has no single "startup" moment the way server.js's own
// start() has for a long-running container — cache the promise so concurrent requests hitting the
// same cold instance don't race to seed/bootstrap twice.
let initPromise = null;
function ensureInit() {
  if (!initPromise) initPromise = initOnce();
  return initPromise;
}

exports.api = onRequest(
  {
    secrets: ALL_SECRETS,
    region: 'us-central1',
    // 0 instead of 1 — no idle-instance cost. Correctness doesn't depend on this at all anymore
    // (unlike the AWS deployment's --min-instances requirement) now that the poll sweep is its own
    // scheduled function, not a timer living inside this one. The one real tradeoff: the first
    // request after a period of no traffic pays a cold-start delay (typically 1-3s for an app this
    // size) instead of responding instantly. If that's ever worth $4.50/month to avoid — e.g. if
    // cold starts turn out to be annoying during the live team test — set this back to 1.
    minInstances: 0,
    cpu: 1,
    memory: '512MiB',
  },
  async (req, res) => {
    await ensureInit();
    await handleRequest(req, res);
  }
);

// DISABLED 2026-08-27 at the user's explicit request — the SmartMoving REST API account's call
// quota had been exhausted (Basic tier: 20,000 calls/month — see the "History" note kept below for
// the full back-story of this same limit), so the REST poll is paused until that's sorted out
// (quota reset, plan upgrade, or the account issue that caused it gets resolved). Not exported, so
// Cloud Scheduler won't invoke it — same disabled-but-not-deleted pattern as icalSweepScheduled
// below. IMPORTANT CONSEQUENCE: with this off, `smartMovingOpportunityId` (the real SmartMoving
// GUID — see mapJobs.js's `lead.id`) is no longer being set or backfilled onto ANY job, since
// neither the calendar sync nor the Smart Insights report sync ever has a real opportunity id to
// give (see db.js's preserveSmartMovingIdentity and mapSmartInsightsRow.js). That means
// JobEditModal.jsx's "Open in SmartMoving" link (added the same day as this change, before this was
// known to be off) won't appear on any job until this is reactivated — it's dormant, not broken;
// nothing needs undoing there once the API access comes back. To reactivate: change
// `const pollSweepScheduled` back to `exports.pollSweepScheduled` below.
const pollSweepScheduled = onSchedule(
  {
    // History: 'every 15 minutes' originally, which burned through the account's 20,000-calls/month
    // Basic-tier quota in about two days mid team test (2026-08-18) — briefly replaced by the free
    // iCal feed as primary (icalSweepScheduled below) that same day, then 'every 24 hours' while
    // this was just a backstop. Was back to being primary (every 2 hours) once pollSweep() itself
    // started filtering to booked-only opportunities (see server.js/mapJobs.js) to cut call volume —
    // until the quota got exhausted again (see the DISABLED note above), which is the current state.
    schedule: 'every 2 hours',
    secrets: ALL_SECRETS,
    region: 'us-central1',
    memory: '512MiB',
  },
  async () => {
    await ensureInit();
    await pollSweep().catch((err) => {
      console.error('Scheduled poll sweep failed:', err);
    });
  }
);
void pollSweepScheduled; // keep the linter quiet about the intentionally-unexported binding

exports.smartInsightsSyncScheduled = onSchedule(
  {
    // Tightened 2026-08-27 at the user's explicit request ("also want the report sync to be done
    // maybe for every 5 minutes") from two fixed daily checks (12:00 PM / 4:00 PM ET, ~15 minutes
    // after the 11:45 AM / 3:45 PM ET report subscriptions) to continuous 5-minute polling across
    // business hours, weekdays only — `*/5 8-16 * * 1-5` reads as "every 5 minutes, during hours
    // 8 through 16 (i.e. up to 4:55 — the window closes before 5:00 PM), Monday through Friday
    // (cron day-of-week: 1=Mon..5=Fri, 0=Sun/6=Sat excluded)". Safe to run this often because each
    // check is CHEAP when there's nothing new: findUnprocessedBookedOpportunityFiles/
    // findUnprocessedAllJobsFiles (smartInsightsGmail.js) just do a couple of Gmail message-list
    // searches and return empty arrays on every run that isn't right after a report email lands —
    // no Firestore reads/writes happen at all until an actual new report is found (unlike
    // calendarSweepScheduled below, which re-walks its whole event window on every single run — see
    // that function's comment for why 5 minutes was chosen carefully there instead of tighter).
    // `timeZone` handles the ET/EDT-vs-EST switch automatically — the cron string alone would need
    // manual adjustment twice a year otherwise. Each run only picks up messages the OTHER runs
    // haven't already labeled processed (see smartInsightsGmail.js), so overlapping/frequent runs
    // never double-process the same report email.
    schedule: '*/5 8-16 * * 1-5',
    timeZone: 'America/New_York',
    secrets: ALL_SECRETS,
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 300,
  },
  async () => {
    await ensureInit();
    const result = await syncSmartInsights().catch((err) => {
      console.error('Scheduled Smart Insights sync failed:', err);
      return null;
    });
    if (result) {
      console.log(
        `Smart Insights sync: ${result.filesProcessed} report(s) processed, ` +
        `${result.jobsCreated} job(s) created, ${result.jobsUpdated} updated, ` +
        `${result.rowsSkipped} row(s) skipped, ${result.errors.length} error(s).`
      );
      result.errors.forEach((e) => console.error('Smart Insights sync error:', e));
    }
  }
);

// DISABLED as of 2026-08-18 — not part of `exports`, so Cloud Scheduler won't invoke it. See this
// file's header comment for why. Superseded 2026-08-26 by calendarSweepScheduled below (the same
// underlying SmartMoving dispatch data, read via the Google Calendar API instead of this bare feed
// URL — see googleCalendarClient.js's header) — kept, not deleted, in case the calendar path ever
// needs a fallback. Reactivate by adding back `exports.icalSweepScheduled = ...`.
const icalSweepScheduled = onSchedule(
  {
    schedule: 'every 10 minutes',
    secrets: ALL_SECRETS,
    region: 'us-central1',
    memory: '512MiB',
  },
  async () => {
    await ensureInit();
    await pollIcalFeed().catch((err) => {
      console.error('Scheduled iCal sweep failed:', err);
    });
  }
);
void icalSweepScheduled; // keep the linter quiet about the intentionally-unexported binding

// Added 2026-08-26 at the user's request: merges the calendar-synced SmartMoving dispatch data
// (truck + crew assignments) with the Smart Insights report data, auto-assigning trucks and drivers
// on new jobs — see server.js's pollGoogleCalendarFeed doc comment for the full mechanics, and
// db.js's upsertSmartMovingJob for the merge-onto-a-Smart-Insights-counterpart logic it relies on.
// Reads via the Google Calendar API (googleCalendarClient.js), authenticated with the SAME OAuth
// grant as the Smart Insights Gmail pipeline above — GMAIL_OAUTH_REFRESH_TOKEN must have been
// re-minted with the added calendar.readonly scope (see smartInsightsGmail.js's 2026-08-26 comment
// on re-running gmail-oauth-setup.js) or every run of this will fail at the auth step and just log
// an error, same as any other misconfigured-secret scheduled function here.
//
// Cadence: tightened again 2026-08-27 at the user's explicit request ("make this sync real time at
// least for business hours from 8:00AM to 5:00PM") from three fixed daily checkpoints (8/12/4) to
// `*/5 8-16 * * 1-5` — every 5 minutes, weekdays, 8:00 AM through 4:55 PM ET (the window closes
// before 5:00 PM). Chose 5 minutes rather than going tighter (e.g. every 1 minute) deliberately:
// unlike smartInsightsSyncScheduled above, pollGoogleCalendarFeed() has no "nothing new, do
// nothing" fast path — googleCalendarClient.js's fetchCalendarEvents() re-fetches the ENTIRE
// 300-day window every single run (WINDOW_PAST_DAYS/WINDOW_FUTURE_DAYS), and
// mergeCalendarDataOntoExistingJob does a Firestore read-then-write for every matching job
// regardless of whether anything actually changed — a real run has touched ~340 events/~260 writes
// (see that function's doc comment). At 5-minute/weekday/business-hours cadence that's still cheap
// (Firestore's free tier absorbs most of it; the small overage is well under $1/month), but each
// run also does ~340+ sequential Firestore round-trips in a plain for-loop (not batched/
// parallelized), so it likely takes a non-trivial number of seconds to finish — going much tighter
// than 5 minutes risks a run still executing when the next one fires, since Cloud Scheduler doesn't
// wait for the previous invocation. Neither concern applies to the Calendar API itself (its quota is
// generous enough that even 1-minute polling was never a risk — see the old comment this replaced).
// `timeZone: 'America/New_York'` handles the ET/EDT-vs-EST switch automatically instead of needing
// the cron string hand-adjusted twice a year. NOTE: pollSweepScheduled (the SmartMoving REST poll,
// below) was deliberately left untouched by this change — that one has a real hard quota (see its
// own comment: 15-minute polling burned through the account's 20,000-calls/month Basic-tier quota
// in about two days), so tightening it the same way would be a real risk, not just a cost question.
exports.calendarSweepScheduled = onSchedule(
  {
    schedule: '*/5 8-16 * * 1-5',
    timeZone: 'America/New_York',
    secrets: ALL_SECRETS,
    region: 'us-central1',
    memory: '512MiB',
  },
  async () => {
    await ensureInit();
    const result = await pollGoogleCalendarFeed().catch((err) => {
      console.error('Scheduled calendar sweep failed:', err);
      return null;
    });
    if (result) {
      console.log(
        `Calendar sweep: ${result.matchedCount} job(s) matched to an existing entry (${result.mergedCount} ` +
        `merged with a Smart Insights record), ${result.skippedNoMatch} calendar event(s) had no existing ` +
        `job to attach to and were skipped (not added — see pollGoogleCalendarFeed's 2026-08-27 doc comment), ` +
        `${result.autoAssignedTruckCount} truck(s)/${result.autoAssignedDriverCount} driver(s) auto-assigned, ` +
        `${result.errors.length} error(s).`
      );
      result.errors.forEach((e) => console.error('Calendar sweep error:', e));
    }
  }
);
