/**
 * Tasking module backend (added 2026-11-05) — the office's daily "what needs doing" board:
 * call list, PBO upsell follow-ups, upcoming jobs not secured (estimate unsigned / no deposit),
 * completed jobs not paid, active claims, plus dispatch notes, materials and crates per job.
 *
 * Design rules (see the project doc "tasking-module-design.md"):
 *  - ADDITIVE ONLY. Everything lives in its own Firestore collections (tasking_opps, tasking_state,
 *    tasking_claims). It never writes to the jobs/trucks/drivers collections, so the SmartMoving
 *    sync and its manual-edit locks can't overwrite Tasking data and Tasking can't disturb the board.
 *  - NEVER BREAKS SYNC. The two hooks used by server.js (noteOpportunities / recordOpportunityDetails)
 *    swallow every error.
 *  - API BUDGET. No live SmartMoving fan-out on page load: pages read Firestore only. SmartMoving is
 *    called by refreshFinance / refreshClaims (daily after the 6 AM sweep, or the admin "Refresh"
 *    button), tagged 'tasking' in apiUsage and stopped when the daily budget runs low.
 *
 * Firestore layout:
 *   tasking_opps/{opportunityId}   what we know about one SmartMoving opportunity (status, service date,
 *                                  customer, estimate/deposit/payment summary, SM tasks)
 *   tasking_state/job-{jobId}      per-board-job office state (call done, PBO override, upsell, dispatch
 *                                  note, materials, crates, emailed-at) PLUS what was imported from the
 *                                  SmartMoving job (smNotes, smNoteSections, smStopNotes, smImportedAt, and materials/crates
 *                                  tagged source:'sm' — see importing below)
 *   tasking_state/day-{YYYY-MM-DD} per-day settings (who calls: crew or erika)
 *   tasking_state/meta             refresh bookkeeping
 *   tasking_claims/{ticketId}      SmartMoving service tickets of type Claim
 */

const { db: fsdb } = require('./firestore');
const smartmoving = require('./smartmovingClient');
const apiUsage = require('./apiUsage');
const { smartMovingIntDateToIso } = require('./mapJobs');

const oppCol = fsdb.collection('tasking_opps');
const stateCol = fsdb.collection('tasking_state');
const claimsCol = fsdb.collection('tasking_claims');

const TIME_ZONE = 'America/New_York';
const STATUS_LABEL = { 0: 'New lead', 1: 'Lead in progress', 3: 'Opportunity', 4: 'Booked', 10: 'Completed', 11: 'Closed', 20: 'Cancelled', 30: 'Lost', 50: 'Bad lead' };
const PBO_RE = /\bPBO\b|pack(?:ed|ing)?\s*by\s*owner|customer\s*pack/i;

/* ---------- small helpers ---------- */
function todayIso() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function isIsoDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(fromIso, toIso) {
  return Math.round((new Date(toIso + 'T12:00:00Z') - new Date(fromIso + 'T12:00:00Z')) / 86400000);
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toIsoDate(v) {
  if (!v && v !== 0) return null;
  if (typeof v === 'number' || /^\d{8}$/.test(String(v))) return smartMovingIntDateToIso(v);
  return isIsoDate(String(v)) ? String(v) : null;
}
function safeId(id) { return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120); }

// SmartMoving enums can arrive as the number or the name; accept both.
const PAY_CAT = { 0: 'deposit', 1: 'balance', 2: 'other', Deposit: 'deposit', BalanceDue: 'balance', Other: 'other' };
const DOC_KIND = { 5: 'contract', 7: 'estimate', Contract: 'contract', Estimate: 'estimate' };
const TICKET_TYPE = { 0: 'claim', 1: 'review', 2: 'other', Claim: 'claim', Review: 'review', Other: 'other' };
const TICKET_STATUS = { 0: 'NotStarted', 1: 'InProgress', 2: 'Completed', NotStarted: 'NotStarted', InProgress: 'InProgress', Completed: 'Completed' };
const lookup = (map, v) => map[v] ?? map[String(v)] ?? null;

function estimatedTotalNumber(e) {
  if (typeof e === 'number') return e;
  if (e && typeof e === 'object') {
    for (const k of ['finalTotal', 'total', 'max', 'estimate', 'amount']) if (typeof e[k] === 'number') return e[k];
  }
  return null;
}

/* ---------- opportunity capture (SmartMoving -> tasking_opps) ---------- */

