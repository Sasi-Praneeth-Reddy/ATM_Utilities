import { useEffect, useRef, useState } from 'react';
import { fmtRange, hourToLabel, timeToHour } from '../../utils/dates';
import { jobTrucks, jobTruckIds, jobTrucksNeeded } from '../../utils/jobs';
import { SmBadge, TruckBadge } from '../board/JobVisuals';

/** Collapsed-by-default multi-select for a long-distance job's assigned trucks — with the real
 * fleet size (20+ trucks), always showing every truck as an inline checkbox row (the old
 * behavior) made each long-distance row in this list enormous and pushed everything else off
 * screen. Closed, it just shows which trucks (if any) are already checked; opening it reveals the
 * full checkbox list — same underlying onToggleJobTruck wiring as before, just tucked behind a
 * click instead of always rendered. Closes on picking somewhere else on the page (mousedown
 * outside the panel) or Escape, matching the pattern used by JobSearch's dropdown elsewhere in
 * the app. */
function TruckMultiSelect({ job, trucks, onToggleJobTruck }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleOutside(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const assignedIds = jobTruckIds(job);
  const assignedTrucks = trucks.filter((t) => assignedIds.includes(t.id));
  const summary = assignedTrucks.length ? assignedTrucks.map((t) => t.name).join(', ') : '— No trucks selected —';

  return (
    <div className="truck-multiselect" ref={wrapRef}>
      <button type="button" className="truck-multiselect-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="truck-multiselect-summary">{summary}</span>
        <span className="truck-multiselect-count">{assignedTrucks.length || 0}</span>
        <span className="truck-multiselect-arrow">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="truck-multiselect-panel">
          {trucks.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={assignedIds.includes(t.id)}
                onChange={(e) => onToggleJobTruck(job.id, t.id, e.target.checked)}
              />
              {' '}{t.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function JobAssignments({ trucks, drivers, jobs, conflictIds, onSetJobSingleTruck, onToggleJobTruck, onUpdateJobField, onAddExtraTruck }) {
  const sorted = [...jobs].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div>
      {sorted.map((j) => {
        const ts = jobTrucks(trucks, j);
        const driverNames = ts.map((t) => (t.driverId ? drivers.find((d) => d.id === t.driverId)?.name : null)).filter(Boolean);
        const conflict = conflictIds.has(j.id);
        const multiCapable = j.type === 'long_distance';

        return (
          <div className={`assign-row ${conflict ? 'conflict' : ''}`} key={j.id}>
            <div>
              <div className="aj-title">
                {j.customer} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· {j.id}</span>
                {conflict && <span className="aj-conflict-tag">⚠ CONFLICT</span>}
                <SmBadge job={j} />
              </div>
              <div className="aj-meta">
                {fmtRange(j)}{j.startTime ? ' · ' + hourToLabel(timeToHour(j.startTime)) : ''} · {j.type === 'long_distance' ? 'Long Distance' : 'Local'} · {(j.origin || '(no address)').split(',')[0]} → {(j.destination || '(no address)').split(',')[0]}
                {driverNames.length ? ' · Driver: ' + driverNames.join(', ') : ''}
              </div>
            </div>
            <div>
              <span className="field-label">{multiCapable ? 'Trucks' : 'Truck'}</span>
              {multiCapable ? (
                <>
                  <TruckMultiSelect job={j} trucks={trucks} onToggleJobTruck={onToggleJobTruck} />
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                    Trucks needed (from SmartMoving):{' '}
                    <input
                      type="text" className="needed-input" defaultValue={jobTrucksNeeded(j)}
                      key={`needed-${j.id}-${jobTrucksNeeded(j)}`}
                      onChange={(e) => onUpdateJobField(j.id, 'trucksNeeded', Math.max(1, parseInt(e.target.value) || 1))}
                    />
                    {' '}<TruckBadge job={j} />
                  </div>
                </>
              ) : (
                <>
                  <select value={jobTruckIds(j)[0] || ''} onChange={(e) => onSetJobSingleTruck(j.id, e.target.value)}>
                    <option value="">— Unassigned —</option>
                    {trucks.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
                  </select>
                  {jobTruckIds(j).length > 0 && (() => {
                    const assignedIds = new Set(jobTruckIds(j));
                    const available = trucks.filter((t) => !assignedIds.has(t.id));
                    if (!available.length) return null;
                    return (
                      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                        Load doesn't fit in one truck?{' '}
                        <select
                          value=""
                          onChange={(e) => { if (e.target.value) onAddExtraTruck(j.id, e.target.value); }}
                        >
                          <option value="">+ Add another truck</option>
                          {available.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
                        </select>
                        {jobTruckIds(j).length > 1 && <> <TruckBadge job={j} /></>}
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
