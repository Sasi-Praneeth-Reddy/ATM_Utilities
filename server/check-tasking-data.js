/**
 * READ-ONLY check: pulls real SmartMoving data and prints what the Tasking module would conclude
 * from it, so you can confirm the field names/meanings BEFORE deploying. Writes nothing to Firestore
 * (its SmartMoving calls are not added to the app's daily usage counter — about 15 calls per run).
 *
 * Run from server/ on a machine that has SMARTMOVING_API_KEY in server/.env (or the environment):
 *   node check-tasking-data.js                      samples a few real opportunities automatically
 *   node check-tasking-data.js <opportunityId> ...  checks specific opportunities
 *   node check-tasking-data.js --days 45            widen the sampling window (default 30 days each way)
 *
 * Costs roughly: 1-3 calls for the customer listing + 1 per opportunity (max 9) + 1 per customer for
 * claims (max 3). Look for the lines marked  !!  — those are things that need a code change.
 * See docs/TASKING.md.
 */
require('./load-env');
// This check must work with no Firestore credentials: stub the database and the usage counter so
// nothing tries to reach Firestore (calls made here therefore don't show in the daily API-usage count).
const Module = require('module');
const _load = Module._load;
Module._load = function (request, ...rest) {
  if (request === './firestore') return { db: { collection: () => ({}) } };
  if (request === './apiUsage') return { recordApiCall: async () => {}, withApiSource: (s, f) => f(), getBudgetStatus: async () => null };
  return _load.call(this, request, ...rest);
};
const sm = require('./smartmovingClient');
const tasking = require('./tasking');
const { smartMovingIntDateToIso } = require('./mapJobs');

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const DAYS = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 30 : 30;
const ids = args.filter((a, i) => !a.startsWith('--') && !(daysIdx >= 0 && i === daysIdx + 1));

const KNOWN_PAY_CAT = new Set(['0', '1', '2', 'Deposit', 'BalanceDue', 'Other']);
const KNOWN_DOC_TYPE = new Set(['0', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'PrintOnly', 'Contract', 'Addendum', 'Estimate', 'Invoice', 'WorkOrder', 'DescriptiveInventory', 'CarrierInvoice', 'TripPlanning', 'WarehouseRelease', 'CardAuthorizationAgreement', 'PaymentAuthorizationTerms']);
const STATUS = { 3: 'Opportunity', 4: 'Booked', 10: 'Completed' };

const ymd = (offset) => {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
};
const flag = (ok, good, bad) => (ok ? `   ok  ${good}` : `   !!  ${bad}`);
const out = (...l) => console.log(...l);

/** Finds any field anywhere in the response whose name hints at money owed/paid (to discover a "deposit required" field). */
function findMoneyKeys(obj, path = '', hits = []) {
  if (!obj || typeof obj !== 'object' || hits.length > 40) return hits;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (/deposit|balance|owed|amountdue|due|paid|outstanding/i.test(k) && (typeof v !== 'object' || v === null)) hits.push(`${p} = ${JSON.stringify(v)}`);
    if (k === 'payments') continue; // rows are printed separately
    if (v && typeof v === 'object') findMoneyKeys(v, Array.isArray(obj) ? `${path}[]` : p, hits);
  }
  return hits;
}

