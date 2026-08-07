import { fmtRange, hourToLabel, timeToHour } from '../../utils/dates';
import { jobTrucks, jobTruckIds, jobTrucksNeeded } from '../../utils/jobs';
import { SmBadge, TruckBadge } from '../board/JobVisuals';

export default function JobAssignments({ trucks, drivers, jobs, conflictIds, onSetJobSingleTruck, onToggleJobTruck, onUpdateJobField }) {
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
                {fmtRange(j)}{j.startTime ? ' · ' + hourToLabel(timeToHour(j.startTime)) : ''} · {j.type === 'long_distance' ? 'Long Distance' : 'Local'} · {j.origin.split(',')[0]} → {j.destination.split(',')[0]}
                {driverNames.length ? ' · Driver: ' + driverNames.join(', ') : ''}
              </div>
            </div>
            <div>
              <span className="field-label">{multiCapable ? 'Trucks' : 'Truck'}</span>
              {multiCapable ? (
                <>
                  <div className="truck-checklist">
                    {trucks.map((t) => (
                      <label key={t.id}>
                        <input
                          type="checkbox"
                          checked={jobTruckIds(j).includes(t.id)}
                          onChange={(e) => onToggleJobTruck(j.id, t.id, e.target.checked)}
                        />
                        {' '}{t.name}
                      </label>
                    ))}
                  </div>
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
                <select value={jobTruckIds(j)[0] || ''} onChange={(e) => onSetJobSingleTruck(j.id, e.target.value)}>
                  <option value="">— Unassigned —</option>
                  {trucks.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
                </select>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
