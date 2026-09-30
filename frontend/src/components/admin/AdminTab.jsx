import { useState } from 'react';
import TruckAdminList from './TruckAdminList';
import DriverAdminList from './DriverAdminList';
import TruckOrderDialog from './TruckOrderDialog';

export default function AdminTab({
  trucks, drivers, jobs,
  onCreateTruck, onCreateDriver,
  onUpdateTruckField, onUpdateTruckStatus, onUpdateDriverField,
  onDeleteTruck, onDeleteDriver, onReorderTrucks,
}) {
  const [showAddTruckForm, setShowAddTruckForm] = useState(false);
  const [showAddDriverForm, setShowAddDriverForm] = useState(false);
  const [showTruckOrder, setShowTruckOrder] = useState(false);

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
      <div className="toolbar">
        <h2 className="section-title">Trucks &amp; Drivers</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => { setShowAddTruckForm((v) => !v); setShowAddDriverForm(false); }}>+ Add Truck</button>
          <button className="btn" onClick={() => { setShowAddDriverForm((v) => !v); setShowAddTruckForm(false); }}>+ Add Driver</button>
          {/* "Clear all jobs" removed 2026-09-10 at the user's request — it deleted every job on the
              board (sample AND real, everything imported from SmartMoving included, for every
              device using this backend) and, despite its own window.confirm() guard, sat right next
              to the much lower-stakes "Reset to sample data" button, close enough for the wrong one
              to get clicked. onClearJobs/data.clearJobs (useSchedulerData.js, still confirm()-
              guarded) is left in place, just no longer wired to any button, in case a real bulk-clear
              need comes up again later and deserves its own more deliberately isolated UI.

              "Reset to sample data" itself MOVED to the Job Assignments tab the same day, at the
              user's request — same reasoning SyncPanel's own move here-to-there comment already
              gives (see JobAssignmentsTab.jsx): this page is the truck/driver roster, not where a
              dispatcher should be reaching for the single most destructive action in the whole app.
              It now also asks twice (with a warning tone on the second) before actually running —
              see useSchedulerData.js's resetToSampleData. */}
        </div>
      </div>

      <div className="grid-2">
        <div>
          <div className="list-heading">
            <h2 className="section-title">Trucks</h2>
            {onReorderTrucks && trucks.length > 1 && (
              <button className="btn-order" onClick={() => setShowTruckOrder(true)} title="Change the order trucks appear on the board">
                <span className="btn-order-icon" aria-hidden="true">⇅</span> Arrange truck order
              </button>
            )}
          </div>
          <TruckAdminList
            trucks={trucks} jobs={jobs}
            showAddForm={showAddTruckForm}
            onSaveNewTruck={saveNewTruck}
            onCancelAddTruck={() => setShowAddTruckForm(false)}
            onUpdateField={onUpdateTruckField}
            onUpdateStatus={onUpdateTruckStatus}
            onDeleteTruck={onDeleteTruck}
          />
        </div>
        <div>
          <div className="list-heading">
            <h2 className="section-title">Drivers</h2>
          </div>
          <DriverAdminList
            drivers={drivers}
            showAddForm={showAddDriverForm}
            onSaveNewDriver={saveNewDriver}
            onCancelAddDriver={() => setShowAddDriverForm(false)}
            onUpdateField={onUpdateDriverField}
            onDeleteDriver={onDeleteDriver}
          />
        </div>
      </div>
      {showTruckOrder && (
        <TruckOrderDialog trucks={trucks} onReorder={onReorderTrucks} onClose={() => setShowTruckOrder(false)} />
      )}
    </section>
  );
}
