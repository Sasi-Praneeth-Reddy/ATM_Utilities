/**
 * One-off CLI for granting (or changing the role/password of) a login account from the terminal —
 * no server restart needed. Useful for the very first admin, adding a second admin, recovering
 * access if email sending isn't configured yet, or granting access without going through the Users
 * panel in the UI.
 *
 * Usage:
 *   node create-admin.js <email> [role] [password]
 *
 * role defaults to "admin" (hence the filename) but accepts owner | developer | admin | dispatcher | crew. password is
 * optional — if omitted, the account is created (or left) with no password, and whoever owns that
 * email needs to use "Forgot password?" on the login screen to set one (requires email sending to
 * be configured — see server/README.md). If the email already has an account, this updates its
 * role (and password, if one is given) instead of failing.
 *
 * Examples:
 *   node create-admin.js csr4@aroundtownmovers.com
 *   node create-admin.js jsmith@aroundtownmovers.com dispatcher
 *   node create-admin.js csr4@aroundtownmovers.com admin "a strong temp password"
 *   node create-admin.js someone@aroundtownmovers.com owner
 *   node create-admin.js someone@aroundtownmovers.com developer
 */

require('./load-env');
const db = require('./db');
const auth = require('./auth');

function nextId(rows, prefix) {
  const nums = rows.map(r => parseInt(String(r.id).replace(prefix, ''), 10)).filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return prefix + (max + 1);
}

async function main() {
  const [, , rawEmail, rawRole, rawPassword] = process.argv;

  if (!rawEmail) {
    console.error('Usage: node create-admin.js <email> [owner|developer|admin|dispatcher|crew] [password]');
    process.exit(1);
  }

  const email = auth.normalizeEmail(rawEmail);
  const role = ['owner', 'developer', 'admin', 'dispatcher', 'crew'].includes(rawRole) ? rawRole : 'admin';

  if (!auth.isCompanyEmail(email)) {
    console.error(`"${rawEmail}" is not a @${auth.EMAIL_DOMAIN} address — refusing to grant it access.`);
    process.exit(1);
  }

  if (rawPassword !== undefined && rawPassword.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const existing = await db.getUserByEmail(email);
  const passwordSuffix = rawPassword ? ' with the password you gave' : ' — no password set yet, use "Forgot password?" on the login screen to set one';

  if (existing) {
    await db.updateUserRole(existing.id, role);
    if (rawPassword) await db.setUserPassword(existing.id, auth.hashPassword(rawPassword));
    console.log(`Updated ${email} — role set to "${role}"${passwordSuffix}.`);
  } else {
    const id = nextId(await db.listUsers(), 'U');
    const passwordHash = rawPassword ? auth.hashPassword(rawPassword) : undefined;
    await db.createUser({ id, email, role, passwordHash });
    console.log(`Granted ${email} access with role "${role}"${passwordSuffix}.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
