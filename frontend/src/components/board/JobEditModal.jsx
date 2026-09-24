import { useEffect, useState } from 'react';
import { jobTruckIds, driversBusyOnDate, JOB_COLOR_OPTIONS } from '../../utils/jobs';

/** Compact date+time for the lock notes below (added 2026-09-24, at the user's request to make
 *  those messages more compact) — drops seconds and uses a 2-digit year ("9/24/26, 7:36 AM")
 *  instead of utils/dates.js's fmtDateTime, which does a full `toLocaleString()`
 *  ("9/24/2026, 7:36:56 AM"). Kept local to this file rather than changed in that shared helper,
 *  which JobVisuals.jsx's ManualEditBadge/TruckLockBadge tooltips and JobAssignmentsTab's row also
 *  rely on — those weren't part of this request and a hover tooltip has room to be less compact
 *  than a note printed directly on the card. */
function fmtCompact(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/** The 5-swatch color picker (added 2026-09-15, "All users to change these colors when clicking on
 *  the job") — shared between the full modal below and its colorOnly (crew) mode, so the two never
 *  drift apart. Applies immediately on click, same "not part of Save/Cancel" pattern the trucks/
 *  drivers section already uses (see this file's header) — clicking the job's CURRENT color again
 *  clears the override back to the automatic military/LD/packing/storage/local color, same toggle-
 *  off convenience a checkbox would give. Rendered as nothing (not even the section) if the caller
 *  didn't wire up onSetJobColor at all, same "optional prop, optional UI" pattern the truck/driver
 *  controls use. */
function ColorSwatchPicker({ job, onSetJobColor }) {
  if (!onSetJobColor) return null;
  const current = job.colorOverride || null;
  return (
    <div className="job-edit-field job-edit-colors">
      <span>Color</span>
      <div className="job-edit-color-swatches">
        {JOB_COLOR_OPTIONS.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`job-edit-color-swatch ${c.key} ${current === c.key ? 'active' : ''}`}
            title={c.label}
            aria-label={c.label}
            onClick={() => onSetJobColor(job.id, current === c.key ? null : c.key)}
          >
            {current === c.key ? '✓' : ''}
          </button>
        ))}
      </div>
      {current && (
        <button type="button" className="job-edit-color-clear" onClick={() => onSetJobColor(job.id, null)}>
          Clear override (use automatic color)
        </button>
      )}
    </div>
  );
}

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
 * SmartMoving — see SyncPanel's one-way-sync note). trucksNeeded/status were always dispatcher-owned
 * and never touched by a re-sync; as of 2026-09-08, saving a real change to any of the other fields
 * here (customer/date/time/addresses/crewSize — db.js's MANUAL_EDIT_LOCK_FIELDS) now locks the WHOLE
 * job, so a subsequent REST poll/calendar/Smart Insights sync can't silently revert it either — see
 * the manual-edit-lock notice/"Resync from source" button rendered below when that's active.
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
  onAddExtraTruck, onRemoveTruck, onSetJobTruckDriver, onSetJobColor,
  onSave, onClose, onDelete, onBack, onClearManualEdit,
  colorOnly = false,
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

  // colorOnly (added 2026-09-15 at the user's request, "All users to change these colors when
  // clicking on the job") — the crew role's stripped-down view of this same modal (see DayBoard.jsx,
  // the only caller that ever passes colorOnly=true). Crew has no access to any other field here
  // (canEdit gates the rest of the app's editing UI — see DayBoard.jsx's own comment), so this
  // renders just enough to identify the job plus the color picker and a close button — no Save/
  // Cancel form, no truck/driver section, no delete — rather than exposing (even read-only) fields
  // crew was never meant to see the internals of. This early return sits AFTER every hook above
  // (not before, and not a `colorOnly` short-circuit at the top of the function) specifically so
  // this component still calls the same hooks in the same order on every render regardless of
  // colorOnly's value — the local form state, autofocus/escape effect etc. above go unused in this
  // branch, but React's rules require they still run.
  if (colorOnly) {
    return (
      <div className="job-edit-overlay" onClick={onClose}>
        <div className="job-edit-modal" onClick={(e) => e.stopPropagation()}>
          <h3>{job.customer}</h3>
          <div className="job-edit-hint">
            {job.date}{job.startTime ? ` · ${job.startTime}` : ''}
            {job.origin || job.destination ? ` · ${job.origin || '(no origin)'} → ${job.destination || '(no destination)'}` : ''}
          </div>
          <ColorSwatchPicker job={job} onSetJobColor={onSetJobColor} />
          <div className="job-edit-actions">
            <span className="job-edit-actions-spacer" />
            <button type="button" className="btn secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  function handleSave(e) {
    e.preventDefault();
    if (!date) { setError('Date is required.'); return; }
    const trucks = Number(trucksNeeded) || 1;
    if (trucks < 1) { setError('Trucks needed must be at least 1.'); return; }
    const shared = {
      customer: customer.trim(), origin: origin.trim(), destination: destination.trim(),
      trucksNeeded: trucks, crewSize: crewSize === '' ? null : Number(crewSize),
    };
    // Re-base trucksNeededOriginal (db.js's floor for useSchedulerData.js's removeTruckFromJob/
    // unassignJob roll-back) ONLY when the dispatcher actually changed this number here — never on
    // every Save, since handleSave always resends whatever's currently in the field regardless of
    // whether it was touched (see this modal's file header). Blindly re-basing on every Save would
    // let an unrelated edit (fixing the customer name, say) silently lock in a trucksNeeded value
    // that had only been auto-bumped by a truck-assignment mistake, defeating the whole point of
    // that roll-back. Comparing against `job.trucksNeeded` (what this modal opened with) rather than
    // the local `trucksNeeded` state's initial value keeps this correct even if a truck was
    // added/removed live while the modal was open (trucks apply immediately — see the file header).
    if (trucks !== (job.trucksNeeded ?? 1)) {
      shared.trucksNeededOriginal = trucks;
    }
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
        {/* Moved to the card's top corner 2026-09-24 at the user's request ("make the delete button
            on the edit job card... in the top corner of it") — was previously a full-width "Delete
            job" button at the bottom of job-edit-actions, alongside Cancel/Save. Absolutely
            positioned against .job-edit-modal (now position:relative — see styles.css) so it always
            sits in the same corner regardless of title length or whether onBack's back-link is
            showing above it. Still gated on onDelete exactly like before (DayBoard.jsx only passes
            it when canEdit), and still carries job-edit-delete-btn so styles.css's mobile breakpoint
            hides it the same way it always has. */}
        {onDelete && (
          <button
            type="button"
            className="job-edit-delete-corner job-edit-delete-btn"
            title="Delete job"
            onClick={onDelete}
          >🗑</button>
        )}
        {onBack && (
          <button type="button" className="jc-back-link" onClick={onBack}>‹ Back to which-job list</button>
        )}
        <h3 className={onDelete ? 'job-edit-title-has-delete' : ''}>Edit {isLd ? 'long-distance move' : 'job'} — {job.customer}</h3>

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

        {/* Manual edit lock (added 2026-09-08 at the user's request) — shown whenever a previous
            edit here (or a resize/date-move elsewhere on the board that touched one of db.js's
            MANUAL_EDIT_LOCK_FIELDS: customer/type/date/endDate/startTime/endTime/duration/origin/
            destination/crewSize/notes) has already locked this job. Truck/driver reassignment does
            NOT lock the job (reverted 2026-09-14 — see MANUAL_EDIT_LOCK_FIELDS's own comment in
            db.js), so dragging a job onto a different truck here never triggers this note by itself.
            While locked, the REST poll, calendar sync, and Smart Insights sync all skip this job
            entirely — see db.js's markJobManuallyEdited — so a dispatcher's correction can't be
            silently reverted by the next automatic sync. "Resync from source" lifts the lock (db.js's
            clearJobManualEdit) without forcing an immediate re-sync — the job just goes back to
            updating normally on the next one. */}
        {job.manuallyEditedAt && (
          <div className="job-edit-lock-note">
            {/* WHO + WHEN, not just "manually edited" (added at the user's follow-up request, "reduce
                the confusion") — a dispatcher opening this months later, or a different dispatcher
                than whoever locked it, needs both to know whether the correction is still current or
                worth double-checking, not just that a lock exists at all. Made compact 2026-09-24
                (shorter sentence, fmtCompact's trimmed date/time, row layout instead of stacked —
                see this file's header and styles.css's .job-edit-lock-note). */}
            <span>
              🔒 Manually edited{job.manuallyEditedBy ? ` by ${job.manuallyEditedBy}` : ''}
              {fmtCompact(job.manuallyEditedAt) ? ` · ${fmtCompact(job.manuallyEditedAt)}` : ''} — syncs won't overwrite this until resynced.
            </span>
            {onClearManualEdit && (
              <button type="button" className="btn secondary job-edit-resync-btn" title="Resync from source — lets SmartMoving, calendar, and Smart Insights syncs update this job again" onClick={onClearManualEdit}>
                Resync
              </button>
            )}
          </div>
        )}

        {/* Truck-assignment lock (added 2026-09-14, split out from the note above — see db.js's
            markTruckAssignmentManual/MANUAL_EDIT_LOCK_FIELDS comments for the full history) — shown
            whenever a truck/driver was assigned, reassigned, or removed here (or a real "Trucks
            needed" edit was saved), independent of whether the job's date/customer/etc. is ALSO
            locked above. Only the calendar sync currently has real truck data to sync from (see
            db.js's syncTruckAssignmentUnlessLocked) — while locked, it leaves this job's truck/driver
            assignment alone entirely, the same "Resync from source" button below lifts both locks at
            once (db.js's clearJobManualEdit), so a job locked on both fronts shows both notes but only
            needs one click to resume syncing everything. */}
        {job.truckLockedAt && (
          <div className="job-edit-lock-note">
            {/* Made compact 2026-09-24 alongside the note above — same shorter-sentence/fmtCompact/
                row-layout treatment. */}
            <span>
              🔒🚚 Truck set{job.truckLockedBy ? ` by ${job.truckLockedBy}` : ''}
              {fmtCompact(job.truckLockedAt) ? ` · ${fmtCompact(job.truckLockedAt)}` : ''} — calendar sync won't change it until resynced.
            </span>
            {onClearManualEdit && (
              <button type="button" className="btn secondary job-edit-resync-btn" title="Resync from source — lets the calendar sync update this job's truck/driver again" onClick={onClearManualEdit}>
                Resync
              </button>
            )}
          </div>
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

        <ColorSwatchPicker job={job} onSetJobColor={onSetJobColor} />

        <label className="job-edit-field">
          Crew size
          <input type="number" min="1" step="1" value={crewSize} placeholder="optional" onChange={(e) => setCrewSize(e.target.value)} />
        </label>

        {error && <div className="job-edit-error">{error}</div>}

        <div className="job-edit-actions">
          <span className="job-edit-actions-spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn">Save</button>
        </div>
      </form>
    </div>
  );
}
