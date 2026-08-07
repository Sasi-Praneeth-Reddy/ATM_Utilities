# ATM Scheduler — backend

This backend has two jobs:

1. **Serves the scheduler's data** — trucks, drivers, and jobs live in a SQLite database on this
   server and are exposed over a small REST API (`GET /api/state`, plus create/update endpoints).
   `atm-scheduler.html` is a thin client: it has no local storage of its own anymore, so this
   backend has to be running for the scheduler to work at all, and every device that opens it talks
   to the same shared database.
2. **Pulls jobs that need dispatching out of SmartMoving CRM** and writes them into that same
   database, so dispatchers don't have to re-enter them by hand.

**This is one-way (pull only).** SmartMoving's public API has no endpoint that can write a job's
date, time, or truck assignment — every write endpoint (create job, update job notes, update job
stops, update opportunity, confirm job) was checked and none of them touch `jobDate` /
`startTimeUtc` / `endTimeUtc`. So: schedule changes made in the scheduler stay local. Dispatchers
still need to mirror any date/time changes into SmartMoving by hand until SmartMoving exposes a
write endpoint (worth asking their support team directly — this isn't something we can build
around on our end).

## Webhooks vs. polling — why both

Originally this only polled `GET /api/leads`. That endpoint's own docs say it returns New/In
Progress leads by default (Lost/Bad are opt-in) — it never documents Booked-status records being
included, and it's explicitly scoped to *leads*. SmartMoving separately has a `Create an
opportunity` endpoint that books a job directly, with no lead involved at all (e.g. a repeat
customer or phone booking a staff member enters straight as a booking) — so polling `/api/leads`
alone can silently miss real jobs.

Fixed by adding SmartMoving's webhooks as the primary trigger:

- **`Job Created`** and **`Opportunity Created`/`Opportunity Status Changed`** fire off the
  job/opportunity object itself — regardless of whether it ever passed through the lead pipeline.
  Confirmed directly in the webhook docs: `Opportunity Created` is described as firing "whether
  submitted via web form, entered manually, or created through an integration or API."
- Webhook payloads are thin — just `{event-type, opportunity-id or job-id, opportunity-status}` —
  so receiving one just tells the backend *which* opportunity to go re-fetch via
  `GET /api/opportunities/{id}`, not the full job detail.
- The old polling sweep is kept as a **fallback/backfill**, running on an interval (default every
  15 minutes) in case a webhook is ever missed, delayed, or misconfigured. It still only sees
  lead-sourced bookings, but between the two, coverage is as complete as the API allows.

Verified this actually closes the gap: `server/mock-smartmoving-server.js` includes a sample
booking (`opp-direct-004`) that exists only via the opportunity-details endpoint, not via
`/api/leads` — simulating a directly-booked job. A poll sweep alone doesn't find it; POSTing a
`job-created` webhook for it does. See `test-webhook.js`.

## What it does

1. **REST API for the scheduler** (`server.js` + `db.js`) — `GET /api/state` returns all
   trucks/drivers/jobs from the SQLite database; `POST`/`PATCH` endpoints create and update them.
   The scheduler UI calls these directly for every action (assigning a truck, adding a driver,
   editing a job) and polls `GET /api/state` in the background every 15s so multiple open tabs/
   devices stay in sync with each other.
2. **Webhook receiver** (`POST /webhooks/smartmoving`) — SmartMoving POSTs here on `job-created`,
   `opportunity-created`, `opportunity-status-changed`, or `opportunity-changed`. On a relevant
   event, fetches `GET /api/opportunities/{id}` (and, best-effort, the older
   `GET /api/premium/opportunities/{id}/jobs` for exact start/end times) and upserts the result
   into the `jobs` table.
3. **Poll sweep** (fallback, every `POLL_INTERVAL_MINUTES`) — walks `GET /api/leads` for a rolling
   date window and hydrates each one the same way, so nothing depends solely on webhooks arriving.
4. Syncing a job that's already in the database (matched by SmartMoving's internal job ID) only
   refreshes its SmartMoving-owned fields (customer, date, time, addresses, crew size) — truck
   assignments and status a dispatcher has set locally are left alone, so a sync can't undo their
   work. Jobs are never deleted by a sync — a cancelled booking just stops showing up as
   *schedulable*, but stays in the database until removed by hand.

Imported jobs show a small **SM** badge in the UI so it's clear which ones came from SmartMoving
vs. were entered by hand. From the scheduler, Admin → Trucks & Drivers → SmartMoving Sync panel →
**Sync now** triggers an on-demand poll sweep — normally you don't need this, since webhooks (or
the automatic interval sweep) keep things current on their own.

## Setup

Requires **Node 22.5 or newer** — this uses the built-in `node:sqlite` module (experimental as of
this Node line), not a separate database server or an npm package. No npm install needed — zero
dependencies. Check your version with `node -v`; if you're on an older Node, upgrade first (e.g.
via nvm: `nvm install 22 && nvm use 22`).

```bash
cd server
cp .env.example .env
# edit .env and paste in your SmartMoving API key
npm start
```

This starts the backend on `http://localhost:8787` and creates `server/data/atm.db` on first run,
seeded with sample trucks/drivers/jobs. Open `atm-scheduler.html` — it talks to
`http://localhost:8787` by default. To point it at a different backend (e.g. once you've deployed
one), open it with `?api=https://your-deployed-host` in the URL, or use the retry field that
appears in the red banner if it can't reach the backend.

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

