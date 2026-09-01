/**
 * Parses a SmartMoving "Smart Insights" Booked Opportunities report (.xlsx buffer, as downloaded
 * from the emailed report link — see smartInsightsGmail.js) into normalized row objects.
 *
 * Ported from the SM_Insights project's proven parsers/bookedOpportunities.js (built + verified
 * against this account's real report on 2026-08-19/24 — see project memory: project_sm_insights.md
 * for the full column-confirmation history). Column list below is the REAL confirmed layout, not a
 * guess — do not "improve" the column names without re-checking a real downloaded report first,
 * since SmartMoving's own report UI can rename/reorder columns without warning.
 *
 * Sheet name is always `data`. 20 columns, header row + one row per opportunity:
 *   Quote #, Status, Customer Name, Email, Phone Number, Branch Name, Moving From, Moving to,
 *   Service Date, Service Type, Weight, Volume, Hourly Rate, Estimated Amount, Invoiced Amount,
 *   Referral Source, Estimator, Sales Person, Move Coordinator, Booked Date
 *
 * Service Date / Booked Date arrive as plain M/D/YYYY strings (not native Excel date cells) —
 * normalizeDate() below converts them to yyyy-mm-dd to match the rest of the scheduler's date
 * handling (see frontend/src/utils/dates.js).
 */
const XLSX = require('xlsx');

const SHEET_NAME = 'data';

function blankToNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}

/** 'M/D/YYYY' -> 'YYYY-MM-DD'. Returns null for anything that doesn't parse — callers should treat
 * a null Service Date as "skip this row", but a null Booked Date is fine (it's informational only). */
function normalizeDate(raw) {
  const s = blankToNull(raw);
  if (s === null) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function toNumber(raw) {
  const v = blankToNull(raw);
  if (v === null) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {Buffer} buffer raw .xlsx file bytes
 * @returns {Array<object>} normalized rows, each with a `raw` field preserving the original row
 *   exactly as read (for debugging / future columns without a full re-parse)
 */
function parseReportBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[SHEET_NAME] || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error(`No sheet found in report (expected "${SHEET_NAME}", got: ${workbook.SheetNames.join(', ')})`);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return parseRows(rows);
}

function parseRows(rows) {
  return rows.map((row) => ({
    quoteNumber: blankToNull(row['Quote #']) !== null ? String(row['Quote #']).trim() : null,
    status: blankToNull(row['Status']),
    customerName: blankToNull(row['Customer Name']),
    email: blankToNull(row['Email']),
    phoneNumber: blankToNull(row['Phone Number']),
    branchName: blankToNull(row['Branch Name']),
    movingFrom: blankToNull(row['Moving From']),
    movingTo: blankToNull(row['Moving to']),
    serviceDate: normalizeDate(row['Service Date']),
    serviceType: blankToNull(row['Service Type']),
    weight: toNumber(row['Weight']),
    volume: toNumber(row['Volume']),
    hourlyRate: toNumber(row['Hourly Rate']),
    estimatedAmount: toNumber(row['Estimated Amount']),
    invoicedAmount: toNumber(row['Invoiced Amount']),
    referralSource: blankToNull(row['Referral Source']),
    estimator: blankToNull(row['Estimator']),
    salesPerson: blankToNull(row['Sales Person']),
    moveCoordinator: blankToNull(row['Move Coordinator']),
    bookedDate: normalizeDate(row['Booked Date']),
    raw: row,
  }));
}

module.exports = { parseReportBuffer, parseRows, reportType: 'booked-opportunities' };
