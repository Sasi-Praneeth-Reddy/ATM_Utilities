import { driverColor } from '../utils/jobs';

export default function DriverLegend({ trucks, drivers }) {
  return (
    <div className="driver-legend">
      <span className="dl-label">Drivers</span>
      {drivers.map((d) => {
        const truck = trucks.find((t) => t.driverId === d.id);
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
