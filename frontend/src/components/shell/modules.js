// Single source of truth for the CRM shell: which modules exist, which tabs each one holds, and
// who may see them. Adding a module later = one entry here + (for a real module) its tab render in
// App.jsx. `soon: true` modules show in the sidebar (admins only) with a "Soon" badge.

export const TAB_LABELS = {
  board: 'Truck Board',
  admin: 'Trucks & Drivers',
  assignments: 'Job Assignments',
  users: 'Users & Access',
  crew: 'My Jobs',
  ld: 'Long Distance Planner',
  leads: 'Pre-Mover Leads & Matches',
  storage: 'Storage Tracker',
  benchmarks: 'Real Estate Benchmarks',
  whatsnew: "What's New",
  'tk-summary': 'Summary',
  'tk-dispatch': 'Dispatch Notes & Materials',
  'map-local': 'Local — Day View',
  'map-ld': 'Long Distance Trips',
};

const STAFF = ['admin', 'dispatcher'];

export const MODULES = [
  // Tasking (docs/TASKING.md): the office's daily pending-actions board + dispatch notes/materials.
  { id: 'tasking', label: 'Tasking', icon: 'tasking', roles: STAFF, tabsByRole: { admin: ['tk-summary', 'tk-dispatch'], dispatcher: ['tk-summary', 'tk-dispatch'] } },
  {
    id: 'dispatch', label: 'Dispatch', icon: 'dispatch',
    tabsByRole: { crew: ['crew', 'board'], dispatcher: ['board'], admin: ['board', 'admin', 'assignments'] },
  },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', soon: true },
  { id: 'storage-ops', label: 'Storage', icon: 'storage', soon: true },
  { id: 'military', label: 'Military', icon: 'military', soon: true },
  { id: 'longdist', label: 'Long Dist.', icon: 'longdist', roles: STAFF, tabsByRole: { admin: ['ld'], dispatcher: ['ld'] } },
  { id: 'referrals', label: 'Referrals', icon: 'referrals', soon: true },
  { id: 'leads', label: 'Leads', icon: 'leads', roles: STAFF, tabsByRole: { admin: ['leads'], dispatcher: ['leads'] } },
  { id: 'market', label: 'Market', icon: 'market', roles: STAFF, tabsByRole: { admin: ['storage', 'benchmarks'], dispatcher: ['storage', 'benchmarks'] } },
  // Map (components/map/MapView.jsx): read-only for every role, nobody can edit anything here.
  { id: 'map', label: 'Map', icon: 'map', tabsByRole: { crew: ['map-local', 'map-ld'], dispatcher: ['map-local', 'map-ld'], admin: ['map-local', 'map-ld'] } },
  { id: 'kpis', label: 'KPIs', icon: 'kpis', soon: true },
  // Release notes + version, open to every role. `badge` shows a small pill in the sidebar; remove it
  // (or change the text) once a release is no longer new.
  // Admin-only housekeeping. People who can sign in are not a dispatch concern, so Users lives here
  // (more settings pages can be added to this tab list later).
  { id: 'settings', label: 'Settings', icon: 'settings', roles: ['admin'], topOnly: true, tabsByRole: { admin: ['users'] } },
  { id: 'whatsnew', label: "What's New", icon: 'sparkle', badge: 'New', tabsByRole: { crew: ['whatsnew'], dispatcher: ['whatsnew'], admin: ['whatsnew'] } },
];

export function tabsFor(mod, role, isTopRole = false) {
  // topOnly modules (Settings > Users) are for owner/developer; an admin doesn't see them.
  if (mod.topOnly && !isTopRole) return [];
  return (mod.tabsByRole && mod.tabsByRole[role]) || [];
}

/** Modules this role sees in the sidebar. "Coming soon" ones are admin-only so crew/dispatchers
    don't see dead links. */
export function visibleModules(role, isTopRole = false) {
  return MODULES.filter((m) => {
    if (m.soon) return role === 'admin';
    if (m.roles && !m.roles.includes(role)) return false;
    return tabsFor(m, role, isTopRole).length > 0;
  });
}

export function moduleOfTab(tabId, role, isTopRole = false) {
  return MODULES.find((m) => !m.soon && tabsFor(m, role, isTopRole).includes(tabId)) || null;
}
