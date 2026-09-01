import { fmtRange } from '../utils/dates';
import { jobTruckDriver } from '../utils/jobs';

export default function ConflictBanner({ conflicts, trucks, drivers }) {
  if (!conflicts.length) return null;
  return (
    <div className="conflict-banner">
      <div className="cb-title">⚠ {conflicts.length} scheduling conflict{conflicts.length > 1 ? 's' : ''} detected</div>
      <ul>
        {conflicts.map((c, i) => {
          const t = trucks.find((t) => t.id === c.truckId);
          // Each job on this truck can have its own driver now (see db.js's file header), so show
          // each side's driver separately rather than one driver name for the whole truck.
          const driverA = jobTruckDriver(drivers, c.a, c.truckId);
          const driverB = jobTruckDriver(drivers, c.b, c.truckId);
          return (
            <li key={i}>
              <b>{t ? t.name : c.truckId}</b>: <b>{c.a.customer}</b> ({c.a.id}, {fmtRange(c.a)}{driverA ? ` — ${driverA.name}` : ''}) overlaps with <b>{c.b.customer}</b> ({c.b.id}, {fmtRange(c.b)}{driverB ? ` — ${driverB.name}` : ''})
            </li>
          );
        })}
      </ul>
    </div>
  );
}
