# ATM Scheduler — backend

This backend has three jobs:

1. **Serves the scheduler's data** — trucks, drivers, and jobs live in Firestore and are exposed
   over a small REST API (`GET /api/state`, plus create/update endpoints).
   The `frontend/` app is a thin client: it has no local storage of its own, so this backend has to
   be running for the scheduler to work at all, and every device that opens it talks to the same
   shared database.
2. **Pulls jobs that need dispatching out of SmartMoving CRM** and writes them into that same
   database, so dispatchers don't have to re-enter them by hand.
3. **Handles login** — email + password sign-in, restricted to `@aroundtownmovers.com` accounts,
   with role-based access (admin / dispatcher / crew) on top and an emailed one-time-code flow for
   setting/resetting a password. See "Login & accounts" below.

**This is one-way (pull only).** SmartMoving's public API has no endpoint that can write a job's
date, time, or truck assignment — every write endpoint (create job, update job notes, update job
stops, update opportunity, confirm job) was checked and none of them touch `jobDate` /
`startTimeUtc` / `endTimeUtc`. So: schedule changes made in the scheduler stay local. Dispatchers
still need to mirror any date/time changes into SmartMoving by hand until SmartMoving exposes a
write endpoint (worth asking their support team directly — this isn't something we can build
around on our end).

## Webhooks vs. polling — why both, booked jobs only, and how polling alone finds them

**The board only ever shows booked jobs**, not quotes/leads/opportunities still in the
pre-booking pipeline. `mapJobs.js`'s `BOOKED_STATUSES` (`4` Booked, `10` Completed, `11` Closed) is
the single source of truth for this filter, applied in `hydrateOpportunity()` (`server.js`) before
any opportunity is written to Firestore — so it's enforced no matter which discovery path found the
opportunity (webhook, poll sweep, or a manual `POST /api/sync-now`). A pre-filter also runs earlier
in the poll sweep (see step 2 below) purely to save API calls, but `hydrateOpportunity`'s check is
the one that's actually authoritative.

This whole design went through three iterations, in order:

