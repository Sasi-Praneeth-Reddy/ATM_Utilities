/**
 * Shared job-type / service-category inference — one place instead of the four separate,
 * near-duplicate `inferJobType()` implementations that used to live in mapIcalEvent.js,
 * mapSmartInsightsRow.js, mapJobs.js and mapOpportunity.js, each independently patched for the
 * same underlying bug class over time (see job 23929-2's 2026-08-27 fix, referenced in
 * mapIcalEvent.js's history, and job 23865-1's 2026-08-28 VA/MD/DC false positive below).
 * Centralizing here means:
 *
 *   1. The VA/MD/DC same-metro-area false positive only needs fixing once, not once per path.
 *   2. Every ingestion path can offer the same finer-grained `serviceCategory` — for board color
 *      grading only (JobVisuals.jsx / DayPrintTimeline.jsx), never behavior — derived from
 *      whatever free-text label SmartMoving put on the job (calendar heading, report Type/Service
 *      Type column): 'long_distance' | 'delivery_unpack' | 'load' | 'moving' | 'other'.
 *   3. Every ingestion path can apply the same mileage-based long-distance override: "identify the
 *      miles that the truck is going ... give it as longdistance even if the heading gives
 *      transit" (2026-08-28) — a job whose origin/destination are simply far enough apart counts
 *      as long-distance even when nothing in the label says so.
 *
 * `type` ('local' | 'long_distance') still drives every existing behavior unchanged — multi-day
 * spans, endDate handling, print-board grouping, etc. `serviceCategory` is new, additive, and
 * display-only.
 */

const zipcodes = require('zipcodes');

/** The DC metro area genuinely spans three jurisdictions that are a normal same-day commute apart
 * (a Fairfax VA -> Rockville MD move is NOT long-distance despite crossing a state line) — the
 * plain "states differ" heuristic is wrong here specifically. Confirmed against job 23865-1
 * (Storage Out Bound, VA -> MD, incorrectly flagged as a full-day long-distance job on 2026-08-28
 * purely because the two addresses' states differed).
 *
 * Only used as a FALLBACK now (2026-08-28) — see classifyJob below. SmartMoving doesn't return
 * real mileage anywhere in its API/reports, so this app can't just trust a "state differs" guess
 * for other parts of the country either: a short hop across a state line elsewhere (Kansas City
 * MO/KS, Texarkana TX/AR-style metro splits) would misfire the exact same way DMV moves did. Real
 * computed mileage (milesBetweenAddresses, below) is the primary signal everywhere a job's
 * addresses carry a readable ZIP; this state list only kicks in when they don't. */
const DMV_STATES = new Set(['VA', 'MD', 'DC']);

/** Moves running this far apart are long-distance by any reasonable definition even when a
 * dispatcher-typed heading doesn't say so, or says something misleading like "transit" (2026-08-28
 * request: "identify the miles ... give it as longdistance even if the heading gives transit").
 * 100 miles is a common moving-industry local/long-distance cutoff (roughly the edge of a
 * same-day round-trip service area) — adjust here if that doesn't match how ATM actually draws
 * the line day to day. This is a ONE-WAY override: it can only push a job TO long_distance, never
 * pull one back to local — a job whose label already says long-distance stays long-distance
 * regardless of what the ZIPs say, since the label is a direct human/SmartMoving decision and the
 * mileage math is a best-effort backstop, not a correction to that call. */
const LONG_DISTANCE_MILES_THRESHOLD = 100;

/** Pulls the 2-letter state abbreviation out of a "..., VA 20105"-style full address string. Same
 * regex every ingestion path used to duplicate locally. */
function stateFromAddress(address) {
  if (!address) return null;
  const m = /,\s*([A-Z]{2})\s+\d{5}/.exec(address);
  return m ? m[1] : null;
}

/** Pulls the 5-digit ZIP out of the same "..., VA 20105"-style tail — same shape stateFromAddress
 * reads, just the other capture group. */
function zipFromAddress(address) {
  if (!address) return null;
  const m = /,\s*[A-Z]{2}\s+(\d{5})/.exec(address);
  return m ? m[1] : null;
}

function isLongDistanceByStates(originState, destState) {
  if (!originState || !destState || originState === destState) return false;
  if (DMV_STATES.has(originState) && DMV_STATES.has(destState)) return false; // same-metro exemption
  return true;
}

