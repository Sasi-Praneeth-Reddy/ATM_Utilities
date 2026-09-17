// Job/truck/driver/conflict helpers — ported 1:1 from the original atm-scheduler.html.
import { jobEnd, timeToHour, daysBetween, jobActiveOn } from './dates';

export const DRIVER_COLORS = [
  '#7c3aed', '#0891b2', '#be185d', '#4338ca', '#0f766e', '#a16207', '#525252', '#9333ea',
];

export const roleLabels = {
  admin: 'Admin — full access to trucks, drivers, availability, and jobs.',
  dispatcher: 'Dispatcher — can assign/move jobs on the board and LD planner. Truck & driver records are locked.',
  crew: 'Crew / Driver — read-only view of the truck board and your own jobs, optimized for mobile. No editing.',
};

export const ldStages = ['scheduled', 'loading', 'in_transit', 'delivering', 'complete'];
export const ldStageLabels = {
  scheduled: 'Scheduled',
  loading: 'Loading',
  in_transit: 'In Transit',
  delivering: 'Delivering',
  complete: 'Complete',
};

/** Label-derived category from server/jobTypeInference.js's inferServiceCategory — display only
 * (board color grading, day board + print board), never drives scheduling. Only 'delivery_unpack',
 * 'load', and 'other' get a dedicated label/color here: 'moving' is the majority/default case and
 * deliberately stays the board's plain default styling (no added signal from calling it out), and
 * 'long_distance' already has its own long-standing '.ld'/'LD' treatment everywhere on the board,
 * so it isn't repainted a second time. Added 2026-08-28. */
export const serviceCategoryLabels = {
  delivery_unpack: 'DEL/UPK',
  load: 'LOAD',
  other: 'OTHER',
};
/** CSS class suffix for job.serviceCategory, used as `cat-${serviceCategoryClass(job)}` — see
 * styles.css's `.job-block.cat-*`/`.pt-block.cat-*` rules. Returns null (no class) for categories
 * that intentionally keep the default look — see serviceCategoryLabels' comment above. Works the
 * same for a long-distance job as a local one since 2026-09-08 (jobTypeInference.js's classifyJob
 * no longer overwrites `serviceCategory` with a bare 'long_distance' string just because `type` is
 * long_distance) — an LD job whose label says DEL/UPK now gets the same 'delivery_unpack' class a
 * local one would, on top of its existing '.ld' treatment. */
export function serviceCategoryClass(job) {
  const cat = job.serviceCategory;
  return cat && serviceCategoryLabels[cat] ? cat : null;
}

/** Display text for a job's service-category badge — 'DEL/UPK'/'LOAD' as before, but for 'other'
 * (added 2026-09-08 at the user's request) the job's OWN serviceCategoryLabel — the actual raw
 * label SmartMoving/the calendar gave it (e.g. "Storage Out Bound") — instead of a flat "OTHER"
 * that told a dispatcher nothing beyond "not one of the known types". Falls back to "OTHER" only
 * when a job predates serviceCategoryLabel being recorded (server/db.js added it 2026-09-08) or the
 * source genuinely carried no label text. null wherever serviceCategoryClass is null (moving/
 * long_distance-labeled/no category), same as before. */
export function serviceCategoryText(job) {
  const cat = serviceCategoryClass(job);
  if (!cat) return null;
  if (cat === 'other') return (job.serviceCategoryLabel || '').trim().toUpperCase() || 'OTHER';
  return serviceCategoryLabels[cat];
}

// A distinct color per distinct 'other'-category label (a hash into a small fixed palette, so e.g.
// every "Storage Out Bound" job always got the same color) used to live here, added 2026-08-28 so
// two different 'other' job types wouldn't both just read as flat gray. Removed 2026-09-15 at the
// user's request for a simpler, fixed board-wide color theme instead ("remove the old color scheme
// for transit and others, instead use this color theme: red for identified military jobs, yellow for
// long distance, purple for packing jobs, green for local jobs, orange for storage jobs") — isStorageJob
// below now carves the one 'other' sub-type that scheme actually names (storage) out into its own
// color; every other 'other' label falls back to one flat gray again (styles.css's --jobblock-other /
// .pt-job-bar.cat-other), same as before the hash existed.

/** True when an 'other'-category job's raw label mentions storage — "Storage In", "Storage Out
 * Bound", "Self Storage", etc. Added 2026-09-15 at the user's request for a dedicated storage color
 * (orange) instead of the old per-label hash-rainbow every 'other' job used to get (see above). Just
 * a label-text check, same "display only, never drives scheduling" rule serviceCategoryClass itself
 * already follows — a job whose real serviceCategory is 'load'/'delivery_unpack'/etc. is never also
 * "storage" even if its label happens to mention the word, since those categories keep their own
 * dedicated colors regardless of label text. */
export function isStorageJob(job) {
  return serviceCategoryClass(job) === 'other' && /storage/i.test(job.serviceCategoryLabel || '');
}

