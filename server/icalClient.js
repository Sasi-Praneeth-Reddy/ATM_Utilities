/**
 * Fetches and parses SmartMoving's per-user iCal (.ics) calendar feed — a completely different
 * mechanism from smartmovingClient.js's REST API calls, discovered 2026-08-18 as a way around the
 * REST API's 20,000-calls/month Basic-tier quota (see server/README.md "SmartMoving sync" and the
 * quota-exhaustion incident). It's a plain HTTPS GET on a per-user secret URL (SmartMoving Profile
 * menu -> Calendar Syncing -> iCal Calendar sync -> Copy), not part of the metered API surface at
 * all — no x-api-key, no rate limiting observed, safe to poll far more often than the REST sources.
 *
 * Confirmed live 2026-08-18 against a real account: one feed returns EVERY branch on the account
 * (not just one), with rich per-job detail packed into each VEVENT's DESCRIPTION as semi-structured
 * plain text (see mapIcalEvent.js for how that's parsed) — including, critically, the assigned
 * truck and crew, which the REST API only exposes via crewMembers[] (people, not trucks) on a
 * Premium-tier-gated endpoint. This is the source pollIcalFeed() in server.js is built around.
 *
 * Trade-off vs. the REST API: this is unauthenticated by anything other than the URL itself being
 * secret (same sensitivity as an API key — never log or expose it), and its exact retention window
 * (how far back/forward events go) isn't documented anywhere; observed 415 events on one real feed
 * spanning at least several weeks back. Treat it as "best available window", not a guaranteed range
 * the way From/To params on the REST endpoints are.
 */

const ICAL_URL = process.env.SMARTMOVING_ICAL_URL || '';

/**
 * Un-folds iCal's line-wrapping (RFC 5545: a line may be split across multiple physical lines,
 * where every continuation line starts with exactly one space or tab) back into single logical
 * lines. Must run before any per-line parsing below, or every property whose value happens to wrap
 * past ~75 chars (DESCRIPTION almost always does) gets truncated at the fold point.
 */
// KNOWN QUIRK (confirmed 2026-08-18 against a real feed, verbatim raw bytes, not a transcription
// error): SmartMoving's generator occasionally wraps a long DESCRIPTION line exactly at a natural
// word-space instead of inserting a genuinely extra fold-marker character — e.g. "...the\ncrew..."
// where the fold "ate" the space that was actually between "the" and "crew" in the source text. A
// strictly RFC-5545-compliant unfolder (stripping exactly one leading char per continuation line,
// which is what unfoldLines does below) reproduces this as "thecrew" — technically correct per
// spec, but a merged word in the resulting free text. Confirmed this only affects incidental
// word-merges inside the long free-text notes fields (Dispatch/Internal/Crew/Customer notes) — the
// short structured lines this app actually keys off (Trucks:/Crew:/Quoted:) never happened to fall
// across a fold boundary in testing, so this doesn't affect truck auto-matching. Deliberately not
// "fixed" with a heuristic (e.g. always insert a space then collapse doubles) — that would just
// trade this artifact for a different one (spurious spaces before punctuation like "Pl , Aldie").
// Leaving the notes fields as occasionally-merged-but-otherwise-verbatim is the safer default.
function unfoldLines(raw) {
  // Split on CRLF or bare LF (SmartMoving's feed uses CRLF; being lenient costs nothing).
  const physicalLines = raw.split(/\r\n|\n|\r/);
  const logicalLines = [];
  for (const line of physicalLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && logicalLines.length) {
      logicalLines[logicalLines.length - 1] += line.slice(1);
    } else {
      logicalLines.push(line);
    }
  }
  return logicalLines;
}

/** Reverses iCal's TEXT value escaping (RFC 5545 §3.3.11): \n -> newline, \, -> , , \; -> ; , \\ -> \ */
function unescapeIcalText(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Splits one unfolded "NAME[;param=x]:value" line into { name, value }. Property parameters (the
 * `;param=x` part, e.g. a TZID on DTSTART) are discarded — none of the fields this app reads
 * (SUMMARY/UID/DTSTART/DTEND/LOCATION/GEO/DESCRIPTION/STATUS/URL) carry parameters worth keeping in
 * the samples seen so far (DTSTART/DTEND come through as plain UTC `...Z` values, no TZID).
 */
function parseLine(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const rawName = line.slice(0, colonIdx);
  const name = rawName.split(';')[0].trim().toUpperCase();
  const value = line.slice(colonIdx + 1);
  return { name, value };
}

/** Parses one iCal `...Z` UTC timestamp (e.g. "20260718T120000Z") into a JS Date. */
function parseIcalUtcDate(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

/**
 * Parses raw .ics text into an array of event objects. Only the fields this app actually uses are
 * extracted — see the file header for which ones have been confirmed present on real events.
 */
function parseIcs(raw) {
  const lines = unfoldLines(raw);
  const events = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue; // outside any VEVENT (VCALENDAR headers, etc.) — not needed here

    const parsed = parseLine(line);
    if (!parsed) continue;
    const { name, value } = parsed;

    switch (name) {
      case 'UID': current.uid = value.trim(); break;
      case 'SUMMARY': current.summary = unescapeIcalText(value).trim(); break;
      case 'DESCRIPTION': current.description = unescapeIcalText(value); break;
      case 'LOCATION': current.location = unescapeIcalText(value).trim(); break;
      case 'GEO': current.geo = value.trim(); break;
      case 'STATUS': current.status = value.trim(); break;
      case 'URL': current.url = value.trim(); break;
      case 'DTSTART': current.dtstart = parseIcalUtcDate(value); break;
      case 'DTEND': current.dtend = parseIcalUtcDate(value); break;
      default: break; // SEQUENCE, TRANSP, DTSTAMP, etc. — not needed
    }
  }

  return events;
}

/**
 * Fetches the feed and returns parsed events. Throws (with a clear message) if
 * SMARTMOVING_ICAL_URL isn't configured, same pattern as smartmovingClient.js's API-key check —
 * callers (server.js's pollIcalFeed) should catch and log rather than let this crash a scheduled
 * sweep.
 */
async function fetchIcalEvents() {
  if (!ICAL_URL) {
    throw new Error('SMARTMOVING_ICAL_URL is not set. Copy it from SmartMoving: Profile menu -> ' +
      'Calendar Syncing -> iCal Calendar sync -> Copy, then set it via server/local.secrets ' +
      '(local dev) or `firebase functions:secrets:set SMARTMOVING_ICAL_URL` (deployed).');
  }
  const res = await fetch(ICAL_URL);
  if (!res.ok) {
    throw new Error(`SmartMoving iCal feed returned ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return parseIcs(text);
}

module.exports = { fetchIcalEvents, parseIcs, unfoldLines, unescapeIcalText, parseIcalUtcDate };
