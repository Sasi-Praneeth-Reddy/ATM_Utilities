export default function Header({ role, onRoleChange, trucks, crewTruck, onCrewTruckChange }) {
  return (
    <header>
      <div className="brand">
        <div className="logo">ATM</div>
        <div>
          <h1>Around Town Movers</h1>
          <span>Scheduler — Prototype (sample data)</span>
        </div>
      </div>
      <div className="role-switch">
        Viewing as
        <select value={role} onChange={(e) => onRoleChange(e.target.value)}>
          <option value="admin">Admin</option>
          <option value="dispatcher">Dispatcher</option>
          <option value="crew">Crew / Driver</option>
        </select>
        {role === 'crew' && (
          <select value={crewTruck} onChange={(e) => onCrewTruckChange(e.target.value)}>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>{t.name} — {t.size}</option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}