/** Reduces a full SmartMoving opportunity (fetched with IncludePayments etc.) to what Tasking needs. */
function summarizeOpportunity(o) {
  const out = {
    id: o.id,
    quoteNumber: o.quoteNumber ?? null,
    status: typeof o.status === 'number' ? o.status : null,
    statusLabel: STATUS_LABEL[o.status] || String(o.leadStatus || o.status || ''),
    customerId: (o.customer && o.customer.id) || null,
    customerName: (o.customer && o.customer.name) || null,
    phone: (o.customer && o.customer.phoneNumber) || null,
    email: (o.customer && o.customer.emailAddress) || null,
    referralSource: o.referralSource || null,
    estimatedTotal: estimatedTotalNumber(o.estimatedTotal),
  };
  const jobDates = (Array.isArray(o.jobs) ? o.jobs : []).map(j => toIsoDate(j.jobDate)).filter(Boolean).sort();
  out.serviceDate = toIsoDate(o.serviceDate) || jobDates[0] || null;
  out.jobDates = jobDates;

  const text = [o.customField01, o.customField02, o.customField03, o.tariff && o.tariff.name, o.moveSize && o.moveSize.name].filter(Boolean).join(' | ');
  out.pboHint = PBO_RE.test(text);

  if (Array.isArray(o.payments)) {
    let paidTotal = 0; let balanceDue = 0; let depositPaid = false; let depositPending = false;
    for (const p of o.payments) {
      const amt = num(p.amount);
      const cat = lookup(PAY_CAT, p.paymentCategory) || 'other';
      if (p.isOutstanding) {
        balanceDue += amt;
        if (cat === 'deposit') depositPending = true;
      } else {
        const net = amt - num(p.amountRefunded);
        paidTotal += net;
        if (cat === 'deposit' && net > 0) depositPaid = true;
      }
    }
    Object.assign(out, { paidTotal, balanceDue, depositPaid, depositPending, financeAt: new Date().toISOString() });
  }
  if (Array.isArray(o.opportunityDocuments)) {
    const kinds = o.opportunityDocuments.map(d => ({ kind: lookup(DOC_KIND, d.type), done: Boolean(d.isComplete) }));
    out.estimateSent = kinds.some(k => k.kind === 'estimate');
    out.estimateSigned = kinds.some(k => (k.kind === 'estimate' || k.kind === 'contract') && k.done);
  }
  if (Array.isArray(o.tasks)) {
    out.smTasks = o.tasks.slice(0, 50).map(t => ({
      id: t.id, title: t.title || '', notes: t.notes || '',
      type: t.taskItemType ?? null, status: t.taskItemStatus ?? null,
      assignedTo: (t.assignedTo && (t.assignedTo.name || t.assignedTo.email)) || null,
    }));
  }
  return out;
}

/** Hook for hydrateOpportunity: stores whatever the already-fetched opportunity carries. Never throws. */
async function recordOpportunityDetails(opportunity) {
  try {
    if (!opportunity || !opportunity.id) return;
    const summary = summarizeOpportunity(opportunity);
    summary.seenAt = new Date().toISOString();
    // Drop nulls so a thin response never erases a richer earlier capture.
    Object.keys(summary).forEach(k => { if (summary[k] === null || summary[k] === undefined) delete summary[k]; });
    await oppCol.doc(safeId(opportunity.id)).set(summary, { merge: true });
  } catch (err) {
    console.warn('tasking.recordOpportunityDetails failed:', err.message);
  }
}

/** Hook for pollSweep: lightweight stubs from the /api/customers listing (no extra API calls). Never throws. */
async function noteOpportunities(items) {
  try {
    if (!Array.isArray(items) || !items.length) return 0;
    let written = 0;
    for (let i = 0; i < items.length; i += 400) {
      const batch = fsdb.batch();
      for (const it of items.slice(i, i + 400)) {
        if (!it.id) continue;
        const doc = {
          id: it.id,
          customerId: it.customerId || undefined,
          customerName: it.customerName || undefined,
          status: typeof it.status === 'number' ? it.status : undefined,
          statusLabel: STATUS_LABEL[it.status] || undefined,
          serviceDate: toIsoDate(it.serviceDate) || undefined,
          quoteNumber: it.quoteNumber ?? undefined,
          seenAt: new Date().toISOString(),
        };
        Object.keys(doc).forEach(k => doc[k] === undefined && delete doc[k]);
        batch.set(oppCol.doc(safeId(it.id)), doc, { merge: true });
        written += 1;
      }
      await batch.commit();
    }
    return written;
  } catch (err) {
    console.warn('tasking.noteOpportunities failed:', err.message);
    return 0;
  }
}

/* ---------- refresh (calls SmartMoving; budget-capped) ---------- */
async function pickRefreshTargets({ max = 60 } = {}) {
  const today = todayIso();
  const snap = await oppCol.where('serviceDate', '>=', addDays(today, -90)).get();
  const staleBefore = Date.now() - 20 * 3600 * 1000;
  const cands = [];
  snap.forEach(d => {
    const o = d.data();
    if (!o.serviceDate) return;
    const stale = !o.financeAt || Date.parse(o.financeAt) < staleBefore;
    if (!stale) return;
    const ahead = daysBetween(today, o.serviceDate);
    if (o.status === 4 && ahead >= -1 && ahead <= 60) cands.push({ id: o.id, p: 0, d: ahead });
    else if (o.status === 10 && ahead >= -90 && ahead <= 0) cands.push({ id: o.id, p: 1, d: -ahead });
    else if (o.status === 3 && ahead >= 0 && ahead <= 90 && !o.financeAt) cands.push({ id: o.id, p: 2, d: ahead });
  });
  cands.sort((a, b) => a.p - b.p || a.d - b.d);
  return { total: cands.length, ids: cands.slice(0, max).map(c => c.id) };
}

async function refreshFinance({ max = 60, minBudgetLeft = 25 } = {}) {
  return apiUsage.withApiSource('tasking', async () => {
    const { total, ids } = await pickRefreshTargets({ max });
    let refreshed = 0; let failed = 0; let stoppedForBudget = false;
    const errors = [];
    for (let i = 0; i < ids.length; i++) {
      if (i % 10 === 0) {
        const b = await apiUsage.getBudgetStatus().catch(() => null);
        if (b && typeof b.remaining === 'number' && b.remaining < minBudgetLeft) { stoppedForBudget = true; break; }
      }
      try {
        const details = await smartmoving.getOpportunityFinance(ids[i]);
        await recordOpportunityDetails(details);
        refreshed += 1;
      } catch (err) {
        failed += 1;
        if (errors.length < 5) errors.push(`${ids[i]}: ${err.message}`);
      }
    }
    return { candidates: total, attempted: ids.length, refreshed, failed, stoppedForBudget, errors };
  });
}

function unwrapList(r) {
  if (Array.isArray(r)) return r;
  if (r && typeof r === 'object') return r.pageResults || r.items || r.results || r.serviceTickets || [];
  return [];
}

