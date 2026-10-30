import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../api';

/**
 * Tracks the logged-in user (via the backend's httpOnly session cookie — nothing about the
 * session is held in local/session storage on this end). `status` starts at 'loading' until the
 * first /api/auth/me check resolves, so the app can avoid flashing a login screen before it knows.
 *
 * Login is email + password (`login`), with a forgot-password/first-time-setup flow that runs on a
 * one-time emailed code (`forgotPassword` requests the code, `resetPassword` submits it along with
 * a new password) — see server/README.md "Login & accounts". All three are plain fetch calls, not
 * page redirects, so LoginScreen owns its own form/error state; this hook just updates `user`/
 * `status` once one of them succeeds.
 */
export function useAuth(backendUrl) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading'); // 'loading' | 'authenticated' | 'unauthenticated'
  // Distinct from "not logged in" — this means the initial check couldn't reach the backend at
  // all (network failure), not that it got a clean "you're not authenticated" response.
  const [connectionError, setConnectionError] = useState('');
  // Whether the backend has DEV_BYPASS_LOGIN active (local dev only — lets you sign in without a
  // password). false until the /api/auth/status check resolves.
  const [devBypassEnabled, setDevBypassEnabled] = useState(false);

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
      // backendUrl is '' for same-origin production hosting (see api.js) — "the backend at "
      // reads oddly with nothing after it, so name it explicitly in that case.
      const where = backendUrl || 'this site';
      const unreachableMsg = backendUrl
        ? `Can't reach the backend at ${where}. Is it running?`
        : "Can't connect to the ATM Hub server. Check your internet connection and try again.";
      setConnectionError(err.status === undefined ? unreachableMsg : '');
      return false;
    }
  }, [backendUrl]);

  useEffect(() => {
    setStatus('loading');
    refresh();
  }, [refresh]);

  useEffect(() => {
    apiCall(backendUrl, 'GET', '/api/auth/status')
      .then((s) => setDevBypassEnabled(Boolean(s.devBypassEnabled)))
      .catch(() => setDevBypassEnabled(false));
  }, [backendUrl]);

  const devLoginUrl = (role) => `${backendUrl}/api/auth/dev-login?role=${encodeURIComponent(role)}`;

  const login = useCallback(async (email, password) => {
    const me = await apiCall(backendUrl, 'POST', '/api/auth/login', { email, password });
    setUser(me);
    setStatus('authenticated');
    setConnectionError('');
  }, [backendUrl]);

  const forgotPassword = useCallback(async (email) => {
    await apiCall(backendUrl, 'POST', '/api/auth/forgot-password', { email });
  }, [backendUrl]);

  const resetPassword = useCallback(async (email, otp, newPassword) => {
    const me = await apiCall(backendUrl, 'POST', '/api/auth/reset-password', { email, otp, newPassword });
    setUser(me);
    setStatus('authenticated');
    setConnectionError('');
  }, [backendUrl]);

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

  return { user, status, connectionError, login, forgotPassword, resetPassword, devBypassEnabled, devLoginUrl, logout, refresh, handleAuthError };
}
