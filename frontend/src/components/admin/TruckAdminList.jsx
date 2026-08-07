import { useState } from 'react';

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

export default function TruckAdminList({ trucks, drivers, showAddForm, onSaveNewTruck, onCancelAddTruck, onUpdateField, onUpdateStatus, onLinkDriver }) {
  return (
    <div>
      {showAddForm && <AddTruckForm onSave={onSaveNewTruck} onCancel={onCancelAddTruck} truckCount={trucks.length} />}
      {trucks.map((t) => (
        <div className="admin-card" key={t.id}>
          <h3>
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
            <span className="field-label">Status</span>
            <select value={t.status} onChange={(e) => onUpdateStatus(t.id, e.target.value)}>
              <option value="available">Available</option>
              <option value="onjob">On Job</option>
              <option value="maintenance">Maintenance</option>
            </select>
          </div>
          <div className="row">
            <span className="field-label">Capacity</span>
            <input type="text" value={t.capacity} onChange={(e) => onUpdateField(t.id, 'capacity', e.target.value)} />
          </div>
          <div className="row">
            <span className="field-label">Driver</span>
            <select value={t.driverId || ''} onChange={(e) => onLinkDriver(t.id, e.target.value)}>
              <option value="">— Unassigned —</option>
              {drivers.map((d) => <option value={d.id} key={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="row">
            <span className="field-label">Home Base</span>
            <input type="text" value={t.homeBase} onChange={(e) => onUpdateField(t.id, 'homeBase', e.target.value)} />
          </div>
        </div>
      ))}
    </div>
  );
}
