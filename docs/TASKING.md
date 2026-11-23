# Tasking module

The office's daily "what needs doing" board, inside ATM Hub (sidebar → **Tasking**).
Visible to admin, dispatcher, owner and developer. Two pages:

| Page | Tab id | What it is |
|---|---|---|
| **Summary** | `tk-summary` | Five lists of pending actions for a chosen day |
| **Dispatch** | `tk-dispatch` | Per-job dispatch notes, materials and crates; print and email the day |

Code map (everything is new files except the small hooks listed under "Where it touches existing code"):

```
server/tasking.js                         all Tasking logic (read this first)
server/materialsReport.js, materialsSync.js   Job Materials report parser + Gmail pickup
server/test-tasking.js                    logic test against a fake Firestore (node test-tasking.js)
frontend/src/components/tasking/          TaskingSummary.jsx, NotSecuredList.jsx, TaskingDispatch.jsx, taskingApi.js, taskingUtils.js
frontend/src/styles.css                   styles, all prefixed  tk-
```

## The five Summary lists and where each comes from

| List | Rule | Data source |
|---|---|---|
| **Call list** | Every board job on the day, by start time. Tick when the customer was called. Assignee = Crew or Erika (a day-level default, overridable per job). | Board jobs (`jobs` collection) + phone from `tasking_opps` |
| **PBO upsell** | The 14 days from the day picked on the page (the countdown is counted from that day). PBO = text match (`PBO`, "packed by owner", "customer pack") in job text or SmartMoving custom fields, **or** set manually. Each has a follow-up status, note and due date. | Board jobs + `tasking_opps.pboHint` + `tasking_state` |
| **Upcoming not secured** | Service date today → 90 days out, status Opportunity (3) or Booked (4), checked two ways from the documents/payments read by *Refresh from SmartMoving*: **estimate** (a signed estimate/contract document = signed; otherwise *Estimate not signed*, or *Estimate not sent* if there is no estimate document; *Not checked yet* if documents were never read) and **deposit** (*No deposit paid* when no deposit and nothing paid). A row can show both reasons. Countdown pill: red ≤3 days, amber ≤7, green otherwise. Military jobs skipped. | `tasking_opps` |
| **Completed not paid** | Status 10 (Completed), last 120 days, balance outstanding > 0. | `tasking_opps` |
| **Active claims** | SmartMoving service tickets of type **Claim** that are not Completed. | `tasking_claims` |

**How "Upcoming not secured" is shown:** `NotSecuredList.jsx` draws this list (display only, nothing is saved). It shows 8 rows per page with Previous / Next (`PAGE_SIZE`), inside an area that scrolls on its own (`.tk-ns-list`, max 520px), with filter chips (All / Within 3 days / Within 7 days — the `FILTERS` array) and the estimate total of the rows in the current filter. To change the page size or add a filter, edit those two constants; styles are the `tk-ns-*` and `tk-chip` classes in `styles.css`.

**How SmartMoving notes are shown on Dispatch:** the calendar event lists notes under headings (*Dispatch notes, Internal notes, Crew notes, Customer notes*). `parseCalendarNotes` keeps each one separately in `sections` and saves it on the job as `smNoteSections` (`{dispatch, internal, crew, crewFeedback, customer}`). The job card draws one labelled block per type (`NOTE_TYPES` in `TaskingDispatch.jsx` sets the order, labels and colours); identical text under two headings is shown once with both tags. `smNotes` (all types in one text) is still saved for the crew email, PBO matching, and as the fallback for jobs imported before the split. **Crew feedback** is supported by the parser but SmartMoving does not put it in the calendar event, so that block stays empty until another source provides it.

## How the data gets in (read this before debugging an empty list)

Pages read **Firestore only** — opening Tasking never calls SmartMoving.
SmartMoving data arrives three ways:

1. **Stubs from the existing sweep.** `pollSweep` already lists every customer's opportunities (status, service date, customer, quote #). One hook there (`tasking.noteOpportunities`) saves a stub for each, booked or not, **at no extra API cost**. The sweep window is `POLL_LOOKBACK_DAYS` (7) back and `POLL_LOOKAHEAD_DAYS` (60) ahead, so Tasking only learns about opportunities in that window.
2. **Details from webhooks/hydration.** `hydrateOpportunity` calls `tasking.recordOpportunityDetails` with the opportunity it already fetched (status, customer, phone, custom fields). This is how a job that just *completed* gets status 10 recorded.
3. **Finance + claims refresh (costs API calls).** `tasking.runRefresh`:
   - `refreshFinance` — re-fetches up to N opportunities **with payments and documents** (`getOpportunityFinance`, 1 call each) that matter: booked in the next 60 days, completed in the last 90, quotes not yet checked. Skips anything refreshed in the last 20 h.
   - `refreshClaims` — for up to N customers (oldest-checked first) fetches service tickets (1 call each) and stores the Claims.
   - Runs **daily right after the 6 AM sweep** (`pollSweepScheduled` in `functions-index.js`, caps 120 opportunities / 40 customers) and from the **Refresh from SmartMoving** button (caps 60 / 20).
   - All calls are tagged `tasking` in `apiUsage` and stop when the daily budget runs low (< 25 calls left).

