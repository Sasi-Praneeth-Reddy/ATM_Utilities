import JobSearch from './board/JobSearch';

/** Top bar of the CRM shell: sidebar toggle, breadcrumb, global job search, user controls. */
export default function Header({
  user, onLogout, role, trucks, jobs, onJumpToJob, crewTruck, onCrewTruckChange,
  theme, onToggleTheme, onToggleSidebar, moduleLabel, tabLabel,
}) {
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

      {jobs && onJumpToJob && <JobSearch jobs={jobs} trucks={trucks} onJumpToJob={onJumpToJob} />}

      <div className="role-switch">
        {role === 'crew' && (
          <select value={crewTruck} onChange={(e) => onCrewTruckChange(e.target.value)}>
            {trucks.map((t) => (<option key={t.id} value={t.id}>{t.name} — {t.size}</option>))}
          </select>
        )}
        <span className="topbar-user">{user.email} <span style={{ opacity: 0.7 }}>({role})</span></span>
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
