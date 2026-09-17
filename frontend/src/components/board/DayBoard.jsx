import { useEffect, useRef, useState } from 'react';
import { jobActiveOn, hourToLabel, todayStr, timeToHour, daysBetween } from '../../utils/dates';
import { jobTruckIds, statusClass, statusLabel, groupByOpportunity, deriveTruckStatus, overlappingClusterFor, isTransitOnlyDay } from '../../utils/jobs';
import { JobChip, GroupedJobChip, JobBlock } from './JobVisuals';
import JobEditModal from './JobEditModal';
import JobConflictChooser from './JobConflictChooser';
import JobCreateModal from './JobCreateModal';

// Full 24-hour day, scrollable — a move (local or long-distance) can still legitimately be dropped
// or edited to start at any hour, not just a business-hours window. Reverted 2026-08-27 back to
// the full range after a first attempt narrowed this to 6am-6pm outright and cut off anything
// scheduled earlier/later — the actual request was for 6am-6pm to be what's VISIBLE by default,
// with the rest of the day still a scroll away, not for the range itself to shrink (that's still
// true for DayPrintTimeline.jsx's printed board specifically, which stays 6am-6pm only — a paper
// handout has no scroll interaction, so there's nothing to reach by scrolling there). Kept as named
// constants (not hardcoded 0/24 throughout) since a lot of the positioning math below reads more
// clearly with a name.
const TIMELINE_START = 0; // 12am
const TIMELINE_END = 24; // 12am next day

// Opens the board scrolled so 6am-6pm fills the visible viewport by default (see .timeline-inner's
// own comment in styles.css for the matching 24/12 stretch ratio that makes exactly that span fit)
// — the rest of the day (overnight hours before 6am, evening after 6pm) is a scroll away rather
// than shown up front, since nothing is ever actually scheduled at 2am in practice.
const DEFAULT_VISIBLE_START_HOUR = 6; // 6am

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

