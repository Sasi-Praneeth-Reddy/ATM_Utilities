import { jobActiveOn, hourToLabel, timeToHour } from '../../utils/dates';
import {
  jobTruckIds, jobTrucksNeeded, driverColor, jobTruckDriver, conflictIdsFrom,
  serviceCategoryClass, serviceCategoryText, isStorageJob, isTransitOnlyDay, mainCity,
  isMilitaryJob, militaryCleanName, jobColorOverrideClass,
} from '../../utils/jobs';

// Transparent red fill for a military (PCS) move's bar — mirrors JobVisuals.jsx's identical
// treatment on the interactive day board (see its own comment for the full rationale); kept as a
// separate constant here rather than shared, same "duplicated on purpose" tradeoff as this file's
// other page-geometry constants. Darkened 0.22 -> 0.42 alpha 2026-09-15 at the user's request ("make
// the light military red color a little darker") — print always renders on a plain white page with
// fixed black text (no theme to worry about, unlike JobVisuals.jsx's own --jobblock-military var), so
// this just stays a plain constant, tuned to the same value as the day board's light-mode one.
const MILITARY_BG = 'rgba(208, 69, 60, 0.42)';

// Mirrors BoardTab.jsx's own page-geometry constants (duplicated on purpose, not imported — same
// "has to be known before the other file's math runs" tradeoff every pre-render helper there already
// makes, see its printSheet() comment) so the actual heights drawn here always agree with the
// --pt-scale BoardTab.jsx computed before this ever rendered.
//
// Reworked 2026-09-15 at the user's request ("look at the old scheduler printout, all jobs are in
// one line, with big font size... the blue placeholders before the job are driver details") to match
// the old scheduler's printout: every job now renders as exactly ONE line — the driver's name as its
// own badge, then the job's own details run together with `white-space:nowrap` (see styles.css's
// .pt-jobline) — instead of the old block that wrapped across 2-4 lines depending on how much detail
// text a job had. Because every job's box is now always exactly one line tall, BASE_ROW_HEIGHT_PX is
// simply a flat constant instead of the character-count line-wrap estimate that used to live here
// (estimateJobLaneHeightPx/estimateHeaderBitsLength/estimateAddressBitsLength, several tuning passes
// across 2026-09-11 trying to model how a job's text wraps — see BoardTab.jsx's own comment on why
// that whole approach was eventually abandoned there too, in favor of a real DOM measurement).
// BoardTab.jsx's measureAndPrintBoard still re-measures every job's real rendered scrollHeight before
// the final print (see its own comment) — this constant only sizes the very first, invisible
// pre-measurement render (it just has to be non-zero), and BoardTab.jsx's own BASE_ROW_HEIGHT_PX
// mirrors it exactly.
const BASE_ROW_HEIGHT_PX = 46;
// Same page-width geometry as BoardTab.jsx's CONTENT_WIDTH_PX — how much horizontal room a job's own
// bar actually has at scale 1, used below to decide whether a short job's bar needs widening (see
// MIN_SHORT_JOB_WIDTH_PX below). PAGE_WIDTH_IN/MARGIN_IN/PX_PER_IN/SHEET_PADDING_PX match
// BoardTab.jsx's own constants exactly — 11in landscape width, 10mm margin, 20px .print-active
// padding on every side. Went 11in/10mm landscape -> 8.5in/14mm portrait -> back to 11in/10mm
// landscape, all on 2026-09-15 — see BoardTab.jsx's PAGE_HEIGHT_IN/MARGIN_IN comment for the full
// back-and-forth; this just mirrors whatever that file's own page geometry ends up being. No longer
// subtracts a side-panel width — Unassigned Jobs moved below the grid the same day (see the return
// statement's own comment), so the truck grid now gets the FULL content width instead of giving some
// up to a column beside it.
const TRACK_WIDTH_PX = (() => {
  const pageWidthIn = 11;
  const marginIn = 10 / 25.4;
  const pxPerIn = 96;
  const sheetPaddingPx = 20;
  const contentWidthPx = (pageWidthIn - marginIn * 2) * pxPerIn - sheetPaddingPx * 2;
  const truckColWidthPx = 150; // col.pt-col-truck
  return contentWidthPx - truckColWidthPx;
})();

