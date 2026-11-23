import { jobActiveOn, timeToHour, hourToLabel } from '../../utils/dates';
import {
  jobTruckIds, jobTrucksNeeded, jobTruckDriver, driverColor, serviceCategoryClass,
  serviceCategoryText, isStorageJob, isMilitaryJob, militaryCleanName, mainCity,
  jobColorOverrideClass, isTransitOnlyDay, conflictIdsFrom,
} from '../../utils/jobs';

// Same fixed business-hours window DayPrintTimeline.jsx already uses for "Print Board"/"Print All
// Trucks" (6am-6pm, 12 columns) — reused here rather than the interactive timeline's full 24h
// scrollable range, since the whole point of this view (added 2026-09-24 at the user's request,
// modeled screenshot-for-screenshot on the OLD scheduler at scheduler.aroundtownmovers.com — see
// [[legacy-scheduler]]) is a compact, at-a-glance overview of the working day, not a 24h grid nobody
// is scheduled in overnight. A job outside this window still shows via its own clamped bar + real
// time label, same as the print grid.
const TIMELINE_START = 6; // 6am
const TIMELINE_END = 18; // 6pm

function hourLabelList() {
  const hours = [];
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) hours.push(h);
  return hours;
}

function clampFrac(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Read-only, on-screen "grid view" of the day board — one dense row per truck, hour columns 6am-6pm,
 * solid color-coded one-line job bars — deliberately built to match the OLD scheduler's exact look
 * (a screenshot the user sent 2026-09-24) rather than the pastel/spacious styling of the interactive
 * timeline or the print sheet. See BoardTab.jsx's "Grid View" toggle button for how this is switched
 * in alongside DayBoard.jsx.
 *
 * Deliberately READ-ONLY (no drag-and-drop) for this first version — the old scheduler's screenshot
 * didn't make clear whether reassignment happened directly on this grid or elsewhere, and building a
 * second full drag/drop surface alongside DayBoard.jsx's existing one is a much bigger scope than "a
 * button that makes the day view look like this." A dispatcher switches back to the normal Day view
 * (the existing toggle) to actually move a job. Revisit if the user asks for drag support here too.
 *
 * Also deliberately omits two things visible in that screenshot that don't have an equivalent yet in
 * this app's data model:
 *  - The "TRUCK NOT LISTED / drop on this line to schedule an outside truck" header row — that's a
 *    drop target for assigning a job to a truck outside the fleet list, which would need real backend
 *    support (an "outside truck" isn't a documented concept anywhere in server/db.js), not just a
 *    styling change.
 *  - Non-truck "line" rows (the old screenshot's "!OPS/OFFICE INFO LINE", "!WAREHOUSE LINE") — no
 *    special-casing needed here: if a real `trucks` document exists with a name like that, it renders
 *    like any other row automatically, same as DayBoard.jsx's own trucks.map() already does.
 *
 * Also drops the "{n/total}" tag the old screenshot showed ahead of each job's text (this is truck
 * n of the total trucks this job needs) — removed 2026-09-24 at the user's request ("you can remove
 * the {1/1} thing it's not needed"); the same trucks-needed count is still visible per job via the
 * "2T | 4M" segment in its detail line.
 */
export default function DayGridView({ date, trucks, drivers, jobs, conflicts, hideInTransit }) {
  const allActiveToday = jobs.filter((j) => jobActiveOn(j, date));
  // Mirrors DayBoard.jsx's own "Hide in-transit" behavior (BoardTab.jsx's toggle) — a long-distance
  // job that's merely passing through today (not picking up or delivering) is dropped from every
  // truck's row when the dispatcher has that toggle on, same as the interactive timeline. Independent
  // of "Include in-transit" (print-only, a different toggle) — this view isn't for printing.
  const activeJobs = hideInTransit ? allActiveToday.filter((j) => !isTransitOnlyDay(j, date)) : allActiveToday;

  const activeJobIds = new Set(activeJobs.map((j) => j.id));
  const conflictsToday = (conflicts || []).filter((c) => activeJobIds.has(c.a.id) && activeJobIds.has(c.b.id));
  const conflictIdsToday = conflictIdsFrom(conflictsToday);

  const hours = hourLabelList();

  // Unassigned jobs starting today (no truck yet) - same rule the interactive board's tray uses, so a
  // dispatcher on the grid can still see what needs a truck without switching views.
  const unassigned = jobs.filter((j) => jobTruckIds(j).length === 0 && j.date === date);

  return (
    <div className="dg-grid">
      <div className={`dg-unassigned ${unassigned.length ? 'has-jobs' : ''}`}>
        <div className="dg-un-title">
          <span>Unassigned</span>
          <b>{unassigned.length}</b>
        </div>
        {unassigned.length === 0 ? (
          <span className="dg-un-empty">All jobs assigned</span>
        ) : (
          <div className="dg-un-list">
            {unassigned.map((j) => {
              const isLd = j.type === 'long_distance';
              const military = isMilitaryJob(j);
              const catClass = serviceCategoryClass(j);
              const cls = ['dg-un-chip', isLd ? 'ld' : '', catClass ? `cat-${catClass}` : '', isStorageJob(j) ? 'storage' : '', military ? 'military' : '', jobColorOverrideClass(j)].filter(Boolean).join(' ');
              const name = military ? militaryCleanName(j) : j.customer;
              const t = j.startTime ? hourToLabel(timeToHour(j.startTime)) : null;
              const route = (j.origin || j.destination) ? `${mainCity(j.origin) || '?'} \u2192 ${mainCity(j.destination) || '?'}` : null;
              const bits = [isLd ? 'LD' : 'LCL', t, route, `${jobTrucksNeeded(j)}T | ${j.crewSize ?? '?'}M`].filter(Boolean);
              return (
                <div className={cls} key={j.id} title={`${name} \u2014 ${bits.join(' | ')} | ${j.id}`}>
                  <b>{name}</b>
                  <span>{bits.join(' | ')}</span>
                  <small>{j.id}</small>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="dg-table">
        <div className="dg-header-row">
          <div className="dg-header-spacer" />
          {hours.map((h) => <div className="dg-header-hour" key={h}>{hourToLabel(h)}</div>)}
        </div>
        {trucks.map((t) => {
          const tjobs = activeJobs.filter((j) => jobTruckIds(j).includes(t.id));

          const framed = tjobs.map((j) => {
            const isLd = j.type === 'long_distance';
            let leftFrac, widthFrac;
            if (isLd) {
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
              leftFrac = startFrac; widthFrac = Math.max(0.04, endFrac - startFrac);
            }
            return { j, isLd, leftFrac, widthFrac, rightFrac: leftFrac + widthFrac };
          }).sort((a, b) => a.leftFrac - b.leftFrac);

          // Same greedy lane-packing as DayPrintTimeline.jsx's truck grid (duplicated on purpose,
          // same "has to be known before render" reasoning that file's own comment already covers —
          // this view has no shared page-fit pass with that one, so there's nothing to keep in sync
          // beyond the algorithm itself).
          const laneEndFracs = [];
          const laned = framed.map((f) => {
            let lane = laneEndFracs.findIndex((end) => f.leftFrac >= end - 0.0001);
            if (lane === -1) { lane = laneEndFracs.length; laneEndFracs.push(f.rightFrac); }
            else { laneEndFracs[lane] = f.rightFrac; }
            return { ...f, lane };
          });
          const laneCount = Math.max(1, laneEndFracs.length);
          const isEmptyTruck = tjobs.length === 0;
          // A working truck's row needs one 27px lane per stacked job; an empty truck has nothing
          // to stack, so it gets its own much shorter fixed height (2026-09-24, at the user's
          // request: "the trucks without the jobs are wider [i.e. taller], make them smaller")
          // instead of the same 27px-per-lane math giving it a full empty lane's worth of space.
          const rowHeightPx = isEmptyTruck ? 18 : laneCount * 27;

          return (
            <div className="dg-row" key={t.id}>
              <div className="dg-truckcell">
                <span className="dg-icon" aria-hidden="true">🚚</span>
                <span className={isEmptyTruck ? 'dg-truckname dg-truckname-empty' : 'dg-truckname'}>{t.name}</span>
              </div>
              <div className="dg-track" style={{ height: `${rowHeightPx}px` }}>
                <div className="dg-hourlabels">
                  {hours.map((h) => <span key={h}>{hourToLabel(h)}</span>)}
                </div>
                {laned.map(({ j, isLd, leftFrac, widthFrac, lane }) => {
                  const conflict = conflictIdsToday.has(j.id);
                  const blockDriver = jobTruckDriver(drivers, j, t.id);
                  const badgeColor = blockDriver ? driverColor(drivers, blockDriver.id) : null;
                  const catClass = serviceCategoryClass(j);
                  const storage = isStorageJob(j);
                  const military = isMilitaryJob(j);
                  const displayName = military ? militaryCleanName(j) : j.customer;

                  const startHour = timeToHour(j.startTime);
                  const timeLabel = isLd
                    ? (j.startTime && j.date === date ? `Departs ${hourToLabel(startHour)}`
                        : (j.endTime && j.endDate === date ? `Arrives ${hourToLabel(timeToHour(j.endTime))}` : null))
                    : (j.startTime ? hourToLabel(startHour) : null);

                  // The old scheduler's "{n/total}" tag (read as "this truck is position n of the
                  // total trucks this job needs" — see this component's doc comment history) was
                  // removed 2026-09-24 at the user's request ("you can remove the {1/1} thing it's
                  // not needed") — trucksTotal itself stays, since the "2T | 4M" segment below still
                  // needs it.
                  const trucksTotal = jobTrucksNeeded(j);

                  const segs = [];
                  segs.push(isLd ? 'LD' : 'LCL');
                  if (military) segs.push('MIL');
                  if (catClass) segs.push(serviceCategoryText(j));
                  segs.push(timeLabel);
                  if (j.origin || j.destination) {
                    segs.push(`${mainCity(j.origin) || '(no origin)'} → ${mainCity(j.destination) || '(no destination)'}`);
                  }
                  // Trucks/crew needed (added 2026-09-24 at the user's request: "add truck and men
                  // to the grid view like its 2 trucks and 4 men then it should display 2T | 4M") —
                  // same trucksNeeded/crewSize pairing DayPrintTimeline.jsx already prints per job
                  // (see that file's own segs.push right after the route segment), just " | "
                  // instead of "/" between the two since every other segment here already reads as
                  // its own " | "-prefixed tag (this file's own .dg-seg::before) rather than a
                  // single combined field the way "Print Board"'s one-line layout treats it.
                  segs.push(`${trucksTotal}T | ${j.crewSize ?? '?'}M`);
                  if (j.miles) segs.push(`${j.miles} mi`);
                  segs.push(j.id);

                  const barClassName = [
                    'dg-job-bar',
                    isLd ? 'ld' : '',
                    catClass ? `cat-${catClass}` : '',
                    storage ? 'storage' : '',
                    military ? 'military' : '',
                    jobColorOverrideClass(j),
                    conflict ? 'conflict' : '',
                  ].filter(Boolean).join(' ');

                  const style = {
                    left: `${leftFrac * 100}%`,
                    width: `${widthFrac * 100}%`,
                    top: `${lane * 27 + 2}px`,
                    height: '23px',
                  };

                  return (
                    <div className={barClassName} style={style} key={j.id} title={`${displayName} — ${segs.filter(Boolean).join(' | ')}`}>
                      {blockDriver && (
                        <span className="dg-driver-badge" style={badgeColor ? { background: badgeColor } : undefined}>
                          {blockDriver.name}
                        </span>
                      )}
                      <b className="dg-job-name">{displayName}{conflict ? ' ⚠' : ''}</b>
                      {segs.filter(Boolean).map((s, i) => <span className="dg-seg" key={i}>{s}</span>)}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
