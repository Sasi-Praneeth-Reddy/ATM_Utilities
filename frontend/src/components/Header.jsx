import JobSearch from './board/JobSearch';
import { useRegisteredPageSearch } from '../hooks/usePageSearch';

/** The title-bar search while the open page has registered its own search (see hooks/usePageSearch.js):
    same look as the job search, but it filters that page's data in place. */
function PageSearchBox({ search }) {
  return (
    <div className="job-search page-search">
      <input
        type="text"
        className="job-search-input"
        placeholder={search.placeholder}
        aria-label={search.placeholder}
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') search.onChange(''); }}
      />
      {search.value && <button type="button" className="list-search-clear" onClick={() => search.onChange('')} title="Clear search" aria-label="Clear search">×</button>}
    </div>
  );
}

/** Top bar of the CRM shell: sidebar toggle, breadcrumb, global job search, user controls. */
export default function Header({
  user, onLogout, role, roleLabel, trucks, jobs, onJumpToJob, crewTruck, onCrewTruckChange,
  theme, onToggleTheme, onToggleSidebar, moduleLabel, tabLabel, jobSearch,
}) {
  const pageSearch = useRegisteredPageSearch();
  return (
    <header className="topbar">
      <button type="button" className="topbar-icon-btn" onClick={onToggleSidebar} aria-label="Toggle sidebar">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" />
        </svg>
      </button>
      <div className="crumbs">
        <span>{moduleLabel}</span>
        {tabLabel && tabLabel !== moduleLabel && (<><span aria-hidden="true">/</span><strong>{tabLabel}</strong></>)}
      </div>

      {/* Page-aware: a page that registered its own search (Leads, Storage, Users, ...) gets it here; the
          job pages (Board, My Jobs, Long Distance) keep the jump-to-job search with a page-specific hint;
          anywhere else there is nothing to search, so no box. */}
      {pageSearch
        ? <PageSearchBox search={pageSearch} />
        : (jobSearch && jobs && onJumpToJob && (
          <JobSearch
            jobs={jobSearch.longDistanceOnly ? jobs.filter((j) => j.type === 'long_distance') : jobs}
            trucks={trucks}
            onJumpToJob={onJumpToJob}
            placeholder={jobSearch.placeholder}
            emptyNoun={jobSearch.longDistanceOnly ? 'long-distance jobs' : 'jobs'}
          />
        ))}

      <div className="role-switch">
        {role === 'crew' && (
          <select value={crewTruck} onChange={(e) => onCrewTruckChange(e.target.value)}>
            {trucks.map((t) => (<option key={t.id} value={t.id}>{t.name} — {t.size}</option>))}
          </select>
        )}
        <span className="topbar-user">{user.email} <span style={{ opacity: 0.7 }}>({roleLabel || role})</span></span>
        {onToggleTheme && (
          <button
            className="theme-toggle"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to day view' : 'Switch to night view'}
            aria-label={theme === 'dark' ? 'Switch to day view' : 'Switch to night view'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        )}
        <button className="btn secondary" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}
