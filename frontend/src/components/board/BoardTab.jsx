import { useMemo, useRef, useState } from 'react';
import DuplicateAlertBanner from '../DuplicateAlertBanner';
import DriverLegend from '../DriverLegend';
import DayBoard from './DayBoard';
import MonthBoard from './MonthBoard';
import OverlappedAlertsTab from './OverlappedAlertsTab';
import { useDragAutoScroll } from '../../hooks/useDragAutoScroll';
import { todayStr, addDays, jobActiveOn, jobActiveInMonth } from '../../utils/dates';
import { isTransitOnlyDay } from '../../utils/jobs';

// Both print sheets are always in the DOM (hidden on screen) so printing never has to wait on a
// React re-render. Which one shows up on paper is decided by a plain DOM class toggle right before
// window.print() is called — deliberately not React state, since setState + window.print() in the
// same click handler risks the browser printing the PREVIOUS render (state updates are async;
// print() isn't) if you don't add an effect to sequence them. A synchronous classList toggle has
// no such race.
//
// Orientation is applied the same way, for the same reason a plain CSS `@page` + named-page
// selector wasn't reliable enough on its own (styles.css still has a plain `@page` as a fallback):
// a dynamically-injected <style> tag setting `@page { size: ... }` right before print() actually
// gets picked up by every major browser's print engine, whereas CSS Paged Media's named-page
// feature only has solid support in Chromium — Firefox/Safari mostly ignore it and fall back to
// whatever the print dialog defaults to. Removed again on 'afterprint' so a later print never
// inherits a stale orientation from an earlier one.
//
// "Print List" always prints portrait; "Print Board" (DayPrintTimeline) went landscape -> portrait
// -> landscape again, all on 2026-09-15: it started landscape, switched to match "Print List" at the
// user's request ("make the print board portrait so that it will fit like the old scheduler fit"),
// then switched back once a later request that same day ("make sure that every detail of the job is
// getting printed...if needed convert the print board page to landscape") made clear portrait's
// narrower page was exactly what was squeezing some jobs' detail text — see measureAndPrintBoard
// below for its own orientation call. This function still takes an explicit orientation argument
// (rather than being hardcoded) since it's a plain, general-purpose helper — nothing about it
// assumes both callers agree, which they now genuinely don't.
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

