export default function SyncPanel({ syncStatus, onSyncNow, lastSyncedAt }) {
  const last = lastSyncedAt ? lastSyncedAt.toLocaleString() : 'never';
  return (
    <div className="sync-panel">
      <h3>SmartMoving Sync</h3>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>
        The backend pulls jobs that need dispatching from SmartMoving automatically (webhooks + a
        periodic poll) and writes them into the shared database — they'll appear here on their own.
        Board last loaded: {last}.
      </div>
      <div className="sync-row">
        <button className="btn" onClick={onSyncNow} disabled={syncStatus.loading}>
          {syncStatus.loading ? 'Syncing…' : 'Sync now'}
        </button>
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
