import { useEffect, useState } from 'react';
import { jobTruckIds, driversBusyOnDate } from '../../utils/jobs';

/**
 * Click-to-edit modal for a job — opened by clicking a job block on the day-view timeline (see
 * JobBlock's onClick in JobVisuals.jsx / DayBoard.jsx) or an unassigned chip (JobChip/
 * GroupedJobChip, same onClick wiring via DayBoard.jsx). Edits date/time (local jobs: a single
 * date + start time + duration; long-distance jobs: a start date, end date, and departure time —
 * the same "Departs H:MM" value set by dropping the job onto a truck, just a keyboard-friendly way
 * to set an exact value instead of eyeballing a drop position) PLUS customer/origin/destination/
 * trucks needed/crew size, which used to only be settable at creation time or not at all for
 * SmartMoving-sourced jobs. All of these are plain fields on the job document (see db.js's
 * updateJob) — nothing here is source-specific, so this works the same for placeholder and
 * SmartMoving-imported jobs alike (editing a SmartMoving job's fields locally doesn't push back to
 * SmartMoving — see SyncPanel's one-way-sync note — and a future re-sync only refreshes
 * SmartMoving-owned fields like date/customer, never trucksNeeded/status, so a local edit here to
 * those two specifically won't get silently overwritten).
 *
 * Deliberately a separate small component rather than folded into JobBlock — JobBlock is a
 * presentational piece reused across day-view truck rows, and a modal has its own lifecycle
 * (escape-to-close, backdrop click, form state) that doesn't belong mixed into that render loop.
 *
 * `onBack` is optional and only passed when this modal was reached by picking a job out of
 * JobConflictChooser (see DayBoard.jsx) — it renders a small "back to which-job list" link so a
 * dispatcher who picked the wrong one of two overlapping jobs isn't stuck re-clicking the board.
 * Plain edits (unassigned tray chip, a job with no overlap) never pass it, so nothing changes for
 * the common case.
 *
 * Trucks & drivers (added 2026-09-02 at the user's request) apply IMMEDIATELY, the moment a truck
 * is added/removed or a driver is picked — NOT batched into the rest of the form and only committed
 * on Save. This deliberately matches how truck/driver assignment already works everywhere else in
 * the app (dragging a job onto a truck's row, JobBlock's own hover "+truck"/"+driver" controls in
 * JobVisuals.jsx) — instant, not part of a Save/Cancel cycle — so Cancel here still discards any
 * unsaved customer/date/address edits without also needing to explain or implement rolling back a
 * truck assignment that already round-tripped to the server. `job` is always the live object from
 * DayBoard.jsx's `jobs` array (re-found by id on every render, not a frozen snapshot taken when the
 * modal opened), so the truck/driver list here stays in sync with each action's result the same way
 * JobBlock's own controls do.
 */
