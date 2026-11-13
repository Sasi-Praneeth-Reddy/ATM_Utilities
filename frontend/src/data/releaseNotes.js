// What's New content. Newest release first. To ship a new release: bump "version" in
// frontend/package.json and add a new object at the TOP of RELEASES. Write for dispatchers and
// crew, not developers — say what they will notice, not what changed in the code.
//
// audience: 'all' (everyone), 'staff' (admin + dispatcher), 'admin' (admins only) — items a person's
// role can't see are hidden so nobody reads about a screen they don't have.

export const RELEASES = [
  {
    version: '2.0.0',
    name: 'ATM Hub 2.0',
    date: '2026-11-04',
    tagline: 'The second major redesign: the scheduler is now one part of a bigger hub.',
    new: [
      {
        title: 'A new look and a sidebar',
        body: 'Everything now lives in one place. Pick a module in the sidebar on the left (Dispatch, Long Dist., Leads, Market), then use the tabs at the top of the page. The sidebar collapses to icons, and works on a phone.',
        audience: 'all',
      },
      {
        title: 'Modern sign-in screen',
        body: 'A cleaner login page with the Around Town Movers logo. Forgot password and first-time sign-in work the same way as before.',
        audience: 'all',
      },
      {
        title: 'A search box that knows which page you are on',
        body: 'The search box in the top bar now searches whatever page is open: jobs on the Board and My Jobs, long-distance jobs in the Long Distance Planner, job assignments, users, trucks and drivers, leads, matched customers, storage facilities. Its hint text changes to tell you what it searches. Pages with nothing to search have no box.',
        audience: 'all',
      },
      {
        title: 'Your page is remembered on refresh',
        body: 'Refreshing the browser, or using Back and Forward, keeps you on the page you were on instead of sending you back to the board.',
        audience: 'all',
      },
      {
        title: 'Leads module',
        body: 'Pre-Mover Leads and Matches: a dashboard with a county map and charts, a sortable and filterable Matches table that flags previous customers whose old homes are now listed, a data sheet you can export to Excel, and uploads.',
        audience: 'staff',
      },
      {
        title: 'Market module',
        body: 'The Storage Tracker (unit prices by city and brand, with filters and charts) and Real Estate Benchmarks, now inside ATM Hub. An Update prices button refreshes storage prices on demand.',
        audience: 'staff',
      },
      {
        title: 'Wider screens, cleaner pages',
        body: 'Pages now use the full width of your screen. Trucks & Drivers flows into columns so you scroll less.',
        audience: 'admin',
      },
      {
        title: 'Deleted Jobs is a real button',
        body: 'The deleted-jobs archive now opens from a visible button on Job Assignments, so nobody has to remember the old hidden shortcut.',
        audience: 'admin',
      },
    ],
    changing: [
      {
        title: 'You were signed out once',
        body: 'Rolling out 2.0 signed everyone out on purpose. Sign in again with your usual email and password. If you cannot remember it, use Forgot password on the sign-in page.',
        audience: 'all',
      },
      {
        title: 'Where things moved',
        body: 'The truck board, My Jobs, Trucks & Drivers and Job Assignments are under Dispatch. Users & Access (admins only) now lives in its own Settings section. The Long Distance Planner has its own Long Dist. module.',
        audience: 'all',
      },
      {
        title: 'The app is now called ATM Hub',
        body: 'Same system, new name, since it now covers more than scheduling.',
        audience: 'all',
      },
      {
        title: 'Job dates fix themselves for longer',
        body: 'When a job date is changed in SmartMoving, the scheduler now catches the correction for jobs up to 30 days back (it was 7). If a date still looks wrong, tell an admin.',
        audience: 'staff',
      },
    ],
    upcoming: [
      { title: 'Tasking and Tasks', body: 'Assign and track work for the office team inside the hub.', audience: 'admin' },
      { title: 'Storage operations', body: 'Run storage units and customers from the hub, next to the market data.', audience: 'admin' },
      { title: 'Military and Referrals', body: 'The military-move workflow and referral tracking, moving in from their separate tools.', audience: 'admin' },
      { title: 'Map and KPIs', body: 'A map view of jobs and a KPI dashboard for the business.', audience: 'admin' },
      { title: 'Automatic storage price updates', body: 'Prices refreshed on a schedule, so the Update prices button is only needed for a quick refresh.', audience: 'staff' },
      { title: 'More from the office CRM', body: 'The rest of the CRM tabs are planned to move into ATM Hub, one module at a time.', audience: 'all' },
    ],
    upcomingNote: 'These are plans, not promises. Order and timing are not set, and they can change.',
  },
];