/** The fixed 5-color job palette (2026-09-15, "No other colors") a user can manually pin a job to
 *  via JobEditModal's swatch picker (job.colorOverride — see server's POST /api/jobs/:id/color and
 *  db.js's setJobColor), overriding whatever the automatic military/LD/packing/storage/local color
 *  above would otherwise show. Same 5 keys/labels the automatic colors already mean, kept as one
 *  shared list so the picker's swatches and their meaning can't drift from the colors themselves. */
export const JOB_COLOR_OPTIONS = [
  { key: 'green', label: 'Local' },
  { key: 'yellow', label: 'Long Distance' },
  { key: 'purple', label: 'Packing' },
  { key: 'red', label: 'Military' },
  { key: 'orange', label: 'Storage' },
];

/** CSS class for a job's manual color override, or '' when none is set — appended alongside the
 *  block/bar's other classes (ld/cat-load/storage/military) in both JobVisuals.jsx (day board) and
 *  DayPrintTimeline.jsx (print board). styles.css's `.job-block.override-*`/`.pt-job-bar.override-*`
 *  rules use `!important` to win over those other classes' colors, and over JobBlock's own inline
 *  military background style, whenever this is present. */
export function jobColorOverrideClass(job) {
  return job && job.colorOverride ? `override-${job.colorOverride}` : '';
}

export function statusClass(s) {
  return s === 'available' ? 'status-available' : s === 'onjob' ? 'status-onjob' : 'status-maintenance';
}
export function statusLabel(s) {
  return s === 'available' ? 'Available' : s === 'onjob' ? 'On Job' : 'Maintenance';
}

/** A truck's "Available"/"On Job" state used to be a persisted field that got flipped to 'onjob'
 * the moment a job was assigned but never flipped back once that job was removed/unassigned —
 * trucks got stuck showing "On Job" forever. Fixed by deriving it fresh for whatever date is being
 * viewed: a truck is 'onjob' only on days it actually has an active job assigned, 'available'
 * otherwise. 'maintenance' is the one manual, non-derived state — a dispatcher taking a truck out
 * of service isn't something job assignments should silently override, so it always wins
 * regardless of what's on the board that day. Any other stored value (including a stale 'onjob'
 * left over from before this fix) is treated as "no override" and computed automatically. */
export function deriveTruckStatus(truck, jobs, date) {
  if (truck.status === 'maintenance') return 'maintenance';
  const hasActiveJob = jobs.some((j) => jobTruckIds(j).includes(truck.id) && jobActiveOn(j, date));
  return hasActiveJob ? 'onjob' : 'available';
}

export function driverColor(drivers, driverId) {
  if (!driverId) return null;
  const idx = drivers.findIndex((d) => d.id === driverId);
  if (idx < 0) return null;
  return DRIVER_COLORS[idx % DRIVER_COLORS.length];
}

export function jobTruckIds(j) {
  return j.truckIds || [];
}

/** Truck NAMES (not ids) a job is currently assigned to, in assignment order — added 2026-09-18 for
 * DuplicateAlertBanner.jsx, so a flagged placeholder/report-job pair can show which truck(s) each
 * one actually landed on (the user's request: seeing a duplicate alert without that context made it
 * unclear whether the two jobs were already correctly split onto different trucks or genuinely
 * double-booked the same one). Drops any id that doesn't resolve to a known truck instead of
 * crashing or showing "undefined" — same defensive `.filter(Boolean)` pattern JobEditModal.jsx's
 * assignedTrucks already uses. */
export function jobTruckNames(j, trucks) {
  return jobTruckIds(j).map((id) => trucks.find((t) => t.id === id)?.name).filter(Boolean);
}

/** Just the city out of a full address string, for the print board's one-line job text (added
 * 2026-09-15 at the user's request — "look at the address in the old scheduler, just the main city
 * names are fine, which will reduce the length significantly"). Addresses in this system are always
 * either "street, city, state[ zip]" (a local job's origin/destination — see e.g. server/db.js's
 * sample data or mapJobs.js's addressFullAddress) or plain "city, state" (a long-distance job's, e.g.
 * "Denver, CO"). Either way the city is always the SECOND-TO-LAST comma-separated segment — for a
 * 2-segment "city, state" address that's segment 0, for a 3+ segment "street, city, state[ zip]"
 * address (a zip is never its own segment; it rides along with the state, e.g. "CO 80202") that's
 * always the one right before the state. Falls back to the whole trimmed string for a single-segment
 * address (no comma at all) rather than guessing, and to '' for nothing. */
export function mainCity(address) {
  if (!address) return '';
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts[parts.length - 2];
}

