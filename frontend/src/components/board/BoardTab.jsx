import { useEffect, useMemo, useRef, useState } from 'react';
import DuplicateAlertBanner from '../DuplicateAlertBanner';
import DriverLegend from '../DriverLegend';
import DayBoard from './DayBoard';
import MonthBoard from './MonthBoard';
import OverlappedAlertsTab from './OverlappedAlertsTab';
import DayPrintSheet from './DayPrintSheet';
import DayPrintTimeline from './DayPrintTimeline';
import JobSearch from './JobSearch';
import { useDragAutoScroll } from '../../hooks/useDragAutoScroll';
import { todayStr, addDays, jobActiveOn } from '../../utils/dates';
import { isTransitOnlyDay, jobTruckIds, overlappingClusterFor, conflictIdsFrom } from '../../utils/jobs';

// Both print sheets are always in the DOM (hidden on screen) so printing never has to wait on a
// React re-render. Which one shows up on paper is decided by a plain DOM class toggle right before
// window.print() is called — deliberately not React state, since setState + window.print() in the
// same click handler risks the browser printing the PREVIOUS render (state updates are async;
// print() isn't) if you don't add an effect to sequence them. A synchronous classList toggle has
// no such race.
//
// Orientation is applied the same way, for the same reason a plain CSS `@page` + named-page
// selector wasn't reliable enough on its own (styles.css still has it as a fallback): a
// dynamically-injected <style> tag setting `@page { size: ... }` right before print() actually
// gets picked up by every major browser's print engine, whereas `page: pt-landscape` (CSS Paged
// Media's named-page feature) only has solid support in Chromium — Firefox/Safari mostly ignore
// it and fall back to whatever the print dialog defaults to. Removed again on 'afterprint' so the
// next "Print List" (portrait) isn't left landscape from a prior "Print Board".
let printOrientationStyleEl = null;
function setPrintOrientation(orientation) {
  if (!printOrientationStyleEl) {
    printOrientationStyleEl = document.createElement('style');
    document.head.appendChild(printOrientationStyleEl);
    window.addEventListener('afterprint', () => { printOrientationStyleEl.textContent = ''; });
  }
  const margin = orientation === 'landscape' ? '10mm' : '14mm';
  printOrientationStyleEl.textContent = `@page{size:letter ${orientation};margin:${margin};}`;
}

