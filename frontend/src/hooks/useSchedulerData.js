import { useCallback, useEffect, useState } from 'react';
import { apiCall, initialBackendUrl, normalizeBackendUrl } from '../api';
import { addDays, daysBetween } from '../utils/dates';

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * All scheduler data (trucks/drivers/jobs) plus every mutation the UI can make. Mirrors the
 * original atm-scheduler.html's global-state + persist() pattern: every mutation updates local
 * state immediately (optimistic) and separately fires an API call to save it, surfacing a banner
 * if the save fails. There's no local storage anywhere — a failed save really did fail everywhere.
 *
 * One deliberate difference from the original: the old code polled every 15s but skipped
 * re-rendering entirely while an admin add-truck/add-driver form was open, since a full
 * innerHTML re-render would have wiped out whatever the user was mid-typing. That guard isn't
 * needed here — form inputs are their own component-local React state now, so a background data
 * refresh can't touch them.
 */
export function useSchedulerData() {
  const [backendUrl, setBackendUrlState] = useState(initialBackendUrl());
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendErrorMsg, setBackendErrorMsg] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ loading: false, message: '', error: null });

  const call = useCallback((method, path, body) => apiCall(backendUrl, method, path, body), [backendUrl]);

  /** Fire-and-forget persistence for a mutation already applied optimistically to local state.
      Surfaces a banner on failure instead of silently losing the change. */
  const persist = useCallback((method, path, body) => {
    call(method, path, body)
      .then(() => setBackendErrorMsg(''))
      .catch((err) => {
        setBackendErrorMsg(
          `Couldn't save your last change to the server (${err.message}). It may be lost on refresh — check your connection to ${backendUrl}.`
        );
      });
  }, [call, backendUrl]);

  const loadStateFromServer = useCallback(async () => {
    try {
      const state = await call('GET', '/api/state');
      setTrucks(state.trucks);
      setDrivers(state.drivers);
      setJobs(state.jobs);
      setBackendConnected(true);
      setBackendErrorMsg('');
      setLastSyncedAt(new Date());
      return true;
    } catch (err) {
      setBackendConnected(false);
      setBackendErrorMsg(err.message);
      return false;
    }
  }, [call]);

  // Initial load, and reload whenever the backend URL changes (e.g. the user retries with a
  // different one from the disconnected banner).
  useEffect(() => {
    loadStateFromServer();
  }, [loadStateFromServer]);

  // Background refresh every 15s so multiple tabs/devices converge on the same board. Only
  // swaps in new arrays when something actually changed, so unrelated components don't re-render
  // for no reason.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const state = await call('GET', '/api/state');
        setBackendConnected(true);
        setBackendErrorMsg('');
        setLastSyncedAt(new Date());
        setTrucks((prev) => (sameJSON(prev, state.trucks) ? prev : state.trucks));
        setDrivers((prev) => (sameJSON(prev, state.drivers) ? prev : state.drivers));
        setJobs((prev) => (sameJSON(prev, state.jobs) ? prev : state.jobs));
      } catch (err) {
        setBackendConnected(false);
        setBackendErrorMsg(err.message);
      }
    }, 15000);
    return () => clearInterval(id);
  }, [call]);

  const setBackendUrl = useCallback((url) => {
    setBackendUrlState(normalizeBackendUrl(url));
  }, []);

  const resetToSampleData = useCallback(() => {
    if (
      !window.confirm(
        'Reset the board back to the original sample data? This clears everything in the database (assignments, imported SmartMoving jobs, admin edits) for every device using this backend, and cannot be undone.'
      )
    ) {
      return;
    }
    call('POST', '/api/reset-to-sample-data')
      .then((state) => {
        setTrucks(state.trucks);
        setDrivers(state.drivers);
        setJobs(state.jobs);
      })
      .catch((err) => window.alert(`Couldn't reset: ${err.message}`));
  }, [call]);

  const syncNow = useCallback(async () => {
    setSyncStatus({ loading: true, message: '', error: null });
    try {
      const result = await call('POST', '/api/sync-now');
      setTrucks(result.state.trucks);
      setDrivers(result.state.drivers);
      setJobs(result.state.jobs);
      const errNote =
        result.errors && result.errors.length
          ? ` ${result.errors.length} opportunit${result.errors.length > 1 ? 'ies' : 'y'} couldn't be read — see console.`
          : '';
      if (result.errors && result.errors.length) console.warn('SmartMoving sync errors:', result.errors);
      setSyncStatus({
        loading: false,
        message: `Synced ${result.leadCount ?? 0} lead${result.leadCount === 1 ? '' : 's'} from SmartMoving.${errNote}`,
        error: null,
      });
    } catch (err) {
      setSyncStatus({ loading: false, message: '', error: `Sync failed: ${err.message}` });
    }
  }, [call]);

  /* ---------- Trucks & drivers CRUD ---------- */

  const createTruck = useCallback(async (fields) => {
    const truck = await call('POST', '/api/trucks', fields);
    setTrucks((prev) => [...prev, truck]);
    return truck;
  }, [call]);

  const createDriver = useCallback(async (fields) => {
    const driver = await call('POST', '/api/drivers', fields);
    setDrivers((prev) => [...prev, driver]);
    return driver;
  }, [call]);

  const updateTruckField = useCallback((id, field, value) => {
    setTrucks((prev) => prev.map((t) => (t.id === id ? { ...t, [field]: value } : t)));
    persist('PATCH', `/api/trucks/${id}`, { [field]: value });
  }, [persist]);

  const updateDriverField = useCallback((id, field, value) => {
    setDrivers((prev) => prev.map((d) => (d.id === id ? { ...d, [field]: value } : d)));
    persist('PATCH', `/api/drivers/${id}`, { [field]: value });
  }, [persist]);

  const updateTruckStatus = useCallback((id, status) => {
    setTrucks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    persist('PATCH', `/api/trucks/${id}`, { status });
  }, [persist]);

  const linkTruckDriver = useCallback((truckId, driverId) => {
    setDrivers((prev) => prev.map((d) => (d.truckId === truckId ? { ...d, truckId: null } : d)));
    setTrucks((prev) => {
      let next = driverId ? prev.map((t) => (t.driverId === driverId ? { ...t, driverId: null } : t)) : prev;
      next = next.map((t) => (t.id === truckId ? { ...t, driverId: driverId || null } : t));
      return next;
    });
    if (driverId) {
      setDrivers((prev) => prev.map((d) => (d.id === driverId ? { ...d, truckId } : d)));
    }
    persist('POST', `/api/trucks/${truckId}/link-driver`, { driverId: driverId || null });
  }, [persist]);

  const unassignDriverTruck = useCallback((driverId) => {
    setTrucks((prev) => prev.map((t) => (t.driverId === driverId ? { ...t, driverId: null } : t)));
    setDrivers((prev) => prev.map((d) => (d.id === driverId ? { ...d, truckId: null } : d)));
    persist('POST', `/api/drivers/${driverId}/unassign-truck`, {});
  }, [persist]);

  /* ---------- Job assignment ---------- */

  const setJobSingleTruck = useCallback((jobId, truckId) => {
    const truckIds = truckId ? [truckId] : [];
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds } : j)));
    const truck = truckId ? trucks.find((t) => t.id === truckId) : null;
    const truckStatusChanged = !!(truck && truck.status === 'available');
    if (truckStatusChanged) {
      setTrucks((prev) => prev.map((t) => (t.id === truckId ? { ...t, status: 'onjob' } : t)));
    }
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
    if (truckStatusChanged) persist('PATCH', `/api/trucks/${truckId}`, { status: 'onjob' });
  }, [trucks, persist]);

  const toggleJobTruck = useCallback((jobId, truckId, checked) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const current = job.truckIds || [];
    const truckIds = checked
      ? (current.includes(truckId) ? current : [...current, truckId])
      : current.filter((id) => id !== truckId);
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds } : j)));
    const truck = checked ? trucks.find((t) => t.id === truckId) : null;
    const truckStatusChanged = !!(truck && truck.status === 'available');
    if (truckStatusChanged) {
      setTrucks((prev) => prev.map((t) => (t.id === truckId ? { ...t, status: 'onjob' } : t)));
    }
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
    if (truckStatusChanged) persist('PATCH', `/api/trucks/${truckId}`, { status: 'onjob' });
  }, [jobs, trucks, persist]);

  const updateJobField = useCallback((jobId, field, value) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, [field]: value } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { [field]: value });
  }, [persist]);

  /** Unassigned-tray drop, and the × button on a multi-truck job block. */
  const removeTruckFromJob = useCallback((jobId, truckId) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const truckIds = (job.truckIds || []).filter((id) => id !== truckId);
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
  }, [jobs, persist]);

  const unassignJob = useCallback((jobId) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds: [] } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds: [] });
  }, [persist]);

  /** Day-view timeline drop — add-only: dropping onto a truck adds it to the job's assigned
      trucks (needed for multi-truck LD jobs); use removeTruckFromJob or drag to Unassigned to
      remove one. `newStartTime` is only applied to non-LD jobs — pass null/undefined to leave
      the job's start time unchanged. */
  const addTruckToJob = useCallback((jobId, truckId, newStartTime) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const current = job.truckIds || [];
    const truckIds = current.includes(truckId) ? current : [...current, truckId];
    const fields = { truckIds };
    if (newStartTime !== undefined && newStartTime !== null && job.type !== 'long_distance') {
      fields.startTime = newStartTime;
    }
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...fields } : j)));
    const truck = trucks.find((t) => t.id === truckId);
    const truckStatusChanged = !!(truck && truck.status === 'available');
    if (truckStatusChanged) {
      setTrucks((prev) => prev.map((t) => (t.id === truckId ? { ...t, status: 'onjob' } : t)));
    }
    persist('PATCH', `/api/jobs/${jobId}`, fields);
    if (truckStatusChanged) persist('PATCH', `/api/trucks/${truckId}`, { status: 'onjob' });
  }, [jobs, trucks, persist]);

  /** Month-view date-cell drop — shifts both date and endDate by the same delta so a multi-day
      job's length is preserved. */
  const moveJobDate = useCallback((jobId, newDate) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const delta = daysBetween(job.date, newDate);
    const endDate = job.endDate ? addDays(job.endDate, delta) : job.endDate;
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, date: newDate, endDate } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { date: newDate, endDate });
  }, [jobs, persist]);

  return {
    backendUrl, setBackendUrl,
    trucks, drivers, jobs,
    backendConnected, backendErrorMsg,
    lastSyncedAt,
    syncStatus, syncNow,
    resetToSampleData,
    createTruck, createDriver,
    updateTruckField, updateDriverField, updateTruckStatus,
    linkTruckDriver, unassignDriverTruck,
    setJobSingleTruck, toggleJobTruck, updateJobField,
    removeTruckFromJob, unassignJob, addTruckToJob, moveJobDate,
  };
}