/** Military (PCS) moves carry a distinctive SmartMoving customer-name shape: "Last, First" followed
 * by one or more semicolon-separated GBL/quote reference codes, optionally with a leading marker tag
 * in asterisks — e.g. "*REWEIGH*Garcia, Michael; HAFC0748880; AAFD-D; T1",
 * "**VIP**-Rivera, Antonio; BGAC0723738; DICF-4; DICE", or, with no marker at all,
 * "Harvey, Jakoy; KKFA0964220; MORV-D; CTI" or "Hall, Joshua; BGAC0722747; DCEV-D; Dice" (added/
 * widened 2026-09-15 at the user's request — the marker tag turned out to be optional, and the last
 * segment isn't always all-caps either, e.g. "Dice" vs "DICE" — so detection can't require either).
 *
 * The marker is NOT required; what actually distinguishes this from an ordinary customer name that
 * happens to carry trailing reference codes too (see customerIdentityKey above, which matches any
 * "name; codes" shape for a different purpose) is the SHAPE of everything after the first ";":
 * every one of those segments has to look like a real reference code — a single short token, no
 * comma, no spaces (isReferenceCodeSegment below; case doesn't matter — "DICE" and "Dice" both
 * count) — rather than, say, a second customer's name or a free-text note. A plain note or a
 * co-customer's name after a semicolon won't match this (it'll have a comma and/or spaces) and
 * correctly falls through as non-military. */
function isReferenceCodeSegment(segment) {
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(segment.trim());
}
export function isMilitaryJob(job) {
  const parts = (job.customer || '').trim().split(';').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 && parts.slice(1).every(isReferenceCodeSegment);
}

// Optional leading marker tag some (not all — see isMilitaryJob above) military customer names
// carry, e.g. "*REWEIGH*" or "**VIP**-" ahead of the real "Last, First" name. Only used by
// militaryCleanName below, to strip it when present — detection itself no longer depends on it.
const MILITARY_MARKER_TAG = /^\*+[A-Za-z][A-Za-z0-9 ]*\*+-?/;

/** The clean "Last, First" portion of a military job's customer name, for display somewhere the
 * marker tag and reference codes would just be noise (added 2026-09-15 for the print board — "in
 * print board only include their original names like Garcia, Michael"). Strips the leading marker
 * tag when one is present (see MILITARY_MARKER_TAG above — most military names don't have one, e.g.
 * "Harvey, Jakoy; KKFA0964220; MORV-D; CTI", and this is a no-op for those), then takes the portion
 * before the first ";" — the same trick customerIdentityKey already uses for the same
 * "Last, First; codes" shape. Falls back to the raw, trimmed customer name if somehow nothing is
 * left after stripping (shouldn't happen in practice), so this never returns empty for a job that
 * has a name at all. */
export function militaryCleanName(job) {
  const raw = (job.customer || '').trim();
  const withoutMarker = raw.replace(MILITARY_MARKER_TAG, '').trim();
  const semiIdx = withoutMarker.indexOf(';');
  const clean = semiIdx === -1 ? withoutMarker : withoutMarker.slice(0, semiIdx).trim();
  return clean || raw;
}

// Mirrors db.js's MANUAL_EDIT_LOCK_FIELDS exactly — the fields that, once a dispatcher changes
// them, freeze the whole job from further automatic syncing (see db.js's markJobManuallyEdited).
// truckIds/trucksNeeded/truckDrivers briefly lived here too (2026-09-08 to 2026-09-14) so assigning
// a truck or driver locked the job as well — reverted (see db.js's MANUAL_EDIT_LOCK_FIELDS comment
// for the full story: it let a routine truck assignment silently block a real SmartMoving date
// correction on job 21973-2/-3 until someone noticed and ran "Resync from source" by hand). Used
// client-side purely for the OPTIMISTIC update in useSchedulerData.js (updateJobFields — see
// fieldsTripManualEditLock below), so the "🔒 Manually edited" notice/badge appears immediately
// instead of waiting for the next full state reload — the backend's own check (server.js's PATCH
// /api/jobs/:id handler, diffed against the job's actual previous values) is what actually decides
// whether the lock applies; this just predicts that decision for a snappier UI, in the same spirit
// as this file's other optimistic local-state updates. Keep in sync with db.js's list by hand — if
// these two names ever drift apart, editing a field only in ONE of the two lists breaks the
// prediction (badge shows the wrong thing for ~15s until the next background poll corrects it — see
// useSchedulerData.js's pollOnce) but not the lock itself, since the backend's own list is what
// actually decides.
export const MANUAL_EDIT_LOCK_FIELDS = [
  'customer', 'type', 'date', 'endDate', 'startTime', 'endTime', 'duration', 'origin', 'destination',
  'crewSize', 'notes',
];

/** Did any key in `fields` — the payload about to be PATCHed onto `job` — actually change a value
 *  listed in MANUAL_EDIT_LOCK_FIELDS? Array/object-aware (JSON.stringify) for truckIds/truckDrivers
 *  specifically: a plain `!==` always reads two different-but-equal arrays/objects as "changed"
 *  since they're never `===` unless the exact same reference, which would make every truck-assignment
 *  action predict a lock even when nothing really moved. Mirrors server.js's diffJobFields'
 *  isObj-aware comparison for the same reason. Bug this guards against (reported 2026-09-08): without
 *  a real-change check, a Save/assignment that only re-sent the SAME values as already on the job
 *  would still optimistically show the lock badge, which then vanished ~15s later once the
 *  background poll corrected it — see updateJobFields' own doc comment in useSchedulerData.js for
 *  the full story. */