async function refreshClaims({ max = 30, minBudgetLeft = 25 } = {}) {
  return apiUsage.withApiSource('tasking', async () => {
    const today = todayIso();
    const metaRef = stateCol.doc('meta');
    const meta = (await metaRef.get()).data() || {};
    const checked = meta.claimsChecked || {};
    const snap = await oppCol.where('serviceDate', '>=', addDays(today, -180)).get();
    const customers = new Map();
    snap.forEach(d => {
      const o = d.data();
      if (o.customerId && o.status !== 0 && o.status !== 1 && o.status !== 30 && o.status !== 50 && !customers.has(o.customerId)) {
        customers.set(o.customerId, o.customerName || '');
      }
    });
    const order = [...customers.keys()].sort((a, b) => (checked[a] || '').localeCompare(checked[b] || ''));
    let customersChecked = 0; let tickets = 0; let failed = 0; let stoppedForBudget = false;
    const errors = [];
    for (const customerId of order.slice(0, max)) {
      if (customersChecked % 10 === 0) {
        const b = await apiUsage.getBudgetStatus().catch(() => null);
        if (b && typeof b.remaining === 'number' && b.remaining < minBudgetLeft) { stoppedForBudget = true; break; }
      }
      try {
        const list = unwrapList(await smartmoving.getCustomerServiceTickets(customerId));
        for (const t of list) {
          if (lookup(TICKET_TYPE, t.type) !== 'claim') continue;
          await claimsCol.doc(safeId(t.id)).set({
            id: t.id, customerId, customerName: customers.get(customerId) || '',
            name: t.name || '', status: lookup(TICKET_STATUS, t.status) || 'NotStarted',
            priority: t.priority ?? null, jobId: t.jobId || null,
            createdAtUtc: t.createdAtUtc || null, updatedAt: new Date().toISOString(),
          }, { merge: true });
          tickets += 1;
        }
        checked[customerId] = new Date().toISOString();
        customersChecked += 1;
      } catch (err) {
        failed += 1;
        if (errors.length < 5) errors.push(`${customerId}: ${err.message}`);
      }
    }
    await metaRef.set({ claimsChecked: checked, claimsRefreshedAt: new Date().toISOString() }, { merge: true });
    return { customersTotal: customers.size, customersChecked, claimTickets: tickets, failed, stoppedForBudget, errors };
  });
}

/** Daily job (chained after the 6 AM poll sweep) and the admin "Refresh" button. */
async function runRefresh(opts = {}) {
  const finance = await refreshFinance({ max: opts.maxOpps || 120 }).catch(err => ({ error: err.message }));
  const claims = await refreshClaims({ max: opts.maxCustomers || 40 }).catch(err => ({ error: err.message }));
  // Dispatch notes + materials for the next two days (today included), when the caller gave us the board db.
  const today = todayIso();
  // Notes + materials now come from the SmartMoving calendar events (recordCalendarNotes, called by the calendar
  // sync) - the Premium job-detail API returns neither, so refreshJobDetails is no longer part of the refresh.
  const jobs = null;
  await stateCol.doc('meta').set({ refreshedAt: new Date().toISOString(), lastFinance: finance, lastClaims: claims, lastJobs: jobs }, { merge: true });
  return { finance, claims, jobs };
}

/* ---------- import dispatch notes + materials from the SmartMoving job (Premium job-detail endpoint) ---------- */
const listOf = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? (x.items || x.materials || x.results || []) : []));

/** Reduces a SmartMoving job-detail response to notes + materials/crates. Pure (no I/O) so it is unit-testable.
 *  Materials come from estimatedMaterials (planned), falling back to actualMaterials; items flagged
 *  isContainer are crates. Quantity = materialsQuantity (units supplied); lines with 0 are ignored. */
function parseJobDetails(d) {
  const mats = listOf(d && d.estimatedMaterials).length ? listOf(d.estimatedMaterials) : listOf(d && d.actualMaterials);
  const materials = []; const crates = [];
  for (const m of mats) {
    const name = str(m.name || m.description, 80);
    const qty = num(m.materialsQuantity);
    if (!name || qty <= 0) continue;
    (m.isContainer ? crates : materials).push({ key: safeId(m.id || name.toLowerCase()), name, qty });
  }
  const stopNotes = (Array.isArray(d && d.stops) ? d.stops : [])
    .map(s => ({ address: str(s.address || s.fullAddress || '', 200), notes: str(s.notes || '', 500) }))
    .filter(s => s.notes).slice(0, 6);
  return { materials, crates, notes: str(d && d.notes, 2000), stopNotes };
}

/** Merges an import into the job's state: SmartMoving-sourced items (id 'sm-…') are replaced by the new
 *  import (keeping their done/doneAt/doneBy), items the office added by hand are left alone. */
async function applyJobImport(jobId, parsed) {
  const ref = stateCol.doc('job-' + safeId(jobId));
  const prev = (await ref.get()).data() || {};
  const prevMats = new Map((prev.materials || []).map(m => [m.id, m]));
  const smMats = parsed.materials.map(m => {
    const id = 'sm-' + m.key; const b = prevMats.get(id);
    const item = { id, name: m.name, qty: m.qty, done: Boolean(b && b.done), source: 'sm' };
    if (item.done) { item.doneAt = b.doneAt || null; item.doneBy = b.doneBy || null; }
    return item;
  });
  const smCrates = parsed.crates.map(c => ({ id: 'sm-' + c.key, label: c.name, qty: c.qty, source: 'sm' }));
  const upd = {
    jobId: String(jobId),
    materials: [...smMats, ...(prev.materials || []).filter(m => m.source !== 'sm')].slice(0, 60),
    crates: [...smCrates, ...(prev.crates || []).filter(c => c.source !== 'sm')].slice(0, 30),
    smNotes: parsed.notes, smStopNotes: parsed.stopNotes, smImportedAt: new Date().toISOString(),
    // Notes split by type (calendar import only). null when the import has no split, so the page falls back to smNotes.
    smNoteSections: parsed.sections || null,
  };
  await ref.set(upd, { merge: true });
  return upd;
}

