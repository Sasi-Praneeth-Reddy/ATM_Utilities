/**
 * Job Materials report sync: Gmail -> parse (materialsReport.js) -> save onto board jobs (tasking.applyMaterialsReport).
 * Runs 6:30 AM and 5:00 PM ET (materialsSyncScheduled* in functions-index.js) and from the Dispatch page button.
 * Same safety contract as smartInsightsSync: an email is labelled processed (and trashed) only AFTER its file was
 * parsed and saved, so a failure leaves it for the next run. See docs/TASKING.md.
 */
const db = require('./db');
const tasking = require('./tasking');
const { parseMaterialsReport } = require('./materialsReport');
const { findUnprocessedMaterialsFiles, markMessageProcessed } = require('./smartInsightsGmail');

/** Parses one report file and saves it. Shared by the Gmail sync and the manual upload. */
async function importMaterialsBuffer(buffer, filename) {
  const parsed = parseMaterialsReport(buffer);
  const applied = await tasking.applyMaterialsReport({ db, byJob: parsed.byJob });
  return { filename, rows: parsed.rows, rowsSkipped: parsed.skipped, ...applied };
}

async function syncMaterials() {
  const files = await findUnprocessedMaterialsFiles();
  const out = { filesProcessed: 0, imports: [], skipped: [], errors: [] };
  for (const f of files) {
    if (f.error) { out.errors.push(`${f.messageId}: ${f.error}`); continue; }
    if (f.skipped) { out.skipped.push(`${f.messageId}: ${f.reason}`); continue; }
    try {
      out.imports.push(await importMaterialsBuffer(f.buffer, f.filename));
      await markMessageProcessed(f.messageId);
      out.filesProcessed += 1;
    } catch (err) {
      out.errors.push(`${f.filename || f.messageId}: ${err.message}`);
    }
  }
  return out;
}

module.exports = { syncMaterials, importMaterialsBuffer };
