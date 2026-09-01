/**
 * One-off diagnostic — runs the EXACT SAME join logic as smartInsightsSync.js's syncSmartInsights()
 * (same two report-email lookups, same status filter, same opportunity-id join), but writes NOTHING
 * to Firestore and marks NOTHING processed, so it's safe to run as many times as you want. Built
 * for "a lot of jobs aren't showing up on the board" — debug-job-lookup.js is for one specific job
 * number; this is for seeing the whole picture at once: how many rows exist, how many matched, and
 * — critically — WHY each unmatched one didn't, broken out by reason, not just a single aggregate
 * "rowsSkipped" count like the real sync's summary gives you.
 *
 * Two modes, tried in order for EACH report type independently:
 *   1. "unprocessed" — the same findUnprocessed*Files() the real sync uses. This is exactly what
 *      clicking "Sync Now" would act on right now.
 *   2. "newest (already processed)" — falls back to the single newest email of that type REGARDLESS
 *      of whether this app already labeled it processed, used only when mode 1 finds nothing. This
 *      matters because each report email is only ever read once (see smartInsightsSync.js's file
 *      header) — if you already clicked "Sync Now" today, today's emails are already labeled and
 *      mode 1 will correctly find nothing, but that doesn't mean there's nothing to diagnose: this
 *      mode lets you see exactly what THAT already-processed run actually saw and why rows were
 *      skipped, without needing to wait for tomorrow's fresh email.
 *
 * Reasons a row in the All Jobs report doesn't become a job (see mapSmartInsightsRow.js /
 * smartInsightsSync.js for the real logic this mirrors):
 *   1. Custom Lead Status isn't exactly "Booked" after trim+lowercase — this script tallies every
 *      DISTINCT status value actually seen, so a wording drift ("Booked - Paid" vs "Booked") shows
 *      up immediately instead of silently swallowing rows you'd expect to match.
 *   2. No matching opportunity in the Booked Opportunities report (by stripping the job number's
 *      trailing "-<sequence>") — lists every such job number so you can check whether its
 *      opportunity is missing from the report entirely, or present but not matching for some other
 *      reason (e.g. a Quote # formatting difference).
 *   3. Missing jobNumber/jobDate on the row itself (mapAllJobsRowToJob's own guard).
 *
 * Usage:
 *   cd server
 *   node debug-smart-insights-dryrun.js
 */
require('./load-env');
const { google } = require('googleapis');
const {
  getAuthenticatedClient, findUnprocessedBookedOpportunityFiles, findUnprocessedAllJobsFiles,
  extractDownloadUrl, fetchReportFile, extractXlsxAttachmentPart, fetchAttachmentBuffer,
  fetchAndSortByDate, SEARCH_QUERY_BOOKED_OPPORTUNITIES, SEARCH_QUERY_ALL_JOBS,
} = require('./smartInsightsGmail');
const { parseReportBuffer } = require('./smartInsightsReport');
const { parseAllJobsBuffer, opportunityIdFromJobNumber } = require('./smartInsightsAllJobsReport');

function summarizeCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `"${k}" (${v})`).join(', ');
}

/** Newest message of a given search query, regardless of processed label. */
async function fetchNewestMessage(gmail, query) {
  const { data: listData } = await gmail.users.messages.list({ userId: 'me', q: query });
  const messageIds = (listData.messages || []).map((m) => m.id);
  if (!messageIds.length) return null;
  const { fetched } = await fetchAndSortByDate(gmail, messageIds);
  return fetched.length ? fetched[fetched.length - 1] : null; // oldest->newest, so last = newest
}

/** Returns [{buffer, source: 'unprocessed'|'newest (already processed)'}] for one report type —
 * tries the real unprocessed lookup first, falls back to the single newest email either way. */
async function resolveFiles(gmail, unprocessedFiles, searchQuery, extractBuffer) {
  const ok = unprocessedFiles.filter((f) => f.buffer);
  if (ok.length) return { files: ok.map((f) => f.buffer), source: 'unprocessed', count: unprocessedFiles.length, bad: unprocessedFiles.filter((f) => !f.buffer) };
  const newest = await fetchNewestMessage(gmail, searchQuery);
  if (!newest) return { files: [], source: 'none found', count: 0, bad: [] };
  const buffer = await extractBuffer(gmail, newest);
  return { files: buffer ? [buffer] : [], source: 'newest (already processed)', count: 1, bad: buffer ? [] : [{ messageId: newest.messageId, error: 'could not extract report from this message' }] };
}

