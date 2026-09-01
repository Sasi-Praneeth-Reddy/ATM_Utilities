# ATM Scheduler

A truck and job scheduler for Around Town Movers, built around a drag-and-drop board and a
one-way sync from the SmartMoving CRM.

## What's here

- **`frontend/`** — the scheduler itself, as a React (Vite) app. It's a thin client: it holds no
  data of its own and needs the backend below running to load or save anything. See
  [`frontend/README.md`](frontend/README.md) for setup and project layout.
- **`server/`** — a small Node backend, deployed to AWS App Runner, backed by Firestore. It stores
  all scheduler data (trucks, drivers, jobs) and serves it over a REST API (and the built frontend
  itself, in production), and separately pulls schedulable jobs out of SmartMoving CRM into that
  same database. See [`server/README.md`](server/README.md) for setup, webhook configuration, AWS
  deployment, and the full list of known limitations.
- **`atm-scheduler.html`** — the original single-file HTML/CSS/JS version. Superseded by
  `frontend/` (same features, ported 1:1 into React components) — kept around for now so nothing's
  deleted before you've had a chance to confirm the new version works for you. Safe to delete once
  you have.

## Features

- Truck board with two views: a today/day timeline (trucks as rows) and a month calendar.
- Drag-and-drop job-to-truck assignment.
- Long-distance jobs render as multi-day, Google-Calendar-style spanning bars in month view, with
  per-driver color coding.
- Multi-truck jobs — long-distance moves that need more than one truck can have several assigned,
  with a "needs N more trucks" indicator.
- Scheduling conflict detection: overlapping jobs on the same truck are flagged, with the
  shorter/conflicting job always rendered on top so it's visible against a longer move underneath.
- Login: email + password, restricted to `@aroundtownmovers.com` addresses (any case). New accounts
  start with no password — the person sets their own via an emailed 6-digit one-time code ("Forgot
  password?" on the login screen). Three roles — **Admin** (full edit — trucks, drivers, jobs, and
  can grant/manage other users' access), **Dispatcher** (can assign/move jobs, can't edit
  truck/driver master records or users), **Crew** (read-only, mobile-oriented). See
  [`server/README.md`](server/README.md) "Login & accounts" for email delivery setup, how the first
  admin gets granted, and how to add more people.
- SmartMoving sync (Admin → Trucks & Drivers → SmartMoving Sync panel): pulls jobs that need
  dispatching directly into the board. One-way — see [`server/README.md`](server/README.md) for
  why, and for the webhook + polling architecture that keeps it up to date.
- Shared, persistent data: trucks/drivers/jobs live in Firestore on the backend, not in the
  browser — every device pointed at the same backend sees the same board, and it stays refreshed
  automatically (polls every 15s). Admin → Trucks & Drivers → **Reset to sample data** clears the
  database back to the original demo state for everyone using it.

## Getting started

The scheduler needs the backend running — there's no offline/mock-data-only mode anymore, since all
data lives in its database.

```bash
# 1. backend
cd server
npm install
cp .env.example .env
# edit .env: set ADMIN_EMAIL (grants the first admin) and either ADMIN_PASSWORD (sign in right
# away) or SMTP_USER/SMTP_PASS (so the account can set its own password by email), and,
# optionally, your SmartMoving API key

# in one terminal — starts a local Firestore emulator (npm install -g firebase-tools first):
firebase emulators:start --only firestore
# in another terminal:
FIRESTORE_EMULATOR_HOST=localhost:8080 npm start
```
This seeds sample trucks/drivers/jobs into the emulator on first run, and grants the first admin
account from `ADMIN_EMAIL`. Full backend details, including email delivery setup, login/account
management, webhook setup for real-time SmartMoving sync, and deployment (Firestore + AWS App
Runner), are in [`server/README.md`](server/README.md).

```bash
# 2. frontend (separate terminal)
cd frontend
npm install
npm run dev
```
This prints a local dev URL (usually `http://localhost:5173`) — open it in a browser. It connects
to `http://localhost:8787` by default. More in [`frontend/README.md`](frontend/README.md).

## Status

Prototype is feature-complete for the scheduling/board side. SmartMoving sync is built and
verified against mock data; still needs a live test against a real account before it's trusted for
actual dispatch.

- [x] Truck board (day timeline + month calendar), drag-and-drop assignment
- [x] Long-distance multi-day jobs, multi-truck jobs, conflict detection
- [x] Role-based views (Admin / Dispatcher / Crew)
- [x] SmartMoving one-way sync: webhook receiver + polling fallback, backend + UI
- [x] Shared persistence: Firestore database on the backend (trucks/drivers/jobs), served over a
      REST API — the scheduler is now a thin client with no local/offline storage, so multiple
      devices pointed at the same backend share one live board
- [x] Frontend rewritten from a single HTML/JS file into a React (Vite) app in `frontend/` — same
      features, ported 1:1 into components; build verified and every view smoke-tested against the
      real backend
- [x] Login: email + password restricted to `@aroundtownmovers.com` addresses, scrypt-hashed
      passwords (no plaintext, no third-party identity provider), httpOnly-cookie sessions,
      role-based access (admin/dispatcher/crew) enforced on every API route, admin-only Users panel
      to grant access / change roles / remove access. New accounts (and locked-out ones) set their
      own password via an emailed 6-digit one-time code, sent via SMTP through an existing mailbox
      (a personal Gmail account by default — self-service, no tenant admin needed) rather than a
      third-party email service — see `server/README.md` "Login & accounts" for setup. First admin
      account bootstraps from `.env`.
- [ ] Live test of the sync against a real SmartMoving account
- [x] Real hosting for the backend and frontend: Firestore (data) + AWS App Runner (backend API
      and the built frontend, served from one container) — see [`server/README.md`](server/README.md)
      "AWS deployment"
- [ ] Push job/schedule changes back to SmartMoving — currently blocked; their public API has no
      write endpoint for job date/time (see `server/README.md`)
- [ ] Manual browser click-through test of the React frontend (drag-and-drop, forms) — build and
      component rendering are verified, but no interactive browser session yet

## License

Internal project for Around Town Movers — not published/licensed for external use.
