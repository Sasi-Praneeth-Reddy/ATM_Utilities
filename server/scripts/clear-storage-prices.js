#!/usr/bin/env node
/**
 * Deletes ALL storage price rows plus the saved storage summary / city history from DynamoDB.
 * Keeps facilities and benchmarks. Shows what it would do unless you pass --yes.
 *
 *   node server/scripts/clear-storage-prices.js          (preview only)
 *   node server/scripts/clear-storage-prices.js --yes    (really delete)
 *
 * Needs AWS credentials: ATM_AWS_ACCESS_KEY_ID / ATM_AWS_SECRET_ACCESS_KEY (server/local.secrets) or `aws configure`.
 * A copy of the data is in backups/firestore-leads-storage-2026-10-28/ if you ever want it back.
 */
const store = require('../awsStore');
const YES = process.argv.includes('--yes');

(async () => {
  console.log('Newest price row:', (await store.newestPricingAt()) || '(none)');
  console.log('Will delete: every storage_pricing row, AppState "storageSummary" and "storageCityHistory".');
  console.log('Will keep:   facilities, benchmarks, leads, everything else.');
  if (!YES) { console.log('\nPreview only. Re-run with --yes to delete.'); return; }

  const n = await store.deleteAll('StoragePricing');
  console.log('Deleted price rows:', n);
  for (const k of ['storageSummary', 'storageCityHistory']) {
    await store.deleteState(k);
    console.log('Deleted saved state:', k);
  }
  const left = await store.count('StoragePricing');
  console.log(left ? 'WARNING: some price rows remain.' : 'Done - 0 price rows remain.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
