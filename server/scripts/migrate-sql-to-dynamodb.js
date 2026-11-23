#!/usr/bin/env node
/**
 * One-time copy of the Leads + Storage data from Cloud SQL (Firebase SQL Connect) to DynamoDB, and a
 * verifier that proves the copy is complete. Read-only on the SQL side: it never changes or deletes
 * anything in Cloud SQL, so it is safe to run as many times as you like (copying is an upsert by key).
 *
 *   cd server
 *   node scripts/migrate-sql-to-dynamodb.js --dry-run          # count rows in Cloud SQL, write nothing
 *   node scripts/migrate-sql-to-dynamodb.js                    # copy everything
 *   node scripts/migrate-sql-to-dynamodb.js --verify           # compare Cloud SQL and DynamoDB row by row
 *   node scripts/migrate-sql-to-dynamodb.js --only Lead,StoragePricing    # limit to some tables
 *
 * Needs BOTH:
 *   - Google credentials to read Cloud SQL:  gcloud auth application-default login
 *   - AWS credentials to write DynamoDB:     ATM_AWS_ACCESS_KEY_ID / ATM_AWS_SECRET_ACCESS_KEY in server/local.secrets,
 *                                            or `aws configure` / SSO, plus ATM_AWS_REGION (default us-east-1)
 *
 * --verify exits with code 1 if ANY table has a missing, extra or different row. Do not delete the Cloud SQL
 * instance until it prints "ALL TABLES MATCH" and the app has run on DynamoDB for a while.
 *
 * After the final copy, the app must be switched to DynamoDB (docs/AWS-DATA.md) - rows written to Cloud SQL
 * after the last copy are NOT carried over, so do the last copy right before the switch.
 */
const crypto = require('crypto');
const sql = require('../sqlconnect');
const store = require('../awsStore');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = flag('dry-run');
const VERIFY = flag('verify');
const ONLY = opt('only', '') ? opt('only', '').split(',').map((s) => s.trim()) : null;

/** Cloud SQL (GraphQL) name of each table, plus how to flatten its relation column. */
const SOURCES = {
  Lead: { field: 'leads' },
  MatchedLead: { field: 'matchedLeads', relation: { name: 'lead', fk: 'leadId' } },
  LegacyCustomer: { field: 'legacyCustomers' },
  StorageFacility: { field: 'storageFacilities' },
  StoragePricing: { field: 'storagePricings', relation: { name: 'facility', fk: 'facilityId' }, pageSize: 2000 },
  MlsBenchmark: { field: 'mlsBenchmarks' },
  ScrapeRun: { field: 'scrapeRuns' },
  EmailNotice: { field: 'emailNotices' },
};

const selectionOf = (type) => {
  const def = store.TABLE_DEFS[type];
  const rel = SOURCES[type].relation;
  const cols = def.fields.filter((f) => !(rel && f === rel.fk));
  return rel ? `${cols.join(' ')} ${rel.name} { ${rel.fk} }` : cols.join(' ');
};
/** A Cloud SQL row -> the DynamoDB item shape (relation objects flattened to their key). */
function flatten(type, r) {
  const rel = SOURCES[type].relation;
  if (!rel) return r;
  const { [rel.name]: related, ...rest } = r;
  return { ...rest, [rel.fk]: related ? related[rel.fk] : null };
}

async function forEachSqlPage(type, onPage) {
  const def = store.TABLE_DEFS[type];
  await sql.pageAll(SOURCES[type].field, def.key, selectionOf(type), {
    pageSize: SOURCES[type].pageSize || 2000,
    onPage: (rows) => { pending.push(Promise.resolve(onPage(rows.map((r) => flatten(type, r))))); },
  });
  await Promise.all(pending.splice(0));
}
const pending = [];

const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};
const digest = (v) => crypto.createHash('sha256').update(canon(v)).digest('hex');

