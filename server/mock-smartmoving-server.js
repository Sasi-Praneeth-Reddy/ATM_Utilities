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

  const jobsMatch = url.pathname.match(/^\/v1\/api\/premium\/opportunities\/([^/]+)\/jobs$/);
  if (jobsMatch) {
    const opportunityId = jobsMatch[1];
    return json(res, 200, JOBS_BY_OPPORTUNITY[opportunityId] || []);
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
