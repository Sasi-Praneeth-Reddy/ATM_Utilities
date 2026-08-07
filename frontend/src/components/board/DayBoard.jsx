import { useState } from 'react';
import { jobActiveOn, hourToLabel } from '../../utils/dates';
import { jobTruckIds, statusClass, statusLabel } from '../../utils/jobs';
import { JobChip, JobBlock } from './JobVisuals';

const TIMELINE_START = 7; // 7am
const TIMELINE_END = 19; // 7pm

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

export default function DayBoard({
  date, trucks, drivers, jobs, role, conflictIds,
  onUnassignJob, onAddTruckToJob, onRemoveTruck,
}) {
  const [trayDragOver, setTrayDragOver] = useState(false);
  const [dragOverTruck, setDragOverTruck] = useState(null);
  const draggable = role !== 'crew';

  const unassigned = jobs.filter((j) => jobTruckIds(j).length === 0 && jobActiveOn(j, date));

  const onChipDragStart = (e, jobId) => e.dataTransfer.setData('text/plain', jobId);

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const showNowLine = date === todayStr;
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

    let newStartTime;
    if (job.type !== 'long_distance') {
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      let newHour = TIMELINE_START + frac * (TIMELINE_END - TIMELINE_START);
      newHour = Math.round(newHour * 2) / 2;
      const dur = job.duration || 2;
      newHour = Math.min(newHour, TIMELINE_END - dur);
      const hh = String(Math.floor(newHour)).padStart(2, '0');
      const mm = newHour % 1 === 0.5 ? '30' : '00';
      newStartTime = `${hh}:${mm}`;
    }
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
        {unassigned.length
          ? unassigned.map((j) => (
              <JobChip key={j.id} job={j} trucks={trucks} conflict={conflictIds.has(j.id)} draggable={draggable} onDragStart={onChipDragStart} />
            ))
          : <span className="empty" style={{ padding: 0 }}>All jobs assigned</span>}
      </div>

      <div className="timeline">
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
          return (
            <div className="truck-row" key={t.id}>
              <div className="truck-info">
                <div className={`tname ${statusClass(t.status)}`}>
                  <span className="status-dot" />{t.name}
                  {hasConflict && <span className="conflict-flag">⚠ conflict</span>}
                </div>
                <div className="meta">{t.size}{driver ? ` · ${driver.name}` : ''}</div>
                <div className="meta">{statusLabel(t.status)}</div>
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
                    TIMELINE_START={TIMELINE_START}
                    TIMELINE_END={TIMELINE_END}
                  />
                ))}
                {nowLineVisible && <div className="now-line" style={{ left: `${nowPct}%` }} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
