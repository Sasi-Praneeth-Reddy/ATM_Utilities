// Tasking logic test against an in-memory fake Firestore (no network, no credentials). Run: node test-tasking.js (from server/)
const Module = require('module');
const path = require('path');
const SRV = __dirname + '/';
// ---- in-memory Firestore mock ----
const store = {};
const calls = [];
let JOB_DETAILS = {};
const col = name => (store[name] = store[name] || new Map());
function snapOf(id, data) { return { id, exists: data !== undefined, data: () => data && JSON.parse(JSON.stringify(data)) }; }
function collection(name) {
  const mk = (filters) => ({
    where(f, op, v) { return mk([...filters, [f, op, v]]); },
    async get() {
      const docs = [...col(name)].filter(([, d]) => filters.every(([f, op, v]) => op === '>=' ? d[f] >= v : op === '<=' ? d[f] <= v : d[f] === v)).map(([id, d]) => snapOf(id, d));
      return { docs, forEach: fn => docs.forEach(fn), size: docs.length };
    },
  });
  return {
    ...mk([]),
    doc: id => ({
      async get() { return snapOf(id, col(name).get(id)); },
      async set(data, opts) { col(name).set(id, opts && opts.merge ? { ...(col(name).get(id) || {}), ...data } : data); },
    }),
  };
}
const fsdb = {
  collection,
  batch() { const ops = []; return { set: (ref, d, o) => ops.push([ref, d, o]), commit: async () => { for (const [r, d, o] of ops) await r.set(d, o); } }; },
  getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
};
const orig = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './firestore') return { db: fsdb };
  if (req === './smartmovingClient') return { getJobDetails: async (opp, job) => { calls.push([opp, job]); if (job === 'boom') throw new Error('500'); return JOB_DETAILS; } };
  if (req === './apiUsage') return { withApiSource: (s, f) => f(), getBudgetStatus: async () => ({ remaining: 500 }) };
  return orig.call(this, req, parent, ...rest);
};
const t = require(SRV + 'tasking.js');
const assert = require('assert');
const today = t.todayIso();
const plus = n => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const int = iso => Number(iso.replace(/-/g, ''));

