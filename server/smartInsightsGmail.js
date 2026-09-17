/**
 * Gmail API OAuth2 client + email lookup for the SmartMoving "Smart Insights" report pipeline.
 *
 * This is NOT the Cowork/Claude chat's Gmail connector — that one only works inside a chat session
 * and can't be called from an unattended Cloud Function running on its own daily schedule. This
 * needs its own standing OAuth grant: a Google Cloud project with the Gmail API enabled, a
 * "Desktop app" OAuth client, and a one-time consent flow (`node server/gmail-oauth-setup.js`, run
 * once from your own machine — it needs a local browser + a local port, which this deployed
 * backend doesn't have) that produces a refresh token. That refresh token is stored as a Firebase
 * secret (GMAIL_OAUTH_REFRESH_TOKEN) and reused indefinitely from then on on every scheduled sync.
 *
 * Scope is `gmail.readonly` + `gmail.modify` (label + trash processed messages, see
 * markMessageProcessed below) — this project never sends mail and never permanently deletes it
 * (messages.trash only, recoverable for ~30 days — see markMessageProcessed's own comment). Ported
 * from the SM_Insights project's proven
 * ingest/gmailAuth.js + ingest/gmail.js (built and tested against this exact account's real report
 * email on 2026-08-19/24) — see project memory (project_sm_insights.md) for that history. Adapted
 * here to feed Scheduler_ATM's own job board directly instead of a separate service.
 *
 * TWO report emails now feed this pipeline (confirmed 2026-08-24 against real inbox messages —
 * see smartInsightsSync.js's file header for how they're joined):
 *  - "Booked Opportunities by Service Date" — from no-reply@smartmoving.com, subject exactly "Your
 *    SmartMoving Report is Ready!", the report file is a LINK in the email body (an Azure Blob
 *    Storage URL) that has to be downloaded separately. Unchanged from before.
 *  - "All Jobs" — from info@send.sigmacomputing.com (SmartMoving's underlying reports run on Sigma
 *    Computing, a completely different sending domain), subject "Your SmartMoving Report is Ready!
 *    ALL Jobs", and — unlike the other report — the .xlsx file is a direct EMAIL ATTACHMENT, not a
 *    link. No download URL to find in the body at all. Needs the Gmail attachments.get API instead
 *    of a plain fetch().
 */
const { google } = require('googleapis');

// gmail.readonly covers search/read. Applying our "processed" label to a message (messages.modify)
// needs the broader gmail.modify scope — gmail.labels only covers managing label objects
// themselves (list/create/delete), not attaching them to a message, and using it alone produces an
// "Insufficient Permission" error the first time markMessageProcessed() runs. gmail.modify is a
// superset (everything except permanent delete) but there's no narrower official scope that covers
// messages.modify. Reading an attachment's bytes (attachments.get, used for the "All Jobs" report
// below) is also covered by gmail.readonly — no additional scope needed for that.
// gmail.modify ALSO covers messages.trash (2026-09-04, see markMessageProcessed below) — moving a
// message to Gmail's Trash is explicitly listed under gmail.modify in Google's own scope docs,
// distinct from permanent delete (messages.delete, which needs the much broader
// https://mail.google.com/ scope and is NOT requested here). No new consent/re-auth needed.
// calendar.readonly added 2026-08-26 for googleCalendarClient.js — SmartMoving can sync its
// dispatch calendar into a Google Calendar under this SAME Gmail account (confirmed live with the
// user), which reads the same rich per-job DESCRIPTION text as the old iCal-URL feed
// (icalClient.js) but via the Calendar API instead of a bare HTTPS GET on a secret feed URL — one
// standing OAuth grant now covers both the Smart Insights report inbox and the dispatch calendar.
// NOTE: adding a scope to an already-issued refresh token doesn't retroactively grant it — this
// requires re-running gmail-oauth-setup.js once (fresh consent screen, since scopes are baked in at
// consent time) and updating the GMAIL_OAUTH_REFRESH_TOKEN secret with the new token it produces.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
];

// Distinct from SM_Insights's own label (if that project is ever deployed too) — each consumer of
// this inbox marks messages processed under its own label so the two never fight over the same
// "have we handled this yet" marker. Shared by both report searches below — a message just being
// labeled "handled by ATM-Scheduler" is enough; which report it was doesn't need its own label.
const LABEL_NAME = 'ATM-Scheduler/SmartInsights-Processed';

