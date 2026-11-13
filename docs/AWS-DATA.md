# AWS data layer (DynamoDB)

Leads and storage-price data moved from Cloud SQL (Firebase Data Connect) to **AWS DynamoDB**.
Firebase Hosting, Firestore, Cloud Functions and Cloud Scheduler stay on Firebase; the `api`
function simply calls DynamoDB. Reason: Cloud SQL was ~73% of the Google bill (~$9.50/month) and the
app only ever loads whole tables into memory, so DynamoDB on-demand costs about $0-1/month.

## Code map
| File | Role |
|---|---|
| `server/awsStore.js` | All DynamoDB access (scan, batch get/write, merge-upsert, state, indexes). |
| `server/leads/leadsDb.js` | Leads, matched leads, legacy customers, analytics cache (uses `awsStore`). |
| `server/storage/storageDb.js` | Facilities, pricing, MLS benchmarks, dashboards (uses `awsStore`). |
| `server/scripts/make-aws-template.js` | Generates `aws/atm-data.template.json` from `TABLE_DEFS`. |
| `server/scripts/migrate-sql-to-dynamodb.js` | One-off copy Cloud SQL -> DynamoDB (`--dry-run`, `--verify`, `--only`). |
| `server/test-aws-store.js` | Tests against the in-process `dynalite` emulator (`npm run test-aws-store`). |
| `server/sqlconnect.js`, `dataconnect/` | Legacy; only needed by the migration script. Delete after the soak period. |

## Tables (prefix `atm-`)
leads, matched-leads, legacy-customers, storage-facilities, storage-pricing, mls-benchmarks,
scrape-runs, email-notices, app-state. On-demand billing, point-in-time recovery, deletion
protection, `Retain` on stack delete. StoragePricing has GSIs `byDay` and `byFacilityUnit` so the
growing price history is never fully scanned.

## Behaviours to know
- `upsertMany` **merges** into the existing item (absent columns kept, explicit `null` overwrites),
  matching the old SQL upsert, so re-ingesting a lead does not wipe owner/contact/status fields.
- Rows are null-filled to the declared fields; dates are `YYYY-MM-DD`, timestamps ISO-8601 UTC.
- App state values are gzip'd into attribute `z` (DynamoDB items max 400 KB).
- `leadsMeta.newestUpdatedAt` replaces a table-wide "newest updatedAt" scan.
- MatchedLead stores `leadId`, StoragePricing stores `facilityId` (old SQL names `leadLeadId` / `facilityFacilityId` are gone).

## Configuration
| Name | Purpose |
|---|---|
| `ATM_AWS_ACCESS_KEY_ID`, `ATM_AWS_SECRET_ACCESS_KEY` | Firebase secrets; keys of IAM user `atm-data-writer` (limited to these tables). |
| `ATM_AWS_REGION` | default `us-east-1` |
| `ATM_DDB_PREFIX` | default `atm-` |
| `ATM_DYNAMODB_ENDPOINT` | tests only |

Static keys are an interim choice because the code runs on Firebase; rotate them periodically
(`aws iam create-access-key` / `delete-access-key`).

## Runbook
1. Create the stack:
   `aws cloudformation deploy --template-file aws/atm-data.template.json --stack-name atm-data --capabilities CAPABILITY_NAMED_IAM --region us-east-1 --parameter-overrides AlertEmail=you@example.com MonthlyBudgetUsd=5`
2. `aws iam create-access-key --user-name atm-data-writer`, then
   `firebase functions:secrets:set ATM_AWS_ACCESS_KEY_ID` and `ATM_AWS_SECRET_ACCESS_KEY`.
3. `cd server && npm install && npm run test-aws-store`
4. `gcloud auth application-default login`, then
   `node scripts/migrate-sql-to-dynamodb.js --dry-run`, then without flags, then `--verify`.
5. `firebase deploy --only functions`, re-run the scraper, check the Leads and Storage tabs.
6. Repeat step 4 (copy + verify) right before switching: rows written to Cloud SQL after the copy are not carried over.
7. After a soak period (about a week): delete the Cloud SQL instance, `dataconnect/`, and the `dataconnect` entry in `firebase.json`.

## Rollback
Before step 7, redeploy the previous functions build; Cloud SQL still holds the old data (anything
written to DynamoDB since then would need copying back).

## Not verified from the sandbox
Tests run against dynalite and the template passes cfn-lint, but the real AWS account, the real
Cloud SQL copy and the Firebase deploy could not be exercised from here.
