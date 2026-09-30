import { useCallback, useEffect, useState } from 'react';
import { apiCall } from '../api';
import { addDays, daysBetween } from '../utils/dates';
import { fieldsTripManualEditLock, fieldsTripTruckLock } from '../utils/jobs';

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Two short, sharp descending beeps via the Web Audio API — no external audio file, consistent
 * with this app's plain/minimal-dependency style elsewhere (see server.js's own "deliberately plain
 * http + minimal deps" comment). Added 2026-09-10 at the user's request, for resetToSampleData's
 * final warning below: a square-wave alert tone reads as "stop and think," not a pleasant
 * notification chime, so its severity registers even for someone skimming past the dialog text
 * without reading it. Always called synchronously from inside a button's click handler, so
 * browsers' autoplay-restriction rules (which only block audio with no direct user gesture behind
 * it) never block this. Best-effort: a browser that blocks or lacks Web Audio just means no sound —
 * never a broken reset flow, since the window.confirm() dialogs are the real safeguard regardless. */
function playWarningTone() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 0.16);
    });
    // AudioContexts don't auto-release their resources — close it once the short tone above has
    // finished so repeatedly clicking through the warning doesn't leak a growing pile of live ones.
    setTimeout(() => { ctx.close().catch(() => {}); }, 500);
  } catch {
    // Same best-effort reasoning as above — never let a sound failure block the actual safeguard.
  }
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

/** Manual edit lock, optimistic side (added 2026-09-08 — see utils/jobs.js's MANUAL_EDIT_LOCK_FIELDS
 *  for the full background, including its brief 2026-09-08-to-2026-09-14 detour through also
 *  covering truck/driver assignment, since reverted in favor of the separate, narrower
 *  withTruckLockPrediction just below). `fields` is whatever's about to be spread onto `job` in
 *  local state; returns `{ manuallyEditedAt: <now> }` when that would trip the lock, or `{}`
 *  otherwise — spread the result into the same object literal that already spreads `fields`. Used by
 *  updateJobFields and moveJobDate, so "does this actually change a locked field's VALUE, not just
 *  touch its key" (utils/jobs.js's fieldsTripManualEditLock) is answered the same way everywhere
 *  instead of each callback re-implementing its own comparison. Doesn't predict manuallyEditedBy (the
 *  current user's email isn't threaded into this hook) — that part stays whatever it already was
 *  until the next background poll fills in the real value from the server; only the
 *  timestamp/badge-visibility is predicted here. */
function withLockPrediction(job, fields) {
  return fieldsTripManualEditLock(job, fields) ? { manuallyEditedAt: new Date().toISOString() } : {};
}

/** Truck-assignment sibling of withLockPrediction above (added 2026-09-14 — see utils/jobs.js's
 *  TRUCK_LOCK_FIELDS for the full background). Same shape, same "predict what the backend's own
 *  real-change check is about to decide" purpose, just for the separate, narrower truck-assignment
 *  lock instead of the detail-field one — a job's truck assignment can now lock (and its badge show)
 *  without that job's date/customer/etc. locking too, and vice versa. */
