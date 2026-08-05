/**
 * Maps raw SmartMoving API responses onto the job shape the ATM Scheduler frontend expects
 * (see the `jobs` array in atm-scheduler.html). Imported jobs always start with `truckIds: []`
 * — truck/driver assignment happens locally in the scheduler, not in SmartMoving.
 */

const OPPORTUNITY_STATUS = {
  0: 'NewLead',
  1: 'LeadInProgress',
  3: 'Opportunity',
  4: 'Booked',
  10: 'Completed',
  11: 'Closed',
  20: 'Cancelled',
  30: 'Lost',
  50: 'BadLead',
};

/** SmartMoving's `From`/`To`/date fields use a yyyyMMdd integer, e.g. 20260805 -> "2026-08-05". */
function smartMovingIntDateToIso(n) {
  if (!n && n !== 0) return null;
  const s = String(n);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * startTimeUtc/endTimeUtc come back as full ISO date-times in UTC. Converting to the branch's
 * local wall-clock time requires knowing the branch's timezone, which isn't exposed by any
 * endpoint we found (BranchListViewModel has no tz field) — so for now this takes the UTC
 * clock time as-is. Flagged clearly here and in the README; fix once a branch timezone source
 * is confirmed (e.g. a manual per-branch config value).
 */
function utcIsoToHHMM(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function hoursBetween(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const start = new Date(startIso), end = new Date(endIso);
  if (isNaN(start) || isNaN(end)) return null;
  const hrs = (end - start) / 3600000;
  return hrs > 0 ? Math.round(hrs * 2) / 2 : null;
}

function pickStop(stops, predicate) {
  return (stops || []).find(predicate) || null;
}

/**
 * SmartMoving doesn't expose a direct "is this long-distance" flag on the job itself — that
 * lives on the opportunity's `opportunityType` (0 Local, 1 Intrastate, 2 Interstate), which
 * would need an extra `Get opportunity details` call per job. To keep this to one call per job,
 * this falls back to comparing origin/destination state — good enough to seed the scheduler's
 * local/long_distance split, but swap in opportunityType once it's wired up for accuracy.
 *
 * The per-job `stops` array (from GET .../opportunities/{id}/jobs) doesn't reliably carry a
 * `state` field on each stop — confirmed by running this against sample data, where stop
 * objects only had an address string. The lead record (GET /api/leads) DOES carry
 * originState/destinationState, so that's used as the primary source, with the stop-level
 * field kept as a fallback in case a future job shape includes it.
 */
function inferJobType(origin, destination, lead) {
  const originState = lead?.originState || origin?.state;
  const destState = lead?.destinationState || destination?.state;
  if (originState && destState && originState !== destState) return 'long_distance';
  return 'local';
}

/**
 * @param {object} lead - one entry from GET /api/leads (LeadViewModel)
 * @param {object} job - one entry from GET /api/premium/opportunities/{id}/jobs (JobViewModel)
 */
function mapSmartMovingJob(lead, job) {
  const stops = job.stops || [];
  const origin = pickStop(stops, s => s.isOrigin) || {};
  const destination = pickStop(stops, s => s.isDestination) || {};

  const date = smartMovingIntDateToIso(job.jobDate) || smartMovingIntDateToIso(lead.serviceDate);
  const type = inferJobType(origin, destination, lead);
  const duration = hoursBetween(job.startTimeUtc, job.endTimeUtc);

  return {
    id: `SM-${job.jobNumber || job.id}`,
    smartMovingJobId: job.id,
    smartMovingOpportunityId: lead.id,
    customer: lead.customerName || 'Unknown Customer',
    type,
    date,
    endDate: date, // SmartMoving doesn't return a job-level end date for multi-day LD moves via
                    // this endpoint; until that's confirmed, treat every imported job as single-day
                    // and let dispatchers extend `endDate` manually in the scheduler for LD runs.
    startTime: utcIsoToHHMM(job.startTimeUtc),
    duration: duration || 2,
    origin: origin.addressFullAddress || lead.originAddressFull || '',
    destination: destination.addressFullAddress || lead.destinationAddressFull || '',
    crewSize: Array.isArray(job.crewMembers) ? job.crewMembers.length : undefined,
    truckIds: [],       // truck/driver assignment always happens locally in the scheduler
    trucksNeeded: 1,    // bump manually in Job Assignments for jobs that need more than one truck
    status: 'scheduled',
    miles: undefined,   // not returned by these endpoints; leave for manual entry if needed
    source: 'smartmoving',
    smartMovingStatus: OPPORTUNITY_STATUS[lead.status] || lead.status,
  };
}

module.exports = { mapSmartMovingJob, smartMovingIntDateToIso, utcIsoToHHMM, hoursBetween, OPPORTUNITY_STATUS };
