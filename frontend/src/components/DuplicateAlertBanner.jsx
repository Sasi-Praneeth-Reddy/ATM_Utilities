import { fmtRange } from '../utils/dates';

// Mirrors ConflictBanner.jsx's shape — see utils/jobs.js's getPlaceholderDuplicates() for why this
// is computed client-side from `jobs` rather than a stored/dismissable alert.
export default function DuplicateAlertBanner({ duplicates }) {
  if (!duplicates.length) return null;
  return (
    <div className="conflict-banner duplicate-banner">
      <div className="cb-title">
        ⚠ {duplicates.length} placeholder duplicate{duplicates.length > 1 ? 's' : ''} detected
      </div>
      <ul>
        {duplicates.map((d, i) => (
          <li key={i}>
            <b>{d.placeholder.customer}</b> — placeholder job ({d.placeholder.id}, {fmtRange(d.placeholder)})
            matches a job from the Smart Insights report (<b>{d.reportJob.id}</b>, {fmtRange(d.reportJob)}
            {d.reportJob.smartInsightsQuoteNumber ? `, quote #${d.reportJob.smartInsightsQuoteNumber}` : ''}).
            Likely the same move — delete the placeholder once you've confirmed it, or update its
            customer name if it's actually a different job.
          </li>
        ))}
      </ul>
    </div>
  );
}
