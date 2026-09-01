/**
 * Fetches SmartMoving's dispatch calendar via the Google Calendar API, reading from a Google
 * Calendar that SmartMoving keeps synced (confirmed live with the user 2026-08-26) — an alternative
 * to icalClient.js's bare-URL iCal feed, using the SAME underlying SmartMoving dispatch data (each
 * event's DESCRIPTION is the identical semi-structured plain text mapIcalEvent.js already parses:
 * Branch/job number/customer/Trucks:/Crew:/etc — see that file's header for the full layout) but
 * fetched through an authenticated API call instead of polling a secret feed URL.
 *
 * Reuses the SAME OAuth2 client/refresh token as smartInsightsGmail.js (one standing Google
 * account, one consent grant covering both Gmail read/modify and Calendar read — see that file's
 * SCOPES list) rather than standing up a second OAuth app. This means: no separate setup script,
 * but the calendar.readonly scope must actually be present on the refresh token in use — see
 * smartInsightsGmail.js's 2026-08-26 comment on re-running gmail-oauth-setup.js.
 *
 * Returns events shaped exactly like icalClient.js's fetchIcalEvents() (uid/summary/description/
 * status/dtstart/dtend as JS Dates) specifically so mapIcalEvent.js's mapIcalEventToJob() — which
 * already knows how to turn one of these into a scheduler job — can be reused completely unchanged
 * regardless of which of the two fetch paths supplied the event.
 */

const { google } = require('googleapis');
const { getAuthenticatedClient } = require('./smartInsightsGmail');

// Which calendar to read — confirmed live with the user 2026-08-26: SmartMoving syncs into its own
// DEDICATED calendar under this Google account (not the account's primary/personal one), found via
// that calendar's Settings and sharing > Integrate calendar > Calendar ID. Deliberately hardcoded
// as the default (not just left as 'primary') so this sync only ever reads SmartMoving's own
// calendar, never anything else in the account, even before SMARTMOVING_CALENDAR_ID is set
// anywhere — still overridable via that env var if this calendar is ever recreated/re-shared under
// a different id later, without a code change.
const CALENDAR_ID = process.env.SMARTMOVING_CALENDAR_ID
  || 'b96aedbcd57ed48f546157b41ce23058bb058f4432837ce3db0a4a03e1d129fc@group.calendar.google.com';

// How far back/forward to read on each poll. SmartMoving jobs get rescheduled by dispatchers after
// creation (see the "Suffern, James" date-fix earlier), so a wide-ish window is deliberately used
// rather than "today onward only" — this catches a job whose date just got moved to the past few
// weeks or is booked several months out. Mirrors icalClient.js's "best available window, not a
// guaranteed range" caveat: unlike the REST endpoints' explicit From/To params, this is just what
// this app has chosen to ask the Calendar API for, not a SmartMoving-documented retention window.
const WINDOW_PAST_DAYS = 60;
const WINDOW_FUTURE_DAYS = 240;

function addDaysUtc(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Fetches events in the configured window and returns them in icalClient.js's shape. Throws (with
 * a clear message) on an auth/config problem — same pattern as icalClient.js's fetchIcalEvents and
 * smartmovingClient.js's API-key check; callers (server.js's poll function) should catch and log
 * rather than let this crash a scheduled sweep.
 */
async function fetchCalendarEvents() {
  const auth = getAuthenticatedClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const timeMin = addDaysUtc(now, -WINDOW_PAST_DAYS).toISOString();
  const timeMax = addDaysUtc(now, WINDOW_FUTURE_DAYS).toISOString();

  const events = [];
  let pageToken;
  do {
    // singleEvents: true expands any recurring event into individual instances with real
    // start/end times — SmartMoving's sync doesn't appear to use recurrence, but this is the safe
    // default for "give me concrete dated instances" rather than raw recurrence rules.
    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin, timeMax,
      singleEvents: true,
      maxResults: 2500,
      pageToken,
    });
    for (const ev of data.items || []) {
      // All-day events (no dispatch time) use start.date/end.date instead of start.dateTime — skip
      // rather than guess a time; SmartMoving job events in the samples seen always carry a real
      // dateTime, so this should be rare in practice (a stray non-job event on the same calendar).
      if (!ev.start || !ev.start.dateTime) continue;
      events.push({
        uid: ev.id,
        summary: ev.summary || '',
        description: ev.description || '',
        status: (ev.status || '').toUpperCase(), // Calendar API: 'confirmed'/'tentative'/'cancelled'
        dtstart: new Date(ev.start.dateTime),
        dtend: ev.end && ev.end.dateTime ? new Date(ev.end.dateTime) : null,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return events;
}

module.exports = { fetchCalendarEvents, CALENDAR_ID, WINDOW_PAST_DAYS, WINDOW_FUTURE_DAYS };