// "Print Board" (DayPrintTimeline) needs every truck on ONE Letter-landscape page, however many
// trucks are running that day — a fixed font size either overflowed onto extra pages for a
// bigger-than-usual fleet, or (if shrunk to always be safe) printed smaller than necessary on a
// normal day. Instead, --pt-scale (consumed throughout styles.css's .pt-* rules via
// `calc(<base> * var(--pt-scale, 1))`) is computed fresh from the actual truck count every time
// "Print Board" is clicked, and set as an inline CSS variable on the print-sheet root right before
// printing — see printSheet() below. A small fleet still prints at full (scale 1) size; only a
// fleet big enough to overflow shrinks, and only as much as it needs to.
//
// This is arithmetic, not a DOM measurement — the print-sheet is normally display:none (see
// styles.css) until the instant before window.print(), and even once shown, the screen viewport's
// width doesn't match the actual ~11in print page width, so measuring on-screen height first would
// be an unreliable proxy for the real printed layout anyway. Instead these constants mirror the
// *unscaled* (scale 1) pixel values already tuned in styles.css's .pt-hour/.pt-track/etc. rules —
// if those base sizes ever change, update the matching constant here too.
const PAGE_HEIGHT_IN = 8.5; // US Letter landscape short side (11in x 8.5in)
const MARGIN_IN = 10 / 25.4; // matches the 10mm landscape @page margin above
const PX_PER_IN = 96; // CSS's fixed reference pixel density — independent of actual print DPI
// .print-sheet.print-active{padding:20px} (styles.css, @media print) adds its OWN 20px padding on
// every side of the sheet, INSIDE the @page margin already subtracted below — found 2026-09-02
// while chasing a lingering, almost-empty second page after the conflicts/unassigned side-panel
// restructure had already fixed the big overflow. That restructure closed the large gap (the
// stacked conflict rows/Unassigned table that were never budgeted for at all), but this 40px
// top+bottom padding was ALSO never subtracted here, even before that fix — it just never mattered
// on its own while a much bigger overflow was already forcing a 2nd page regardless. Once the big
// gap closed, this 40px alone was enough to still push a normal-size page's total rendered height
// (header + table + footer, or header + side panel + footer) just past one page's worth of room —
// small enough that nothing visible actually lands on that forced 2nd page, which is exactly the
// "why is there a 2nd page with nothing on it" symptom this fixes.
const SHEET_PADDING_PX = 20;
// Some browsers' print dialogs (Chrome/Edge's "Headers and footers" option, on by default in some
// setups and not always easy to find/disable — see the 2026-09-03 report of this from a user on
// Edge) print their OWN date/URL/title/page-number strip at the top and bottom of every page,
// reserving real vertical space that lives outside this app's CSS entirely — there's no DOM
// element, no @page rule, nothing this file can measure or control for it. Found 2026-09-03 from a
// printout where the app's own content fit ENTIRELY on page 1 (every truck row, side panel, all of
// it) and page 2 was completely blank except that browser-added strip — proof the shortfall wasn't
// this app's math being wrong, just not knowing about a chunk of space it doesn't own. This buffer
// is a defensive estimate (roughly half an inch) of how much room that strip typically eats, so a
// printout stays on one page whether or not any given user's browser/settings happen to add one —
// worst case it shrinks text slightly more than strictly necessary when the setting is off.
const BROWSER_HEADER_FOOTER_BUFFER_PX = 48;
const CONTENT_HEIGHT_PX = (PAGE_HEIGHT_IN - MARGIN_IN * 2) * PX_PER_IN - SHEET_PADDING_PX * 2 - BROWSER_HEADER_FOOTER_BUFFER_PX;
// .print-header + .print-footer + the hours <thead> row, at scale 1 — small relative to the page,
// so (unlike the truck rows) not worth also shrinking via --pt-scale just to claw back a few more
// px of headroom.
const HEADER_FOOTER_THEAD_PX = 46 + 26 + 28;
const SAFETY_BUFFER_PX = 12; // rounding/line-height slack so the last row never juuust spills over
const BASE_ROW_HEIGHT_PX = 55; // .pt-track's 54px min-height + its 1px border-bottom, at scale 1 — shrunk from 98 to 51 then bumped to 55 on 2026-08-28 alongside .pt-track's own min-height (see that CSS rule's comment)
// Floor — below this the text stops being "readable" (the whole point of this feature), so an
// unusually large fleet is allowed to spill onto a 2nd page rather than shrink past legibility.
const MIN_TRUCK_PRINT_SCALE = 0.55;

function truckPrintScale(truckCount) {
  if (!truckCount) return 1;
  const availableForRows = CONTENT_HEIGHT_PX - HEADER_FOOTER_THEAD_PX - SAFETY_BUFFER_PX;
  const scale = availableForRows / (truckCount * BASE_ROW_HEIGHT_PX);
  return Math.max(MIN_TRUCK_PRINT_SCALE, Math.min(1, scale));
}

// Conflicts and Unassigned Jobs used to print as extra rows/blocks stacked BELOW the truck grid —
// an inline conflict panel under every truck that had one, then a whole separate Unassigned table
// after the whole grid — and neither one was ever budgeted into truckPrintScale's page-fit math
// above, which only ever looked at truck count. A day with a handful of conflicts or several
// unassigned jobs routinely pushed the printout onto a second page even though the truck grid
// alone fit fine. Fixed 2026-09-02 at the user's request by moving both into a side column BESIDE
// the grid instead (see DayPrintTimeline.jsx's `.pt-side-panel` and its own restructure comment) —
// a column adds WIDTH, never height, so it can never be the reason the page spills onto a second
// sheet. That side column gets its own independent scale (`--pt-side-scale`, separate from the
// truck grid's `--pt-scale`) sized from how much conflict/unassigned content there actually is
// today, computed here.
//
// This mirrors — deliberately, not by import — the exact grouping DayPrintTimeline.jsx's own render
// does (activeJobs/conflictsToday/conflictIdsToday/per-truck overlappingClusterFor clusters), same
// "duplicated on purpose" tradeoff transitOnlyJobCount above already makes: the scale has to be
// known and set as a CSS var on the print-sheet root BEFORE window.print() is called, which is
// necessarily before DayPrintTimeline ever renders with today's data, so there's no DOM measurement
// available to read this from — see printSheet()'s own comment for why this is arithmetic, not a
// measurement, throughout this file.
function countPrintSideContent(jobs, trucks, date, conflicts) {
  const activeJobs = jobs.filter((j) => jobActiveOn(j, date) && !isTransitOnlyDay(j, date));
  const activeJobIds = new Set(activeJobs.map((j) => j.id));
  const conflictsToday = (conflicts || []).filter((c) => activeJobIds.has(c.a.id) && activeJobIds.has(c.b.id));
  const conflictIdsToday = conflictIdsFrom(conflictsToday);

  let conflictTruckCount = 0;
  let conflictJobEntryCount = 0;
  trucks.forEach((t) => {
    const tjobs = activeJobs.filter((j) => jobTruckIds(j).includes(t.id));
    const seen = new Set();
    let truckHasConflict = false;
    tjobs.forEach((j) => {
      if (!conflictIdsToday.has(j.id) || seen.has(j.id)) return;
      const cluster = overlappingClusterFor(conflictsToday, t.id, j);
      cluster.forEach((cj) => seen.add(cj.id));
      conflictJobEntryCount += cluster.length;
      truckHasConflict = true;
    });
    if (truckHasConflict) conflictTruckCount += 1;
  });

  const unassignedCount = jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date).length;
  return { conflictTruckCount, conflictJobEntryCount, unassignedCount };
}

