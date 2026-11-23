# Backend on AWS Lambda

The API and the scheduled sync jobs run on **AWS Lambda** instead of Google Cloud Functions. Firebase Hosting
(the website) and Firestore (jobs, users, trucks) stay on Google; leads/storage data is in DynamoDB
(see `docs/AWS-DATA.md`).

## How it fits together
- **One Lambda, `atm-api`** (`server/lambda.js`, Node 22, 2 GB, 10 min timeout).
  - **HTTP:** a Lambda **Function URL** forwards every request to `handleRequest()` in `server/server.js`, the same
    handler Cloud Functions used. (A Function URL, not API Gateway, because API Gateway cuts requests off at 30 s.)
  - **Scheduled jobs:** EventBridge Scheduler (Eastern time, handles DST) invokes the same function with
    `{"job": "pollSweep" | "materials" | "smartInsights" | "calendar"}`. Same six schedules as before:
    6:00 poll sweep + Tasking refresh, 6:30 and 17:00 materials, 12:00 and 16:00 Smart Insights,
    8:00/12:00/13:00 and 16:03 calendar sweep. Failed deliveries land in an SQS dead-letter queue.
- **Configuration:** one SSM Parameter Store entry per setting under `/atm/prod/` (secrets are SecureString).
  Loaded at cold start into `process.env` before `server.js` is required. Copy them from Firebase with
  `server/scripts/copy-config-to-ssm.js`.
- **Firestore from AWS:** `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` (a Firebase service-account key)
  are in SSM; `server/firestore.js` already supports this. Keep that key secret and rotate it now and then.
- **DynamoDB from AWS:** the Lambda's IAM role is used. No access keys.
- **Login without cookies:** the website (Firebase) and the API (AWS) are different sites, so browsers may block the
  login cookie. When the site calls a different origin, the login response also carries the signed session token
  (`x-session-mode: bearer`), the page keeps it in `localStorage` and sends `Authorization: Bearer ...`
  (`frontend/src/api.js`, `getCurrentUser()` in `server/server.js`). Same-origin hosting still uses the httpOnly cookie.
- **Limits to know:** requests and responses are capped at 6 MB. Big text responses (the leads CSV) are gzipped
  automatically; keep scraper upload batches under about 5 MB.

## Files
| File | Purpose |
|---|---|
| `server/lambda.js` | Lambda entry: SSM config, HTTP adapter, scheduled jobs, gzip. |
| `server/test-lambda.js` | Tests for the entry point (`npm run test-lambda`). |
| `server/scripts/build-lambda.js` | Stages `build/lambda` (source + Linux production dependencies, checks the 250 MB limit). |
| `server/scripts/copy-config-to-ssm.js` | Copies Firebase secrets + `.env.atm-scheduler` + service-account key into SSM. |
| `aws/atm-compute.template.yaml` | Lambda, Function URL, schedules, IAM roles, alarms. |
| `server/functions-index.js` | The old Google wrappers. Left in place until the Google functions are deleted. |

## Deploy (nothing here affects production until the cutover section)
All commands are PowerShell, from the repo root unless noted. Region `us-east-1`.

1. Build and test
   ```powershell
   cd server
   npm install
   npm run test-lambda
   npm run build-lambda
   cd ..
   ```
2. Artifact bucket (once): `aws s3 mb s3://atm-deploy-<your-account-id> --region us-east-1`
3. Configuration into SSM (check with `--dry-run` first; needs `firebase login` and `aws configure`)
   ```powershell
   cd server
   node scripts/copy-config-to-ssm.js --service-account ..\atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json --dry-run
   node scripts/copy-config-to-ssm.js --service-account ..\atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json
   cd ..
   ```
4. Package and deploy (schedules start DISABLED)
   ```powershell
   aws cloudformation package --template-file aws/atm-compute.template.yaml --s3-bucket atm-deploy-<your-account-id> --output-template-file build/atm-compute.packaged.yaml --region us-east-1
   aws cloudformation deploy --template-file build/atm-compute.packaged.yaml --stack-name atm-compute --capabilities CAPABILITY_IAM --region us-east-1 --parameter-overrides AlertEmail=you@example.com
   aws cloudformation describe-stacks --stack-name atm-compute --region us-east-1 --query "Stacks[0].Outputs"
   ```
   `FunctionUrl` is the API address (it ends with `/`).
5. Smoke test: `Invoke-RestMethod "<FunctionUrl>api/auth/status"` should return JSON.
6. Beta test: open the beta site with `?api=<FunctionUrl without the trailing />`, sign in, and check the Board,
   Leads, Storage, Tasking and Map. Both backends use the same Firestore and DynamoDB, so this is safe.
   Logs: `aws logs tail /aws/lambda/atm-api --follow --region us-east-1`

## Cutover (a quiet evening)
1. Point the website at AWS: create `frontend/.env.production` containing `VITE_API_URL=<FunctionUrl without the trailing />`,
   then `cd frontend; npm run build; cd ..; firebase deploy --only hosting`.
2. SmartMoving webhook: change its URL to `<FunctionUrl>webhooks/smartmoving` (keep the same secret as before).
3. Scraper repos: set their backend URL secret to the FunctionUrl (no trailing slash).
4. Stop Google's schedules and start AWS's, in this order:
   ```powershell
   gcloud scheduler jobs list --location us-central1 --project atm-scheduler
   gcloud scheduler jobs pause <each firebase-schedule-... job> --location us-central1 --project atm-scheduler
   aws cloudformation deploy --template-file build/atm-compute.packaged.yaml --stack-name atm-compute --capabilities CAPABILITY_IAM --region us-east-1 --parameter-overrides SchedulesState=ENABLED AlertEmail=you@example.com
   ```
5. Next morning check: the 6:00 sweep ran (logs), the scraper ingest succeeded, no alarm emails.

## Rollback
Rebuild the frontend without `VITE_API_URL` and deploy Hosting; resume the paused Cloud Scheduler jobs
(`gcloud scheduler jobs resume ...`); point the webhook and scrapers back at the old URL; redeploy the stack with
`SchedulesState=DISABLED`. The Google functions stay deployed until you delete them.

## After a week of clean running
Delete the Google functions (`firebase functions:delete api pollSweepScheduled smartInsightsSyncScheduled materialsSyncScheduled materialsSyncScheduled5pm calendarSweepScheduled calendarSweepScheduled403pm`),
remove the `rewrites` for `/api/**` and `/webhooks/**` from `firebase.json`, and optionally delete the Firebase secrets.
Hosting and Firestore remain.