(async () => {
  // summarize: deposit paid vs not, outstanding balance, docs
  const s1 = t.summarizeOpportunity({ id: 'o1', status: 4, serviceDate: int(plus(5)), customer: { id: 'c1', name: 'Ann', phoneNumber: '555' },
    payments: [{ amount: 100, paymentCategory: 'Deposit', isOutstanding: false }, { amount: 400, paymentCategory: 1, isOutstanding: true }],
    opportunityDocuments: [{ type: 7, isComplete: true }], estimatedTotal: { finalTotal: 500 }, customField01: 'PBO job' });
  assert.equal(s1.depositPaid, true); assert.equal(s1.balanceDue, 400); assert.equal(s1.paidTotal, 100);
  assert.equal(s1.estimatedTotal, 500); assert.equal(s1.pboHint, true); assert.equal(s1.estimateSigned, true); assert.equal(s1.serviceDate, plus(5));
  const s2 = t.summarizeOpportunity({ id: 'o2', status: 4, customer: { name: 'Bob' }, payments: [] });
  assert.equal(s2.depositPaid, false); assert.equal(s2.paidTotal, 0);
  const s3 = t.summarizeOpportunity({ id: 'o3', status: 3 });
  assert.equal(s3.financeAt, undefined, 'no payments array => no finance claim');
  console.log('summarize OK');

  // hooks
  await t.noteOpportunities([
    { id: 'u1', customerId: 'c9', customerName: 'Unsigned Ursula', status: 3, serviceDate: int(plus(10)), quoteNumber: '1001' },
    { id: 'p1', customerId: 'c8', customerName: 'NoDeposit Nate', status: 4, serviceDate: int(plus(3)) },
  ]);
  await t.recordOpportunityDetails({ id: 'p1', status: 4, serviceDate: int(plus(3)), customer: { id: 'c8', name: 'NoDeposit Nate' }, payments: [] });
  await t.recordOpportunityDetails({ id: 'd1', status: 10, serviceDate: int(plus(-10)), customer: { id: 'c7', name: 'Owes Olive' }, payments: [{ amount: 250, paymentCategory: 1, isOutstanding: true }] });
  await t.recordOpportunityDetails({ id: 'd2', status: 10, serviceDate: int(plus(-10)), customer: { id: 'c6', name: 'Paid Pat' }, payments: [{ amount: 250, paymentCategory: 1, isOutstanding: false }] });
  await t.recordOpportunityDetails({ id: 'o1', ...{ status: 4, serviceDate: int(plus(5)), customer: { id: 'c1', name: 'Ann', phoneNumber: '555' }, payments: [{ amount: 100, paymentCategory: 0, isOutstanding: false }] } });
  col('tasking_claims').set('k1', { id: 'k1', customerName: 'Claimant', status: 'InProgress', createdAtUtc: '2026-10-01' });
  col('tasking_claims').set('k2', { id: 'k2', customerName: 'Done', status: 'Completed' });

  // fake board db
  const jobs = [
    { id: 'J1', customer: 'Ann', date: today, startTime: '10:00', status: 'scheduled', smartMovingOpportunityId: 'o1', origin: 'A', destination: 'B', truckIds: ['T1'], truckDrivers: { T1: 'D1' } },
    { id: 'J2', customer: 'Early Ed', date: today, startTime: '08:00', status: 'scheduled', serviceCategoryLabel: 'Packing by owner' },
    { id: 'J3', customer: 'Cancelled Cy', date: today, startTime: '09:00', status: 'cancelled' },
    { id: 'JM', customer: '*REWEIGH*Garcia, Michael; HAFC0748880; AAFD-D; T1', date: plus(1), startTime: '07:00', status: 'scheduled' },
    { id: 'JN', customer: 'Normal Nina', date: plus(1), startTime: '09:00', status: 'scheduled' },
    { id: 'J4', customer: 'Later Lou', date: plus(4), startTime: '09:00', status: 'scheduled', notes: 'PBO please upsell' },
  ];
  const db = {
    listJobsInRange: async (a, b) => jobs.filter(j => j.date >= a && j.date <= b),
    getTrucksAndDrivers: async () => ({ trucks: [{ id: 'T1', name: 'Truck 1' }], drivers: [{ id: 'D1', name: 'Dan' }] }),
  };
  await t.updateJobState('J1', { callDone: true, dispatchNote: 'Gate code 1234', materials: [{ name: 'Boxes', qty: 20 }, { name: 'Tape', qty: 4, done: true }], crates: [{ label: 'Crate', qty: 3 }] }, 'me@x.com');
  await t.setDayState(today, { callOwner: 'erika' }, 'me@x.com');
  const sum = await t.buildSummary(db, today);
  assert.deepEqual(sum.calls.map(c => c.customer), ['Early Ed', 'Ann'], 'sorted by time, cancelled hidden');
  assert.equal(sum.calls[1].callDone, true); assert.equal(sum.calls[1].phone, '555'); assert.equal(sum.calls[0].assignee, 'erika');
  assert.deepEqual(sum.pbo.map(p => p.customer).sort(), ['Early Ed', 'Later Lou']);
  const ns = Object.fromEntries(sum.notSecured.map(n => [n.customer, n.reasons[0]]));
  assert.equal(ns['Unsigned Ursula'], 'Not checked yet'); assert.equal(ns['NoDeposit Nate'], 'No deposit paid'); assert.equal(ns['Ann'], undefined, 'deposit paid => secured');
  assert.equal(sum.notSecured[0].customer, 'NoDeposit Nate', 'soonest first');
  assert.deepEqual(sum.unpaidCompleted.map(u => [u.customer, u.balanceDue]), [['Owes Olive', 250]]);
  assert.deepEqual(sum.claims.map(c => c.customer), ['Claimant']);
  console.log('summary OK');

  const disp = await t.buildDispatch(db, today);
  assert.equal(disp.jobs.length, 2); const j1 = disp.jobs.find(j => j.jobId === 'J1');
  assert.equal(j1.trucks[0].name, 'Truck 1'); assert.equal(j1.trucks[0].driver, 'Dan'); assert.equal(j1.dispatchNote, 'Gate code 1234');
  assert.equal(j1.materials[1].done, true); assert.ok(j1.materials[1].doneBy);
  const mail = t.renderAssignmentsEmail(disp);
  assert.ok(mail.text.includes('Gate code 1234') && mail.text.includes('20× Boxes') && !mail.text.includes('Tape'), 'done materials omitted');
  assert.ok(mail.html.includes('Truck 1 (Dan)'));
  console.log('dispatch + email OK');

  // materials done-stamp is sticky, update validation
  const st = await t.updateJobState('J1', { materials: [{ id: j1.materials[1].id, name: 'Tape', qty: 4, done: true }], upsellStatus: 'bogus', callAssignee: 'crew' }, 'other@x.com');
  assert.equal(st.materials[0].doneBy, 'me@x.com'); assert.equal(st.upsellStatus, null);
  console.log('state OK');

  // ---- SmartMoving job-detail import (dispatch notes + materials + crates) ----
  const parsed = t.parseJobDetails({
    notes: 'Piano on 2nd floor', estimatedMaterials: [
      { id: 'm1', name: 'Medium box', materialsQuantity: 30 }, { id: 'm2', name: 'Wardrobe', materialsQuantity: 2 },
      { id: 'm3', name: 'Plastic crate', materialsQuantity: 12, isContainer: true }, { id: 'm4', name: 'Unused', materialsQuantity: 0 }],
    stops: [{ address: '1 Main St', notes: 'Park on side street' }, { address: '2 Oak', notes: '' }] });
  assert.deepEqual(parsed.materials.map(m => [m.name, m.qty]), [['Medium box', 30], ['Wardrobe', 2]]);
  assert.deepEqual(parsed.crates.map(c => [c.name, c.qty]), [['Plastic crate', 12]]);
  assert.equal(parsed.notes, 'Piano on 2nd floor'); assert.equal(parsed.stopNotes.length, 1);
  assert.equal(t.parseJobDetails({ actualMaterials: { items: [{ name: 'Tape', materialsQuantity: 5 }] } }).materials[0].name, 'Tape', 'falls back to actualMaterials / unwraps objects');

  // office adds a manual item, ticks an SM item, then SM data changes and is re-imported
  const imp1 = await t.applyJobImport('J2', parsed);
  await t.updateJobState('J2', { materials: [...imp1.materials.map(m => (m.name === 'Medium box' ? { ...m, done: true } : m)), { name: 'Dolly (manual)', qty: 1 }] }, 'ed@x.com');
  const imp2 = await t.applyJobImport('J2', t.parseJobDetails({ estimatedMaterials: [{ id: 'm1', name: 'Medium box', materialsQuantity: 40 }, { id: 'm9', name: 'Mattress bag', materialsQuantity: 3 }] }));
  const byName = Object.fromEntries(imp2.materials.map(m => [m.name, m]));
  assert.equal(byName['Medium box'].qty, 40, 'SM quantity updated'); assert.equal(byName['Medium box'].done, true, 'done state kept');
  assert.equal(byName['Medium box'].doneBy, 'ed@x.com'); assert.ok(byName['Mattress bag'] && byName['Dolly (manual)'], 'new SM + manual items present');
  assert.equal(byName['Wardrobe'], undefined, 'SM item removed in SM disappears'); assert.equal(imp2.crates.length, 0, 'removed crate gone');
  const stAfter = await t.updateJobState('J2', { materials: imp2.materials.map(m => ({ ...m, source: 'manual-hack' })) }, 'ed@x.com');
  assert.equal(stAfter.materials.find(m => m.name === 'Mattress bag').source, 'sm', 'client cannot change source');
  assert.equal(stAfter.materials.find(m => m.name === 'Dolly (manual)').source, undefined, 'client cannot claim sm source');
  console.log('import merge OK');

  // refreshJobDetails: only SM-linked jobs, skips fresh ones, counts failures
  jobs.push({ id: 'J5', customer: 'SM Sam', date: today, startTime: '12:00', status: 'scheduled', smartMovingOpportunityId: 'oS', smartMovingJobId: 'jS' });
  jobs.push({ id: 'J6', customer: 'Boom Bo', date: today, startTime: '13:00', status: 'scheduled', smartMovingOpportunityId: 'oB', smartMovingJobId: 'boom' });
  JOB_DETAILS = { notes: 'Elevator booked 1-3pm', estimatedMaterials: [{ name: 'Large box', materialsQuantity: 10 }] };
  let r = await t.refreshJobDetails({ db, from: today, to: today, max: 10 });
  assert.equal(r.jobsOnDays, 2, 'only jobs with SM ids'); assert.equal(r.imported, 1); assert.equal(r.failed, 1);
  const calls1 = calls.length; r = await t.refreshJobDetails({ db, from: today, to: today, max: 10 });
  assert.equal(calls.length, calls1 + 1, 'fresh import skipped; only the failed one retried');
  r = await t.refreshJobDetails({ db, from: today, to: today, max: 10, force: true });
  assert.equal(r.attempted, 2, 'force re-imports');
  const d2 = await t.buildDispatch(db, today); const sam = d2.jobs.find(j => j.jobId === 'J5');
  assert.equal(sam.smNotes, 'Elevator booked 1-3pm'); assert.equal(sam.materials[0].source, 'sm'); assert.equal(sam.hasSmartMovingJob, true);
  assert.ok(t.renderAssignmentsEmail(d2).text.includes('SmartMoving notes: Elevator booked'));
  console.log('refreshJobDetails OK');
  // ---- calendar notes + materials (the real source) ----
  const DESC = ['24502-1 / Long Distance Moving / ATM 4500#','-------------------------------------------------','From: Affiliate Carmack','-------------------------------------------------','Origin: 13100 Pavilion Ln','-------------------------------------------------',
    'Dispatch notes: ','Internal notes: 10.07.2026 | Blair | HQ91094','2 of our guys and Felipe','Crew notes: USE CARMACK PAPERWORK as best you can.','Robert Blair - 571-970-8802','Materials: 2 dishpacks; 4 wardrobes; 1 white paper; 2 tapes; 3 crates','Small Pack and Unpack',
    'Customer notes: USE CARMACK PAPERWORK as best you can.','Robert Blair - 571-970-8802','Materials: 2 dishpacks; 4 wardrobes; 1 white paper; 2 tapes; 3 crates','Small Pack and Unpack',
    '-------------------------------------------------','Quoted: 1 trucks, 4 crew'].join('\n');
  const pc = t.parseCalendarNotes(DESC);
  assert.deepEqual(pc.materials.map(m => m.name + ':' + m.qty), ['dishpacks:2', 'wardrobes:4', 'white paper:1', 'tapes:2']);
  assert.deepEqual(pc.crates.map(m => m.name + ':' + m.qty), ['crates:3']);
  assert.ok(pc.notes.includes('Internal: 10.07.2026 | Blair | HQ91094\n2 of our guys and Felipe'), 'multi-line internal note kept');
  assert.ok(pc.notes.includes('Small Pack and Unpack') && !pc.notes.includes('Customer:'), 'customer block dropped when it repeats crew notes');
  assert.equal(pc.sections.internal, '10.07.2026 | Blair | HQ91094\n2 of our guys and Felipe', 'internal section kept on its own');
  assert.ok(pc.sections.crew.startsWith('USE CARMACK') && pc.sections.customer === pc.sections.crew, 'crew and customer sections each keep their own text');
  assert.equal(pc.sections.dispatch, ''); assert.equal(pc.sections.crewFeedback, '');
  const pf = t.parseCalendarNotes(['x', '----------', 'Dispatch notes: gate 1234', 'Crew feedback: stairs were tight', 'Customer notes: call first'].join('\n'));
  assert.equal(pf.sections.crewFeedback, 'stairs were tight'); assert.equal(pf.sections.dispatch, 'gate 1234'); assert.equal(pf.sections.customer, 'call first');
  assert.equal(t.parseCalendarNotes('garbage').materials.length, 0);
  const today2 = t.todayIso();
  const items = [{ jobId: 'SM-24502', date: today2, description: DESC }, { jobId: 'SM-OLD', date: '2020-01-01', description: DESC }];
  assert.equal(await t.recordCalendarNotes(items), 1, 'old job ignored');
  assert.equal(await t.recordCalendarNotes(items), 0, 'unchanged -> no rewrite');
  const cst = (await t.getJobStates(['SM-24502'])).get('SM-24502');
  assert.equal((cst.materials || []).length, 0, 'materials are not imported from notes'); assert.ok(cst.smNotes.includes('Crew: USE CARMACK')); assert.ok(cst.smNoteSections.crew.startsWith('USE CARMACK'), 'sections saved on the job');
  console.log('calendar notes OK');
  // ---- materials report ----
  const { parseMaterialsReport } = require(SRV + 'materialsReport');
  const rep = parseMaterialsReport(require('fs').readFileSync(SRV + 'test-fixtures/job-materials-sample.xlsx'));
  assert.ok(Object.keys(rep.byJob).length >= 10, 'parsed jobs');
  const upcoming = Object.entries(rep.byJob).filter(([, j]) => j.date >= '2026-11-01' && j.date <= '2026-11-30');
  assert.ok(upcoming.length >= 5 && /^SM-\d+-\d+$/.test(upcoming[0][0]));
  const crateJob = Object.entries(rep.byJob).find(([, j]) => j.items.some(i => i.crate));
  assert.ok(crateJob, 'crate item detected by name');
  assert.throws(() => parseMaterialsReport(Buffer.from('a,b\n1,2', 'utf8')), /missing column/);
  // apply to board jobs: fake board with the fixture's jobs on their dates
  const mjobs = Object.entries(rep.byJob).map(([id, j]) => ({ id, date: j.date, customer: id }));
  const fixedToday = '2026-11-05';
  const mdb = { listJobsInRange: async (a, b) => mjobs.filter(j => j.date >= a && j.date <= b) };
  const inWin = mjobs.filter(j => j.date >= '2026-11-04' && j.date <= '2026-12-03');
  let mr = await t.applyMaterialsReport({ db: mdb, byJob: rep.byJob, today: fixedToday });
  assert.equal(mr.updated, inWin.filter(j => rep.byJob[j.id].items.length).length); assert.equal(mr.failed, 0);
  assert.equal((await t.applyMaterialsReport({ db: mdb, byJob: rep.byJob, today: fixedToday })).updated, 0, 'unchanged -> no rewrite');
  const target = inWin.find(j => rep.byJob[j.id].items.some(i => !i.crate));
  const ts = (await t.getJobStates([target.id])).get(target.id);
  assert.ok(ts.materials.length && ts.materials.every(m => m.source === 'sm' && m.done === false));
  // a hand-typed row and a done tick survive a changed report; a job removed from the report loses its sm rows
  await t.updateJobState(target.id, { materials: [{ id: 'm-hand', name: 'Hand item', qty: 2, done: false }, ...ts.materials.map((m, i) => (i === 0 ? { ...m, done: true } : m))] }, 'x@y');
  const changed = JSON.parse(JSON.stringify(rep.byJob)); changed[target.id].items[0].qty += 1;
  await t.applyMaterialsReport({ db: mdb, byJob: changed, today: fixedToday });
  const ts2 = (await t.getJobStates([target.id])).get(target.id);
  assert.ok(ts2.materials.some(m => m.id === 'm-hand'), 'hand-typed kept');
  assert.equal(ts2.materials.find(m => m.id === ts.materials[0].id).qty, ts.materials[0].qty + 1);
  const removed = { ...changed }; delete removed[target.id];
  mr = await t.applyMaterialsReport({ db: mdb, byJob: removed, today: fixedToday });
  const ts3 = (await t.getJobStates([target.id])).get(target.id);
  assert.ok(mr.cleared >= 1 && ts3.materials.every(m => m.source !== 'sm') && ts3.materials.some(m => m.id === 'm-hand'));
  console.log('materials report OK');
  // ---- call list skips military jobs ----
  const msum = await t.buildSummary(db, plus(1));
  assert.deepEqual(msum.calls.map(c => c.jobId), ['JN'], 'military job not on the call list');
  assert.equal(msum.callsMilitaryHidden, 1); assert.equal(msum.calls[0].ownAssignee, false);
  await t.recordOpportunityDetails({ id: 'mil1', status: 4, serviceDate: int(plus(3)), customer: { id: 'cm', name: 'Garcia, Michael; HAFC0748880; AAFD-D; T1' }, payments: [] });
  await t.recordOpportunityDetails({ id: 'mil2', status: 10, serviceDate: int(plus(-5)), customer: { id: 'cm2', name: 'Hall, Joshua; BGAC0722747; DCEV-D; Dice' }, payments: [{ amount: 900, paymentCategory: 1, isOutstanding: true }] });
  const msum2 = await t.buildSummary(db, today);
  assert.ok(![...msum2.notSecured, ...msum2.unpaidCompleted].some(x => /Garcia|Hall, Joshua/.test(x.customer)), 'military excluded from not-secured and unpaid');
  // a signed estimate with no deposit is listed for the deposit only; unsigned + no deposit lists both; signed + paid is secured
  const docs = (done) => [{ type: 7, isComplete: done }];
  await t.recordOpportunityDetails({ id: 'sg1', status: 3, serviceDate: int(plus(3)), customer: { id: 'sg', name: 'Signed Sam' }, payments: [], opportunityDocuments: docs(true) });
  await t.recordOpportunityDetails({ id: 'sg2', status: 3, serviceDate: int(plus(4)), customer: { id: 'sg2c', name: 'Unsigned Uma' }, payments: [], opportunityDocuments: docs(false) });
  await t.recordOpportunityDetails({ id: 'sg3', status: 3, serviceDate: int(plus(5)), customer: { id: 'sg3c', name: 'Paid Pia' }, payments: [{ amount: 100, paymentCategory: 0, isOutstanding: false }], opportunityDocuments: docs(true) });
  const ns2 = Object.fromEntries((await t.buildSummary(db, today)).notSecured.map(n => [n.customer, n.reasons]));
  assert.deepEqual(ns2['Signed Sam'], ['No deposit paid']);
  assert.deepEqual(ns2['Unsigned Uma'], ['Estimate not signed', 'No deposit paid']);
  assert.equal(ns2['Paid Pia'], undefined);
  console.log('call list military filter OK');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
