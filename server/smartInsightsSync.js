/**
 * Orchestrates one Smart Insights sync: Gmail -> parse (both reports) -> join -> map -> upsert.
 *
 * Runs at 12:00 PM and 4:00 PM ET, every day, via functions-index.js's smartInsightsSyncScheduled
 * (shortly after the actual report emails go out at 11:51 AM / 3:51 PM ET), and on demand via
 * POST /api/smart-insights/sync-now (see server.js).
 *
 * TWO-REPORT JOIN (redesigned 2026-08-24 — see smartInsightsGmail.js's file header for how each
 * email is found/downloaded): SmartMoving's "All Jobs" report is job-level (one row per Job
 * Number, e.g. "24100-1") but has NO customer name, email, phone, or address columns at all — it's
 * an operational export, not a lead/customer report. The older "Booked Opportunities by Service
 * Date" report is the opposite: opportunity-level (one row per opportunity id, e.g. "24100") WITH
 * customer/address/sales-person data, keyed by the same id that prefixes every one of that
 * opportunity's Job Numbers.
 *
 * The join is driven from the Booked Opportunities side, not the All Jobs side — for each
 * opportunity in that report, find its matching Job Number rows in the All Jobs report (by
 * stripping the trailing "-<sequence>") and add those, EXCLUDING only rows whose own Custom Lead
 * Status explicitly says the row itself is dead (see TERMINAL_JOB_STATUSES below — changed
 * 2026-08-31, see that constant's comment for why this used to require an exact "Booked" match
 * instead). An All Jobs row whose opportunity doesn't appear in this run's Booked Opportunities
 * data is skipped rather than added with a placeholder customer name — see
 * mapSmartInsightsRow.js's doc comment for why. This means opportunity "24100" with three booked
 * Job Numbers becomes THREE separate jobs on the board (SI-24100-1, SI-24100-2, SI-24100-3), each
 * carrying the same customer/address inherited from the one opportunity row, exactly mirroring how
 * multi-truck/multi-stop SmartMoving jobs already work via the REST poll (see
 * frontend/src/utils/jobs.js's groupByOpportunity()).
 *
 * This join is done FRESH, in-memory, from whatever both reports' UNPROCESSED emails contain in
 * THIS run — there's no separate Firestore table of opportunity data carried over between runs
 * (deliberately: the user asked not to store more in Firestore than the job board already stored
 * before this report existed — see mapSmartInsightsRow.js's file header). The Booked Opportunities
 * report re-lists every open booked opportunity each day, BUT — corrected 2026-08-31, an earlier
 * version of this comment claimed this held "regardless of age": live investigation (job 23996,
 * plus a broader dry-run scan — see server/debug-smart-insights-dryrun.js) found the report is
 * actually scoped to a rolling Service Date window (observed ~2026-07-01 to ~2026-09-25 on
 * 2026-08-31, i.e. roughly the current quarter) — an opportunity whose service date has aged out of
 * that window, or is too far in the future, simply stops appearing and its jobs can never join, no
 * matter how many times this syncs. That's a report-configuration question on SmartMoving/Sigma's
 * side, not something fixable here. Within that window, though, a job that's missed on one day's
 * sync because its opportunity email hadn't landed yet will still match successfully once both
 * reports for the SAME day are present together in a later run, without needing to remember
 * anything from past runs. The tradeoff: if the All Jobs report ever stops being re-sent daily (or
 * its schedule drifts far from the Booked Opportunities one), a job could go unmatched for longer
 * than expected — worth revisiting with a persisted opportunity lookup if that turns out to happen
 * in practice.
 *
 * Gmail messages are only marked processed (smartInsightsGmail.markMessageProcessed) AFTER their
 * file has been fully parsed — a Booked Opportunities email as soon as it's parsed (nothing further
 * can fail for it, since it only feeds an in-memory lookup), an All Jobs email only once every one
 * of its booked rows has been upserted without throwing. If an All Jobs file's processing throws
 * partway through, its message stays unlabeled and the whole file is retried from scratch on the
 * next run (upsertSmartInsightsJob is idempotent, so re-processing an already-synced row is
 * harmless).
 */
