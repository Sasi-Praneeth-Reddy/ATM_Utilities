import { useState } from 'react';
import { fmtRange, hourToLabel, timeToHour, daysBetween } from '../../utils/dates';
import {
  jobTruckIds, jobTrucksNeeded, jobTruckLabel, truckBadgeInfo, getJobDriverColor,
  stackZIndex, ldStageLabels, driversBusyOnDate, jobTruckDriver,
  conflictColorForTruck, conflictTruckIdForJob, overlappingClusterFor,
  serviceCategoryClass, serviceCategoryLabels,
} from '../../utils/jobs';

export function SmBadge({ job }) {
  if (job.source !== 'smartmoving') return null;
  return <span className="sm-badge" title="Imported from SmartMoving">SM</span>;
}

/** Same badge pattern as SmBadge, for jobs sourced from the Smart Insights report sync (see
 * server/smartInsightsSync.js) rather than the live SmartMoving REST poll — a different data path
 * with different fields available (see mapSmartInsightsRow.js's doc comment on the job-detail gap),
 * so it's worth distinguishing from a plain "SM" badge at a glance. */
export function SiBadge({ job }) {
  if (job.source !== 'smartmoving-insights') return null;
  return <span className="si-badge" title="Imported from a Smart Insights report">SI</span>;
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

/** "Set/change the driver for THIS truck on THIS job" — hover-reveal, same corner-badge treatment
    as AddTruckControl (opposite bottom corner, so both can show at once without overlapping).
    Unlike AddTruckControl, this doesn't disappear once picked — a driver isn't a one-time "add,"
    they can be swapped job to job (see db.js's file header for why driver assignment lives on the
    job/truck pairing, not the truck itself), so the select's value always reflects whichever
    driver (if any) is currently on this specific pairing and stays available to change it. */
function AddDriverControl({ job, truckId, date, drivers, jobs, onSetDriver }) {
  if (!truckId || !onSetDriver || !drivers.length) return null;
  const current = (job.truckDrivers || {})[truckId] || '';
  // Excludes anyone already driving on a DIFFERENT job active on the date actually being viewed
  // (not necessarily job.date — a long-distance job spans several days, and the relevant "is this
  // driver free" check is for whichever day this block is being looked at, not just day one) whose
  // TIME overlaps this job's — a driver assigned 8:00-12:00 elsewhere is excluded, but one who's
  // done by the time this job starts is not (see driversBusyOnDate's doc comment in utils/jobs.js).
  // The currently-picked driver always stays in the list regardless, so the select never ends up
  // showing a value that isn't one of its own options.
  const busy = driversBusyOnDate(jobs, date, job.id, job);
  const options = drivers.filter((d) => d.id === current || !busy.has(d.id));
  return (
    <select
      className="jb-add-driver"
      value={current}
      title="Set the driver for this truck on this job"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onChange={(e) => onSetDriver(job.id, truckId, e.target.value || null)}
    >
      <option value="">+ driver</option>
      {options.map((d) => <option value={d.id} key={d.id}>{d.name}</option>)}
    </select>
  );
}

/** Renders "origin → destination" for the address line shared by chips and job blocks — skips
 * entirely (returns null, not an empty line) when neither is set, which is common for a freshly
 * created placeholder job (both default to '') so it doesn't waste space showing a bare "→". */
function AddressLine({ job, className }) {
  if (!job.origin && !job.destination) return null;
  return <div className={className}>{job.origin || '—'} → {job.destination || '—'}</div>;
}

/** Chip in the unassigned tray (day view). Clicking the chip (not the delete button, which stops
 * propagation) opens JobEditModal via onEditJob, same click-to-edit affordance JobBlock already has
 * for assigned jobs — this chip is both draggable AND clickable, same combination JobBlock already
 * handles fine. */
export function JobChip({ job, trucks, conflict, draggable, onDragStart, highlighted, onDeleteJob, onEditJob }) {
  const when = job.type === 'long_distance' ? `Long Distance (${fmtRange(job)})` : (job.startTime ? hourToLabel(timeToHour(job.startTime)) : '');
  const canDelete = job.source === 'placeholder' && onDeleteJob;
  return (
    <div
      className={`chip ${job.type === 'long_distance' ? 'ld' : ''} ${conflict ? 'conflict' : ''} ${highlighted ? 'highlighted' : ''}`}
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, job.id)}
      onClick={onEditJob ? () => onEditJob(job.id) : undefined}
    >
      {canDelete && (
        <span
          className="jb-remove chip-delete"
          title="Delete this placeholder job"
          onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id, job.customer); }}
        >×</span>
      )}
      <b>{job.customer}{conflict && <span className="conflict-flag">⚠</span>}<SmBadge job={job} /><SiBadge job={job} /><PlaceholderBadge job={job} /></b>
      <AddressLine job={job} className="chip-addr" />
      {job.id} · {when} <TruckBadge job={job} />
    </div>
  );
}

