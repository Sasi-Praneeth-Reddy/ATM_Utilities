// Single source of truth for the CRM shell: which modules exist, which tabs each one holds, and
// who may see them. Adding a module later = one entry here + (for a real module) its tab render in
// App.jsx. `soon: true` modules show in the sidebar (admins only) with a "Soon" badge.

export const TAB_LABELS = {
  board: 'Truck Board',
  admin: 'Trucks & Drivers',
  assignments: 'Job Assignments',
  users: 'Users',
  crew: 'My Jobs',
  ld: 'Long Distance Planner',
  leads: 'Pre-Mover Leads & Matches',
  storage: 'Storage Tracker',
  benchmarks: 'Real Estate Benchmarks',
};

const STAFF = ['admin', 'dispatcher'];

export const MODULES = [
  { id: 'tasking', label: 'Tasking', icon: 'tasking', soon: true },
  {
    id: 'dispatch', label: 'Dispatch', icon: 'dispatch',
    tabsByRole: { crew: ['crew', 'board'], dispatcher: ['board'], admin: ['board', 'admin', 'assignments', 'users'] },
  },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', soon: true },
  { id: 'storage-ops', label: 'Storage', icon: 'storage', soon: true },
  { id: 'military', label: 'Military', icon: 'military', soon: true },
  { id: 'longdist', label: 'Long Dist.', icon: 'longdist', roles: STAFF, tabsByRole: { admin: ['ld'], dispatcher: ['ld'] } },
  { id: 'referrals', label: 'Referrals', icon: 'referrals', soon: true },
  { id: 'leads', label: 'Leads', icon: 'leads', roles: STAFF, tabsByRole: { admin: ['leads'], dispatcher: ['leads'] } },
  { id: 'market', label: 'Market', icon: 'market', roles: STAFF, tabsByRole: { admin: ['storage', 'benchmarks'], dispatcher: ['storage', 'benchmarks'] } },
  { id: 'map', label: 'Map', icon: 'map', soon: true },
  { id: 'kpis', label: 'KPIs', icon: 'kpis', soon: true },
];

export function tabsFor(mod, role) {
  return (mod.tabsByRole && mod.tabsByRole[role]) || [];
}

/** Modules this role sees in the sidebar. "Coming soon" ones are admin-only so crew/dispatchers
    don't see dead links. */
export function visibleModules(role) {
  return MODULES.filter((m) => {
    if (m.soon) return role === 'admin';
    if (m.roles && !m.roles.includes(role)) return false;
    return tabsFor(m, role).length > 0;
  });
}

export function moduleOfTab(tabId, role) {
  return MODULES.find((m) => !m.soon && tabsFor(m, role).includes(tabId)) || null;
}
