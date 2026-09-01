import { useState } from 'react';
import { deriveTruckStatus, statusClass, statusLabel } from '../../utils/jobs';
import { todayStr } from '../../utils/dates';

function AddTruckForm({ onSave, onCancel, truckCount }) {
  const [name, setName] = useState('');
  const [size, setSize] = useState('');
  const [capacity, setCapacity] = useState('');
  const [homeBase, setHomeBase] = useState('');

  async function save() {
    await onSave({
      name: name.trim() || `Truck ${truckCount + 1}`,
      size: size.trim() || '26ft Box',
      capacity: capacity.trim() || '—',
      homeBase: homeBase.trim() || 'Denver, CO',
    });
  }

  return (
    <div className="admin-card add-form">
      <h3>New Truck</h3>
      <div className="row"><span className="field-label">Name</span><input type="text" value={name} placeholder="Truck 6" onChange={(e) => setName(e.target.value)} /></div>
      <div className="row"><span className="field-label">Size</span><input type="text" value={size} placeholder="26ft Box" onChange={(e) => setSize(e.target.value)} /></div>
      <div className="row"><span className="field-label">Capacity</span><input type="text" value={capacity} placeholder="12,000 lbs" onChange={(e) => setCapacity(e.target.value)} /></div>
      <div className="row"><span className="field-label">Home Base</span><input type="text" value={homeBase} placeholder="Denver, CO" onChange={(e) => setHomeBase(e.target.value)} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
        <button className="btn" onClick={save}>Save Truck</button>
      </div>
    </div>
  );
}

function TruckCard({ t, jobs, onUpdateField, onUpdateStatus, onDeleteTruck, drag }) {
  async function handleDelete() {
    if (!window.confirm(`Delete truck "${t.name}"? Any job currently assigned to it will become unassigned. This can't be undone.`)) return;
    try {
      await onDeleteTruck(t.id);
    } catch (err) {
      window.alert(`Couldn't delete truck: ${err.message}`);
    }
  }

  // "Available"/"On Job" is no longer something to set by hand — it's derived from today's actual
  // job assignments (see deriveTruckStatus in utils/jobs.js) so it can't get stuck showing "On Job"
  // after a job is removed. The one thing still manually controlled here is "Maintenance" (out of
  // service), which always overrides the derived value regardless of what's assigned.
  const derived = deriveTruckStatus(t, jobs, todayStr());
  const outOfService = t.status === 'maintenance';

  return (
    <div
      className="admin-card"
      draggable={Boolean(drag)}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      style={{
        opacity: drag?.isDragging ? 0.4 : 1,
        borderTop: drag?.isDropTarget ? '2px solid var(--blue)' : undefined,
        cursor: drag ? 'grab' : undefined,
      }}
    >
      <h3>
        {drag && <span className="drag-handle" title="Drag to reorder" style={{ color: 'var(--muted)', marginRight: 4, cursor: 'grab' }}>⠿</span>}
        <input
          type="text" value={t.name}
          style={{ fontWeight: 700, fontSize: 13, width: 110 }}
          onChange={(e) => onUpdateField(t.id, 'name', e.target.value)}
        />
        <input
          type="text" value={t.size}
          style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 12, width: 150 }}
          onChange={(e) => onUpdateField(t.id, 'size', e.target.value)}
        />
      </h3>
      <div className="row">
        <span className="field-label">Today</span>
        <span className={statusClass(derived)} title="Automatic — reflects whether this truck has a job assigned today.">
          <span className="status-dot" />{statusLabel(derived)}
        </span>
      </div>
      <div className="row">
        <span className="field-label">Status</span>
        <select value={outOfService ? 'maintenance' : 'available'} onChange={(e) => onUpdateStatus(t.id, e.target.value)}>
          <option value="available">In service</option>
          <option value="maintenance">Out of service (maintenance)</option>
        </select>
      </div>
      <div className="row">
        <span className="field-label">Capacity</span>
        <input type="text" value={t.capacity} onChange={(e) => onUpdateField(t.id, 'capacity', e.target.value)} />
      </div>
      {/* No "Driver" field here anymore — a truck's driver changes job to job now instead of being
          a standing assignment (see db.js's file header). Set it per job in Admin → Job
          Assignments instead. */}
      <div className="row">
        <span className="field-label">Home Base</span>
        <input type="text" value={t.homeBase} onChange={(e) => onUpdateField(t.id, 'homeBase', e.target.value)} />
      </div>
      <div className="row">
        <span className="field-label" title="How this truck is labeled in SmartMoving's dispatch info (e.g. &quot;ARC 130-2&quot;) — used to auto-assign this truck when a synced job lists it. Separate multiple aliases with commas.">SmartMoving label</span>
        {/* defaultValue + onBlur (not value + onChange like every other field here) is deliberate:
            this holds an array, and re-splitting/rejoining on every keystroke eats the trailing
            ", " the instant you type a comma, making it impossible to type a second alias. Committing
            once on blur avoids fighting the user while they type. */}
        <input
          type="text"
          defaultValue={(t.smartMovingLabels || []).join(', ')}
          placeholder="e.g. ARC 130-2"
          onBlur={(e) => {
            const labels = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            onUpdateField(t.id, 'smartMovingLabels', labels);
          }}
        />
      </div>
      {onDeleteTruck && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={handleDelete}>Delete truck</button>
        </div>
      )}
    </div>
  );
}

export default function TruckAdminList({ trucks, jobs, showAddForm, onSaveNewTruck, onCancelAddTruck, onUpdateField, onUpdateStatus, onDeleteTruck, onReorder }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  function handleDragStart(e, index) {
    setDragIndex(index);
    // Firefox requires data to be set for drag to actually start.
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }

  function handleDragOver(e, index) {
    e.preventDefault(); // required to allow a drop
    e.dataTransfer.dropEffect = 'move';
    if (index !== overIndex) setOverIndex(index);
  }

  function handleDrop(e, index) {
    e.preventDefault();
    const from = dragIndex;
    const to = index;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === to) return;

    const reordered = trucks.map((t) => t.id);
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    onReorder(reordered);
  }

  function handleDragEnd() {
    setDragIndex(null);
    setOverIndex(null);
  }

  return (
    <div>
      {showAddForm && <AddTruckForm onSave={onSaveNewTruck} onCancel={onCancelAddTruck} truckCount={trucks.length} />}
      {trucks.map((t, index) => (
        <TruckCard
          key={t.id}
          t={t}
          jobs={jobs}
          onUpdateField={onUpdateField}
          onUpdateStatus={onUpdateStatus}
          onDeleteTruck={onDeleteTruck}
          drag={onReorder ? {
            onDragStart: (e) => handleDragStart(e, index),
            onDragOver: (e) => handleDragOver(e, index),
            onDrop: (e) => handleDrop(e, index),
            onDragEnd: handleDragEnd,
            isDragging: dragIndex === index,
            isDropTarget: overIndex === index && dragIndex !== null && dragIndex !== index,
          } : null}
        />
      ))}
    </div>
  );
}