const SEARCH_QUERY_BOOKED_OPPORTUNITIES = 'from:no-reply@smartmoving.com subject:"SmartMoving Report is Ready"';
// Sigma's sending address has historically been info@send.sigmacomputing.com, but matching the
// whole send.sigmacomputing.com domain is more robust to Sigma changing the local part than
// pinning the exact address.
//
// Bug fixed 2026-08-31 (reported: a manually/on-demand-requested "All Jobs" report never got
// picked up by Sync Now even though the email was sitting right there): this query used to also
// require the literal phrase "ALL Jobs" in the SUBJECT line, on the assumption that's what
// distinguishes this report from any other Sigma-delivered report that might land in this same
// inbox. That held for the daily *scheduled* delivery, but a one-time/on-demand request from
// Sigma came through with a generic subject — "Your SmartMoving Report is Ready!" — with "All
// Jobs" appearing only in the body text, never in the subject at all. Gmail's `subject:` operator
// only searches the subject field, so that clause silently matched zero messages for this kind of
// email. The subject requirement is dropped here; findUnprocessedAllJobsFiles() below now
// verifies the report identity a more reliable way — by checking the actual .xlsx attachment's
// filename (which the report itself carries, not a delivery-template quirk) — after fetching each
// candidate message, so a different Sigma report landing in this inbox still gets correctly
// ignored rather than misread as an All Jobs report.
const SEARCH_QUERY_ALL_JOBS = 'from:send.sigmacomputing.com subject:"SmartMoving Report is Ready"';

/** Azure Blob Storage link inside the Booked Opportunities email body — confirmed 2026-08-24 (see
 * project memory) to be a real, unauthenticated, directly-fetchable URL, valid ~30 days from when
 * SmartMoving sends it. Not used for the "All Jobs" report — see findUnprocessedAllJobsFiles(). */
const DOWNLOAD_URL_PATTERN = /https:\/\/smfilestore\.blob\.core\.windows\.net\/report-exports\/[a-zA-Z0-9-]+\/[^\s"'<>]+\.xlsx/;

// The real "is this actually the All Jobs report" check (see SEARCH_QUERY_ALL_JOBS's comment above
// for why the search query alone can't tell) — matched against the .xlsx attachment's own filename
// (e.g. "All Jobs_All Jobs Report....xlsx"), case-insensitively, tolerant of the space between the
// two words being missing/doubled/replaced with an underscore.
const ALL_JOBS_FILENAME_PATTERN = /all[\s_]*jobs/i;

function getOAuth2Client() {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET not set — see .env.example and gmail-oauth-setup.js.');
  }
  // redirect_uri only matters during the one-time local setup flow (gmail-oauth-setup.js) — a
  // loopback address, since Google deprecated the old out-of-band ("copy this code") flow for
  // installed apps. Ordinary scheduled syncing never redirects anywhere.
  return new google.auth.OAuth2(clientId, clientSecret, 'http://localhost:53682/oauth2callback');
}

/** For unattended scheduled syncing — assumes gmail-oauth-setup.js has already produced a refresh
 * token, stored as the GMAIL_OAUTH_REFRESH_TOKEN secret. */
function getAuthenticatedClient() {
  const refreshToken = process.env.GMAIL_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error('GMAIL_OAUTH_REFRESH_TOKEN not set — run `node server/gmail-oauth-setup.js` once first, then set it as a Firebase secret.');
  }
  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function getOrCreateLabelId(gmail) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels || []).find((l) => l.name === LABEL_NAME);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.data.id;
}

function extractDownloadUrl(message) {
  const parts = [];
  function walk(part) {
    if (!part) return;
    if (part.body && part.body.data) parts.push(Buffer.from(part.body.data, 'base64').toString('utf8'));
    (part.parts || []).forEach(walk);
  }
  walk(message.payload);
  const fullText = parts.join('\n');
  const match = fullText.match(DOWNLOAD_URL_PATTERN);
  return match ? match[0] : null;
}

