/**
 * Minimal .env loader shared by every entry point in this backend (server.js, create-admin.js,
 * any future CLI script). Kept dependency-free on purpose — see server/README.md.
 *
 * Values already set in the real environment (e.g. by your hosting platform, or exported in your
 * shell) are left untouched; only keys missing from process.env get filled in from .env.
 *
 * This used to live only inline in server.js — create-admin.js didn't load .env at all, so a
 * value that's only set in .env (like a custom SQLITE_PATH) would silently be invisible to the CLI
 * script, which would then read/write a different database file than the running server. Pulling
 * this out so every script sees the same config.
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) return;
    const key = match[1];
    let value = (match[2] || '').trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  });
}

loadDotEnv();

module.exports = { loadDotEnv };
