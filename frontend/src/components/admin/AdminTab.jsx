import { useState } from 'react';
import TruckAdminList from './TruckAdminList';
import DriverAdminList from './DriverAdminList';

export default function AdminTab({
  trucks, drivers, jobs,
  onResetToSampleData, onClearJobs,
  onCreateTruck, onCreateDriver,
  onUpdateTruckField, onUpdateTruckStatus, onUpdateDriverField,
  onDeleteTruck, onDeleteDriver, onReorderTrucks,
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
          <button
            className="btn secondary"
            style={{ color: 'var(--red)' }}
            onClick={onClearJobs}
            title="Remove all jobs — including the sample jobs — but leave trucks and drivers untouched"
          >
            Clear all jobs
          </button>
        </div>
      </div>

      <div className="grid-2">
        <div>
          <h2 className="section-title">Trucks</h2>
          <TruckAdminList
            trucks={trucks} jobs={jobs}
            showAddForm={showAddTruckForm}
            onSaveNewTruck={saveNewTruck}
            onCancelAddTruck={() => setShowAddTruckForm(false)}
            onUpdateField={onUpdateTruckField}
            onUpdateStatus={onUpdateTruckStatus}
            onDeleteTruck={onDeleteTruck}
            onReorder={onReorderTrucks}
          />
        </div>
        <div>
          <h2 className="section-title">Drivers</h2>
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
    </section>
  );
}
