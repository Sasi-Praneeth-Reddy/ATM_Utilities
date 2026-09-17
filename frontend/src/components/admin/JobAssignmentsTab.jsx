import { useMemo, useState } from 'react';
import JobAssignments from './JobAssignments';
import SyncPanel from './SyncPanel';
import { jobTrucks, jobTruckLabel } from '../../utils/jobs';

/** Matches a job against a lowercased search term across every field a dispatcher would plausibly
 * filter this list by — customer name, either SmartMoving id, both addresses, and whichever
 * truck/driver it's currently assigned to (so "who's on Truck 3" or "who's driving with Mike"
 * works too, not just "find this customer"). */
export function matchesQuery(job, trucks, drivers, q) {
  const ts = jobTrucks(trucks, job);
  const truckDrivers = job.truckDrivers || {};
  const driverNames = ts.map((t) => (truckDrivers[t.id] ? drivers.find((d) => d.id === truckDrivers[t.id])?.name : null)).filter(Boolean);
  const haystack = [
    job.customer, job.id, job.origin, job.destination,
    job.smartMovingJobId, job.smartMovingOpportunityId,
    jobTruckLabel(trucks, job), ...driverNames,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

/** Thin "page" wrapper around JobAssignments (the actual list — see that file), giving it its own
 * top-level nav tab instead of living as a scrolled-past section inside Trucks & Drivers. Mirrors
 * the toolbar/section-title header pattern every other top-level tab uses (BoardTab, LDPlanner).
 * Adds a plain filter-as-you-type search scoped to this page only — this list can run long once
 * SmartMoving sync has populated a month's worth of jobs, and unlike JobSearch.jsx on the board
 * (which jumps the calendar to a picked result), everything's already on screen here, so filtering
 * the list in place is all that's needed. Also hosts SyncPanel (moved here 2026-08-25 at the
 * user's request, from Trucks & Drivers — this page is where assignments actually get made, so
 * checking for/pulling in newly-synced jobs belongs here rather than on the truck/driver roster
 * page) — see SyncPanel.jsx for what it does.
 *
 * Also hosts "Reset to sample data" (moved here 2026-09-10 from Trucks & Drivers, at the user's
 * request) — same "this page is where the consequential stuff happens" reasoning as SyncPanel's own
 * move: a dispatcher managing job assignments and syncs is already in the right headspace to notice
 * a big red warning button, more so than someone just adding a truck or fixing a driver's phone
 * number on the roster page. The click handler itself (useSchedulerData.js's resetToSampleData) asks
 * twice before doing anything, with a warning tone on the second ask — this button is just where it
 * lives now, not a second confirmation layer of its own. */
export default function JobAssignmentsTab({
  trucks, drivers, jobs, conflictIds, onSetJobSingleTruck, onToggleJobTruck, onUpdateJobField, onAddExtraTruck, onSetJobTruckDriver,
  syncStatus, onSyncNow, lastSyncedAt,
  calendarSyncStatus, onSyncCalendarNow,
  smartInsightsSyncStatus, onSyncSmartInsightsNow, gmailAuthStatus,
  onResetToSampleData,
}) {
  const [query, setQuery] = useState('');

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => matchesQuery(j, trucks, drivers, q));
  }, [jobs, trucks, drivers, query]);

  return (
    <section>
      <SyncPanel
        syncStatus={syncStatus} onSyncNow={onSyncNow} lastSyncedAt={lastSyncedAt}
        calendarSyncStatus={calendarSyncStatus} onSyncCalendarNow={onSyncCalendarNow}
        smartInsightsSyncStatus={smartInsightsSyncStatus} onSyncSmartInsightsNow={onSyncSmartInsightsNow}
        gmailAuthStatus={gmailAuthStatus}
      />

      <div className="toolbar">
        <h2 className="section-title">Job Assignments — assign a truck &amp; driver to each job</h2>
        <div className="list-filter">
          <input
            type="text"
            className="job-search-input"
            placeholder="Search jobs (customer, address, job ID, truck, driver)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className="btn secondary"
          style={{ color: 'var(--red)' }}
          onClick={onResetToSampleData}
          title="Clear all local changes and reload the original sample data — asks twice before doing anything"
        >
          Reset to sample data
        </button>
      </div>
      {query.trim() && !filteredJobs.length ? (
        <div className="empty">No jobs match "{query}".</div>
      ) : (
        <JobAssignments
          trucks={trucks} drivers={drivers} jobs={filteredJobs} conflictIds={conflictIds}
          onSetJobSingleTruck={onSetJobSingleTruck}
          onToggleJobTruck={onToggleJobTruck}
          onUpdateJobField={onUpdateJobField}
          onAddExtraTruck={onAddExtraTruck}
          onSetJobTruckDriver={onSetJobTruckDriver}
        />
      )}
    </section>
  );
}
