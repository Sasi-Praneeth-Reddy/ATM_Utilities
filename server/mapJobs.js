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

/** The statuses that count as "an actual job to dispatch," not just a quote or an inquiry — this
 * is the filter behind the 2026-08-18 "booked jobs only" sync redesign (see server.js's
 * hydrateOpportunity and README's "Webhooks vs. polling"). Deliberately excludes 0/1 (still pure
 * pipeline, nothing to schedule yet), 3 (quoted but not confirmed — could still fall through),
 * and the three negative-terminal statuses (20 Cancelled/30 Lost/50 BadLead — never should have
 * been on a live board). Includes 10 Completed/11 Closed alongside 4 Booked so a job that's
 * already been imported doesn't just vanish once it wraps up — those are still real jobs that
 * happened, useful for a dispatcher looking back at a recent day. */
const BOOKED_STATUSES = new Set([4, 10, 11]);

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

const { classifyJob } = require('./jobTypeInference');

/**
 * SmartMoving doesn't expose a direct "is this long-distance" flag on the job itself — that
 * lives on the opportunity's `opportunityType` (0 Local, 1 Intrastate, 2 Interstate), which
 * would need an extra `Get opportunity details` call per job (see mapOpportunity.js, which has
 * that field). To keep this to one call per job, this instead hands whatever address text is
 * available to jobTypeInference.js's classifyJob — real ZIP-based mileage where it can be
 * computed, falling back to the state-difference heuristic otherwise (see that module's header).
 *
 * The per-job `stops` array (from GET .../opportunities/{id}/jobs) doesn't reliably carry a
 * `state` field or a full address string on each stop — confirmed by running this against sample
 * data, where stop objects only had a bare address string in some cases. The lead record
 * (GET /api/leads) DOES carry originAddressFull/destinationAddressFull, so those are preferred
 * when present.
 */
function classifyFromStops(origin, destination, lead) {
  return classifyJob({
    originAddress: (lead && lead.originAddressFull) || (origin && origin.addressFullAddress) || null,
    destinationAddress: (lead && lead.destinationAddressFull) || (destination && destination.addressFullAddress) || null,
  });
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
  const { type, serviceCategory, miles } = classifyFromStops(origin, destination, lead);
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
    miles,              // computed from address ZIPs — see jobTypeInference.js; null if unreadable
    serviceCategory,
    source: 'smartmoving',
    smartMovingStatus: OPPORTUNITY_STATUS[lead.status] || lead.status,
  };
}

module.exports = { mapSmartMovingJob, smartMovingIntDateToIso, utcIsoToHHMM, hoursBetween, OPPORTUNITY_STATUS, BOOKED_STATUSES };
