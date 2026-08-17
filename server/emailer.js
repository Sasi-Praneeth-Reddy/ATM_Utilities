/**
 * Sends the password-reset/first-time-setup OTP by email via SMTP, using an existing mailbox
 * instead of a third-party transactional email service — no domain verification, no DNS records to
 * add. This is the one deliberate exception to this backend's otherwise zero-npm-dependency
 * approach: hand-rolling a correct SMTP client (TLS negotiation, multi-line response parsing, AUTH
 * LOGIN/PLAIN, provider quirks) for a security-sensitive flow like password reset is a lot of
 * surface area to get subtly wrong, so this uses `nodemailer` (a small, well-tested,
 * dependency-free-itself package) rather than writing that by hand. See server/README.md
 * "Login & accounts" → "One-time setup: email delivery."
 *
 * Needs SMTP_HOST, SMTP_USER, and SMTP_PASS set in server/.env — see .env.example. Defaults are
 * tuned for Gmail (`smtp.gmail.com:465`, an app password as SMTP_PASS) — a personal/free Gmail
 * account, chosen as the default over a Microsoft 365 mailbox because Gmail app passwords are
 * entirely self-service (just needs 2-Step Verification turned on), whereas many Microsoft 365
 * tenants have SMTP AUTH disabled organization-wide and need a tenant admin to re-enable it per
 * mailbox before this works at all — confirmed the hard way against aroundtownmovers.com's tenant
 * (`535 5.7.139 ... SmtpClientAuthentication is disabled for the Tenant`). Override
 * SMTP_HOST/SMTP_PORT to use Microsoft 365 (`smtp.office365.com:587`) or any other SMTP mailbox
 * instead.
 */

const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
// Port 465 is implicit TLS (connect straight into TLS); anything else (587, the Microsoft 365
// default) negotiates plaintext-then-STARTTLS instead — nodemailer picks the right handshake based
// on this flag, it doesn't infer it from the port number.
const SMTP_SECURE = SMTP_PORT === 465;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
// Defaults to sending "as" the mailbox that's authenticating — most providers (including Microsoft
// 365) reject or flag a From address that doesn't match the authenticated account unless you've
// separately set up send-as delegation, so this only needs overriding if that's been configured.
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

function otpEmailConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/** Throws (rather than failing silently) when email isn't configured or the send itself fails, so
    the caller (server.js's /api/auth/forgot-password) can log the real reason — while still always
    returning a generic "if that email has access, a code was sent" response to the browser, so the
    failure mode is never visible to whoever's making the request. A 535-style auth error here
    almost always means the mailbox's provider is blocking basic SMTP AUTH (Microsoft 365 disables
    it by default on many tenants) — see server/README.md for how to turn it back on. */
async function sendOtpEmail(toEmail, code) {
  if (!otpEmailConfigured()) {
    throw new Error('Email sending is not configured — set SMTP_HOST, SMTP_USER, and SMTP_PASS in server/.env.');
  }
  await getTransporter().sendMail({
    from: SMTP_FROM,
    to: toEmail,
    subject: 'Your ATM Scheduler password reset code',
    text: `Your password reset code is ${code}. It expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.`,
    html: `<p>Your ATM Scheduler password reset code is:</p>` +
      `<p style="font-size:28px;font-weight:700;letter-spacing:4px;">${code}</p>` +
      `<p>It expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>`,
  });
}

module.exports = { sendOtpEmail, otpEmailConfigured };
