import { useEffect, useRef, useState } from 'react';
import { jobActiveOn, hourToLabel, todayStr } from '../../utils/dates';
import { jobTruckIds, statusClass, statusLabel, groupByOpportunity, deriveTruckStatus, jobTruckDriver, overlappingClusterFor, isTransitOnlyDay } from '../../utils/jobs';
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
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onAddExtraTruck, onSetJobTruckDriver, onUpdateJobFields, onCreateJob,
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
    function measure() {
      const nav = document.querySelector('nav');
      const navBottom = nav ? nav.getBoundingClientRect().bottom : 58;
      const trayHeight = trayRef.current ? trayRef.current.getBoundingClientRect().height : 0;
      setPinOffsets({ trayTop: navBottom, timelineMaxHeight: `calc(100vh - ${navBottom + trayHeight}px)` });
    }
    measure();
    window.addEventListener('resize', measure);
    // Re-measures automatically whenever the tray's rendered size changes for ANY reason (chips
    // appearing/disappearing as jobs get assigned/unassigned, "All jobs assigned" text swapping in,
    // theme/font changes) — covers what a dependency array on unassignedAll.length alone wouldn't
    // (e.g. a chip's own content reflowing without the count changing).
    const ro = new ResizeObserver(measure);
    if (trayRef.current) ro.observe(trayRef.current);
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
  useEffect(() => {
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
            {unassignedSingles.map((j) => (
              <JobChip key={j.id} job={j} trucks={trucks} conflict={conflictIds.has(j.id)} draggable={draggable} onDragStart={onChipDragStart} highlighted={j.id === highlightedJobId} onDeleteJob={canEdit ? handleDeleteJob : undefined} onEditJob={canEdit ? (jobId) => setEditingJobId(jobId) : undefined} />
            ))}
            {unassignedGroups.map((g) => (
              // Never contains placeholder jobs — grouping only happens for jobs that share a
              // smartMovingOpportunityId, which manually-created placeholders don't have — so no
              // delete affordance needed here.
              <GroupedJobChip key={g[0].smartMovingOpportunityId} jobsInGroup={g} trucks={trucks} conflictIds={conflictIds} draggable={draggable} onDragStart={onChipDragStart} highlightedJobId={highlightedJobId} onEditJob={canEdit ? (jobId) => setEditingJobId(jobId) : undefined} />
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
            // Driver is assigned per job now, not permanently to the truck (see db.js's file
            // header) — shows whichever active job's driver is set first; two active jobs on the
            // same truck the same day is itself a conflict the dispatcher needs to resolve.
            const driver = tjobs.map((j) => jobTruckDriver(drivers, j, t.id)).find(Boolean) || null;
            const hasConflict = tjobs.some((j) => conflictIds.has(j.id));
            // "On Job"/"Available" is derived fresh for this specific date from whether the truck
            // actually has an active job today — not read from the truck's stored status field,
            // which used to get stuck on "On Job" forever once a job was assigned (see
            // deriveTruckStatus's doc comment in utils/jobs.js). "Maintenance" is still a manual,
            // stored override and always wins.
            const derivedStatus = deriveTruckStatus(t, jobs, date);
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
                  <div className="meta">{t.size}{driver ? ` · ${driver.name}` : ''}</div>
                  <div className="meta">{statusLabel(derivedStatus)}</div>
                </div>
                <div
                  className={`track ${dragOverTruck === t.id ? 'dragover' : ''}`}
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
                      onEditJob={canEdit ? openJobOrChooser : undefined}
                      onResizeJob={canEdit ? (jobId, newDuration) => onUpdateJobFields(jobId, { duration: newDuration }) : undefined}
                      onDeleteJob={canEdit ? handleDeleteJob : undefined}
                      TIMELINE_START={TIMELINE_START}
                      TIMELINE_END={TIMELINE_END}
                      highlighted={j.id === highlightedJobId}
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
        onSave={(fields) => { onUpdateJobFields(editingJob.id, fields); closeEditModal(); }}
        onClose={closeEditModal}
        onBack={chooserState ? () => setEditingJobId(null) : undefined}
        onDelete={onDeleteJob ? () => handleDeleteJob(editingJob.id, editingJob.customer) : undefined}
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
