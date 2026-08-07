# ATM Scheduler

A truck and job scheduler for Around Town Movers, built around a drag-and-drop board and a
one-way sync from the SmartMoving CRM.

## What's here

- **`frontend/`** — the scheduler itself, as a React (Vite) app. It's a thin client: it holds no
  data of its own and needs the backend below running to load or save anything. See
  [`frontend/README.md`](frontend/README.md) for setup and project layout.
- **`server/`** — a small Node + SQLite backend. It stores all scheduler data (trucks, drivers,
  jobs) and serves it over a REST API, and separately pulls schedulable jobs out of SmartMoving CRM
  into that same database. See [`server/README.md`](server/README.md) for setup, webhook
  configuration, deployment, and the full list of known limitations.
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
- Three roles: **Admin** (full edit — trucks, drivers, jobs), **Dispatcher** (can assign/move jobs,
  can't edit truck/driver master records), **Crew** (read-only, mobile-oriented, scoped to one
  truck's jobs).
- SmartMoving sync (Admin → Trucks & Drivers → SmartMoving Sync panel): pulls jobs that need
  dispatching directly into the board. One-way — see [`server/README.md`](server/README.md) for
  why, and for the webhook + polling architecture that keeps it up to date.
- Shared, persistent data: trucks/drivers/jobs live in a SQLite database on the backend, not in the
  browser — every device pointed at the same backend sees the same board, and it stays refreshed
  automatically (polls every 15s). Admin → Trucks & Drivers → **Reset to sample data** clears the
  database back to the original demo state for everyone using it.

## Getting started

The scheduler needs the backend running — there's no offline/mock-data-only mode anymore, since all
data lives in its database.

```bash
# 1. backend
cd server
cp .env.example .env
# edit .env, add your SmartMoving API key (optional — only needed for CRM sync)
npm start
```
This creates and seeds `server/data/atm.db` on first run. Full backend details, including webhook
setup for real-time SmartMoving sync and deployment notes, are in
[`server/README.md`](server/README.md).

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
- [x] Shared persistence: SQLite database on the backend (trucks/drivers/jobs), served over a REST
      API — the scheduler is now a thin client with no local/offline storage, so multiple devices
      pointed at the same backend share one live board
- [x] Frontend rewritten from a single HTML/JS file into a React (Vite) app in `frontend/` — same
      features, ported 1:1 into components; build verified and every view smoke-tested against the
      real backend
- [ ] Live test of the sync against a real SmartMoving account
- [ ] Real hosting for the backend (needed for webhooks — they require a public URL — and for
      multi-device use outside one machine) and a static host for the built `frontend/`
- [ ] Push job/schedule changes back to SmartMoving — currently blocked; their public API has no
      write endpoint for job date/time (see `server/README.md`)
- [ ] Manual browser click-through test of the React frontend (drag-and-drop, forms) — build and
      component rendering are verified, but no interactive browser session yet

## License

Internal project for Around Town Movers — not published/licensed for external use.
