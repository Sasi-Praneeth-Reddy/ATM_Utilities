// Tests for the DynamoDB data layer (awsStore.js) and the Leads / Storage code that sits on it.
// Runs against dynalite, an in-process DynamoDB emulator: no network, no AWS account, nothing real is touched.
//   cd server && npm install && node test-aws-store.js
const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');

const PORT = 4600 + Math.floor(Math.random() * 300);
process.env.ATM_DYNAMODB_ENDPOINT = `http://127.0.0.1:${PORT}`;
process.env.ATM_DDB_PREFIX = 'test-';

// leadsDb reads the Firestore `jobs` collection (read-only) to find past customers; give it a fake one.
const jobsDocs = [];
const fakeFs = { collection: () => ({ get: async () => ({ docs: jobsDocs.map((j) => ({ data: () => j })) }) }) };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../firestore' && parent && /leadsDb\.js$/.test(parent.filename)) return { db: fakeFs };
  return origLoad.call(this, request, parent, isMain);
};

const dynalite = require('dynalite');
const store = require('./awsStore');

const ok = (name) => console.log(`  ok  ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = dynalite({ createTableMs: 0 });
  await new Promise((res) => server.listen(PORT, res));
  await store.createTablesIfMissing();

  /* ---------- awsStore ---------- */
  await store.upsertMany('Lead', [{ leadId: 'L1', address: '1 A St', status: 'for_sale', isVacant: false, listPrice: 500000, firstName: 'Pat', listedDate: '2026-10-01T05:00:00Z' }]);
  await store.upsertMany('Lead', [{ leadId: 'L1', address: '1 A St', status: 'pending', isVacant: false, listPrice: null }]);
  const l1 = await store.getItem('Lead', 'L1');
  assert.equal(l1.firstName, 'Pat', 'a column that is not sent must be kept');
  assert.equal(l1.status, 'pending'); assert.equal(l1.listPrice, null, 'an explicit null overwrites');
  assert.equal(l1.phone, null, 'never-set fields come back as null, like SQL');
  assert.equal(l1.listedDate, '2026-10-01', 'dates are stored as YYYY-MM-DD');
  assert.ok(l1.createdAt, 'createdAt set on first insert');
  assert.equal(await store.getItem('Lead', 'nope'), null);
  ok('upsert merges, nulls, date normalising');

  await store.upsertMany('Lead', [{ leadId: 'L2', address: '2 B St', status: 'for_sale', isVacant: true, updatedAt: '2026-11-01T00:00:00Z' }, { leadId: 'L3', address: '3 C St', status: 'closed', isVacant: false, updatedAt: '2026-11-10T00:00:00Z' }]);
  assert.equal(await store.count('Lead'), 3);
  assert.deepEqual((await store.scan('Lead')).map((r) => r.leadId), ['L1', 'L2', 'L3'], 'scan returns key order');
  assert.deepEqual((await store.scan('Lead', { filter: store.gt('updatedAt', '2026-11-05T00:00:00.000Z') })).map((r) => r.leadId), ['L3']);
  assert.deepEqual((await store.scan('Lead', { filter: store.eq('status', 'closed'), project: ['leadId', 'status'] })), [{ leadId: 'L3', status: 'closed' }]);
  assert.equal((await store.getMany('Lead', ['L1', 'L3', 'missing'])).length, 2);
  const many = Array.from({ length: 230 }, (_, i) => ({ leadId: `B${String(i).padStart(3, '0')}`, address: `${i} Bulk Rd`, status: 'for_sale', isVacant: false }));
  assert.equal(await store.upsertMany('Lead', many), 230);
  assert.equal((await store.getMany('Lead', many.map((r) => r.leadId))).length, 230, 'batch get/write across chunk limits');
  assert.equal(await store.count('Lead'), 233);
  ok('scan / filter / project / count / batch');

  await store.update('Lead', 'L2', { status: 'pending', notes: undefined });
  assert.equal((await store.getItem('Lead', 'L2')).status, 'pending');
  await assert.rejects(() => store.update('Lead', 'ghost', { status: 'x' }), /Not found/);
  assert.equal(await store.deleteAll('Lead'), 233); assert.equal(await store.count('Lead'), 0);
  ok('update / not-found / deleteAll');

  assert.equal(await store.getState('k'), null);
  await store.setState('k', { a: 1 }); await store.mergeState('k', { b: 2 });
  assert.deepEqual(await store.getState('k'), { a: 1, b: 2 });
  const big = { rows: Array.from({ length: 9000 }, (_, i) => ({ id: i, name: `Facility number ${i}`, city: 'Fairfax', rate: i % 97 })) };
  assert.ok(JSON.stringify(big).length > 400 * 1024, 'test value is over the 400 KB item limit raw');
  await store.setState('big', big); assert.deepEqual(await store.getState('big'), big);
  await assert.rejects(() => store.setState('huge', { blob: crypto.randomBytes(600 * 1024).toString('hex') }), /too large|limited/);
  assert.equal((await store.listStates()).length, 2);
  await store.deleteState('k'); assert.equal(await store.getState('k'), null);
  ok('app state: roundtrip, merge, >400 KB value, too-big guard, delete');

  /* ---------- Leads ---------- */
  const leads = require('./leads/leadsDb');
  jobsDocs.push({ id: 'J1', origin: '10 Old Rd', destination: '22 Maple Ln', destinationZip: '22030', originZip: '20147', date: '2025-06-01', customer: 'Sam Customer' });
  const r1 = await leads.upsertPreMoverLeads([
    { address: '22 Maple Ln', zip_code: '22030', city: 'Fairfax', state: 'VA', status: 'for_sale', list_price: 700000, county: 'Fairfax' },
    { address: '5 Other St', zip_code: '20147', city: 'Ashburn', state: 'VA', status: 'for_sale', county: 'Loudoun' },
  ]);
  assert.equal(r1.total, 2); assert.equal(r1.newMatches, 1, 'the past customer address is matched on ingest');
  const stored = await store.scan('Lead');
  const maple = stored.find((l) => l.address === '22 Maple Ln');
  await store.upsertMany('Lead', [{ leadId: maple.leadId, firstName: 'Owner', phone: '555-0100' }]);
  let matches = await leads.listMatchedLeads();
  assert.equal(matches.length, 1); assert.equal(matches[0].status, 'pending'); assert.equal(matches[0].leadId, maple.leadId);
  assert.equal(matches[0].customerName, 'Sam Customer');
  const mid = matches[0].id;
  ok('ingest + automatic match');

  await leads.updateMatchedLeadStatus(mid, 'contacted', 'called him');
  await leads.recordOutreach(mid, { type: 'email', to: 'sam@example.com' });
  const m1 = await leads.listMatchedLeads('contacted');
  assert.equal(m1.length, 1); assert.equal(m1[0].notes, 'called him'); assert.equal(m1[0].outreachHistory.length, 1);
  assert.equal((await leads.listMatchedLeads('pending')).length, 0);
  await assert.rejects(() => leads.updateMatchedLeadStatus('nope', 'x'), /Match not found/);
  ok('match status, notes, outreach history');

  const firstListed = (await store.getItem('Lead', maple.leadId)).listedDate;
  const r2 = await leads.upsertPreMoverLeads([{ address: '22 Maple Ln', zip_code: '22030', city: 'Fairfax', state: 'VA', status: 'pending', list_price: 690000, county: 'Fairfax' }]);
  const maple2 = await store.getItem('Lead', maple.leadId);
  assert.equal(r2.newMatches, 0, 're-ingest creates no duplicate match');
  assert.equal(maple2.previousStatus, 'for_sale', 'status change history kept'); assert.equal(maple2.status, 'pending');
  assert.equal(maple2.listedDate, firstListed, 're-upload does not reset the listing date');
  assert.equal(maple2.firstName, 'Owner', 'contact fields added later survive a re-upload');
  const still = await leads.listMatchedLeads('contacted');
  assert.equal(still.length, 1, 'staff status survives re-matching'); assert.equal(still[0].outreachHistory.length, 1);
  ok('re-ingest keeps dates, contact fields, staff status');

  const list = await leads.listPreMoverLeads({ status: 'pending' });
  assert.equal(list.total, 1);
  const summary = await leads.getLeadsSummary();
  assert.equal(summary.totalListings, 2); assert.equal(summary.totalMatches, 1); assert.equal(summary.contactedMatches, 1);
  const a1 = await leads.getLeadsAnalytics({ refresh: true });
  assert.ok(a1 && a1.computedAt);
  await sleep(15);
  const a2 = await leads.getLeadsAnalytics();
  assert.equal(a2.computedAt, a1.computedAt, 'stored analytics are reused');
  await sleep(15);
  await leads.upsertPreMoverLeads([{ address: '9 New Ct', zip_code: '20147', city: 'Ashburn', state: 'VA', status: 'for_sale', county: 'Loudoun' }]);
  const a3 = await leads.getLeadsAnalytics();
  assert.notEqual(a3.computedAt, a1.computedAt, 'an ingest makes the stored analytics stale, so they are recomputed');
  ok('list, summary, analytics freshness');

  assert.equal((await leads.importLegacyCustomers([{ name: 'Legacy Lee', destinationAddress: '5 Other St', zip: '20147' }])).imported, 1);
  assert.equal((await leads.listLegacyCustomers()).length, 1);
  assert.equal((await leads.listMatchedLeads()).length, 2, 'legacy customer matched to a listing');
  ok('legacy customers');

  /* ---------- Storage ---------- */
  const stor = require('./storage/storageDb');
  assert.equal((await stor.upsertFacilities([
    { googlePlaceId: 'F1', name: 'Store One', brand: 'Public Storage', city: 'Fairfax', state: 'VA', zipCode: '22030', lat: 38.8, lon: -77.3 },
    { googlePlaceId: 'F2', name: 'Store Two', brand: 'Extra Space', city: 'Fairfax', state: 'VA', zipCode: '22031' },
  ])).count, 2);
  assert.equal((await stor.getFacilities()).length, 2); assert.equal((await stor.getFacility('F1')).brand, 'Public Storage');
  assert.equal((await stor.getFacilities({ brand: 'Extra Space' })).length, 1);
  const T0 = Date.now(); // one fixed base time, so day(0) is the same instant everywhere it is used
  const day = (n) => new Date(T0 - n * 86400000).toISOString();
  const snaps = [
    { facilityId: 'F1', unitSize: '10x10', streetRate: 200, webRate: 150, scrapedAt: day(0), snapshotKey: 'k0' },
    { facilityId: 'F1', unitSize: '10x10', streetRate: 205, webRate: 160, scrapedAt: day(1), snapshotKey: 'k1' },
    { facilityId: 'F1', unitSize: '10x10', webRate: 170, scrapedAt: day(40), snapshotKey: 'k40' },
    { facilityId: 'F2', unitSize: '10x10', webRate: 120, scrapedAt: day(0), snapshotKey: 'k2' },
    { facilityId: 'F9', unitSize: '10x10', webRate: 99, scrapedAt: day(0), snapshotKey: 'kx' },
  ];
  const ins = await stor.insertPricingSnapshots(snaps);
  assert.equal(ins.count, 4); assert.equal(ins.skipped, 1, 'unknown facility skipped');
  await stor.insertPricingSnapshots(snaps);
  assert.equal(await store.count('StoragePricing'), 4, 'same snapshotKey = same row (idempotent)');
  ok('facilities + pricing snapshots');

  const hist = await stor.getPricingHistory('F1', '10x10', 30);
  assert.deepEqual(hist.map((h) => h.webRate), [160, 150], 'history: last 30 days, oldest first, 40-day-old row excluded');
  assert.equal((await stor.getPricingHistory('F1', '10x10', 60)).length, 3);
  assert.equal(await store.newestPricingAt(), store.isoTs(day(0)));
  const sum = await stor.refreshStorageSummary();
  assert.equal(sum.totalFacilities, 2); assert.equal(sum.activeSnapshots, 3, 'summary reads only the last 30 days');
  assert.equal(sum.avgRates['10x10'], 135, 'average of the latest cheapest rate per facility: (150 + 120) / 2');
  assert.equal(sum.latestPricing.length, 2);
  const f1 = sum.latestPricing.find((r) => r.facilityId === 'F1'); assert.equal(f1.webRate, 150); assert.equal(f1.streetRate, 200);
  assert.equal((await stor.getLatestPricing({ facilityId: 'F2' }))[0].webRate, 120);
  assert.equal((await stor.getStorageKpis()).totalFacilities, 2);
  const ch = await stor.getCityHistory({ city: 'Fairfax', state: 'VA', unitSize: '10x10' });
  assert.equal(ch.length, 1); assert.equal(ch[0].avg, 135);
  assert.equal((await stor.getMarketShare()).length, 2);
  ok('price history, summary, KPIs, city history, market share');

  await stor.upsertMlsBenchmarks([{ source: 'NVAR', region: 'Northern Virginia', periodDate: '2026-09-01', year: 2026, month: 9, activeListings: 10, medianClosePrice: 650000 }]);
  await stor.upsertMlsBenchmarks([{ source: 'NVAR', region: 'Northern Virginia', periodDate: '2026-09-01', year: 2026, month: 9, activeListings: 11, medianClosePrice: 650000 }]);
  const bm = await stor.getMlsBenchmarks();
  assert.equal(bm.length, 1); assert.equal(bm[0].activeListings, 11); assert.equal(bm[0].periodDate, '2026-09-01'); assert.ok(bm[0].id);
  ok('MLS benchmarks');

  await server.close();
  console.log('\nAll DynamoDB data-layer tests passed.');
  process.exit(0);
})().catch((e) => { console.error('\nTEST FAILED:', e); process.exit(1); });
