/**
 * Stand-in for api-public.smartmoving.com, shaped like the real responses documented in the
 * dev portal, purely so server.js can be exercised end-to-end without a real SmartMoving
 * account. Point SMARTMOVING_BASE_URL at this server's URL to test.
 *
 *   node mock-smartmoving-server.js        # starts on :8788
 *   SMARTMOVING_BASE_URL=http://localhost:8788 SMARTMOVING_API_KEY=test-key node server.js
 */
const http = require('http');

const LEADS = [
  {
    id: 'opp-kessler-001', customerName: 'Harold & Anne Kessler', emailAddress: 'kessler@example.com',
    serviceDate: 20260805, status: 4, // Booked
    originAddressFull: 'Denver, CO', originState: 'CO',
    destinationAddressFull: 'Phoenix, AZ', destinationState: 'AZ',
    createdAtUtc: '2026-07-20T12:00:00Z',
  },
  {
    id: 'opp-thompson-002', customerName: 'Sarah Thompson', emailAddress: 'sthompson@example.com',
    serviceDate: 20260806, status: 4, // Booked
    originAddressFull: '1420 Larimer St, Denver, CO', originState: 'CO',
    destinationAddressFull: '880 Pearl St, Boulder, CO', destinationState: 'CO',
    createdAtUtc: '2026-07-22T09:00:00Z',
  },
  {
    id: 'opp-lead-003', customerName: 'Not Yet Booked', emailAddress: 'lead@example.com',
    serviceDate: 20260810, status: 1, // LeadInProgress -- should be filtered out by default
    originAddressFull: 'Denver, CO', originState: 'CO',
    destinationAddressFull: 'Denver, CO', destinationState: 'CO',
    createdAtUtc: '2026-08-01T09:00:00Z',
  },
];

const JOBS_BY_OPPORTUNITY = {
  'opp-kessler-001': [{
    id: 'job-kessler-1', jobNumber: 'J-90001', jobDate: 20260805,
    startTimeUtc: '2026-08-05T15:00:00Z', endTimeUtc: '2026-08-05T21:00:00Z',
    crewMembers: ['crew-1', 'crew-2', 'crew-3', 'crew-4'],
    stops: [
      { isOrigin: true, isDestination: false, addressFullAddress: 'Denver, CO' },
      { isOrigin: false, isDestination: true, addressFullAddress: 'Phoenix, AZ' },
    ],
  }],
  'opp-thompson-002': [{
    id: 'job-thompson-1', jobNumber: 'J-90002', jobDate: 20260806,
    startTimeUtc: '2026-08-06T14:00:00Z', endTimeUtc: '2026-08-06T17:00:00Z',
    crewMembers: ['crew-5', 'crew-6', 'crew-7'],
    stops: [
      { isOrigin: true, isDestination: false, addressFullAddress: '1420 Larimer St, Denver, CO' },
      { isOrigin: false, isDestination: true, addressFullAddress: '880 Pearl St, Boulder, CO' },
    ],
  }],
  // Deliberately no entry for opp-direct-004 — exercises the arrivalWindow fallback path in
  // mapOpportunity.js when the premium jobs-by-opportunity call has nothing for an opportunity.
};

