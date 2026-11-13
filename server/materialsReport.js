/**
 * Parser for SmartMoving's "Job Materials" Smart Insights report ("All Job Material.xlsx").
 *
 * One row per job + material. Columns used (names must match, see REQUIRED): Job Number (e.g. "24744-1"),
 * Job Date, Name (the material), Estimated Materials Quantity. Actual quantities are used only when the
 * estimate is 0 (finished jobs). Packing / unpacking columns are labour, not warehouse stock, and are ignored.
 * "Is Container" is NOT used: it is ticked for ordinary cartons and wardrobe boxes, not warehouse crates.
 * A "crate" here is any material whose name contains the word crate (e.g. 85" TV Crate Rental).
 *
 * Pure (no I/O besides parsing the buffer) so it is unit-tested in test-tasking.js.
 * Output is keyed by board job id, which is `SM-<Job Number>` (same as mapIcalEvent.js).
 */
const XLSX = require('xlsx');

const REQUIRED = ['Job Number', 'Job Date', 'Name', 'Estimated Materials Quantity'];
const CRATE_RE = /\bcrates?\b/i;

/** Filename test used by the Gmail pickup to tell this report apart from the other Smart Insights reports. */
const MATERIALS_FILENAME_RE = /job[\s_]*materials?/i;

const cleanName = (n) => String(n == null ? '' : n).replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
const toIso = (v) => {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return null;
};

/** @returns {{ byJob: Object<string,{jobNumber:string,date:string,items:Array<{key:string,name:string,qty:number,crate:boolean}>}>, rows:number, skipped:number }} */
function parseMaterialsReport(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('Materials report has no sheets');
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false, dateNF: 'yyyy-mm-dd' });
  if (!rows.length) return { byJob: {}, rows: 0, skipped: 0 };
  const have = new Set(Object.keys(rows[0]));
  const missing = REQUIRED.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`Materials report is missing column(s): ${missing.join(', ')}. Columns found: ${[...have].join(', ')}`);

  const byJob = {}; let skipped = 0;
  for (const r of rows) {
    const jobNumber = String(r['Job Number'] || '').trim();
    const name = cleanName(r['Name']);
    const est = Number(String(r['Estimated Materials Quantity'] ?? '').replace(/,/g, '')) || 0;
    const act = Number(String(r['Actual Materials Quantity'] ?? '').replace(/,/g, '')) || 0;
    const qty = est > 0 ? est : act;
    const date = toIso(r['Job Date']);
    if (!jobNumber || !name || !(qty > 0) || !date) { skipped += 1; continue; }
    const id = 'SM-' + jobNumber;
    const job = byJob[id] || (byJob[id] = { jobNumber, date, items: [] });
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'item';
    const hit = job.items.find((i) => i.key === key);
    if (hit) hit.qty += qty; else job.items.push({ key, name: name.slice(0, 80), qty, crate: CRATE_RE.test(name) });
  }
  return { byJob, rows: rows.length, skipped };
}

module.exports = { parseMaterialsReport, MATERIALS_FILENAME_RE, REQUIRED };
