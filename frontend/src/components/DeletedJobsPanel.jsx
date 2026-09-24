import { useEffect, useState } from 'react';

/** The "very secret place only i should know" archive view (added 2026-09-24, at the user's
 * request that deleted jobs be stored somewhere hidden, "only i should know it", with who deleted
 * each one and when). Reachable only by clicking Header.jsx's logo 5 times within 2 seconds, and
 * only when role === 'admin' — see Header.jsx's own click-counter for the trigger, and
 * server.js's GET /api/deleted-jobs / POST /api/deleted-jobs/:id/restore for the matching
 * admin-only server-side gate (so the restriction holds even if someone else discovers the click
 * pattern by accident).
 *
 * Fetched lazily — only when opened, never as part of the normal trucks/drivers/jobs poll — see
 * useSchedulerData.js's fetchDeletedJobs doc comment for why. */
export default function DeletedJobsPanel({ open, onClose, fetchDeletedJobs, onRestore }) {
  const [items, setItems] = useState(null); // null = still loading
  const [loadError, setLoadError] = useState('');
  const [restoringId, setRestoringId] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setItems(null);
    setLoadError('');
    fetchDeletedJobs()
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((err) => { if (!cancelled) setLoadError(err.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [open, fetchDeletedJobs]);

  if (!open) return null;

  async function handleRestore(id) {
    setRestoringId(id);
    try {
      await onRestore(id);
      setItems((prev) => (prev ? prev.filter((j) => j.id !== id) : prev));
    } catch (err) {
      window.alert(`Couldn't restore this job: ${err.message}`);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <div className="job-edit-modal deleted-jobs-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Deleted Jobs</h3>
        {loadError && <div className="job-edit-error">{loadError}</div>}
        {items === null && !loadError && <p className="delete-confirm-body">Loading…</p>}
        {items && items.length === 0 && <p className="delete-confirm-body">Nothing deleted yet.</p>}
        {items && items.length > 0 && (
          <div className="deleted-jobs-table-wrap">
            <table className="deleted-jobs-table">
              <thead>
                <tr><th>Job</th><th>Deleted by</th><th>When</th><th /></tr>
              </thead>
              <tbody>
                {items.map((j) => (
                  <tr key={j.id}>
                    <td>{j.customer || j.id}</td>
                    <td>{j.deletedBy?.email || '—'}</td>
                    <td>{j.deletedAt ? new Date(j.deletedAt).toLocaleString() : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={restoringId === j.id}
                        onClick={() => handleRestore(j.id)}
                      >
                        {restoringId === j.id ? 'Restoring…' : 'Restore'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="job-edit-actions">
          <span className="job-edit-actions-spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