// GET /api/opportunities/{id} (OpportunityDetailsViewModel) — the richer, basic-tier endpoint.
// opp-direct-004 is intentionally absent from LEADS above: it simulates a booking a staff member
// entered directly (POST /api/premium/opportunity) rather than through the lead pipeline, so the
// polling sweep (which walks GET /api/leads) can never find it — only a webhook can.
const OPPORTUNITIES = {
  'opp-kessler-001': {
    id: 'opp-kessler-001', quoteNumber: 90001,
    customer: { id: 'cust-1', name: 'Harold & Anne Kessler' },
    opportunityType: 2, // Interstate
    status: 4, // Booked
    serviceDate: 20260805,
    tripInfo: { isTripInfoApplied: true, confirmedPickupDate: 20260805, confirmedDeliveryDate: 20260808 },
    jobs: [{
      id: 'job-kessler-1', jobNumber: 'J-90001', jobDate: 20260805,
      jobAddresses: ['Denver, CO', 'Phoenix, AZ'],
      arrivalWindow: { startTime: 8, endTime: 12 },
      crewMembers: ['crew-1', 'crew-2', 'crew-3', 'crew-4'],
    }],
  },
  'opp-thompson-002': {
    id: 'opp-thompson-002', quoteNumber: 90002,
    customer: { id: 'cust-2', name: 'Sarah Thompson' },
    opportunityType: 0, // Local
    status: 4,
    serviceDate: 20260806,
    jobs: [{
      id: 'job-thompson-1', jobNumber: 'J-90002', jobDate: 20260806,
      jobAddresses: ['1420 Larimer St, Denver, CO', '880 Pearl St, Boulder, CO'],
      arrivalWindow: { startTime: 9, endTime: 11 },
      crewMembers: ['crew-5', 'crew-6', 'crew-7'],
    }],
  },
  'opp-lead-003': {
    id: 'opp-lead-003', quoteNumber: 90099,
    customer: { id: 'cust-3', name: 'Not Yet Booked' },
    opportunityType: 0,
    status: 1, // LeadInProgress — should never appear in schedulable-jobs output
    serviceDate: 20260810,
    jobs: [],
  },
  'opp-direct-004': {
    id: 'opp-direct-004', quoteNumber: 90004,
    customer: { id: 'cust-4', name: 'Diane Foster' },
    opportunityType: 0, // Local
    status: 4, // Booked — but never went through the lead pipeline, see comment above
    serviceDate: 20260807,
    jobs: [{
      id: 'job-direct-1', jobNumber: 'J-90004', jobDate: 20260807,
      jobAddresses: ['500 16th St, Denver, CO', '12 Lookout Mountain Rd, Golden, CO'],
      arrivalWindow: { startTime: 13, endTime: 15 },
      crewMembers: ['crew-8', 'crew-9'],
    }],
  },
  // Absent from LEADS AND only ever assigned to crew-9, whose status is "Inactive" — models a
  // real gap found 2026-08-10: filtering crew enumeration to Status=Active would silently miss
  // this job even though it's real, booked, and staffed. Proves getAllCrewMembers() with no
  // status filter finds it.
  'opp-inactive-crew-005': {
    id: 'opp-inactive-crew-005', quoteNumber: 90005,
    customer: { id: 'cust-5', name: 'Priya Shah' },
    opportunityType: 0, // Local
    status: 4, // Booked
    serviceDate: 20260808,
    jobs: [{
      id: 'job-inactive-crew-1', jobNumber: 'J-90005', jobDate: 20260808,
      jobAddresses: ['100 Speer Blvd, Denver, CO', '200 Union Blvd, Lakewood, CO'],
      arrivalWindow: { startTime: 9, endTime: 11 },
      crewMembers: ['crew-9'],
    }],
  },
  // Booked, with a job already created, but NO crew assigned to it at all (crewMembers: []) and
  // not present in LEADS or any CREW_JOBS entry — models the real gap reported 2026-08-10 that
  // neither /api/leads nor /api/crew-members/{id}/jobs can reach, since there's no crew member to
  // enumerate from. Only GET /api/customers (see CUSTOMERS below) can find this one.
  'opp-unstaffed-006': {
    id: 'opp-unstaffed-006', quoteNumber: 90006,
    customer: { id: 'cust-6', name: 'Marcus Webb' },
    opportunityType: 0, // Local
    status: 4, // Booked
    serviceDate: 20260809,
    jobs: [{
      id: 'job-unstaffed-1', jobNumber: 'J-90006', jobDate: 20260809,
      jobAddresses: ['300 Blake St, Denver, CO', '400 17th St, Denver, CO'],
      arrivalWindow: { startTime: 10, endTime: 12 },
      crewMembers: [],
    }],
  },
};

// GET /api/customers — confirmed live in the dev portal 2026-08-10. Real response shape is a
// customer-centric summary (not full opportunity/job detail — that still comes from
// OPPORTUNITIES above via getOpportunityDetails), used purely for discovery. Deliberately doesn't
// filter by FromServiceDate/ToServiceDate here — the mock only needs to prove pollSweep's parsing
// and dedup logic works, not reproduce SmartMoving's exact server-side date-filtering behavior
// (which can't be verified without a live account anyway).
const CUSTOMERS = [
  {
    id: 'cust-6', name: 'Marcus Webb',
    opportunities: [{
      id: 'opp-unstaffed-006', quoteNumber: '90006', status: 4,
      jobs: [{ id: 'job-unstaffed-1', jobNumber: 'J-90006', serviceDate: '20260809', type: 1 }],
    }],
  },
  {
    id: 'cust-3', name: 'Not Yet Booked',
    opportunities: [{ id: 'opp-lead-003', quoteNumber: '90099', status: 1, jobs: [] }],
  },
];