/* ---------- dispatch notes + materials from the SmartMoving calendar event (no API calls) ---------- */
const NOTE_LABELS = { 'dispatch notes': 'dispatch', 'dispatcher notes': 'dispatch', 'internal notes': 'internal', 'crew notes': 'crew', 'crew feedback': 'crewFeedback', 'customer notes': 'customer' };
const NOTE_HEADING = /^(dispatch notes|dispatcher notes|internal notes|crew notes|crew feedback|customer notes):\s*(.*)$/i;

/** Parses the notes block of a SmartMoving calendar event DESCRIPTION (see mapIcalEvent.js for the layout).
 *  Unlike the board mapper, which keeps only the first line of each note, this keeps every line, and pulls
 *  out a "Materials: 2 dishpacks; 4 wardrobes; 1 white paper" line into materials (items with "crate" in the
 *  name become crates). Pure, never throws. */
function parseCalendarNotes(description) {
  const blocks = String(description || '').split(/^-{10,}\s*$/m).map(b => b.trim()).filter(Boolean);
  const block = blocks.find(b => /^Dispatch notes:/mi.test(b)) || '';
  const sec = { dispatch: [], internal: [], crew: [], crewFeedback: [], customer: [] };
  let cur = null;
  for (const raw of block.split('\n')) {
    const m = NOTE_HEADING.exec(raw.trim());
    if (m) { cur = NOTE_LABELS[m[1].toLowerCase()]; if (m[2].trim()) sec[cur].push(m[2].trim()); }
    else if (cur && raw.trim()) sec[cur].push(raw.trim());
  }
  // sections: each note type kept separately, exactly as typed under its own heading (only a line repeated
  // inside the SAME section is dropped). The Dispatch page shows these as separate labelled blocks.
  // "Crew feedback" is read if SmartMoving ever puts that heading in the event; today's feed does not include it.
  const sections = {};
  for (const k of Object.keys(sec)) {
    const own = new Set();
    sections[k] = str(sec[k].filter(l => { const key = l.toLowerCase(); if (own.has(key)) return false; own.add(key); return true; }).join('\n'), 2000);
  }
  // notes: the older single-text version (used by the crew email and PBO text matching).
  // SmartMoving repeats the same lines under several headings (Crew notes are often copied into Customer notes, and
  // long notes appear twice), so a line already shown in an earlier section is dropped from later ones.
  const seenLines = new Set();
  const text = k => sec[k].filter(l => { const key = l.toLowerCase(); if (seenLines.has(key)) return false; seenLines.add(key); return true; }).join('\n');
  const parts = [['Dispatch', text('dispatch')], ['Internal', text('internal')], ['Crew', text('crew')], ['Crew feedback', text('crewFeedback')], ['Customer', text('customer')]]
    .filter(([, t]) => t);
  const notes = str(parts.map(([l, t]) => l + ': ' + t).join('\n'), 2000);
  // Materials line: first "Materials: ..." found in dispatch, internal, crew, then customer notes.
  let line = '';
  for (const k of ['dispatch', 'internal', 'crew', 'customer']) {
    const hit = sec[k].map(l => /^materials?\s*:\s*(.+)$/i.exec(l)).find(Boolean);
    if (hit) { line = hit[1]; break; }
  }
  const materials = []; const crates = []; const seen = new Set();
  for (const part of line.split(/[;,]/).map(x => x.trim()).filter(Boolean).slice(0, 40)) {
    let qty = 1; let name = part; let m;
    if ((m = /^(\d+(?:\.\d+)?)\s*(?:x|×)?\s*(.+)$/i.exec(part))) { qty = Number(m[1]); name = m[2]; }
    else if ((m = /^(.+?)\s*(?:x|×)\s*(\d+)$/i.exec(part))) { name = m[1]; qty = Number(m[2]); }
    name = str(name.replace(/\s+/g, ' ').trim(), 80);
    if (!name || !(qty > 0)) continue;
    const key = safeId(name.toLowerCase());
    if (seen.has(key)) continue; seen.add(key);
    (/\bcrates?\b/i.test(name) ? crates : materials).push({ key, name, qty });
  }
  return { notes, sections, materials, crates, materialsLine: str(line, 400) };
}

/** Hook for the calendar syncs: [{jobId, date, description}]. Saves each upcoming job's notes + materials into
 *  its Tasking state, only when the parsed result changed since last time (so frequent syncs write little).
 *  Never throws. Returns how many jobs were updated. */
