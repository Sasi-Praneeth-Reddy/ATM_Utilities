// Job/truck/driver/conflict helpers — ported 1:1 from the original atm-scheduler.html.
import { jobEnd, timeToHour, daysBetween } from './dates';

export const DRIVER_COLORS = [
  '#7c3aed', '#0891b2', '#be185d', '#4338ca', '#0f766e', '#a16207', '#525252', '#9333ea',
];

export const roleLabels = {
  admin: 'Admin — full access to trucks, drivers, availability, and jobs.',
  dispatcher: 'Dispatcher — can assign/move jobs on the board and LD planner. Truck & driver records are locked.',
  crew: 'Crew / Driver — read-only view of the truck board and your own jobs, optimized for mobile. No editing.',
};

export const ldStages = ['scheduled', 'loading', 'in_transit', 'delivering', 'complete'];
export const ldStageLabels = {
  scheduled: 'Scheduled',
  loading: 'Loading',
  in_transit: 'In Transit',
  delivering: 'Delivering',
  complete: 'Complete',
};

export function statusClass(s) {
  return s === 'available' ? 'status-available' : s === 'onjob' ? 'status-onjob' : 'status-maintenance';
}
export function statusLabel(s) {
  return s === 'available' ? 'Available' : s === 'onjob' ? 'On Job' : 'Maintenance';
}

export function driverColor(drivers, driverId) {
  if (!driverId) return null;
  const idx = drivers.findIndex((d) => d.id === driverId);
  if (idx < 0) return null;
  return DRIVER_COLORS[idx % DRIVER_COLORS.length];
}

export function jobTruckIds(j) {
  return j.truckIds || [];
}
export function jobTrucksNeeded(j) {
  return j.trucksNeeded || 1;
}
export function jobTrucks(trucks, j) {
  return jobTruckIds(j).map((id) => trucks.find((t) => t.id === id)).filter(Boolean);
}
export function truckShortLabel(t) {
  return t.name.replace('Truck ', 'T');
}
export function jobTruckLabel(trucks, j) {
  const ts = jobTrucks(trucks, j);
  return ts.length ? ts.map(truckShortLabel).join('+') : 'Unassigned';
}

/** Returns null, or a descriptor for the "needs N more trucks" / "N/M trucks" badge. */
export function truckBadgeInfo(j) {
  const needed = jobTrucksNeeded(j);
  if (needed <= 1) return null;
  const have = jobTruckIds(j).length;
  const short = needed - have;
  if (short > 0) return { kind: 'short', text: `⚠ needs ${short} more truck${short > 1 ? 's' : ''}` };
  if (have > needed) return { kind: 'over', text: `${have}/${needed} trucks` };
  return { kind: 'ok', text: `${have}/${needed} trucks ✓` };
}

export function getJobDriverColor(trucks, drivers, j) {
  const truck = jobTrucks(trucks, j)[0];
  if (!truck || !truck.driverId) return null;
  return driverColor(drivers, truck.driverId);
}

/* ---------- CONFLICT DETECTION ---------- */
export function getConflicts(jobs) {
  const conflicts = [];
  const byTruck = {};
  jobs.forEach((j) => {
    jobTruckIds(j).forEach((truckId) => {
      (byTruck[truckId] = byTruck[truckId] || []).push(j);
    });
  });
  Object.keys(byTruck).forEach((truckId) => {
    const list = byTruck[truckId];
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i], b = list[k];
        const aS = a.date, aE = jobEnd(a), bS = b.date, bE = jobEnd(b);
        if (!(aS <= bE && bS <= aE)) continue;
        if (a.type !== 'long_distance' && b.type !== 'long_distance' && aS === aE && bS === bE && aS === bS) {
          const as = timeToHour(a.startTime) ?? 0, ae = as + (a.duration || 2);
          const bs = timeToHour(b.startTime) ?? 0, be = bs + (b.duration || 2);
          if (!(as < be && bs < ae)) continue;
        }
        conflicts.push({ truckId, a, b });
      }
    }
  });
  return conflicts;
}

export function conflictIdsFrom(conflicts) {
  return new Set(conflicts.flatMap((c) => [c.a.id, c.b.id]));
}

export function jobDurationHours(j) {
  if (j.type === 'long_distance') {
    return (daysBetween(j.date, jobEnd(j)) + 1) * 24; // multi-day LD job expressed in hours
  }
  return j.duration || 2;
}

/** Shorter jobs stack ABOVE longer jobs so an overlap is always visible on top of the job it
    conflicts with. */
export function stackZIndex(j) {
  return Math.max(1, 500 - Math.round(jobDurationHours(j)));
}

/** Lane assignment for month-view multi-day LD bars — shorter jobs claim the topmost lane first,
    same "less time on top" rule as the day view. Mutates each event with `_dur` and `lane`. */
export function assignLanes(events) {
  events.forEach((ev) => { ev._dur = jobDurationHours(ev.job); });
  events.sort((a, b) => a._dur - b._dur || a.startCol - b.startCol);
  const laneEnds = [];
  events.forEach((ev) => {
    let placed = false;
    for (let li = 0; li < laneEnds.length; li++) {
      if (laneEnds[li] < ev.startCol) {
        laneEnds[li] = ev.endCol;
        ev.lane = li;
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneEnds.push(ev.endCol);
      ev.lane = laneEnds.length - 1;
    }
  });
  return laneEnds.length;
}