(async () => {
  console.log('Checking report emails (unprocessed first, falling back to the newest already-processed one if none)...\n');

  const auth = getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const [unprocessedOpp, unprocessedAllJobs] = await Promise.all([
    findUnprocessedBookedOpportunityFiles(),
    findUnprocessedAllJobsFiles(),
  ]);

  const oppResult = await resolveFiles(gmail, unprocessedOpp, SEARCH_QUERY_BOOKED_OPPORTUNITIES, async (gm, msg) => {
    const url = extractDownloadUrl(msg.message);
    return url ? fetchReportFile(url) : null;
  });
  const jobsResult = await resolveFiles(gmail, unprocessedAllJobs, SEARCH_QUERY_ALL_JOBS, async (gm, msg) => {
    const att = extractXlsxAttachmentPart(msg.message);
    return att ? fetchAttachmentBuffer(gm, msg.messageId, att.attachmentId) : null;
  });

  console.log(`Booked Opportunities: using ${oppResult.files.length} email(s) — mode: ${oppResult.source}.`);
  oppResult.bad.forEach((f) => console.log(`  message ${f.messageId}: ${f.error || f.reason}`));
  console.log(`All Jobs: using ${jobsResult.files.length} email(s) — mode: ${jobsResult.source}.`);
  jobsResult.bad.forEach((f) => console.log(`  message ${f.messageId}: ${f.error || f.reason}`));

  if (!oppResult.files.length || !jobsResult.files.length) {
    console.log(
      `\n${!oppResult.files.length ? 'No Booked Opportunities' : 'No All Jobs'} report email found in this inbox AT ALL ` +
      '(not even an already-processed one) — that\'s the root cause right there, not a join problem: ' +
      'check (a) the report emails are still arriving daily to this inbox, (b) GMAIL_OAUTH_REFRESH_TOKEN ' +
      'is still valid — a revoked/expired token makes gmail.users.messages.list return zero results ' +
      'with no obvious error rather than an auth failure, (c) SmartMoving/Sigma hasn\'t changed the ' +
      'sender address or subject line the search queries in smartInsightsGmail.js key off.'
    );
    process.exit(0);
  }

  const opportunitiesById = new Map();
  oppResult.files.forEach((buf) => {
    parseReportBuffer(buf).forEach((row) => {
      if (row.quoteNumber) opportunitiesById.set(row.quoteNumber, row);
    });
  });
  console.log(`\n${opportunitiesById.size} distinct booked opportunity id(s) available to join against.`);

  // Service/Booked date range actually present in the Booked Opportunities report — used below to
  // test whether unmatched jobs are missing because that report is scoped to a rolling date window
  // (its own name is "Booked Opportunities BY SERVICE DATE") rather than genuinely re-listing every
  // still-open booked opportunity regardless of age, which is what smartInsightsSync.js's file
  // header currently assumes.
  const serviceDates = [...opportunitiesById.values()].map((o) => o.serviceDate).filter(Boolean).sort();
  const bookedDates = [...opportunitiesById.values()].map((o) => o.bookedDate).filter(Boolean).sort();
  console.log(`  Service Date range in this report: ${serviceDates[0] || '(none)'} .. ${serviceDates[serviceDates.length - 1] || '(none)'}`);
  console.log(`  Booked Date range in this report: ${bookedDates[0] || '(none)'} .. ${bookedDates[bookedDates.length - 1] || '(none)'}`);

  const statusCounts = new Map();
  const noOpportunityMatch = [];
  const noOpportunityMatchDetail = [];
  const noJobNumberOrDate = [];
  let matched = 0;
  let totalRows = 0;

  jobsResult.files.forEach((buf) => {
    const rows = parseAllJobsBuffer(buf);
    totalRows += rows.length;
    rows.forEach((row) => {
      const status = (row.customLeadStatus || '(blank)').trim();
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
      if (status.toLowerCase() !== 'booked') return;
      if (!row.jobNumber || !row.jobDate) { noJobNumberOrDate.push(row.jobNumber || '(no job number)'); return; }
      const oppId = opportunityIdFromJobNumber(row.jobNumber);
      if (!opportunitiesById.has(oppId)) {
        noOpportunityMatch.push(`${row.jobNumber} (opportunity id "${oppId}")`);
        noOpportunityMatchDetail.push({ jobNumber: row.jobNumber, jobDate: row.jobDate });
        return;
      }
      matched++;
    });
  });

  console.log(`\n=== All Jobs report: ${totalRows} total row(s) ===`);
  console.log(`Custom Lead Status breakdown: ${summarizeCounts(statusCounts)}`);
  console.log('  -> only rows whose status is exactly "Booked" (case/whitespace-insensitive) are eligible to sync.');

  console.log(`\n${matched} row(s) WOULD (or DID, if mode is "newest (already processed)" above) successfully sync.`);

  if (noOpportunityMatch.length) {
    const isOutside = (d) => d.jobDate && serviceDates.length &&
      (d.jobDate < serviceDates[0] || d.jobDate > serviceDates[serviceDates.length - 1]);
    const outside = noOpportunityMatchDetail.filter(isOutside);
    const inRange = noOpportunityMatchDetail.filter((d) => !isOutside(d));

    // Summary + the actionable (in-range) subset print FIRST and in FULL, not truncated — this is
    // the smaller, more interesting group: a job date outside the report's own Service Date range
    // is explained by that report being scoped to a rolling window (see this file's header), but
    // one INSIDE the range with no match can't be explained that way — it points at a real
    // formatting mismatch (e.g. a Quote # prefix/suffix difference) worth checking by eye.
    console.log(
      `\n${noOpportunityMatch.length} Booked row(s) have NO matching opportunity — ${outside.length} of ` +
      `them have a job date outside this report's own Service Date range shown above (explained by ` +
      `that report being scoped to a rolling window, not a code bug), leaving ${inRange.length} that ` +
      `are INSIDE the range and still unmatched — those are the ones worth investigating:`
    );
    if (inRange.length) {
      inRange.forEach((d) => console.log(`  ${d.jobNumber} — job date ${d.jobDate} (opportunity id "${opportunityIdFromJobNumber(d.jobNumber)}")`));
      console.log(
        '  For each of these, open the raw Booked Opportunities .xlsx and search for that opportunity ' +
        'id in the Quote # column by eye — if it\'s there but formatted differently (extra whitespace, ' +
        'a leading zero, a prefix like "Q-"), that\'s the mismatch; if it\'s genuinely absent, the ' +
        'opportunity likely isn\'t actually marked Booked on SmartMoving\'s side despite its job(s) ' +
        'showing Booked in the All Jobs report.'
      );
    } else {
      console.log('  (none — every unmatched job is explained by the date-range theory above.)');
    }

    console.log(`\nFull list of all ${noOpportunityMatch.length} unmatched job(s) (first 40 shown):`);
    noOpportunityMatchDetail.slice(0, 40).forEach((d) => {
      console.log(`  ${d.jobNumber} — job date ${d.jobDate || '(none)'}${isOutside(d) ? '  <- outside Service Date range' : ''}`);
    });
    if (noOpportunityMatch.length > 40) console.log(`  ...and ${noOpportunityMatch.length - 40} more.`);
  }
  if (noJobNumberOrDate.length) {
    console.log(`\n${noJobNumberOrDate.length} row(s) skipped — missing Job Number or Job Date on the row itself: ${noJobNumberOrDate.slice(0, 20).join(', ')}`);
  }

  if (oppResult.source.startsWith('newest') || jobsResult.source.startsWith('newest')) {
    console.log(
      '\nNote: at least one report above was already marked processed by a prior sync — the counts ' +
      'shown reflect what that run actually saw, but "Sync Now" won\'t re-read it. Any job listed ' +
      'above as unmatched will only get picked up once a genuinely NEW report email arrives.'
    );
  }

  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