// "Print Board" (DayPrintTimeline) needs every working truck on ONE Letter-portrait page, however
// much vertical room that day's actual jobs need — a truck with two overlapping jobs needs two
// stacked lanes, and (since 2026-09-15's one-line-per-job rework, see DayPrintTimeline.jsx's
// BASE_ROW_HEIGHT_PX comment) every lane is now a fixed height, so "how much room a day needs" is
// just its total lane count. A fixed font size either overflowed onto extra pages for an unusually
// busy day, or (if shrunk to always be safe) printed smaller than necessary on a normal one. Instead,
// --pt-scale (consumed throughout styles.css's .pt-* rules via `calc(<base> * var(--pt-scale, 1))`)
// is computed fresh every time "Print Board" is clicked (see measureAndPrintBoard below for the real
// DOM-measurement pass that actually drives this, and printSheet() for the plain "Print List"
// manifest's simpler arithmetic-only version) and set as an inline CSS variable on the print-sheet
// root right before printing. A normal day still prints at full (scale 1) size; only a day with
// enough content to overflow shrinks, and only as much as it needs to.
//
// These constants mirror the *unscaled* (scale 1) pixel values already tuned in styles.css's
// .pt-hour/.pt-track/etc. rules — if those base sizes ever change, update the matching constant here
// too.
// PAGE_HEIGHT_IN/MARGIN_IN switched from landscape (8.5in height, 10mm margin) to portrait (11in
// height, 14mm margin) 2026-09-15 at the user's request ("make the print board portrait so that it
// will fit like the old scheduler fit"), then back to landscape again the SAME day once a later
// request ("make sure that every detail of the job is getting printed in the print board...if
// needed convert the print board page to landscape") made it clear portrait's narrower width was
// exactly what was making some jobs' full detail line not fit — see setPrintOrientation's own margin
// table below and measureAndPrintBoard's now-'landscape' call. Landscape's *wider* page (11in vs.
// portrait's 8.5in short side) means more horizontal room per truck row for a job's one-line detail
// text, at the cost of less vertical room per page than portrait had — DayPrintTimeline.jsx's own
// TRACK_WIDTH_PX mirrors the wider width. "Print List" (the plain manifest) is UNAFFECTED — it still
// prints portrait, only "Print Board" (DayPrintTimeline) uses these constants.
const PAGE_HEIGHT_IN = 8.5; // US Letter landscape short side (11in x 8.5in)
const MARGIN_IN = 10 / 25.4; // matches the 10mm landscape @page margin below
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
// "Print All Trucks" variant only — added 2026-09-15 at the user's request ("remove the main
// heading"). DayPrintTimeline.jsx skips rendering .print-header entirely when includeAllTrucks is
// true (see its own return statement), so that 46px never actually occupies any space on that
// printout — budgeting for it here anyway would just make this variant shrink its text MORE than
// it needs to. Same footer + thead, minus the header.
const HEADER_FOOTER_THEAD_PX_ALL_TRUCKS = 26 + 28;
const SAFETY_BUFFER_PX = 12; // rounding/line-height slack so the last row never juuust spills over
// .pt-track's per-lane height at scale 1 — was 55 (54px min-height + 1px border-bottom) back when a
// lane's real height varied by how many lines its job's text wrapped to. Reworked 2026-09-15
// alongside DayPrintTimeline.jsx's move to a one-line-per-job layout (see that file's own
// BASE_ROW_HEIGHT_PX comment for the full story): every lane is now always exactly one line tall, so
// this is simply that line's height instead of a "tallest job in this lane" estimate. Kept in sync
// with DayPrintTimeline.jsx's own BASE_ROW_HEIGHT_PX by hand — the two have to agree for the same
// "known before the other file's math runs" reason noted throughout this file.
const BASE_ROW_HEIGHT_PX = 46;
// Floor — below this the text stops being "readable" (the whole point of this feature), so an
// unusually busy day (a big fleet, or several stacked overlaps) is allowed to spill onto a 2nd page
// rather than shrink past legibility.
const MIN_TRUCK_PRINT_SCALE = 0.55;
// "Print All Trucks" variant only — added 2026-09-15 at the user's explicit request ("make the font
// size adjustments to print in only one page, no matter how many jobs there are"), overriding the
// legibility floor above JUST for that button. Printing the entire fleet (not just today's working
// trucks) means this variant's content height can genuinely exceed what MIN_TRUCK_PRINT_SCALE would
// still fit on one page — the user explicitly said a guaranteed single page matters more than
// legibility here, unlike "Print Board" (which still respects MIN_TRUCK_PRINT_SCALE and is allowed
// to spill onto a 2nd page on a busy day). Not literally 0 — a couple percent keeps the scaled text
// from collapsing to an unrenderable sliver — but low enough that, combined with
// HEADER_FOOTER_THEAD_PX_ALL_TRUCKS above, the one-page guarantee holds for any realistic fleet size.
const MIN_TRUCK_PRINT_SCALE_ALL_TRUCKS = 0.08;
// Ceiling on the OTHER end — originally added 2026-09-11 after a light day (few trucks, one job
// each) came out printed at full, uncapped scale 1, and raised 2026-09-15 at the user's request for
// a bigger, old-scheduler-style printout ("all jobs are in one line, with big font size"): now that
// every job is a single line instead of a wrapped 2-4 line block, a typical day needs far less total
// content height, so most days will land at (or near) this ceiling rather than deep inside it —
// raising it is what actually makes the printed text bigger day to day, not just the base .pt-*
// font-size values in styles.css. Only a genuinely busy day still shrinks further (down to
// MIN_TRUCK_PRINT_SCALE) to fit one page.
const MAX_TRUCK_PRINT_SCALE = 0.85;