function withTruckLockPrediction(job, fields) {
  return fieldsTripTruckLock(job, fields) ? { truckLockedAt: new Date().toISOString() } : {};
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
  // True until the first /api/state attempt settles (added 2026-09-30). backendConnected starts
  // false, so without this the "Can't reach the backend" banner flashed for a split second on every
  // load/reload before the first response arrived. App.jsx shows a loading animation instead while
  // this is true, and BackendBanner only renders once it's false.
  const [initialLoading, setInitialLoading] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [syncStatus, setSyncStatus] = useState({ loading: false, message: '', error: null });
  const [smartInsightsSyncStatus, setSmartInsightsSyncStatus] = useState({ loading: false, message: '', error: null });
  // Split out of syncStatus 2026-09-08 — see syncCalendarNow's own comment below for why the
  // calendar sync got its own status state instead of continuing to ride along inside syncNow's.
  const [calendarSyncStatus, setCalendarSyncStatus] = useState({ loading: false, message: '', error: null });
  // Backs SyncPanel's "Gmail authorization" countdown (added 2026-09-08 at the user's request) —
  // null until the first successful fetch, or while GET /api/gmail-auth-status hasn't returned yet.
  // { tracked: false } means gmail-oauth-setup.js has never recorded a re-auth (fresh setup, or run
  // before this feature existed) — SyncPanel treats that as "unknown", not "expired". A fetch
  // failure here is deliberately non-fatal (see loadGmailAuthStatus below) since this is a
  // heads-up widget, not core board data — nothing else on the board depends on it.
  const [gmailAuthStatus, setGmailAuthStatus] = useState(null);

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
    if (!enabled) { setInitialLoading(true); return; }
    let cancelled = false;
    setInitialLoading(true);
    (async () => {
      let ok = await loadStateFromServer();
      // One quiet retry before admitting defeat — the `api` Cloud Function runs with
      // minInstances: 0, so the first request after idle can fail/timeout on a cold start even
      // though the backend is fine a second later.
      if (!ok && !cancelled) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!cancelled) ok = await loadStateFromServer();
      }
      if (!cancelled) setInitialLoading(false);
    })();
    return () => { cancelled = true; };
  }, [enabled, loadStateFromServer]);

  /** Fetches the Gmail/Calendar OAuth re-auth countdown. Crew/dispatcher accounts get a 403 from
      this endpoint (admin-only, same as the sync endpoints it sits next to) — that's expected, not
      an error worth surfacing, so it's swallowed quietly rather than routed into backendErrorMsg
      like a real data-load failure would be. A 7-day countdown doesn't need to be live, so this is
      only ever called once on load/login, not on the 15s background poll below. */
  const loadGmailAuthStatus = useCallback(async () => {
    try {
      const status = await call('GET', '/api/gmail-auth-status');
      setGmailAuthStatus(status);
    } catch (err) {
      if (err.status === 401) { onAuthError?.(); return; }
      // 403 (non-admin) or any other failure: leave it null, SyncPanel just won't render the
      // widget rather than showing something alarming over what's ultimately a nice-to-have.
    }
  }, [call, onAuthError]);

  useEffect(() => {
    if (!enabled) return;
    loadGmailAuthStatus();
  }, [enabled, loadGmailAuthStatus]);

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
    // Background polls only flag the backend as unreachable after 2 failures in a row, so a single
    // blip (cold start, brief network hiccup) doesn't flash the disconnected banner mid-session.
    let consecutivePollFailures = 0;
    function markActive() { lastActivityAt = Date.now(); }
    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'wheel', 'scroll', 'touchstart'];
    activityEvents.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }));

    async function pollOnce() {
      try {
        const state = await call('GET', '/api/state');
        consecutivePollFailures = 0;
        setBackendConnected(true);
        setBackendErrorMsg('');
        setLastSyncedAt(new Date());
        setTrucks((prev) => (sameJSON(prev, state.trucks) ? prev : state.trucks));
        setDrivers((prev) => (sameJSON(prev, state.drivers) ? prev : state.drivers));
        setJobs((prev) => (sameJSON(prev, state.jobs) ? prev : state.jobs));
      } catch (err) {
        if (err.status === 401) { onAuthError?.(); return; }
        consecutivePollFailures += 1;
        if (consecutivePollFailures < 2) return;
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

  // Two separate confirmations, not one, at the user's explicit request 2026-09-10 — this action
  // wipes EVERY truck, driver, and job (sample and real, including anything imported from
  // SmartMoving) for every device using this backend, with no undo, so a single reflexive "OK"
  // click on one dialog is exactly the failure mode worth designing against. The second, final
  // warning also plays a short alert tone (playWarningTone above) right as it opens, so its
  // severity registers even for someone clicking through without reading the dialog text.
  const resetToSampleData = useCallback(() => {
    if (
      !window.confirm(
        'Reset the board back to the original sample data? This clears everything in the database (assignments, imported SmartMoving jobs, admin edits) for every device using this backend, and cannot be undone.'
      )
    ) {
      return;
    }
    playWarningTone();
    if (
      !window.confirm(
        'FINAL WARNING — this cannot be undone. Every real truck, driver, and job will be permanently replaced with the original sample data, for every device using this backend. Are you absolutely sure?'
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
      // 2026-09-30: pollSweep is diff-only by default — webhooks keep jobs current, so most
      // opportunities are skipped as already up to date — and it's capped by a daily API budget.
      const upToDate = result.skippedUpToDateCount ?? 0;
      const upToDateNote = upToDate > 0 ? ` ${upToDate} already up to date (kept current by webhooks).` : '';
      const budgetNote = result.stoppedForBudget ? ' Stopped early: daily SmartMoving API budget reached.' : '';
      if (result.skipped === 'daily-budget-exceeded') {
        setSyncStatus({
          loading: false, message: '',
          error: `Sync skipped: today's SmartMoving API budget is used up (${result.budget?.used ?? '?'} / ${result.budget?.budget ?? '?'} calls). Webhooks are still syncing live.`,
        });
        return;
      }
      const rangeNote = result.from && result.to ? ` Range: ${yyyymmddToLabel(result.from)} – ${yyyymmddToLabel(result.to)}.` : '';
      setSyncStatus({
        loading: false,
        message: `Synced with SmartMoving (booked jobs only).${rangeNote}${sourceNote}${upToDateNote}${jobNote}${skippedNote}${budgetNote}${errNote}`,
        error: null,
      });
    } catch (err) {
      setSyncStatus({ loading: false, message: '', error: `Sync failed: ${err.message}` });
    }
  }, [call]);

  /** Manual trigger for the Google Calendar sync (pollGoogleCalendarFeed on the backend) — split out
      of syncNow 2026-09-08 at the user's request. It used to ride along inside POST /api/sync-now,
      run sequentially right after the SmartMoving REST poll sweep in the very same request — which
      meant a slow/timed-out poll sweep (the `api` function's 60s default Cloud Run timeout, hit under
      real data volume) silently killed the request before the calendar sync ever got a turn to run.
      Now it's its own endpoint/button/status, so it succeeds or fails entirely on its own — see
      SyncPanel.jsx for the second button this backs. */
  const syncCalendarNow = useCallback(async () => {
    setCalendarSyncStatus({ loading: true, message: '', error: null });
    try {
      const result = await call('POST', '/api/calendar-sync-now');
      setTrucks(result.state.trucks);
      setDrivers(result.state.drivers);
      setJobs(result.state.jobs);
      if (result.errors && result.errors.length) console.warn('Calendar sync errors:', result.errors);
      const errNote = result.errors && result.errors.length
        ? ` ${result.errors.length} event${result.errors.length > 1 ? 's' : ''} couldn't be read — see console.`
        : '';
      const matchedCount = result.matchedCount ?? 0;
      const mergedCount = result.mergedCount ?? 0;
      const skippedNoMatch = result.skippedNoMatch ?? 0;
      // Manual edit lock (added 2026-09-08) — jobs the calendar sync found but deliberately left
      // alone because a dispatcher hand-corrected them (see db.js's markJobManuallyEdited). Worth
      // its own callout, not folded into "matched"/"updated", so it doesn't read as though nothing
      // happened for that job.
      const skippedManualEdit = result.skippedManualEdit ?? 0;
      const lockNote = skippedManualEdit > 0
        ? ` ${skippedManualEdit} job${skippedManualEdit === 1 ? '' : 's'} skipped (manually edited — see "Resync from source" on that job).`
        : '';
      const message = matchedCount === 0
        ? `Synced with Google Calendar. No matching jobs found on the board.${skippedNoMatch > 0 ? ` (${skippedNoMatch} event(s) had no matching job.)` : ''}${lockNote}${errNote}`
        : `Synced with Google Calendar. ${matchedCount} job${matchedCount === 1 ? '' : 's'} matched, ${mergedCount} updated.${skippedNoMatch > 0 ? ` ${skippedNoMatch} event(s) had no matching job.` : ''}${lockNote}${errNote}`;
      setCalendarSyncStatus({ loading: false, message, error: null });
    } catch (err) {
      setCalendarSyncStatus({ loading: false, message: '', error: `Calendar sync failed: ${err.message}` });
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
      // Manual edit lock (added 2026-09-08) — see syncCalendarNow's matching note above.
      const lockNote = result.jobsSkippedManualEdit > 0
        ? ` ${result.jobsSkippedManualEdit} job${result.jobsSkippedManualEdit === 1 ? '' : 's'} left as-is (manually edited — see "Resync from source" on that job).`
        : '';
      // Added alongside db.js's removeLostSmartInsightsJob — a job that was previously on the board
      // but whose row is now marked lost/dead/cancelled in the All Jobs report gets removed outright
      // rather than just left stale, so this surfaces that removal the same way every other sync
      // outcome here already does, instead of jobs silently disappearing with no note anywhere.
      const removedNote = result.jobsRemovedLost > 0
        ? ` ${result.jobsRemovedLost} job${result.jobsRemovedLost === 1 ? '' : 's'} removed (marked lost/cancelled).`
        : '';
      const message = result.messagesFound === 0
        ? 'No new Smart Insights report emails found.'
        : `Processed ${result.filesProcessed} report${result.filesProcessed === 1 ? '' : 's'}: ` +
          `${result.jobsCreated} job${result.jobsCreated === 1 ? '' : 's'} added, ` +
          `${result.jobsUpdated} updated.${removedNote}${rowSkipNote}${lockNote}${skipNote}${errNote}`;
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
    setJobs((prev) => prev.map((j) => (j.id === jobId
      ? { ...j, truckIds, truckDrivers: trimTruckDrivers(j, truckIds), ...withTruckLockPrediction(j, { truckIds }) }
      : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
  }, [persist]);

  const toggleJobTruck = useCallback((jobId, truckId, checked) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const current = job.truckIds || [];
    const truckIds = checked
      ? (current.includes(truckId) ? current : [...current, truckId])
      : current.filter((id) => id !== truckId);
    setJobs((prev) => prev.map((j) => (j.id === jobId
      ? { ...j, truckIds, truckDrivers: trimTruckDrivers(j, truckIds), ...withTruckLockPrediction(j, { truckIds }) }
      : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { truckIds });
  }, [jobs, persist]);

  const updateJobField = useCallback((jobId, field, value) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, [field]: value } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, { [field]: value });
  }, [persist]);

  /** Same as updateJobField but for several fields at once in a single PATCH — used by the "edit
      date/time" modal (JobEditModal) so saving date+endDate+startTime doesn't fire three separate
      round trips (and three separate optimistic-update flickers) for one save action.

      Manual edit lock (added 2026-09-08): when `fields` touches any of MANUAL_EDIT_LOCK_FIELDS
      (utils/jobs.js — the fields every sync source treats as its own) with a value that actually
      DIFFERS from what this job already has, also optimistically sets manuallyEditedAt/
      manuallyEditedBy locally, predicting what server.js's PATCH handler is about to decide
      server-side (it diffs against the job's actual previous values the same way — see that
      handler's comment).

      Bug fixed 2026-09-08 (reported by the user: added trucks to a job, saw the lock badge appear,
      then watched it disappear ~15s later even though the truck assignment itself was still there):
      this used to check only whether a lock-field KEY was present in `fields` — Object.keys(fields).
      some((f) => MANUAL_EDIT_LOCK_FIELDS.includes(f)) — not whether its VALUE actually changed. But
      JobEditModal's handleSave always resends its full field set (customer/origin/destination/
      trucksNeeded/crewSize/date/endDate/startTime/duration) on every Save click, including the live-
      apply "+ Add truck" control's own Save — even one that touched nothing but which trucks are
      assigned still carries customer/date/etc. as unchanged values in that payload. So this
      optimistic guess showed the lock badge on essentially every Save, whether or not anything
      sync-owned really changed — while the server's own check (a genuine before/after diff) correctly
      found no real change and never set the lock. The mismatch resolved itself once the 15s
      background poll (below) pulled the real, unlocked, state — which read as "the lock silently
      disappeared," when actually it had never really been set; only the prediction was wrong. Now
      compares each field's actual value against the job's current one (same `?? null` treatment
      server.js's diffJobFields uses for these plain scalar fields) so a Save that only changed truck
      assignment, or changed nothing at all, no longer predicts a lock it isn't going to get.

      Truck-assignment lock (added 2026-09-14, split out of the above — see utils/jobs.js's
      TRUCK_LOCK_FIELDS/MANUAL_EDIT_LOCK_FIELDS comments for the full history): also applies
      withTruckLockPrediction alongside withLockPrediction here, since a Save from JobEditModal can
      touch its "Trucks needed" field too — that's the one truck-related field this callback itself
      ever carries (truck/driver ADD/REMOVE actions go through their own dedicated callbacks below,
      each with their own withTruckLockPrediction call). The two predictions are independent: a Save
      can trip one, both, or neither, matching the two separate locks server-side. */
  const updateJobFields = useCallback((jobId, fields) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId
      ? { ...j, ...fields, ...withLockPrediction(j, fields), ...withTruckLockPrediction(j, fields) }
      : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [persist]);

  /** "Resync from source" — clears the manual edit lock a JobEditModal save above may have set (see
      db.js's clearJobManualEdit), so this job goes back to accepting automatic field updates from
      whichever sync source(s) still recognize it. Doesn't force an immediate re-sync — see
      clearJobManualEdit's own doc comment. Not run through `persist` like the fields above (which
      fire-and-forget, discarding the response) — this one awaits and adopts the server's returned
      job wholesale, since manuallyEditedAt/manuallyEditedBy are server-computed and there's nothing
      useful to predict locally the way updateJobFields does above. */
  const clearManualEdit = useCallback(async (jobId) => {
    try {
      const updatedJob = await call('POST', `/api/jobs/${jobId}/resync`);
      setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...updatedJob } : j)));
    } catch (err) {
      window.alert(`Couldn't resync this job: ${err.message}`);
    }
  }, [call]);

  /** Deletes a job — offered in the UI for every job since 2026-09-24 (previously wired up only
      for placeholders, source === 'placeholder'; see JobVisuals.jsx/JobEditModal.jsx for the
      widened gating). The server now soft-deletes: the job is archived to the deletedJobs
      collection (who/when) rather than hard-removed, and is restorable from the hidden Deleted
      Jobs panel — see server/db.js's deleteJob doc comment for the still-standing caveat that a
      deleted SmartMoving-sourced job can still come back on a future sync, since no
      tombstone-checking was added to the sync upsert paths. Optimistic like everything else here:
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

  /** Deleted-jobs archive (added 2026-09-24), backing the hidden "Deleted Jobs" panel — see
      Header.jsx's secret click-trigger. Deliberately NOT loaded as part of the normal
      trucks/drivers/jobs poll: it's fetched on demand only when the panel is actually opened, both
      because it's admin-only server-side (a non-admin's call would just 403) and because there's no
      reason to pay for this extra read on every single poll tick when almost nobody ever opens the
      panel. Returns the array directly (not stored in hook state) — the panel component owns its
      own loading state, this is just a thin fetch wrapper matching the rest of this file's call()
      pattern. */
  const fetchDeletedJobs = useCallback(async () => {
    return call('GET', '/api/deleted-jobs');
  }, [call]);

  /** Restores an archived job back into the live jobs list. Not optimistic like deleteJob above —
      the restored job's full shape comes back from the server (POST .../restore returns the same
      {trucks, drivers, jobs} state shape as everything else in this file), so it's simplest to just
      await it and adopt the returned jobs wholesale rather than guess at what the restored doc looks
      like locally. */
  const restoreJob = useCallback(async (jobId) => {
    const state = await call('POST', `/api/deleted-jobs/${jobId}/restore`);
    if (state && state.jobs) setJobs(state.jobs);
    return state;
  }, [call]);

  /** Permanently removes one archived job (added 2026-09-24, alongside the panel's search/bulk-select
      UI, right after a 131-job cleanup filled the archive with entries nobody would ever restore).
      No local jobs-array state to reconcile here — the archive list itself lives in
      DeletedJobsPanel.jsx's own component state (see fetchDeletedJobs' doc comment for why it isn't
      hoisted into this hook), so this is just a thin call() wrapper; the panel removes the row
      itself on success. True hard delete server-side — see db.js's permanentlyDeleteArchivedJob. */
  const permanentlyDeleteArchivedJob = useCallback(async (jobId) => {
    await call('DELETE', `/api/deleted-jobs/${jobId}`);
  }, [call]);

  /** Unassigned-tray drop, and the × button on a multi-truck job block. Removing a truck from a
      job also drops whichever driver was assigned to THAT truck on this job — see
      trimTruckDrivers' comment — so a driver isn't left looking "still on" a job they've actually
      been pulled off of.

      trucksNeeded roll-back (added 2026-09-08, user-reported, then corrected same day): addTruckToJob/
      addExtraTruckToJob bump trucksNeeded UP to match truckIds.length whenever a truck gets added (so
      the "needs N more"/"N/M trucks" badge stays honest — see utils/jobs.js's jobTrucksNeeded doc
      comment). Removing a truck used to never bring it back DOWN, so undoing an accidental
      extra-truck assignment (e.g. a SmartMoving job synced with trucksNeeded=1, a second truck added
      by mistake, then removed) left trucksNeeded stuck at 2 forever.
      First fix attempt just rolled trucksNeeded back to match truckIds.length whenever the two were
      currently equal — but that's indistinguishable from a job that genuinely needs 2 trucks (say,
      SmartMoving itself says 2), started with both assigned, and then had one pulled for a real
      reason: trucksNeeded (2) === truckIds.length (2) there too, so that version would have wrongly
      erased the real requirement right along with an actual mistake. Corrected version floors the
      roll-back at db.js's trucksNeededOriginal — a snapshot of what trucksNeeded was at job creation
      (from SmartMoving/Smart Insights/iCal, or whatever a dispatcher typed for a placeholder), never
      touched by these assignment-driven bumps, only re-based by a genuinely deliberate edit through
      JobEditModal's own "Trucks needed" field (see its handleSave). So a job created needing 1,
      bumped to 2 by an accidental add, rolls back to 1 when that truck is removed — but a job created
      needing 2 never rolls below 2, no matter how many of its trucks get pulled off later. */
  const removeTruckFromJob = useCallback((jobId, truckId) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const truckIds = (job.truckIds || []).filter((id) => id !== truckId);
    const fields = { truckIds };
    const floor = job.trucksNeededOriginal ?? job.trucksNeeded ?? 1;
    const rolledBack = Math.max(floor, truckIds.length);
    if (rolledBack !== (job.trucksNeeded || 1)) fields.trucksNeeded = rolledBack;
    setJobs((prev) => prev.map((j) => (j.id === jobId
      ? { ...j, ...fields, truckDrivers: trimTruckDrivers(j, truckIds), ...withTruckLockPrediction(j, fields) }
      : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [jobs, persist]);

  /** Drag-to-Unassigned — clears every truck off the job at once, so every driver assignment on it
      goes with them (trimTruckDrivers against an empty truckIds list drops the whole map). Same
      trucksNeededOriginal-floored roll-back as removeTruckFromJob above, and for the same reason —
      clearing every truck off a job resets trucksNeeded to its real floor (1 for a job that was only
      ever bumped by mistake, or higher if that's genuinely what it needs per trucksNeededOriginal),
      never below what the job was actually created needing. */
  const unassignJob = useCallback((jobId) => {
    const job = jobs.find((j) => j.id === jobId);
    const fields = { truckIds: [] };
    if (job) {
      const floor = job.trucksNeededOriginal ?? job.trucksNeeded ?? 1;
      if (floor !== (job.trucksNeeded || 1)) fields.trucksNeeded = floor;
    }
    setJobs((prev) => prev.map((j) => (j.id === jobId
      ? { ...j, ...fields, truckDrivers: {}, ...withTruckLockPrediction(j, fields) }
      : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [jobs, persist]);

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
    // Bug fixed 2026-09-08: dragging a second (third, ...) truck onto a long-distance job's
    // timeline here used to grow truckIds without ever touching trucksNeeded — only the deliberate
    // "+truck" button (addExtraTruckToJob below) did that bump. trucksNeeded on a synced job
    // normally starts at 1 (see mapOpportunity.js/mapJobs.js/mapIcalEvent.js/mapSmartInsightsRow.js),
    // so a job dragged up to 2 assigned trucks this way was silently left showing "Trucks needed: 1"
    // in Job Assignments (JobAssignments.jsx) even with 2 trucks checked, and truckBadgeInfo
    // (utils/jobs.js) renders NOTHING at all once trucksNeeded <= 1 — regardless of how many trucks
    // are actually assigned — so the board's "needs N more"/"N/M trucks" badge didn't even show the
    // mismatch. Mirrors addExtraTruckToJob's Math.max bump so the truck count this job reports
    // always keeps up with reality, however a truck got added to it.
    if (job.type === 'long_distance' && truckIds.length > current.length) {
      fields.trucksNeeded = Math.max(job.trucksNeeded || 1, truckIds.length);
      // trucksNeededOriginal floor (added 2026-09-08, second pass — see db.js's jobData() comment):
      // db.js only ever snapshots this at job CREATION, so every job that already existed before
      // that change shipped has it missing (null/undefined) in Firestore. Without capturing it here
      // too, removeTruckFromJob/unassignJob's `job.trucksNeededOriginal ?? job.trucksNeeded ?? 1`
      // fallback would read `job.trucksNeeded` AFTER this same bump already landed — i.e. the
      // bumped value, not the true pre-bump one — making the floor equal the mistake it's supposed
      // to undo, so a later removal could never roll back down. Only set once (skipped if the job
      // already has a real trucksNeededOriginal, from creation or a prior bump), so a second/third
      // bump doesn't keep sliding the floor upward — it always anchors to the FIRST bump's pre-bump
      // value, however many trucks get added after that.
      if (fields.trucksNeeded !== (job.trucksNeeded || 1) && job.trucksNeededOriginal == null) {
        fields.trucksNeededOriginal = job.trucksNeeded || 1;
      }
    }
    if (newStartTime !== undefined && newStartTime !== null) {
      fields.startTime = newStartTime;
    }
    // For a local job, this can MOVE it off its previous truck (see the comment above) — that
    // truck's driver assignment shouldn't come along for the ride onto the new one.
    setJobs((prev) => prev.map((j) => (j.id === jobId
      ? { ...j, ...fields, truckDrivers: trimTruckDrivers(j, truckIds), ...withTruckLockPrediction(j, fields) }
      : j)));
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
    // trucksNeededOriginal floor — same second-pass fix as addTruckToJob above, same reason: a
    // pre-existing job has no trucksNeededOriginal snapshot from creation, so this bump has to
    // capture the pre-bump value itself the first time, or removeTruckFromJob/unassignJob would
    // never be able to tell this bump apart from a genuine multi-truck requirement.
    if (trucksNeeded !== (job.trucksNeeded || 1) && job.trucksNeededOriginal == null) {
      fields.trucksNeededOriginal = job.trucksNeeded || 1;
    }
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...fields, ...withTruckLockPrediction(j, fields) } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [jobs, persist]);

  /** Assigns (driverId given) or clears (driverId falsy/undefined) which driver is driving one
      specific truck on one specific job — see db.js's file header for why this replaced the old
      standing truck-to-driver link. Optimistic like everything else here: updates just that one
      entry in the job's local `truckDrivers` map, so sibling trucks on the same job (or this
      truck's assignment on a different job) aren't touched.

      Driver assignment briefly predicted the (then-combined) manual-edit lock too (2026-09-08 to
      2026-09-14) — that got reverted along with the server-side combined lock itself (see
      utils/jobs.js's MANUAL_EDIT_LOCK_FIELDS comment), so this no longer touches manuallyEditedAt.
      It now predicts the separate, narrower truck-assignment lock instead (added 2026-09-14 — see
      utils/jobs.js's TRUCK_LOCK_FIELDS/withTruckLockPrediction), same real-change guard (only on an
      actual driver change, not a same-value re-send) as server.js's own check for this endpoint. */
  const setJobTruckDriver = useCallback((jobId, truckId, driverId) => {
    setJobs((prev) => prev.map((j) => {
      if (j.id !== jobId) return j;
      const truckDrivers = { ...(j.truckDrivers || {}) };
      const priorDriverId = truckDrivers[truckId] || null;
      const newDriverId = driverId || null;
      if (newDriverId) truckDrivers[truckId] = newDriverId;
      else delete truckDrivers[truckId];
      return { ...j, truckDrivers, ...(priorDriverId !== newDriverId ? { truckLockedAt: new Date().toISOString() } : {}) };
    }));
    persist('POST', `/api/jobs/${jobId}/set-truck-driver`, { truckId, driverId: driverId || null });
  }, [persist]);

  /** Sets (color given) or clears (color falsy/null) a job's manual color override — added
      2026-09-15 at the user's request that any user, including crew, be able to pick a job's color
      directly. Optimistic like setJobTruckDriver above, and deliberately does NOT predict either
      manual-edit lock (colorOverride is a pure display preference, not one of
      MANUAL_EDIT_LOCK_FIELDS/TRUCK_LOCK_FIELDS — see db.js's setJobColor comment) — a color pick
      never freezes a job against SmartMoving/calendar syncing. Hits its own narrow endpoint (see
      server.js's POST /api/jobs/:id/color) rather than the generic PATCH, since that's the one this
      app authorizes for the crew role too. */
  const setJobColor = useCallback((jobId, color) => {
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, colorOverride: color || null } : j)));
    persist('POST', `/api/jobs/${jobId}/color`, { color: color || null });
  }, [persist]);

  /** Month-view date-cell drop — shifts both date and endDate by the same delta so a multi-day
      job's length is preserved. Predicts the manual edit lock too (added 2026-09-08) — date/endDate
      are both in MANUAL_EDIT_LOCK_FIELDS and always genuinely change here (a drop onto the SAME date
      wouldn't fire this at all — see MonthBoard.jsx's drop handler), so this always trips the lock;
      unlike updateJobFields/withLockPrediction elsewhere, no no-op-save case to worry about here. */
  const moveJobDate = useCallback((jobId, newDate) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return;
    const delta = daysBetween(job.date, newDate);
    const endDate = job.endDate ? addDays(job.endDate, delta) : job.endDate;
    const fields = { date: newDate, endDate };
    setJobs((prev) => prev.map((j) => (j.id === jobId ? { ...j, ...fields, ...withLockPrediction(j, fields) } : j)));
    persist('PATCH', `/api/jobs/${jobId}`, fields);
  }, [jobs, persist]);

  return {
    trucks, drivers, jobs,
    backendConnected, backendErrorMsg, initialLoading,
    lastSyncedAt,
    syncStatus, syncNow,
    calendarSyncStatus, syncCalendarNow,
    smartInsightsSyncStatus, syncSmartInsightsNow,
    gmailAuthStatus,
    resetToSampleData, clearJobs,
    createTruck, createDriver,
    updateTruckField, updateDriverField, updateTruckStatus, reorderTrucks,
    deleteTruck, deleteDriver,
    setJobSingleTruck, toggleJobTruck, updateJobField, updateJobFields, clearManualEdit, createJob, deleteJob,
    fetchDeletedJobs, restoreJob, permanentlyDeleteArchivedJob,
    removeTruckFromJob, unassignJob, addTruckToJob, addExtraTruckToJob, moveJobDate,
    setJobTruckDriver, setJobColor,
  };
}
