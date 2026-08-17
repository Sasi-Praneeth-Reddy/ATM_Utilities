import { useEffect, useState } from 'react';

/**
 * Click-to-edit modal for a job's date/time — opened by clicking a job block on the day-view
 * timeline (see JobBlock's onClick in JobVisuals.jsx / DayBoard.jsx). Local jobs edit a single
 * date + start time + duration; long-distance jobs edit a start date, end date, and departure
 * time (the same "Departs H:MM" value set by dropping the job onto a truck — this is just a
 * keyboard-friendly way to set an exact value instead of eyeballing a drop position).
 *
 * Deliberately a separate small component rather than folded into JobBlock — JobBlock is a
 * presentational piece reused across day-view truck rows, and a modal has its own lifecycle
 * (escape-to-close, backdrop click, form state) that doesn't belong mixed into that render loop.
 */
export default function JobEditModal({ job, onSave, onClose, onDelete }) {
  const isLd = job.type === 'long_distance';
  const [date, setDate] = useState(job.date || '');
  const [endDate, setEndDate] = useState(job.endDate || job.date || '');
  const [startTime, setStartTime] = useState(job.startTime || '');
  const [duration, setDuration] = useState(job.duration ?? 2);
  const [error, setError] = useState('');

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function handleSave(e) {
    e.preventDefault();
    if (!date) { setError('Date is required.'); return; }
    if (isLd) {
      if (endDate && endDate < date) { setError('End date must be on or after the start date.'); return; }
      onSave({ date, endDate: endDate || date, startTime: startTime || null });
    } else {
      const dur = Number(duration);
      if (!dur || dur <= 0) { setError('Duration must be greater than 0.'); return; }
      onSave({ date, startTime: startTime || null, duration: dur });
    }
  }

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <form className="job-edit-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSave}>
        <h3>Edit {isLd ? 'long-distance move' : 'job'} — {job.customer}</h3>

        {isLd ? (
          <>
            <label className="job-edit-field">
              Start date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="job-edit-field">
              End date
              <input type="date" value={endDate} min={date || undefined} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <label className="job-edit-field">
              Departure time
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              <span className="job-edit-hint">Same as dropping the job onto a truck at a given time — leave blank if unknown.</span>
            </label>
          </>
        ) : (
          <>
            <label className="job-edit-field">
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="job-edit-field">
              Start time
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label className="job-edit-field">
              Duration (hours)
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
              <span className="job-edit-hint">You can also drag the right edge of the job block on the board to resize it.</span>
            </label>
          </>
        )}

        {error && <div className="job-edit-error">{error}</div>}

        <div className="job-edit-actions">
          {job.source === 'placeholder' && onDelete && (
            <button type="button" className="btn danger" onClick={onDelete}>Delete placeholder</button>
          )}
          <span className="job-edit-actions-spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn">Save</button>
        </div>
      </form>
    </div>
  );
}
