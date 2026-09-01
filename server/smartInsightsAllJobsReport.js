/**
 * Parses the SmartMoving "All Jobs" report (.xlsx, delivered as a direct email attachment via
 * Sigma Computing — see smartInsightsGmail.js's file header) into normalized row objects.
 *
 * Confirmed 2026-08-24 against a real downloaded report (sheet "All Jobs", 65 columns, one row per
 * JOB — not per opportunity; an opportunity booked for a multi-truck or multi-stop move has one row
 * per Job Number, e.g. "24100-1"/"24100-2"/"24100-3" all sharing opportunity id "24100"). This
 * report has NO customer name, email, phone, or address columns at all — see
 * smartInsightsSync.js's file header for how those get joined in from the other (Booked
 * Opportunities) report instead. Column list below is the real confirmed layout for the columns
 * this pipeline actually uses — do not assume the rest without checking a real report first, same
 * caution as smartInsightsReport.js.
 *
 * Unlike the Booked Opportunities report's Service Date/Booked Date (plain M/D/YYYY text cells),
 * this report's "Job Date" is a REAL Excel date cell — XLSX.read's cellDates:true option is
 * required so it comes back as a JS Date instead of a raw serial number, and toYMD() below reads
 * it with UTC getters (SheetJS represents a date-only cell as UTC midnight; using local getters
 * here would shift the date by a day for any server not running in UTC).
 */
const XLSX = require('xlsx');

const SHEET_NAME = 'All Jobs';

function blankToNull(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return v;
}

function toYMD(raw) {
  const v = blankToNull(raw);
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
 */
function parseAllJobsBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = workbook.Sheets[SHEET_NAME] || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error(`No sheet found in All Jobs report (expected "${SHEET_NAME}", got: ${workbook.SheetNames.join(', ')})`);
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return parseAllJobsRows(rows);
}

function parseAllJobsRows(rows) {
  return rows.map((row) => ({
    jobNumber: blankToNull(row['Job Number']) !== null ? String(row['Job Number']).trim() : null,
    jobDate: toYMD(row['Job Date']),
    type: blankToNull(row['Type']),
    branchName: blankToNull(row['Branch Name']),
    customLeadStatus: blankToNull(row['Custom Lead Status']),
    totalEstimatedCost: toNumber(row['Total Estimated Cost']),
    raw: row,
  }));
}

/** The opportunity/quote id a job belongs to is everything before the LAST "-<sequence>" in its
 * Job Number ("24100-1" -> "24100") — matches the Booked Opportunities report's Quote # column,
 * which is what smartInsightsSync.js joins against. Falls back to the whole job number unchanged
 * if it doesn't match that shape (defensive — so an unexpected format doesn't crash the sync, it
 * just won't find a matching opportunity and gets skipped there instead). */
function opportunityIdFromJobNumber(jobNumber) {
  if (!jobNumber) return null;
  const m = String(jobNumber).match(/^(.*)-(\d+)$/);
  return m ? m[1] : String(jobNumber);
}

module.exports = { parseAllJobsBuffer, parseAllJobsRows, opportunityIdFromJobNumber, reportType: 'all-jobs' };
