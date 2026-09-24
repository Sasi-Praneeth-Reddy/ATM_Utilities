import { useEffect, useMemo, useState } from 'react';

/** The "very secret place only i should know" archive view (added 2026-09-24, at the user's
 * request that deleted jobs be stored somewhere hidden, "only i should know it", with who deleted
 * each one and when). Reachable only by clicking Header.jsx's logo 5 times within 2 seconds, and
 * only when role === 'admin' — see Header.jsx's own click-counter for the trigger, and
 * server.js's GET /api/deleted-jobs / POST /api/deleted-jobs/:id/restore / DELETE
 * /api/deleted-jobs/:id for the matching admin-only server-side gates (so the restriction holds
 * even if someone else discovers the click pattern by accident).
 *
 * Fetched lazily — only when opened, never as part of the normal trucks/drivers/jobs poll — see
 * useSchedulerData.js's fetchDeletedJobs doc comment for why.
 *
 * Search + multi-select + bulk permanent delete added 2026-09-24, same day, right after a 131-job
 * Smart Insights cleanup (see smartInsightsSync.js's TERMINAL_JOB_STATUSES doc comment) dumped a
 * wall of near-identical "Quote NNNNN-N" rows in here — restoring or hunting through those one row
 * at a time isn't realistic at that volume, and neither is finding one specific real job (the user's
 * own example: a since-deleted "Servpro" job) buried in the middle of it. */
export default function DeletedJobsPanel({ open, onClose, fetchDeletedJobs, onRestore, onPermanentlyDelete }) {
  const [items, setItems] = useState(null); // null = still loading
  const [loadError, setLoadError] = useState('');
  const [restoringId, setRestoringId] = useState(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setItems(null);
    setLoadError('');
    setQuery('');
    setSelected(new Set());
    fetchDeletedJobs()
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((err) => { if (!cancelled) setLoadError(err.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [open, fetchDeletedJobs]);

  // Matches on customer name, job id (e.g. "SI-24231-1" or its bare number "24231"), and who
  // deleted it — covers "find the Servpro job" (customer) and "find everything from today's
  // cleanup" (id prefix) equally well. Client-side only: this list is already fully loaded (see
  // fetchDeletedJobs' doc comment — it's a single on-open fetch, not paginated), so there's no
  // reason to round-trip a search term to the server.
  const filtered = useMemo(() => {
    if (!items) return items;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((j) => (
      (j.customer || '').toLowerCase().includes(q)
      || j.id.toLowerCase().includes(q)
      || (j.deletedBy?.email || '').toLowerCase().includes(q)
    ));
  }, [items, query]);

  if (!open) return null;

  async function handleRestore(id) {
    setRestoringId(id);
    try {
      await onRestore(id);
      setItems((prev) => (prev ? prev.filter((j) => j.id !== id) : prev));
      setSelected((prev) => { if (!prev.has(id)) return prev; const next = new Set(prev); next.delete(id); return next; });
    } catch (err) {
      window.alert(`Couldn't restore this job: ${err.message}`);
    } finally {
      setRestoringId(null);
    }
  }

  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Selects/clears only what's currently VISIBLE (i.e. matches the search filter) — selecting
  // "all" while a search is narrowing the list should mean all of the filtered results, not every
  // archived job regardless of what's on screen; same convention most filtered-table "select all"
  // checkboxes use.
  const visibleIds = filtered ? filtered.map((j) => j.id) : [];
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  function toggleSelectAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...prev, ...visibleIds]);
    });
  }

  // Permanent, no undo — see db.js's permanentlyDeleteArchivedJob doc comment. Deliberately a
  // plain confirm() rather than the two-step DeleteConfirmModal flow the live board's delete uses:
  // this panel is already a hidden, admin-only, one-level-deeper archive (5-click logo trigger),
  // and the jobs it's acting on are already off the live board — the stakes of a mis-click here are
  // lower than deleting something still in active dispatch, so one clear confirmation is enough.
  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const label = ids.length === 1 ? 'this 1 job' : `these ${ids.length} jobs`;
    if (!window.confirm(`Permanently delete ${label}? This can't be undone.`)) return;
    setBulkDeleting(true);
    const failed = [];
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop -- deliberately sequential, not
        // Promise.all(...) — these hit the same admin-gated endpoint back-to-back; there's no
        // benefit to racing them and it keeps the failure list (below) attributable one at a time.
        await onPermanentlyDelete(id);
      } catch (err) {
        failed.push(`${id}: ${err.message}`);
      }
    }
    setBulkDeleting(false);
    setItems((prev) => (prev ? prev.filter((j) => !ids.includes(j.id) || failed.some((f) => f.startsWith(`${j.id}:`))) : prev));
    setSelected(new Set());
    if (failed.length > 0) window.alert(`${failed.length} job(s) couldn't be deleted:\n${failed.join('\n')}`);
  }

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <div className="job-edit-modal deleted-jobs-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Deleted Jobs</h3>
        {loadError && <div className="job-edit-error">{loadError}</div>}
        {items === null && !loadError && <p className="delete-confirm-body">Loading…</p>}
        {items && items.length === 0 && <p className="delete-confirm-body">Nothing deleted yet.</p>}
        {items && items.length > 0 && (
          <>
            <div className="deleted-jobs-toolbar">
              <input
                type="text"
                className="deleted-jobs-search"
                placeholder="Search by customer, job id, or who deleted it…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {selected.size > 0 && (
                <button
                  type="button"
                  className="btn danger"
                  disabled={bulkDeleting}
                  onClick={handleBulkDelete}
                >
                  {bulkDeleting ? 'Deleting…' : `Delete ${selected.size} selected permanently`}
                </button>
              )}
            </div>
            {filtered.length === 0 ? (
              <p className="delete-confirm-body">No deleted jobs match "{query}".</p>
            ) : (
              <div className="deleted-jobs-table-wrap">
                <table className="deleted-jobs-table">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          title="Select all shown"
                        />
                      </th>
                      <th>Job</th><th>Deleted by</th><th>When</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((j) => (
                      <tr key={j.id} className={selected.has(j.id) ? 'deleted-jobs-row-selected' : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(j.id)}
                            onChange={() => toggleSelected(j.id)}
                          />
                        </td>
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
          </>
        )}
        <div className="job-edit-actions">
          <span className="job-edit-actions-spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