const {
  findUnprocessedBookedOpportunityFiles, findUnprocessedAllJobsFiles, markMessageProcessed,
} = require('./smartInsightsGmail');
const { parseReportBuffer } = require('./smartInsightsReport');
const { parseAllJobsBuffer, opportunityIdFromJobNumber } = require('./smartInsightsAllJobsReport');
const { mapAllJobsRowToJob } = require('./mapSmartInsightsRow');
const db = require('./db');

/** Bug fixed 2026-08-31 (reported: job 23996, confirmed real/booked by the user on both SmartMoving
 * reports directly, never appeared on the board): Pass 2 used to require an All Jobs row's OWN
 * Custom Lead Status to read exactly "Booked" before even attempting the opportunity join below —
 * but live data showed that column is frequently blank on real, currently-booked jobs (23996's two
 * job rows both had a null Custom Lead Status despite their opportunity showing status "Booked" in
 * the Booked Opportunities report) — and in this account's real data, blank was in fact the SINGLE
 * LARGEST Custom Lead Status value across the whole report, larger even than "Booked" itself. That
 * exact-match requirement was silently dropping a large fraction of genuinely booked jobs before
 * they ever reached the join step.
 *
 * The Booked Opportunities report is already scoped to booked-only opportunities (that's what makes
 * it useful here at all), so it's the more trustworthy signal — this now only excludes a row whose
 * OWN status explicitly says the row itself isn't going forward (covers the one legitimate case
 * this used to also guard against: one leg of a multi-job move getting individually cancelled while
 * its siblings under the same opportunity stay active). Every other status — including blank —
 * still has to pass the real gate below: mapAllJobsRowToJob returns null without a matching Booked
 * opportunity, so a row with no real booking behind it is excluded exactly as before, just via the
 * join instead of this column. */
const TERMINAL_JOB_STATUSES = new Set(['dead', 'cancelled', 'canceled', 'lost', 'bad lead']);

/**
 * @returns {Promise<{opportunitiesFound: number, filesProcessed: number, filesSkipped: number,
 *   jobsCreated: number, jobsUpdated: number, rowsSkipped: number, jobsRemovedLost: number,
 *   errors: string[]}>}
 *   `messagesFound` is kept as an alias of (booked opportunity emails + all jobs emails) found,
 *   for the frontend's "no new report emails" check — see useSchedulerData.js's syncSmartInsightsNow.
 */