export default function DayBoard({
  date, trucks, drivers, jobs, role, conflictIds, conflicts,
  hideInTransit,
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onAddExtraTruck, onSetJobTruckDriver, onSetJobColor, onUpdateJobFields, onCreateJob,
  onClearManualEdit,
  onDeleteJob,
  highlightedJobId,
  timelineRef: timelineRefProp,
}) {
  const [trayDragOver, setTrayDragOver] = useState(false);
  const [dragOverTruck, setDragOverTruck] = useState(null);
  const [editingJobId, setEditingJobId] = useState(null);
  // Set instead of going straight to editingJobId when a clicked job block overlaps another job on
  // the SAME truck (see openJobOrChooser below and JobConflictChooser.jsx's doc comment) — holds
  // {jobs, truckId, truckName} for the chooser dialog. Stays set while a job picked from it is being
  // edited (editingJobId governs which overlay actually renders — see the chooser's render guard
  // below) so JobEditModal's "back" link can restore the same chooser instead of losing the cluster.
  const [chooserState, setChooserState] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Owned by BoardTab (see its comment) so it can also be handed to useDragAutoScroll for
  // horizontal auto-scroll during drag — but falls back to a local ref so DayBoard still works
  // standalone (e.g. if ever rendered without a parent that provides one) for its own
  // scroll-to-DEFAULT_VISIBLE_START_HOUR effect below.
  const localTimelineRef = useRef(null);
  const timelineRef = timelineRefProp || localTimelineRef;

  // Pins the "Unassigned" tray to the top of the page while scrolling down through a long truck
  // list, instead of scrolling out of view like the truck rows below it. The sticky `top` offset
  // can't be a fixed CSS number — it depends on the real rendered height of the sticky header+nav
  // bars above this component (which this app doesn't hardcode anywhere either) — so it's measured
  // via ref and re-measured on resize, rather than guessed.
  //
  // The hour-label row (.timeline-header) is pinned differently, not with its own measured `top`:
  // an earlier version tried that and it silently failed — CSS forces overflow-y to `auto` on any
  // element whose overflow-x is non-visible (.timeline has overflow-x:auto for its independent
  // horizontal scroll; see its own comment), which secretly makes .timeline itself the "nearest
  // scrolling ancestor" for anything sticky inside it, instead of the page. .timeline-header's
  // sticky top ended up resolving relative to .timeline's own (never-actually-scrolling, since it
  // just auto-grows to fit content) box, so it rendered frozen partway down the truck list instead
  // of following the page scroll — confirmed live, it landed around the 3rd truck row.
  // Fix: give .timeline a real bounded height (`timelineMaxHeight` below, viewport height minus
  // header+nav+tray) so it becomes an ACTUAL scroll container with its own scrollbar, and let
  // .timeline-header stick to `top: 0` within THAT (see its CSS) — simple and needs no further
  // measurement, since 0 relative to .timeline's own scrollport is always correct.
  const trayRef = useRef(null);
  const [pinOffsets, setPinOffsets] = useState({ trayTop: 58, timelineMaxHeight: 'none' });
  useEffect(() => {
    // MAIN_BOTTOM_PADDING_PX mirrors styles.css's main{padding:16px} — the one bit of space below
    // .timeline itself that the tray's own rect can't see (it's outside the tray/timeline entirely,
    // on <main>'s own box).
    const MAIN_BOTTOM_PADDING_PX = 16;
    function measure() {
      const nav = document.querySelector('nav');
      const navBottom = nav ? nav.getBoundingClientRect().bottom : 58;
      // timelineMaxHeight now reads the tray's own real bottom edge (getBoundingClientRect().bottom)
      // instead of re-deriving "everything above .timeline" as navBottom + the tray's own height.
      // That older version silently ignored the WHOLE toolbar/banner stack actually sitting between
      // nav and the tray — BoardTab.jsx's own toolbar (title + Date/Month/Print buttons),
      // DuplicateAlertBanner, the "Hide in-transit" note — so .timeline rendered taller than the
      // space truly left in the viewport, pushing the entire PAGE past 100vh and forcing an outer/
      // body scrollbar that dragged the toolbar (date picker, Print Board/Print All Trucks buttons)
      // out of view right along with it on scroll. Reading the tray's actual rendered position
      // instead sidesteps needing to track each of those pieces by hand — whatever is currently
      // showing above the tray, its real height is already baked into where the tray itself landed.
      // Fixed 2026-09-17 at the user's request ("get rid of the main scroller... only board will be
      // scrolled").
      const trayRect = trayRef.current ? trayRef.current.getBoundingClientRect() : null;
      const trayBottom = trayRect ? trayRect.bottom : navBottom;
      setPinOffsets({ trayTop: navBottom, timelineMaxHeight: `calc(100vh - ${trayBottom + MAIN_BOTTOM_PADDING_PX}px)` });
    }
    measure();
    window.addEventListener('resize', measure);
    // Re-measures automatically whenever the tray's rendered size changes for ANY reason (chips
    // appearing/disappearing as jobs get assigned/unassigned, "All jobs assigned" text swapping in,
    // theme/font changes) — covers what a dependency array on unassignedAll.length alone wouldn't
    // (e.g. a chip's own content reflowing without the count changing). Also watches <main> as a
    // whole (added alongside the fix above) so a banner appearing/disappearing ABOVE the tray
    // (BackendBanner, GmailAuthBanner, the 3s role hint, DuplicateAlertBanner) — which doesn't touch
    // the tray's OWN size, only its position — still triggers a remeasure instead of leaving
    // timelineMaxHeight stale until the next resize.
    const ro = new ResizeObserver(measure);
    if (trayRef.current) ro.observe(trayRef.current);
    const main = document.querySelector('main');
    if (main) ro.observe(main);
    return () => { window.removeEventListener('resize', measure); ro.disconnect(); };
  }, []);

  /** Confirm-then-delete, shared by every entry point (tray chip, board block, edit modal) so
      there's exactly one confirmation prompt and one error-handling path instead of three. Only
      ever wired up for placeholder jobs — see JobVisuals.jsx/JobEditModal.jsx for where that's
      gated. */
  async function handleDeleteJob(jobId, customerName) {
    if (!onDeleteJob) return;
    if (!window.confirm(`Delete "${customerName}"? This can't be undone.`)) return;
    try {
      await onDeleteJob(jobId);
      if (editingJobId === jobId) { setEditingJobId(null); setChooserState(null); }
    } catch (err) {
      window.alert(`Couldn't delete job: ${err.message}`);
    }
  }
  const draggable = role !== 'crew';
  // Still gates drag/resize/delete/trucks-drivers and the JobEditModal's full form — the ONE
  // exception is the modal's colorOnly mode (wired below via colorOnly={!canEdit}), which crew CAN
  // reach (added 2026-09-15 at the user's request, "All users to change these colors when clicking
  // on the job"): job blocks/chips' onEditJob is deliberately no longer canEdit-gated (see below) so
  // crew's click still opens something, just the stripped-down color-only view instead of the full
  // editor everyone else gets.
  const canEdit = role !== 'crew';
  const editingJob = editingJobId ? jobs.find((j) => j.id === editingJobId) : null;

  /** Click handler wired up as JobBlock's onEditJob (see its doc comment) — decides whether a click
   * on a job block goes straight to JobEditModal or, when that job overlaps another job on THIS
   * truck, opens JobConflictChooser instead so both jobs stay reachable regardless of which one is
   * drawn on top (see stackZIndex in utils/jobs.js). truckIdCtx is undefined for the unassigned
   * tray's chips (JobChip/GroupedJobChip use their own simpler onEditJob wiring below, calling this
   * indirectly is unnecessary since an unassigned job can't conflict with anything), so those always
   * fall through to the plain single-job path. */
  function openJobOrChooser(jobId, truckIdCtx) {
    const job = jobs.find((j) => j.id === jobId);
    if (!job || !truckIdCtx || !conflictIds.has(jobId)) {
      setEditingJobId(jobId);
      setChooserState(null);
      return;
    }
    const cluster = overlappingClusterFor(conflicts, truckIdCtx, job);
    if (cluster.length <= 1) {
      // Flagged as conflicting overall, but not against anything on THIS specific truck (can happen
      // for a multi-truck job) — nothing to choose between, so open it directly.
      setEditingJobId(jobId);
      setChooserState(null);
      return;
    }
    const truck = trucks.find((t) => t.id === truckIdCtx);
    setChooserState({ jobs: cluster, truckId: truckIdCtx, truckName: truck ? truck.name : truckIdCtx });
  }

  function closeEditModal() {
    setEditingJobId(null);
    setChooserState(null);
  }

  // Scroll a job found via search into view once the board lands on its date — the timeline can
  // be tall enough (many trucks) or wide enough (24-hour view) that the highlighted job isn't
  // necessarily on screen just because the right day is showing.
  useEffect(() => {
    if (!highlightedJobId) return;
    const el = document.querySelector(`.job-block.highlighted, .chip.highlighted`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [highlightedJobId, date]);

  // Ref mirror of highlightedJobId, read by the default-scroll effect right below. Deliberately a
  // ref and not a plain dependency on highlightedJobId itself — see that effect's comment for why.
  const highlightedJobIdRef = useRef(highlightedJobId);
  highlightedJobIdRef.current = highlightedJobId;

  // Opens the board scrolled to DEFAULT_VISIBLE_START_HOUR instead of midnight — see that
  // constant's comment. Re-runs on every date change so switching days always resets back to the
  // same default view rather than carrying over wherever the previous day happened to be scrolled.
  // The truck column is `position: sticky; left: 0`, so it stays pinned in place during the scroll
  // below rather than sliding out of view with the hours; the scroll target is calculated for the
  // hours area alone, past that pinned column. Its width is MEASURED from the actual rendered
  // .truck-col-spacer element rather than assumed as a fixed number — styles.css narrows that
  // column at mobile widths (160px desktop, 108px under the 720px breakpoint — see its own
  // comment), and a hardcoded constant here would silently go stale the moment the CSS width
  // changes at any breakpoint, throwing this calculation off exactly on the screens it matters most
  // for. 160 is only the fallback for the (should-never-happen) case the element isn't found yet.
  //
  // Scrolls `.timeline` specifically, NOT the outer `.board-wrap` — an earlier version scrolled
  // board-wrap, which also contains the "Unassigned" tray above the timeline; since the tray isn't
  // hour-based at all, dragging it sideways along with the timeline just hid job chips off-screen
  // for no reason. `.timeline` now owns its own horizontal scroll (see styles.css) so this can move
  // the truck-row hours around without disturbing anything above it.
  //
  // Bug fixed 2026-09-10 (reported: a job found via search "sometimes" wasn't actually visible —
  // only showed up if you searched again): this effect and the highlight-scroll effect above both
  // fire on the same commit whenever a search jump lands on a new date (handleJumpToJob sets
  // boardDate and highlightedJobId together). Both are plain useEffects declared in this order, so
  // React always runs the highlight scrollIntoView FIRST, then this one immediately after — and
  // this one used to unconditionally snap `.timeline`'s scroll back to the default 6am window,
  // undoing the scrollIntoView a moment earlier if the found job's time fell outside that window.
  // Searching a SECOND time for a job already on the currently-displayed date never re-triggered
  // this effect (its old deps were just `[date]`, and date hadn't changed), so only the highlight
  // effect ran and the job correctly appeared — hence "works the second time." Fix: skip the
  // default-hour reset whenever a search highlight is actively landing on this date and let that
  // effect own the scroll position instead; genuine date navigation (arrows, date picker, Today),
  // where highlightedJobId is null, resets to the default hour exactly as before.
  useEffect(() => {
    if (highlightedJobIdRef.current) return;
    const el = timelineRef.current;
    if (!el) return;
    const truckColEl = el.querySelector('.truck-col-spacer');
    const TRUCK_COL_WIDTH = truckColEl ? truckColEl.getBoundingClientRect().width : 160;
    const hoursAreaWidth = el.scrollWidth - TRUCK_COL_WIDTH;
    if (hoursAreaWidth <= 0) return;
    const targetScrollLeft = hoursAreaWidth * (DEFAULT_VISIBLE_START_HOUR - TIMELINE_START) / (TIMELINE_END - TIMELINE_START);
    el.scrollLeft = Math.max(0, targetScrollLeft);
  }, [date]);

  // Unassigned jobs only show in the tray on their OWN start date — a long-distance job starting
  // 7/31 shouldn't appear as "unassigned" on 8/1, 8/2, etc. just because it's still in transit;
  // it only needs picking up once, on the day it starts. (Once it's actually assigned to a truck,
  // that truck's row still shows it spanning every day of the trip via jobActiveOn — unchanged.)
  const unassignedAll = jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date);
  const { groups: unassignedGroups, singles: unassignedSingles } = groupByOpportunity(unassignedAll);

  const onChipDragStart = (e, jobId) => e.dataTransfer.setData('text/plain', jobId);

  const now = new Date();
  // Shared with BoardTab's "Today" button (see todayStr() in utils/dates.js) so the two can't
  // drift apart — clicking Today always lands on exactly the date this now-line is drawn on.
  const showNowLine = date === todayStr();
  const hourNow = now.getHours() + now.getMinutes() / 60;
  const nowPct = (hourNow - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
  const nowLineVisible = showNowLine && hourNow >= TIMELINE_START && hourNow <= TIMELINE_END;

  function handleTrayDrop(e) {
    e.preventDefault();
    setTrayDragOver(false);
    const jobId = e.dataTransfer.getData('text/plain');
    if (jobId) onUnassignJob(jobId);
  }

  function handleTrackDrop(e, truckId) {
    e.preventDefault();
    setDragOverTruck(null);
    const jobId = e.dataTransfer.getData('text/plain');
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;

    // Every job type now gets a start time from where it's dropped on the 24-hour timeline.
    // Long-distance jobs used to skip this entirely (their bar always spans the full day width
    // regardless of time, so there was no visual reason to capture it) — but a move's actual
    // departure time still matters for planning even though the board shows it as an all-day bar;
    // JobBlock now displays it as "Departs H:MMam/pm" on the LD block. Local jobs stay clamped so
    // their end doesn't run past midnight; long-distance jobs aren't, since their `duration` field
    // isn't a real end-of-day bound the way a local job's is (a move can depart at 11pm just fine).
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    let newHour = TIMELINE_START + frac * (TIMELINE_END - TIMELINE_START);
    newHour = Math.round(newHour * 2) / 2;
    if (job.type !== 'long_distance') {
      const dur = job.duration || 2;
      newHour = Math.min(newHour, TIMELINE_END - dur);
    }
    const hh = String(Math.floor(newHour)).padStart(2, '0');
    const mm = newHour % 1 === 0.5 ? '30' : '00';
    const newStartTime = `${hh}:${mm}`;

    onAddTruckToJob(jobId, truckId, newStartTime);
  }

  return (
    <>
    {/* .board-wrap deliberately opens its own stacking context (see its CSS comment) so job blocks'
        internal z-index (up to ~999) can never escape above the sticky header/nav. That containment
        applies to EVERY descendant, including position:fixed ones — a fixed element only escapes an
        ancestor's stacking context if no ancestor creates one, and .board-wrap does. The three
        modals below used to be rendered as .board-wrap's children and, despite z-index:2000, got
        capped at .board-wrap's own z-level (0) — below header/nav (50/49) — any time they visually
        overlapped that pinned region. Rendering them as .board-wrap's SIBLINGS instead (via this
        fragment) keeps them out of that stacking context entirely, so they compete directly against
        header/nav in the page's root context and 2000 wins, as the overlay's own CSS already
        intended. */}
    <div className="board-wrap">
      <div
        ref={trayRef}
        className={`unassigned-tray ${trayDragOver ? 'dragover' : ''}`}
        style={{ top: pinOffsets.trayTop }}
        onDragOver={draggable ? (e) => { e.preventDefault(); setTrayDragOver(true); } : undefined}
        onDragLeave={draggable ? () => setTrayDragOver(false) : undefined}
        onDrop={draggable ? handleTrayDrop : undefined}
      >
        <span className="tray-label">Unassigned</span>
        {canEdit && onCreateJob && (
          <button
            type="button"
            className="btn secondary tray-add-btn"
            onClick={(e) => { e.stopPropagation(); setShowCreateModal(true); }}
            title="Add a placeholder job for this day"
          >
            + Add job
          </button>
        )}
        {unassignedAll.length ? (
          <>
            {/* onEditJob is unconditional here (not gated on canEdit) as of 2026-09-15 — even the
                crew role, which can't drag/resize/delete a job, can still click it open to set its
                color (see JobEditModal's colorOnly mode below, wired via colorOnly={!canEdit}); the
                delete affordance right next to it stays canEdit-gated since crew still can't delete
                anything. */}
            {unassignedSingles.map((j) => (
              <JobChip key={j.id} job={j} trucks={trucks} conflict={conflictIds.has(j.id)} draggable={draggable} onDragStart={onChipDragStart} highlighted={j.id === highlightedJobId} onDeleteJob={canEdit ? handleDeleteJob : undefined} onEditJob={(jobId) => setEditingJobId(jobId)} />
            ))}
            {unassignedGroups.map((g) => (
              // Never contains placeholder jobs — grouping only happens for jobs that share a
              // smartMovingOpportunityId, which manually-created placeholders don't have — so no
              // delete affordance needed here.
              <GroupedJobChip key={g[0].smartMovingOpportunityId} jobsInGroup={g} trucks={trucks} conflictIds={conflictIds} draggable={draggable} onDragStart={onChipDragStart} highlightedJobId={highlightedJobId} onEditJob={(jobId) => setEditingJobId(jobId)} />
            ))}
          </>
        ) : (
          <span className="empty" style={{ padding: 0 }}>All jobs assigned</span>
        )}
      </div>

      <div className="timeline" ref={timelineRef} style={{ maxHeight: pinOffsets.timelineMaxHeight }}>
        <div className="timeline-inner">
          <div className="timeline-header">
            <div className="truck-col-spacer" />
            <div className="hours">
              {hourLabelList().map((h) => <div className="hour" key={h}>{hourToLabel(h)}</div>)}
            </div>
          </div>

          {trucks.map((t) => {
            // hideInTransit (BoardTab.jsx's "Hide in-transit" toggle, added 2026-09-01) additionally
            // drops a long-distance job from a truck's row on a day it's strictly in transit — see
            // isTransitOnlyDay's doc comment (utils/jobs.js). Off by default so a truck's row still
            // spans a move's full trip via jobActiveOn, same as always; when it's on, this also pulls
            // the job out of `hasConflict` below for that day, since a job that isn't shown here
            // shouldn't flag this row as conflicted either — global conflict counts elsewhere
            // (Overlapped Alerts, the month view's Conflicts filter) are untouched, same as how
            // DayPrintTimeline.jsx's own transit-day exclusion only narrows what THAT view shows.
            const tjobs = jobs.filter((j) => jobTruckIds(j).includes(t.id) && jobActiveOn(j, date)
              && !(hideInTransit && isTransitOnlyDay(j, date)));
            const hasConflict = tjobs.some((j) => conflictIds.has(j.id));
            // "On Job"/"Available" is derived fresh for this specific date from whether the truck
            // actually has an active job today — not read from the truck's stored status field,
            // which used to get stuck on "On Job" forever once a job was assigned (see
            // deriveTruckStatus's doc comment in utils/jobs.js). "Maintenance" is still a manual,
            // stored override and always wins.
            const derivedStatus = deriveTruckStatus(t, jobs, date);

            // Lane assignment (added 2026-09-15 at the user's request — "instead of placing
            // conflicted jobs on top of each other... make the jobs look like in print board, one
            // below another") — mirrors DayPrintTimeline.jsx's own greedy interval-lane packing
            // (see that file's identical comment for the algorithm) so two jobs that overlap in
            // time on this truck get separate stacked rows instead of the old z-index-stacked
            // overlap (stackZIndex, utils/jobs.js — still used below as a tiebreaker, now mostly
            // moot since lanes keep genuinely overlapping jobs physically apart). Computed here
            // (not shared with the print board's copy) since this view's start/end fractions have
            // to match exactly what JobBlock itself draws for left/width — TIMELINE_START/END span
            // the FULL day (0-24) here, not the printed board's clamped 6am-6pm window, and an LD
            // job's bar always runs to the end of the day in this single-day view (see JobBlock's
            // own barStyle) rather than being clamped like the print board's multi-page layout
            // needs. Driven purely by actual time overlap, not the `conflictIds` prop, same
            // reasoning DayPrintTimeline.jsx's own comment gives — so a lane boundary can never
            // disagree with what conflictIds separately flags as "needs a dispatcher's attention".
            const framed = tjobs.map((j) => {
              let startFrac, endFrac;
              if (j.type === 'long_distance') {
                const dayIdx = daysBetween(j.date, date) + 1;
                if (dayIdx !== 1 || !j.startTime) {
                  startFrac = 0; endFrac = 1;
                } else {
                  const start = timeToHour(j.startTime) ?? TIMELINE_START;
                  startFrac = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START);
                  endFrac = 1;
                }
              } else {
                const start = timeToHour(j.startTime) ?? TIMELINE_START;
                const dur = j.duration || 2;
                startFrac = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START);
                endFrac = (start + dur - TIMELINE_START) / (TIMELINE_END - TIMELINE_START);
              }
              return { j, startFrac, endFrac };
            }).sort((a, b) => a.startFrac - b.startFrac);
            const laneEnds = [];
            const laneByJobId = new Map();
            framed.forEach((f) => {
              let lane = laneEnds.findIndex((end) => f.startFrac >= end - 0.0001);
              if (lane === -1) { lane = laneEnds.length; laneEnds.push(f.endFrac); }
              else { laneEnds[lane] = f.endFrac; }
              laneByJobId.set(f.j.id, lane);
            });
            const laneCount = Math.max(1, laneEnds.length);

            return (
              <div className="truck-row" key={t.id}>
                <div className="truck-info">
                  <div className={`tname ${statusClass(derivedStatus)}`}>
                    <span className="status-dot" />{t.name}
                    {/* Symbol only, no "conflict" label text — added 2026-08-28 at the user's
                        request: the ⚠ is enough on its own in the truck sidebar (the job block
                        itself, and this truck's row, already make it obvious what's wrong; a
                        hover title covers anyone who wants the word spelled out). */}
                    {hasConflict && <span className="conflict-flag" title="Conflict — this truck has overlapping jobs today">⚠</span>}
                  </div>
                  {/* Driver name dropped from here 2026-09-15 at the user's request ("remove that
                      feature") — each job on this truck already shows its own assigned driver
                      directly on its block (JobVisuals.jsx's assignedDriver/detailBits), which is
                      more accurate besides (a truck can carry a different driver per job today —
                      see db.js's file header), so this sidebar summary was redundant with that. */}
                  <div className="meta">{t.size}</div>
                  <div className="meta">{statusLabel(derivedStatus)}</div>
                </div>
                <div
                  className={`track ${dragOverTruck === t.id ? 'dragover' : ''} ${laneCount > 1 ? 'multi-lane' : ''}`}
                  // Explicit height only kicks in once there's a real overlap (laneCount > 1) — a
                  // single-lane truck (the normal case) keeps relying on CSS's own min-height:44px
                  // (or 56px on the mobile breakpoint — see --track-lane-height's own comment in
                  // styles.css) exactly as before this feature, so nothing changes for the common
                  // case. --track-lane-height (not a hardcoded 44 here) is what keeps this in sync
                  // with that same mobile bump automatically.
                  style={laneCount > 1 ? { height: `calc(var(--track-lane-height) * ${laneCount})` } : undefined}
                  onDragOver={draggable ? (e) => { e.preventDefault(); setDragOverTruck(t.id); } : undefined}
                  onDragLeave={draggable ? () => setDragOverTruck(null) : undefined}
                  onDrop={draggable ? (e) => handleTrackDrop(e, t.id) : undefined}
                >
                  {tjobs.map((j) => (
                    <JobBlock
                      key={j.id}
                      job={j}
                      date={date}
                      truckIdCtx={t.id}
                      trucks={trucks}
                      drivers={drivers}
                      jobs={jobs}
                      conflict={conflictIds.has(j.id)}
                      conflicts={conflicts}
                      role={role}
                      draggable={draggable}
                      onDragStart={onChipDragStart}
                      onRemoveTruck={onRemoveTruck}
                      onAddExtraTruck={onAddExtraTruck}
                      onSetJobTruckDriver={onSetJobTruckDriver}
                      onEditJob={openJobOrChooser}
                      onResizeJob={canEdit ? (jobId, newDuration) => onUpdateJobFields(jobId, { duration: newDuration }) : undefined}
                      onDeleteJob={canEdit ? handleDeleteJob : undefined}
                      TIMELINE_START={TIMELINE_START}
                      TIMELINE_END={TIMELINE_END}
                      highlighted={j.id === highlightedJobId}
                      laneIndex={laneByJobId.get(j.id) ?? 0}
                      laneCount={laneCount}
                    />
                  ))}
                  {nowLineVisible && <div className="now-line" style={{ left: `${nowPct}%` }} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>

    {/* Chooser hides itself once editingJobId is set (picking a job from it, or clicking a
        non-conflicting block elsewhere, both go through setEditingJobId) so the two overlays never
        show at once — chooserState itself stays around so JobEditModal's "back" link can restore
        it. */}
    {chooserState && !editingJobId && (
      <JobConflictChooser
        jobs={chooserState.jobs}
        truckId={chooserState.truckId}
        truckName={chooserState.truckName}
        drivers={drivers}
        date={date}
        onPick={(jobId) => setEditingJobId(jobId)}
        onClose={() => setChooserState(null)}
      />
    )}

    {editingJob && (
      <JobEditModal
        job={editingJob}
        trucks={trucks}
        drivers={drivers}
        jobs={jobs}
        onAddExtraTruck={onAddExtraTruck}
        onRemoveTruck={onRemoveTruck}
        onSetJobTruckDriver={onSetJobTruckDriver}
        onSetJobColor={onSetJobColor}
        onSave={(fields) => { onUpdateJobFields(editingJob.id, fields); closeEditModal(); }}
        onClearManualEdit={onClearManualEdit ? () => onClearManualEdit(editingJob.id) : undefined}
        onClose={closeEditModal}
        onBack={chooserState ? () => setEditingJobId(null) : undefined}
        onDelete={onDeleteJob ? () => handleDeleteJob(editingJob.id, editingJob.customer) : undefined}
        colorOnly={!canEdit}
      />
    )}

    {showCreateModal && (
      <JobCreateModal
        defaultDate={date}
        onCreate={onCreateJob}
        onClose={() => setShowCreateModal(false)}
      />
    )}
    </>
  );
}
