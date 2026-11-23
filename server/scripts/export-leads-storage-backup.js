/**
 * Backs up every Leads / Storage-Market Firestore collection to JSON-lines files, BEFORE anything is
 * migrated to SQL or deleted. Safe to re-run: it resumes where it stopped.
 *
 *   cd server
 *   node scripts/export-leads-storage-backup.js
 *
 * Uses the service-account key at ../atm-scheduler-firebase-adminsdk-*.json (or GOOGLE_APPLICATION_CREDENTIALS).
 * Output: ../backups/firestore-leads-storage-<date>/<collection>.jsonl  (git-ignored — contains customer data)
 * Reads ~75K documents once (a few cents on the Blaze plan).
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');

const COLLECTIONS = [
  'preMoverLeads', 'matchedLeads', 'legacyCustomers',
  'storageFacilities', 'storagePricing', 'storagePromotions', 'mlsBenchmarks', 'mlsMarketData',
];
const SYSTEM_DOCS = ['leadsAnalytics', 'leadsReconcile', 'storageSummary'];

const root = path.resolve(__dirname, '../..');
const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || fs.readdirSync(root).filter((f) => /^atm-scheduler-firebase-adminsdk.*\.json$/.test(f)).map((f) => path.join(root, f))[0];
if (!keyPath) throw new Error('No service-account key found.');
const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
initializeApp({ credential: cert(key), projectId: key.project_id });
const db = getFirestore();
db.settings({ preferRest: true, ignoreUndefinedProperties: true });

const outDir = path.join(root, 'backups', `firestore-leads-storage-${new Date().toISOString().slice(0, 10)}`);
fs.mkdirSync(outDir, { recursive: true });
const replacer = (k, v) => (v && typeof v === 'object' && typeof v.toDate === 'function' ? { __ts: v.toDate().toISOString() } : v);

async function exportCollection(name) {
  const file = path.join(outDir, `${name}.jsonl`);
  const cursorFile = path.join(outDir, `${name}.cursor`);
  let cursor = fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, 'utf8') : null;
  if (cursor === 'DONE') { console.log(`${name}: already exported`); return; }
  let count = 0;
  for (;;) {
    let q = db.collection(name).orderBy(FieldPath.documentId()).limit(1000);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;
    fs.appendFileSync(file, `${snap.docs.map((d) => JSON.stringify({ id: d.id, data: d.data() }, replacer)).join('\n')}\n`);
    cursor = snap.docs[snap.docs.length - 1].id;
    fs.writeFileSync(cursorFile, cursor);
    count += snap.size;
    process.stdout.write(`\r${name}: +${count}   `);
  }
  fs.writeFileSync(cursorFile, 'DONE');
  console.log(`\n${name}: done`);
}

(async () => {
  for (const c of COLLECTIONS) await exportCollection(c);
  const sys = [];
  for (const id of SYSTEM_DOCS) {
    const d = await db.collection('system').doc(id).get();
    if (d.exists) sys.push({ id, data: d.data() });
  }
  fs.writeFileSync(path.join(outDir, 'system_docs.json'), JSON.stringify(sys, replacer));
  const summary = {};
  for (const c of COLLECTIONS) {
    const f = path.join(outDir, `${c}.jsonl`);
    summary[c] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
  }
  fs.writeFileSync(path.join(outDir, '_counts.json'), JSON.stringify(summary, null, 2));
  console.log('\nBackup complete:', outDir, summary);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
