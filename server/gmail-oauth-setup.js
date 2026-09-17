#!/usr/bin/env node
/**
 * ONE-TIME LOCAL SETUP (well — every ~7 days, until the OAuth app leaves Google's "Testing"
 * publishing status; see smartInsightsGmail.js's file header) — run this on your own machine, not
 * on the deployed server.
 *
 * Produces a fresh GMAIL_OAUTH_REFRESH_TOKEN for server/smartInsightsGmail.js (the Smart Insights
 * report pipeline AND the Google Calendar sync both share this one grant). This can't run on
 * Firebase/Cloud Functions itself: it needs a real browser to complete Google's consent screen, and
 * a local port to catch the redirect — a deployed backend has neither.
 *
 * Automated as of 2026-09-08 (previously: this script only printed the new token, and you had to
 * copy/paste it into server/local.secrets AND into the `firebase functions:secrets:set` prompt by
 * hand, twice, every single re-auth). Now, once you approve the consent screen, this script:
 *   1. Writes the new token straight into server/local.secrets (adds or replaces the
 *      GMAIL_OAUTH_REFRESH_TOKEN= line) — no copy/paste.
 *   2. Pushes it to the Firebase secret (`firebase functions:secrets:set`) via the Firebase CLI,
 *      feeding it the value directly instead of you pasting it into that prompt — see
 *      pushFirebaseSecret() below for what this needs (Firebase CLI installed + `firebase login`
 *      already done, same as you need for `firebase deploy` anyway).
 *   3. Records the refresh timestamp in Firestore (db.setGmailAuthRefreshed) so the board's
 *      "Gmail authorization" countdown (SyncPanel, via GET /api/gmail-auth-status) knows a fresh
 *      7-day window just started — needs its own Firestore Admin credential, see below.
 * Step 2 does NOT redeploy the running function for you — see this script's final printed message
 * for why that's still a separate, deliberate step.
 *
 * Prerequisites (see server/local.secrets's own header comment for why it's THIS file, not
 * server/.env):
 *   1. A Google Cloud project with the Gmail API enabled.
 *   2. An OAuth 2.0 Client ID of type "Desktop app" (Cloud Console -> APIs & Services ->
 *      Credentials -> Create Credentials -> OAuth client ID). Copy its Client ID and Client secret.
 *   3. GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET set in server/local.secrets (or exported
 *      in your shell) before running this script — NEVER in server/.env, see below.
 *   4. The Firebase CLI installed and already logged in (`firebase login`) — for step 2 above.
 *   5. GOOGLE_APPLICATION_CREDENTIALS pointed at a Firestore Admin service-account key for this
 *      run, for step 3 above — same pattern test-ical-sync.js/cleanup-stale-smart-insights-jobs.js
 *      already use, set per-command, NEVER added to local.secrets/.env (see this repo's standing
 *      rule on that — a value there gets auto-loaded into every server process unconditionally,
 *      which this credential should never be). If it's not set, this script still finishes the
 *      token refresh — it just skips recording the timestamp and tells you so, rather than failing
 *      the whole run over a "nice to have."
 *
 * Usage (PowerShell example — see prerequisite 5 above for why the env var is set per-command):
 *   cd server
 *   $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; npm run gmail-auth
 *
 * This opens a URL for you to visit (or prints it — copy/paste into any browser where you're
 * signed into the Gmail account that RECEIVES the SmartMoving report emails). After you approve
 * access, Google redirects back to a tiny local server this script starts on
 * http://localhost:53682/oauth2callback, which exchanges the resulting code for tokens and takes
 * it from there — see the three steps above.
 */
require('./load-env');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');
const { URL } = require('url');
const { getOAuth2Client, SCOPES } = require('./smartInsightsGmail');

const PORT = 53682;
const LOCAL_SECRETS_PATH = path.join(__dirname, 'local.secrets');

/** Adds or replaces the GMAIL_OAUTH_REFRESH_TOKEN= line in server/local.secrets, leaving every
 * other line (GMAIL_OAUTH_CLIENT_ID/SECRET, SESSION_SECRET, etc.) untouched. Creates the file if it
 * somehow doesn't exist yet (fresh checkout). Mirrors load-env.js's own KEY=value parsing so the
 * line this writes is guaranteed to be read back the same way. */
function writeRefreshTokenToLocalSecrets(token) {
  const existing = fs.existsSync(LOCAL_SECRETS_PATH) ? fs.readFileSync(LOCAL_SECRETS_PATH, 'utf8') : '';
  const lines = existing.length ? existing.split('\n') : [];
  const lineIndex = lines.findIndex((line) => /^\s*GMAIL_OAUTH_REFRESH_TOKEN\s*=/.test(line));
  const newLine = `GMAIL_OAUTH_REFRESH_TOKEN=${token}`;
  if (lineIndex === -1) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push(''); // keep a blank separator if the file didn't already end with one
    lines.push(newLine);
  } else {
    lines[lineIndex] = newLine;
  }
  fs.writeFileSync(LOCAL_SECRETS_PATH, lines.join('\n'));
}