**First-time setup / empty lists:** run *Sync Now* (Job Assignments page) so stubs exist, then press *Refresh from SmartMoving* on Tasking Summary. Lists fill in as data arrives.

## Firestore collections (all new; the board's collections are never written)

| Collection / doc | Contents |
|---|---|
| `tasking_opps/{opportunityId}` | `status`, `statusLabel`, `serviceDate`, `customerId/Name`, `phone`, `quoteNumber`, `estimatedTotal`, `pboHint`, and when finance was fetched (`financeAt`): `paidTotal`, `balanceDue`, `depositPaid`, `depositPending`, `estimateSent/Signed`, `smTasks[]` |
| `tasking_state/job-{jobId}` | office state per board job: `callDone/At/By`, `callAssignee`, `pbo` (true/false/null = auto), `upsellStatus/Note/Due`, `dispatchNote`, `materials[]`, `crates[]`, `emailedAt` |
| `tasking_state/day-{YYYY-MM-DD}` | `callOwner`: `crew` or `erika` |
| `tasking_state/meta` | refresh timestamps, last refresh results, claim check times |
| `tasking_claims/{ticketId}` | SmartMoving Claim tickets |

Because state lives in its own collection, the SmartMoving sync and its manual-edit locks can never overwrite it.

## REST endpoints (`server.js`, section "Tasking")

All require admin/dispatcher/owner/developer.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasking/summary?date=YYYY-MM-DD` | all five lists + refresh info |
| GET | `/api/tasking/dispatch?date=` | the day's jobs with trucks/drivers, notes, materials, crates |
| PUT | `/api/tasking/job/:jobId` | save any of `callDone, callAssignee, pbo, upsellStatus, upsellNote, upsellDue, dispatchNote, materials, crates` (whitelisted and trimmed in `updateJobState`) |
| PUT | `/api/tasking/day/:date` | `{callOwner}` |
| POST | `/api/tasking/refresh` | run the SmartMoving refresh now |
| POST | `/api/tasking/materials-sync` | check Gmail now for the Job Materials report |
| POST | `/api/tasking/materials-upload` | `{filename, dataBase64}` import the report .xlsx by hand |
| POST | `/api/tasking/send-assignments` | `{date, to:[emails]}` — email the day's dispatch sheet; recipients must be company addresses or on the External Access list |

## Decisions and assumptions to know about

- **PBO has no SmartMoving field**, so detection is a text match plus a manual override. If PBO is recorded somewhere specific, change `PBO_RE` / `isPbo` in `tasking.js`.
- **"Paid" logic** assumes SmartMoving payment rows with `isOutstanding: true` are amounts still owed, and non-outstanding rows are money received (refunds subtracted). Verify against a real opportunity the first time.
- **Estimate vs. signed:** decided from the opportunity's documents (estimate/contract with `isComplete`), not from status - a quote can be signed and still unbooked/unpaid.
- **Dispatch notes and materials come from the SmartMoving calendar event** (the same events the board sync already reads), not the API. SmartMoving's API cannot supply materials (confirmed by SmartMoving support, 2026-11-05: `estimatedMaterials`/`actualMaterials` are always null) and the job `notes` field was empty on every real job checked. The calendar event's notes block holds Dispatch / Internal / Crew / Customer notes. `parseCalendarNotes` (`tasking.js`) keeps **every line** of each (the board mapper keeps only the first) and shows them read-only as "From SmartMoving"; the office's own note is separate and never overwritten.
- **Materials and crates come from the Smart Insights "Job Materials" report** (estimators enter materials in billing; the API cannot return them, and free-text notes are unreliable, so the notes are *not* parsed for materials). The report ("All Job Material.xlsx") is emailed to the same Gmail inbox as the other Insights reports; one row per job + material.
  - `server/materialsReport.js` parses it (needs columns *Job Number, Job Date, Name, Estimated Materials Quantity*; a missing column gives a clear error). Job Number `24744-1` becomes board job `SM-24744-1`. Quantity = estimated (actual only if estimated is 0); duplicate job+name rows are added up; zero rows skipped. **Crate = any material whose name contains "crate"** (e.g. `E-Crate, Rental per week`, `85" TV Crate Rental`); the report's *Is Container* flag is ignored because it is ticked for ordinary cartons. Packing/unpacking columns are labour and ignored.
  - `tasking.applyMaterialsReport` saves it for board jobs from yesterday to +28 days: SmartMoving rows (`source:'sm'`, tag **SM**) are replaced when the report changes, done ticks are kept, hand-typed rows are never touched, a job that disappears from the report loses its SM rows. Writes only when a job's content changed (`matHash`).
  - `server/materialsSync.js` = Gmail pickup (`findUnprocessedMaterialsFiles` in `smartInsightsGmail.js`) + import. Scheduled **6:30 AM and 5:00 PM ET** (`materialsSyncScheduled`, `materialsSyncScheduled5pm` in `functions-index.js`). The email is recognised by its attachment/file name (`job material`), and marked processed + trashed only after a successful import, like the other reports. The search is `from:send.sigmacomputing.com OR from:no-reply@smartmoving.com subject:(Job Materials) newer_than:4d` (the SmartMoving schedules send "Job Materials Exports" at 5:45 AM and 4:45 PM ET to atm.sspr@gmail.com); set env `MATERIALS_REPORT_QUERY` to narrow it. The existing Booked-Opportunities finder skips this report's link emails.
  - Manual routes on the Dispatch page: **Check materials email** (runs the sync now) and **Upload materials report** (import the .xlsx by hand, handy for testing). Both show how many jobs were updated and which report jobs are not on the board.
  - Test data: `server/test-fixtures/job-materials-sample.xlsx` (real rows, trimmed).