/** Straight-line (great-circle) miles between two addresses' ZIP centroids, via the bundled
 * `zipcodes` npm package (BSD-licensed offline ZIP dataset, no external API call) — deliberately
 * avoiding a paid geocoding/Distance-Matrix API given this app's already-tight Firestore/
 * SmartMoving-REST quotas (see the 2026-08-28 usage investigation: writes/reads were already
 * exceeding the free Firestore quota before adding a per-job external HTTP call to the mix).
 * Straight-line, not driving distance, so it runs somewhat under actual road miles — fine for a
 * coarse local-vs-long-distance split, not for billing. Returns null (never throws, never guesses)
 * when either address has no readable ZIP — a mangled/incomplete address just means the mileage
 * override can't apply for that job; the label/state checks still can. */
function milesBetweenAddresses(originAddress, destinationAddress) {
  const originZip = zipFromAddress(originAddress);
  const destZip = zipFromAddress(destinationAddress);
  if (!originZip || !destZip) return null;
  try {
    const miles = zipcodes.distance(originZip, destZip);
    return typeof miles === 'number' && !isNaN(miles) ? Math.round(miles) : null;
  } catch {
    return null; // ZIP not in the bundled dataset (rare/retired code) — degrade like a missing one
  }
}

/** Label-only classification for BOARD COLOR GRADING — never changes `type` or any scheduling
 * behavior (confirmed 2026-08-28: "color/label only" scope). Checked in this order because a real
 * heading can contain more than one of these terms: long-distance first since it's the most
 * operationally distinct category (and already drives `type`), then the two specific job-shape
 * labels the user named (DEL/UPK, LOAD), then a bare "moving" catch-all, then 'other' for anything
 * with a label that matches none of the above. Returns null (not 'other') when there's no label
 * text at all, so a caller can tell "no signal" apart from "labeled, but unrecognized". */
function inferServiceCategory(...labels) {
  const text = labels.filter(Boolean).join(' ');
  if (!text) return null;
  if (/long distance/i.test(text)) return 'long_distance';
  if (/\bDEL\s*\/\s*UPK\b/i.test(text)) return 'delivery_unpack';
  if (/\bLOAD\b/i.test(text)) return 'load';
  if (/\bmoving\b/i.test(text)) return 'moving';
  return 'other';
}

/**
 * Unified entry point every ingestion path should call instead of its own local inferJobType.
 *
 * @param {object} opts
 * @param {string} [opts.jobTypeLabel] free-text label(s) straight from SmartMoving (calendar
 *   header line 2, or a report's Type/Service Type column) — join every text source you have into
 *   one string so inferServiceCategory sees all of it.
 * @param {string} [opts.originAddress] full address string, e.g. "123 Main St, Herndon, VA 20170"
 * @param {string} [opts.destinationAddress]
 * @param {boolean} [opts.labelSaysLongDistance] set true when a source has ALREADY determined
 *   long-distance from a more authoritative signal than free text (mapOpportunity.js's numeric
 *   `opportunityType`, the one real enum SmartMoving exposes) — skips the label regex but still
 *   runs the state/mileage checks, since those can still raise a Local/Intrastate opportunity to
 *   long-distance the same as any other path.
 * @returns {{ type: 'local'|'long_distance', serviceCategory: string|null, miles: number|null }}
 */
function classifyJob({ jobTypeLabel, originAddress, destinationAddress, labelSaysLongDistance } = {}) {
  const miles = milesBetweenAddresses(originAddress, destinationAddress);

  const labelLD = Boolean(labelSaysLongDistance) || (jobTypeLabel && /long distance/i.test(jobTypeLabel));

  // Real mileage beats the blunt "states differ" guess wherever it's available — including inside
  // the old DMV exemption (a VA<->MD move a mile from the state line stays local, same outcome as
  // before) and everywhere else in the country a state-line crossing doesn't actually mean
  // long-distance. Falls back to the coarser state-difference heuristic (with the DMV exemption)
  // only when neither address has a readable ZIP to compute real mileage from — see
  // milesBetweenAddresses's own comment on when that happens.
  const distanceLD = miles !== null
    ? miles >= LONG_DISTANCE_MILES_THRESHOLD
    : isLongDistanceByStates(stateFromAddress(originAddress), stateFromAddress(destinationAddress));

  const type = (labelLD || distanceLD) ? 'long_distance' : 'local';
  const serviceCategory = type === 'long_distance' ? 'long_distance' : inferServiceCategory(jobTypeLabel);

  return { type, serviceCategory, miles };
}

module.exports = {
  DMV_STATES,
  LONG_DISTANCE_MILES_THRESHOLD,
  stateFromAddress,
  zipFromAddress,
  isLongDistanceByStates,
  milesBetweenAddresses,
  inferServiceCategory,
  classifyJob,
};
