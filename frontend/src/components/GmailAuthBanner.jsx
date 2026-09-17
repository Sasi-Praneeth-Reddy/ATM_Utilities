/** App-wide "Gmail authorization about to expire" banner — added 2026-09-08 alongside SyncPanel's
 * own countdown line (components/admin/SyncPanel.jsx). SyncPanel's line only shows up if an admin
 * happens to be on the Job Assignments tab; this banner mirrors BackendBanner's placement (right
 * under the header, on every tab) so a lapsed Gmail authorization is visible no matter which part
 * of the board an admin has open, the same way a disconnected backend already is.
 *
 * Deliberately much quieter than SyncPanel's version until things are actually urgent — this
 * renders nothing at all unless within GMAIL_AUTH_BANNER_WARNING_DAYS of expiring or already
 * expired, so it doesn't compete with BackendBanner/DuplicateAlertBanner for attention during the
 * other ~5 days of every cycle when there's nothing to do yet. Admin-only (App.jsx only renders
 * this for role === 'admin') since re-authorizing is an admin/ops task — a dispatcher or crew
 * account seeing this couldn't act on it anyway. */
const GMAIL_AUTH_BANNER_WARNING_DAYS = 1;

export default function GmailAuthBanner({ status }) {
  if (!status || !status.tracked) return null;
  if (!status.expired && status.daysRemaining > GMAIL_AUTH_BANNER_WARNING_DAYS) return null;

  const daysAgo = status.expired ? Math.abs(status.daysRemaining) : 0;
  const message = status.expired
    ? `Gmail authorization expired ${daysAgo === 0 ? 'today' : `${daysAgo} day${daysAgo > 1 ? 's' : ''} ago`} — report sync and calendar sync are failing until it's renewed.`
    : `Gmail authorization expires ${status.daysRemaining === 0 ? 'today' : 'tomorrow'} — renew it soon to avoid a sync failure.`;

  return (
    <div className="conflict-banner" role="alert">
      <div className="cb-title">⚠ {message} Run <code>npm run gmail-auth</code> (see server/gmail-oauth-setup.js), or see Job Assignments → Smart Insights Report Sync for details.</div>
    </div>
  );
}
