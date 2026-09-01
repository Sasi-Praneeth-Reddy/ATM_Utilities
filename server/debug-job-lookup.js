/**
 * One-off diagnostic — traces ONE job number through the Smart Insights report pipeline end to end,
 * to answer "why isn't job <N> on the board yet even though I can see it in the report I was just
 * emailed."
 *
 * Unlike syncSmartInsights() (server/smartInsightsSync.js), this does NOT filter to only
 * unprocessed report emails and does NOT mark anything processed or write anything to Firestore —
 * it looks at the MOST RECENT real email of each report type regardless of whether this app has
 * already labeled it processed, so it can show:
 *
 *   1. Whether that job number's row is in the All Jobs report at all, and what its Custom Lead
 *      Status actually says — the sync only keeps rows whose status is EXACTLY "booked" after
 *      trim+lowercase (see smartInsightsSync.js), so a status like "Booked - Pending Payment" would
 *      silently fall through as skipped, not errored.
 *   2. Whether a matching opportunity row exists in the Booked Opportunities report, matched by
 *      stripping the trailing "-<sequence>" off the job number (see
 *      smartInsightsAllJobsReport.js's opportunityIdFromJobNumber) — a job with no matching
 *      opportunity is skipped by design (see mapSmartInsightsRow.js's doc comment).
 *   3. Whether the newest email of each type has ALREADY been marked processed by a prior sync — if
 *      so, and the job was missing/unbooked at that point, clicking "Sync Now" again won't refetch
 *      it — each report email is only ever read once (see smartInsightsSync.js's file header). It
 *      takes a genuinely NEW report email (tomorrow's daily one, typically) to pick it up.
 *   4. Whether the job already exists on the board right now, under either id shape this app could
 *      have created it as (SI-<job> from this pipeline, or SM-<job> from the calendar/REST paths,
 *      which upsertSmartInsightsJob merges Smart-Insights fields onto instead of duplicating — see
 *      db.js's file header).
 *
 * Read-only everywhere: Gmail messages.list/get/attachments.get (no .modify call), Firestore
 * db.getState() only. Safe to run as many times as you want.
 *
 * Usage (run from your machine — same Gmail OAuth + Firestore requirements as your other sync/debug
 * scripts):
 *   cd server
 *   node debug-job-lookup.js 23996
 */
require('./load-env');
const { google } = require('googleapis');
const db = require('./db');
const {
  getAuthenticatedClient, findUnprocessedBookedOpportunityFiles, findUnprocessedAllJobsFiles,
  extractDownloadUrl, fetchReportFile, extractXlsxAttachmentPart, fetchAttachmentBuffer,
  fetchAndSortByDate, SEARCH_QUERY_BOOKED_OPPORTUNITIES, SEARCH_QUERY_ALL_JOBS,
} = require('./smartInsightsGmail');
const { parseReportBuffer } = require('./smartInsightsReport');
const { parseAllJobsBuffer, opportunityIdFromJobNumber } = require('./smartInsightsAllJobsReport');

const jobNumberArg = process.argv[2];
if (!jobNumberArg) {
  console.error('Usage: node debug-job-lookup.js <jobNumber>   (e.g. node debug-job-lookup.js 23996)');
  process.exit(1);
}
const opportunityIdArg = opportunityIdFromJobNumber(jobNumberArg);

/** Newest message of a given search query, REGARDLESS of processed label — unlike
 * findUnprocessed*Files(), which deliberately excludes already-labeled messages. */
async function fetchNewestMessage(gmail, query) {
  const { data: listData } = await gmail.users.messages.list({ userId: 'me', q: query });
  const messageIds = (listData.messages || []).map((m) => m.id);
  if (!messageIds.length) return null;
  const { fetched } = await fetchAndSortByDate(gmail, messageIds);
  return fetched.length ? fetched[fetched.length - 1] : null; // fetchAndSortByDate sorts oldest->newest
}

