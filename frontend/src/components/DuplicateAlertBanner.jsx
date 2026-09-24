import { fmtRange } from '../utils/dates';
import { jobTruckNames } from '../utils/jobs';

// Truck names for one side of a flagged pair, as its own short parenthetical — added 2026-09-18 at
// the user's request. Deliberately doesn't say anything different when the two sides land on
// different trucks (no "⚠ different truck" callout, no suppressing the alert) — the user was
// explicit that the alert should keep showing exactly as before either way ("the alert should still
// show"), just with enough truck context alongside it that a dispatcher can tell at a glance
// whether the placeholder and the real job already ended up on different trucks (already correctly
// split — a quick "yes, that's fine" check) or the same one (worth a closer look) without having to
// click into each job first.
function truckNote(job, trucks) {
  const names = jobTruckNames(job, trucks);
  if (!names.length) return 'no truck assigned';
  return names.join(', ');
}

// Mirrors ConflictBanner.jsx's shape — see utils/jobs.js's getPlaceholderDuplicates() for why this
// is computed client-side from `jobs` rather than a stored/dismissable alert.
//
// hidden/onToggleHidden (added 2026-09-22 at the user's request: "give me a button to the
// placeholder alert to hide and display when needed") — collapse/expand state itself lives in
// BoardTab.jsx (a plain useState, not persisted, same "personal viewing preference" treatment as
// hideInTransit right below it there) so it survives switching between Day/Month view without
// resetting, but resets on a normal page reload same as every other view toggle in this app. Both
// props are optional so this component still renders exactly as before if a future caller doesn't
// wire them up. Deliberately never auto-hides itself or forgets a duplicate exists while hidden — a
// dispatcher who hides this because they've already reviewed today's list still sees a small
// collapsed reminder (below) rather than the alert silently vanishing, same reasoning DayBoard.jsx's
// hideInTransit toggle already uses for its own count badge.
export default function DuplicateAlertBanner({ duplicates, trucks, hidden, onToggleHidden }) {
  if (!duplicates.length) return null;

  if (hidden) {
    return (
      <button
        type="button"
        className="duplicate-banner-collapsed"
        onClick={onToggleHidden}
        title="Show the placeholder duplicate alert"
      >
        ⚠ {duplicates.length} placeholder duplicate{duplicates.length > 1 ? 's' : ''} hidden — tap to show
      </button>
    );
  }

  return (
    <div className="conflict-banner duplicate-banner">
      <div className="cb-title">
        <span>⚠ {duplicates.length} placeholder duplicate{duplicates.length > 1 ? 's' : ''} detected</span>
        {onToggleHidden && (
          <button type="button" className="cb-hide-btn" onClick={onToggleHidden} title="Hide this alert until you show it again">
            Hide
          </button>
        )}
      </div>
      <ul>
        {duplicates.map((d, i) => (
          <li key={i}>
            <b>{d.placeholder.customer}</b> — placeholder job ({d.placeholder.id}, {fmtRange(d.placeholder)}
            {trucks && `, truck: ${truckNote(d.placeholder, trucks)}`})
            {/* "another job already on the board" instead of "a job from the Smart Insights report"
                — changed 2026-09-18 alongside utils/jobs.js's getPlaceholderDuplicates fix, which
                now matches against ANY non-placeholder job, not just source === 'smartmoving-
                insights' specifically. A calendar/REST sync commonly re-labels a Smart-Insights-
                sourced job's source to 'smartmoving' once it enriches it with a real truck
                assignment, so by the time a pair shows up here the matched job may no longer
                literally BE Smart-Insights-sourced — the quote number below still shows whenever
                that field survived from wherever the job originated, regardless of its current
                source label. */}
            matches another job already on the board (<b>{d.reportJob.id}</b>, {fmtRange(d.reportJob)}
            {d.reportJob.smartInsightsQuoteNumber ? `, quote #${d.reportJob.smartInsightsQuoteNumber}` : ''}
            {trucks && `, truck: ${truckNote(d.reportJob, trucks)}`}).
            Likely the same move — delete the placeholder once you've confirmed it, or update its
            customer name if it's actually a different job.
          </li>
        ))}
      </ul>
    </div>
  );
}
