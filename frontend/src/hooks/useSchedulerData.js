import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../api';
import { addDays, daysBetween } from '../utils/dates';

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Drops any `truckDrivers` entries for trucks no longer in `newTruckIds` — keeps local optimistic
 * state in sync with what db.js's `updateJob()` already does server-side (see its comment) any
 * time a mutation below changes a job's `truckIds`. Without this, unassigning a job (or just
 * removing one of its trucks) left the old truck's driver sitting in local state until the next
 * 15s background poll overwrote it — harmless on its own, but if that same truck got re-added to
 * the job before the poll caught up, the stale entry would make the old driver silently reappear
 * as if they were still assigned. Returns the same object reference when nothing actually needs
 * dropping, so callers that spread this into a new job object don't cause an unnecessary re-render
 * for jobs that weren't affected. */
function trimTruckDrivers(job, newTruckIds) {
  const existing = job.truckDrivers || {};
  const keys = Object.keys(existing);
  const kept = keys.filter((truckId) => newTruckIds.includes(truckId));
  if (kept.length === keys.length) return existing;
  const next = {};
  kept.forEach((truckId) => { next[truckId] = existing[truckId]; });
  return next;
}

/** Formats the yyyymmdd integer format the backend uses (e.g. 20260812) as a short human date
 * (e.g. "Aug 12, 2026") for the sync status message. */