export function fieldsTripManualEditLock(job, fields) {
  const isObj = (v) => v !== null && typeof v === 'object';
  return Object.keys(fields).some((f) => {
    if (!MANUAL_EDIT_LOCK_FIELDS.includes(f)) return false;
    const before = job[f] ?? null;
    const after = fields[f] ?? null;
    return (isObj(before) || isObj(after)) ? JSON.stringify(before) !== JSON.stringify(after) : before !== after;
  });
}

// Sibling of MANUAL_EDIT_LOCK_FIELDS above, for the separate truck-assignment lock (added
// 2026-09-14 — see db.js's markTruckAssignmentManual and syncTruckAssignmentUnlessLocked). Once a
// dispatcher assigns/reassigns/removes a truck (or types a real "Trucks needed" override), that
// job's truck assignment stops tracking the calendar sync's own "Trucks:" match — everything ELSE
// about the job (date/customer/etc.) keeps syncing normally, governed by the separate
// MANUAL_EDIT_LOCK_FIELDS lock above. Mirrors db.js's TRUCK_LOCK_FIELDS exactly; keep in sync by
// hand for the same reason noted above.
export const TRUCK_LOCK_FIELDS = ['truckIds', 'trucksNeeded'];

/** Truck-assignment sibling of fieldsTripManualEditLock above — did any key in `fields` actually
 *  change a value listed in TRUCK_LOCK_FIELDS? Same array-aware real-change comparison, same reason
 *  (a Save/assignment resending the same value already on the job shouldn't optimistically predict a
 *  lock that the backend isn't actually going to set). */
export function fieldsTripTruckLock(job, fields) {
  const isObj = (v) => v !== null && typeof v === 'object';
  return Object.keys(fields).some((f) => {
    if (!TRUCK_LOCK_FIELDS.includes(f)) return false;
    const before = job[f] ?? null;
    const after = fields[f] ?? null;
    return (isObj(before) || isObj(after)) ? JSON.stringify(before) !== JSON.stringify(after) : before !== after;
  });
}
// Self-heals 2026-09-08: floors at how many trucks are ACTUALLY assigned, not just the stored
// trucksNeeded value. Fixes a bug where dragging a 2nd+ truck onto a long-distance job's day-board
// timeline (useSchedulerData.js's addTruckToJob) could grow truckIds without trucksNeeded ever
// following along, since trucksNeeded is otherwise dispatcher-owned and never auto-updated by a
// sync (see db.js's upsert functions) — a job could end up with 2 trucks assigned but "Trucks
// needed" still reading 1 in Job Assignments (JobAssignments.jsx), and truckBadgeInfo below used to
// render NOTHING at all in that state (it bails out whenever needed <= 1, before ever comparing
// against how many trucks are actually on the job) — no visible warning that anything was off.
// Taking Math.max here fixes every existing job showing this mismatch immediately, on every read,
// with no migration needed — addTruckToJob's own trucksNeeded bump (added alongside this) keeps the
// STORED value in sync too, so a fresh GET /api/... response already reflects the truth without
// relying on this floor.
export function jobTrucksNeeded(j) {
  return Math.max(j.trucksNeeded || 1, jobTruckIds(j).length);
}
export function jobTrucks(trucks, j) {
  return jobTruckIds(j).map((id) => trucks.find((t) => t.id === id)).filter(Boolean);
}
export function truckShortLabel(t) {
  return t.name.replace('Truck ', 'T');
}
export function jobTruckLabel(trucks, j) {
  const ts = jobTrucks(trucks, j);
  return ts.length ? ts.map(truckShortLabel).join('+') : 'Unassigned';
}

/** Returns null, or a descriptor for the "needs N more trucks" / "N/M trucks" badge. */
export function truckBadgeInfo(j) {
  const needed = jobTrucksNeeded(j);
  if (needed <= 1) return null;
  const have = jobTruckIds(j).length;
  const short = needed - have;
  if (short > 0) return { kind: 'short', text: `⚠ needs ${short} more truck${short > 1 ? 's' : ''}` };
  if (have > needed) return { kind: 'over', text: `${have}/${needed} trucks` };
  return { kind: 'ok', text: `${have}/${needed} trucks ✓` };
}

/** Color for a job's first assigned truck's driver — used wherever a job needs one representative
 * color (e.g. the month view). Reads the driver from the job's own `truckDrivers` map (per-job,
 * per-truck assignment — see db.js's file header), not from any standing truck-level field. */
export function getJobDriverColor(trucks, drivers, j) {
  const truck = jobTrucks(trucks, j)[0];
  const driverId = truck && (j.truckDrivers || {})[truck.id];
  if (!driverId) return null;
  return driverColor(drivers, driverId);
}

/** The driver currently assigned to a specific truck ON a specific job (not a standing pairing —
 * see db.js's file header). Returns the full driver object, or null if unassigned. */
export function jobTruckDriver(drivers, j, truckId) {
  const driverId = (j.truckDrivers || {})[truckId];
  return driverId ? drivers.find((d) => d.id === driverId) || null : null;
}

