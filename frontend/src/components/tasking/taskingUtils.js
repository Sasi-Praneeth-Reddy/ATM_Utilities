// Small shared helpers for the Tasking pages.

/** Today as YYYY-MM-DD in the browser's local time (the office is in one time zone). */
export function todayLocalIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shiftIso(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtTime(hhmm) {
  if (!hhmm) return 'TBD';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`;
}

export function fmtMoney(n) {
  if (n === null || n === undefined) return '';
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** Countdown label + colour class for "days until the job". */
export function countdown(days) {
  if (days <= 0) return { text: days === 0 ? 'Today' : `${-days}d ago`, cls: 'tk-red' };
  return { text: `${days}d`, cls: days <= 3 ? 'tk-red' : days <= 7 ? 'tk-amber' : 'tk-green' };
}
