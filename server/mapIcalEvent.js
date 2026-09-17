/**
 * Maps one parsed iCal VEVENT (from icalClient.js) onto the scheduler's job shape. Alternative to
 * mapOpportunity.js/mapJobs.js's REST-API-based mapping — see icalClient.js's header for why this
 * source exists (quota-free) and server.js's pollIcalFeed() for how it's wired into the sync.
 *
 * SmartMoving packs almost everything into DESCRIPTION as semi-structured plain text (confirmed
 * live 2026-08-18 against a real account, 3 sample events, all Around Town Movers + one Campbell
 * Moving and Storage event on the same feed). It's laid out as blocks separated by a divider line
 * of 10+ dashes:
 *
 *   Branch: <branch name>
 *   <jobNumber> / <job type free text> / <a reference code, meaning unconfirmed>
 *   <pricing type> $<amount>
 *   <customer name (or, on gov't/3rd-party jobs, a messier multi-part reference string)>
 *   <phone>
 *   [<email>]                                    <- not always present (see gov't sample)
 *   -------------------------------------------------
 *   From: <referral source>
 *   Estimated time: <hours>
 *   Volume: <cuft> cuft
 *   Weight: <lbs> lbs
 *   -------------------------------------------------
 *   Custom Office Arrival Time: <none | a time>
 *   Arrival: <window> (<sub-window>)
 *   Origin: <address>
 *   <access notes free text>
 *   [Destination: <address>
 *   <access notes free text>]                     <- absent on Unload-Only-type jobs (no destination)
 *   -------------------------------------------------
 *   Dispatch notes: <text, often empty>
 *   Internal notes: <text, often empty>
 *   Crew notes: <text, often empty>
 *   Customer notes: <text, often empty>
 *   -------------------------------------------------
 *   Quoted: <N> trucks, <M> crew
 *   Trucks: <free text truck label(s), e.g. "ARC 130-2">
 *   Crew: <free text, wildly inconsistent format — sometimes a name, sometimes a code, sometimes
 *          with a phone number appended, e.g. "Celita 703-454-4456" or "JJ24/7-45% 571-577-1592">
 *   -------------------------------------------------
 *
 * This is dispatcher-typed free text, not a documented API contract — every extractor below is
 * best-effort and returns `null`/undefined rather than throwing when a line is missing or doesn't
 * match, so a format hiccup on one field degrades that one field instead of dropping the whole job.
 * The "Trucks:" line is what pollIcalFeed() in server.js matches against each truck's
 * `smartMovingLabels` to auto-assign truckIds — see db.js's findTruckIdBySmartMovingLabel.
 */

const { classifyJob } = require('./jobTypeInference');

const DIVIDER_RE = /^-{10,}\s*$/m;

/** Moving-industry-standard pricing/estimate types SmartMoving's DESCRIPTION text carries right
 * after the price (see this file's header layout) — "Binding" / "Non-Binding" (sometimes "Binding
 * Not-to-Exceed"). Bug fixed 2026-08-28: when that text sits on its OWN line, separate from the
 * dollar amount (rather than combined on one line like "Non-Binding $1,850.00", which priceLine's
 * `\$` pattern below already catches and excludes), it wasn't excluded from customerLine's
 * candidate lines — `restLines.find()` just returns the FIRST line that isn't phone/email/price, so
 * it could pick "Non-Binding" itself as the customer's name instead of skipping past it to find the
 * real name. Confirmed live: calendar-synced jobs were showing "Non-Binding" as the customer.
 * Matched case-insensitively, matched by PREFIX (not requiring a trailing `$`) so it excludes the
 * line whether or not a dollar amount rides along with it on the same line. */
const PRICING_TYPE_RE = /^(non-?binding|binding)\b/i;

