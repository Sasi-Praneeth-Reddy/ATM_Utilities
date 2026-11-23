import { useEffect, useMemo, useState, useTransition } from 'react';
import JobAssignments from './JobAssignments';
import SyncPanel from './SyncPanel';
import { jobTrucks, jobTruckLabel } from '../../utils/jobs';
import { todayStr } from '../../utils/dates';
import LoadingScreen from '../LoadingScreen';
import { usePageSearch } from '../../hooks/usePageSearch';

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
 * REMOVED 2026-09-30 (user request — production is live on real data, a one-click wipe is too
 * risky): the "Reset to sample data" button. Historical note: it was moved here 2026-09-10 from Trucks & Drivers, at the user's
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
  onOpenDeletedJobs,
}) {
  const [query, setQuery] = useState('');
  // Pagination (added 2026-09-30) — rendering every job at once (each row with truck + driver
  // dropdowns and a per-row driver-availability check across all jobs) made this tab slow to open
  // once SmartMoving had synced a few hundred jobs. `page` is 1-based; null = "not chosen yet",
  // which resolves to the page containing today's jobs rather than the oldest ones.
  const [pageSize, setPageSize] = useState(50);
  // Sort (2026-09-30, replaced the "Today" button): by date or customer name, asc/desc.
  const [sortBy, setSortBy] = useState('date'); // 'date' | 'name'
  // Default changed 2026-10-01 (user request): open on Newest first (date desc), page 1.
  const [sortDir, setSortDir] = useState('desc'); // 'asc' | 'desc'
  const [page, setPage] = useState(null);
  // Truck loading animation while the tab first renders / while switching pages.
  const [ready, setReady] = useState(false);
  const [isPending, startTransition] = useTransition();
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? jobs.filter((j) => matchesQuery(j, trucks, drivers, q)) : jobs;
    const dir = sortDir === 'desc' ? -1 : 1;
    const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
    const byName = (a, b) => (a.customer || '').localeCompare(b.customer || '', undefined, { sensitivity: 'base' });
    // Ties broken by the other key (always ascending) so the order is stable and predictable.
    const cmp = sortBy === 'name'
      ? (a, b) => dir * byName(a, b) || byDate(a, b)
      : (a, b) => dir * byDate(a, b) || byName(a, b);
    return [...list].sort(cmp);
  }, [jobs, trucks, drivers, query, sortBy, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredJobs.length / pageSize));
  // Date ascending (no search) opens on the page with today's jobs rather than the oldest ones;
  // every other sort — including the default Newest first — starts at page 1.
  const todayPage = useMemo(() => {
    if (sortBy !== 'date' || sortDir !== 'asc') return 1;
    const today = todayStr();
    const idx = filteredJobs.findIndex((j) => (j.endDate || j.date || '') >= today);
    return idx === -1 ? totalPages : Math.floor(idx / pageSize) + 1;
  }, [filteredJobs, pageSize, totalPages, sortBy, sortDir]);
  const currentPage = Math.min(Math.max(page ?? todayPage, 1), totalPages);
  const pageJobs = filteredJobs.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const firstShown = filteredJobs.length ? (currentPage - 1) * pageSize + 1 : 0;
  const lastShown = Math.min(currentPage * pageSize, filteredJobs.length);

  const goToPage = (n) => startTransition(() => setPage(Math.min(Math.max(n, 1), totalPages)));
  const onQueryChange = (value) => { setQuery(value); setPage(value.trim() ? 1 : null); };
  // The title-bar search box drives this page's job filter (it used to be a second box down here).
  usePageSearch({ id: 'assignments', placeholder: 'Search jobs (customer, address, job ID, truck, driver)…', value: query, onChange: onQueryChange });
  const onPageSizeChange = (size) => startTransition(() => { setPageSize(size); setPage(null); });
  const onSortByChange = (value) => startTransition(() => { setSortBy(value); setPage(query.trim() ? 1 : null); });
  const onToggleSortDir = () => startTransition(() => { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); setPage(query.trim() ? 1 : null); });

  const pager = (
    <div className="pager">
      <span className="pager-info">
        {filteredJobs.length ? `Showing ${firstShown}–${lastShown} of ${filteredJobs.length} jobs` : 'No jobs'}
      </span>
      <div className="pager-controls">
        <button className="btn secondary" onClick={() => goToPage(1)} disabled={currentPage <= 1} title="First page">«</button>
        <button className="btn secondary" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1}>‹ Prev</button>
        <span className="pager-page">Page {currentPage} of {totalPages}</span>
        <button className="btn secondary" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages}>Next ›</button>
        <button className="btn secondary" onClick={() => goToPage(totalPages)} disabled={currentPage >= totalPages} title="Last page">»</button>
        <label className="pager-size">
          Sort by{' '}
          <select value={sortBy} onChange={(e) => onSortByChange(e.target.value)}>
            <option value="date">Date</option>
            <option value="name">Name</option>
          </select>
        </label>
        <button
          className="btn secondary"
          onClick={onToggleSortDir}
          title={sortDir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
        >
          {sortBy === 'name' ? (sortDir === 'asc' ? 'A → Z ↑' : 'Z → A ↓') : (sortDir === 'asc' ? 'Oldest first ↑' : 'Newest first ↓')}
        </button>
        <label className="pager-size">
          Per page{' '}
          <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
            {[10, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
    </div>
  );

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
          {onOpenDeletedJobs && (
            <button type="button" className="btn secondary" onClick={onOpenDeletedJobs} title="View and restore deleted jobs">
              Deleted jobs
            </button>
          )}
        </div>
      </div>
      {query.trim() && !filteredJobs.length ? (
        <div className="empty">No jobs match "{query}".</div>
      ) : !ready ? (
        <LoadingScreen inline message="Loading job assignments" />
      ) : (
        <>
          {pager}
          <div className={`pager-body${isPending ? ' is-pending' : ''}`}>
            <JobAssignments
              trucks={trucks} drivers={drivers} jobs={pageJobs} allJobs={jobs} conflictIds={conflictIds}
              onSetJobSingleTruck={onSetJobSingleTruck}
              onToggleJobTruck={onToggleJobTruck}
              onUpdateJobField={onUpdateJobField}
              onAddExtraTruck={onAddExtraTruck}
              onSetJobTruckDriver={onSetJobTruckDriver}
            />
            {isPending && (
              <div className="pager-overlay"><LoadingScreen inline message="Loading jobs" /></div>
            )}
          </div>
          {pageJobs.length > 5 && pager}
        </>
      )}
    </section>
  );
}
