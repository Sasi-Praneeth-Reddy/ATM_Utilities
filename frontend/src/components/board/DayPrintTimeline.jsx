import { jobActiveOn, hourToLabel, timeToHour } from '../../utils/dates';
import { jobTruckIds, getJobDriverColor } from '../../utils/jobs';

// Kept in sync by eye with DayBoard.jsx's TIMELINE_START/TIMELINE_END — this is a separate,
// print-only component (not a reuse of DayBoard itself, since DayBoard's absolute-positioned drag
// handles and hover-only controls aren't meaningful on paper), so if the on-screen board's hours
// ever change, update both.
const TIMELINE_START = 0; // 12am
const TIMELINE_END = 24; // 12am next day

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

/**
 * A print-only rendition of the day board that LOOKS like the on-screen timeline — trucks down the
 * left, colored bars across an hours header — rather than DayPrintSheet's plain table manifest.
 * Requires the browser's "background graphics" print option to be on for the colors to actually
 * show (a browser/print-dialog setting, not something CSS alone can force); `print-color-adjust`
 * in styles.css is a hint some browsers respect without it, but not a guarantee.
 */
export default function DayPrintTimeline({ id, date, trucks, drivers, jobs, conflictIds }) {
  const activeJobs = jobs.filter((j) => jobActiveOn(j, date));
  // Unassigned jobs only print on their own start date — see DayPrintSheet.jsx / DayBoard.jsx for
  // the same fix and why (a long-distance job shouldn't reappear as "unassigned" on every day
  // it's in transit, only the day it needs picking up). Assigned trucks still use activeJobs.
  const unassigned = jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date);
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const printedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="print-sheet print-sheet-timeline" id={id}>
      <div className="print-header">
        <div className="print-title">Around Town Movers — Daily Truck Board</div>
        <div className="print-date">{dateLabel}</div>
      </div>

      <div className="pt-timeline">
        <div className="pt-timeline-header">
          <div className="pt-truck-col-spacer" />
          <div className="pt-hours">
            {/* Paper is a fixed width (no horizontal scroll like the on-screen board), so with 24
                columns instead of 12, labeling every hour gets cramped — only every other hour
                gets a label; every hour still gets its own gridline (see .pt-hour CSS). */}
            {hourLabelList().map((h) => <div className="pt-hour" key={h}>{h % 2 === 0 ? hourToLabel(h) : ''}</div>)}
          </div>
        </div>
        {trucks.map((t) => {
          const driver = t.driverId ? drivers.find((d) => d.id === t.driverId) : null;
          const tjobs = activeJobs.filter((j) => jobTruckIds(j).includes(t.id));
          return (
            <div className="pt-truck-row" key={t.id}>
              <div className="pt-truck-info">
                <div className="pt-truck-name">{t.name}</div>
                <div className="pt-truck-meta">{t.size}{driver ? ` · ${driver.name}` : ''}</div>
              </div>
              <div className="pt-track">
                {tjobs.map((j) => {
                  const isLd = j.type === 'long_distance';
                  const color = getJobDriverColor(trucks, drivers, j);
                  // Same as JobBlock (the on-screen version): on the day it actually departs, the
                  // bar starts at the dropped time instead of always looking like midnight; on
                  // later transit days it's back to a full-day bar.
                  const style = isLd
                    ? (() => {
                        if (j.date !== date || !j.startTime) return { left: '0%', width: '100%' };
                        const start = timeToHour(j.startTime) ?? TIMELINE_START;
                        const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
                        return { left: `${left}%`, width: `${100 - left}%` };
                      })()
                    : (() => {
                        const start = timeToHour(j.startTime) ?? TIMELINE_START;
                        const dur = j.duration || 2;
                        const left = (start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START) * 100;
                        const width = dur / (TIMELINE_END - TIMELINE_START) * 100;
                        return { left: `${left}%`, width: `${width}%` };
                      })();
                  if (color) style.borderLeftColor = color;
                  const conflict = conflictIds && conflictIds.has(j.id);
                  return (
                    <div className={`pt-block ${isLd ? 'ld' : ''} ${conflict ? 'conflict' : ''}`} style={style} key={j.id}>
                      <b>{j.customer}{conflict ? ' ⚠' : ''}</b>
                      <span>{isLd ? `Long Distance${j.startTime && j.date === date ? ` · Departs ${hourToLabel(timeToHour(j.startTime))}` : ''}` : (j.startTime ? hourToLabel(timeToHour(j.startTime)) : '')}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {unassigned.length > 0 && (
        <div className="print-truck print-unassigned" style={{ marginTop: 14 }}>
          <div className="print-truck-head"><span className="print-truck-name">⚠ Unassigned Jobs</span></div>
          <table className="print-table">
            <thead><tr><th>Time</th><th>Customer</th><th>Origin</th><th>Destination</th></tr></thead>
            <tbody>
              {unassigned.map((j) => (
                <tr key={j.id}>
                  <td>{j.type === 'long_distance' ? 'LD' : (j.startTime ? hourToLabel(timeToHour(j.startTime)) : '—')}</td>
                  <td>{j.customer}</td>
                  <td>{j.origin}</td>
                  <td>{j.destination}</td>
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