// Per-entry height budgets for the side panel, at scale 1 — deliberately generous (biased toward
// shrinking a bit more than strictly necessary) since a real conflict/unassigned entry can wrap to
// 2 lines (name+time on one, the full origin -> destination address on another) and there's no DOM
// to measure ahead of time — same reasoning as BASE_ROW_HEIGHT_PX above, just for the narrower
// side column instead of a truck row.
const SIDE_SECTION_HEADER_PX = 20; // "⚠ Conflicts Today" / "Unassigned Jobs" section title
const SIDE_TRUCK_HEADER_PX = 18; // one per truck with a conflict, inside the Conflicts section
const SIDE_CONFLICT_ENTRY_PX = 34; // one per job listed in a conflict cluster
const SIDE_UNASSIGNED_ENTRY_PX = 30; // one per unassigned job
// Side panel is secondary/reference detail, not the primary thing being handed to a crew — allowed
// to shrink further than the truck grid's own MIN_TRUCK_PRINT_SCALE floor before anything would
// need to be cut, since legibility matters less here than it does for the truck bars themselves.
const MIN_SIDE_PRINT_SCALE = 0.45;

// Independent from truckPrintScale — see countPrintSideContent's comment above for why the two
// columns (truck grid vs. side panel) each get their own scale instead of sharing one, even though
// both are sized against the exact same page content-height budget.
function sidePanelPrintScale({ conflictTruckCount, conflictJobEntryCount, unassignedCount }) {
  const availableForRows = CONTENT_HEIGHT_PX - HEADER_FOOTER_THEAD_PX - SAFETY_BUFFER_PX;
  const conflictsNeeded = conflictJobEntryCount > 0
    ? SIDE_SECTION_HEADER_PX + conflictTruckCount * SIDE_TRUCK_HEADER_PX + conflictJobEntryCount * SIDE_CONFLICT_ENTRY_PX
    : 0;
  const unassignedNeeded = unassignedCount > 0
    ? SIDE_SECTION_HEADER_PX + unassignedCount * SIDE_UNASSIGNED_ENTRY_PX
    : 0;
  const needed = conflictsNeeded + unassignedNeeded;
  if (needed <= 0) return 1;
  const scale = availableForRows / needed;
  return Math.max(MIN_SIDE_PRINT_SCALE, Math.min(1, scale));
}

function printSheet(id, orientation = 'portrait', truckCount, sideCounts) {
  document.querySelectorAll('.print-sheet').forEach((el) => el.classList.remove('print-active'));
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('print-active');
    // Only "Print Board" passes truckCount/sideCounts — "Print List" (the plain manifest) doesn't
    // use --pt-scale/--pt-side-scale at all, so setting both to 1 there is harmless, just unused.
    el.style.setProperty('--pt-scale', String(truckCount != null ? truckPrintScale(truckCount) : 1));
    el.style.setProperty('--pt-side-scale', String(sideCounts ? sidePanelPrintScale(sideCounts) : 1));
  }
  setPrintOrientation(orientation);
  window.print();
}

