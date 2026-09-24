import { useRef } from 'react';
import JobSearch from './board/JobSearch';

// Click 5 within this window to trip the secret trigger; a slower click just resets the counter
// with no visible feedback either way — see the logo's onClick below.
const SECRET_CLICK_COUNT = 5;
const SECRET_CLICK_WINDOW_MS = 2000;

export default function Header({ user, onLogout, role, trucks, jobs, onJumpToJob, crewTruck, onCrewTruckChange, theme, onToggleTheme, onOpenDeletedJobs }) {
  // Hidden trigger for the Deleted Jobs archive (added 2026-09-24, at the user's request: "place
  // this deleted jobs button in a very secret place only i should know it"): clicking the "ATM"
  // logo 5 times within 2 seconds opens DeletedJobsPanel, admin-only. Deliberately no visible
  // affordance beyond the cursor change in styles.css (.brand .logo) — a counter/tooltip/badge
  // would defeat the point of it being secret. Kept as a plain ref (not state) since the click
  // count itself never needs to trigger a re-render — only the resulting onOpenDeletedJobs() call
  // does anything visible.
  const clickTimestampsRef = useRef([]);
  function handleLogoClick() {
    if (role !== 'admin' || !onOpenDeletedJobs) return;
    const now = Date.now();
    const recent = clickTimestampsRef.current.filter((t) => now - t < SECRET_CLICK_WINDOW_MS);
    recent.push(now);
    clickTimestampsRef.current = recent;
    if (recent.length >= SECRET_CLICK_COUNT) {
      clickTimestampsRef.current = [];
      onOpenDeletedJobs();
    }
  }

  return (
    <header>
      <div className="brand">
        <div className="logo" onClick={handleLogoClick}>ATM</div>
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