async function fetchReportFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Report download failed: HTTP ${res.status} from ${url}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Finds the first .xlsx attachment on a message (the "All Jobs" report always has exactly one —
 * see smartInsightsSync.js's file header for why this report arrives as an attachment instead of
 * the other report's body link). Returns the attachment's Gmail attachmentId (needed for a
 * separate attachments.get call — unlike the body text, attachment bytes aren't included in the
 * message payload itself) and filename, or null if the message has no .xlsx attachment. */
function extractXlsxAttachmentPart(message) {
  let found = null;
  function walk(part) {
    if (!part || found) return;
    if (part.filename && /\.xlsx$/i.test(part.filename) && part.body && part.body.attachmentId) {
      found = { attachmentId: part.body.attachmentId, filename: part.filename };
      return;
    }
    (part.parts || []).forEach(walk);
  }
  walk(message.payload);
  return found;
}

/** Downloads one attachment's bytes via the Gmail API (separate call from messages.get — the
 * message payload only carries an attachmentId reference, not the actual data, once a part is
 * over a small inline-size threshold, which every real .xlsx report always is). Gmail returns
 * attachment bytes as base64url, not plain base64 — Buffer's 'base64url' encoding (Node 15+)
 * decodes both padding variants correctly; using plain 'base64' here would silently corrupt any
 * byte sequence containing the '-'/'_' characters base64url uses in place of '+'/'/'. */
async function fetchAttachmentBuffer(gmail, messageId, attachmentId) {
  const { data } = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  return Buffer.from(data.data, 'base64url');
}

/** Fetches the full message for each id, then sorts the successful fetches oldest-to-newest by the
 * message's actual send time (`internalDate`, a ms-epoch string Gmail stamps on every message —
 * NOT something derived from search result order). Both findUnprocessed*Files() callers below feed
 * their results into code that keeps the LAST-processed value when the same opportunity/job id
 * shows up twice in one run (smartInsightsSync.js's `opportunitiesById.set(...)` and its Firestore
 * upserts) — Gmail's search result order is not documented to be date-sorted, so without this an
 * older backlog message processed after a newer one could silently overwrite the newer report's
 * data. This only matters when 2+ days of a report end up unprocessed in the same run (missed
 * schedule, prior run failure) — the normal one-new-email-a-day case is unaffected either way — but
 * sorting explicitly here means correctness never depends on Gmail's actual (undocumented) order.
 * @returns {Promise<{fetched: Array<{messageId: string, message: object}>, results: Array<{messageId: string, error: string}>}>}
 *   `results` carries only the fetch failures, in the shape the callers' result arrays expect —
 *   callers prepend it to what they build from `fetched`. */
async function fetchAndSortByDate(gmail, messageIds) {
  const fetched = [];
  const results = [];
  for (const messageId of messageIds) {
    try {
      const { data: message } = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
      fetched.push({ messageId, message });
    } catch (err) {
      results.push({ messageId, error: err.message });
    }
  }
  fetched.sort((a, b) => Number(a.message.internalDate) - Number(b.message.internalDate));
  return { fetched, results };
}

/**
 * Finds every not-yet-processed Booked Opportunities report email, downloads each one's report
 * file (from the link in the body), and returns the raw buffers — labeling is the CALLER's job
 * (smartInsightsSync.js), done only after a message's file has been successfully parsed and
 * consumed, so a mid-pipeline failure leaves the message unlabeled and it's retried on the next
 * scheduled run instead of silently skipped.
 * @returns {Promise<Array<{messageId: string, buffer: Buffer, filename: string} | {messageId: string, skipped: true, reason: string} | {messageId: string, error: string}>>}
 */
async function findUnprocessedBookedOpportunityFiles() {
  const auth = getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const { data: listData } = await gmail.users.messages.list({
    userId: 'me',
    q: `${SEARCH_QUERY_BOOKED_OPPORTUNITIES} -label:${LABEL_NAME.replace('/', '-')}`,
  });
  const messageIds = (listData.messages || []).map((m) => m.id);

  const { fetched, results: fetchErrors } = await fetchAndSortByDate(gmail, messageIds);
  const results = [...fetchErrors];
  for (const { messageId, message } of fetched) {
    const downloadUrl = extractDownloadUrl(message);
    if (!downloadUrl) {
      results.push({ messageId, skipped: true, reason: 'no download URL found in message body' });
      continue;
    }
    try {
      const filename = downloadUrl.split('/').pop();
      const buffer = await fetchReportFile(downloadUrl);
      results.push({ messageId, buffer, filename });
    } catch (err) {
      results.push({ messageId, error: err.message });
    }
  }
  return results;
}

/**
 * Finds every not-yet-processed "All Jobs" report email and downloads its attached .xlsx directly
 * (no link to follow — see this file's header comment) via the Gmail attachments API. Same
 * mark-processed-only-after-success contract as findUnprocessedBookedOpportunityFiles above.
 * @returns {Promise<Array<{messageId: string, buffer: Buffer, filename: string} | {messageId: string, skipped: true, reason: string} | {messageId: string, error: string}>>}
 */
async function findUnprocessedAllJobsFiles() {
  const auth = getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });

  const { data: listData } = await gmail.users.messages.list({
    userId: 'me',
    q: `${SEARCH_QUERY_ALL_JOBS} -label:${LABEL_NAME.replace('/', '-')}`,
  });
  const messageIds = (listData.messages || []).map((m) => m.id);

  const { fetched, results: fetchErrors } = await fetchAndSortByDate(gmail, messageIds);
  const results = [...fetchErrors];
  for (const { messageId, message } of fetched) {
    try {
      const attachment = extractXlsxAttachmentPart(message);
      if (!attachment) {
        results.push({ messageId, skipped: true, reason: 'no .xlsx attachment found on message' });
        continue;
      }
      // See SEARCH_QUERY_ALL_JOBS's comment: the Gmail search alone can match a Sigma email that
      // isn't actually the All Jobs report (any other Sigma-delivered report sharing this inbox's
      // generic "SmartMoving Report is Ready" subject) — this is the real report-identity check,
      // against the attachment's own filename rather than delivery-template subject text.
      if (!ALL_JOBS_FILENAME_PATTERN.test(attachment.filename)) {
        results.push({
          messageId, skipped: true,
          reason: `attachment "${attachment.filename}" doesn't look like an All Jobs report — likely a different Sigma-delivered report sharing this inbox`,
        });
        continue;
      }
      const buffer = await fetchAttachmentBuffer(gmail, messageId, attachment.attachmentId);
      results.push({ messageId, buffer, filename: attachment.filename });
    } catch (err) {
      results.push({ messageId, error: err.message });
    }
  }
  return results;
}