// A job's bar is naturally only as wide as its real time span — on the 6am-6pm/12-column grid, a
// 1-hour job is naturally only ~1/12th of the row's width, nowhere near enough room for a driver
// badge plus job text at this bigger one-line font. Added 2026-09-15 at the user's request ("if the
// job is only scheduled to one hour, increase the bar length... and display the actual hours"):
// rather than special-case "exactly 1 hour", any non-long-distance job scheduled for this long or
// less gets its bar widened out from its real start time — never shrunk, and bounded by the next job
// on the same lane so it never visually runs into it, see the widening logic inline below — and its
// time label switches from a single start time to the actual start-end range, since the bar no
// longer visually matches its true time span. MIN_SHORT_JOB_WIDTH_PX is deliberately generous —
// driver badge + customer name + a couple of detail bits, at the bigger one-line font.
//
// Threshold raised 1 -> 4 the same day, after an HTML mockup that widened EVERY job's bar (not just
// short ones) to look more like the old scheduler's bold, full rows turned out to be the wrong
// direction ("don't widen every bar, only widen the bar that is less than four hour or three hour
// job") — so this stays a threshold, just a bigger one. 4 is also close to the point past which this
// logic naturally stops doing anything anyway: on this 12-column 6am-6pm grid a job longer than
// ~3.8 real hours already draws wider than MIN_SHORT_JOB_WIDTH_PX on its own now that the page is
// landscape again (was ~5.3h under the portrait width this was first tuned against — see
// TRACK_WIDTH_PX above), so raising this much further than 4h wouldn't actually widen more jobs, just
// relabel more of them from a single start time to a start-end range.
const SHORT_JOB_MAX_DURATION_HOURS = 4;
const MIN_SHORT_JOB_WIDTH_PX = 250;

// Deliberately NOT the same 0-24 span DayBoard.jsx's on-screen timeline uses — narrowed to
// business hours at the user's request 2026-08-27: a printed truck board is a paper handout for
// the day's actual working window, not a 24h grid with 18 empty overnight columns nobody's
// scheduled in. A job whose real start/end time falls outside 6am-6pm still prints its exact time
// as text (see segs below) and its bar is simply clamped to the visible edge rather than
// hidden — see clampFrac.
const TIMELINE_START = 6; // 6am
const TIMELINE_END = 18; // 6pm

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

// isTransitOnlyDay moved to utils/jobs.js (2026-09-01) so DayBoard.jsx's interactive "hide
// in-transit jobs" toggle shares the exact same definition instead of a second copy that could
// drift from this one — see that file for the full doc comment. Narrowed 2026-08-27 at the user's
// request from an earlier version that excluded every multi-day job outright: only the in-between
// transit days are skipped here (both from the truck bars and the Unassigned section of the side
// panel) — the start day and end day both print normally, with a Departs/Arrives seg (see segs
// below) so it's clear which one a given day is. BoardTab.jsx's "Print Board" button
// still warns via window.confirm first if any job would be skipped on the date being printed, so
// nobody is surprised a job they expected to see isn't there.

