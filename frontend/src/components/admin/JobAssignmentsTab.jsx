import { useMemo, useState } from 'react';
import JobAssignments from './JobAssignments';
import { jobTrucks, jobTruckLabel } from '../../utils/jobs';

/** Matches a job against a lowercased search term across every field a dispatcher would plausibly
 * filter this list by — customer name, either SmartMoving id, both addresses, and whichever
 * truck/driver it's currently assigned to (so "who's on Truck 3" or "who's driving with Mike"
 * works too, not just "find this customer"). */
export function matchesQuery(job, trucks, drivers, q) {
  const ts = jobTrucks(trucks, job);
  const driverNames = ts.map((t) => (t.driverId ? drivers.find((d) => d.id === t.driverId)?.name : null)).filter(Boolean);
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
 * the list in place is all that's needed. */
export default function JobAssignmentsTab({ trucks, drivers, jobs, conflictIds, onSetJobSingleTruck, onToggleJobTruck, onUpdateJobField, onAddExtraTruck }) {
  const [query, setQuery] = useState('');

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => matchesQuery(j, trucks, drivers, q));
  }, [jobs, trucks, drivers, query]);

  return (
    <section>
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
        />
      )}
    </section>
  );
}
