import { driverColor, driverTruckForDate } from '../utils/jobs';

// `date` scopes "which truck is this driver on" to a single day — driver assignment is per-job
// now (see db.js's file header), so it's not a standing fact the way it used to be. Callers pass
// whatever date the board is currently showing.
export default function DriverLegend({ trucks, drivers, jobs, date }) {
  return (
    <div className="driver-legend">
      <span className="dl-label">Drivers</span>
      {drivers.map((d) => {
        const truck = driverTruckForDate(trucks, jobs, date, d.id);
        return (
          <span className="dl-item" key={d.id}>
            <span className="dl-swatch" style={{ background: driverColor(drivers, d.id) }} />
            {d.name}{truck ? ` · ${truck.name}` : ''}
          </span>
        );
      })}
    </div>
  );
}
