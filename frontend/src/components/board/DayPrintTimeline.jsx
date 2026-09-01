import { Fragment } from 'react';
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
// transit days are skipped here (both from the truck bars and the Unassigned table below) — the
// start day and end day both print normally, with Departs/Arrives detail text (see detailBits
// below) so it's clear which one a given day is. BoardTab.jsx's "Print Board" button still warns
// via window.confirm first if any job would be skipped on the date being printed, so nobody is
// surprised a job they expected to see isn't there.

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
  // above) — so both the ⚠ flag on a bar and the conflict-details panel below use this filtered
  // list instead of the raw, date-agnostic `conflicts` prop.
  const activeJobIds = new Set(activeJobs.map((j) => j.id));
  const conflictsToday = (conflicts || []).filter((c) => activeJobIds.has(c.a.id) && activeJobIds.has(c.b.id));
  const conflictIdsToday = conflictIdsFrom(conflictsToday);

  return (
    <div className="print-sheet print-sheet-timeline" id={id}>
      <div className="print-header">
        <div className="print-title">Around Town Movers — Daily Truck Board</div>
        <div className="print-date">{dateLabel}</div>
      </div>

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

          // Full-detail conflict panel, printed as its own row directly under this truck's bars —
          // added 2026-08-27 at the user's request. On screen, an overlapping second job is still
          // reachable by clicking through (JobConflictChooser); on paper there's no click-through,
          // so a job fully hidden behind another absolutely-positioned .pt-block (see .pt-block's
          // overflow:hidden) would otherwise be invisible to whoever's holding this printout. Reuses
          // the same overlappingClusterFor helper the on-screen board and JobVisuals.jsx's
          // "⚠ also:" line use, so this panel's grouping can never disagree with either of those.
          // Every job in a cluster gets its own full line here (time, customer, full origin ->
          // destination) — not just the OTHER job's name — so a worker reading the panel never has
          // to cross-reference back to the bars for the rest of the details.
          const conflictClusters = [];
          const seenConflictJobIds = new Set();
          tjobs.forEach((j) => {
            if (!conflictIdsToday.has(j.id) || seenConflictJobIds.has(j.id)) return;
            const cluster = overlappingClusterFor(conflictsToday, t.id, j);
            cluster.forEach((cj) => seenConflictJobIds.add(cj.id));
            conflictClusters.push(cluster);
          });

          return (
            <Fragment key={t.id}>
              <tr className="pt-truck-row">
                <td className="pt-truck-info">
                  <div className="pt-truck-name">{t.name}</div>
                  <div className="pt-truck-meta">{t.size}{driver ? ` · ${driver.name}` : ''}</div>
                </td>
                <td className="pt-track-cell" colSpan={hours.length}>
                <div className="pt-track">
                  {tjobs.map((j) => {
                    const isLd = j.type === 'long_distance';
                    const color = getJobDriverColor(trucks, drivers, j);
                    // Same as JobBlock (the on-screen version): on the day it actually departs, the
                    // bar starts at the dropped time instead of always looking like midnight. Any
                    // part of the bar that falls before 6am or after 6pm is clamped to the visible
                    // edge (clampFrac) rather than overflowing the printed grid or getting hidden —
                    // the job's real time still prints as text in detailBits below regardless.
                    const style = isLd
                      ? (() => {
                          if (j.date !== date || !j.startTime) return { left: '0%', width: '100%' };
                          const start = timeToHour(j.startTime) ?? TIMELINE_START;
                          const leftFrac = clampFrac((start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
                          return { left: `${leftFrac * 100}%`, width: `${(1 - leftFrac) * 100}%` };
                        })()
                      : (() => {
                          const start = timeToHour(j.startTime) ?? TIMELINE_START;
                          const dur = j.duration || 2;
                          const startFrac = clampFrac((start - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
                          const endFrac = clampFrac((start + dur - TIMELINE_START) / (TIMELINE_END - TIMELINE_START));
                          return { left: `${startFrac * 100}%`, width: `${Math.max(0, endFrac - startFrac) * 100}%` };
                        })();
                    if (color) style.borderLeftColor = color;
                    const conflict = conflictIdsToday.has(j.id);
                    const blockDriver = jobTruckDriver(drivers, j, t.id);
                    // Service-category color grading (print board) — same source/rationale as the
                    // on-screen board, see JobVisuals.jsx's catClass. null (no extra class/label)
                    // for 'moving'/'long_distance', which keep the print board's existing look.
                    const catClass = serviceCategoryClass(j);
                    // One flowing, wrap-as-needed run instead of a fixed line per detail — a short
                    // local job (no driver, no crew set) shouldn't reserve the same vertical space as
                    // a fully-detailed one. All the pieces just wrap to fill whatever width the block
                    // actually has (see .pt-block-details' white-space:normal), packing more into a
                    // wide block on one line and only dropping to a second line when it has to.
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
                    // Hybrid layout, matching the on-screen board's dense single-line job block —
                    // added 2026-08-28 at the user's request. Name + every detail bit are separate
                    // flex items in ONE flex-wrap row (see .pt-block-line in styles.css): when the
                    // block is wide enough they all sit on one dense line, same look as the screen
                    // version's .jb-line-wrap; when it isn't, the browser's own wrapping drops
                    // whichever bits don't fit onto a second (or third) line for just THIS box —
                    // no ellipsis, no JS measurement, nothing ever silently hidden. Paper has no
                    // hover to recover clipped text the way the on-screen tooltip does, so unlike
                    // the screen version this box never truncates.
                    return (
                      <div className={`pt-block ${isLd ? 'ld' : ''} ${catClass ? `cat-${catClass}` : ''} ${conflict ? 'conflict' : ''}`} style={style} key={j.id}>
                        <div className="pt-block-line">
                          <b className="pt-block-name">{j.customer}{conflict ? ' ⚠' : ''}</b>
                          {detailBits.filter(Boolean).map((bit, i) => <span className="pt-bit" key={i}>{bit}</span>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                </td>
              </tr>
              {conflictClusters.length > 0 && (
                <tr className="pt-conflict-row">
                  <td className="pt-truck-col-spacer" />
                  <td className="pt-conflict-cell" colSpan={hours.length}>
                    <div className="pt-conflict-panel">
                      <div className="pt-conflict-panel-title">⚠ Conflicts on {t.name} — the jobs below overlap on this truck</div>
                      {conflictClusters.map((cluster) => (
                        <div className="pt-conflict-cluster" key={cluster.map((cj) => cj.id).join('-')}>
                          {cluster.map((cj) => (
                            <div className="pt-conflict-entry" key={cj.id}>
                              <b>{cj.customer}</b>
                              {' — '}
                              {cj.type === 'long_distance' ? 'Long Distance' : (cj.startTime ? hourToLabel(timeToHour(cj.startTime)) : '—')}
                              {' — '}
                              {cj.origin || '(no origin)'} → {cj.destination || '(no destination)'}
                              {cj.crewSize ? ` · ${cj.crewSize} crew` : ''}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        </tbody>
      </table>

      {unassigned.length > 0 && (
        <div className="print-truck print-unassigned" style={{ marginTop: 14 }}>
          <div className="print-truck-head"><span className="print-truck-name">⚠ Unassigned Jobs</span></div>
          <table className="print-table">
            <thead><tr><th>Time</th><th>Customer</th><th>Origin</th><th>Destination</th></tr></thead>
            <tbody>
              {unassigned.map((j) => (
                <tr key={j.id}>
                  <td>{j.type === 'long_distance' ? 'LD' : (j.startTime ? hourToLabel(timeToHour(j.startTime)) : '—')}</td>
                  <td>{j.customer}</td>
                  <td>{j.origin}</td>
                  <td>{j.destination}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="print-footer">Printed {printedAt}</div>
    </div>
  );
}
