import { useEffect, useState } from 'react';

/**
 * Quick-add a "placeholder" job from the day view — just a name, date, the day it runs until, and
 * a time, for penciling in something that isn't in SmartMoving (a phone-booked job not synced
 * yet, a tentative hold, etc.) without having to fill in every field a real job has. Created
 * unassigned (shows up in the Unassigned tray like any other job) and tagged
 * `source: 'placeholder'` so it's visually flagged (see PlaceholderBadge in JobVisuals.jsx) as a
 * stub rather than a confirmed, fully-detailed booking — origin/destination/crew size can all be
 * filled in later via JobEditModal or Admin → Job Assignments once known.
 *
 * Whether this becomes a local or long-distance-style job isn't picked explicitly — same as
 * JobEditModal, it's inferred from whether "until" is later than the start date.
 */
export default function JobCreateModal({ defaultDate, onCreate, onClose }) {
  const [customer, setCustomer] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function handleSave(e) {
    e.preventDefault();
    if (!date) { setError('Date is required.'); return; }
    if (endDate && endDate < date) { setError('"Until" must be on or after the date.'); return; }
    setSaving(true);
    setError('');
    try {
      await onCreate({ customer: customer.trim(), date, endDate: endDate || date, startTime: startTime || null });
      onClose();
    } catch (err) {
      setSaving(false);
      setError(`Couldn't create job: ${err.message}`);
    }
  }

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <form className="job-edit-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSave}>
        <h3>Add placeholder job</h3>
        <div className="job-edit-hint" style={{ marginTop: -6 }}>
          A quick stub for a booking that isn't in SmartMoving — fill in the rest later.
        </div>

        <label className="job-edit-field">
          Name
          <input
            type="text"
            value={customer}
            placeholder="e.g. Thompson move (tentative)"
            onChange={(e) => setCustomer(e.target.value)}
            autoFocus
          />
        </label>
        <label className="job-edit-field">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="job-edit-field">
          Until (last day)
          <input type="date" value={endDate} min={date || undefined} onChange={(e) => setEndDate(e.target.value)} />
          <span className="job-edit-hint">Leave same as the date above for a single-day job; set it later for a multi-day move.</span>
        </label>
        <label className="job-edit-field">
          Time
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>

        {error && <div className="job-edit-error">{error}</div>}

        <div className="job-edit-actions">
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? 'Adding…' : 'Add job'}</button>
        </div>
      </form>
    </div>
  );
}
