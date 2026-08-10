# ATM Scheduler — frontend

A React (Vite) port of the scheduler UI — the truck board, long-distance planner, admin panel, and
crew view. Same features and look as the original single-file `atm-scheduler.html`, just split into
components instead of one 1,300-line file of hand-written DOM manipulation.

This talks to the `server/` backend over its REST API — it holds no data of its own. See the root
[`README.md`](../README.md) and [`server/README.md`](../server/README.md) for how the backend works.

## Setup

Requires Node 18+ (any reasonably recent Node works here — the version requirement that matters for
this project is on the backend, which needs 22.5+ for SQLite).

```bash
cd frontend
npm install
npm run dev
```

This starts a dev server (prints the local URL, usually `http://localhost:5173`) with hot reload.
The backend needs to be running separately (`cd ../server && npm start`) — the app is a thin client
and has nothing to show without it.

By default the frontend talks to `http://localhost:8787`. To point it at a different backend, open
it with a `?api=` query param, e.g. `http://localhost:5173/?api=https://your-deployed-backend`. If
the backend can't be reached, the app shows a banner with a field to retry a different URL for the
rest of that session — nothing is saved to local storage.

You'll land on a login screen first — there's a single "Sign in with Microsoft" button, no
email/password form. See the root [`server/README.md`](../server/README.md) "Login & accounts" for
the Entra ID app registration steps and how the first account gets granted. There's no role switcher
anymore (the old prototype let you pick "viewing as" from a dropdown) — your role comes from
whichever Microsoft account you sign in with, enforced by the backend on every request, not just
hidden in the UI.

## Building for real use

```bash
npm run build
```

Produces a static `dist/` folder — plain HTML/CSS/JS, no server-side rendering needed. Serve it with
any static file host (the backend's own `server/server.js` doesn't currently serve it — that's a
separate concern; see the root README's "Status" section for what's still open). `npm run preview`
serves the built `dist/` locally if you want to sanity-check a production build before deploying it.

## Project layout

- `src/api.js` — the fetch wrapper around the backend's REST API. Sends `credentials: 'include'` on
  every call so the httpOnly session cookie goes along with it.
- `src/hooks/useAuth.js` — the logged-in user (via `/api/auth/me`), `microsoftLoginUrl` (a full-page
  redirect, not a fetch call — sign-in itself happens on Microsoft's site), `logout`, and a
  `handleAuthError` the other hooks call if a request ever comes back 401 (session expired) so the
  app falls back to the login screen instead of just erroring. Also tracks `connectionError`
  separately from "not logged in," so an unreachable backend shows a clear message instead of a
  blank login form.
- `src/hooks/useSchedulerData.js` — the one hook holding all trucks/drivers/jobs state and every
  mutation (assign a truck, edit a driver, sync from SmartMoving, etc.). Each mutation updates local
  state immediately and separately persists to the backend, surfacing a banner if the save fails —
  same optimistic-update pattern the original file used, just with React state instead of global
  variables and manual re-renders. Only starts loading/polling once `useAuth` confirms a session.
- `src/hooks/useUsers.js` — admin-only: the Users list plus create/change-role/delete, each
  refetching the list afterward. No password reset — there's nothing to reset.
- `src/utils/dates.js`, `src/utils/jobs.js` — pure helper functions (date formatting, conflict
  detection, driver colors, month-view lane assignment) ported directly from the original file's
  equivalent functions, with the same behavior.
- `src/components/` — one component per section of the UI: `LoginScreen`, `Header`, `Nav`,
  `BackendBanner`, `ConflictBanner`, `DriverLegend`, `board/` (day timeline + month calendar),
  `admin/` (trucks/drivers CRUD, SmartMoving sync panel, `UsersAdmin`), `LDPlanner`, `CrewTab`.

## Relationship to `atm-scheduler.html`

The old single-file version in the project root still exists but is now superseded by this
`frontend/` app — same features, ported 1:1. Once you've confirmed this version works for you, feel
free to delete `atm-scheduler.html`; it's kept for now only so nothing is deleted without you seeing
it work first.
