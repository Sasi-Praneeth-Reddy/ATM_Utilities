/**
 * One-off CLI to replace the ENTIRE fleet (every doc in the `trucks` collection) with a fixed
 * list, all sharing one home base. Written for onboarding the real Around Town Movers fleet in
 * place of the sample data's 5 placeholder trucks — see server/db.js's SAMPLE_TRUCKS.
 *
 * What it does, in order:
 *   1. Deletes every existing truck. Any job assigned to one of those trucks becomes unassigned
 *      (db.deleteTruck rewrites `truckIds` on every referencing job — see its doc comment for why
 *      that replaced SQL's ON DELETE CASCADE). Any driver linked to a deleted truck is unlinked,
 *      not deleted.
 *   2. Creates one truck per line below, id assigned sequentially (T1, T2, ...), all with
 *      homeBase set to the constant below, status "available", no driver linked, size/capacity
 *      left blank (fill those in later from the Trucks & Drivers panel if you want them tracked).
 *
 * Run locally (this touches the real Firestore database, not a sandbox):
 *   cd server
 *   node replace-trucks.js
 *
 * Safe to re-run — it always starts from "delete everything currently in `trucks`", so running it
 * twice just recreates the same list with fresh T1..T24 ids.
 */

require('./load-env');
const db = require('./db');

const HOME_BASE = 'Sterling, VA';

const TRUCK_NAMES = [
  '!OPS/OFFICE INFO LINE',
  '!WAREHOUSE LINE',
  'ARC 118',
  'ARC 130',
  'ARC 130-2',
  'ARC 26',
  'CELITA 160',
  'CELITA VAN',
  'HTS 27',
  'JCM 129',
  'JCM 31',
  'JCM 32',
  'M&C 120',
  'M&C 120-2',
  'PATHWAY TRAILER',
  'TT1 VOLVO',
  'TT2',
  'X-HTS 20',
  'X-HTS 25',
  'XX!-HTS MB',
  'XX!-HTS NISSAN VAN',
  'YCMS 140',
  'YCMS 2019 PENSKE',
  'YCMS 377',
  'ZCMS 2001 Isuzu',
  'ZCMS NESTOR 26',
];

async function main() {
  const before = (await db.getState()).trucks;
  console.log(`Deleting ${before.length} existing truck(s): ${before.map(t => t.name).join(', ') || '(none)'}`);
  for (const truck of before) {
    await db.deleteTruck(truck.id);
  }

  console.log(`Creating ${TRUCK_NAMES.length} truck(s), home base "${HOME_BASE}"...`);
  for (let i = 0; i < TRUCK_NAMES.length; i++) {
    const id = `T${i + 1}`;
    await db.createTruck({ id, name: TRUCK_NAMES[i], homeBase: HOME_BASE, status: 'available' });
    console.log(`  ${id}  ${TRUCK_NAMES[i]}`);
  }

  console.log(`Done. Fleet now has ${(await db.getState()).trucks.length} truck(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
