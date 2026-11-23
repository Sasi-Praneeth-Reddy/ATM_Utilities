/**
 * server/scraperAuth.js
 *
 * API-key auth for the automated daily scrapers (GitHub Actions) that push Leads and Storage data.
 * The key is sent as an `x-api-key` header and compared in constant time against SCRAPER_API_KEY
 * (a Secret Manager secret on Cloud Functions - see functions-index.js). SECRET_WEBHOOK_KEY is still
 * accepted as a local-dev / legacy fallback. Never the SmartMoving WEBHOOK_SECRET: separate secrets
 * for separate jobs.
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function hasValidScraperKey(req) {
  const sent = req.headers['x-api-key'] || req.headers['x-webhook-key'];
  if (!sent) return false;
  const expected = [process.env.SCRAPER_API_KEY, process.env.SECRET_WEBHOOK_KEY]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  const got = String(sent).trim();
  return expected.some((e) => safeEqual(got, e));
}

module.exports = { hasValidScraperKey, safeEqual };
