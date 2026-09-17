import JobSearch from './board/JobSearch';

export default function Header({ user, onLogout, role, trucks, jobs, onJumpToJob, crewTruck, onCrewTruckChange, theme, onToggleTheme }) {
  return (
    <header>
      <div className="brand">
        <div className="logo">ATM</div>
        <div>
          <h1>Around Town Movers</h1>
          <span>Scheduler</span>
        </div>
      </div>
      {/* Moved here from the Board tab's toolbar 2026-09-10 at the user's request — living in the
          title bar instead means it's reachable from every tab (Admin, Assignments, Users, Crew),
          not just Board. Available to every role, crew included: a picked result always switches to
          the Board tab's day view (see App.jsx's handleJumpToJob), which crew already sees in its
          own view-only form (BoardTab's title reads "view only" for role==='crew'), so there's
          nothing here a crew member couldn't already reach by clicking around. The `jobs &&
          onJumpToJob` guard is just for the brief render before App.jsx's data/handlers exist, not
          a role check.*/}
      {jobs && onJumpToJob && <JobSearch jobs={jobs} trucks={trucks} onJumpToJob={onJumpToJob} />}
      <div className="role-switch">
        {role === 'crew' && (
          <select value={crewTruck} onChange={(e) => onCrewTruckChange(e.target.value)}>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {t.size}</option>
            ))}
          </select>
        )}
        <span>{user.email} <span style={{ opacity: 0.7 }}>({role})</span></span>
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