1. **Leads + webhooks (original).** Polled `GET /api/leads` only. **Confirmed live in the dev
   portal on 2026-08-10** (the "Get leads" operation's own description): "By default, only New and
   In Progress leads are returned, but Lost and Bad Leads can be included through query
   parameters." There is no parameter of any kind to widen this to Booked/Completed/Closed —
   `IncludeBad`/`IncludeLost` are the only two flags this endpoint has. So `/api/leads` **cannot
   ever** return an already-booked job, full stop — a hard ceiling on what that one source can see,
   not a bug. Two more sources (crew-assigned jobs, customer records — see step 3) were added to
   close that gap without dropping leads yet.
2. **iCal feed (brief, 2026-08-18).** The REST API's 20,000-calls/month Basic-tier quota got
   exhausted in about two days running the 3-source sweep every 15 minutes during a live team test.
   SmartMoving's free, unmetered iCal feed (`server/icalClient.js`) briefly became the primary sync
   path instead. **Set aside again the same day** once step 3 below made REST polling cheap enough
   to trust as primary — the iCal code is kept, not deleted (`pollIcalFeed` in `server.js`,
   reachable via `icalSweepScheduled` in `functions-index.js`, currently commented out of that
   file's `exports`), in case a faster/free path is needed again later. Its known gap if ever
   reactivated: the feed's event shape carries no opportunity status, so it can't apply the
   booked-only filter itself — every event on the feed gets imported regardless of stage.
3. **Booked-only status filter + leads dropped (current, 2026-08-18).** `GET /api/leads` was
   removed entirely — see step 1, it structurally can never contribute a booked job, so under a
   booked-only design it was pure wasted calls. What's left:
   - **Webhooks (primary, real-time)** — `Job Created` and `Opportunity Created`/
     `Opportunity Status Changed`/`Opportunity Changed` fire off the job/opportunity object itself,
     regardless of pipeline stage. Confirmed directly in the webhook docs: `Opportunity Created` is
     described as firing "whether submitted via web form, entered manually, or created through an
     integration or API." Payloads are thin — `opportunity-*` events give `{event-type,
opportunity-id, opportunity-status}` (confirmed via the dev portal's webhook document), so
     receiving one tells the backend which opportunity to re-fetch via
     `GET /api/opportunities/{id}` — `hydrateOpportunity` then applies the booked-only filter on
     the fresh `status`. **`job-created` only ever gives `{event-type, job-id}` — no
     opportunity-id** — and there's no endpoint that resolves a bare job-id to anything, so that
     event alone can't be hydrated; `handleWebhook` deliberately no-ops on it and lets the poll
     sweep pick it up on its next pass instead of guessing.
   - **Poll sweep** (`server.js`'s `pollSweep`, primary sync path again, on an interval —
     `POLL_INTERVAL_MINUTES`, default 120) merges **two** discovery sources before hydrating:
     - `GET /api/crew-members/{id}/jobs` — **confirmed live in the dev portal 2026-08-10**: lists
       real jobs directly by service date, for one crew member at a time. Doesn't go through
       `/api/leads` at all, so it finds already-booked, already-staffed work. There's no "list all
       jobs" endpoint on this API, so the sweep enumerates **every** crew member
       (`GET /api/crew-members`, deliberately no `Status` filter — see below) and asks each one for
       their jobs in the poll window. Can't find a job with nobody staffed on it yet — nothing to
       enumerate it from. This source's own job shape carries no status field, so its
       opportunities go straight to `hydrateOpportunity`'s check rather than being pre-filtered.
     - `GET /api/customers` — **confirmed live in the dev portal 2026-08-10**, added after a real
       user reported jobs missing even with no crew assigned. Each customer comes back with
       `opportunities[]` across the **full** `OpportunityStatus` range and each opportunity's
       `status` field directly embedded — so `pollSweep` pre-filters against `BOOKED_STATUSES`
       _here_, before it's even added to the discovery list, which is the main lever that keeps
       poll-sweep call volume down (this source alone previously found ~977
       opportunities-with-jobs in one real test, most not booked). Fails open on a missing/unusual
       `status` value rather than silently dropping a real job over an unexpected shape.

     Every opportunity id found by either source is hydrated exactly once — deduped in a `Map`
     before the hydration loop, so one found via both sources still only costs one hydration call.

**Don't filter crew members by `Status=Active`.** Found 2026-08-10 against a real account: a real,
booked, staffed job was missing from the board because it was assigned to a crew member whose
status wasn't exactly `"Active"` (SmartMoving's docs only name two values, `Active`/`Inactive`, but
that's no guarantee every real account's data matches cleanly). Filtering crew enumeration to
Active-only silently drops every job assigned to anyone who doesn't match — for a scheduler, a
false negative (a real job never appearing) is worse than the extra API calls from checking
everyone. `getAllCrewMembers()` now fetches all crew members regardless of status.

Verified the discovery gaps actually close, in one bash-call test run each:
`server/mock-smartmoving-server.js` has three sample bookings, each deliberately unreachable by a
different subset of sources — one absent from `LEADS` (a direct booking), one assigned only to an
`Inactive`-status crew member, and one Booked with a job created but `crewMembers: []` (nobody
staffed) and absent from `LEADS`. Ran real `POST /api/sync-now` calls against the mock with **no
webhook involved at all** and confirmed each one landed on the board through the poll sweep alone —
`crewJobOpportunityCount`/`customerJobOpportunityCount` in the response show which source found
which. `test-webhook.js` still exercises the webhook path itself (`npm run test-webhook`) —
webhooks remain the better real-time signal once hosting is in place, but polling is no longer
structurally blind to any booking state.

### Opportunity status codes

SmartMoving reports an opportunity's pipeline stage as a number — the `status` field on
opportunity/lead responses and `opportunity-status` in webhook payloads (e.g.
`{"event-type": "opportunity-status-changed", "opportunity-id": "...", "opportunity-status": 10}`).
Mapped in `mapJobs.js` as `OPPORTUNITY_STATUS`:

| Code | Status           | Meaning                                      |
| ---- | ---------------- | -------------------------------------------- |
| 0    | New Lead         | Fresh inquiry, not yet worked                |
| 1    | Lead In Progress | Sales is working the lead                    |
| 3    | Opportunity      | Quoted/estimated, not booked yet             |
| 4    | Booked           | Customer committed — a real job to dispatch  |
| 10   | Completed        | The move has been performed                  |
| 11   | Closed           | Job finalized (billing/paperwork wrapped up) |
| 20   | Cancelled        | Was booked, then cancelled                   |
| 30   | Lost             | Customer went elsewhere / didn't book        |
| 50   | Bad Lead         | Junk or invalid lead                         |

The gaps (no 2, 5–9, etc.) are SmartMoving's own numbering. Only **4, 10 and 11**
(`BOOKED_STATUSES`) are imported as jobs. A job already imported that later moves to 20
(Cancelled) is **not** removed automatically — delete it from the board manually.

### Rate limits

The crew-jobs and customers sources mean one sync can be a lot of sequential calls on a real
account: one per crew member, a handful of paginated calls to `/api/customers`, plus two per
opportunity discovered (details + exact-timing jobs). Confirmed
live against a real account with 26+ crew members and dozens of opportunities — firing those with
no pacing hit SmartMoving's `429 Too Many Requests` almost immediately. `smartmovingClient.js`
handles this two ways, transparently, no action needed normally: every call is paced at least
`SMARTMOVING_MIN_REQUEST_INTERVAL_MS` (default 350ms) apart, and any `429` is automatically retried
after waiting however long SmartMoving's own error message says to ("Try again in N seconds"), up
to 6 retries per call. If a sync summary still shows `429` errors after that, raise
`SMARTMOVING_MIN_REQUEST_INTERVAL_MS` in `.env` — larger fleets need more headroom.

## What it does

1. **REST API for the scheduler** (`server.js` + `db.js`) — `GET /api/state` returns all
   trucks/drivers/jobs from Firestore; `POST`/`PATCH` endpoints create and update them. The
   scheduler UI calls these directly for every action (assigning a truck, adding a driver, editing
   a job) and polls `GET /api/state` in the background every 15s so multiple open tabs/devices stay
   in sync with each other.
2. **Webhook receiver** (`POST /webhooks/smartmoving`) — SmartMoving POSTs here on `job-created`,
   `opportunity-created`, `opportunity-status-changed`, or `opportunity-changed`. On a relevant
   event with an opportunity id, fetches `GET /api/opportunities/{id}` (and, best-effort,
   `GET /api/opportunities/{id}/jobs` for exact start/end times) and upserts the result into the
   `jobs` collection. `job-created` payloads only carry a job id with no opportunity id and nothing
   resolves one from the other, so that event is left for the poll sweep to pick up instead.
3. **Poll sweep** (primary sync path, every `POLL_INTERVAL_MINUTES`, default 120) — merges two
   discovery sources: `GET /api/crew-members/{id}/jobs` for every crew member, and
   `GET /api/customers` (pre-filtered to booked-only statuses) — over the same rolling date window
   (see "Webhooks vs. polling" above for why `GET /api/leads` was dropped) — then hydrates each
   opportunity found by either source the same way (booked-only filter applied again there,
   authoritatively), so nothing depends solely on webhooks arriving.
4. Syncing a job that's already in the database (matched by SmartMoving's internal job ID) only
   refreshes its SmartMoving-owned fields (customer, date, time, addresses, crew size) — truck
   assignments and status a dispatcher has set locally are left alone, so a sync can't undo their
   work. Jobs are never deleted by a sync — a cancelled booking just stops showing up as
   _schedulable_, but stays in the database until removed by hand.

Imported jobs show a small **SM** badge in the UI so it's clear which ones came from SmartMoving
vs. were entered by hand. From the scheduler, Admin → Trucks & Drivers → SmartMoving Sync panel →
**Sync now** triggers an on-demand poll sweep — normally you don't need this, since webhooks (or
the automatic interval sweep) keep things current on their own.

## Setup

Data lives in Firestore, not a local file — for local development, run it against the **Firestore
emulator** rather than real production data (see `server/firestore.js`'s header comment for how
credential resolution works). Requires Node 22.5+ still, but only for `node:sqlite` in the one-off
`migrate-to-firestore.js` script (see its header) — the request path itself (`server.js`/`db.js`)
doesn't need it anymore. `firebase-admin` and `nodemailer` (for the password-reset email — see
"Login & accounts") are the two real npm dependencies now, so `npm install` is a one-time step.

```bash
cd server
npm install
cp .env.example .env
# edit .env and paste in your SmartMoving API key

# In one terminal — starts the Firestore emulator on localhost:8080 (requires the Firebase CLI:
# npm install -g firebase-tools):
firebase emulators:start --only firestore

# In another terminal:
FIRESTORE_EMULATOR_HOST=localhost:8080 npm start
```

This starts the backend on `http://localhost:8787`, seeds the emulator with sample trucks/drivers/
jobs on first run (an empty Firestore database), and — if `ADMIN_EMAIL` is set in `.env` — grants
the first admin account. Emulator data resets every time you restart it (nothing to clean up
between runs). See "Login & accounts" below before you do anything else — set `ADMIN_PASSWORD`
too if you want to sign in immediately, or configure `SMTP_USER`/`SMTP_PASS` so the account can set
its own password via the emailed one-time code. Then start the frontend
(`cd ../frontend && npm install && npm run dev`) — it talks to `http://localhost:8787` by default.
To point it at a different backend (e.g. once you've deployed one), open it with
`?api=https://your-deployed-host` in the URL, or use the retry field that appears in the red banner
if it can't reach the backend.

**The scheduler needs this backend running to work at all** — there's no offline/local-only mode
anymore. If the backend is unreachable, the scheduler shows a banner and won't have any data to
display.

### Wiring up webhooks (do this once you have real hosting)

Webhooks need a public HTTPS URL — `localhost` won't work, so this step comes after you've
deployed (see Deployment below). In SmartMoving: **Settings → Integrations → SmartMoving API →
Webhooks**, and point it at `https://your-deployed-host/webhooks/smartmoving`. Subscribe to at
least `Job Created`, `Opportunity Created`, and `Opportunity Status Changed`. If you set
`WEBHOOK_SECRET` in `.env`, add the same value to whatever field SmartMoving offers for a secret/
signing value, or append it as `?secret=...` on the URL you give them — the receiver checks both
an `x-webhook-secret` header and a `secret` query param. Requires Premium tier (confirmed
available on this account as of 2026-08-05).

Test the receiver without waiting on SmartMoving:

```bash
node test-webhook.js http://localhost:8787 <opportunityId> job-created
# or against the mock server's sample direct-booking job:
npm run mock &   # separate terminal, or already running
npm run test-webhook   # defaults to opp-direct-004 / job-created
```

### Getting an API key

SmartMoving API keys are issued from the Developer Portal
(`api-public.smartmoving.com`). Two tiers:

- **Basic** — free, read-only, 20,000 calls/month. Enough to run the whole poll-sweep path
  (no webhooks) — `GET /api/opportunities/{id}`, `GET /api/opportunities/{id}/jobs` (exact
  `startTimeUtc`/`endTimeUtc` per job), `GET /api/leads`, `GET /api/crew-members`,
  `GET /api/crew-members/{id}/jobs`, and `GET /api/customers` are all tagged "basic" in the dev
  portal, confirmed 2026-08-10 — none of them need Premium.
- **Premium** — $149/month, adds write access and webhooks. Needed for the webhook path described
  above, and for `GET /api/premium/opportunities/{id}/jobs/{jobId}` (richer per-job detail: exact
  stop lat/lng, dispatcher/crew notes, charges — not currently used by `mapOpportunity.js`, which
  gets by on the basic tier's `jobAddresses`/`crewMembers`/exact timing already).

### Testing without a real API key

`server/mock-smartmoving-server.js` fakes SmartMoving's `/api/leads`, `/api/opportunities/{id}`,
`/api/opportunities/{id}/jobs`, `/api/crew-members`, `/api/crew-members/{id}/jobs`, and
`/api/customers` endpoints with a few sample bookings — including one absent from `/api/leads`
entirely (a direct booking), one assigned only to an `Inactive`-status crew member, and one Booked
with a job created but no crew assigned at all — to exercise every discovery source described in
"Webhooks vs. polling" above — so you can verify the whole pipeline without live credentials:

```bash
# terminal 1
npm run mock          # fake SmartMoving API on :8788

# terminal 2
SMARTMOVING_BASE_URL=http://localhost:8788/v1 SMARTMOVING_API_KEY=test-key npm start
```

Then open the frontend dev server (it'll load from this backend) and use the **Sync now** button in
Admin → Trucks & Drivers → SmartMoving Sync, or hit `http://localhost:8787/api/schedulable-jobs`
directly to see what would be imported.

## Login & accounts

Every route except `/api/health`, `/api/auth/login`, `/api/auth/forgot-password`,
`/api/auth/reset-password`, `/api/auth/status`, and the SmartMoving webhook receiver requires a
logged-in session. Sign-in is email + password, restricted to an allowlist (the `users` table) of
`@aroundtownmovers.com` addresses (case-insensitive) — an admin has to explicitly grant an address
access before it can ever sign in, same as before.

**Passwords are never stored in plaintext.** `auth.js` hashes them with `crypto.scryptSync` (built
into Node — no `bcrypt` package needed), salted per account, before anything touches the database.

**There's no admin-set temp password.** A brand new account (created by an admin with just an email
and role) starts with no password at all, and the _only_ way to set one — for a new account or one
that's actually locked out — is the same self-service flow: click "Forgot password?" on the login
screen, get a 6-digit code emailed to that address (valid 10 minutes, single-use), and submit it
along with a new password. This means the same code path covers both "first time signing in" and
"actually forgot it," and an admin never needs to think up or transmit a temporary password.

### One-time setup: email delivery

The forgot-password/first-time-setup flow needs somewhere to send the 6-digit code. Rather than a
third-party transactional email service (which needs a verified sending domain — DNS records added
by whoever controls `aroundtownmovers.com`'s DNS, which may not be readily available), this sends
through a real mailbox over SMTP. Uses `nodemailer` (`server/emailer.js`) — the one deliberate
exception to this backend's otherwise zero-npm-dependency approach; see that file's header comment
for why.

**Default: a personal/free Gmail account.** Chosen as the default over a company Microsoft 365
mailbox because it's entirely self-service:

1. Turn on 2-Step Verification for the Gmail account, if it isn't already:
   [myaccount.google.com/security](https://myaccount.google.com/security) → 2-Step Verification.
   Required before Google allows app passwords.
2. Generate an app password: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   → name it e.g. "ATM Scheduler" → copy the 16-character password.
3. In `server/.env`, set `SMTP_USER` to that Gmail address and `SMTP_PASS` to the app password
   (`SMTP_HOST`/`SMTP_PORT` already default to `smtp.gmail.com:465` — no need to set them for
   Gmail).
4. Restart the backend — the startup log confirms `Password-reset emails are configured (SMTP).`
5. Note the emails will show as coming from that Gmail address, not `@aroundtownmovers.com` — fine
   for an internal tool, but worth telling your team so a code from an unfamiliar address doesn't
   look suspicious.

**Alternative: a Microsoft 365 mailbox.** Set `SMTP_HOST=smtp.office365.com` and
`SMTP_PORT=587` in `.env`, with `SMTP_USER`/`SMTP_PASS` for that mailbox. **Confirmed against
aroundtownmovers.com's own tenant**: this fails out of the box with
`535 5.7.139 ... SmtpClientAuthentication is disabled for the Tenant` — most Microsoft 365 tenants
disable basic SMTP AUTH organization-wide by default. A tenant admin needs to re-enable it for that
one mailbox: Microsoft 365 admin center → **Users → Active users** → select the mailbox → **Mail**
tab → **Manage email apps** → check **Authenticated SMTP** (or via PowerShell:
`Set-CASMailbox -Identity user@aroundtownmovers.com -SmtpClientAuthenticationDisabled $false`). If
that admin access isn't available, the Gmail path above sidesteps this entirely.

Until one of these is set up, `/api/auth/forgot-password` still responds successfully (so it never
reveals whether an email is configured or which addresses exist) but no email actually goes out —
check `GET /api/health`'s `recentEvents` for `otp-send-failed` entries (with the exact SMTP error),
or the server log, to confirm. Set an `ADMIN_PASSWORD` (see below) to get into the app immediately
without waiting on this.

### Accounts

**The first admin account** is granted automatically the first time the server starts with an empty
`users` table, from `ADMIN_EMAIL` in `.env`. If `ADMIN_PASSWORD` is also set, that account can sign
in with it right away (change it via "Forgot password?" afterward); if not, it's created with no
password and needs email delivery configured (see above) to set one. After that first run, both
`ADMIN_EMAIL` and `ADMIN_PASSWORD` are ignored (only consulted while zero accounts exist) — safe to
leave in `.env` or remove them.

**Adding more accounts** — once signed in as an admin, use Admin → Users to grant access to an
`@aroundtownmovers.com` address and assign a role. There's no password field in that form on
purpose — the new person sets their own via "Forgot password?" the first time they sign in. The
Users panel flags any account that hasn't done this yet with a "NO PASSWORD YET" badge.

**From the terminal** — `node create-admin.js <email> [admin|dispatcher|crew] [password]` grants
access to a new address or changes an existing one's role (and password, if you give one). Useful
for the very first admin, for adding a second admin, or for recovering access without waiting on
email delivery:

```bash
node create-admin.js csr4@aroundtownmovers.com admin
node create-admin.js csr4@aroundtownmovers.com admin "a strong temp password"
```

**Roles** map directly to what a route allows:
| Role | Can do |
|---|---|
| `admin` | Everything — trucks/drivers CRUD, job assignment, SmartMoving sync, the Users panel. |
| `dispatcher` | Assign/move jobs (`PATCH /api/jobs/:id`) and view everything. Can't edit truck/driver records, can't reach `/api/users`, `/api/trucks`, `/api/drivers`, sync, reset-to-sample-data, or clear-jobs. |
| `crew` | Read-only — `GET /api/state` only. Any write attempt gets a 403. |

**Sessions** are a signed httpOnly cookie (`atm_session`), not a database table — after a successful
login (or password reset), this backend signs its own token containing just the user's id and an
expiry (7 days); every request re-reads that user's _current_ role from the database, so changing
someone's role (or removing their access) takes effect on their very next request rather than
waiting out their existing session. Restarting the server without a stable `SESSION_SECRET`
invalidates every session at once (see the table below) — that's a deliberate simplicity tradeoff,
not a bug: there's no server-side session store to manage.

The last remaining admin can't demote or delete themselves (or be demoted/deleted by anyone else)
via the API — promote a second admin first if you need to step down.

### Working on the app without email configured

Set `DEV_BYPASS_LOGIN=true` in `.env` (see `.env.example`) to add
`GET /api/auth/dev-login?role=admin|dispatcher|crew`, which signs you in as an existing account
with that role without a real password. The login screen shows "admin / dispatcher / crew" buttons
automatically whenever this is active. Never set `DEV_BYPASS_LOGIN` on anything reachable outside
your own machine — it has no automatic self-disable the way the old Microsoft-only bypass did, so
remove it from `.env` before deploying anywhere real.

**One-time codes are HMAC'd, not stored raw.** `auth.hashOtp` runs the 6-digit code through
HMAC-SHA256 keyed on `SESSION_SECRET` before it ever reaches `db.setUserOtp` — a database read alone
can't recover a usable code, same idea as the password hashing above.

## Configuration

Environment variables (set in `.env`, or via your hosting platform):

| Variable                              | Default                                 | Notes                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SMARTMOVING_API_KEY`                 | —                                       | Optional — only needed for CRM sync. Never put this in the frontend.                                                                                                                                                                                                                       |
| `WEBHOOK_SECRET`                      | — (disabled)                            | Verifies incoming webhook POSTs. Set before exposing the backend publicly.                                                                                                                                                                                                                 |
| `POLL_INTERVAL_MINUTES`               | `15`                                    | Fallback sweep frequency. `0` disables it — webhook-only, not recommended.                                                                                                                                                                                                                 |
| `POLL_LOOKBACK_DAYS`                  | `7`                                     | How far back the poll sweep's date window starts.                                                                                                                                                                                                                                          |
| `POLL_LOOKAHEAD_DAYS`                 | `60`                                    | How far forward the poll sweep's date window extends.                                                                                                                                                                                                                                      |
| `SMARTMOVING_BASE_URL`                | `https://api-public.smartmoving.com/v1` | Override to point at the mock server for testing.                                                                                                                                                                                                                                          |
| `SMARTMOVING_MIN_REQUEST_INTERVAL_MS` | `350`                                   | Minimum gap between consecutive SmartMoving API calls. Raise this if you have a large fleet/branch (many crew members, many opportunities) and still see `429` errors in the sync summary despite the built-in retry — see "Rate limits" below.                                            |
| `PORT`                                | `8787`                                  | Port the backend listens on. Set this to whatever port your AWS App Runner service is configured to send traffic to.                                                                                                                                                                       |
| `FIREBASE_PROJECT_ID`                 | —                                       | The Firebase/GCP project the Firestore data lives in (`atm-scheduler`). Always required on AWS — unlike Cloud Run, App Runner has no GCP environment to infer this from.                                                                                                                   |
| `FIREBASE_SERVICE_ACCOUNT_JSON`       | —                                       | The full contents of a downloaded service account key, as one JSON string — how the backend authenticates to Firestore on AWS (no built-in GCP identity there). Set via an App Runner secret, not a plain env var — see "AWS deployment" below and `server/firestore.js`'s header comment. |
| `GOOGLE_APPLICATION_CREDENTIALS`      | —                                       | Path to a downloaded service account JSON key **file**. Local-dev-only alternative to `FIREBASE_SERVICE_ACCOUNT_JSON` (a file path is more convenient than a JSON string on a laptop) — see `server/firestore.js`'s header comment. Never commit that file.                                |
| `FIRESTORE_EMULATOR_HOST`             | —                                       | Set to `localhost:8080` (or wherever `firebase emulators:start --only firestore` is listening) to develop locally without touching real data.                                                                                                                                              |
| `SMTP_USER` / `SMTP_PASS`             | —                                       | The mailbox that sends the forgot-password/first-time-setup one-time code (see "Login & accounts" → "One-time setup: email delivery"). Without these, that flow's emails silently don't go out.                                                                                            |
| `SMTP_HOST` / `SMTP_PORT`             | `smtp.gmail.com` / `465`                | Override for a different mailbox, e.g. Microsoft 365 (`smtp.office365.com` / `587` — see the tenant SMTP AUTH caveat above).                                                                                                                                                               |
| `SMTP_FROM`                           | `SMTP_USER`                             | Override only if the mailbox has "send as" delegation set up for a different address.                                                                                                                                                                                                      |
| `ADMIN_EMAIL`                         | —                                       | Only used to grant the very first admin account (see "Login & accounts").                                                                                                                                                                                                                  |
| `ADMIN_PASSWORD`                      | —                                       | Optional — lets the first admin sign in immediately instead of waiting on email delivery. Only consulted alongside `ADMIN_EMAIL` while zero accounts exist.                                                                                                                                |
| `FRONTEND_URL`                        | `http://localhost:5173`                 | Where the browser gets sent back to after using the dev-login bypass (a full-page redirect, unlike the regular fetch-based login).                                                                                                                                                         |
| `SESSION_SECRET`                      | random, regenerated each restart        | Signs session cookies and one-time codes. Set this to a stable random string, or every restart logs everyone out (and invalidates any outstanding reset code). Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.                               |
| `COOKIE_SECURE`                       | unset                                   | Set to `true` once served over HTTPS, to add the `Secure` flag to the session cookie. Leave unset for local `http://` development.                                                                                                                                                         |
| `DEV_BYPASS_LOGIN`                    | unset                                   | Local dev only — see "Working on the app without email configured." Never set on a publicly reachable server.                                                                                                                                                                              |

The scheduler picks up the backend URL from a `?api=` query parameter. In local dev (`npm run
dev`, frontend and backend as two separate processes/ports) it falls back to
`http://localhost:8787`; in the production build it falls back to `''` (same origin — see
`frontend/src/api.js`), since in production `server.js` itself serves the built frontend (see its
`serveStatic()` function) — frontend and API are the same AWS App Runner service, so the browser
never sees a different origin at all.

## Deployment

This backend is stateless (all data lives in Firestore, not on local disk), so any container
platform that honors `PORT` works. The setup this project actually uses is AWS App Runner, serving
both this backend's API and the built frontend from one container — see "AWS deployment" below for
the exact commands. A few things that apply regardless of platform:

- Set `SMARTMOVING_API_KEY`, `WEBHOOK_SECRET`, `SESSION_SECRET`, `SMTP_USER`, `SMTP_PASS`, and
  `FIREBASE_SERVICE_ACCOUNT_JSON` as real secrets (via a secret manager), never committed to the
  repo. `SESSION_SECRET` especially — an auto-generated one changes on every restart/redeploy,
  logging everyone out each time.
- Make sure `DEV_BYPASS_LOGIN` is unset on anything reachable outside your own machine.
- Set `COOKIE_SECURE=true` once this is served over HTTPS (it should be, for anything beyond local
  dev — the session cookie is otherwise sent in the clear). AWS App Runner is HTTPS-only by
  default, so this should always be `true` there.
- `/api/*` routes require a logged-in session now (see "Login & accounts" above), so they're safe
  to expose without an additional allowlist/VPN layer. `/webhooks/smartmoving` is the one route
  that stays public on purpose (for SmartMoving to reach it), so make sure `WEBHOOK_SECRET` is set
  before exposing it.
- This backend can now run more than one instance at once safely (Firestore, unlike the old SQLite
  file, is a real shared database) — App Runner's autoscaling just works. The one thing to watch:
  the `setInterval`-based poll sweep (see "Webhooks vs. polling" above) runs inside each instance's
  process, so if App Runner scales to zero between requests, that timer stops. See "AWS deployment"
  below for how this project handles that (minimum instance count of 1).

### AWS deployment

This app uses **Firestore for data, AWS for hosting/compute** — split across two separate cloud
accounts on purpose:

- **`atm-scheduler`** (Google Firebase project) — Firestore only. Stays on the no-cost Spark plan;
  plain Firestore usage under the free quotas doesn't require billing.
- **AWS App Runner** — runs this backend as a container, and also serves the built frontend (see
  the "4." item in `server.js`'s header comment) — one service, one URL, for both the site and its
  API. Chosen over Google Cloud Run specifically to avoid enabling Cloud Run/Cloud Build/Artifact
  Registry, which require the GCP project to be upgraded to the paid Blaze plan just to host a
  container — Firestore itself doesn't need that, and App Runner is AWS's closest equivalent to
  Cloud Run (build from a Dockerfile, auto-scaling, pay-per-use, HTTPS handled for you).

Since App Runner isn't a GCP product, it has no built-in Google identity and no persistent
filesystem to pre-place a downloaded credentials file on — the backend authenticates to Firestore
using a service account **key**, injected as a secret env var (`FIREBASE_SERVICE_ACCOUNT_JSON` —
see `server/firestore.js`'s header comment for exactly how this is resolved).

**One-time setup:**

1. In the `atm-scheduler` Firebase project, enable the Firestore API and create a Firestore
   database in **Native mode** (Firebase console → Build → Firestore Database → Create database),
   if it doesn't already have one.
2. Download a service account key for that project: Firebase console → `atm-scheduler` → Project
   settings → Service accounts → **Generate new private key**. This downloads a JSON file — treat
   it like a password (see .gitignore; never commit it).
3. Store that key's contents in AWS Secrets Manager as a single-line string (App Runner reads it
   from there as an env var):
   ```
   aws secretsmanager create-secret --name atm-scheduler/firebase-key \
     --secret-string "$(cat /path/to/the-downloaded-key.json | tr -d '\n')"
   ```
4. Create secrets for the rest of the sensitive config the same way:
   ```
   aws secretsmanager create-secret --name atm-scheduler/session-secret \
     --secret-string "$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
   aws secretsmanager create-secret --name atm-scheduler/smtp-pass --secret-string "your-gmail-app-password"
   aws secretsmanager create-secret --name atm-scheduler/smartmoving-api-key --secret-string "your-smartmoving-api-key"
   aws secretsmanager create-secret --name atm-scheduler/webhook-secret \
     --secret-string "$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
   ```
5. Build and push the container image to Amazon ECR (from the **repo root**, since the Dockerfile
   there needs both `frontend/` and `server/` in its build context):
   ```
   aws ecr create-repository --repository-name atm-scheduler   # one-time
   aws ecr get-login-password | docker login --username AWS --password-stdin <your-account-id>.dkr.ecr.<region>.amazonaws.com
   docker build -t atm-scheduler .
   docker tag atm-scheduler:latest <your-account-id>.dkr.ecr.<region>.amazonaws.com/atm-scheduler:latest
   docker push <your-account-id>.dkr.ecr.<region>.amazonaws.com/atm-scheduler:latest
   ```

**Create the App Runner service** (console is easiest for the first setup — CLI shown for
reference): Source = "Container registry" → pick the `atm-scheduler` ECR repo/`latest` tag → Port
`8787` (matches the Dockerfile's `EXPOSE`/`server.js`'s default). Under environment variables and
secrets:

| Name                                         | Value                                           | Type                                                                      |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `FIREBASE_PROJECT_ID`                        | `atm-scheduler`                                 | plain env var                                                             |
| `FIREBASE_SERVICE_ACCOUNT_JSON`              | `atm-scheduler/firebase-key`                    | secret (from Secrets Manager)                                             |
| `SESSION_SECRET`                             | `atm-scheduler/session-secret`                  | secret                                                                    |
| `SMTP_PASS`                                  | `atm-scheduler/smtp-pass`                       | secret                                                                    |
| `SMARTMOVING_API_KEY`                        | `atm-scheduler/smartmoving-api-key`             | secret                                                                    |
| `WEBHOOK_SECRET`                             | `atm-scheduler/webhook-secret`                  | secret                                                                    |
| `ADMIN_EMAIL`                                | your email                                      | plain env var — grants the first admin, see "Login & accounts"            |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER`      | `smtp.gmail.com` / `465` / your sending address | plain env vars                                                            |
| `POLL_LOOKBACK_DAYS` / `POLL_LOOKAHEAD_DAYS` | `30` / `30`                                      | plain env vars                                                            |
| `COOKIE_SECURE`                              | `true`                                          | plain env var — App Runner is HTTPS-only, so this should always be `true` |

Under "Auto scaling," set **minimum size to 1** — App Runner can otherwise scale a service to zero
between requests, which would silently stop the SmartMoving poll-sweep timer (the same
`setInterval` caveat that applies to Cloud Run — see "Webhooks vs. polling" above). It's a small
ongoing cost, worth it for a 3-week team test where you want sync to just keep working. No
authentication needs configuring on App Runner itself — this app's own login (email + password +
OTP) already gates every `/api/*` route.

App Runner gives you a URL like `https://xxxxxxxxxx.us-east-1.awsapprunner.com` once the service is
running (a custom domain can be attached later under "Custom domains" if you have one).

**Migrate the real data, once, before or right after the first deploy** — see
`server/migrate-to-firestore.js`'s own header comment for full details. Run it locally, from
whichever machine still has the real `server/data/atm.db` file on it (this uses
`GOOGLE_APPLICATION_CREDENTIALS` pointing at a **local copy** of the same downloaded key file,
since that's more convenient than pasting JSON into an env var on a laptop):

```
cd server
GOOGLE_APPLICATION_CREDENTIALS=/path/to/the-downloaded-key.json FIREBASE_PROJECT_ID=atm-scheduler \
node migrate-to-firestore.js            # dry run first — prints counts, writes nothing
# then, once the counts look right:
GOOGLE_APPLICATION_CREDENTIALS=/path/to/the-downloaded-key.json FIREBASE_PROJECT_ID=atm-scheduler \
node migrate-to-firestore.js --yes
```

**Verify:** visit the App Runner URL, confirm the login screen loads, and check
`<your-app-runner-url>/api/health` returns `{"ok": true, ...}` — that confirms the container is
serving both the frontend and the API, and that it can reach Firestore.

Grant the team's actual accounts once it's live, from your own machine (same
`GOOGLE_APPLICATION_CREDENTIALS`/`FIREBASE_PROJECT_ID` as the migration step above):

```
node create-admin.js dispatcher1@aroundtownmovers.com dispatcher
node create-admin.js crewlead1@aroundtownmovers.com crew
```

Each person then uses "Forgot password?" on the login screen to set their own password via an
emailed one-time code — see "Login & accounts" above.

**Redeploying after a code change:** rebuild and push a new image (the `docker build`/`tag`/`push`
steps above), then either trigger a deployment from the App Runner console or enable "automatic
deployments" on the service so a new image push redeploys on its own.

## Known limitations (flagged for future work)

- **`arrivalWindow` unit is an assumption.** SmartMoving's docs list `arrivalWindow.startTime`/
  `endTime` only as `number (double)`, no unit specified. `mapOpportunity.js` treats it as an
  hour-of-day decimal (8.5 → 8:30am). This only matters when `GET /api/opportunities/{id}/jobs`
  (basic tier, exact timing — see "Webhooks vs. polling" above) has no entry for a given job —
  double check the hour-decimal assumption is right once tested against a real account.
- **Time zone**: `GET /api/opportunities/{id}/jobs`'s `startTimeUtc`/`endTimeUtc` come back in
  UTC, and no endpoint found exposes the branch's local time zone, so imported start times (when
  sourced from there) are the raw UTC clock time. Fix once a timezone source is confirmed (could be a manual
  per-branch config value in `mapJobs.js`/`mapOpportunity.js`).
- **No write-back**: covered above — this is the big one, and needs a conversation with
  SmartMoving, not more code on our end.
- **Webhook signature verification**: the dev portal's webhook page didn't document a signing
  header, so this uses a simple shared secret instead (`WEBHOOK_SECRET`). If SmartMoving does sign
  payloads (check the "help docs" link on their webhook settings page), switching to verifying
  that signature would be stronger than a shared secret in a query param.

### Fixed since the first version (2026-08-05)

- ~~Type inference (local vs. long-distance) was a state-comparison heuristic~~ — now uses
  SmartMoving's own `opportunityType` field (0 Local/1 Intrastate/2 Interstate) from
  `GET /api/opportunities/{id}`, which is authoritative.
- ~~Long-distance jobs imported as single-day~~ — now uses `tripInfo.confirmedPickupDate`/
  `confirmedDeliveryDate` from the same endpoint for the real multi-day span, when trip info is
  available on the opportunity.
- ~~Jobs booked directly (not via a lead) were invisible to the sync~~ — fixed by the webhook path
  described above.

### Weekly Google Authorization

- Every week google should be authorised using this command: "$env:GOOGLE_APPLICATION_CREDENTIALS="../atm-scheduler-firebase-adminsdk-fbsvc-5a61cc7d23.json"; npm run gmail-auth" followed by "firebase deploy --only functions --project atm-scheduler" to make the atm-scheduler running without any disturbances as we are using the google test mode for this project.
