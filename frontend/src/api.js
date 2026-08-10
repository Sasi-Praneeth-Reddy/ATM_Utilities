// Thin fetch wrapper around the backend REST API. No local storage anywhere — the backend URL
// comes from a `?api=` query param (falls back to localhost:8787) and is otherwise only ever
// held in memory for the lifetime of the page.

export const DEFAULT_BACKEND_URL = 'http://localhost:8787';

export function initialBackendUrl() {
  return new URLSearchParams(window.location.search).get('api') || DEFAULT_BACKEND_URL;
}

export function normalizeBackendUrl(url) {
  return (url || DEFAULT_BACKEND_URL).trim().replace(/\/$/, '');
}

export async function apiCall(backendUrl, method, path, body) {
  const res = await fetch(backendUrl + path, {
    method,
    // Sends/receives the httpOnly session cookie even though the frontend (:5173) and backend
    // (:8787) are different origins in dev. This is session state, not app data — distinct from
    // the "nothing in local storage" rule, which is about trucks/drivers/jobs living only in the
    // backend's database, not about how the login session itself is carried.
    credentials: 'include',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json()).error || '';
    } catch (e) {
      // response wasn't JSON — ignore, we'll just show the status code
    }
    const err = new Error(`Backend returned ${res.status}${detail ? ' — ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}
