#!/usr/bin/env node
/**
 * Repairs listedDate/scrapedAt on leads whose dates were overwritten with the upload day.
 * Source of truth: the Firestore backup (original listedDate + scrapedAt). Only those two columns change.
 *
 *   node server/scripts/restore-lead-dates.js --dir backups/firestore-leads-storage-2026-10-28          (preview)
 *   node server/scripts/restore-lead-dates.js --dir backups/firestore-leads-storage-2026-10-28 --yes    (apply)
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sql = require('../sqlconnect');

const args = process.argv.slice(2);
const i = args.indexOf('--dir');
if (i < 0 || !args[i + 1]) { console.error('Missing --dir <backup folder>'); process.exit(1); }
const FILE = path.resolve(args[i + 1], 'preMoverLeads.jsonl');
const APPLY = args.includes('--yes');

(async () => {
  const backup = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { id, data: d } = JSON.parse(line);
    const ld = sql.dateOnly(d.listedDate) || sql.dateOnly(d.scrapedAt);
    if (ld) backup.set(id, { listedDate: ld, scrapedAt: d.scrapedAt ? String(d.scrapedAt) : null });
  }
  console.log(`Backup leads with a date: ${backup.size}`);

  const fixes = [];
  await sql.pageAll('leads', 'leadId', 'leadId address status listedDate scrapedAt', {
    onPage: (rows) => {
      for (const r of rows) {
        const b = backup.get(r.leadId);
        if (!b) continue; // new since the backup: today is its true first-seen date
        if (r.listedDate !== b.listedDate || (b.scrapedAt && r.scrapedAt !== b.scrapedAt)) {
          fixes.push({ leadId: r.leadId, address: r.address, status: r.status, listedDate: b.listedDate, scrapedAt: b.scrapedAt || r.scrapedAt || null });
        }
      }
    },
  });
  console.log(`Leads needing a date repair: ${fixes.length}`);
  fixes.slice(0, 5).forEach((f) => console.log('  e.g.', f.leadId, '->', f.listedDate));
  if (!APPLY) { console.log('Preview only. Re-run with --yes to apply.'); return; }
  const n = await sql.upsertMany('Lead', 'lead_upsertMany', fixes);
  await sql.mergeState('leadsAnalytics', { stale: true });
  console.log(`Repaired ${n} leads. Analytics marked stale (recomputes on next load).`);
})().catch((e) => { console.error(e); process.exit(1); });
