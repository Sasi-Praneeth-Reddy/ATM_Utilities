import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../api';

/** User accounts (admin-only). Separate from useSchedulerData since it's a much smaller, admin-
    only slice of data with no need for background polling — just refetch after each mutation. */
export function useUsers(backendUrl, enabled) {
  const [users, setUsers] = useState([]);
  const [allowedExternalEmails, setAllowedExternalEmails] = useState([]);

  const call = useCallback((method, path, body) => apiCall(backendUrl, method, path, body), [backendUrl]);

  const refresh = useCallback(async () => {
    try {
      const list = await call('GET', '/api/users');
      setUsers(list);
    } catch (err) {
      // Only admins can reach this — if it fails (e.g. role changed away from admin mid-session),
      // just leave the list empty rather than surfacing a separate error banner for it.
    }
  }, [call]);

  // Emails outside @aroundtownmovers.com that an admin has explicitly allowed — see db.js's
  // allowedExternalEmails doc comment and server.js's POST /api/users check. Fetched alongside
  // users since both live on the same admin-only Users page.
  const refreshAllowedExternalEmails = useCallback(async () => {
    try {
      const list = await call('GET', '/api/allowed-external-emails');
      setAllowedExternalEmails(list);
    } catch (err) {
      // Same reasoning as refresh() above — admin-only, fails silently if role changed mid-session.
    }
  }, [call]);

  useEffect(() => {
    if (enabled) { refresh(); refreshAllowedExternalEmails(); }
  }, [enabled, refresh, refreshAllowedExternalEmails]);

  const createUser = useCallback(async (fields) => {
    await call('POST', '/api/users', fields);
    await refresh();
  }, [call, refresh]);

  const changeRole = useCallback(async (id, role) => {
    await call('PATCH', `/api/users/${id}`, { role });
    await refresh();
  }, [call, refresh]);

  const deleteUser = useCallback(async (id) => {
    await call('DELETE', `/api/users/${id}`);
    await refresh();
  }, [call, refresh]);

  const addAllowedExternalEmail = useCallback(async (email, note) => {
    await call('POST', '/api/allowed-external-emails', { email, note });
    await refreshAllowedExternalEmails();
  }, [call, refreshAllowedExternalEmails]);

  const removeAllowedExternalEmail = useCallback(async (email) => {
    await call('DELETE', `/api/allowed-external-emails/${encodeURIComponent(email)}`);
    await refreshAllowedExternalEmails();
  }, [call, refreshAllowedExternalEmails]);

  return {
    users, refresh, createUser, changeRole, deleteUser,
    allowedExternalEmails, addAllowedExternalEmail, removeAllowedExternalEmail,
  };
}
