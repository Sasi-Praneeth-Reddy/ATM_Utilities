#!/usr/bin/env node
/**
 * Deletes ALL storage price rows plus the saved storage summary / city history from Firebase SQL Connect.
 * Keeps facilities and benchmarks. Shows what it would do unless you pass --yes.
 *
 *   node server/scripts/clear-storage-prices.js          (preview only)
 *   node server/scripts/clear-storage-prices.js --yes    (really delete)
 *
 * Needs Application Default Credentials (gcloud auth application-default login), same as the loader.
 * A copy of the data is in backups/firestore-leads-storage-2026-10-28/ if you ever want it back.
 */
const sql = require('../sqlconnect');
const YES = process.argv.includes('--yes');

(async () => {
  const first = await sql.read('query { storagePricings(limit: 1, orderBy: {scrapedAt: DESC}) { scrapedAt } storageFacilities(limit: 1) { facilityId } }');
  console.log('Newest price row:', (first.storagePricings[0] || {}).scrapedAt || '(none)');
  console.log('Will delete: every storage_pricing row, AppState "storageSummary" and "storageCityHistory".');
  console.log('Will keep:   facilities, benchmarks, leads, everything else.');
  if (!YES) { console.log('\nPreview only. Re-run with --yes to delete.'); return; }

  const r = await sql.write('mutation { storagePricing_deleteMany(all: true) }', {});
  console.log('Deleted price rows:', JSON.stringify(r));
  for (const k of ['storageSummary', 'storageCityHistory']) {
    await sql.write('mutation D($k: String!) { appState_delete(key: {stateKey: $k}) }', { k });
    console.log('Deleted saved state:', k);
  }
  const left = await sql.read('query { storagePricings(limit: 1) { priceId } }');
  console.log(left.storagePricings.length ? 'WARNING: some price rows remain.' : 'Done - 0 price rows remain.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
