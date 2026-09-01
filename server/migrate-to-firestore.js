/**
 * One-time migration: copies every truck, driver, job, and user account out of the old local
 * SQLite database and into Firestore, in the exact document shape server/db.js expects (see its
 * docToTruck/docToDriver/docToJob/docToUser helpers). Run this once, from the machine that still
 * has the real SQLite file (server/data/atm.db) on it, pointed at whichever Firestore project you
 * want the data to land in.
 *
 * Preserves real password hashes as-is (never re-hashes or clears them) so nobody has to reset
 * their password after the move, and preserves each job's `truckIds` by reading the old
 * `job_trucks` join table and collapsing it into the array field the new schema uses (see db.js's
 * file header for why that collapse happened). Deliberately does NOT carry over `otpHash`/
 * `otpExpiresAt` — any in-flight "forgot password" code is short-lived and not worth preserving
 * across a migration; anyone mid-reset just requests a new code afterward.
 *
 * Usage:
 *   cd server
 *   node migrate-to-firestore.js                 # dry run — prints what WOULD be copied, writes nothing
 *   node migrate-to-firestore.js --yes            # actually performs the migration
 *
 * Point this at the right Firestore before running with --yes:
 *   - Emulator:      FIRESTORE_EMULATOR_HOST=localhost:8080 node migrate-to-firestore.js --yes
 *   - Real project:  set FIREBASE_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS in server/.env first
 *     (see server/firestore.js's header comment), then: node migrate-to-firestore.js --yes
 *
 * Safe to re-run in dry-run mode as many times as you like. Re-running with --yes is NOT
 * idempotent in the way db.js's initDb() is — it always overwrites (doc.set(), not merge) whatever
 * is already at each id in Firestore, so running it twice against the same Firestore project just
 * re-copies the same SQLite snapshot on top of itself. If dispatchers have already started making
 * live changes in Firestore, running this again would clobber that work — the --yes run prints a
 * loud warning and asks for one more confirmation if it detects the target Firestore already has
 * data in it, for exactly that reason.
 */

require('./load-env');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

const DRY_RUN = !process.argv.includes('--yes');

const DATA_DIR = path.join(__dirname, 'data');
const SQLITE_FILE = process.env.SQLITE_PATH || path.join(DATA_DIR, 'atm.db');

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer.trim().toLowerCase()); });
  });
}

async function main() {
  if (!fs.existsSync(SQLITE_FILE)) {
    console.error(`No SQLite database found at ${SQLITE_FILE}. Run this from the machine that has ` +
      `the real database file (or set SQLITE_PATH to point at it).`);
    process.exit(1);
  }

  const { DatabaseSync } = require('node:sqlite');
  const sqlite = new DatabaseSync(SQLITE_FILE, { readOnly: true });

  const trucks = sqlite.prepare('SELECT * FROM trucks ORDER BY id').all();
  const drivers = sqlite.prepare('SELECT * FROM drivers ORDER BY id').all();
  const jobRows = sqlite.prepare('SELECT * FROM jobs ORDER BY id').all();
  const jobTruckRows = sqlite.prepare('SELECT * FROM job_trucks').all();
  const users = sqlite.prepare('SELECT * FROM users ORDER BY createdAt').all();
  sqlite.close();

  const truckIdsByJob = new Map();
  for (const row of jobTruckRows) {
    if (!truckIdsByJob.has(row.jobId)) truckIdsByJob.set(row.jobId, []);
    truckIdsByJob.get(row.jobId).push(row.truckId);
  }
  const jobs = jobRows.map((row) => ({ ...row, truckIds: truckIdsByJob.get(row.id) || [] }));

  console.log(`Read from SQLite (${SQLITE_FILE}):`);
  console.log(`  ${trucks.length} truck(s)`);
  console.log(`  ${drivers.length} driver(s)`);
  console.log(`  ${jobs.length} job(s)`);
  console.log(`  ${users.length} user account(s)`);

  if (DRY_RUN) {
    console.log('\nDry run only — nothing was written. Re-run with --yes to actually migrate to Firestore.');
    return;
  }

  const { db: firestore } = require('./firestore');
  const trucksCol = firestore.collection('trucks');
  const driversCol = firestore.collection('drivers');
  const jobsCol = firestore.collection('jobs');
  const usersCol = firestore.collection('users');

  const [existingTrucks, existingUsers] = await Promise.all([trucksCol.limit(1).get(), usersCol.limit(1).get()]);
  if (!existingTrucks.empty || !existingUsers.empty) {
    console.warn('\n⚠️  The target Firestore already has data in it (trucks and/or users collection is ' +
      'non-empty). Running this migration will OVERWRITE any doc whose id matches one from SQLite — ' +
      'including any changes a dispatcher has already made directly in Firestore.');
    const answer = await confirm('Type "overwrite" to proceed anyway, anything else to cancel: ');
    if (answer !== 'overwrite') {
      console.log('Cancelled — nothing was written.');
      return;
    }
  }

  function truckData(t) {
    return { name: t.name, size: t.size ?? null, capacity: t.capacity ?? null, status: t.status ?? 'available', driverId: t.driverId ?? null, homeBase: t.homeBase ?? null };
  }
  function driverData(d) {
    return { name: d.name, phone: d.phone ?? null, cdl: d.cdl ?? null, truckId: d.truckId ?? null };
  }
  function jobData(j) {
    return {
      customer: j.customer ?? null, type: j.type ?? 'local', date: j.date, endDate: j.endDate,
      startTime: j.startTime ?? null, duration: j.duration ?? null, origin: j.origin ?? null, destination: j.destination ?? null,
      crewSize: j.crewSize ?? null, trucksNeeded: j.trucksNeeded ?? 1, status: j.status ?? null,
      miles: j.miles ?? null, transitDays: j.transitDays ?? null, stage: j.stage ?? null, source: j.source ?? null,
      smartMovingJobId: j.smartMovingJobId ?? null, smartMovingOpportunityId: j.smartMovingOpportunityId ?? null,
      smartMovingStatus: j.smartMovingStatus ?? null, smartMovingStatusCode: j.smartMovingStatusCode ?? null,
      truckIds: j.truckIds || [],
    };
  }
  function userData(u) {
    return { email: u.email, role: u.role, createdAt: u.createdAt, passwordHash: u.passwordHash ?? null, otpHash: null, otpExpiresAt: null };
  }

  // Firestore batches cap at 500 writes — chunk defensively (mirrors db.js's deleteAllInCollection).
  async function writeAll(col, rows, toData, label) {
    for (let i = 0; i < rows.length; i += 450) {
      const batch = firestore.batch();
      rows.slice(i, i + 450).forEach((row) => batch.set(col.doc(row.id), toData(row)));
      await batch.commit();
      console.log(`  wrote ${Math.min(i + 450, rows.length)}/${rows.length} ${label}`);
    }
  }

  console.log('\nWriting to Firestore...');
  await writeAll(trucksCol, trucks, truckData, 'truck(s)');
  await writeAll(driversCol, drivers, driverData, 'driver(s)');
  await writeAll(jobsCol, jobs, jobData, 'job(s)');
  await writeAll(usersCol, users, userData, 'user account(s)');

  console.log('\nDone. Verify with: node -e "require(\'./db\').getState().then(s => console.log(s.trucks.length, s.drivers.length, s.jobs.length))"');
  console.log('Password hashes were carried over as-is — everyone signs in with their existing password, no reset needed.');
  console.log('Any in-flight "forgot password" codes were NOT carried over — anyone mid-reset just requests a new code.');
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
