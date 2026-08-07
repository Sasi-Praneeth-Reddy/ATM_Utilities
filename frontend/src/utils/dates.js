// Date/time helpers — ported 1:1 from the original atm-scheduler.html.

export function jobEnd(j) {
  return j.endDate || j.date;
}

export function jobActiveOn(j, dateStr) {
  return dateStr >= j.date && dateStr <= jobEnd(j);
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