/** Do two jobs' time-of-day windows actually overlap, given that their date ranges already do?
 * Extracted out of getConflicts (below) so truck conflicts and driver availability (driversBusyOnDate/
 * driversBusyForJob below) can't silently drift apart — both should agree on "are these two jobs
 * actually happening at the same time." Only narrows to an hour-level check when BOTH jobs are
 * local (not long-distance) and each spans exactly one calendar day and it's the SAME day for both
 * — e.g. an 8:00-12:00 job and a 1:00-3:00 job on the same date don't overlap, so a truck/driver on
 * the first is free for the second. Every other case (a long-distance job, or two jobs whose date
 * ranges merely touch on different days) has no meaningful single start/duration window to compare,
 * so it's treated as a full overlap for the whole span, same as before this function existed. A
 * missing startTime defaults to hour 0 and a missing duration defaults to 2 hours, matching how the
 * rest of the app already treats a job with no time set (see e.g. DayBoard.jsx). */
function sameDayTimeOverlap(a, b) {
  const aS = a.date, aE = jobEnd(a), bS = b.date, bE = jobEnd(b);
  if (a.type === 'long_distance' || b.type === 'long_distance') return true;
  if (!(aS === aE && bS === bE && aS === bS)) return true;
  const as = timeToHour(a.startTime) ?? 0, ae = as + (a.duration || 2);
  const bs = timeToHour(b.startTime) ?? 0, be = bs + (b.duration || 2);
  return as < be && bs < ae;
}

/** A long-distance job only has actionable truck work on the day it actually starts (job.date —
 * loading/departure) or the day it actually ends (job.endDate — delivery); every day strictly
 * BETWEEN those two is just "in transit," nothing to do that day. Originally written for
 * DayPrintTimeline.jsx's printed board (2026-08-27, at the user's request, narrowed from an
 * earlier version that excluded a multi-day job outright) and BoardTab.jsx's print-confirm count;
 * promoted here 2026-09-01 so DayBoard.jsx's interactive "hide in-transit jobs" toggle uses the
 * exact same definition instead of a second copy that could quietly drift from the print one. A
 * same-day long-distance job (date === endDate) is never "in transit" by this definition — only a
 * real multi-day span with a day strictly between its two ends qualifies. */
export function isTransitOnlyDay(j, date) {
  return j.type === 'long_distance' && j.endDate && j.endDate !== j.date && date > j.date && date < j.endDate;
}

/** Driver ids already assigned (on ANY truck) to some OTHER job active on this date AND whose time
 * window overlaps `targetJob`'s — used to keep a driver picker from offering someone who's already
 * booked elsewhere at that time. A driver assigned 8:00-12:00 is only busy for jobs that overlap
 * that window; a job starting at 1:00 the same day sees them as free again (see sameDayTimeOverlap
 * above for exactly which cases get hour-level treatment vs. whole-day). A driver can legitimately
 * be reassigned to a different truck within the SAME job (e.g. swapping who drives on a multi-truck
 * move), so `excludeJobId` is the job currently being edited, not a truck — only cross-JOB double-
 * booking is what this flags. */
export function driversBusyOnDate(jobs, date, excludeJobId, targetJob) {
  const busy = new Set();
  jobs.forEach((j) => {
    if (j.id === excludeJobId) return;
    if (!jobActiveOn(j, date)) return;
    if (targetJob && !sameDayTimeOverlap(targetJob, j)) return;
    Object.values(j.truckDrivers || {}).forEach((driverId) => { if (driverId) busy.add(driverId); });
  });
  return busy;
}

/** Same idea as driversBusyOnDate, but for a whole job's date RANGE rather than one specific day —
 * used by the Job Assignments admin picker, which isn't scoped to a single viewed day the way the
 * interactive day board is. Flags anyone already driving on another job whose span overlaps `job`'s
 * span (same interval-overlap check getConflicts uses) AND whose time window overlaps too (see
 * sameDayTimeOverlap above) — so a long-distance job's driver check still covers their whole
 * multi-day trip, while two same-day local jobs with non-overlapping times (an 8-12 job and a 1-3
 * job) no longer block each other. */
export function driversBusyForJob(jobs, job, excludeJobId) {
  const busy = new Set();
  const aS = job.date, aE = jobEnd(job);
  jobs.forEach((j) => {
    if (j.id === excludeJobId) return;
    const bS = j.date, bE = jobEnd(j);
    if (!(aS <= bE && bS <= aE)) return;
    if (!sameDayTimeOverlap(job, j)) return;
    Object.values(j.truckDrivers || {}).forEach((driverId) => { if (driverId) busy.add(driverId); });
  });
  return busy;
}

/** Which truck (if any) a driver is riding on, for whatever single date is being viewed — driver
 * assignment is per-job now (see db.js's file header), so "the truck this driver is on" only makes
 * sense scoped to a specific day, not as a standing fact. Looks across every job active on that
 * date for a `truckDrivers` entry naming this driver; returns the first match's truck (a driver
 * double-booked across two active jobs on the same day is itself a scheduling conflict the
 * dispatcher needs to resolve, not something this lookup needs to represent). */
