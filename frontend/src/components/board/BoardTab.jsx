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
import { todayStr, addDays } from '../../utils/dates';

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
const CONTENT_HEIGHT_PX = (PAGE_HEIGHT_IN - MARGIN_IN * 2) * PX_PER_IN;
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

function printSheet(id, orientation = 'portrait', truckCount) {
  document.querySelectorAll('.print-sheet').forEach((el) => el.classList.remove('print-active'));
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('print-active');
    // Only "Print Board" passes truckCount — "Print List" (the plain manifest) doesn't use
    // --pt-scale at all, so setting it to 1 there is harmless, just unused.
    el.style.setProperty('--pt-scale', String(truckCount != null ? truckPrintScale(truckCount) : 1));
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
  return jobs.filter((j) => j.type === 'long_distance' && j.endDate && j.endDate !== j.date
    && date > j.date && date < j.endDate).length;
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
                  printSheet('day-print-timeline', 'landscape', trucks.length);
                }}
                title="Print the truck board as it looks on screen — colors, bars, trucks on the left, 6am-6pm, plus full details for any conflicting jobs. Every truck is fit onto one page, shrinking text only as much as the fleet size requires. Long-distance jobs print on their start and end day; days in between (in transit) are left off, and you'll be asked to confirm first if any would be skipped today."
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
          <DayBoard
            date={boardDate}
            trucks={trucks}
            drivers={drivers}
            jobs={jobs}
            role={role}
            conflictIds={conflictIds}
            conflicts={conflicts}
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
