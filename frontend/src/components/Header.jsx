import { useRef } from 'react';
import JobSearch from './board/JobSearch';

// Click 5 within this window to trip the secret trigger; a slower click just resets the counter
// with no visible feedback either way — see the logo's onClick below.
const SECRET_CLICK_COUNT = 5;
const SECRET_CLICK_WINDOW_MS = 2000;

export default function Header({
  user,
  onLogout,
  role,
  trucks,
  jobs,
  onJumpToJob,
  crewTruck,
  onCrewTruckChange,
  theme,
  onToggleTheme,
  onOpenDeletedJobs,
  activeModule = 'scheduler',
  onSelectModule,
}) {
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
          <span>{activeModule === 'market' ? 'Market Intelligence' : 'Scheduler'}</span>
        </div>
      </div>

      {/* Module Switcher (Clean UI Separation between Dispatch Scheduler & Market Intelligence) */}
      {role !== 'crew' && onSelectModule && (
        <div style={{
          display: 'flex',
          backgroundColor: 'var(--bg-subtle, #f1f5f9)',
          padding: '3px',
          borderRadius: '8px',
          border: '1px solid var(--border-color, #e2e8f0)',
          margin: '0 14px'
        }}>
          <button
            type="button"
            onClick={() => onSelectModule('scheduler')}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeModule === 'scheduler' ? 'var(--bg-card, #ffffff)' : 'transparent',
              color: activeModule === 'scheduler' ? '#2b6cb0' : '#64748b',
              boxShadow: activeModule === 'scheduler' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              transition: 'all 0.15s ease'
            }}
          >
            🚚 Dispatch Scheduler
          </button>
          <button
            type="button"
            onClick={() => onSelectModule('market')}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              backgroundColor: activeModule === 'market' ? 'var(--bg-card, #ffffff)' : 'transparent',
              color: activeModule === 'market' ? '#2b6cb0' : '#64748b',
              boxShadow: activeModule === 'market' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              transition: 'all 0.15s ease'
            }}
          >
            📊 Market & Leads
          </button>
        </div>
      )}

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
