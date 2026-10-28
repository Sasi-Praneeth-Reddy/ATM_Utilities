import { apiCall } from '../../api';

export async function fetchLeadsSummary(backendUrl) {
  return apiCall(backendUrl, 'GET', '/api/leads/summary');
}

export async function fetchLeadsAnalytics(backendUrl) {
  return apiCall(backendUrl, 'GET', '/api/leads/analytics');
}

export async function fetchMatchedLeads(backendUrl, status = 'all') {
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
  return apiCall(backendUrl, 'GET', `/api/leads/matches${query}`);
}

export async function fetchOutreachDraft(backendUrl, matchId) {
  return apiCall(backendUrl, 'GET', `/api/leads/matches/${encodeURIComponent(matchId)}/draft`);
}

export async function updateMatchStatus(backendUrl, matchId, status, notes = '') {
  return apiCall(backendUrl, 'POST', `/api/leads/matches/${encodeURIComponent(matchId)}/status`, { status, notes });
}

export async function sendOutreach(backendUrl, matchId, payload) {
  return apiCall(backendUrl, 'POST', `/api/leads/matches/${encodeURIComponent(matchId)}/send-outreach`, payload);
}

export async function fetchListings(backendUrl, { status, state, county, search, minPrice, maxPrice, month, limit = 100, offset = 0, after } = {}) {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (state && state !== 'all') params.set('state', state);
  if (county && county !== 'all') params.set('county', county);
  if (search) params.set('search', search);
  if (minPrice) params.set('minPrice', String(minPrice));
  if (maxPrice) params.set('maxPrice', String(maxPrice));
  if (month && month !== 'all') params.set('month', month);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  // `after` = the previous page's endCursor: lets the server fetch just this page instead of skipping `offset` documents.
  if (after) params.set('after', after);
  return apiCall(backendUrl, 'GET', `/api/leads/listings?${params.toString()}`);
}

export async function importLegacyCustomers(backendUrl, customers) {
  return apiCall(backendUrl, 'POST', '/api/leads/import-legacy-customers', { customers });
}

export async function triggerReconcile(backendUrl) {
  return apiCall(backendUrl, 'POST', '/api/leads/reconcile', {});
}
