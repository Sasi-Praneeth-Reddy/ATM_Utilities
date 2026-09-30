import { useMemo, useState } from 'react';

/**
 * Search + fixed-size paging for the Trucks & Drivers lists (added 2026-09-30, user request:
 * search bar per list, 10 per page). `matchFn(item, lowercasedQuery)` decides what a search hits.
 */
export function usePagedSearch(items, matchFn, pageSize = 10) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((it) => matchFn(it, q)) : items;
  }, [items, matchFn, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);

  return {
    query,
    setQuery: (v) => { setQuery(v); setPage(1); },
    page: currentPage, totalPages, setPage: (n) => setPage(Math.min(Math.max(n, 1), totalPages)),
    filtered, pageItems, start,
  };
}

export function ListSearch({ value, onChange, placeholder }) {
  return (
    <div className="list-search">
      <input
        type="text"
        className="job-search-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && <button className="list-search-clear" onClick={() => onChange('')} title="Clear search">×</button>}
    </div>
  );
}

export function SimplePager({ paged, noun }) {
  const { filtered, page, totalPages, setPage, start, pageItems } = paged;
  if (!filtered.length) return null;
  return (
    <div className="pager pager-compact">
      <span className="pager-info">
        {start + 1}–{start + pageItems.length} of {filtered.length} {noun}
      </span>
      {totalPages > 1 && (
        <div className="pager-controls">
          <button className="btn secondary" onClick={() => setPage(page - 1)} disabled={page <= 1}>‹ Prev</button>
          <span className="pager-page">{page} / {totalPages}</span>
          <button className="btn secondary" onClick={() => setPage(page + 1)} disabled={page >= totalPages}>Next ›</button>
        </div>
      )}
    </div>
  );
}