/** Pushes the new token to the Firebase secret via the CLI instead of you pasting it into the
 * interactive prompt yourself. `firebase functions:secrets:set NAME` reads the value from stdin
 * when it's piped rather than a real terminal, so writing the token there once and closing stdin
 * does the same thing typing-then-Enter would. If the CLI then also asks (as it sometimes does)
 * whether to immediately redeploy the functions using this secret, closing stdin here answers that
 * "no" by default — this script deliberately never redeploys on its own (see this repo's standing
 * "never deploy without being asked" rule); the final printed message tells you to do that
 * yourself. Returns true on success; on any failure (CLI not installed, not logged in, etc.) prints
 * what happened and returns false so the caller can fall back to telling you to run it by hand —
 * this step failing should never lose the token itself, which is already safely in local.secrets by
 * the time this runs.
 *
 * `shell: true` on Windows only (confirmed needed 2026-09-08, first real run of this automation):
 * an npm-installed CLI like `firebase` is a `.cmd` wrapper script on Windows, not a real .exe —
 * execFileSync's default (no shell) launches a process directly via Windows' CreateProcess, which
 * doesn't know how to run a .cmd file the way typing `firebase` at a prompt does, and fails with
 * ENOENT even though `firebase` is genuinely installed and on PATH. Routing through a shell makes
 * command resolution work the same way it does when you type it yourself. Left off on
 * macOS/Linux, where `firebase` is normally a real executable/shebang script and this was already
 * working — no reason to change behavior that wasn't broken there. Safe either way: the only
 * things reaching the shell here are the two hardcoded literal args below, never the token itself
 * (that's passed via stdin, not argv), so there's nothing for a token containing shell-special
 * characters to inject. */
function pushFirebaseSecret(token) {
  try {
    execFileSync('firebase', ['functions:secrets:set', 'GMAIL_OAUTH_REFRESH_TOKEN'], {
      input: token,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    return true;
  } catch (err) {
    console.error(`\nCouldn't push the new token to the Firebase secret automatically (${err.message}).`);
    console.error('Run this yourself instead (paste the token from server/local.secrets when prompted):');
    console.error('  firebase functions:secrets:set GMAIL_OAUTH_REFRESH_TOKEN\n');
    return false;
  }
}

/** Records the refresh timestamp in Firestore for the board's countdown (see this file's header,
 * prerequisite 5) — best-effort: a missing/invalid Firestore Admin credential here shouldn't fail
 * the whole re-auth, since the token itself is already safely saved by this point regardless. */
async function recordRefreshedInFirestore() {
  try {
    const db = require('./db');
    await db.setGmailAuthRefreshed(new Date().toISOString());
    return true;
  } catch (err) {
    console.error(`\nCouldn't record this re-auth in Firestore (${err.message}).`);
    console.error('The board\'s "Gmail authorization" countdown won\'t reflect today\'s refresh until this is set —');
    console.error('see this file\'s header comment (prerequisite 5) for GOOGLE_APPLICATION_CREDENTIALS.\n');
    return false;
  }
}

async function main() {
  let oauth2Client;
  try {
    oauth2Client = getOAuth2Client();
  } catch (err) {
    console.error(`\n${err.message}\n`);
    console.error('Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in server/local.secrets first (NOT .env) — see .env.example.');
    process.exit(1);
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // required to get a refresh_token back, not just an access_token
    prompt: 'consent', // forces the consent screen every time, so a refresh_token is issued even if
                        // this Google account has authorized this same client before
    scope: SCOPES,
  });

  console.log('\n1. Open this URL in a browser (sign in as the Gmail account that receives the SmartMoving report emails):\n');
  console.log(`   ${authUrl}\n`);
  console.log(`2. Approve access. This script is waiting on http://localhost:${PORT} for the redirect...\n`);

  const code = await waitForAuthCode();

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      '\nNo refresh token came back. This usually means this Google account already granted this ' +
      'exact OAuth client consent before, without a fresh "prompt=consent" — Google only issues a ' +
      'new refresh token then. Fix: revoke this app\'s access at ' +
      'https://myaccount.google.com/permissions and run this script again.\n'
    );
    process.exit(1);
  }
  const token = tokens.refresh_token;

  console.log('\nNew refresh token received. Finishing up automatically — no copy/paste needed:\n');

  writeRefreshTokenToLocalSecrets(token);
  console.log('  [x] server/local.secrets updated');

  const secretPushed = pushFirebaseSecret(token);
  if (secretPushed) console.log('  [x] Firebase secret GMAIL_OAUTH_REFRESH_TOKEN updated');

  const recorded = await recordRefreshedInFirestore();
  if (recorded) console.log('  [x] Re-auth timestamp recorded (board countdown will reflect this)');

  const nextDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  console.log(
    `\nOne step left: the deployed function still has the OLD token loaded — Firebase pins a secret's ` +
    `value at DEPLOY time, it doesn't pick up a new version on its own. Run:\n\n` +
    `  firebase deploy --only functions\n\n` +
    `to actually put this new token into use. After that, the next re-auth is due by ${nextDue} ` +
    `(Google's 7-day Testing-mode limit) — the board will start warning you as that date gets close.\n`
  );
  process.exit(0);
}

function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
      if (reqUrl.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const code = reqUrl.searchParams.get('code');
      const error = reqUrl.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        error
          ? `<h2>Authorization failed: ${error}</h2><p>You can close this tab and check the terminal.</p>`
          : '<h2>Authorized.</h2><p>You can close this tab and go back to the terminal.</p>'
      );
      server.close();
      if (error) reject(new Error(`Google returned an error: ${error}`));
      else if (!code) reject(new Error('No authorization code in the redirect.'));
      else resolve(code);
    });
    server.listen(PORT);
  });
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
