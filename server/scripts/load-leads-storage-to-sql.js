#!/usr/bin/env node
/**
 * Loads the Firestore backup (backups/firestore-leads-storage-<date>/) into Firebase SQL Connect.
 * Reads only local files - never touches Firestore, never deletes anything. Safe to re-run (upserts).
 *
 *   node server/scripts/load-leads-storage-to-sql.js --dir backups/firestore-leads-storage-2026-10-28 --dry-run
 *   DATA_CONNECT_EMULATOR_HOST=127.0.0.1:9399 node server/scripts/load-leads-storage-to-sql.js --dir <dir>   (emulator)
 *   node server/scripts/load-leads-storage-to-sql.js --dir <dir>                                             (real instance)
 *
 * Needs Application Default Credentials for the real instance (gcloud auth application-default login).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DIR = path.resolve(opt('dir', ''));
const DRY = flag('dry-run');
const BATCH = parseInt(opt('batch', '100'), 10);
const SERVICE_ID = opt('service', 'atm-scheduler-service');
const LOCATION = opt('location', 'us-east4');
if (!opt('dir')) { console.error('Missing --dir <backup folder>'); process.exit(1); }

// ---------- helpers ----------
const nn = (v) => (v === undefined || v === null || v === '' ? null : v);
const str = (v) => (nn(v) === null ? null : String(v));
const int = (v) => { if (nn(v) === null) return null; const n = Math.round(Number(v)); return Number.isFinite(n) ? n : null; };
const flt = (v) => { if (nn(v) === null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const dateOnly = (v) => { const s = str(v); const m = s && s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
function ts(v) {
  if (nn(v) === null) return null;
  if (typeof v === 'object') { // Firestore timestamp shapes
    const sec = v._seconds ?? v.seconds; if (sec != null) return new Date(sec * 1000).toISOString();
    return null;
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')).toISOString();
  const d = new Date(s); return isNaN(d) ? null : d.toISOString();
}

async function readJsonl(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) { if (line.trim()) out.push(JSON.parse(line)); }
  return out;
}

// ---------- transforms (Firestore doc -> SQL row) ----------
const tLead = ({ id, data: d }) => ({
  leadId: id, address: str(d.address) || '(unknown)', city: str(d.city), state: str(d.state), zipCode: str(d.zipCode),
  county: str(d.county), status: str(d.status) || 'Unknown', listPrice: int(d.listPrice), bedrooms: int(d.bedrooms),
  bathrooms: flt(d.bathrooms), sqft: int(d.sqft), isVacant: !!d.isVacant, listedDate: dateOnly(d.listedDate),
  scrapedAt: str(d.scrapedAt), firstName: str(d.firstName), lastName: str(d.lastName), ownerFullName: str(d.ownerFullName),
  phone: str(d.phone), email: str(d.email), realtorName: str(d.realtorName), realtorPhone: str(d.realtorPhone),
  realtorEmail: str(d.realtorEmail), brokerName: str(d.brokerName), source: str(d.source), previousStatus: str(d.previousStatus),
});
const tMatch = ({ id, data: d }) => ({
  matchId: id, leadId: str(d.leadId), customerName: str(d.customerName) || '(unknown)', customerEmail: str(d.customerEmail),
  customerPhone: str(d.customerPhone), matchedAddress: str(d.matchedAddress), matchedType: str(d.matchedType),
  sourceType: str(d.sourceType), confidence: int(d.confidence), matchReason: str(d.matchReason),
  previousMoveDate: str(d.previousMoveDate), previousMoveDetails: str(d.previousMoveDetails), listingStatus: str(d.listingStatus),
  listingPrice: int(d.listingPrice), listedDate: dateOnly(d.listedDate), realtorName: str(d.realtorName),
  realtorPhone: str(d.realtorPhone), realtorEmail: str(d.realtorEmail), status: str(d.status) || 'new', notes: str(d.notes),
  outreachHistory: Array.isArray(d.outreachHistory) ? d.outreachHistory : [], detectedAt: ts(d.detectedAt), lastChecked: ts(d.lastChecked),
});
const tFacility = ({ id, data: d }) => ({
  facilityId: id, name: str(d.name) || '(unnamed)', brand: str(d.brand), address: str(d.address), city: str(d.city),
  state: str(d.state), zipCode: str(d.zipCode), lat: flt(d.lat), lon: flt(d.lon), phone: str(d.phone), website: str(d.website),
});
const tBench = ({ id, data: d }) => ({
  benchmarkId: id, region: str(d.region) || 'Unknown', source: str(d.source), periodType: str(d.periodType),
  periodDate: dateOnly(d.periodDate), year: int(d.year), month: int(d.month), activeListings: int(d.activeListings),
  newListings: int(d.newListings), closedSales: int(d.closedSales), pendingSales: int(d.pendingSales),
  avgClosePrice: int(d.avgClosePrice), medianClosePrice: int(d.medianClosePrice), medianDaysOnMarket: int(d.medianDaysOnMarket),
  closeToListRatio: flt(d.closeToListRatio),
});

// GraphQL: foreign keys are set as `<rel>: { <pk>: value }` in generated *_Data inputs.
const MUT = {
  Lead: 'lead_upsertMany', MatchedLead: 'matchedLead_upsertMany', StorageFacility: 'storageFacility_upsertMany',
  StoragePricing: 'storagePricing_upsertMany', MlsBenchmark: 'mlsBenchmark_upsertMany', ScrapeRun: 'scrapeRun_upsertMany',
  EmailNotice: 'emailNotice_upsertMany',
};

async function main() {
  console.log(`Backup dir: ${DIR}  mode: ${DRY ? 'DRY RUN' : process.env.DATA_CONNECT_EMULATOR_HOST ? 'EMULATOR' : 'REAL INSTANCE'}`);
  const sqlite = JSON.parse(fs.readFileSync(path.join(DIR, 'sqlite_export.json'), 'utf8'));
  const idMap = sqlite.facilityIdMap; // sqlite int id (string) -> facility doc id

  const leads = (await readJsonl(path.join(DIR, 'preMoverLeads.jsonl'))).map(tLead);
  const leadIds = new Set(leads.map((l) => l.leadId));
  const facilities = (await readJsonl(path.join(DIR, 'storageFacilities.jsonl'))).map(tFacility);
  const facIds = new Set(facilities.map((f) => f.facilityId));

  const problems = [];
  const matches = (await readJsonl(path.join(DIR, 'matchedLeads.jsonl'))).map(tMatch).map((m) => {
    if (!leadIds.has(m.leadId)) problems.push(`match ${m.matchId}: lead ${m.leadId} missing`);
    const { leadId, ...rest } = m; return { ...rest, leadLeadId: leadId };
  });
  const pricing = (await readJsonl(path.join(DIR, 'storagePricing.jsonl'))).map(({ id, data: d }) => {
    const facilityId = idMap[String(d.facilityId)] || (facIds.has(String(d.facilityId)) ? String(d.facilityId) : null);
    if (!facilityId) { problems.push(`price ${id}: no facility for ${d.facilityId}`); return null; }
    return {
      priceId: id, facilityFacilityId: facilityId, unitSize: str(d.unitSize) || 'Unknown', unitType: str(d.unitType),
      streetRate: int(d.streetRate), webRate: int(d.webRate), availability: str(d.availability), source: str(d.source),
      scrapedAt: ts(d.scrapedAt) || new Date(0).toISOString(),
    };
  }).filter(Boolean);
  const bench = (await readJsonl(path.join(DIR, 'mlsBenchmarks.jsonl'))).map(tBench).filter((b) => b.periodDate);
  const runs = sqlite.scrapeLog.map((r) => ({
    runId: `run_${r.id}`, source: str(r.source) || 'unknown', status: str(r.status) || 'unknown', recordsWritten: int(r.records_written),
    errorMessage: str(r.error_msg), durationSec: flt(r.duration_sec), runAt: ts(r.run_at) || new Date(0).toISOString(),
  }));
  const notices = sqlite.emailLog.map((r) => ({
    noticeId: `mail_${r.id}`, recipients: str(r.recipients) || '', subject: str(r.subject), status: str(r.status),
    errorMessage: str(r.error_msg), messageId: str(r.message_id), sentAt: ts(r.sent_at) || new Date(0).toISOString(),
  }));

  const plan = [
    ['Lead', leads], ['StorageFacility', facilities], ['StoragePricing', pricing], ['MlsBenchmark', bench],
    ['MatchedLead', matches], ['ScrapeRun', runs], ['EmailNotice', notices],
  ];
  for (const [t, rows] of plan) console.log(`  ${t.padEnd(16)} ${rows.length} rows`);
  if (problems.length) { console.error(`\n${problems.length} integrity problems (first 5):`, problems.slice(0, 5)); process.exit(2); }
  if (DRY) { console.log('\nDry run OK - nothing written.'); return; }

  const { initializeApp, applicationDefault, getApps } = require('firebase-admin/app');
  const { getDataConnect } = require('firebase-admin/data-connect');
  if (!getApps().length) initializeApp({ credential: applicationDefault(), projectId: process.env.GCLOUD_PROJECT || 'atm-scheduler' });
  const dc = getDataConnect({ serviceId: SERVICE_ID, location: LOCATION });

  for (const [table, rows] of plan) {
    const mut = MUT[table];
    const q = `mutation Load($data: [${table}_Data!]!) { ${mut}(data: $data) }`;
    for (let i = 0; i < rows.length; i += BATCH) {
      const data = rows.slice(i, i + BATCH);
      await dc.executeGraphql(q, { variables: { data } });
      process.stdout.write(`\r  ${table}: ${Math.min(i + BATCH, rows.length)}/${rows.length}   `);
    }
    process.stdout.write('\n');
  }

  await dc.executeGraphql('mutation S($d: AppState_Data!) { appState_upsert(data: $d) }', {
    variables: { d: { stateKey: 'facilityIdMap', value: idMap, updatedAt: new Date().toISOString() } },
  });
  console.log('  AppState facilityIdMap stored.');

  console.log('\nVerifying row counts in SQL...');
  const names = { Lead: 'leads', StorageFacility: 'storageFacilities', StoragePricing: 'storagePricings', MlsBenchmark: 'mlsBenchmarks', MatchedLead: 'matchedLeads', ScrapeRun: 'scrapeRuns', EmailNotice: 'emailNotices' };
  let ok = true;
  for (const [t, rows] of plan) {
    let n = 0, after = null;
    // count by paging keys only (works without aggregate support)
    const pk = { Lead: 'leadId', StorageFacility: 'facilityId', StoragePricing: 'priceId', MlsBenchmark: 'benchmarkId', MatchedLead: 'matchId', ScrapeRun: 'runId', EmailNotice: 'noticeId' }[t];
    for (;;) {
      const r = await dc.executeGraphqlRead(`query C($after:String){ ${names[t]}(limit:5000, orderBy:{${pk}:ASC}${after ? ', where:{' + pk + ':{gt:$after}}' : ''}) { ${pk} } }`, { variables: after ? { after } : {} });
      const list = r.data[names[t]]; n += list.length; if (list.length < 5000) break; after = list[list.length - 1][pk];
    }
    const good = n === rows.length; ok = ok && good;
    console.log(`  ${t.padEnd(16)} sql=${n} backup=${rows.length} ${good ? 'OK' : 'MISMATCH'}`);
  }
  if (!ok) { console.error('Count mismatch - do NOT delete anything from Firestore.'); process.exit(3); }
  console.log('All counts match.');
}
main().catch((e) => { console.error('\nFAILED:', e.message || e); process.exit(1); });
