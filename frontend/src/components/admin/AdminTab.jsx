import { useState } from 'react';
import SyncPanel from './SyncPanel';
import TruckAdminList from './TruckAdminList';
import DriverAdminList from './DriverAdminList';
import JobAssignments from './JobAssignments';
import UsersAdmin from './UsersAdmin';

export default function AdminTab({
  trucks, drivers, jobs, conflictIds,
  syncStatus, onSyncNow, lastSyncedAt, onResetToSampleData,
  onCreateTruck, onCreateDriver,
  onUpdateTruckField, onUpdateTruckStatus, onLinkDriver, onUpdateDriverField, onUnassignDriverTruck,
  onSetJobSingleTruck, onToggleJobTruck, onUpdateJobField,
  users, currentUserId, onCreateUser, onChangeUserRole, onDeleteUser,
}) {
  const [showAddTruckForm, setShowAddTruckForm] = useState(false);
  const [showAddDriverForm, setShowAddDriverForm] = useState(false);

  async function saveNewTruck(fields) {
    try {
      await onCreateTruck(fields);
      setShowAddTruckForm(false);
    } catch (err) {
      window.alert(`Couldn't create the truck: ${err.message}`);
    }
  }

  async function saveNewDriver(fields) {
    try {
      await onCreateDriver(fields);
      setShowAddDriverForm(false);
    } catch (err) {
      window.alert(`Couldn't create the driver: ${err.message}`);
    }
  }

  return (
    <section>
      <SyncPanel syncStatus={syncStatus} onSyncNow={onSyncNow} lastSyncedAt={lastSyncedAt} />

      <div className="toolbar">
        <h2 className="section-title">Trucks &amp; Drivers</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => { setShowAddTruckForm((v) => !v); setShowAddDriverForm(false); }}>+ Add Truck</button>
          <button className="btn" onClick={() => { setShowAddDriverForm((v) => !v); setShowAddTruckForm(false); }}>+ Add Driver</button>
          <button
            className="btn secondary"
            onClick={onResetToSampleData}
            title="Clear all local changes and reload the original sample data"
          >
            Reset to sample data
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div>
          <h2 className="section-title">Trucks</h2>
          <TruckAdminList
            trucks={trucks} drivers={drivers}
            showAddForm={showAddTruckForm}
            onSaveNewTruck={saveNewTruck}
            onCancelAddTruck={() => setShowAddTruckForm(false)}
            onUpdateField={onUpdateTruckField}
            onUpdateStatus={onUpdateTruckStatus}
            onLinkDriver={onLinkDriver}
          />
        </div>
        <div>
          <h2 className="section-title">Drivers</h2>
          <DriverAdminList
            trucks={trucks} drivers={drivers}
            showAddForm={showAddDriverForm}
            onSaveNewDriver={saveNewDriver}
            onCancelAddDriver={() => setShowAddDriverForm(false)}
            onUpdateField={onUpdateDriverField}
            onLinkDriver={onLinkDriver}
            onUnassignDriverTruck={onUnassignDriverTruck}
          />
        </div>
      </div>

      <h2 className="section-title" style={{ marginTop: 22 }}>Job Assignments — assign a truck &amp; driver to each job</h2>
      <JobAssignments
        trucks={trucks} drivers={drivers} jobs={jobs} conflictIds={conflictIds}
        onSetJobSingleTruck={onSetJobSingleTruck}
        onToggleJobTruck={onToggleJobTruck}
        onUpdateJobField={onUpdateJobField}
      />

      <div style={{ marginTop: 22 }}>
        <UsersAdmin
          users={users}
          currentUserId={currentUserId}
          onCreateUser={onCreateUser}
          onChangeRole={onChangeUserRole}
          onDeleteUser={onDeleteUser}
        />
      </div>
    </section>
  );
}
