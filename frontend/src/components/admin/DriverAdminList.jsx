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

function DriverCard({ d, drivers, onUpdateField, onDeleteDriver }) {
  async function handleDelete() {
    if (!window.confirm(`Remove driver "${d.name}"? Any job assignment naming them as a truck's driver will be cleared. This can't be undone.`)) return;
    try {
      await onDeleteDriver(d.id);
    } catch (err) {
      window.alert(`Couldn't delete driver: ${err.message}`);
    }
  }

  return (
    <div className="admin-card">
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
      {/* No "Truck" field here anymore — a driver's truck changes job to job now instead of being
          a standing assignment (see db.js's file header). Set it per job in Admin → Job
          Assignments instead. */}
      <div className="row">
        <span className="field-label" title="How this driver is labeled in SmartMoving's dispatch &quot;Crew:&quot; text (e.g. &quot;Celita&quot; or &quot;Celita 703-454-4456&quot;) — used to auto-assign this driver when a synced job names them. That text is inconsistently formatted job to job, so add more than one alias if the first doesn't catch. Separate multiple aliases with commas.">SmartMoving label</span>
        {/* defaultValue + onBlur, same as TruckAdminList's SmartMoving label field — holds an
            array, and re-splitting/rejoining on every keystroke eats the trailing ", " the instant
            you type a comma, making it impossible to type a second alias. */}
        <input
          type="text"
          defaultValue={(d.smartMovingLabels || []).join(', ')}
          placeholder="e.g. Celita, Celita 703-454-4456"
          onBlur={(e) => {
            const labels = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            onUpdateField(d.id, 'smartMovingLabels', labels);
          }}
        />
      </div>
      {onDeleteDriver && (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn secondary" style={{ color: 'var(--red)' }} onClick={handleDelete}>Delete driver</button>
        </div>
      )}
    </div>
  );
}

export default function DriverAdminList({ drivers, showAddForm, onSaveNewDriver, onCancelAddDriver, onUpdateField, onDeleteDriver }) {
  return (
    <div>
      {showAddForm && <AddDriverForm onSave={onSaveNewDriver} onCancel={onCancelAddDriver} />}
      {drivers.map((d) => (
        <DriverCard
          key={d.id}
          d={d}
          drivers={drivers}
          onUpdateField={onUpdateField}
          onDeleteDriver={onDeleteDriver}
        />
      ))}
    </div>
  );
}
