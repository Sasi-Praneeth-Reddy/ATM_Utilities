import { useEffect, useState } from 'react';

/**
 * "Arrange truck order" dialog (added 2026-09-30, user request: an easier way to manage the order
 * trucks appear on the board than dragging the big edit cards around — which also can't work
 * across pages now that the truck list is paged/searchable).
 *
 * Works on a local draft of the order: move trucks with ↑ / ↓, jump straight to Top / Bottom, type
 * a position number, or drag a row. Nothing is saved until "Save order" — then onReorder is called
 * once with the full new id order (same db.reorderTrucks path the old drag-and-drop used).
 */
export default function TruckOrderDialog({ trucks, onReorder, onClose }) {
  const [order, setOrder] = useState(() => trucks.map((t) => t.id));
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [saving, setSaving] = useState(false);
  const byId = Object.fromEntries(trucks.map((t) => [t.id, t]));
  const original = trucks.map((t) => t.id);
  const changed = order.some((id, i) => id !== original[i]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function move(from, to) {
    if (to < 0 || to >= order.length || from === to) return;
    setOrder((prev) => {
      const next = [...prev];
      const [id] = next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await onReorder(order);
      onClose();
    } catch (err) {
      window.alert(`Couldn't save the truck order: ${err.message}`);
      setSaving(false);
    }
  }

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <div className="truck-order-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Arrange truck order">
        <div className="tod-header">
          <div>
            <h3>Arrange truck order</h3>
            <p>This is the order trucks appear on the board. Use the arrows, type a position, or drag a row.</p>
          </div>
          <button className="tod-close" onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <ol className="tod-list">
          {order.map((id, i) => {
            const t = byId[id];
            if (!t) return null;
            const moved = original[i] !== id;
            return (
              <li
                key={id}
                className={`tod-row${dragIndex === i ? ' dragging' : ''}${overIndex === i && dragIndex !== null && dragIndex !== i ? ' drop-target' : ''}${moved ? ' moved' : ''}`}
                draggable
                onDragStart={(e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
                onDragOver={(e) => { e.preventDefault(); if (overIndex !== i) setOverIndex(i); }}
                onDrop={(e) => { e.preventDefault(); if (dragIndex !== null) move(dragIndex, i); setDragIndex(null); setOverIndex(null); }}
                onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
              >
                <span className="tod-grip" title="Drag to move">⠿</span>
                <input
                  className="tod-pos"
                  type="number" min={1} max={order.length}
                  value={i + 1}
                  title="Type a position and press Enter"
                  onChange={() => {}}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const n = parseInt(e.currentTarget.value, 10);
                      if (!Number.isNaN(n)) move(i, Math.min(Math.max(n, 1), order.length) - 1);
                    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      move(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
                    }
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <span className="tod-name">
                  {t.name}
                  {t.status === 'maintenance' && <span className="tod-tag">out of service</span>}
                </span>
                <span className="tod-actions">
                  <button onClick={() => move(i, 0)} disabled={i === 0} title="Move to top">⤒</button>
                  <button onClick={() => move(i, i - 1)} disabled={i === 0} title="Move up">↑</button>
                  <button onClick={() => move(i, i + 1)} disabled={i === order.length - 1} title="Move down">↓</button>
                  <button onClick={() => move(i, order.length - 1)} disabled={i === order.length - 1} title="Move to bottom">⤓</button>
                </span>
              </li>
            );
          })}
        </ol>

        <div className="tod-footer">
          <button className="btn secondary" onClick={() => setOrder(original)} disabled={!changed || saving}>Undo changes</button>
          <span style={{ flex: 1 }} />
          <button className="btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn" onClick={save} disabled={!changed || saving}>{saving ? 'Saving…' : 'Save order'}</button>
        </div>
      </div>
    </div>
  );
}
