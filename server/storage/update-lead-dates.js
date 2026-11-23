/**
 * server/storage/update-lead-dates.js
 *
 * Repairs the listedDate field on all preMoverLeads documents in Firestore
 * by matching against the true scraped_at timestamps in storage_tracker_aws.db.
 *
 * Usage:
 *   # Dry run (checks how many documents will be updated):
 *   node storage/update-lead-dates.js
 *
 *   # Live execution:
 *   node storage/update-lead-dates.js --yes
 */

require('../load-env');
const path = require('path');
const fs = require('fs');

const DRY_RUN = !process.argv.includes('--yes');
const DB_PATH = path.resolve(__dirname, '../../storage_tracker_aws.db');

if (!fs.existsSync(DB_PATH)) {
  console.error('❌ SQLite backup database not found at:', DB_PATH);
  process.exit(1);
}

const { DatabaseSync } = require('node:sqlite');
const sqlite = new DatabaseSync(DB_PATH, { readOnly: true });

const leads = sqlite.prepare('SELECT id, address, zip_code, listed_date, scraped_at, import_file FROM pre_mover_leads').all();
sqlite.close();

console.log(`Loaded ${leads.length} leads from SQLite backup.`);

const monthBreakdown = {};
for (const l of leads) {
  const dt = (l.listed_date && l.listed_date.trim()) || (l.scraped_at ? l.scraped_at.slice(0, 7) : 'Unknown');
  monthBreakdown[dt] = (monthBreakdown[dt] || 0) + 1;
}
console.log('Original Month Distribution:', monthBreakdown);

if (DRY_RUN) {
  console.log('\n[DRY RUN] To apply these correct dates to Firestore, run:');
  console.log('  node storage/update-lead-dates.js --yes');
  process.exit(0);
}

const { db } = require('../firestore');

async function run() {
  console.log(`\nUpdating listedDate & scrapedAt on ${leads.length} leads in Firestore...`);
  const BATCH_SIZE = 400;
  let updatedCount = 0;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const chunk = leads.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (let j = 0; j < chunk.length; j++) {
      const l = chunk[j];
      const cleanAddr = (l.address || '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const docId = `lead_${cleanAddr || (i + j)}_${l.zip_code || ''}`;
      const ref = db.collection('preMoverLeads').doc(docId);

      const trueDate = (l.listed_date && l.listed_date.trim()) || 
                       (l.scraped_at ? l.scraped_at.slice(0, 10) : '2026-10-27');

      batch.update(ref, {
        listedDate: trueDate,
        scrapedAt: l.scraped_at || trueDate,
      });
    }

    await batch.commit();
    updatedCount += chunk.length;
    process.stdout.write(`  Updated ${updatedCount} / ${leads.length}\r`);
  }

  console.log(`\n✅ All ${updatedCount} pre-mover leads successfully updated with their true dates in Firestore!`);
}

run().catch(err => {
  console.error('\n❌ Update failed:', err);
  process.exit(1);
});
