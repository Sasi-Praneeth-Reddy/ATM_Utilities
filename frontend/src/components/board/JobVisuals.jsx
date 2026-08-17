import { useState } from 'react';
import { fmtRange, hourToLabel, timeToHour, daysBetween } from '../../utils/dates';
import {
  jobTruckIds, jobTrucksNeeded, jobTruckLabel, truckBadgeInfo, getJobDriverColor,
  stackZIndex, ldStageLabels,
} from '../../utils/jobs';

export function SmBadge({ job }) {
  if (job.source !== 'smartmoving') return null;
  return <span className="sm-badge" title="Imported from SmartMoving">SM</span>;
}

/** Flags a manually created "placeholder" job (see JobCreateModal / POST /api/jobs) — a stub
 * created directly on the board with just a name/date/time, not yet backed by a real SmartMoving
 * booking. Same badge-next-to-name pattern as SmBadge, distinguishing "where did this come from"
 * at a glance so it doesn't get mistaken for a confirmed, fully-detailed job. */
export function PlaceholderBadge({ job }) {
  if (job.source !== 'placeholder') return null;
  return <span className="placeholder-badge" title="Manually added placeholder — fill in details when known">PLACEHOLDER</span>;
}

export function TruckBadge({ job }) {
  const info = truckBadgeInfo(job);
  if (!info) return null;
  return <span className={`needs-badge ${info.kind === 'ok' ? 'ok' : info.kind === 'over' ? 'over' : ''}`}>{info.text}</span>;
}

/** "This job needs another truck" — a deliberate action (any job type, not just long-distance:
    a local move can turn out too big for one truck too), separate from the drag-and-drop that
    assigns the first truck. Picking a truck here adds it and bumps trucksNeeded to match, so the
    "needs N more" badge clears instead of flipping to "over." Renders nothing once every truck is
    already on the job. Stops propagation so clicking/opening the dropdown doesn't start a drag on
    the job block it sits inside. */
function AddTruckControl({ job, trucks, onAddTruck }) {
  const assignedIds = new Set(jobTruckIds(job));
  const available = trucks.filter((t) => !assignedIds.has(t.id));
  if (!available.length || !onAddTruck) return null;
  return (
    <select
      className="jb-add-truck"
      value=""
      title="Load doesn't fit in one truck? Add another."
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const truckId = e.target.value;
        if (truckId) onAddTruck(job.id, truckId);
        e.target.value = '';
      }}
    >
      <option value="">+ truck</option>
      {available.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
    </select>
  );
}

/** Chip in the unassigned tray (day view). */
export function JobChip({ job, trucks, conflict, draggable, onDragStart, highlighted, onDeleteJob }) {
  const when = job.type === 'long_distance' ? `Long Distance (${fmtRange(job)})` : (job.startTime ? hourToLabel(timeToHour(job.startTime)) : '');
  const canDelete = job.source === 'placeholder' && onDeleteJob;
  return (
    <div
      className={`chip ${job.type === 'long_distance' ? 'ld' : ''} ${conflict ? 'conflict' : ''} ${highlighted ? 'highlighted' : ''}`}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      {canDelete && (
        <span
          className="jb-remove chip-delete"
          title="Delete this placeholder job"
          onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id, job.customer); }}
        >×</span>
      )}
      <b>{job.customer}{conflict && <span className="conflict-flag">⚠</span>}<SmBadge job={job} /><PlaceholderBadge job={job} /></b>
      {job.id} · {when} <TruckBadge job={job} />
    </div>
  );
}

/** Chip in the unassigned tray (day view) for a SmartMoving opportunity that has more than one
 * job on it (e.g. quote 23569 split into jobs 23569-1/23569-2/23569-3) — shown as ONE chip with a
 * picker instead of cluttering the tray with one row per job. The picker just changes which job
 * this chip currently represents (for display and for what gets dragged onto a truck); the other
 * jobs in the group stay in the tray, still unassigned, until picked and dropped themselves. */
