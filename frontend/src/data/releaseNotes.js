// What's New content. Newest release first. To ship a new release: bump "version" in
// frontend/package.json and add a new object at the TOP of RELEASES. Write for dispatchers and
// crew, not developers — say what they will notice, not what changed in the code.
//
// audience: 'all' (everyone), 'staff' (admin + dispatcher), 'admin' (admins only) — items a person's
// role can't see are hidden so nobody reads about a screen they don't have.

export const RELEASES = [
  {
    version: '2.1.0',
    name: 'Tasking, Map and a faster back end',
    date: '2026-11-13',
    tagline: 'Two new modules (Tasking and Map), a night view, a tidier Leads search, and a quicker, cheaper system behind the scenes.',
    new: [
      {
        title: 'Tasking: Summary (the office to-do board)',
        body: 'Open Tasking in the sidebar, then Summary. Pick a day with the arrows or Today and you get five lists. Call list: every job that day by start time. Tick the box when the customer has been called, and choose whether Crew or Erika is calling (the choice is saved for that day). PBO upsell follow-ups: PBO jobs in the next 14 days, each with a status, a note and a follow-up date. Upcoming jobs not secured: jobs in the next 90 days where the estimate is not signed or no deposit is paid, with a days-left pill (red = 3 days or less, amber = 7 or less). Use the All / Within 3 days / Within 7 days chips and the Previous / Next buttons to page through it. Completed jobs not paid: finished jobs with a balance still owed. Active claims: open claims from SmartMoving. Press Refresh from SmartMoving to pull the latest payments, signatures and claims. It also refreshes by itself every morning after the 6 AM sweep. If a list looks empty, press Refresh first.',
        audience: 'staff',
      },
      {
        title: 'Tasking: Dispatch (notes, materials and crates)',
        body: 'Under Tasking, open Dispatch and pick a day. Each job shows its time, customer and truck. Notes from SmartMoving appear in separate coloured blocks (Dispatch, Internal, Crew and Customer notes), and you can type your own Dispatch notes (office) underneath, which SmartMoving never overwrites. Materials and crates are filled in automatically from the daily Job Materials report (checked at 6:30 AM and 5 PM). Tick each item when it is ready, add your own items and crates with the Add boxes, and use Print materials for the warehouse sheet. Email assigned jobs sends the whole day to the addresses you type. Three helper buttons: Import notes from SmartMoving, Check materials email (look for the report right now) and Upload materials report (add the .xlsx by hand).',
        audience: 'staff',
      },
      {
        title: 'Map module (for everyone)',
        body: 'Open Map in the sidebar. Local - Day View shows the day\'s local jobs: a solid line from the warehouse to the pickup, and a dashed line from the pickup to the drop-off. Long Distance Trips shows trips running that day from pickup to drop-off, and Whole USA zooms out to fit them all. Pickups are filled dots and drop-offs are hollow, numbered to match the list beside the map. Click a job in the list or on the map to highlight it. Use the arrows or Today to change the day. The first time a new address appears it says Locating new addresses and takes a few seconds, then it is remembered. The map is view-only, so nothing here can change a job. Live truck positions (Motive) are planned.',
        audience: 'all',
      },
      {
        title: 'Night view',
        body: 'The moon button in the top bar switches the whole app to a dark theme, and the sun button switches back. It is remembered on that device. The Leads county map and charts follow it too.',
        audience: 'all',
      },
      {
        title: 'Leads: search now lives in the top bar',
        body: 'The extra search box inside the Leads filters is gone. The search box at the top of the page now searches whatever Leads page is open, and its hint tells you what: listings (address, homeowner, realtor, city, ZIP), matched customers (name, address, email, phone, agent) or the data sheet you are on. Click the x or press Esc to clear it. Filters, the county map and the Matches table work as before. Click a county on the map to see its listings.',
        audience: 'staff',
      },
      {
        title: 'Truck Board: View and Print menus',
        body: 'The loose switches above the board are now two menus. View holds Timeline view / Compact grid and Hide in-transit days. Print holds the print options (list, board, orientation, include in-transit jobs). On a phone the board now opens as the compact grid, and Timeline view (where you drag jobs) is one tap away in View.',
        audience: 'all',
      },
      {
        title: 'Storage Tracker: cleaner prices',
        body: 'The Update prices button works again and starts a fresh price collection. Unit sizes are now written the same way everywhere (for example 10x15, smaller side first) so the same size is no longer split across several rows. City, state, ZIP and brand are filled in where they were showing as Unknown, and the city and brand summary updates on its own when a collection finishes.',
        audience: 'staff',
      },
      {
        title: 'Owner and Developer roles',
        body: 'Two roles now sit above Admin: Owner and Developer. They can do everything an Admin can, and they are the only ones who can add or remove users and give out those two roles. Settings > Users is now visible to Owner and Developer only. If you are an Admin and need a user added or changed, ask one of them.',
        audience: 'admin',
      },
    ],
    changing: [
      {
        title: 'Please sign in once more',
        body: 'The way the app keeps you signed in changed with the back-end move below, so everyone is asked to sign in again once. Use your usual email and password (or Forgot password). After that you stay signed in as before until you press Log out.',
        audience: 'all',
      },
      {
        title: 'Back end moved to Amazon (AWS)',
        body: 'The system that runs behind the screens moved from Google to the company\'s Amazon account. It costs less and has more room to grow. It is the same data and the same screens. The SmartMoving webhook, the 6 AM job sweep, the materials checks (6:30 AM and 5 PM), the Smart Insights reports (12 PM and 4 PM) and the calendar sweeps (8 AM, 12 PM, 1 PM and 4:03 PM, Eastern time) all run there on the same schedule.',
        audience: 'staff',
      },
      {
        title: 'Leads and storage data in a new database',
        body: 'The Leads (listings, matched customers, uploads) and Storage Tracker data now live in Amazon\'s DynamoDB instead of the old Google SQL database. Nothing was lost. Leads and storage pages and the Leads Excel export load the same way as before, and large exports are compressed so they download faster.',
        audience: 'staff',
      },
      {
        title: 'Heads up: a slower first click',
        body: 'After the system has been idle for a while, the first page you open can take two to four seconds longer while it wakes up. After that it is quick again. If something looks stuck for more than about ten seconds, refresh the page and tell an admin.',
        audience: 'all',
      },
    ],
    upcoming: [
      { title: 'Live trucks on the Map', body: 'Motive truck positions as an overlay on the Map pages (the Motive box there is a placeholder for now).', audience: 'all' },
      { title: 'Tasks', body: 'SmartMoving tasks and your own tasks in one list, with due dates and comments. Owners and developers see every task and everyone else sees their own.', audience: 'admin' },
      { title: 'Texting jobs to crews', body: 'Tasking can email the day\'s jobs today. Texting is not built yet.', audience: 'admin' },
      { title: 'Automatic storage price updates', body: 'Prices refreshed on a schedule, so the Update prices button is only needed for a quick refresh.', audience: 'staff' },
      { title: 'Storage operations, Military, Referrals and KPIs', body: 'The remaining modules in the sidebar are planned to move into ATM Hub one at a time.', audience: 'admin' },
    ],
    upcomingNote: 'These are plans, not promises. Order and timing are not set, and they can change.',
  },
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
