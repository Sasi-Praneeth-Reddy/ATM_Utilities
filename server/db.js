/**
 * Firestore data layer for the ATM Scheduler — trucks, drivers, jobs, and users. Replaces the old
 * node:sqlite-based version of this file (see git history) as part of moving to Firestore + AWS
 * App Runner for team testing — see server/README.md "AWS deployment."
 *
 * Every exported function here keeps the exact same name and shape it had under SQLite, so
 * server.js needed minimal changes. The one across-the-board difference: every function here is
 * now `async` — Firestore's Admin SDK is Promise-based, there's no better-sqlite3-style synchronous
 * call — so every call site in server.js (and create-admin.js, replace-trucks.js) needed an `await`
 * added. Call `initDb()` once at startup, before serving any requests (see server.js) — it seeds
 * sample data on a brand new/empty Firestore database, mirroring the old "seed if the trucks table
 * is empty" check that used to run synchronously at module load time.
 *
 * `truckIds` is stored directly as an array field on each job document now, instead of a separate
 * `job_trucks` join table — Firestore has no joins, and the app already treated `truckIds` as a
 * plain array everywhere in memory (frontend and backend alike), so this is a simplification, not
 * a behavior change. Deleting a truck now explicitly finds every job whose `truckIds` contains it
 * (an `array-contains` query) and rewrites that array, which is what used to happen automatically
 * via SQLite's `ON DELETE CASCADE` on `job_trucks`.
 *
 * ID generation (T6, D6, J-10245, U2) still lives entirely in server.js's own
 * `nextId(rows, prefix)` helper, completely unchanged — it computes "max existing numeric suffix +
 * 1" over whatever array `db.getState()`/`db.listUsers()` returns, which works identically whether
 * that array came from SQL or Firestore. (This carries over the same small race-condition
 * limitation the SQLite version already had — two near-simultaneous creates could compute the same
 * "next" id — which is unchanged by this migration, not introduced by it.)
 *
 * Known minor behavioral differences from the SQLite version, both edge cases that don't come up in
 * normal use of this app:
 *  - `updateTruck`/`updateDriver`/`updateJob`/`updateUserRole`/etc. on an id that doesn't exist:
 *    SQLite silently no-opped (`UPDATE ... WHERE id = ?` matching zero rows isn't an error).
 *    Firestore's `.update()` throws NOT_FOUND on a missing document — `safeUpdate()` below catches
 *    that specific case and returns `null`/no-ops instead, to match the old silent behavior exactly
 *    (server.js's routes mostly don't check existence before calling these).
 *
 * Drivers are NOT linked to trucks anymore (removed 2026-08-18) — a driver used to have one
 * standing truck (`driver.truckId` / `truck.driverId`), which didn't match how dispatch actually
 * works here: the same driver drives whichever truck they're needed on for a given job, and that
 * changes job to job. Instead, each job carries its own `truckDrivers` map (`{ [truckId]: driverId
 * }`), set per truck per job via `setJobTruckDriver` below — see server.js's
 * `POST /api/jobs/:id/set-truck-driver`. `truckDrivers` is deliberately NOT in `updateJob`'s
 * generic `allowed` field list, so a routine job PATCH (editing the customer name, say) can never
 * accidentally clobber the whole map — only `setJobTruckDriver`'s single-key dot-path update can
 * touch it, and `updateJob` itself only ever deletes individual keys (when a truck is removed from
 * the job's `truckIds`), never overwrites the map wholesale.
 */

const { db: fs } = require('./firestore');
const { FieldValue } = require('firebase-admin/firestore');

const trucksCol = fs.collection('trucks');
const driversCol = fs.collection('drivers');
const jobsCol = fs.collection('jobs');
// Soft-delete archive for jobs (added 2026-09-24) — see deleteJob/listDeletedJobs/restoreJob below.
// A separate top-level collection rather than a `deleted: true` flag left on the jobs doc itself,
// so every existing query against jobsCol (getState, sync upserts, etc.) never has to remember to
// filter deleted ones back out.
const deletedJobsCol = fs.collection('deletedJobs');
const usersCol = fs.collection('users');
const allowedExternalEmailsCol = fs.collection('allowedExternalEmails');
// One-doc-per-key "app settings" collection — currently only holds gmailAuth (below), but kept as
// a general small collection rather than a gmailAuth-specific one in case something else small and
// singleton-ish needs a home later (a doc id, not a whole new top-level collection, is cheap to add).
const systemCol = fs.collection('system');
const GMAIL_AUTH_DOC_ID = 'gmailAuth';

/** Each job's own audit trail lives as a `history` SUBcollection under that job's own document —
 * `jobs/{jobId}/history/{entryId}` — rather than one flat collection with a `jobId` field to filter
 * by. Keyed off the job's own id specifically so browsing it in the Firebase console is just
 * "open this job, open its history": no filtering, no separate lookup, and every job's trail lives
 * right next to the job it's about. Firestore subcollections are independent documents under the
 * hood, not nested data on the parent — deleting the parent job doc (deleteJob above) does NOT
 * delete this subcollection, which is exactly what's wanted here: a deleted job's history (including
 * the 'delete' entry itself, logged with the job's last known state — see logJobChange) stays
 * intact and still reachable at this same path even after the job itself is gone. See logJobChange's
 * own doc comment for what's actually written here and why. */
function jobHistoryCol(jobId) {
  return jobsCol.doc(jobId).collection('history');
}

