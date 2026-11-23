/**
 * node scripts/copy-config-to-ssm.js --service-account <path-to-firebase-key.json> [--prefix /atm/prod/] [--region us-east-1] [--dry-run]
 *
 * Copies the backend's configuration from Firebase into AWS SSM Parameter Store, where lambda.js reads it:
 *  - every Firebase secret (read with "firebase functions:secrets:access", needs "firebase login") -> SecureString
 *  - plain settings from server/.env.atm-scheduler -> String
 *  - FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON (from the key file you pass) so the Lambda can reach
 *    Firestore, which stays on Google -> SecureString
 * Values are never printed. Uses your normal AWS credentials (aws configure / SSO).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const DRY = args.includes('--dry-run');
const PREFIX = (opt('--prefix', '/atm/prod/')).replace(/\/?$/, '/');
const REGION = opt('--region', process.env.AWS_REGION || 'us-east-1');
const KEY_FILE = opt('--service-account');
const PROJECT = opt('--project', 'atm-scheduler');

// Same list as ALL_SECRETS in functions-index.js (the two ATM_AWS_* keys are not needed: Lambda uses its IAM role).
const SECRETS = ['SESSION_SECRET', 'SMTP_PASS', 'SMARTMOVING_API_KEY', 'WEBHOOK_SECRET', 'SCRAPER_API_KEY', 'GITHUB_DISPATCH_TOKEN',
  'SMARTMOVING_ICAL_URL', 'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REFRESH_TOKEN'];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function firebaseSecret(name) {
  const r = spawnSync('firebase', ['functions:secrets:access', name, '--project', PROJECT], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\r?\n$/, '');
}

(async () => {
  if (!KEY_FILE) { console.error('Pass --service-account <path to the Firebase service account key .json>'); process.exit(1); }
  const keyJson = JSON.stringify(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'))); // one line
  const items = []; // { name, value, secure }
  const missing = [];
  for (const name of SECRETS) {
    const v = firebaseSecret(name);
    if (v === null || v === '') missing.push(name); else items.push({ name, value: v, secure: true });
  }
  const envFile = path.resolve(__dirname, '..', '.env.atm-scheduler');
  const plain = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  for (const [k, v] of Object.entries(plain)) {
    if (SECRETS.includes(k) || /^(ATM_AWS_|FIREBASE_SERVICE_ACCOUNT_JSON|GOOGLE_APPLICATION_CREDENTIALS|FIRESTORE_EMULATOR_HOST|DEV_BYPASS_LOGIN|USE_LOCAL_FIREBASE_KEY|PORT)/.test(k)) continue;
    if (v !== '') items.push({ name: k, value: v, secure: false });
  }
  if (!items.some((i) => i.name === 'FIREBASE_PROJECT_ID')) items.push({ name: 'FIREBASE_PROJECT_ID', value: PROJECT, secure: false });
  items.push({ name: 'FIREBASE_SERVICE_ACCOUNT_JSON', value: keyJson, secure: true });
  if (!items.some((i) => i.name === 'COOKIE_SECURE')) items.push({ name: 'COOKIE_SECURE', value: 'true', secure: false });

  console.log(`${DRY ? 'DRY RUN - would write' : 'Writing'} ${items.length} parameters under ${PREFIX} (${REGION}):`);
  for (const i of items) console.log(`  ${i.secure ? 'SecureString' : 'String      '}  ${i.name}  (${i.value.length} chars)`);
  if (missing.length) console.log(`\nNOT FOUND in Firebase (skipped): ${missing.join(', ')}`);
  if (DRY) return;

  const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ region: REGION });
  for (const i of items) {
    await ssm.send(new PutParameterCommand({ Name: PREFIX + i.name, Value: i.value, Type: i.secure ? 'SecureString' : 'String', Overwrite: true }));
  }
  console.log('\nDone. Re-run any time a value changes (it overwrites).');
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
