# SmartMoving API Playground

A standalone dashboard for poking at your real SmartMoving account, completely separate from the
scheduler app. It doesn't import `server.js`/`db.js`, doesn't touch the scheduler's SQLite
database, and never calls a SmartMoving write endpoint — read-only `GET` calls only.

Use this to see exactly what your account's real API returns before we trust any of it inside
`server/mapOpportunity.js`.

## Run it

Needs real internet access to reach SmartMoving, so run it on your own machine (not this sandbox):

```
cd smartmoving-playground
node playground-server.js
```

Open **http://localhost:8790**. It reuses `server/.env`, so your `SMARTMOVING_API_KEY` is already
in place — nothing else to configure.

## What it does

1. **Fetch leads** — hits `GET /api/leads` for a date range you pick (defaults: 60 days back, 90
   ahead) and lists every lead with its status. A banner up top flags it clearly if **no**
   Booked/Completed/Closed leads came back at all — expected, since `GET /api/leads`'s own
   dev-portal description says it only returns New/InProgress by default, with no parameter to
   widen that to Booked+ (confirmed live 2026-08-10).
2. **Click any lead** — fetches `GET /api/opportunities/{id}` and
   `GET /api/opportunities/{id}/jobs` for that one lead and shows the raw JSON for both, side by
   side, with `jobs[].length` called out in big red/green text and the top-level response keys
   listed.
3. **"Check jobs[] for every lead"** — loops through every lead in the current list (with a small
   delay between calls) and fills in the `jobs[]` column for all of them at once, then reports
   "N of M leads have a populated jobs[] array" — the fastest way to see the overall picture.
4. **"Check crew jobs (bypasses /api/leads)"** — hits `GET /api/crew-members` then
   `GET /api/crew-members/{id}/jobs` for each active crew member in the same date range. This is
   the endpoint that actually finds already-booked jobs, since it never goes through `/api/leads`
   at all. The summary highlights any opportunity id found this way that ISN'T in the
   currently-loaded leads list — that gap is exactly what a leads-only poll used to miss, and
   what `server.js`'s `pollSweep()` now also checks for real.

## Why this exists

**Update 2026-08-10 — the open question this was built for is now answered.** Browsed the real
SmartMoving dev portal (`api-details` + `webhook-document`) and confirmed: `GET /api/leads`
structurally can never return a Booked/Completed/Closed opportunity (no query param exists to ask
for one), and the scheduler's old "premium jobs by opportunity" call was hitting a URL that doesn't
exist (`/api/premium/opportunities/{id}/jobs` — the real basic-tier endpoint has no `/premium/`
segment). Both are now fixed in `server/smartmovingClient.js`/`server/mapOpportunity.js`/
`server.js`'s `pollSweep()`, which now also walks `GET /api/crew-members/{id}/jobs` to find
already-booked jobs without needing a webhook. Verified end-to-end against the mock server: a
direct-booking fixture invisible to `/api/leads` now lands on the board through polling alone. See
the "Webhooks vs. polling" section in `server/README.md` for the full writeup.

This dashboard is still useful for checking your *real* account's data shape against those fixed
assumptions (crew-jobs coverage depends on jobs actually being assigned to a crew member, and the
`arrivalWindow`/timezone assumptions in `mapOpportunity.js` are still flagged as unverified against
live data) — findings feed back into `server/mapOpportunity.js` and `server/smartmovingClient.js`
if anything needs further adjustment.

A simpler console-only version of this same check is in `../server/debug-smartmoving.js`, if you'd
rather just read plain text output than click through a page.
