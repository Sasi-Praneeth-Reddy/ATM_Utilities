import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtDate, fmtMoney, countdown } from './taskingUtils';

/**
 * "Upcoming jobs not secured" list on the Tasking Summary page.
 *
 * Shows the rows the server already sorted (soonest first) as a compact list with:
 *  - a totals strip (how many jobs, how much estimate value is at risk),
 *  - quick filters by urgency (all / within 3 days / within 7 days),
 *  - pages of PAGE_SIZE rows with Previous / Next, inside a fixed-height area that scrolls
 *    on its own, so a long list never stretches the whole Summary page.
 *
 * Display only: it does not save anything. `rows` is `data.notSecured` from GET /api/tasking/summary.
 */
const PAGE_SIZE = 8;

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'd3', label: 'Within 3 days', test: (n) => n.daysLeft <= 3 },
  { id: 'd7', label: 'Within 7 days', test: (n) => n.daysLeft <= 7 },
];

/** Colour for a reason chip: unsigned/unsent estimate is the bigger risk, "not checked" is neutral. */
function reasonClass(reason) {
  if (reason.startsWith('Estimate')) return 'tk-red';
  if (reason.startsWith('No deposit')) return 'tk-amber';
  return 'tk-neutral';
}

export default function NotSecuredList({ rows }) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const listRef = useRef(null);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter(f.test).length])),
    [rows],
  );
  const shown = useMemo(() => rows.filter(FILTERS.find((f) => f.id === filter).test), [rows, filter]);
  const atRisk = useMemo(() => shown.reduce((sum, n) => sum + (Number(n.estimatedTotal) || 0), 0), [shown]);

  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1); // stay in range when the list shrinks after a refresh
  const start = current * PAGE_SIZE;
  const pageRows = shown.slice(start, start + PAGE_SIZE);

  // Back to the top of the scroll area whenever the page or filter changes.
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [current, filter]);

  function pickFilter(id) { setFilter(id); setPage(0); }

  return (
    <div className="tk-ns">
      <div className="tk-ns-bar">
        <div className="tk-ns-filters" role="group" aria-label="Filter by how soon the job is">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" className={`tk-chip${filter === f.id ? ' active' : ''}`}
              aria-pressed={filter === f.id} onClick={() => pickFilter(f.id)}>
              {f.label}<span className="tk-chip-n">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="tk-ns-total"><b>{fmtMoney(atRisk)}</b> in estimates at risk</div>
      </div>

      {!shown.length ? <div className="tk-empty">No jobs in this range.</div> : (
        <ul className="tk-ns-list" ref={listRef}>
          {pageRows.map((n) => {
            const cd = countdown(n.daysLeft);
            return (
              <li key={n.oppId} className={`tk-ns-row ${cd.cls}-edge`}>
                <div className={`tk-ns-days ${cd.cls}`}>{cd.text}</div>
                <div className="tk-ns-main">
                  <div className="tk-ns-name">
                    <b>{n.customer}</b>{n.quote ? <span className="tk-sub">#{n.quote}</span> : null}
                  </div>
                  <div className="tk-ns-meta">
                    <span>{fmtDate(n.serviceDate)}</span>
                    {n.phone && <a className="tk-ns-phone" href={`tel:${n.phone}`}>{n.phone}</a>}
                  </div>
                  <div className="tk-ns-why">
                    {n.reasons.map((r) => <span key={r} className={`tk-pill ${reasonClass(r)}`}>{r}</span>)}
                  </div>
                </div>
                <div className="tk-ns-amt">{fmtMoney(n.estimatedTotal)}</div>
              </li>
            );
          })}
        </ul>
      )}

      {shown.length > PAGE_SIZE && (
        <div className="tk-ns-foot">
          <span className="tk-sub">{start + 1}–{start + pageRows.length} of {shown.length}</span>
          <div className="tk-ns-pager">
            <button type="button" className="btn secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>← Previous</button>
            <span className="tk-sub">Page {current + 1} of {pages}</span>
            <button type="button" className="btn secondary" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}
