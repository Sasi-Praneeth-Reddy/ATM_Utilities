import { useEffect, useMemo, useState } from 'react';
import { initialBackendUrl, normalizeBackendUrl } from './api';
import { useAuth } from './hooks/useAuth';
import { useSchedulerData } from './hooks/useSchedulerData';
import { useUsers } from './hooks/useUsers';
import { getConflicts, conflictIdsFrom, getPlaceholderDuplicates, roleLabels } from './utils/jobs';
import { todayStr } from './utils/dates';
import { readRoute, writeRoute } from './utils/route';
import Header from './components/Header';
import Nav from './components/Nav';
import Sidebar from './components/shell/Sidebar';
import ComingSoon from './components/shell/ComingSoon';
import { MODULES, TAB_LABELS, tabsFor, moduleOfTab } from './components/shell/modules';
import BackendBanner from './components/BackendBanner';
import LoadingScreen from './components/LoadingScreen';
import GmailAuthBanner, { isGmailAuthAlert } from './components/GmailAuthBanner';
import LoginScreen from './components/LoginScreen';
import DeletedJobsPanel from './components/DeletedJobsPanel';
import BoardTab from './components/board/BoardTab';
import DayPrintSheet from './components/board/DayPrintSheet';
import DayPrintTimeline from './components/board/DayPrintTimeline';
import LDPlanner from './components/LDPlanner';
import AdminTab from './components/admin/AdminTab';
import JobAssignmentsTab from './components/admin/JobAssignmentsTab';
import UsersTab from './components/admin/UsersTab';
import CrewTab from './components/CrewTab';
import LeadsTab from './components/leads/LeadsTab';
import StorageTab from './components/storage/StorageTab';
import BenchmarksTab from './components/storage/BenchmarksTab';

