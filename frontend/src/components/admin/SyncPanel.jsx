import { useEffect, useState } from 'react';

// Hidden 2026-08-24 at the user's request ("hide this one for now") — the REST-poll SmartMoving
// sync panel below (webhooks + periodic poll, "Sync now" with a date range). Not removed: the
// underlying sync (onSyncNow, the /api/sync-now endpoint, the background poll itself) keeps
// running exactly as before, only its manual-trigger UI panel is hidden. Flip this back to true to
// bring the panel back — nothing else needs to change.
const SHOW_SMARTMOVING_REST_SYNC = false;

/** Formats an ISO date string the way the rest of this panel already formats dates (see
 *  SyncPanel's own toLocaleString usage below) — just the date, no time, since the exact hour a
 *  re-auth happened/is due doesn't matter here the way it does for lastSyncedAt. */
function fmtDay(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The "Gmail authorization" countdown — added 2026-09-08 at the user's request, so the 7-day
 *  Testing-mode refresh-token expiry (see smartInsightsGmail.js's file header) shows up here as a
 *  heads-up well before it actually breaks a sync, instead of only being discovered from an
 *  invalid_grant error. `status` is exactly what GET /api/gmail-auth-status returns (see
 *  useSchedulerData.js's loadGmailAuthStatus) — null while it hasn't loaded yet (renders nothing,
 *  same as a non-admin who gets nothing back at all), `{tracked: false}` if gmail-oauth-setup.js
 *  has never recorded a re-auth (a fresh setup, or one run before this feature existed) — shown as
 *  a quiet note rather than a false "expired" alarm, since there's no timestamp to measure from.
 *  Three severity levels once it IS tracked: plain info with days to spare, an amber heads-up once
 *  within GMAIL_AUTH_WARNING_DAYS, and a red alert once actually expired. */
const GMAIL_AUTH_WARNING_DAYS = 2;
function GmailAuthStatusLine({ status }) {
  if (!status) return null;
  if (!status.tracked) {
    return (
      <div className="sync-msg" style={{ color: 'var(--muted)' }}>
        Gmail authorization isn't being tracked yet — run <code>npm run gmail-auth</code> once (see
        server/gmail-oauth-setup.js) to start the 7-day countdown here.
      </div>
    );
  }
  if (status.expired) {
    const daysAgo = Math.abs(status.daysRemaining);
    return (
      <div className="sync-msg err">
        ⚠ Gmail authorization expired {daysAgo === 0 ? 'today' : `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`} —
        report sync and calendar sync will fail (invalid_grant) until you re-run <code>npm run gmail-auth</code>.
      </div>
    );
  }
  if (status.daysRemaining <= GMAIL_AUTH_WARNING_DAYS) {
    return (
      <div className="sync-msg err">
        Gmail authorization expires in {status.daysRemaining} day{status.daysRemaining === 1 ? '' : 's'}
        {' '}(by {fmtDay(status.expiresAt)}) — re-run <code>npm run gmail-auth</code> soon to avoid a sync failure.
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, color: 'var(--muted)' }}>
      Gmail authorization renews by {fmtDay(status.expiresAt)} ({status.daysRemaining} days left).
    </div>
  );
}

export default function SyncPanel({
  syncStatus, onSyncNow, lastSyncedAt,
  calendarSyncStatus, onSyncCalendarNow,
  smartInsightsSyncStatus, onSyncSmartInsightsNow, gmailAuthStatus,
}) {
  const last = lastSyncedAt ? lastSyncedAt.toLocaleString() : 'never';
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showSyncMsg, setShowSyncMsg] = useState(true);
  const [showCalendarSyncMsg, setShowCalendarSyncMsg] = useState(true);
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
    if (!calendarSyncStatus?.message && !calendarSyncStatus?.error) return;
    setShowCalendarSyncMsg(true);
    const t = setTimeout(() => setShowCalendarSyncMsg(false), 3000);
    return () => clearTimeout(t);
  }, [calendarSyncStatus?.message, calendarSyncStatus?.error]);

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
      <GmailAuthStatusLine status={gmailAuthStatus} />
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
            to force a sync without waiting for the next scheduled run. Calls onSyncNow (POST
            /api/sync-now on the backend) — the SmartMoving REST poll sweep only, as of the
            2026-09-08 split below. No date range here (unlike the hidden panel's version) — plain
            onSyncNow({}) uses the backend's own default lookback/lookahead window, which covers "did
            this job's data change" without needing a dispatcher to pick dates for what's meant to be
            a quick nudge. */}
        <button
          className="btn"
          onClick={() => onSyncNow({})}
          disabled={syncStatus.loading}
          title="Pull the latest jobs from SmartMoving (REST poll) right now — the same sync that already runs automatically every few hours."
        >
          {syncStatus.loading ? 'Syncing…' : 'Sync now'}
        </button>
        {/* Split out 2026-09-08 (at the user's request) from the button above, which used to run this
            same Google Calendar sync sequentially right after the REST poll sweep, inside one
            request. That meant a slow/timed-out REST poll (the backend's 60s request timeout, hit
            under real data volume) silently prevented the calendar sync from running at all in that
            attempt — even though the calendar sync itself is what actually carries truck/driver
            assignment data and merges iCal/Smart-Insights records, and was otherwise healthy. Now
            it's its own button/request, so it can be used (and can succeed or fail) independently —
            e.g. to force a corrected long-distance flag to refresh immediately instead of waiting for
            calendarSweepScheduled's next 8:00am/1:00pm/4:03pm ET run. */}
        <button
          className="btn"
          onClick={onSyncCalendarNow}
          disabled={calendarSyncStatus?.loading}
          title="Pull the latest events from Google Calendar right now — the same sync that already runs automatically at 8:00am/1:00pm/4:03pm ET."
        >
          {calendarSyncStatus?.loading ? 'Syncing…' : 'Sync calendar'}
        </button>
      </div>
      {showSmartInsightsMsg && smartInsightsSyncStatus?.message && <div className="sync-msg ok">{smartInsightsSyncStatus.message}</div>}
      {showSmartInsightsMsg && smartInsightsSyncStatus?.error && <div className="sync-msg err">{smartInsightsSyncStatus.error}</div>}
      {showSyncMsg && syncStatus.message && <div className="sync-msg ok">{syncStatus.message}</div>}
      {showSyncMsg && syncStatus.error && <div className="sync-msg err">{syncStatus.error}</div>}
      {showCalendarSyncMsg && calendarSyncStatus?.message && <div className="sync-msg ok">{calendarSyncStatus.message}</div>}
      {showCalendarSyncMsg && calendarSyncStatus?.error && <div className="sync-msg err">{calendarSyncStatus.error}</div>}
    </div>
  );
}
