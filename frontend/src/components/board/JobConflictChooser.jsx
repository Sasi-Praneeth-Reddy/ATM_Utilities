import { useEffect } from 'react';
import { fmtRange } from '../../utils/dates';
import { jobTruckDriver } from '../../utils/jobs';

/**
 * "Which job do you want to see?" chooser — shown instead of jumping straight into JobEditModal
 * when the job block that was clicked overlaps one or more other jobs on the same truck (see
 * DayBoard.jsx's openJobOrChooser). Overlapping jobs are drawn stacked on the timeline (see
 * stackZIndex's doc comment in utils/jobs.js: shorter jobs stack ABOVE longer ones so an overlap is
 * always visible), which used to mean a click on the shared area always resolved to whichever job
 * was drawn on top — the other one had no reliable way to be reached by clicking. This lists every
 * job in the overlapping cluster (utils/jobs.js's overlappingClusterFor) so a dispatcher can always
 * get to any of them, then hands off to the normal JobEditModal once a specific job is picked.
 *
 * Same overlay/modal shell as JobEditModal (.job-edit-overlay/.job-edit-modal) so it reads as part
 * of the same interaction, not a different kind of dialog.
 */
export default function JobConflictChooser({ jobs, truckId, truckName, drivers, onPick, onClose }) {
  useEffect(() => {
    function onKeyDown(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="job-edit-overlay" onClick={onClose}>
      <div className="job-edit-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Which job do you want to see?</h3>
        <div className="jc-sub">These jobs overlap on {truckName}</div>
        <div className="jc-options">
          {jobs.map((j) => {
            const driver = jobTruckDriver(drivers, j, truckId);
            return (
              <button type="button" key={j.id} className="jc-option" onClick={() => onPick(j.id)}>
                <span className="jc-name">{j.customer}</span>
                <span className="jc-meta">{j.id} · {fmtRange(j)}{driver ? ` — ${driver.name}` : ''}</span>
              </button>
            );
          })}
        </div>
        <div className="job-edit-actions">
          <span className="job-edit-actions-spacer" />
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
