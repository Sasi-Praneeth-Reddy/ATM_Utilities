import { useState } from 'react';
import { driverColor } from '../../utils/jobs';

function AddDriverForm({ onSave, onCancel }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [cdl, setCdl] = useState('');

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) { window.alert('Enter a driver name.'); return; }
    await onSave({ name: trimmed, phone: phone.trim() || '—', cdl: cdl.trim() || 'Class A' });
  }

  return (
    <div className="admin-card add-form">
      <h3>New Driver</h3>
      <div className="row"><span className="field-label">Name</span><input type="text" value={name} placeholder="Full name" onChange={(e) => setName(e.target.value)} /></div>
      <div className="row"><span className="field-label">Phone</span><input type="text" value={phone} placeholder="(303) 555-0100" onChange={(e) => setPhone(e.target.value)} /></div>
      <div className="row"><span className="field-label">License</span><input type="text" value={cdl} placeholder="Class A" onChange={(e) => setCdl(e.target.value)} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onCancel}>Cancel</button>
        <button className="btn" onClick={save}>Save Driver</button>
      </div>
    </div>
  );
}

export default function DriverAdminList({ trucks, drivers, showAddForm, onSaveNewDriver, onCancelAddDriver, onUpdateField, onLinkDriver, onUnassignDriverTruck }) {
  return (
    <div>
      {showAddForm && <AddDriverForm onSave={onSaveNewDriver} onCancel={onCancelAddDriver} />}
      {drivers.map((d) => {
        const assignedTruck = trucks.find((t) => t.driverId === d.id);
        return (
          <div className="admin-card" key={d.id}>
            <h3>
              <span className="dl-swatch" style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: driverColor(drivers, d.id), marginRight: 6 }} />
              <input
                type="text" value={d.name}
                style={{ fontWeight: 700, fontSize: 13, width: 150 }}
                onChange={(e) => onUpdateField(d.id, 'name', e.target.value)}
              />
            </h3>
            <div className="row"><span className="field-label">Phone</span><input type="text" value={d.phone} onChange={(e) => onUpdateField(d.id, 'phone', e.target.value)} /></div>
            <div className="row"><span className="field-label">License</span><input type="text" value={d.cdl} onChange={(e) => onUpdateField(d.id, 'cdl', e.target.value)} /></div>
            <div className="row">
              <span className="field-label">Truck</span>
              <select
                value={assignedTruck ? assignedTruck.id : ''}
                onChange={(e) => (e.target.value ? onLinkDriver(e.target.value, d.id) : onUnassignDriverTruck(d.id))}
              >
                <option value="">— Unassigned —</option>
                {trucks.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
        );
      })}
    </div>
  );
}
