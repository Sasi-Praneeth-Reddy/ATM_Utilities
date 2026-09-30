const TABS_BY_ROLE = {
  crew: [
    { id: 'crew', label: 'My Jobs' },
    { id: 'board', label: 'Truck Board' },
  ],
  dispatcher: [
    { id: 'board', label: 'Truck Board' },
    { id: 'ld', label: 'Long Distance Planner' },
  ],
  admin: [
    { id: 'board', label: 'Truck Board' },
    { id: 'ld', label: 'Long Distance Planner' },
    { id: 'admin', label: 'Trucks & Drivers' },
    { id: 'assignments', label: 'Job Assignments' },
    { id: 'users', label: 'Users' },
  ],
};

/** `alertTabs` (added 2026-09-30): { [tabId]: 'tooltip text' } — shows a small red dot on that tab,
 * e.g. the Job Assignments tab when the Gmail authorization is expiring (see App.jsx). */
export default function Nav({ role, activeTab, onTabChange, alertTabs = {} }) {
  const tabs = TABS_BY_ROLE[role] || TABS_BY_ROLE.dispatcher;
  return (
    <nav>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={activeTab === tab.id ? 'active' : ''}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.label}
          {alertTabs[tab.id] && (
            <span className="nav-alert-dot" title={alertTabs[tab.id]} aria-label={alertTabs[tab.id]} />
          )}
        </button>
      ))}
    </nav>
  );
}
