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
 *  - `pollSweepScheduled` — RE-ENABLED 2026-09-29, now as a once-daily BACKSTOP rather than the
 *    primary sync path — see the 2026-09-29 SmartMoving webhook rollout below. Was disabled
 *    2026-08-27 after exhausting the Basic tier's 20,000-calls/month quota running every 2 hours;
 *    the account is now on Premium tier (125,000 calls/month, and Premium is also what makes real
 *    webhooks possible at all), so a light once-a-day reconciliation run is no longer a quota risk.
 *    See its own comment below for the full history.
 *  - SmartMoving webhooks (2026-09-29): the `api` function below already has a webhook receiver at
 *    POST /webhooks/smartmoving (see server.js's handleWebhook) — this was built earlier but never
 *    reachable from SmartMoving's side until Premium unlocked webhook delivery. This is now the
 *    PRIMARY SmartMoving sync trigger: `opportunity-status-changed` fires the instant a job is
 *    Booked, hydrating just that one opportunity via the same hydrateOpportunity() pollSweep uses —
 *    no polling needed for the common case. pollSweepScheduled above exists only to catch whatever a
 *    webhook delivery might miss (endpoint briefly down, a `job-created` event with no opportunity id
 *    to hydrate from — see handleWebhook's RELEVANT_EVENTS comment). Rolled out deliberately
 *    side-by-side with smartInsightsSyncScheduled below, not as a replacement for it yet — the plan
 *    is to compare the two for a trial period before retiring the Smart Insights Gmail pipeline (see
 *    that function's own comment for why it still exists).
 *  - `icalSweepScheduled` — DISABLED (not exported) as of 2026-08-18. Briefly held the primary role
 *    (see server/icalClient.js's header for why it existed — the REST API's monthly quota got
 *    burned through by the old 15-minute pollSweepScheduled) but is set aside for now, not deleted,
 *    now that pollSweep's own status filter cuts REST call volume. The function definition is kept
 *    below, just commented out of `exports`, so it's a one-line change to reactivate if ever needed.
 *  - `smartInsightsSyncScheduled` — added 2026-08-24, tightened to every 5 minutes (weekdays,
 *    8 AM-5 PM ET) 2026-08-27, reverted 2026-09-04 to two fixed daily checks (12:00 PM / 4:00 PM ET,
 *    every day) since the underlying report emails only ever go out at 11:51 AM / 3:51 PM ET anyway.
 *    Runs the Smart Insights report pipeline (smartInsightsSync.js: Gmail -> parse -> upsert) — see
 *    its own comment below for the exact cadence. Separate from pollSweepScheduled above — this reads
 *    SmartMoving's emailed report exports via Gmail, not the SmartMoving REST API, so it needs its
 *    own Gmail OAuth secrets (GMAIL_OAUTH_*, see smartInsightsGmail.js and
 *    server/gmail-oauth-setup.js) rather than SMARTMOVING_API_KEY.
 *  - `calendarSweepScheduled` / `calendarSweepScheduled403pm` — added 2026-08-26, tightened to every
 *    5 minutes (weekdays, 8 AM-5 PM ET) 2026-08-27, reverted 2026-09-04 to three fixed daily check
 *    times (8:00 AM, 1:00 PM, 4:03 PM ET, every day) — split across two functions since cron can't
 *    express three arbitrary same-cadence times where the minute differs by hour; see the comment
 *    above these two exports below. A 12:00 PM ET check was added 2026-09-23 at the user's request
 *    ("is calendar not syncing at 12:00AM along with the smartmoving insights" — clarified to mean
 *    noon, matching one of smartInsightsSyncScheduled's two times above, not actual midnight) so the
 *    calendar sweep runs at the same moment as one of the two Smart Insights checks; the existing
 *    8:00 AM/1:00 PM/4:03 PM checks are unchanged, this is a fourth addition, not a replacement.
 *    Reads SmartMoving's dispatch calendar (truck/crew text, dates/times) via the Google Calendar API.
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
// API key for the daily Leads/Storage scrapers (GitHub Actions) - see server/scraperAuth.js. Set via:
//   firebase functions:secrets:set SCRAPER_API_KEY   (use the same value as the GitHub repo secret)
const SCRAPER_API_KEY = defineSecret('SCRAPER_API_KEY');
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
  SESSION_SECRET, SMTP_PASS, SMARTMOVING_API_KEY, WEBHOOK_SECRET, SCRAPER_API_KEY, SMARTMOVING_ICAL_URL,
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
    memory: '2GiB',
    timeoutSeconds: 120,
  },
  async (req, res) => {
    await ensureInit();
    await handleRequest(req, res);
  }
);

// RE-ENABLED 2026-09-29 — see this file's header comment ("SmartMoving webhooks (2026-09-29)") for
// the full rollout story. History: 'every 15 minutes' originally, which burned through the account's
// 20,000-calls/month Basic-tier quota in about two days mid team test (2026-08-18) — briefly
// replaced by the free iCal feed as primary (icalSweepScheduled below) that same day, then
// 'every 24 hours' while just a backstop, then 'every 2 hours' once pollSweep() started filtering to
// booked-only opportunities — until the quota got exhausted again on 2026-08-27, which disabled this
// entirely until today. Now that SmartMoving webhooks (Premium-only, just enabled) handle the
// real-time case, this only needs to run as an occasional reconciliation backstop — once a day is
// plenty, and the account's now on Premium's 125,000-calls/month quota besides. IMPORTANT: this being
// back on means `smartMovingOpportunityId` (the real SmartMoving GUID — see mapJobs.js's `lead.id`)
// is being set/backfilled again, so JobEditModal.jsx's "Open in SmartMoving" link will start
// reappearing on jobs this touches — expected, not a bug. To disable again: change
// `exports.pollSweepScheduled` back to `const pollSweepScheduled` + `void pollSweepScheduled;`.
exports.pollSweepScheduled = onSchedule(
  {
    schedule: '0 6 * * *', // 6:00 AM ET daily — well before the business day, light backstop only
    timeZone: 'America/New_York',
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

exports.smartInsightsSyncScheduled = onSchedule(
  {
    // Deliberately left running as-is alongside the 2026-09-29 SmartMoving webhook rollout (see this
    // file's header comment) — this pipeline costs nothing in SmartMoving API terms (it only reads
    // Gmail), so keeping it live during the webhook trial period is a free safety net, not waste.
    // Plan is to compare the two for a while and retire this once webhooks are proven reliable — not
    // yet. Reverted 2026-09-04 at the user's explicit request, back to two fixed daily checks instead of
    // the 5-minute polling window this had been tightened to on 2026-08-27. Reason given: the actual
    // SmartMoving/Sigma report emails only ever go out at two fixed times — 11:51 AM and 3:51 PM
    // ET — so checking every 5 minutes all day was mostly wasted runs finding nothing; a single check
    // shortly after each real send time (12:00 PM and 4:00 PM ET, ~9 minutes after 11:51/3:51) covers
    // it. `0 12,16 * * *` = 12:00 PM and 4:00 PM ET, every day — no weekday restriction this time (the
    // user said "daily"), unlike the old `1-5`-only cron. `timeZone` still handles the ET/EDT-vs-EST
    // switch automatically. Each run only picks up messages OTHER runs haven't already labeled
    // processed (see smartInsightsGmail.js), so this is still safe to fire more than strictly needed
    // if the report send times ever drift — it just won't find anything new to do.
    schedule: '0 12,16 * * *',
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
// Shared handler for both calendar-sweep schedules below — factored out 2026-09-04 so the two fixed
// firing times (see the comment above each exports.calendarSweepScheduled* below for why they're two
// separate functions instead of one cron string) don't duplicate this logging/error-handling block.
async function runCalendarSweep(label) {
  await ensureInit();
  const result = await pollGoogleCalendarFeed().catch((err) => {
    console.error(`Scheduled calendar sweep (${label}) failed:`, err);
    return null;
  });
  if (result) {
    console.log(
      `Calendar sweep (${label}): ${result.matchedCount} job(s) matched to an existing entry (${result.mergedCount} ` +
      `merged with a Smart Insights record), ${result.skippedNoMatch} calendar event(s) had no existing ` +
      `job to attach to and were skipped (not added — see pollGoogleCalendarFeed's 2026-08-27 doc comment), ` +
      `${result.autoAssignedTruckCount} truck(s)/${result.autoAssignedDriverCount} driver(s) auto-assigned, ` +
      `${result.errors.length} error(s).`
    );
    result.errors.forEach((e) => console.error(`Calendar sweep (${label}) error:`, e));
  }
}

// Reverted 2026-09-04 at the user's explicit request, from 5-minute weekday/business-hours polling
// back to three fixed daily check times: 8:00 AM, 1:00 PM, and 4:03 PM ET, every day (no weekday
// restriction this time — the old `1-5` cron is gone). Split into TWO exported functions rather than
// one, because a single cron expression can't express three (now four) arbitrary (hour, minute)
// pairs where the minute differs by hour — cron's minute and hour fields are independent, so e.g.
// `0,3 8,12,13,16 * * *` would actually fire at every minute-value crossed with every hour-value
// (8:00, 8:03, 12:00, 12:03, 13:00, 13:03, 16:00, AND 16:03), not just the four times wanted.
// `0 8,12,13 * * *` covers the three on-the-hour times (8:00 AM, 12:00 PM, 1:00 PM); the odd 4:03 PM
// time needs its own `3 16 * * *` schedule.
// 12:00 PM ET added 2026-09-23 at the user's request, so the calendar sweep runs alongside one of
// smartInsightsSyncScheduled's two daily checks (12:00 PM and 4:00 PM ET — see this file's header
// comment) instead of missing it. 4:00 PM/4:03 PM stays a 3-minute stagger, not aligned — the odd
// :03 offset exists purely for the cron-expressiveness reason above, not to deliberately avoid
// overlapping Smart Insights; revisit if the two ever need to line up exactly at 4pm too.
exports.calendarSweepScheduled = onSchedule(
  {
    schedule: '0 8,12,13 * * *', // 8:00 AM, 12:00 PM, and 1:00 PM ET, daily
    timeZone: 'America/New_York',
    secrets: ALL_SECRETS,
    region: 'us-central1',
    memory: '512MiB',
  },
  async () => { await runCalendarSweep('8:00 AM / 12:00 PM / 1:00 PM'); }
);

exports.calendarSweepScheduled403pm = onSchedule(
  {
    schedule: '3 16 * * *', // 4:03 PM ET, daily — see the shared comment above exports.calendarSweepScheduled
    timeZone: 'America/New_York',
    secrets: ALL_SECRETS,
    region: 'us-central1',
    memory: '512MiB',
  },
  async () => { await runCalendarSweep('4:03 PM'); }
);

// force-redeploy trigger: 2026-09-29T15:18:31.1195010-04:00

// force-redeploy trigger: 2026-09-29T16:11:32.5253657-04:00

// force-redeploy trigger: 2026-09-29T16:38:31.0908235-04:00
