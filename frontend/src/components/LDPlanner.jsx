import { fmtRange, jobEnd } from '../utils/dates';
import { jobTrucks, getJobDriverColor, ldStages, ldStageLabels } from '../utils/jobs';
import { SmBadge, TruckBadge } from './board/JobVisuals';

export default function LDPlanner({ trucks, drivers, jobs, conflictIds }) {
  const ldJobs = jobs.filter((j) => j.type === 'long_distance');

  return (
    <section>
      <div className="toolbar">
        <h2 className="section-title">Long Distance Jobs — route, transit &amp; crew</h2>
      </div>
      <div className="ld-list">
        {ldJobs.length === 0 && <div className="empty">No long distance jobs.</div>}
        {ldJobs.map((j) => {
          const ts = jobTrucks(trucks, j);
          const driverNames = ts.map((t) => (t.driverId ? drivers.find((d) => d.id === t.driverId)?.name.split(' ')[0] : null)).filter(Boolean);
          const stageIdx = ldStages.indexOf(j.stage || 'scheduled');
          const conflict = conflictIds.has(j.id);
          const color = getJobDriverColor(trucks, drivers, j);
          const rowStyle = conflict ? { borderColor: 'var(--red)' } : (color ? { borderLeft: `4px solid ${color}` } : {});
          return (
            <div className="ld-row" style={rowStyle} key={j.id}>
              <div className="ld-route">
                {j.customer}{conflict && <span className="conflict-flag">⚠ conflict</span>}<SmBadge job={j} /> <TruckBadge job={j} />
                <div className="sub">{j.origin} → {j.destination} · {j.id}</div>
              </div>
              <div className="ld-field"><label>Pickup</label><div>{j.date}</div></div>
              <div className="ld-field"><label>Delivery</label><div>{jobEnd(j)}</div></div>
              <div className="ld-field">
                <label>Trucks / Drivers</label>
                <div>{ts.length ? ts.map((t) => t.name).join(', ') : 'Unassigned'}{driverNames.length ? ' · ' + driverNames.join(', ') : ''}</div>
              </div>
              <div className="pipeline">
                {ldStages.map((s, i) => (
                  <span className={`pipe-step ${i < stageIdx ? 'done' : i === stageIdx ? 'current' : ''}`} key={s}>{ldStageLabels[s]}</span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
