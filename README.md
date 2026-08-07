# ATM Scheduler

A truck and job scheduler for Around Town Movers, built around a drag-and-drop board and a
one-way sync from the SmartMoving CRM.

## What's here

- **`atm-scheduler.html`** — the scheduler itself. A single self-contained HTML/CSS/JS file, no
  build step, no client-side dependencies. It's a thin client, though: it holds no data of its own
  and needs the backend below running to load or save anything.
- **`server/`** — a small Node + SQLite backend. It stores all scheduler data (trucks, drivers,
  jobs) and serves it over a REST API, and separately pulls schedulable jobs out of SmartMoving CRM
  into that same database. See [`server/README.md`](server/README.md) for setup, webhook
  configuration, deployment, and the full list of known limitations.

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
cd server
cp .env.example .env
# edit .env, add your SmartMoving API key (optional — only needed for CRM sync)
npm start
```
This creates and seeds `server/data/atm.db` on first run. Then open `atm-scheduler.html` — it
connects to `http://localhost:8787` by default. Full backend details, including webhook setup for
real-time SmartMoving sync and deployment notes, are in [`server/README.md`](server/README.md).

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
- [ ] Live test of the sync against a real SmartMoving account
- [ ] Real hosting for the backend (needed for webhooks — they require a public URL — and for
      multi-device use outside one machine)
- [ ] Push job/schedule changes back to SmartMoving — currently blocked; their public API has no
      write endpoint for job date/time (see `server/README.md`)
- [ ] Manual browser click-through test of the rewritten (backend-backed) scheduler UI

## License

Internal project for Around Town Movers — not published/licensed for external use.
