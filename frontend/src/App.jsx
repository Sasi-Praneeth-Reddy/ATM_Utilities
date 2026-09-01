import { useEffect, useMemo, useState } from 'react';
import { initialBackendUrl, normalizeBackendUrl } from './api';
import { useAuth } from './hooks/useAuth';
import { useSchedulerData } from './hooks/useSchedulerData';
import { useUsers } from './hooks/useUsers';
import { getConflicts, conflictIdsFrom, getPlaceholderDuplicates, roleLabels } from './utils/jobs';
import { todayStr } from './utils/dates';
import Header from './components/Header';
import Nav from './components/Nav';
import BackendBanner from './components/BackendBanner';
import LoginScreen from './components/LoginScreen';
import BoardTab from './components/board/BoardTab';
import LDPlanner from './components/LDPlanner';
import AdminTab from './components/admin/AdminTab';
import JobAssignmentsTab from './components/admin/JobAssignmentsTab';
import UsersTab from './components/admin/UsersTab';
import CrewTab from './components/CrewTab';

export default function App() {
  const [backendUrl, setBackendUrlState] = useState(initialBackendUrl());
  const setBackendUrl = (url) => setBackendUrlState(normalizeBackendUrl(url));

  // Day/night theme. Starts from the OS/browser's own light-vs-dark preference and can be
  // switched with the header toggle — but deliberately isn't saved anywhere (no localStorage),
  // consistent with this app's "nothing lives only on one device" rule, so it just falls back to
  // system preference again on the next visit rather than remembering a per-device choice.
  const [theme, setTheme] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  ));
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

  // Land on that role's default tab once we know who's logged in (or right after logging in).
  useEffect(() => {
    if (!role) return;
    setActiveTab(role === 'crew' ? 'crew' : 'board');
  }, [role]);

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
  useEffect(() => {
    if (!isAuthenticated) return;
    const t = setTimeout(() => setShowRoleHint(false), 3000);
    return () => clearTimeout(t);
  }, [isAuthenticated]);

  const conflicts = useMemo(() => getConflicts(jobs), [jobs]);
  const conflictIds = useMemo(() => conflictIdsFrom(conflicts), [conflicts]);
  const placeholderDuplicates = useMemo(() => getPlaceholderDuplicates(jobs), [jobs]);

  if (authStatus === 'loading') {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>;
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

  return (
    <>
      <Header
        user={user}
        role={role}
        onLogout={authState.logout}
        trucks={trucks}
        crewTruck={currentCrewTruck}
        onCrewTruckChange={setCurrentCrewTruck}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <Nav role={role} activeTab={activeTab} onTabChange={setActiveTab} />
      {/* Board tab (the truck timeline, now a full 24-hour day) needs real width — capping it at
          the same 1400px reading width as the admin forms just left empty space on both sides of
          a wide monitor while still forcing the timeline to scroll horizontally. Other tabs keep
          the narrower, more readable width. */}
      <main className={activeTab === 'board' || activeTab === 'ld' ? 'board-main' : ''}>
        <BackendBanner
          backendConnected={data.backendConnected}
          backendErrorMsg={data.backendErrorMsg}
          backendUrl={backendUrl}
          onRetryUrl={setBackendUrl}
        />
        {showRoleHint && <div className="hint">{roleLabels[role]}</div>}

        {activeTab === 'board' && (
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
            onUpdateJobFields={data.updateJobFields}
            onCreateJob={data.createJob}
            onDeleteJob={data.deleteJob}
          />
        )}

        {activeTab === 'ld' && (
          <LDPlanner
            role={role}
            trucks={trucks} drivers={drivers} jobs={jobs}
            conflicts={conflicts} conflictIds={conflictIds}
          />
        )}

        {activeTab === 'admin' && role === 'admin' && (
          <AdminTab
            trucks={trucks} drivers={drivers} jobs={jobs}
            onResetToSampleData={data.resetToSampleData}
            onClearJobs={data.clearJobs}
            onCreateTruck={data.createTruck} onCreateDriver={data.createDriver}
            onUpdateTruckField={data.updateTruckField} onUpdateTruckStatus={data.updateTruckStatus}
            onUpdateDriverField={data.updateDriverField}
            onDeleteTruck={data.deleteTruck} onDeleteDriver={data.deleteDriver}
            onReorderTrucks={data.reorderTrucks}
          />
        )}

        {activeTab === 'assignments' && role === 'admin' && (
          <JobAssignmentsTab
            trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds}
            onSetJobSingleTruck={data.setJobSingleTruck} onToggleJobTruck={data.toggleJobTruck}
            onUpdateJobField={data.updateJobField}
            onAddExtraTruck={data.addExtraTruckToJob}
            onSetJobTruckDriver={data.setJobTruckDriver}
            syncStatus={data.syncStatus} onSyncNow={data.syncNow} lastSyncedAt={data.lastSyncedAt}
            smartInsightsSyncStatus={data.smartInsightsSyncStatus} onSyncSmartInsightsNow={data.syncSmartInsightsNow}
          />
        )}

        {activeTab === 'users' && role === 'admin' && (
          <UsersTab
            users={usersData.users} currentUserId={user.id}
            onCreateUser={usersData.createUser} onChangeUserRole={usersData.changeRole}
            onDeleteUser={usersData.deleteUser}
            allowedExternalEmails={usersData.allowedExternalEmails}
            onAddAllowedExternalEmail={usersData.addAllowedExternalEmail}
            onRemoveAllowedExternalEmail={usersData.removeAllowedExternalEmail}
          />
        )}

        {activeTab === 'crew' && (
          <CrewTab trucks={trucks} drivers={drivers} jobs={jobs} currentCrewTruck={currentCrewTruck} conflictIds={conflictIds} />
        )}
      </main>
    </>
  );
}
