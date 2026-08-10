/**
 * Auth primitives — Microsoft (Entra ID) sign-in, session tokens, cookie parsing, and the company-
 * email domain check. Built on Node's built-in `crypto`/`fetch` only (no `msal`/`jsonwebtoken`/
 * etc.), matching this backend's zero-npm-dependency approach everywhere else.
 *
 * There are no passwords anywhere in this app — every account signs in with their real Around Town
 * Movers Microsoft 365 account. The OAuth "authorization code" exchange happens server-to-server
 * (this backend <-> Microsoft's token endpoint, authenticated with a client secret), so the ID
 * token we get back is trusted without doing full JWKS signature verification — but see
 * `validateMicrosoftIdToken` for the claim checks done anyway as defense in depth.
 *
 * Sessions: a small HMAC-SHA256-signed token (same idea as a JWT, hand-rolled) carried in an
 * httpOnly cookie — stateless, so restarting the server doesn't need a sessions table, but it does
 * mean every session is invalidated if SESSION_SECRET changes (including an auto-generated one
 * regenerating on restart — see the warning server.js logs if you haven't set one). The same
 * signing scheme also protects the OAuth `state` parameter against CSRF, without needing anywhere
 * to store it server-side.
 */

const crypto = require('crypto');

const EMAIL_DOMAIN = 'aroundtownmovers.com';
const COOKIE_NAME = 'atm_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — just needs to outlive the Microsoft login screen

function isCompanyEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return email.trim().toLowerCase().endsWith('@' + EMAIL_DOMAIN);
}

function normalizeEmail(email) {
  return (email || '').trim().toLowerCase();
}

/* ---------- Signing (shared by session tokens and OAuth state) ---------- */
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

/* ---------- Microsoft (Entra ID) OAuth ----------
   Standard OAuth 2.0 authorization code flow, tenant-restricted: the authorize URL is scoped to
   your specific tenant (not the generic "common"/"organizations" endpoints), so Microsoft itself
   refuses to let anyone outside your Around Town Movers tenant even reach the point of granting an
   authorization code — the email-domain check in server.js is a second layer on top of that, not
   the only line of defense. */

function createOAuthState(secret) {
  return sign({ nonce: crypto.randomBytes(16).toString('hex'), exp: Date.now() + OAUTH_STATE_TTL_MS }, secret);
}

function verifyOAuthState(state, secret) {
  return verify(state, secret);
}

function buildMicrosoftAuthorizeUrl({ tenantId, clientId, redirectUri, state }) {
  const url = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeMicrosoftCode({ tenantId, clientId, clientSecret, redirectUri, code }) {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      scope: 'openid profile email',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Microsoft token exchange failed');
  }
  return data; // { access_token, id_token, ... }
}

function decodeJwtPayload(jwt) {
  const parts = (jwt || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

/** Checks the claims we can verify without doing full JWKS signature verification — reasonable
    here since the token came directly from Microsoft's token endpoint in response to our own
    client-secret-authenticated request, not handed to us by the browser. Still checked as defense
    in depth against a misconfigured client or a substituted token. */
function validateMicrosoftIdToken(claims, { clientId, tenantId }) {
  if (claims.aud !== clientId) throw new Error('Token audience mismatch');
  if (claims.tid !== tenantId) throw new Error('Token tenant mismatch');
  if (!claims.exp || Date.now() / 1000 > claims.exp) throw new Error('Token expired');
  if (!(claims.iss || '').includes(tenantId)) throw new Error('Token issuer mismatch');
  return claims;
}

module.exports = {
  EMAIL_DOMAIN, COOKIE_NAME,
  isCompanyEmail, normalizeEmail,
  createSessionToken, verifySessionToken,
  parseCookies, sessionCookieHeader, clearSessionCookieHeader,
  createOAuthState, verifyOAuthState,
  buildMicrosoftAuthorizeUrl, exchangeMicrosoftCode, decodeJwtPayload, validateMicrosoftIdToken,
};
