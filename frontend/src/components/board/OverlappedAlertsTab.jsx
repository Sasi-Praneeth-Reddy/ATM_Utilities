import { fmtRange } from '../../utils/dates';
import { jobTruckDriver } from '../../utils/jobs';

/** One clickable reference to a job within a conflict row — jumps the board to day view on that
 *  job's date and briefly highlights it, via the same onJumpToJob mechanism JobSearch's results
 *  use (see App.jsx's handleJumpToJob — moved up from BoardTab 2026-09-10 so the title-bar search
 *  can reach it from every tab, not just Board). Rendered as a reset-styled inline <button> so it reads as
 *  part of the sentence rather than a separate control, while still being a real clickable element
 *  (keyboard-focusable, no href needed since this never leaves the app). */
function JobLink({ job, driver, onJumpToJob }) {
  return (
    <button type="button" className="oa-job-link" onClick={() => onJumpToJob(job)}>
      {job.customer}
      <span className="oa-job-meta"> ({job.id}, {fmtRange(job)}{driver ? ` — ${driver.name}` : ''})</span>
    </button>
  );
}

/**
 * Full-tab list of truck scheduling conflicts (two jobs assigned to the same truck with
 * overlapping dates/times — see utils/jobs.js's getConflicts). Used to live as an always-visible
 * banner (ConflictBanner.jsx) above the day board; moved into its own Truck Board tab (2026-08-28,
 * at the user's request) once a real sync run regularly produced dozens of these and the banner
 * started crowding out the board itself. ConflictBanner.jsx's rendering logic is duplicated here
 * rather than reused as-is, because that component was a small fixed-height list — this one is the
 * whole tab, so it also needs an empty state and clickable job links, which ConflictBanner never
 * had.
 *
 * Each job mentioned is a clickable link (via onJumpToJob) so a dispatcher can go straight from an
 * alert to the day view showing it, instead of hunting for the date manually — same pattern
 * JobSearch's dropdown results already use.
 *
 * `conflicts` arrives pre-scoped by BoardTab.jsx to whichever view this tab was opened from — the
 * selected day's conflicts from day view, the selected month's from month view (see
 * BoardTab.jsx's conflictsInView comment for why) — rather than every conflict in the whole
 * dataset like it used to. `scopeLabel` (e.g. "on September 8, 2026" / "this month (September
 * 2026)") names that scope in the header/empty state so it's clear this list isn't everything.
 */
export default function OverlappedAlertsTab({ conflicts, scopeLabel, trucks, drivers, onJumpToJob }) {
  return (
    <section>
      <h2 className="section-title">
        {conflicts.length
          ? `⚠ ${conflicts.length} scheduling conflict${conflicts.length > 1 ? 's' : ''} detected ${scopeLabel}`
          : `No scheduling conflicts ${scopeLabel}`}
      </h2>
      {conflicts.length === 0 ? (
        <div className="oa-empty">Every truck's jobs are clear of double-bookings {scopeLabel}.</div>
      ) : (
        <ul className="oa-list">
          {conflicts.map((c, i) => {
            const t = trucks.find((tr) => tr.id === c.truckId);
            // Each job on this truck can have its own driver now (see db.js's file header), so show
            // each side's driver separately rather than one driver name for the whole truck.
            const driverA = jobTruckDriver(drivers, c.a, c.truckId);
            const driverB = jobTruckDriver(drivers, c.b, c.truckId);
            return (
              <li key={i} className="oa-row">
                <span className="oa-truck">{t ? t.name : c.truckId}:</span>
                <span className="oa-sentence">
                  <JobLink job={c.a} driver={driverA} onJumpToJob={onJumpToJob} />
                  {' overlaps with '}
                  <JobLink job={c.b} driver={driverB} onJumpToJob={onJumpToJob} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
