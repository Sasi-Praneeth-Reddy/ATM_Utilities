// Map view logic test with a fake Firestore + fake geocoder (no network). Run: node test-mapview.js (from server/)
const assert = require('assert');
const mv = require('./mapview');
const store = new Map();
const fsdb = {
  collection: () => ({ doc: (id) => ({ id, set: async (d) => { store.set(id, d); } }) }),
  getAll: async (...refs) => refs.map((r) => ({ id: r.id, exists: store.has(r.id), data: () => store.get(r.id) })),
};
let calls = 0;
const geocode = async (a) => { calls++; return /nowhere/i.test(a) ? null : { lat: 39 + calls / 1000, lng: -77 }; };
const jobs = [
  { id: 'a', customer: 'A', type: 'local', date: '2026-11-10', endDate: '2026-11-10', startTime: '10:00', origin: '1 Main St #5, Sterling, VA', destination: '2 Oak Ave, Reston, VA', truckIds: ['t1'] },
  { id: 'b', customer: 'B', type: 'local', date: '2026-11-10', origin: '1 Main St Apt 9, Sterling, VA', destination: '', truckIds: [] },
  { id: 'c', customer: 'C', type: 'long_distance', date: '2026-11-08', endDate: '2026-11-12', origin: '9 Pine Rd, Dulles, VA', destination: '5 Beach Dr, Miami, FL', truckIds: ['t1'] },
  { id: 'd', customer: 'D', type: 'local', date: '2026-11-10', origin: '3 Nowhere Ln', destination: '', status: 'cancelled', truckIds: [] },
  { id: 'e', customer: 'E', type: 'local', date: '2026-11-10', origin: '3 Nowhere Ln', destination: '', truckIds: [] },
];
const db = { listJobsInRange: async () => jobs, getTrucksAndDrivers: async () => ({ trucks: [{ id: 't1', name: 'Truck 1', color: '#f00' }] }) };
(async () => {
  assert.strictEqual(mv.normalizeAddress('1 Main St #5, Sterling, VA'), mv.normalizeAddress('1 Main St Apt 9, Sterling, VA'));
  let r = await mv.buildMap(db, '2026-11-10', 'local', { fsdb, geocode });
  assert.deepStrictEqual(r.jobs.map((j) => j.id), ['a', 'b', 'e']);           // LD + cancelled excluded
  assert.strictEqual(calls, 4);  // warehouse, Main St (a & b share one lookup), Oak Ave, Nowhere
  assert.ok(r.warehouse.lat && r.jobs[0].origin.lat && r.jobs[1].origin.lat === r.jobs[0].origin.lat);
  assert.strictEqual(r.jobs[2].origin.lat, null); assert.strictEqual(r.unresolved.length, 1);
  assert.strictEqual(r.jobs[0].trucks[0].name, 'Truck 1');
  const before = calls;
  r = await mv.buildMap(db, '2026-11-10', 'local', { fsdb, geocode });
  assert.strictEqual(calls, before, 'second request must use the cache (incl. negative cache)');
  r = await mv.buildMap(db, '2026-11-11', 'ld', { fsdb, geocode });             // multi-day trip shows mid-span
  assert.deepStrictEqual(r.jobs.map((j) => j.id), ['c']);
  r = await mv.buildMap(db, '2026-11-13', 'ld', { fsdb, geocode });
  assert.strictEqual(r.jobs.length, 0);                                          // trip over
  store.clear();
  r = await mv.buildMap(db, '2026-11-10', 'local', { fsdb, geocode, maxLookups: 2 });
  assert.ok(r.pending > 0);                                                      // capped, asks to come back
  console.log('mapview OK');
})().catch((e) => { console.error(e); process.exit(1); });
