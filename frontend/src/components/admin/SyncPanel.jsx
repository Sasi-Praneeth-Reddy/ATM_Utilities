import { useEffect, useState } from 'react';

// Hidden 2026-08-24 at the user's request ("hide this one for now") — the REST-poll SmartMoving
// sync panel below (webhooks + periodic poll, "Sync now" with a date range). Not removed: the
// underlying sync (onSyncNow, the /api/sync-now endpoint, the background poll itself) keeps
// running exactly as before, only its manual-trigger UI panel is hidden. Flip this back to true to
// bring the panel back — nothing else needs to change.
const SHOW_SMARTMOVING_REST_SYNC = false;

export default function SyncPanel({ syncStatus, onSyncNow, lastSyncedAt, smartInsightsSyncStatus, onSyncSmartInsightsNow }) {
  const last = lastSyncedAt ? lastSyncedAt.toLocaleString() : 'never';
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showSyncMsg, setShowSyncMsg] = useState(true);
  const [showSmartInsightsMsg, setShowSmartInsightsMsg] = useState(true);

  // Result/error lines below auto-hide 3s after a sync finishes instead of staying pinned on
  // screen until the next sync — once read, there's nothing actionable left in them (the button's
  // own label already shows the loading state), so leaving them up forever just clutters the page.
  // Re-triggers on every new message/error (not just once), so back-to-back syncs each get their
  // own fresh 3s window.
  useEffect(() => {
    if (!syncStatus.message && !syncStatus.error) return;
    setShowSyncMsg(true);
    const t = setTimeout(() => setShowSyncMsg(false), 3000);
    return () => clearTimeout(t);
  }, [syncStatus.message, syncStatus.error]);

  useEffect(() => {
    if (!smartInsightsSyncStatus?.message && !smartInsightsSyncStatus?.error) return;
    setShowSmartInsightsMsg(true);
    const t = setTimeout(() => setShowSmartInsightsMsg(false), 3000);
    return () => clearTimeout(t);
  }, [smartInsightsSyncStatus?.message, smartInsightsSyncStatus?.error]);

  const rangeInvalid = fromDate && toDate && fromDate > toDate;

  return (
    <div className="sync-panel">
      {SHOW_SMARTMOVING_REST_SYNC && (
        <>
          <h3>SmartMoving Sync</h3>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            The backend pulls jobs that need dispatching from SmartMoving automatically (webhooks + a
            periodic poll) and writes them into the shared database — they'll appear here on their own.
            Board last loaded: {last}.
          </div>
          <div className="sync-row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
            <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              From (optional)
              <input
                type="date"
                value={fromDate}
                max={toDate || undefined}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </label>
            <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
              To (optional)
              <input
                type="date"
                value={toDate}
                min={fromDate || undefined}
                onChange={(e) => setToDate(e.target.value)}
              />
            </label>
            <button
              className="btn"
              onClick={() => onSyncNow({ from: fromDate || undefined, to: toDate || undefined })}
              disabled={syncStatus.loading || rangeInvalid}
            >
              {syncStatus.loading ? 'Syncing…' : 'Sync now'}
            </button>
            {(fromDate || toDate) && (
              <button
                className="btn secondary"
                type="button"
                onClick={() => { setFromDate(''); setToDate(''); }}
                disabled={syncStatus.loading}
              >
                Clear range
              </button>
            )}
          </div>
          {rangeInvalid && <div className="sync-msg err">"From" must be on or before "To".</div>}
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            Leave both blank to use the backend's default sync window. Set a range to check a specific
            period against SmartMoving's dispatch calendar — this only affects this one sync, it doesn't
            change the automatic background poll.
          </div>
          <div className="oneway-note">
            ⚠ One-way sync: this pulls jobs FROM SmartMoving only. Truck/driver assignments and any
            date or time edits made in this scheduler are <b>not</b> pushed back to SmartMoving —
            SmartMoving's API doesn't support that yet. Update SmartMoving manually to keep both
            systems in sync. Jobs imported from SmartMoving are marked <span className="sm-badge">SM</span>.
          </div>
        </>
      )}

      <h3 style={{ marginTop: SHOW_SMARTMOVING_REST_SYNC ? 18 : 0 }}>Smart Insights Report Sync</h3>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        Separately, two reports emailed from SmartMoving (Smart Insights → Booked Opportunities, for
        customer/address details, and All Jobs, for the actual booked jobs) are checked automatically
        twice a day, at 12:00 PM and 4:00 PM ET, and joined together onto the board — no API quota
        used. Only jobs whose opportunity appears in the Booked Opportunities report are
        added (so customer name/address is always known); one opportunity can become several jobs
        on the board (one per Job Number marked "Booked" in the All Jobs report). Jobs from this
        source are marked <span className="si-badge">SI</span>. If a manually added placeholder
        job's customer name matches one of these, a duplicate alert shows above the board.
      </div>
      <div className="sync-row">
        <button
          className="btn"
          onClick={onSyncSmartInsightsNow}
          disabled={smartInsightsSyncStatus?.loading}
        >
          {smartInsightsSyncStatus?.loading ? 'Checking…' : 'Check for report now'}
        </button>
        {/* Re-surfaced 2026-08-27 (was only reachable via the hidden REST-sync panel above — see
            SHOW_SMARTMOVING_REST_SYNC's comment, still off) at the user's request for a visible way
            to force a sync without waiting for the next scheduled run. Same onSyncNow the hidden
            panel's own button calls (POST /api/sync-now on the backend), which runs BOTH the REST
            poll and the Google Calendar sync (see server.js) — the calendar sync is what actually
            carries truck/driver assignment data and merges iCal/Smart-Insights records, so this is
            the one to use to force a specific job (e.g. a corrected long-distance flag) to refresh
            immediately instead of waiting for calendarSweepScheduled's next 8am/12pm/4pm ET run. No
            date range here (unlike the hidden panel's version) — plain onSyncNow({}) uses the
            backend's own default lookback/lookahead window, which covers "did this job's data
            change" without needing a dispatcher to pick dates for what's meant to be a quick nudge. */}
        <button
          className="btn"
          onClick={() => onSyncNow({})}
          disabled={syncStatus.loading}
          title="Pull the latest jobs from SmartMoving (REST + calendar) right now — the same sync that already runs automatically every few hours."
        >
          {syncStatus.loading ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {showSmartInsightsMsg && smartInsightsSyncStatus?.message && <div className="sync-msg ok">{smartInsightsSyncStatus.message}</div>}
      {showSmartInsightsMsg && smartInsightsSyncStatus?.error && <div className="sync-msg err">{smartInsightsSyncStatus.error}</div>}
      {showSyncMsg && syncStatus.message && <div className="sync-msg ok">{syncStatus.message}</div>}
      {showSyncMsg && syncStatus.error && <div className="sync-msg err">{syncStatus.error}</div>}
    </div>
  );
}