// `forAllTrucks` (added 2026-09-15) swaps in the "Print All Trucks" variant's own header/footer
// budget and legibility floor — see HEADER_FOOTER_THEAD_PX_ALL_TRUCKS and
// MIN_TRUCK_PRINT_SCALE_ALL_TRUCKS above for why those need to differ from "Print Board"'s. Default
// (false) keeps "Print Board" byte-for-byte identical to its prior behavior.
function truckPrintScale(contentHeightPx, forAllTrucks = false) {
  if (!contentHeightPx) return MAX_TRUCK_PRINT_SCALE;
  const headerFooterTheadPx = forAllTrucks ? HEADER_FOOTER_THEAD_PX_ALL_TRUCKS : HEADER_FOOTER_THEAD_PX;
  const minScale = forAllTrucks ? MIN_TRUCK_PRINT_SCALE_ALL_TRUCKS : MIN_TRUCK_PRINT_SCALE;
  const availableForRows = CONTENT_HEIGHT_PX - headerFooterTheadPx - SAFETY_BUFFER_PX;
  const scale = availableForRows / contentHeightPx;
  return Math.max(minScale, Math.min(MAX_TRUCK_PRINT_SCALE, scale));
}

// A character-count-based version of the truck grid's content-height estimate used to live here
// (jobDetailTextLength -> estimateHeaderBitsLength/estimateAddressBitsLength, several iterations
// across 2026-09-11 trying to model how a job's detail text wraps). Removed the same day, once it
// became clear no amount of retuning the constants would settle: widening it to stop undercounting
// a text-heavy job (a DEL/UPK job with a long address, whose real ~4 lines it once read as 2, and
// spilled into the very next lane) then started overcounting short simple ones enough to shrink the
// whole page more than that day's actual workload needed, erasing the fix's benefit. The truck
// grid's real scale/lane sizes now come from measureAndPrintBoard below, which reads every job's
// TRUE rendered height straight from the browser instead of guessing it from its text — see that
// function's comment for the full story. A character-count estimate (countPrintSideContent/
// sidePanelPrintScale, an independent --pt-side-scale) used to size the Unassigned Jobs side column
// the same arithmetic way, back when it printed in its own column beside the grid and so was never
// part of this measurement pass. Removed 2026-09-15 when Unassigned Jobs moved to a full-width
// section below the grid instead (see DayPrintTimeline.jsx's own restructure comment) — now that it
// adds HEIGHT like everything else on the page, it gets measured for real right alongside the truck
// rows below instead of estimated separately, and shares this one --pt-scale instead of having its
// own.

function printSheet(id, orientation = 'portrait', contentHeightPx) {
  document.querySelectorAll('.print-sheet').forEach((el) => el.classList.remove('print-active'));
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('print-active');
    // Only "Print Board" passes contentHeightPx — "Print List" (the plain manifest) doesn't use
    // --pt-scale at all, so setting it to 1 there is harmless, just unused.
    el.style.setProperty('--pt-scale', String(contentHeightPx != null ? truckPrintScale(contentHeightPx) : 1));
  }
  setPrintOrientation(orientation);
  window.print();
}