(async () => {
  console.log(`Looking up job "${jobNumberArg}" (opportunity id "${opportunityIdArg}")...\n`);

  const auth = getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const [newestOppMsg, newestAllJobsMsg, unprocessedOpp, unprocessedAllJobs, { jobs }] = await Promise.all([
    fetchNewestMessage(gmail, SEARCH_QUERY_BOOKED_OPPORTUNITIES),
    fetchNewestMessage(gmail, SEARCH_QUERY_ALL_JOBS),
    findUnprocessedBookedOpportunityFiles(),
    findUnprocessedAllJobsFiles(),
    db.getState(),
  ]);

  // --- 4. Already on the board? ---
  // Matches SI-<jobNumber>/SM-<jobNumber> exactly (the arg was already a full job number, e.g.
  // "23996-1") OR SI-<jobNumber>-N/SM-<jobNumber>-N (the arg was a bare opportunity id, e.g.
  // "23996", which every real job number is "<opportunity id>-<sequence>" of — see
  // smartInsightsAllJobsReport.js's opportunityIdFromJobNumber) — an opportunity can have more than
  // one job (multi-truck/multi-stop), so this can legitimately print more than one match.
  console.log('=== Already on the board? ===');
  const idPrefixes = ['SI-', 'SM-'];
  const existing = jobs.filter((j) => idPrefixes.some((p) =>
    j.id === `${p}${jobNumberArg}` || j.id.startsWith(`${p}${jobNumberArg}-`) || j.id.startsWith(`${p}${opportunityIdArg}-`)));
  if (existing.length) {
    existing.forEach((j) => console.log(`  FOUND: ${j.id} — customer: ${j.customer}, source: ${j.source}, date: ${j.date}`));
  } else {
    console.log(`  Not found under any SI-${opportunityIdArg}* or SM-${opportunityIdArg}* job id.`);
  }

  // --- Booked Opportunities report ---
  console.log('\n=== Booked Opportunities report (newest email) ===');
  if (!newestOppMsg) {
    console.log('  No Booked Opportunities report email found at all in this inbox.');
  } else {
    const alreadyProcessed = !unprocessedOpp.some((f) => f.messageId === newestOppMsg.messageId);
    console.log(`  Newest email: messageId ${newestOppMsg.messageId}, already processed by a prior sync: ${alreadyProcessed}`);
    const downloadUrl = extractDownloadUrl(newestOppMsg.message);
    if (!downloadUrl) {
      console.log('  Could not find a report download link in this email body.');
    } else {
      const buffer = await fetchReportFile(downloadUrl);
      const rows = parseReportBuffer(buffer);
      const match = rows.find((r) => r.quoteNumber === opportunityIdArg);
      if (match) {
        console.log(`  FOUND opportunity "${opportunityIdArg}": customer "${match.customerName}", status "${match.status}", service type "${match.serviceType}"`);
      } else {
        console.log(`  Opportunity "${opportunityIdArg}" is NOT in this report's ${rows.length} row(s) — the join in smartInsightsSync.js would skip this job entirely without this.`);
      }
    }
  }

  // --- All Jobs report ---
  console.log('\n=== All Jobs report (newest email) ===');
  if (!newestAllJobsMsg) {
    console.log('  No All Jobs report email found at all in this inbox.');
  } else {
    const alreadyProcessed = !unprocessedAllJobs.some((f) => f.messageId === newestAllJobsMsg.messageId);
    console.log(`  Newest email: messageId ${newestAllJobsMsg.messageId}, already processed by a prior sync: ${alreadyProcessed}`);
    const attachment = extractXlsxAttachmentPart(newestAllJobsMsg.message);
    if (!attachment) {
      console.log('  Could not find an .xlsx attachment on this email.');
    } else {
      const buffer = await fetchAttachmentBuffer(gmail, newestAllJobsMsg.messageId, attachment.attachmentId);
      const rows = parseAllJobsBuffer(buffer);
      // Job Number in this report is always "<opportunity id>-<sequence>" (e.g. "23996-1") — never
      // a bare opportunity id on its own (see smartInsightsAllJobsReport.js's file header) — so
      // match on the SAME opportunity-id-prefix logic that join actually uses, not string equality
      // against whatever was typed on the command line. One opportunity can have more than one job
      // row (multi-truck/multi-stop), so this lists every match, not just the first.
      const matches = rows.filter((r) => r.jobNumber === jobNumberArg || opportunityIdFromJobNumber(r.jobNumber) === opportunityIdArg);
      if (matches.length) {
        matches.forEach((match) => {
          const isBooked = (match.customLeadStatus || '').trim().toLowerCase() === 'booked';
          console.log(`  FOUND job "${match.jobNumber}": Custom Lead Status = "${match.customLeadStatus}" (counts as Booked for the sync: ${isBooked})`);
        });
      } else {
        console.log(`  Job "${jobNumberArg}" is NOT in this report's ${rows.length} row(s).`);
      }
    }
  }

  console.log(
    '\nHow to read this: for the job to land on the board, it needs to (a) appear in an All Jobs ' +
    'report row with Custom Lead Status exactly "Booked", (b) have a matching opportunity in a ' +
    'Booked Opportunities report, and (c) at least one of the two report emails carrying that data ' +
    'needs to still be unprocessed so "Sync Now" (or the daily 6am run) actually reads it. If both ' +
    'emails above already show "already processed: true" and the job/opportunity data was missing ' +
    'or not-yet-Booked at that point, nothing will pick it up until a genuinely NEW report email ' +
    'arrives — normally tomorrow\'s daily one.'
  );

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