export function GroupedJobChip({ jobsInGroup, trucks, conflictIds, draggable, onDragStart, highlightedJobId }) {
  // If a search result landed us on a job that's inside this group, default the picker to THAT
  // job instead of always the first one — otherwise "find the job" would highlight a chip showing
  // a completely different job in the group.
  const initialId = jobsInGroup.some((j) => j.id === highlightedJobId) ? highlightedJobId : jobsInGroup[0].id;
  const [selectedId, setSelectedId] = useState(initialId);
  const job = jobsInGroup.find((j) => j.id === selectedId) || jobsInGroup[0];
  const when = job.type === 'long_distance' ? `Long Distance (${fmtRange(job)})` : (job.startTime ? hourToLabel(timeToHour(job.startTime)) : '');
  const conflict = conflictIds.has(job.id);
  const highlighted = job.id === highlightedJobId;
  return (
    <div
      className={`chip grouped ${job.type === 'long_distance' ? 'ld' : ''} ${conflict ? 'conflict' : ''} ${highlighted ? 'highlighted' : ''}`}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
      title={`${jobsInGroup.length} jobs on this SmartMoving booking — pick which one to assign`}
    >
      <b>{job.customer}{conflict && <span className="conflict-flag">⚠</span>}<SmBadge job={job} /><PlaceholderBadge job={job} /></b>
      <select
        className="chip-job-select"
        value={selectedId}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setSelectedId(e.target.value)}
      >
        {jobsInGroup.map((j, i) => (
          <option value={j.id} key={j.id}>{j.id} ({i + 1}/{jobsInGroup.length})</option>
        ))}
      </select>
      {' '}· {when} <TruckBadge job={job} />
    </div>
  );
}

/** Job block positioned on a truck's timeline row (day view). Clicking the block (not its remove
 * button, +truck picker, or resize handle — those all stop the click from bubbling here) opens
 * JobEditModal via onEditJob so the date/time can be typed in exactly instead of only ever being
 * set by eyeballing a drag position. Local jobs can also be resized by dragging the small handle
 * on their right edge, adjusting duration live as you drag (see handleResizeMouseDown). */
