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

/** KPI numbers for the given filters (same filter params as fetchListings). */
export async function fetchFilteredStats(backendUrl, { status, state, county, search, minPrice, maxPrice, month } = {}) {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (state && state !== 'all') params.set('state', state);
  if (county && county !== 'all') params.set('county', county);
  if (search) params.set('search', search);
  if (minPrice) params.set('minPrice', String(minPrice));
  if (maxPrice) params.set('maxPrice', String(maxPrice));
  if (month && month !== 'all') params.set('month', month);
  return apiCall(backendUrl, 'GET', `/api/leads/stats?${params.toString()}`);
}

export async function fetchLegacyCustomers(backendUrl, limit = 5000) {
  return apiCall(backendUrl, 'GET', `/api/leads/legacy-customers?limit=${limit}`);
}

/** Downloads every listing matching the filters as a CSV (opens in Excel). Returns the row count. */
export async function downloadListingsCsv(backendUrl, { status, state, county, search, minPrice, maxPrice, month } = {}) {
  const params = new URLSearchParams();
  if (status && status !== 'all') params.set('status', status);
  if (state && state !== 'all') params.set('state', state);
  if (county && county !== 'all') params.set('county', county);
  if (search) params.set('search', search);
  if (minPrice) params.set('minPrice', String(minPrice));
  if (maxPrice) params.set('maxPrice', String(maxPrice));
  if (month && month !== 'all') params.set('month', month);
  const res = await fetch(`${backendUrl}/api/leads/export.csv?${params.toString()}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  saveBlob(blob, `pre-mover-leads-${new Date().toISOString().slice(0, 10)}.csv`);
  return Number(res.headers.get('X-Row-Count')) || null;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
