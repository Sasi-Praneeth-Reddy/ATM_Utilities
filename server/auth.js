/**
 * Auth primitives — email+password sign-in, OTP-based password reset, session tokens, cookie
 * parsing, and the company-email domain check. Built on Node's built-in `crypto`/`fetch` only (no
 * `bcrypt`/`jsonwebtoken`/etc.), matching this backend's zero-npm-dependency approach everywhere
 * else.
 *
 * Passwords are hashed with `crypto.scryptSync` (built into Node, no npm package needed) — a
 * random salt per password, stored alongside the hash as `salt:hash` in one column. There is no
 * "forgot password" secret question or admin-set temp password: a locked-out user (or a brand new
 * account with no password yet) requests a one-time 6-digit code emailed to their address, and
 * that code — combined with knowing the account's email — is what authorizes setting a new
 * password. See `generateOtp`/`hashOtp`/`verifyOtp` below and server.js's
 * `/api/auth/forgot-password` and `/api/auth/reset-password` routes.
 *
 * Sessions: a small HMAC-SHA256-signed token (same idea as a JWT, hand-rolled) carried in an
 * httpOnly cookie — stateless, so restarting the server doesn't need a sessions table, but it does
 * mean every session is invalidated if SESSION_SECRET changes (including an auto-generated one
 * regenerating on restart — see the warning server.js logs if you haven't set one). The same
 * signing scheme (via `hashOtp`, an HMAC keyed on SESSION_SECRET) is what turns a 6-digit OTP into
 * something safe to store in the database — never the raw code.
 */

const crypto = require('crypto');

const EMAIL_DOMAIN = 'aroundtownmovers.com';
const COOKIE_NAME = 'atm_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to check email, short enough to limit guessing
const SCRYPT_KEYLEN = 64;

function isCompanyEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return email.trim().toLowerCase().endsWith('@' + EMAIL_DOMAIN);
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

/* ---------- Signing (used by session tokens) ---------- */
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadObj, secret) {
  const payload = base64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ---------- Session tokens ---------- */
// Deliberately carries only the user id + expiry, not email/role — those are looked up fresh from
// the database on every request instead. That way, if an admin changes someone's role (or deletes
// their account), it takes effect on their very next request instead of waiting up to 7 days for
// their existing token to expire.
function createSessionToken(user, secret) {
  return sign({ sub: user.id, exp: Date.now() + SESSION_TTL_MS }, secret);
}

function verifySessionToken(token, secret) {
  return verify(token, secret);
}

/* ---------- Cookies ---------- */
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function sessionCookieHeader(token, secure) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function clearSessionCookieHeader(secure) {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
}

/* ---------- Passwords ----------
   `crypto.scryptSync` is deliberately synchronous — every call here happens inside a single HTTP
   request handler in server.js with nothing else in flight for that request, so there's no event-
   loop-blocking concern that would justify the added complexity of the async variant. Stored as
   `salt:hash` (both hex) in one TEXT column — no separate salt column needed. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/** Constant-time compare (via `timingSafeEqual`) so a mistyped password can't be distinguished by
    response-time from a correct one that just happens to differ in a later byte. Returns false
    (rather than throwing) for a missing/malformed stored value — covers brand-new accounts that
    have no password set yet, which should behave like "wrong password", not crash the request. */
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hashHex] = stored.split(':');
  let hashBuf, candidateBuf;
  try {
    hashBuf = Buffer.from(hashHex, 'hex');
    candidateBuf = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  return hashBuf.length === candidateBuf.length && crypto.timingSafeEqual(hashBuf, candidateBuf);
}

/* ---------- One-time passcodes (password reset / first-time password setup) ----------
   A 6-digit numeric code is short enough to type from an email on a phone, and long enough (1 in a
   million per guess) to be safe given the 10-minute expiry and that each request overwrites any
   previous code (so there's never more than one valid code per account, and no way to "stack up"
   guesses across multiple outstanding codes). Only the HMAC of the code is ever stored — see
   `hashOtp` — so a database read alone can't recover a usable code. */
function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Keyed on the same SESSION_SECRET used for session tokens — reusing it here (rather than storing
    OTPs in plaintext, or adding a second secret to configure) is safe because an HMAC key is fine
    to use for more than one purpose as long as the *inputs* are domain-separated, which they are
    here (a 6-digit code vs. a JSON session payload look nothing alike to an attacker trying to
    reuse one context against the other). */
function hashOtp(code, secret) {
  return crypto.createHmac('sha256', secret).update(String(code)).digest('hex');
}

function verifyOtp(code, storedHash, secret) {
  if (!storedHash) return false;
  const expected = hashOtp(code, secret);
  const expectedBuf = Buffer.from(expected);
  const storedBuf = Buffer.from(storedHash);
  return expectedBuf.length === storedBuf.length && crypto.timingSafeEqual(expectedBuf, storedBuf);
}

module.exports = {
  EMAIL_DOMAIN, COOKIE_NAME, OTP_TTL_MS,
  isCompanyEmail, normalizeEmail,
  createSessionToken, verifySessionToken,
  parseCookies, sessionCookieHeader, clearSessionCookieHeader,
  hashPassword, verifyPassword,
  generateOtp, hashOtp, verifyOtp,
};