function yyyymmddToLabel(yyyymmdd) {
  const s = String(yyyymmdd);
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
  return isNaN(d.getTime()) ? String(yyyymmdd) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
 *
 * `backendUrl` is owned by the caller (shared with useAuth, since both need it). `enabled` gates
 * the initial load and background polling — pass false until the user is actually logged in, so
 * this doesn't fire a doomed /api/state call (and log a confusing error) before that.
 * `onAuthError` fires whenever a request comes back 401, so the caller can bounce back to the
 * login screen if a session expires mid-use.
 */
export function useSchedulerData(backendUrl, { enabled = true, onAuthError } = {}) {
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [backendConnected, setBackendConnected] = useState(false);
  const [backendErrorMsg, setBackendErrorMsg] = useState('');
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ loading: false, message: '', error: null });
  const [smartInsightsSyncStatus, setSmartInsightsSyncStatus] = useState({ loading: false, message: '', error: null });

  const call = useCallback((method, path, body) => apiCall(backendUrl, method, path, body), [backendUrl]);

  /** Fire-and-forget persistence for a mutation already applied optimistically to local state.
      Surfaces a banner on failure instead of silently losing the change. */
  const persist = useCallback((method, path, body) => {
    call(method, path, body)
      .then(() => setBackendErrorMsg(''))
      .catch((err) => {
        if (err.status === 401) { onAuthError?.(); return; }
        // backendUrl is '' for same-origin production hosting (see api.js) — name it explicitly
        // instead of showing a blank.
        const where = backendUrl || 'this site';
        setBackendErrorMsg(
          `Couldn't save your last change to the server (${err.message}). It may be lost on refresh — check your connection to ${where}.`
        );
      });
  }, [call, backendUrl, onAuthError]);

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
      if (err.status === 401) { onAuthError?.(); return false; }
      setBackendConnected(false);
      setBackendErrorMsg(err.message);
      return false;
    }
  }, [call, onAuthError]);

  // Initial load, and reload whenever the backend URL changes (e.g. the user retries with a
  // different one from the disconnected banner) — only once logged in.
  useEffect(() => {
    if (!enabled) return;
    loadStateFromServer();
  }, [enabled, loadStateFromServer]);

  // Background refresh every 15s so multiple tabs/devices converge on the same board. Only
  // swaps in new arrays when something actually changed, so unrelated components don't re-render
  // for no reason.
  //
  // Skipped in two situations, so a tab nobody's actually using stops burning Firestore reads:
  //   1. The tab is backgrounded (document.hidden, via the Page Visibility API) — a minimized
  //      window, a switched-away tab, or the whole browser not being focused.
  //   2. The tab is visible and focused but IDLE — left open on screen with no mouse/keyboard/
  //      touch activity for IDLE_TIMEOUT_MS. Visibility alone doesn't catch this: a tab can sit
  //      visible and untouched for hours and would otherwise keep polling the whole time.
  // `lastActivityAt` is a plain mutable variable (not state) updated by passive activity
  // listeners — it's read every interval tick, not rendered, so it deliberately doesn't need to
  // trigger a re-render.
  //
  // Coming back is still instant: `handleVisibilityChange` fires an immediate poll the moment the
  // tab becomes visible again (covers returning after minimizing/switching away), and any real
  // activity (mousemove/keydown/click/scroll/touch) resets the idle clock immediately so the very
  // next tick (within 15s) resumes polling once you're back — you don't have to wait out the full
  // idle window again.
  useEffect(() => {
    if (!enabled) return;

    const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of no interaction counts as "not using it"
    let lastActivityAt = Date.now();
    function markActive() { lastActivityAt = Date.now(); }
    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll', 'touchstart'];
    activityEvents.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }));

    async function pollOnce() {
      try {
        const state = await call('GET', '/api/state');
        setBackendConnected(true);
        setBackendErrorMsg('');
        setLastSyncedAt(new Date());
        setTrucks((prev) => (sameJSON(prev, state.trucks) ? prev : state.trucks));
        setDrivers((prev) => (sameJSON(prev, state.drivers) ? prev : state.drivers));
        setJobs((prev) => (sameJSON(prev, state.jobs) ? prev : state.jobs));
      } catch (err) {
        if (err.status === 401) { onAuthError?.(); return; }
        setBackendConnected(false);
        setBackendErrorMsg(err.message);
      }
    }

    function isIdle() {
      return Date.now() - lastActivityAt >= IDLE_TIMEOUT_MS;
    }

    const id = setInterval(() => {
      if (document.hidden || isIdle()) return; // not visible, or nobody's touched it — skip, no request made
      pollOnce();
    }, 15000);

    function handleVisibilityChange() {
      // Returning to the tab always counts as activity, even before the browser fires its own
      // mousemove — otherwise a tab reopened right at the idle boundary could skip its own
      // catch-up poll.
      if (!document.hidden) { markActive(); pollOnce(); }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      activityEvents.forEach((evt) => window.removeEventListener(evt, markActive));
    };
  }, [enabled, call, onAuthError]);

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

  const clearJobs = useCallback(() => {
    if (
      !window.confirm(
        "Remove every job (including the sample jobs and anything imported from SmartMoving) for every device using this backend? Trucks and drivers are left exactly as they are — only jobs are cleared. Cannot be undone."
      )
    ) {
      return;
    }
    call('POST', '/api/clear-jobs')
      .then((state) => {
        setTrucks(state.trucks);
        setDrivers(state.drivers);
        setJobs(state.jobs);
      })
      .catch((err) => window.alert(`Couldn't clear jobs: ${err.message}`));
  }, [call]);

  const syncNow = useCallback(async ({ from, to } = {}) => {
    setSyncStatus({ loading: true, message: '', error: null });
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const query = params.toString();
      const result = await call('POST', `/api/sync-now${query ? `?${query}` : ''}`);
      setTrucks(result.state.trucks);
      setDrivers(result.state.drivers);
      setJobs(result.state.jobs);
      const errNote =
        result.errors && result.errors.length
          ? ` ${result.errors.length} opportunit${result.errors.length > 1 ? 'ies' : 'y'} couldn't be read — see console.`
          : '';
      if (result.errors && result.errors.length) console.warn('SmartMoving sync errors:', result.errors);
      // Two independent sources feed this as of the 2026-08-18 "booked jobs only" redesign (see
      // server.js's pollSweep doc comment) — GET /api/leads was dropped entirely, since by
      // definition it can never return a Booked+ opportunity. Crew members' assigned jobs (bypasses
      // needing an opportunity's own status field) and /api/customers (pre-filtered by status
      // server-side, but also finds jobs regardless of crew assignment) are merged and deduped
      // before hydrating, so an opportunity found via both only counts once toward jobCount.
      const crewJobOpportunityCount = result.crewJobOpportunityCount ?? 0;
      const customerJobOpportunityCount = result.customerJobOpportunityCount ?? 0;
      const jobCount = result.jobCount ?? 0;
      const skippedNotBookedCount = result.skippedNotBookedCount ?? 0;
      const sourceBits = [];
      if (crewJobOpportunityCount > 0) sourceBits.push(`${crewJobOpportunityCount} booked opportunit${crewJobOpportunityCount === 1 ? 'y' : 'ies'} assigned to crew`);
      if (customerJobOpportunityCount > 0) sourceBits.push(`${customerJobOpportunityCount} more via customer records`);
      const sourceNote = sourceBits.length ? ` Checked ${sourceBits.join(' and ')}.` : '';
      const jobNote = jobCount === 0
        ? (crewJobOpportunityCount === 0 && customerJobOpportunityCount === 0
          ? ' No booked jobs found for this range.'
          : ' Nothing new to add to the board.')
        : ` ${jobCount} job${jobCount === 1 ? '' : 's'} added/updated on the board.`;
      const skippedNote = skippedNotBookedCount > 0 ? ` ${skippedNotBookedCount} opportunit${skippedNotBookedCount === 1 ? 'y was' : 'ies were'} skipped (not booked yet).` : '';
      const rangeNote = result.from && result.to ? ` Range: ${yyyymmddToLabel(result.from)} – ${yyyymmddToLabel(result.to)}.` : '';
      setSyncStatus({
        loading: false,
        message: `Synced with SmartMoving (booked jobs only).${rangeNote}${sourceNote}${jobNote}${skippedNote}${errNote}`,
        error: null,
      });
    } catch (err) {
      setSyncStatus({ loading: false, message: '', error: `Sync failed: ${err.message}` });
    }
  }, [call]);

  /** Manual trigger for the Smart Insights report sync (same pipeline as the daily 6am ET
      smartInsightsSyncScheduled Cloud Function — see server/smartInsightsSync.js) — checks Gmail
      for any not-yet-processed report email right now instead of waiting for tomorrow's run.
      Placeholder-duplicate detection (utils/jobs.js's getPlaceholderDuplicates) recomputes
      automatically once the new jobs land in `jobs` state below, same as everything else derived
      from it — no separate step needed here. */
  const syncSmartInsightsNow = useCallback(async () => {
    setSmartInsightsSyncStatus({ loading: true, message: '', error: null });
    try {
      const result = await call('POST', '/api/smart-insights/sync-now');
      setTrucks(result.state.trucks);
      setDrivers(result.state.drivers);
      setJobs(result.state.jobs);
      if (result.errors && result.errors.length) console.warn('Smart Insights sync errors:', result.errors);
      const errNote = result.errors && result.errors.length
        ? ` ${result.errors.length} report${result.errors.length > 1 ? 's' : ''} couldn't be read — see console.`
        : '';
      const skipNote = result.filesSkipped > 0
        ? ` ${result.filesSkipped} email${result.filesSkipped > 1 ? 's' : ''} had no recognizable report link/attachment.`
        : '';
      const rowSkipNote = result.rowsSkipped > 0 ? ` ${result.rowsSkipped} row(s) skipped (not Booked yet, or no matching opportunity).` : '';
      const message = result.messagesFound === 0
        ? 'No new Smart Insights report emails found.'
        : `Processed ${result.filesProcessed} report${result.filesProcessed === 1 ? '' : 's'}: ` +
          `${result.jobsCreated} job${result.jobsCreated === 1 ? '' : 's'} added, ` +
          `${result.jobsUpdated} updated.${rowSkipNote}${skipNote}${errNote}`;
      setSmartInsightsSyncStatus({ loading: false, message, error: null });
    } catch (err) {
      setSmartInsightsSyncStatus({ loading: false, message: '', error: `Smart Insights sync failed: ${err.message}` });
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

  /** Quick-add "placeholder" job from the day view (JobCreateModal) — just a name/date/time stub,
      unassigned, for penciling in something that isn't in SmartMoving (yet or ever). The backend
      returns the full state (same pattern as syncNow/resetToSampleData) rather than just the new
      job, since it's a cheap single round trip and keeps this in lockstep with the same
      "set from server state" pattern the rest of this file uses after any bulk-ish change. */
  const createJob = useCallback(async (fields) => {
    const result = await call('POST', '/api/jobs', fields);
    setJobs(result.state.jobs);
    return result;
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

  /** Drag-and-drop reordering in the Trucks admin panel — caller (TruckAdminList) computes the
      full new order client-side (it already has the list being dragged) and hands back the
      complete array of truck ids in that order. Applied to local state immediately so the drag
      feels instant, then persisted the same fire-and-forget way as the field-level edits above. */
  const reorderTrucks = useCallback((orderedIds) => {
    setTrucks((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      return orderedIds.map((id) => byId.get(id)).filter(Boolean);
    });
    persist('POST', '/api/trucks/reorder', { truckIds: orderedIds });
  }, [persist]);

  /** Deleting a truck can ripple into jobs (any job assigned to it becomes unassigned) and the
      linked driver (unlinked, not deleted) — the backend's DELETE handles both and hands back the
      full resulting state (same shape as resetToSampleData/syncNow), so this just adopts that
      instead of trying to replicate the cross-table cleanup logic here too. */
  const deleteTruck = useCallback(async (id) => {
    const state = await call('DELETE', `/api/trucks/${id}`);
    setTrucks(state.trucks);
    setDrivers(state.drivers);
    setJobs(state.jobs);
  }, [call]);

  /** Deleting a driver can ripple into jobs now (any job's `truckDrivers` entry naming this driver
      is cleared server-side — see db.js's deleteDriver) — same "adopt the server's full state"
      approach as deleteTruck, for the same reason. */
  const deleteDriver = useCallback(async (id) => {
    const state = await call('DELETE', `/api/drivers/${id}`);
    setTrucks(state.trucks);
    setDrivers(state.drivers);
    setJobs(state.jobs);
  }, [call]);

  /* ---------- Job assignment ---------- */

  const setJobSingleTruck = useCallback((jobId, truckId) => {
    const truckIds = truckId ? [truckId] : [];
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds, truckDrivers: trimTruckDrivers(j, truckIds) } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
  }, [persist]);

  const toggleJobTruck = useCallback((jobId, truckId, checked) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const current = job.truckIds || [];
    const truckIds = checked
      ? (current.includes(truckId) ? current : [...current, truckId])
      : current.filter((id) => id !== truckId);
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds, truckDrivers: trimTruckDrivers(j, truckIds) } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
  }, [jobs, persist]);

  const updateJobField = useCallback((jobId, field, value) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, [field]: value } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { [field]: value });
  }, [persist]);

  /** Same as updateJobField but for several fields at once in a single PATCH — used by the "edit
      date/time" modal (JobEditModal) so saving date+endDate+startTime doesn't fire three separate
      round trips (and three separate optimistic-update flickers) for one save action. */
  const updateJobFields = useCallback((jobId, fields) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...fields } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [persist]);

  /** Permanently deletes a job — wired up in the UI only for placeholder jobs (source ===
      'placeholder'; see JobVisuals.jsx/JobEditModal.jsx), not SmartMoving-sourced ones, which
      would just come back on the next poll sweep anyway. Optimistic like everything else here:
      removes it from local state immediately, and if the DELETE call fails, restores it and
      surfaces an alert rather than leaving the UI showing a job that's still on the server. */
  const deleteJob = useCallback(async (jobId) => {
    const removed = jobs.find((j) => j.id === jobId);
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    try {
      await call('DELETE', `/api/jobs/${jobId}`);
    } catch (err) {
      if (removed) setJobs((prev) => [...prev, removed]);
      throw err;
    }
  }, [jobs, call]);

  /** Unassigned-tray drop, and the × button on a multi-truck job block. Removing a truck from a
      job also drops whichever driver was assigned to THAT truck on this job — see
      trimTruckDrivers' comment — so a driver isn't left looking "still on" a job they've actually
      been pulled off of. */
  const removeTruckFromJob = useCallback((jobId, truckId) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const truckIds = (job.truckIds || []).filter((id) => id !== truckId);
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds, truckDrivers: trimTruckDrivers(j, truckIds) } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
  }, [jobs, persist]);

  /** Drag-to-Unassigned — clears every truck off the job at once, so every driver assignment on it
      goes with them (trimTruckDrivers against an empty truckIds list drops the whole map). */
  const unassignJob = useCallback((jobId) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, truckIds: [], truckDrivers: {} } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds: [] });
  }, [persist]);

  /** Day-view timeline drop. Long-distance jobs can need more than one truck, so dropping onto a
      new truck there ADDS to the job's assigned trucks (remove one via removeTruckFromJob or drag
      to Unassigned to clear all). Local jobs are single-truck only — mirroring the single-select
      dropdown in Admin → Job Assignments — so dropping one onto a different truck MOVES it there
      instead of stacking a second assignment. `newStartTime` is applied to any job type, including
      long-distance — a trip's departure time still matters even though its bar always spans the
      full day width; pass null/undefined to leave the job's start time unchanged (e.g. when
      DayBoard.jsx computes no time because the drop wasn't on the timeline itself). */
  const addTruckToJob = useCallback((jobId, truckId, newStartTime) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const current = job.truckIds || [];
    const truckIds = job.type === 'long_distance'
      ? (current.includes(truckId) ? current : [...current, truckId])
      : [truckId];
    const fields = { truckIds };
    if (newStartTime !== undefined && newStartTime !== null) {
      fields.startTime = newStartTime;
    }
    // For a local job, this can MOVE it off its previous truck (see the comment above) — that
    // truck's driver assignment shouldn't come along for the ride onto the new one.
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...fields, truckDrivers: trimTruckDrivers(j, truckIds) } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [jobs, persist]);

  /** Explicit "this job needs another truck" action — a deliberate button/picker in the
      scheduler board and Admin → Job Assignments, distinct from addTruckToJob (which is only the
      day-board drag-and-drop and stays type-restricted so local jobs can't get silently
      double-assigned by dragging). Works for any job type: a local job can need a second truck
      too if the load doesn't fit, not just long-distance ones. Also bumps trucksNeeded up to the
      new truck count so the "needs N more truck(s)" badge reflects reality instead of showing
      "over" once assigned trucks exceed a stale trucksNeeded value. */
  const addExtraTruckToJob = useCallback((jobId, truckId) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const current = job.truckIds || [];
    if (current.includes(truckId)) return;
    const truckIds = [...current, truckId];
    const trucksNeeded = Math.max(job.trucksNeeded || 1, truckIds.length);
    const fields = { truckIds, trucksNeeded };
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...fields } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [jobs, persist]);

  /** Assigns (driverId given) or clears (driverId falsy/undefined) which driver is driving one
      specific truck on one specific job — see db.js's file header for why this replaced the old
      standing truck-to-driver link. Optimistic like everything else here: updates just that one
      entry in the job's local `truckDrivers` map, so sibling trucks on the same job (or this
      truck's assignment on a different job) aren't touched. */
  const setJobTruckDriver = useCallback((jobId, truckId, driverId) => {
    setJobs((prev) => prev.map((j) => {
      if (j.id !== jobId) return j;
      const truckDrivers = { ...(j.truckDrivers || {}) };
      if (driverId) truckDrivers[truckId] = driverId;
      else delete truckDrivers[truckId];
      return { ...j, truckDrivers };
    }));
    persist('POST', `/api/jobs/${jobId}/set-truck-driver`, { truckId, driverId: driverId || null });
  }, [persist]);

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
    trucks, drivers, jobs,
    backendConnected, backendErrorMsg,
    lastSyncedAt,
    syncStatus, syncNow,
    smartInsightsSyncStatus, syncSmartInsightsNow,
    resetToSampleData, clearJobs,
    createTruck, createDriver,
    updateTruckField, updateDriverField, updateTruckStatus, reorderTrucks,
    deleteTruck, deleteDriver,
    setJobSingleTruck, toggleJobTruck, updateJobField, updateJobFields, createJob, deleteJob,
    removeTruckFromJob, unassignJob, addTruckToJob, addExtraTruckToJob, moveJobDate,
    setJobTruckDriver,
  };
}