export function driverTruckForDate(trucks, jobs, date, driverId) {
  for (const j of jobs) {
    if (!jobActiveOn(j, date)) continue;
    const truckDrivers = j.truckDrivers || {};
    const truckId = Object.keys(truckDrivers).find((tid) => truckDrivers[tid] === driverId);
    if (truckId) return trucks.find((t) => t.id === truckId) || null;
  }
  return null;
}

/** Groups jobs that share a SmartMoving opportunity (one booking split into multiple jobs — e.g.
 * quote 23569 with jobs 23569-1/23569-2/23569-3, all sharing one smartMovingOpportunityId) so the
 * unassigned tray can show one chip with a picker instead of one row per job. Jobs with no
 * smartMovingOpportunityId (locally created), or the lone job on an opportunity, are returned
 * ungrouped — grouping only helps once there's more than one job to choose between. */
export function groupByOpportunity(jobsArr) {
  const byOpportunity = new Map();
  const singles = [];
  jobsArr.forEach((j) => {
    if (j.smartMovingOpportunityId) {
      const list = byOpportunity.get(j.smartMovingOpportunityId) || [];
      list.push(j);
      byOpportunity.set(j.smartMovingOpportunityId, list);
    } else {
      singles.push(j);
    }
  });
  const groups = [];
  byOpportunity.forEach((list) => {
    if (list.length > 1) groups.push(list);
    else singles.push(...list);
  });
  return { groups, singles };
}

/** Identifies which SmartMoving opportunity (one customer's booking) a job belongs to, so sibling
 * legs of the same booking (e.g. 23938-1 and 23938-2 — one opportunity split across two job
 * records, maybe even two trucks or an overlapping window on purpose) can be told apart from two
 * genuinely different customers' jobs accidentally double-booked onto the same truck. Added
 * 2026-08-27 at the user's request, for getConflicts below.
 *
 * Prefers smartMovingOpportunityId (a real, unambiguous SmartMoving GUID) when present, but that's
 * only ever set by the REST poll — currently disabled account-wide (see functions-index.js's
 * pollSweepScheduled), so it's absent on effectively every job right now. Falls back to parsing
 * the shared numeric prefix off the job's own id/quote number instead: `SI-23938-1`, `SI-23938-2`,
 * and `SM-23938-3` all carry "23938" as that prefix (see mapSmartInsightsRow.js/mapJobs.js — the
 * job id is always `<SOURCE>-<jobNumber>`, and jobNumber for a multi-leg booking is itself
 * `<opportunity number>-<leg number>`), which is exactly the "opportunity number" dispatchers
 * already read jobs by. Returns null (never matches anything, including another null) for a job
 * with neither piece of data — e.g. a locally created placeholder — so two unrelated placeholders
 * are never treated as siblings just because both lack an opportunity number. */
export function jobOpportunityKey(job) {
  if (job.smartMovingOpportunityId) return `sm:${job.smartMovingOpportunityId}`;
  const raw = job.smartInsightsQuoteNumber || job.id || '';
  const m = String(raw).match(/(\d+)-\d+$/);
  return m ? `num:${m[1]}` : null;
}

/* ---------- CONFLICT DETECTION ---------- */
export function getConflicts(jobs) {
  const conflicts = [];
  const byTruck = {};
  jobs.forEach((j) => {
    jobTruckIds(j).forEach((truckId) => {
      (byTruck[truckId] = byTruck[truckId] || []).push(j);
    });
  });
  Object.keys(byTruck).forEach((truckId) => {
    const list = byTruck[truckId];
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i], b = list[k];
        const aS = a.date, aE = jobEnd(a), bS = b.date, bE = jobEnd(b);
        if (!(aS <= bE && bS <= aE)) continue;
        if (!sameDayTimeOverlap(a, b)) continue;
        // Same opportunity (see jobOpportunityKey above) — two legs of one booking overlapping on
        // one truck is expected, not a scheduling mistake, so it's never flagged as a conflict.
        const oppKey = jobOpportunityKey(a);
        if (oppKey && oppKey === jobOpportunityKey(b)) continue;
        conflicts.push({ truckId, a, b });
      }
    }
  });
  return conflicts;
}

export function conflictIdsFrom(conflicts) {
  return new Set(conflicts.flatMap((c) => [c.a.id, c.b.id]));
}

/** Distinct, saturated colors for "which truck is this conflict on" color-coding in month view (see
 * conflictColorForTruck below and WeekBar/GroupedWeekBar/MonthChip/ConflictOverlayChip's
 * `conflictColor` prop in JobVisuals.jsx) — added 2026-08-27 at the user's request: with several
 * separate conflicts on screen at once, every one of them used to get the exact same red outline, so
 * telling "are these two red bars actually the SAME truck's conflict, or two unrelated ones" meant
 * reading each bar's truck-label text one at a time. Deliberately a separate palette from
 * DRIVER_COLORS (above) rather than reusing it — a job's border already uses its driver's color when
 * one's assigned, and conflict color always renders as the OUTER box-shadow (never the border
 * itself — see styles.css's --conflict-color custom property), so the two can never collide or be
 * mistaken for each other even when both are showing on the same job at once. */