/* ---------- Sample data (used to seed an empty database on first run) ---------- */
const SAMPLE_TRUCKS = [
  { id: 'T1', name: 'Truck 1', size: '26ft Box', capacity: '12,000 lbs', status: 'available', homeBase: 'Denver, CO' },
  { id: 'T2', name: 'Truck 2', size: '26ft Box', capacity: '12,000 lbs', status: 'onjob', homeBase: 'Denver, CO' },
  { id: 'T3', name: 'Truck 3', size: '53ft Trailer (LD)', capacity: '26,000 lbs', status: 'available', homeBase: 'Denver, CO' },
  { id: 'T4', name: 'Truck 4', size: '16ft Box', capacity: '6,000 lbs', status: 'maintenance', homeBase: 'Denver, CO' },
  { id: 'T5', name: 'Truck 5', size: '53ft Trailer (LD)', capacity: '26,000 lbs', status: 'available', homeBase: 'Denver, CO' },
];
const SAMPLE_DRIVERS = [
  { id: 'D1', name: 'Mike Reynolds', phone: '(303) 555-0114', cdl: 'Class A' },
  { id: 'D2', name: 'Alex Chen', phone: '(303) 555-0122', cdl: 'Class A' },
  { id: 'D3', name: 'Jordan Blake', phone: '(303) 555-0133', cdl: 'Class A + LD Endorsed' },
  { id: 'D4', name: 'Sam Patel', phone: '(303) 555-0147', cdl: 'Class B' },
  { id: 'D5', name: 'Casey Nunez', phone: '(303) 555-0158', cdl: 'Class A + LD Endorsed' },
];
const SAMPLE_JOBS = [
  { id: 'J-10231', customer: 'Sarah Thompson', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '08:00', duration: 3, origin: '1420 Larimer St, Denver, CO', destination: '880 Pearl St, Boulder, CO', crewSize: 3, truckIds: ['T1'], truckDrivers: { T1: 'D1' }, trucksNeeded: 1, status: 'scheduled', miles: 32 },
  { id: 'J-10232', customer: 'The Whitfield Family', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '09:30', duration: 2.5, origin: '2200 Colfax Ave, Denver, CO', destination: '50 S Steele St, Denver, CO', crewSize: 2, truckIds: ['T2'], truckDrivers: { T2: 'D2' }, trucksNeeded: 1, status: 'in_progress', miles: 8 },
  { id: 'J-10233', customer: 'Devon Marsh', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '13:00', duration: 2, origin: '900 Auraria Pkwy, Denver, CO', destination: '12 Golden Gate Cyn, Golden, CO', crewSize: 2, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 19 },
  { id: 'J-10235', customer: 'Grace Lin', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '15:30', duration: 2, origin: '3300 E Colfax Ave, Denver, CO', destination: '700 Kalamath St, Denver, CO', crewSize: 2, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 6 },
  { id: 'J-10234', customer: 'Priya Nair', type: 'local', date: '2026-08-06', endDate: '2026-08-06', startTime: '09:00', duration: 3, origin: '400 W 48th Ave, Denver, CO', destination: '77 S Union Blvd, Lakewood, CO', crewSize: 3, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 14 },
  { id: 'J-10236', customer: 'Tom Alvarez', type: 'local', date: '2026-08-11', endDate: '2026-08-11', startTime: '08:30', duration: 3, origin: '1660 Wynkoop St, Denver, CO', destination: '6900 Layton Ave, Denver, CO', crewSize: 2, truckIds: ['T1'], truckDrivers: { T1: 'D1' }, trucksNeeded: 1, status: 'scheduled', miles: 11 },
  { id: 'J-10237', customer: 'Nia Coleman', type: 'local', date: '2026-08-14', endDate: '2026-08-14', startTime: '10:00', duration: 2.5, origin: '2001 York St, Denver, CO', destination: '1000 Chapman Dr, Louisville, CO', crewSize: 3, truckIds: ['T2'], truckDrivers: { T2: 'D2' }, trucksNeeded: 1, status: 'scheduled', miles: 23 },
  { id: 'J-10238', customer: 'Ortiz Household', type: 'local', date: '2026-08-20', endDate: '2026-08-20', startTime: '09:00', duration: 3, origin: '4650 Leetsdale Dr, Denver, CO', destination: '150 W Prospect Rd, Fort Collins, CO', crewSize: 3, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 66 },
  { id: 'J-10244', customer: 'Nguyen Family', type: 'local', date: '2026-08-06', endDate: '2026-08-06', startTime: '10:00', duration: 2, origin: '1900 Grant St, Denver, CO', destination: '8000 E Girard Ave, Denver, CO', crewSize: 2, truckIds: ['T3'], truckDrivers: { T3: 'D3' }, trucksNeeded: 1, status: 'scheduled', miles: 10 },
  { id: 'J-10240', customer: 'Harold & Anne Kessler', type: 'long_distance', date: '2026-08-05', endDate: '2026-08-08', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Phoenix, AZ', crewSize: 4, truckIds: ['T3'], truckDrivers: { T3: 'D3' }, trucksNeeded: 2, status: 'loading', miles: 862, transitDays: 2, stage: 'loading' },
  { id: 'J-10241', customer: 'Reyes Household', type: 'long_distance', date: '2026-08-06', endDate: '2026-08-09', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Austin, TX', crewSize: 3, truckIds: ['T5'], truckDrivers: { T5: 'D5' }, trucksNeeded: 1, status: 'scheduled', miles: 925, transitDays: 2, stage: 'scheduled' },
  { id: 'J-10242', customer: 'Ben Okafor', type: 'long_distance', date: '2026-08-04', endDate: '2026-08-07', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Portland, OR', crewSize: 3, truckIds: [], trucksNeeded: 2, status: 'in_transit', miles: 1245, transitDays: 3, stage: 'in_transit' },
  { id: 'J-10243', customer: 'Marcus Webb', type: 'long_distance', date: '2026-08-18', endDate: '2026-08-21', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Chicago, IL', crewSize: 3, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 996, transitDays: 2, stage: 'scheduled' },
];

/* ---------- Doc <-> app-shape helpers ---------- */
function docToTruck(doc) {
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}
function docToDriver(doc) {
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}
function docToJob(doc) {
  if (!doc.exists) return null;
  const data = doc.data();
  return { id: doc.id, ...data, truckIds: data.truckIds || [], truckDrivers: data.truckDrivers || {} };
}
function docToUser(doc) {
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}
function sortById(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
/** Trucks sort by their explicit `order` field (drag-and-drop reordering in the admin panel writes
    this) rather than by id — falls back to id order for anything missing `order` (shouldn't happen
    in practice since initDb() backfills it on every startup, but keeps display stable rather than
    throwing if it ever does). */
function sortByOrder(a, b) {
  const ao = a.order ?? Infinity, bo = b.order ?? Infinity;
  if (ao !== bo) return ao - bo;
  return sortById(a, b);
}

/** Runs `ref.update(updates)` but swallows a NOT_FOUND error and returns `false` instead of
    throwing — see the file header comment for why this matches the old SQLite behavior. Returns
    `true` if the update actually applied. */
async function safeUpdate(ref, updates) {
  try {
    await ref.update(updates);
    return true;
  } catch (err) {
    if (err.code === 5 || err.code === 'not-found') return false;
    throw err;
  }
}

/* ---------- Reads ---------- */
async function getState() {
  const [truckSnap, driverSnap, jobSnap] = await Promise.all([
    trucksCol.get(), driversCol.get(), jobsCol.get(),
  ]);
  const trucks = truckSnap.docs.map(docToTruck).sort(sortByOrder);
  const drivers = driverSnap.docs.map(docToDriver).sort(sortById);
  const jobs = jobSnap.docs.map(docToJob).sort(sortById);
  return { trucks, drivers, jobs };
}

/* ---------- Change-version (added 2026-10-26) ----------
 * One tiny doc, system/dataVersion, holds a counter that every board-data write bumps (see the
 * wrapper at the bottom of this file — every write function in module.exports is wrapped, so no
 * write path can forget). The browser polls /api/state?since=<version>; getStateIfChanged() reads
 * just this one doc (1 Firestore read) and only does the full trucks+drivers+jobs read when the
 * counter has actually moved. The version is read BEFORE the data, so a write landing in between
 * can only make the client refetch once more (harmless), never miss a change. */
const dataVersionRef = systemCol.doc('dataVersion');

async function getDataVersion() {
  const doc = await dataVersionRef.get();
  return doc.exists ? Number(doc.data().version) || 0 : 0;
}

async function bumpDataVersion() {
  try {
    await dataVersionRef.set({ version: FieldValue.increment(1), updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    // Never fail the real write because the bookkeeping doc failed — clients' periodic full
    // refresh (see useSchedulerData.js) is the safety net for a missed bump.
    console.error('bumpDataVersion failed:', err.message);
  }
}

/** since === undefined/null -> always the full state (old clients, first load). Otherwise returns
 * { changed: false, version } for 1 read when nothing moved, or { changed: true, version, ...state }. */
async function getStateIfChanged(since) {
  const version = await getDataVersion();
  if (since !== undefined && since !== null && Number(since) === version) {
    return { changed: false, version };
  }
  return { changed: true, version, ...(await getState()) };
}

/** Document counts via count() aggregation (~1 read per 1,000 docs) — for /api/health, which is public
 * and must never read whole collections. null = count unavailable. */
async function getCounts() {
  const c = async (col) => { try { return (await col.count().get()).data().count; } catch (e) { return null; } };
  const [trucks, drivers, jobs, users] = await Promise.all([c(trucksCol), c(driversCol), c(jobsCol), c(usersCol)]);
  return { trucks, drivers, jobs, users };
}

async function getJob(id) {
  const doc = await jobsCol.doc(id).get();
  return docToJob(doc);
}

/* ---------- Writes: trucks ---------- */
/** New trucks go to the end of the display order — reads the current max `order` rather than just
    trucks.length, so a truck's position survives even if trucks have been deleted in between. */
async function nextTruckOrder() {
  const snap = await trucksCol.get();
  let max = -1;
  snap.forEach((d) => { const o = d.data().order; if (typeof o === 'number' && o > max) max = o; });
  return max + 1;
}

async function createTruck(truck) {
  const data = {
    name: truck.name, size: truck.size || null, capacity: truck.capacity || null,
    status: truck.status || 'available', homeBase: truck.homeBase || null,
    order: truck.order ?? await nextTruckOrder(),
    // Free-text aliases this truck is known by in SmartMoving's iCal feed (e.g. "ARC 130-2") — set
    // via the Admin > Trucks panel, matched against each job's "Trucks:" line by
    // findTruckIdBySmartMovingLabel below to auto-assign truckIds during iCal sync. Empty by
    // default; a truck with no labels set just never auto-matches (falls back to manual dispatcher
    // assignment, same as today).
    smartMovingLabels: truck.smartMovingLabels || [],
  };
  await trucksCol.doc(truck.id).set(data);
  return { id: truck.id, ...data };
}

async function updateTruck(id, fields) {
  const allowed = ['name', 'size', 'capacity', 'status', 'homeBase', 'order', 'smartMovingLabels'];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
  }
  if (Object.keys(updates).length) await safeUpdate(trucksCol.doc(id), updates);
  return docToTruck(await trucksCol.doc(id).get());
}

/** Normalizes a SmartMoving truck label for matching: uppercase, strip everything but
 *  letters/digits. "ARC 130-2", "arc130-2", "ARC-130-2" all normalize to "ARC1302" so dispatcher
 *  typos in spacing/dashes/case don't block a match. Exact-substring-free — this is intentionally
 *  strict equality after normalization, not fuzzy matching, so an unmapped/new truck label just
 *  fails to match (job keeps truckIds: [], visible via smartMovingTruckText for manual assignment)
 *  rather than risking a wrong auto-assignment. */
function normalizeSmartMovingLabel(label) {
  return String(label || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Given the current truck list and a raw "Trucks:" string from a SmartMoving job (which may list
 *  more than one truck, e.g. "ARC 130-2, ARC 145" on a multi-truck job — only the first is used
 *  today; ATM Scheduler jobs. `trucksNeeded` already anticipates a job needing more than one truck.
 *  If multi-truck auto-assignment turns out to matter in practice, extend this to return an array).
 *  Returns the matching truck's id, or null if no truck's smartMovingLabels normalize-match. */
function findTruckIdBySmartMovingLabel(trucks, rawLabel) {
  if (!rawLabel) return null;
  const firstLabel = rawLabel.split(',')[0].trim();
  const target = normalizeSmartMovingLabel(firstLabel);
  if (!target) return null;
  const match = trucks.find((t) =>
    Array.isArray(t.smartMovingLabels) && t.smartMovingLabels.some((alias) => normalizeSmartMovingLabel(alias) === target)
  );
  return match ? match.id : null;
}

/** Driver analog of findTruckIdBySmartMovingLabel above, for a job's raw "Crew:" text. Per explicit
 *  instruction (2026-08-26): matching must be by registered id/label, the same exact-after-
 *  normalization equality findTruckIdBySmartMovingLabel already uses for trucks — never fuzzy or
 *  best-effort name matching, so a driver never gets auto-assigned off a guess. "Exact" here means
 *  exact after normalizeSmartMovingLabel's uppercase+strip-non-alphanumeric folding (so spacing/
 *  case/punctuation differences still match, same tolerance trucks get) — not a substring/contains
 *  match, so "Celita" alone would NOT match a driver whose registered label is "Celita
 *  703-454-4456" or vice versa. Because mapIcalEvent.js's header documents Crew: text as "wildly
 *  inconsistent" (sometimes bare name, sometimes name+phone, sometimes a code), getting reliable
 *  hits may mean registering more than one alias per driver in Admin > Drivers — e.g. both "Celita"
 *  and "Celita 703-454-4456" — so whichever exact form a given job's Crew: line happens to use still
 *  matches. Only the first comma-separated crew member is tried (mirrors the truck helper's
 *  same-line assumption) — a job naming multiple crew members beyond the first simply doesn't
 *  auto-assign past the first today. Returns the matching driver's id, or null if nothing matches —
 *  a job with no auto-matched driver just keeps its truck's `truckDrivers` entry unset, visible via
 *  smartMovingCrewText for a dispatcher to assign by hand, exactly like an unmatched truck. */
function findDriverIdBySmartMovingLabel(drivers, rawCrewText) {
  if (!rawCrewText) return null;
  const firstCrew = rawCrewText.split(',')[0].trim();
  const target = normalizeSmartMovingLabel(firstCrew);
  if (!target) return null;
  const match = drivers.find((d) =>
    Array.isArray(d.smartMovingLabels) && d.smartMovingLabels.some((alias) => normalizeSmartMovingLabel(alias) === target)
  );
  return match ? match.id : null;
}

/** Drag-and-drop reordering in the Trucks admin panel sends the FULL list of truck ids in their new
    order — simpler and less error-prone than computing/sending individual position swaps. Batched
    into one atomic write so a page of concurrent viewers never sees a half-applied order. Every id
    must correspond to a real, currently-existing truck — Firestore batches are all-or-nothing, so
    a stale/invalid id (e.g. a truck deleted by someone else moments before this commits) fails the
    whole reorder rather than silently applying a partial one; the frontend always sends ids it just
    read from current state, so this is expected to succeed in normal use. */
async function reorderTrucks(orderedIds) {
  const batch = fs.batch();
  orderedIds.forEach((id, index) => { batch.update(trucksCol.doc(id), { order: index }); });
  await batch.commit();
  return getState();
}

/** Deletes a truck. Explicitly rewrites `truckIds` on every job that references it (the old
 * `job_trucks` join table's `ON DELETE CASCADE` did this automatically in SQL — see the file
 * header), and also clears that truck's entry from `truckDrivers` on any of those jobs (a driver
 * assignment that names a truck which no longer exists shouldn't linger). Drivers themselves have
 * no truck-level link anymore, so there's no driver-side cleanup here — see the file header. */
async function deleteTruck(id) {
  const jobSnap = await jobsCol.where('truckIds', 'array-contains', id).get();
  const batch = fs.batch();
  jobSnap.forEach((j) => {
    const data = j.data();
    const truckIds = (data.truckIds || []).filter((t) => t !== id);
    const updates = { truckIds };
    if (data.truckDrivers && Object.prototype.hasOwnProperty.call(data.truckDrivers, id)) {
      updates[`truckDrivers.${id}`] = FieldValue.delete();
    }
    batch.update(j.ref, updates);
  });
  batch.delete(trucksCol.doc(id));
  await batch.commit();
  return getState();
}

/* ---------- Writes: drivers ---------- */
async function createDriver(driver) {
  const data = {
    name: driver.name, phone: driver.phone || null, cdl: driver.cdl || null,
    // Free-text aliases this driver is known by in SmartMoving's dispatch "Crew:" text (e.g. a
    // first name, a driver code — see mapIcalEvent.js's header on how inconsistent that format is)
    // — set via the Admin > Drivers panel, matched by findDriverIdBySmartMovingLabel below to
    // auto-assign a job's driver during calendar sync. Mirrors truck.smartMovingLabels exactly
    // (see createTruck above). Empty by default; a driver with no labels set never auto-matches.
    smartMovingLabels: driver.smartMovingLabels || [],
  };
  await driversCol.doc(driver.id).set(data);
  return { id: driver.id, ...data };
}

async function updateDriver(id, fields) {
  const allowed = ['name', 'phone', 'cdl', 'smartMovingLabels'];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
  }
  if (Object.keys(updates).length) await safeUpdate(driversCol.doc(id), updates);
  return docToDriver(await driversCol.doc(id).get());
}

/** Deletes a driver. There's no truck-level link to clean up anymore (see file header) — instead,
    scans every job for a `truckDrivers` entry pointing at this driver and clears just that entry,
    so a deleted driver doesn't linger as a stale assignment on some job's truck. Firestore has no
    way to query "map values containing X", so this reads every job rather than a targeted query —
    fine at this app's scale (a single moving company's job list, not a large multi-tenant one). */
async function deleteDriver(id) {
  const jobSnap = await jobsCol.get();
  const batch = fs.batch();
  jobSnap.forEach((j) => {
    const truckDrivers = j.data().truckDrivers || {};
    const toClear = Object.keys(truckDrivers).filter((truckId) => truckDrivers[truckId] === id);
    if (toClear.length) {
      const updates = {};
      toClear.forEach((truckId) => { updates[`truckDrivers.${truckId}`] = FieldValue.delete(); });
      batch.update(j.ref, updates);
    }
  });
  batch.delete(driversCol.doc(id));
  await batch.commit();
  return getState();
}

/* ---------- Writes: jobs ---------- */
function jobData(job) {
  return {
    customer: job.customer || null, type: job.type || 'local',
    date: job.date, endDate: job.endDate || job.date,
    startTime: job.startTime || null, endTime: job.endTime || null, duration: job.duration ?? null,
    // `??` (not `||`): mapOpportunity.js legitimately sends '' when SmartMoving has no address
    // data for a job. `||` would silently coerce that '' into a real null, which then crashes
    // every frontend spot that calls `.split(',')` on origin/destination assuming it's a string.
    origin: job.origin ?? null, destination: job.destination ?? null,
    crewSize: job.crewSize ?? null, trucksNeeded: job.trucksNeeded || 1,
    // "Original" trucks-needed floor — added 2026-09-08 at the user's request. Snapshot of what
    // trucksNeeded was on FIRST creation (from SmartMoving/Smart Insights/iCal mapping, or whatever
    // a dispatcher typed creating a placeholder). trucksNeeded itself gets pushed UP afterward
    // whenever a dispatcher assigns extra trucks (see useSchedulerData.js's addTruckToJob/
    // addExtraTruckToJob's Math.max bump), but removeTruckFromJob/unassignJob must never let it drop
    // BELOW this floor — otherwise undoing an accidental extra-truck assignment on a job that
    // genuinely needs 2+ trucks (SmartMoving itself says 2) would erase that real requirement right
    // along with the mistake, which is indistinguishable from the mistake using trucksNeeded/
    // truckIds.length alone at removal time. Frozen at creation; the only other writer is
    // JobEditModal's handleSave, and only when a dispatcher actually types a new number into
    // "Trucks needed" there (a deliberate override, re-basing the floor) — never when a Save just
    // resends the same value untouched, or when a truck-assignment action bumps trucksNeeded.
    trucksNeededOriginal: job.trucksNeededOriginal ?? job.trucksNeeded ?? 1,
    status: job.status || null, miles: job.miles ?? null, transitDays: job.transitDays ?? null,
    // Label-derived category for board color grading only (DEL/UPK, LOAD, moving, long_distance,
    // other) — see jobTypeInference.js's inferServiceCategory. Never drives scheduling behavior;
    // `type` above is still the only field that does. Added 2026-08-28.
    serviceCategory: job.serviceCategory || null,
    // Raw label text serviceCategory was classified from (e.g. "Storage Out Bound") — added
    // 2026-09-08 at the user's request, so the board can show what an 'other'-category job
    // specifically IS instead of a generic "OTHER" — see jobTypeInference.js's classifyJob and
    // utils/jobs.js's serviceCategoryText/otherCategoryColor.
    serviceCategoryLabel: job.serviceCategoryLabel || null,
    stage: job.stage || null, source: job.source || null,
    smartMovingJobId: job.smartMovingJobId || null,
    smartMovingOpportunityId: job.smartMovingOpportunityId || null,
    smartMovingStatus: job.smartMovingStatus || null,
    smartMovingStatusCode: job.smartMovingStatusCode ?? null,
    // Added for the iCal sync source (mapIcalEvent.js) — the raw "Trucks:"/"Crew:" text from
    // SmartMoving's dispatch description and a combined notes string, so a dispatcher can see what
    // SmartMoving says even when findTruckIdBySmartMovingLabel couldn't auto-match a local truck.
    smartMovingTruckText: job.smartMovingTruckText || null,
    smartMovingCrewText: job.smartMovingCrewText || null,
    notes: job.notes || null,
    // Added for the Smart Insights report sync (smartInsightsSync.js) — opportunity-level fields
    // that have no equivalent in the REST/iCal sources above. See upsertSmartInsightsJob below.
    smartInsightsQuoteNumber: job.smartInsightsQuoteNumber || null,
    smartInsightsStatus: job.smartInsightsStatus || null,
    smartInsightsEstimatedAmount: job.smartInsightsEstimatedAmount ?? null,
    smartInsightsBranch: job.smartInsightsBranch || null,
    smartInsightsSalesPerson: job.smartInsightsSalesPerson || null,
    // "Manual edit lock" — added 2026-09-08 at the user's request, after confirming that every sync
    // source (REST poll, calendar, Smart Insights) was unconditionally overwriting a job's own
    // detail fields (customer/date/time/addresses/crewSize/notes/type — see MANUAL_EDIT_LOCK_FIELDS
    // below) on every re-sync, with no protection at all beyond truckIds/trucksNeeded/status (those
    // were already dispatcher-owned — see upsertSmartMovingJob's header). Set by
    // markJobManuallyEdited (called from server.js's PATCH /api/jobs/:id handler, only when the
    // diffed changes actually touch one of those fields) and cleared by clearJobManualEdit (the
    // "Resync from source" action) — see both functions below for the full mechanics. null until a
    // dispatcher has ever hand-edited one of those fields.
    manuallyEditedAt: job.manuallyEditedAt ?? null,
    manuallyEditedBy: job.manuallyEditedBy ?? null,
    // Truck-assignment lock — same idea as manuallyEditedAt/By just above, but its own separate flag
    // scoped to truckIds/trucksNeeded/truckDrivers only (added 2026-09-14, split out of the combined
    // lock — see MANUAL_EDIT_LOCK_FIELDS's comment for why). Set by markTruckAssignmentManual, cleared
    // by clearJobManualEdit alongside the detail lock. null until a dispatcher has ever hand-assigned
    // a truck/driver on this job.
    truckLockedAt: job.truckLockedAt ?? null,
    truckLockedBy: job.truckLockedBy ?? null,
    truckIds: job.truckIds || [],
    // Per-truck driver assignment for this job — `{ [truckId]: driverId }`. See the file header for
    // why this replaced a standing driver-to-truck link. New jobs start with an empty map; entries
    // are added/removed one key at a time via setJobTruckDriver, never written wholesale here after
    // creation (updateJob only ever deletes individual keys, when a truck leaves truckIds).
    truckDrivers: job.truckDrivers || {},
    // Manual color override, settable at creation time as of 2026-09-16 ("for placeholder give
    // option for colors") — same field setJobColor writes post-creation (see that function below),
    // just also accepted here so a placeholder job can start out with a pick already applied
    // instead of needing a second click right after it's created. Server.js's POST /api/jobs
    // handler validates this against the same 5-color set setJobColor does before it ever reaches
    // here.
    colorOverride: job.colorOverride || null,
  };
}

async function createJob(job) {
  await jobsCol.doc(job.id).set(jobData(job));
  return getJob(job.id);
}

async function updateJob(id, fields) {
  const allowed = [
    'customer', 'type', 'date', 'endDate', 'startTime', 'endTime', 'duration', 'origin', 'destination',
    'crewSize', 'trucksNeeded', 'trucksNeededOriginal', 'status', 'miles', 'serviceCategory', 'serviceCategoryLabel', 'transitDays', 'stage', 'source',
    'smartMovingJobId', 'smartMovingOpportunityId', 'smartMovingStatus', 'smartMovingStatusCode',
    'smartMovingTruckText', 'smartMovingCrewText', 'notes',
    'smartInsightsQuoteNumber', 'smartInsightsStatus', 'smartInsightsEstimatedAmount',
    'smartInsightsBranch', 'smartInsightsSalesPerson',
  ];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) updates[key] = fields[key];
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'truckIds')) {
    const newTruckIds = fields.truckIds || [];
    updates.truckIds = newTruckIds;
    // A truck that's leaving this job shouldn't leave its driver assignment behind — clear that
    // truck's `truckDrivers` entry too, so if the same truck is re-added to this job later (or a
    // different job reuses the map key), a stale driver pairing doesn't silently reappear. Needs a
    // read first since Firestore has no "delete this map key if present" without knowing the key.
    const existing = await getJob(id);
    const existingTruckDrivers = (existing && existing.truckDrivers) || {};
    Object.keys(existingTruckDrivers).forEach((truckId) => {
      if (!newTruckIds.includes(truckId)) updates[`truckDrivers.${truckId}`] = FieldValue.delete();
    });
  }
  if (Object.keys(updates).length) await safeUpdate(jobsCol.doc(id), updates);
  return getJob(id);
}

/** What counts as a "manual edit" that trips the freeze below — the fields a sync source treats as
 *  its own (customer/date/time/addresses/crewSize/notes/type — always refreshed on every re-sync,
 *  see upsertSmartMovingJob/mergeCalendarDataOntoExistingJob/upsertSmartInsightsJob below).
 *
 *  Briefly (2026-09-08 to 2026-09-14) also covered truckIds/trucksNeeded/truckDrivers, so assigning
 *  a truck or driver locked the whole job — including customer/date/address/etc. — against further
 *  syncing. Reverted 2026-09-14 (user-reported on job 21973-2/-3): SmartMoving corrected those jobs'
 *  dates, but a routine truck assignment made earlier had already locked them, so the REST poll AND
 *  the calendar sync both silently skipped the jobs entirely — including the date fix — until
 *  someone noticed and ran "Resync from source" by hand. That's a worse failure mode than the one
 *  the 2026-09-08 change was guarding against, and unnecessary besides: assignment fields were
 *  already protected from ever being overwritten by a sync without needing the lock's help — no sync
 *  source writes truckIds/truckDrivers onto an existing job at all (see fillAssignmentIfEmpty's
 *  "only if empty" rule), and trucksNeeded is only ever raised, never lowered, by
 *  fillTrucksNeededIfUnset. So dropping these three back out costs nothing on the "don't silently
 *  revert a dispatcher's assignment" front, while letting genuine SmartMoving-owned fields (the date
 *  fix, in particular) keep flowing onto an assigned job instead of freezing along with it.
 *
 *  server.js's PATCH /api/jobs/:id handler checks its diffJobFields() output against this same list
 *  before calling markJobManuallyEdited, since customer/date/etc. all flow through that one generic
 *  handler. POST /api/jobs/:id/set-truck-driver no longer calls markJobManuallyEdited at all — driver
 *  assignment doesn't touch anything in this list anymore, so there's nothing for it to trip. Kept as
 *  one shared list (mirrored in the frontend's utils/jobs.js) so the definition can't drift between
 *  call sites. */
const MANUAL_EDIT_LOCK_FIELDS = [
  'customer', 'type', 'date', 'endDate', 'startTime', 'endTime', 'duration', 'origin', 'destination',
  'crewSize', 'notes',
];

/** Sibling of MANUAL_EDIT_LOCK_FIELDS above, for the separate truck-assignment lock (added
 *  2026-09-14 — see markTruckAssignmentManual's comment). truckDrivers isn't listed here for the
 *  same reason it isn't mechanically checked against MANUAL_EDIT_LOCK_FIELDS either — it never flows
 *  through the generic PATCH /api/jobs/:id handler this list is consulted from (POST
 *  /api/jobs/:id/set-truck-driver has its own dedicated before/after comparison instead). Mirrored
 *  in the frontend's utils/jobs.js for the same optimistic-prediction reason MANUAL_EDIT_LOCK_FIELDS
 *  is. */
const TRUCK_LOCK_FIELDS = ['truckIds', 'trucksNeeded'];

/** One-line ops visibility for a manual-edit-lock skip (see MANUAL_EDIT_LOCK_FIELDS above) — the
 *  REST poll sweep and Smart Insights sync don't thread a skip count back up to their own callers
 *  the way pollGoogleCalendarFeed's skippedManualEdit does (see server.js), so this console.log is
 *  the only record of it for those two paths; shows up in `firebase functions:log`. */
function logManualEditSkip(source, existing) {
  console.log(`[manualEditLock] ${source} sync skipped ${existing.id} — manually edited ${existing.manuallyEditedAt} by ${existing.manuallyEditedBy || 'unknown'}`);
}

/**
 * "Manual edit lock" — see jobData()'s comment on manuallyEditedAt/manuallyEditedBy for the full
 * background. Called from one place in server.js, right after a REAL change to one of
 * MANUAL_EDIT_LOCK_FIELDS (customer/type/date/endDate/startTime/endTime/duration/origin/destination/
 * crewSize/notes) is confirmed against the job's previous state via diffJobFields (so merely opening
 * JobEditModal and clicking Save without changing anything doesn't spuriously lock a job) — the
 * PATCH /api/jobs/:id handler. Once set, upsertSmartMovingJob/mergeCalendarDataOntoExistingJob/
 * upsertSmartInsightsJob all skip this job ENTIRELY on their next sync — not just the fields that
 * were actually edited; see this repo's "freeze the whole job" decision (as opposed to per-field
 * tracking) — until clearJobManualEdit (below) is called.
 *
 * Truck/driver assignment (truckIds/trucksNeeded/truckDrivers) used to also trip this SAME lock
 * (2026-09-08 to 2026-09-14) but no longer does — see MANUAL_EDIT_LOCK_FIELDS's own comment for why.
 * It now has its own separate, narrower lock — see markTruckAssignmentManual below — so a truck
 * reassignment doesn't freeze customer/date/etc, and editing customer/date/etc doesn't freeze truck
 * syncing either. Two independent locks, two independent trigger/target field sets.
 */
async function markJobManuallyEdited(id, actor) {
  await safeUpdate(jobsCol.doc(id), {
    manuallyEditedAt: new Date().toISOString(),
    manuallyEditedBy: actor?.email || null,
  });
  return getJob(id);
}

/**
 * Truck-assignment lock (added 2026-09-14, replacing the truckIds/trucksNeeded/truckDrivers share of
 * the old combined manual-edit lock — see markJobManuallyEdited's comment above and
 * MANUAL_EDIT_LOCK_FIELDS's comment for the full history). Called from server.js right after a REAL
 * change to truckIds/trucksNeeded (PATCH /api/jobs/:id, via diffJobFields) or truckDrivers (POST
 * /api/jobs/:id/set-truck-driver, via its own priorDriverId/newDriverId comparison — that field never
 * flows through the generic PATCH path).
 *
 * Once set, a job's truck/driver assignment is frozen against the calendar sync specifically — see
 * syncTruckAssignmentUnlessLocked below, used by mergeCalendarDataOntoExistingJob — the only sync
 * path that currently carries real truck-assignment data (the calendar event's "Trucks:"/"Crew:"
 * text, matched via findTruckIdBySmartMovingLabel/findDriverIdBySmartMovingLabel). The REST/webhook
 * opportunity poll (mapOpportunity.js) doesn't expose an equivalent truck field at all right now — it
 * always builds jobs with truckIds: [] — so upsertSmartMovingJob's own truck handling (still just
 * fillAssignmentIfEmpty, unchanged) deliberately stays "fill if empty" rather than "sync fully" even
 * once this lock exists: treating that endpoint's permanently-empty truckIds as "SmartMoving says no
 * truck" would silently wipe every non-locked job's assignment on every REST poll. Smart Insights
 * never carries truck data at all (see mapSmartInsightsRow.js), so it's unaffected either way.
 */
async function markTruckAssignmentManual(id, actor) {
  await safeUpdate(jobsCol.doc(id), {
    truckLockedAt: new Date().toISOString(),
    truckLockedBy: actor?.email || null,
  });
  return getJob(id);
}

/** "Resync from source" — clears BOTH locks (the detail-field lock above and the truck-assignment
 *  lock above) in one write, so this job goes back to accepting automatic updates from whichever
 *  sync source(s) still recognize it (matched by id/counterpart id, same as any other job — see
 *  findCounterpartJobId). Doesn't force an immediate re-sync itself; it just lifts both blocks so
 *  the next regular poll sweep / calendar sweep / Smart Insights sync (automatic or manually
 *  triggered via the sync buttons) picks this job up normally again. One combined button/endpoint
 *  for both locks — a dispatcher asking to "resync" a job almost certainly means all of it, and two
 *  separate resync actions for one job would just be confusing for no real benefit. */
async function clearJobManualEdit(id) {
  await safeUpdate(jobsCol.doc(id), {
    manuallyEditedAt: null,
    manuallyEditedBy: null,
    truckLockedAt: null,
    truckLockedBy: null,
  });
  return getJob(id);
}

/** Sets (or, when driverId is falsy, clears) which driver is driving one specific truck on one
    specific job. Uses a single-key dot-path update so sibling trucks' driver assignments on the
    same job — and every other field on the job — are left untouched. Doesn't verify truckId is
    actually in the job's truckIds; server.js's route checks that before calling this. */
async function setJobTruckDriver(jobId, truckId, driverId) {
  const updates = driverId
    ? { [`truckDrivers.${truckId}`]: driverId }
    : { [`truckDrivers.${truckId}`]: FieldValue.delete() };
  await safeUpdate(jobsCol.doc(jobId), updates);
  return getJob(jobId);
}

/** Sets (or, when color is falsy, clears) a job's manual color override — added 2026-09-15 at the
    user's request ("All users to change these colors when clicking on the job"), so a dispatcher's
    (or crew's) deliberate pick always wins over the automatic military/LD/packing/storage/local
    color computed from the job's own fields. Deliberately its OWN narrow field, not part of
    updateJob's `allowed` list and NOT in MANUAL_EDIT_LOCK_FIELDS/TRUCK_LOCK_FIELDS above: it's a
    pure display preference, unrelated to the customer/date/truck data those two locks protect, so
    setting it should never freeze a job against SmartMoving/calendar syncing the way a real detail
    edit does. server.js's own route validates `color` is one of the 5 allowed values (or null to
    clear) before ever calling this — this function trusts its caller. */
async function setJobColor(jobId, color) {
  const updates = color
    ? { colorOverride: color }
    : { colorOverride: FieldValue.delete() };
  await safeUpdate(jobsCol.doc(jobId), updates);
  return getJob(jobId);
}

/** Replaces the full set of trucks assigned to a job. Not called from server.js directly (job
    truck assignment goes through updateJob's `truckIds` field) — kept as its own export for
    parity with the old SQLite version's API surface, in case anything else imports it. */
async function setJobTrucks(jobId, truckIds) {
  await safeUpdate(jobsCol.doc(jobId), { truckIds: truckIds || [] });
}

/**
 * Given a job id from one source ("SM-<num>" from the live REST poll or calendar sync, "SI-<num>"
 * from a Smart Insights report), returns the id the SAME underlying SmartMoving job would carry
 * under the OTHER source — or null if `ownId` doesn't start with either known prefix.
 *
 * Added 2026-08-26 for the iCal/calendar + Smart Insights merge feature: both id schemes are
 * assumed to key off the same raw SmartMoving "job number" string (e.g. "24119-1") — confirmed for
 * Smart Insights (smartInsightsAllJobsReport.js's opportunityIdFromJobNumber strips a trailing
 * "-N" leg suffix from exactly this kind of string) but UNVERIFIED for the calendar/iCal source,
 * since no real sample of mapIcalEvent.js's parsed jobNumber has been checked against a real Smart
 * Insights "Job Number" column value yet. If that assumption turns out wrong once tested against a
 * live sync, the practical effect is simply that the two sources keep landing as separate docs the
 * way they always used to (findCounterpartJob's lookup just never hits) — not an incorrect merge.
 */
function findCounterpartJobId(ownId) {
  if (typeof ownId !== 'string') return null;
  if (ownId.startsWith('SM-')) return `SI-${ownId.slice(3)}`;
  if (ownId.startsWith('SI-')) return `SM-${ownId.slice(3)}`;
  return null;
}

/** Adds truckIds/truckDrivers to `updates` (a Firestore update-payload object being built by one of
 *  the upsert-onto-counterpart branches below) from `incoming`'s auto-matched assignment — but ONLY
 *  when `existing` (the counterpart doc already on file) doesn't already have a truck assigned.
 *  Mirrors this file's established "never overwrite a dispatcher's assignment" rule (see
 *  upsertSmartMovingJob's own header above) but applied at merge time: a job that already exists
 *  under the *other* source's id, with no truck ever assigned to it, is functionally still
 *  unassigned — this fills that gap from freshly synced data rather than overwriting anything a
 *  dispatcher did. Never touches `updates` at all once `existing.truckIds` is non-empty.
 *
 *  As of 2026-09-14, this is ONLY still used by upsertSmartMovingJob's counterpart-merge branch below
 *  (the REST/webhook + dormant iCal path) — mergeCalendarDataOntoExistingJob (the calendar sync) uses
 *  syncTruckAssignmentUnlessLocked instead, which can also CLEAR an assignment, not just fill one.
 *  Kept at "fill only" here deliberately: the REST/webhook opportunity path (mapOpportunity.js) has no
 *  real truck signal to actively sync from — see markTruckAssignmentManual's comment for why
 *  "sync fully" would be unsafe there specifically. */
function fillAssignmentIfEmpty(updates, existing, incoming) {
  const alreadyAssigned = existing && Array.isArray(existing.truckIds) && existing.truckIds.length > 0;
  if (alreadyAssigned) return;
  if (!incoming.truckIds || !incoming.truckIds.length) return;
  updates.truckIds = incoming.truckIds;
  const incomingDrivers = incoming.truckDrivers || {};
  Object.keys(incomingDrivers).forEach((truckId) => {
    updates[`truckDrivers.${truckId}`] = incomingDrivers[truckId];
  });
}

/**
 * Calendar-sync sibling of fillAssignmentIfEmpty above, added 2026-09-14 (user-reported: a truck
 * unassigned on SmartMoving's side stayed assigned here forever, with no way for a sync to ever pick
 * that up). Where fillAssignmentIfEmpty only ever ADDS a truck onto a job that has none yet — so it
 * can never undo a dispatcher's assignment, but also never reflects an assignment SmartMoving removed
 * — this actively keeps truckIds/truckDrivers in sync with the calendar's own current "Trucks:"/
 * "Crew:" match, in both directions, UNLESS the job's truck assignment has been manually fixed here
 * (existing.truckLockedAt — see markTruckAssignmentManual above). Unlocked and the calendar now shows
 * a different truck, or none at all (`incoming.truckIds` empty): this REPLACES `existing.truckIds`/
 * `truckDrivers` to match, including clearing them — that's the whole point of "sync them" rather
 * than "only ever fill them."
 *
 * Deliberately only wired into mergeCalendarDataOntoExistingJob (calendar sync), NOT
 * upsertSmartMovingJob (REST/webhook poll) — see markTruckAssignmentManual's own comment for why:
 * the REST/webhook opportunity path has no real truck signal to sync FROM (mapOpportunity.js always
 * builds truckIds: []), so treating that as "SmartMoving says no truck" would wipe every unlocked
 * job's assignment on every ordinary poll. Only the calendar event's "Trucks:" text is an actual,
 * current signal from SmartMoving about what truck is on the job right now.
 *
 * Known limitation, same one fillAssignmentIfEmpty always had: `incoming.truckIds` being empty could
 * mean the calendar genuinely shows no truck, OR that today's "Trucks:" text just didn't match any
 * truck's smartMovingLabels (typo, unmapped label, reworded text). Both look identical here, so an
 * unlocked job's assignment can now be cleared by a label that stops matching, not just by a real
 * removal — the tradeoff for actually reflecting a real removal instead of never reflecting one at
 * all. A dispatcher who wants an assignment to stick regardless should fix it here once (locks it)
 * rather than relying on the label to keep matching forever.
 */
function syncTruckAssignmentUnlessLocked(updates, existing, incoming) {
  if (existing && existing.truckLockedAt) return;
  const incomingTruckIds = incoming.truckIds || [];
  const currentTruckIds = (existing && existing.truckIds) || [];
  if (JSON.stringify(incomingTruckIds) !== JSON.stringify(currentTruckIds)) {
    updates.truckIds = incomingTruckIds;
  }
  const incomingDrivers = incoming.truckDrivers || {};
  const currentDrivers = (existing && existing.truckDrivers) || {};
  Object.keys(currentDrivers).forEach((truckId) => {
    if (!(truckId in incomingDrivers)) updates[`truckDrivers.${truckId}`] = FieldValue.delete();
  });
  Object.keys(incomingDrivers).forEach((truckId) => {
    if (currentDrivers[truckId] !== incomingDrivers[truckId]) updates[`truckDrivers.${truckId}`] = incomingDrivers[truckId];
  });
}

/**
 * Adopts a sync source's own trucks-needed figure onto an existing job whose trucksNeeded has
 * never actually been engaged with by anything — added 2026-09-08, user-reported on job 23773-1:
 * the calendar description said "Quoted: 2 trucks, 5 crew" (mapIcalEvent.js parses this into
 * `job.trucksNeeded`), the ONE matching truck (ARC 130-2) got correctly auto-assigned by
 * fillAssignmentIfEmpty above, but the job kept showing "1 truck" regardless. Root cause: this job
 * was first created via a Smart Insights report (which never carries a truck count at all — see
 * mapSmartInsightsRow.js — so it always writes the hardcoded trucksNeeded:1 placeholder), and
 * neither upsertSmartMovingJob's/mergeCalendarDataOntoExistingJob's smFields nor
 * fillAssignmentIfEmpty ever refresh trucksNeeded on an EXISTING doc — by design, since it's meant
 * to be dispatcher-owned once genuinely set (see this file's header on truckIds/trucksNeeded/
 * status). The gap: that "never overwrite the dispatcher's number" rule was also protecting a
 * number nobody had actually set — an untouched placeholder default, not a real decision.
 *
 * Distinguishes "never touched" from "a dispatcher's real number" via trucksNeededOriginal (added
 * the same day, for useSchedulerData.js's removeTruckFromJob/unassignJob roll-back) — every path
 * that meaningfully sets trucksNeeded (JobEditModal's deliberate edit, or a truck-assignment
 * auto-bump) also sets that floor, so its absence here means this job's trucksNeeded has never been
 * through any of those. Deliberately INDEPENDENT of fillAssignmentIfEmpty's truckIds guard above —
 * 23773-1 already had its one truck assigned by the time this runs in the same merge, which is
 * exactly the case that needs covering, not excluding. Only ever raises the number (`incomingNeeded
 * <= currentNeeded` bails out), so a genuinely smaller dispatcher-set value already recorded via
 * trucksNeededOriginal is never overridden by a sync's own figure.
 */
function fillTrucksNeededIfUnset(updates, existing, incoming) {
  if (existing && existing.trucksNeededOriginal != null) return;
  const incomingNeeded = incoming.trucksNeeded;
  const currentNeeded = (existing && existing.trucksNeeded) || 1;
  if (!incomingNeeded || incomingNeeded <= currentNeeded) return;
  updates.trucksNeeded = incomingNeeded;
  updates.trucksNeededOriginal = incomingNeeded;
}

/**
 * Bug fixed 2026-08-27 (surfaced investigating a "link a job back to SmartMoving" feature request):
 * mergeCalendarDataOntoExistingJob's smFields (below) was unconditionally overwriting BOTH
 * smartMovingJobId and smartMovingOpportunityId on every single calendar sync, with values that
 * aren't actually authoritative for either field — see mapIcalEvent.js's mapIcalEventToJob:
 * `smartMovingJobId` there is really the Google Calendar EVENT's iCal UID, not a SmartMoving job
 * GUID (a different KIND of identifier that happens to share this field's name because both sources
 * build the same job shape), and `smartMovingOpportunityId` is always null — "not exposed by this
 * feed." So once a job had a REAL SmartMoving GUID/opportunity id from the REST poll or Smart
 * Insights, the very next calendar sync to touch it (now every 5 minutes on weekdays — see
 * functions-index.js) would silently replace the real GUID with the iCal UID and NULL OUT the
 * opportunity id entirely. The opportunity id loss was the more visible breakage: it's what
 * utils/jobs.js's groupByOpportunity() keys on to collapse a multi-job SmartMoving booking (e.g.
 * quote 23569's 23569-1/2/3) into one chip in the unassigned tray/month view — a job that briefly
 * lost its opportunity id to a calendar sync would fall out of its group and render as three
 * separate stray chips instead of one grouped one, until the next REST/Smart Insights sync happened
 * to restore it.
 *
 * Fix, same "protect what a better source already set" shape as fillAssignmentIfEmpty above:
 * whichever of these two fields the existing doc already has a value for is deleted from `updates`
 * before the calendar merge writes anything, so that field is left completely untouched. A field
 * that's still empty (e.g. a job created fresh from a Smart Insights report, which never carries a
 * smartMovingJobId at all) still gets filled in by the calendar sync — better than nothing, same
 * "fill if empty" semantics as fillAssignmentIfEmpty. This is intentionally CALENDAR-ONLY: the REST
 * poll's own upsertSmartMovingJob is left alone — its smartMovingJobId/OpportunityId ARE always real,
 * authoritative SmartMoving values, so it should keep overwriting freely (and, as a side effect,
 * self-heals any job a calendar sync tainted before this fix existed, the next time the REST poll
 * touches it).
 */
function preserveSmartMovingIdentity(updates, existing) {
  if (existing && existing.smartMovingJobId) delete updates.smartMovingJobId;
  if (existing && existing.smartMovingOpportunityId) delete updates.smartMovingOpportunityId;
}

/**
 * Upserts a job pulled from SmartMoving (the live REST poll, or the calendar/iCal sync — see
 * googleCalendarClient.js/icalClient.js). Mirrors the merge logic that used to live in the
 * frontend's importFromSmartMoving(): SmartMoving-owned fields (customer/date/time/addresses/crew
 * size/status) are always refreshed, but truckIds/trucksNeeded/status are left alone once a
 * dispatcher has touched them locally — re-syncing should never undo dispatch work. The one
 * exception is a brand-new job's *initial* truckIds — see createJob below — which the caller
 * (server.js's poll function) may have already auto-resolved from the "Trucks:"/"Crew:" text via
 * findTruckIdBySmartMovingLabel/findDriverIdBySmartMovingLabel; that only ever happens once, at
 * creation (or, since 2026-08-26, once at first merge onto a pre-existing Smart-Insights-sourced
 * counterpart with no assignment yet — see fillAssignmentIfEmpty above).
 *
 * Matches by the job's own `id` first (both mapOpportunity.js and mapIcalEvent.js deterministically
 * build it as `SM-${jobNumber}`), NOT by `smartMovingJobId` — that field's actual VALUE differs by
 * source (the REST API's per-job GUID vs. the calendar feed's iCal UID for the very same real-world
 * job), so matching on it would silently create a duplicate document every time a job first seen
 * via one source got re-synced via the other. `id` is the one natural key both sources agree on.
 *
 * Since 2026-08-26: if no doc exists under this job's own `SM-` id, also checks for a counterpart
 * `SI-` doc (see findCounterpartJobId) before falling back to creating a brand-new doc — merging
 * SmartMoving-owned fields (plus, per fillAssignmentIfEmpty, an assignment if the counterpart has
 * none yet) onto that existing Smart-Insights-sourced record instead of creating a duplicate
 * scheduler entry for the same real-world job.
 */
/** Never lets this source's endDate downgrade a job's already-known multi-day span. Same "genuine
 * improvement only, never a demotion" pattern as fillTrucksNeededIfUnset below: a REST-poll job's
 * endDate (mapOpportunity.js) is either a real multi-day span — when SmartMoving's own tripInfo has
 * a confirmed delivery date — or, when that isn't in SmartMoving yet, just a same-day guess
 * (endDate defaults to `date` there). The reliable source for a real multi-day span is the calendar
 * sync (mergeCalendarDataOntoExistingJob, which applies its own endDate unconditionally below,
 * since it's never guessing) — this poll should never overwrite that with its own guess.
 *
 * Bug fixed 2026-09-10, same root cause/symptom as upsertSmartInsightsJob's siFields fix just below
 * (reported: a multi-day long-distance job's endDate "suddenly" reverted to a single day, so it
 * stopped appearing on any day but its first): clicking "Sync Now" on a job whose multi-day span
 * SmartMoving itself hasn't confirmed yet (no tripInfo.confirmedDeliveryDate) would silently
 * collapse that job's already-correct calendar-set span back to a single day, exactly like the
 * automatic Smart Insights sync used to do unconditionally. */
function applyNonRegressingEndDate(updates, existing, job) {
  if (!job.endDate) return;
  const existingEnd = existing && existing.endDate;
  if (!existingEnd || job.endDate >= existingEnd) updates.endDate = job.endDate;
}

async function upsertSmartMovingJob(job) {
  const smFields = {
    customer: job.customer, type: job.type, date: job.date,
    startTime: job.startTime, endTime: job.endTime, duration: job.duration, origin: job.origin, destination: job.destination,
    crewSize: job.crewSize,
    // Computed from origin/destination ZIPs (jobTypeInference.js) — refreshed on every sync just
    // like `type`, not treated as dispatcher-owned. `?? undefined` (not `?? null`) deliberately:
    // when THIS source's addresses can't yield a value (e.g. no readable ZIP), that should leave
    // whatever a previous, better-addressed sync already computed alone rather than clobbering it
    // with null — `ignoreUndefinedProperties` (see firestore.js) drops an undefined key from the
    // update entirely, matching the old SQLite layer's "missing key = don't touch that column".
    // Added 2026-08-28.
    miles: job.miles ?? undefined, serviceCategory: job.serviceCategory ?? undefined,
    serviceCategoryLabel: job.serviceCategoryLabel ?? undefined,
    smartMovingJobId: job.smartMovingJobId,
    smartMovingOpportunityId: job.smartMovingOpportunityId,
    smartMovingStatus: job.smartMovingStatus, smartMovingStatusCode: job.smartMovingStatusCode,
    smartMovingTruckText: job.smartMovingTruckText, smartMovingCrewText: job.smartMovingCrewText,
    notes: job.notes,
  };

  const existingSnap = await jobsCol.doc(job.id).get();
  if (existingSnap.exists) {
    const existingId = job.id;
    const existing = docToJob(existingSnap);
    // Manual edit lock (added 2026-09-08 — see jobData()'s comment on manuallyEditedAt): a
    // dispatcher's hand-corrected date/time/address/etc. should never get silently reverted by the
    // next poll sweep just because SmartMoving's own copy still says something else. Skip this job
    // entirely rather than refreshing smFields onto it.
    if (existing && existing.manuallyEditedAt) {
      logManualEditSkip('REST poll', existing);
      return { job: existing, created: false, skippedManualEdit: true };
    }
    const updates = { ...smFields, source: 'smartmoving' };
    applyNonRegressingEndDate(updates, existing, job);
    await updateJob(existingId, updates);
    return { job: await getJob(existingId), created: false };
  }

  const counterpartId = findCounterpartJobId(job.id);
  const counterpartSnap = counterpartId ? await jobsCol.doc(counterpartId).get() : null;
  if (counterpartSnap && counterpartSnap.exists) {
    const existing = docToJob(counterpartSnap);
    if (existing && existing.manuallyEditedAt) {
      logManualEditSkip('REST poll', existing);
      return { job: existing, created: false, merged: false, skippedManualEdit: true };
    }
    // Prefer 'smartmoving' as the merged doc's source label: the calendar/REST path carries the
    // richer per-job dispatch detail (real start time, Trucks:/Crew: text) that a Smart-Insights-
    // sourced record never had — this is an upgrade, not a demotion, of what that record can show.
    const updates = { ...smFields, source: 'smartmoving' };
    fillAssignmentIfEmpty(updates, existing, job);
    fillTrucksNeededIfUnset(updates, existing, job);
    applyNonRegressingEndDate(updates, existing, job);
    await safeUpdate(counterpartSnap.ref, updates);
    return { job: await getJob(counterpartId), created: false, merged: true };
  }

  await createJob(job);
  return { job: await getJob(job.id), created: true };
}

/**
 * Calendar-sync-specific sibling of upsertSmartMovingJob, added 2026-08-27 at the user's explicit
 * request: "don't add new jobs" from the calendar sync. Every job on the board should originate
 * from a report or a dispatcher, never be created purely because it showed up on SmartMoving's
 * synced calendar — the calendar sync's role is now ENRICHMENT ONLY (truck assignment, and the
 * long-distance end date — see mapIcalEvent.js's endDate derivation), applied on top of a job that
 * already exists some other way. Concretely: matches the SAME two ways upsertSmartMovingJob does —
 * this job's own `SM-` id already synced before, or a `SI-` counterpart from a Smart Insights report
 * (see findCounterpartJobId) — but where upsertSmartMovingJob falls back to createJob() when NEITHER
 * matches, this just skips the event entirely (`matched: false`, nothing written). A calendar event
 * whose job number was never reported by Smart Insights (not booked yet, or simply not this app's
 * jobs) is left alone rather than becoming its own unassigned scheduler entry — which is exactly
 * what was cluttering the board with stray "non-binding" jobs before this existed (a run against
 * live data 2026-08-26 synced 341 calendar events against only 258 Smart Insights counterparts —
 * the other 83 were landing as brand-new, truck-less entries).
 *
 * server.js's pollGoogleCalendarFeed should call this instead of upsertSmartMovingJob. That older
 * function is untouched and still used by the REST poll (pollSweep/hydrateOpportunity) and the
 * dormant pollIcalFeed — both of those are still expected to create brand-new jobs; only the
 * calendar sync's "don't add new jobs" behavior is new.
 */
async function mergeCalendarDataOntoExistingJob(job) {
  const smFields = {
    customer: job.customer, type: job.type, date: job.date, endDate: job.endDate,
    startTime: job.startTime, endTime: job.endTime, duration: job.duration, origin: job.origin, destination: job.destination,
    crewSize: job.crewSize,
    // Computed from origin/destination ZIPs (jobTypeInference.js) — refreshed on every sync just
    // like `type`, not treated as dispatcher-owned. `?? undefined` (not `?? null`) deliberately:
    // when THIS source's addresses can't yield a value (e.g. no readable ZIP), that should leave
    // whatever a previous, better-addressed sync already computed alone rather than clobbering it
    // with null — `ignoreUndefinedProperties` (see firestore.js) drops an undefined key from the
    // update entirely, matching the old SQLite layer's "missing key = don't touch that column".
    // Added 2026-08-28.
    miles: job.miles ?? undefined, serviceCategory: job.serviceCategory ?? undefined,
    serviceCategoryLabel: job.serviceCategoryLabel ?? undefined,
    smartMovingJobId: job.smartMovingJobId,
    smartMovingOpportunityId: job.smartMovingOpportunityId,
    smartMovingStatus: job.smartMovingStatus, smartMovingStatusCode: job.smartMovingStatusCode,
    smartMovingTruckText: job.smartMovingTruckText, smartMovingCrewText: job.smartMovingCrewText,
    notes: job.notes,
  };

  // Bug fixed 2026-08-28: this branch used to call updateJob() directly with just smFields, which
  // NEVER applies an auto-matched truck — server.js sets job.truckIds locally (from
  // findTruckIdBySmartMovingLabel) before calling this function, but smFields deliberately excludes
  // truckIds (see the counterpart-merge branch below), and updateJob() only touches truckIds when
  // the caller explicitly passes it. So a job that already exists under its own SM- id (i.e. was
  // already seen by a PRIOR calendar sync, before any truck labels were registered) could never
  // pick up a truck on a LATER sync even once labels were added and matching started working — only
  // the counterpart-merge branch below used to call the truck-sync helper. Now mirrors that branch
  // exactly: fetch the existing doc, let syncTruckAssignmentUnlessLocked keep the truck/driver
  // assignment in step with the calendar's own current match UNLESS this job's assignment has been
  // manually fixed here (see that function's own comment), and write via safeUpdate directly (not
  // updateJob) since its dot-path `truckDrivers.<id>` keys aren't in updateJob's field allowlist and
  // would silently be dropped by it.
  const existingSnap = await jobsCol.doc(job.id).get();
  if (existingSnap.exists) {
    const existingId = job.id;
    const existing = docToJob(existingSnap);
    // Manual edit lock (added 2026-09-08 — see jobData()'s comment on manuallyEditedAt): skip this
    // job entirely rather than refreshing smFields onto it. Still counts as `matched` (the calendar
    // sync did find this job) but not `merged` (nothing was actually written) — see
    // pollGoogleCalendarFeed's skippedManualEdit tally in server.js. This is the DETAIL lock only —
    // truck assignment has its own separate lock, checked inside syncTruckAssignmentUnlessLocked
    // below, so a job can still get its truck synced even while nothing else about it is locked
    // (and vice versa).
    if (existing && existing.manuallyEditedAt) {
      logManualEditSkip('calendar', existing);
      return { job: existing, matched: true, merged: false, skippedManualEdit: true };
    }
    const updates = { ...smFields, source: 'smartmoving' };
    syncTruckAssignmentUnlessLocked(updates, existing, job);
    fillTrucksNeededIfUnset(updates, existing, job);
    preserveSmartMovingIdentity(updates, existing);
    await safeUpdate(existingSnap.ref, updates);
    return { job: await getJob(existingId), matched: true, merged: false };
  }

  const counterpartId = findCounterpartJobId(job.id);
  const counterpartSnap = counterpartId ? await jobsCol.doc(counterpartId).get() : null;
  if (counterpartSnap && counterpartSnap.exists) {
    const existing = docToJob(counterpartSnap);
    if (existing && existing.manuallyEditedAt) {
      logManualEditSkip('calendar', existing);
      return { job: existing, matched: true, merged: false, skippedManualEdit: true };
    }
    const updates = { ...smFields, source: 'smartmoving' };
    syncTruckAssignmentUnlessLocked(updates, existing, job);
    fillTrucksNeededIfUnset(updates, existing, job);
    preserveSmartMovingIdentity(updates, existing);
    await safeUpdate(counterpartSnap.ref, updates);
    return { job: await getJob(counterpartId), matched: true, merged: true };
  }

  // No existing job anywhere for this job number — per "don't add new jobs", skip it. Nothing is
  // written; the caller (server.js) just counts this as skipped for its own diagnostics.
  return { job: null, matched: false, merged: false };
}

/**
 * Upserts a job pulled from a SmartMoving Smart Insights report (see smartInsightsSync.js). Same
 * "refresh source-owned fields, leave dispatcher-owned fields alone" shape as
 * upsertSmartMovingJob above — truckIds/trucksNeeded/status are only ever set on first creation
 * (Smart Insights reports carry no truck/crew data of their own to auto-assign from anyway), never
 * overwritten by a later day's re-sync, so a dispatcher's truck assignment or status change
 * survives every subsequent daily sync of the same quote.
 *
 * Matches by `id` (`SI-${quoteNumber}`, built by mapSmartInsightsRow.js) first — distinct from the
 * `SM-${jobNumber}` ids the REST/calendar sources use, so a job seen via both paths doesn't collide
 * on id alone. Since 2026-08-26: if no `SI-` doc exists yet, also checks for a counterpart `SM-`
 * doc (see findCounterpartJobId) and merges Smart-Insights-owned fields onto it instead of creating
 * a second scheduler entry for the same real-world job — `source` is deliberately left untouched in
 * that merge branch (see upsertSmartMovingJob's comment on why 'smartmoving' is the preferred merged
 * label), so a doc that already has calendar-sourced dispatch detail keeps showing as such; the
 * Smart Insights fields (quote number, estimated amount, sales person, branch) are still recorded
 * onto it for reference. (Separate from this: duplicate-placeholder detection — a manually created
 * job whose customer name matches an incoming Smart Insights job — is handled client-side; see
 * utils/jobs.js's getPlaceholderDuplicates().)
 */
async function upsertSmartInsightsJob(job) {
  const siFields = {
    // Bug fixed 2026-09-10 (reported: a multi-day long-distance job's endDate "suddenly" reverted
    // to a single day, so it stopped appearing on any day but its first — even though nobody
    // touched it, and only non-manually-edited jobs were affected). Root cause: `endDate` used to
    // be included here unconditionally, but mapSmartInsightsRow.js ALWAYS sets endDate: null for
    // every row (this source has no delivery-date data at all — see its own file). The ONLY source
    // that ever computes a real multi-day endDate is the Google Calendar sync
    // (mapIcalEvent.js/mergeCalendarDataOntoExistingJob). Smart Insights syncs run automatically
    // twice a day; every one of those runs was silently overwriting whatever real endDate a prior
    // calendar sync had set, right back to null — exactly the "all of a sudden, all of them"
    // pattern reported, and exactly why manually-edited jobs were spared (the manual-edit-lock skip
    // above bails out before siFields is ever applied to them). Fix: don't include endDate here at
    // all — same reasoning as why truckIds/trucksNeeded/status aren't in siFields either: this
    // source has nothing real to contribute to that field on an UPDATE, so it shouldn't touch it.
    // (Still fine at job CREATION time below/in jobData() — a brand-new Smart-Insights-only job
    // simply starts single-day (endDate falls back to date) until a calendar sync can extend it,
    // same as before.)
    customer: job.customer, type: job.type, date: job.date,
    origin: job.origin, destination: job.destination,
    // See upsertSmartMovingJob's smFields for the `?? undefined` reasoning — matters even more
    // here, since `movingFrom`/`movingTo` (Smart Insights report text) don't always carry a ZIP,
    // so this source often can't compute miles at all; `?? undefined` keeps that from clobbering
    // a good value a calendar sync already computed for the same job. Added 2026-08-28.
    miles: job.miles ?? undefined, serviceCategory: job.serviceCategory ?? undefined,
    serviceCategoryLabel: job.serviceCategoryLabel ?? undefined,
    smartInsightsQuoteNumber: job.smartInsightsQuoteNumber,
    smartInsightsStatus: job.smartInsightsStatus,
    smartInsightsEstimatedAmount: job.smartInsightsEstimatedAmount,
    smartInsightsBranch: job.smartInsightsBranch,
    smartInsightsSalesPerson: job.smartInsightsSalesPerson,
  };

  const existingSnap = await jobsCol.doc(job.id).get();
  if (existingSnap.exists) {
    const existingId = job.id;
    const existing = docToJob(existingSnap);
    // Manual edit lock (added 2026-09-08 — see jobData()'s comment on manuallyEditedAt): skip this
    // job entirely rather than refreshing siFields onto it.
    if (existing && existing.manuallyEditedAt) {
      logManualEditSkip('Smart Insights', existing);
      return { job: existing, created: false, skippedManualEdit: true };
    }
    await updateJob(existingId, { ...siFields, source: 'smartmoving-insights' });
    return { job: await getJob(existingId), created: false };
  }

  const counterpartId = findCounterpartJobId(job.id);
  const counterpartSnap = counterpartId ? await jobsCol.doc(counterpartId).get() : null;
  if (counterpartSnap && counterpartSnap.exists) {
    const existing = docToJob(counterpartSnap);
    if (existing && existing.manuallyEditedAt) {
      logManualEditSkip('Smart Insights', existing);
      return { job: existing, created: false, merged: false, skippedManualEdit: true };
    }
    // No fillAssignmentIfEmpty call here — a Smart Insights row never carries truck/crew data, so
    // there's nothing for it to contribute to an assignment either way.
    await safeUpdate(counterpartSnap.ref, siFields);
    return { job: await getJob(counterpartId), created: false, merged: true };
  }

  await createJob(job);
  return { job: await getJob(job.id), created: true };
}

/** Removes a Smart Insights-sourced job from Firestore because SmartMoving's own "All Jobs" report
 * now marks its row as lost/dead/cancelled (see smartInsightsSync.js's TERMINAL_JOB_STATUSES) —
 * added at the user's request so a move that fell through actually disappears from the board
 * instead of sitting there stale forever (upsertSmartInsightsJob's normal sync just stops touching
 * a terminal row, it never used to remove what it had already created).
 *
 * `id` is always `SI-<jobNumber>` (mapSmartInsightsRow.js), the SAME id scheme upsertSmartInsightsJob
 * writes new jobs under — so this only ever looks up a doc at that exact id. It deliberately does
 * NOT go looking for a "counterpart" the way upsertSmartInsightsJob's findCounterpartJobId does: if
 * this job's Smart Insights data was instead merged onto an existing SmartMoving/calendar-sourced
 * job (a different doc, its OWN `SM-...` id), that doc is a real dispatched job from a different,
 * still-trustworthy source — deleting it just because this one report's row went stale would be far
 * more destructive than leaving a few now-unused smartInsights* fields on it. The `source` check
 * below is a second layer of the same guard: even if something else ever re-used an `SI-` id for a
 * non-Smart-Insights job, this still refuses to touch it.
 *
 * Deletes unconditionally, including a job a dispatcher has already manually edited or assigned a
 * truck to (manuallyEditedAt/truckLockedAt) — unlike every other Smart Insights write path, which
 * treats those as sacred. That's deliberate here: "manually edited" protects a job's DETAILS from
 * being silently overwritten by a routine resync, it was never meant to keep a job that isn't
 * happening anymore parked on the board. Logs loudly (console.log) whenever it overrides a lock, so
 * that override is at least visible in the Cloud Function logs even though — same as every other
 * automated sync write — it doesn't go through logJobChange's per-job audit history (see that
 * function's own doc comment on why automated syncs never call it).
 *
 * @returns {Promise<boolean>} true if a job was actually deleted.
 */
async function removeLostSmartInsightsJob(id) {
  const snap = await jobsCol.doc(id).get();
  if (!snap.exists) return false;
  const existing = docToJob(snap);
  if (existing.source !== 'smartmoving-insights') return false; // never touch a merged/other-sourced job
  if (existing.manuallyEditedAt || existing.truckLockedAt) {
    console.log(`[smartInsightsSync] removing ${id} despite manual lock (manuallyEditedAt=${existing.manuallyEditedAt || 'no'}, truckLockedAt=${existing.truckLockedAt || 'no'}) — marked lost/cancelled in the All Jobs report`);
  }
  await snap.ref.delete();
  return true;
}

/* ---------- Users (login accounts) ----------
   Email + password login (see auth.js) with an allowlist-and-invite model: an admin creates a row
   here in advance (via the Users panel or create-admin.js) with just an email and role — that
   grants access, but `passwordHash` starts null, so the account can't sign in yet. The new user
   (or anyone locked out later) uses "Forgot password?" on the login screen, which emails a one-time
   code and lets them set a password themselves — the same flow serves both "first time setting a
   password" and "actually forgot it," so there's only one code path to reason about instead of two. */
async function createUser({ id, email, role, passwordHash }) {
  const data = {
    email, role: role || 'dispatcher', createdAt: new Date().toISOString(),
    passwordHash: passwordHash || null, otpHash: null, otpExpiresAt: null,
  };
  await usersCol.doc(id).set(data);
  return getUserById(id);
}

async function listUsers() {
  const snap = await usersCol.orderBy('createdAt').get();
  return snap.docs.map((d) => {
    const data = d.data();
    return { id: d.id, email: data.email, role: data.role, createdAt: data.createdAt, hasPassword: Boolean(data.passwordHash) };
  });
}

async function getUserByEmail(email) {
  const snap = await usersCol.where('email', '==', email).limit(1).get();
  return snap.empty ? null : docToUser(snap.docs[0]);
}

async function getUserById(id) {
  return docToUser(await usersCol.doc(id).get());
}

async function updateUserRole(id, role) {
  await safeUpdate(usersCol.doc(id), { role });
  return getUserById(id);
}

async function deleteUser(id) {
  await usersCol.doc(id).delete();
}

async function countAdmins() {
  const snap = await usersCol.where('role', '==', 'admin').get();
  return snap.size;
}

/** Sets a new password and clears any outstanding OTP in the same call — used both by the
    reset-password route (OTP flow) and create-admin.js (direct CLI password set). */
async function setUserPassword(id, passwordHash) {
  await safeUpdate(usersCol.doc(id), { passwordHash, otpHash: null, otpExpiresAt: null });
  return getUserById(id);
}

/** Stores the (hashed) one-time code for a password reset/first-time-setup request. Overwrites
    whatever code was previously outstanding for this account, so at most one is ever valid. */
async function setUserOtp(id, otpHash, otpExpiresAt) {
  await safeUpdate(usersCol.doc(id), { otpHash, otpExpiresAt });
}

async function clearUserOtp(id) {
  await safeUpdate(usersCol.doc(id), { otpHash: null, otpExpiresAt: null });
}

/* ---------- Gmail/Calendar OAuth re-auth tracking ----------
   Google's OAuth "Testing" publishing status auto-expires the refresh token
   server/smartInsightsGmail.js runs on every 7 days (see that file's header) — this doc is what
   lets the board warn about that BEFORE it actually breaks a sync, instead of everyone finding out
   from an invalid_grant error days later. Written only by server/gmail-oauth-setup.js, right after
   a successful re-auth (it's the one place that actually knows "a brand new token was just
   issued" — the deployed backend just sees whatever token is in the secret and has no way to tell
   a fresh one from a week-old one). Read by GET /api/gmail-auth-status (server.js). */
async function getGmailAuthStatus() {
  const doc = await systemCol.doc(GMAIL_AUTH_DOC_ID).get();
  return doc.exists ? doc.data() : null;
}

async function setGmailAuthRefreshed(refreshedAt) {
  await systemCol.doc(GMAIL_AUTH_DOC_ID).set({ refreshedAt }, { merge: true });
}

/* ---------- Allowed external emails ----------
   Access is normally gated to @aroundtownmovers.com addresses (see auth.js's isCompanyEmail and
   server.js's POST /api/users) — this is the escape hatch for the occasional legitimate exception
   (e.g. a partner/subcontractor at a different company who needs real access to the scheduler, like
   paul@campbellmoving.com, added 2026-08-25). Rather than hardcoding one-off email addresses into
   the backend's source, an admin manages this list from the Users panel itself: adding an email
   here doesn't grant access by itself — it only lifts the domain restriction so that email CAN then
   be granted access the normal way (the "+ Grant Access" form, with a role chosen there), keeping
   role assignment as the one single place access is actually turned on. Doc id is the normalized
   email itself (no separate id field needed — email uniqueness is exactly what a Firestore doc id
   already guarantees, and it makes "is this email allowed" a single doc read instead of a query). */
async function addAllowedExternalEmail(email, { addedByEmail, note } = {}) {
  const data = { email, addedByEmail: addedByEmail || null, note: note || '', addedAt: new Date().toISOString() };
  await allowedExternalEmailsCol.doc(email).set(data);
  return data;
}

async function listAllowedExternalEmails() {
  const snap = await allowedExternalEmailsCol.orderBy('addedAt').get();
  return snap.docs.map((d) => d.data());
}

async function isEmailAllowedExternally(email) {
  const doc = await allowedExternalEmailsCol.doc(email).get();
  return doc.exists;
}

async function removeAllowedExternalEmail(email) {
  await allowedExternalEmailsCol.doc(email).delete();
}

/* ---------- Bulk delete / reset ---------- */
/** Firestore batched writes cap at 500 operations — chunk defensively even though this app's scale
    (dozens of trucks/drivers, low thousands of jobs at most) will rarely if ever need more than
    one batch. */
async function deleteAllInCollection(col) {
  const snap = await col.get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = fs.batch();
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

async function clearAll() {
  await Promise.all([
    deleteAllInCollection(jobsCol),
    deleteAllInCollection(driversCol),
    deleteAllInCollection(trucksCol),
  ]);
}

async function seed(trucks, drivers, jobs) {
  for (const t of trucks) await createTruck(t);
  for (const d of drivers) await createDriver(d);
  for (const j of jobs) await createJob(j);
}

async function resetToSampleData() {
  await clearAll();
  await seed(SAMPLE_TRUCKS, SAMPLE_DRIVERS, SAMPLE_JOBS);
  return getState();
}

/** Empties jobs ONLY — trucks and drivers (the fleet) are left alone. For going live with real job
    data (e.g. once SmartMoving sync or manual entry is the actual source of jobs) without having to
    re-enter trucks/drivers that are already set up correctly. */
async function clearJobs() {
  await deleteAllInCollection(jobsCol);
  return getState();
}

/** Permanently removes one job — currently only exposed in the UI for manually-created
    "placeholder" jobs (source = 'placeholder'), not SmartMoving-sourced ones, which would just
    reappear on the next poll sweep anyway since the backend has no way to tell SmartMoving "stop
    syncing this." The route itself doesn't enforce that restriction, so it's a UI-level choice, not
    a data-layer one — see server.js's DELETE /api/jobs/:id. */
// Soft-deletes a job: archives it to deletedJobsCol (with who/when) instead of a hard delete, then
// removes it from jobsCol. Widened 2026-09-24, at the user's request ("add a feature to delete the
// job... make the deleted store in the deleted jobs... also save who deleted it at what time"), to
// every job — was hard-delete, placeholder-only before this. Takes the caller's already-read `job`
// object (avoids a redundant Firestore read — server.js already fetches it to 404-check before
// calling this) and `deletedBy` (the current user, for the audit trail).
//
// Standing caveat, unchanged by this rewrite: deleting a real SmartMoving-sourced job does NOT stop
// a future sync from re-creating it under a new id — no sync path currently checks for a
// "tombstone" here. Building that tombstone-awareness into the sync upsert paths was deliberately
// NOT done in this pass, since it touches sync/job-lifecycle logic this project's own notes flag as
// sensitive to change without a much closer look.
async function deleteJob(id, job, deletedBy) {
  if (job) {
    const { id: _jobId, ...jobData } = job;
    await deletedJobsCol.doc(id).set({
      ...jobData,
      deletedBy: deletedBy ? { id: deletedBy.id, email: deletedBy.email, role: deletedBy.role } : null,
      deletedAt: FieldValue.serverTimestamp(),
    });
  }
  await jobsCol.doc(id).delete();
  return getState();
}

/** Lists every archived (soft-deleted) job, newest first, for the hidden "Deleted Jobs" panel —
    see Header.jsx's secret click-trigger and DeletedJobsPanel.jsx. deletedAt is normalized to an
    ISO string here (same pattern docToJob-adjacent helpers elsewhere in this file use) since a raw
    Firestore Timestamp doesn't serialize usefully straight through sendJson. */
async function listDeletedJobs() {
  const snap = await deletedJobsCol.orderBy('deletedAt', 'desc').get();
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      ...data,
      deletedAt: data.deletedAt && data.deletedAt.toDate ? data.deletedAt.toDate().toISOString() : data.deletedAt || null,
    };
  });
}

/** Restores an archived job back into jobsCol under its original id, then removes it from the
    archive. Doesn't try to re-validate the restored job against trucks/drivers that may have
    changed while it sat deleted (e.g. a truck it references could since be gone) — same "trust the
    stored shape" approach the rest of this file takes when reading jobs back, not a new gap
    introduced here. */
async function restoreJob(id) {
  const doc = await deletedJobsCol.doc(id).get();
  if (!doc.exists) { const err = new Error('Deleted job not found'); err.status = 404; throw err; }
  const { deletedBy, deletedAt, ...jobData } = doc.data();
  await jobsCol.doc(id).set(jobData);
  await deletedJobsCol.doc(id).delete();
  return getState();
}

/** Permanently removes one archived job from deletedJobsCol — added 2026-09-24 at the user's
 * request, after a bulk cleanup (131 empty SmartMoving-Insights phantom jobs, see
 * smartInsightsSync.js's TERMINAL_JOB_STATUSES doc comment for that story) filled the Deleted Jobs
 * panel with entries nobody will ever want to restore. Unlike restoreJob just above, this is a true
 * hard delete with no further recovery — no "un-permanently-delete" path exists, by design (a
 * second archive of an archive would just be the same problem one level down). Only ever touches
 * deletedJobsCol, never jobsCol — a job has to already be in the archive (i.e. already removed from
 * the live board via deleteJob) before this can do anything to it. Returns whether a doc actually
 * existed to delete, same true/false shape as removeLostSmartInsightsJob, so the route can 404 a
 * stale id (e.g. a double-click, or two admins racing) instead of reporting success for nothing. */
async function permanentlyDeleteArchivedJob(id) {
  const doc = await deletedJobsCol.doc(id).get();
  if (!doc.exists) return false;
  await deletedJobsCol.doc(id).delete();
  return true;
}

/**
 * Records one human-made change to a job into that job's own `history` subcollection (see
 * jobHistoryCol above) — added 2026-09-02 at the user's request ("can we make a log if the job is
 * updated by someone... no one has to access it only me", then "make history log of primary id,
 * the job id, and make the collection for that id"). Deliberately NOT surfaced anywhere in this
 * app's own API or UI — by design, the only way to read this back is directly in the Firebase
 * console's Firestore data viewer (open the job, open its `history`), which is enough given nobody
 * but the account owner needs to see it; that also means there's no new role/permission surface to
 * get wrong. Only ever called from server.js's job routes, right where the logged-in
 * dispatcher/admin's identity (from getCurrentUser) is already in scope for the requireRole check
 * those routes already do — automated SmartMoving sync writes (the REST poll, the calendar sync,
 * the Smart Insights report sync) never call this, since those aren't "someone" doing anything; see
 * upsertSmartMovingJob/mergeCalendarDataOntoExistingJob/upsertSmartInsightsJob above, none of which
 * touch this collection.
 *
 * `changes` is a plain object shaped `{ field: { from, to } }` for an update (see server.js's
 * diffJobFields — only the fields that actually differ) or set-truck-driver (a single entry), or
 * `{ job: <full snapshot> }` for a create/delete, where there's no "before" or "after" to diff
 * against. Failure here is swallowed (logged to the server console, not thrown) rather than ever
 * blocking or rolling back the real job mutation that triggered it — losing one audit entry to a
 * transient Firestore hiccup is far better than losing a dispatcher's actual change over it.
 */
async function logJobChange({ jobId, action, actor, changes }) {
  try {
    await jobHistoryCol(jobId).add({
      // Redundant with the doc's own parent path (jobs/{jobId}/history/...) but kept as a real
      // field too — harmless, and it means this subcollection could still be queried across EVERY
      // job at once later via Firestore's collectionGroup('history') without also having to parse
      // jobId back out of each doc's path.
      jobId,
      action, // 'create' | 'update' | 'delete' | 'set-truck-driver'
      actorId: actor?.id || null,
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
      changes: changes || null,
      at: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[jobAuditLog] failed to record "${action}" on job ${jobId}:`, err);
  }
}

/** Seeds sample data if the database is completely empty (checked via the trucks collection alone,
    same as the old SQLite version's truckCount check). Call this once at startup, awaited, before
    server.listen() — see server.js. An existing database (with real dispatcher work in it) is
    never silently overwritten; this only ever fires the very first time against a brand new,
    empty Firestore database. */
async function initDb() {
  const snap = await trucksCol.limit(1).get();
  if (snap.empty) {
    await seed(SAMPLE_TRUCKS, SAMPLE_DRIVERS, SAMPLE_JOBS);
    return;
  }
  // Backfill `order` on any truck that predates drag-and-drop reordering (e.g. every truck carried
  // over from the original SQLite migration) — assigns them their current id-sorted position, one
  // time, so reordering has a real starting point instead of every truck defaulting to the same
  // "missing order" bucket. Cheap even at hundreds of trucks; a no-op once every truck has one.
  await backfillTruckOrder();
}

async function backfillTruckOrder() {
  const snap = await trucksCol.get();
  const all = snap.docs.map((d) => ({ id: d.id, order: d.data().order }));
  const missing = all.filter((t) => typeof t.order !== 'number').sort(sortById);
  if (!missing.length) return;
  // Starts after whatever's already assigned, not at 0 — avoids colliding with real order values
  // on trucks that already have one (only relevant if this ever runs against a mixed state; on
  // this app's very first run after adding reordering, every truck is missing order and this is 0).
  let next = all.reduce((max, t) => (typeof t.order === 'number' && t.order > max ? t.order : max), -1) + 1;
  const batch = fs.batch();
  missing.forEach((t) => { batch.update(trucksCol.doc(t.id), { order: next++ }); });
  await batch.commit();
}

/**
 * Jobs already in Firestore that came from SmartMoving (have a smartMovingOpportunityId) with a
 * date in [fromIso, toIso]. Used by server.js's diff-only pollSweep (2026-09-30) to skip
 * re-hydrating opportunities webhooks have already kept current. Single-field range query on
 * `date`, so no composite index needed; the opportunity-id filter happens in memory.
 */
async function listSmartMovingJobsInRange(fromIso, toIso) {
  const snap = await jobsCol.where('date', '>=', fromIso).where('date', '<=', toIso).get();
  return snap.docs.map(docToJob).filter(j => j && j.smartMovingOpportunityId);
}

/* Every function below changes board data (trucks/drivers/jobs), so each is wrapped to bump the
 * change-version after it runs (in `finally`, so a partially-applied write still invalidates).
 * Deliberately NOT wrapped: initDb (runs every cold start), history/audit logging, users, the
 * deleted-jobs archive and Gmail auth — none of those appear in /api/state. */
const WRITERS = [
  'createTruck', 'updateTruck', 'deleteTruck', 'reorderTrucks',
  'createDriver', 'updateDriver', 'deleteDriver',
  'createJob', 'updateJob', 'deleteJob', 'restoreJob', 'setJobTrucks', 'setJobTruckDriver', 'setJobColor',
  'upsertSmartMovingJob', 'upsertSmartInsightsJob', 'removeLostSmartInsightsJob',
  'fillAssignmentIfEmpty', 'mergeCalendarDataOntoExistingJob',
  'markJobManuallyEdited', 'markTruckAssignmentManual', 'clearJobManualEdit',
  'resetToSampleData', 'clearJobs',
];
function withVersionBump(fn) {
  return async function (...args) {
    try { return await fn.apply(this, args); } finally { await bumpDataVersion(); }
  };
}

const exported = {
  initDb,
  getState, getStateIfChanged, getDataVersion, getCounts, getJob,
  createTruck, updateTruck, deleteTruck, reorderTrucks,
  findTruckIdBySmartMovingLabel, findDriverIdBySmartMovingLabel,
  createDriver, updateDriver, deleteDriver,
  createJob, updateJob, deleteJob, listDeletedJobs, restoreJob, permanentlyDeleteArchivedJob, setJobTrucks, setJobTruckDriver, setJobColor, upsertSmartMovingJob,
  upsertSmartInsightsJob, removeLostSmartInsightsJob, findCounterpartJobId, fillAssignmentIfEmpty, mergeCalendarDataOntoExistingJob,
  logJobChange, markJobManuallyEdited, markTruckAssignmentManual, clearJobManualEdit,
  MANUAL_EDIT_LOCK_FIELDS, TRUCK_LOCK_FIELDS,
  resetToSampleData, clearJobs,
  createUser, listUsers, getUserByEmail, getUserById, updateUserRole, deleteUser, countAdmins,
  setUserPassword, setUserOtp, clearUserOtp,
  addAllowedExternalEmail, listAllowedExternalEmails, isEmailAllowedExternally, removeAllowedExternalEmail,
  getGmailAuthStatus, setGmailAuthRefreshed,
  listSmartMovingJobsInRange,
};
for (const name of WRITERS) {
  if (typeof exported[name] !== 'function') throw new Error(`db.js WRITERS lists unknown export ${name}`);
  exported[name] = withVersionBump(exported[name]);
}
module.exports = exported;