- Flow: `pollGoogleCalendarFeed` / `pollIcalFeed` (`server.js`) collect each event's job id, date and description and call `tasking.recordCalendarNotes` once per sync; it only handles jobs from yesterday to +21 days and writes only when the parsed result changed (`calHash`). The Dispatch button *Import notes from SmartMoving* just runs the calendar sync now.
- The Premium job-detail path (`refreshJobDetails`, `parseJobDetails`) is kept but no longer runs in the refresh.
- **Texting jobs to crews is not built** (no SMS provider in the stack). Email only, through the existing SMTP mailbox (`emailer.sendMail`).
- Completed-and-unpaid only sees jobs whose completion Tasking recorded (webhook) or that are inside the sweep window. To see further back, raise `POLL_LOOKBACK_DAYS`.
- Sidebar modules **Tasks** and **Storage** are separate and not built yet; the Tasking spec items for SM tasks (`smTasks` is already captured) and storage customers belong there.

## Where it touches existing code (all additive, never throws into the sync)

- `server/server.js`: `require('./tasking')`; one line in `hydrateOpportunity`; collection of stubs + one call in `pollSweepInner`; the `/api/tasking/*` route block; `runTaskingRefresh` export.
- `server/functions-index.js`: `pollSweepScheduled` runs the refresh after the sweep (timeout raised to 540 s).
- `server/smartmovingClient.js`: `getOpportunityFinance`, `getCustomerServiceTickets` (existing calls untouched).
- `server/db.js`: `listJobsInRange`, `getTrucksAndDrivers`. `server/emailer.js`: `sendMail`.
- `frontend/src/components/shell/modules.js`, `App.jsx`: module registration and page routing.

## Extending it

- **New list on Summary:** add a block in `buildSummary` (`tasking.js`), add a `<Card>` in `TaskingSummary.jsx`. If it needs new SmartMoving fields, capture them in `summarizeOpportunity`.
- **New per-job field:** add it to the whitelist in `updateJobState`, send it from the UI via `saveJobState`.

## Testing and deploying

- Logic: `cd server; node test-tasking.js` (fake database, no credentials).
- Preview deploy (the preview site talks to the **live** backend function, so deploy functions first):
  ```
  cd frontend ; npm run build ; cd ..
  firebase deploy --only functions --project atm-scheduler
  firebase hosting:channel:deploy tasking --expires 14d --project atm-scheduler
  ```
  Open the URL it prints. To go live later: `firebase deploy --only hosting --project atm-scheduler`.

## Checking real data before going live

`cd server ; node check-tasking-data.js` (needs `SMARTMOVING_API_KEY` in `server/.env`; read-only, ~15 API calls, no Firestore access) samples real booked / quote / completed opportunities and prints, for each: payments, documents, estimate total, job notes, materials, and whether it would appear on the Not-secured or Completed-unpaid lists. Lines marked `!!` need a code change. Pass opportunity ids to check specific customers: `node check-tasking-data.js <opportunityId> ...`.

Then on the preview site, click through: Summary loads for today → *Refresh from SmartMoving* → lists fill → tick a call → reload and confirm it stuck → Dispatch → add a material → *Print materials* → *Email assigned jobs* to yourself.