export default function App() {
  const [backendUrl, setBackendUrlState] = useState(initialBackendUrl());
  const setBackendUrl = (url) => setBackendUrlState(normalizeBackendUrl(url));

  // Day/night theme. Always starts light now (changed 2026-09-15 at the user's request, "make the
  // light theme default") — used to start from the OS/browser's own light-vs-dark preference
  // (window.matchMedia('(prefers-color-scheme: dark)')) instead, which meant anyone whose OS/browser
  // defaults to dark mode saw this app open dark on every visit whether they'd ever chosen that here
  // or not. Still switchable with the header toggle, and still deliberately isn't saved anywhere (no
  // localStorage), consistent with this app's "nothing lives only on one device" rule — it just
  // falls back to this same light default again on the next visit rather than remembering a
  // per-device choice, the same tradeoff as before, just with a different starting point.
  const [theme, setTheme] = useState('light');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  const authState = useAuth(backendUrl);
  const { user, status: authStatus } = authState;
  const isAuthenticated = authStatus === 'authenticated';
  const role = user?.role;

  const data = useSchedulerData(backendUrl, { enabled: isAuthenticated, onAuthError: authState.handleAuthError });
  const usersData = useUsers(backendUrl, isAuthenticated && role === 'admin');
  const { trucks, drivers, jobs } = data;

  const [activeTab, setActiveTab] = useState('board');
  // CRM shell: the sidebar picks a module, the module's tab strip picks a page. The active module is
  // derived from the active tab (so e.g. a job-search jump to the Board switches module on its own);
  // "coming soon" modules have no tab, so they're tracked separately in soonModule.
  const [soonModule, setSoonModule] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (typeof window !== 'undefined' ? window.innerWidth < 1000 : false));
  const activeMod = soonModule || moduleOfTab(activeTab, role) || MODULES.find((m) => m.id === 'dispatch');

  function handleSelectModule(mod) {
    if (typeof window !== 'undefined' && window.innerWidth <= 720) setSidebarCollapsed(true);
    if (mod.soon) { setSoonModule(mod); return; }
    setSoonModule(null);
    const tabs = tabsFor(mod, role);
    if (tabs.length) setActiveTab(tabs.includes(activeTab) ? activeTab : tabs[0]);
  }
  const [currentCrewTruck, setCurrentCrewTruck] = useState('T1');
  const [boardMode, setBoardMode] = useState('day');
  // Opens on today's date/month, not a hardcoded one — was pinned to a fixed 2026-08-05 (a leftover
  // from an early dev/demo date) so the board silently opened on the wrong day for anyone visiting
  // after that date passed. todayStr() (utils/dates.js) matches what DayBoard's "Today" button and
  // now-line already use, so all three stay in agreement about what "today" means.
  const [boardDate, setBoardDate] = useState(todayStr());
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  // Global job search now lives in the title bar (Header) instead of just the Board tab's toolbar
  // — moved 2026-09-10 at the user's request so it's reachable from every tab, not only Board — so
  // the jump-to-job/highlight state it drives has to live up here too, above whichever tab is
  // currently showing. Search always lands on Board/day view (the one place a job's exact
  // truck/time is visible) and briefly highlights the job once the board gets there, regardless of
  // which tab the search was actually run from.
  const [highlightedJobId, setHighlightedJobId] = useState(null);
  useEffect(() => {
    if (!highlightedJobId) return undefined;
    const timer = setTimeout(() => setHighlightedJobId(null), 4000);
    return () => clearTimeout(timer);
  }, [highlightedJobId]);

  function handleJumpToJob(job) {
    setSoonModule(null);
    setActiveTab('board');
    setBoardMode('day');
    setBoardDate(job.date);
    setMonthCursor(new Date(`${job.date}T00:00:00`));
    setHighlightedJobId(job.id);
  }

  // "Print Board"'s in-transit checkbox — lives here (not BoardTab.jsx, where the checkbox itself
  // is still rendered) because DayPrintTimeline itself moved up to this level 2026-09-11, see the
  // print-sheet rendering below. Session-only, same as BoardTab.jsx's own hideInTransit.
  // Defaulted to OFF originally so a dispatcher had to opt in before extra jobs appeared on the
  // printout unannounced — flipped to ON by default 2026-09-15 at the user's explicit request
  // ("also always make the include in-transit checked"), since by then the goal had shifted to
  // "every detail of the job is getting printed" by default; still a plain checkbox, so a dispatcher
  // can still uncheck it for a given printout same as before.
  const [includeTransitPrint, setIncludeTransitPrint] = useState(true);

  // Land on the page named in the URL (so a refresh keeps you where you were), else on that role's
  // default tab, once we know who's logged in (or right after logging in).
  function applyRoute(currentRole) {
    const { tab } = readRoute();
    if (tab && tab.startsWith('soon-') && currentRole === 'admin') {
      const mod = MODULES.find((m) => m.soon && `soon-${m.id}` === tab);
      if (mod) { setSoonModule(mod); return; }
    }
    if (tab && moduleOfTab(tab, currentRole)) { setSoonModule(null); setActiveTab(tab); return; }
    setSoonModule(null);
    setActiveTab(currentRole === 'crew' ? 'crew' : 'board');
  }
  // routeReady: the address bar is only rewritten AFTER the URL has been read, otherwise the default
  // tab would overwrite "#/leads/matches" before we looked at it.
  const [routeReady, setRouteReady] = useState(false);
  useEffect(() => {
    if (!role) { setRouteReady(false); return; }
    applyRoute(role);
    setRouteReady(true);
  }, [role]);

  // Browser Back/Forward between pages.
  useEffect(() => {
    if (!role) return undefined;
    const onNav = () => applyRoute(role);
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => { window.removeEventListener('popstate', onNav); window.removeEventListener('hashchange', onNav); };
  }, [role]);

  // Keep the address bar in step with the page being shown.
  useEffect(() => {
    if (!role || !routeReady) return;
    writeRoute(soonModule ? `soon-${soonModule.id}` : activeTab);
  }, [role, routeReady, activeTab, soonModule]);

  // Keep the crew truck selector pointed at a real truck once data loads.
  useEffect(() => {
    if (trucks.length && !trucks.some((t) => t.id === currentCrewTruck)) {
      setCurrentCrewTruck(trucks[0].id);
    }
  }, [trucks, currentCrewTruck]);

  // The role hint line ("Admin — full access to...") shows for 3s after the scheduler actually
  // opens, then hides — a one-time orientation cue, not a permanent fixture eating space on every
  // tab. Gated on isAuthenticated (not just mount) so the 3s starts when the scheduler UI itself
  // first appears, not while still on the loading spinner or login screen. Doesn't re-trigger on
  // tab switches (isAuthenticated stays true the whole session) — only a fresh login shows it again.
  const [showRoleHint, setShowRoleHint] = useState(true);

  // Deleted Jobs archive panel (added 2026-09-24) — opened from the "Deleted jobs" button on the
  // admin-only Job Assignments tab (was a hidden 5-click logo trigger until 2026-10-28). Lives up here rather than inside Header itself
  // so it can sit as a true top-level overlay sibling of everything else, same reasoning as every
  // other modal in this app (JobEditModal, JobConflictChooser, etc. all render from their nearest
  // sensible ancestor, not buried inside the element that merely triggers them).
  const [showDeletedJobs, setShowDeletedJobs] = useState(false);
  useEffect(() => {
    // Wait for the loading screen to finish, so the 3s is actually visible time.
    if (!isAuthenticated || data.initialLoading) return;
    const t = setTimeout(() => setShowRoleHint(false), 3000);
    return () => clearTimeout(t);
  }, [isAuthenticated, data.initialLoading]);

  const conflicts = useMemo(() => getConflicts(jobs), [jobs]);
  const conflictIds = useMemo(() => conflictIdsFrom(conflicts), [conflicts]);
  const placeholderDuplicates = useMemo(() => getPlaceholderDuplicates(jobs), [jobs]);

  if (authStatus === 'loading') {
    return <LoadingScreen />;
  }

  if (authStatus === 'unauthenticated') {
    return (
      <LoginScreen
        onLogin={authState.login}
        onForgotPassword={authState.forgotPassword}
        onResetPassword={authState.resetPassword}
        connectionError={authState.connectionError}
        devBypassEnabled={authState.devBypassEnabled}
        devLoginUrl={authState.devLoginUrl}
      />
    );
  }

  // Logged in but the first board data hasn't arrived yet — keep showing the loading animation
  // rather than an empty board with a flashing "Can't reach the backend" banner (2026-09-30).
  if (data.initialLoading) {
    return <LoadingScreen />;
  }

  return (
    <>
      {/* .app-shell wraps literally everything EXCEPT the print sheets below — added 2026-09-11
          chasing a persistent blank-2nd-page report that turned out to have nothing to do with the
          print sheet's own sizing math (already tuned carefully, see BoardTab.jsx/
          DayPrintTimeline.jsx): the OLD print CSS hid this entire app with `visibility:hidden`
          (needed since DayPrintSheet/DayPrintTimeline used to render nested deep inside BoardTab,
          and visibility is the only thing that can be selectively re-enabled for a specific
          descendant when its ancestors are hidden) — but visibility:hidden does NOT remove an
          element from the page's normal layout flow, only paints it invisible. The full interactive
          board (this whole app) is often taller than one printed page, so that invisible-but-still-
          there content kept forcing a second, entirely blank page after the actual printout. Moving
          the print sheets OUT to be true top-level siblings of this wrapper (see below) means print
          can now just `display:none` the wrapper outright — display:none actually removes it from
          layout, so there's no leftover height left to paginate. display:contents on screen means
          this div adds no box of its own and changes nothing about the on-screen layout — it exists
          purely so @media print has one simple thing to hide (see styles.css). */}
      <div className="app-shell">
      <Sidebar
        role={role}
        activeModuleId={activeMod.id}
        onSelectModule={handleSelectModule}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        alertModules={role === 'admin' && isGmailAuthAlert(data.gmailAuthStatus)
          ? { dispatch: 'Gmail authorization is expiring or expired — see Job Assignments' } : {}}
      />
      <div className="shell-main">
      <Header
        user={user}
        role={role}
        onLogout={authState.logout}
        trucks={trucks}
        jobs={jobs}
        onJumpToJob={handleJumpToJob}
        crewTruck={currentCrewTruck}
        onCrewTruckChange={setCurrentCrewTruck}
        theme={theme}
        onToggleTheme={toggleTheme}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
        moduleLabel={activeMod.label}
        tabLabel={soonModule ? null : TAB_LABELS[activeTab]}
      />
      <Nav
        tabIds={soonModule ? [] : tabsFor(activeMod, role)}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        alertTabs={role === 'admin' && isGmailAuthAlert(data.gmailAuthStatus)
          ? { assignments: 'Gmail authorization is expiring or expired — see Job Assignments' } : {}}
      />
      <main className={!soonModule && (activeTab === 'board' || activeTab === 'ld') ? 'board-main' : ''}>
        <BackendBanner
          backendConnected={data.backendConnected}
          backendErrorMsg={data.backendErrorMsg}
          backendUrl={backendUrl}
          onRetryUrl={setBackendUrl}
        />
        {/* Only on Job Assignments (2026-09-30) — elsewhere the red dot on that tab is the alert. */}
        {role === 'admin' && activeTab === 'assignments' && <GmailAuthBanner status={data.gmailAuthStatus} />}
        {showRoleHint && <div className="hint">{roleLabels[role]}</div>}

        {soonModule && <ComingSoon module={soonModule} />}

        {!soonModule && activeTab === 'board' && (
          <BoardTab
            role={role}
            boardMode={boardMode} setBoardMode={setBoardMode}
            boardDate={boardDate} setBoardDate={setBoardDate}
            monthCursor={monthCursor} setMonthCursor={setMonthCursor}
            trucks={trucks} drivers={drivers} jobs={jobs}
            currentCrewTruck={currentCrewTruck}
            conflicts={conflicts} conflictIds={conflictIds}
            placeholderDuplicates={placeholderDuplicates}
            onUnassignJob={data.unassignJob}
            onAddTruckToJob={data.addTruckToJob}
            onRemoveTruck={data.removeTruckFromJob}
            onMoveJobDate={data.moveJobDate}
            onAddExtraTruck={data.addExtraTruckToJob}
            onSetJobTruckDriver={data.setJobTruckDriver}
            onSetJobColor={data.setJobColor}
            onUpdateJobFields={data.updateJobFields}
            onClearManualEdit={data.clearManualEdit}
            onCreateJob={data.createJob}
            onDeleteJob={data.deleteJob}
            highlightedJobId={highlightedJobId}
            onJumpToJob={handleJumpToJob}
            includeTransitPrint={includeTransitPrint}
            setIncludeTransitPrint={setIncludeTransitPrint}
          />
        )}

        {!soonModule && activeTab === 'ld' && (
          <LDPlanner
            role={role}
            trucks={trucks} drivers={drivers} jobs={jobs}
            conflicts={conflicts} conflictIds={conflictIds}
          />
        )}

        {!soonModule && activeTab === 'admin' && role === 'admin' && (
          <AdminTab
            trucks={trucks} drivers={drivers} jobs={jobs}
            onCreateTruck={data.createTruck} onCreateDriver={data.createDriver}
            onUpdateTruckField={data.updateTruckField} onUpdateTruckStatus={data.updateTruckStatus}
            onUpdateDriverField={data.updateDriverField}
            onDeleteTruck={data.deleteTruck} onDeleteDriver={data.deleteDriver}
            onReorderTrucks={data.reorderTrucks}
          />
        )}

        {!soonModule && activeTab === 'assignments' && role === 'admin' && (
          <JobAssignmentsTab
            trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds}
            onSetJobSingleTruck={data.setJobSingleTruck} onToggleJobTruck={data.toggleJobTruck}
            onUpdateJobField={data.updateJobField}
            onAddExtraTruck={data.addExtraTruckToJob}
            onSetJobTruckDriver={data.setJobTruckDriver}
            syncStatus={data.syncStatus} onSyncNow={data.syncNow} lastSyncedAt={data.lastSyncedAt}
            calendarSyncStatus={data.calendarSyncStatus} onSyncCalendarNow={data.syncCalendarNow}
            smartInsightsSyncStatus={data.smartInsightsSyncStatus} onSyncSmartInsightsNow={data.syncSmartInsightsNow}
            gmailAuthStatus={data.gmailAuthStatus}
            onOpenDeletedJobs={() => setShowDeletedJobs(true)}
          />
        )}

        {!soonModule && activeTab === 'users' && role === 'admin' && (
          <UsersTab
            users={usersData.users} currentUserId={user.id}
            onCreateUser={usersData.createUser} onChangeUserRole={usersData.changeRole}
            onDeleteUser={usersData.deleteUser}
            allowedExternalEmails={usersData.allowedExternalEmails}
            onAddAllowedExternalEmail={usersData.addAllowedExternalEmail}
            onRemoveAllowedExternalEmail={usersData.removeAllowedExternalEmail}
          />
        )}

        {!soonModule && activeTab === 'leads' && (role === 'admin' || role === 'dispatcher') && (
          <LeadsTab backendUrl={backendUrl} role={role} />
        )}

        {!soonModule && activeTab === 'storage' && (role === 'admin' || role === 'dispatcher') && (
          <StorageTab backendUrl={backendUrl} role={role} />
        )}

        {!soonModule && activeTab === 'benchmarks' && (role === 'admin' || role === 'dispatcher') && (
          <BenchmarksTab backendUrl={backendUrl} />
        )}

        {!soonModule && activeTab === 'crew' && (
          <CrewTab trucks={trucks} drivers={drivers} jobs={jobs} currentCrewTruck={currentCrewTruck} conflictIds={conflictIds} />
        )}
      </main>
      </div>
      <DeletedJobsPanel
        open={showDeletedJobs}
        onClose={() => setShowDeletedJobs(false)}
        fetchDeletedJobs={data.fetchDeletedJobs}
        onRestore={data.restoreJob}
        onPermanentlyDelete={data.permanentlyDeleteArchivedJob}
      />
      </div>
      {/* True top-level siblings of .app-shell (not nested inside it, and not nested inside
          BoardTab.jsx anymore either, as of 2026-09-11 — see .app-shell's own comment above for
          why). Only need to exist when the "Print List"/"Print Board" buttons that target them are
          actually reachable, same as before this move. */}
      {!soonModule && activeTab === 'board' && boardMode === 'day' && (
        <>
          <DayPrintSheet id="day-print-list" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds} />
          <DayPrintTimeline id="day-print-timeline" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflicts={conflicts} includeTransit={includeTransitPrint} />
          {/* "Print All Trucks" — added 2026-09-15, its OWN separate always-in-the-DOM instance
              (id="day-print-timeline-all", includeAllTrucks hardcoded true) rather than a second
              mode for the instance above. A first version instead reused the SAME element via a
              shared React state flag toggling its includeAllTrucks prop — that broke under real
              use once window.print() turned out to block synchronously, leaving the flag stuck and
              both print buttons reprinting whatever had rendered last (see BoardTab.jsx's
              measureAndPrintBoard comment for the full story, and the user's own bug report: "print
              board and print all trucks are working only when refreshed seperately... i want them
              to be two different seperate mechanisms even when we don't do the refresh"). A fully
              separate element with its own fixed props has nothing to race: it's always correctly
              rendered, independent of whichever button was clicked last. */}
          <DayPrintTimeline id="day-print-timeline-all" date={boardDate} trucks={trucks} drivers={drivers} jobs={jobs} conflicts={conflicts} includeTransit={includeTransitPrint} includeAllTrucks />
        </>
      )}
    </>
  );
}
