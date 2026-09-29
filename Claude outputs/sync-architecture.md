# ATM Scheduler — SmartMoving Sync Architecture (as of 2026-09-29)

Five distinct sync sources feed the scheduler board, plus three manual "Sync Now" triggers. This
is what each one does, when it runs, and how conflicts between them are resolved.

## 1. Daily order of automated runs

| Time (ET) | Source | Function |
|---|---|---|
| 6:00 AM | REST poll sweep (SmartMoving API) | `pollSweepScheduled` |
| 8:00 AM | Calendar sync (Google Calendar) | `calendarSweepScheduled` |
| 12:00 PM | Calendar sync | `calendarSweepScheduled` |
| 12:00 PM | Smart Insights (Gmail reports) | `smartInsightsSyncScheduled` |
| 1:00 PM | Calendar sync | `calendarSweepScheduled` |
| 4:00 PM | Smart Insights | `smartInsightsSyncScheduled` |
| 4:03 PM | Calendar sync | `calendarSweepScheduled403pm` |
| continuous | **Webhooks** | `api` (POST /webhooks/smartmoving) — event-driven, not scheduled |

Webhooks (just registered today) are now the **primary** trigger for anything SmartMoving-side —
Opportunity Created / Status Changed / Changed, and Job Created all fire in real time and
immediately hydrate just that one opportunity. Everything scheduled above exists as a backstop or
for data the webhook payloads don't carry (truck/crew text, Smart Insights fields).

## 2. What each source can actually do

| Source | Creates new jobs? | Refreshes date/time/address/customer/crew size? | Truck/driver assignment | Multi-day endDate |
|---|---|---|---|---|
| REST poll / webhook (`hydrateOpportunity`) | Yes | Yes (unless manual-edit-locked) | Fill-if-empty only — never removes (`mapOpportunity.js` has no truck field to sync from at all) | Non-regressing only (never shrinks a span the calendar already set) |
| Calendar sync | **No** — enrichment only, never creates a board entry on its own | Yes (unless manual-edit-locked) | Full two-way sync (adds, changes, *and clears*) unless truck-locked | Sets unconditionally — this is the one authoritative source for real multi-day spans |
| Smart Insights (Gmail reports) | Yes | Yes, except endDate (deliberately never touches it — see below) | Never — this source carries no truck data at all | Never touches it (fixed 2026-09-10: it used to null out a calendar-set span every run) |

Calendar sync intentionally never creates a new board entry by itself (2026-08-27 change, at your
explicit request) — it only enriches a job that already exists via a REST/webhook/Smart-Insights
counterpart match. A calendar event with no matching job on the board is skipped, not added.

## 3. The two locks that override all of the above

- **Manual edit lock** (`manuallyEditedAt`/`manuallyEditedBy`) — trips the moment a dispatcher
  changes customer/type/date/endDate/startTime/endTime/duration/origin/destination/crewSize/notes
  through the UI. Once set, REST poll, webhook, calendar sync, and Smart Insights **all skip that
  job entirely** — not just the edited field, the whole job — until "Resync from source" clears it.
- **Truck-assignment lock** (`truckLockedAt`/`truckLockedBy`) — separate, narrower lock, trips on a
  manual truck/driver assignment. Only affects calendar sync's truck-sync behavior (the only source
  that can actively change an assignment); REST/webhook's fill-if-empty is already safe without it.

Both are cleared together by the same "Resync from source" action.

## 4. Identity fields — who's allowed to set them

`smartMovingJobId`/`smartMovingOpportunityId` (the real SmartMoving GUIDs, not to be confused with
the calendar feed's iCal UID) are only ever written by the REST poll/webhook path once set — the
calendar sync explicitly deletes these two keys from its own update payload if the job already has
real values, so it can never clobber them with the iCal UID (bug fixed 2026-08-27). This is also
what makes JobEditModal's "Open in SmartMoving" link reliable.

## 5. Manual triggers (any admin, any time)

- `POST /api/sync-now` — runs `pollSweep()` immediately (the REST poll).
- `POST /api/calendar-sync-now` — runs the calendar sync immediately.
- `POST /api/smart-insights/sync-now` — runs the Smart Insights Gmail pipeline immediately.

## 6. Current rollout status (2026-09-29)

- Webhook registered in SmartMoving: Opportunity Created, Opportunity Status Changed, Opportunity
  Changed, Job Created → `https://api-65qmlj54ya-uc.a.run.app/webhooks/smartmoving`.
- `WEBHOOK_SECRET` confirmed live (`webhookSecretConfigured: true` on `/api/health`).
- No delivery yet — waiting on the first real SmartMoving event to confirm `lastWebhookAt`/
  `recentEvents` populate.
- `pollSweepScheduled` re-enabled today as a once-daily 6 AM backstop (was fully paused 8/24–9/29).
- Smart Insights left running unchanged, deliberately, as a free parallel safety net during the
  webhook trial period — no retirement decision made yet.