// "Print Board" (DayPrintTimeline) skips a long-distance job on the specific day being printed only
// when that day is strictly BETWEEN its start and end date (an "in transit" day with no actionable
// truck work) — see that component's isTransitOnlyDay doc comment; the job's actual start day and
// end day both print normally. Added 2026-08-27 at the user's request: before printing, warn the
// dispatcher with a plain window.confirm() naming how many jobs will be skipped on THIS date, so a
// multi-day move never just silently vanishes from what gets handed to a crew. A synchronous
// confirm() blocks the click handler without triggering a React re-render, so it's safe to call
// before printSheet() in the same handler — same "no state, no race" reasoning as printSheet()'s
// own comment above.
function transitOnlyJobCount(jobs, date) {
  return jobs.filter((j) => isTransitOnlyDay(j, date)).length;
}

export default function BoardTab({
  role, boardMode, setBoardMode, boardDate, setBoardDate, monthCursor, setMonthCursor,
  trucks, drivers, jobs, currentCrewTruck, conflicts, conflictIds, placeholderDuplicates,
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onMoveJobDate, onAddExtraTruck, onSetJobTruckDriver, onUpdateJobFields,
  onCreateJob, onDeleteJob,
}) {
  const title = role === 'crew'
    ? 'Company truck board — view only'
    : "Drag a job onto a truck's row (day view) or a date (month view) to assign it";

  // Lets the page auto-scroll while dragging a job near the top or bottom of the screen — see
  // useDragAutoScroll's doc comment for why this can't just rely on the browser's native
  // drag-auto-scroll (it silently fails at the top edge here because of the sticky header/nav).
  // Also auto-scrolls the day view's timeline left/right near ITS edges — timelineRef is owned
  // here (not inside DayBoard) so the same ref can both be handed to the hook and passed down to
  // DayBoard to attach to the actual scrollable element.
  const timelineRef = useRef(null);
  useDragAutoScroll({ horizontalScrollRef: timelineRef });

  // Search always jumps to day view — that's the one place a job's exact truck/time is visible —
  // and briefly highlights the job once the board lands on its date, so "find this job" ends with
  // actually seeing it, not just guessing it's somewhere on the right day.
  const [highlightedJobId, setHighlightedJobId] = useState(null);
  useEffect(() => {
    if (!highlightedJobId) return undefined;
    const timer = setTimeout(() => setHighlightedJobId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedJobId]);

  function handleJumpToJob(job) {
    setBoardMode('day');
    setBoardDate(job.date);
    setMonthCursor(new Date(`${job.date}T00:00:00`));
    setHighlightedJobId(job.id);
  }

  // Month view only (day view already shows everything for one date at a time, and Overlapped
  // Alerts is already conflicts-only by nature) — lets a dispatcher see local moves, long-distance
  // moves, or just the jobs currently in conflict, in isolation instead of everything crowded onto
  // the same calendar cells. Filtering the JOBS ARRAY passed into MonthBoard (rather than adding
  // filter logic inside it) is deliberate: MonthBoard/Week already derive every rendered piece —
  // day chips, week bars, even the local-job-over-an-LD-bar overlay markers — purely from whatever
  // `jobs` it's handed, so a pre-filtered array here "just works" for every filter mode with zero
  // changes needed inside MonthBoard.jsx. conflictIds/conflicts themselves are always computed from
  // the FULL unfiltered job set (see App.jsx) and passed through unchanged, so conflict flags/badges
  // stay correct regardless of which filter is active — including "Conflicts", which naturally keeps
  // BOTH sides of a conflicting pair (local-local, LD-LD, or mixed) since conflictIds already spans
  // every type.
  // Day view only — a long-distance job spans its ENTIRE date range on a truck's row (jobActiveOn,
  // utils/dates.js, has no notion of "in transit" vs. "actually working today"), and getConflicts
  // (utils/jobs.js) treats that whole span as fully busy too, so a multi-week move can flag a
  // conflict on every truck row it merely passes through. Added 2026-09-01 at the user's request
  // ("hide the multi day jobs that are in transit which are making many conflicts") — reuses the
  // exact isTransitOnlyDay definition DayPrintTimeline.jsx already established for the printed
  // board (see utils/jobs.js), so a job that's already invisible on a printout is now optionally
  // invisible on the live board too, for the same reason: nothing actionable happens on that truck
  // that day. Defaults to OFF (existing behavior unchanged) since this hides real jobs from the
  // view — a dispatcher opts in rather than something disappearing on them unannounced. Persists
  // only for this browser tab's session (plain useState, not written to Firestore or localStorage)
  // since it's a personal viewing preference, not shared board state.
  const [hideInTransit, setHideInTransit] = useState(false);
  const transitHiddenCount = boardMode === 'day' ? transitOnlyJobCount(jobs, boardDate) : 0;

  const [monthFilter, setMonthFilter] = useState('all');
  const monthFilteredJobs = useMemo(() => {
    if (monthFilter === 'local') return jobs.filter((j) => j.type !== 'long_distance');
    if (monthFilter === 'long_distance') return jobs.filter((j) => j.type === 'long_distance');
    if (monthFilter === 'conflicts') return jobs.filter((j) => conflictIds.has(j.id));
    return jobs;
  }, [jobs, monthFilter, conflictIds]);

  return (
    <section>
      <div className="toolbar">
        <h2 className="section-title">{title}</h2>
        <JobSearch jobs={jobs} trucks={trucks} onJumpToJob={handleJumpToJob} />
        <div className="board-controls">
          <div className="view-toggle">
            <button className={`btn secondary ${boardMode === 'day' ? 'active' : ''}`} onClick={() => setBoardMode('day')}>Day</button>
            <button className={`btn secondary ${boardMode === 'month' ? 'active' : ''}`} onClick={() => setBoardMode('month')}>Month</button>
            {/* Moved out of an always-visible banner above the board (see OverlappedAlertsTab.jsx's
                doc comment) into its own tab, at the user's request — a real sync run regularly
                produces dozens of these and the banner was crowding out the board itself. The count
                badge means a dispatcher still sees at a glance whether there's anything to look at,
                without switching tabs first. */}
            <button className={`btn secondary oa-toggle-btn ${boardMode === 'conflicts' ? 'active' : ''}`} onClick={() => setBoardMode('conflicts')}>
              Overlapped Alerts
              {conflicts.length > 0 && <span className="oa-count-badge">{conflicts.length}</span>}
            </button>
          </div>
          {boardMode === 'day' && (
            <div className="datepick">
              <span>Date:</span>
              {/* addDays (utils/dates.js) does its arithmetic through a real local-midnight Date
                  object rather than string-slicing the ISO date, so this rolls over month/year
                  boundaries and DST changes correctly — same helper daysBetween/LD day-index math
                  already relies on elsewhere, not a new date-parsing path. Mirrors the month view's
                  own ‹/› prev/next buttons (.monthpick below) for a consistent look. */}
              <button className="btn secondary" onClick={() => setBoardDate(addDays(boardDate, -1))} title="Previous day">‹</button>
              <input type="date" value={boardDate} onChange={(e) => setBoardDate(e.target.value)} />
              <button className="btn secondary" onClick={() => setBoardDate(addDays(boardDate, 1))} title="Next day">›</button>
              <button className="btn secondary" onClick={() => setBoardDate(todayStr())} title="Jump to today — the same date the now-line marks on the timeline">Today</button>
              <button
                className={`btn secondary ${hideInTransit ? 'active' : ''}`}
                onClick={() => setHideInTransit((v) => !v)}
                title="Hide long-distance jobs on days they're only in transit (not the pickup or delivery day) — reduces conflict clutter from a move that's just passing through a truck's schedule."
              >
                {hideInTransit ? 'In-transit hidden' : 'Hide in-transit'}
                {hideInTransit && transitHiddenCount > 0 && <span className="oa-count-badge">{transitHiddenCount}</span>}
              </button>
              <button className="btn secondary" onClick={() => printSheet('day-print-list')} title="Print a plain text list of the day's jobs">🖨 Print List</button>
              <button
                className="btn secondary"
                onClick={() => {
                  // A long-distance job "in transit" on this specific date (not starting or ending
                  // today) never appears on this printout (see DayPrintTimeline.jsx's
                  // isTransitOnlyDay) — confirm first so a dispatcher printing for a crew isn't
                  // surprised later that one of those jobs isn't on the page.
                  const skipped = transitOnlyJobCount(jobs, boardDate);
                  if (skipped > 0) {
                    const ok = window.confirm(
                      `${skipped} long-distance job${skipped === 1 ? ' is' : 's are'} in transit today (not starting or ending) and won't appear on this printed board. ` +
                      `Print the rest anyway?`
                    );
                    if (!ok) return;
                  }
                  // Conflicts/Unassigned Jobs print in their own side column, not stacked below the
                  // grid — see countPrintSideContent/sidePanelPrintScale above and
                  // DayPrintTimeline.jsx's restructure comment — so their own scale is computed here
                  // from today's actual conflict/unassigned counts, independent of truck count.
                  const sideCounts = countPrintSideContent(jobs, trucks, boardDate, conflicts);
                  printSheet('day-print-timeline', 'landscape', trucks.length, sideCounts);
                }}
                title="Print the truck board as it looks on screen — colors, bars, trucks on the left, 6am-6pm — with Conflicts and Unassigned Jobs in their own column beside the calendar. Everything is fit onto one page, shrinking text only as much as the fleet size and side-panel content require. Long-distance jobs print on their start and end day; days in between (in transit) are left off, and you'll be asked to confirm first if any would be skipped today."
              >
                🖨 Print Board
              </button>
            </div>
          )}
          {boardMode === 'month' && (
            <div className="monthpick">
              <button className="btn secondary" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}>‹</button>
              <span>{monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
              <button className="btn secondary" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}>›</button>
            </div>
          )}
          {boardMode === 'month' && (
            <div className="view-toggle month-filter">
              <button className={`btn secondary ${monthFilter === 'all' ? 'active' : ''}`} onClick={() => setMonthFilter('all')} title="Show every job">All</button>
              <button className={`btn secondary ${monthFilter === 'local' ? 'active' : ''}`} onClick={() => setMonthFilter('local')} title="Local moves only">Local</button>
              <button className={`btn secondary ${monthFilter === 'long_distance' ? 'active' : ''}`} onClick={() => setMonthFilter('long_distance')} title="Long-distance moves only">Long Distance</button>
              <button className={`btn secondary oa-toggle-btn ${monthFilter === 'conflicts' ? 'active' : ''}`} onClick={() => setMonthFilter('conflicts')} title="Only jobs currently in a scheduling conflict">
                Conflicts
                {conflictIds.size > 0 && <span className="oa-count-badge">{conflictIds.size}</span>}
              </button>
            </div>
          )}
        </div>
      </div>

      {boardMode !== 'conflicts' && (
        <>
          <DuplicateAlertBanner duplicates={placeholderDuplicates || []} />
          <DriverLegend trucks={trucks} drivers={drivers} jobs={jobs} date={boardDate} />
        </>
      )}

      {boardMode === 'day' && (
        <>
          {hideInTransit && transitHiddenCount > 0 && (
            <div className="month-filter-note">
              Hiding {transitHiddenCount} long-distance job{transitHiddenCount === 1 ? '' : 's'} in transit today (not the pickup or delivery day).
            </div>
          )}
          <DayBoard
            date={boardDate}
            trucks={trucks}
            drivers={drivers}
            jobs={jobs}
            role={role}
            conflictIds={conflictIds}
            conflicts={conflicts}
            hideInTransit={hideInTransit}
            onUnassignJob={onUnassignJob}
            onAddTruckToJob={onAddTruckToJob}
            onRemoveTruck={onRemoveTruck}
            onAddExtraTruck={onAddExtraTruck}
            onSetJobTruckDriver={onSetJobTruckDriver}
            onUpdateJobFields={onUpdateJobFields}
            onCreateJob={onCreateJob}
            onDeleteJob={onDeleteJob}
            highlightedJobId={highlightedJobId}
            timelineRef={timelineRef}
          />
          <DayPrintSheet id="day-print-list" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds} />
          <DayPrintTimeline id="day-print-timeline" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflicts={conflicts} />
        </>
      )}
      {boardMode === 'month' && monthFilter !== 'all' && (
        <div className="month-filter-note">
          Showing {monthFilteredJobs.length} of {jobs.length} jobs
          {monthFilter === 'local' && ' — local moves only'}
          {monthFilter === 'long_distance' && ' — long-distance moves only'}
          {monthFilter === 'conflicts' && ' — conflicts only'}.
        </div>
      )}
      {boardMode === 'month' && (
        <MonthBoard
          monthCursor={monthCursor}
          trucks={trucks}
          drivers={drivers}
          jobs={monthFilteredJobs}
          role={role}
          currentCrewTruck={currentCrewTruck}
          conflicts={conflicts}
          conflictIds={conflictIds}
          onMoveJobDate={onMoveJobDate}
          onAddExtraTruck={onAddExtraTruck}
        />
      )}
      {boardMode === 'conflicts' && (
        <OverlappedAlertsTab conflicts={conflicts} trucks={trucks} drivers={drivers} onJumpToJob={handleJumpToJob} />
      )}
    </section>
  );
}
