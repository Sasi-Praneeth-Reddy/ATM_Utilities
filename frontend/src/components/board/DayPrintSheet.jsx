import { jobActiveOn, fmtRange, hourToLabel, timeToHour, daysBetween } from '../../utils/dates';
import { jobTruckIds, statusLabel, ldStageLabels, deriveTruckStatus, jobTruckDriver } from '../../utils/jobs';

function jobTimeLabel(j, date) {
  if (j.type === 'long_distance') {
    const dayIdx = daysBetween(j.date, date) + 1;
    const totalDays = daysBetween(j.date, j.endDate || j.date) + 1;
    return `LD · Day ${dayIdx}/${totalDays}`;
  }
  return j.startTime ? hourToLabel(timeToHour(j.startTime)) : '—';
}

/** Long-distance jobs (all-day, no fixed start time) print first, then local jobs by start time. */
function sortForPrint(jobsArr) {
  return [...jobsArr].sort((a, b) => {
    const aLd = a.type === 'long_distance', bLd = b.type === 'long_distance';
    if (aLd !== bLd) return aLd ? -1 : 1;
    return (timeToHour(a.startTime) ?? 0) - (timeToHour(b.startTime) ?? 0);
  });
}

/**
 * A clean, black-and-white printable manifest for one day — deliberately separate from the
 * interactive drag-and-drop timeline (`DayBoard`), which relies on absolute positioning, hover-only
 * controls, and screen colors that don't translate to paper. Hidden on screen (`.print-sheet` is
 * `display:none` by default); the `@media print` rule in styles.css makes it the only thing visible
 * when the "🖨 Print" button in BoardTab calls `window.print()`. Always uses plain black/gray, not
 * the app's day/night theme variables — a printed page should look the same regardless of which
 * theme was active on screen when it was printed.
 */
export default function DayPrintSheet({ id, date, trucks, drivers, jobs, conflictIds }) {
  const activeJobs = jobs.filter((j) => jobActiveOn(j, date));
  // Unassigned jobs only print on their own start date — a long-distance job starting 7/31
  // shouldn't reappear on every printed day it's still in transit; see DayBoard.jsx for the same
  // fix on the interactive board. Assigned jobs (the per-truck tables above) still use the full
  // activeJobs range, since a truck legitimately has that LD job on its plate every day of the trip.
  const unassigned = sortForPrint(jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date));
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const printedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="print-sheet print-sheet-list" id={id}>
      <div className="print-header">
        <div className="print-title">Around Town Movers — Daily Schedule</div>
        <div className="print-date">{dateLabel}</div>
      </div>

      {trucks.map((t) => {
        const truckJobs = sortForPrint(activeJobs.filter((j) => jobTruckIds(j).includes(t.id)));
        // Driver is assigned per job now, not permanently to the truck (see db.js's file header) —
        // shows whichever active job's driver is set first.
        const driver = truckJobs.map((j) => jobTruckDriver(drivers, j, t.id)).find(Boolean) || null;
        return (
          <div className="print-truck" key={t.id}>
            <div className="print-truck-head">
              <span className="print-truck-name">{t.name}</span>
              <span className="print-truck-meta">
                {t.size}
                {driver ? ` · Driver: ${driver.name}${driver.phone ? ` (${driver.phone})` : ''}` : ' · No driver assigned'}
                {' · '}{statusLabel(deriveTruckStatus(t, jobs, date))}
              </span>
            </div>
            {truckJobs.length ? (
              <table className="print-table">
                <thead>
                  <tr><th>Time</th><th>Customer</th><th>Origin</th><th>Destination</th><th>Crew</th><th>Notes</th></tr>
                </thead>
                <tbody>
                  {truckJobs.map((j) => (
                    <tr key={j.id}>
                      <td>{jobTimeLabel(j, date)}</td>
                      <td>{j.customer}{conflictIds && conflictIds.has(j.id) ? ' ⚠ CONFLICT' : ''}</td>
                      <td>{j.origin}</td>
                      <td>{j.destination}</td>
                      <td>{j.crewSize ?? '—'}</td>
                      <td>
                        {j.type === 'long_distance'
                          ? `LD (${fmtRange(j)})${j.stage ? ` · ${ldStageLabels[j.stage] || j.stage}` : ''}`
                          : (j.duration ? `${j.duration}h` : '')}
                        {j.source === 'smartmoving' ? ' · SM' : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="print-empty">No jobs scheduled</div>
            )}
          </div>
        );
      })}

      {unassigned.length > 0 && (
        <div className="print-truck print-unassigned">
          <div className="print-truck-head"><span className="print-truck-name">⚠ Unassigned Jobs</span></div>
          <table className="print-table">
            <thead><tr><th>Time</th><th>Customer</th><th>Origin</th><th>Destination</th><th>Crew</th></tr></thead>
            <tbody>
              {unassigned.map((j) => (
                <tr key={j.id}>
                  <td>{jobTimeLabel(j, date)}</td>
                  <td>{j.customer}</td>
                  <td>{j.origin}</td>
                  <td>{j.destination}</td>
                  <td>{j.crewSize ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="print-footer">Printed {printedAt}</div>
    </div>
  );
}