export default function JobEditModal({
  job, trucks = [], drivers = [], jobs = [],
  onAddExtraTruck, onRemoveTruck, onSetJobTruckDriver,
  onSave, onClose, onDelete, onBack,
}) {
  const isLd = job.type === 'long_distance';
  const [date, setDate] = useState(job.date || '');
  const [endDate, setEndDate] = useState(job.endDate || job.date || '');
  const [startTime, setStartTime] = useState(job.startTime || '');
  const [duration, setDuration] = useState(job.duration ?? 2);
  const [customer, setCustomer] = useState(job.customer || '');
  const [origin, setOrigin] = useState(job.origin || '');
  const [destination, setDestination] = useState(job.destination || '');
  const [trucksNeeded, setTrucksNeeded] = useState(job.trucksNeeded ?? 1);
  const [crewSize, setCrewSize] = useState(job.crewSize ?? '');
  const [error, setError] = useState('');

  // Trucks currently on this job (in the order they were assigned) and every other truck still
  // available to add — same assigned/available split AddTruckControl (JobVisuals.jsx) uses for the
  // on-block "+truck" picker, just rendered as a form section here instead of a hover-reveal corner
  // badge (this modal isn't positioned inside a job block, so that CSS wouldn't apply).
  const assignedTruckIds = jobTruckIds(job);
  const assignedTrucks = assignedTruckIds.map((id) => trucks.find((t) => t.id === id)).filter(Boolean);
  const availableTrucks = trucks.filter((t) => !assignedTruckIds.includes(t.id));
  // Driver ids already busy on some OTHER job active on this job's own date, whose time window
  // overlaps this job's — same driversBusyOnDate call AddDriverControl (JobVisuals.jsx) uses, just
  // computed once here for the whole job rather than per-truck (a driver busy elsewhere is equally
  // unavailable no matter which of this job's trucks you're picking for). Uses job.date (this job's
  // own start date) rather than a currently-viewed board date, since this modal isn't tied to
  // whichever day happens to be showing on the board — a driver conflict should be checked against
  // the day this job actually runs.
  const busyDriverIds = driversBusyOnDate(jobs, job.date, job.id, job);
  function driverOptionsFor(truckId) {
    const current = (job.truckDrivers || {})[truckId] || '';
    return drivers.filter((d) => d.id === current || !busyDriverIds.has(d.id));
  }

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
    const trucks = Number(trucksNeeded) || 1;
    if (trucks < 1) { setError('Trucks needed must be at least 1.'); return; }
    const shared = {
      customer: customer.trim(), origin: origin.trim(), destination: destination.trim(),
      trucksNeeded: trucks, crewSize: crewSize === '' ? null : Number(crewSize),
    };
    if (isLd) {
      if (endDate && endDate < date) { setError('End date must be on or after the start date.'); return; }
      onSave({ ...shared, date, endDate: endDate || date, startTime: startTime || null });
    } else {
      const dur = Number(duration);
      if (!dur || dur <= 0) { setError('Duration must be greater than 0.'); return; }
      // Local jobs are single-day — this modal doesn't even show an end-date field for them (see the
      // isLd branch above) — so `endDate` must always be sent alongside `date`, not just `date` on
      // its own. Without this, changing a local job's date only patched `date` server-side (db.js's
      // updateJob only touches fields actually present in the payload) and left endDate sitting at
      // whatever it was set to at creation, silently producing an inverted date/endDate range (e.g.
      // date moved to 8/26 but endDate still 8/25) the moment a dispatcher rescheduled a local job.
      onSave({ ...shared, date, endDate: date, startTime: startTime || null, duration: dur });
    }
  }

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <form className="job-edit-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSave}>
        {onBack && (
          <button type="button" className="jc-back-link" onClick={onBack}>‹ Back to which-job list</button>
        )}
        <h3>Edit {isLd ? 'long-distance move' : 'job'} — {job.customer}</h3>

        {/* "Open in SmartMoving" — added 2026-08-27 at the user's request. Only the opportunity id
            (a real SmartMoving GUID, confirmed live against the URL SmartMoving's own dashboard
            uses: https://app.smartmoving.com/opportunities/<id>/estimate) works for this — the
            job's OWN smartMovingJobId field isn't reliably a real SmartMoving identifier (for a
            calendar-sourced job it's really the Google Calendar event's id, a different kind of
            value entirely — see db.js's preserveSmartMovingIdentity). smartMovingOpportunityId is
            only ever set by the REST poll (mapJobs.js/mapOpportunity.js) or, since that fix, kept
            once the REST poll has set it — never by the calendar sync or a Smart Insights report on
            their own. So this link only appears once a job has actually been synced via the REST
            poll at least once; a job that's only ever come from Smart Insights or the calendar has
            no real opportunity id to link to yet, and the link is simply omitted rather than
            pointing somewhere wrong. Opens the OPPORTUNITY level, not this specific job leg — on a
            multi-job booking (e.g. 23569-1/2/3) every sibling job opens the same SmartMoving page,
            which is the only level SmartMoving's own URL scheme exposes. */}
        {job.smartMovingOpportunityId && (
          <a
            className="job-edit-sm-link"
            href={`https://app.smartmoving.com/opportunities/${job.smartMovingOpportunityId}/estimate`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            Open in SmartMoving ↗
          </a>
        )}

        <label className="job-edit-field">
          Customer
          <input type="text" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </label>

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

        {/* Live-apply — see this component's doc comment above for why these aren't part of the
            Save/Cancel form state like every field above. Rendered at all only when the caller
            passed the truck/driver props (DayBoard.jsx always does); a hypothetical future caller
            that doesn't wire them up just gets the plain field-editing modal as before. */}
        {(onAddExtraTruck || onRemoveTruck || onSetJobTruckDriver) && (
          <div className="job-edit-field job-edit-trucks">
            <span>Trucks &amp; drivers</span>
            {assignedTrucks.length ? (
              <div className="job-edit-truck-list">
                {assignedTrucks.map((t) => (
                  <div className="job-edit-truck-row" key={t.id}>
                    <span className="job-edit-truck-name">{t.name}</span>
                    <select
                      className="job-edit-driver-select"
                      value={(job.truckDrivers || {})[t.id] || ''}
                      title="Set the driver for this truck on this job"
                      onChange={(e) => onSetJobTruckDriver && onSetJobTruckDriver(job.id, t.id, e.target.value || null)}
                      disabled={!onSetJobTruckDriver || !drivers.length}
                    >
                      <option value="">No driver</option>
                      {driverOptionsFor(t.id).map((d) => <option value={d.id} key={d.id}>{d.name}</option>)}
                    </select>
                    {onRemoveTruck && (
                      <button
                        type="button"
                        className="job-edit-truck-remove"
                        title={`Remove ${t.name} from this job`}
                        onClick={() => onRemoveTruck(job.id, t.id)}
                      >×</button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="job-edit-truck-empty">No trucks assigned yet.</div>
            )}
            {onAddExtraTruck && availableTrucks.length > 0 && (
              <select
                className="job-edit-add-truck"
                value=""
                title="Load doesn't fit in one truck? Add another."
                onChange={(e) => {
                  const truckId = e.target.value;
                  if (truckId) onAddExtraTruck(job.id, truckId);
                  e.target.value = '';
                }}
              >
                <option value="">+ Add truck</option>
                {availableTrucks.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
              </select>
            )}
          </div>
        )}

        <label className="job-edit-field">
          Crew size
          <input type="number" min="1" step="1" value={crewSize} placeholder="optional" onChange={(e) => setCrewSize(e.target.value)} />
        </label>

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