function labeledValue(block, label) {
  // `[^\S\n]*` (not `\s*`) after the colon deliberately excludes newline — `\s` matches literal
  // newline characters in JS regex, so with a genuinely empty value (e.g. "Dispatch notes: \n"),
  // `\s*` was swallowing the newline and letting `(.*)$` capture the ENTIRE NEXT LINE instead of
  // an empty string — every empty labeled field was silently stealing the next field's value.
  // Confirmed via a real parse test 2026-08-18 (dispatchNotes came back as "Internal notes:").
  const re = new RegExp(`^${label}:[^\\S\\n]*(.*)$`, 'm');
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

/**
 * Parses one event's DESCRIPTION text into a structured object. Exported separately from
 * mapIcalEventToJob so it can be unit-checked/inspected on its own (e.g. via a debug script) without
 * needing a full event object.
 */
function parseDescription(description) {
  const blocks = (description || '').split(DIVIDER_RE).map(b => b.trim()).filter(Boolean);
  const [header = '', logistics = '', addresses = '', notes = '', dispatch = ''] = blocks;

  // --- Header block: Branch / jobNumber-type-ref / price / customer name / phone / email ---
  const branch = labeledValue(header, 'Branch');
  const headerLines = header.split('\n').map(l => l.trim());
  // Line 2 (after "Branch: ..."): "<jobNumber> / <job type> / <ref>" — split on " / " (spaced
  // slash) rather than bare "/", since job type text itself sometimes contains un-spaced slashes
  // (e.g. "DEL/UPK: Gov't/3rd Party Crated DA").
  const jobLine = headerLines[1] || '';
  const jobParts = jobLine.split(' / ').map(s => s.trim());
  const jobNumber = jobParts[0] || null;
  const jobTypeLabel = jobParts[1] || null;

  // Whichever remaining header lines aren't the branch/job/price lines are customer info, in no
  // fixed order beyond "name usually comes before phone/email" — so pick by pattern instead of
  // position: a phone-shaped line, an email-shaped line, and whatever's left as the name.
  const restLines = headerLines.slice(2).filter(Boolean);
  const phoneLine = restLines.find(l => /^\d{3}-\d{3}-\d{4}$/.test(l)) || null;
  const emailLine = restLines.find(l => /^\S+@\S+\.\S+$/.test(l)) || null;
  const priceLine = restLines.find(l => /\$[\d,.]+/.test(l)) || null;
  const pricingTypeLine = restLines.find(l => PRICING_TYPE_RE.test(l)) || null;
  const customerLine = restLines.find(l => l !== phoneLine && l !== emailLine && l !== priceLine && l !== pricingTypeLine) || null;

  // --- Logistics block: From / Estimated time / Volume / Weight ---
  const referralSource = labeledValue(logistics, 'From');
  const estimatedTimeHours = Number(labeledValue(logistics, 'Estimated time')) || null;
  const volumeCuft = parseFloat(labeledValue(logistics, 'Volume')) || null;
  const weightLbs = parseFloat(labeledValue(logistics, 'Weight')) || null;

  // --- Addresses block: Custom Office Arrival Time / Arrival / Origin(+notes) / Destination(+notes) ---
  const arrivalWindow = labeledValue(addresses, 'Arrival');
  const addrLines = addresses.split('\n').map(l => l.trim());
  const originIdx = addrLines.findIndex(l => l.startsWith('Origin:'));
  const destIdx = addrLines.findIndex(l => l.startsWith('Destination:'));
  const origin = originIdx >= 0 ? addrLines[originIdx].replace(/^Origin:\s*/, '').trim() : null;
  const destination = destIdx >= 0 ? addrLines[destIdx].replace(/^Destination:\s*/, '').trim() : null;
  // The access-notes line, if present, is whatever non-empty line sits directly after Origin:/
  // Destination: and before the next labeled line.
  const originNotes = originIdx >= 0 && addrLines[originIdx + 1] && !addrLines[originIdx + 1].includes(':')
    ? addrLines[originIdx + 1] : null;
  const destinationNotes = destIdx >= 0 && addrLines[destIdx + 1] && !addrLines[destIdx + 1].includes(':')
    ? addrLines[destIdx + 1] : null;

  // --- Notes block ---
  const dispatchNotes = labeledValue(notes, 'Dispatch notes') || null;
  const internalNotes = labeledValue(notes, 'Internal notes') || null;
  const crewNotes = labeledValue(notes, 'Crew notes') || null;
  const customerNotes = labeledValue(notes, 'Customer notes') || null;

  // --- Dispatch block: Quoted / Trucks / Crew ---
  const quotedMatch = /Quoted:\s*(\d+)\s*trucks?,\s*(\d+)\s*crew/i.exec(dispatch);
  const quotedTrucks = quotedMatch ? Number(quotedMatch[1]) : null;
  const quotedCrew = quotedMatch ? Number(quotedMatch[2]) : null;
  const trucksText = labeledValue(dispatch, 'Trucks') || null;
  const crewText = labeledValue(dispatch, 'Crew') || null;

  return {
    branch, jobNumber, jobTypeLabel, priceLine, pricingTypeLine, customerLine, phoneLine, emailLine,
    referralSource, estimatedTimeHours, volumeCuft, weightLbs,
    arrivalWindow, origin, originNotes, destination, destinationNotes,
    dispatchNotes, internalNotes, crewNotes, customerNotes,
    quotedTrucks, quotedCrew, trucksText, crewText,
  };
}

// Bug fixed 2026-08-28: unlike the old bare iCal feed and REST API sources (genuinely no timezone
// info anywhere — see mapJobs.js's utcIsoToHHMM and this comment's original wording, which used to
// say so), the Google Calendar API's event.start/end.dateTime carries a REAL per-event offset (e.g.
// "2026-09-01T08:00:00-04:00") — googleCalendarClient.js's `new Date(ev.start.dateTime)` parses
// that correctly into a true UTC instant. Reading that instant back with getUTCHours()/
// getUTCFullYear() (what this file always did, since it predates the Calendar API integration)
// grabs the UTC clock reading, not the dispatcher's actual local time — an 8:00 AM Eastern job
// came back reading "12:00" (confirmed live: nearly every calendar-synced job's startTime showed
// 12:00PM), and the same bug could flip `date` to the wrong calendar day for anything scheduled
// near midnight Eastern. Fixed by converting through this app's one confirmed operating timezone
// (see functions-index.js's own scheduled-function `timeZone: 'America/New_York'`) instead of
// reading UTC fields directly.
const JOB_TIMEZONE = 'America/New_York';

function localDateTimeParts(d) {
  if (!d) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: JOB_TIMEZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = {};
  fmt.formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return parts;
}
/** Local (America/New_York) wall-clock time as HH:MM. */
function localDateToHHMM(d) {
  const p = localDateTimeParts(d);
  return p ? `${p.hour}:${p.minute}` : null;
}
/** Local (America/New_York) calendar date as YYYY-MM-DD. */
function localDateToIsoDate(d) {
  const p = localDateTimeParts(d);
  return p ? `${p.year}-${p.month}-${p.day}` : null;
}
function hoursBetweenDates(start, end) {
  if (!start || !end) return null;
  const hrs = (end - start) / 3600000;
  return hrs > 0 ? Math.round(hrs * 2) / 2 : null;
}
/** Adds `days` (may be negative) to an ISO YYYY-MM-DD string. Pure calendar-date arithmetic on an
 * already-localized date string (see localDateToIsoDate above) — not a timezone conversion, so doing
 * it in UTC is fine here (unlike everywhere else in this file, where UTC vs. local is the whole
 * point). A tiny local copy of the frontend's utils/dates.js addDays, since server code doesn't share
 * that frontend-only module. */
function addDaysToIsoDate(dateStr, days) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * @param {object} event - one parsed VEVENT from icalClient.js's fetchIcalEvents()
 * @returns {object|null} scheduler job object (truckIds always [] — resolved by the caller against
 *   local trucks' smartMovingLabels, see server.js's pollIcalFeed), or null if the event doesn't
 *   even have enough to build a job (no jobNumber found — shouldn't happen on real data, but a
 *   malformed/unexpected DESCRIPTION shouldn't crash the whole sweep over one bad event).
 */
function mapIcalEventToJob(event) {
  const d = parseDescription(event.description);
  if (!d.jobNumber) return null;

  const date = localDateToIsoDate(event.dtstart);
  // See jobTypeInference.js's header for why this now lives in a shared module: fixes the
  // VA/MD/DC false positive (job 23865-1, 2026-08-28), adds `serviceCategory` for board color
  // grading, and applies the mileage-based long-distance override on top of the label check this
  // file always did.
  const { type, serviceCategory, serviceCategoryLabel, miles } = classifyJob({
    jobTypeLabel: d.jobTypeLabel, originAddress: d.origin, destinationAddress: d.destination,
  });
  const combinedNotes = [d.dispatchNotes, d.internalNotes, d.crewNotes, d.customerNotes]
    .filter(Boolean).join(' | ') || null;

  // Added 2026-08-27 at the user's request ("if there is an end date... the ld job should be added
  // with the end date and the job will be extended from start to end"). There's no explicit
  // "delivery date" field anywhere in DESCRIPTION's documented layout (see file header) — the only
  // place a genuine multi-day span can come from is the calendar event's OWN dtend, when SmartMoving
  // has scheduled the dispatch event itself to run from the pickup day through the delivery day
  // rather than as a same-day block. Only trusted for long_distance jobs (local jobs are single-day
  // by definition elsewhere in this app — see JobEditModal.jsx's date/endDate sync) and only when
  // dtend's calendar date is genuinely LATER than dtstart's — a same-day multi-hour event (the
  // common case, e.g. a same-day local-leg block) must keep endDate === date, not get "extended" by
  // a few hours rolling past midnight Eastern. Falls back to the single-day behavior otherwise, same
  // as before this change. (Both `date` and `dtendDate` are now derived in local Eastern time — see
  // localDateToIsoDate's 2026-08-28 fix above — so this comparison itself isn't affected by the UTC
  // rollover bug that fix addresses; it was already comparing two same-basis values before too.)
  //
  // Bug fixed 2026-08-27 (reported: job 23929-2's calendar event showed dtend "09/13/2026 12:00 AM",
  // but the board painted a full extra day on the 13th when the truck was actually done as of the
  // end of the 12th): a dtend that lands EXACTLY on midnight is an exclusive boundary — "ends at the
  // very start of this day" — not "spans into this day." Reading dtend's date half at face value
  // (the old `dtendDate` alone) treated that midnight instant as if the job ran all the way through
  // the 13th. Whenever dtend's local time is exactly 00:00, the true last active day is dtend's date
  // MINUS ONE — shifted here via addDaysToIsoDate before the same "is it genuinely later than date"
  // extension check runs. A dtend at any other time of day (e.g. arriving 2:00 PM) is unaffected —
  // that's a real partial day and still extends endDate to that same calendar date, same as before.
  const dtendDate = localDateToIsoDate(event.dtend);
  const dtendTime = localDateToHHMM(event.dtend);
  const effectiveDtendDate = (dtendTime === '00:00' && dtendDate) ? addDaysToIsoDate(dtendDate, -1) : dtendDate;
  const endDate = (type === 'long_distance' && effectiveDtendDate && effectiveDtendDate > date) ? effectiveDtendDate : date;

  // Added 2026-08-27 at the user's request ("for calendar sync also try to import the end time from
  // at the end date"): the calendar event's dtend already carries a wall-clock time (same real
  // per-event offset noted above, e.g. delivery/arrival at "2026-09-03T14:00:00-04:00"), it just
  // wasn't being kept anywhere — only its DATE half fed into endDate above, and its full span was
  // collapsed into a single `duration` hours number. Stored as its own HH:MM field (mirroring
  // startTime) so a genuine arrival time on the end date survives the sync instead of being
  // discarded. Best-effort like every other field here: `localDateToHHMM` already returns null when
  // event.dtend itself is missing, so this can't throw on a same-day event with no distinct end.
  //
  // Same midnight-boundary fix as endDate above applies here too: a dtend of exactly 00:00 isn't a
  // real "arrival time" on any day — it's just where the exclusive span happens to end — so it's
  // dropped to null rather than surfacing a confusing "Arrives 12:00AM" on what's now the job's last
  // real day (see JobVisuals.jsx's arrivesLabel, which only renders when endTime is truthy).
  const endTime = dtendTime === '00:00' ? null : dtendTime;

  return {
    id: `SM-${d.jobNumber}`,
    smartMovingJobId: event.uid, // iCal UID is this source's stable per-job identifier
    smartMovingOpportunityId: null, // not exposed by this feed — see file header
    customer: d.customerLine || 'Unknown Customer',
    type,
    date,
    endDate,
    startTime: localDateToHHMM(event.dtstart),
    endTime,
    duration: hoursBetweenDates(event.dtstart, event.dtend) || d.estimatedTimeHours || 2,
    origin: d.origin || '',
    destination: d.destination || '',
    crewSize: d.quotedCrew ?? undefined,
    truckIds: [], // resolved by the caller — see file header
    trucksNeeded: d.quotedTrucks || 1,
    status: 'scheduled',
    miles,
    serviceCategory,
    serviceCategoryLabel,
    source: 'smartmoving',
    smartMovingStatus: event.status || null, // iCal's own STATUS (e.g. "CONFIRMED") — NOT the same
                                              // enum as the REST API's OpportunityStatus, don't mix
    // Extra fields not in the older REST mapping — see db.js's jobData() for which of these persist.
    smartMovingTruckText: d.trucksText,
    smartMovingCrewText: d.crewText,
    notes: combinedNotes,
  };
}

module.exports = { parseDescription, mapIcalEventToJob };
