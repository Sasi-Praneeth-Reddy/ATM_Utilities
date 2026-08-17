import { useMemo, useState } from 'react';
import MonthBoard from './board/MonthBoard';

/**
 * Long Distance Planner — a month calendar scoped to long-distance jobs only, reusing the same
 * spanning-bar/conflict/drag-to-reschedule rendering the Truck Board's month view already uses for
 * LD jobs (see MonthBoard.jsx). Replaces the old flat pipeline-stage list: filtering `jobs` down to
 * `long_distance` before handing them to MonthBoard is enough — every local-job code path inside
 * MonthBoard/Week just sees empty arrays and renders nothing, so nothing else needed changing there.
 *
 * Owns its own month cursor (separate from the Truck Board's) so browsing months here doesn't move
 * what the Board tab is showing, and vice versa. Defaults to the real current month via `new Date()`
 * rather than a hardcoded sample-data month — see the Today-button fix elsewhere in this app for why
 * a hardcoded "today" is a bug waiting to happen once real data spans real dates.
 *
 * View-only: passes `readOnly` down to MonthBoard so bars can't be dragged onto a different date
 * here — this is meant as a planning/status overview, not another place to reassign jobs (that
 * still happens on the Truck Board or in Job Assignments). `readOnly` disables both the drag source
 * (the bars) and the drop targets (the day cells) without touching the Truck Board's own month view,
 * which still allows it.
 */
export default function LDPlanner({ role, trucks, drivers, jobs, conflicts, conflictIds }) {
  const [monthCursor, setMonthCursor] = useState(new Date());
  const ldJobs = useMemo(() => jobs.filter((j) => j.type === 'long_distance'), [jobs]);

  return (
    <section>
      <div className="toolbar">
        <h2 className="section-title">Long Distance Jobs — month view</h2>
        <div className="monthpick">
          <button className="btn secondary" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() - 1, 1))}>‹</button>
          <span>{monthCursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
          <button className="btn secondary" onClick={() => setMonthCursor(new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 1))}>›</button>
        </div>
      </div>
      {ldJobs.length === 0 && <div className="empty">No long distance jobs.</div>}
      <MonthBoard
        monthCursor={monthCursor}
        trucks={trucks}
        drivers={drivers}
        jobs={ldJobs}
        role={role}
        conflicts={conflicts}
        conflictIds={conflictIds}
        readOnly
      />
    </section>
  );
}
