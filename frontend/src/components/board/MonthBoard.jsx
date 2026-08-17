import { useMemo, useState } from 'react';
import { addDays, isoDate, todayStr, daysBetween } from '../../utils/dates';
import { assignLanes, jobTruckIds, groupByOpportunity } from '../../utils/jobs';
import { MonthChip, MonthGroupedChip, WeekBar, GroupedWeekBar, ConflictOverlayChip } from './JobVisuals';

const DAY_NUM_H = 23; // reserved space (px) for the date number, so bars never cover it

function buildWeeks(monthCursor) {
  const y = monthCursor.getFullYear();
  const m = monthCursor.getMonth();
  const firstOfMonth = isoDate(y, m, 1);
  const startOffset = new Date(y, m, 1).getDay();
  const calStart = addDays(firstOfMonth, -startOffset);
  const weeks = [];
  let cursor = calStart;
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function Week({ week, monthStr, jobs, trucks, drivers, role, currentCrewTruck, conflicts, conflictIds, onDrop, onAddExtraTruck, readOnly }) {
  const [dragOverDate, setDragOverDate] = useState(null);
  // Crew never gets drag-and-drop (view-only role); `readOnly` is a separate, explicit override for
  // callers like LDPlanner that want a view-only month calendar for an otherwise-editing role
  // (admin/dispatcher) — kept distinct from the role check so disabling it there can't be confused
  // with, or accidentally affect, the Truck Board's own month view.
  const draggable = role !== 'crew' && !readOnly;
  const weekStart = week[0], weekEnd = week[6];
  const today = todayStr();

  const { ldEvents, laneCount, laneMap } = useMemo(() => {
    const ldJobsThisWeek = jobs.filter((j) => j.type === 'long_distance' && j.date <= weekEnd && (j.endDate || j.date) >= weekStart);
    // Same grouping as the local-job chips: multiple unassigned long-distance jobs sharing one
    // SmartMoving opportunity (one trip split into several job records, e.g. 23569-1/2/3) collapse
    // into a single spanning bar with a picker instead of several overlapping bars for the same
    // move. Assigned jobs, and any opportunity with only one unassigned job, stay individual —
    // grouping only helps once there's more than one unassigned job to choose between.
    const assignedLd = ldJobsThisWeek.filter((j) => jobTruckIds(j).length > 0);
    const { groups: ldGroups, singles: unassignedLdSingles } = groupByOpportunity(
      ldJobsThisWeek.filter((j) => jobTruckIds(j).length === 0)
    );
    const toEvent = (job, jobsInGroup) => ({
      job,
      jobsInGroup: jobsInGroup || null,
      startCol: Math.max(0, daysBetween(weekStart, job.date)),
      endCol: Math.min(6, daysBetween(weekStart, job.endDate || job.date)),
    });
    const events = [
      ...assignedLd.map((j) => toEvent(j)),
      ...unassignedLdSingles.map((j) => toEvent(j)),
      ...ldGroups.map((g) => toEvent(g[0], g)),
    ];
    const count = assignLanes(events);
    const map = {};
    events.forEach((ev) => { map[ev.job.id] = ev.lane; });
    return { ldEvents: events, laneCount: count, laneMap: map };
  }, [jobs, weekStart, weekEnd]);

  const barsAreaHeight = laneCount ? laneCount * 20 : 0;

  // A local job that conflicts with an LD job on the same truck is drawn as a small marker
  // directly on top of that LD bar, in the exact day column where the overlap happens — shorter
  // job always wins the top spot. Jobs conflicting with the same LD job on the same day are
  // grouped into a single marker instead of stacking.
  const overlayJobIds = new Set();
  const overlayGroups = {};
  week.forEach((dateStr, dayIndex) => {
    jobs.filter((j) => j.type !== 'long_distance' && j.date === dateStr && conflictIds.has(j.id)).forEach((j) => {
      const pair = conflicts.find((c) =>
        (c.a.id === j.id && c.b.type === 'long_distance') || (c.b.id === j.id && c.a.type === 'long_distance')
      );
      if (!pair) return;
      const partner = pair.a.id === j.id ? pair.b : pair.a;
      if (laneMap[partner.id] === undefined) return;
      overlayJobIds.add(j.id);
      const key = `${dayIndex}-${laneMap[partner.id]}`;
      (overlayGroups[key] = overlayGroups[key] || { dayIndex, lane: laneMap[partner.id], jobs: [] }).jobs.push(j);
    });
  });

  return (
    <div className="month-week">
      <div className="week-bars" style={{ paddingTop: DAY_NUM_H }}>
        {ldEvents.map((ev) => (
          ev.jobsInGroup ? (
            <GroupedWeekBar
              key={ev.job.smartMovingOpportunityId}
              ev={ev}
              weekStart={weekStart}
              weekEnd={weekEnd}
              conflictIds={conflictIds}
              draggable={draggable}
              onDragStart={(e, jobId) => e.dataTransfer.setData('text/plain', jobId)}
            />
          ) : (
            <WeekBar
              key={ev.job.id}
              ev={ev}
              weekStart={weekStart}
              weekEnd={weekEnd}
              trucks={trucks}
              drivers={drivers}
              conflict={conflictIds.has(ev.job.id)}
              mine={role === 'crew' && (ev.job.truckIds || []).includes(currentCrewTruck)}
              draggable={draggable}
              onDragStart={(e, jobId) => e.dataTransfer.setData('text/plain', jobId)}
              onAddExtraTruck={onAddExtraTruck}
            />
          )
        ))}
        {Object.values(overlayGroups).map((g, i) => (
          <ConflictOverlayChip
            key={i}
            jobsArr={g.jobs}
            dayIndex={g.dayIndex}
            lane={g.lane}
            mine={role === 'crew' && g.jobs.some((j) => (j.truckIds || []).includes(currentCrewTruck))}
          />
        ))}
      </div>
      <div className="month-week-grid">
        {week.map((dateStr) => {
          const dayNum = parseInt(dateStr.slice(8, 10), 10);
          const inMonth = dateStr.slice(5, 7) === monthStr;
          const isToday = dateStr === today;
          const localJobsAll = jobs.filter((j) => j.type !== 'long_distance' && j.date === dateStr && !overlayJobIds.has(j.id));
          // Same grouping as the day view's unassigned tray: multiple unassigned jobs sharing one
          // SmartMoving opportunity collapse into a single chip with a picker. Assigned jobs stay
          // individual (which truck they're on is meaningful info, so no reason to hide it).
          const assignedLocalJobs = localJobsAll.filter((j) => jobTruckIds(j).length > 0);
          const { groups: localGroups, singles: unassignedLocalSingles } = groupByOpportunity(
            localJobsAll.filter((j) => jobTruckIds(j).length === 0)
          );
          return (
            <div
              className={`month-day ${inMonth ? '' : 'pad'} ${isToday ? 'today' : ''} ${dragOverDate === dateStr ? 'dragover' : ''}`}
              key={dateStr}
              onDragOver={draggable ? (e) => { e.preventDefault(); setDragOverDate(dateStr); } : undefined}
              onDragLeave={draggable ? () => setDragOverDate(null) : undefined}
              onDrop={draggable ? (e) => {
                e.preventDefault();
                setDragOverDate(null);
                const jobId = e.dataTransfer.getData('text/plain');
                if (jobId) onDrop(jobId, dateStr);
              } : undefined}
            >
              <div className="day-num">{dayNum}</div>
              <div className="bar-spacer" style={{ height: barsAreaHeight }} />
              <div className="day-events">
                {assignedLocalJobs.map((j) => (
                  <MonthChip
                    key={j.id}
                    job={j}
                    trucks={trucks}
                    drivers={drivers}
                    conflict={conflictIds.has(j.id)}
                    mine={role === 'crew' && (j.truckIds || []).includes(currentCrewTruck)}
                    draggable={draggable}
                    onDragStart={(e, jobId) => e.dataTransfer.setData('text/plain', jobId)}
                    onAddExtraTruck={onAddExtraTruck}
                  />
                ))}
                {unassignedLocalSingles.map((j) => (
                  <MonthChip
                    key={j.id}
                    job={j}
                    trucks={trucks}
                    drivers={drivers}
                    conflict={conflictIds.has(j.id)}
                    mine={role === 'crew' && (j.truckIds || []).includes(currentCrewTruck)}
                    draggable={draggable}
                    onDragStart={(e, jobId) => e.dataTransfer.setData('text/plain', jobId)}
                    onAddExtraTruck={onAddExtraTruck}
                  />
                ))}
                {localGroups.map((g) => (
                  <MonthGroupedChip
                    key={g[0].smartMovingOpportunityId}
                    jobsInGroup={g}
                    conflictIds={conflictIds}
                    mine={role === 'crew' && g.some((j) => (j.truckIds || []).includes(currentCrewTruck))}
                    draggable={draggable}
                    onDragStart={(e, jobId) => e.dataTransfer.setData('text/plain', jobId)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function MonthBoard({ monthCursor, trucks, drivers, jobs, role, currentCrewTruck, conflicts, conflictIds, onMoveJobDate, onAddExtraTruck, readOnly }) {
  const y = monthCursor.getFullYear();
  const m = monthCursor.getMonth();
  const monthStr = String(m + 1).padStart(2, '0');
  const weeks = buildWeeks(monthCursor);

  return (
    <div className="month-board">
      <div className="month-weekdays">
        <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
      </div>
      <div className="month-weeks-wrap">
        {weeks.map((week, i) => (
          <Week
            key={i}
            week={week}
            monthStr={monthStr}
            jobs={jobs}
            trucks={trucks}
            drivers={drivers}
            role={role}
            currentCrewTruck={currentCrewTruck}
            conflicts={conflicts}
            conflictIds={conflictIds}
            onDrop={onMoveJobDate}
            onAddExtraTruck={onAddExtraTruck}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
}
