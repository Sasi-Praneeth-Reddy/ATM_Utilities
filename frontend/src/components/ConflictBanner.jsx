import { fmtRange } from '../utils/dates';

export default function ConflictBanner({ conflicts, trucks, drivers }) {
  if (!conflicts.length) return null;
  return (
    <div className="conflict-banner">
      <div className="cb-title">⚠ {conflicts.length} scheduling conflict{conflicts.length > 1 ? 's' : ''} detected</div>
      <ul>
        {conflicts.map((c, i) => {
          const t = trucks.find((t) => t.id === c.truckId);
          const driver = t ? drivers.find((d) => d.id === t.driverId) : null;
          return (
            <li key={i}>
              <b>{t ? t.name : c.truckId}</b>{driver ? ` — ${driver.name}` : ''}: <b>{c.a.customer}</b> ({c.a.id}, {fmtRange(c.a)}) overlaps with <b>{c.b.customer}</b> ({c.b.id}, {fmtRange(c.b)})
            </li>
          );
        })}
      </ul>
    </div>
  );
}
