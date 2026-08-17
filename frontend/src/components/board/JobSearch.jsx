import { useMemo, useState } from 'react';
import { fmtRange } from '../../utils/dates';
import { jobTruckIds, jobTruckLabel } from '../../utils/jobs';

/** Matches a job against a lowercased search term across every field a dispatcher would
 * plausibly search by — customer name, either SmartMoving id, and both addresses — not just the
 * customer name, since "where's the Larimer St job" is as likely a search as a customer's name. */
function matchesQuery(job, q) {
  const haystack = [
    job.customer, job.id, job.origin, job.destination,
    job.smartMovingJobId, job.smartMovingOpportunityId,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

/**
 * Search box for finding a job and jumping the board straight to the day it's scheduled on —
 * "where is the Thompson job" instead of clicking through dates one at a time. Lives in
 * BoardTab's toolbar so it's available from both day and month view; picking a result always
 * switches to day view (via onJumpToJob) since that's the one place a job's exact truck/time is
 * visible, and BoardTab briefly highlights the job once the board lands on that date.
 */
export default function JobSearch({ jobs, trucks, onJumpToJob }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return jobs
      .filter((j) => matchesQuery(j, q))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 10);
  }, [jobs, query]);

  function handlePick(job) {
    onJumpToJob(job);
    setQuery('');
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { setQuery(''); setOpen(false); e.currentTarget.blur(); }
    if (e.key === 'Enter' && results.length) handlePick(results[0]);
  }

  return (
    <div className="job-search">
      <input
        type="text"
        className="job-search-input"
        placeholder="Search jobs (customer, address, job ID)…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
      />
      {open && query.trim() && (
        <div className="job-search-results">
          {results.length ? results.map((j) => (
            <button
              type="button"
              key={j.id}
              className="job-search-result"
              // Keeps the input focused through the click so the onBlur above doesn't close this
              // dropdown before the click has a chance to register.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handlePick(j)}
            >
              <span className="jsr-customer">{j.customer}</span>
              <span className="jsr-meta">
                {j.type === 'long_distance' ? `Long distance · ${fmtRange(j)}` : j.date}
                {' · '}{jobTruckIds(j).length ? jobTruckLabel(trucks, j) : 'Unassigned'}
              </span>
            </button>
          )) : (
            <div className="job-search-empty">No jobs match "{query}"</div>
          )}
        </div>
      )}
    </div>
  );
}