// Crew members + their jobs — models GET /api/crew-members and GET /api/crew-members/{id}/jobs,
// confirmed live in the dev portal 2026-08-10. Deliberately assigns opp-direct-004's job to
// crew-8: that opportunity is NOT in LEADS above (it simulates a direct booking that never went
// through the lead pipeline), so this is what proves the poll sweep's crew-jobs source finds it
// even with zero webhooks configured — the leads-based source alone cannot.
const CREW_MEMBERS = [
  { id: 'crew-1', name: 'Alex Rivera', status: 'Active' },
  { id: 'crew-8', name: 'Jordan Park', status: 'Active' },
  { id: 'crew-9', name: 'Sam Okafor', status: 'Inactive' },
];

const CREW_JOBS = {
  'crew-1': [
    { id: 'job-kessler-1', jobNumber: 'J-90001', opportunityId: 'opp-kessler-001', serviceType: 1, serviceDate: 20260805 },
  ],
  'crew-8': [
    { id: 'job-direct-1', jobNumber: 'J-90004', opportunityId: 'opp-direct-004', serviceType: 1, serviceDate: 20260807 },
  ],
  // Inactive, but still has a real job — proves getAllCrewMembers() must NOT filter by status.
  'crew-9': [
    { id: 'job-inactive-crew-1', jobNumber: 'J-90005', opportunityId: 'opp-inactive-crew-005', serviceType: 1, serviceDate: 20260808 },
  ],
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.headers['x-api-key'] !== undefined && req.headers['x-api-key'] === '') {
    return json(res, 401, { error: 'Missing x-api-key header' });
  }

  if (url.pathname === '/v1/api/leads') {
    const from = Number(url.searchParams.get('From'));
    const to = Number(url.searchParams.get('To'));
    const results = LEADS.filter(l => (!from || l.serviceDate >= from) && (!to || l.serviceDate <= to));
    return json(res, 200, {
      pageNumber: 1, pageSize: 100, lastPage: true, totalPages: 1,
      totalResults: results.length, totalThisPage: results.length,
      pageResults: results,
    });
  }

  // Basic-tier "Get jobs by opportunityId" — confirmed live path has no /premium/ segment.
  const jobsMatch = url.pathname.match(/^\/v1\/api\/opportunities\/([^/]+)\/jobs$/);
  if (jobsMatch) {
    const opportunityId = jobsMatch[1];
    return json(res, 200, JOBS_BY_OPPORTUNITY[opportunityId] || []);
  }

  if (url.pathname === '/v1/api/crew-members') {
    const status = url.searchParams.get('Status');
    const results = CREW_MEMBERS.filter(c => !status || c.status === status);
    return json(res, 200, {
      pageNumber: 1, pageSize: 100, lastPage: true, totalPages: 1,
      totalResults: results.length, totalThisPage: results.length, pageResults: results,
    });
  }

  const crewJobsMatch = url.pathname.match(/^\/v1\/api\/crew-members\/([^/]+)\/jobs$/);
  if (crewJobsMatch) {
    const crewMemberId = crewJobsMatch[1];
    const results = CREW_JOBS[crewMemberId] || [];
    return json(res, 200, {
      pageNumber: 1, pageSize: 100, lastPage: true, totalPages: 1,
      totalResults: results.length, totalThisPage: results.length, pageResults: results,
    });
  }

  if (url.pathname === '/v1/api/customers') {
    // Real response is a plain array, not a {pageResults} wrapper — confirmed live 2026-08-10.
    const page = Number(url.searchParams.get('Page')) || 1;
    const pageSize = Number(url.searchParams.get('PageSize')) || 100;
    const start = (page - 1) * pageSize;
    return json(res, 200, CUSTOMERS.slice(start, start + pageSize));
  }

  const oppMatch = url.pathname.match(/^\/v1\/api\/opportunities\/([^/]+)$/);
  if (oppMatch) {
    const opportunity = OPPORTUNITIES[oppMatch[1]];
    if (!opportunity) return json(res, 400, { error: 'Opportunity not found' });
    return json(res, 200, opportunity);
  }

  json(res, 404, { error: 'Not found in mock server: ' + url.pathname });
});

const PORT = process.env.MOCK_PORT || 8788;
server.listen(PORT, () => console.log(`Mock SmartMoving API listening on http://localhost:${PORT}`));
