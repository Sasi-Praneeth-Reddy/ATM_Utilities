import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../api';

/**
 * Tracks the logged-in user (via the backend's httpOnly session cookie — nothing about the
 * session is held in local/session storage on this end). `status` starts at 'loading' until the
 * first /api/auth/me check resolves, so the app can avoid flashing a login screen before it knows.
 *
 * There's no password login anymore — everyone signs in with Microsoft (Entra ID), which is a full
 * page redirect (`microsoftLoginUrl`), not a fetch call. This hook mainly tracks who's currently
 * signed in and lets them sign out; `authError` surfaces what went wrong if the backend redirected
 * back with `?authError=...` (see App.jsx, which reads that query param once and clears it).
 */
export function useAuth(backendUrl) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'authenticated' | 'unauthenticated'
  const [authError, setAuthError] = useState('');
  // Distinct from "not logged in" — this means the initial check couldn't reach the backend at
  // all (network failure), not that it got a clean "you're not authenticated" response.
  const [connectionError, setConnectionError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const me = await apiCall(backendUrl, 'GET', '/api/auth/me');
      setUser(me);
      setStatus('authenticated');
      setConnectionError('');
      return true;
    } catch (err) {
      setUser(null);
      setStatus('unauthenticated');
      // err.status is only set for a real HTTP response (e.g. 401 "not logged in", which is the
      // normal/expected case pre-login). If it's missing, fetch() itself failed — the backend is
      // unreachable — which is worth telling the user about instead of just showing a blank form.
      setConnectionError(err.status === undefined ? `Can't reach the backend at ${backendUrl}. Is it running?` : '');
      return false;
    }
  }, [backendUrl]);

  useEffect(() => {
    setStatus('loading');
    refresh();
  }, [refresh]);

  const microsoftLoginUrl = `${backendUrl}/api/auth/microsoft/login`;

  const logout = useCallback(async () => {
    try {
      await apiCall(backendUrl, 'POST', '/api/auth/logout');
    } catch (err) {
      // Even if the request fails, treat the user as logged out locally — worst case they hit a
      // route that 401s and get bounced back here anyway.
    }
    setUser(null);
    setStatus('unauthenticated');
  }, [backendUrl]);

  /** Call when a scheduler API request comes back 401 mid-session (e.g. the session expired, or
      an admin deleted the account) — re-checks auth so the app falls back to the login screen. */
  const handleAuthError = useCallback(() => { refresh(); }, [refresh]);

  return { user, status, authError, setAuthError, connectionError, microsoftLoginUrl, logout, refresh, handleAuthError };
}