- **Basic** — free, read-only, 20,000 calls/month. Enough to run the poll-sweep-only path (no
  webhooks) — `GET /api/opportunities/{id}` is tagged "basic" in the docs, not premium.
- **Premium** — $149/month, adds write access and webhooks. Needed for the webhook path described
  above, and for the more precise `startTimeUtc`/`endTimeUtc` timing from
  `GET /api/premium/opportunities/{id}/jobs` (falls back to the basic tier's `arrivalWindow` when
  that call isn't available).

### Testing without a real API key

`server/mock-smartmoving-server.js` fakes SmartMoving's `/api/leads`, `/api/opportunities/{id}`,
and `/api/premium/opportunities/{id}/jobs` endpoints with a few sample bookings — including one
that only exists via the opportunity-details endpoint, to exercise the webhook-only path — so you
can verify the whole pipeline without live credentials:

```bash
# terminal 1
npm run mock          # fake SmartMoving API on :8788

# terminal 2
SMARTMOVING_BASE_URL=http://localhost:8788/v1 SMARTMOVING_API_KEY=test-key npm start
```

Then open `atm-scheduler.html` (it'll load from this backend) and use the **Sync now** button in
Admin → Trucks & Drivers → SmartMoving Sync, or hit `http://localhost:8787/api/schedulable-jobs`
directly to see what would be imported.

## Configuration

Environment variables (set in `.env`, or via your hosting platform):

| Variable | Default | Notes |
|---|---|---|
| `SMARTMOVING_API_KEY` | — | Required. Never put this in the frontend HTML. |
| `WEBHOOK_SECRET` | — (disabled) | Verifies incoming webhook POSTs. Set before exposing the backend publicly. |
| `POLL_INTERVAL_MINUTES` | `15` | Fallback sweep frequency. `0` disables it — webhook-only, not recommended. |
| `POLL_LOOKBACK_DAYS` | `7` | How far back the poll sweep's date window starts. |
| `POLL_LOOKAHEAD_DAYS` | `60` | How far forward the poll sweep's date window extends. |
| `SMARTMOVING_BASE_URL` | `https://api-public.smartmoving.com/v1` | Override to point at the mock server for testing. |
| `PORT` | `8787` | Port the backend listens on. |
| `SQLITE_PATH` | `server/data/atm.db` | Where the database file lives. Must be a normal local-disk path — SQLite needs real file locking, which doesn't work over some network drives or FUSE-style mounts. |

The scheduler picks up the backend URL from a `?api=` query parameter (falls back to
`http://localhost:8787`) — there's nothing to configure in the browser's storage, since the app no
longer uses any.

## Deployment

The backend is a single dependency-free Node process, so it runs anywhere Node 22.5+ runs: a small
VM, Render, Railway, Fly.io, or a container. Whatever you use:

- Set `SMARTMOVING_API_KEY` and `WEBHOOK_SECRET` as real environment variables, not committed to a
  repo.
- The `/api/*` endpoints (including `/api/state`, which is the whole scheduler's data) have no auth
  of their own — keep the deployment reachable only by whoever needs the scheduler (an allowlist,
  VPN, or reverse-proxy auth is enough for a small team). `/webhooks/smartmoving` is the one route
  that must stay publicly reachable (for SmartMoving to reach it), so make sure the secret is set
  before exposing it.
- The database is a single SQLite file at `server/data/atm.db` (auto-created and seeded on first
  run, gitignored). It needs to sit on real local disk — most VMs and container platforms give you
  this by default, but if you attach a network volume, confirm it supports normal file locking
  first. Run only **one instance** of this backend against one database file — SQLite handles
  concurrent access from many clients (the scheduler's tabs/devices) fine, but isn't meant to be
  shared by multiple *server* processes at once the way a networked database would be.
- Back up `server/data/atm.db` periodically (a plain file copy is fine while the server isn't
  mid-write) — it's now the only copy of trucks, drivers, and jobs.

## Known limitations (flagged for future work)

- **`arrivalWindow` unit is an assumption.** SmartMoving's docs list `arrivalWindow.startTime`/
  `endTime` only as `number (double)`, no unit specified. `mapOpportunity.js` treats it as an
  hour-of-day decimal (8.5 → 8:30am). This only matters when the Premium-tier
  `startTimeUtc`/`endTimeUtc` isn't available for a job — double check this is right once tested
  against a real account.
- **Time zone**: the premium endpoint's `startTimeUtc`/`endTimeUtc` come back in UTC, and no
  endpoint found exposes the branch's local time zone, so imported start times (when sourced from
  there) are the raw UTC clock time. Fix once a timezone source is confirmed (could be a manual
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
