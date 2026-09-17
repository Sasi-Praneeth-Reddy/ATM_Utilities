import { useEffect, useState } from 'react';
import { JOB_COLOR_OPTIONS } from '../../utils/jobs';

/**
 * Quick-add a "placeholder" job from the day view — name, date, the day it runs until, a time, and
 * optionally origin/destination/trucks needed/crew size, for penciling in something that isn't in
 * SmartMoving (a phone-booked job not synced yet, a tentative hold, etc.) without having to fill in
 * every field a real job has. Only "Date" is actually required — everything else, including the
 * fields added here, can be left blank and filled in later via JobEditModal or Admin → Job
 * Assignments once known. Created unassigned (shows up in the Unassigned tray like any other job)
 * and tagged `source: 'placeholder'` so it's visually flagged (see PlaceholderBadge in
 * JobVisuals.jsx) as a stub rather than a confirmed, fully-detailed booking.
 *
 * Local vs. long-distance is now picked explicitly (the "Local" / "Long Distance" toggle below) —
 * used to be inferred from whether "until" was later than the start date, same as JobEditModal
 * still does. Picking "Long Distance" here also switches the "Until" field from disabled/locked-
 * to-the-start-date over to an editable end date, since a local job is always single-day.
 */
export default function JobCreateModal({ defaultDate, onCreate, onClose }) {
  const [type, setType] = useState('local');
  const [customer, setCustomer] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [endDate, setEndDate] = useState(defaultDate);
  const [startTime, setStartTime] = useState('');
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [trucksNeeded, setTrucksNeeded] = useState(1);
  const [crewSize, setCrewSize] = useState('');
  // Color override, picked at creation time (added 2026-09-16 at the user's request — "for
  // placeholder give option for colors"). Unlike JobEditModal's ColorSwatchPicker (which applies
  // each click immediately via onSetJobColor, since it's editing a job that already exists), this
  // job doesn't have an id yet — there's nothing to PATCH — so this just holds the pick in local
  // state and sends it along as `colorOverride` in the same POST that creates the job (see
  // handleSave below and server.js's POST /api/jobs handler). Same 5-color set as the automatic
  // green/yellow/purple/red/orange taxonomy (JOB_COLOR_OPTIONS, utils/jobs.js) — this is a manual
  // override on top of it, not a 6th color, so the swatches double as a "leave it automatic" no-op
  // when nothing is selected.
  const [color, setColor] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isLd = type === 'long_distance';

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
    // Local jobs are always single-day regardless of whatever stale value is sitting in `endDate`
    // state (e.g. left over from switching type back and forth before saving) — force it to match
    // `date` rather than trusting the field.
    const resolvedEndDate = isLd ? (endDate || date) : date;
    if (isLd && resolvedEndDate < date) { setError('"Until" must be on or after the date.'); return; }
    setSaving(true);
    setError('');
    try {
      await onCreate({
        customer: customer.trim(), type, date, endDate: resolvedEndDate, startTime: startTime || null,
        origin: origin.trim(), destination: destination.trim(),
        trucksNeeded: trucksNeeded || 1, crewSize: crewSize || null,
        colorOverride: color || null,
      });
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
        <div className="job-edit-field">
          Type
          <div className="job-type-toggle">
            <button
              type="button"
              className={`btn secondary ${!isLd ? 'active' : ''}`}
              onClick={() => setType('local')}
            >
              Local
            </button>
            <button
              type="button"
              className={`btn secondary ${isLd ? 'active' : ''}`}
              onClick={() => setType('long_distance')}
            >
              Long Distance
            </button>
          </div>
        </div>
        <label className="job-edit-field">
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        {isLd && (
          <label className="job-edit-field">
            Until (last day)
            <input type="date" value={endDate} min={date || undefined} onChange={(e) => setEndDate(e.target.value)} />
            <span className="job-edit-hint">The last day of the move — required for a long-distance job.</span>
          </label>
        )}
        <label className="job-edit-field">
          Time
          <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </label>
        <label className="job-edit-field">
          Origin
          <input type="text" value={origin} placeholder="e.g. 1420 Larimer St, Denver, CO" onChange={(e) => setOrigin(e.target.value)} />
        </label>
        <label className="job-edit-field">
          Destination
          <input type="text" value={destination} placeholder="e.g. 880 Pearl St, Boulder, CO" onChange={(e) => setDestination(e.target.value)} />
        </label>
        <label className="job-edit-field">
          Trucks needed
          <input type="number" min="1" step="1" value={trucksNeeded} onChange={(e) => setTrucksNeeded(e.target.value)} />
        </label>
        <label className="job-edit-field">
          Crew size
          <input type="number" min="1" step="1" value={crewSize} placeholder="optional" onChange={(e) => setCrewSize(e.target.value)} />
        </label>
        <div className="job-edit-field job-edit-colors">
          Color
          <div className="job-edit-color-swatches">
            {JOB_COLOR_OPTIONS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`job-edit-color-swatch ${c.key} ${color === c.key ? 'active' : ''}`}
                title={c.label}
                aria-label={c.label}
                onClick={() => setColor(color === c.key ? null : c.key)}
              >
                {color === c.key ? '✓' : ''}
              </button>
            ))}
          </div>
          <span className="job-edit-hint">Optional — leave blank to use the automatic color once the job type is known.</span>
        </div>

        {error && <div className="job-edit-error">{error}</div>}

        <div className="job-edit-actions">
          <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn" disabled={saving}>{saving ? 'Adding…' : 'Add job'}</button>
        </div>
      </form>
    </div>
  );
}
