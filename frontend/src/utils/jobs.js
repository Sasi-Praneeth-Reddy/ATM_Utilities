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
 * that intentionally keep the default look — see serviceCategoryLabels' comment above. */
export function serviceCategoryClass(job) {
  const cat = job.serviceCategory;
  return cat && serviceCategoryLabels[cat] ? cat : null;
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
export function jobTrucksNeeded(j) {
  return j.trucksNeeded || 1;
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
 * whose customer name matches a job that later arrived from a Smart Insights report sync (source:
 * 'smartmoving-insights', see server/smartInsightsSync.js) — almost always the same real move,
 * entered by hand before the report caught up with it. Name match only (case/whitespace-insensitive,
 * and ignoring any trailing "; reference codes" — see customerIdentityKey above) — deliberately not
 * scoped to matching dates too, since a dispatcher may have placeholder'd a job under a rough
 * guessed date that the real report data corrects, and that's exactly the case this should still
 * catch.
 * @returns {Array<{placeholder: object, reportJob: object}>} one entry per matching pair — a
 *   placeholder matching more than one report job (or vice versa) produces multiple entries.
 */
export function getPlaceholderDuplicates(jobs) {
  const duplicates = [];
  const placeholders = jobs.filter((j) => j.source === 'placeholder' && customerIdentityKey(j.customer));
  const reportJobs = jobs.filter((j) => j.source === 'smartmoving-insights' && customerIdentityKey(j.customer));
  placeholders.forEach((p) => {
    const pKey = customerIdentityKey(p.customer);
    reportJobs.forEach((r) => {
      if (customerIdentityKey(r.customer) === pKey) duplicates.push({ placeholder: p, reportJob: r });
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
