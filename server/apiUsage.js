/**
 * Per-day SmartMoving API usage tracking (added 2026-09-30).
 *
 * WHY: Premium tier = 125,000 calls/month for the WHOLE SmartMoving account, shared with other
 * projects (chatbot, SM tooling, etc.). Scheduler_ATM has burned the monthly quota twice before
 * (2026-08-18, 2026-08-27). Every call made through smartmovingClient.js is counted here, tagged
 * with WHO made it, so we can see where calls go and keep the scheduler inside its own budget.
 *
 * Firestore layout (collection `apiUsage`):
 *   apiUsage/day-YYYY-MM-DD   { date, total, bySource{webhook,poll,...}, byEndpoint{...}, status429, errors, updatedAt }
 *   apiUsage/month-YYYY-MM    { month, total, bySource{...}, updatedAt }
 * Days/months are America/New_York calendar days (matches the business day, and the scheduled jobs'
 * timeZone). SmartMoving's own monthly reset may be on a UTC boundary — close enough for budgeting.
 *
 * Source tags: wrap work in `withApiSource('webhook', fn)`; anything not wrapped falls back to
 * process.env.API_USAGE_SOURCE (set it to 'debug' / 'chatbot' in local scripts or other services)
 * or 'other'. Uses AsyncLocalStorage so concurrent requests on one instance don't mix tags.
 *
 * Recording is best-effort: a Firestore failure (e.g. a local script with no credentials) never
 * fails the SmartMoving call itself.
 */

const { AsyncLocalStorage } = require('async_hooks');

const TIME_ZONE = 'America/New_York';
// Scheduler_ATM's own daily allowance (user decision 2026-09-30: 1,000/day ≈ 30k/month, leaving
// ~95k/month of the account's Premium quota for the chatbot and other projects).
const DAILY_BUDGET = Number(process.env.SMARTMOVING_DAILY_BUDGET) || 1000;
const MONTHLY_QUOTA = Number(process.env.SMARTMOVING_MONTHLY_QUOTA) || 125000;

const sourceStorage = new AsyncLocalStorage();

function withApiSource(source, fn) {
  return sourceStorage.run({ source }, fn);
}

function currentSource() {
  const store = sourceStorage.getStore();
  return (store && store.source) || process.env.API_USAGE_SOURCE || 'other';
}

/** 'YYYY-MM-DD' for the given instant in America/New_York. */
function dayKey(date = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Collapses ids so byEndpoint groups by operation, not by opportunity:
 *  /api/opportunities/213a4b77-.../jobs -> /api/opportunities/:id/jobs */
function normalizeEndpoint(path) {
  return String(path)
    .split('?')[0]
    .split('/')
    .map(seg => (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) || (/\d/.test(seg) && seg.length > 6)) ? ':id' : seg)
    .join('/')
    // Firestore map keys can't contain '.' meaningfully in dotted paths; '/' is fine inside a map
    // written via set(merge), but keep keys tidy anyway.
    .replace(/\./g, '_');
}

let firestore = null;
let FieldValue = null;
let firestoreUnavailable = false;
function getFirestoreSafe() {
  if (firestore || firestoreUnavailable) return firestore;
  try {
    firestore = require('./firestore').db;
    FieldValue = require('firebase-admin/firestore').FieldValue;
  } catch (err) {
    firestoreUnavailable = true;
    console.warn(`apiUsage: Firestore unavailable, API usage will not be recorded (${err.message})`);
  }
  return firestore;
}

// In-process tally too, so /api/health and the budget check can work even if a write is slow.
const localToday = { date: null, total: 0 };

/**
 * Called by smartmovingClient.js once per HTTP request actually sent to SmartMoving (including
 * each 429 retry attempt — those count against the quota too).
 */
async function recordApiCall({ path, status }) {
  const source = currentSource();
  const date = dayKey();
  if (localToday.date !== date) { localToday.date = date; localToday.total = 0; }
  localToday.total += 1;

  const fs = getFirestoreSafe();
  if (!fs) return;
  const inc = FieldValue.increment(1);
  const now = new Date().toISOString();
  const endpoint = normalizeEndpoint(path);
  const dayUpdate = {
    date, total: inc, updatedAt: now,
    bySource: { [source]: inc },
    byEndpoint: { [endpoint]: inc },
  };
  if (status === 429) dayUpdate.status429 = inc;
  else if (status >= 400) dayUpdate.errors = inc;
  const month = date.slice(0, 7);
  try {
    await Promise.all([
      fs.collection('apiUsage').doc(`day-${date}`).set(dayUpdate, { merge: true }),
      fs.collection('apiUsage').doc(`month-${month}`).set(
        { month, total: inc, updatedAt: now, bySource: { [source]: inc } }, { merge: true }),
    ]);
  } catch (err) {
    console.warn(`apiUsage: failed to record call (${err.message})`);
  }
}

async function getDayUsage(date = dayKey()) {
  const fs = getFirestoreSafe();
  if (!fs) return { date, total: localToday.date === date ? localToday.total : 0, bySource: {}, byEndpoint: {} };
  const snap = await fs.collection('apiUsage').doc(`day-${date}`).get();
  return snap.exists ? { total: 0, bySource: {}, byEndpoint: {}, ...snap.data(), date } : { date, total: 0, bySource: {}, byEndpoint: {} };
}

async function getMonthUsage(month = dayKey().slice(0, 7)) {
  const fs = getFirestoreSafe();
  if (!fs) return { month, total: 0, bySource: {} };
  const snap = await fs.collection('apiUsage').doc(`month-${month}`).get();
  return snap.exists ? { total: 0, bySource: {}, ...snap.data(), month } : { month, total: 0, bySource: {} };
}

/** Last `days` days (newest first), for the usage endpoint / a future chart. */
async function getRecentDays(days = 14) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < days; i++) out.push(await getDayUsage(dayKey(new Date(now - i * 86400000))));
  return out;
}

/**
 * Scheduler-attributed calls today. Counts every source except ones that clearly belong to other
 * projects ('chatbot' and anything prefixed 'ext:'), so the scheduler's budget isn't eaten by, and
 * doesn't eat into, another project's usage.
 */
function schedulerCallsFrom(day) {
  return Object.entries(day.bySource || {})
    .filter(([src]) => src !== 'chatbot' && !src.startsWith('ext:'))
    .reduce((sum, [, n]) => sum + (Number(n) || 0), 0);
}

async function getBudgetStatus() {
  const day = await getDayUsage();
  const used = schedulerCallsFrom(day);
  return { date: day.date, used, budget: DAILY_BUDGET, remaining: Math.max(DAILY_BUDGET - used, 0), exceeded: used >= DAILY_BUDGET };
}

module.exports = {
  withApiSource, currentSource, recordApiCall, dayKey, normalizeEndpoint,
  getDayUsage, getMonthUsage, getRecentDays, getBudgetStatus, schedulerCallsFrom,
  DAILY_BUDGET, MONTHLY_QUOTA,
};
