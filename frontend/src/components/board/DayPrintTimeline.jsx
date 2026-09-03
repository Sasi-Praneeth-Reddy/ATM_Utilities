import { jobActiveOn, hourToLabel, timeToHour } from '../../utils/dates';
import {
  jobTruckIds, jobTrucksNeeded, getJobDriverColor, jobTruckDriver, overlappingClusterFor, conflictIdsFrom,
  serviceCategoryClass, serviceCategoryLabels, isTransitOnlyDay,
} from '../../utils/jobs';

// Deliberately NOT the same 0-24 span DayBoard.jsx's on-screen timeline uses — narrowed to
// business hours at the user's request 2026-08-27: a printed truck board is a paper handout for
// the day's actual working window, not a 24h grid with 18 empty overnight columns nobody's
// scheduled in. A job whose real start/end time falls outside 6am-6pm still prints its exact time
// as text (see detailBits below) and its bar is simply clamped to the visible edge rather than
// hidden — see clampFrac.
const TIMELINE_START = 6; // 6am
const TIMELINE_END = 18; // 6pm

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

// isTransitOnlyDay moved to utils/jobs.js (2026-09-01) so DayBoard.jsx's interactive "hide
// in-transit jobs" toggle shares the exact same definition instead of a second copy that could
// drift from this one — see that file for the full doc comment. Narrowed 2026-08-27 at the user's
// request from an earlier version that excluded every multi-day job outright: only the in-between
// transit days are skipped here (both from the truck bars and the Unassigned section of the side
// panel) — the start day and end day both print normally, with Departs/Arrives detail text (see
// detailBits below) so it's clear which one a given day is. BoardTab.jsx's "Print Board" button
// still warns via window.confirm first if any job would be skipped on the date being printed, so
// nobody is surprised a job they expected to see isn't there.