let lastCalendarRun = null;
const getCalendarRun = () => lastCalendarRun;
async function recordCalendarNotes(items) {
  try {
    const today = todayIso();
    const keep = (Array.isArray(items) ? items : [])
      .filter(i => i && i.jobId && i.description && i.date >= addDays(today, -1) && i.date <= addDays(today, 21))
      .slice(0, 300);
    let updated = 0;
    for (let i = 0; i < keep.length; i += 100) {
      const chunk = keep.slice(i, i + 100);
      const refs = chunk.map(it => stateCol.doc('job-' + safeId(it.jobId)));
      const snaps = await fsdb.getAll(...refs);
      for (let k = 0; k < chunk.length; k++) {
        const parsed = parseCalendarNotes(chunk[k].description);
        const hash = JSON.stringify([parsed.notes, parsed.sections]);
        const prev = (snaps[k] && snaps[k].data && snaps[k].data()) || {};
        if (prev.calHash === hash) continue;
        // Notes only. Materials in free-text notes are unreliable (sometimes typed, sometimes not), so they are NOT imported.
        await applyJobImport(chunk[k].jobId, { materials: [], crates: [], notes: parsed.notes, sections: parsed.sections, stopNotes: prev.smStopNotes || [] });
        await refs[k].set({ calHash: hash, calMaterialsLine: parsed.materialsLine }, { merge: true });
        updated += 1;
      }
    }
    lastCalendarRun = { at: new Date().toISOString(), received: Array.isArray(items) ? items.length : 0, inWindow: keep.length, withNotes: keep.filter(i => parseCalendarNotes(i.description).notes).length, updated };
    await stateCol.doc('meta').set({ lastCalendarRun }, { merge: true }).catch(() => {});
    return updated;
  } catch (err) {
    lastCalendarRun = { at: new Date().toISOString(), error: err.message };
    console.error('[tasking] recordCalendarNotes failed:', err.message);
    return 0;
  }
}

/* ---------- materials + crates from the Smart Insights "Job Materials" report (materialsReport.js) ---------- */
/** Saves the report's materials onto the board jobs between today-1 and today+28. byJob comes from
 *  parseMaterialsReport. Per board job: SmartMoving-sourced rows (source 'sm') are replaced by the report's, keeping
 *  their done ticks; rows typed by hand are never touched; a job that dropped out of the report loses its old 'sm'
 *  rows. Writes only when the report's content for that job changed (matHash). Never throws on one bad job. */
async function applyMaterialsReport({ db, byJob, today = todayIso(), daysBack = 1, daysAhead = 28 }) {
  const from = addDays(today, -daysBack); const to = addDays(today, daysAhead);
  const boardJobs = await db.listJobsInRange(from, to);
  const boardIds = new Set(boardJobs.map(j => String(j.id)));
  const inWindow = Object.entries(byJob || {}).filter(([, j]) => j.date >= from && j.date <= to);
  const unmatched = inWindow.filter(([id]) => !boardIds.has(id)).map(([id]) => id.replace(/^SM-/, ''));
  let updated = 0; let cleared = 0; let failed = 0;
  for (let i = 0; i < boardJobs.length; i += 100) {
    const chunk = boardJobs.slice(i, i + 100);
    const refs = chunk.map(j => stateCol.doc('job-' + safeId(j.id)));
    const snaps = await fsdb.getAll(...refs);
    for (let k = 0; k < chunk.length; k++) {
      try {
        const prev = (snaps[k] && snaps[k].data && snaps[k].data()) || {};
        const rep = byJob[String(chunk[k].id)];
        const items = rep ? rep.items : [];
        const hadSm = (prev.materials || []).some(m => m.source === 'sm') || (prev.crates || []).some(c => c.source === 'sm');
        if (!items.length && !hadSm) continue;
        const hash = JSON.stringify(items.map(x => [x.key, x.qty, x.crate]));
        if (prev.matHash === hash) continue;
        const prevMats = new Map((prev.materials || []).map(m => [m.id, m]));
        const smMats = items.filter(x => !x.crate).map(x => {
          const id = 'sm-' + x.key; const b = prevMats.get(id);
          const it = { id, name: x.name, qty: x.qty, done: Boolean(b && b.done), source: 'sm' };
          if (it.done) { it.doneAt = b.doneAt || null; it.doneBy = b.doneBy || null; }
          return it;
        });
        const smCrates = items.filter(x => x.crate).map(x => ({ id: 'sm-' + x.key, label: x.name, qty: x.qty, source: 'sm' }));
        await refs[k].set({
          jobId: String(chunk[k].id),
          materials: [...smMats, ...(prev.materials || []).filter(m => m.source !== 'sm')].slice(0, 80),
          crates: [...smCrates, ...(prev.crates || []).filter(c => c.source !== 'sm')].slice(0, 40),
          matHash: hash, matImportedAt: new Date().toISOString(),
        }, { merge: true });
        if (items.length) updated += 1; else cleared += 1;
      } catch (err) { failed += 1; console.error('[tasking] materials apply failed for', chunk[k].id, err.message); }
    }
  }
  const result = { at: new Date().toISOString(), reportJobs: Object.keys(byJob || {}).length, reportJobsInWindow: inWindow.length, boardJobsInWindow: boardJobs.length, updated, cleared, failed, unmatched: unmatched.slice(0, 15), unmatchedCount: unmatched.length };
  await stateCol.doc('meta').set({ lastMaterials: result }, { merge: true }).catch(() => {});
  return result;
}

/** One Premium call per SmartMoving-linked board job in [from, to]. Skips jobs imported in the last 6 h
 *  unless force. Budget-capped like the other refreshes. */
async function refreshJobDetails({ db, from, to, max = 40, force = false, minBudgetLeft = 25 }) {
  return apiUsage.withApiSource('tasking', async () => {
    const all = (await db.listJobsInRange(from, to)).filter(j => visibleJob(j) && j.smartMovingJobId && j.smartMovingOpportunityId);
    const states = await getJobStates(all.map(j => j.id));
    const fresh = Date.now() - 6 * 3600 * 1000;
    const todo = all.filter(j => force || !(states.get(j.id) && states.get(j.id).smImportedAt && Date.parse(states.get(j.id).smImportedAt) > fresh)).slice(0, max);
    let imported = 0; let failed = 0; let stoppedForBudget = false; const errors = [];
    for (let i = 0; i < todo.length; i++) {
      if (i % 10 === 0) {
        const b = await apiUsage.getBudgetStatus().catch(() => null);
        if (b && typeof b.remaining === 'number' && b.remaining < minBudgetLeft) { stoppedForBudget = true; break; }
      }
      try {
        const details = await smartmoving.getJobDetails(todo[i].smartMovingOpportunityId, todo[i].smartMovingJobId, { includeStops: true, includeDispatchInfo: false });
        await applyJobImport(todo[i].id, parseJobDetails(details));
        imported += 1;
      } catch (err) {
        failed += 1;
        if (errors.length < 5) errors.push(`${todo[i].customer}: ${err.message}`);
      }
    }
    return { jobsOnDays: all.length, attempted: todo.length, imported, failed, stoppedForBudget, errors };
  });
}