async function checkOpportunity(id) {
  let o;
  try { o = await sm.getOpportunityFinance(id); } catch (err) { out(`\n=== ${id}\n   !!  fetch failed: ${err.message}`); return null; }
  const s = tasking.summarizeOpportunity(o);
  out(`\n=== ${s.customerName || '(no name)'}  #${s.quoteNumber ?? '?'}  ${s.statusLabel}  service ${s.serviceDate || '(none)'}  [${id}]`);
  out('   top-level fields:', Object.keys(o).join(', '));
  out(flag(Boolean(s.phone), `phone: ${s.phone}`, 'no customer phone number returned (call list will show "—")'));

  if (!Array.isArray(o.payments)) out('   !!  no "payments" array in the response — finance can not be computed');
  else {
    out(`   payments (${o.payments.length}):`);
    o.payments.forEach(p => {
      const known = KNOWN_PAY_CAT.has(String(p.paymentCategory));
      out(`     amount=${p.amount} category=${JSON.stringify(p.paymentCategory)} isOutstanding=${p.isOutstanding} paidAt=${p.paidAtUtc || '-'} refunded=${p.amountRefunded || 0}${known ? '' : '   !! unrecognised category value'}`);
    });
    out(`   -> depositPaid=${s.depositPaid}  paidTotal=${s.paidTotal}  balanceDue(outstanding)=${s.balanceDue}`);
    out('      CHECK BY HAND: do these match what SmartMoving shows for this customer? (isOutstanding = owed, not yet paid)');
  }

  if (!Array.isArray(o.opportunityDocuments)) out('   !!  no "opportunityDocuments" array — estimate sent/signed can not be known');
  else {
    out(`   documents (${o.opportunityDocuments.length}): ` + (o.opportunityDocuments.map(d => `${JSON.stringify(d.type)}${d.isComplete ? '✓' : ''}`).join(', ') || '(none)'));
    const unk = o.opportunityDocuments.filter(d => !KNOWN_DOC_TYPE.has(String(d.type)));
    if (unk.length) out(`   !!  unrecognised document type values: ${unk.map(d => JSON.stringify(d.type)).join(', ')}`);
    out(`   -> estimateSent=${s.estimateSent}  estimateSigned=${s.estimateSigned}`);
  }

  out(`   estimatedTotal raw: ${JSON.stringify(o.estimatedTotal)}  -> parsed: ${s.estimatedTotal}`);
  out(flag(s.estimatedTotal !== undefined && s.estimatedTotal !== null, 'estimated total understood', 'estimatedTotal could not be parsed to a number'));
  out(`   tasks: ${Array.isArray(o.tasks) ? o.tasks.length : 'not returned'}   PBO text hint: ${s.pboHint}   custom fields: ${[o.customField01, o.customField02, o.customField03].filter(Boolean).join(' | ') || '(empty)'}`);
  // Dispatch notes + materials (Premium job detail), for the first job on this opportunity
  const job0 = (o.jobs || [])[0];
  if (job0 && job0.id) {
    try {
      const jd = await sm.getJobDetails(id, job0.id, { includeStops: true, includeDispatchInfo: false });
      const parsed = tasking.parseJobDetails(jd);
      const rawMats = [].concat(jd.estimatedMaterials || [], jd.actualMaterials || []);
      out(`   job ${job0.jobNumber || job0.id}: notes=${JSON.stringify((jd.notes || '').slice(0, 120))}  estimatedMaterials=${Array.isArray(jd.estimatedMaterials) ? jd.estimatedMaterials.length : JSON.stringify(jd.estimatedMaterials)}  actualMaterials=${Array.isArray(jd.actualMaterials) ? jd.actualMaterials.length : JSON.stringify(jd.actualMaterials)}`);
      rawMats.slice(0, 6).forEach(m => out(`     material: ${JSON.stringify(m.name)} materialsQuantity=${m.materialsQuantity} packingQuantity=${m.packingQuantity} isContainer=${m.isContainer}`));
      out(`   -> Dispatch import would give: ${parsed.materials.length} material line(s), ${parsed.crates.length} crate line(s), ${parsed.notes ? 'job notes' : 'no job notes'}, ${parsed.stopNotes.length} stop note(s)`);
      out(flag(parsed.materials.length + parsed.crates.length > 0, 'materials/crates found in SmartMoving', 'no materials on this job in SmartMoving (estimators may not enter them) — office will type them in'));
    } catch (err) { out(`   !!  job-detail call failed: ${err.message}  (Premium endpoint)`); }
  }
  const money = findMoneyKeys(o);
  if (money.length) out('   money-looking fields elsewhere:\n     ' + money.join('\n     '));

  const today = tasking.todayIso();
  const upcoming = s.serviceDate && s.serviceDate >= today;
  const notSecured = upcoming && (s.status === 3 || (s.status === 4 && s.financeAt && !s.depositPaid && (s.paidTotal || 0) <= 0));
  const unpaid = s.status === 10 && s.financeAt && (s.balanceDue || 0) > 0;
  out(`   TASKING WOULD SHOW:  Not-secured list: ${notSecured ? 'YES' : 'no'}   Completed-unpaid list: ${unpaid ? 'YES' : 'no'}`);
  return s;
}

(async () => {
  if (!process.env.SMARTMOVING_API_KEY) { console.error('SMARTMOVING_API_KEY is not set (server/.env).'); process.exit(1); }
  let targets = ids.map(id => ({ id }));
  let customers = [];

  if (!targets.length) {
    out(`Sampling opportunities with service dates from ${DAYS} days ago to ${DAYS} days ahead…`);
    customers = await sm.getAllCustomersWithOpportunities({ fromServiceDate: ymd(-DAYS), toServiceDate: ymd(DAYS) });
    const byStatus = {}; const pick = { 4: [], 3: [], 10: [] };
    customers.forEach(c => (c.opportunities || []).forEach(op => {
      byStatus[op.status] = (byStatus[op.status] || 0) + 1;
      if (pick[op.status] && op.id && Array.isArray(op.jobs) && op.jobs.length) pick[op.status].push({ id: op.id, customerId: c.id, customerName: c.name, status: op.status, serviceDate: op.serviceDate });
    }));
    out('Opportunities seen by status:', JSON.stringify(byStatus));
    out(flag(!!byStatus[3], 'Opportunity (status 3) quotes ARE visible to the sweep', 'no status-3 quotes with jobs/dates seen — the "Estimate not signed" list will be empty'));
    out(flag(!!byStatus[10], 'Completed (status 10) opportunities are visible', 'no status-10 opportunities in this window — "Completed not paid" needs completed jobs in range (raise POLL_LOOKBACK_DAYS)'));
    targets = [...pick[4].slice(0, 3), ...pick[3].slice(0, 3), ...pick[10].slice(0, 3)];
    if (!targets.length) { out('Nothing to sample in that window. Try --days 60 or pass an opportunity id.'); return; }
  }

  const results = [];
  for (const t of targets) { const r = await checkOpportunity(t.id); if (r) results.push(r); }

  out('\n=== Claims (service tickets)');
  const custIds = [...new Set(results.map(r => r.customerId).filter(Boolean))].slice(0, 3);
  if (!custIds.length) out('   (no customer ids to check)');
  for (const cid of custIds) {
    try {
      const r = await sm.getCustomerServiceTickets(cid);
      const list = Array.isArray(r) ? r : (r.pageResults || r.items || r.results || r.serviceTickets || []);
      out(`   customer ${cid}: ${list.length} ticket(s) ${list.length ? '— ' + list.map(t => `${JSON.stringify(t.type)}/${JSON.stringify(t.status)} "${t.name}"`).join('; ') : ''}`);
      if (!Array.isArray(r) && !(r.pageResults || r.items || r.results || r.serviceTickets)) out(`   !!  unexpected response shape, keys: ${Object.keys(r).join(', ')}`);
    } catch (err) { out(`   !!  service-tickets call failed for ${cid}: ${err.message}  (Premium endpoint — is the key Premium?)`); }
  }

  out('\nDone. Nothing was written to Firestore. Items marked  !!  need a fix before relying on that list.');
})().catch(err => { console.error('Check failed:', err.message); process.exit(1); });