/** Chip in the unassigned tray (day view) for a SmartMoving opportunity that has more than one
 * job on it (e.g. quote 23569 split into jobs 23569-1/23569-2/23569-3) — shown as ONE chip with a
 * picker instead of cluttering the tray with one row per job. The picker just changes which job
 * this chip currently represents (for display and for what gets dragged onto a truck); the other
 * jobs in the group stay in the tray, still unassigned, until picked and dropped themselves. */
export function GroupedJobChip({ jobsInGroup, trucks, conflictIds, draggable, onDragStart, highlightedJobId, onEditJob }) {
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
      onClick={onEditJob ? () => onEditJob(job.id) : undefined}
      title={`${jobsInGroup.length} jobs on this SmartMoving booking — pick which one to assign`}
    >
      <b>{job.customer}{conflict && <span className="conflict-flag">⚠</span>}<SmBadge job={job} /><SiBadge job={job} /><PlaceholderBadge job={job} /></b>
      <AddressLine job={job} className="chip-addr" />
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
 * button, +truck picker, or resize handle — those all stop the click from bubbling here) calls
 * onEditJob(job.id, truckIdCtx) so the date/time can be typed in exactly instead of only ever being
 * set by eyeballing a drag position. Passing truckIdCtx alongside the job id lets the caller
 * (DayBoard.jsx's openJobOrChooser) tell whether this job overlaps another on THIS truck and, if so,
 * show a "which job?" chooser instead of opening JobEditModal directly — see JobConflictChooser.jsx.
 * Local jobs can also be resized by dragging the small handle on their right edge, adjusting
 * duration live as you drag (see handleResizeMouseDown). */
export function JobBlock({ job, date, truckIdCtx, trucks, drivers, jobs, conflict, conflicts, role, draggable, onDragStart, onRemoveTruck, onAddExtraTruck, onSetJobTruckDriver, onEditJob, onResizeJob, onDeleteJob, TIMELINE_START, TIMELINE_END, highlighted }) {
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
  // Driver assigned to THIS truck on THIS job (see db.js's file header — it's per job/truck now,
  // not a standing field), shown directly on the block instead of only being visible by hovering
  // the +driver picker.
  const assignedDriver = truckIdCtx ? jobTruckDriver(drivers, job, truckIdCtx) : null;
  const [resizing, setResizing] = useState(false);
  const [resizePreviewHours, setResizePreviewHours] = useState(null);
  const handleBlockClick = () => { if (!resizing && onEditJob) onEditJob(job.id, truckIdCtx); };

  // Names of the OTHER job(s) this one conflicts with on THIS specific truck — added 2026-08-27 at
  // the user's request: with two overlapping blocks stacked on the same truck row, the higher
  // z-indexed one (see stackZIndex above) visually covers the other's name entirely, so a dispatcher
  // could only tell there WAS a second job — from the extra width peeking out past the visible
  // block's edge — without knowing whose it was, short of clicking through to open
  // JobConflictChooser. Reuses the same overlappingClusterFor helper DayBoard.jsx's openJobOrChooser
  // already calls for that chooser, so "who does this list" and "who does the chooser list" can
  // never drift apart. Requires `conflicts` (the pairwise array, not just the boolean `conflict`
  // prop) and `truckIdCtx` — falls back to an empty list without either, so a block rendered without
  // truck context (shouldn't happen for an assigned job, but kept defensive) just shows nothing
  // extra rather than throwing.
  const otherConflictNames = (conflict && conflicts && truckIdCtx)
    ? overlappingClusterFor(conflicts, truckIdCtx, job).filter((j) => j.id !== job.id).map((j) => j.customer)
    : [];
  const conflictNamesLabel = otherConflictNames.length ? `⚠ also: ${otherConflictNames.join(', ')}` : null;
  // LD-specific variant — added 2026-08-27 at the user's request: a truck out on a multi-day LD run
  // can end up simultaneously double-booked against several other jobs, more often than a local
  // truck ever does in a single day, so past 3 other conflicting jobs this spells out only the
  // first two names and collapses the rest into "+N more" rather than letting the line grow
  // unbounded (it would otherwise just get clipped by the CSS ellipsis anyway, but at an arbitrary
  // mid-name point instead of a clean boundary). Local blocks keep the full comma-joined list via
  // conflictNamesLabel above — conflicts that large are rare enough there for it not to matter. The
  // full list is always in the block's hover tooltip regardless of which line is shown (see the LD
  // `tip` string below), so nothing is ever fully hidden, only visually condensed.
  const ldConflictNamesLabel = otherConflictNames.length
    ? (otherConflictNames.length > 3
        ? `⚠ also: ${otherConflictNames.slice(0, 2).join(', ')}, +${otherConflictNames.length - 2} more`
        : `⚠ also: ${otherConflictNames.join(', ')}`)
    : null;

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
    // Symmetric to departsLabel, on the LAST day of a genuine multi-day span — job.endTime comes
    // from the calendar sync's dtend wall-clock time (see mapIcalEvent.js), only meaningful once
    // there's more than one day to arrive on (a same-day job's "end time" is just its own end,
    // already implied by duration, not a separate arrival worth calling out).
    const arrivesLabel = dayIdx === totalDays && totalDays > 1 && job.endTime ? `Arrives ${hourToLabel(timeToHour(job.endTime))}` : null;
    const barStyle = (() => {
      if (dayIdx !== 1 || !job.startTime) return { left: '0%', width: '100%' };
      const start = timeToHour(job.startTime) ?? TIMELINE_START;
      const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
      return { left: `${left}%`, width: `${100 - left}%` };
    })();
    // Dense single-line detail run, built the same "array of optional bits, joined" way the print
    // board's detailBits already works (see DayPrintTimeline.jsx) — everything after the customer
    // name (origin/destination, day/stage, departs/arrives, driver, trucks-needed, the job id)
    // packed onto one line instead of stacked as separate rows. Truncates independently of the name
    // (see .jb-detail's CSS) if the block is too narrow — but the hover tooltip below is built from
    // this SAME array, untruncated, so nothing visibly clipped on the block is ever actually hidden
    // from whoever hovers it.
    const detailBits = [
      'LD',
      `Day ${dayIdx}/${totalDays} (${ldStageLabels[job.stage || 'scheduled']})`,
      `${job.origin || '(no origin)'} → ${job.destination || '(no destination)'}`,
      departsLabel,
      arrivesLabel,
      assignedDriver ? `🧑 ${assignedDriver.name}` : null,
      multiTruck ? `trucks: ${jobTruckLabel(trucks, job)}` : null,
      job.id,
    ].filter(Boolean).join(' · ');
    // Hover tooltip — added 2026-08-28 at the user's request: shows the FULL detail line (every
    // bit above, never truncated) plus the full conflict-name list, since the on-screen block can
    // visually clip either one (jb-detail's ellipsis, or ldConflictNamesLabel's "+N more") when the
    // block is narrow. Native title tooltips render \n as a real line break, so this reads as
    // customer/conflict flag, then the full detail line, then (only when relevant) who else it
    // conflicts with — the same three pieces of info the block shows, just guaranteed complete.
    const tip = [
      `${job.customer}${conflict ? ' — ⚠ CONFLICT: overlaps another job on this truck' : ''}`,
      detailBits,
      otherConflictNames.length ? `Also conflicts with: ${otherConflictNames.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    return (
      <div
        className={`job-block ld ${conflict ? 'conflict' : ''} ${highlighted ? 'highlighted' : ''} ${showRemove || canDelete ? 'jb-inset' : ''}`}
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
          <span className={`jb-delete ${showRemove ? 'jb-delete-offset' : ''}`} title="Delete this placeholder job" onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id, job.customer); }}>🗑</span>
        )}
        <span className="jb-line-wrap">
          <span className="jb-name">{job.customer}{conflict ? ' ⚠' : ''}</span>
          <SiBadge job={job} /><PlaceholderBadge job={job} /><TruckBadge job={job} />
          <span className="jb-detail">{detailBits}</span>
        </span>
        {ldConflictNamesLabel && <span className="jb-conflict-names">{ldConflictNamesLabel}</span>}
        {canEdit && <AddTruckControl job={job} trucks={trucks} onAddTruck={onAddExtraTruck} />}
        {canEdit && <AddDriverControl job={job} truckId={truckIdCtx} date={date} drivers={drivers} jobs={jobs} onSetDriver={onSetJobTruckDriver} />}
      </div>
    );
  }

  const start = timeToHour(job.startTime) ?? TIMELINE_START;
  const dur = resizePreviewHours ?? (job.duration || 2);
  const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
  const width = dur / (TIMELINE_END - TIMELINE_START) * 100;
  // Service-category color grading (day board) — added 2026-08-28 at the user's request to color
  // DEL/UPK, LOAD, etc. distinctly from a plain local move; see utils/jobs.js's
  // serviceCategoryClass/serviceCategoryLabels and styles.css's `.job-block.cat-*` rules. null for
  // the categories that deliberately keep the board's default look (see that comment).
  const catClass = serviceCategoryClass(job);
  // Dense single-line detail run — see the long-distance branch above for the full rationale
  // (same "array of optional bits, joined" pattern the print board already uses). truckBadgeInfo's
  // "⚠ needs N more truck(s)" text used to only show via a separate stacked line gated on
  // multiTruck; TruckBadge itself already renders nothing when the job doesn't need more than one
  // truck, so it's now rendered unconditionally right next to the name instead of behind that
  // extra check — one fewer thing this line has to gate on. Full text (never truncated) also feeds
  // the hover tooltip below, same as the LD branch.
  const detailBits = [
    'LCL',
    catClass ? serviceCategoryLabels[catClass] : null,
    `${hourToLabel(start)} · ${dur}h`,
    `${job.origin || '(no origin)'} → ${job.destination || '(no destination)'}`,
    `${jobTrucksNeeded(job)}T/${job.crewSize ?? '?'}M`,
    assignedDriver ? `🧑 ${assignedDriver.name}` : null,
    multiTruck ? `trucks: ${jobTruckLabel(trucks, job)}` : null,
    job.id,
  ].filter(Boolean).join(' · ');
  const tip = [
    `${job.customer}${conflict ? ' — ⚠ CONFLICT: overlaps another job on this truck' : ''}`,
    detailBits,
    otherConflictNames.length ? `Also conflicts with: ${otherConflictNames.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return (
    <div
      className={`job-block ${catClass ? `cat-${catClass}` : ''} ${conflict ? 'conflict' : ''} ${resizing ? 'resizing' : ''} ${highlighted ? 'highlighted' : ''} ${showRemove || canDelete ? 'jb-inset' : ''}`}
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
        <span className={`jb-delete ${showRemove ? 'jb-delete-offset' : ''}`} title="Delete this placeholder job" onClick={(e) => { e.stopPropagation(); onDeleteJob(job.id, job.customer); }}>🗑</span>
      )}
      <span className="jb-line-wrap">
        <span className="jb-name">{job.customer}{conflict ? ' ⚠' : ''}</span>
        <SiBadge job={job} /><PlaceholderBadge job={job} /><TruckBadge job={job} />
        <span className="jb-detail">{detailBits}</span>
      </span>
      {conflictNamesLabel && <span className="jb-conflict-names">{conflictNamesLabel}</span>}
      {canEdit && <AddTruckControl job={job} trucks={trucks} onAddTruck={onAddExtraTruck} />}
      {canEdit && <AddDriverControl job={job} truckId={truckIdCtx} date={date} drivers={drivers} jobs={jobs} onSetDriver={onSetJobTruckDriver} />}
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
export function MonthChip({ job, trucks, drivers, conflict, conflicts, mine, draggable, onDragStart, onAddExtraTruck }) {
  const color = getJobDriverColor(trucks, drivers, job);
  const hasTruck = jobTruckIds(job).length > 0;
  const time = job.startTime ? hourToLabel(timeToHour(job.startTime)) : '';
  const tip = `${job.customer} — ${time}${job.duration ? ` (${job.duration}h)` : ''} · ${jobTruckLabel(trucks, job)}${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}`;
  // Per-truck conflict color: which truck this job conflicts on decides the color, so two chips
  // conflicting on the same truck (even across different days) read as the same color at a glance.
  // Falls back to plain red (styles.css's var(--red) default) when this job isn't conflicted, or
  // `conflicts` wasn't passed in — see conflictColorForTruck's doc comment in utils/jobs.js.
  const conflictTruckId = conflict && conflicts ? conflictTruckIdForJob(conflicts, job.id) : null;
  const conflictColor = conflictTruckId ? conflictColorForTruck(trucks, conflicts, conflictTruckId) : null;
  return (
    <div
      className={`month-chip ${!hasTruck ? 'unassigned' : ''} ${mine ? 'mine' : ''} ${conflict ? 'conflict' : ''}`}
      title={tip}
      style={{ ...(color ? { borderLeftColor: color } : {}), ...(conflictColor ? { '--conflict-color': conflictColor } : {}) }}
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
export function WeekBar({ ev, weekStart, weekEnd, trucks, drivers, conflict, conflicts, mine, draggable, onDragStart, onAddExtraTruck }) {
  const job = ev.job;
  const color = getJobDriverColor(trucks, drivers, job);
  const continuesLeft = job.date < weekStart;
  const continuesRight = (job.endDate || job.date) > weekEnd;
  const borderColor = color || 'var(--muted)';
  const radius = `${continuesLeft ? '2px' : '6px'} ${continuesRight ? '2px' : '6px'} ${continuesRight ? '2px' : '6px'} ${continuesLeft ? '2px' : '6px'}`;
  const understaffed = jobTruckIds(job).length < jobTrucksNeeded(job);
  const tip = `${job.customer} — ${job.origin} → ${job.destination} (${fmtRange(job)})${conflict ? ' — CONFLICT: overlaps another job on this truck' : ''}${understaffed ? ' — needs more trucks' : ''}`;
  // Same per-truck conflict color as MonthChip — see its comment above for the rationale.
  const conflictTruckId = conflict && conflicts ? conflictTruckIdForJob(conflicts, job.id) : null;
  const conflictColor = conflictTruckId ? conflictColorForTruck(trucks, conflicts, conflictTruckId) : null;
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
        ...(conflictColor ? { '--conflict-color': conflictColor } : {}),
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

/** Grouped marker for one or more local jobs that overlap an LD bar on the same truck+day. All jobs
 * in one group share the same conflicting truck (they're grouped by their shared LD partner job —
 * see MonthBoard.jsx's overlayGroups), so the color only needs to be looked up once from the first
 * job. Same per-truck conflict color as MonthChip/WeekBar — see MonthChip's comment for rationale. */
export function ConflictOverlayChip({ jobsArr, dayIndex, lane, mine, trucks, conflicts }) {
  const single = jobsArr.length === 1;
  const z = Math.max(...jobsArr.map((j) => stackZIndex(j)));
  const names = jobsArr.map((j) => j.customer).join(', ');
  const tip = jobsArr.map((j) => `${j.customer} — ${j.origin} → ${j.destination} — CONFLICT: overlaps a long-distance job on this truck`).join('  |  ');
  const conflictTruckId = conflicts ? conflictTruckIdForJob(conflicts, jobsArr[0].id) : null;
  const conflictColor = conflictTruckId && trucks ? conflictColorForTruck(trucks, conflicts, conflictTruckId) : null;
  return (
    <div
      className={`week-bar conflict overlay-chip ${mine ? 'mine' : ''}`}
      title={tip}
      style={{
        gridColumn: `${dayIndex + 1} / ${dayIndex + 2}`,
        gridRow: lane + 1,
        zIndex: z,
        ...(conflictColor ? { '--conflict-color': conflictColor } : {}),
      }}
    >
      ⚠ {single ? names : `${jobsArr.length} jobs: ${names}`}
    </div>
  );
}
