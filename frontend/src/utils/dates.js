// Date/time helpers — ported 1:1 from the original atm-scheduler.html.

export function jobEnd(j) {
  return j.endDate || j.date;
}

export function jobActiveOn(j, dateStr) {
  return dateStr >= j.date && dateStr <= jobEnd(j);
}

// Same "does this job's date range touch this window" check as jobActiveOn, but against a whole
// calendar month instead of a single day — added 2026-09-08 for BoardTab.jsx's Overlapped Alerts
// tab, which needs to scope conflicts to "this month" when opened from month view the same way it
// already scopes to "this day" when opened from day view. Plain range-overlap: the job's [date,
// jobEnd] span and the month's [1st, last day] span overlap iff each one starts on or before the
// other's end.
export function jobActiveInMonth(j, year, month) {
  const monthStart = isoDate(year, month, 1);
  const monthEnd = isoDate(year, month, new Date(year, month + 1, 0).getDate());
  return j.date <= monthEnd && jobEnd(j) >= monthStart;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

export function addDays(dateStr, n) {
  const dt = new Date(dateStr + 'T00:00:00');
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function fmtRange(j) {
  const end = jobEnd(j);
  return end === j.date ? j.date : `${j.date} → ${end}`;
}

export function timeToHour(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h + m / 60;
}

export function hourToLabel(h) {
  const hr = Math.floor(h);
  const ampm = hr >= 12 ? 'PM' : 'AM';
  let disp = hr % 12;
  if (disp === 0) disp = 12;
  const mins = Math.round((h - hr) * 60);
  return mins ? `${disp}:${String(mins).padStart(2, '0')}${ampm}` : `${disp}${ampm}`;
}

export function isoDate(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Added 2026-09-08 for the manual edit lock (db.js's manuallyEditedAt) — a shared "when did this
// happen" formatter so JobVisuals.jsx's ManualEditBadge tooltip, JobEditModal.jsx's lock notice, and
// JobAssignments.jsx's row can all show the same readable date+time instead of a raw ISO string,
// matching the plain `.toLocaleString()` SyncPanel.jsx already uses for lastSyncedAt. Returns ''
// for a falsy/unparseable input so callers can inline it without an extra null check.
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}
