import { useMemo, useState } from 'react';
import { fmtRange } from '../../utils/dates';
import { jobTruckIds, jobTruckLabel } from '../../utils/jobs';

/** Matches a job against a lowercased search term across every field a dispatcher would
 * plausibly search by — customer name, any SmartMoving id, and both addresses — not just the
 * customer name, since "where's the Larimer St job" is as likely a search as a customer's name. */
function matchesQuery(job, q) {
  const haystack = [
    job.customer, job.id, job.origin, job.destination,
    job.smartMovingJobId, job.smartMovingOpportunityId, job.smartInsightsQuoteNumber,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

/** The customer-facing job/opportunity number to show next to a result, if this job has one worth
 * showing — a plain generated Firestore doc id isn't meaningful to a dispatcher, but the number
 * SmartMoving itself uses for the job is. Matters most now that one opportunity can produce
 * several jobs on the board with the SAME customer name (see mapSmartInsightsRow.js's file header
 * — e.g. "24100-1"/"24100-2"/"24100-3" all "Brown, Byron") — without this, those look like
 * indistinguishable duplicate rows in the results list. Returns null for placeholder jobs, which
 * have no such number.
 *
 * Bug fixed 2026-08-31 (reported: the SI number disappeared from search results for jobs that
 * clearly have one): this used to branch on `job.source` alone — smartInsightsQuoteNumber only
 * for 'smartmoving-insights', smartMovingJobId/smartMovingOpportunityId only for 'smartmoving'.
 * But db.js's calendar merge (mergeCalendarDataOntoExistingJob/upsertSmartMovingJob) deliberately
 * flips a Smart-Insights-originated job's `source` to 'smartmoving' the moment the calendar sync
 * enriches it — "an upgrade, not a demotion" — while leaving smartInsightsQuoteNumber itself
 * untouched (smFields never includes it). Once that flip happened, this function stopped looking
 * at smartInsightsQuoteNumber and fell back to smartMovingJobId instead — which, for a job that
 * came from Smart Insights and was only ever merged with CALENDAR data (never the REST poll), is
 * actually the Google Calendar event's iCal UID (see mapIcalEvent.js's mapIcalEventToJob), not a
 * real job number — so the truly meaningful number silently stopped showing. This got more visible
 * after the 2026-08-31 branch-filter removal (server.js), since more jobs now get calendar-merged
 * than before. Fix: check smartInsightsQuoteNumber first regardless of source — it's set once and
 * never overwritten, so it stays valid and meaningful even after a job's source label changes. */
// Fixed 2026-09-30 (reported: REST/webhook-synced jobs showed a long GUID like
// "#53ef2ff6-b8e6-…" instead of the job number): for jobs from the REST poll / webhooks,
// smartMovingJobId and smartMovingOpportunityId are SmartMoving's internal GUIDs, never the number
// dispatchers use. The real job number ("24508-1") is embedded in the board id instead —
// mapOpportunity.js/mapJobs.js build it as `SM-<jobNumber>` (Smart Insights: `SI-<jobNumber>`).
// So: quote number first, then the number parsed from the board id, then a smartMovingJobId only
// if it's NOT a GUID / iCal UID. Never show a GUID.
const LOOKS_LIKE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function jobIdNumber(job) {
  if (job.smartInsightsQuoteNumber) return job.smartInsightsQuoteNumber;
  const fromId = String(job.id || '').match(/^(?:SM|SI)-(\d+(?:-\d+)?)$/);
  if (fromId) return fromId[1];
  const smId = job.smartMovingJobId;
  if (smId && !LOOKS_LIKE_GUID.test(smId) && /^\d+(-\d+)?$/.test(smId)) return smId;
  return null;
}

/**
 * Search box for finding a job and jumping the board straight to the day it's scheduled on —
 * "where is the Thompson job" instead of clicking through dates one at a time. Lives in
 * BoardTab's toolbar so it's available from both day and month view; picking a result always
 * switches to day view (via onJumpToJob) since that's the one place a job's exact truck/time is
 * visible, and BoardTab briefly highlights the job once the board lands on that date.
 */
export default function JobSearch({ jobs, trucks, onJumpToJob, placeholder = 'Search jobs (customer, address, job ID)…', emptyNoun = 'jobs' }) {
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
        placeholder={placeholder}
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
              <span className="jsr-title">
                <span className="jsr-customer">{j.customer}</span>
                {jobIdNumber(j) && <span className="jsr-id">#{jobIdNumber(j)}</span>}
              </span>
              <span className="jsr-meta">
                {j.type === 'long_distance' ? `Long distance · ${fmtRange(j)}` : j.date}
                {' · '}{jobTruckIds(j).length ? jobTruckLabel(trucks, j) : 'Unassigned'}
              </span>
            </button>
          )) : (
            <div className="job-search-empty">No {emptyNoun} match "{query}"</div>
          )}
        </div>
      )}
    </div>
  );
}
