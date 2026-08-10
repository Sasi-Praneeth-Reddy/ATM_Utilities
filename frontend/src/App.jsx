import { useEffect, useMemo, useState } from 'react';
import { initialBackendUrl, normalizeBackendUrl } from './api';
import { useAuth } from './hooks/useAuth';
import { useSchedulerData } from './hooks/useSchedulerData';
import { useUsers } from './hooks/useUsers';
import { getConflicts, conflictIdsFrom, roleLabels } from './utils/jobs';
import Header from './components/Header';
import Nav from './components/Nav';
import BackendBanner from './components/BackendBanner';
import LoginScreen from './components/LoginScreen';
import BoardTab from './components/board/BoardTab';
import LDPlanner from './components/LDPlanner';
import AdminTab from './components/admin/AdminTab';
import CrewTab from './components/CrewTab';

export default function App() {
  const [backendUrl, setBackendUrlState] = useState(initialBackendUrl());
  const setBackendUrl = (url) => setBackendUrlState(normalizeBackendUrl(url));

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
  const [boardDate, setBoardDate] = useState('2026-08-05');
  const [monthCursor, setMonthCursor] = useState(new Date(2026, 7, 1));

  // Land on that role's default tab once we know who's logged in (or right after logging in).
  useEffect(() => {
    if (!role) return;
    setActiveTab(role === 'crew' ? 'crew' : 'board');
  }, [role]);

  // After a Microsoft sign-in redirect, the backend sends the browser back here with
  // ?authError=... on failure (nothing added on success). Pick it up once, then scrub it from the
  // URL so refreshing the page doesn't keep re-showing a stale error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('authError');
    if (err) {
      authState.setAuthError(err);
      params.delete('authError');
      const query = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the crew truck selector pointed at a real truck once data loads.
  useEffect(() => {
    if (trucks.length && !trucks.some((t) => t.id === currentCrewTruck)) {
      setCurrentCrewTruck(trucks[0].id);
    }
  }, [trucks, currentCrewTruck]);

  const conflicts = useMemo(() => getConflicts(jobs), [jobs]);
  const conflictIds = useMemo(() => conflictIdsFrom(conflicts), [conflicts]);

  if (authStatus === 'loading') {
    return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }

  if (authStatus === 'unauthenticated') {
    return (
      <LoginScreen
        microsoftLoginUrl={authState.microsoftLoginUrl}
        authError={authState.authError}
        connectionError={authState.connectionError}
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
      />
      <Nav role={role} activeTab={activeTab} onTabChange={setActiveTab} />
      <main>
        <BackendBanner
          backendConnected={data.backendConnected}
          backendErrorMsg={data.backendErrorMsg}
          backendUrl={backendUrl}
          onRetryUrl={setBackendUrl}
        />
        <div className="hint">{roleLabels[role]}</div>

        {activeTab === 'board' && (
          <BoardTab
            role={role}
            boardMode={boardMode} setBoardMode={setBoardMode}
            boardDate={boardDate} setBoardDate={setBoardDate}
            monthCursor={monthCursor} setMonthCursor={setMonthCursor}
            trucks={trucks} drivers={drivers} jobs={jobs}
            currentCrewTruck={currentCrewTruck}
            conflicts={conflicts} conflictIds={conflictIds}
            onUnassignJob={data.unassignJob}
            onAddTruckToJob={data.addTruckToJob}
            onRemoveTruck={data.removeTruckFromJob}
            onMoveJobDate={data.moveJobDate}
          />
        )}

        {activeTab === 'ld' && (
          <LDPlanner trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds} />
        )}

        {activeTab === 'admin' && role === 'admin' && (
          <AdminTab
            trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds}
            syncStatus={data.syncStatus} onSyncNow={data.syncNow} lastSyncedAt={data.lastSyncedAt}
            onResetToSampleData={data.resetToSampleData}
            onCreateTruck={data.createTruck} onCreateDriver={data.createDriver}
            onUpdateTruckField={data.updateTruckField} onUpdateTruckStatus={data.updateTruckStatus}
            onLinkDriver={data.linkTruckDriver}
            onUpdateDriverField={data.updateDriverField} onUnassignDriverTruck={data.unassignDriverTruck}
            onSetJobSingleTruck={data.setJobSingleTruck} onToggleJobTruck={data.toggleJobTruck}
            onUpdateJobField={data.updateJobField}
            users={usersData.users} currentUserId={user.id}
            onCreateUser={usersData.createUser} onChangeUserRole={usersData.changeRole}
            onDeleteUser={usersData.deleteUser}
          />
        )}

        {activeTab === 'crew' && (
          <CrewTab trucks={trucks} drivers={drivers} jobs={jobs} currentCrewTruck={currentCrewTruck} conflictIds={conflictIds} />
        )}
      </main>
    </>
  );
}