/** Marks a message processed once its file has been successfully ingested — see the doc comments
 * above for why this is a separate step, not automatic. Works the same regardless of which of the
 * two reports the message was — both share LABEL_NAME.
 *
 * Added 2026-09-04 (user request, "can we delete the mail once it is processed"): also moves the
 * message to Gmail's Trash, where it sits recoverable for ~30 days before Gmail auto-purges it —
 * deliberately NOT a permanent delete (messages.delete), which is one-way immediately and needs a
 * broader scope than this app has ever requested (see SCOPES's comment above). The label is still
 * applied FIRST and kept even after trashing: it's what findUnprocessedBookedOpportunityFiles()/
 * findUnprocessedAllJobsFiles() use to skip already-handled mail, and Gmail's default search already
 * excludes Trash — but if the user manually recovers a message from Trash before the 30 days are up,
 * the label is what stops it from being read as a brand-new report and reprocessed a second time.
 * Trashing runs after labeling, not before, so a failure here (network blip, etc.) still leaves the
 * message correctly labeled — worst case it just lingers in the inbox instead of moving to Trash,
 * never double-processed. */
async function markMessageProcessed(messageId) {
  const auth = getAuthenticatedClient();
  const gmail = google.gmail({ version: 'v1', auth });
  const labelId = await getOrCreateLabelId(gmail);
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [labelId] } });
  await gmail.users.messages.trash({ userId: 'me', id: messageId });
}

module.exports = {
  getOAuth2Client, getAuthenticatedClient,
  findUnprocessedBookedOpportunityFiles, findUnprocessedAllJobsFiles,
  markMessageProcessed, SCOPES, LABEL_NAME,
  // Exported 2026-08-31 for debug-job-lookup.js — these were previously module-private, but a
  // diagnostic that traces one specific job through the pipeline needs to fetch/parse a report
  // email regardless of whether it's already been marked processed (findUnprocessed*Files() above
  // deliberately excludes those), so it has to call the same lower-level pieces the production
  // path uses instead of duplicating this logic. Pure/no side effects — exporting them doesn't
  // change any existing behavior.
  extractDownloadUrl, fetchReportFile, extractXlsxAttachmentPart, fetchAttachmentBuffer,
  fetchAndSortByDate, SEARCH_QUERY_BOOKED_OPPORTUNITIES, SEARCH_QUERY_ALL_JOBS,
  // Exported 2026-08-31 alongside the SEARCH_QUERY_ALL_JOBS fix (see its comment) — the diagnostic
  // scripts' "newest, regardless of already-processed" fallback paths call extractXlsxAttachmentPart
  // directly rather than through findUnprocessedAllJobsFiles(), so they need this same filename
  // check to avoid mistaking some other Sigma-delivered report for the All Jobs one.
  ALL_JOBS_FILENAME_PATTERN,
};
