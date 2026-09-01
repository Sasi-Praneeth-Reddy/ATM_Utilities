// Thin fetch wrapper around the backend REST API. No local storage anywhere — the backend URL
// comes from a `?api=` query param and is otherwise only ever held in memory for the lifetime of
// the page.
//
// Default depends on how the frontend itself is being served:
//  - `npm run dev` (Vite dev server on :5173): defaults to localhost:8787 — the backend runs as a
//    separate process on a different port in local dev, so this has to be cross-origin.
//  - The production build: defaults to '' (same origin). In production, server.js itself serves
//    this built frontend directly (see its serveStatic() function) alongside the API — one AWS App
//    Runner container, one origin — so the frontend and backend are the SAME origin from the
//    browser's point of view — no CORS, and the session cookie just works without SameSite/
//    cross-site headaches. `backendUrl + path` with backendUrl = '' simply hits the current origin.
// The `?api=` override still works in both cases, for pointing a deployed frontend at a different
// backend (e.g. a staging App Runner service) without a rebuild.
export const DEFAULT_BACKEND_URL = import.meta.env.DEV ? 'http://localhost:8787' : '';

export function initialBackendUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get('api');
  return fromQuery !== null ? fromQuery : DEFAULT_BACKEND_URL;
}

export function normalizeBackendUrl(url) {
  return (url ?? DEFAULT_BACKEND_URL).trim().replace(/\/$/, '');
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
