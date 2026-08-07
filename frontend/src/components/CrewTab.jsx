import { fmtRange, hourToLabel, timeToHour } from '../utils/dates';
import { jobTruckIds, jobTrucksNeeded, jobTruckLabel, statusLabel } from '../utils/jobs';
import { TruckBadge } from './board/JobVisuals';

export default function CrewTab({ trucks, drivers, jobs, currentCrewTruck, conflictIds }) {
  const truck = trucks.find((t) => t.id === currentCrewTruck);
  if (!truck) return <div className="crew-wrap"><div className="empty">No truck selected.</div></div>;

  const driver = drivers.find((d) => d.id === truck.driverId);
  const myJobs = jobs
    .filter((j) => jobTruckIds(j).includes(currentCrewTruck))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime || '').localeCompare(b.startTime || ''));

  return (
    <div className="crew-wrap">
      <div className="crew-truck-header">
        <div className="t-name">{truck.name} — {truck.size}</div>
        <div className="t-driver">Driver: {driver ? driver.name : 'Unassigned'} · {statusLabel(truck.status)}</div>
      </div>
      {myJobs.length === 0 && <div className="empty">No jobs assigned to this truck yet.</div>}
      {myJobs.map((j) => {
        const conflict = conflictIds.has(j.id);
        return (
          <div className={`crew-job ${conflict ? 'conflict' : ''}`} key={j.id}>
            <div className="cj-date">
              {fmtRange(j)}{j.startTime ? ' · ' + hourToLabel(timeToHour(j.startTime)) : ''}{j.type === 'long_distance' ? ' · Long Distance' : ''}
            </div>
            <div className="cj-customer">{j.customer}</div>
            <div className="cj-addr"><span className="lbl">Pickup</span>{j.origin}</div>
            <div className="cj-addr"><span className="lbl">Drop-off</span>{j.destination}</div>
            <div className="cj-footer">
              <span>{j.crewSize} crew</span>
              <span>{j.miles} mi{j.transitDays ? ' · ' + j.transitDays + ' day transit' : ''}</span>
            </div>
            {jobTrucksNeeded(j) > 1 && (
              <div className="cj-footer" style={{ borderTop: 'none', paddingTop: 0 }}>
                Trucks on this move: {jobTruckLabel(trucks, j)} <TruckBadge job={j} />
              </div>
            )}
            {conflict && <div className="cj-conflict">⚠ This truck is double-booked — overlaps with another job. Check with dispatch.</div>}
          </div>
        );
      })}
    </div>
  );
}
