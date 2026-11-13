/**
 * node scripts/build-lambda.js
 * Stages the backend for AWS Lambda into <repo>/build/lambda: the server source (no tests, debug or one-off
 * scripts, no .env files - configuration comes from SSM) plus production-only node_modules installed for
 * Linux x64 (the Lambda platform), then reports the unzipped size (Lambda's limit is 250 MB).
 * Deploy it with aws/atm-compute.template.yaml (see docs/AWS-COMPUTE.md).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SERVER = path.resolve(__dirname, '..');
const OUT = path.resolve(SERVER, '..', 'build', 'lambda');
const SKIP_FILE = /^(test-|debug-|mock-|migrate-|create-admin|replace-trucks|apply-truck|check-|cleanup-|gmail-oauth-setup|functions-index)/;
const DIRS = ['leads', 'storage'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let copied = 0;
for (const f of fs.readdirSync(SERVER)) {
  if (f.endsWith('.js') && !SKIP_FILE.test(f)) { fs.copyFileSync(path.join(SERVER, f), path.join(OUT, f)); copied++; }
}
for (const d of DIRS) {
  fs.cpSync(path.join(SERVER, d), path.join(OUT, d), {
    recursive: true,
    filter: (src) => !/(^|[\\/])(migrate-|update-lead-dates)/.test(path.basename(src)),
  });
}
for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(SERVER, f), path.join(OUT, f));
console.log(`Copied ${copied} server files + ${DIRS.join(', ')}.`);

// The module that starts everything must exist.
for (const must of ['lambda.js', 'server.js', 'firestore.js', 'awsStore.js']) {
  if (!fs.existsSync(path.join(OUT, must))) { console.error(`Missing ${must} in the bundle.`); process.exit(1); }
}

console.log('Installing production dependencies for Linux x64 (this can take a minute)...');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['ci', '--omit=dev', '--os=linux', '--cpu=x64', '--no-audit', '--no-fund'], { cwd: OUT, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) { console.error('npm ci failed. If it says package.json and package-lock.json are out of sync, run "npm install" in server/ first.'); process.exit(r.status || 1); }

function dirSize(p) { let n = 0; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size; } return n; }
const mb = dirSize(OUT) / 1048576;
console.log(`Bundle: ${OUT}  (${mb.toFixed(0)} MB unzipped; Lambda limit 250 MB)`);
if (mb > 240) { console.error('Too close to the Lambda size limit - tell Claude, the bundle needs trimming or a container image.'); process.exit(1); }