export const CONFLICT_COLORS = [
  '#d0453c', '#c2478f', '#7c3aed', '#0891b2', '#b45309', '#4d7c0f', '#be123c', '#0f766e',
];

/** Deterministically picks one of CONFLICT_COLORS for a truckId, indexed by that truck's position
 * among ONLY the trucks that currently have at least one conflict — not its position in the whole
 * fleet — so e.g. 3 conflicted trucks out of 25 get 3 clearly distinct colors instead of being
 * scattered thin across a wide, mostly-unused range. Indexed off `trucks`' own stored order (not the
 * order truckIds happen to appear in the `conflicts` array, which can shift from run to run
 * depending on job data/iteration order) so a truck's assigned color stays stable across re-renders
 * as long as the truck list itself doesn't reorder. Returns null for a truckId with no conflicts (or
 * not found in `trucks`), so callers fall back to the plain --red outline used everywhere else. */
export function conflictColorForTruck(trucks, conflicts, truckId) {
  if (!truckId) return null;
  const conflictedTruckIds = new Set(conflicts.map((c) => c.truckId));
  if (!conflictedTruckIds.has(truckId)) return null;
  const orderedConflictedIds = trucks.map((t) => t.id).filter((id) => conflictedTruckIds.has(id));
  const idx = orderedConflictedIds.indexOf(truckId);
  if (idx === -1) return null;
  return CONFLICT_COLORS[idx % CONFLICT_COLORS.length];
}

/** Which truck a SPECIFIC job's conflict is actually on — `conflictIds`/the `conflict` boolean prop
 * are job-level (does this job conflict with ANYTHING), but a multi-truck job can conflict on one of
 * its trucks and not another, and conflictColorForTruck above needs a single truckId to look up.
 * Returns the first matching conflict pair's truckId, or null if this job isn't in `conflicts` at
 * all (the common case — most jobs have no conflict). */
export function conflictTruckIdForJob(conflicts, jobId) {
  const hit = conflicts.find((c) => c.a.id === jobId || c.b.id === jobId);
  return hit ? hit.truckId : null;
}

/** Given the flat pairwise list from getConflicts and a specific truckId + job that was just
 * clicked on the day board, returns every job in that job's overlapping cluster ON THAT TRUCK — not
 * just whichever single job it happens to be directly paired with. Two jobs that don't overlap each
 * other but BOTH overlap a third (A-B and B-C conflict, but not A-C) still need to appear together
 * in one "which job?" chooser, since a dispatcher clicking anywhere in that stack needs to see every
 * job involved, not just whichever pair getConflicts happened to record first. Grown via a simple
 * fixed-point pass over the (small, per-truck) conflict list rather than a real graph structure —
 * there's never more than a handful of jobs overlapping on one truck at once, so this is plenty.
 * Always includes `job` itself, even in the degenerate case where it has no conflicts on this
 * specific truckId (can happen if it's on a truck it's not flagged as conflicting on — a job with
 * multiple trucks can conflict on one truck and not another). Sorted by start time so the chooser
 * lists jobs in the order they actually run. */
export function overlappingClusterFor(conflicts, truckId, job) {
  const relevant = conflicts.filter((c) => c.truckId === truckId);
  const byId = new Map([[job.id, job]]);
  let growing = true;
  while (growing) {
    growing = false;
    relevant.forEach((c) => {
      const aIn = byId.has(c.a.id), bIn = byId.has(c.b.id);
      if (aIn && !bIn) { byId.set(c.b.id, c.b); growing = true; }
      if (bIn && !aIn) { byId.set(c.a.id, c.a); growing = true; }
    });
  }
  return Array.from(byId.values()).sort((a, b) => (timeToHour(a.startTime) ?? 0) - (timeToHour(b.startTime) ?? 0));
}

/* ---------- PLACEHOLDER / SMART INSIGHTS DUPLICATE DETECTION ---------- */
// Same "compute fresh from jobs, no server storage" shape as getConflicts above (see App.jsx's
// `useMemo(() => getConflicts(jobs), [jobs])`) — a placeholder job someone typed in by hand before
// the real SmartMoving job showed up isn't a data-integrity problem to fix server-side, it's a
// heads-up a dispatcher resolves by deleting the placeholder (or renaming it if it turns out to be
// a genuinely different customer) — so this is derived state, not a stored alert to dismiss/resolve.
function normalizeCustomerName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Real customer-name values in this system are sometimes "Last, First; <reference code(s)>" — a
 * dispatcher typing a placeholder before the real quote is booked only knows a rough/partial code
 * (or none), while the Smart Insights report's own Customer Name column carries the full quote
 * number and route code once booked. E.g. placeholder "Brown, Byron; QXAK; DICE" vs. report
 * "Brown, Byron; QXAK0398356; DICF-J; DICE" — same customer, different trailing codes, so a full-
 * string match misses it. Matching on the portion before the first ";" (the actual name) instead of
 * the whole string catches this while staying exact for the common case of no semicolon at all. */
