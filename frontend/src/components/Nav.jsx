const SCHEDULER_TABS_BY_ROLE = {
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

const MARKET_TABS = [
  { id: 'leads', label: '🏠 Pre-Mover Leads & Matches' },
  { id: 'storage', label: '📦 Self-Storage Tracker' },
  { id: 'benchmarks', label: '📈 Real Estate Benchmarks' },
];

/** `alertTabs`: { [tabId]: 'tooltip text' } — shows a small red dot on that tab */
export default function Nav({ role, activeTab, onTabChange, activeModule = 'scheduler', alertTabs = {} }) {
  const tabs =
    activeModule === 'market'
      ? MARKET_TABS
      : SCHEDULER_TABS_BY_ROLE[role] || SCHEDULER_TABS_BY_ROLE.dispatcher;

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
