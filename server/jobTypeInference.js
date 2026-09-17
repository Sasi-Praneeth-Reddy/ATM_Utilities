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
 * behavior (confirmed 2026-08-28: "color/label only" scope).
 *
 * Order changed 2026-09-08 (user-reported: job 23060-3 / Bill Fischer, label "DELIVER: Long
 * Distance", stayed a bare uncategorized "LD" block on the board with no DEL/UPK-style badge).
 * Root cause was this function itself, not the caller: 'long distance' used to be checked FIRST and
 * returned immediately on a match, before ever looking for a more specific sub-type in the same
 * string — so a label combining both (as SmartMoving labels genuinely do: "DELIVER: Long Distance"
 * says both "this is long-distance" AND "this specific job is a delivery") always lost the more
 * specific half, no matter what the caller did with the result. Checking the specific job-shape
 * labels (DEL/UPK-or-DELIVER, LOAD, a bare "moving" catch-all) BEFORE 'long distance' fixes that: a
 * label naming both now keeps its specific type, and a label that ONLY says "long distance" with no
 * other signal still correctly falls through every specific check and lands on 'long_distance' at
 * the end, same as before. 'other' remains the final catch-all for a label that matches none of
 * these. Returns null (not 'other') when there's no label text at all, so a caller can tell "no
 * signal" apart from "labeled, but unrecognized".
 *
 * DEL/UPK's pattern was also widened the same day to catch "DELIVER"/"DELIVERY" as a bare word, not
 * just the "DEL/UPK" or "DEL / UPK" shorthand — 23060-3's own label is exactly this case, and
 * there's no reason a dispatcher who typed out "Deliver" instead of the abbreviation should land in
 * the generic 'other' bucket instead of the dedicated delivery category. */
function inferServiceCategory(...labels) {
  const text = labels.filter(Boolean).join(' ');
  if (!text) return null;
  if (/\bDEL\s*\/\s*UPK\b|\bDELIVERY?\b/i.test(text)) return 'delivery_unpack';
  if (/\bLOAD\b/i.test(text)) return 'load';
  if (/\bmoving\b/i.test(text)) return 'moving';
  if (/long distance/i.test(text)) return 'long_distance';
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
  // Changed 2026-09-08 at the user's request ("add these labels in longdistance"): used to force
  // serviceCategory to the fixed string 'long_distance' whenever `type` was long_distance,
  // discarding whatever the actual label said (DEL/UPK, LOAD, etc.) — reasonable when `type` became
  // long_distance FROM the label itself (the label already says "long distance", so there's nothing
  // more specific underneath it), but wrong when it became long_distance purely from the mileage
  // override (distanceLD) while the label said something else entirely — a long-haul DEL/UPK job
  // was showing as a bare, uncategorized long-distance bar instead of getting its own DEL/UPK
  // color/label like a local DEL/UPK job does. Now always classifies straight from the label text —
  // still lands on 'long_distance' on its own when the label genuinely says so (inferServiceCategory
  // checks that first), but otherwise reports the job's real category regardless of `type`, letting
  // the board apply the same color grading to a long-distance job's specific type as it already does
  // for local jobs (see JobVisuals.jsx's JobBlock — both branches now read catClass).
  const serviceCategory = inferServiceCategory(jobTypeLabel);
  // Raw label text this classification was based on, added 2026-09-08 at the user's request so the
  // board can show what an 'other' job specifically IS (e.g. "Storage Out Bound") instead of a
  // generic "OTHER" that told a dispatcher nothing beyond "not one of the known types" — see
  // utils/jobs.js's serviceCategoryText. Not just meaningful for 'other': kept for every category so
  // the field is consistently present rather than sometimes-null-sometimes-absent depending on which
  // bucket a job landed in. null when no label text was available at all (same case that makes
  // inferServiceCategory itself return null above).
  const serviceCategoryLabel = jobTypeLabel ? String(jobTypeLabel).trim() || null : null;

  return { type, serviceCategory, serviceCategoryLabel, miles };
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
