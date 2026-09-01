/**
 * One-time script: applies the truck <-> SmartMoving-calendar-text matching your manager confirmed
 * (2026-08-26 matching PDF, reviewed and handwritten back 2026-08-26/27) to each truck's
 * `smartMovingLabels` field in Firestore, via db.js's real `updateTruck()` — no ad-hoc Firestore
 * calls, so this goes through the exact same validation/allowlist path the Admin > Trucks UI does.
 *
 * Every truck listed below currently has NO labels set (confirmed via debug-truck-label-match.js),
 * so this is a straight SET, not a merge — safe to re-run any number of times (idempotent: it just
 * writes the same confirmed list again).
 *
 * Deliberately NOT touched (per your manager's review):
 *   - IOFFICE- Est. and PTO, !WAREHOUSE LINE, CELITA VAN, PATHWAY TRAILER, HTS NISSAN VAN — no
 *     calendar activity at all in the sync window.
 *   - "RYDER RENTAL26", "ARC - PENSKE RENTAL", "HTS T2 Rental" — confirmed 2026-08-28: these are
 *     rental trucks that get returned, not permanent fleet trucks, so they're deliberately left
 *     unmatched to any Scheduler truck rather than aliased.
 *
 * Usage (same pattern as your other apply/cleanup scripts):
 *   cd server
 *   node apply-truck-smartmoving-labels.js         # dry run — prints what WOULD be set
 *   node apply-truck-smartmoving-labels.js --yes    # actually applies it
 *
 * Point this at the REAL deployed Firestore (the same "atm-scheduler" project the live app uses)
 * with a ONE-OFF environment variable, not by adding anything to server/local.secrets (see that
 * file's own header comment for why):
 *
 *   PowerShell:
 *     $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; node apply-truck-smartmoving-labels.js
 *   then, once the dry-run list looks right:
 *     $env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; node apply-truck-smartmoving-labels.js --yes
 */
require('./load-env');
const db = require('./db');

const DRY_RUN = !process.argv.includes('--yes');

// truckId -> confirmed SmartMoving label alias(es), exactly as SmartMoving sends them (matching is
// exact-after-normalization — see db.js's normalizeSmartMovingLabel — so these need to be the real
// text, not a shortened version).
const CONFIRMED_LABELS = {
  T3: ['ARC 118'],
  T5: ['ARC 130-2'],
  T6: ['ARC 26'],
  T7: ['Celita 160'],
  T11: ['JCM 31'],
  T10: ['JCM 129'],
  T12: ['JCM 32'],
  T13: ['M&C 120'],
  T14: ['M&C 120-2'],
  // Tractor + trailer pairing for one physical unit — manager's matching PDF explicitly noted these
  // two calendar values ("HTS TL1 2024 KY HI-CUBE" / "HTS T1 Volvo") are the same truck.
  T16: ['HTS TL1 2024 KY HI-CUBE', 'HTS T1 Volvo'],
  T17: ['HTS TL2 GO BIG ORANGE'],
  T18: ['X - HTS 20'],
  T19: ['X - HTS 25'],
  T20: ['XX! - HTS MB Sprinter'],
  T9: ['HTS 27'],
  T22: ['ZCMS - 140'],
  T23: ['YCMS -  2019 Penske'],
  T24: ['ZCMS - 377'],
  T25: ['ZCMS - 2001 Isuzu'],
  T26: ['ZCMS - Nestor 26'],
};

async function main() {
  const { trucks } = await db.getState();
  const byId = new Map(trucks.map((t) => [t.id, t]));

  console.log(`${DRY_RUN ? 'DRY RUN — nothing will be written.' : 'LIVE — applying to Firestore.'}\n`);

  let missing = 0;
  for (const [truckId, labels] of Object.entries(CONFIRMED_LABELS)) {
    const truck = byId.get(truckId);
    if (!truck) {
      console.log(`  SKIP ${truckId}: no truck with this id exists — check it hasn't been renumbered.`);
      missing += 1;
      continue;
    }
    const already = truck.smartMovingLabels || [];
    const changed = JSON.stringify(already) !== JSON.stringify(labels);
    console.log(
      `  ${truck.name} (${truckId}): ${JSON.stringify(already)} -> ${JSON.stringify(labels)}` +
      (changed ? '' : '  (already set, no change)')
    );
    if (!DRY_RUN && changed) {
      await db.updateTruck(truckId, { smartMovingLabels: labels });
    }
  }

  if (missing) {
    console.log(`\n${missing} truck id(s) in this script's list weren't found — nothing was written for those.`);
  }
  if (DRY_RUN) {
    console.log('\nDry run only — re-run with --yes to actually apply these labels.');
  } else {
    console.log('\nDone.');
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
