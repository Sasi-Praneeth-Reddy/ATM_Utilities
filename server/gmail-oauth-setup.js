#!/usr/bin/env node
/**
 * ONE-TIME LOCAL SETUP — run this on your own machine, not on the deployed server.
 *
 * Produces the GMAIL_OAUTH_REFRESH_TOKEN needed by server/smartInsightsGmail.js (the Smart Insights
 * report pipeline's Gmail access). This can't run on Firebase/Cloud Functions itself: it needs a
 * real browser to complete Google's consent screen, and a local port to catch the redirect — a
 * deployed backend has neither. Run it once, and the resulting refresh token is reused indefinitely
 * after that (see server/smartInsightsGmail.js's file header).
 *
 * Prerequisites (see server/local.secrets's own header comment for why it's THIS file, not
 * server/.env):
 *   1. A Google Cloud project with the Gmail API enabled.
 *   2. An OAuth 2.0 Client ID of type "Desktop app" (Cloud Console -> APIs & Services ->
 *      Credentials -> Create Credentials -> OAuth client ID). Copy its Client ID and Client secret.
 *   3. GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET set in server/local.secrets (or exported
 *      in your shell) before running this script — NEVER in server/.env, see below.
 *
 * Usage:
 *   cd server
 *   npm run gmail-auth
 *
 * This opens a URL for you to visit (or prints it — copy/paste into any browser where you're
 * signed into the Gmail account that RECEIVES the SmartMoving report emails). After you approve
 * access, Google redirects back to a tiny local server this script starts on
 * http://localhost:53682/oauth2callback, which exchanges the resulting code for tokens and prints
 * the refresh token to your terminal. Paste that into server/local.secrets as
 * GMAIL_OAUTH_REFRESH_TOKEN — NOT server/.env, which Firebase auto-loads as plain env vars at
 * deploy time and would collide with the same name being declared as a real secret in
 * functions-index.js ("Secret environment variable overlaps non secret environment variable").
 * Then also update it as a Firebase secret for the deployed function — see below.
 */
require('./load-env');
const http = require('http');
const { URL } = require('url');
const { getOAuth2Client, SCOPES } = require('./smartInsightsGmail');

const PORT = 53682;

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

  console.log('\nSuccess. Add this to server/local.secrets (NOT server/.env — see that file\'s header comment):\n');
  console.log(`GMAIL_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log(
    'For the deployed Cloud Function, also update it as a Firebase secret (from the server/ directory):\n' +
    '  firebase functions:secrets:set GMAIL_OAUTH_REFRESH_TOKEN\n' +
    '(paste the same value when prompted) — GMAIL_OAUTH_CLIENT_ID/SECRET are unchanged, no need to ' +
    're-set those unless they changed too. Then redeploy.\n'
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