// "Print Board"'s REAL page-fit pass — added 2026-09-11 after a character-count line-wrap estimate
// kept needing recalibration in opposite directions (too narrow for a text-heavy job, which spilled
// into the next lane; widened to fix that, then over-crediting short simple jobs and shrinking the
// page more than a light day actually needed). Rather than keep tuning constants for shapes of job
// text this file can't fully enumerate, this reads each job's TRUE rendered height directly from the
// browser instead of guessing it: the print sheet is briefly given a real (off-screen, invisible —
// see .print-sheet.print-measuring in styles.css) layout at --pt-scale 1, every job line's
// `scrollHeight` is read (that DOM property reports an element's full content height regardless of
// its own explicit CSS height or overflow:hidden clipping it visually), and the actual page-fit
// scale/every lane's real top+height are computed from those true numbers before the final, visible
// print happens.
//
// Reworked 2026-09-15 alongside DayPrintTimeline.jsx's move to a one-line-per-job layout: every job
// line is now `white-space:nowrap` (styles.css's .pt-jobline/.pt-job-bar), so unlike the old wrapped
// block this no longer needs measuring to catch a job that wraps to more lines than expected — every
// job is always exactly one line, full stop. What this pass still catches is ordinary rendering
// variance (font metrics, an unusually tall badge) between BASE_ROW_HEIGHT_PX's placeholder guess and
// the real thing, so it's kept rather than removed — cheap insurance for something that used to be a
// real, recurring bug.
//
// Still measured at a FIXED scale of 1 (not whatever the final scale turns out to be), for the same
// reason as before: the real final scale (computed from that worst case, and always <= 1) never needs
// MORE room than what was measured at the largest size, so the actual print can never clip or
// overflow — it can only ever end up very slightly taller than the strict minimum on a day that
// shrinks a lot.
//
// Also measures the Unassigned Jobs section's real height now (added 2026-09-15 when that section
// moved from a side column beside the grid to a full-width block below it, at the user's request —
// see DayPrintTimeline.jsx's own restructure comment for the full story). A side column only ever
// added WIDTH, so it never needed to be part of this pass; a bottom section adds HEIGHT just like
// every truck row does, so it has to be folded into the same `total` the truck rows build up, or a
// busy day's worth of unassigned jobs could silently push the page onto a 2nd sheet the way this
// whole measurement pass exists to prevent. .pt-unassigned-section's own scrollHeight (read at the
// same forced --pt-scale:1 layout as the truck rows above) is simplest here — unlike a truck's
// lanes, these rows just stack top to bottom in normal flow (see styles.css's .pt-jobline.static),
// so there's no need to walk individual rows or compute per-row offsets the way byLane does above.
// `id` (added 2026-09-15 for "Print All Trucks") lets this same real-measurement pass serve TWO
// fully independent print-sheet DOM nodes — 'day-print-timeline' (the default, "Print Board":
// active trucks only) and 'day-print-timeline-all' ("Print All Trucks": every truck, no Unassigned
// Jobs section — see App.jsx/DayPrintTimeline.jsx). Two separate, always-in-the-DOM elements rather
// than one shared element toggled by a state flag — an EARLIER version of this feature tried a
// single 'day-print-timeline' whose truck list was driven by a React state flag
// (includeAllTrucksPrint) flipped by the button and reset on 'afterprint'; that broke exactly the
// way the user reported ("print board and print all trucks are working only when refreshed
// seperately, or else they are printing the same thing") once window.print() turned out to block
// synchronously in the browsers actually being used — the 'afterprint' listener got registered
// AFTER window.print() already returned, so it could miss an event that had already fired during
// the block, leaving the flag stuck and every later print (of either button) reusing whichever
// truck list was already rendered. Two separate DOM ids sidesteps the whole class of bug: each
// button's print pulls from its own always-current, independently-rendered element — no shared
// mutable state, no event-ordering race, no dependency on 'afterprint' firing at all for this to
// work correctly twice in a row without a page refresh.
// Also handles the "Print All Trucks" one-page guarantee (added 2026-09-15 at the user's request:
// "remove the main heading and make the font size adjustments to print in only one page, no matter
// how many jobs there are") — `forAllTrucks` below is derived straight from `id` rather than being a
// separate parameter, since the two already have a fixed 1:1 mapping (see the id doc comment above)
// and deriving it here means a caller can never pass a mismatched pair.
function measureAndPrintBoard(id = 'day-print-timeline') {
  document.querySelectorAll('.print-sheet').forEach((el) => el.classList.remove('print-active', 'print-measuring'));
  const el = document.getElementById(id);
  if (!el) return;
  const forAllTrucks = id === 'day-print-timeline-all';
  el.classList.add('print-measuring');
  el.style.setProperty('--pt-scale', '1');
  // Reading a layout property here forces the browser to actually lay the sheet out before the
  // scrollHeight reads below, now that print-measuring has swapped it off display:none — querying
  // for the rows next would force this anyway, but this makes that dependency explicit.
  void el.offsetHeight;

  let total = 0;
  const measuredTracks = [];
  el.querySelectorAll('tr.pt-truck-row').forEach((row) => {
    const track = row.querySelector('.pt-track');
    if (!track) return;
    const byLane = new Map();
    track.querySelectorAll('[data-lane]').forEach((node) => {
      const lane = Number(node.getAttribute('data-lane'));
      const h = node.scrollHeight;
      byLane.set(lane, Math.max(byLane.get(lane) || 0, h));
    });
    const laneCount = byLane.size ? Math.max(...byLane.keys()) + 1 : 1;
    const laneHeightsPx = [];
    for (let i = 0; i < laneCount; i++) laneHeightsPx.push(Math.max(BASE_ROW_HEIGHT_PX, byLane.get(i) || 0));
    const laneOffsetsPx = [];
    laneHeightsPx.reduce((cum, h) => { laneOffsetsPx.push(cum); return cum + h; }, 0);
    const trackHeightPx = laneHeightsPx.reduce((sum, h) => sum + h, 0);
    total += trackHeightPx;
    measuredTracks.push({ track, laneHeightsPx, laneOffsetsPx, trackHeightPx });
  });

  const unassignedSection = el.querySelector('.pt-unassigned-section');
  if (unassignedSection) total += unassignedSection.scrollHeight;

  const finalScale = truckPrintScale(total || null, forAllTrucks);
  measuredTracks.forEach(({ track, laneHeightsPx, laneOffsetsPx, trackHeightPx }) => {
    track.style.height = `calc(${trackHeightPx}px * var(--pt-scale, 1))`;
    track.querySelectorAll('[data-lane]').forEach((node) => {
      const lane = Number(node.getAttribute('data-lane'));
      node.style.top = `calc(${laneOffsetsPx[lane] + 2}px * var(--pt-scale, 1))`;
      node.style.height = `calc(${laneHeightsPx[lane] - 4}px * var(--pt-scale, 1))`;
    });
  });

  el.classList.remove('print-measuring');
  el.classList.add('print-active');
  el.style.setProperty('--pt-scale', String(finalScale));
  setPrintOrientation('landscape');
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
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onMoveJobDate, onAddExtraTruck, onSetJobTruckDriver, onSetJobColor, onUpdateJobFields,
  onClearManualEdit,
  onCreateJob, onDeleteJob,
  // Job search itself now lives in the title bar (Header, via App.jsx) so it's reachable from every
  // tab, not just Board — moved 2026-09-10. handleJumpToJob and the highlight-timeout state moved
  // up to App.jsx with it (a search result has to be able to switch tabs to Board, which only
  // App.jsx can do); highlightedJobId/onJumpToJob arrive here as plain props now instead of being
  // owned locally, but still flow to DayBoard/OverlappedAlertsTab exactly as before.
  highlightedJobId, onJumpToJob,
  // "Print Board"'s in-transit checkbox state — moved up to App.jsx 2026-09-11 alongside
  // DayPrintSheet/DayPrintTimeline themselves (see App.jsx's .app-shell comment for why); the
  // checkbox and the print button's onClick handler still live here, just reading/writing this via
  // props instead of local state now.
  includeTransitPrint, setIncludeTransitPrint,
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

  // includeTransitPrint/setIncludeTransitPrint ("Print Board" only — separate from hideInTransit
  // above, which controls the interactive on-screen board) arrive as props from App.jsx now — see
  // this component's own prop-list comment for why.

  // "Print All Trucks" (added 2026-09-15) prints its OWN always-in-the-DOM DayPrintTimeline instance
  // (id="day-print-timeline-all", rendered by App.jsx with includeAllTrucks hardcoded true — see its
  // own comment) rather than toggling a shared state flag on the regular "Print Board" sheet. An
  // earlier version tried the shared-flag approach and broke under real use — see
  // measureAndPrintBoard's own comment above for the full race-condition story. No hook needed here
  // at all now: this button's onClick below calls measureAndPrintBoard('day-print-timeline-all')
  // directly and synchronously, exactly like every other print button in this file, since that
  // element's content never depends on anything this component's state has to wait a render for.

  const [monthFilter, setMonthFilter] = useState('all');
  const monthFilteredJobs = useMemo(() => {
    if (monthFilter === 'local') return jobs.filter((j) => j.type !== 'long_distance');
    if (monthFilter === 'long_distance') return jobs.filter((j) => j.type === 'long_distance');
    if (monthFilter === 'conflicts') return jobs.filter((j) => conflictIds.has(j.id));
    return jobs;
  }, [jobs, monthFilter, conflictIds]);

  // Overlapped Alerts used to just dump every conflict in the whole dataset (utils/jobs.js's
  // getConflicts runs over ALL jobs, not just what's currently on screen — see App.jsx), which
  // meant a dispatcher looking at one day's board saw conflicts from months away too. Re-scoped
  // 2026-09-08 at the user's request so the tab instead shows only what's relevant to whichever
  // view it was opened from: the day's conflicts from day view, the month's conflicts from month
  // view. "Overlapped Alerts" is itself a third boardMode value (see the toggle buttons below), so
  // by the time it's active boardMode no longer says whether the dispatcher came from day or month
  // — this ref remembers the last real (non-"conflicts") view so that choice survives the switch.
  // Mutating a ref mid-render like this is safe here because it only ever reads its OWN prior value
  // (never stale props/state) and every reader below sees the update in the very same render pass.
  const lastViewModeRef = useRef(boardMode === 'month' ? 'month' : 'day');
  if (boardMode === 'day' || boardMode === 'month') lastViewModeRef.current = boardMode;

  const conflictsInView = useMemo(() => {
    if (lastViewModeRef.current === 'month') {
      const year = monthCursor.getFullYear();
      const month = monthCursor.getMonth();
      return conflicts.filter((c) => jobActiveInMonth(c.a, year, month) || jobActiveInMonth(c.b, year, month));
    }
    return conflicts.filter((c) => jobActiveOn(c.a, boardDate) || jobActiveOn(c.b, boardDate));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lastViewModeRef.current is read, not a dep, but boardMode covers every render where it can change
  }, [conflicts, boardDate, monthCursor, boardMode]);

  const conflictsScopeLabel = lastViewModeRef.current === 'month'
    ? `this month (${monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`
    : `on ${new Date(`${boardDate}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;

  return (
    <section>
      <div className="toolbar">
        <h2 className="section-title">{title}</h2>
        <div className="board-controls">
          <div className="view-toggle">
            <button className={`btn secondary ${boardMode === 'day' ? 'active' : ''}`} onClick={() => setBoardMode('day')}>Day</button>
            <button className={`btn secondary ${boardMode === 'month' ? 'active' : ''}`} onClick={() => setBoardMode('month')}>Month</button>
            {/* Moved out of an always-visible banner above the board (see OverlappedAlertsTab.jsx's
                doc comment) into its own tab, at the user's request — a real sync run regularly
                produces dozens of these and the banner was crowding out the board itself. The count
                badge means a dispatcher still sees at a glance whether there's anything to look at,
                without switching tabs first. */}
            <button
              className={`btn secondary oa-toggle-btn ${boardMode === 'conflicts' ? 'active' : ''}`}
              onClick={() => setBoardMode('conflicts')}
              title={`Scheduling conflicts ${conflictsScopeLabel}`}
            >
              Overlapped Alerts
              {conflictsInView.length > 0 && <span className="oa-count-badge">{conflictsInView.length}</span>}
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
              <label
                className="btn secondary"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                title="Print a long-distance job that's only in transit today (not picking up or delivering) too, as a plain gray bar showing which truck it's tied up on — instead of leaving it off the printout entirely."
              >
                <input type="checkbox" checked={includeTransitPrint} onChange={(e) => setIncludeTransitPrint(e.target.checked)} />
                Include in-transit
              </label>
              <button
                className="btn secondary"
                onClick={() => {
                  // A long-distance job "in transit" on this specific date (not starting or ending
                  // today) is left off this printout unless "Include in-transit" (above) is checked
                  // — confirm first so a dispatcher printing for a crew isn't surprised later that
                  // one of those jobs isn't on the page.
                  const skipped = transitOnlyJobCount(jobs, boardDate);
                  if (skipped > 0 && !includeTransitPrint) {
                    const ok = window.confirm(
                      `${skipped} long-distance job${skipped === 1 ? ' is' : 's are'} in transit today (not starting or ending) and won't appear on this printed board. ` +
                      `Print the rest anyway? (Check "Include in-transit" above to print it instead.)`
                    );
                    if (!ok) return;
                  }
                  // Unassigned Jobs now prints as a full-width section below the grid and shares its
                  // real-height measurement with the truck rows — see measureAndPrintBoard's own
                  // comment and DayPrintTimeline.jsx's restructure comment for the full story.
                  measureAndPrintBoard();
                }}
                title="Print the truck board as it looks on screen — colors, bars, trucks on the left, 6am-6pm — with Unassigned Jobs listed in a section below the calendar. Only trucks working that day get a row, and two jobs overlapping on the same truck each print in full on their own stacked line. Everything is fit onto one page, shrinking text only as much as that day's actual workload requires. Long-distance jobs print on their start and end day; days in between (in transit) are left off unless 'Include in-transit' is checked, and you'll be asked to confirm first if any would be skipped today."
              >
                🖨 Print Board
              </button>
              {/* "Print All Trucks" — added 2026-09-15 at the user's request ("a new button beside
                  print full day, which will print all the truck board, like that will includes the
                  trucks that are not been assigned with jobs"), then reworked the same day once the
                  first version (a shared state flag toggling the SAME print-sheet "Print Board"
                  uses) turned out to break under real use — see measureAndPrintBoard's own comment
                  for the full story, and the user's own report: "print board and print all trucks
                  are working only when refreshed seperately, or else they are printing the same
                  thing" / "i want them to be two different seperate mechanisms even when we don't
                  do the refresh". Now genuinely independent: this targets its OWN always-rendered
                  DayPrintTimeline instance (id="day-print-timeline-all", App.jsx) that always shows
                  every truck and never the Unassigned Jobs section, so this button and "Print Board"
                  never share any state, DOM node, or timing dependency — each one measures and
                  prints its own sheet directly, synchronously, right here, exactly like every other
                  print button in this file. */}
              <button
                className="btn secondary"
                onClick={() => {
                  const skipped = transitOnlyJobCount(jobs, boardDate);
                  if (skipped > 0 && !includeTransitPrint) {
                    const ok = window.confirm(
                      `${skipped} long-distance job${skipped === 1 ? ' is' : 's are'} in transit today (not starting or ending) and won't appear on this printed board. ` +
                      `Print the rest anyway? (Check "Include in-transit" above to print it instead.)`
                    );
                    if (!ok) return;
                  }
                  measureAndPrintBoard('day-print-timeline-all');
                }}
                title="Print the truck board with EVERY truck in the fleet, including ones with nothing assigned today (just an empty row) — everything else is identical to Print Board except no Unassigned Jobs section: colors, bars, one page, shrinking text only as much as the (now larger) fleet needs."
              >
                🖨 Print All Trucks
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
          <DuplicateAlertBanner duplicates={placeholderDuplicates || []} trucks={trucks} />
          {/* Day view (2026-09-08, at the user's request): job blocks no longer color-code by
              driver (see JobVisuals.jsx's JobBlock — border-left is now a conflict indicator, and
              the driver's name already prints directly on the block), so this legend's color key
              has nothing left to explain there. Month view keeps it — MonthChip (JobVisuals.jsx)
              still uses driver color as its only way to show who's driving (no room to print the
              name), so the key is still needed to read it. */}
          {boardMode !== 'day' && <DriverLegend trucks={trucks} drivers={drivers} jobs={jobs} date={boardDate} />}
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
            onSetJobColor={onSetJobColor}
            onUpdateJobFields={onUpdateJobFields}
            onClearManualEdit={onClearManualEdit}
            onCreateJob={onCreateJob}
            onDeleteJob={onDeleteJob}
            highlightedJobId={highlightedJobId}
            timelineRef={timelineRef}
          />
          {/* DayPrintSheet/DayPrintTimeline used to render here — moved up to App.jsx 2026-09-11 as
              true top-level siblings of the rest of the app, fixing a persistent blank-2nd-page
              print bug (see App.jsx's .app-shell comment for the full reasoning). printSheet()
              above still targets them purely by DOM id, so nothing about how "Print List"/"Print
              Board" actually work here needed to change. */}
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
        <OverlappedAlertsTab
          conflicts={conflictsInView}
          scopeLabel={conflictsScopeLabel}
          trucks={trucks}
          drivers={drivers}
          onJumpToJob={onJumpToJob}
        />
      )}
    </section>
  );
}