function clampFrac(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * A print-only rendition of the day board that LOOKS like the on-screen timeline — trucks down the
 * left, colored bars across an hours header — rather than DayPrintSheet's plain table manifest.
 * Requires the browser's "background graphics" print option to be on for the colors to actually
 * show (a browser/print-dialog setting, not something CSS alone can force); `print-color-adjust`
 * in styles.css is a hint some browsers respect without it, but not a guarantee.
 *
 * Built as a real <table> (thead + tbody), not the stacked <div>s an earlier version used — a
 * fleet with enough trucks to overflow one printed page needs the hours ribbon to repeat at the
 * top of every following page, and a plain flex/div layout has no way to do that. A <thead> is the
 * one piece of plain HTML/CSS browsers already know how to repeat on each page when a table breaks
 * across a page boundary, with no JS or manual page-splitting needed — Chrome, Firefox, and Safari
 * all handle it. Each truck's job blocks still render as absolutely-positioned .pt-block divs
 * inside one wide `colSpan`-ed cell, same as before; only the outer scaffolding changed.
 *
 * Restructured 2026-09-02 at the user's request ("i don't want the print board printing in two
 * pages... print conflicts and unassigned jobs in a different block on the side of the calendar"):
 * Conflicts and Unassigned Jobs used to print as extra rows/blocks STACKED below the truck grid —
 * an inline "pt-conflict-row" under every truck that had one, then a whole separate Unassigned
 * table after the entire grid. Neither of those was budgeted into truckPrintScale's page-fit math
 * (BoardTab.jsx), which only ever accounted for truck-row count — so a day with a handful of
 * conflicts or several unassigned jobs routinely pushed the printout onto a second page even when
 * the truck grid alone fit comfortably on one. Both now render in a `.pt-side-panel` column BESIDE
 * the grid (see `.pt-page-body`'s flex layout in styles.css) instead of below it, so neither one
 * adds any height to the page — only width, which the grid gives up to make room. The side panel
 * gets its own independent `--pt-side-scale` (computed by sidePanelPrintScale in BoardTab.jsx, from
 * how many conflicting/unassigned jobs there actually are today) so a busy Conflicts/Unassigned
 * column shrinks its own text to fit without also shrinking the truck grid's `--pt-scale` — and
 * vice versa, a big fleet doesn't force tiny text onto a light conflict day's side panel either.
 */
export default function DayPrintTimeline({ id, date, trucks, drivers, jobs, conflicts }) {
  const activeJobs = jobs.filter((j) => jobActiveOn(j, date) && !isTransitOnlyDay(j, date));
  // Unassigned jobs only print on their own start date — see DayPrintSheet.jsx / DayBoard.jsx for
  // the same fix and why (a long-distance job shouldn't reappear as "unassigned" on every day
  // it's in transit, only the day it needs picking up). Never a transit-only day by construction
  // (j.date === date can't also satisfy date > j.date), so no isTransitOnlyDay filter needed here.
  const unassigned = jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date);
  const dateLabel = new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const printedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const hours = hourLabelList();

  // Conflicts scoped to just THIS printed day — added 2026-08-27 at the user's request.
  // getConflicts (see App.jsx) flags a pair as conflicting whenever their date RANGES overlap
  // anywhere, which for two multi-day long-distance jobs can be a day other than the one being
  // printed right now (e.g. two LD jobs whose spans overlap on day 5, printed on day 2, where only
  // one of them is even running). A conflict only belongs on this printout when BOTH jobs are
  // actually active today — activeJobs already reflects that (including the transit-day exclusion
  // above) — so both the ⚠ flag on a bar and the side-panel conflict entries below use this
  // filtered list instead of the raw, date-agnostic `conflicts` prop.
  const activeJobIds = new Set(activeJobs.map((j) => j.id));
  const conflictsToday = (conflicts || []).filter((c) => activeJobIds.has(c.a.id) && activeJobIds.has(c.b.id));
  const conflictIdsToday = conflictIdsFrom(conflictsToday);

  // Every truck's conflict clusters, collected up front into one page-level list instead of being
  // computed (and rendered) per-truck-row — see the restructure note above. Reuses the exact same
  // overlappingClusterFor grouping the on-screen board and JobVisuals.jsx's "⚠ also:" line use, so
  // this panel's grouping can never disagree with either of those. BoardTab.jsx's
  // sidePanelPrintScale mirrors this same shape (truck-with-conflict count + total job-entry count)
  // to size --pt-side-scale BEFORE this component ever renders — see its own comment for why that
  // has to be precomputed rather than measured from the DOM.
  const conflictSections = [];
  trucks.forEach((t) => {
    const tjobs = activeJobs.filter((j) => jobTruckIds(j).includes(t.id));
    const seenConflictJobIds = new Set();
    const clusters = [];
    tjobs.forEach((j) => {
      if (!conflictIdsToday.has(j.id) || seenConflictJobIds.has(j.id)) return;
      const cluster = overlappingClusterFor(conflictsToday, t.id, j);
      cluster.forEach((cj) => seenConflictJobIds.add(cj.id));
      clusters.push(cluster);
    });
    if (clusters.length > 0) conflictSections.push({ truck: t, clusters });
  });

  return (
    <div className="print-sheet print-sheet-timeline" id={id}>
      <div className="print-header">
        <div className="print-title">Around Town Movers — Daily Truck Board</div>
        <div className="print-date">{dateLabel}</div>
      </div>

      <div className="pt-page-body">
      <div className="pt-table-wrap">
      <table className="pt-table">
        <colgroup>
          {/* Explicit width on just the truck column — table-layout:fixed then splits the rest of
              the page width evenly across the hour columns below, and reuses those exact same
              widths for every page the table breaks onto. */}
          <col className="pt-col-truck" />
          {hours.map((h) => <col key={h} />)}
        </colgroup>
        <thead>
          {/* Now just 12 columns (6am-6pm, see TIMELINE_START/END above) instead of the original
              24, so every hour comfortably gets its own label — the old "only every other hour"
              thinning is no longer needed. Every hour still gets its own gridline either way (see
              .pt-hour CSS). */}
          <tr>
            <th className="pt-truck-col-spacer" />
            {hours.map((h) => <th className="pt-hour" key={h}>{hourToLabel(h)}</th>)}
          </tr>
        </thead>
        <tbody>
        {trucks.map((t) => {
          const tjobs = activeJobs.filter((j) => jobTruckIds(j).includes(t.id));
          // Driver is assigned per job now, not permanently to the truck (see db.js's file header).
          const driver = tjobs.map((j) => jobTruckDriver(drivers, j, t.id)).find(Boolean) || null;

          // Bar left/width fractions computed up front for every job on this truck, sorted
          // left-to-right — added 2026-09-03 alongside .pt-block-label below, so a narrow job's
          // beside-the-bar label can be bounded by its immediate neighbor on THIS row instead of
          // assuming the whole row is free (two different jobs' labels would otherwise risk
          // printing on top of each other). Same left/width formulas as before, just computed once
          // per job instead of inline inside the render below.
          const framed = tjobs.map((j) => {
            const isLd = j.type === 'long_distance';
            let leftFrac, widthFrac;
            if (isLd) {
              // Same as JobBlock (the on-screen version): on the day it actually departs, the bar
              // starts at the dropped time instead of always looking like midnight.
              if (j.date !== date || !j.startTime) {
                leftFrac = 0; widthFrac = 1;
              } else {
                const start = timeToHour(j.startTime) ?? TIMELINE_START;
                leftFrac = clampFrac((start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
                widthFrac = 1 - leftFrac;
              }
            } else {
              const start = timeToHour(j.startTime) ?? TIMELINE_START;
              const dur = j.duration || 2;
              const startFrac = clampFrac((start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
              const endFrac = clampFrac((start + dur - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
              leftFrac = startFrac; widthFrac = Math.max(0, endFrac - startFrac);
            }
            return { j, isLd, leftFrac, widthFrac, rightFrac: leftFrac + widthFrac };
          }).sort((a, b) => a.leftFrac - b.leftFrac);

          return (
              <tr className="pt-truck-row" key={t.id}>
                <td className="pt-truck-info">
                  <div className="pt-truck-name">{t.name}</div>
                  <div className="pt-truck-meta">{t.size}{driver ? ` · ${driver.name}` : ''}</div>
                </td>
                <td className="pt-track-cell" colSpan={hours.length}>
                <div className="pt-track">
                  {framed.flatMap(({ j, isLd, leftFrac, widthFrac, rightFrac }, idx) => {
                    const color = getJobDriverColor(trucks, drivers, j);
                    // Any part of the bar that falls before 6am or after 6pm is already clamped to
                    // the visible edge (clampFrac, above) rather than overflowing the printed grid
                    // or getting hidden — the job's real time still prints as text in detailBits
                    // below regardless.
                    const style = { left: `${leftFrac * 100}%`, width: `${widthFrac * 100}%` };
                    if (color) style.borderLeftColor = color;
                    const conflict = conflictIdsToday.has(j.id);
                    const blockDriver = jobTruckDriver(drivers, j, t.id);
                    // Service-category color grading (print board) — same source/rationale as the
                    // on-screen board, see JobVisuals.jsx's catClass. null (no extra class/label)
                    // for 'moving'/'long_distance', which keep the print board's existing look.
                    const catClass = serviceCategoryClass(j);
                    // One flowing, wrap-as-needed run instead of a fixed line per detail — a short
                    // local job (no driver, no crew set) shouldn't reserve the same space as a
                    // fully-detailed one. The pieces wrap to fill whatever width is actually
                    // available to them (see styles.css's .pt-bit), packing more onto one line when
                    // there's room and only dropping to a second line when there truly isn't.
                    const detailBits = [];
                    // Departs on the day it actually starts, Arrives on the day it actually ends
                    // (job.endTime comes from the calendar sync's dtend wall-clock — see
                    // mapIcalEvent.js) — added 2026-08-27 alongside the transit-day exclusion above,
                    // so a worker looking at either printed end of a multi-day move sees which one
                    // today is, not just an unlabeled "Long Distance" bar.
                    detailBits.push(isLd
                      ? `Long Distance${
                          j.startTime && j.date === date ? ` · Departs ${hourToLabel(timeToHour(j.startTime))}`
                          : (j.endTime && j.endDate === date ? ` · Arrives ${hourToLabel(timeToHour(j.endTime))}` : '')
                        }`
                      : (j.startTime ? hourToLabel(timeToHour(j.startTime)) : null));
                    // SM id and truck/crew count sit right next to the time — added 2026-08-28 at
                    // the user's request, so a dispatcher can match this bar back to the
                    // SmartMoving booking and see at a glance how many trucks/crew the job needs,
                    // without flipping back to the screen for either. Same "NT/MM" shorthand the
                    // on-screen local job block already uses (see JobVisuals.jsx's detailBits).
                    detailBits.push(j.id);
                    detailBits.push(`${jobTrucksNeeded(j)}T/${j.crewSize ?? '?'}M`);
                    if (catClass) detailBits.push(serviceCategoryLabels[catClass]);
                    if (blockDriver) detailBits.push(blockDriver.name);
                    if (j.origin || j.destination) {
                      // Full address, not just the street segment before the first comma (a
                      // dispatcher printing this for a driver needs the whole thing, not a
                      // truncated hint) — unlike the on-screen chips/blocks, paper has no hover or
                      // click-to-edit to go check the rest of it.
                      detailBits.push(`${j.origin || '(no origin)'} → ${j.destination || '(no destination)'}`);
                    }
                    // Crew size now covered by the "NT/MM" bit above — miles (when known) still
                    // gets its own bit rather than being folded back in there.
                    if (j.miles) detailBits.push(`${j.miles} mi`);

                    const barClassName = `pt-block ${isLd ? 'ld' : ''} ${catClass ? `cat-${catClass}` : ''} ${conflict ? 'conflict' : ''}`;
                    const labelContent = (
                      <div className="pt-block-line">
                        <b className="pt-block-name">{j.customer}{conflict ? ' ⚠' : ''}</b>
                        {detailBits.filter(Boolean).map((bit, i) => <span className="pt-bit" key={i}>{bit}</span>)}
                      </div>
                    );

                    // Beside-the-bar text (below) is now ONLY for jobs allotted 3 hours or less —
                    // narrowed 2026-09-03 at the user's request after an earlier version applied it
                    // to EVERY job, including wide long-distance bars that never needed it and just
                    // ended up looking broken (an empty bar with its text floating apart from it,
                    // where the original in-bar text had always read fine on one line). Long-distance
                    // jobs have no fixed "duration" — they run from their start time to the end of
                    // the day — so they count as never beside here; a local job over 3h is rare
                    // enough, and wide enough at 3h+ of the 12-hour span (25%+), that it keeps the
                    // plain in-bar layout too. Only a short local job's bar is narrow enough to
                    // actually need the extra room — see the `durationHours > 3` branch just below,
                    // which is the plain original in-bar rendering, unchanged.
                    const durationHours = isLd ? Infinity : (j.duration || 2);
                    if (durationHours > 3) {
                      return [<div className={barClassName} style={style} key={j.id}>{labelContent}</div>];
                    }

                    // The bar itself (`.pt-block`, drawn below with NO text of its own) stays exactly
                    // the job's true time-span, same as always — it's the one thing on this printout
                    // that has to stay accurate, not just readable. The text lives in a separate
                    // `.pt-block-label` layered on top of it (see the CSS comment on
                    // `.pt-block-label`) after two earlier attempts at this same row-height problem:
                    // text crammed inside a narrow bar either got truncated (the old .pt-bit ellipsis)
                    // or, once that was fixed to wrap, grew the row taller and spilled into the row
                    // below / forced a 2nd page; text pushed entirely OUTSIDE the bar (with a gap)
                    // fixed that but wasted the bar's own width and still wrapped more than it needed
                    // to on a longer address. This version starts the label flush at the bar's own
                    // edge — so short bits print right on top of the (pale-tinted) bar, same as the
                    // very first version did — and lets it run PAST that edge into whichever
                    // neighboring gap has more room (see `prev`/`next` below), rather than stopping at
                    // the bar's own narrow width.
                    const prev = idx > 0 ? framed[idx - 1] : null;
                    const next = idx < framed.length - 1 ? framed[idx + 1] : null;
                    const GAP = 0.006; // ~a few px of breathing room against the NEXT job's own bar
                    const rightBound = next ? next.leftFrac : 1;
                    const leftBound = prev ? prev.rightFrac : 0;
                    const rightRoom = Math.max(0, rightBound - rightFrac);
                    const leftRoom = Math.max(0, leftFrac - leftBound);
                    // Ties (equal, usually both 0 — e.g. two adjacent jobs with no gap either side)
                    // fall through to label-right (left-align, starting at the bar) as the plainer
                    // default reading order.
                    const onLeft = leftRoom > rightRoom;
                    const contentLeft = onLeft ? leftBound + GAP : leftFrac;
                    const contentRight = onLeft ? rightFrac : rightBound - GAP;
                    // Math.max against the bar's own width is a safety net, not the expected path —
                    // by construction contentRight-contentLeft already includes the bar's full span
                    // plus whichever neighboring gap was bigger; this only matters if two neighbors
                    // are packed close enough that GAP alone eats the difference.
                    const contentWidth = Math.max(widthFrac, contentRight - contentLeft);
                    const labelStyle = { left: `${contentLeft * 100}%`, width: `${contentWidth * 100}%` };

                    return [
                      <div className={barClassName} style={style} key={j.id} />,
                      <div className={`pt-block-label ${onLeft ? 'label-left' : 'label-right'}`} style={labelStyle} key={`${j.id}-label`}>
                        {labelContent}
                      </div>,
                    ];
                  })}
                </div>
                </td>
              </tr>
          );
        })}
        </tbody>
      </table>
      </div>

      <div className="pt-side-panel">
        {conflictSections.length > 0 && (
          <div className="pt-side-section pt-side-conflicts">
            <div className="pt-side-section-title">⚠ Conflicts Today</div>
            {/* Every job in a cluster gets its own full entry here (time, customer, full origin ->
                destination) — not just the OTHER job's name — so a worker reading this panel never
                has to cross-reference back to the bars for the rest of the details. On screen, an
                overlapping second job is still reachable by clicking through (JobConflictChooser);
                on paper there's no click-through, so a job fully hidden behind another
                absolutely-positioned .pt-block (see .pt-block's overflow:hidden) would otherwise be
                invisible to whoever's holding this printout. */}
            {conflictSections.map(({ truck, clusters }) => (
              <div className="pt-side-truck-block" key={truck.id}>
                <div className="pt-side-truck-name">{truck.name}</div>
                {clusters.map((cluster) => (
                  <div className="pt-side-cluster" key={cluster.map((cj) => cj.id).join('-')}>
                    {cluster.map((cj) => (
                      <div className="pt-side-entry pt-side-conflict-entry" key={cj.id}>
                        <b>{cj.customer}</b>
                        {' — '}
                        {cj.type === 'long_distance' ? 'Long Distance' : (cj.startTime ? hourToLabel(timeToHour(cj.startTime)) : '—')}
                        <div className="pt-side-entry-addr">{cj.origin || '(no origin)'} → {cj.destination || '(no destination)'}</div>
                        {cj.crewSize ? <div className="pt-side-entry-meta">{cj.crewSize} crew</div> : null}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {unassigned.length > 0 && (
          <div className="pt-side-section pt-side-unassigned">
            <div className="pt-side-section-title">Unassigned Jobs</div>
            {unassigned.map((j) => (
              <div className="pt-side-entry pt-side-unassigned-entry" key={j.id}>
                <b>{j.customer}</b>
                {' — '}
                {j.type === 'long_distance' ? 'LD' : (j.startTime ? hourToLabel(timeToHour(j.startTime)) : '—')}
                <div className="pt-side-entry-addr">{j.origin || '(no origin)'} → {j.destination || '(no destination)'}</div>
              </div>
            ))}
          </div>
        )}

        {conflictSections.length === 0 && unassigned.length === 0 && (
          <div className="pt-side-empty">No conflicts or unassigned jobs today.</div>
        )}
      </div>
      </div>

      <div className="print-footer">Printed {printedAt}</div>
    </div>
  );
}
