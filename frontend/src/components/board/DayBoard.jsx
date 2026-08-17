import { useEffect, useRef, useState } from 'react';
import { jobActiveOn, hourToLabel, todayStr } from '../../utils/dates';
import { jobTruckIds, statusClass, statusLabel, groupByOpportunity, deriveTruckStatus } from '../../utils/jobs';
import { JobChip, GroupedJobChip, JobBlock } from './JobVisuals';
import JobEditModal from './JobEditModal';
import JobCreateModal from './JobCreateModal';

// Full 24-hour day — moves (local or long-distance) can legitimately start at any hour, not just
// a "business hours" window. Kept as named constants (not hardcoded 0/24 throughout) since a lot
// of the positioning math below reads more clearly with a name, and DayPrintTimeline.jsx mirrors
// these by eye (see its own comment) so both stay in sync if this ever changes again.
const TIMELINE_START = 0; // 12am
const TIMELINE_END = 24; // 12am next day

// Nothing is ever scheduled at 2am, so opening the board on hour 0 means scrolling (or squinting
// at tiny columns) past a stretch of dead space before reaching the hours that actually matter.
// This only changes where the board SCROLLS TO by default — TIMELINE_START/END above still span
// the full day, so a job can still be dropped or edited to start at any hour; 12am-4:59am and
// 7:01pm-midnight just aren't what you see without scrolling there yourself.
const DEFAULT_VISIBLE_START_HOUR = 5; // 5am

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

export default function DayBoard({
  date, trucks, drivers, jobs, role, conflictIds,
  onUnassignJob, onAddTruckToJob, onRemoveTruck, onAddExtraTruck, onUpdateJobFields, onCreateJob,
  onDeleteJob,
  highlightedJobId,
  timelineRef: timelineRefProp,
}) {
  const [trayDragOver, setTrayDragOver] = useState(false);
  const [dragOverTruck, setDragOverTruck] = useState(null);
  const [editingJobId, setEditingJobId] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  // Owned by BoardTab (see its comment) so it can also be handed to useDragAutoScroll for
  // horizontal auto-scroll during drag — but falls back to a local ref so DayBoard still works
  // standalone (e.g. if ever rendered without a parent that provides one) for its own
  // scroll-to-DEFAULT_VISIBLE_START_HOUR effect below.
  const localTimelineRef = useRef(null);
  const timelineRef = timelineRefProp || localTimelineRef;

  /** Confirm-then-delete, shared by every entry point (tray chip, board block, edit modal) so
      there's exactly one confirmation prompt and one error-handling path instead of three. Only
      ever wired up for placeholder jobs — see JobVisuals.jsx/JobEditModal.jsx for where that's
      gated. */
  async function handleDeleteJob(jobId, customerName) {
    if (!onDeleteJob) return;
    if (!window.confirm(`Delete "${customerName}"? This can't be undone.`)) return;
    try {
      await onDeleteJob(jobId);
      if (editingJobId === jobId) setEditingJobId(null);
    } catch (err) {
      window.alert(`Couldn't delete job: ${err.message}`);
    }
  }
  const draggable = role !== 'crew';
  const canEdit = role !== 'crew';
  const editingJob = editingJobId ? jobs.find((j) => j.id === editingJobId) : null;

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
  // 160 matches .truck-col-spacer/.truck-info's CSS width — that column is `position: sticky; left:
  // 0`, so it stays pinned in place during the scroll below rather than sliding out of view with
  // the hours; the scroll target is calculated for the hours area alone, past that pinned column.
  //
  // Scrolls `.timeline` specifically, NOT the outer `.board-wrap` — an earlier version scrolled
  // board-wrap, which also contains the "Unassigned" tray above the timeline; since the tray isn't
  // hour-based at all, dragging it sideways along with the timeline just hid job chips off-screen
  // for no reason. `.timeline` now owns its own horizontal scroll (see styles.css) so this can move
  // the truck-row hours around without disturbing anything above it.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const TRUCK_COL_WIDTH = 160;
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
    <div className="board-wrap">
      <div
        className={`unassigned-tray ${trayDragOver ? 'dragover' : ''}`}
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
              <JobChip key={j.id} job={j} trucks={trucks} conflict={conflictIds.has(j.id)} draggable={draggable} onDragStart={onChipDragStart} highlighted={j.id === highlightedJobId} onDeleteJob={canEdit ? handleDeleteJob : undefined} />
            ))}
            {unassignedGroups.map((g) => (
              // Never contains placeholder jobs — grouping only happens for jobs that share a
              // smartMovingOpportunityId, which manually-created placeholders don't have — so no
              // delete affordance needed here.
              <GroupedJobChip key={g[0].smartMovingOpportunityId} jobsInGroup={g} trucks={trucks} conflictIds={conflictIds} draggable={draggable} onDragStart={onChipDragStart} highlightedJobId={highlightedJobId} />
            ))}
          </>
        ) : (
          <span className="empty" style={{ padding: 0 }}>All jobs assigned</span>
        )}
      </div>

      <div className="timeline" ref={timelineRef}>
        <div className="timeline-inner">
          <div className="timeline-header">
            <div className="truck-col-spacer" />
            <div className="hours">
              {hourLabelList().map((h) => <div className="hour" key={h}>{hourToLabel(h)}</div>)}
            </div>
          </div>

          {trucks.map((t) => {
            const driver = t.driverId ? drivers.find((d) => d.id === t.driverId) : null;
            const tjobs = jobs.filter((j) => jobTruckIds(j).includes(t.id) && jobActiveOn(j, date));
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
                    {hasConflict && <span className="conflict-flag">⚠ conflict</span>}
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
                      conflict={conflictIds.has(j.id)}
                      role={role}
                      draggable={draggable}
                      onDragStart={onChipDragStart}
                      onRemoveTruck={onRemoveTruck}
                      onAddExtraTruck={onAddExtraTruck}
                      onEditJob={canEdit ? (jobId) => setEditingJobId(jobId) : undefined}
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

      {editingJob && (
        <JobEditModal
          job={editingJob}
          onSave={(fields) => { onUpdateJobFields(editingJob.id, fields); setEditingJobId(null); }}
          onClose={() => setEditingJobId(null)}
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
    </div>
  );
}