export function JobBlock({ job, date, truckIdCtx, trucks, drivers, conflict, role, draggable, onDragStart, onRemoveTruck, onAddExtraTruck, onEditJob, onResizeJob, onDeleteJob, TIMELINE_START, TIMELINE_END, highlighted }) {
  const color = getJobDriverColor(trucks, drivers, job);
  const colorStyle = color ? { borderColor: color, borderLeftColor: color } : {};
  const z = stackZIndex(job);
  const multiTruck = jobTrucksNeeded(job) > 1;
  // Keyed off how many trucks are ACTUALLY assigned, not job.trucksNeeded — trucksNeeded is an
  // LD-specific "how many should this have" field that's normally 1 for local jobs, so gating the
  // remove button on it alone hides it exactly when a local job ends up (incorrectly) assigned to
  // more than one truck, leaving no way to fix it from the board. See useSchedulerData.js's
  // addTruckToJob for where that double-assignment is now prevented at the source.
  const showRemove = jobTruckIds(job).length > 1 && truckIdCtx && role !== 'crew';
  const canEdit = role !== 'crew';
  const canDelete = job.source === 'placeholder' && canEdit && onDeleteJob;
  const [resizing, setResizing] = useState(false);
  const [resizePreviewHours, setResizePreviewHours] = useState(null);
  const handleBlockClick = () => { if (!resizing && onEditJob) onEditJob(job.id); };

  /** Drag-to-resize a local job's duration from its right edge. Uses raw mouse events (not HTML5
   * drag-and-drop, which only reports a drop point, not continuous movement) so the block's width
   * updates live as you drag, same as a familiar "resize" handle elsewhere on the web. Reads the
   * enclosing `.track` element's width to convert pixel movement into hours using the same
   * TIMELINE_START/END span the block's own position is computed from, so it stays accurate at
   * any zoom/window width. Commits via onResizeJob on mouseup; a plain click (no movement) never
   * reaches here since the handle has its own small hit area separate from the block's onClick. */
  function handleResizeMouseDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const trackEl = e.currentTarget.closest('.track');
    if (!trackEl || !onResizeJob) return;
    const trackWidth = trackEl.getBoundingClientRect().width;
    const startX = e.clientX;
    const initialDuration = job.duration || 2;
    const startHour = timeToHour(job.startTime) ?? TIMELINE_START;
    const maxDuration = TIMELINE_END - startHour;

    function clampDuration(deltaPx) {
      const deltaHours = (deltaPx / trackWidth) * (TIMELINE_END - TIMELINE_START);
      const raw = Math.round((initialDuration + deltaHours) * 2) / 2;
      return Math.max(0.5, Math.min(raw, maxDuration));
    }
    function onMove(ev) {
      setResizing(true);
      setResizePreviewHours(clampDuration(ev.clientX - startX));
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalDuration = clampDuration(ev.clientX - startX);
      setResizePreviewHours(null);
      // Defer clearing `resizing` past this tick so the click that a mouseup can sometimes
      // trigger on the same element doesn't slip through and reopen the edit modal right after
      // a resize.
      setTimeout(() => setResizing(false), 0);
      if (finalDuration !== initialDuration) onResizeJob(job.id, finalDuration);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  if (job.type === 'long_distance') {
    const dayIdx = daysBetween(job.date, date) + 1;
    const totalDays = daysBetween(job.date, job.endDate || job.date) + 1;
    // On the day it actually departs, the bar starts at the dropped time and runs to the end of
    // that day — same "where you drop it is when it starts" behavior as a local job — instead of
    // always looking like it starts at midnight regardless of what time was picked. On every later
    // transit day the truck is out for the whole day, so the bar goes back to spanning 0%-100%.
    const departsLabel = dayIdx === 1 && job.startTime ? `Departs ${hourToLabel(timeToHour(job.startTime))}` : null;
    const barStyle = (() => {
      if (dayIdx !== 1 || !job.startTime) return { left: '0%', width: '100%' };
      const start = timeToHour(job.startTime) ?? TIMELINE_START;
      const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
      return { left: `${left}%`, width: `${100 - left}%` };
    })();
    const tip = `${job.customer} — LD to ${job.destination} (${fmtRange(job)})${departsLabel ? ` — ${departsLabel}` : ''}${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}`;
    return (
      <div
        className={`job-block ld ${conflict ? 'conflict' : ''} ${highlighted ? 'highlighted' : ''}`}
        title={tip}
        style={{ ...barStyle, zIndex: z, ...colorStyle }}
        draggable={draggable}
        onDragStart={(e) => onDragStart(e, job.id)}
        onClick={handleBlockClick}
      >
        {showRemove && (
          <span className="jb-remove" title="Remove from this truck" onClick={(e) => { e.stopPropagation(); onRemoveTruck(job.id, truckIdCtx); }}>×</span>
        )}
        {canDelete && (
          <span className="jb-delete" title="Delete this placeholder job" onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id, job.customer); }}>🗑</span>
        )}
        <b>{job.customer}{conflict ? ' ⚠' : ''}<PlaceholderBadge job={job} /></b>
        <div className="jb-time">{job.id} · LD → {(job.destination || '(no address)').split(',')[0]} · Day {dayIdx}/{totalDays} ({ldStageLabels[job.stage || 'scheduled']})</div>
        {departsLabel && <div className="jb-time">{departsLabel}</div>}
        {multiTruck && <div className="jb-time"><TruckBadge job={job} /> · trucks: {jobTruckLabel(trucks, job)}</div>}
        {canEdit && <AddTruckControl job={job} trucks={trucks} onAddTruck={onAddExtraTruck} />}
      </div>
    );
  }

  const start = timeToHour(job.startTime) ?? TIMELINE_START;
  const dur = resizePreviewHours ?? (job.duration || 2);
  const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
  const width = dur / (TIMELINE_END - TIMELINE_START) * 100;
  const tip = `${job.customer} — ${hourToLabel(start)} (${dur}h), ${job.origin} → ${job.destination}${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}`;
  return (
    <div
      className={`job-block ${conflict ? 'conflict' : ''} ${resizing ? 'resizing' : ''} ${highlighted ? 'highlighted' : ''}`}
      title={tip}
      style={{ left: `${left}%`, width: `${width}%`, zIndex: z, ...colorStyle }}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
      onClick={handleBlockClick}
    >
      {showRemove && (
        <span className="jb-remove" title="Remove from this truck" onClick={(e) => { e.stopPropagation(); onRemoveTruck(job.id, truckIdCtx); }}>×</span>
      )}
      {canDelete && (
        <span className="jb-delete" title="Delete this placeholder job" onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id, job.customer); }}>🗑</span>
      )}
      <b>{job.customer}{conflict ? ' ⚠' : ''}<PlaceholderBadge job={job} /></b>
      <div className="jb-time">{hourToLabel(start)} · {dur}h · {job.id}{multiTruck ? ` · ${jobTruckLabel(trucks, job)}` : ''}</div>
      {canEdit && <AddTruckControl job={job} trucks={trucks} onAddTruck={onAddExtraTruck} />}
      {canEdit && onResizeJob && (
        <span
          className="jb-resize-handle"
          title="Drag to change duration"
          onMouseDown={handleResizeMouseDown}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

/** Small chip for a local (non-LD) job on a specific day, in month view. */
export function MonthChip({ job, trucks, drivers, conflict, mine, draggable, onDragStart, onAddExtraTruck }) {
  const color = getJobDriverColor(trucks, drivers, job);
  const hasTruck = jobTruckIds(job).length > 0;
  const time = job.startTime ? hourToLabel(timeToHour(job.startTime)) : '';
  const tip = `${job.customer} — ${time}${job.duration ? ` (${job.duration}h)` : ''} · ${jobTruckLabel(trucks, job)}${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}`;
  return (
    <div
      className={`month-chip ${!hasTruck ? 'unassigned' : ''} ${mine ? 'mine' : ''} ${conflict ? 'conflict' : ''}`}
      title={tip}
      style={color ? { borderLeftColor: color } : {}}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      {conflict ? '⚠ ' : ''}{time ? time + ' · ' : ''}{jobTruckLabel(trucks, job)}: {job.customer}
      {draggable && <AddTruckControl job={job} trucks={trucks} onAddTruck={onAddExtraTruck} />}
    </div>
  );
}

/** Same idea as GroupedJobChip (day view), for month view: local jobs sharing one SmartMoving
 * opportunity that land unassigned on the same calendar day (e.g. quote 23569 split into jobs
 * 23569-1/23569-2/23569-3) collapse into one chip with a picker instead of three separate chips
 * crowding the day cell. Only unassigned jobs are grouped — once a job is on a truck it's shown
 * individually via MonthChip so which truck it's on stays visible. */
export function MonthGroupedChip({ jobsInGroup, conflictIds, mine, draggable, onDragStart }) {
  const [selectedId, setSelectedId] = useState(jobsInGroup[0].id);
  const job = jobsInGroup.find((j) => j.id === selectedId) || jobsInGroup[0];
  const conflict = conflictIds.has(job.id);
  const time = job.startTime ? hourToLabel(timeToHour(job.startTime)) : '';
  const tip = `${jobsInGroup.length} jobs on this SmartMoving booking — pick which one to assign`;
  return (
    <div
      className={`month-chip unassigned grouped ${mine ? 'mine' : ''} ${conflict ? 'conflict' : ''}`}
      title={tip}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      {conflict ? '⚠ ' : ''}{time ? time + ' · ' : ''}{job.customer}
      <select
        className="chip-job-select"
        value={selectedId}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setSelectedId(e.target.value)}
      >
        {jobsInGroup.map((j, i) => (
          <option value={j.id} key={j.id}>{j.id} ({i + 1}/{jobsInGroup.length})</option>
        ))}
      </select>
    </div>
  );
}

/** Multi-day bar spanning a week for a long-distance job, in month view. */
export function WeekBar({ ev, weekStart, weekEnd, trucks, drivers, conflict, mine, draggable, onDragStart, onAddExtraTruck }) {
  const job = ev.job;
  const color = getJobDriverColor(trucks, drivers, job);
  const continuesLeft = job.date < weekStart;
  const continuesRight = (job.endDate || job.date) > weekEnd;
  const borderColor = color || 'var(--muted)';
  const radius = `${continuesLeft ? '2px' : '6px'} ${continuesRight ? '2px' : '6px'} ${continuesRight ? '2px' : '6px'} ${continuesLeft ? '2px' : '6px'}`;
  const understaffed = jobTruckIds(job).length < jobTrucksNeeded(job);
  const tip = `${job.customer} — ${job.origin} → ${job.destination} (${fmtRange(job)})${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}${understaffed ? ' — needs more trucks' : ''}`;
  return (
    <div
      className={`week-bar ${conflict ? 'conflict' : ''} ${mine ? 'mine' : ''} ${understaffed ? 'understaffed' : ''}`}
      title={tip}
      style={{
        gridColumn: `${ev.startCol + 1} / ${ev.endCol + 2}`,
        gridRow: ev.lane + 1,
        borderColor,
        borderRadius: radius,
        zIndex: stackZIndex(job),
      }}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      {continuesLeft ? '◂ ' : ''}{conflict ? '⚠ ' : ''}{understaffed ? '🚚! ' : ''}{jobTruckLabel(trucks, job)}: {job.customer}{continuesRight ? ' ▸' : ''}
      {draggable && <AddTruckControl job={job} trucks={trucks} onAddTruck={onAddExtraTruck} />}
    </div>
  );
}

/** Same idea as GroupedJobChip/MonthGroupedChip, for long-distance bars: an opportunity split into
 * several unassigned long-distance job records (e.g. quote 23569 as jobs 23569-1/23569-2/23569-3,
 * all the same trip) renders as ONE spanning bar with a picker instead of several overlapping bars
 * for what's really the same move. Only formed from jobs active in the SAME week (see MonthBoard's
 * ldEvents grouping) and positioned using the group's first job's date range — picking a different
 * job in the dropdown changes which one is displayed/dragged, not the bar's width, on the
 * assumption jobs on one opportunity share essentially the same trip dates. */
export function GroupedWeekBar({ ev, weekStart, weekEnd, conflictIds, draggable, onDragStart }) {
  const jobsInGroup = ev.jobsInGroup;
  const [selectedId, setSelectedId] = useState(jobsInGroup[0].id);
  const job = jobsInGroup.find((j) => j.id === selectedId) || jobsInGroup[0];
  const conflict = conflictIds.has(job.id);
  const continuesLeft = job.date < weekStart;
  const continuesRight = (job.endDate || job.date) > weekEnd;
  const radius = `${continuesLeft ? '2px' : '6px'} ${continuesRight ? '2px' : '6px'} ${continuesRight ? '2px' : '6px'} ${continuesLeft ? '2px' : '6px'}`;
  const tip = `${job.customer} — ${jobsInGroup.length} jobs on this SmartMoving booking, pick which one to assign · ${job.origin} → ${job.destination} (${fmtRange(job)})`;
  return (
    <div
      className={`week-bar grouped ${conflict ? 'conflict' : ''}`}
      title={tip}
      style={{
        gridColumn: `${ev.startCol + 1} / ${ev.endCol + 2}`,
        gridRow: ev.lane + 1,
        borderColor: 'var(--muted)',
        borderRadius: radius,
        zIndex: stackZIndex(job),
      }}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      {continuesLeft ? '◂ ' : ''}{conflict ? '⚠ ' : ''}Unassigned: {job.customer}{continuesRight ? ' ▸' : ''}
      <select
        className="chip-job-select"
        value={selectedId}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => setSelectedId(e.target.value)}
      >
        {jobsInGroup.map((j, i) => (
          <option value={j.id} key={j.id}>{j.id} ({i + 1}/{jobsInGroup.length})</option>
        ))}
      </select>
    </div>
  );
}

/** Grouped marker for one or more local jobs that overlap an LD bar on the same truck+day. */
export function ConflictOverlayChip({ jobsArr, dayIndex, lane, mine }) {
  const single = jobsArr.length === 1;
  const z = Math.max(...jobsArr.map((j) => stackZIndex(j)));
  const names = jobsArr.map((j) => j.customer).join(', ');
  const tip = jobsArr.map((j) => `${j.customer} — ${j.origin} → ${j.destination} — CONFLICT: overlaps a long-distance job on this truck`).join('  |  ');
  return (
    <div
      className={`week-bar conflict overlay-chip ${mine ? 'mine' : ''}`}
      title={tip}
      style={{ gridColumn: `${dayIndex + 1} / ${dayIndex + 2}`, gridRow: lane + 1, zIndex: z }}
    >
      ⚠ {single ? names : `${jobsArr.length} jobs: ${names}`}
    </div>
  );
}
