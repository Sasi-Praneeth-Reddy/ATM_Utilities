/**
 * Maps SmartMoving's `GET /api/opportunities/{id}` response (OpportunityDetailsViewModel) onto
 * the scheduler's job shape. This is the primary hydration path for webhook-driven ingestion,
 * since a webhook payload only ever gives an opportunity-id or job-id — see server.js.
 *
 * Why this endpoint instead of the older lead+premium-jobs pair in mapJobs.js:
 *  - `opportunityType` (0 Local / 1 Intrastate / 2 Interstate) is the authoritative long-distance
 *    flag SmartMoving actually uses internally. mapJobs.js's `inferJobType` has to guess from
 *    address states because the older code path (GET /api/leads + premium jobs-by-opportunity)
 *    never had access to this field.
 *  - `tripInfo.confirmedPickupDate`/`confirmedDeliveryDate` give the real multi-day date range
 *    for a long-distance move — the premium jobs endpoint has no equivalent, which is why
 *    long-distance imports were landing as single-day (see README "Known limitations").
 *  - It's tagged "basic opportunities" in the dev portal, not "premium" — confirm on your
 *    account, but this should work even without the Premium tier upgrade.
 *
 * Trade-off: this endpoint's per-job time field is `arrivalWindow` (a window, e.g. "8am-12pm"),
 * not an exact start/end timestamp like the premium jobs endpoint's `startTimeUtc`/`endTimeUtc`.
 * So `mapOpportunityToJobs` accepts an optional `premiumJobsById` map (job id -> premium job
 * object) to prefer exact timing when it's available, and falls back to `arrivalWindow` when it
 * isn't (e.g. on accounts without Premium access).
 */

const { smartMovingIntDateToIso, utcIsoToHHMM, hoursBetween, OPPORTUNITY_STATUS } = require('./mapJobs');

const OPPORTUNITY_TYPE = { 0: 'Local', 1: 'Intrastate', 2: 'Interstate' };

function opportunityTypeToJobType(t) {
  if (t === 1 || t === 2) return 'long_distance';
  if (t === 0) return 'local';
  return null; // unknown — caller should default to 'local'
}

/**
 * `arrivalWindow.startTime`/`endTime` are documented only as `number (double)`, with no unit
 * given. Treating them as hour-of-day decimals (e.g. 8.5 -> 8:30am) — consistent with how
 * SmartMoving represents `preferredPickupTime` elsewhere in the same API. Flagged as an
 * assumption; if imported start times look wrong once tested against a real account, this is
 * the first place to check.
 */
function hourDecimalToHHMM(h) {
  if (h === null || h === undefined || isNaN(h)) return null;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * @param {object} opportunity - response from getOpportunityDetails(opportunityId)
 * @param {object} [premiumJobsById] - optional { [jobId]: premiumJobObject } for exact timing,
 *   built from smartmovingClient.getJobsByOpportunityId(opportunityId) results.
 * @returns {object[]} scheduler job objects, one per job on the opportunity
 */
function mapOpportunityToJobs(opportunity, premiumJobsById = {}) {
  const jobs = opportunity.jobs || [];
  const inferredType = opportunityTypeToJobType(opportunity.opportunityType);
  const type = inferredType || 'local';
  const tripInfo = opportunity.tripInfo;
  const pickupDate = tripInfo && tripInfo.confirmedPickupDate ? smartMovingIntDateToIso(tripInfo.confirmedPickupDate) : null;
  const deliveryDate = tripInfo && tripInfo.confirmedDeliveryDate ? smartMovingIntDateToIso(tripInfo.confirmedDeliveryDate) : null;
  const customerName = (opportunity.customer && opportunity.customer.name) || 'Unknown Customer';
  const smartMovingStatusCode = opportunity.status;
  const smartMovingStatus = OPPORTUNITY_STATUS[opportunity.status] || opportunity.status;

  return jobs.map(job => {
    const premium = premiumJobsById[job.id];
    const addresses = job.jobAddresses || [];
    const origin = addresses[0] || '';
    const destination = addresses.length > 1 ? addresses[addresses.length - 1] : '';

    let date = smartMovingIntDateToIso(job.jobDate) || smartMovingIntDateToIso(opportunity.serviceDate);
    let endDate = date;
    if (type === 'long_distance' && pickupDate && deliveryDate) {
      // Real multi-day span from tripInfo, not a single-day guess.
      date = pickupDate;
      endDate = deliveryDate;
    }

    const startTime = premium ? utcIsoToHHMM(premium.startTimeUtc)
      : (job.arrivalWindow ? hourDecimalToHHMM(job.arrivalWindow.startTime) : null);
    const duration = premium ? hoursBetween(premium.startTimeUtc, premium.endTimeUtc) : null;

    return {
      id: `SM-${job.jobNumber || job.id}`,
      smartMovingJobId: job.id,
      smartMovingOpportunityId: opportunity.id,
      customer: customerName,
      type,
      date,
      endDate,
      startTime,
      duration: duration || 2,
      origin,
      destination,
      crewSize: Array.isArray(job.crewMembers) ? job.crewMembers.length : undefined,
      truckIds: [],
      trucksNeeded: 1,
      status: 'scheduled',
      miles: undefined,
      source: 'smartmoving',
      smartMovingStatus,
      smartMovingStatusCode,
    };
  });
}

module.exports = { mapOpportunityToJobs, opportunityTypeToJobType, hourDecimalToHHMM, OPPORTUNITY_TYPE };