function customerIdentityKey(name) {
  const normalized = normalizeCustomerName(name);
  const semiIdx = normalized.indexOf(';');
  return semiIdx === -1 ? normalized : normalized.slice(0, semiIdx).trim();
}

/**
 * Flags manually-created "placeholder" jobs (source: 'placeholder', see server.js's POST /api/jobs)
 * whose customer name matches another, real synced job — almost always the same move, entered by
 * hand before the sync caught up with it. Name match (case/whitespace-insensitive, and ignoring any
 * trailing "; reference codes" — see customerIdentityKey above) AND a matching date — requiring the
 * date too was added 2026-09-18 at the user's explicit request ("only show if there is a duplicate
 * on that particular day"), after a real report showed a single placeholder ("Cortney Holder", Sept
 * 20) flagged against THREE separate report jobs a month-plus apart (Aug 7, Aug 31, Sept 20) —
 * almost certainly separate real bookings by the same repeat customer, not the same move, and
 * name-only matching had no way to tell them apart.
 *
 * This deliberately trades away one thing the OLD name-only version could catch: a placeholder
 * entered under a rough/wrong guessed date that the real report later corrects. The user chose this
 * tradeoff explicitly, given the noise it was causing — a placeholder like that just won't surface
 * here anymore; it still shows up as its own separate job once the real one syncs in, same as any
 * other unmatched pair.
 *
 * "Matching date" means their date RANGES overlap (via jobEnd, same as jobActiveOn/getConflicts use
 * elsewhere) rather than requiring their start dates to be identical — a placeholder's date doesn't
 * have to land on exactly the first day of a multi-day long-distance report job for this to still
 * catch it as the same move.
 *
 * The "real" side of the match is anything that ISN'T a placeholder (source !== 'placeholder'),
 * not just source === 'smartmoving-insights' specifically — fixed 2026-09-18 (same day as the date
 * fix above) after the user reported a duplicate alert vanishing the moment a calendar sync ran:
 * mergeCalendarDataOntoExistingJob (server/db.js) deliberately RE-LABELS a job's source from
 * 'smartmoving-insights' to 'smartmoving' once the calendar/REST sync enriches it with real
 * dispatch detail (a matched truck, in this case) — "an upgrade, not a demotion" per that
 * function's own comment. That relabel is intentional and correct for what it's tracking (where
 * this job's most authoritative data now comes from), but this function was reading it as "no
 * longer a real synced job at all" and dropping it from matching the instant that happened — which
 * is backwards, since an enriched job (now WITH a truck assigned) is exactly the case a dispatcher
 * most needs to be nudged to delete the leftover placeholder for.
 * @returns {Array<{placeholder: object, reportJob: object}>} one entry per matching pair — a
 *   placeholder matching more than one report job (or vice versa) produces multiple entries.
 */
export function getPlaceholderDuplicates(jobs) {
  const duplicates = [];
  const placeholders = jobs.filter((j) => j.source === 'placeholder' && customerIdentityKey(j.customer));
  const reportJobs = jobs.filter((j) => j.source !== 'placeholder' && customerIdentityKey(j.customer));
  placeholders.forEach((p) => {
    const pKey = customerIdentityKey(p.customer);
    reportJobs.forEach((r) => {
      const sameCustomer = customerIdentityKey(r.customer) === pKey;
      const sameDate = p.date <= jobEnd(r) && jobEnd(p) >= r.date;
      if (sameCustomer && sameDate) duplicates.push({ placeholder: p, reportJob: r });
    });
  });
  return duplicates;
}

export function placeholderDuplicateIdsFrom(duplicates) {
  return new Set(duplicates.flatMap((d) => [d.placeholder.id, d.reportJob.id]));
}

export function jobDurationHours(j) {
  if (j.type === 'long_distance') {
    return (daysBetween(j.date, jobEnd(j)) + 1) * 24; // multi-day LD job expressed in hours
  }
  return j.duration || 2;
}

/** Shorter jobs stack ABOVE longer jobs so an overlap is always visible on top of the job it
    conflicts with. */
export function stackZIndex(j) {
  return Math.max(1, 500 - Math.round(jobDurationHours(j)));
}

/** Lane assignment for month-view multi-day LD bars — shorter jobs claim the topmost lane first,
    same "less time on top" rule as the day view. Mutates each event with `_dur` and `lane`. */
export function assignLanes(events) {
  events.forEach((ev) => { ev._dur = jobDurationHours(ev.job); });
  events.sort((a, b) => a._dur - b._dur || a.startCol - b.startCol);
  const laneEnds = [];
  events.forEach((ev) => {
    let placed = false;
    for (let li = 0; li < laneEnds.length; li++) {
      if (laneEnds[li] < ev.startCol) {
        laneEnds[li] = ev.endCol;
        ev.lane = li;
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneEnds.push(ev.endCol);
      ev.lane = laneEnds.length - 1;
    }
  });
  return laneEnds.length;
}