/* ---------- per-job / per-day office state ---------- */
async function getJobStates(jobIds) {
  const map = new Map();
  const refs = [...new Set(jobIds)].map(id => stateCol.doc('job-' + safeId(id)));
  if (!refs.length) return map;
  const snaps = await fsdb.getAll(...refs);
  snaps.forEach(s => { if (s.exists) map.set(s.data().jobId, s.data()); });
  return map;
}

async function getDayState(dateIso) {
  const s = await stateCol.doc('day-' + dateIso).get();
  return s.exists ? s.data() : { callOwner: 'crew' };
}

const str = (v, n) => String(v ?? '').slice(0, n);

function cleanMaterials(list, prev, actor, now) {
  const prevById = new Map((Array.isArray(prev) ? prev : []).map(m => [m.id, m]));
  return list.slice(0, 60).map((m, i) => {
    const id = str(m.id || `m${Date.now().toString(36)}${i}`, 40);
    const done = Boolean(m.done);
    const before = prevById.get(id);
    const item = { id, name: str(m.name, 80), qty: Math.max(0, num(m.qty)), done };
    if (before && before.source === 'sm') item.source = 'sm'; // never trust the client to claim/clear this
    if (done) { item.doneAt = (before && before.done && before.doneAt) || now; item.doneBy = (before && before.done && before.doneBy) || actor; }
    return item;
  });
}
function cleanCrates(list, prev) {
  const prevById = new Map((Array.isArray(prev) ? prev : []).map(c => [c.id, c]));
  return list.slice(0, 30).map((c, i) => {
    const id = str(c.id || `c${Date.now().toString(36)}${i}`, 40);
    const item = { id, label: str(c.label, 80), qty: Math.max(0, num(c.qty)) };
    if (prevById.get(id) && prevById.get(id).source === 'sm') item.source = 'sm';
    return item;
  });
}

/** Applies a whitelisted partial update to a job's office state. Returns the stored state. */
async function updateJobState(jobId, patch, actorEmail) {
  const ref = stateCol.doc('job-' + safeId(jobId));
  const prevSnap = await ref.get();
  const prev = prevSnap.exists ? prevSnap.data() : {};
  const now = new Date().toISOString();
  const upd = { jobId: String(jobId), updatedAt: now, updatedBy: actorEmail };

  if (patch.callDone !== undefined) {
    upd.callDone = Boolean(patch.callDone);
    upd.callDoneAt = upd.callDone ? now : null;
    upd.callDoneBy = upd.callDone ? actorEmail : null;
  }
  if (patch.callAssignee !== undefined) upd.callAssignee = patch.callAssignee ? str(patch.callAssignee, 40) : null;
  if (patch.pbo !== undefined) upd.pbo = patch.pbo === null ? null : Boolean(patch.pbo);
  if (patch.upsellStatus !== undefined) {
    upd.upsellStatus = ['open', 'done', 'declined'].includes(patch.upsellStatus) ? patch.upsellStatus : null;
  }
  if (patch.upsellNote !== undefined) upd.upsellNote = str(patch.upsellNote, 500);
  if (patch.upsellDue !== undefined) upd.upsellDue = isIsoDate(patch.upsellDue) ? patch.upsellDue : null;
  if (patch.dispatchNote !== undefined) upd.dispatchNote = str(patch.dispatchNote, 2000);
  if (Array.isArray(patch.materials)) upd.materials = cleanMaterials(patch.materials, prev.materials, actorEmail, now);
  if (Array.isArray(patch.crates)) upd.crates = cleanCrates(patch.crates, prev.crates);
  if (patch.emailedAt !== undefined) upd.emailedAt = patch.emailedAt;

  await ref.set(upd, { merge: true });
  return { ...prev, ...upd };
}

async function setDayState(dateIso, patch, actorEmail) {
  const upd = { date: dateIso, updatedAt: new Date().toISOString(), updatedBy: actorEmail };
  if (patch.callOwner !== undefined) upd.callOwner = ['crew', 'erika'].includes(patch.callOwner) ? patch.callOwner : 'crew';
  await stateCol.doc('day-' + dateIso).set(upd, { merge: true });
  return getDayState(dateIso);
}

/* ---------- reads for the pages ---------- */
function isPbo(job, opp, state) {
  if (state && state.pbo === true) return { pbo: true, source: 'manual' };
  if (state && state.pbo === false) return { pbo: false, source: 'manual' };
  const text = [job.serviceCategoryLabel, job.serviceCategory, job.notes, job.smartMovingTruckText, state && state.smNotes].filter(Boolean).join(' | ');
  if (PBO_RE.test(text) || (opp && opp.pboHint)) return { pbo: true, source: 'auto' };
  return { pbo: false, source: 'auto' };
}

