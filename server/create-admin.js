/**
 * One-off CLI for granting (or changing the role of) a login account from the terminal — no server
 * restart needed. There's no password to set: this app signs everyone in with their real Around
 * Town Movers Microsoft 365 account, so this script just decides who's *allowed* to, and with what
 * role. Useful for the very first admin, adding a second admin, or granting access without going
 * through the Users panel in the UI.
 *
 * Usage:
 *   node create-admin.js <email> [role]
 *
 * role defaults to "admin" (hence the filename) but accepts admin | dispatcher | crew. If the
 * email already has an account, this updates its role instead of failing.
 *
 * Examples:
 *   node create-admin.js csr4@aroundtownmovers.com
 *   node create-admin.js jsmith@aroundtownmovers.com dispatcher
 */

const db = require('./db');
const auth = require('./auth');

function nextId(rows, prefix) {
  const nums = rows.map(r => parseInt(String(r.id).replace(prefix, ''), 10)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return prefix + (max + 1);
}

const [, , rawEmail, rawRole] = process.argv;

if (!rawEmail) {
  console.error('Usage: node create-admin.js <email> [admin|dispatcher|crew]');
  process.exit(1);
}

const email = auth.normalizeEmail(rawEmail);
const role = ['admin', 'dispatcher', 'crew'].includes(rawRole) ? rawRole : 'admin';

if (!auth.isCompanyEmail(email)) {
  console.error(`"${rawEmail}" is not a @${auth.EMAIL_DOMAIN} address — refusing to grant it access.`);
  process.exit(1);
}

const existing = db.getUserByEmail(email);

if (existing) {
  db.updateUserRole(existing.id, role);
  console.log(`Updated ${email} — role set to "${role}". They sign in with Microsoft using this address.`);
} else {
  const id = nextId(db.listUsers(), 'U');
  db.createUser({ id, email, role });
  console.log(`Granted ${email} access with role "${role}". They sign in with Microsoft using this address.`);
}
