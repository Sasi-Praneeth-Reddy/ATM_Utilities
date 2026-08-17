import { useState } from 'react';

export default function SyncPanel({ syncStatus, onSyncNow, lastSyncedAt }) {
  const last = lastSyncedAt ? lastSyncedAt.toLocaleString() : 'never';
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const rangeInvalid = fromDate && toDate && fromDate > toDate;

  return (
    <div className="sync-panel">
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
      {syncStatus.message && <div className="sync-msg ok">{syncStatus.message}</div>}
      {syncStatus.error && <div className="sync-msg err">{syncStatus.error}</div>}
      <div className="oneway-note">
        ⚠ One-way sync: this pulls jobs FROM SmartMoving only. Truck/driver assignments and any
        date or time edits made in this scheduler are <b>not</b> pushed back to SmartMoving —
        SmartMoving's API doesn't support that yet. Update SmartMoving manually to keep both
        systems in sync. Jobs imported from SmartMoving are marked <span className="sm-badge">SM</span>.
      </div>
    </div>
  );
}