async function syncSmartInsights() {
  const [opportunityFiles, allJobsFiles] = await Promise.all([
    findUnprocessedBookedOpportunityFiles(),
    findUnprocessedAllJobsFiles(),
  ]);

  const summary = {
    messagesFound: opportunityFiles.length + allJobsFiles.length,
    opportunitiesFound: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    jobsCreated: 0,
    jobsUpdated: 0,
    rowsSkipped: 0,
    // Manual edit lock (added 2026-09-08 — see db.js's markJobManuallyEdited): a row that matched an
    // existing job but was skipped because a dispatcher hand-corrected it. Tracked separately from
    // jobsUpdated so that count stays accurate (an upsert this sync intentionally left untouched
    // isn't really an "update") — see the `wasCreated`/`wasSkipped` destructure below.
    jobsSkippedManualEdit: 0,
    // A terminal-status row (see TERMINAL_JOB_STATUSES below) whose job was already on the board
    // from an earlier, non-terminal sync — removed outright rather than just left stale. Tracked
    // separately from rowsSkipped so "skipped, nothing to do" and "skipped, AND something was
    // actively deleted" stay distinguishable in the sync summary.
    jobsRemovedLost: 0,
    errors: [],
  };

  // Pass 1: Booked Opportunities emails -> an in-memory opportunity-id -> row lookup (this run
  // only — see file header for why nothing here is persisted to Firestore). Marked processed
  // immediately on successful parse; there's no further step that can fail for these.
  const opportunitiesById = new Map();
  for (const file of opportunityFiles) {
    if (file.error) {
      summary.errors.push(`message ${file.messageId}: ${file.error}`);
      continue;
    }
    if (file.skipped) {
      summary.filesSkipped++;
      continue;
    }
    try {
      const rows = parseReportBuffer(file.buffer);
      for (const row of rows) {
        if (!row.quoteNumber) continue;
        opportunitiesById.set(row.quoteNumber, row);
      }
      summary.opportunitiesFound += rows.length;
      await markMessageProcessed(file.messageId);
      summary.filesProcessed++;
    } catch (err) {
      summary.errors.push(`message ${file.messageId} (${file.filename || 'unknown file'}): ${err.message}`);
      // Message stays unlabeled — retried in full next run, see file header.
    }
  }

  // Pass 2: All Jobs emails -> exclude explicitly-terminal rows -> join against the opportunity map
  // above -> upsert one job per matched row. Each file's message is only marked processed once
  // every one of its rows has been handled without throwing (join misses/status filtering are NOT
  // failures — they just don't produce a job — only an actual parse/write error blocks marking it
  // processed).
  for (const file of allJobsFiles) {
    if (file.error) {
      summary.errors.push(`message ${file.messageId}: ${file.error}`);
      continue;
    }
    if (file.skipped) {
      summary.filesSkipped++;
      continue;
    }
    try {
      const rows = parseAllJobsBuffer(file.buffer);
      let created = 0, updated = 0, skipped = 0, skippedManualEdit = 0, removedLost = 0;
      for (const row of rows) {
        if (TERMINAL_JOB_STATUSES.has((row.customLeadStatus || '').trim().toLowerCase())) {
          skipped++;
          // The row itself says this job is dead/cancelled/lost — if an earlier, non-terminal sync
          // already created a board job for it (id is always `SI-<jobNumber>`, same scheme
          // mapSmartInsightsRow.js builds it under), take it off the board instead of just leaving
          // it stale forever. See db.js's removeLostSmartInsightsJob for exactly what this does and
          // doesn't touch (never a job merged onto a different, SmartMoving/calendar-sourced doc).
          if (await db.removeLostSmartInsightsJob(`SI-${row.jobNumber}`)) {
            removedLost++;
            console.log(`[smartInsightsSync] removed SI-${row.jobNumber} — Custom Lead Status "${row.customLeadStatus}" in the All Jobs report`);
          }
          continue;
        }
        const opportunity = opportunitiesById.get(opportunityIdFromJobNumber(row.jobNumber));
        const job = mapAllJobsRowToJob(row, opportunity);
        if (!job) { skipped++; continue; }
        const { created: wasCreated, skippedManualEdit: wasLocked } = await db.upsertSmartInsightsJob(job);
        if (wasCreated) created++;
        else if (wasLocked) skippedManualEdit++;
        else updated++;
      }
      // Credit the counts as soon as the Firestore writes succeed, BEFORE the label call below —
      // the upserts are what actually matter (and did happen) even if markMessageProcessed then
      // throws (e.g. a transient Gmail API error) — see this same fix in the single-report version
      // of this file, applied here from the start this time.
      summary.jobsCreated += created;
      summary.jobsUpdated += updated;
      summary.rowsSkipped += skipped;
      summary.jobsSkippedManualEdit += skippedManualEdit;
      summary.jobsRemovedLost += removedLost;
      await markMessageProcessed(file.messageId);
      summary.filesProcessed++;
    } catch (err) {
      summary.errors.push(`message ${file.messageId} (${file.filename || 'unknown file'}): ${err.message}`);
      // Message stays unlabeled — retried in full next run, see file header.
    }
  }

  return summary;
}

module.exports = { syncSmartInsights };
