/**
 * Maps a JOINED (All Jobs row + matching Booked Opportunities row) record into the scheduler's job
 * shape — the Smart-Insights analog of mapOpportunity.js's mapOpportunityToJobs() for the live
 * SmartMoving REST poll.
 *
 * Two-report join (see smartInsightsSync.js's file header for the full design): the All Jobs
 * report (smartInsightsAllJobsReport.js) is job-level and has no customer/address columns at all;
 * the Booked Opportunities report (smartInsightsReport.js) is opportunity-level and has customer
 * name/address/sales person, keyed by the same id (e.g. "24100") that prefixes every one of that
 * opportunity's Job Numbers ("24100-1", "24100-2", "24100-3"). mapAllJobsRowToJob() below takes one
 * row from each and produces one job per All Jobs row, carrying the shared opportunity's customer
 * identity onto every one of its jobs.
 *
 * Deliberately narrow: only the fields the scheduler's job schema already had before this report
 * existed (see db.js's jobData()) get populated — everything else in either report's ~20-65
 * columns is available in each row's own `raw` field (see the two report parsers) if a future need
 * comes up, but isn't stored in Firestore. There's no crew size, no arrival window, no per-stop
 * detail in what gets stored; startTime/duration/crewSize are left null rather than guessed, same
 * as before — the board already handles null startTime for other job types (see
 * frontend/src/components/board/JobVisuals.jsx), and trucksNeeded defaults to 1 like a manually
 * created placeholder does, so dispatchers still assign trucks/drivers themselves.
 */

const { classifyJob } = require('./jobTypeInference');

/** Service Type / Type is free text in both reports (18+ distinct values seen in the real Booked
 * Opportunities report, e.g. "Moving", "Long Distance Moving", "Moving and Packing"; the All Jobs
 * report's own Type column uses a different but overlapping vocabulary, e.g. "Moving", "LOAD:
 * Gov't/3rd Party Crated OA"). Both texts are joined and handed to jobTypeInference.js's
 * classifyJob — see that module's header for the shared long_distance/serviceCategory/mileage
 * logic this used to duplicate locally (bug fixed 2026-08-27, same class as mapIcalEvent.js's own
 * inferJobType fix — see its comment for the full story on job 23929-2: checking only ONE of the
 * two report's type texts could miss a "long distance" that only showed up in the other one). */
function classifyFromRow(row, opportunity) {
  return classifyJob({
    jobTypeLabel: [row.type, opportunity && opportunity.serviceType].filter(Boolean).join(' '),
    originAddress: opportunity && opportunity.movingFrom,
    destinationAddress: opportunity && opportunity.movingTo,
  });
}

/**
 * @param {object} row one row from smartInsightsAllJobsReport.js's parseAllJobsRows() — the caller
 *   (smartInsightsSync.js) only pre-filters out rows whose OWN Custom Lead Status is explicitly
 *   terminal (Dead/Cancelled/etc — see its TERMINAL_JOB_STATUSES); it does NOT require this row's
 *   status to read exactly "Booked" (changed 2026-08-31 — that column is frequently blank even on
 *   real, currently-booked jobs, see smartInsightsSync.js's TERMINAL_JOB_STATUSES comment for the
 *   full story on job 23996). This function doesn't check status at all, only shape.
 * @param {object|null} opportunity the row from smartInsightsReport.js's parseRows() whose Quote #
 *   equals this job's opportunity id (smartInsightsAllJobsReport.js's
 *   opportunityIdFromJobNumber(row.jobNumber)) — or null/undefined if no such opportunity was
 *   found in the current sync run's Booked Opportunities data. THIS is the real "is it actually
 *   booked" gate now, not the row's own status column — the Booked Opportunities report only ever
 *   lists booked opportunities in the first place.
 * @returns {object|null} a job object ready for db.upsertSmartInsightsJob(), or null if the row
 *   can't be mapped: no job number/date to schedule against, or — just as importantly — no
 *   matching opportunity. A job with no matching opportunity is skipped rather than added with a
 *   placeholder customer name, by design: this report has no customer data of its own, and a job
 *   the dispatcher can't identify by customer isn't useful on the board. It'll pick up on a later
 *   sync once/if its opportunity shows up in a Booked Opportunities report — which re-lists every
 *   still-open booked opportunity daily WITHIN THAT REPORT'S OWN SERVICE-DATE WINDOW (confirmed
 *   2026-08-31 to be a rolling window, not literally every booked opportunity regardless of age —
 *   see smartInsightsSync.js's file header).
 */
function mapAllJobsRowToJob(row, opportunity) {
  if (!row.jobNumber || !row.jobDate) return null;
  if (!opportunity) return null;

  const { type, serviceCategory, miles } = classifyFromRow(row, opportunity);

  return {
    id: `SI-${row.jobNumber}`,
    customer: opportunity.customerName || `Quote ${row.jobNumber}`,
    type,
    date: row.jobDate,
    endDate: null,
    startTime: null,
    duration: null,
    origin: opportunity.movingFrom || null,
    destination: opportunity.movingTo || null,
    crewSize: null,
    truckIds: [],
    trucksNeeded: 1,
    status: 'scheduled',
    miles,
    serviceCategory,
    source: 'smartmoving-insights',
    // Holds the full JOB number ("24100-1"), not just the opportunity id — this is what makes each
    // sibling job (24100-1/2/3) get its own Firestore doc id (`SI-${smartInsightsQuoteNumber}`)
    // instead of colliding on one shared "24100" doc. Nothing else in the codebase parses this
    // field's contents (grep confirmed: db.js and the frontend only ever pass it through opaquely),
    // so this shape change is safe.
    smartInsightsQuoteNumber: row.jobNumber,
    smartInsightsStatus: row.customLeadStatus,
    smartInsightsEstimatedAmount: row.totalEstimatedCost,
    smartInsightsBranch: row.branchName,
    smartInsightsSalesPerson: opportunity.salesPerson || null,
  };
}

module.exports = { mapAllJobsRowToJob };