function clampFrac(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * A print-only rendition of the day board that LOOKS like the on-screen timeline — trucks down the
 * left, colored bars across an hours header — rather than DayPrintSheet's plain table manifest.
 * Requires the browser's "background graphics" print option to be on for the colors to actually
 * show (a browser/print-dialog setting, not something CSS alone can force); `print-color-adjust`
 * in styles.css is a hint some browsers respect without it, but not a guarantee.
 *
 * Built as a real <table> (thead + tbody), not the stacked <div>s an earlier version used — a
 * fleet with enough trucks to overflow one printed page needs the hours ribbon to repeat at the
 * top of every following page, and a plain flex/div layout has no way to do that. A <thead> is the
 * one piece of plain HTML/CSS browsers already know how to repeat on each page when a table breaks
 * across a page boundary, with no JS or manual page-splitting needed — Chrome, Firefox, and Safari
 * all handle it. Each truck's jobs still render as absolutely-positioned .pt-jobline divs inside
 * one wide `colSpan`-ed cell, same as before; only the outer scaffolding changed.
 *
 * Restructured 2026-09-02 at the user's request ("i don't want the print board printing in two
 * pages... print conflicts and unassigned jobs in a different block on the side of the calendar"):
 * Conflicts and Unassigned Jobs used to print as extra rows/blocks STACKED below the truck grid —
 * an inline "pt-conflict-row" under every truck that had one, then a whole separate Unassigned
 * table after the entire grid. Neither of those was budgeted into truckPrintScale's page-fit math
 * (BoardTab.jsx), which only ever accounted for truck-row count — so a day with a handful of
 * conflicts or several unassigned jobs routinely pushed the printout onto a second page even when
 * the truck grid alone fit comfortably on one. Unassigned Jobs moved into a `.pt-side-panel` column
 * BESIDE the grid instead, so it added no height to the page — only width, which the grid gave up
 * to make room — with its own independent `--pt-side-scale` so a busy Unassigned column could shrink
 * its own text without also shrinking the truck grid's `--pt-scale`, and vice versa.
 *
 * Conflicts used to have their OWN side-panel section here too (a truck with two overlapping jobs
 * could only ever draw one visible bar — the other hidden behind it — so the side list was the only
 * place to see both). Removed 2026-09-11 alongside the lane-stacking below: an overlapping job now
 * gets its own full bar directly on its truck's row, so the side list became pure duplication. There
 * still isn't a separate Conflicts list anywhere on this printout for that same reason — an
 * assigned job's conflict already shows inline via the ⚠ flag / red box-shadow on its own lane (see
 * `.pt-jobline.conflict` below), and an unassigned job can never be part of a truck-overlap conflict
 * in the first place.
 *
 * Unassigned Jobs moved AGAIN, 2026-09-15, from that side column to a full-width `.pt-unassigned-
 * section` below the grid instead (at the user's request: "move the unassigned jobs and conflicts
 * in board to the bottom and make the details to look more clearly as in the pdf") — reusing the
 * one-line/pipe-separated/big-font `.pt-jobline`/`.pt-job-bar` styling every assigned job on the
 * grid already uses (via a `.pt-jobline.static` modifier, since these rows aren't lane-positioned —
 * see styles.css), for one consistent look top to bottom instead of the old side panel's smaller,
 * denser text. This reintroduces the exact "extra content silently adds a 2nd page" problem the
 * 2026-09-02 side-column design was built to avoid, since a bottom section adds height just like a
 * truck row does — BoardTab.jsx's measureAndPrintBoard now solves it the same way it already solves
 * it for the truck grid: by measuring this section's real rendered height (not estimating it) and
 * folding that into the same page-fit total, sharing the grid's single `--pt-scale` instead of the
 * old side panel's separate `--pt-side-scale`.
 */
export default function DayPrintTimeline({ id, date, trucks, drivers, jobs, conflicts, includeTransit, includeAllTrucks = false }) {
  const allActiveToday = jobs.filter((j) => jobActiveOn(j, date));
  // "Include in-transit" (BoardTab.jsx checkbox, default off) — a long-distance job just passing
  // through today (isTransitOnlyDay) is normally left off this printout entirely; checking it prints
  // the truck as tied up instead, via its own distinct hatched bar (see the `isTransit` branch
  // below) rather than a real colored job bar, so it reads as "unavailable" not "here's a job".
  const transitJobsToday = includeTransit ? allActiveToday.filter((j) => isTransitOnlyDay(j, date)) : [];
  const transitJobIds = new Set(transitJobsToday.map((j) => j.id));
  const activeJobs = allActiveToday.filter((j) => !isTransitOnlyDay(j, date));
  // Unassigned jobs only print on their own start date — see DayPrintSheet.jsx / DayBoard.jsx for
  // the same fix and why (a long-distance job shouldn't reappear as "unassigned" on every day
  // it's in transit, only the day it needs picking up). Never a transit-only day by construction
  // (j.date === date can't also satisfy date > j.date), so no isTransitOnlyDay filter needed here.
  const unassigned = jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date);
  // Only trucks actually working THIS printed day get a row — added 2026-09-11 at the user's
  // request ("should print only in one page ... details should be readable"). Previously every
  // truck in the whole fleet printed a row here (even one with nothing assigned today, just an
  // empty track), which both wasted page height that could push a light day onto a 2nd page, and
  // (via BoardTab.jsx's truckPrintScale, which was sized off the same full fleet count) shrank
  // every OTHER truck's text more than that day's actual workload ever required. Same "business
  // hours only, not a 24h grid nobody's scheduled in" reasoning TIMELINE_START/END already applies
  // above, just for rows instead of columns. A truck whose only job today is an in-transit one
  // (only possible when "Include in-transit" is checked) still counts as active. BoardTab.jsx's
  // printSheet() caller computes this exact same filter (countPrintRowUnits, duplicated on purpose
  // — see its comment) BEFORE this component ever renders, so the --pt-scale it sets always agrees
  // with what actually draws here.
  // includeAllTrucks (added 2026-09-15 at the user's request — "a new button beside print full
  // day... that will include the trucks that are not been assigned with jobs") — App.jsx renders a
  // SECOND, always-mounted instance of this component (id="day-print-timeline-all") with this prop
  // hardcoded true, entirely separate from the normal "Print Board" instance (id="day-print-
  // timeline", this prop always false there) — see App.jsx's own comment for why it's two fully
  // independent elements rather than one shared state flag (that first attempt broke under real
  // print() timing — see BoardTab.jsx's measureAndPrintBoard comment for the story). True here
  // skips this filter entirely, so an idle truck with nothing assigned today still gets a row (just
  // an empty track, same as this component drew for every truck before the 2026-09-11 change
  // introduced this filter in the first place — see below).
  const activeTrucks = includeAllTrucks ? trucks : trucks.filter((t) =>
    activeJobs.some((j) => jobTruckIds(j).includes(t.id)) || transitJobsToday.some((j) => jobTruckIds(j).includes(t.id))
  );
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const printedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const hours = hourLabelList();

  // Conflicts scoped to just THIS printed day — added 2026-08-27 at the user's request.
  // getConflicts (see App.jsx) flags a pair as conflicting whenever their date RANGES overlap
  // anywhere, which for two multi-day long-distance jobs can be a day other than the one being
  // printed right now (e.g. two LD jobs whose spans overlap on day 5, printed on day 2, where only
  // one of them is even running). A conflict only belongs on this printout when BOTH jobs are
  // actually active today — activeJobs already reflects that (including the transit-day exclusion
  // above) — so the ⚠ flag on a bar uses this filtered list instead of the raw, date-agnostic
  // `conflicts` prop. Still used for the ⚠ badge/border on each bar even though the side-panel
  // Conflicts list is gone — a dispatcher scanning the grid still needs to see which bars overlap.
  const activeJobIds = new Set(activeJobs.map((j) => j.id));
  const conflictsToday = (conflicts || []).filter((c) => activeJobIds.has(c.a.id) && activeJobIds.has(c.b.id));
  const conflictIdsToday = conflictIdsFrom(conflictsToday);

  return (
    <div className="print-sheet print-sheet-timeline" id={id}>
      {/* Skipped for "Print All Trucks" 2026-09-15 at the user's request ("remove the main
          heading") — that variant already has enough content (the full fleet, not just today's
          working trucks) that reclaiming this block's page-height budget matters for BoardTab.jsx's
          one-page guarantee (see its HEADER_FOOTER_THEAD_PX_ALL_TRUCKS). "Print Board" keeps its
          header exactly as before. */}
      {!includeAllTrucks && (
        <div className="print-header">
          <div className="print-title">Around Town Movers — Daily Truck Board</div>
          <div className="print-date">{dateLabel}</div>
        </div>
      )}

      <table className="pt-table">
        <colgroup>
          {/* Explicit width on just the truck column — table-layout:fixed then splits the rest of
              the page width evenly across the hour columns below, and reuses those exact same
              widths for every page the table breaks onto. */}
          <col className="pt-col-truck" />
          {hours.map((h) => <col key={h} />)}
        </colgroup>
        <thead>
          {/* Now just 12 columns (6am-6pm, see TIMELINE_START/END above) instead of the original
              24, so every hour comfortably gets its own label — the old "only every other hour"
              thinning is no longer needed. Every hour still gets its own gridline either way (see
              .pt-hour CSS). */}
          <tr>
            <th className="pt-truck-col-spacer" />
            {hours.map((h) => <th className="pt-hour" key={h}>{hourToLabel(h)}</th>)}
          </tr>
        </thead>
        <tbody>
        {activeTrucks.map((t) => {
          const tjobs = [...activeJobs, ...transitJobsToday].filter((j) => jobTruckIds(j).includes(t.id));
          // Only reachable when includeAllTrucks is true — the normal "Print Board" filter (see
          // activeTrucks above) already excludes any truck with zero jobs today, so this can never
          // be true for that variant. Shrunk further 2026-09-15 at the user's request ("make the
          // font size even smaller for truck names that are not having jobs in Print All trucks
          // print") so an idle truck's row reads as filler, not competing for attention with a
          // truck that's actually working today.
          const isEmptyTruck = tjobs.length === 0;

          // Bar left/width fractions computed up front for every job on this truck, sorted
          // left-to-right — so a short job's widened bar (see SHORT_JOB_MAX_DURATION_HOURS above)
          // can be bounded by its immediate neighbor on THIS lane instead of assuming the whole row
          // is free (two different jobs would otherwise risk printing on top of each other). An
          // in-transit job (only present when "Include in-transit" is checked) naturally falls into
          // the isLd "not today's start day" branch below and always spans the full row (leftFrac 0,
          // widthFrac 1) — no separate case needed here, just its own rendering further down.
          const framed = tjobs.map((j) => {
            const isLd = j.type === 'long_distance';
            let leftFrac, widthFrac;
            if (isLd) {
              // Same as JobBlock (the on-screen version): on the day it actually departs, the bar
              // starts at the dropped time instead of always looking like midnight.
              if (j.date !== date || !j.startTime) {
                leftFrac = 0; widthFrac = 1;
              } else {
                const start = timeToHour(j.startTime) ?? TIMELINE_START;
                leftFrac = clampFrac((start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
                widthFrac = 1 - leftFrac;
              }
            } else {
              const start = timeToHour(j.startTime) ?? TIMELINE_START;
              const dur = j.duration || 2;
              const startFrac = clampFrac((start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
              const endFrac = clampFrac((start + dur - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
              leftFrac = startFrac; widthFrac = Math.max(0, endFrac - startFrac);
            }
            return { j, isLd, leftFrac, widthFrac, rightFrac: leftFrac + widthFrac };
          }).sort((a, b) => a.leftFrac - b.leftFrac);

          // Lane assignment — standard greedy interval-graph packing: walk the jobs left-to-right,
          // put each one in the first lane whose last job already ended by this one's start, else
          // open a new lane. Driven purely by actual time overlap (not the `conflicts` prop) so it
          // can never disagree with what's actually drawn — two jobs that touch in time always land
          // in different lanes. A truck with no overlap always gets exactly one lane (today's normal
          // case). Every lane is now the same fixed BASE_ROW_HEIGHT_PX tall (see that constant's own
          // comment for why a per-job height estimate is no longer needed) — simpler than the old
          // per-lane "tallest job wins" math, which existed only because a wrapped block's real
          // height used to vary job to job.
          const laneEndFracs = [];
          const laned = framed.map((f) => {
            let lane = laneEndFracs.findIndex((end) => f.leftFrac >= end - 0.0001);
            if (lane === -1) { lane = laneEndFracs.length; laneEndFracs.push(f.rightFrac); }
            else { laneEndFracs[lane] = f.rightFrac; }
            return { ...f, lane };
          });
          const laneCount = Math.max(1, laneEndFracs.length);
          // Same-lane neighbors only, for the short-job widening bound below — a job in one lane
          // doesn't need to dodge a bar in a DIFFERENT lane; those are already vertically separated
          // by construction.
          const byLane = new Map();
          laned.forEach((f) => {
            if (!byLane.has(f.lane)) byLane.set(f.lane, []);
            byLane.get(f.lane).push(f);
          });
          // The track's real height now has to be set explicitly (not just CSS min-height) — its
          // only children are position:absolute bars, which never contribute to a plain div's auto
          // height, so without this a truck with 2+ lanes would collapse back to a single lane's
          // worth of visible space. Paired with styles.css's `.pt-track{overflow:hidden}`, this is
          // also what keeps one truck's row from ever bleeding into the next truck's row on paper.
          const trackHeightPx = laneCount * BASE_ROW_HEIGHT_PX;
          const trackStyle = { height: `calc(${trackHeightPx}px * var(--pt-scale, 1))` };

          return (
              <tr className="pt-truck-row" key={t.id}>
                <td className="pt-truck-info">
                  <div className={`pt-truck-name${isEmptyTruck ? ' pt-truck-name-empty' : ''}`}>{t.name}</div>
                  {/* Driver dropped from here 2026-09-15 — it's now its own badge on each job's
                      line (see the driver badge below), which is both more accurate (a truck can
                      carry a different driver on each job it runs that day, see db.js's file header)
                      and matches the old scheduler's printout this was modeled on. */}
                  <div className={`pt-truck-meta${isEmptyTruck ? ' pt-truck-meta-empty' : ''}`}>{t.size}</div>
                </td>
                <td className="pt-track-cell" colSpan={hours.length}>
                <div className="pt-track" style={trackStyle}>
                  {laned.flatMap(({ j, isLd, leftFrac, widthFrac, rightFrac, lane }) => {
                    const laneTopPx = lane * BASE_ROW_HEIGHT_PX + 2;
                    const laneHeightPx = BASE_ROW_HEIGHT_PX - 4;
                    const laneVerticalStyle = {
                      top: `calc(${laneTopPx}px * var(--pt-scale, 1))`,
                      height: `calc(${laneHeightPx}px * var(--pt-scale, 1))`,
                    };

                    // In-transit bar (only present when "Include in-transit" is checked) — a plain
                    // hatched placeholder, not a job-color variant, so it reads as "this truck is
                    // tied up" rather than "here's a job happening here". Always full-width (see the
                    // framed comment above) so it never needs the short-job widening logic below.
                    if (transitJobIds.has(j.id)) {
                      const style = { left: `${leftFrac * 100}%`, width: `${widthFrac * 100}%`, ...laneVerticalStyle };
                      return [
                        <div className="pt-transit-bar" style={style} data-lane={lane} key={j.id}>
                          <b className="pt-job-name">🚚 In Transit</b>
                          <span className="pt-seg">{j.customer} · Long Distance</span>
                        </div>,
                      ];
                    }

                    const conflict = conflictIdsToday.has(j.id);
                    // Driver shown as its own badge before the job's line (see styles.css's
                    // .pt-driver-badge) — matching the old scheduler printout's "TRUCK: <driver>" tag
                    // ahead of each job. Colored per-driver (same DRIVER_COLORS palette the on-screen
                    // board already uses) so it still doubles as an at-a-glance "which driver" signal,
                    // the same job this badge's predecessor (a border-left tint on the old wrapped
                    // block) used to do. A job with no driver assigned yet just skips the badge — the
                    // job's own bar starts flush at the job's real start time instead.
                    const blockDriver = jobTruckDriver(drivers, j, t.id);
                    const badgeColor = blockDriver ? driverColor(drivers, blockDriver.id) : null;
                    // Service-category color grading (print board) — same source/rationale as the
                    // on-screen board, see JobVisuals.jsx's catClass. null (no extra class/label)
                    // for 'moving', which keeps the print board's existing look. Applies to
                    // long-distance jobs too as of 2026-09-08 (see jobTypeInference.js's classifyJob)
                    // — an LD job with a DEL/UPK or LOAD label now gets that color/label on the
                    // printed board same as a local one, on top of its existing .ld look.
                    const catClass = serviceCategoryClass(j);
                    // Storage — a sub-type of 'other' carved out for its own orange color 2026-09-15
                    // (isStorageJob, utils/jobs.js), replacing the old per-'other'-label hash-rainbow
                    // (otherCategoryColor) at the user's request for a fixed 5-color theme instead —
                    // see .pt-job-bar's own comment in styles.css for the full story. Purely a CSS
                    // class now (.pt-job-bar.storage), no inline style needed.
                    const storage = isStorageJob(j);
                    // Military (PCS) move — transparent red fill, overriding the category color
                    // entirely (see MILITARY_BG's own comment above) — added 2026-09-15 at the
                    // user's request.
                    const military = isMilitaryJob(j);

                    // Short-job widening (added 2026-09-15 at the user's request, see
                    // SHORT_JOB_MAX_DURATION_HOURS's own comment above) — bounded by the next job on
                    // this same lane so a widened short job never visually runs into it.
                    const isShort = !isLd && (j.duration || 2) <= SHORT_JOB_MAX_DURATION_HOURS;
                    let displayLeftFrac = leftFrac, displayWidthFrac = widthFrac;
                    if (isShort) {
                      const laneItems = byLane.get(lane);
                      const idxInLane = laneItems.findIndex((x) => x.j.id === j.id);
                      const next = idxInLane < laneItems.length - 1 ? laneItems[idxInLane + 1] : null;
                      const GAP = 0.006; // ~a few px of breathing room against the NEXT job's own bar
                      const rightBound = next ? next.leftFrac - GAP : 1;
                      const neededFrac = MIN_SHORT_JOB_WIDTH_PX / TRACK_WIDTH_PX;
                      const availableFrac = Math.max(widthFrac, rightBound - leftFrac);
                      displayWidthFrac = Math.max(widthFrac, Math.min(neededFrac, availableFrac));
                    }
                    // Any part of the bar that falls before 6am or after 6pm is already clamped to
                    // the visible edge (clampFrac, above) rather than overflowing the printed grid
                    // or getting hidden — the job's real time still prints as text in segs below
                    // regardless.
                    const style = { left: `${displayLeftFrac * 100}%`, width: `${displayWidthFrac * 100}%`, ...laneVerticalStyle };
                    const jobBarStyle = military ? { background: MILITARY_BG } : undefined;

                    const startHour = timeToHour(j.startTime);
                    // Departs on the day it actually starts, Arrives on the day it actually ends
                    // (job.endTime comes from the calendar sync's dtend wall-clock — see
                    // mapIcalEvent.js). A short (<= 1hr) job prints its actual start-end range
                    // instead of just a start time, since its bar is now wider than its true time
                    // span (see isShort above) — added 2026-09-15 at the user's request.
                    const timeLabel = isLd
                      ? (j.startTime && j.date === date ? `Departs ${hourToLabel(startHour)}`
                          : (j.endTime && j.endDate === date ? `Arrives ${hourToLabel(timeToHour(j.endTime))}` : null))
                      : (isShort && startHour != null
                          ? `${hourToLabel(startHour)}–${hourToLabel(startHour + (j.duration || 2))}`
                          : (j.startTime ? hourToLabel(startHour) : null));

                    // One flat run of pipe-separated detail bits on a single, never-wrapping line
                    // (each `.pt-seg` prints its own leading "| ", see styles.css) — reworked
                    // 2026-09-15 from the old flex-wrap "however many lines it takes" layout, and
                    // reordered the same day at the user's request ("use | for separating the
                    // details like name| LCL| LOAD | ADDRESS | Weight | like that") to read
                    // type -> category -> time -> address -> crew/miles -> job id, matching the old
                    // scheduler's own "TRUCK: X | PLACEHOLDER: Name | LCL | <description> | <route> |
                    // <crew>" ordering from its printout. Driver is no longer repeated here (it's the
                    // badge, above); addresses are trimmed to just the main city names (mainCity,
                    // utils/jobs.js) instead of the full street address — both changes together are
                    // most of what makes "one line" actually fit now. Anything that still doesn't fit
                    // visibly runs on past the bar's own background instead of silently truncating
                    // with an ellipsis (removed 2026-09-15 at the user's request — see .pt-job-bar's
                    // CSS for the full story) or wrapping.
                    const segs = [];
                    segs.push(isLd ? 'LD' : 'LCL'); // job type code, matching the old scheduler's LCL/MIL/LD tags
                    if (military) segs.push('MIL');
                    if (catClass) segs.push(serviceCategoryText(j));
                    segs.push(timeLabel);
                    if (j.origin || j.destination) {
                      segs.push(`${mainCity(j.origin) || '(no origin)'} → ${mainCity(j.destination) || '(no destination)'}`);
                    }
                    segs.push(`${jobTrucksNeeded(j)}T/${j.crewSize ?? '?'}M`);
                    if (j.miles) segs.push(`${j.miles} mi`);
                    segs.push(j.id);
                    // Military jobs print just the clean "Last, First" name here — dropping the
                    // leading *REWEIGH*/**VIP** marker tag and the semicolon-separated reference/
                    // routing codes SmartMoving carries in the raw customer field — added 2026-09-15
                    // at the user's request ("in print board only include their original names like
                    // Garcia, Michael"). Everywhere else (the on-screen day board, JobAssignments,
                    // etc.) still shows the raw job.customer unchanged — this substitution is
                    // deliberately scoped to the print board only.
                    const displayName = military ? militaryCleanName(j) : j.customer;

                    const lineClassName = `pt-jobline ${conflict ? 'conflict' : ''} ${isLd ? 'ld' : ''}`;
                    // Manual color override (2026-09-15) — same job.colorOverride the day board reads
                    // (jobColorOverrideClass, utils/jobs.js), so a color picked in JobEditModal shows
                    // up here too, not just on-screen. !important in styles.css's .pt-job-bar.override-*
                    // rules is what actually makes this win over .ld/.cat-load/.storage/.military above.
                    const barClassName = `pt-job-bar ${isLd ? 'ld' : ''} ${catClass ? `cat-${catClass}` : ''} ${storage ? 'storage' : ''} ${military ? 'military' : ''} ${jobColorOverrideClass(j)}`;

                    return [
                      <div className={lineClassName} style={style} data-lane={lane} key={j.id}>
                        {blockDriver && (
                          <span className="pt-driver-badge" style={badgeColor ? { background: badgeColor } : undefined}>
                            {blockDriver.name}
                          </span>
                        )}
                        <span className={barClassName} style={jobBarStyle}>
                          <b className="pt-job-name">{displayName}{conflict ? ' ⚠' : ''}</b>
                          {/* Duration, right beside the name — added 2026-09-15 at the user's request
                              ("include number of hours beside name in print board"). Local (non-LD)
                              only: an LD job's "duration" spans days, not hours, and already prints
                              its own Departs/Arrives time label in segs below instead. */}
                          {!isLd && <span className="pt-job-hours">({j.duration || 2}h)</span>}
                          {segs.filter(Boolean).map((s, i) => <span className="pt-seg" key={i}>{s}</span>)}
                        </span>
                      </div>,
                    ];
                  })}
                </div>
                </td>
              </tr>
          );
        })}
        </tbody>
      </table>

      {/* Unassigned Jobs — moved here, below the truck grid, 2026-09-15 at the user's request
          ("move the unassigned jobs and conflicts in board to the bottom and make the details to
          look more clearly as in the pdf"). Used to print as its own narrow column BESIDE the grid
          (see the 2026-09-02 restructure this replaces, and BoardTab.jsx's own comment on why) so it
          never added page HEIGHT — only width, which the grid gave up to make room. Printing it full
          width below the grid instead reintroduces exactly the height budget that restructure was
          built to avoid, so BoardTab.jsx's measureAndPrintBoard now also measures this section's own
          real rendered height and folds it into the same page-fit total the truck grid uses (see its
          comment) — there's no more separate --pt-side-scale, this section shares the grid's
          --pt-scale so both use the exact same, single font-size language top to bottom, which is
          also what actually answers "look more clearly as in the pdf": one consistent one-line/
          pipe-separated/big-font style everywhere on the page, not two different ones.
          A conflict, by definition, only happens between two jobs both assigned to the SAME truck
          (getConflicts, utils/jobs.js) — an unassigned job can never be part of one, so there's
          nothing conflict-specific to list here; every conflict already shows inline via the ⚠ flag
          and red box-shadow directly on its truck's row above (see conflictIdsToday, used throughout
          the grid rendering) — a dedicated "Conflicts" list used to exist here too, removed
          2026-09-11 once overlapping jobs started stacking as full lanes right on the grid instead
          of hiding one behind the other, which made a separate list pure duplication.

          Skipped entirely on "Print All Trucks" (includeAllTrucks) — added 2026-09-15 at the user's
          follow-up request ("in print all trucks don't print unassigned jobs"). That printout is
          about seeing the WHOLE FLEET including idle trucks, not about what still needs a truck —
          Unassigned Jobs is still exactly what "Print Board" itself is for, unchanged. */}
      {!includeAllTrucks && (
      <div className="pt-unassigned-section">
        <div className="pt-unassigned-title">
          ⚠ Unassigned Jobs{unassigned.length > 0 ? ` (${unassigned.length})` : ''}
        </div>
        {unassigned.length > 0 ? (
          <div className="pt-unassigned-list">
            {unassigned.map((j) => {
              const isLdU = j.type === 'long_distance';
              const catClassU = serviceCategoryClass(j);
              const storageU = isStorageJob(j);
              const militaryU = isMilitaryJob(j);
              const jobBarStyleU = militaryU ? { background: MILITARY_BG } : undefined;
              const displayNameU = militaryU ? militaryCleanName(j) : j.customer;
              const segsU = [];
              segsU.push(isLdU ? 'LD' : 'LCL');
              if (militaryU) segsU.push('MIL');
              if (catClassU) segsU.push(serviceCategoryText(j));
              if (!isLdU && j.startTime) segsU.push(hourToLabel(timeToHour(j.startTime)));
              if (j.origin || j.destination) {
                segsU.push(`${mainCity(j.origin) || '(no origin)'} → ${mainCity(j.destination) || '(no destination)'}`);
              }
              segsU.push(`${jobTrucksNeeded(j)}T/${j.crewSize ?? '?'}M`);
              if (j.miles) segsU.push(`${j.miles} mi`);
              segsU.push(j.id);
              const barClassNameU = `pt-job-bar ${isLdU ? 'ld' : ''} ${catClassU ? `cat-${catClassU}` : ''} ${storageU ? 'storage' : ''} ${militaryU ? 'military' : ''} ${jobColorOverrideClass(j)}`;
              return (
                <div className="pt-jobline static" key={j.id}>
                  <span className={barClassNameU} style={jobBarStyleU}>
                    <b className="pt-job-name">{displayNameU}</b>
                    {!isLdU && <span className="pt-job-hours">({j.duration || 2}h)</span>}
                    {segsU.filter(Boolean).map((s, i) => <span className="pt-seg" key={i}>{s}</span>)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="pt-unassigned-empty">No unassigned jobs today.</div>
        )}
      </div>
      )}

      <div className="print-footer">Printed {printedAt}</div>
    </div>
  );
}
