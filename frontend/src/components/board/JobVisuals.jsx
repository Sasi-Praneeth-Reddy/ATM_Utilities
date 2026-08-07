import { fmtRange, hourToLabel, timeToHour, daysBetween } from '../../utils/dates';
import {
  jobTruckIds, jobTrucksNeeded, jobTruckLabel, truckBadgeInfo, getJobDriverColor,
  stackZIndex, ldStageLabels,
} from '../../utils/jobs';

export function SmBadge({ job }) {
  if (job.source !== 'smartmoving') return null;
  return <span className="sm-badge" title="Imported from SmartMoving">SM</span>;
}

export function TruckBadge({ job }) {
  const info = truckBadgeInfo(job);
  if (!info) return null;
  return <span className={`needs-badge ${info.kind === 'ok' ? 'ok' : info.kind === 'over' ? 'over' : ''}`}>{info.text}</span>;
}

/** Chip in the unassigned tray (day view). */
export function JobChip({ job, trucks, conflict, draggable, onDragStart }) {
  const when = job.type === 'long_distance' ? `Long Distance (${fmtRange(job)})` : (job.startTime ? hourToLabel(timeToHour(job.startTime)) : '');
  return (
    <div
      className={`chip ${job.type === 'long_distance' ? 'ld' : ''} ${conflict ? 'conflict' : ''}`}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      <b>{job.customer}{conflict && <span className="conflict-flag">⚠</span>}<SmBadge job={job} /></b>
      {job.id} · {when} <TruckBadge job={job} />
    </div>
  );
}

/** Job block positioned on a truck's timeline row (day view). */
export function JobBlock({ job, date, truckIdCtx, trucks, drivers, conflict, role, draggable, onDragStart, onRemoveTruck, TIMELINE_START, TIMELINE_END }) {
  const color = getJobDriverColor(trucks, drivers, job);
  const colorStyle = color ? { borderColor: color, borderLeftColor: color } : {};
  const z = stackZIndex(job);
  const multiTruck = jobTrucksNeeded(job) > 1;
  const showRemove = multiTruck && truckIdCtx && role !== 'crew';

  if (job.type === 'long_distance') {
    const dayIdx = daysBetween(job.date, date) + 1;
    const totalDays = daysBetween(job.date, job.endDate || job.date) + 1;
    const tip = `${job.customer} — LD to ${job.destination} (${fmtRange(job)})${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}`;
    return (
      <div
        className={`job-block ld ${conflict ? 'conflict' : ''}`}
        title={tip}
        style={{ left: '0%', width: '100%', zIndex: z, ...colorStyle }}
        draggable={draggable}
        onDragStart={(e) => onDragStart(e, job.id)}
      >
        {showRemove && (
          <span className="jb-remove" title="Remove from this truck" onClick={(e) => { e.stopPropagation(); onRemoveTruck(job.id, truckIdCtx); }}>×</span>
        )}
        <b>{job.customer}{conflict ? ' ⚠' : ''}</b>
        <div className="jb-time">{job.id} · LD → {job.destination.split(',')[0]} · Day {dayIdx}/{totalDays} ({ldStageLabels[job.stage || 'scheduled']})</div>
        {multiTruck && <div className="jb-time"><TruckBadge job={job} /> · trucks: {jobTruckLabel(trucks, job)}</div>}
      </div>
    );
  }

  const start = timeToHour(job.startTime) ?? TIMELINE_START;
  const dur = job.duration || 2;
  const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
  const width = dur / (TIMELINE_END - TIMELINE_START) * 100;
  const tip = `${job.customer} — ${hourToLabel(start)}, ${job.origin} → ${job.destination}${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}`;
  return (
    <div
      className={`job-block ${conflict ? 'conflict' : ''}`}
      title={tip}
      style={{ left: `${left}%`, width: `${width}%`, zIndex: z, ...colorStyle }}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
    >
      <b>{job.customer}{conflict ? ' ⚠' : ''}</b>
      <div className="jb-time">{hourToLabel(start)} · {job.id}</div>
    </div>
  );
}

/** Small chip for a local (non-LD) job on a specific day, in month view. */
export function MonthChip({ job, trucks, drivers, conflict, mine, draggable, onDragStart }) {
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
    </div>
  );
}

/** Multi-day bar spanning a week for a long-distance job, in month view. */
export function WeekBar({ ev, weekStart, weekEnd, trucks, drivers, conflict, mine, draggable, onDragStart }) {
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
