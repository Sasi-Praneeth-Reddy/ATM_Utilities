/**
 * SQLite data layer for the ATM Scheduler — trucks, drivers, jobs, and job/truck assignments.
 * This is now the single source of truth for the scheduler's own state (previously held only in
 * browser localStorage, which meant every device had its own separate copy). The SmartMoving sync
 * job cache also lives here now (`jobs` rows with `source = 'smartmoving'`), replacing the earlier
 * file-backed job store.
 *
 * Uses Node's built-in `node:sqlite` (stable enough for this project's needs, still flagged
 * "experimental" by Node itself as of Node 22) instead of an npm package like `better-sqlite3` —
 * keeps the "zero npm dependencies" approach from the rest of this backend, and avoids native
 * module compilation issues on whatever machine ends up hosting this. Requires Node 22.5+; see
 * the version check in server.js for what happens on older Node.
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
// Overridable because SQLite needs real local-disk file locking — it errors with "disk I/O error"
// on some network drives, FUSE mounts, and certain container volume setups. If that happens on
// wherever this ends up hosted, point SQLITE_PATH at a genuinely local path instead.
const DB_FILE = process.env.SQLITE_PATH || path.join(DATA_DIR, 'atm.db');
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS trucks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size TEXT,
    capacity TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    driverId TEXT,
    homeBase TEXT
  );

  CREATE TABLE IF NOT EXISTS drivers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    cdl TEXT,
    truckId TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    customer TEXT,
    type TEXT NOT NULL DEFAULT 'local',
    date TEXT NOT NULL,
    endDate TEXT NOT NULL,
    startTime TEXT,
    duration REAL,
    origin TEXT,
    destination TEXT,
    crewSize INTEGER,
    trucksNeeded INTEGER NOT NULL DEFAULT 1,
    status TEXT,
    miles REAL,
    transitDays INTEGER,
    stage TEXT,
    source TEXT,
    smartMovingJobId TEXT,
    smartMovingOpportunityId TEXT,
    smartMovingStatus TEXT,
    smartMovingStatusCode INTEGER
  );

  CREATE TABLE IF NOT EXISTS job_trucks (
    jobId TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    truckId TEXT NOT NULL REFERENCES trucks(id) ON DELETE CASCADE,
    PRIMARY KEY (jobId, truckId)
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_smartMovingJobId ON jobs(smartMovingJobId);
`);

/* ---------- Sample data (used to seed an empty database on first run) ---------- */
const SAMPLE_TRUCKS = [
  { id: 'T1', name: 'Truck 1', size: '26ft Box', capacity: '12,000 lbs', status: 'available', driverId: 'D1', homeBase: 'Denver, CO' },
  { id: 'T2', name: 'Truck 2', size: '26ft Box', capacity: '12,000 lbs', status: 'onjob', driverId: 'D2', homeBase: 'Denver, CO' },
  { id: 'T3', name: 'Truck 3', size: '53ft Trailer (LD)', capacity: '26,000 lbs', status: 'available', driverId: 'D3', homeBase: 'Denver, CO' },
  { id: 'T4', name: 'Truck 4', size: '16ft Box', capacity: '6,000 lbs', status: 'maintenance', driverId: 'D4', homeBase: 'Denver, CO' },
  { id: 'T5', name: 'Truck 5', size: '53ft Trailer (LD)', capacity: '26,000 lbs', status: 'available', driverId: 'D5', homeBase: 'Denver, CO' },
];
const SAMPLE_DRIVERS = [
  { id: 'D1', name: 'Mike Reynolds', phone: '(303) 555-0114', cdl: 'Class A', truckId: 'T1' },
  { id: 'D2', name: 'Alex Chen', phone: '(303) 555-0122', cdl: 'Class A', truckId: 'T2' },
  { id: 'D3', name: 'Jordan Blake', phone: '(303) 555-0133', cdl: 'Class A + LD Endorsed', truckId: 'T3' },
  { id: 'D4', name: 'Sam Patel', phone: '(303) 555-0147', cdl: 'Class B', truckId: 'T4' },
  { id: 'D5', name: 'Casey Nunez', phone: '(303) 555-0158', cdl: 'Class A + LD Endorsed', truckId: 'T5' },
];
const SAMPLE_JOBS = [
  { id: 'J-10231', customer: 'Sarah Thompson', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '08:00', duration: 3, origin: '1420 Larimer St, Denver, CO', destination: '880 Pearl St, Boulder, CO', crewSize: 3, truckIds: ['T1'], trucksNeeded: 1, status: 'scheduled', miles: 32 },
  { id: 'J-10232', customer: 'The Whitfield Family', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '09:30', duration: 2.5, origin: '2200 Colfax Ave, Denver, CO', destination: '50 S Steele St, Denver, CO', crewSize: 2, truckIds: ['T2'], trucksNeeded: 1, status: 'in_progress', miles: 8 },
  { id: 'J-10233', customer: 'Devon Marsh', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '13:00', duration: 2, origin: '900 Auraria Pkwy, Denver, CO', destination: '12 Golden Gate Cyn, Golden, CO', crewSize: 2, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 19 },
  { id: 'J-10235', customer: 'Grace Lin', type: 'local', date: '2026-08-05', endDate: '2026-08-05', startTime: '15:30', duration: 2, origin: '3300 E Colfax Ave, Denver, CO', destination: '700 Kalamath St, Denver, CO', crewSize: 2, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 6 },
  { id: 'J-10234', customer: 'Priya Nair', type: 'local', date: '2026-08-06', endDate: '2026-08-06', startTime: '09:00', duration: 3, origin: '400 W 48th Ave, Denver, CO', destination: '77 S Union Blvd, Lakewood, CO', crewSize: 3, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 14 },
  { id: 'J-10236', customer: 'Tom Alvarez', type: 'local', date: '2026-08-11', endDate: '2026-08-11', startTime: '08:30', duration: 3, origin: '1660 Wynkoop St, Denver, CO', destination: '6900 Layton Ave, Denver, CO', crewSize: 2, truckIds: ['T1'], trucksNeeded: 1, status: 'scheduled', miles: 11 },
  { id: 'J-10237', customer: 'Nia Coleman', type: 'local', date: '2026-08-14', endDate: '2026-08-14', startTime: '10:00', duration: 2.5, origin: '2001 York St, Denver, CO', destination: '1000 Chapman Dr, Louisville, CO', crewSize: 3, truckIds: ['T2'], trucksNeeded: 1, status: 'scheduled', miles: 23 },
  { id: 'J-10238', customer: 'Ortiz Household', type: 'local', date: '2026-08-20', endDate: '2026-08-20', startTime: '09:00', duration: 3, origin: '4650 Leetsdale Dr, Denver, CO', destination: '150 W Prospect Rd, Fort Collins, CO', crewSize: 3, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 66 },
  { id: 'J-10244', customer: 'Nguyen Family', type: 'local', date: '2026-08-06', endDate: '2026-08-06', startTime: '10:00', duration: 2, origin: '1900 Grant St, Denver, CO', destination: '8000 E Girard Ave, Denver, CO', crewSize: 2, truckIds: ['T3'], trucksNeeded: 1, status: 'scheduled', miles: 10 },
  { id: 'J-10240', customer: 'Harold & Anne Kessler', type: 'long_distance', date: '2026-08-05', endDate: '2026-08-08', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Phoenix, AZ', crewSize: 4, truckIds: ['T3'], trucksNeeded: 2, status: 'loading', miles: 862, transitDays: 2, stage: 'loading' },
  { id: 'J-10241', customer: 'Reyes Household', type: 'long_distance', date: '2026-08-06', endDate: '2026-08-09', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Austin, TX', crewSize: 3, truckIds: ['T5'], trucksNeeded: 1, status: 'scheduled', miles: 925, transitDays: 2, stage: 'scheduled' },
  { id: 'J-10242', customer: 'Ben Okafor', type: 'long_distance', date: '2026-08-04', endDate: '2026-08-07', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Portland, OR', crewSize: 3, truckIds: [], trucksNeeded: 2, status: 'in_transit', miles: 1245, transitDays: 3, stage: 'in_transit' },
  { id: 'J-10243', customer: 'Marcus Webb', type: 'long_distance', date: '2026-08-18', endDate: '2026-08-21', startTime: null, duration: null, origin: 'Denver, CO', destination: 'Chicago, IL', crewSize: 3, truckIds: [], trucksNeeded: 1, status: 'scheduled', miles: 996, transitDays: 2, stage: 'scheduled' },
];

/* ---------- Row <-> app-shape helpers ---------- */
const getTruckIdsForJobStmt = db.prepare('SELECT truckId FROM job_trucks WHERE jobId = ?');
function attachTruckIds(job) {
  const rows = getTruckIdsForJobStmt.all(job.id);
  return { ...job, truckIds: rows.map(r => r.truckId) };
}

function rowToJob(row) {
  if (!row) return null;
  return attachTruckIds(row);
}

/* ---------- Reads ---------- */
function getState() {
  const trucks = db.prepare('SELECT * FROM trucks ORDER BY id').all();
  const drivers = db.prepare('SELECT * FROM drivers ORDER BY id').all();
  const jobRows = db.prepare('SELECT * FROM jobs ORDER BY id').all();
  const jobs = jobRows.map(attachTruckIds);
  return { trucks, drivers, jobs };
}

function getJob(id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return rowToJob(row);
}

/* ---------- Writes: trucks ---------- */
const insertTruckStmt = db.prepare(`
  INSERT INTO trucks (id, name, size, capacity, status, driverId, homeBase)
  VALUES (@id, @name, @size, @capacity, @status, @driverId, @homeBase)
`);
function createTruck(truck) {
  insertTruckStmt.run({
    id: truck.id, name: truck.name, size: truck.size || null, capacity: truck.capacity || null,
    status: truck.status || 'available', driverId: truck.driverId || null, homeBase: truck.homeBase || null,
  });
  return db.prepare('SELECT * FROM trucks WHERE id = ?').get(truck.id);
}

function updateTruck(id, fields) {
  const allowed = ['name', 'size', 'capacity', 'status', 'driverId', 'homeBase'];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE trucks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  return db.prepare('SELECT * FROM trucks WHERE id = ?').get(id);
}

/** Links a driver to a truck, unlinking both sides' previous pairing (mirrors the old frontend logic). */
function linkTruckDriver(truckId, driverId) {
  db.prepare('UPDATE drivers SET truckId = NULL WHERE truckId = ?').run(truckId);
  if (driverId) db.prepare('UPDATE trucks SET driverId = NULL WHERE driverId = ?').run(driverId);
  db.prepare('UPDATE trucks SET driverId = ? WHERE id = ?').run(driverId || null, truckId);
  if (driverId) db.prepare('UPDATE drivers SET truckId = ? WHERE id = ?').run(truckId, driverId);
}

function unassignDriverTruck(driverId) {
  const truck = db.prepare('SELECT * FROM trucks WHERE driverId = ?').get(driverId);
  if (truck) db.prepare('UPDATE trucks SET driverId = NULL WHERE id = ?').run(truck.id);
}

/* ---------- Writes: drivers ---------- */
const insertDriverStmt = db.prepare(`
  INSERT INTO drivers (id, name, phone, cdl, truckId) VALUES (@id, @name, @phone, @cdl, @truckId)
`);
function createDriver(driver) {
  insertDriverStmt.run({
    id: driver.id, name: driver.name, phone: driver.phone || null, cdl: driver.cdl || null,
    truckId: driver.truckId || null,
  });
  return db.prepare('SELECT * FROM drivers WHERE id = ?').get(driver.id);
}

function updateDriver(id, fields) {
  const allowed = ['name', 'phone', 'cdl', 'truckId'];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE drivers SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  return db.prepare('SELECT * FROM drivers WHERE id = ?').get(id);
}

/* ---------- Writes: jobs ---------- */
const insertJobStmt = db.prepare(`
  INSERT INTO jobs (id, customer, type, date, endDate, startTime, duration, origin, destination,
                     crewSize, trucksNeeded, status, miles, transitDays, stage, source,
                     smartMovingJobId, smartMovingOpportunityId, smartMovingStatus, smartMovingStatusCode)
  VALUES (@id, @customer, @type, @date, @endDate, @startTime, @duration, @origin, @destination,
          @crewSize, @trucksNeeded, @status, @miles, @transitDays, @stage, @source,
          @smartMovingJobId, @smartMovingOpportunityId, @smartMovingStatus, @smartMovingStatusCode)
`);
const setJobTruckStmt = db.prepare('INSERT OR IGNORE INTO job_trucks (jobId, truckId) VALUES (?, ?)');
const clearJobTrucksStmt = db.prepare('DELETE FROM job_trucks WHERE jobId = ?');

function jobParams(job) {
  return {
    id: job.id, customer: job.customer || null, type: job.type || 'local',
    date: job.date, endDate: job.endDate || job.date,
    startTime: job.startTime || null, duration: job.duration ?? null,
    origin: job.origin || null, destination: job.destination || null,
    crewSize: job.crewSize ?? null, trucksNeeded: job.trucksNeeded || 1,
    status: job.status || null, miles: job.miles ?? null, transitDays: job.transitDays ?? null,
    stage: job.stage || null, source: job.source || null,
    smartMovingJobId: job.smartMovingJobId || null,
    smartMovingOpportunityId: job.smartMovingOpportunityId || null,
    smartMovingStatus: job.smartMovingStatus || null,
    smartMovingStatusCode: job.smartMovingStatusCode ?? null,
  };
}

function createJob(job) {
  insertJobStmt.run(jobParams(job));
  setJobTrucks(job.id, job.truckIds || []);
  return getJob(job.id);
}

function updateJob(id, fields) {
  const allowed = [
    'customer', 'type', 'date', 'endDate', 'startTime', 'duration', 'origin', 'destination',
    'crewSize', 'trucksNeeded', 'status', 'miles', 'transitDays', 'stage', 'source',
    'smartMovingJobId', 'smartMovingOpportunityId', 'smartMovingStatus', 'smartMovingStatusCode',
  ];
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }
  if (Object.prototype.hasOwnProperty.call(fields, 'truckIds')) {
    setJobTrucks(id, fields.truckIds || []);
  }
  return getJob(id);
}

/** Replaces the full set of trucks assigned to a job. */
function setJobTrucks(jobId, truckIds) {
  clearJobTrucksStmt.run(jobId);
  (truckIds || []).forEach(truckId => setJobTruckStmt.run(jobId, truckId));
}

/**
 * Upserts a job pulled from SmartMoving. Mirrors the merge logic that used to live in the
 * frontend's importFromSmartMoving(): SmartMoving-owned fields (customer/date/time/addresses/crew
 * size/status) are always refreshed, but truckIds/trucksNeeded/status are left alone once a
 * dispatcher has touched them locally — re-syncing should never undo dispatch work.
 * Matches by smartMovingJobId, same as before.
 */
const findBySmStmt = db.prepare('SELECT * FROM jobs WHERE smartMovingJobId = ?');
function upsertSmartMovingJob(job) {
  const existing = job.smartMovingJobId ? findBySmStmt.get(job.smartMovingJobId) : null;
  if (existing) {
    updateJob(existing.id, {
      customer: job.customer, type: job.type, date: job.date, endDate: job.endDate,
      startTime: job.startTime, duration: job.duration, origin: job.origin, destination: job.destination,
      crewSize: job.crewSize, source: 'smartmoving',
      smartMovingOpportunityId: job.smartMovingOpportunityId,
      smartMovingStatus: job.smartMovingStatus, smartMovingStatusCode: job.smartMovingStatusCode,
    });
    return { job: getJob(existing.id), created: false };
  }
  createJob(job);
  return { job: getJob(job.id), created: true };
}

/* ---------- Reset ---------- */
function clearAll() {
  db.exec('DELETE FROM job_trucks; DELETE FROM jobs; DELETE FROM drivers; DELETE FROM trucks;');
}

function seed(trucks, drivers, jobs) {
  trucks.forEach(createTruck);
  drivers.forEach(createDriver);
  jobs.forEach(createJob);
}

function resetToSampleData() {
  clearAll();
  seed(SAMPLE_TRUCKS, SAMPLE_DRIVERS, SAMPLE_JOBS);
  return getState();
}

// Seed on first run only — an existing database (with real dispatcher work in it) is never
// silently overwritten.
const truckCount = db.prepare('SELECT COUNT(*) AS n FROM trucks').get().n;
if (truckCount === 0) {
  seed(SAMPLE_TRUCKS, SAMPLE_DRIVERS, SAMPLE_JOBS);
}

module.exports = {
  DB_FILE,
  getState, getJob,
  createTruck, updateTruck, linkTruckDriver, unassignDriverTruck,
  createDriver, updateDriver,
  createJob, updateJob, setJobTrucks, upsertSmartMovingJob,
  resetToSampleData,
};
