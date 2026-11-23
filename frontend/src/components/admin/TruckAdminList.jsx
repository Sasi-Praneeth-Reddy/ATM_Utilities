import { useCallback, useEffect, useRef, useState } from 'react';
import { usePagedSearch, ListSearch, SimplePager } from './ListControls';
import { deriveTruckStatus, statusClass, statusLabel } from '../../utils/jobs';
import { todayStr } from '../../utils/dates';

function AddTruckForm({ onSave, onCancel, truckCount }) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [homeBase, setHomeBase] = useState('');

  async function save() {
    await onSave({
      name: name.trim() || `Truck ${truckCount + 1}`,
      // "Size" dropped from this form entirely 2026-09-16, at the user's request — it used to
      // default to '26ft Box' whenever the field was left blank (which was most of the time, since
      // the placeholder text "26ft Box" looked like a real value), silently mislabeling trucks that
      // were never actually 26ft box trucks (e.g. "M&C VAN", "Penske Rental"). There was also no way
      // to fix a wrong size afterward — the size edit box was removed from existing truck cards back
      // on 2026-09-10 (see TruckCard's own comment below). Rather than keep guessing a default or
      // re-adding that edit box, new trucks just start with no size at all (db.js's createTruck
      // already handles size being omitted, storing it as null) — nothing here asks for it or fills
      // one in.
      capacity: capacity.trim() || '—',
      homeBase: homeBase.trim() || 'Denver, CO',
    });
  }

  return (
    <div className="admin-card add-form">
      <h3>New Truck</h3>
      <div className="row"><span className="field-label">Name</span><input type="text" value={name} placeholder="Truck 6" onChange={(e) => setName(e.target.value)} /></div>
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
      </h3>
      {/* The "size" edit box that used to sit right next to the name (e.g. "26ft Box") was removed
          here 2026-09-10 at the user's request — unused in practice, and it was rendering as a
          conspicuous empty box for any truck without a size set. `t.size` itself is still a real,
          displayed field elsewhere (Header's crew truck selector, CrewTab, the day board's truck
          row, both printed sheets) — only its one edit affordance is gone, not the field or its
          value. If it ever needs editing again, it'll need a new home; nothing here still writes to
          it. */}
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
      {/* Firestore doc id, added 2026-09-10 at the user's request ("show me example before
          developing it" — see truck-card-example.html, Option B). Genuinely blurred (not just
          faint) at rest and sharpens on hover — a reference for support/debugging, not something a
          dispatcher needs to read day to day. Trucks aren't keyed by Firestore's usual long
          auto-generated ids — createTruck (server.js) assigns a short one instead, e.g. "T7" — so
          this line stays short regardless of how a truck was created. */}
      <div className="truck-id-footer">
        <span className="truck-id-line" title={`Firestore doc id: ${t.id}`}>id: {t.id}</span>
      </div>
    </div>
  );
}

/** Search matches name, capacity, home base, SmartMoving labels and id. */
function truckMatches(t, q) {
  return [t.name, t.capacity, t.homeBase, t.id, ...(t.smartMovingLabels || [])]
    .filter(Boolean).join(' ').toLowerCase().includes(q);
}

/* 2026-09-30: searchable + 10 per page. Drag-to-reorder on these cards was removed — it can't work
 * across pages/search results — and replaced by the "Arrange truck order" dialog
 * (TruckOrderDialog.jsx, opened from AdminTab). */
export default function TruckAdminList({ query, trucks, jobs, showAddForm, onSaveNewTruck, onCancelAddTruck, onUpdateField, onUpdateStatus, onDeleteTruck }) {
  const matchFn = useCallback(truckMatches, []);
  const paged = usePagedSearch(trucks, matchFn, 10, query);
  // The cards scroll inside their own box (2026-09-30) instead of the whole page — jump back to the
  // top of that box whenever the page or search changes.
  const scrollRef = useRef(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }, [paged.page, paged.query, showAddForm]);

  return (
    <div>
      {query === undefined && <ListSearch value={paged.query} onChange={paged.setQuery} placeholder="Search trucks (name, label, home base)…" />}
      <SimplePager paged={paged} noun="trucks" />
      {paged.query.trim() && !paged.filtered.length && <div className="empty">No trucks match "{paged.query}".</div>}
      <div className="admin-scroll" ref={scrollRef}>
        {showAddForm && <AddTruckForm onSave={onSaveNewTruck} onCancel={onCancelAddTruck} truckCount={trucks.length} />}
      {paged.pageItems.map((t) => (
        <TruckCard
          key={t.id}
          t={t}
          jobs={jobs}
          onUpdateField={onUpdateField}
          onUpdateStatus={onUpdateStatus}
          onDeleteTruck={onDeleteTruck}
          drag={null}
        />
      ))}
      </div>
    </div>
  );
}