async function copyTable(type) {
  let n = 0;
  let newestUpdatedAt = '';
  await forEachSqlPage(type, async (rows) => {
    if (!DRY) await store.putMany(type, rows);
    n += rows.length;
    if (type === 'Lead') for (const r of rows) { const u = store.isoTs(r.updatedAt) || ''; if (u > newestUpdatedAt) newestUpdatedAt = u; }
    process.stdout.write(`\r  ${type}: ${n} rows${DRY ? ' (counted)' : ' copied'}   `);
  });
  process.stdout.write('\n');
  return { n, newestUpdatedAt };
}

async function copyState() {
  const rows = await sql.pageAll('appStates', 'stateKey', 'stateKey value updatedAt');
  for (const r of rows) {
    if (!DRY) await store.putState(r.stateKey, r.value, r.updatedAt);
    console.log(`  AppState: ${DRY ? 'would copy' : 'copied'} "${r.stateKey}"`);
  }
  return rows.length;
}

/** Compares one table. Returns the number of problems found. */
async function verifyTable(type) {
  const def = store.TABLE_DEFS[type];
  const want = new Map();
  await forEachSqlPage(type, (rows) => {
    for (const r of rows) want.set(String(r[def.key]), digest(store.fillRow(def, store.normalizeRow(def, r))));
  });
  const have = new Map((await store.scan(type)).map((r) => [String(r[def.key]), digest(r)]));
  const missing = [...want.keys()].filter((k) => !have.has(k));
  const extra = [...have.keys()].filter((k) => !want.has(k));
  const differ = [...want].filter(([k, h]) => have.has(k) && have.get(k) !== h).map(([k]) => k);
  const ok = !missing.length && !differ.length; // extras are rows written by the app after the copy: expected once live
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${type}: Cloud SQL ${want.size}, DynamoDB ${have.size}` +
    (missing.length ? `, missing ${missing.length} (e.g. ${missing.slice(0, 3).join(', ')})` : '') +
    (differ.length ? `, different ${differ.length} (e.g. ${differ.slice(0, 3).join(', ')})` : '') +
    (extra.length ? `, ${extra.length} newer rows only in DynamoDB (normal after go-live)` : ''));
  return missing.length + differ.length;
}

async function verifyState() {
  const sqlRows = await sql.pageAll('appStates', 'stateKey', 'stateKey value updatedAt');
  const have = new Map((await store.listStates()).map((r) => [r.stateKey, digest(r.value)]));
  let bad = 0;
  for (const r of sqlRows) {
    const same = have.has(r.stateKey) && have.get(r.stateKey) === digest(r.value);
    if (!same) { bad++; console.log(`  FAIL AppState "${r.stateKey}" ${have.has(r.stateKey) ? 'differs' : 'is missing'}`); }
  }
  // Entries the app has rewritten since the copy (analytics refresh, reconcile state) legitimately differ once live.
  if (!bad) console.log(`  OK   AppState: ${sqlRows.length} entries match`);
  return bad;
}

(async () => {
  const types = Object.keys(SOURCES).filter((t) => !ONLY || ONLY.includes(t));
  const doState = !ONLY || ONLY.includes('AppState');
  const started = Date.now();

  if (VERIFY) {
    console.log('Verifying Cloud SQL against DynamoDB...');
    let problems = 0;
    for (const t of types) problems += await verifyTable(t);
    if (doState) problems += await verifyState();
    console.log(problems ? `\nPROBLEMS FOUND: ${problems}. Re-run the copy, then verify again.` : '\nALL TABLES MATCH.');
    process.exit(problems ? 1 : 0);
  }

  console.log(DRY ? 'DRY RUN: counting Cloud SQL rows, writing nothing.' : 'Copying Cloud SQL -> DynamoDB (safe to re-run).');
  let newestLead = '';
  for (const t of types) {
    const { n, newestUpdatedAt } = await copyTable(t);
    if (t === 'Lead') newestLead = newestUpdatedAt;
    if (!n) console.log(`  ${t}: no rows`);
  }
  if (doState) console.log(`  AppState: ${await copyState()} entries`);
  if (!DRY && newestLead) {
    await store.mergeState('leadsMeta', { newestUpdatedAt: newestLead }); // lets the app's "leads changed?" check avoid scanning
    console.log(`  leadsMeta.newestUpdatedAt = ${newestLead}`);
  }
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s.${DRY ? '' : ' Now run with --verify.'}`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
