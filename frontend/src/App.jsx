import { useEffect, useMemo, useState } from 'react';
import { useSchedulerData } from './hooks/useSchedulerData';
import { getConflicts, conflictIdsFrom, roleLabels } from './utils/jobs';
import Header from './components/Header';
import Nav from './components/Nav';
import BackendBanner from './components/BackendBanner';
import BoardTab from './components/board/BoardTab';
import LDPlanner from './components/LDPlanner';
import AdminTab from './components/admin/AdminTab';
import CrewTab from './components/CrewTab';

export default function App() {
  const data = useSchedulerData();
  const { trucks, drivers, jobs } = data;

  const [role, setRole] = useState('admin');
  const [activeTab, setActiveTab] = useState('board');
  const [currentCrewTruck, setCurrentCrewTruck] = useState('T1');
  const [boardMode, setBoardMode] = useState('day');
  const [boardDate, setBoardDate] = useState('2026-08-05');
  const [monthCursor, setMonthCursor] = useState(new Date(2026, 7, 1));

  // Switching roles jumps to that role's default tab, same as the original applyRole().
  function handleRoleChange(newRole) {
    setRole(newRole);
    setActiveTab(newRole === 'crew' ? 'crew' : 'board');
  }

  // Keep the crew truck selector pointed at a real truck once data loads.
  useEffect(() => {
    if (trucks.length && !trucks.some((t) => t.id === currentCrewTruck)) {
      setCurrentCrewTruck(trucks[0].id);
    }
  }, [trucks, currentCrewTruck]);

  const conflicts = useMemo(() => getConflicts(jobs), [jobs]);
  const conflictIds = useMemo(() => conflictIdsFrom(conflicts), [conflicts]);

  return (
    <>
      <Header
        role={role}
        onRoleChange={handleRoleChange}
        trucks={trucks}
        crewTruck={currentCrewTruck}
        onCrewTruckChange={setCurrentCrewTruck}
      />
      <Nav role={role} activeTab={activeTab} onTabChange={setActiveTab} />
      <main>
        <BackendBanner
          backendConnected={data.backendConnected}
          backendErrorMsg={data.backendErrorMsg}
          backendUrl={data.backendUrl}
          onRetryUrl={data.setBackendUrl}
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
          />
        )}

        {activeTab === 'crew' && (
          <CrewTab trucks={trucks} drivers={drivers} jobs={jobs} currentCrewTruck={currentCrewTruck} conflictIds={conflictIds} />
        )}
      </main>
    </>
  );
}