async function loadOppsFor(jobs) {
  const ids = [...new Set(jobs.map(j => j.smartMovingOpportunityId).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const snaps = await fsdb.getAll(...ids.map(id => oppCol.doc(safeId(id))));
  snaps.forEach(s => { if (s.exists) map.set(s.data().id, s.data()); });
  return map;
}

const byTime = (a, b) => (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || String(a.customer).localeCompare(String(b.customer));
const visibleJob = j => j && j.status !== 'cancelled' && j.status !== 'deleted';
/** Military (PCS) moves have customer names like "Garcia, Michael; HAFC0748880; AAFD-D; T1" (optionally with a leading
 *  "*REWEIGH*" tag): "Last, First" then only short reference codes after a semicolon. Same rule as isMilitaryJob in
 *  frontend/src/utils/jobs.js - keep the two in sync. Military work will be handled in the Military module, so the Summary lists (calls, PBO, not secured, completed unpaid) skip it. */
const isMilitaryJob = j => {
  const parts = String((j && j.customer) || '').trim().split(';').map(x => x.trim()).filter(Boolean);
  return parts.length > 1 && parts.slice(1).every(x => /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(x));
};

async function buildSummary(db, dateIso) {
  const date = isIsoDate(dateIso) ? dateIso : todayIso();
  const today = todayIso();
  const [dayJobsRaw, soonJobsRaw, dayState, metaSnap] = await Promise.all([
    db.listJobsInRange(date, date),
    db.listJobsInRange(date, addDays(date, 14)),
    getDayState(date),
    stateCol.doc('meta').get(),
  ]);
  const dayJobs = dayJobsRaw.filter(visibleJob).sort(byTime);
  const soonJobs = soonJobsRaw.filter(visibleJob);
  const allJobs = [...new Map([...dayJobs, ...soonJobs].map(j => [j.id, j])).values()];
  const [states, opps] = await Promise.all([getJobStates(allJobs.map(j => j.id)), loadOppsFor(allJobs)]);

  const jobCard = j => {
    const st = states.get(j.id) || {};
    const opp = opps.get(j.smartMovingOpportunityId) || null;
    const p = isPbo(j, opp, st);
    return { j, st, opp, p };
  };

  const callJobs = dayJobs.filter(j => !isMilitaryJob(j));
  const militaryHidden = dayJobs.length - callJobs.length;
  const calls = callJobs.map(jobCard).map(({ j, st, opp, p }) => ({
    jobId: j.id, time: j.startTime || null, customer: j.customer, phone: (opp && opp.phone) || null,
    origin: j.origin || '', destination: j.destination || '', type: j.type || 'local',
    assignee: st.callAssignee || dayState.callOwner || 'crew', ownAssignee: Boolean(st.callAssignee),
    callDone: Boolean(st.callDone), callDoneAt: st.callDoneAt || null, callDoneBy: st.callDoneBy || null,
    pbo: p.pbo,
  }));

  const pboList = soonJobs.filter(j => !isMilitaryJob(j)).map(jobCard).filter(c => c.p.pbo).sort((a, b) => a.j.date.localeCompare(b.j.date) || byTime(a.j, b.j)).map(({ j, st, p }) => ({
    jobId: j.id, customer: j.customer, date: j.date, time: j.startTime || null, daysLeft: daysBetween(date, j.date), // counted from the day picked on the page, not from today
    source: p.source, upsellStatus: st.upsellStatus || 'open', upsellNote: st.upsellNote || '', upsellDue: st.upsellDue || null,
  }));

  const [aheadSnap, behindSnap, claimSnap] = await Promise.all([
    oppCol.where('serviceDate', '>=', today).where('serviceDate', '<=', addDays(today, 90)).get(),
    oppCol.where('serviceDate', '>=', addDays(today, -120)).where('serviceDate', '<=', today).get(),
    claimsCol.get(),
  ]);

  const notSecured = [];
  aheadSnap.forEach(d => {
    const o = d.data();
    if (isMilitaryJob({ customer: o.customerName })) return; // military: handled in the Military module
    const reasons = [];
    // Two independent checks for an unbooked (3) or booked (4) opportunity, both from the documents/payments read
    // by "Refresh from SmartMoving" (financeAt). A quote can be signed but unpaid, so status alone says nothing.
    if (o.status === 3 || o.status === 4) {
      if (o.estimateSigned === true) { /* signed - nothing to chase */ }
      else if (o.estimateSigned === false) reasons.push(o.estimateSent === false ? 'Estimate not sent' : 'Estimate not signed');
      else if (o.status === 3) reasons.push('Not checked yet'); // documents not read yet: don't claim unsigned
      if (o.financeAt && !o.depositPaid && num(o.paidTotal) <= 0) reasons.push('No deposit paid');
    }
    if (!reasons.length) return;
    notSecured.push({
      oppId: o.id, customer: o.customerName || 'Unknown', quote: o.quoteNumber || null, phone: o.phone || null,
      serviceDate: o.serviceDate, daysLeft: daysBetween(today, o.serviceDate), status: o.statusLabel || '',
      estimatedTotal: o.estimatedTotal ?? null, reasons,
    });
  });
  notSecured.sort((a, b) => a.daysLeft - b.daysLeft);

  const unpaidCompleted = [];
  behindSnap.forEach(d => {
    const o = d.data();
    if (isMilitaryJob({ customer: o.customerName })) return;
    if (o.status === 10 && o.financeAt && num(o.balanceDue) > 0) {
      unpaidCompleted.push({
        oppId: o.id, customer: o.customerName || 'Unknown', quote: o.quoteNumber || null, phone: o.phone || null,
        serviceDate: o.serviceDate, daysSince: daysBetween(o.serviceDate, today), balanceDue: num(o.balanceDue),
      });
    }
  });
  unpaidCompleted.sort((a, b) => b.daysSince - a.daysSince);

  const claims = [];
  claimSnap.forEach(d => {
    const c = d.data();
    if (c.status === 'Completed') return;
    claims.push({ id: c.id, customer: c.customerName || 'Unknown', name: c.name || '', status: c.status, priority: c.priority, createdAt: c.createdAtUtc || null });
  });
  claims.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const meta = metaSnap.exists ? metaSnap.data() : {};
  return {
    date, today, callOwner: dayState.callOwner || 'crew',
    calls, callsMilitaryHidden: militaryHidden, pbo: pboList, notSecured: notSecured.slice(0, 300), unpaidCompleted: unpaidCompleted.slice(0, 300), claims,
    meta: { refreshedAt: meta.refreshedAt || null, claimsRefreshedAt: meta.claimsRefreshedAt || null, lastFinance: meta.lastFinance || null, lastClaims: meta.lastClaims || null },
  };
}

async function buildDispatch(db, dateIso) {
  const date = isIsoDate(dateIso) ? dateIso : todayIso();
  const [jobsRaw, { trucks, drivers }, metaSnap] = await Promise.all([db.listJobsInRange(date, date), db.getTrucksAndDrivers(), stateCol.doc('meta').get()]);
  const metaData = (metaSnap && metaSnap.data && metaSnap.data()) || {};
  const jobs = jobsRaw.filter(visibleJob).sort(byTime);
  const states = await getJobStates(jobs.map(j => j.id));
  const truckName = id => { const t = trucks.find(x => x.id === id); return t ? (t.name || t.id) : id; };
  const driverName = id => { const d = drivers.find(x => x.id === id); return d ? (d.name || d.id) : id; };
  return {
    date,
    materialsImport: metaData.lastMaterials || null,
    jobs: jobs.map(j => {
      const st = states.get(j.id) || {};
      return {
        jobId: j.id, customer: j.customer, time: j.startTime || null, duration: j.duration || null, type: j.type || 'local',
        origin: j.origin || '', destination: j.destination || '', crewSize: j.crewSize || null,
        trucks: (j.truckIds || []).map(id => ({ id, name: truckName(id), driver: j.truckDrivers && j.truckDrivers[id] ? driverName(j.truckDrivers[id]) : null })),
        dispatchNote: st.dispatchNote || '', materials: st.materials || [], crates: st.crates || [], emailedAt: st.emailedAt || null,
        smNotes: st.smNotes || '', smNoteSections: st.smNoteSections || null, smStopNotes: st.smStopNotes || [], smImportedAt: st.smImportedAt || null, hasSmartMovingJob: Boolean(j.smartMovingJobId && j.smartMovingOpportunityId),
      };
    }),
  };
}

/** Plain-text + HTML body for "email assigned jobs". */
function renderAssignmentsEmail(dispatch) {
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const lines = [`ATM dispatch — ${dispatch.date}`, ''];
  const rows = [];
  for (const j of dispatch.jobs) {
    const trucks = j.trucks.length ? j.trucks.map(t => t.name + (t.driver ? ` (${t.driver})` : '')).join(', ') : 'UNASSIGNED';
    const mats = j.materials.filter(m => !m.done).map(m => `${m.qty}× ${m.name}`).join(', ');
    const crates = j.crates.map(c => `${c.qty}× ${c.label || 'crate'}`).join(', ');
    lines.push(`${j.time || 'TBD'}  ${j.customer}  [${trucks}]`, `  ${j.origin}${j.destination ? '  ->  ' + j.destination : ''}`);
    if (j.smNotes) lines.push(`  SmartMoving notes: ${j.smNotes}`);
    (j.smStopNotes || []).forEach(s => lines.push(`  Stop note (${s.address || 'stop'}): ${s.notes}`));
    if (j.dispatchNote) lines.push(`  Note: ${j.dispatchNote}`);
    if (mats) lines.push(`  Materials: ${mats}`);
    if (crates) lines.push(`  Crates: ${crates}`);
    lines.push('');
    rows.push(`<tr><td style="padding:6px;border-bottom:1px solid #ddd;vertical-align:top"><b>${esc(j.time || 'TBD')}</b></td>` +
      `<td style="padding:6px;border-bottom:1px solid #ddd"><b>${esc(j.customer)}</b><br>${esc(j.origin)}${j.destination ? ' &rarr; ' + esc(j.destination) : ''}` +
      `${j.smNotes ? '<br>SmartMoving: ' + esc(j.smNotes) : ''}${(j.smStopNotes || []).map(s => '<br>' + esc(s.address || 'Stop') + ': ' + esc(s.notes)).join('')}${j.dispatchNote ? '<br><i>' + esc(j.dispatchNote) + '</i>' : ''}${mats ? '<br>Materials: ' + esc(mats) : ''}${crates ? '<br>Crates: ' + esc(crates) : ''}</td>` +
      `<td style="padding:6px;border-bottom:1px solid #ddd;vertical-align:top">${esc(trucks)}</td></tr>`);
  }
  return {
    subject: `ATM dispatch — ${dispatch.date} (${dispatch.jobs.length} jobs)`,
    text: lines.join('\n'),
    html: `<h3>ATM dispatch — ${esc(dispatch.date)}</h3><table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">${rows.join('')}</table>`,
  };
}

module.exports = {
  todayIso, isIsoDate, summarizeOpportunity, recordOpportunityDetails, noteOpportunities,
  refreshFinance, refreshClaims, refreshJobDetails, parseJobDetails, applyJobImport, parseCalendarNotes, recordCalendarNotes, getCalendarRun, applyMaterialsReport, runRefresh, pickRefreshTargets,
  getJobStates, getDayState, updateJobState, setDayState,
  buildSummary, buildDispatch, renderAssignmentsEmail, isPbo,
};
