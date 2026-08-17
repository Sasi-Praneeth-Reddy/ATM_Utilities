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

export default function Nav({ role, activeTab, onTabChange }) {
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
        </button>
      ))}
    </nav>
  );
}
